#!/usr/bin/env node
"use strict";
// monitor-rearm-canary-multichain.js — read-only multichain sentinel monitor for the
// exploit re-arm canary amendment (batch exploit-rearm-canary-amendment-20260924).
// Chains: 1, 8453, 42161, 999 (strike sentinels) + 4663 (Robinhood monitor-only sentinels).
// NO signing, NO broadcast, NO secret reads. Endpoint values stay process-only; output is sanitized.
//
// Strike sentinels (55): reports/raw/fast/w9-strike-routes-20260922/sentinel-list-proposed.json
//   fired = availableLiquidityUsd > floorUsd
//     available = max(0, market.totalSupplyAssets - market.totalBorrowAssets)   (loan-raw)
//     floor = $0.06 where collateral is an open ERC-4626 (incl. bwUSDC 0x3c41bb7b…), else spec.floorUsd
//     USD pricing only for USD-stable loan legs; other legs are `exit-unpriced` (monitored + flagged).
// RH monitor-only sentinels (chain 4663):
//   rh:usde-usdg-modt-deviation  — deviation >= threshold | isChallenged | !isPrimary | USDE/USD <= 0.995012e8
//   rh:rh-equity-gap-threshold   — any equity-class market debt >= $10 (poller approach; W8-L3 evidence)
//
// Exit: 0 = all dormant, 3 = at least one FIRED, 1 = incomplete/operational error.
// Flags: --out <path> --once --loop <seconds> [--max-hours N]
//        --loop <seconds> --keep-watching-on-fire --no-deadline
// Both opt-ins are required to continue read-only observation after FIRE and
// past batch metadata expiry. Without them, FIRE exits and the batch deadline
// applies; --keep-watching-on-fire alone retains that deadline. The batch block
// in status is metadata, never authority for execution or readiness.
// --once --observation-only permits exactly one passive observation independently
// of that historical window. No loop, inventory override or authority renewal.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const net = require("net");
const dns = require("dns");
const https = require("https");

const ROOT = path.resolve(__dirname, "..");
const { ethers } = require(path.join(ROOT, "tools", "node_modules", "ethers"));
const { resolveRpc, rpcCall, loadRpcUrls, rpcCapabilityRank } = require(path.join(ROOT, "tools", "shared-rpc.js"));
const { rankProviderUrls, providerFamily } = require(path.join(ROOT, "tools", "lib", "rpc-provider-reliability.js"));
const { batchDeadline } = require(path.join(ROOT, "tools", "lib", "canary-loop-window.js"));
const { acquireCanaryOutputOwner, assertCanaryOutputOwner, CanaryOutputOwnershipError } =
  require(path.join(ROOT, "tools", "lib", "canary-output-owner.js"));
const { installCanaryReadOnlyStop } = require(path.join(ROOT, "tools", "lib", "canary-readonly-stop.js"));
const { envelope, predicate, check, ratioDecimal } = require("./monitor-evidence");

const BATCH = "exploit-rearm-canary-renewal-20261011";
const BATCH_STARTED_AT = "2026-10-11T22:10:00.000Z";
const BATCH_EXPIRES_AT = "2026-10-25T22:10:00.000Z";
const PROFIT_DESTINATION = "0x24e46e91dfaad1fa3d49c48aa85ca9306885ce0a";
const CHAIN_IDS = [1, 8453, 42161, 999, 4663, 56, 31612, 480, 747474, 5042];
const CHAIN_ALIAS = { 1: "ethereum", 8453: "base", 42161: "arbitrum", 999: "hyperevm", 4663: "robinhood", 56: "bsc", 31612: "mezo", 480: "world", 747474: "katana", 5042: "arc" };
const DEFAULT_OUT = path.join(ROOT, "reports", "raw", "fast", "exploit-rearm-canary", "status-multichain.json");
const SENTINEL_SOURCE = path.join(ROOT, "reports", "raw", "fast", "w9-strike-routes-20260922", "sentinel-list-proposed.json");
const EXECUTION_EVIDENCE = path.join(ROOT, "reports", "raw", "fast", "w9-bwusdc-strike-20260924", "execution.json");
const HISTORY_MAX_RUNS = 50;
const LAST_FIRE_MAX_SENTINELS = 128;

const ERC4626_FLOOR_USD = 0.06;
const BWUSDC_MARKET = "0x3c41bb7bcd549d7526f0b223f1f5821cb4db5583667f8fed5a59d5556a1e4a1c";
const PENDLE_PT_MARKET = "0xe6a832e464f2afc8639ae6982c6dc06520b43a85babcddfd892781bbc95ad280";
const PENDLE_PT_COLLATERAL = "0x270d664d2fc7d962012a787aec8661ca83df24eb";
const PENDLE_PT_RUNTIME_HASH = "0x60d2e3697a3a8e16653ad50c8fa6c21ac3011778f9492929f6e5a7e6928649c4";
// bwUSDC collateral is a MarketWrapper whose _deposit is protocol-gated; re-adjudicated routePositive=false
// until roleReceiver.isRebalanceInitiated() is true (see reports/raw/fast/w9-bwusdc-strike-20260924/blocker.json).
const BWUSDC_ROUTE_STATUS = "route-blocked/MarketWrapper-gated";

// Robinhood monitor-only pins (public addresses; from W9-S1/W9-S2 evidence).
const RH_MORPHO = "0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010";
const RH_MODT_CLONE = "0xE64849bd4AD03DfaBbe02bb521de19997a19055f";
const RH_USDE_FEED = "0xd9B1f2958298F25bf1289B5aaB7fB6d1B7416c95";
const RH_USDE_ANSWER_THRESHOLD = 99_501_200n; // 0.995012e8
const RH_EQUITY_THRESHOLD_USD = 10;
const RH_FEED_STALE_SECONDS = 86_400; // 24 h
const RH_FEED_MOVE_BPS = 1000; // >10% round-over-round
// Equity-class markets enumerated from the W8-L3 evidence
// reports/raw/fast/w8-fresh-surface-round2-20260922/rwa-progression-w8.json (D_robinhood materialBorrows / top20Borrow
// + the matching oracles[].feeds.baseFeed1 pin). feed=null means the market's oracle exposes no base feed.
const RH_EQUITY_MARKETS = [
  { pair: "STEERUV417/USDG", marketId: "0x9eb061674020355c26a343c01eacf31b39a1dbb79f35a0596412bb7f14e33cee", feed: "0xDe57Da6c5F2901360AC47044fA86c1ca3B6729E9" },
  { pair: "SPY/USDG", marketId: "0x50bc39b5722fb5634c436d74c6787f3c125b879e7b73cf9e9ecc01bbb57b8e55", feed: "0xa68CA83408bE3f78d1c58a82081c619e9d21486d" },
  { pair: "NVDA/USDG", marketId: "0x8b16891f032a93b771347c9cb470a780e6699dd701553d3402aa3cdba6189c3e", feed: null },
  { pair: "NVDA/USDG", marketId: "0x66306c087add8907752320b309934abcc354d21626de8115c79df49d9c214edc", feed: "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15" },
  { pair: "SPCX/USDG", marketId: "0x9b4b47cdf7e295341c6c6cdfd3efb9805c4a5b3d580dba0c0c39d3a4232b297b", feed: null },
  { pair: "SPCX/USDG", marketId: "0x597227ca652ea5e8afb6e4801ecd766a4d6eb9b3b9fafa9127ba88a8b1f19629", feed: "0x42a95341ff361e81fd934F39943c5C98F6991844" },
  { pair: "BIGTECH/USDG", marketId: "0xedc213c29e117c66ae8deb3b53af2ce3b66a9011c2152e83e412b2c5cd40ea3e", feed: "0xB7D302D71Bf8E095072139Bc52670B142a470BB8" },
  { pair: "Index/USDG", marketId: "0x6e6762ae397a2b3f2500ea2f48f8adce0eadfbf54cbc37f6108602e907e844ad", feed: "0x5fDB62417853f46C702354eFc34Bbf1D2213CBbC" },
  { pair: "STONKBROKER/USDG", marketId: "0x378713071c58206c6a826287d0051bcae113d83d6e3d3b6370b7e73128d06162", feed: "0xB3F38BA8E7C9f4C7239384BbDFD341feF0038b3E" },
  { pair: "NOTHING/USDG", marketId: "0x071fb8a90e74f8b3ff3f517f581db96875f3b609a4f0f42efa5c158da9f4b0be", feed: null },
];

const MORPHO_IF = new ethers.Interface([
  "function market(bytes32) view returns (uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee)",
  "function idToMarketParams(bytes32) view returns ((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv))",
]);
const ERC20_IF = new ethers.Interface([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);
const ERC4626_IF = new ethers.Interface([
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
]);
const ROLE_IF = new ethers.Interface([
  "function roleReceiver() view returns (address)",
  "function isRebalanceInitiated() view returns (bool)",
]);
const MODT_IF = new ethers.Interface([
  "function getDeviation() view returns (uint256)",
  "function deviationThreshold() view returns (uint256)",
  "function isChallenged() view returns (bool)",
  "function isPrimary() view returns (bool)",
]);
const FEED_IF = new ethers.Interface([
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
]);
const AGG_IF = new ethers.Interface([
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
  "function getRoundData(uint80 _roundId) view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
]);
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const STABLE_EXTRA = new Set(["DAI", "GHO", "AUSD", "PYUSD", "CRVUSD", "FRAX"]);

function b(v) { return typeof v === "bigint" ? v : BigInt(v); }
function decode(iface, fn, raw) {
  if (!raw || raw === "0x") return null;
  try { return iface.decodeFunctionResult(fn, raw); } catch (_) { return null; }
}
function isUsdStable(symbol) {
  const s = String(symbol || "").toUpperCase();
  if (!s) return false;
  return s.includes("USD") || STABLE_EXTRA.has(s);
}
function chainAlias(cid) { return CHAIN_ALIAS[cid] || `chain-${cid}`; }
function slug(value) { return String(value || "?").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 40); }

async function poolMap(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...await Promise.all(items.slice(i, i + size).map((item, j) => fn(item, i + j))));
  }
  return out;
}

function makeCaller(url, blockHex) {
  async function call(to, data, opts = {}) {
    const block = opts.block || blockHex;
    const args = block ? [{ to, data }, block] : [{ to, data }];
    return rpcCall(url, "eth_call", args, opts.ms || 20000);
  }
  async function getStorage(to, slot, opts = {}) {
    const block = opts.block || blockHex;
    const args = block ? [to, slot, block] : [to, slot];
    return rpcCall(url, "eth_getStorageAt", args, opts.ms || 20000);
  }
  async function getCode(to, opts = {}) {
    return rpcCall(url, "eth_getCode", [to, opts.block || blockHex], opts.ms || 20000);
  }
  return { call, getStorage, getCode };
}

// ---------------- upgrade/config sentinels ----------------
// A FIRE here means "re-decode the watched core now" (upgrade or config mutation). Monitoring-only:
// never auto-execute. Read-only; no signing/broadcast.
const EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const EIP1967_SLOTS = [["impl", EIP1967_IMPL_SLOT], ["admin", EIP1967_ADMIN_SLOT], ["beacon", EIP1967_BEACON_SLOT]];
// Source-backed Zeppelinos slots (not EIP-1967): cirBTC AdminUpgradeabilityProxy.
const LEGACY_IMPL_SLOT = "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3";
const LEGACY_ADMIN_SLOT = "0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b";
const ARC_BOUND_IMPL = "0xc6061272419bb754a6c0386d1df81ddb3fe5cf3c";
const ARC_BOUND_RUNTIME_HASH = "0x17555f31fc63b3ea3abe18c2a47b18545e48e25120b8c439f2cc25e3bfa1244d";
const ARC_BOUND_RUNTIME_BYTES = 23464;
const UPGRADE_TOPICS = [ethers.id("Upgraded(address)"), ethers.id("AdminChanged(address,address)"), ethers.id("BeaconUpgraded(address)")];
const LOG_CHUNK_BLOCKS = 5000;
const LOG_SCAN_MAX_CHUNKS = 12;
const HERTZ_RPC_MAX_CANDIDATES = 16;
const HERTZ_RUN_MS = 120_000;
const RH_RUN_MS = 120_000;
const RH_MAX_CANDIDATES = 24;
const HERTZ_MAX_HEAD_AGE_SECONDS = 300;
const HERTZ_MAX_FUTURE_SKEW_SECONDS = 30;
const HERTZ_MAX_WITNESS_LAG_BLOCKS = 100;
const WORLD_LOG_CHUNK_BLOCKS = 100;
const WORLD_LOG_MAX_CHUNKS = Math.floor(LOG_SCAN_MAX_CHUNKS / 2); // two independent log reads per chunk
const WORLD_RPC_MAX_CANDIDATES = 32;
const MEZO_RPC_MAX_CANDIDATES = 24;
const MEZO_RPC_MAX_TARGET_PROBES = 8;
const WORLD_MAX_HEAD_AGE_SECONDS = 300;
const WORLD_MAX_FUTURE_SKEW_SECONDS = 30;
const WORLD_MAX_WITNESS_LAG_BLOCKS = 100;
const ROLE_ENUM_IF = new ethers.Interface([
  "function getRoleMemberCount(bytes32) view returns (uint256)",
  "function getRoleMember(bytes32,uint256) view returns (address)",
]);
// Chain 56 HertzFlow GMX-V2-fork cores + wrapped-token/beacon banks (W5/W6/W8 evidence).
const HF = {
  dataStore: "0xc244A37A17CE7aa14E1BDD73f6a047Ed6B56f6B8", reader: "0xFC370bA161F4B54B12574c7e0a2121Cea57854A1",
  roleStore: "0x616Ee07aa245EB578c7443E598dcc8b4451bEf30", oracle: "0x99dcc0eec522fde03992ef59808f2d9861fe1126",
  beacon: "0x38b70119bc1e5b707c8c85032765652930afa8bc", hfusdBank: "0x00ceA6655a2b5C4eAD8752EBb41dbC896D3eB5df",
  hfusd1Bank: "0xAB96931f9d151bE6Ff313449a926390cA292db62", hfusd: "0x7F7AD43d1Baa6BeA7f53F72D97D90b4FC0f662DF",
  hfusd1: "0x026C39Ab4B07f4C8C62b5824F0F9D7BE5087405a",
};
// Chain 31612 Mezo Earn (sMUSD) + PCV (W4-L4 evidence).
const MZ = { pcv: "0x391EcC7ffEFc48cff41D0F2Bb36e38b82180B993", smusd: "0xb4D498029af77680cD1eF828b967f010d06C51CC", irm: "0x4a453700d157717Fe02fB62E7700ED7845048285", borrowerOps: "0x44b1bac67dDA612a41a58AAf779143B181dEe031", stabilityPool: "0x73245Eff485aB3AAc1158B3c4d8f4b23797B0e32" };
// Ethereum NaraUSD / NaraUSD+ / MCT / collateral Safe (W8-L2 evidence).
const NR = { mct: "0x4eD90999f558fdc28606b7f7f9afc7044befb803", naraPlus: "0x1aa23cdfc941f6b54251c72012a9bfa4bf5394d6", nara: "0x5c6263904ccfd3bcf1aaa6e7063ddd29743b3bb7", safe: "0xab05c0db9d26e96a9dcedcafca23341316f6fe6f" };
// Ethereum Theo thUSD token + ThUSDMinter + off-contract Gnosis Safe destination (W8-L2 evidence).
const TH = { token: "0xa3fe5c7596024e6811e14f029937d5bd8ae485b3", minter: "0x2d99ac801dc0edadd53f5688fef2317932e8696e", safe: "0xec417ccb6dd26868cca993a92f37217b1d4b3c2f" };
// Katana VaultBridge CustomTokens + per-token NativeConverters (W7-L2 evidence).
const KT = { vbUSDC: "0x203A662b0BD271A6ed5a60EdFbd04bFce608FD36", vbETH: "0xEE7D8BCFb72bC1880D0Cf19822eB0A2e6577aB62", vbWBTC: "0x0913DA6Da4b42f538B445599b46Bb4622342Cf52", ncUSDC: "0x97a3500083348a147f419b8a65717909762c389f", ncETH: "0xa6b0db1293144ebe9478b6a84f75dd651e45914a", ncWBTC: "0xb00aa68b87256e2f22058fb2ba3246eec54a44fc", lxly: "0x2a3dd3eb832af982ec71669e178424b10dca2ede" };
// World OpenXAUT XERC20 (W7-L2 evidence).
const WD = { oXAUT: "0x30974f73A4ac9E606Ed80da928e454977ac486D2", factory: "0x1ab0b0438f04dd396610db7a6bc9b67d1e146e46" };
// MetaOracleDeviationTimelock clones (PT-sUSDD-26NOV2026 eth, USDe/USDG 4663) (W7-L3/W8-L3 evidence).
const MODT_PT = { clone: "0xcD4A69D460Ac1Bd79DEe5859b034BbA9143a6B46", impl: "0xcc319ef091bc520cf6835565826212024b2d25ec", primary: "0x4EAdc1710b6ae3FbA3965F6df9f0AC4700D01777", backup: "0x4d572D679415aE8D13f4CA7C7A23959f3E3D8B9F" };
const MODT_USDE = { clone: "0xE64849bd4AD03DfaBbe02bb521de19997a19055f", impl: "0x6a16d6fe1ba26e6ba52fda03972b1fe2e31ca729", primary: "0x68B60430a1E2d663cCD975Be31d3d31EBa8Ee501", backup: "0xceE05FD68fE4799dbfBB9aD14D74E073c7a194B0" };
// Robinhood Spine vault + borrowController (W8-L3 evidence).
const SP = { vault: "0x38cc0dae2c4305c16f3d702f9a0260599e14654f", controller: "0xce1d096e3bd08b3114a23d916a45c7cf8966d6ea" };
// Arc cirBTC FiatTokenProxy (W7-L2 evidence).
const AR = { cirBTC: "0x171A4217b86A807A64eB94757Db6849fb4bDbAA0", masterMinter: "0x081a1d99cc35957b406783903bb175e0e15e7b2d", admin: "0xea93790965853bc7a1b898b524f73ea40c25acc2" };

const U = (target, abi, fn, rule, extra = {}) => ({ target, abi, fn, rule, ...extra });
// Role enumeration is optional: AccessControl deployments need not implement Enumerable.
const ROLE = (target, roleGetter) => ({ target, roleGetter, rule: "role", optional: true });

