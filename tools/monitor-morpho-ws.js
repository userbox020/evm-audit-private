#!/usr/bin/env node
"use strict";

// Real-time Morpho Blue event streaming via source-safe WebSocket resolution.
const ethers = require("ethers");
const fs = require("fs");
const path = require("path");
const {
  getResolvedProvider,
  readLatestBlock,
  registerWsSubscription,
  resolveWsProvider,
  sanitizedErrorClass,
} = require("./monitor-ws-endpoints");

const WORKSPACE = path.resolve(__dirname, "..");
const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const STATUS_PATH = path.join(WORKSPACE, "reports", "monitor", "morpho-ws-status.json");
const CACHE_PATH = path.join(WORKSPACE, "reports", "monitor", "morpho-ws-cache.json");
const EVENTS_LOG = path.join(WORKSPACE, "reports", "monitor", "morpho-ws-events.jsonl");
const RECONNECT_MS = 10000;
const OBSERVATION_TIMEOUT_MS = 8000;
const OBSERVATION_MAX_AGE_MS = 120000;
const OBSERVATION_WATCHDOG_MS = 30000;
const VALUATION_STATUS = "UNAVAILABLE_MARKET_METADATA_REQUIRED";

const EVENTS = {
  Borrow: "0x570954540bed6b1304a87dfe815a5eda4a648f7097a16240dcd85c9b5fd42a43",
  Liquidate: "0xc271de7a37024d1e851e5fc9284cc9f2ffd01a781d0a2e9899c4a7a01a81e95e",
  Repay: ethers.id("Repay(bytes32,address,address,uint256,uint256)"),
  Supply: ethers.id("Supply(bytes32,address,address,uint256,uint256)"),
};

const CHAINS = {
  ethereum: { key: "ethereum", id: 1, name: "ETH" },
  base: { key: "base", id: 8453, name: "Base" },
  arbitrum: { key: "arbitrum", id: 42161, name: "Arb" },
  optimism: { key: "optimism", id: 10, name: "OP" },
};

const MORPHO_ABI = [
  "event Borrow(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets, uint256 shares)",
  "event Liquidate(bytes32 indexed id, address indexed caller, address borrower, uint256 repaidAssets, uint256 repaidShares, uint256 seizedAssets, uint256 badDebtAssets, uint256 badDebtShares)",
  "event Repay(bytes32 indexed id, address indexed caller, address indexed onBehalf, uint256 assets, uint256 shares)",
  "event Supply(bytes32 indexed id, address indexed caller, address indexed onBehalf, uint256 assets, uint256 shares)",
];

function ts() { return new Date().toISOString(); }
function log(message) { console.log(`[${ts()}] ${message}`); }
function shortAddress(value) { return value ? `${value.toString().slice(0, 10)}...` : "unknown"; }
function rawValue(value) { return value === undefined || value === null ? null : value.toString(); }

const missedLiquidations = [];
const borrowerCache = new Map();
const marketCache = new Map();
const eventStats = { Borrow: 0, Liquidate: 0, Repay: 0, Supply: 0 };
const reconnectTimers = new Map();
const activeProviders = new Map();
const connectionState = Object.fromEntries(Object.values(CHAINS).map(chain => [chain.key, {
  connected: false,
  degraded: true,
  connectedAt: null,
  degradedAt: ts(),
  sourceClass: null,
  errorClass: null,
  subscriptionState: "UNSUBSCRIBED",
  subscribedAt: null,
  lastObservedBlock: null,
  observationUpdatedAt: null,
}]));

function ensureMonitorDir() {
  fs.mkdirSync(path.dirname(STATUS_PATH), { recursive: true });
}

function logEvent(event) {
  try {
    ensureMonitorDir();
    fs.appendFileSync(EVENTS_LOG, `${JSON.stringify(event)}\n`);
  } catch (_) {}
}

function pruneMap(map, maxSize) {
  while (map.size > maxSize) map.delete(map.keys().next().value);
}

function pushBounded(array, value, maxSize) {
  array.push(value);
  if (array.length > maxSize) array.splice(0, array.length - maxSize);
}

