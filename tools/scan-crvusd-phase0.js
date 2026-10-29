#!/usr/bin/env node
// scan-crvusd-phase0.js - read-only crvUSD Phase 0 scanner.
// RPC URLs are resolved in memory only. Never prints/stores RPC URLs, private keys, calldata, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpcPool } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "crvusd-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "crvusd-phase0-triage.md");
const QUIET = process.argv.includes("--quiet");

const SIGNAL_BANNER = "\uD83D\uDFE2 DORMANT";
const ETHEREUM_CHAIN_ID = 1;
const CRVUSD = "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E";
const CRVUSD_FACTORY = "0xC9332fdCB1C491Dcc683bAe86Fe3cb70360738BC";
const ZERO = "0x0000000000000000000000000000000000000000";
const WAD = 10n ** 18n;
const MAX_ENUMERATE = Number(process.env.CRVUSD_PHASE0_MAX_ENUMERATE || "80");
const MAX_BORROWER_SAMPLES_PER_CONTROLLER = Number(process.env.CRVUSD_PHASE0_MAX_BORROWERS_PER_CONTROLLER || "16");
const MATERIAL_USD = Number(process.env.CRVUSD_PHASE0_MATERIAL_USD || "10000");
const ORACLE_DIFF_WATCH_BPS = Number(process.env.CRVUSD_PHASE0_ORACLE_DIFF_WATCH_BPS || "500");
const CHAINLINK_WARN_SECONDS = Number(process.env.CRVUSD_PHASE0_CHAINLINK_WARN_SECONDS || "3600");
const CHAINLINK_STALE_SECONDS = Number(process.env.CRVUSD_PHASE0_CHAINLINK_STALE_SECONDS || "86400");

const SOURCE_PEGKEEPERS = [
  "0x9201da0D97CaAAff53f01B2fB56767C7072dE340",
  "0xFb726F57d251aB5C731E5C64eD4F5F94351eF9F3",
  "0x3fA20eAa107DE08B38a8734063D605d5842fe09C",
  "0x338Cb2D827112d989A861cDe87CD9FfD913A1f9D",
];

const FACTORY_ABI = [
  "function admin() view returns (address)",
  "function fee_receiver() view returns (address)",
  "function stablecoin() view returns (address)",
  "function n_collaterals() view returns (uint256)",
  "function total_debt() view returns (uint256)",
  "function controller_implementation() view returns (address)",
  "function amm_implementation() view returns (address)",
  "function controllers(uint256) view returns (address)",
  "function amms(uint256) view returns (address)",
  "function collaterals(uint256) view returns (address)",
  "function debt_ceiling(address) view returns (uint256)",
  "function debt_ceiling_residual(address) view returns (uint256)",
];

const CONTROLLER_ABI = [
  "function factory() view returns (address)",
  "function amm() view returns (address)",
  "function collateral_token() view returns (address)",
  "function borrowed_token() view returns (address)",
  "function monetary_policy() view returns (address)",
  "function available_balance() view returns (uint256)",
  "function total_debt() view returns (uint256)",
  "function minted() view returns (uint256)",
  "function redeemed() view returns (uint256)",
  "function admin_fees() view returns (uint256)",
  "function loan_discount() view returns (uint256)",
  "function liquidation_discount() view returns (uint256)",
  "function n_loans() view returns (uint256)",
  "function loans(uint256) view returns (address)",
  "function debt(address) view returns (uint256)",
  "function loan_exists(address) view returns (bool)",
  "function health(address,bool) view returns (int256)",
  "function tokens_to_liquidate(address) view returns (uint256)",
  "function user_state(address) view returns (uint256[4])",
];

const AMM_ABI = [
  "function admin() view returns (address)",
  "function A() view returns (uint256)",
  "function fee() view returns (uint256)",
  "function rate() view returns (uint256)",
  "function get_rate_mul() view returns (uint256)",
  "function active_band() view returns (int256)",
  "function active_band_with_skip() view returns (int256)",
  "function min_band() view returns (int256)",
  "function max_band() view returns (int256)",
  "function price_oracle_contract() view returns (address)",
  "function price_oracle() view returns (uint256)",
  "function get_p() view returns (uint256)",
  "function coins(uint256) view returns (address)",
  "function bands_x(int256) view returns (uint256)",
  "function bands_y(int256) view returns (uint256)",
];

const ORACLE_ABI = [
  "function price() view returns (uint256)",
  "function price_w() view returns (uint256)",
  "function MA_EXP_TIME() view returns (uint256)",
  "function last_timestamp() view returns (uint256)",
  "function last_price() view returns (uint256)",
  "function chainlink_feed() view returns (address)",
  "function CHAINLINK_STALE_THRESHOLD() view returns (uint256)",
  "function POOL() view returns (address)",
  "function COLLATERAL_IX() view returns (uint256)",
  "function BORROWED_IX() view returns (uint256)",
  "function N_POOLS() view returns (uint256)",
  "function tricrypto(uint256) view returns (address)",
  "function stableswap(uint256) view returns (address)",
  "function stable_aggregator() view returns (address)",
];

const POLICY_ABI = [
  "function n_peg_keepers() view returns (uint256)",
  "function peg_keepers(uint256) view returns (address)",
  "function PRICE_ORACLE() view returns (address)",
  "function CONTROLLER_FACTORY() view returns (address)",
  "function n_controllers() view returns (uint256)",
  "function controllers(uint256) view returns (address)",
  "function rate(address) view returns (uint256)",
  "function rate_write(address) view returns (uint256)",
  "function rate0() view returns (uint256)",
  "function sigma() view returns (int256)",
  "function target_debt_fraction() view returns (uint256)",
];

const PEGKEEPER_ABI = [
  "function factory() view returns (address)",
  "function pegged() view returns (address)",
  "function pool() view returns (address)",
  "function aggregator() view returns (address)",
  "function regulator() view returns (address)",
  "function debt() view returns (uint256)",
  "function caller_share() view returns (uint256)",
  "function last_change() view returns (uint256)",
  "function action_delay() view returns (uint256)",
  "function calc_profit() view returns (uint256)",
  "function estimate_caller_profit() view returns (uint256)",
  "function IS_INVERSE() view returns (bool)",
];

const REGULATOR_ABI = [
  "function provide_allowed(address) view returns (uint256)",
  "function withdraw_allowed(address) view returns (uint256)",
  "function stablecoin() view returns (address)",
  "function aggregator() view returns (address)",
  "function worst_price_threshold() view returns (uint256)",
  "function price_deviation() view returns (uint256)",
  "function alpha() view returns (uint256)",
  "function beta() view returns (uint256)",
  "function fee_receiver() view returns (address)",
  "function admin() view returns (address)",
  "function emergency_admin() view returns (address)",
];

const POOL_ABI = [
  "function coins(uint256) view returns (address)",
  "function balances(uint256) view returns (uint256)",
  "function get_virtual_price() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function price_oracle() view returns (uint256)",
  "function price_oracle(uint256) view returns (uint256)",
  "function get_p() view returns (uint256)",
  "function get_p(uint256) view returns (uint256)",
];

const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];