const UPGRADE_SENTINELS = [
  {
    id: "upgrade:56:hertzflow", chainId: 56, label: "HertzFlow cores/banks/wrapped tokens",
    eip1967: [HF.beacon, HF.hfusdBank, HF.hfusd1Bank, HF.hfusd, HF.hfusd1],
    probes: [
      U(HF.hfusdBank, "function minReserveFactor() view returns (uint256)", "minReserveFactor", "nonzero"),
      U(HF.hfusd1Bank, "function minReserveFactor() view returns (uint256)", "minReserveFactor", "nonzero"),
      U(HF.beacon, "function implementation() view returns (address)", "implementation", "changed"),
      U(HF.beacon, "function owner() view returns (address)", "owner", "changed"),
      // WrappedToken exposes these public getters; bank-minter membership requires a verified
      // per-wrapper bank binding before treating minters(bank) as a meaningful watched pair.
      U(HF.hfusd, "function redemptionBank() view returns (address)", "redemptionBank", "changed"),
      U(HF.hfusd, "function admin() view returns (address)", "admin", "changed"),
      U(HF.hfusd1, "function redemptionBank() view returns (address)", "redemptionBank", "changed"),
      U(HF.hfusd1, "function admin() view returns (address)", "admin", "changed"),
    ],
  },
  {
    id: "upgrade:31612:mezo-earn", chainId: 31612, label: "Mezo Earn sMUSD + PCV",
    eip1967: [MZ.pcv, MZ.smusd, MZ.irm, MZ.borrowerOps, MZ.stabilityPool],
    probes: [
      U(MZ.pcv, "function feeSplitPercentage() view returns (uint256)", "feeSplitPercentage", "changed"),
      U(MZ.pcv, "function feeRecipient() view returns (address)", "feeRecipient", "changed"),
      U(MZ.pcv, "function distributor() view returns (address)", "distributor", "changed"),
      U(MZ.pcv, "function owner() view returns (address)", "owner", "changed"),
      U(MZ.smusd, "function strategy() view returns (address)", "strategy", "changed"),
      U(MZ.irm, "function interestRate() view returns (uint256)", "interestRate", "changed"),
    ],
  },
  {
    id: "upgrade:1:narausd", chainId: 1, label: "NaraUSD MCT / NaraUSD+ / collateral Safe",
    eip1967: [NR.mct, NR.naraPlus, NR.nara, NR.safe],
    probes: [
      U(NR.mct, "function getSupportedAssets() view returns (address[])", "getSupportedAssets", "changed"),
      ROLE(NR.mct, "MINTER_ROLE()"),
      U(NR.naraPlus, "function asset() view returns (address)", "asset", "changed"),
      U(NR.safe, "function getOwners() view returns (address[])", "getOwners", "changed"),
      U(NR.safe, "function getThreshold() view returns (uint256)", "getThreshold", "changed"),
    ],
  },
  {
    id: "upgrade:1:theo-thusd", chainId: 1, label: "Theo thUSD + ThUSDMinter",
    eip1967: [TH.token, TH.minter, TH.safe],
    probes: [
      U(TH.minter, "function mintDestination() view returns (address)", "mintDestination", "eq", { expected: TH.safe }),
      U(TH.minter, "function redeemDestination() view returns (address)", "redeemDestination", "eq", { expected: TH.safe }),
      ROLE(TH.minter, "MINTER_ROLE()"),
      U(TH.token, "function minter() view returns (address)", "minter", "changed"),
      U(TH.token, "function owner() view returns (address)", "owner", "changed"),
      U(TH.minter, "function paused() view returns (uint256)", "paused", "nonzero"),
      U(TH.minter, "function redeemFeeBps() view returns (uint256)", "redeemFeeBps", "changed"),
    ],
  },
  {
    id: "upgrade:747474:katana-vaultbridge", chainId: 747474, label: "Katana VaultBridge CustomTokens + converters + roles",
    eip1967: [KT.vbUSDC, KT.vbETH, KT.vbWBTC, KT.ncUSDC, KT.ncETH, KT.ncWBTC],
    probes: [
      U(KT.vbUSDC, "function nativeConverter() view returns (address)", "nativeConverter", "changed"),
      U(KT.vbETH, "function nativeConverter() view returns (address)", "nativeConverter", "changed"),
      U(KT.vbWBTC, "function nativeConverter() view returns (address)", "nativeConverter", "changed"),
      U(KT.vbUSDC, "function lxlyBridge() view returns (address)", "lxlyBridge", "changed"),
      U(KT.vbUSDC, "function paused() view returns (uint256)", "paused", "nonzero"),
      ROLE(KT.vbUSDC, "MINTER_BURNER_ROLE()"),
      ROLE(KT.vbETH, "MINTER_BURNER_ROLE()"),
      ROLE(KT.vbWBTC, "MINTER_BURNER_ROLE()"),
    ],
  },
  {
    id: "upgrade:480:world-openxaut", chainId: 480, label: "World OpenXAUT XERC20",
    eip1967: [WD.oXAUT],
    probes: [
      U(WD.oXAUT, "function lockbox() view returns (address)", "lockbox", "nonzero"),
      U(WD.oXAUT, "function owner() view returns (address)", "owner", "changed"),
      U(WD.oXAUT, "function FACTORY() view returns (address)", "FACTORY", "changed"),
      ROLE(WD.oXAUT, "DEFAULT_ADMIN_ROLE()"),
    ],
  },
  {
    id: "upgrade:1:modt-pt-susdd", chainId: 1, label: "MODT clone PT-sUSDD-26NOV2026",
    eip1967: [MODT_PT.clone, MODT_PT.impl, MODT_PT.primary, MODT_PT.backup],
    probes: [
      U(MODT_PT.clone, "function primaryOracle() view returns (address)", "primaryOracle", "changed"),
      U(MODT_PT.clone, "function backupOracle() view returns (address)", "backupOracle", "changed"),
      U(MODT_PT.clone, "function currentOracle() view returns (address)", "currentOracle", "changed"),
      U(MODT_PT.clone, "function deviationThreshold() view returns (uint256)", "deviationThreshold", "changed"),
      U(MODT_PT.clone, "function isChallenged() view returns (bool)", "isChallenged", "nonzero"),
      U(MODT_PT.clone, "function getDeviation() view returns (uint256)", "getDeviation", "changedPct", { thresholdPct: 100 }),
    ],
  },
  {
    id: "upgrade:4663:modt-usde-usdg", chainId: 4663, label: "MODT clone USDe/USDG",
    eip1967: [MODT_USDE.clone, MODT_USDE.impl, MODT_USDE.primary, MODT_USDE.backup],
    probes: [
      U(MODT_USDE.clone, "function primaryOracle() view returns (address)", "primaryOracle", "changed"),
      U(MODT_USDE.clone, "function backupOracle() view returns (address)", "backupOracle", "changed"),
      U(MODT_USDE.clone, "function currentOracle() view returns (address)", "currentOracle", "changed"),
      U(MODT_USDE.clone, "function deviationThreshold() view returns (uint256)", "deviationThreshold", "changed"),
      U(MODT_USDE.clone, "function isChallenged() view returns (bool)", "isChallenged", "nonzero"),
      // Computed from live primary/backup prices, not stored upgrade/config state.
      U(MODT_USDE.clone, "function getDeviation() view returns (uint256)", "getDeviation", "observe"),
    ],
  },
  {
    id: "upgrade:4663:spine", chainId: 4663, label: "Spine vault + borrowController",
    eip1967: [SP.vault, SP.controller],
    probes: [
      U(SP.vault, "function owner() view returns (address)", "owner", "changed"),
      U(SP.controller, "function owner() view returns (address)", "owner", "changed"),
      ROLE(SP.controller, "DEFAULT_ADMIN_ROLE()"),
      ROLE(SP.controller, "BORROWER_ROLE()"),
    ],
  },
  {
    id: "upgrade:5042:arc-cirbtc", chainId: 5042, label: "Arc cirBTC FiatTokenProxy",
    eip1967: [AR.cirBTC],
    legacyProxy: [
      { target: AR.cirBTC, name: "impl", slot: LEGACY_IMPL_SLOT, view: "implementation" },
      { target: AR.cirBTC, name: "admin", slot: LEGACY_ADMIN_SLOT, view: "admin" },
    ],
    probes: [
      U(AR.cirBTC, "function masterMinter() view returns (address)", "masterMinter", "changed"),
      U(AR.cirBTC, "function implementation() view returns (address)", "implementation", "changed"),
      U(AR.cirBTC, "function admin() view returns (address)", "admin", "changed"),
      U(AR.cirBTC, "function owner() view returns (address)", "owner", "changed"),
      U(AR.cirBTC, "function paused() view returns (bool)", "paused", "nonzero"),
      U(AR.cirBTC, "function isMinter(address) view returns (bool)", "isMinter", "changed", { args: [AR.masterMinter] }),
      U(AR.cirBTC, "function minterAllowance(address) view returns (uint256)", "minterAllowance", "changed", { args: [AR.masterMinter] }),
      U(AR.cirBTC, "function blacklister() view returns (address)", "blacklister", "changed"),
    ],
  },
];

function shortAddr(a) { return typeof a === "string" && a.length >= 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : String(a || "?"); }
function normValue(v) { return v == null ? null : String(v).toLowerCase(); }
function digest(value) { return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 16); }
function numericFrom(value) {
  const v = String(value || "");
  if (/^-?[0-9]+$/.test(v)) return Number(v);
  if (/^0x[0-9a-f]+$/i.test(v)) { try { return Number(BigInt(v)); } catch (_) { return null; } }
  const m = v.match(/sum:(-?[0-9]+)/);
  return m ? Number(m[1]) : null;
}
// Canonical scalar encoding so a set/array value can be compared across runs without storing lists.
function encodeDecoded(decoded) {
  if (!decoded || decoded.length === 0) return null;
  const first = decoded[0];
  if (Array.isArray(first)) {
    const parts = first.map((x) => (typeof x === "string" ? x.toLowerCase() : String(x)));
    if (parts.length && /^0x[0-9a-f]{40}$/.test(parts[0])) return `count:${parts.length};h:${digest([...parts].sort().join(","))}`;
    const sum = parts.reduce((acc, x) => { try { return acc + BigInt(x); } catch (_) { return acc; } }, 0n);
    return `count:${parts.length};h:${digest(parts.join(","))};sum:${sum.toString()}`;
  }
  if (typeof first === "boolean") return first ? "true" : "false";
  if (typeof first === "string" && /^0x[0-9a-fA-F]{40}$/.test(first)) return first.toLowerCase();
  return String(first);
}
function probeKey(p) { return `${String(p.target).toLowerCase()}|${p.slot || p.roleGetter || p.fn}|${(p.args || []).map((x) => String(x).toLowerCase()).join(",")}${p.alternative ? `|${p.abi}` : ""}`; }
async function readEip1967Slot(c, target, slot) {
  const raw = await c.getStorage(target, slot);
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(raw)) return null;
  return raw.toLowerCase();
}
async function readRoleSet(c, target, role) {
  const cntRaw = await c.call(target, ROLE_ENUM_IF.encodeFunctionData("getRoleMemberCount", [role]));
  const cnt = decode(ROLE_ENUM_IF, "getRoleMemberCount", cntRaw)?.[0];
  if (cnt === undefined || cnt === null) return null;
  const n = Number(cnt);
  if (!Number.isFinite(n) || n > 200) return `count:${n};h:${digest(String(n))}`;
  const members = [];
  for (let i = 0; i < n; i++) {
    const r = await c.call(target, ROLE_ENUM_IF.encodeFunctionData("getRoleMember", [role, i]));
    const a = decode(ROLE_ENUM_IF, "getRoleMember", r)?.[0];
    if (typeof a === "string") members.push(a.toLowerCase());
    else return null;
  }
  return `count:${n};h:${digest(members.sort().join(","))}`;
}
async function readProbe(c, p) {
  if (p.slot) return readEip1967Slot(c, p.target, p.slot);
  if (p.roleGetter) {
    const iface = new ethers.Interface([`function ${p.roleGetter} view returns (bytes32)`]);
    const fn = p.roleGetter.split("(")[0];
    const raw = await c.call(p.target, iface.encodeFunctionData(fn, []));
    const role = decode(iface, fn, raw)?.[0];
    if (!role) return null;
    return readRoleSet(c, p.target, role);
  }
  const iface = new ethers.Interface([p.abi]);
  const raw = await c.call(p.target, iface.encodeFunctionData(p.fn, p.args || []));
  const d = decode(iface, p.fn, raw);
  if (!d) return null;
  return encodeDecoded(d);
}
function evalProbeRule(rule, value, prev, thresholdPct, expected) {
  if (value == null) return { fired: false };
  if (rule === "observe") return { fired: false };
  if (rule === "nonzero") {
    if (value === "true") return { fired: true };
    if (value === "false") return { fired: false };
    try { return { fired: BigInt(value) !== 0n }; } catch (_) { return { fired: false }; }
  }
  if (rule === "eq") return { fired: normValue(expected) !== normValue(value) };
  if (prev == null) return { fired: false };
  if (normValue(prev) === normValue(value)) return { fired: false };
  if (rule === "changed") return { fired: true };
  if (rule === "changedPct") {
    const a = numericFrom(value), b = numericFrom(prev);
    if (a == null || b == null) return { fired: true };
    const base = Math.abs(b);
    const pct = base > 0 ? (Math.abs(a - b) / base) * 100 : (a !== b ? 100 : 0);
    return { fired: pct > (thresholdPct == null ? 100 : thresholdPct), pct: Number(pct.toFixed(4)) };
  }
  return { fired: true };
}

async function scanUpgradeLogs(url, chainId, fromBlock, toBlock, addresses, rpc, deadline) {
  return scanHertzLogs(url, fromBlock, toBlock, { eip1967: addresses }, rpc, deadline);
}

function logSpecFingerprint(spec) {
  return "0x" + crypto.createHash("sha256").update(JSON.stringify({
    id: spec.id, chainId: spec.chainId, addresses: spec.eip1967.map((a) => a.toLowerCase()),
    probes: spec.probes, slots: EIP1967_SLOTS, legacy: spec.legacyProxy || [],
    topics: UPGRADE_TOPICS, chunk: LOG_CHUNK_BLOCKS,
  })).digest("hex");
}

function validLogCheckpoint(prev, spec) {
  const log = prev?.logScan, snapshots = prev?.snapshots;
  if (!spec || !snapshots || typeof snapshots !== "object" || Array.isArray(snapshots)) return false;
  const present = (p) => typeof snapshots[probeKey(p)] === "string" && snapshots[probeKey(p)].length > 0;
  if (spec.probes.some((p) => !p.optional && !p.alternative && !present(p)) ||
      spec.probes.some((p) => p.alternative && !spec.probes.some((q) => q.alternative === p.alternative && present(q))) ||
      spec.eip1967.some((a) => EIP1967_SLOTS.some(([name]) => !HEX32.test(snapshots[`slot:${a.toLowerCase()}:${name}`] || ""))) ||
      (spec.legacyProxy || []).some((p) => !HEX32.test(snapshots[`legacy:${p.target.toLowerCase()}:${p.name}`] || ""))) return false;
  return !!(log && Number.isSafeInteger(prev.pin) && prev.pin >= 0 &&
    Number.isSafeInteger(log.cursor) && log.cursor >= prev.pin && HEX32.test(log.hash || "") &&
    HEX32.test(log.pinHash || "") && typeof log.hit === "boolean" &&
    log.specFingerprint === logSpecFingerprint(spec) &&
    (log.cursor !== prev.pin || log.hash.toLowerCase() === log.pinHash.toLowerCase()));
}

async function resumeUpgradeLogs(url, head, spec, prev, deps) {
  const rpc = deps.rpc || rpcCall, deadline = deps.deadline || Date.now() + 30_000;
  let scan = { hits: [], scannedFrom: null, scannedTo: null, truncated: false, error: null };
  const fail = (error) => ({ scan: { ...scan, error }, checkpoint: null });
  if (prev && (!Number.isSafeInteger(prev.pin) || prev.pin < 0 ||
      (prev.logScan !== undefined && !validLogCheckpoint(prev, spec)))) return fail("log-baseline-or-spec-invalid");
  if (prev && (prev.logScan?.cursor ?? prev.pin) > head) return fail("pin-ahead-of-block");
  const headHash = deps.headHash || await hertzBlockHash(url, head, rpc, deadline);
  if (!HEX32.test(headHash || "")) return fail("log-head-unreadable");
  const pin = prev ? prev.pin : head;
  const pinHash = await hertzBlockHash(url, pin, rpc, deadline);
  if (!pinHash || (prev?.logScan && pinHash !== prev.logScan.pinHash.toLowerCase())) return fail("log-pin-unreadable-or-reorg");
  const initial = prev?.logScan || { cursor: pin, hash: pinHash, pinHash, hit: false, specFingerprint: logSpecFingerprint(spec) };
  if (prev && !validLogCheckpoint({ ...prev, logScan: initial }, spec)) return fail("log-baseline-or-spec-invalid");
  // Migrate legacy snapshots only after replay at the original pin. Do not
  // silently move the comparison baseline to the newest readable block.
  if (prev) {
    const tag = "0x" + pin.toString(16);
    const read = async (method, args) => {
      if (Date.now() >= deadline) return null;
      try { return await rpc(url, method, args, Math.min(5000, Math.max(100, deadline - Date.now()))); }
      catch (_) { return null; }
    };
    const c = { call: (to, data) => read("eth_call", [{ to, data }, tag]),
      getStorage: (to, slot) => read("eth_getStorageAt", [to, slot, tag]) };
    const tasks = [
      ...spec.probes.filter((p) => !p.optional && !p.alternative || prev.snapshots?.[probeKey(p)] != null)
        .map((p) => async () => [probeKey(p), await readProbe(c, p)]),
      ...spec.eip1967.flatMap((a) => EIP1967_SLOTS.map(([name, slot]) => async () =>
        [`slot:${a.toLowerCase()}:${name}`, await readEip1967Slot(c, a, slot)])),
      ...(spec.legacyProxy || []).map((p) => async () =>
        [`legacy:${p.target.toLowerCase()}:${p.name}`, await readEip1967Slot(c, p.target, p.slot)]),
    ];
    const replay = await poolMap(tasks, 4, async (task) => { try { return await task(); } catch (_) { return null; } });
    if (replay.some((r) => !r || r[1] == null)) return fail("log-baseline-replay-unreadable");
    if (replay.some(([key, value]) => prev.snapshots?.[key] == null || normValue(prev.snapshots[key]) !== normValue(value)))
      return fail("log-baseline-replay-mismatch");
  }
  if (await hertzBlockHash(url, initial.cursor, rpc, deadline) !== initial.hash.toLowerCase()) return fail("log-cursor-reorg");
  let checkpoint = { ...initial };
  if (checkpoint.cursor < head) {
    scan = await (deps.scanLogs || scanUpgradeLogs)(url, spec.chainId, checkpoint.cursor + 1, head, spec.eip1967, rpc, deadline);
    if (scan.scannedFrom !== checkpoint.cursor + 1 || (scan.scannedTo != null &&
        (!Number.isSafeInteger(scan.scannedTo) || scan.scannedTo <= checkpoint.cursor || scan.scannedTo > head || !HEX32.test(scan.hash || ""))))
      return fail("log-checkpoint-invalid");
    if (scan.scannedTo != null) {
      checkpoint.cursor = scan.scannedTo;
      checkpoint.hash = scan.hash.toLowerCase();
    }
    checkpoint.hit ||= scan.hits.length > 0;
  }
  const finalHeadHash = await hertzBlockHash(url, head, rpc, deadline);
  if (!finalHeadHash) {
    // Every saved chunk already has a verified terminal hash. Keep that partial
    // coverage for revalidation on restart; an unavailable head is not a reorg.
    scan.error ||= Date.now() >= deadline ? "logs-time-budget" : "log-head-unreadable";
  } else if (finalHeadHash !== headHash.toLowerCase()) {
    scan.error = "log-head-reorg";
    checkpoint = { ...initial, hit: checkpoint.hit }; // retain hits, never advance across a changed pin
  }
  scan.truncated ||= checkpoint.cursor < head;
  return { scan, checkpoint };
}

function hertzSpecFingerprint(spec) {
  return "0x" + crypto.createHash("sha256").update(JSON.stringify({
    id: spec.id, chainId: spec.chainId, addresses: spec.eip1967.map((a) => a.toLowerCase()),
    probes: spec.probes, slots: EIP1967_SLOTS, topics: UPGRADE_TOPICS, chunk: LOG_CHUNK_BLOCKS,
  })).digest("hex");
}

function validHertzCheckpoint(prev, spec) {
  const h = prev?.hertz;
  const snapshots = prev?.snapshots;
  if (!spec || !snapshots || typeof snapshots !== "object" || Array.isArray(snapshots) ||
      spec.probes.filter((p) => !p.optional).some((p) => typeof snapshots[probeKey(p)] !== "string" ||
        !snapshots[probeKey(p)].length) ||
      spec.eip1967.some((addr) => EIP1967_SLOTS.some(([name]) =>
        !HEX32.test(snapshots[`slot:${addr.toLowerCase()}:${name}`] || "")))) return false;
  return !!(h && Number.isSafeInteger(prev.pin) && prev.pin >= 0 &&
    Number.isSafeInteger(h.cursor) && h.cursor >= prev.pin && HEX32.test(h.hash || "") &&
    HEX32.test(h.pinHash || "") && typeof h.hit === "boolean" &&
    h.specFingerprint === hertzSpecFingerprint(spec) &&
    (h.cursor !== prev.pin || h.hash.toLowerCase() === h.pinHash.toLowerCase()));
}

function arcSpecFingerprint(spec) {
  return "0x" + crypto.createHash("sha256").update(JSON.stringify({
    id: spec.id, chainId: spec.chainId, addresses: spec.eip1967.map((a) => a.toLowerCase()),
    probes: spec.probes, slots: EIP1967_SLOTS, legacy: spec.legacyProxy, topics: UPGRADE_TOPICS,
    chunk: LOG_CHUNK_BLOCKS, implementation: ARC_BOUND_IMPL,
    runtimeHash: ARC_BOUND_RUNTIME_HASH, runtimeBytes: ARC_BOUND_RUNTIME_BYTES,
  })).digest("hex");
}

function validArcCheckpoint(prev, spec) {
  const a = prev?.arc, snapshots = prev?.snapshots;
  if (!spec || !snapshots || typeof snapshots !== "object" || Array.isArray(snapshots) ||
      spec.probes.some((p) => typeof snapshots[probeKey(p)] !== "string" || !snapshots[probeKey(p)].length) ||
      spec.eip1967.some((addr) => EIP1967_SLOTS.some(([name]) =>
        !HEX32.test(snapshots[`slot:${addr.toLowerCase()}:${name}`] || ""))) ||
      spec.legacyProxy.some((l) => !HEX32.test(snapshots[`legacy:${l.target.toLowerCase()}:${l.name}`] || ""))) return false;
  return !!(a && Number.isSafeInteger(prev.pin) && prev.pin >= 0 &&
    Number.isSafeInteger(a.cursor) && a.cursor >= prev.pin && HEX32.test(a.hash || "") &&
    HEX32.test(a.pinHash || "") && typeof a.hit === "boolean" &&
    a.specFingerprint === arcSpecFingerprint(spec) &&
    (a.cursor !== prev.pin || a.hash.toLowerCase() === a.pinHash.toLowerCase()));
}

async function arcSnapshot(c, spec, codeHash = ethers.keccak256) {
  const base = await hertzSnapshot(c, spec);
  if (!base) return null;
  for (const legacy of spec.legacyProxy) {
    let word;
    try { word = await readEip1967Slot(c, legacy.target, legacy.slot); } catch (_) { return null; }
    const probe = spec.probes.find((p) => p.target.toLowerCase() === legacy.target.toLowerCase() && p.fn === legacy.view);
    if (!word || !probe || `0x${word.slice(-40)}` !== normValue(base[probeKey(probe)])) return null;
    base[`legacy:${legacy.target.toLowerCase()}:${legacy.name}`] = word;
  }
  const impl = base[`legacy:${AR.cirBTC.toLowerCase()}:impl`];
  if (`0x${impl.slice(-40)}` !== ARC_BOUND_IMPL || typeof c.getCode !== "function") return null;
  let code;
  try { code = await c.getCode(ARC_BOUND_IMPL); } catch (_) { return null; }
  if (typeof code !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(code) ||
      (code.length - 2) / 2 !== ARC_BOUND_RUNTIME_BYTES ||
      codeHash(code).toLowerCase() !== ARC_BOUND_RUNTIME_HASH) return null;
  return base;
}

