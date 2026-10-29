#!/usr/bin/env node
"use strict";

// Real-time Chainlink AnswerUpdated event streaming with opaque WS resolution.
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
const STATUS_PATH = path.join(WORKSPACE, "reports", "monitor", "chainlink-ws-status.json");
const EVENTS_LOG = path.join(WORKSPACE, "reports", "monitor", "chainlink-ws-events.jsonl");
const RECONNECT_MS = 10000;
const OBSERVATION_TIMEOUT_MS = 8000;
const OBSERVATION_MAX_AGE_MS = 120000;

const FEEDS = {
  ethereum: { key: "ethereum", id: 1, name: "ETH", feed: "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419" },
  base: { key: "base", id: 8453, name: "Base", feed: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70" },
  arbitrum: { key: "arbitrum", id: 42161, name: "Arb", feed: "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612" },
  optimism: { key: "optimism", id: 10, name: "OP", feed: "0x13e3Ee699D1909E989722E753853AE30b17e08c5" },
  polygon: { key: "polygon", id: 137, name: "Poly", feed: "0xF9680D99D6C9589e2a93a78A04A279e509205945" },
};

const ANSWER_UPDATED_TOPIC = "0x0559884fd3a460db3073b7fc896cc77986f16e378210ded43186175bf646fc5f";
const CL_ABI = ["event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)"];
const state = { prices: {}, lastUpdates: {}, stalenessAlerts: {}, lastEvents: {}, sequence: 0 };
const reconnectTimers = new Map();
const activeProviders = new Map();
const connectionState = Object.fromEntries(Object.values(FEEDS).map(feed => [feed.key, {
  connected: false,
  degraded: true,
  connectedAt: null,
  degradedAt: new Date().toISOString(),
  sourceClass: null,
  errorClass: null,
  subscriptionState: "UNSUBSCRIBED",
  subscribedAt: null,
  lastObservedBlock: null,
  observationUpdatedAt: null,
}]));

function ts() { return new Date().toISOString(); }
function log(message) { console.log(`[${ts()}] ${message}`); }

function ensureMonitorDir() {
  fs.mkdirSync(path.dirname(STATUS_PATH), { recursive: true });
}

function appendEvent(event) {
  try {
    ensureMonitorDir();
    fs.appendFileSync(EVENTS_LOG, `${JSON.stringify(event)}\n`);
  } catch (_) {}
}

function writeStatus(trigger = "interval") {
  const now = Math.floor(Date.now() / 1000);
  ensureMonitorDir();
  fs.writeFileSync(STATUS_PATH, JSON.stringify({
    updatedAt: ts(),
    trigger,
    sequence: state.sequence,
    feeds: Object.values(FEEDS).map(config => {
      const last = state.lastUpdates[config.key];
      return {
        key: config.key,
        chainId: config.id,
        name: config.name,
        price: state.prices[config.key],
        prevPrice: state.lastEvents[config.key]?.prevPrice,
        changePct: state.lastEvents[config.key]?.changePct,
        dropPct: state.lastEvents[config.key]?.dropPct,
        updatedAt: last?.updatedAt,
        age: last?.updatedAt ? now - last.updatedAt : null,
        block: last?.block,
        stale: !!state.stalenessAlerts[config.key],
        connection: { ...connectionState[config.key] },
      };
    }),
    status: "RUNNING",
  }, null, 2));
}

function checkDivergence() {
  const chains = Object.values(FEEDS).filter(config => state.prices[config.name]);
  if (chains.length < 2) return;
  const prices = chains.map(config => ({ name: config.name, price: state.prices[config.name] }));
  prices.sort((a, b) => a.price - b.price);
  const min = prices[0];
  const max = prices[prices.length - 1];
  const spread = (max.price - min.price) / min.price * 100;
  if (spread >= 2) {
    log(`DIVERGENCE ${spread.toFixed(2)}% ${min.name}=$${min.price.toFixed(2)} ${max.name}=$${max.price.toFixed(2)}`);
  }
}

function handleAnswerUpdated(config, iface, eventLog) {
  const parsed = iface.parseLog({ topics: [...eventLog.topics], data: eventLog.data });
  if (!parsed) return;

  // These feeds are explicitly ETH/USD feeds with 8-decimal answers.
  const price = Number(ethers.formatUnits(parsed.args.current, 8));
  const roundId = parsed.args.roundId.toString();
  const updatedAt = Number(parsed.args.updatedAt);
  const now = Math.floor(Date.now() / 1000);
  const age = now - updatedAt;
  const previous = state.prices[config.key];
  const changePct = previous > 0 ? (price - previous) / previous * 100 : null;
  const dropPct = previous > 0 ? Math.max(0, (previous - price) / previous * 100) : null;

  state.sequence += 1;
  state.prices[config.key] = price;
  state.prices[config.name] = price;
  state.lastUpdates[config.key] = { updatedAt, age, roundId, block: eventLog.blockNumber, tx: eventLog.transactionHash };
  state.lastUpdates[config.name] = state.lastUpdates[config.key];
  state.lastEvents[config.key] = { prevPrice: previous, changePct, dropPct };

  if (previous && Math.abs(price - previous) / previous > 0.001) {
    log(`${config.name} CL ETH/USD $${price.toFixed(2)} (${changePct.toFixed(2)}%) age=${age}s block=${eventLog.blockNumber}`);
  } else if (!previous) {
    log(`${config.name} CL ETH/USD $${price.toFixed(2)} age=${age}s initial`);
  }

  appendEvent({
    time: ts(), sequence: state.sequence, key: config.key, chainId: config.id, name: config.name,
    feed: config.feed, price, prevPrice: previous, changePct, dropPct, updatedAt, age,
    roundId, block: eventLog.blockNumber, tx: eventLog.transactionHash,
  });
  checkDivergence();
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

function markDegraded(config, error) {
  const status = connectionState[config.key];
  status.connected = false;
  status.degraded = true;
  status.degradedAt = ts();
  status.errorClass = sanitizedErrorClass(error);
  status.subscriptionState = "UNSUBSCRIBED";
  status.subscribedAt = null;
}

function scheduleReconnect(config, provider, error) {
  markDegraded(config, error);
  if (reconnectTimers.has(config.key)) return;
  activeProviders.delete(config.key);
  log(`${config.name} reconnecting errorClass=${connectionState[config.key].errorClass}`);
  writeStatus("reconnecting");
  Promise.resolve(provider?.destroy?.()).catch(() => {});
  const timer = setTimeout(() => {
    reconnectTimers.delete(config.key);
    connectChain(config);
  }, RECONNECT_MS);
  reconnectTimers.set(config.key, timer);
}

async function connectChain(config, injected = {}) {
  const resolveProvider = injected.resolveWsProvider || resolveWsProvider;
  const resolvedProvider = injected.getResolvedProvider || getResolvedProvider;
  const registerSubscription = injected.registerWsSubscription || registerWsSubscription;
  const latestBlock = injected.readLatestBlock || readLatestBlock;
  const reconnect = injected.scheduleReconnect || scheduleReconnect;
  const statusWriter = injected.writeStatus || writeStatus;
  const logger = injected.log || log;
  try {
    const resolution = await resolveProvider({ chainId: config.id });
    const provider = resolvedProvider(resolution);
    const status = connectionState[config.key];
    status.connected = false;
    status.degraded = true;
    status.connectedAt = null;
    status.sourceClass = resolution.sourceClass;
    status.errorClass = null;
    status.subscriptionState = "UNSUBSCRIBED";
    status.subscribedAt = null;
    activeProviders.set(config.key, provider);

    const providerFailed = error => {
      if (activeProviders.get(config.key) === provider) reconnect(config, provider, error);
    };
    provider.websocket?.on("close", () => providerFailed({ code: "NETWORK_ERROR" }));
    provider.websocket?.on("error", providerFailed);

    const iface = new ethers.Interface(CL_ABI);
    const filter = { address: config.feed, topics: [ANSWER_UPDATED_TOPIC] };
    await registerSubscription(provider, filter, eventLog => {
      recordObservation(status, eventLog?.blockNumber);
      try { handleAnswerUpdated(config, iface, eventLog); } catch (_) {}
    }, OBSERVATION_TIMEOUT_MS);
    if (activeProviders.get(config.key) !== provider) throw new Error("WS_CONTEXT_CLOSED");
    await registerSubscription(provider, "block", blockNumber => {
      if (recordObservation(status, blockNumber)) statusWriter("observation");
    }, OBSERVATION_TIMEOUT_MS);
    if (activeProviders.get(config.key) !== provider) throw new Error("WS_CONTEXT_CLOSED");
    markSubscribed(status);
    const blockNumber = await latestBlock(provider, OBSERVATION_TIMEOUT_MS);
    if (activeProviders.get(config.key) !== provider) throw new Error("WS_CONTEXT_CLOSED");
    if (!recordObservation(status, blockNumber)) throw new Error("OBSERVATION_REJECTED");
    logger(`${config.name} subscribed and observed`);
    statusWriter("observed");
    return provider;
  } catch (error) {
    reconnect(config, activeProviders.get(config.key) || null, error);
    return null;
  }
}

function startStalenessWatchdog() {
  return setInterval(() => {
    const now = Math.floor(Date.now() / 1000);
    for (const config of Object.values(FEEDS)) {
      const connection = connectionState[config.key];
      if (connection.subscriptionState === "SUBSCRIBED" && observationExpired(connection)) {
        scheduleReconnect(config, activeProviders.get(config.key), { code: "TIMEOUT" });
      }
      const lastUpdate = state.lastUpdates[config.key];
      if (!lastUpdate) continue;
      const age = now - lastUpdate.updatedAt;
      if (age > 3600 && !state.stalenessAlerts[config.key]) {
        state.stalenessAlerts[config.key] = true;
        log(`STALE ${config.name} ETH/USD ageHours=${Math.floor(age / 3600)} price=$${state.prices[config.name]?.toFixed(2)}`);
      } else if (age <= 3600) {
        state.stalenessAlerts[config.key] = false;
      }
    }
    writeStatus("interval");
  }, 60000);
}

async function main() {
  console.log("=== Chainlink ETH/USD Real-Time Monitor (WebSocket) ===");
  console.log(`Chains: ${Object.values(FEEDS).map(config => config.name).join(", ")}`);
  ensureMonitorDir();
  writeStatus("startup");
  startStalenessWatchdog();
  await Promise.all(Object.values(FEEDS).map(connectChain));
  process.on("SIGINT", () => process.exit(0));
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Monitor failed errorClass=${sanitizedErrorClass(error)}`);
    process.exit(1);
  });
}

module.exports = {
  FEEDS,
  checkDivergence,
  connectChain,
  connectionState,
  handleAnswerUpdated,
  main,
  markDegraded,
  observationExpired,
  recordObservation,
  startStalenessWatchdog,
  state,
};