const FEED_ABI = [
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
];

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function safeText(value, max = 120) { return String(value ?? "").replace(/[\r\n|]+/g, " ").slice(0, max); }
function normalizeAddress(value) { try { return ethers.getAddress(String(value || "").replace(/^0X/, "0x")); } catch (_) { return null; } }
function lowerAddress(value) { const addr = normalizeAddress(value); return addr ? addr.toLowerCase() : null; }
function compactAddress(value) { const addr = normalizeAddress(value); return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : "n/a"; }
function toBig(value) { try { return BigInt(value ?? 0); } catch (_) { return 0n; } }
function unique(items) { return [...new Set((items || []).filter(Boolean))]; }
function asNumber(value) { if (value === null || value === undefined) return null; if (typeof value === "number") return Number.isFinite(value) ? value : null; const n = Number(String(value).replace(/[$,%\s,]/g, "")); return Number.isFinite(n) ? n : null; }
function round(value, decimals = 2) { const n = asNumber(value); if (n === null) return null; const f = 10 ** decimals; return Math.round(n * f) / f; }
function formatUsd(value) { const n = asNumber(value); return n === null ? "n/a" : `$${Math.round(n).toLocaleString("en-US")}`; }
function formatPctBps(value) { const n = asNumber(value); return n === null ? "n/a" : `${round(n / 100, 2)}%`; }
function formatBps(value) { const n = asNumber(value); return n === null ? "n/a" : `${round(n, 2)}bps`; }
function unitsToNumber(value, decimals = 18) { try { const n = Number(ethers.formatUnits(toBig(value), Number(decimals ?? 18))); return Number.isFinite(n) ? n : null; } catch (_) { return null; } }
function wadToBps(value) { try { return Number((toBig(value) * 10000n) / WAD); } catch (_) { return null; } }
function strip0x(value) { return String(value || "").replace(/^0x/i, ""); }
function splitWords(hex) { const s = strip0x(hex); const words = []; for (let i = 0; i + 64 <= s.length; i += 64) words.push(`0x${s.slice(i, i + 64)}`); return words; }
function decodeAddressWord(word) { const s = strip0x(word).padStart(64, "0"); if (/^0+$/.test(s)) return null; return normalizeAddress(`0x${s.slice(-40)}`); }
function sameAddress(a, b) { const aa = lowerAddress(a); const bb = lowerAddress(b); return Boolean(aa && bb && aa === bb); }

async function tryCall(fn, fallback = null) {
  try { return await fn(); } catch (_) { return fallback; }
}

async function safeCode(provider, address) {
  const addr = normalizeAddress(address);
  if (!addr) return "0x";
  return await tryCall(() => provider.getCode(addr), "0x");
}

async function addressKind(provider, address) {
  const addr = normalizeAddress(address);
  if (!addr || addr === ZERO) return null;
  const code = await safeCode(provider, addr);
  return code && code !== "0x" ? "contract" : "eoa";
}

async function fetchJson(url, options = {}) {
  try {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(options.timeoutMs || 15_000) });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}

async function protocolMetadata() {
  const json = await fetchJson("https://api.llama.fi/protocol/crvusd", { timeoutMs: 20_000 });
  if (!json) return { slug: "crvusd", tvlUsd: null, category: "CDP", chains: ["Ethereum"], source: "api-unavailable" };
  const tvlUsd = protocolTvlUsd(json);
  return {
    slug: json.slug || "crvusd",
    name: json.name || "crvUSD",
    category: json.category || "CDP",
    tvlUsd: round(tvlUsd, 2),
    chains: Array.isArray(json.chains) ? json.chains.slice(0, 12) : [],
    audits: json.audits ?? null,
    url: json.url || null,
    module: json.module || null,
    source: "https://api.llama.fi/protocol/crvusd",
  };
}

function protocolTvlUsd(json) {
  const direct = asNumber(json?.tvl);
  if (direct !== null) return direct;
  const currentEth = asNumber(json?.currentChainTvls?.Ethereum);
  if (currentEth !== null) return currentEth;
  const chain = json?.chainTvls?.Ethereum;
  const series = Array.isArray(chain) ? chain : (Array.isArray(chain?.tvl) ? chain.tvl : []);
  const last = series.length ? series[series.length - 1] : null;
  return asNumber(last?.totalLiquidityUSD ?? last?.tvl ?? last?.totalLiquidityUsd);
}

async function curveApis() {
  const [lending, amms] = await Promise.all([
    fetchJson("https://api.curve.fi/v1/getLendingVaults/all", { headers: { accept: "application/json" }, timeoutMs: 20_000 }),
    fetchJson("https://api.curve.fi/v1/getVolumes/ethereum/crvusd-amms", { headers: { accept: "application/json" }, timeoutMs: 20_000 }),
  ]);
  const lendingVaults = lending?.data?.lendingVaultData || [];
  const crvusdAmms = amms?.data?.amms || [];
  return { lendingVaults, crvusdAmms };
}

async function tokenMeta(provider, token, fallback = {}) {
  const addr = normalizeAddress(token);
  if (!addr) return { address: null, symbol: fallback.symbol || "UNK", name: fallback.name || "", decimals: fallback.decimals ?? 18 };
  const c = new ethers.Contract(addr, ERC20_ABI, provider);
  const [symbol, name, decimals, totalSupply] = await Promise.all([
    tryCall(() => c.symbol(), fallback.symbol || null),
    tryCall(() => c.name(), fallback.name || null),
    tryCall(() => c.decimals(), fallback.decimals ?? 18),
    tryCall(() => c.totalSupply(), null),
  ]);
  return { address: addr, symbol: safeText(symbol || fallback.symbol || "UNK", 40), name: safeText(name || fallback.name || "", 100), decimals: Number(decimals ?? fallback.decimals ?? 18), totalSupply: totalSupply === null ? null : totalSupply.toString() };
}

function diffBps(a, b) {
  const aa = toBig(a);
  const bb = toBig(b);
  if (aa <= 0n || bb <= 0n) return null;
  const diff = aa > bb ? aa - bb : bb - aa;
  return Number((diff * 10000n) / (aa > bb ? aa : bb));
}

function sampleIndexes(count, limit) {
  const n = toBig(count);
  if (n <= 0n || limit <= 0) return [];
  const indexes = new Set(["0", (n - 1n).toString()]);
  const steps = Math.max(1, limit - indexes.size);
  for (let i = 1; i <= steps; i++) indexes.add(((n * BigInt(i)) / BigInt(steps + 1)).toString());
  return [...indexes].map((x) => BigInt(x)).filter((x) => x >= 0n && x < n).slice(0, limit);
}

function debtUsd(raw, decimals = 18) {
  const value = unitsToNumber(raw, decimals);
  return value === null ? null : round(value, 2);
}

function apiByAmm(crvusdAmms) {
  const by = new Map();
  for (const item of crvusdAmms || []) {
    const key = lowerAddress(item.address || item.amm || item.ammAddress);
    if (key) by.set(key, item);
  }
  return by;
}

