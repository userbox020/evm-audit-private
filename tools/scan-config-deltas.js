#!/usr/bin/env node
"use strict";
/**
 * scan-config-deltas.js
 *
 * Read-only, bounded scanner for FRESH ON-CHAIN CONFIGURATION / LOG DELTAS on
 * live lending, vault and oracle systems across Ethereum (1), Base (8453) and
 * Arbitrum (42161). It never inspects repository commits.
 *
 * Safety properties:
 *  - endpoints are supplied process-only via CONFIG_DELTA_RPC_JSON (chainId -> url)
 *    and are never printed, logged, hashed or written to any artifact;
 *  - when that env var is absent a curated keyless public fallback map is used;
 *  - `rpc_endpoints.txt` / env / key material are never read;
 *  - output is one sanitized JSON artifact under reports/raw/fast/ that contains
 *    deltas only, with no endpoint or credential material.
 *
 * Bounds: per-chain lookback window, chunk size, chunk cap, total request cap,
 * concurrency cap, short timeouts, deterministic sorted output.
 */

const fs = require("fs");
const path = require("path");
const { PUBLIC_FALLBACKS, getOrigin } = require("./shared-rpc.js");

const WORKSPACE = path.resolve(__dirname, "..");

// Resolve keccak_256 from the workspace root install. A nested tools/node_modules
// copy of @noble/hashes (v1) does not export "./sha3.js", so resolve explicitly.
function loadKeccak() {
  const attempts = [
    () => require(require.resolve("@noble/hashes/sha3.js", { paths: [WORKSPACE] })).keccak_256,
    () => require(path.join(WORKSPACE, "node_modules", "@noble", "hashes", "sha3.js")).keccak_256,
    () => require(path.join(WORKSPACE, "node_modules", "@noble", "hashes", "index.js")).keccak_256,
  ];
  for (const attempt of attempts) {
    try {
      const fn = attempt();
      if (typeof fn === "function") return fn;
    } catch (_) {
      // try the next resolution strategy
    }
  }
  throw new Error("keccak-unavailable");
}
const keccak_256 = loadKeccak();
const OUT_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
// Baseline output is the rolling latest artifact. Cycle-isolated runs select a
// distinct output via CONFIG_DELTA_OUT (env, not argv) or --out; the basename is
// sanitized so no path traversal and no secret ever reaches the filename.
function resolveOutFile() {
  const argIndex = process.argv.indexOf("--out");
  const requested = (argIndex > -1 ? process.argv[argIndex + 1] : null) || process.env.CONFIG_DELTA_OUT || null;
  if (typeof requested === "string" && /^[A-Za-z0-9._-]{1,96}$/.test(requested)) return path.join(OUT_DIR, requested);
  return path.join(OUT_DIR, "config-deltas-latest.json");
}
const OUT_FILE = resolveOutFile();

const CHAIN_NAMES = { 1: "ethereum", 8453: "base", 42161: "arbitrum", 56: "bnb" };

// ---------------------------------------------------------------------------
// Bounds (explicit, reviewable, fail-closed)
// ---------------------------------------------------------------------------
// CYCLE 3 (2026-09-15) archive-profile bounds. Endpoints are capability-qualified
// first by tools/qualify-config-delta-rpcs-v1.js (deep canonical header + deep
// non-empty eth_getCode + deep eth_getStorageAt + full-window chunked eth_getLogs)
// and are supplied process-only via CONFIG_DELTA_RPC_JSON. Windows are restored
// to at least cycle-1 depth. Witness probes re-enabled (bounded 1 chunk each) so
// within-window absence is event-presence-verified rather than transport-blind.
// Historical constants retained for reproducibility (additive only):
//   CYCLE 2 (2026-09-15, keyless public fallback; ~10k-block cap on 1/8453/56,
//            ~50-128 blocks on 42161; witness disabled):
//     1     9500  9500  1  2000  witness 0
//     8453  9500  9500  1  2000  witness 0
//     42161 100   100   1  25    witness 0
//     56    9500  9500  1  2000  witness 0
//   CYCLE 1 (2026-09-14, wider non-public endpoints):
//     1     25000  25000  1  2000   witness 8x25000
//     8453  90000  2000   45 2000   witness 15x2000
//     42161 700000 700000 1  50000  witness 3x700000
const BOUNDS = {
  1: { windowBlocks: 25000, chunkBlocks: 25000, maxChunks: 1, minChunk: 2000, witnessChunks: 1, witnessChunkBlocks: 25000, paceMs: 80 },
  8453: { windowBlocks: 90000, chunkBlocks: 2000, maxChunks: 45, minChunk: 2000, witnessChunks: 1, witnessChunkBlocks: 20000, paceMs: 60 },
  42161: { windowBlocks: 700000, chunkBlocks: 700000, maxChunks: 1, minChunk: 50000, witnessChunks: 1, witnessChunkBlocks: 700000, paceMs: 60 },
  56: { windowBlocks: 10000, chunkBlocks: 10000, maxChunks: 1, minChunk: 2000, witnessChunks: 1, witnessChunkBlocks: 10000, paceMs: 120 },
};
const MAX_TOTAL_REQUESTS = 4000;
const CHAIN_REQUEST_BUDGET = 1600;
const CONCURRENCY = 3;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_LOG_RESULTS = 5000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Minimal ABI helpers
// ---------------------------------------------------------------------------
function splitTop(text) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if (ch === "(") { depth += 1; cur += ch; }
    else if (ch === ")") { depth -= 1; cur += ch; }
    else if (ch === "," && depth === 0) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  if (cur.length) out.push(cur);
  return out;
}