async function hertzBlockHash(url, block, rpc = rpcCall, deadline = Infinity) {
  if (!Number.isSafeInteger(block) || block < 0 || Date.now() >= deadline) return null;
  let raw;
  try { raw = await rpc(url, "eth_getBlockByNumber", ["0x" + block.toString(16), false], 5000); }
  catch (_) { return null; }
  try {
    return raw && Number(BigInt(raw.number)) === block && HEX32.test(raw.hash || "") ? raw.hash.toLowerCase() : null;
  } catch (_) { return null; }
}

async function hertzSnapshot(c, spec) {
  const tasks = [
    ...spec.probes.filter((p) => !p.optional).map((p) => async () => [probeKey(p), await readProbe(c, p)]),
    ...spec.eip1967.flatMap((addr) => EIP1967_SLOTS.map(([name, slot]) => async () =>
      [`slot:${addr.toLowerCase()}:${name}`, await readEip1967Slot(c, addr, slot)])),
  ];
  const result = await poolMap(tasks, 4, async (task) => { try { return await task(); } catch (_) { return null; } });
  return result.some((r) => !r || r[1] == null) ? null : Object.fromEntries(result);
}

async function scanHertzLogs(url, start, head, spec, rpc = rpcCall, deadline = Infinity, chunkBudget = null) {
  const out = { hits: [], scannedFrom: start, scannedTo: null, hash: null, truncated: false, error: null };
  let from = start;
  for (let i = 0; from <= head && i < LOG_SCAN_MAX_CHUNKS; i++) {
    if (Date.now() >= deadline) { out.error = "logs-time-budget"; break; }
    if (chunkBudget) {
      if (chunkBudget.remaining <= 0) { out.error = "logs-chunk-budget"; break; }
      chunkBudget.remaining--;
    }
    const to = Math.min(head, from + LOG_CHUNK_BLOCKS - 1);
    let raw;
    try { raw = await rpc(url, "eth_getLogs", [{ fromBlock: "0x" + from.toString(16),
      toBlock: "0x" + to.toString(16), address: spec.eip1967, topics: [UPGRADE_TOPICS] }], 8000); }
    catch (_) { raw = null; }
    if (!Array.isArray(raw) || raw.length > 1000) { out.error = "logs-unreadable"; break; }
    const hits = [];
    for (const l of raw) {
      const block = l && Number(l.blockNumber);
      if (!l || l.removed === true || typeof l.blockNumber !== "string" || !/^0x[0-9a-f]+$/i.test(l.blockNumber) ||
          !Number.isSafeInteger(block) || block < from || block > to ||
          !HEX32.test(l.blockHash || "") || !HEX32.test(l.transactionHash || "") ||
          typeof l.logIndex !== "string" || !/^0x[0-9a-f]+$/i.test(l.logIndex) ||
          !Number.isSafeInteger(Number(l.logIndex)) ||
          !spec.eip1967.some((a) => a.toLowerCase() === String(l.address).toLowerCase()) ||
          !Array.isArray(l.topics) || !UPGRADE_TOPICS.some((t) => t.toLowerCase() === String(l.topics[0]).toLowerCase()) ||
          l.topics.some((t) => !HEX32.test(t)) || typeof l.data !== "string" || !/^0x(?:[0-9a-f]{2})*$/i.test(l.data)) {
        out.error = "logs-invalid"; break;
      }
      const actual = await hertzBlockHash(url, block, rpc, deadline);
      if (!actual || actual !== l.blockHash.toLowerCase()) { out.error = "logs-block-mismatch"; break; }
      hits.push({ address: l.address.toLowerCase(), topic0: l.topics[0].toLowerCase(),
        txHash: l.transactionHash.toLowerCase(), block: l.blockNumber });
    }
    if (out.error) { out.hits.push(...hits); break; }
    out.hits.push(...hits);
    const hash = await hertzBlockHash(url, to, rpc, deadline);
    if (!hash) { out.error = "log-cursor-unreadable"; break; }
    out.scannedTo = to;
    out.hash = hash;
    from = to + 1;
  }
  out.truncated = from <= head;
  return out;
}

const RH_UPGRADE_IDS = ["upgrade:4663:modt-usde-usdg", "upgrade:4663:spine"];
function rhSpecFingerprint(spec) {
  return "0x" + crypto.createHash("sha256").update(JSON.stringify({ id: spec.id,
    chainId: spec.chainId, addresses: spec.eip1967.map((a) => a.toLowerCase()),
    probes: spec.probes, slots: EIP1967_SLOTS, topics: UPGRADE_TOPICS, chunk: LOG_CHUNK_BLOCKS,
  })).digest("hex");
}
function validRhCheckpoint(prev, spec) {
  const r = prev?.rh, snapshots = prev?.snapshots;
  if (!spec || !snapshots || typeof snapshots !== "object" || Array.isArray(snapshots) ||
      spec.probes.filter((p) => !p.optional).some((p) => typeof snapshots[probeKey(p)] !== "string" ||
        !snapshots[probeKey(p)].length) ||
      spec.eip1967.some((addr) => EIP1967_SLOTS.some(([name]) =>
        !HEX32.test(snapshots[`slot:${addr.toLowerCase()}:${name}`] || "")))) return false;
  return !!(r && Number.isSafeInteger(prev.pin) && prev.pin >= 0 &&
    Number.isSafeInteger(r.cursor) && r.cursor >= prev.pin && HEX32.test(r.hash || "") &&
    HEX32.test(r.pinHash || "") && typeof r.hit === "boolean" &&
    r.specFingerprint === rhSpecFingerprint(spec) &&
    (r.cursor !== prev.pin || r.hash.toLowerCase() === r.pinHash.toLowerCase()));
}
async function rhSnapshot(c, spec, prev = null) {
  const state = await hertzSnapshot(c, spec);
  if (!state) return null;
  for (const p of spec.probes.filter((probe) => probe.optional && prev?.snapshots?.[probeKey(probe)] != null)) {
    let value;
    try { value = await readProbe(c, p); } catch (_) { return null; }
    if (value == null) return null;
    state[probeKey(p)] = value;
  }
  return state;
}

// This opt-in never opens any archive inventory during default runs or unit tests.
function rhArchiveInventoryPath(value) {
  if (value == null) return null;
  if (value !== "robinhood_archive_endpoints.md") throw Error("rh-archive-path-invalid");
  return path.join(ROOT, value);
}

// The explicitly supplied base-root RPC is a candidate, not evidence of capability.
// Keep its value in memory only, and require an exact URL token in both local inventories.
function rhUserGatewayUrl(value) {
  if (typeof value !== "string" || !value || value.length > 2048 || value !== value.trim()) return null;
  let parsed;
  try { parsed = new URL(value); } catch (_) { return null; }
  if (parsed.protocol !== "https:" || parsed.href !== value || parsed.pathname !== "/" ||
      parsed.username || parsed.password || parsed.search || parsed.hash ||
      /[%<>${}\[\]\\\s]/.test(value) || net.isIP(parsed.hostname) ||
      parsed.hostname.length > 253 || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(parsed.hostname) ||
      parsed.hostname.split(".").some((part) => part.length > 63 || part.startsWith("-") || part.endsWith("-")) ||
      /(?:^|\.)(?:localhost|local|lan|home|corp|private|internal|invalid|test|example|onion|arpa)$|^example\.(?:com|org|net)$/i.test(parsed.hostname) ||
      /(?:^|[./_-])(?:app|session|key|token|secret|auth|api[-_]?key|placeholder|your[-_]?rpc|replace[-_]?me)(?:$|[./_-])/i.test(parsed.hostname)) return null;
  return value;
}

function containsExactRpcToken(text, url) {
  const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9+.-])${escaped}(?![a-z0-9/?#@:%_.+-])`, "im").test(text);
}

function readBoundedRhInventory(file, maxBytes, io = fs) {
  let fd;
  try {
    const before = io.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) return null;
    fd = io.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = io.fstatSync(fd);
    if (!opened.isFile() || opened.size > maxBytes || opened.dev !== before.dev || opened.ino !== before.ino) return null;
    const bytes = Buffer.alloc(maxBytes + 1);
    let used = 0, count;
    while (used < bytes.length && (count = io.readSync(fd, bytes, used, bytes.length - used, null)) > 0) used += count;
    const after = io.fstatSync(fd);
    const current = io.lstatSync(file);
    if (used > maxBytes || after.size !== opened.size || used !== opened.size ||
        !current.isFile() || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino) return null;
    return bytes.toString("utf8", 0, used);
  } catch (_) { return null; }
  finally { if (fd !== undefined) try { io.closeSync(fd); } catch (_) { /* fail closed */ } }
}