async function scanFactory(provider) {
  const factory = new ethers.Contract(CRVUSD_FACTORY, FACTORY_ABI, provider);
  const code = await safeCode(provider, CRVUSD_FACTORY);
  const [admin, feeReceiver, stablecoin, nCollaterals, totalDebt, controllerImplementation, ammImplementation] = await Promise.all([
    tryCall(() => factory.admin(), null),
    tryCall(() => factory.fee_receiver(), null),
    tryCall(() => factory.stablecoin(), null),
    tryCall(() => factory.n_collaterals(), 0n),
    tryCall(() => factory.total_debt(), null),
    tryCall(() => factory.controller_implementation(), null),
    tryCall(() => factory.amm_implementation(), null),
  ]);
  const count = Number(nCollaterals || 0n);
  const limit = Math.min(count, MAX_ENUMERATE);
  const markets = [];
  for (let i = 0; i < limit; i++) {
    const [controller, amm, collateral] = await Promise.all([
      tryCall(() => factory.controllers(i), null),
      tryCall(() => factory.amms(i), null),
      tryCall(() => factory.collaterals(i), null),
    ]);
    const [debtCeiling, debtCeilingResidual] = controller ? await Promise.all([
      tryCall(() => factory.debt_ceiling(controller), null),
      tryCall(() => factory.debt_ceiling_residual(controller), null),
    ]) : [null, null];
    markets.push({
      index: i,
      controller: normalizeAddress(controller),
      amm: normalizeAddress(amm),
      collateral: normalizeAddress(collateral),
      debtCeiling: debtCeiling === null ? null : debtCeiling.toString(),
      debtCeilingResidual: debtCeilingResidual === null ? null : debtCeilingResidual.toString(),
      debtCeilingUsd: debtUsd(debtCeiling),
      debtCeilingResidualUsd: debtUsd(debtCeilingResidual),
    });
  }
  return {
    address: normalizeAddress(CRVUSD_FACTORY),
    codePresent: code !== "0x",
    codeBytes: code === "0x" ? 0 : (code.length - 2) / 2,
    admin: normalizeAddress(admin),
    adminKind: await addressKind(provider, admin),
    feeReceiver: normalizeAddress(feeReceiver),
    stablecoin: normalizeAddress(stablecoin),
    nCollaterals: count,
    totalDebt: totalDebt === null ? null : totalDebt.toString(),
    totalDebtUsd: debtUsd(totalDebt),
    controllerImplementation: normalizeAddress(controllerImplementation),
    ammImplementation: normalizeAddress(ammImplementation),
    capHit: count > MAX_ENUMERATE,
    markets,
  };
}

async function scanOracle(provider, oracleAddress, blockTimestamp) {
  const oracle = normalizeAddress(oracleAddress);
  if (!oracle) return null;
  const c = new ethers.Contract(oracle, ORACLE_ABI, provider);
  const code = await safeCode(provider, oracle);
  const [price, priceW, maExpTime, lastTimestamp, lastPrice, chainlinkFeedDirect, chainlinkStaleThreshold, pool, collateralIx, borrowedIx, nPools, stableAggregator] = await Promise.all([
    tryCall(() => c.price(), null),
    tryCall(() => c.price_w(), null),
    tryCall(() => c.MA_EXP_TIME(), null),
    tryCall(() => c.last_timestamp(), null),
    tryCall(() => c.last_price(), null),
    tryCall(() => c.chainlink_feed(), null),
    tryCall(() => c.CHAINLINK_STALE_THRESHOLD(), null),
    tryCall(() => c.POOL(), null),
    tryCall(() => c.COLLATERAL_IX(), null),
    tryCall(() => c.BORROWED_IX(), null),
    tryCall(() => c.N_POOLS(), null),
    tryCall(() => c.stable_aggregator(), null),
  ]);
  const source = await sourcifySource(oracle);
  const feedFromSource = decodeFeedAddress(source.title, source.constructorArgs);
  const chainlinkFeed = normalizeAddress(chainlinkFeedDirect) || feedFromSource;
  const feedState = chainlinkFeed ? await scanFeed(provider, chainlinkFeed, blockTimestamp) : null;
  const priceWriteDiffBps = price !== null && priceW !== null ? diffBps(price, priceW) : null;
  const pools = [];
  const poolCount = nPools === null ? 0 : Math.min(Number(nPools), 6);
  for (let i = 0; i < poolCount; i++) {
    const [tri, stable] = await Promise.all([
      tryCall(() => c.tricrypto(i), null),
      tryCall(() => c.stableswap(i), null),
    ]);
    if (normalizeAddress(tri)) pools.push({ type: "tricrypto", index: i, address: normalizeAddress(tri) });
    if (normalizeAddress(stable)) pools.push({ type: "stableswap", index: i, address: normalizeAddress(stable) });
  }
  const typeHints = [];
  if (pool) typeHints.push("pool-derived");
  if (nPools !== null) typeHints.push("multi-pool");
  if (chainlinkFeed) typeHints.push("chainlink-linked");
  if (maExpTime !== null || lastTimestamp !== null) typeHints.push("ema-like");
  if (!typeHints.length && price !== null) typeHints.push("price-only");
  return {
    address: oracle,
    codePresent: code !== "0x",
    sourceTitle: source.title,
    sourceStatus: source.status,
    typeHints,
    price: price === null ? null : price.toString(),
    priceW: priceW === null ? null : priceW.toString(),
    priceWriteDiffBps,
    maExpTimeSeconds: maExpTime === null ? null : Number(maExpTime),
    lastTimestamp: lastTimestamp === null ? null : Number(lastTimestamp),
    lastPrice: lastPrice === null ? null : lastPrice.toString(),
    pool: normalizeAddress(pool),
    collateralIx: collateralIx === null ? null : collateralIx.toString(),
    borrowedIx: borrowedIx === null ? null : borrowedIx.toString(),
    nPools: nPools === null ? null : Number(nPools),
    pools,
    stableAggregator: normalizeAddress(stableAggregator),
    chainlinkFeed,
    chainlinkStaleThresholdSeconds: chainlinkStaleThreshold === null ? null : Number(chainlinkStaleThreshold),
    feedState,
    feedWarn: Boolean(feedState && feedState.ageSeconds !== null && feedState.ageSeconds >= CHAINLINK_WARN_SECONDS),
    feedStale: Boolean(feedState && feedState.ageSeconds !== null && feedState.ageSeconds >= (chainlinkStaleThreshold ? Number(chainlinkStaleThreshold) : CHAINLINK_STALE_SECONDS)),
  };
}

async function scanFeed(provider, feed, blockTimestamp) {
  const c = new ethers.Contract(feed, FEED_ABI, provider);
  const [decimals, description, latestRoundData] = await Promise.all([
    tryCall(() => c.decimals(), null),
    tryCall(() => c.description(), null),
    tryCall(() => c.latestRoundData(), null),
  ]);
  const updatedAt = latestRoundData ? Number(latestRoundData[3]) : null;
  const answer = latestRoundData ? latestRoundData[1] : null;
  return {
    feed: normalizeAddress(feed),
    decimals: decimals === null ? null : Number(decimals),
    description: safeText(description || "", 80),
    answer: answer === null ? null : answer.toString(),
    updatedAt,
    ageSeconds: updatedAt === null ? null : Math.max(0, Number(blockTimestamp) - updatedAt),
    answeredInRound: latestRoundData ? latestRoundData[4].toString() : null,
  };
}