function upsertCache(chainConfig, eventName, args, eventLog, assetsRaw) {
  const marketId = rawValue(args.id);
  const borrower = rawValue(args.onBehalf || args.borrower) || "";
  if (!marketId || !borrower) return;

  const borrowerKey = `${chainConfig.id}:${marketId}:${borrower.toLowerCase()}`;
  const current = borrowerCache.get(borrowerKey) || {
    chainKey: chainConfig.key,
    chainId: chainConfig.id,
    chain: chainConfig.name,
    marketId,
    borrower,
    firstSeenAt: ts(),
    borrowEvents: 0,
    repayEvents: 0,
    liquidateEvents: 0,
  };
  if (eventName === "Borrow") current.borrowEvents += 1;
  if (eventName === "Repay") current.repayEvents += 1;
  if (eventName === "Liquidate") current.liquidateEvents += 1;
  current.lastEvent = eventName;
  current.lastAssetsRaw = assetsRaw;
  current.lastBlock = eventLog.blockNumber;
  current.lastTx = eventLog.transactionHash;
  current.updatedAt = ts();
  borrowerCache.set(borrowerKey, current);
  pruneMap(borrowerCache, 5000);

  const marketKey = `${chainConfig.id}:${marketId}`;
  const market = marketCache.get(marketKey) || {
    chainKey: chainConfig.key,
    chainId: chainConfig.id,
    chain: chainConfig.name,
    marketId,
    borrowers: new Set(),
    borrowEvents: 0,
    repayEvents: 0,
    liquidateEvents: 0,
    firstSeenAt: ts(),
  };
  market.borrowers.add(borrower);
  if (eventName === "Borrow") market.borrowEvents += 1;
  if (eventName === "Repay") market.repayEvents += 1;
  if (eventName === "Liquidate") market.liquidateEvents += 1;
  market.lastEvent = eventName;
  market.lastBlock = eventLog.blockNumber;
  market.lastTx = eventLog.transactionHash;
  market.updatedAt = ts();
  marketCache.set(marketKey, market);
  pruneMap(marketCache, 1000);
}

function cacheSnapshot() {
  const borrowers = [...borrowerCache.values()]
    .sort((a, b) => (b.lastBlock || 0) - (a.lastBlock || 0))
    .slice(0, 500);
  const markets = [...marketCache.values()]
    .sort((a, b) => (b.lastBlock || 0) - (a.lastBlock || 0))
    .slice(0, 200)
    .map(market => ({ ...market, borrowers: [...market.borrowers].slice(0, 100), borrowerCount: market.borrowers.size }));
  return { borrowers, markets };
}

function chainStatus(chain) {
  return { key: chain.key, id: chain.id, name: chain.name, ...connectionState[chain.key] };
}

function writeStatus(trigger = "interval") {
  try {
    ensureMonitorDir();
    const recent = missedLiquidations.slice(-10);
    const snapshot = cacheSnapshot();
    const status = {
      updatedAt: ts(),
      trigger,
      eventStats,
      liquidationsSeen: missedLiquidations.length,
      cachedBorrowers: borrowerCache.size,
      cachedMarkets: marketCache.size,
      recent: recent.map(event => ({
        chain: event.chain,
        chainId: event.chainId,
        block: event.block,
        borrower: event.borrower?.slice(0, 10),
        marketId: event.marketId,
        repaidAssetsRaw: event.repaidAssetsRaw,
        seizedAssetsRaw: event.seizedAssetsRaw,
        amountUsd: null,
        valuationStatus: VALUATION_STATUS,
      })),
      chains: Object.values(CHAINS).map(chainStatus),
      status: "RUNNING",
    };
    fs.writeFileSync(STATUS_PATH, JSON.stringify(status, null, 2));
    fs.writeFileSync(CACHE_PATH, JSON.stringify({ updatedAt: ts(), ...snapshot }, null, 2));
  } catch (_) {}
}

function baseEvent(chainConfig, eventName, args, eventLog) {
  return {
    chainKey: chainConfig.key,
    chainId: chainConfig.id,
    chain: chainConfig.name,
    type: eventName,
    block: eventLog.blockNumber,
    marketId: rawValue(args.id),
    amountUsd: null,
    valuationStatus: VALUATION_STATUS,
    time: ts(),
    tx: eventLog.transactionHash,
  };
}