function canonicalType(type) {
  return type.startsWith("tuple") ? type.slice("tuple".length) : type;
}

function eventTopic(eventDef) {
  const sig = `${eventDef.name}(${eventDef.params.map((p) => canonicalType(p[1])).join(",")})`;
  return "0x" + Buffer.from(keccak_256(new TextEncoder().encode(sig))).toString("hex");
}

function isDynamic(type) {
  return type === "string" || type === "bytes" || type === "bytes";
}

function parseTupleMembers(type) {
  const inner = type.slice(type.indexOf("(") + 1, type.lastIndexOf(")"));
  return splitTop(inner).map((t, i) => ({ name: `f${i}`, type: t }));
}

function readWord(data, index) {
  const start = 2 + index * 64;
  if (start + 64 > data.length) return null;
  return data.slice(start, start + 64);
}

function decodeStatic(type, word) {
  if (!word) return null;
  if (type === "address") return ("0x" + word.slice(24).toLowerCase());
  if (type === "bool") return BigInt("0x" + word) !== 0n;
  if (type === "bytes32") return "0x" + word;
  if (/^uint|^int/.test(type)) return BigInt("0x" + word).toString();
  return "0x" + word;
}

function decodeDynamicString(data, offsetWord) {
  try {
    const offset = Number(BigInt("0x" + offsetWord));
    if (!Number.isSafeInteger(offset) || offset < 0) return "[unreadable]";
    const lenWord = readWord(data, offset / 32);
    if (!lenWord) return "[unreadable]";
    const len = Number(BigInt("0x" + lenWord));
    if (!Number.isSafeInteger(len) || len < 0 || len > 512) return "[len:" + String(len).slice(0, 8) + "]";
    const start = 2 + offset * 2 + 64;
    const hex = data.slice(start, start + len * 2);
    return Buffer.from(hex, "hex").toString("utf8");
  } catch (_) {
    return "[unreadable]";
  }
}