async function sourcifySource(address) {
  const addr = lowerAddress(address);
  if (!addr) return { status: null, title: null, constructorArgs: null };
  for (const status of ["full_match", "partial_match"]) {
    const base = `https://repo.sourcify.dev/contracts/${status}/1/${addr}`;
    try {
      const metadataResponse = await fetch(`${base}/metadata.json`, { signal: AbortSignal.timeout(8_000) });
      if (!metadataResponse.ok) continue;
      const metadata = await metadataResponse.json();
      const argsResponse = await fetch(`${base}/constructor-args.txt`, { signal: AbortSignal.timeout(8_000) });
      const constructorArgs = argsResponse.ok ? (await argsResponse.text()).trim() : null;
      return {
        status,
        title: metadata.output?.devdoc?.title || Object.values(metadata.settings?.compilationTarget || {})[0] || null,
        constructorArgs,
      };
    } catch (_) {
      // Try the next Sourcify status.
    }
  }
  return { status: null, title: null, constructorArgs: null };
}

function decodeFeedAddress(title, constructorArgs) {
  const words = splitWords(constructorArgs);
  if (!title || words.length === 0) return null;
  if (/GoldChainlinkPrice/i.test(title)) return decodeAddressWord(words[0]);
  if (/ChainlinkFrxeth/i.test(title)) return decodeAddressWord(words[5]);
  if (/CryptoWithStablePriceAndChainlink/i.test(title)) return decodeAddressWord(words[4]);
  return null;
}

async function sampleBorrowers(controller, nLoans, blockTimestamp) {
  const count = toBig(nLoans);
  const rows = [];
  for (const index of sampleIndexes(count, MAX_BORROWER_SAMPLES_PER_CONTROLLER)) {
    const borrower = normalizeAddress(await tryCall(() => controller.loans(index), null));
    if (!borrower || borrower === ZERO) {
      rows.push({ index: index.toString(), borrower: null, status: "empty-or-unreadable" });
      continue;
    }
    const [debt, loanExists, health, healthFull, tokensToLiquidate, userState] = await Promise.all([
      tryCall(() => controller.debt(borrower), null),
      tryCall(() => controller.loan_exists(borrower), null),
      tryCall(() => controller["health(address,bool)"](borrower, false), null),
      tryCall(() => controller["health(address,bool)"](borrower, true), null),
      tryCall(() => controller.tokens_to_liquidate(borrower), null),
      tryCall(() => controller.user_state(borrower), null),
    ]);
    const healthFullBig = healthFull === null ? null : toBig(healthFull);
    const tokensToLiquidateUsd = debtUsd(tokensToLiquidate);
    rows.push({
      index: index.toString(),
      borrower,
      blockTimestamp,
      loanExists,
      debt: debt === null ? null : debt.toString(),
      debtUsd: debtUsd(debt),
      health: health === null ? null : health.toString(),
      healthFull: healthFull === null ? null : healthFull.toString(),
      liquidatable: healthFullBig !== null && healthFullBig < 0n,
      nearLiquidation: healthFullBig !== null && healthFullBig >= 0n && healthFullBig < WAD / 50n,
      tokensToLiquidate: tokensToLiquidate === null ? null : tokensToLiquidate.toString(),
      tokensToLiquidateUsd,
      materialLiquidatable: healthFullBig !== null && healthFullBig < 0n && (tokensToLiquidateUsd || 0) >= MATERIAL_USD,
      userState: Array.isArray(userState) ? {
        collateral: userState[0]?.toString?.() || null,
        borrowedInAmm: userState[1]?.toString?.() || null,
        debt: userState[2]?.toString?.() || null,
        n: userState[3]?.toString?.() || null,
      } : null,
    });
  }
  return rows;
}