function handleMorphoEvent(chainConfig, iface, eventLog) {
  const parsed = iface.parseLog({ topics: [...eventLog.topics], data: eventLog.data });
  if (!parsed) return;
  const { name: eventName, args } = parsed;
  eventStats[eventName] = (eventStats[eventName] || 0) + 1;

  if (eventName === "Liquidate") {
    const repaidAssetsRaw = rawValue(args.repaidAssets);
    const seizedAssetsRaw = rawValue(args.seizedAssets);
    log(`${chainConfig.name} LIQUIDATE borrower=${shortAddress(args.borrower)} repaidAssetsRaw=${repaidAssetsRaw} seizedAssetsRaw=${seizedAssetsRaw} block=${eventLog.blockNumber}`);
    upsertCache(chainConfig, eventName, args, eventLog, repaidAssetsRaw);
    const event = {
      ...baseEvent(chainConfig, eventName, args, eventLog),
      borrower: args.borrower,
      repaidAssetsRaw,
      seizedAssetsRaw,
    };
    pushBounded(missedLiquidations, event, 1000);
    logEvent(event);
  } else if (["Borrow", "Repay", "Supply"].includes(eventName)) {
    const assetsRaw = rawValue(args.assets);
    const actor = args.onBehalf;
    log(`${chainConfig.name} ${eventName.toUpperCase()} onBehalf=${shortAddress(actor)} assetsRaw=${assetsRaw} block=${eventLog.blockNumber}`);
    upsertCache(chainConfig, eventName, args, eventLog, assetsRaw);
    logEvent({
      ...baseEvent(chainConfig, eventName, args, eventLog),
      onBehalf: actor,
      receiver: eventName === "Borrow" ? args.receiver : undefined,
      assetsRaw,
    });
  }
  writeStatus("event");
}

function markSubscribed(status) {
  status.subscriptionState = "SUBSCRIBED";
  status.subscribedAt = ts();
}

function recordObservation(status, blockNumber) {
  const observedBlock = Number(blockNumber);
  if (status.subscriptionState !== "SUBSCRIBED" || !Number.isSafeInteger(observedBlock) || observedBlock < 0) return false;
  if (status.connected && status.lastObservedBlock !== null && observedBlock <= status.lastObservedBlock) return false;
  status.lastObservedBlock = observedBlock;
  status.observationUpdatedAt = ts();
  status.connected = true;
  status.degraded = false;
  status.connectedAt ||= status.observationUpdatedAt;
  status.errorClass = null;
  return true;
}

function observationExpired(status, nowMs = Date.now()) {
  if (status.subscriptionState !== "SUBSCRIBED" || !status.observationUpdatedAt) return true;
  const observedAt = Date.parse(status.observationUpdatedAt);
  return !Number.isFinite(observedAt) || nowMs - observedAt > OBSERVATION_MAX_AGE_MS;
}

function markDegraded(chainConfig, error) {
  const status = connectionState[chainConfig.key];
  status.connected = false;
  status.degraded = true;
  status.degradedAt = ts();
  status.errorClass = sanitizedErrorClass(error);
  status.subscriptionState = "UNSUBSCRIBED";
  status.subscribedAt = null;
}

function scheduleReconnect(chainConfig, provider, error) {
  markDegraded(chainConfig, error);
  if (reconnectTimers.has(chainConfig.key)) return;
  activeProviders.delete(chainConfig.key);
  log(`${chainConfig.name} reconnecting errorClass=${connectionState[chainConfig.key].errorClass}`);
  writeStatus("reconnecting");
  Promise.resolve(provider?.destroy?.()).catch(() => {});
  const timer = setTimeout(() => {
    reconnectTimers.delete(chainConfig.key);
    connectChain(chainConfig);
  }, RECONNECT_MS);
  reconnectTimers.set(chainConfig.key, timer);
}