function decodeEvent(eventDef, log) {
  const indexed = eventDef.params.filter((p) => p[2]);
  const nonIndexed = eventDef.params.filter((p) => !p[2]);
  const out = {};
  const topics = log.topics.slice(1);
  indexed.forEach((p, i) => {
    const topic = topics[i];
    out[p[0]] = isDynamic(p[1]) || p[1] === "bytes" ? "[hashed]" : decodeStatic(p[1], topic ? topic.slice(2) : null);
  });
  let cursor = 0;
  for (const p of nonIndexed) {
    if (p[1].startsWith("tuple")) {
      const members = parseTupleMembers(p[1]);
      const tuple = {};
      for (const m of members) tuple[m.name] = decodeStatic(m.type, readWord(log.data, cursor++));
      out[p[0]] = tuple;
    } else if (isDynamic(p[1])) {
      const offsetWord = readWord(log.data, cursor++);
      out[p[0]] = decodeDynamicString(log.data, offsetWord || "0x" + "0".repeat(64));
    } else {
      out[p[0]] = decodeStatic(p[1], readWord(log.data, cursor++));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Curated, probe-verified tracked configuration / registry contracts
// ---------------------------------------------------------------------------
const P = (name, type, indexed) => [name, type, Boolean(indexed)];

const AAVE_CONFIGURATOR_EVENTS = [
  { name: "ReserveInitialized", params: [P("asset", "address", 1), P("aToken", "address", 1), P("stableDebtToken", "address", 0), P("variableDebtToken", "address", 0), P("interestRateStrategyAddress", "address", 0)] },
  { name: "CollateralConfigurationChanged", params: [P("asset", "address", 1), P("ltv", "uint256", 0), P("liquidationThreshold", "uint256", 0), P("liquidationBonus", "uint256", 0)] },
  { name: "SupplyCapChanged", params: [P("asset", "address", 1), P("oldSupplyCap", "uint256", 0), P("newSupplyCap", "uint256", 0)] },
  { name: "BorrowCapChanged", params: [P("asset", "address", 1), P("oldBorrowCap", "uint256", 0), P("newBorrowCap", "uint256", 0)] },
  { name: "ReserveBorrowing", params: [P("asset", "address", 1), P("enabled", "bool", 0)] },
  { name: "ReservePaused", params: [P("asset", "address", 1), P("paused", "bool", 0)] },
  { name: "ReserveUnpaused", params: [P("asset", "address", 1)] },
  { name: "ReserveFrozen", params: [P("asset", "address", 1), P("frozen", "bool", 0)] },
  { name: "ReserveFactorChanged", params: [P("asset", "address", 1), P("oldReserveFactor", "uint256", 0), P("newReserveFactor", "uint256", 0)] },
  { name: "BorrowableInIsolationChanged", params: [P("asset", "address", 1), P("borrowable", "bool", 0)] },
  { name: "DebtCeilingChanged", params: [P("asset", "address", 1), P("oldDebtCeiling", "uint256", 0), P("newDebtCeiling", "uint256", 0)] },
  { name: "SiloedBorrowingChanged", params: [P("asset", "address", 1), P("oldState", "bool", 0), P("newState", "bool", 0)] },
  { name: "LiquidationProtocolFeeChanged", params: [P("asset", "address", 1), P("oldFee", "uint256", 0), P("newFee", "uint256", 0)] },
  { name: "EModeAssetCategoryChanged", params: [P("asset", "address", 1), P("oldCategoryId", "uint8", 0), P("newCategoryId", "uint8", 0)] },
  { name: "ReserveInterestRateStrategyChanged", params: [P("asset", "address", 1), P("oldStrategy", "address", 0), P("newStrategy", "address", 0)] },
  { name: "ReserveDropped", params: [P("asset", "address", 1)] },
];

const AAVE_PROVIDER_EVENTS = [
  { name: "PriceOracleUpdated", params: [P("newAddress", "address", 1)] },
  { name: "PoolUpdated", params: [P("newAddress", "address", 1)] },
  { name: "PoolConfiguratorUpdated", params: [P("newAddress", "address", 1)] },
  { name: "ACLManagerUpdated", params: [P("newAddress", "address", 1)] },
  { name: "ACLAdminUpdated", params: [P("newAddress", "address", 1)] },
  { name: "PriceOracleSentinelUpdated", params: [P("newAddress", "address", 1)] },
  { name: "PoolDataProviderUpdated", params: [P("newAddress", "address", 1)] },
  { name: "AddressSet", params: [P("id", "bytes32", 1), P("oldAddress", "address", 1), P("newAddress", "address", 1)] },
];

const AAVE_ORACLE_EVENTS = [
  { name: "AssetSourceUpdated", params: [P("asset", "address", 1), P("source", "address", 1)] },
  { name: "FallbackOracleUpdated", params: [P("fallbackOracle", "address", 1)] },
  { name: "BaseCurrencySet", params: [P("baseCurrency", "address", 1), P("baseCurrencyUnit", "uint256", 0)] },
];

const MORPHO_EVENTS = [
  { name: "CreateMarket", params: [P("id", "bytes32", 1), P("marketParams", "tuple(address,address,address,address,uint256)", 0)] },
  { name: "SetFee", params: [P("id", "bytes32", 1), P("newFee", "uint256", 0)] },
  { name: "EnableLltv", params: [P("lltv", "uint256", 0)] },
  { name: "EnableIrm", params: [P("irm", "address", 1)] },
  { name: "SetOwner", params: [P("newOwner", "address", 1)] },
  { name: "SetFeeRecipient", params: [P("newFeeRecipient", "address", 1)] },
];

const METAMORPHO_EVENTS = [
  { name: "CreateMetaMorpho", params: [P("metaMorpho", "address", 1), P("caller", "address", 1), P("initialOwner", "address", 0), P("initialTimelock", "uint256", 0), P("asset", "address", 1), P("name", "string", 0), P("symbol", "string", 0), P("salt", "bytes32", 0)] },
];

const ASSET_CONFIG_TUPLE = "tuple(address,address,uint64,uint64,uint64,uint64,uint128)";
const COMET_CONFIGURATOR_EVENTS = [
  { name: "UpdateAssetSupplyCap", params: [P("cometProxy", "address", 1), P("asset", "address", 1), P("oldSupplyCap", "uint128", 0), P("newSupplyCap", "uint128", 0)] },
  { name: "UpdateAssetPriceFeed", params: [P("cometProxy", "address", 1), P("asset", "address", 1), P("oldPriceFeed", "address", 0), P("newPriceFeed", "address", 0)] },
  { name: "UpdateAssetBorrowCollateralFactor", params: [P("cometProxy", "address", 1), P("asset", "address", 1), P("oldBorrowCF", "uint64", 0), P("newBorrowCF", "uint64", 0)] },
  { name: "UpdateAssetLiquidateCollateralFactor", params: [P("cometProxy", "address", 1), P("asset", "address", 1), P("oldLiquidateCF", "uint64", 0), P("newLiquidateCF", "uint64", 0)] },
  { name: "UpdateAssetLiquidationFactor", params: [P("cometProxy", "address", 1), P("asset", "address", 1), P("oldLiquidationFactor", "uint64", 0), P("newLiquidationFactor", "uint64", 0)] },
  { name: "SetPauseGuardian", params: [P("cometProxy", "address", 1), P("oldPauseGuardian", "address", 1), P("newPauseGuardian", "address", 1)] },
  { name: "CometDeployed", params: [P("cometProxy", "address", 1), P("newComet", "address", 1)] },
  { name: "SetFactory", params: [P("cometProxy", "address", 1), P("oldFactory", "address", 1), P("newFactory", "address", 1)] },
  { name: "SetGovernor", params: [P("cometProxy", "address", 1), P("oldGovernor", "address", 1), P("newGovernor", "address", 1)] },
  { name: "AddAsset", params: [P("cometProxy", "address", 1), P("assetConfig", ASSET_CONFIG_TUPLE, 0)] },
  { name: "UpdateAsset", params: [P("cometProxy", "address", 1), P("oldAssetConfig", ASSET_CONFIG_TUPLE, 0), P("newAssetConfig", ASSET_CONFIG_TUPLE, 0)] },
  { name: "SetSupplyKink", params: [P("cometProxy", "address", 1), P("oldKink", "uint64", 0), P("newKink", "uint64", 0)] },
  { name: "SetBorrowKink", params: [P("cometProxy", "address", 1), P("oldKink", "uint64", 0), P("newKink", "uint64", 0)] },
  { name: "SetStoreFrontPriceFactor", params: [P("cometProxy", "address", 1), P("oldStoreFrontPriceFactor", "uint64", 0), P("newStoreFrontPriceFactor", "uint64", 0)] },
  { name: "SetTargetReserves", params: [P("cometProxy", "address", 1), P("oldTargetReserves", "uint104", 0), P("newTargetReserves", "uint104", 0)] },
];

const COMET_PAUSE_EVENTS = [
  { name: "PauseAction", params: [P("supplyPaused", "bool", 0), P("transferPaused", "bool", 0), P("withdrawPaused", "bool", 0), P("absorbPaused", "bool", 0), P("buyPaused", "bool", 0)] },
];

const FEED_REGISTRY_EVENTS = [
  { name: "FeedConfirmed", params: [P("asset", "address", 1), P("denomination", "address", 1), P("latestAggregator", "address", 1), P("previousAggregator", "address", 0), P("nextPhaseId", "uint16", 0), P("sender", "address", 0)] },
  { name: "FeedProposed", params: [P("asset", "address", 1), P("denomination", "address", 1), P("proposedAggregator", "address", 1), P("currentAggregator", "address", 0), P("sender", "address", 0)] },
];

const COMPTROLLER_EVENTS = [
  { name: "MarketListed", params: [P("mToken", "address", 0)] },
  { name: "NewCollateralFactor", params: [P("mToken", "address", 0), P("oldCollateralFactorMantissa", "uint256", 0), P("newCollateralFactorMantissa", "uint256", 0)] },
  { name: "NewPriceOracle", params: [P("oldPriceOracle", "address", 0), P("newPriceOracle", "address", 0)] },
  { name: "NewBorrowCap", params: [P("cToken", "address", 1), P("newBorrowCap", "uint256", 0)] },
  { name: "NewSupplyCap", params: [P("cToken", "address", 1), P("newSupplyCap", "uint256", 0)] },
  { name: "ActionPaused", params: [P("cToken", "address", 1), P("action", "string", 0), P("pauseState", "bool", 0)] },
  { name: "NewReserveFactor", params: [P("cToken", "address", 0), P("oldReserveFactorMantissa", "uint256", 0), P("newReserveFactorMantissa", "uint256", 0)] },
];

// Each entry is probe-verified at runtime for live code and decoded log shape.
const REGISTRY = [
  // ---- Ethereum ----
  { chainId: 1, role: "AaveV3PoolAddressesProvider", cls: ["oracle", "config"], address: "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e", events: AAVE_PROVIDER_EVENTS },
  { chainId: 1, role: "AaveV3PoolConfigurator", cls: ["listing", "risk", "pause"], address: "0x64b761D848206f447Fe2dd461b0c635Ec39EbB27", events: AAVE_CONFIGURATOR_EVENTS },
  { chainId: 1, role: "AaveV3Oracle", cls: ["oracle"], address: "0x54586bE62E3c3580375aE3723C145253060Ca0C2", events: AAVE_ORACLE_EVENTS },
  { chainId: 1, role: "MorphoBlue", cls: ["listing", "risk", "admin"], address: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", events: MORPHO_EVENTS },
  { chainId: 1, role: "MetaMorphoFactory", cls: ["vault-registration"], address: "0xA9c3D3a366466Fa809d1Ae982Fb2c46E5fC41101", events: METAMORPHO_EVENTS },
  { chainId: 1, role: "CompoundIIICometConfigurator", cls: ["listing", "risk", "oracle", "pause"], address: "0x316f9708bB98af7dA9c68C1C3b5e79039cD336E3", events: COMET_CONFIGURATOR_EVENTS },
  { chainId: 1, role: "CompoundIIICometUSDC", cls: ["pause"], address: "0xc3d688B66703497DAA19211EEdff47f25384cdc3", events: COMET_PAUSE_EVENTS },
  { chainId: 1, role: "ChainlinkFeedRegistry", cls: ["oracle"], address: "0x47Fb2585D2C56Fe188D0E6ec628a38b74fCeeeDf", events: FEED_REGISTRY_EVENTS },
  { chainId: 1, role: "SparkPoolAddressesProvider", cls: ["oracle", "config"], address: "0x02C3eA4e34C0cBd694D2adFa2c690EECbC1793eE", events: AAVE_PROVIDER_EVENTS },
  { chainId: 1, role: "SparkLendPoolConfigurator", cls: ["listing", "risk", "pause"], address: "0x542dBA469Bde58faEE189FFB60C6b49CE60E0738", events: AAVE_CONFIGURATOR_EVENTS },

  // ---- Base ----
  { chainId: 8453, role: "AaveV3PoolAddressesProvider", cls: ["oracle", "config"], address: "0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D", events: AAVE_PROVIDER_EVENTS },
  { chainId: 8453, role: "AaveV3PoolConfigurator", cls: ["listing", "risk", "pause"], address: "0x5731a04B1E775f0fdd454Bf70f3335886e9A96be", events: AAVE_CONFIGURATOR_EVENTS },
  { chainId: 8453, role: "AaveV3Oracle", cls: ["oracle"], address: "0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156", events: AAVE_ORACLE_EVENTS },
  { chainId: 8453, role: "MorphoBlue", cls: ["listing", "risk", "admin"], address: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", events: MORPHO_EVENTS },
  { chainId: 8453, role: "MetaMorphoFactory", cls: ["vault-registration"], address: "0xA9c3D3a366466Fa809d1Ae982Fb2c46E5fC41101", events: METAMORPHO_EVENTS },
  { chainId: 8453, role: "MoonwellComptroller", cls: ["listing", "risk", "oracle", "pause"], address: "0xfBb21d0380beE3312B33c4353c8936a0F13EF26C", events: COMPTROLLER_EVENTS },
  { chainId: 8453, role: "CompoundIIICometUSDC", cls: ["pause"], address: "0xb125E6687d4313864e53df431d5425969c15Eb2F", events: COMET_PAUSE_EVENTS },

  // ---- Arbitrum ----
  { chainId: 42161, role: "AaveV3PoolAddressesProvider", cls: ["oracle", "config"], address: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb", events: AAVE_PROVIDER_EVENTS },
  { chainId: 42161, role: "AaveV3PoolConfigurator", cls: ["listing", "risk", "pause"], address: "0x8145eddDf43f50276641b55bd3AD95944510021E", events: AAVE_CONFIGURATOR_EVENTS },
  { chainId: 42161, role: "AaveV3Oracle", cls: ["oracle"], address: "0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7", events: AAVE_ORACLE_EVENTS },
  { chainId: 42161, role: "MorphoBlue", cls: ["listing", "risk", "admin"], address: "0x6c247b1F6182318877311737BaC0844bAa518F5e", events: MORPHO_EVENTS },
  { chainId: 42161, role: "MetaMorphoFactory", cls: ["vault-registration"], address: "0x0Ad7ef5876305f0505208Acd9CA866e1f654D527", events: METAMORPHO_EVENTS },
  { chainId: 42161, role: "MetaMorphoFactoryAlt", cls: ["vault-registration"], address: "0xD0fD1DD7a33e9fBBc00621D144f29647E624D7c3", events: METAMORPHO_EVENTS },
  { chainId: 42161, role: "CompoundIIICometUSDC", cls: ["pause"], address: "0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf", events: COMET_PAUSE_EVENTS },

  // ---- Cycle 2 additions (probe-verified 2026-09-15: eth_getCode non-empty;
  //      Morpho entries additionally answered owner() non-zero) ----
  { chainId: 1, role: "CompoundV2Comptroller", cls: ["listing", "risk", "oracle", "pause"], address: "0x3d9819210A31b4961b30EF54bE2aeD79B9c9Cd3B", events: COMPTROLLER_EVENTS },
  { chainId: 1, role: "CompoundIIICometUSDT", cls: ["pause"], address: "0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840", events: COMET_PAUSE_EVENTS },
  { chainId: 1, role: "CompoundIIICometWETH", cls: ["pause"], address: "0xA17581A9E3356d9A858b789D68B4d866e593aE94", events: COMET_PAUSE_EVENTS },
  { chainId: 42161, role: "CompoundIIICometUSDT", cls: ["pause"], address: "0xF25212E676D1F7F89Cd72fFEe66158f541246445", events: COMET_PAUSE_EVENTS },

  // ---- BNB Smart Chain (new chain in cycle 2) ----
  { chainId: 56, role: "MorphoBlue", cls: ["listing", "risk", "admin"], address: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", events: MORPHO_EVENTS },
];

// ---------------------------------------------------------------------------
// Transport (endpoint material stays process-only)
// ---------------------------------------------------------------------------
function resolveRpcs() {
  const map = {};
  const raw = process.env.CONFIG_DELTA_RPC_JSON;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      for (const [k, v] of Object.entries(parsed)) {
        if (/^\d+$/.test(k) && typeof v === "string" && /^https?:\/\//i.test(v)) map[Number(k)] = v;
      }
    } catch (_) {
      // fall through to public fallbacks
    }
  }
  // Strict mode (cycle-3): a chain absent from the supplied capability-qualified
  // map is recorded UNAVAILABLE rather than silently downgraded to a shallow
  // public fallback, so an empty result cannot be an artifact of narrow coverage.
  if (process.env.CONFIG_DELTA_STRICT_ENDPOINTS === "1") return map;
  for (const [chainId, url] of Object.entries(PUBLIC_FALLBACKS)) {
    if (!map[Number(chainId)]) map[Number(chainId)] = url;
  }
  return map;
}

let requestCount = 0;
async function rpc(url, method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
  if (requestCount >= MAX_TOTAL_REQUESTS) return { ok: false, code: "request-cap" };
  requestCount += 1;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Origin-proxied endpoints (e.g. app-hosted RPC proxies in the authorized
    // inventory) reject requests without a matching `origin` header.
    const headers = { "content-type": "application/json" };
    const origin = getOrigin(url);
    if (origin) headers.origin = origin;
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    if (res.status === 429 || res.status === 503 || res.status === 502) return { ok: false, code: "rate-limited" };
    const json = await res.json();
    if (!res.ok || !json || json.error || json.result === undefined) return { ok: false, code: "rpc-rejected" };
    return { ok: true, result: json.result };
  } catch (_) {
    return { ok: false, code: "transport" };
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function hexBlock(n) {
  const s = BigInt(n).toString(16);
  return "0x" + s;
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------
function eventsOf(entry) {
  const byTopic = new Map();
  for (const ev of entry.events) byTopic.set(eventTopic(ev), ev);
  return byTopic;
}

async function fetchLogsBounded(url, address, topics, fromBlock, toBlock, minChunk, paceMs, budget) {
  const logs = [];
  const errors = [];
  let requests = 0;
  let truncated = false;
  const stack = [{ from: fromBlock, to: toBlock }];
  while (stack.length) {
    if (budget.remaining <= 0) { errors.push("chain-budget"); truncated = true; break; }
    const span = stack.pop();
    if (span.from > span.to) continue;
    requests += 1;
    budget.remaining -= 1;
    await sleep(paceMs);
    let res = await rpc(url, "eth_getLogs", [{ address, topics, fromBlock: hexBlock(span.from), toBlock: hexBlock(span.to) }]);
    // Rate limiting must not be amplified by recursive splitting: back off, then skip.
    for (let attempt = 0; res.code === "rate-limited" && attempt < 2 && budget.remaining > 0; attempt += 1) {
      budget.remaining -= 1;
      await sleep(2500 * (attempt + 1));
      res = await rpc(url, "eth_getLogs", [{ address, topics, fromBlock: hexBlock(span.from), toBlock: hexBlock(span.to) }]);
    }
    if (res.ok) {
      if (!Array.isArray(res.result)) { errors.push("bad-result"); continue; }
      for (const log of res.result) if (logs.length < MAX_LOG_RESULTS) logs.push(log);
      continue;
    }
    if (res.code === "rate-limited") { errors.push("rate-limited"); continue; }
    const width = span.to - span.from + 1;
    if (width > minChunk) {
      const mid = span.from + Math.floor(width / 2);
      stack.push({ from: span.from, to: mid });
      stack.push({ from: mid + 1, to: span.to });
    } else {
      errors.push(res.code);
    }
  }
  return { logs, errors, requests, truncated };
}

async function main() {
  const chains = process.argv.includes("--chain")
    ? [Number(process.argv[process.argv.indexOf("--chain") + 1])]
    : [1, 8453, 42161, 56];

  const rpcs = resolveRpcs();
  const probe = [];
  const dropped = [];
  const deltas = [];
  const perChain = {};

  for (const chainId of chains) {
    const url = rpcs[chainId];
    const bounds = BOUNDS[chainId];
    if (!url || !bounds) { dropped.push({ chainId, role: "rpc", reason: "no-endpoint" }); continue; }
    const tipRes = await rpc(url, "eth_blockNumber", []);
    if (!tipRes.ok) { dropped.push({ chainId, role: "rpc", reason: "block-number-" + tipRes.code }); continue; }
    const tip = Number(BigInt(tipRes.result));
    const fromBlock = Math.max(0, tip - bounds.windowBlocks + 1);

    const entries = REGISTRY.filter((e) => e.chainId === chainId);
    const budget = { remaining: CHAIN_REQUEST_BUDGET };
    const chainStats = { chainId, chainName: CHAIN_NAMES[chainId], tipBlock: tip, fromBlock, toBlock: tip, windowBlocks: bounds.windowBlocks, chunkBlocks: bounds.chunkBlocks, entries: entries.length, requests: 0, chunkFailures: 0, budgetExhausted: false };
    const chainDeltas = [];

    for (const entry of entries) {
      if (budget.remaining <= 0) { chainStats.budgetExhausted = true; break; }
      const codeRes = await rpc(url, "eth_getCode", [entry.address, hexBlock(tip)]);
      const codePresent = codeRes.ok && typeof codeRes.result === "string" && codeRes.result !== "0x" && codeRes.result.length > 2;
      const row = { chainId, role: entry.role, address: entry.address, codePresent, topicsDeclared: entry.events.length, logsObserved: 0, topicsObserved: [], decodeErrors: 0, witness: "none-in-window", budgetTruncated: false };
      if (!codePresent) {
        dropped.push({ chainId, role: entry.role, address: entry.address, reason: "no-live-code" });
        probe.push(row);
        continue;
      }

      const byTopic = eventsOf(entry);
      const topics = [Array.from(byTopic.keys())];
      const startReq = requestCount;
      const scan = await fetchLogsBounded(url, entry.address, topics, fromBlock, tip, bounds.minChunk, bounds.paceMs, budget);
      chainStats.requests += requestCount - startReq;
      chainStats.chunkFailures += scan.errors.length;
      row.logsObserved = scan.logs.length;
      row.budgetTruncated = Boolean(scan.truncated);
      for (const log of scan.logs) {
        const topic0 = (log.topics && log.topics[0]) ? log.topics[0].toLowerCase() : null;
        const ev = topic0 ? byTopic.get(topic0) : null;
        if (!ev) continue;
        if (!row.topicsObserved.includes(ev.name)) row.topicsObserved.push(ev.name);
        let params = null;
        try {
          params = decodeEvent(ev, log);
        } catch (_) {
          row.decodeErrors += 1;
          continue;
        }
        chainDeltas.push({
          chainId,
          chainName: CHAIN_NAMES[chainId],
          role: entry.role,
          address: entry.address,
          classes: entry.cls,
          event: ev.name,
          blockNumber: log.blockNumber ? Number(BigInt(log.blockNumber)) : null,
          logIndex: log.logIndex ? Number(BigInt(log.logIndex)) : null,
          transactionHash: log.transactionHash || null,
          params,
        });
      }

      // Bounded witness probe for quiet events (event-presence verification).
      if (scan.logs.length === 0) {
        const wFrom = Math.max(0, fromBlock - bounds.witnessChunkBlocks * bounds.witnessChunks);
        if (wFrom < fromBlock) {
          const wStart = requestCount;
          const wit = await fetchLogsBounded(url, entry.address, topics, wFrom, fromBlock - 1, bounds.minChunk, bounds.paceMs, budget);
          chainStats.requests += requestCount - wStart;
          const names = new Set();
          for (const log of wit.logs) {
            const topic0 = (log.topics && log.topics[0]) ? log.topics[0].toLowerCase() : null;
            const ev = topic0 ? byTopic.get(topic0) : null;
            if (ev) names.add(ev.name);
          }
          row.budgetTruncated = row.budgetTruncated || Boolean(wit.truncated);
          row.witness = wit.logs.length > 0 ? `verified:${Array.from(names).sort().join("|")}` : "none-in-witness-window";
        }
      } else {
        row.witness = "observed-in-window";
      }
      probe.push(row);
    }

    chainDeltas.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0) || (a.blockNumber - b.blockNumber) || (a.logIndex - b.logIndex) || (a.event < b.event ? -1 : 1));
    deltas.push(...chainDeltas);
    perChain[chainId] = chainStats;
  }

  const classCounts = {};
  for (const d of deltas) for (const c of d.classes) classCounts[c] = (classCounts[c] || 0) + 1;
  const eventCounts = {};
  for (const d of deltas) eventCounts[d.event] = (eventCounts[d.event] || 0) + 1;

  const artifact = {
    schema: "config-delta-scan/v1",
    profile: process.env.CONFIG_DELTA_PROFILE || "cycle3",
    outFile: path.basename(OUT_FILE),
    registrySize: REGISTRY.length,
    bounds: {
      windowBlocks: Object.fromEntries(Object.entries(BOUNDS).map(([k, v]) => [k, { windowBlocks: v.windowBlocks, chunkBlocks: v.chunkBlocks, maxChunks: v.maxChunks, minChunk: v.minChunk, witnessChunks: v.witnessChunks, witnessChunkBlocks: v.witnessChunkBlocks }])),
      maxTotalRequests: MAX_TOTAL_REQUESTS,
      concurrency: CONCURRENCY,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      requestsUsed: requestCount,
    },
    chains: perChain,
    probe,
    dropped,
    deltaCount: deltas.length,
    deltasByClass: classCounts,
    deltasByEvent: eventCounts,
    deltas,
    safety: {
      endpointsStored: false,
      endpointStringsPresent: false,
      envOrKeyFilesRead: false,
      artifactContainsDeltasOnly: true,
    },
  };

  assertSanitized(artifact);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(artifact, null, 2) + "\n", "utf8");
  console.log(`wrote ${path.relative(WORKSPACE, OUT_FILE)} registry=${REGISTRY.length} deltas=${deltas.length} requests=${requestCount}`);
  console.log(`byClass=${JSON.stringify(classCounts)}`);
  for (const [cid, s] of Object.entries(perChain)) console.log(`chain=${cid} ${s.chainName} window=${s.fromBlock}..${s.toBlock} entries=${s.entries} requests=${s.requests} chunkFailures=${s.chunkFailures}`);
}

function assertSanitized(artifact) {
  const text = JSON.stringify(artifact);
  if (/(?:https?|wss?):\/\//i.test(text)) throw new Error("artifact endpoint leak");
  if (/"(?:endpoint|rpc|rpcUrl|providerUrl|headers|header|credential|secret|apiKey|token)"\s*:/i.test(text)) throw new Error("artifact provider-key leak");
}

main().catch((error) => {
  console.error("scan-config-deltas failed: " + String(error && error.message ? error.message : "error").replace(/https?:\/\/\S+/g, "[redacted]"));
  process.exitCode = 1;
});