async function scanMarket(provider, factoryMarket, api, oracleCache, blockTimestamp) {
  const controllerAddr = normalizeAddress(factoryMarket.controller);
  const ammAddr = normalizeAddress(factoryMarket.amm);
  const controller = controllerAddr ? new ethers.Contract(controllerAddr, CONTROLLER_ABI, provider) : null;
  const amm = ammAddr ? new ethers.Contract(ammAddr, AMM_ABI, provider) : null;
  const flags = [];
  const [controllerCode, ammCode] = await Promise.all([safeCode(provider, controllerAddr), safeCode(provider, ammAddr)]);
  if (controllerCode === "0x") flags.push("CONTROLLER_NO_CODE");
  if (ammCode === "0x") flags.push("AMM_NO_CODE");

  const [factory, controllerAmm, collateralToken, borrowedToken, monetaryPolicy, availableBalance, totalDebt, minted, redeemed, adminFees, loanDiscount, liquidationDiscount, nLoans] = controller ? await Promise.all([
    tryCall(() => controller.factory(), null),
    tryCall(() => controller.amm(), null),
    tryCall(() => controller.collateral_token(), null),
    tryCall(() => controller.borrowed_token(), null),
    tryCall(() => controller.monetary_policy(), null),
    tryCall(() => controller.available_balance(), null),
    tryCall(() => controller.total_debt(), null),
    tryCall(() => controller.minted(), null),
    tryCall(() => controller.redeemed(), null),
    tryCall(() => controller.admin_fees(), null),
    tryCall(() => controller.loan_discount(), null),
    tryCall(() => controller.liquidation_discount(), null),
    tryCall(() => controller.n_loans(), 0n),
  ]) : [];
  const [ammAdmin, A, fee, rate, rateMul, activeBand, activeBandWithSkip, minBand, maxBand, priceOracleContract, priceOracleLimited, ammPrice, coin0, coin1] = amm ? await Promise.all([
    tryCall(() => amm.admin(), null),
    tryCall(() => amm.A(), null),
    tryCall(() => amm.fee(), null),
    tryCall(() => amm.rate(), null),
    tryCall(() => amm.get_rate_mul(), null),
    tryCall(() => amm.active_band(), null),
    tryCall(() => amm.active_band_with_skip(), null),
    tryCall(() => amm.min_band(), null),
    tryCall(() => amm.max_band(), null),
    tryCall(() => amm.price_oracle_contract(), null),
    tryCall(() => amm.price_oracle(), null),
    tryCall(() => amm.get_p(), null),
    tryCall(() => amm.coins(0), null),
    tryCall(() => amm.coins(1), null),
  ]) : [];

  if (factory && !sameAddress(factory, CRVUSD_FACTORY)) flags.push("FACTORY_MISMATCH");
  if (controllerAmm && ammAddr && !sameAddress(controllerAmm, ammAddr)) flags.push("CONTROLLER_AMM_MISMATCH");
  if (ammAdmin && controllerAddr && !sameAddress(ammAdmin, controllerAddr)) flags.push("AMM_ADMIN_NOT_CONTROLLER");
  if (borrowedToken && !sameAddress(borrowedToken, CRVUSD)) flags.push("BORROWED_TOKEN_NOT_CRVUSD");
  if (activeBand !== null && activeBandWithSkip !== null && toBig(activeBand) !== toBig(activeBandWithSkip)) flags.push("ACTIVE_BAND_CAN_SKIP");
  if (priceOracleLimited !== null && priceOracleLimited <= 0n) flags.push("AMM_LIMITED_ORACLE_ZERO");

  const oracleAddr = normalizeAddress(priceOracleContract);
  let oracle = null;
  if (oracleAddr) {
    const key = lowerAddress(oracleAddr);
    if (!oracleCache.has(key)) oracleCache.set(key, await scanOracle(provider, oracleAddr, blockTimestamp));
    oracle = oracleCache.get(key);
  }
  const limitedDiffBps = oracle?.price && priceOracleLimited !== null ? diffBps(priceOracleLimited, oracle.price) : null;
  if (limitedDiffBps !== null && limitedDiffBps >= ORACLE_DIFF_WATCH_BPS) flags.push("AMM_ORACLE_LIMIT_DIFF_WATCH");
  if (oracle?.feedStale) flags.push("CHAINLINK_FEED_STALE");
  else if (oracle?.feedWarn) flags.push("CHAINLINK_FEED_WARN");
  if (oracle?.priceWriteDiffBps !== null && oracle?.priceWriteDiffBps >= ORACLE_DIFF_WATCH_BPS) flags.push("ORACLE_PRICE_W_DIFF_WATCH");

  const bands = [];
  if (amm && activeBand !== null) {
    const active = toBig(activeBand);
    const indexes = unique([active - 2n, active - 1n, active, active + 1n, active + 2n, minBand, maxBand].filter((x) => x !== null && x !== undefined).map((x) => toBig(x).toString())).slice(0, 9);
    for (const nText of indexes) {
      const n = BigInt(nText);
      const [x, y] = await Promise.all([
        tryCall(() => amm.bands_x(n), null),
        tryCall(() => amm.bands_y(n), null),
      ]);
      bands.push({ n: n.toString(), x: x === null ? null : x.toString(), y: y === null ? null : y.toString() });
    }
  }

  const [borrowedMeta, collateralMeta] = await Promise.all([
    tokenMeta(provider, normalizeAddress(borrowedToken) || CRVUSD, { symbol: "crvUSD", decimals: 18 }),
    tokenMeta(provider, normalizeAddress(collateralToken) || normalizeAddress(factoryMarket.collateral), { decimals: 18 }),
  ]);
  const borrowerRows = controller ? await sampleBorrowers(controller, nLoans || 0n, blockTimestamp) : [];
  const totalDebtUsd = debtUsd(totalDebt, borrowedMeta.decimals);
  const availableBalanceUsd = debtUsd(availableBalance, borrowedMeta.decimals);
  const loanDiscountBps = wadToBps(loanDiscount);
  const impliedMaxLtvBps = loanDiscountBps === null ? null : Math.max(0, 10000 - loanDiscountBps);
  const invariantMismatch = flags.some((flag) => /MISMATCH|NOT_CRVUSD|NO_CODE/.test(flag));
  const oracleWatch = Boolean(oracle?.feedStale || limitedDiffBps >= ORACLE_DIFF_WATCH_BPS || (oracle?.priceWriteDiffBps ?? 0) >= ORACLE_DIFF_WATCH_BPS);
  const materialDebt = (totalDebtUsd || 0) >= MATERIAL_USD;
  return {
    kind: "crvusd-cdp",
    index: factoryMarket.index,
    controller: controllerAddr,
    amm: ammAddr,
    api: api ? { address: api.address || null, volumeUSD: asNumber(api.volumeUSD) } : null,
    flags,
    code: { controllerBytes: controllerCode === "0x" ? 0 : (controllerCode.length - 2) / 2, ammBytes: ammCode === "0x" ? 0 : (ammCode.length - 2) / 2 },
    controllerState: {
      factory: normalizeAddress(factory),
      amm: normalizeAddress(controllerAmm),
      collateralToken: normalizeAddress(collateralToken),
      borrowedToken: normalizeAddress(borrowedToken),
      monetaryPolicy: normalizeAddress(monetaryPolicy),
      availableBalance: availableBalance === null ? null : availableBalance.toString(),
      availableBalanceUsd,
      totalDebt: totalDebt === null ? null : totalDebt.toString(),
      totalDebtUsd,
      minted: minted === null ? null : minted.toString(),
      redeemed: redeemed === null ? null : redeemed.toString(),
      adminFees: adminFees === null ? null : adminFees.toString(),
      loanDiscount: loanDiscount === null ? null : loanDiscount.toString(),
      loanDiscountBps,
      impliedMaxLtvBps,
      liquidationDiscount: liquidationDiscount === null ? null : liquidationDiscount.toString(),
      liquidationDiscountBps: wadToBps(liquidationDiscount),
      nLoans: nLoans === null ? null : nLoans.toString(),
    },
    factoryState: { debtCeiling: factoryMarket.debtCeiling, debtCeilingUsd: factoryMarket.debtCeilingUsd, debtCeilingResidual: factoryMarket.debtCeilingResidual, debtCeilingResidualUsd: factoryMarket.debtCeilingResidualUsd },
    ammState: {
      admin: normalizeAddress(ammAdmin),
      A: A === null ? null : A.toString(),
      fee: fee === null ? null : fee.toString(),
      rate: rate === null ? null : rate.toString(),
      rateMul: rateMul === null ? null : rateMul.toString(),
      activeBand: activeBand === null ? null : activeBand.toString(),
      activeBandWithSkip: activeBandWithSkip === null ? null : activeBandWithSkip.toString(),
      minBand: minBand === null ? null : minBand.toString(),
      maxBand: maxBand === null ? null : maxBand.toString(),
      priceOracleContract: oracleAddr,
      priceOracleLimited: priceOracleLimited === null ? null : priceOracleLimited.toString(),
      getP: ammPrice === null ? null : ammPrice.toString(),
      limitedRawOracleDiffBps: limitedDiffBps,
      coin0: normalizeAddress(coin0),
      coin1: normalizeAddress(coin1),
      bands,
    },
    oracle,
    borrowed: borrowedMeta,
    collateral: collateralMeta,
    borrowerRows,
    sampledBorrowers: borrowerRows.filter((row) => row.borrower).length,
    sampledLiquidatableBorrowers: borrowerRows.filter((row) => row.liquidatable).length,
    materialSampledLiquidatableBorrowers: borrowerRows.filter((row) => row.materialLiquidatable).length,
    materialDebt,
    watchCandidate: materialDebt && (oracleWatch || invariantMismatch),
    routePositive: false,
  };
}