async function connectChain(chainConfig, injected = {}) {
  const resolveProvider = injected.resolveWsProvider || resolveWsProvider;
  const resolvedProvider = injected.getResolvedProvider || getResolvedProvider;
  const registerSubscription = injected.registerWsSubscription || registerWsSubscription;
  const latestBlock = injected.readLatestBlock || readLatestBlock;
  const reconnect = injected.scheduleReconnect || scheduleReconnect;
  const statusWriter = injected.writeStatus || writeStatus;
  const logger = injected.log || log;
  try {
    const resolution = await resolveProvider({ chainId: chainConfig.id });
    const provider = resolvedProvider(resolution);
    const status = connectionState[chainConfig.key];
    status.connected = false;
    status.degraded = true;
    status.connectedAt = null;
    status.sourceClass = resolution.sourceClass;
    status.errorClass = null;
    status.subscriptionState = "UNSUBSCRIBED";
    status.subscribedAt = null;
    activeProviders.set(chainConfig.key, provider);

    const providerFailed = error => {
      if (activeProviders.get(chainConfig.key) === provider) reconnect(chainConfig, provider, error);
    };
    provider.websocket?.on("close", () => providerFailed({ code: "NETWORK_ERROR" }));
    provider.websocket?.on("error", providerFailed);

    const iface = new ethers.Interface(MORPHO_ABI);
    const filter = {
      address: MORPHO,
      topics: [[EVENTS.Liquidate, EVENTS.Borrow, EVENTS.Repay, EVENTS.Supply]],
    };
    await registerSubscription(provider, filter, eventLog => {
      recordObservation(status, eventLog?.blockNumber);
      try { handleMorphoEvent(chainConfig, iface, eventLog); } catch (_) {}
    }, OBSERVATION_TIMEOUT_MS);
    if (activeProviders.get(chainConfig.key) !== provider) throw new Error("WS_CONTEXT_CLOSED");
    await registerSubscription(provider, "block", blockNumber => {
      if (recordObservation(status, blockNumber)) statusWriter("observation");
    }, OBSERVATION_TIMEOUT_MS);
    if (activeProviders.get(chainConfig.key) !== provider) throw new Error("WS_CONTEXT_CLOSED");
    markSubscribed(status);
    const blockNumber = await latestBlock(provider, OBSERVATION_TIMEOUT_MS);
    if (activeProviders.get(chainConfig.key) !== provider) throw new Error("WS_CONTEXT_CLOSED");
    if (!recordObservation(status, blockNumber)) throw new Error("OBSERVATION_REJECTED");
    logger(`${chainConfig.name} subscribed and observed`);
    statusWriter("observed");
    return provider;
  } catch (error) {
    reconnect(chainConfig, activeProviders.get(chainConfig.key) || null, error);
    return null;
  }
}

function startObservationWatchdog() {
  return setInterval(() => {
    for (const chainConfig of Object.values(CHAINS)) {
      const status = connectionState[chainConfig.key];
      if (status.subscriptionState === "SUBSCRIBED" && observationExpired(status)) {
        scheduleReconnect(chainConfig, activeProviders.get(chainConfig.key), { code: "TIMEOUT" });
      }
    }
  }, OBSERVATION_WATCHDOG_MS);
}

async function main() {
  console.log("=== Morpho Blue Real-Time Event Monitor (WebSocket) ===");
  console.log(`Chains: ${Object.values(CHAINS).map(chain => chain.name).join(", ")}`);
  ensureMonitorDir();
  writeStatus("startup");
  await Promise.all(Object.values(CHAINS).map(connectChain));

  startObservationWatchdog();
  setInterval(() => writeStatus("interval"), 300000);
  process.on("SIGINT", () => {
    fs.writeFileSync(STATUS_PATH, JSON.stringify({ stoppedAt: ts(), liquidationsSeen: missedLiquidations.length, status: "STOPPED" }, null, 2));
    process.exit(0);
  });
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Monitor failed errorClass=${sanitizedErrorClass(error)}`);
    process.exit(1);
  });
}

module.exports = {
  CHAINS,
  cacheSnapshot,
  connectChain,
  connectionState,
  handleMorphoEvent,
  main,
  markDegraded,
  observationExpired,
  rawValue,
  recordObservation,
  shortAddress,
  startObservationWatchdog,
};