function publicRhIp(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 ||
      a === 192 && (b === 0 || b === 168 || b === 88 && c === 99) ||
      a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) ||
      a === 203 && b === 0 && c === 113 || a === 100 && b >= 64 && b <= 127);
  }
  if (family !== 6 || address.includes("%")) return false;
  let value = address.toLowerCase();
  if (value.includes(".")) {
    const match = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
    if (!match || net.isIP(match[2]) !== 4) return false;
    const v = match[2].split(".").map(Number);
    value = `${match[1]}${((v[0] << 8) | v[1]).toString(16)}:${((v[2] << 8) | v[3]).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return false;
  const front = halves[0] ? halves[0].split(":") : [];
  const back = halves[1] ? halves[1].split(":") : [];
  const words = halves.length === 2 ? [...front, ...Array(8 - front.length - back.length).fill("0"), ...back] : front;
  if (words.length !== 8) return false;
  const n = words.reduce((acc, word) => (acc << 16n) | BigInt(parseInt(word, 16)), 0n);
  if (n >> 32n === 0xffffn) return publicRhIp([(Number(n >> 24n) & 255),
    (Number(n >> 16n) & 255), (Number(n >> 8n) & 255), (Number(n) & 255)].join("."));
  if (n >> 125n !== 1n || n >> 112n === 0x2002n || n >> 116n === 0x3ffn ||
      n >> 96n === 0x20010db8n) return false;
  if (n >> 112n === 0x2001n) {
    const second = Number((n >> 96n) & 0xffffn);
    if (second <= 5 || second >> 4 === 1 || second >> 4 === 2 ||
        second === 4 && Number((n >> 80n) & 0xffffn) === 0x112) return false;
  }
  return true;
}

// Dedicated, non-redirecting RPC transport for the explicit public gateway only.
// Lookup resolves once per call and pins the accepted address for TCP; HTTPS retains
// the original DNS hostname for SNI and certificate validation.
function makeRhUserGatewayRpc(value, deps = {}) {
  const url = rhUserGatewayUrl(value);
  if (!url) return null;
  const endpoint = new URL(url);
  const resolve = deps.resolve || dns.lookup;
  const request = deps.request || https.request;
  return (rpcUrl, method, params, ms = 5000) => new Promise((resolveResult, rejectResult) => {
    if (rpcUrl !== url) { rejectResult(Error("rh-rpc-route-invalid")); return; }
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
    let settled = false, timer;
    const fail = () => { if (!settled) { settled = true; clearTimeout(timer); rejectResult(Error("rh-rpc-unavailable")); } };
    const lookup = (_hostname, opts, callback) => {
      try {
        resolve(endpoint.hostname, { all: true, verbatim: true }, (error, records) => {
          if (error || !Array.isArray(records) || !records.length ||
              records.some((entry) => !entry || !publicRhIp(entry.address) || entry.family !== net.isIP(entry.address))) {
            callback(Error("rh-rpc-address-rejected")); return;
          }
          // Node's autoSelectFamily asks lookup({ all: true }) for an array;
          // return only the already-validated selected address to pin CONNECT.
          if (opts.all) callback(null, [{ address: records[0].address, family: records[0].family }]);
          else callback(null, records[0].address, records[0].family);
        });
      } catch (_) { callback(Error("rh-rpc-address-rejected")); }
    };
    let req;
    try {
      req = request({ protocol: "https:", hostname: endpoint.hostname, servername: endpoint.hostname,
        port: endpoint.port || 443, path: "/", method: "POST", lookup, agent: false,
        rejectUnauthorized: true, timeout: Math.min(8000, Math.max(100, ms)),
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
        if (res.statusCode !== 200 || Number(res.headers?.["content-length"]) > 4 * 1024 * 1024) {
          res.destroy(); fail(); return;
        }
        const chunks = [];
        let total = 0;
        res.on("data", (chunk) => {
          total += chunk.length;
          if (total > 4 * 1024 * 1024) { res.destroy(); fail(); } else chunks.push(chunk);
        });
        res.on("error", fail);
        res.on("end", () => {
          if (settled) return;
          try {
            const reply = JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
            if (reply?.error || !reply || !("result" in reply)) { fail(); return; }
            settled = true; clearTimeout(timer); resolveResult(reply.result);
          } catch (_) { fail(); }
        });
      });
      req.on("timeout", () => { req.destroy(); fail(); });
      req.on("error", fail);
      timer = setTimeout(() => { req.destroy(); fail(); }, Math.min(8000, Math.max(100, ms)));
      req.end(body);
    } catch (_) { if (req) req.destroy(); fail(); }
  });
}

// Archive inventory is a Markdown results table, not a URL list. Only its mainnet
// archive-state result rows with explicit no-auth access and positive historical
// state evidence can supply candidates. Never pass other document links to RPC.
function parseRhArchiveInventory(markdown) {
  if (typeof markdown !== "string" || Buffer.byteLength(markdown) > 1024 * 1024) return null;
  const urls = [];
  let root = false, rootSeen = false, section = false, sections = 0, table = 0, rows = 0;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^ {0,3}#{1,6}(?!#)\S/.test(line)) return null; // malformed heading: never infer its section
    const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const title = heading[2];
      if (level === 1) {
        if (rootSeen) return null;
        rootSeen = true;
        root = /\brobinhood\b/i.test(title) && /\bmainnet\b/i.test(title) &&
          /\barchive\b/i.test(title) && /\brpcs?\b/i.test(title);
        if (!root) return null;
      } else if (level === 2) {
        if (!root) return null;
        section = /^archive[- ]state\s+results?$/i.test(title);
        if (section && ++sections > 1) return null;
      } else if (section) return null; // no nested entries under the selected results
      continue;
    }
    if (!section) continue;
    if (!/^\s*\|/.test(line)) {
      if (/https?:\/\//i.test(line)) return null; // no narrative URLs in this section
      continue;
    }
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (!/^\s*\|.*\|\s*$/.test(line) || cells.length > 8 || cells.some((cell) => cell.length > 512)) return null;
    if (table === 0) {
      if (cells.length !== 3 || !/\baccess\b/i.test(cells[0]) || !/\brpc\b/i.test(cells[1]) ||
          cells.some((cell) => /https?:\/\//i.test(cell))) return null;
      table = 1;
      continue;
    }
    if (table === 1) {
      if (cells.length !== 3 || !cells.every((cell) => /^:?-{3,}:?$/.test(cell))) return null;
      table = 2;
      continue;
    }
    if (cells.length !== 3) {
      if (cells.some((cell) => /https?:\/\//i.test(cell))) return null;
      table = 3; // subsequent non-RPC results tables are not URL sources
      continue;
    }
    if (++rows > 64) return null;
    if (table === 3) {
      if (/https?:\/\//i.test(line)) return null;
      continue;
    }
    const [access, endpoint, result] = cells;
    if (!/\b(?:no[\s_-]*(?:api[\s_-]*)?(?:auth(?:entication)?|key|token|credential|sign[\s_-]*up|login)|without[\s_-]*(?:authentication|auth|api[\s_-]*key|key|token|credentials|login)|unauthenticated|anonymous|keyless|auth[\s_-]*free)\b/i.test(access) ||
        /\b(?:provisioned|placeholder|requires?|app|session|docs?|example)\b/i.test(access) ||
        !/\bhistorical\s+state\b/i.test(result) ||
        !/\b(?:works?|supported|yes|available|pass(?:ed)?|returns?|serves?|readable|valid|confirmed)\b/i.test(result) ||
        /\b(?:not|no|cannot|can't|fails?|unavailable|unsupported|pruned|unknown|unclear|unverified|limited|requires)\b/i.test(result)) continue;
    const entry = /^`(https:\/\/[^`\s|]+)`$/.exec(endpoint);
    if (!entry) return null;
    const value = entry[1];
    let parsed;
    try { parsed = new URL(value); } catch (_) { return null; }
    if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password ||
        /[?#%<>${}\[\]]/.test(value) ||
        /(?:^|[./_-])(app|session|token|api[-_]?key|secret|auth)(?:$|[./_-])/i.test(parsed.hostname + parsed.pathname) ||
        net.isIP(parsed.hostname) || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(parsed.hostname) ||
        /(?:^|\.)(?:localhost|local|internal|invalid|test|example)$|^example\.(?:com|org|net)$/i.test(parsed.hostname) ||
        /\b(?:placeholder|your[-_]?rpc|replace[-_]?me)\b/i.test(value)) return null;
    if (urls.length >= 128) return null;
    urls.push(value);
  }
  return sections === 1 && table >= 2 && urls.length ? urls : null;
}

function startRhUpgradeScan() {
  return { deadline: Date.now() + RH_RUN_MS, chunkBudget: { remaining: LOG_SCAN_MAX_CHUNKS } };
}

async function qualifyRhRpc(prevById, deps = {}) {
  const specs = RH_UPGRADE_IDS.map((id) => UPGRADE_SENTINELS.find((s) => s.id === id));
  if (specs.some((s) => !s) || specs.some((s) => !prevById[s.id] ||
      !Number.isSafeInteger(prevById[s.id].pin) || prevById[s.id].pin < 0 ||
      prevById[s.id].rh && !validRhCheckpoint(prevById[s.id], s))) return null;
  let rpc = deps.rpc || rpcCall;
  const deadline = deps.deadline || Date.now() + RH_RUN_MS;
  const nowSec = deps.nowSec ?? Math.floor(Date.now() / 1000);
  const fresh = (t) => Number.isSafeInteger(t) && t > 0 && t >= nowSec - 300 && t <= nowSec + 30;
  if (deps.userGatewayEnv && !deps.archivePath) return null;
  // An explicit gateway never inherits the broad standing candidate pool: only
  // independently documented archive rows may witness its canonical head.
  let urls = deps.userGatewayEnv ? [] : deps.urls || loadRpcUrls({ maxCandidates: 128 });
  let archiveUrls = null, userUrl = null;
  const readInventory = deps.readInventory || readBoundedRhInventory;
  if (deps.archivePath) {
    if (deps.archivePath !== path.join(ROOT, "robinhood_archive_endpoints.md")) return null;
    const markdown = readInventory(deps.archivePath, 1024 * 1024);
    const archive = markdown === null ? null : parseRhArchiveInventory(markdown);
    if (!archive) return null; // fail closed before probing even other candidate sources
    archiveUrls = new Set(archive);
    urls = [...urls, ...(deps.userGatewayEnv ? [...new Set(archive)].slice(0, 3) : archive)];
    if (deps.userGatewayEnv) {
      userUrl = rhUserGatewayUrl(process.env.RH_PUBLIC_ARCHIVE_RPC_URL);
      const catalog = readInventory(path.join(ROOT, "rpc_endpoints.txt"), 1024 * 1024);
      if (!userUrl || catalog === null || !containsExactRpcToken(markdown, userUrl) ||
          !containsExactRpcToken(catalog, userUrl)) return null;
      if (!deps.rpc) {
        const secure = makeRhUserGatewayRpc(userUrl);
        if (!secure) return null;
        rpc = (url, method, params, ms) => url === userUrl
          ? secure(url, method, params, ms) : rpcCall(url, method, params, ms);
      }
      urls.unshift(userUrl);
    }
  }
  if (!Array.isArray(urls) || !urls.length) return null;
  const ranked = rankProviderUrls([...new Set(urls)], urls.length);
  const pool = ranked.map((url, order) => ({ url, order })).sort((a, b) =>
    Number(b.url === userUrl) - Number(a.url === userUrl) ||
    Number(archiveUrls?.has(b.url)) - Number(archiveUrls?.has(a.url)) ||
    Number(/robinhood|4663/i.test(b.url)) - Number(/robinhood|4663/i.test(a.url)) ||
    rpcCapabilityRank(a.url) - rpcCapabilityRank(b.url) || a.order - b.order).slice(0, RH_MAX_CANDIDATES);
  const read = async (url, method, params, ms = 5000) => {
    if (Date.now() >= deadline) return null;
    try { return await rpc(url, method, params, Math.min(ms, Math.max(100, deadline - Date.now()))); }
    catch (_) { return null; }
  };
  const family = (url) => {
    try { return (deps.familyOf ? deps.familyOf(url) : providerFamily(url)) || `host:${new URL(url).hostname.toLowerCase()}`; }
    catch (_) { return null; }
  };
  const heads = await poolMap(pool, 4, async ({ url }) => {
    try {
      const id = await read(url, "eth_chainId", []);
      if (typeof id !== "string" || Number(BigInt(id)) !== 4663) return null;
      const bn = await read(url, "eth_blockNumber", []), head = Number(BigInt(bn));
      if (!Number.isSafeInteger(head) || specs.some((s) => head < prevById[s.id].pin)) return null;
      const header = await read(url, "eth_getBlockByNumber", ["0x" + head.toString(16), false]);
      const timestamp = parseBlockTimestamp(header);
      if (!header || Number(BigInt(header.number)) !== head || !HEX32.test(header.hash || "") || !fresh(timestamp)) return null;
      return { url, head, hash: header.hash.toLowerCase(), timestamp, family: family(url) };
    } catch (_) { return null; }
  });
  const valid = heads.filter((h) => h && h.family);
  for (const entry of valid) {
    if (Date.now() >= deadline) break;
    const tag = "0x" + entry.head.toString(16);
    const c = { call: (to, data) => read(entry.url, "eth_call", [{ to, data }, tag]),
      getStorage: (to, slot) => read(entry.url, "eth_getStorageAt", [to, slot, tag]) };
    if (specs.some((s) => !s.eip1967.length)) continue;
    let capable = true;
    for (const spec of specs) {
      if (!await rhSnapshot(c, spec, prevById[spec.id])) { capable = false; break; }
      const from = prevById[spec.id].rh ? prevById[spec.id].rh.cursor + 1 : prevById[spec.id].pin + 1;
      const sampleFrom = from <= entry.head ? from : Math.max(0, entry.head - 99);
      for (const [start, to] of [[sampleFrom, Math.min(entry.head, sampleFrom + LOG_CHUNK_BLOCKS - 1)],
        [Math.max(0, entry.head - 99), entry.head]]) {
        const raw = await read(entry.url, "eth_getLogs", [{ fromBlock: "0x" + start.toString(16),
          toBlock: "0x" + to.toString(16), address: spec.eip1967, topics: [UPGRADE_TOPICS] }], 8000);
        if (!Array.isArray(raw)) { capable = false; break; }
      }
      if (!capable) break;
    }
    if (!capable) continue;
    let witnessUrl = null;
    const witnesses = valid.filter((h) => h.family !== entry.family);
    for (const witness of witnesses) {
      if (Math.abs(witness.head - entry.head) > 100 || witness.head < entry.head) continue;
      const header = await read(witness.url, "eth_getBlockByNumber", [tag, false]);
      try {
        if (Number(BigInt(header.number)) === entry.head && String(header.hash).toLowerCase() === entry.hash &&
            parseBlockTimestamp(header) === entry.timestamp && fresh(parseBlockTimestamp(header))) {
          witnessUrl = witness.url; break;
        }
      } catch (_) { /* header witness unavailable */ }
    }
    if ((entry.url === userUrl || witnesses.length) && !witnessUrl) continue;
    if (userUrl && entry.url !== userUrl) continue; // never fall back to an unprotected primary
    return { url: entry.url, witnessUrl, block: entry.head, hash: entry.hash,
      timestamp: entry.timestamp };
  }
  return null;
}

async function qualifyHertzRpc(prev, deps = {}) {
  const spec = UPGRADE_SENTINELS.find((s) => s.id === "upgrade:56:hertzflow");
  if (!prev || !Number.isSafeInteger(prev.pin) || prev.pin < 0 ||
      (prev.hertz && !validHertzCheckpoint(prev, spec))) return null;
  const rpc = deps.rpc || rpcCall, deadline = deps.deadline || Date.now() + HERTZ_RUN_MS;
  const nowSec = deps.nowSec ?? Math.floor(Date.now() / 1000);
  const fresh = (timestamp) => Number.isSafeInteger(timestamp) && timestamp > 0 &&
    timestamp >= nowSec - HERTZ_MAX_HEAD_AGE_SECONDS && timestamp <= nowSec + HERTZ_MAX_FUTURE_SKEW_SECONDS;
  const urls = deps.urls || loadRpcUrls({ maxCandidates: 128 });
  if (!urls.length) return null;
  const ranked = rankProviderUrls([...new Set(urls)], urls.length);
  const pool = ranked.map((url, order) => ({ url, order })).sort((a, b) =>
    Number(/bsc|binance|(?:^|\D)56(?:\D|$)/i.test(b.url)) - Number(/bsc|binance|(?:^|\D)56(?:\D|$)/i.test(a.url)) ||
    rpcCapabilityRank(a.url) - rpcCapabilityRank(b.url) || a.order - b.order).slice(0, HERTZ_RPC_MAX_CANDIDATES);
  const read = async (url, method, params, ms = 5000) => {
    if (Date.now() >= deadline) return null;
    try { return await rpc(url, method, params, ms); } catch (_) { return null; }
  };
  const family = (url) => {
    try { return (deps.familyOf ? deps.familyOf(url) : providerFamily(url)) || `host:${new URL(url).hostname.toLowerCase()}`; }
    catch (_) { return null; }
  };
  const heads = await poolMap(pool, 4, async ({ url }) => {
    try {
      const id = await read(url, "eth_chainId", []);
      if (typeof id !== "string" || Number(BigInt(id)) !== 56) return null;
      const bn = await read(url, "eth_blockNumber", []);
      const head = Number(BigInt(bn));
      if (!Number.isSafeInteger(head) || head < prev.pin) return null;
      const header = await read(url, "eth_getBlockByNumber", ["0x" + head.toString(16), false]);
      const timestamp = parseBlockTimestamp(header);
      if (!header || Number(BigInt(header.number)) !== head || !HEX32.test(header.hash || "") || !fresh(timestamp)) return null;
      return { url, head, hash: header.hash.toLowerCase(), timestamp,
        family: family(url), rank: rpcCapabilityRank(url) };
    } catch (_) { return null; }
  });
  const valid = heads.filter((h) => h && h.family).sort((a, b) => a.rank - b.rank);
  for (const entry of valid) {
    if (Date.now() >= deadline) break;
    const tag = "0x" + entry.head.toString(16);
    const c = { call: (to, data) => read(entry.url, "eth_call", [{ to, data }, tag]),
      getStorage: (to, slot) => read(entry.url, "eth_getStorageAt", [to, slot, tag]) };
    const state = await hertzSnapshot(c, spec);
    if (!state) continue;
    const from = prev.hertz ? prev.hertz.cursor + 1 : prev.pin + 1;
    const sampleFrom = from <= entry.head ? from : Math.max(0, entry.head - 99);
    const to = Math.min(entry.head, sampleFrom + LOG_CHUNK_BLOCKS - 1);
    const sample = await read(entry.url, "eth_getLogs", [{ fromBlock: "0x" + sampleFrom.toString(16),
      toBlock: "0x" + to.toString(16), address: spec.eip1967, topics: [UPGRADE_TOPICS] }], 8000);
    if (!Array.isArray(sample)) continue;
    let witnessUrl = null;
    const witnesses = valid.filter((candidate) => candidate.family !== entry.family);
    for (const candidate of witnesses) {
      if (Math.abs(candidate.head - entry.head) > HERTZ_MAX_WITNESS_LAG_BLOCKS || candidate.head < entry.head) continue;
      const header = await read(candidate.url, "eth_getBlockByNumber", [tag, false]);
      try {
        if (Number(BigInt(header.number)) === entry.head && String(header.hash).toLowerCase() === entry.hash &&
            parseBlockTimestamp(header) === entry.timestamp && fresh(parseBlockTimestamp(header))) {
          witnessUrl = candidate.url; break;
        }
      } catch (_) { /* no usable header witness */ }
    }
    if (witnesses.length && !witnessUrl) continue;
    return { url: entry.url, witnessUrl, block: entry.head, hash: entry.hash,
      timestamp: entry.timestamp, deadline };
  }
  return null;
}

// Arc only: source-bound current state and the first original-pin filter must work
// before a primary may serve single-provider bulk logs. Witnesses check headers only.
async function qualifyArcRpc(prev, deps = {}) {
  const spec = UPGRADE_SENTINELS.find((s) => s.id === "upgrade:5042:arc-cirbtc");
  if (!prev || !Number.isSafeInteger(prev.pin) || prev.pin < 0 ||
      (prev.arc && !validArcCheckpoint(prev, spec))) return null;
  const rpc = deps.rpc || rpcCall, deadline = deps.deadline || Date.now() + HERTZ_RUN_MS;
  const nowSec = deps.nowSec ?? Math.floor(Date.now() / 1000);
  const fresh = (timestamp) => Number.isSafeInteger(timestamp) && timestamp > 0 &&
    timestamp >= nowSec - HERTZ_MAX_HEAD_AGE_SECONDS && timestamp <= nowSec + HERTZ_MAX_FUTURE_SKEW_SECONDS;
  const urls = deps.urls || loadRpcUrls({ maxCandidates: 128 });
  if (!urls.length) return null;
  const ranked = rankProviderUrls([...new Set(urls)], urls.length);
  const pool = ranked.map((url, order) => ({ url, order })).sort((a, b) =>
    Number(/(?:^|[./_-])arc(?:[./?_-]|$)|5042/i.test(b.url)) -
    Number(/(?:^|[./_-])arc(?:[./?_-]|$)|5042/i.test(a.url)) ||
    rpcCapabilityRank(a.url) - rpcCapabilityRank(b.url) || a.order - b.order).slice(0, HERTZ_RPC_MAX_CANDIDATES);
  const read = async (url, method, params, ms = 5000) => {
    if (Date.now() >= deadline) return null;
    try { return await rpc(url, method, params, ms); } catch (_) { return null; }
  };
  const family = (url) => {
    try { return (deps.familyOf ? deps.familyOf(url) : providerFamily(url)) || `host:${new URL(url).hostname.toLowerCase()}`; }
    catch (_) { return null; }
  };
  const heads = await poolMap(pool, 4, async ({ url }) => {
    try {
      const id = await read(url, "eth_chainId", []);
      if (typeof id !== "string" || Number(BigInt(id)) !== 5042) return null;
      const bn = await read(url, "eth_blockNumber", []);
      const head = Number(BigInt(bn));
      if (!Number.isSafeInteger(head) || head < prev.pin) return null;
      const header = await read(url, "eth_getBlockByNumber", ["0x" + head.toString(16), false]);
      const timestamp = parseBlockTimestamp(header);
      if (!header || Number(BigInt(header.number)) !== head || !HEX32.test(header.hash || "") || !fresh(timestamp)) return null;
      return { url, head, hash: header.hash.toLowerCase(), timestamp,
        family: family(url), rank: rpcCapabilityRank(url) };
    } catch (_) { return null; }
  });
  const valid = heads.filter((h) => h && h.family).sort((a, b) => a.rank - b.rank);
  for (const entry of valid) {
    if (Date.now() >= deadline) break;
    const tag = "0x" + entry.head.toString(16);
    const c = { call: (to, data) => read(entry.url, "eth_call", [{ to, data }, tag]),
      getStorage: (to, slot) => read(entry.url, "eth_getStorageAt", [to, slot, tag]),
      getCode: (to) => read(entry.url, "eth_getCode", [to, tag]) };
    if (!await arcSnapshot(c, spec, deps.arcCodeHash || ethers.keccak256)) continue;
    const from = prev.arc ? prev.arc.cursor + 1 : prev.pin + 1;
    const sampleFrom = from <= entry.head ? from : Math.max(0, entry.head - 99);
    const to = Math.min(entry.head, sampleFrom + LOG_CHUNK_BLOCKS - 1);
    const sample = await read(entry.url, "eth_getLogs", [{ fromBlock: "0x" + sampleFrom.toString(16),
      toBlock: "0x" + to.toString(16), address: spec.eip1967, topics: [UPGRADE_TOPICS] }], 8000);
    if (!Array.isArray(sample)) continue;
    let witnessUrl = null;
    const witnesses = valid.filter((candidate) => candidate.family !== entry.family);
    for (const candidate of witnesses) {
      if (Math.abs(candidate.head - entry.head) > HERTZ_MAX_WITNESS_LAG_BLOCKS || candidate.head < entry.head) continue;
      const header = await read(candidate.url, "eth_getBlockByNumber", [tag, false]);
      try {
        if (Number(BigInt(header.number)) === entry.head && String(header.hash).toLowerCase() === entry.hash &&
            parseBlockTimestamp(header) === entry.timestamp && fresh(parseBlockTimestamp(header))) {
          witnessUrl = candidate.url; break;
        }
      } catch (_) { /* no usable header witness */ }
    }
    if (witnesses.length && !witnessUrl) continue;
    return { url: entry.url, witnessUrl, block: entry.head, hash: entry.hash,
      timestamp: entry.timestamp, deadline };
  }
  return null;
}

function worldSpecFingerprint(spec) {
  return "0x" + crypto.createHash("sha256").update(JSON.stringify({
    id: spec.id, chainId: spec.chainId, addresses: spec.eip1967.map((a) => a.toLowerCase()),
    probes: spec.probes, slots: EIP1967_SLOTS, topics: UPGRADE_TOPICS, chunk: WORLD_LOG_CHUNK_BLOCKS,
  })).digest("hex");
}

function validWorldCheckpoint(prev, spec) {
  return !!(prev && Number.isSafeInteger(prev.pin) && prev.pin >= 0 && prev.world &&
    Number.isSafeInteger(prev.world.cursor) && prev.world.cursor >= prev.pin &&
    HEX32.test(prev.world.hash) && typeof prev.world.hit === "boolean" &&
    HEX32.test(prev.world.specFingerprint || "") &&
    (!spec || prev.world.specFingerprint === worldSpecFingerprint(spec)));
}

async function worldBlockHash(url, block, rpc = rpcCall) {
  const raw = await rpc(url, "eth_getBlockByNumber", ["0x" + block.toString(16), false], 8000);
  return raw && Number(BigInt(raw.number || "0x0")) === block && HEX32.test(raw.hash || "") ? raw.hash.toLowerCase() : null;
}

// Match exact canonical event identities; no endpoint or untrusted RPC text leaves this helper.
async function worldLogIdentities(url, witnessUrl, from, to, addresses, rpc) {
  const filter = { fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16),
    address: addresses, topics: [UPGRADE_TOPICS] };
  const raw = await rpc(url, "eth_getLogs", [filter], 8000);
  if (!Array.isArray(raw) || raw.length > 1000) return null;
  const hashes = new Map();
  const identities = [];
  for (const l of raw) {
    const n = Number(l?.blockNumber);
    if (l?.removed === true || !Number.isSafeInteger(n) || n < from || n > to || !HEX32.test(l.blockHash || "") ||
        !HEX32.test(l.transactionHash || "") || typeof l.logIndex !== "string" ||
        !/^0x[0-9a-f]+$/i.test(l.logIndex) || !Number.isSafeInteger(Number(l.logIndex)) ||
        !addresses.some((a) => a.toLowerCase() === String(l.address).toLowerCase()) ||
        !Array.isArray(l.topics) || !UPGRADE_TOPICS.some((t) => t.toLowerCase() === String(l.topics[0]).toLowerCase()) ||
        l.topics.some((t) => !HEX32.test(t)) || typeof l.data !== "string" || !/^0x(?:[0-9a-f]{2})*$/i.test(l.data)) return null;
    if (!hashes.has(n)) {
      const [a, b] = await Promise.all([worldBlockHash(url, n, rpc), worldBlockHash(witnessUrl, n, rpc)]);
      if (!a || a !== b) return null;
      hashes.set(n, a);
    }
    if (l.blockHash.toLowerCase() !== hashes.get(n)) return null;
    identities.push({ address: l.address.toLowerCase(), topic0: l.topics[0].toLowerCase(),
      txHash: l.transactionHash.toLowerCase(), block: n, blockHash: l.blockHash.toLowerCase(),
      logIndex: Number(l.logIndex), topics: l.topics.map((t) => t.toLowerCase()), data: l.data.toLowerCase() });
  }
  identities.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (new Set(identities.map((l) => `${l.txHash}:${l.logIndex}`)).size !== identities.length) return null;
  return identities;
}

async function worldLogPair(url, witnessUrl, from, to, addresses, rpc) {
  if (!witnessUrl || to - from + 1 > WORLD_LOG_CHUNK_BLOCKS) return null;
  const [a, b] = await Promise.all([
    worldLogIdentities(url, witnessUrl, from, to, addresses, rpc),
    worldLogIdentities(witnessUrl, url, from, to, addresses, rpc),
  ]);
  return a && b && JSON.stringify(a) === JSON.stringify(b) ? a : null;
}

async function scanWorldUpgradeLogs(url, fromBlock, head, addresses, rpc = rpcCall, witnessUrl = null) {
  const out = { hits: [], scannedFrom: fromBlock, scannedTo: null, hash: null, truncated: false, error: null };
  if (fromBlock > head || !witnessUrl) { out.error = "world-witness-unavailable"; return out; }
  let from = fromBlock;
  for (let i = 0; from <= head && i < WORLD_LOG_MAX_CHUNKS; i++) {
    const to = Math.min(head, from + WORLD_LOG_CHUNK_BLOCKS - 1);
    let hits;
    try { hits = await worldLogPair(url, witnessUrl, from, to, addresses, rpc); }
    catch (_) { out.error = "logs-unreadable"; return out; }
    if (!hits) { out.error = "logs-disagreement"; return out; }
    out.hits.push(...hits.map(({ address, topic0, txHash, block }) => ({ address, topic0, txHash, block })));
    out.scannedTo = to;
    from = to + 1;
  }
  out.truncated = from <= head;
  try {
    const [a, b] = await Promise.all([worldBlockHash(url, out.scannedTo, rpc), worldBlockHash(witnessUrl, out.scannedTo, rpc)]);
    if (a && a === b) out.hash = a;
  } catch (_) { /* fail closed */ }
  if (!out.hash) out.error = "log-pin-disagreement";
  return out;
}