async function scanPolicies(provider, markets) {
  const policies = unique(markets.map((m) => m.controllerState?.monetaryPolicy).filter(Boolean).map(normalizeAddress));
  const rows = [];
  const pegkeepers = new Set(SOURCE_PEGKEEPERS.map((a) => normalizeAddress(a)));
  for (const address of policies) {
    const policy = new ethers.Contract(address, POLICY_ABI, provider);
    const [code, nPegKeepers, priceOracle, controllerFactory, nControllers, rate0, sigma, targetDebtFraction] = await Promise.all([
      safeCode(provider, address),
      tryCall(() => policy.n_peg_keepers(), null),
      tryCall(() => policy.PRICE_ORACLE(), null),
      tryCall(() => policy.CONTROLLER_FACTORY(), null),
      tryCall(() => policy.n_controllers(), null),
      tryCall(() => policy.rate0(), null),
      tryCall(() => policy.sigma(), null),
      tryCall(() => policy.target_debt_fraction(), null),
    ]);
    const pks = [];
    const n = nPegKeepers === null ? 0 : Math.min(Number(nPegKeepers), 25);
    for (let i = 0; i < n; i++) {
      const pk = normalizeAddress(await tryCall(() => policy.peg_keepers(i), null));
      if (pk && pk !== ZERO) { pks.push(pk); pegkeepers.add(pk); }
    }
    rows.push({
      address,
      codePresent: code !== "0x",
      marketsUsingPolicy: markets.filter((m) => sameAddress(m.controllerState?.monetaryPolicy, address)).map((m) => ({ controller: m.controller, collateralSymbol: m.collateral?.symbol || null, totalDebtUsd: m.controllerState?.totalDebtUsd ?? null })),
      nPegKeepers: nPegKeepers === null ? null : Number(nPegKeepers),
      pegKeepers: pks,
      priceOracle: normalizeAddress(priceOracle),
      controllerFactory: normalizeAddress(controllerFactory),
      nControllers: nControllers === null ? null : Number(nControllers),
      rate0: rate0 === null ? null : rate0.toString(),
      sigma: sigma === null ? null : sigma.toString(),
      targetDebtFraction: targetDebtFraction === null ? null : targetDebtFraction.toString(),
    });
  }
  return { policyRows: rows, pegkeeperAddresses: [...pegkeepers].filter(Boolean) };
}

async function scanPegkeepers(provider, pegkeeperAddresses) {
  const rows = [];
  for (const address of unique(pegkeeperAddresses.map(normalizeAddress))) {
    if (!address || address === ZERO) continue;
    const pk = new ethers.Contract(address, PEGKEEPER_ABI, provider);
    const code = await safeCode(provider, address);
    const [factory, pegged, poolAddr, aggregator, regulatorAddr, debt, callerShare, lastChange, actionDelay, calcProfit, estimateCallerProfit, isInverse] = await Promise.all([
      tryCall(() => pk.factory(), null),
      tryCall(() => pk.pegged(), null),
      tryCall(() => pk.pool(), null),
      tryCall(() => pk.aggregator(), null),
      tryCall(() => pk.regulator(), null),
      tryCall(() => pk.debt(), null),
      tryCall(() => pk.caller_share(), null),
      tryCall(() => pk.last_change(), null),
      tryCall(() => pk.action_delay(), null),
      tryCall(() => pk.calc_profit(), null),
      tryCall(() => pk.estimate_caller_profit(), null),
      tryCall(() => pk.IS_INVERSE(), null),
    ]);
    const pool = normalizeAddress(poolAddr) ? new ethers.Contract(normalizeAddress(poolAddr), POOL_ABI, provider) : null;
    const [virtualPrice, lpBalance, poolTotalSupply, poolCoin0, poolCoin1, poolBalance0, poolBalance1, poolPriceOracle, poolPriceOracle0, poolGetP, poolGetP0] = pool ? await Promise.all([
      tryCall(() => pool.get_virtual_price(), null),
      tryCall(() => pool.balanceOf(address), null),
      tryCall(() => pool.totalSupply(), null),
      tryCall(() => pool.coins(0), null),
      tryCall(() => pool.coins(1), null),
      tryCall(() => pool.balances(0), null),
      tryCall(() => pool.balances(1), null),
      tryCall(() => pool.price_oracle(), null),
      tryCall(() => pool["price_oracle(uint256)"](0), null),
      tryCall(() => pool.get_p(), null),
      tryCall(() => pool["get_p(uint256)"](0), null),
    ]) : [];
    const regulator = normalizeAddress(regulatorAddr) ? new ethers.Contract(normalizeAddress(regulatorAddr), REGULATOR_ABI, provider) : null;
    const [provideAllowed, withdrawAllowed, regStablecoin, regAggregator, worstPriceThreshold, priceDeviation, alpha, beta, feeReceiver, regulatorAdmin, emergencyAdmin] = regulator ? await Promise.all([
      tryCall(() => regulator.provide_allowed(address), null),
      tryCall(() => regulator.withdraw_allowed(address), null),
      tryCall(() => regulator.stablecoin(), null),
      tryCall(() => regulator.aggregator(), null),
      tryCall(() => regulator.worst_price_threshold(), null),
      tryCall(() => regulator.price_deviation(), null),
      tryCall(() => regulator.alpha(), null),
      tryCall(() => regulator.beta(), null),
      tryCall(() => regulator.fee_receiver(), null),
      tryCall(() => regulator.admin(), null),
      tryCall(() => regulator.emergency_admin(), null),
    ]) : [];
    const estimateCallerProfitUsd = estimateCallerProfit !== null && virtualPrice !== null ? unitsToNumber((toBig(estimateCallerProfit) * toBig(virtualPrice)) / WAD, 18) : null;
    rows.push({
      address,
      codePresent: code !== "0x",
      source: SOURCE_PEGKEEPERS.some((pkAddr) => sameAddress(pkAddr, address)) ? "source-and/or-policy" : "policy-discovered",
      factory: normalizeAddress(factory),
      pegged: normalizeAddress(pegged),
      pool: normalizeAddress(poolAddr),
      aggregator: normalizeAddress(aggregator),
      regulator: normalizeAddress(regulatorAddr),
      debt: debt === null ? null : debt.toString(),
      debtUsdApprox: debtUsd(debt),
      callerShare: callerShare === null ? null : callerShare.toString(),
      lastChange: lastChange === null ? null : Number(lastChange),
      actionDelaySeconds: actionDelay === null ? null : Number(actionDelay),
      calcProfitLp: calcProfit === null ? null : calcProfit.toString(),
      estimateCallerProfitLp: estimateCallerProfit === null ? null : estimateCallerProfit.toString(),
      estimateCallerProfitUsdApprox: round(estimateCallerProfitUsd, 2),
      materialEstimatedCallerProfit: (estimateCallerProfitUsd || 0) >= MATERIAL_USD,
      isInverse,
      poolState: pool ? {
        virtualPrice: virtualPrice === null ? null : virtualPrice.toString(),
        lpBalance: lpBalance === null ? null : lpBalance.toString(),
        totalSupply: poolTotalSupply === null ? null : poolTotalSupply.toString(),
        coin0: normalizeAddress(poolCoin0),
        coin1: normalizeAddress(poolCoin1),
        balance0: poolBalance0 === null ? null : poolBalance0.toString(),
        balance1: poolBalance1 === null ? null : poolBalance1.toString(),
        priceOracle: poolPriceOracle === null ? null : poolPriceOracle.toString(),
        priceOracle0: poolPriceOracle0 === null ? null : poolPriceOracle0.toString(),
        getP: poolGetP === null ? null : poolGetP.toString(),
        getP0: poolGetP0 === null ? null : poolGetP0.toString(),
      } : null,
      regulatorState: regulator ? {
        provideAllowed: provideAllowed === null ? null : provideAllowed.toString(),
        provideAllowedUsdApprox: debtUsd(provideAllowed),
        withdrawAllowed: withdrawAllowed === null ? null : withdrawAllowed.toString(),
        withdrawAllowedUsdApprox: withdrawAllowed && toBig(withdrawAllowed) > (1n << 200n) ? "unbounded" : debtUsd(withdrawAllowed),
        stablecoin: normalizeAddress(regStablecoin),
        aggregator: normalizeAddress(regAggregator),
        worstPriceThreshold: worstPriceThreshold === null ? null : worstPriceThreshold.toString(),
        priceDeviation: priceDeviation === null ? null : priceDeviation.toString(),
        alpha: alpha === null ? null : alpha.toString(),
        beta: beta === null ? null : beta.toString(),
        feeReceiver: normalizeAddress(feeReceiver),
        admin: normalizeAddress(regulatorAdmin),
        emergencyAdmin: normalizeAddress(emergencyAdmin),
      } : null,
      routePositive: false,
    });
  }
  return rows;
}

function marketReportRows(markets) {
  const sorted = [...markets].sort((a, b) => (b.controllerState?.totalDebtUsd || 0) - (a.controllerState?.totalDebtUsd || 0));
  return sorted.map((m) => `| ${m.collateral?.symbol || "?"} | ${compactAddress(m.controller)} | ${formatUsd(m.controllerState?.totalDebtUsd)} | ${formatUsd(m.controllerState?.availableBalanceUsd)} | ${formatPctBps(m.controllerState?.impliedMaxLtvBps)} | ${m.sampledBorrowers}/${m.sampledLiquidatableBorrowers}/${m.materialSampledLiquidatableBorrowers} | ${m.ammState?.limitedRawOracleDiffBps === null ? "n/a" : formatBps(m.ammState.limitedRawOracleDiffBps)} | ${m.watchCandidate ? "watch" : "context"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a | n/a |";
}

function pegkeeperReportRows(rows) {
  return rows.map((row) => `| ${compactAddress(row.address)} | ${compactAddress(row.pool)} | ${formatUsd(row.debtUsdApprox)} | ${formatUsd(row.estimateCallerProfitUsdApprox)} | ${row.regulatorState?.provideAllowedUsdApprox === null ? "n/a" : formatUsd(row.regulatorState?.provideAllowedUsdApprox)} | ${row.regulatorState?.withdrawAllowedUsdApprox || "n/a"} | ${row.materialEstimatedCallerProfit ? "material-context" : "context"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a |";
}

function writeReport(out) {
  const s = out.summary;
  const lines = [
    `# ${SIGNAL_BANNER} - crvUSD Phase 0 Triage`,
    "",
    `Date: ${out.generatedAt}`,
    "",
    "## Result",
    "",
    "No confirmed permissionless value-extracting exploit was found in this read-only Phase 0 refresh. Ethereum crvUSD controllers, LLAMMAs, oracle links, PegKeeper state, and bounded borrower samples were mapped; no stale/divergent oracle state or liquidation/keeper path has exact positive economics or fork proof.",
    "",
    "Raw outputs:",
    "",
    "| File | Contents |",
    "|---|---|",
    "| `reports/raw/fast/crvusd-phase0.json` | current Ethereum crvUSD CDP/LLAMMA/oracle/PegKeeper scan |",
    "",
    "## Summary",
    "",
    "| Metric | Value |",
    "|---|---:|",
    `| Public TVL context | ${formatUsd(s.defillamaCurrentTvlUsd)} |`,
    `| Factory markets scanned | ${s.factoryMarketsScanned}/${s.factoryMarkets} |`,
    `| Market rows | ${s.marketRows} |`,
    `| Total debt context | ${formatUsd(s.totalDebtUsd)} |`,
    `| Available crvUSD context | ${formatUsd(s.availableCrvusdUsd)} |`,
    `| Unique oracle rows | ${s.uniqueOracleRows} |`,
    `| Chainlink stale rows | ${s.staleFeedRows} |`,
    `| Oracle diff rows | ${s.oracleDiffRows} |`,
    `| PegKeepers mapped | ${s.pegKeeperRows} |`,
    `| Material PegKeeper profit rows | ${s.materialPegKeeperProfitRows} |`,
    `| Bounded borrower samples | ${s.sampledBorrowers} |`,
    `| Material sampled liquidatable borrowers | ${s.materialSampledLiquidatableBorrowers} |`,
    `| Watch candidates | ${s.watchCandidates} |`,
    `| Route positive | ${s.routePositive} |`,
    "",
    "## Markets",
    "",
    "| Collateral | Controller | Debt | Available crvUSD | Implied max LTV | Borrowers sampled/liquidatable/material | Oracle diff | Status |",
    "|---|---|---:|---:|---:|---:|---:|---|",
    marketReportRows(out.marketRows),
    "",
    "## PegKeepers",
    "",
    "| PegKeeper | Pool | Debt | Est. caller profit | Provide allowed | Withdraw allowed | Status |",
    "|---|---|---:|---:|---:|---:|---|",
    pegkeeperReportRows(out.pegKeeperRows),
    "",
    "PegKeeper caller-profit values are LP-token estimates and are treated as intended keeper-incentive context, not as an exploit route without exact LP exit quotes, gas, MEV/slippage, and fork proof.",
    "",
    "## Blockers",
    "",
    "- Oracle and LLAMMA rows are context only unless a current accepted price becomes stale/divergent and maps to exact positive borrow/liquidation/unwind economics.",
    "- Sampled liquidatable borrowers are ordinary crvUSD liquidation state unless repay sizing, collateral exit, gas/slippage, and fork proof show extractive profit.",
    "- PegKeeper update profit is an intended keeper surface and remains non-actionable here without exact LP exit and signed-action authorization.",
    "- No fork extraction proof exists, and no signed action is justified.",
    "",
    "## Reopen Triggers",
    "",
    "- A crvUSD market accepts a stale or attacker-favorable oracle value while debt and collateral exit liquidity are material.",
    "- A borrower becomes material-liquidatable and exact repay/seize/collateral-exit economics are positive after gas/slippage.",
    "- PegKeeper/regulator state exposes a material caller-profit opportunity whose LP token can be exited exactly-positive after costs and governance/keeper intent review.",
    "",
    "## Close-Out",
    "",
    "crvUSD remains dormant for the declared Phase 0 scope. No fork, executor, or live action is justified from this pass.",
  ];
  ensureDir(REPORT_OUT);
  fs.writeFileSync(REPORT_OUT, `${lines.join("\n")}\n`);
}

async function main() {
  const [metadata, apis, rpcPool] = await Promise.all([
    protocolMetadata(),
    curveApis(),
    resolveRpcPool([ETHEREUM_CHAIN_ID]),
  ]);
  const rpc = rpcPool[ETHEREUM_CHAIN_ID];
  if (!rpc) throw new Error("No Ethereum RPC endpoint resolved");
  const provider = new ethers.JsonRpcProvider(rpc, ETHEREUM_CHAIN_ID, { batchMaxCount: 1, staticNetwork: true });
  const [blockNumber, block] = await Promise.all([provider.getBlockNumber(), provider.getBlock("latest")]);
  const blockTimestamp = Number(block?.timestamp || Math.floor(Date.now() / 1000));
  const factoryRow = await scanFactory(provider);
  const apiMap = apiByAmm(apis.crvusdAmms);
  const oracleCache = new Map();
  const marketRows = [];
  for (const market of factoryRow.markets) {
    marketRows.push(await scanMarket(provider, market, apiMap.get(lowerAddress(market.amm)), oracleCache, blockTimestamp));
  }
  const { policyRows, pegkeeperAddresses } = await scanPolicies(provider, marketRows);
  const pegKeeperRows = await scanPegkeepers(provider, pegkeeperAddresses);
  const roleRows = [
    { role: "factoryAdmin", address: factoryRow.admin, kind: factoryRow.adminKind },
    { role: "factoryFeeReceiver", address: factoryRow.feeReceiver, kind: await addressKind(provider, factoryRow.feeReceiver) },
    ...policyRows.map((row) => ({ role: "monetaryPolicy", address: row.address, kind: "contract", markets: row.marketsUsingPolicy.length })),
  ];
  const oracleRows = [...oracleCache.values()].filter(Boolean);
  const borrowerRows = marketRows.flatMap((m) => (m.borrowerRows || []).map((row) => ({ marketIndex: m.index, controller: m.controller, collateralSymbol: m.collateral?.symbol || null, ...row })));
  const materialSampledLiquidatableBorrowers = borrowerRows.filter((row) => row.materialLiquidatable).length;
  const summary = {
    defillamaCurrentTvlUsd: round(metadata.tvlUsd, 2),
    blockNumber,
    blockTimestamp,
    factoryMarkets: factoryRow.nCollaterals,
    factoryMarketsScanned: factoryRow.markets.length,
    factoryCapHit: factoryRow.capHit,
    marketRows: marketRows.length,
    marketsWithCode: marketRows.filter((row) => row.code.controllerBytes > 0 && row.code.ammBytes > 0).length,
    totalDebtUsd: round(marketRows.reduce((sum, row) => sum + (asNumber(row.controllerState?.totalDebtUsd) || 0), 0), 2),
    availableCrvusdUsd: round(marketRows.reduce((sum, row) => sum + (asNumber(row.controllerState?.availableBalanceUsd) || 0), 0), 2),
    materialDebtRows: marketRows.filter((row) => row.materialDebt).length,
    highLtvRows: marketRows.filter((row) => (asNumber(row.controllerState?.impliedMaxLtvBps) || 0) >= 7000).length,
    uniqueOracleRows: oracleRows.length,
    staleFeedRows: oracleRows.filter((row) => row.feedStale).length,
    feedWarnRows: oracleRows.filter((row) => row.feedWarn).length,
    oracleDiffRows: marketRows.filter((row) => (asNumber(row.ammState?.limitedRawOracleDiffBps) || 0) >= ORACLE_DIFF_WATCH_BPS || (asNumber(row.oracle?.priceWriteDiffBps) || 0) >= ORACLE_DIFF_WATCH_BPS).length,
    policyRows: policyRows.length,
    pegKeeperRows: pegKeeperRows.length,
    materialPegKeeperProfitRows: pegKeeperRows.filter((row) => row.materialEstimatedCallerProfit).length,
    sampledBorrowers: borrowerRows.filter((row) => row.borrower).length,
    sampledLiquidatableBorrowers: borrowerRows.filter((row) => row.liquidatable).length,
    materialSampledLiquidatableBorrowers,
    watchCandidates: marketRows.filter((row) => row.watchCandidate).length,
    routePositive: 0,
    executableNow: false,
    signedActionJustified: false,
    coverageClassification: "bounded-with-caveats",
    forkGate: "closed-route-positive-zero",
  };
  const out = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-crvusd-phase0.js",
    scope: "Read-only Ethereum crvUSD controller/LLAMMA/oracle/PegKeeper/borrower Phase 0 scan",
    target: { name: "crvUSD", slug: "crvusd", category: "CDP", chain: "Ethereum", chainId: ETHEREUM_CHAIN_ID, surface: "cdp-llamma-oracle-liquidation-pegkeeper", metadata },
    safety: {
      publicApisOnlyForMetadata: true,
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
    thresholds: { materialUsd: MATERIAL_USD, oracleDiffWatchBps: ORACLE_DIFF_WATCH_BPS, chainlinkWarnSeconds: CHAINLINK_WARN_SECONDS, chainlinkStaleSeconds: CHAINLINK_STALE_SECONDS, maxBorrowerSamplesPerController: MAX_BORROWER_SAMPLES_PER_CONTROLLER, maxEnumerate: MAX_ENUMERATE },
    docs: {
      curveLendingApi: "https://api.curve.fi/v1/getLendingVaults/all",
      curveCrvusdAmmApi: "https://api.curve.fi/v1/getVolumes/ethereum/crvusd-amms",
      priorTriage: "reports/curve-stablecoin-triage.md",
      factory: CRVUSD_FACTORY,
    },
    apiCounts: { lendingVaults: apis.lendingVaults.length, crvusdAmms: apis.crvusdAmms.length },
    summary,
    factoryRow,
    marketRows,
    oracleRows,
    policyRows,
    pegKeeperRows,
    borrowerRows,
    roleRows,
    routePositiveRows: [],
    watchRows: marketRows.filter((row) => row.watchCandidate),
    blockers: [
      "Oracle and LLAMMA rows require current stale/divergent accepted value plus exact positive borrow/liquidation/unwind economics",
      "Bounded borrower sampling is not exhaustive and ordinary liquidatables require exact repay/seize/exit economics plus fork proof",
      "PegKeeper profit is intended keeper-incentive context until exact LP exit, gas, and authorization are proven",
      "No fork extraction proof",
    ],
    requiredForRoutePositive: [
      "specific crvUSD market accepts attacker-favorable stale/divergent oracle/accounting state",
      "borrower liquidation, borrow, or PegKeeper path is permissionless and has material live liquidity",
      "repay/acquire/borrow/redeem/seized-collateral or LP exit route is exact-quoted after gas/slippage/fees",
      "fork extraction proof",
    ],
    nextReadOnlyStep: "Keep crvUSD on oracle staleness, material borrower liquidation, and PegKeeper-profit watch; exact-quote/fork only if a material row becomes exact-positive.",
  };
  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, JSON.stringify(out, jsonReplacer, 2));
  writeReport(out);
  if (!QUIET) {
    console.log(`crvUSD Phase 0: markets=${summary.factoryMarketsScanned}/${summary.factoryMarkets} debt=${formatUsd(summary.totalDebtUsd)} oracles=${summary.uniqueOracleRows} pegKeepers=${summary.pegKeeperRows} sampledBorrowers=${summary.sampledBorrowers} materialLiquidatable=${summary.materialSampledLiquidatableBorrowers} watch=${summary.watchCandidates} routePositive=${summary.routePositive}`);
    console.log(`Wrote ${path.relative(WORKSPACE, RAW_OUT)}`);
    console.log(`Report ${path.relative(WORKSPACE, REPORT_OUT)}`);
  }
}

main().catch((err) => {
  console.error(`crvUSD Phase 0 failed: ${err.message}`);
  process.exitCode = 1;
});