// World only: qualify a ranked pool against the exact watched getters, slots, and small log windows.
async function qualifyWorldRpc(prev, deps = {}) {
  const rpc = deps.rpc || rpcCall;
  const fresh = (timestamp) => {
    const nowSec = deps.nowSec ?? Math.floor(Date.now() / 1000);
    return Number.isSafeInteger(timestamp) && timestamp > 0 &&
      timestamp >= nowSec - WORLD_MAX_HEAD_AGE_SECONDS && timestamp <= nowSec + WORLD_MAX_FUTURE_SKEW_SECONDS;
  };
  const watch = UPGRADE_SENTINELS.find((s) => s.chainId === 480);
  if (prev && !validWorldCheckpoint(prev, watch)) return null;
  let urls = deps.urls;
  if (!urls) {
    const inventory = loadRpcUrls({ maxCandidates: 128 });
    // These public fallbacks are already in the approved inventory. Read only their local source literals.
    const source = fs.readFileSync(path.join(ROOT, "tools", "scan-capyfi-phase0.js"), "utf8");
    const section = source.match(/const LOCAL_PUBLIC_FALLBACKS\s*=\s*\{[\s\S]*?\b480:\s*(\[[\s\S]*?\])/);
    const publicUrls = section ? [...section[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((u) => /^https:\/\//i.test(u)) : [];
    const ranked = rankProviderUrls([...new Set([...inventory, ...publicUrls])], inventory.length + publicUrls.length);
    const reserved = ranked.filter((u) => publicUrls.includes(u));
    urls = [...ranked.filter((u) => !publicUrls.includes(u)).slice(0, WORLD_RPC_MAX_CANDIDATES - reserved.length), ...reserved];
  }
  const pool = deps.urls ? rankProviderUrls([...new Set(urls)], WORLD_RPC_MAX_CANDIDATES) : urls;
  const candidates = [];
  let attempts = 0;
  for (let i = 0; i < pool.length; i += 4) {
    const batch = pool.slice(i, i + 4);
    const values = await Promise.all(batch.map(async (url) => {
      try {
        if (Number(BigInt(await rpc(url, "eth_chainId", [], 8000))) !== 480) return null;
        const raw = await rpc(url, "eth_blockNumber", [], 8000);
        const head = Number(BigInt(raw));
        if (!Number.isSafeInteger(head) || head < WORLD_LOG_CHUNK_BLOCKS) return null;
        const header = await rpc(url, "eth_getBlockByNumber", ["0x" + head.toString(16), false], 8000);
        const timestamp = parseBlockTimestamp(header);
        if (!header || Number(BigInt(header.number || "0x0")) !== head || !HEX32.test(header.hash || "") || !fresh(timestamp)) return null;
        const byHash = await rpc(url, "eth_getBlockByHash", [header.hash, false], 8000);
        if (!byHash || Number(BigInt(byHash.number || "0x0")) !== head ||
            String(byHash.hash).toLowerCase() !== header.hash.toLowerCase() || parseBlockTimestamp(byHash) !== timestamp) return null;
        return { url, head,
          family: (deps.familyOf ? deps.familyOf(url) : providerFamily(url)) || `host:${new URL(url).hostname.toLowerCase()}` };
      } catch (_) { return null; }
    }));
    for (const candidate of values.filter(Boolean)) {
      for (const other of candidates) {
        if (other.family === candidate.family || ++attempts > 16 ||
            Math.abs(other.head - candidate.head) > WORLD_MAX_WITNESS_LAG_BLOCKS) continue;
        const block = Math.min(other.head, candidate.head);
        if (prev && prev.world.cursor > block) continue;
        try {
          const inspect = async (entry) => {
            const header = await rpc(entry.url, "eth_getBlockByNumber", ["0x" + block.toString(16), false], 8000);
            const headerTime = parseBlockTimestamp(header);
            if (!header || Number(BigInt(header.number || "0x0")) !== block || !HEX32.test(header.hash || "") ||
                !fresh(headerTime)) return null;
            const hash = header.hash.toLowerCase();
            const byHash = await rpc(entry.url, "eth_getBlockByHash", [hash, false], 8000);
            if (!byHash || Number(BigInt(byHash.number || "0x0")) !== block || String(byHash.hash).toLowerCase() !== hash) return null;
            const timestamp = parseBlockTimestamp(byHash);
            if (timestamp !== headerTime) return null;
            const tag = "0x" + block.toString(16);
            const c = { call: (to, data) => rpc(entry.url, "eth_call", [{ to, data }, tag], 8000),
              getStorage: (to, slot) => rpc(entry.url, "eth_getStorageAt", [to, slot, tag], 8000) };
            const state = [];
            for (const fn of ["lockbox", "owner", "FACTORY"]) {
              const p = watch.probes.find((probe) => probe.fn === fn);
              const v = p && await readProbe(c, p);
              if (v == null) return null;
              state.push(v);
            }
            for (const [, slot] of EIP1967_SLOTS) {
              const v = await readEip1967Slot(c, watch.eip1967[0], slot);
              if (v == null) return null;
              state.push(v);
            }
            return { hash, timestamp, state };
          };
          const [a, b] = await Promise.all([inspect(other), inspect(candidate)]);
          if (!a || !b || a.hash !== b.hash || a.timestamp !== b.timestamp ||
              JSON.stringify(a.state) !== JSON.stringify(b.state)) continue;
          if (prev) {
            const [ah, bh] = await Promise.all([worldBlockHash(other.url, prev.world.cursor, rpc), worldBlockHash(candidate.url, prev.world.cursor, rpc)]);
            if (ah !== prev.world.hash.toLowerCase() || bh !== ah) continue;
          }
          const start = prev ? Math.min(prev.world.cursor + 1, block) : block;
          const windows = [start, Math.max(0, block - WORLD_LOG_CHUNK_BLOCKS + 1)];
          let complete = true;
          for (const from of [...new Set(windows)]) {
            const to = Math.min(block, from + WORLD_LOG_CHUNK_BLOCKS - 1);
            if (!await worldLogPair(other.url, candidate.url, from, to, watch.eip1967, rpc)) { complete = false; break; }
          }
          if (complete && fresh(a.timestamp)) return { url: other.url, witnessUrl: candidate.url, block, hash: a.hash, timestamp: a.timestamp };
        } catch (_) { /* try another independent family */ }
      }
      candidates.push(candidate);
    }
  }
  return null;
}

// Mezo only: admit a provider after two independent families agree on every required
// target's code, six views, and all 15 EIP-1967 words at a single block hash.
// Raw state, endpoint identities and RPC failures remain process-only.
async function qualifyMezoRpc(deps = {}) {
  const watch = UPGRADE_SENTINELS.find((s) => s.chainId === 31612);
  const rpc = deps.rpc || rpcCall;
  let urls = deps.urls;
  if (!urls) urls = loadRpcUrls({ maxCandidates: 128 });
  if (!Array.isArray(urls) || !urls.length) return null;
  const ranked = rankProviderUrls([...new Set(urls)], urls.length);
  const pool = ranked.map((url, order) => ({ url, order })).sort((a, b) =>
    Number(/mezo|31612/i.test(b.url)) - Number(/mezo|31612/i.test(a.url)) ||
    rpcCapabilityRank(a.url) - rpcCapabilityRank(b.url) || a.order - b.order).slice(0, MEZO_RPC_MAX_CANDIDATES);
  const familyOf = (url) => {
    try { return (deps.familyOf ? deps.familyOf(url) : providerFamily(url)) || `host:${new URL(url).hostname.toLowerCase()}`; }
    catch (_) { return null; }
  };
  const read = async (url, method, params) => {
    try { return await rpc(url, method, params, 3500); } catch (_) { return null; }
  };
  const heads = await poolMap(pool, 4, async ({ url }) => {
    try {
      const idRaw = await read(url, "eth_chainId", []);
      if (typeof idRaw !== "string" || !/^0x[0-9a-f]+$/i.test(idRaw) || Number(BigInt(idRaw)) !== 31612) return null;
      const numberRaw = await read(url, "eth_blockNumber", []);
      if (typeof numberRaw !== "string" || !/^0x[0-9a-f]+$/i.test(numberRaw)) return null;
      const number = Number(BigInt(numberRaw));
      if (!Number.isSafeInteger(number) || number <= 0) return null;
      const header = await read(url, "eth_getBlockByNumber", ["0x" + number.toString(16), false]);
      if (!header || Number(BigInt(header.number || "0x0")) !== number || !HEX32.test(header.hash || "")) return null;
      return { url, number, hash: header.hash.toLowerCase(), family: familyOf(url), rank: rpcCapabilityRank(url) };
    } catch (_) { return null; }
  });
  const valid = heads.filter((h) => h && h.family);
  if (valid.length < 2) return null;
  const pin = valid[0].number, tag = "0x" + pin.toString(16), hash = valid[0].hash;
  const pinned = await poolMap(valid, 4, async (entry) => {
    const header = await read(entry.url, "eth_getBlockByNumber", [tag, false]);
    try { return header && Number(BigInt(header.number)) === pin && String(header.hash).toLowerCase() === hash ? entry : null; }
    catch (_) { return null; }
  });
  const inspect = async (entry) => {
    const c = { call: (to, data) => read(entry.url, "eth_call", [{ to, data }, tag]),
      getStorage: (to, slot) => read(entry.url, "eth_getStorageAt", [to, slot, tag]) };
    const tasks = [
      ...watch.eip1967.map((addr) => () => read(entry.url, "eth_getCode", [addr, tag]).then((code) =>
        typeof code === "string" && /^0x(?:[0-9a-f]{2})+$/i.test(code) ? code.toLowerCase() : null)),
      ...watch.probes.map((p) => () => readProbe(c, p).catch(() => null)),
      ...watch.eip1967.flatMap((addr) => EIP1967_SLOTS.map(([, slot]) => () => readEip1967Slot(c, addr, slot).catch(() => null))),
    ];
    const state = await poolMap(tasks, 4, (fn) => fn());
    return state.every((value) => value != null) ? state : null; // zero storage is a valid word
  };
  const capable = [];
  const ordered = pinned.filter(Boolean).sort((a, b) => a.rank - b.rank).slice(0, MEZO_RPC_MAX_TARGET_PROBES);
  for (const entry of ordered) {
    const state = await inspect(entry);
    if (!state) continue;
    for (const a of capable) {
      if (a.family === entry.family || a.state.some((value, k) => value !== state[k])) continue;
      const [ah, bh] = await Promise.all([
        read(a.url, "eth_getBlockByNumber", [tag, false]), read(entry.url, "eth_getBlockByNumber", [tag, false]),
      ]);
      try {
        if (Number(BigInt(ah.number)) !== pin || Number(BigInt(bh.number)) !== pin ||
            String(ah.hash).toLowerCase() !== hash || String(bh.hash).toLowerCase() !== hash) continue;
      } catch (_) { continue; }
      return { url: a.url, witnessUrl: entry.url, block: pin, hash, timestamp: parseBlockTimestamp(ah) };
    }
    capable.push({ ...entry, state });
  }
  return null;
}

async function evaluateUpgradeConfig(url, blockHex, blockNum, spec, prev, deps = {}) {
  const row = { sentinel: spec.id, chainId: spec.chainId, type: "upgrade/config", fired: false, ok: true, reason: "", label: spec.label };
  const hertzDeadline = spec.id === "upgrade:56:hertzflow" ? deps.deadline || Date.now() + HERTZ_RUN_MS : null;
  const arcDeadline = spec.id === "upgrade:5042:arc-cirbtc" ? deps.deadline || Date.now() + HERTZ_RUN_MS : null;
  const rhDeadline = RH_UPGRADE_IDS.includes(spec.id) ? deps.deadline || Date.now() + RH_RUN_MS : null;
  const hertzRead = async (method, params, ms = 5000) => {
    if (Date.now() >= hertzDeadline) return null;
    try { return await (deps.rpc || rpcCall)(url, method, params,
      Math.min(ms, Math.max(100, hertzDeadline - Date.now()))); }
    catch (_) { return null; }
  };
  const arcRead = async (method, params, ms = 5000) => {
    if (Date.now() >= arcDeadline) return null;
    try { return await (deps.rpc || rpcCall)(url, method, params,
      Math.min(ms, Math.max(100, arcDeadline - Date.now()))); }
    catch (_) { return null; }
  };
  const rhRead = async (method, params, ms = 5000) => {
    if (Date.now() >= rhDeadline) return null;
    try { return await (deps.rpc || rpcCall)(url, method, params,
      Math.min(ms, Math.max(100, rhDeadline - Date.now()))); }
    catch (_) { return null; }
  };
  const c = deps.caller || (hertzDeadline ? {
    call: (to, data) => hertzRead("eth_call", [{ to, data }, blockHex]),
    getStorage: (to, slot) => hertzRead("eth_getStorageAt", [to, slot, blockHex]),
  } : arcDeadline ? {
    call: (to, data) => arcRead("eth_call", [{ to, data }, blockHex]),
    getStorage: (to, slot) => arcRead("eth_getStorageAt", [to, slot, blockHex]),
    getCode: (to) => arcRead("eth_getCode", [to, blockHex]),
  } : rhDeadline ? {
    call: (to, data) => rhRead("eth_call", [{ to, data }, blockHex]),
    getStorage: (to, slot) => rhRead("eth_getStorageAt", [to, slot, blockHex]),
  } : makeCaller(url, blockHex));
  const snapshots = {};
  const fired = [];
  const unread = [];
  let hertzCheckpoint = null;
  let hertzWitnessVerified = false;
  let arcCheckpoint = null;
  let arcWitnessVerified = false;
  let rhCheckpoint = null;
  let rhWitnessVerified = false;
  let logCheckpoint = null;
  try {
    const world = spec.chainId === 480;
    const hertz = spec.id === "upgrade:56:hertzflow";
    const arc = spec.id === "upgrade:5042:arc-cirbtc";
    const rh = RH_UPGRADE_IDS.includes(spec.id);
    const generic = !world && !hertz && !arc && !rh && spec.eip1967.length > 0;
    const priorPin = prev && Number.isInteger(prev.pin) ? prev.pin : null;
    if (world && prev && !validWorldCheckpoint(prev, spec)) {
      row.ok = false; row.error = "world-spec-or-checkpoint-invalid"; row.reason = "World checkpoint incompatible with watched spec";
      return { row, snapshot: snapshots, pin: blockNum, world: null };
    }
    let worldPinVerified = false;
    let scan = { hits: [], scannedFrom: null, truncated: false, error: null };
    if (rh) {
      if (!prev || priorPin == null || (prev.rh && !validRhCheckpoint(prev, spec))) {
        row.ok = false; row.error = "rh-baseline-or-spec-invalid"; row.reason = "Robinhood baseline unavailable or incompatible";
        return { row, snapshot: snapshots, pin: blockNum, rh: null };
      }
      const rpc = deps.rpc || rpcCall, deadline = rhDeadline;
      const oldHash = await hertzBlockHash(url, priorPin, rpc, deadline);
      if (!oldHash || (prev.rh && oldHash !== prev.rh.pinHash.toLowerCase())) {
        row.ok = false; row.error = "rh-pin-unreadable-or-reorg";
      } else {
        const tag = "0x" + priorPin.toString(16);
        const historic = { call: (to, data) => rhRead("eth_call", [{ to, data }, tag]),
          getStorage: (to, slot) => rhRead("eth_getStorageAt", [to, slot, tag]) };
        const replay = await rhSnapshot(historic, spec, prev);
        if (!replay) {
          row.ok = false; row.error = prev.rh ? "rh-snapshot-replay-unreadable" : "rh-legacy-replay-unreadable";
        } else if (Object.entries(replay).some(([key, value]) => prev.snapshots[key] == null ||
            normValue(prev.snapshots[key]) !== normValue(value))) {
          row.ok = false; row.error = prev.rh ? "rh-snapshot-replay-mismatch" : "rh-legacy-replay-mismatch";
        } else rhCheckpoint = prev.rh ? { ...prev.rh } : {
          cursor: priorPin, hash: oldHash, pinHash: oldHash, hit: false, specFingerprint: rhSpecFingerprint(spec),
        };
      }
      if (rhCheckpoint && deps.witnessUrl) {
        const witnessHash = await hertzBlockHash(deps.witnessUrl, priorPin, rpc, deadline);
        if (witnessHash !== oldHash) { row.ok = false; row.error = "rh-pin-disagreement"; }
        rhWitnessVerified = witnessHash === oldHash;
      }
      if (rhCheckpoint && row.ok) {
        const cursorHash = await hertzBlockHash(url, rhCheckpoint.cursor, rpc, deadline);
        if (cursorHash !== rhCheckpoint.hash.toLowerCase()) { row.ok = false; row.error = "rh-cursor-reorg"; }
      }
      if (rhCheckpoint && row.ok && rhCheckpoint.cursor > blockNum) {
        row.ok = false; row.error = "pin-ahead-of-block";
      }
      if (!row.ok) {
        row.fired = validRhCheckpoint(prev, spec) && prev.rh.hit;
        row.reason = `Robinhood baseline validation incomplete (${row.error})`;
        return { row, snapshot: snapshots, pin: blockNum, rh: null };
      }
      if (rhCheckpoint && rhCheckpoint.cursor < blockNum) {
        scan = await (deps.scanRhLogs || scanHertzLogs)(url, rhCheckpoint.cursor + 1, blockNum,
          spec, rpc, deadline, deps.chunkBudget);
        if (scan.scannedTo != null && scan.scannedTo >= rhCheckpoint.cursor + 1 &&
            scan.scannedTo <= blockNum && HEX32.test(scan.hash || "")) {
          rhCheckpoint.cursor = scan.scannedTo;
          rhCheckpoint.hash = scan.hash.toLowerCase();
        } else if (scan.scannedTo != null || scan.hash != null) scan.error = "rh-checkpoint-invalid";
        if (scan.hits.length) rhCheckpoint.hit = true;
      }
      const headHash = await hertzBlockHash(url, blockNum, rpc, deadline);
      if (!HEX32.test(deps.headHash || "") || headHash !== deps.headHash.toLowerCase()) {
        row.ok = false; row.error = "rh-head-reorg";
      }
      if (!row.ok) scan.error = row.error;
      if (rhCheckpoint?.hit) fired.push("eip1967-logs:earlier");
    } else if (arc) {
      if (!prev || priorPin == null || (prev.arc && !validArcCheckpoint(prev, spec))) {
        row.ok = false; row.error = "arc-baseline-or-spec-invalid"; row.reason = "Arc baseline unavailable or incompatible";
        return { row, snapshot: snapshots, pin: blockNum, arc: null };
      }
      const rpc = deps.rpc || rpcCall, deadline = arcDeadline;
      const oldHash = await hertzBlockHash(url, priorPin, rpc, deadline);
      if (!oldHash || (prev.arc && oldHash !== prev.arc.pinHash.toLowerCase())) {
        row.ok = false; row.error = "arc-pin-unreadable-or-reorg";
      } else {
        const tag = "0x" + priorPin.toString(16);
        const historic = { call: (to, data) => arcRead("eth_call", [{ to, data }, tag]),
          getStorage: (to, slot) => arcRead("eth_getStorageAt", [to, slot, tag]),
          getCode: (to) => arcRead("eth_getCode", [to, tag]) };
        const replay = await arcSnapshot(historic, spec, deps.arcCodeHash || ethers.keccak256);
        if (!replay || Object.entries(replay).some(([key, value]) => prev.snapshots[key] == null ||
            normValue(prev.snapshots[key]) !== normValue(value))) {
          row.ok = false; row.error = prev.arc ? "arc-snapshot-replay-mismatch" : "arc-legacy-replay-mismatch";
        } else arcCheckpoint = prev.arc ? { ...prev.arc } : {
          cursor: priorPin, hash: oldHash, pinHash: oldHash, hit: false, specFingerprint: arcSpecFingerprint(spec),
        };
      }
      if (arcCheckpoint && deps.witnessUrl) {
        const witnessHash = await hertzBlockHash(deps.witnessUrl, priorPin, rpc, deadline);
        if (witnessHash !== oldHash) { row.ok = false; row.error = "arc-pin-disagreement"; }
        arcWitnessVerified = witnessHash === oldHash;
      }
      if (arcCheckpoint && row.ok) {
        const cursorHash = await hertzBlockHash(url, arcCheckpoint.cursor, rpc, deadline);
        if (cursorHash !== arcCheckpoint.hash.toLowerCase()) { row.ok = false; row.error = "arc-cursor-reorg"; }
      }
      if (arcCheckpoint && row.ok && arcCheckpoint.cursor > blockNum) {
        row.ok = false; row.error = "pin-ahead-of-block";
      }
      if (!row.ok) {
        row.fired = validArcCheckpoint(prev, spec) && prev.arc.hit;
        row.reason = `Arc baseline validation incomplete (${row.error})`;
        return { row, snapshot: snapshots, pin: blockNum, arc: null };
      }
      if (arcCheckpoint && arcCheckpoint.cursor < blockNum) {
        scan = await (deps.scanArcLogs || scanHertzLogs)(url, arcCheckpoint.cursor + 1, blockNum, spec, rpc, deadline);
        if (scan.scannedTo != null && scan.scannedTo >= arcCheckpoint.cursor + 1 &&
            scan.scannedTo <= blockNum && HEX32.test(scan.hash || "")) {
          arcCheckpoint.cursor = scan.scannedTo;
          arcCheckpoint.hash = scan.hash.toLowerCase();
        } else if (scan.scannedTo != null || scan.hash != null) scan.error = "arc-checkpoint-invalid";
        if (scan.hits.length) arcCheckpoint.hit = true;
      }
      const headHash = await hertzBlockHash(url, blockNum, rpc, deadline);
      if (!HEX32.test(deps.headHash || "") || headHash !== deps.headHash.toLowerCase()) {
        row.ok = false; row.error = "arc-head-reorg";
      }
      if (!row.ok) scan.error = row.error;
      if (arcCheckpoint?.hit) fired.push("eip1967-logs:earlier");
    } else if (hertz) {
      if (!prev || priorPin == null || (prev.hertz && !validHertzCheckpoint(prev, spec))) {
        row.ok = false; row.error = "hertz-baseline-or-spec-invalid"; row.reason = "HertzFlow baseline unavailable or incompatible";
        return { row, snapshot: snapshots, pin: blockNum, hertz: null };
      }
      const rpc = deps.rpc || rpcCall, deadline = hertzDeadline;
      const oldHash = await hertzBlockHash(url, priorPin, rpc, deadline);
      if (!oldHash || (prev.hertz && oldHash !== prev.hertz.pinHash.toLowerCase())) {
        row.ok = false; row.error = "hertz-pin-unreadable-or-reorg";
      } else {
        const tag = "0x" + priorPin.toString(16);
        const historic = { call: (to, data) => hertzRead("eth_call", [{ to, data }, tag]),
          getStorage: (to, slot) => hertzRead("eth_getStorageAt", [to, slot, tag]) };
        const replay = await hertzSnapshot(historic, spec);
        if (!replay || Object.entries(replay).some(([key, value]) => prev.snapshots[key] == null ||
            normValue(prev.snapshots[key]) !== normValue(value))) {
          row.ok = false; row.error = prev.hertz ? "hertz-snapshot-replay-mismatch" : "hertz-legacy-replay-mismatch";
        } else hertzCheckpoint = prev.hertz ? { ...prev.hertz } : {
          cursor: priorPin, hash: oldHash, pinHash: oldHash, hit: false, specFingerprint: hertzSpecFingerprint(spec),
        };
      }
      if (hertzCheckpoint && deps.witnessUrl) {
        const witnessHash = await hertzBlockHash(deps.witnessUrl, priorPin, rpc, deadline);
        if (witnessHash !== oldHash) { row.ok = false; row.error = "hertz-pin-disagreement"; }
        hertzWitnessVerified = witnessHash === oldHash;
      }
      if (hertzCheckpoint && row.ok) {
        const cursorHash = await hertzBlockHash(url, hertzCheckpoint.cursor, rpc, deadline);
        if (cursorHash !== hertzCheckpoint.hash.toLowerCase()) { row.ok = false; row.error = "hertz-cursor-reorg"; }
      }
      if (hertzCheckpoint && row.ok && hertzCheckpoint.cursor > blockNum) {
        row.ok = false; row.error = "pin-ahead-of-block";
      }
      if (!row.ok) {
        row.fired = validHertzCheckpoint(prev, spec) && prev.hertz.hit;
        row.reason = `HertzFlow baseline validation incomplete (${row.error})`;
        return { row, snapshot: snapshots, pin: blockNum, hertz: null };
      }
      if (hertzCheckpoint && row.ok && hertzCheckpoint.cursor < blockNum) {
        scan = await (deps.scanHertzLogs || scanHertzLogs)(url, hertzCheckpoint.cursor + 1, blockNum, spec, rpc, deadline);
        if (scan.scannedTo != null && scan.scannedTo >= hertzCheckpoint.cursor + 1 &&
            scan.scannedTo <= blockNum && HEX32.test(scan.hash || "")) {
          hertzCheckpoint.cursor = scan.scannedTo;
          hertzCheckpoint.hash = scan.hash.toLowerCase();
        } else if (scan.scannedTo != null || scan.hash != null) scan.error = "hertz-checkpoint-invalid";
        if (scan.hits.length) hertzCheckpoint.hit = true;
      }
      if (hertzCheckpoint && row.ok) {
        const headHash = await hertzBlockHash(url, blockNum, rpc, deadline);
        if (!HEX32.test(deps.headHash || "") || headHash !== deps.headHash.toLowerCase()) {
          row.ok = false; row.error = "hertz-head-reorg";
        }
      }
      if (!row.ok) scan.error = row.error;
      if (hertzCheckpoint?.hit) fired.push("eip1967-logs:earlier");
    } else if (world && priorPin != null) {
      if (prev.world.cursor > blockNum) scan.error = "pin-ahead-of-block";
      else {
        let hash = null;
        try {
          const [a, b] = await Promise.all([worldBlockHash(url, prev.world.cursor, deps.rpc || rpcCall),
            worldBlockHash(deps.witnessUrl, prev.world.cursor, deps.rpc || rpcCall)]);
          if (a && a === b) hash = a;
        } catch (_) { /* fail closed */ }
        if (hash !== prev.world.hash.toLowerCase()) scan.error = "world-checkpoint-reorg";
        else {
          worldPinVerified = true;
          if (prev.world.cursor < blockNum) {
            scan = await (deps.scanWorldLogs || scanWorldUpgradeLogs)(url, prev.world.cursor + 1, blockNum, spec.eip1967 || [], deps.rpc || rpcCall, deps.witnessUrl);
            if (!scan.error && (!Number.isSafeInteger(scan.scannedTo) || scan.scannedTo < prev.world.cursor + 1 ||
                scan.scannedTo > blockNum || !HEX32.test(scan.hash || ""))) scan.error = "world-checkpoint-invalid";
          }
        }
      }
    } else if (generic) {
      const resumed = await resumeUpgradeLogs(url, blockNum, spec, prev, deps);
      scan = resumed.scan;
      logCheckpoint = resumed.checkpoint;
      if (logCheckpoint?.hit || (validLogCheckpoint(prev, spec) && prev.logScan.hit)) fired.push("eip1967-logs:earlier");
    }
    if (priorPin != null && priorPin > blockNum) scan.error = "pin-ahead-of-block";
    if (world && (!HEX32.test(deps.headHash || "") || !deps.witnessUrl)) scan.error = "world-head-or-witness-unavailable";
    if (world && !scan.error && scan.scannedTo === blockNum && scan.hash.toLowerCase() !== deps.headHash.toLowerCase()) {
      scan.error = "world-head-reorg";
    }
    if (world && !scan.error) {
      try {
        const [a, b] = await Promise.all([worldBlockHash(url, blockNum, deps.rpc || rpcCall),
          worldBlockHash(deps.witnessUrl, blockNum, deps.rpc || rpcCall)]);
        if (a !== deps.headHash.toLowerCase() || b !== a) scan.error = "world-head-reorg";
      } catch (_) { scan.error = "world-head-reorg"; }
    }
    if (scan.hits.length) fired.push(`eip1967-logs:${scan.hits.length}`);
    if (world && prev?.world?.hit === true) fired.push("eip1967-logs:earlier");

    const alternatives = new Map();
    for (const p of spec.probes || []) {
      const key = probeKey(p);
      let value = null;
      try { value = await readProbe(c, p); } catch (_) { value = null; }
      // Optional/alternate ABI absence must not erase a previously readable comparison.
      snapshots[key] = value == null && (p.optional || p.alternative) && prev?.snapshots?.[key] != null
        ? prev.snapshots[key] : value;
      if (p.alternative) {
        alternatives.set(p.alternative, (alternatives.get(p.alternative) || false) || value != null);
      } else if (value == null && !p.optional) unread.push(key);
      if (value == null) continue;
      const prevVal = prev && prev.snapshots ? prev.snapshots[key] : undefined;
      if (evalProbeRule(p.rule, value, prevVal, p.thresholdPct, p.expected).fired) fired.push(`${p.roleGetter || p.fn}@${shortAddr(p.target)}`);
    }
    for (const [name, readable] of alternatives) if (!readable) unread.push(`alternative:${name}`);
    for (const addr of spec.eip1967 || []) {
      for (const [name, slot] of EIP1967_SLOTS) {
        const key = `slot:${String(addr).toLowerCase()}:${name}`;
        let value = null;
        try { value = await readEip1967Slot(c, addr, slot); } catch (_) { value = null; }
        snapshots[key] = value;
        if (value == null) unread.push(key);
        const prevVal = prev && prev.snapshots ? prev.snapshots[key] : undefined;
        if (value != null && prevVal != null && normValue(prevVal) !== normValue(value)) fired.push(`slot-${name}@${shortAddr(addr)}`);
      }
    }
    let legacyMismatch = 0;
    for (const legacy of spec.legacyProxy || []) {
      const key = `legacy:${String(legacy.target).toLowerCase()}:${legacy.name}`;
      let value = null;
      try { value = await readEip1967Slot(c, legacy.target, legacy.slot); } catch (_) { value = null; }
      snapshots[key] = value;
      if (value == null) unread.push(key); // all-zero storage is readable, not missing
      const prevVal = prev && prev.snapshots ? prev.snapshots[key] : undefined;
      if (value != null && prevVal != null && normValue(prevVal) !== normValue(value)) fired.push(`legacy-${legacy.name}@${shortAddr(legacy.target)}`);
      const viewProbe = (spec.probes || []).find((p) => p.target.toLowerCase() === legacy.target.toLowerCase() && p.fn === legacy.view);
      const view = viewProbe && snapshots[probeKey(viewProbe)];
      if (!viewProbe || viewProbe.optional) unread.push(`legacy-view:${legacy.name}`);
      else if (value != null && view != null && `0x${value.slice(-40)}` !== normValue(view)) legacyMismatch++;
    }
    let arcBindingError = null;
    if (spec.id === "upgrade:5042:arc-cirbtc") {
      const implWord = snapshots[`legacy:${AR.cirBTC.toLowerCase()}:impl`];
      const implProbe = spec.probes.find((p) => p.fn === "implementation");
      const implView = implProbe && snapshots[probeKey(implProbe)];
      if (implWord == null || implView == null) arcBindingError = "arc-implementation-unreadable";
      else if (`0x${implWord.slice(-40)}` !== ARC_BOUND_IMPL || normValue(implView) !== ARC_BOUND_IMPL) {
        arcBindingError = "arc-implementation-unbound";
        fired.push(`arc-impl-review@${shortAddr(AR.cirBTC)}`);
      } else {
        let code = null;
        try { if (typeof c.getCode === "function") code = await c.getCode(ARC_BOUND_IMPL); }
        catch (_) { /* unreadable: do not persist RPC failures */ }
        if (typeof code !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(code)) arcBindingError = "arc-runtime-unreadable";
        else if ((code.length - 2) / 2 !== ARC_BOUND_RUNTIME_BYTES ||
            (deps.arcCodeHash || ethers.keccak256)(code).toLowerCase() !== ARC_BOUND_RUNTIME_HASH) {
          arcBindingError = "arc-runtime-changed";
          fired.push(`arc-runtime-review@${shortAddr(AR.cirBTC)}`);
        }
      }
    }
    row.fired = fired.length > 0;
    row.ok = row.ok && !scan.truncated && !scan.error && unread.length === 0 && legacyMismatch === 0 && !arcBindingError;
    if (hertz && (!hertzCheckpoint || hertzCheckpoint.cursor !== blockNum)) row.ok = false;
    if (arc && (!arcCheckpoint || arcCheckpoint.cursor !== blockNum)) row.ok = false;
    if (rh && (!rhCheckpoint || rhCheckpoint.cursor !== blockNum)) row.ok = false;
    if (world && priorPin != null && (scan.scannedTo ?? prev.world.cursor) !== blockNum) row.ok = false;
    if (world && !scan.error && priorPin != null && scan.scannedTo != null) {
      // Commit only validated contiguous coverage, even when current state reads are incomplete.
      row.worldCheckpoint = { cursor: scan.scannedTo, hash: scan.hash.toLowerCase(),
        hit: prev.world.hit || scan.hits.length > 0, specFingerprint: worldSpecFingerprint(spec) };
    } else if (world && worldPinVerified && scan.hits.length &&
        ["logs-unreadable", "logs-disagreement", "log-pin-disagreement", "world-head-reorg"].includes(scan.error)) {
      // Keep the observed hit without advancing over an unvalidated log interval.
      row.worldCheckpoint = { ...prev.world, hit: true };
    }
    row.measurements = {
      type: "upgrade/config", label: spec.label,
      eip1967Addrs: (spec.eip1967 || []).length, probes: (spec.probes || []).length,
      logHits: scan.hits.length, logScannedFrom: scan.scannedFrom, logTruncated: scan.truncated, logError: scan.error,
      pinBlock: blockNum, priorPin, unreadRequired: unread.length, legacySlotMismatch: legacyMismatch,
      ...(hertz ? { logScannedTo: hertzCheckpoint?.cursor ?? null, bulkLogs: "single-primary",
        headerWitness: hertzWitnessVerified } : {}),
      ...(arc ? { logScannedTo: arcCheckpoint?.cursor ?? null, bulkLogs: "single-primary",
        headerWitness: arcWitnessVerified } : {}),
      ...(rh ? { logScannedTo: rhCheckpoint?.cursor ?? null, bulkLogs: "single-primary",
        headerWitness: rhWitnessVerified } : {}),
      ...(generic ? { logScannedTo: logCheckpoint?.cursor ?? prev?.logScan?.cursor ?? null,
        bulkLogs: "single-primary", headerWitness: false } : {}),
      ...(spec.id === "upgrade:5042:arc-cirbtc" ? { arcBinding: arcBindingError || "bound" } : {}),
      ...(spec.id === "upgrade:4663:modt-usde-usdg" ? { observedDeviation: snapshots[probeKey(spec.probes.find((p) => p.fn === "getDeviation"))] } : {}),
      configDeltas: fired.filter((x) => !x.startsWith("eip1967-logs")).length,
      firedReasons: fired.join(",").slice(0, 300),
    };
    if (!row.ok) row.error = scan.error || (scan.truncated ? "logs-truncated" : unread.length ? "required-read-unreadable" : legacyMismatch ? "legacy-slot-view-mismatch" : arcBindingError || "required-read-unreadable");
    if (row.fired) {
      row.reason = `upgrade/config change -> re-decode: ${fired.slice(0, 8).join(", ")}${fired.length > 8 ? ` (+${fired.length - 8})` : ""}`;
    } else if (!row.ok) {
      row.reason = `not-fired: upgrade/config scan incomplete (${row.error})`;
    } else {
      row.reason = `dormant: no EIP-1967 events and no config delta${priorPin != null ? ` since pin ${priorPin}` : world ? " (baseline pinned; no pre-baseline history claim)" : " (baseline pinned)"}`;
    }
  } catch (_) {
    row.ok = false; row.error = "upgrade-scan-failed"; row.reason = "sentinel read failed";
  }
  return { row, snapshot: snapshots, pin: blockNum, hertz: hertzCheckpoint, arc: arcCheckpoint, rh: rhCheckpoint, logScan: logCheckpoint,
    world: row.worldCheckpoint || (spec.chainId === 480 && row.ok
      ? { cursor: blockNum, hash: deps.headHash.toLowerCase(), hit: false,
        specFingerprint: worldSpecFingerprint(spec) } : null) };
}

// ---------------- strike sentinels ----------------
function loadStrikeSentinels() {
  const parsed = JSON.parse(fs.readFileSync(SENTINEL_SOURCE, "utf8"));
  const rows = Array.isArray(parsed.sentinels) ? parsed.sentinels : [];
  return rows
    .filter((r) => r && CHAIN_IDS.includes(Number(r.chainId)) && typeof r.marketId === "string" && HEX32.test(r.marketId))
    .map((r) => {
      const isBw = String(r.marketId).toLowerCase() === BWUSDC_MARKET;
      return {
        chainId: Number(r.chainId),
        marketId: r.marketId,
        oracle: typeof r.oracle === "string" ? r.oracle.toLowerCase() : null,
        morpho: r.morpho,
        pair: r.pair,
        floorUsd: typeof r.floorUsd === "number" && r.floorUsd > 0 ? r.floorUsd : 50,
        spec: `strike:${r.chainId}:${r.marketId.slice(2, 10)}`,
        routeStatus: isBw ? BWUSDC_ROUTE_STATUS : (typeof r.routeStatus === "string" ? r.routeStatus : null),
        routePositive: isBw ? false : (typeof r.routePositive === "boolean" ? r.routePositive : null),
      };
    });
}

// Optional execution evidence: a completed in-batch strike written by tools/exec-bwusdc-strike.js.
// It only annotates the matching sentinel; the fired flag always comes from live liquidity.
function loadExecutions() {
  try {
    const parsed = JSON.parse(fs.readFileSync(EXECUTION_EVIDENCE, "utf8"));
    if (
      parsed && parsed.schema === "w9-bwusdc-strike/execution-v1" && parsed.status === "SUCCESS" &&
      typeof parsed.marketId === "string" && HEX32.test(parsed.marketId) && Array.isArray(parsed.txHashes)
    ) {
      return parsed;
    }
  } catch (_) { /* no execution evidence yet */ }
  return null;
}

async function detectErc4626(c, collateralToken) {
  const assetRaw = await c.call(collateralToken, ERC4626_IF.encodeFunctionData("asset", []));
  if (assetRaw == null) return null;
  if (assetRaw === "0x") return false; // selector not implemented
  const asset = decode(ERC4626_IF, "asset", assetRaw)?.[0];
  if (!asset) return null;
  if (asset === ethers.ZeroAddress) return false;
  const totalRaw = await c.call(collateralToken, ERC4626_IF.encodeFunctionData("totalAssets", []));
  if (totalRaw == null) return null;
  if (totalRaw === "0x") return false;
  return decode(ERC4626_IF, "totalAssets", totalRaw) ? true : null;
}

async function evaluateStrike(url, blockHex, spec, deps = {}) {
  const row = { sentinel: spec.spec, chainId: spec.chainId, fired: false, ok: true, reason: "" };
  const c = deps.caller || makeCaller(url, blockHex);
  try {
    const mRaw = await c.call(spec.morpho, MORPHO_IF.encodeFunctionData("market", [spec.marketId]));
    const pRaw = await c.call(spec.morpho, MORPHO_IF.encodeFunctionData("idToMarketParams", [spec.marketId]));
    const state = decode(MORPHO_IF, "market", mRaw);
    const params = decode(MORPHO_IF, "idToMarketParams", pRaw)?.[0];
    if (!state || !params) { row.ok = false; row.error = "market-decode-failed"; row.reason = "market state unreadable"; return row; }
    const loanToken = String(params[0]), collateralToken = String(params[1]), oracle = String(params[2]);
    if (oracle && spec.oracle && oracle.toLowerCase() !== spec.oracle) {
      row.ok = false; row.error = "oracle-mismatch"; row.reason = "idToMarketParams oracle does not match the spec pin";
      return row;
    }
    const supply = b(state[0]), borrow = b(state[2]);
    const available = supply > borrow ? supply - borrow : 0n;
    if (available === 0n && spec.marketId.toLowerCase() !== BWUSDC_MARKET) {
      if ([loanToken, collateralToken, oracle].some((address) => address.toLowerCase() === ethers.ZeroAddress.toLowerCase())) {
        row.ok = false; row.error = "market-params-invalid"; row.reason = "market parameters unreadable";
        return row;
      }
      // No market-available loan units can cross either floor. Do not classify the loan
      // or its exit until availability appears; keep the route claim unchanged.
      row.routeStatus = spec.routeStatus;
      row.routePositive = spec.routePositive;
      row.measurements = {
        pair: spec.pair || null, marketId: spec.marketId, morpho: spec.morpho,
        collateralToken, loanToken, loanSymbol: null, loanDecimals: null, oracle,
        erc4626: null, floorUsd: null, totalSupplyAssets: supply.toString(),
        totalBorrowAssets: borrow.toString(), availableRaw: "0", availableLiquidityUsd: null,
        exitPriced: false, routeStatus: spec.routeStatus, routePositive: spec.routePositive, liquidityFired: false,
      };
      row.reason = "zero market-available loan units; token/exit unverified; reopen if supply appears";
      return row;
    }
    const [symRaw, decRaw] = await Promise.all([
      c.call(loanToken, ERC20_IF.encodeFunctionData("symbol", [])),
      c.call(loanToken, ERC20_IF.encodeFunctionData("decimals", [])),
    ]);
    const loanSymbol = decode(ERC20_IF, "symbol", symRaw)?.[0];
    const loanDecimals = decode(ERC20_IF, "decimals", decRaw)?.[0];
    const metadataReadable = typeof loanSymbol === "string" && loanSymbol.length > 0 && loanDecimals != null;
    const exitPriced = metadataReadable && isUsdStable(loanSymbol);
    let erc4626 = spec.marketId.toLowerCase() === BWUSDC_MARKET;
    if (!erc4626) { try { erc4626 = await detectErc4626(c, collateralToken); } catch (_) { erc4626 = null; } }
    if (spec.chainId === 1 && spec.marketId.toLowerCase() === PENDLE_PT_MARKET &&
        collateralToken.toLowerCase() === PENDLE_PT_COLLATERAL) {
      let code = null;
      try { if (typeof c.getCode === "function") code = await c.getCode(collateralToken); }
      catch (_) { /* code identity unknown */ }
      const bound = typeof code === "string" && /^0x(?:[0-9a-fA-F]{2})+$/.test(code) &&
        (deps.ptCodeHash || ethers.keccak256)(code).toLowerCase() === PENDLE_PT_RUNTIME_HASH;
      // This exact deployed runtime has no ERC-4626 selectors. No other PT or market inherits this result.
      erc4626 = bound && erc4626 !== true ? false : null;
    }
    const floorUsd = erc4626 === null ? null : erc4626 ? ERC4626_FLOOR_USD : spec.floorUsd;
    const availableUsd = exitPriced ? Number(available) / 10 ** Number(loanDecimals) : null;
    const isBw = spec.marketId.toLowerCase() === BWUSDC_MARKET;
    // bwUSDC's MarketWrapper deposit gate: fire only when the protocol has opened the gate.
    let roleReceiver = null, gateOpen = null, gateError = null;
    if (isBw) {
      try {
        const rrRaw = await c.call(collateralToken, ROLE_IF.encodeFunctionData("roleReceiver", []));
        const rr = decode(ROLE_IF, "roleReceiver", rrRaw)?.[0];
        if (rr && rr !== ethers.ZeroAddress) {
          roleReceiver = String(rr);
          const iniRaw = await c.call(roleReceiver, ROLE_IF.encodeFunctionData("isRebalanceInitiated", []));
          const ini = decode(ROLE_IF, "isRebalanceInitiated", iniRaw)?.[0];
          gateOpen = ini === true ? true : ini === false ? false : null;
        } else { gateError = "gate-read-failed"; }
      } catch (_) { gateError = "gate-read-failed"; gateOpen = null; }
    }
    // Unknown collateral type cannot hide a trigger above the higher floor, or assert dormancy
    // between the two floors. An ABI revert outside that interval need not fail the entire row.
    const liquidityFired = exitPriced && availableUsd > (floorUsd == null ? Math.max(ERC4626_FLOOR_USD, spec.floorUsd) : floorUsd);
    row.routeStatus = spec.routeStatus;
    row.routePositive = spec.routePositive;
    row.measurements = {
      pair: spec.pair || null,
      marketId: spec.marketId,
      morpho: spec.morpho,
      collateralToken,
      loanToken,
      loanSymbol: loanSymbol == null ? null : String(loanSymbol),
      loanDecimals: loanDecimals == null ? null : Number(loanDecimals),
      oracle,
      erc4626,
      floorUsd,
      totalSupplyAssets: supply.toString(),
      totalBorrowAssets: borrow.toString(),
      availableRaw: available.toString(),
      availableLiquidityUsd: availableUsd == null ? null : availableUsd.toFixed(6),
      exitPriced,
      routeStatus: spec.routeStatus,
      routePositive: spec.routePositive,
      liquidityFired,
      roleReceiver,
      isRebalanceInitiated: gateOpen,
      gateOpen,
    };
    if (!metadataReadable) {
      row.ok = false; row.error = "loan-metadata-unreadable";
      row.reason = "not-fired: loan symbol/decimals unreadable; exit pricing unknown";
      return row;
    }
    if (!exitPriced) {
      row.fired = false;
      if (isBw && gateOpen === null) { row.ok = false; row.error = gateError || "gate-read-failed"; }
      row.reason = `monitored/exit-unpriced: loan ${String(loanSymbol)} is not a USD stable; floor ${floorUsd == null ? `unknown (ERC-4626 $${ERC4626_FLOOR_USD} or ordinary $${spec.floorUsd})` : `$${floorUsd}`}`;
      return row;
    }
    if (isBw) {
      if (gateOpen === true) {
        row.fired = liquidityFired;
        row.reason = row.fired
          ? `availableLiquidityUsd ${availableUsd.toFixed(6)} > floor $${floorUsd} and MarketWrapper gate OPEN (isRebalanceInitiated=true)`
          : `dormant: gate open but availableLiquidityUsd ${availableUsd.toFixed(6)} <= floor $${floorUsd}`;
      } else {
        row.fired = false;
        if (gateOpen === null) { row.ok = false; row.error = gateError || "gate-read-failed"; }
        row.reason = gateOpen === false
          ? `dormant: MarketWrapper deposit gate CLOSED (isRebalanceInitiated=false; routePositive=false)`
          : "not-fired: MarketWrapper gate unreadable";
      }
      return row;
    }
    row.fired = liquidityFired;
    if (erc4626 === null && !row.fired && availableUsd > Math.min(ERC4626_FLOOR_USD, spec.floorUsd)) {
      row.ok = false; row.error = "collateral-type-unreadable";
      row.reason = "not-fired: collateral type unknown between ERC-4626 and ordinary floors";
    } else if (erc4626 === null) {
      row.reason = row.fired
        ? `availableLiquidityUsd ${availableUsd.toFixed(6)} > conservative floor $${Math.max(ERC4626_FLOOR_USD, spec.floorUsd)} (collateral type unknown)`
        : `dormant: availableLiquidityUsd ${availableUsd.toFixed(6)} <= both collateral floors`;
    } else {
      row.reason = row.fired
        ? `availableLiquidityUsd ${availableUsd.toFixed(6)} > floor $${floorUsd}${erc4626 ? " (open ERC-4626 collateral)" : ""}`
        : `dormant: availableLiquidityUsd ${availableUsd.toFixed(6)} <= floor $${floorUsd}`;
    }
  } catch (_) {
    row.ok = false; row.error = "strike-read-failed"; row.reason = "sentinel read failed";
  }
  return row;
}

// ---------------- RH monitor-only sentinels ----------------
async function sentinelUsdeModt(url, blockHex, deps = {}) {
  const row = { sentinel: "rh:usde-usdg-modt-deviation", chainId: 4663, fired: false, ok: true, reason: "" };
  const c = deps.caller || makeCaller(url, blockHex);
  try {
    const [devRaw, thrRaw, chalRaw, primRaw, feedRaw] = await Promise.all([
      c.call(RH_MODT_CLONE, MODT_IF.encodeFunctionData("getDeviation", [])),
      c.call(RH_MODT_CLONE, MODT_IF.encodeFunctionData("deviationThreshold", [])),
      c.call(RH_MODT_CLONE, MODT_IF.encodeFunctionData("isChallenged", [])),
      c.call(RH_MODT_CLONE, MODT_IF.encodeFunctionData("isPrimary", [])),
      c.call(RH_USDE_FEED, FEED_IF.encodeFunctionData("latestRoundData", [])),
    ]);
    const dev = decode(MODT_IF, "getDeviation", devRaw)?.[0];
    const thr = decode(MODT_IF, "deviationThreshold", thrRaw)?.[0];
    const challenged = decode(MODT_IF, "isChallenged", chalRaw)?.[0];
    const primary = decode(MODT_IF, "isPrimary", primRaw)?.[0];
    const feed = decode(FEED_IF, "latestRoundData", feedRaw);
    if (dev === undefined || thr === undefined || challenged === undefined || primary === undefined || !feed) {
      row.ok = false; row.error = "oracle-decode-failed"; row.reason = "MODT clone/feed unreadable"; return row;
    }
    const answer = b(feed[1]);
    const devB = b(dev), thrB = b(thr);
    const deviationFired = devB >= thrB;
    const answerFired = answer <= RH_USDE_ANSWER_THRESHOLD;
    row.measurements = {
      clone: RH_MODT_CLONE,
      feed: RH_USDE_FEED,
      getDeviation: devB.toString(),
      deviationThreshold: thrB.toString(),
      isChallenged: Boolean(challenged),
      isPrimary: Boolean(primary),
      usdeUsdAnswer: answer.toString(),
      usdeUsdAnswerThreshold: RH_USDE_ANSWER_THRESHOLD.toString(),
      deviationFired,
      answerFired,
      monitorOnly: true,
    };
    row.fired = deviationFired || Boolean(challenged) || !primary || answerFired;
    row.reason = row.fired
      ? `MODT deviation path open (monitor-only): deviation ${devB} vs threshold ${thrB}, challenged=${Boolean(challenged)}, primary=${Boolean(primary)}, answer ${answer}`
      : `dormant: deviation ${devB} < ${thrB}, not challenged, primary=${Boolean(primary)}, USDE/USD ${answer} > ${RH_USDE_ANSWER_THRESHOLD}`;
  } catch (_) {
    row.ok = false; row.error = "modt-read-failed"; row.reason = "sentinel read failed";
  }
  return row;
}

// Read a market's primary feed and decide the gap condition: age > 24 h OR round-over-round move > 10%.
// A valid stale latest round confirms age even when the previous round is unavailable.
async function readFeedGap(c, feed, nowSec) {
  const out = { ok: false, ageSec: null, movedPct: null, movedBps: null,
    latestValid: null, gapFired: false, error: null };
  if (!feed) { out.error = "no-feed"; return out; }
  if (!Number.isSafeInteger(nowSec) || nowSec <= 0) { out.error = "pin-time-invalid"; return out; }
  try {
    const raw = await c.call(feed, AGG_IF.encodeFunctionData("latestRoundData", []));
    const d = decode(AGG_IF, "latestRoundData", raw);
    if (!d) { out.error = "latest-round-unread"; return out; }
    const roundId = b(d[0]), answer = b(d[1]);
    const updatedAt = b(d[3]);
    if (answer <= 0n || roundId <= 0n || b(d[4]) !== roundId) {
      out.latestValid = false; out.error = "latest-round-invalid"; return out;
    }
    if (updatedAt <= 0n || updatedAt > BigInt(nowSec)) {
      out.latestValid = false; out.error = "latest-time-invalid"; return out;
    }
    out.latestValid = true;
    out.ageSec = nowSec - Number(updatedAt);
    const stale = out.ageSec > RH_FEED_STALE_SECONDS;
    if (stale) { out.gapFired = true; out.stale = true; }
    if (roundId <= 1n) { out.prevRoundUnread = true; out.error = "previous-round-unavailable"; return out; }
    let moved = false;
    const requested = roundId - 1n;
    const prevRaw = await c.call(feed, AGG_IF.encodeFunctionData("getRoundData", [requested]));
    const prev = decode(AGG_IF, "getRoundData", prevRaw);
    if (!prev) { out.prevRoundUnread = true; out.error = "previous-round-unreadable"; return out; }
    const prevId = b(prev[0]), previousAnswer = b(prev[1]), prevTime = b(prev[3]), answeredIn = b(prev[4]);
    if (prevId !== requested || previousAnswer <= 0n || prevTime <= 0n || prevTime >= updatedAt ||
        prevTime > BigInt(nowSec) || answeredIn < prevId || answeredIn >= roundId) {
      out.prevRoundUnread = true; out.error = "previous-round-invalid"; return out;
    }
    const diff = answer >= previousAnswer ? answer - previousAnswer : previousAnswer - answer;
    out.movedPct = Number(diff) / Number(previousAnswer) * 100;
    out.movedBps = ratioDecimal(diff * 10_000n, previousAnswer, 80);
    moved = diff * 10_000n > previousAnswer * BigInt(RH_FEED_MOVE_BPS);
    out.ok = true;
    out.gapFired = stale || moved;
    if (stale) out.stale = true;
    if (moved) out.moved = true;
    return out;
  } catch (_) {
    out.ok = false;
    out.prevRoundUnread = out.latestValid === true;
    out.error = out.prevRoundUnread ? "previous-round-unreadable" : "feed-read-failed";
    return out;
  }
}

function rhEquityEvidence(row, observedAt, chain = {}) {
  const pinned = Number.isSafeInteger(chain.block) && chain.block >= 0;
  const timeValid = Number.isSafeInteger(chain.timestamp) && chain.timestamp > 0;
  const gapsByError = {
    "latest-round-invalid": "LATEST_ROUND_INVALID", "latest-time-invalid": "LATEST_TIME_INVALID",
    "latest-round-unread": "LATEST_ROUND_UNREADABLE", "feed-read-failed": "FEED_READ_FAILED",
    "previous-round-unavailable": "PREVIOUS_ROUND_UNAVAILABLE", "previous-round-unreadable": "PREVIOUS_ROUND_UNAVAILABLE",
    "previous-round-invalid": "PREVIOUS_ROUND_UNAVAILABLE", "feed-unobservable": "FEED_UNOBSERVABLE",
    "market-unread": "MARKET_UNREADABLE", "equity-market-read-failed": "MARKET_UNREADABLE",
    "pin-time-invalid": "PIN_TIME_INVALID",
  };
  const markets = RH_EQUITY_MARKETS.map((spec) => {
    const rec = (row.markets || []).find((m) => m.marketId === spec.marketId);
    const gaps = ["SINGLE_PRIMARY", "NOMINAL_USDG_ASSUMPTION", "ECONOMICS_NOT_EVALUATED"];
    if (!pinned) gaps.push("UNPINNED_READS");
    if (!timeValid) gaps.push("PIN_TIME_INVALID");
    if (!rec || rec.borrowRaw === null) gaps.push("MARKET_UNREADABLE");
    if (gapsByError[rec?.error]) gaps.push(gapsByError[rec.error]);
    const debt = rec?.borrowRaw != null ? predicate(rec.debtAtOrAboveThreshold) : "UNKNOWN";
    const gap = rec?.gapFired === true ? "TRUE" : rec?.ok === true ? "FALSE" : "UNKNOWN";
    const checks = [check("DEBT_THRESHOLD", debt, rec?.borrowRaw ?? null, ">=", "10000000", "RAW")];
    if (debt !== "FALSE") checks.push(
      check("LATEST_ROUND_VALID", predicate(rec?.latestRoundValid), rec?.latestRoundValid == null ? null : rec.latestRoundValid ? "1" : "0", "=", "1", "BOOLEAN"),
      check("FEED_AGE", rec?.feedAgeSec == null ? "UNKNOWN" : predicate(rec.feedStale), rec?.feedAgeSec == null ? null : String(rec.feedAgeSec), ">", String(RH_FEED_STALE_SECONDS), "SECONDS"),
      check("ROUND_MOVE_BPS", rec?.roundMovedBps == null ? "UNKNOWN" : predicate(rec.feedMoved), rec?.roundMovedBps ?? null, ">", String(RH_FEED_MOVE_BPS), "BPS"),
    );
    return { chainId: 4663, marketId: spec.marketId, venue: RH_MORPHO, oracle: null, feed: spec.feed,
      pair: spec.pair, scope: "MARKET", predicate: debt === "FALSE" ? "FALSE" : debt === "TRUE" ? gap : "UNKNOWN",
      quality: rec?.borrowRaw != null ? "PARTIAL" : "UNAVAILABLE", gaps: [...new Set(gaps)],
      pin: { blockNumber: pinned ? chain.block : null, blockHash: HEX32.test(chain.hash || "") ? chain.hash : null,
        blockTimestamp: timeValid ? chain.timestamp : null, binding: pinned ? "BLOCK_NUMBER" : "UNPINNED", witness: "SINGLE_PRIMARY" },
      checks, amounts: [{ kind: "DEBT", raw: rec?.borrowRaw ?? null, decimals: 6, symbol: "USDG" }], reference: null };
  });
  return envelope("rh-equity-gap", observedAt, markets);
}

async function sentinelRhEquity(url, blockHex, deps = {}) {
  const row = { sentinel: "rh:rh-equity-gap-threshold", chainId: 4663, fired: false, ok: true, reason: "", markets: [] };
  const c = deps.caller || makeCaller(url, blockHex);
  const nowSec = deps.timestamp;
  if (!Number.isSafeInteger(nowSec) || nowSec <= 0) {
    row.ok = false; row.error = "block-timestamp-unreadable"; row.reason = "pinned block timestamp unreadable";
    return row;
  }
  let readAny = false, debtCount = 0, gapCount = 0, maxAge = null, feedsRead = 0;
  try {
    for (const m of RH_EQUITY_MARKETS) {
      const rec = {
        pair: m.pair, marketId: m.marketId, borrowRaw: null, borrowUsd: null, ok: true,
        feed: m.feed || null, feedAgeSec: null, roundMovedPct: null, gapFired: false, debtAtOrAboveThreshold: false,
      };
      try {
        const raw = await c.call(RH_MORPHO, MORPHO_IF.encodeFunctionData("market", [m.marketId]));
        const state = decode(MORPHO_IF, "market", raw);
        if (!state) { rec.ok = false; rec.error = "market-unread"; row.markets.push(rec); continue; }
        const borrow = b(state[2]);
        rec.borrowRaw = borrow.toString();
        rec.borrowUsd = (Number(borrow) / 1e6).toFixed(6); // USDG loan leg, 6 decimals, $1 peg
        rec.debtAtOrAboveThreshold = borrow >= 10_000_000n;
        readAny = true;
        if (rec.debtAtOrAboveThreshold) {
          debtCount++;
          const gap = await readFeedGap(c, m.feed, nowSec);
          rec.feedAgeSec = gap.ageSec;
          rec.roundMovedPct = gap.movedPct == null ? null : Number(gap.movedPct.toFixed(4));
          rec.roundMovedBps = gap.movedBps;
          rec.latestRoundValid = gap.latestValid;
          rec.gapFired = gap.gapFired;
          rec.feedStale = Boolean(gap.stale);
          rec.feedMoved = Boolean(gap.moved);
          // A debt-bearing market with no observable feed cannot justify a clean no-gap verdict.
          if (!m.feed) { rec.ok = false; rec.error = "feed-unobservable"; }
          else if (!gap.ok || gap.prevRoundUnread) { rec.ok = false; rec.error = gap.error || "previous-round-unreadable"; }
          if (gap.ok) feedsRead++;
          if (gap.ageSec != null) maxAge = maxAge == null ? gap.ageSec : Math.max(maxAge, gap.ageSec);
          if (gap.gapFired) gapCount++;
        }
      } catch (_) {
        rec.ok = false; rec.error = "equity-market-read-failed";
      }
      row.markets.push(rec);
    }
    const maxBorrow = row.markets.reduce((acc, r) => (r.borrowUsd == null ? acc : Math.max(acc, Number(r.borrowUsd))), 0);
    row.measurements = {
      thresholdUsd: RH_EQUITY_THRESHOLD_USD,
      staleSeconds: RH_FEED_STALE_SECONDS,
      pinTimestamp: nowSec,
      moveBps: RH_FEED_MOVE_BPS,
      marketsRead: readAny,
      maxBorrowUsd: maxBorrow.toFixed(6),
      marketsAtOrAboveThreshold: debtCount,
      feedsRead,
      maxFeedAgeSec: maxAge,
      marketsGapFired: gapCount,
      monitorOnly: true,
    };
    if (!readAny) {
      row.ok = false; row.error = "market-unread"; row.reason = "no equity-class market state readable";
      return row;
    }
    row.fired = gapCount > 0;
    if (row.markets.some((m) => !m.ok)) { row.ok = false; row.error = "equity-market-unreadable"; }
    row.reason = row.fired
      ? `equity gap: ${gapCount} market(s) with debt >= $${RH_EQUITY_THRESHOLD_USD} and (feed age > 24h or round move > 10%) (monitor-only; no auto-strike)`
      : row.ok ? `dormant: ${debtCount} market(s) >= $${RH_EQUITY_THRESHOLD_USD} but no feed gap (all readable feeds <= 24h old and round moves <= 10%)`
        : "not-fired: equity market/feed evaluation incomplete";
  } catch (_) {
    row.ok = false; row.error = "equity-sentinel-read-failed"; row.reason = "sentinel read failed";
  }
  return row;
}

// ---------------- run ----------------
function parseBlockTimestamp(blk) {
  const raw = blk && blk.timestamp;
  if (typeof raw !== "string" || !/^0x[0-9a-f]+$/i.test(raw)) return null;
  const value = Number(BigInt(raw));
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function batchBlock() {
  return {
    name: BATCH,
    chainIds: [...CHAIN_IDS],
    startedAt: BATCH_STARTED_AT,
    expiresAt: BATCH_EXPIRES_AT,
    profitDestination: PROFIT_DESTINATION,
    caps: {
      capitalEthPerAction: "0.01",
      gasCeilingEthPerTx: "0.05",
      // Capability flags come from batch-amendment-20260924.json; this read-only monitor never
      // signs, broadcasts, or uses flash loans.
      flashLoans: true,
      slippageCriticalLegs: false,
    },
  };
}

function historicalMonitoringWindowState(window, nowMs = Date.now()) {
  // Batch dates use canonical UTC timestamps. Missing/malformed metadata is not
  // an open-ended window, even when an independent read-only pass is permitted.
  const dates = [window?.startedAt, window?.expiresAt].map((value) => {
    const stamp = typeof value === "string" ? Date.parse(value) : NaN;
    return Number.isFinite(stamp) && new Date(stamp).toISOString() === value ? stamp : NaN;
  });
  const [start, end] = dates;
  if (!Number.isFinite(nowMs) || !dates.every(Number.isFinite) || end <= start) return "INVALID";
  return nowMs >= end ? "WINDOW_CLOSED" : nowMs < start ? "NOT_STARTED" : "OPEN";
}

function readHistory(historyPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(historyPath, "utf8"));
    if (parsed && parsed.schema === "exploit-rearm-canary-multichain-history/v1" && Array.isArray(parsed.runs)) {
      return parsed;
    }
  } catch (_) { /* first run */ }
  return { schema: "exploit-rearm-canary-multichain-history/v1", batchStartedAt: BATCH_STARTED_AT, runs: [] };
}

class MultichainScanStopped extends Error {
  constructor() { super("multichain-scan-stopped"); }
}

function assertMultichainHistoryPath(outPath) {
  const historyPath = path.join(path.dirname(outPath), "history-multichain.json");
  if (path.resolve(outPath) === path.resolve(historyPath)) throw new CanaryOutputOwnershipError();
  try {
    const stat = fs.lstatSync(historyPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new CanaryOutputOwnershipError();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return historyPath;
}

function readPreviousUpgradeState(outPath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(outPath, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return { bySentinel: {} }; // genuinely first run
    throw new Error("upgrade-state-unreadable"); // never replace an existing invalid baseline
  }
  const state = parsed && parsed.upgradeState;
  const bySentinel = state && state.sentinels;
  if (!parsed || parsed.schema !== "exploit-rearm-canary-multichain/v1" || !state || state.schemaVersion !== 1 ||
      !bySentinel || typeof bySentinel !== "object" || Array.isArray(bySentinel) ||
       Object.entries(bySentinel).some(([id, s]) => !s || !Number.isSafeInteger(s.pin) || s.pin < 0 ||
        !s.snapshots || typeof s.snapshots !== "object" || Array.isArray(s.snapshots) ||
         Object.values(s.snapshots).some((v) => v !== null && typeof v !== "string") ||
          (s.world !== undefined && (!s.world || !Number.isSafeInteger(s.world.cursor) || s.world.cursor < s.pin ||
            !HEX32.test(s.world.hash || "") || typeof s.world.hit !== "boolean")) ||
           (s.hertz !== undefined && !validHertzCheckpoint(s,
             UPGRADE_SENTINELS.find((spec) => spec.id === "upgrade:56:hertzflow"))) ||
           (s.arc !== undefined && !validArcCheckpoint(s,
             UPGRADE_SENTINELS.find((spec) => spec.id === "upgrade:5042:arc-cirbtc"))) ||
            (s.rh !== undefined && (!RH_UPGRADE_IDS.includes(id) || !validRhCheckpoint(s,
              UPGRADE_SENTINELS.find((spec) => spec.id === id)))) ||
            (s.logScan !== undefined && !validLogCheckpoint(s, UPGRADE_SENTINELS.find((spec) => spec.id === id))))) {
    throw new Error("upgrade-state-invalid");
  }
  return { bySentinel };
}

function aggregateVerdict(chains, sentinels) {
  if (sentinels.some((s) => s.fired)) return "FIRED";
  const unsafeSnapshot = Object.entries(chains).some(([id, c]) => c.qualified &&
    (!Number.isSafeInteger(c.block) || !/^0x[0-9a-f]{64}$/i.test(c.hash || "") ||
      !sentinels.some((s) => Number(s.chainId) === Number(id))));
  return sentinels.some((s) => s.ok === false) || unsafeSnapshot ? "INCOMPLETE" : "DORMANT";
}

async function evaluateStrikeGroup(cid, specs, url, blockHex, explicitGateway = false, evaluate = evaluateStrike) {
  if (explicitGateway && cid === 4663) return specs.map((spec) => ({
    sentinel: spec.spec, chainId: cid, fired: false, ok: false,
    reason: "explicit-gateway-strike-unsupported", error: "explicit-gateway-strike-unsupported",
    measurements: { pair: spec.pair || null, marketId: spec.marketId },
  }));
  if (!url) return specs.map((spec) => ({
    sentinel: spec.spec, chainId: cid, fired: false, ok: false,
    reason: "endpoint-unavailable", error: "endpoint-unavailable",
    measurements: { pair: spec.pair || null, marketId: spec.marketId },
  }));
  return poolMap(specs, 3, (spec) => evaluate(url, blockHex, spec));
}

function retainedUpgradeState(prev, res) {
  // Do not advance the pin or replace good comparison values on a partial scan, even if it fired.
  if (res.logScan) return res.row.ok ? { pin: res.pin, snapshots: res.snapshot,
    logScan: { cursor: res.pin, hash: res.logScan.hash, pinHash: res.logScan.hash, hit: false,
      specFingerprint: res.logScan.specFingerprint } } : prev ? { ...prev, logScan: res.logScan } : prev;
  if (res.rh) return res.row.ok ? { pin: res.pin, snapshots: res.snapshot,
    rh: { cursor: res.pin, hash: res.rh.hash, pinHash: res.rh.hash, hit: false,
      specFingerprint: res.rh.specFingerprint } } : { ...prev, rh: res.rh };
  if (res.arc) return res.row.ok ? { pin: res.pin, snapshots: res.snapshot,
    arc: { cursor: res.pin, hash: res.arc.hash, pinHash: res.arc.hash, hit: false,
      specFingerprint: res.arc.specFingerprint } } : { ...prev, arc: res.arc };
  if (res.hertz) return res.row.ok ? { pin: res.pin, snapshots: res.snapshot,
    hertz: { cursor: res.pin, hash: res.hertz.hash, pinHash: res.hertz.hash, hit: false,
      specFingerprint: res.hertz.specFingerprint } } : { ...prev, hertz: res.hertz };
  if (res.row.ok) return res.world ? { pin: res.pin, snapshots: res.snapshot,
    world: { cursor: res.pin, hash: res.world.hash, hit: false,
      specFingerprint: res.world.specFingerprint } } : { pin: res.pin, snapshots: res.snapshot };
  return res.world && prev ? { ...prev, world: res.world } : prev;
}

function unavailableUpgradeRow(spec, prev) {
  const heldHit = (spec.chainId === 480 && validWorldCheckpoint(prev, spec) && prev.world.hit === true) ||
    (spec.id === "upgrade:56:hertzflow" && validHertzCheckpoint(prev, spec) && prev.hertz.hit === true) ||
    (spec.id === "upgrade:5042:arc-cirbtc" && validArcCheckpoint(prev, spec) && prev.arc.hit === true) ||
    (RH_UPGRADE_IDS.includes(spec.id) && validRhCheckpoint(prev, spec) && prev.rh.hit === true) ||
    (validLogCheckpoint(prev, spec) && prev.logScan.hit === true);
  return {
    sentinel: spec.id, chainId: spec.chainId, type: "upgrade/config", fired: heldHit, ok: false,
    reason: heldHit ? spec.chainId === 480 ? "previous World upgrade log hit; endpoint unavailable"
      : spec.chainId === 56 ? "previous HertzFlow upgrade log hit; endpoint unavailable"
        : spec.chainId === 5042 ? "previous Arc upgrade log hit; endpoint unavailable"
          : RH_UPGRADE_IDS.includes(spec.id) ? "previous Robinhood upgrade log hit; endpoint unavailable"
            : "previous upgrade log hit; endpoint unavailable" : "endpoint-unavailable",
    error: "endpoint-unavailable",
    measurements: { type: "upgrade/config", label: spec.label,
      eip1967Addrs: (spec.eip1967 || []).length, probes: (spec.probes || []).length },
  };
}

async function runOnce(outPath, options = {}, owner, stopRequested = () => false, deps = {}) {
  assertCanaryOutputOwner(owner, outPath);
  const historyPath = assertMultichainHistoryPath(outPath);
  let ownershipLoss = null;
  const heartbeat = setInterval(() => {
    if (ownershipLoss) return;
    try { owner.check(); } catch (_) { ownershipLoss = new CanaryOutputOwnershipError(); }
  }, 15_000);
  heartbeat.unref();
  const scanCheck = () => {
    if (ownershipLoss) throw ownershipLoss;
    assertCanaryOutputOwner(owner, outPath);
    assertMultichainHistoryPath(outPath);
    if (stopRequested()) throw new MultichainScanStopped();
  };
  try {
  const prevUpgrade = readPreviousUpgradeState(outPath);
  const explicitUrl = options.rhUserGatewayEnv === true ? rhUserGatewayUrl(process.env.RH_PUBLIC_ARCHIVE_RPC_URL) : null;
  const explicitRpc = explicitUrl ? makeRhUserGatewayRpc(explicitUrl) : null;
  if (options.rhUserGatewayEnv === true && (!options.rhArchiveInventory || !explicitRpc))
    throw Error("rh-user-gateway-invalid");
  const rhReadRpc = explicitRpc ? (url, method, params, ms) =>
    url === explicitUrl ? explicitRpc(url, method, params, ms) : rpcCall(url, method, params, ms) : rpcCall;
  const strikeSpecs = (deps.loadStrikeSentinels || loadStrikeSentinels)();
  const nowIso = new Date(deps.now ? deps.now() : Date.now()).toISOString();
  const runId = nowIso.replace(/[:.]/g, "-");

  const chains = {};
  const rpc = {};
  let worldWitness = null, hertzWitness = null, hertzDeadline = null, arcWitness = null, arcDeadline = null;
  let rhWitness = null;
  for (const cid of CHAIN_IDS) {
    if (deps.qualifyChain) {
      const { chain, url } = await deps.qualifyChain(cid, prevUpgrade.bySentinel);
      scanCheck();
      chains[String(cid)] = chain;
      if (url) rpc[cid] = url;
      continue;
    }
    if (cid === 4663) {
      const rh = await qualifyRhRpc(prevUpgrade.bySentinel,
        { archivePath: options.rhArchiveInventory || null, userGatewayEnv: options.rhUserGatewayEnv === true,
          ...(explicitRpc ? { rpc: rhReadRpc } : {}) });
      scanCheck();
      if (!rh) { chains["4663"] = { qualified: false, reason: "rh-capability-unavailable" }; continue; }
      rpc[4663] = rh.url;
      chains["4663"] = { qualified: true, block: rh.block, hash: rh.hash, timestamp: rh.timestamp,
        logWitness: rh.witnessUrl ? "header-only" : "single-primary" };
      rhWitness = rh.witnessUrl;
      continue;
    }
    if (cid === 5042) {
      const arc = await qualifyArcRpc(prevUpgrade.bySentinel["upgrade:5042:arc-cirbtc"] || null);
      scanCheck();
      if (!arc) { chains["5042"] = { qualified: false, reason: "arc-capability-unavailable" }; continue; }
      rpc[5042] = arc.url;
      chains["5042"] = { qualified: true, block: arc.block, hash: arc.hash, timestamp: arc.timestamp,
        logWitness: arc.witnessUrl ? "header-only" : "single-primary" };
      arcWitness = arc.witnessUrl;
      arcDeadline = arc.deadline;
      continue;
    }
    if (cid === 56) {
      const hertz = await qualifyHertzRpc(prevUpgrade.bySentinel["upgrade:56:hertzflow"] || null);
      scanCheck();
      if (!hertz) { chains["56"] = { qualified: false, reason: "hertz-capability-unavailable" }; continue; }
      rpc[56] = hertz.url;
      chains["56"] = { qualified: true, block: hertz.block, hash: hertz.hash, timestamp: hertz.timestamp };
      // Only the primary reads bulk logs. A witness, when present, checks headers only.
      chains["56"].logWitness = hertz.witnessUrl ? "header-only" : "single-primary";
      hertzWitness = hertz.witnessUrl;
      hertzDeadline = hertz.deadline;
      continue;
    }
    if (cid === 31612) {
      const mezo = await qualifyMezoRpc();
      scanCheck();
      if (!mezo) { chains["31612"] = { qualified: false, reason: "mezo-quorum-unavailable" }; continue; }
      rpc[31612] = mezo.url;
      chains["31612"] = { qualified: true, block: mezo.block, hash: mezo.hash, timestamp: mezo.timestamp };
      continue;
    }
    if (cid === 480) {
      const world = await qualifyWorldRpc(prevUpgrade.bySentinel["upgrade:480:world-openxaut"] || null);
      scanCheck();
      if (!world) { chains["480"] = { qualified: false, reason: "world-capability-unavailable" }; continue; }
      rpc[480] = world.url;
      worldWitness = world.witnessUrl;
      chains["480"] = { qualified: true, block: world.block, hash: world.hash, timestamp: world.timestamp };
      continue;
    }
    let url = null;
    try { url = await resolveRpc(cid, null, { capability: "read", timeoutMs: 12000 }); } catch (_) { url = null; }
    scanCheck();
    if (!url) { chains[String(cid)] = { qualified: false, reason: "endpoint-unavailable" }; continue; }
    rpc[cid] = url;
    let bn = null;
    for (let attempt = 0; attempt < 3 && !bn; attempt++) {
      bn = await rpcCall(url, "eth_blockNumber", [], 15000);
      scanCheck();
      if (!bn) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      scanCheck();
    }
    if (!bn) { chains[String(cid)] = { qualified: false, reason: "block-number-failed" }; delete rpc[cid]; continue; }
    const blockHex = "0x" + BigInt(bn).toString(16);
    const blk = await rpcCall(url, "eth_getBlockByNumber", [blockHex, false], 15000);
    scanCheck();
    chains[String(cid)] = { qualified: true, block: Number(BigInt(bn)), hash: blk ? blk.hash : null, timestamp: parseBlockTimestamp(blk) };
  }

  const byChain = new Map();
  for (const spec of strikeSpecs) {
    if (!byChain.has(spec.chainId)) byChain.set(spec.chainId, []);
    byChain.get(spec.chainId).push(spec);
  }
  const strikeRows = [];
  for (const [cid, specs] of byChain) {
    const url = rpc[cid], blockHex = chains[String(cid)].qualified ? "0x" + chains[String(cid)].block.toString(16) : null;
    strikeRows.push(...await (deps.evaluateStrikeGroup || evaluateStrikeGroup)(cid, specs, url, blockHex, options.rhUserGatewayEnv === true));
    scanCheck();
  }

  const executions = (deps.loadExecutions || loadExecutions)();
  const executedSentinels = [];
  if (executions) {
    const target = `strike:8453:${executions.marketId.slice(2, 10)}`;
    for (const r of strikeRows) {
      if (r.sentinel === target) {
        r.executed = true;
        r.executedAt = executions.completedAt || null;
        if (r.measurements && typeof r.measurements === "object") r.measurements.executed = true;
        executedSentinels.push(target);
      }
    }
  }

  const rhRows = [];
  if (rpc[4663]) {
    const blockHex = "0x" + chains["4663"].block.toString(16);
    const rhCaller = explicitRpc ? { call: (to, data) => rhReadRpc(rpc[4663], "eth_call", [{ to, data }, blockHex]) } : null;
    rhRows.push(await (deps.sentinelUsdeModt || sentinelUsdeModt)(rpc[4663], blockHex, rhCaller ? { caller: rhCaller } : {}));
    scanCheck();
    rhRows.push(await (deps.sentinelRhEquity || sentinelRhEquity)(rpc[4663], blockHex, { timestamp: chains["4663"].timestamp,
      ...(rhCaller ? { caller: rhCaller } : {}) }));
    scanCheck();
  } else {
    for (const id of ["rh:usde-usdg-modt-deviation", "rh:rh-equity-gap-threshold"]) {
      rhRows.push({ sentinel: id, chainId: 4663, fired: false, ok: false, reason: "endpoint-unavailable", error: "endpoint-unavailable", measurements: {} });
    }
  }
  const equityRow = rhRows.find((row) => row.sentinel === "rh:rh-equity-gap-threshold");
  const monitorEvidence = rhEquityEvidence(equityRow, nowIso, chains["4663"]);
  equityRow.monitorEvidence = monitorEvidence;

  const upgradeRows = [];
  const upgradeSentinels = { ...prevUpgrade.bySentinel };
  let rhUpgradeScan = null; // start only at handoff to the first qualified Robinhood upgrade row
  for (const spec of UPGRADE_SENTINELS) {
    const url = rpc[spec.chainId];
    const chain = chains[String(spec.chainId)];
    if (!url || !chain || !chain.qualified) {
      const missing = unavailableUpgradeRow(spec, prevUpgrade.bySentinel[spec.id]);
      if (spec.chainId === 31612) missing.reason = missing.error = "mezo-quorum-unavailable";
      upgradeRows.push(missing);
      continue;
    }
    const blockHex = "0x" + chain.block.toString(16);
    const prev = prevUpgrade.bySentinel[spec.id] || null;
    if (RH_UPGRADE_IDS.includes(spec.id) && !rhUpgradeScan) rhUpgradeScan = startRhUpgradeScan();
    const res = await (deps.evaluateUpgradeConfig || evaluateUpgradeConfig)(url, blockHex, chain.block, spec, prev,
      spec.chainId === 480 ? { headHash: chain.hash, witnessUrl: worldWitness } :
        spec.id === "upgrade:56:hertzflow" ? { headHash: chain.hash, witnessUrl: hertzWitness, deadline: hertzDeadline } :
          spec.id === "upgrade:5042:arc-cirbtc" ? { headHash: chain.hash, witnessUrl: arcWitness, deadline: arcDeadline } :
          RH_UPGRADE_IDS.includes(spec.id) ? { headHash: chain.hash, witnessUrl: rhWitness,
            deadline: rhUpgradeScan.deadline, chunkBudget: rhUpgradeScan.chunkBudget,
              ...(explicitRpc ? { rpc: rhReadRpc } : {}) } : { headHash: chain.hash });
    scanCheck();
    upgradeRows.push(res.row);
    const state = retainedUpgradeState(prev, res);
    if (state) upgradeSentinels[spec.id] = state;
  }

  const sentinels = [...strikeRows, ...rhRows, ...upgradeRows];
  const fired = sentinels.filter((s) => s.fired);
  scanCheck();
  const history = readHistory(historyPath);
  const priorFire = history.lastFire || [...history.runs].reverse().find((r) => r && r.verdict === "FIRED");
  const fireRecord = fired.length ? { runId, at: nowIso, fired: fired.map((s) => s.sentinel) } : priorFire;
  const lastFire = fireRecord && typeof fireRecord.runId === "string" && typeof fireRecord.at === "string" &&
    Array.isArray(fireRecord.fired) ? { runId: fireRecord.runId.slice(0, 100), at: fireRecord.at.slice(0, 40),
      fired: fireRecord.fired.filter((id) => typeof id === "string").slice(0, LAST_FIRE_MAX_SENTINELS)
        .map((id) => id.slice(0, 128)) } : null;
  const out = {
    schema: "exploit-rearm-canary-multichain/v1",
    batch: batchBlock(),
    runId, generatedAt: nowIso,
    observationMode: options.observationOnly === true ? "READ_ONLY_ONCE" : null,
    historicalMonitoringWindowState: historicalMonitoringWindowState(batchBlock(), Date.parse(nowIso)),
    chains,
    noSigning: true, noBroadcast: true,
    sentinels,
    upgradeState: { schemaVersion: 1, sentinels: upgradeSentinels },
    executedSentinels,
    firedCount: fired.length,
    firedSentinels: fired.map((s) => s.sentinel),
    lastFire, // bounded, latched observation; verdict remains this poll's result
    verdict: aggregateVerdict(chains, sentinels),
  };
  scanCheck();
  fs.writeFileSync(outPath, JSON.stringify(out, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");

  const pinBlocks = {};
  for (const cid of CHAIN_IDS) pinBlocks[String(cid)] = chains[String(cid)] && chains[String(cid)].block != null ? chains[String(cid)].block : null;
  history.batchStartedAt = history.batchStartedAt || BATCH_STARTED_AT;
  history.generatedAt = nowIso;
  history.lastFire = lastFire;
  history.runs = [
    ...history.runs.filter((r) => r && r.runId !== runId),
    { runId, at: nowIso, verdict: out.verdict, fired: out.firedSentinels, chains: pinBlocks, firedCount: out.firedCount,
      upgradePins: Object.fromEntries(Object.entries(upgradeSentinels).map(([id, s]) => [id, s.pin])), monitorEvidence },
  ].slice(-HISTORY_MAX_RUNS);
  scanCheck();
  fs.writeFileSync(historyPath, JSON.stringify(history, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
  return out;
  } finally { clearInterval(heartbeat); }
}

async function main(args = process.argv.slice(2), deps = {}) {
  const values = new Map();
  const switches = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (["--once", "--observation-only", "--rh-user-gateway-env", "--keep-watching-on-fire", "--no-deadline", "--supervised-readonly"].includes(flag)) {
      if (switches.has(flag)) throw Error("duplicate-flag");
      switches.add(flag);
    } else if (["--out", "--loop", "--max-hours", "--rh-archive-inventory"].includes(flag)) {
      if (values.has(flag) || !args[i + 1] || args[i + 1].startsWith("--")) throw Error("invalid-flag-value");
      values.set(flag, args[++i]);
    } else throw Error("unknown-flag");
  }
  const observationOnly = switches.has("--observation-only");
  if (observationOnly && (!switches.has("--once") ||
      [...switches].some((flag) => !["--once", "--observation-only"].includes(flag)) ||
      [...values.keys()].some((flag) => flag !== "--out"))) throw Error("observation-only-requires-strict-once");
  if (switches.has("--once") && values.has("--loop")) throw Error("once-and-loop-conflict");
  if (switches.has("--supervised-readonly") && !values.has("--loop")) throw Error("supervised-readonly-requires-loop");
  if (switches.has("--keep-watching-on-fire") && !values.has("--loop")) throw Error("keep-watching-requires-loop");
  if (switches.has("--no-deadline") && (!values.has("--loop") || !switches.has("--keep-watching-on-fire") ||
      values.has("--max-hours"))) throw Error("no-deadline-requires-unbounded-keep-watching-loop");
  if (values.has("--max-hours") && !values.has("--loop")) throw Error("max-hours-requires-loop");
  const positiveDecimal = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
  if (["--loop", "--max-hours"].some((flag) => values.has(flag) &&
      (!positiveDecimal.test(values.get(flag)) || !Number.isFinite(Number(values.get(flag))) ||
        Number(values.get(flag)) <= 0))) throw Error("invalid-loop-duration");
  const rhArchiveInventory = rhArchiveInventoryPath(values.get("--rh-archive-inventory") || null);
  const rhUserGatewayEnv = switches.has("--rh-user-gateway-env");
  if (rhUserGatewayEnv && !rhArchiveInventory) throw Error("rh-user-gateway-argument-invalid");
  if (rhUserGatewayEnv && !rhUserGatewayUrl(process.env.RH_PUBLIC_ARCHIVE_RPC_URL))
    throw Error("rh-user-gateway-invalid");
  const outPath = values.has("--out") ? path.resolve(values.get("--out")) : DEFAULT_OUT;
  const interval = values.has("--loop") ? Math.max(60, Number(values.get("--loop"))) : null;
  const keepWatching = switches.has("--keep-watching-on-fire");
  const now = deps.now || Date.now;
  const deadline = observationOnly || switches.has("--no-deadline") ? null : batchDeadline(now(), BATCH_EXPIRES_AT,
    values.has("--max-hours") ? Number(values.get("--max-hours")) : undefined);
  if (path.resolve(outPath) === path.join(path.dirname(outPath), "history-multichain.json"))
    throw new CanaryOutputOwnershipError();
  const owner = acquireCanaryOutputOwner(outPath); // before any status/history or RPC reads
  let stopping = false;
  let wake = null;
  const stop = () => { stopping = true; if (wake) wake(); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const disposeReadOnlyStop = installCanaryReadOnlyStop(stop, process, switches.has("--supervised-readonly"));
  try {
    let code = 0;
    for (;;) {
      owner.check();
      if (stopping || (deadline !== null && now() >= deadline)) return code;
      try {
        const last = await (deps.runOnce || runOnce)(outPath, { rhArchiveInventory, rhUserGatewayEnv, observationOnly }, owner, () => stopping, deps);
        console.log(JSON.stringify({
          runId: last.runId,
          verdict: last.verdict,
          firedCount: last.firedCount,
          fired: last.firedSentinels,
          chains: Object.fromEntries(Object.entries(last.chains).map(([k, v]) => [k, v.qualified ? v.block : v.reason])),
          sentinels: last.sentinels.map((s) => ({ sentinel: s.sentinel, fired: s.fired, ok: s.ok, reason: s.reason })),
        }));
        if (last.verdict === "FIRED") {
          if (!keepWatching) return 3;
          code = 3;
        } else if (code !== 3) code = last.verdict === "INCOMPLETE" ? 1 : 0;
      } catch (error) {
        if (error instanceof MultichainScanStopped) return code;
        if (error instanceof CanaryOutputOwnershipError) throw error;
        console.error("RUN-ERROR monitor-run-failed");
        if (code !== 3) code = 1;
      }
      if (stopping || interval === null || (deadline !== null && now() > deadline)) return code;
      const end = now() + interval * 1000;
      while (!stopping && now() < end) {
        owner.check();
        if (deps.sleep) {
          await deps.sleep(Math.min(15_000, end - now()), stop);
          continue;
        }
        await new Promise((resolve) => {
          const timer = setTimeout(() => { wake = null; resolve(); }, Math.min(15_000, end - now()));
          wake = () => { clearTimeout(timer); wake = null; resolve(); };
          if (stopping) wake();
        });
      }
    }
  } finally {
    disposeReadOnlyStop();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    if (!owner.release()) throw new CanaryOutputOwnershipError();
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((_) => {
    console.error("FAIL monitor-main-failed"); process.exitCode = 1;
  });
}

module.exports = { loadStrikeSentinels, isUsdStable, RH_EQUITY_MARKETS, batchBlock, historicalMonitoringWindowState, UPGRADE_SENTINELS, evalProbeRule, encodeDecoded, probeKey, aggregateVerdict, evaluateStrikeGroup, retainedUpgradeState, readPreviousUpgradeState, evaluateUpgradeConfig, evaluateStrike, sentinelUsdeModt, sentinelRhEquity, rhEquityEvidence, readFeedGap, parseBlockTimestamp, scanWorldUpgradeLogs, qualifyWorldRpc, qualifyMezoRpc, qualifyHertzRpc, qualifyArcRpc, qualifyRhRpc, rhArchiveInventoryPath, parseRhArchiveInventory, readBoundedRhInventory, publicRhIp, makeRhUserGatewayRpc, startRhUpgradeScan, validHertzCheckpoint, validArcCheckpoint, validRhCheckpoint, hertzSpecFingerprint, arcSpecFingerprint, rhSpecFingerprint, unavailableUpgradeRow, worldSpecFingerprint, runOnce, main };
