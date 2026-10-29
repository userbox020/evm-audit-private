"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

const {
  PaperLedger,
  PublicDataError,
  analyzeMarkHistory,
  binaryParityScreen,
  calibration,
  createPublicClient,
  eventBasketScreen,
  fairValueScreen,
  marketMakingProposal,
  normalizeMarket,
  resolveLiveFeeSchedule,
  screenSelectedEvents,
  screenSelectedMarkets,
  simulateDepth,
  takerFee,
} = require("../polymarket-research-r1");

const NOW = Date.parse("2026-08-30T00:00:00.000Z");
const freshBook = (bids, asks) => ({ timestamp: NOW, bids, asks });

test("fee formula is symmetric, rounded to five decimals, and dust rounds to zero", () => {
  assert.equal(takerFee(10, 0.02, 0.2), 0.032);
  assert.equal(takerFee(10, 0.02, 0.8), 0.032);
  assert.equal(takerFee(1, 0.00001, 0.5), 0);
  assert.equal(takerFee(1, 0.123456, 0.5), 0.03086);
  assert.throws(() => takerFee(1, undefined, 0.5), /fee-rate-required/);
});

test("malformed metadata is retained as deterministic normalization errors", () => {
  const market = normalizeMarket({ outcomes: "[bad", clobTokenIds: { nope: true }, outcomePrices: "" });
  assert.deepEqual(market.outcomes, []);
  assert.ok(market.metadataErrors.includes("outcomes:malformed-array"));
  assert.ok(market.metadataErrors.includes("tokenIds:not-array-or-string"));
});

test("outcome, token, and price correlation preserves source index", () => {
  const market = normalizeMarket({ outcomes: '["Yes","No"]', clobTokenIds: '["y","n"]', outcomePrices: '["0.61","0.39"]', orderPriceMinTickSize: 0.01, orderMinSize: 5, takerBaseFee: 2 });
  assert.deepEqual(market.outcomeTokens, [
    { index: 0, outcome: "Yes", tokenId: "y", price: 0.61, correlated: true },
    { index: 1, outcome: "No", tokenId: "n", price: 0.39, correlated: true },
  ]);
  assert.equal(market.tickSize, 0.01);
  assert.equal(market.minOrderSize, 5);
  assert.equal(market.feeSchedule.interpretable, false);
  assert.equal(resolveLiveFeeSchedule(market.feeSchedule).known, false);
  assert.deepEqual(resolveLiveFeeSchedule(market.feeSchedule, 0.02), { known: true, takerRate: 0.02, source: "explicit" });
});

test("depth simulation consumes best prices and supports FAK partial and FOK rejection", () => {
  const book = freshBook([], [{ price: 0.4, size: 2 }, { price: 0.5, size: 3 }]);
  const partial = simulateDepth({ side: "buy", book, shares: 7, feeRate: 0, orderType: "FAK", nowMs: NOW });
  assert.equal(partial.filledShares, 5);
  assert.equal(partial.partialFill, true);
  assert.equal(partial.grossCash, 2.3);
  const rejected = simulateDepth({ side: "buy", book, shares: 7, feeRate: 0, orderType: "FOK", nowMs: NOW });
  assert.equal(rejected.filledShares, 0);
  assert.equal(rejected.blocker, "insufficient-depth-for-fok");
});

test("fair-value EV uses executable asks and fees, not midpoint", () => {
  const result = fairValueScreen({
    side: "buy", book: freshBook([{ price: 0.1, size: 10 }], [{ price: 0.6, size: 10 }]),
    shares: 10, fairProbability: 0.65, feeRate: 0.02, orderType: "FOK", nowMs: NOW,
  });
  assert.equal(result.executablePrice, 0.6);
  assert.equal(result.expectedValue, 0.452);
  assert.equal(result.profitable, true);
});

test("binary parity requires explicit buffer and complete correlated inventory", () => {
  const blocked = binaryParityScreen({ shares: 10, feeRate: 0 });
  assert.equal(blocked.blocker, "explicit-settlement-merge-cost-buffer-required");
  const result = binaryParityScreen({
    shares: 10, feeRate: 0, settlementMergeCostBuffer: 0.1, conditionId: "condition", outcomesCorrelated: true, yesTokenId: "yes", noTokenId: "no", nowMs: NOW,
    yesBook: freshBook([], [{ price: 0.48, size: 10 }]), noBook: freshBook([], [{ price: 0.49, size: 10 }]),
  });
  assert.ok(Math.abs(result.net - 0.2) < 1e-12);
  assert.equal(result.sellPair.inventoryRequired, true);
});

test("event basket is blocked without exact identity, rules, and all outcomes", () => {
  const blocked = eventBasketScreen({ eventId: "e", outcomes: [{}, {}], exactEventIdentity: true, exactRules: false, allRequiredOutcomesPresent: false });
  assert.ok(blocked.blockers.includes("exact-rule-and-resolution-source-required"));
  assert.ok(blocked.blockers.includes("all-required-outcomes-required"));
});

test("market-making proposal respects tick, post-only bounds, inventory, and excludes rewards", () => {
  const proposal = marketMakingProposal({
    fairProbability: 0.55, tickSize: 0.01, minOrderSize: 5, size: 10,
    inventory: 15, inventoryCap: 20, bestBid: 0.54, bestAsk: 0.56,
  });
  assert.equal(proposal.bid, null);
  assert.equal(proposal.ask.price, 0.56);
  assert.equal(proposal.ask.inventoryRequired, true);
  assert.equal(proposal.rewardsIncludedInBasePnl, false);
  assert.equal(proposal.expectedPnl, null);
});

test("history is clearly not an execution backtest and calibration is exact", () => {
  const history = analyzeMarkHistory([{ t: 2, p: 0.6 }, { t: 1, p: 0.5 }]);
  assert.equal(history.label, "NOT an execution backtest");
  assert.ok(Math.abs(history.meanAbsoluteMarkChange - 0.1) < 1e-12);
  const result = calibration([{ probability: 0.8, outcome: 1 }, { probability: 0.2, outcome: 0 }], 2);
  assert.ok(Math.abs(result.brierScore - 0.04) < 1e-12);
  assert.ok(Math.abs(result.logScore - -Math.log(0.8)) < 1e-12);
  assert.equal(result.bins[0].observedFrequency, 0);
  assert.equal(result.bins[1].observedFrequency, 1);
});

test("paper ledger accepts explicit fills, fees, realized/unrealized PnL, and resolution", () => {
  const ledger = new PaperLedger();
  ledger.recordFill({ side: "buy", shares: 10, price: 0.4, fee: 0.1 });
  ledger.recordFill({ side: "sell", shares: 4, price: 0.6, fee: 0.04 });
  let summary = ledger.summary(0.5);
  assert.ok(Math.abs(summary.realizedPnl - 0.72) < 1e-12);
  assert.ok(Math.abs(summary.unrealizedPnl - 0.54) < 1e-12);
  summary = ledger.resolve(1);
  assert.ok(Math.abs(summary.realizedPnl - 4.26) < 1e-12);
  assert.equal(summary.inventory, 0);
  assert.equal(summary.totalPnl, null);
});

test("public client validates payloads and enforces request budget", async () => {
  const responses = [[], []];
  const fetchImpl = async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => responses.shift() });
  const client = createPublicClient({ fetchImpl, maxRequests: 2, concurrency: 1 });
  const discovery = await client.fetchGammaDiscovery({ marketLimit: 1, eventLimit: 1 });
  assert.deepEqual(discovery, { markets: [], events: [] });
  await assert.rejects(client.fetchBook("token"), (error) => error instanceof PublicDataError && error.code === "request-budget-exceeded");
});

test("CLOB book and bounded price-history fetchers normalize public JSON", async () => {
  const bodies = [
    { asset_id: "token", timestamp: NOW, bids: [{ price: "0.4", size: "3" }], asks: [{ price: "0.6", size: "2" }] },
    { history: [{ t: 1, p: 0.4 }, { t: 2, p: 0.5 }] },
  ];
  const fetchImpl = async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => bodies.shift() });
  const client = createPublicClient({ fetchImpl, maxRequests: 2 });
  const book = await client.fetchBook("token");
  assert.deepEqual(book.bids, [{ price: 0.4, size: 3 }]);
  const history = await client.fetchPricesHistory("token", { interval: "1d", maxPoints: 1 });
  assert.deepEqual(history, [{ timestamp: 1, price: 0.4 }]);
});

test("public client timeout is deterministic and does not expose URL details", async () => {
  const fetchImpl = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(Object.assign(new Error("secret-url-must-not-appear"), { name: "AbortError" })));
  });
  const client = createPublicClient({ fetchImpl, timeoutMs: 5, maxRequests: 1 });
  await assert.rejects(client.fetchBook("sensitive-token"), (error) => {
    assert.equal(error.message, "request-timeout:clob-book");
    assert.equal(error.message.includes("sensitive-token"), false);
    return true;
  });
});

function eventMarket(id, yesTokenId, overrides = {}) {
  return {
    id,
    active: true,
    closed: false,
    acceptingOrders: true,
    rules: `Captured rules for ${id}`,
    outcomes: ["Yes", "No"],
    tokenIds: [yesTokenId, `${yesTokenId}-no`],
    prices: [0.5, 0.5],
    ...overrides,
  };
}

test("selected event screen fetches only correlated YES books and returns complete negative and positive screens", async () => {
  const snapshot = {
    events: [
      { id: "negative", active: true, closed: false, negRisk: true, markets: [eventMarket("n1", "n1-yes"), eventMarket("n2", "n2-yes")] },
      { id: "positive", active: true, closed: false, negRisk: true, markets: [eventMarket("p1", "p1-yes"), eventMarket("p2", "p2-yes")] },
    ],
  };
  const askPrices = new Map([["n1-yes", 0.55], ["n2-yes", 0.5], ["p1-yes", 0.4], ["p2-yes", 0.4]]);
  const requested = [];
  const fetchImpl = async (url) => {
    const tokenId = url.searchParams.get("token_id");
    requested.push(tokenId);
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ asset_id: tokenId, timestamp: NOW, bids: [], asks: [{ price: askPrices.get(tokenId), size: 10 }] }),
    };
  };
  const result = await screenSelectedEvents(snapshot, {
    eventIds: "negative,positive", shares: 10, feeRate: 0, settlementBuffer: 0.1, maxRequests: 4, concurrency: 2,
  }, { fetchImpl, nowMs: NOW });
  assert.deepEqual(requested.sort(), ["n1-yes", "n2-yes", "p1-yes", "p2-yes"]);
  assert.equal(result.events[0].allRequiredOutcomesPresent, true);
  assert.equal(result.events[0].screen.profitable, false);
  assert.ok(result.events[0].screen.net < 0);
  assert.equal(result.events[1].screen.profitable, true);
  assert.ok(result.events[1].screen.net > 0);
  assert.deepEqual(result.unknowns, ["capital carry", "conversion mechanics", "latency", "event completeness"]);
});

test("selected event screen blocks completeness and sanitizes current book failures", async () => {
  const snapshot = {
    events: [{
      id: "blocked",
      active: true,
      closed: false,
      negRisk: true,
      markets: [eventMarket("b1", "b1-yes"), eventMarket("b2", "b2-yes", { rules: "" })],
    }],
  };
  const fetchImpl = async (url) => {
    const tokenId = url.searchParams.get("token_id");
    if (tokenId === "b2-yes") return { ok: false, status: 503, headers: { get: () => "application/json" } };
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ asset_id: tokenId, timestamp: NOW, bids: [], asks: [{ price: 0.4, size: 10 }] }),
    };
  };
  const result = await screenSelectedEvents(snapshot, {
    eventIds: "blocked", shares: 10, feeRate: 0.02, settlementBuffer: 0.1, maxRequests: 2,
  }, { fetchImpl, nowMs: NOW });
  const event = result.events[0];
  assert.equal(event.allRequiredOutcomesPresent, false);
  assert.equal(event.exactRules, false);
  assert.deepEqual(event.bookErrors, [{ marketId: "b2", code: "http-503" }]);
  assert.ok(event.screen.blockers.includes("all-required-outcomes-required"));
  assert.equal(JSON.stringify(event).includes("token_id"), false);
});

test("selected event screen requires explicit fee and settlement buffer and bounds IDs", async () => {
  await assert.rejects(screenSelectedEvents({ events: [] }, { eventIds: "e", shares: 1, settlementBuffer: 0 }), /fee-rate-required/);
  await assert.rejects(screenSelectedEvents({ events: [] }, { eventIds: "e", shares: 1, feeRate: 0 }), /settlement-buffer-required/);
  await assert.rejects(screenSelectedEvents({ events: [] }, {
    eventIds: Array.from({ length: 21 }, (_, index) => `e${index}`), shares: 1, feeRate: 0, settlementBuffer: 0,
  }), /too-many-event-ids/);
});

function capturedBinaryMarket(id, overrides = {}) {
  return {
    id,
    conditionId: `${id}-condition`,
    question: `Question ${id}`,
    active: true,
    closed: false,
    acceptingOrders: true,
    restricted: false,
    rules: `Rules ${id}`,
    endDate: "2026-08-30T12:00:00.000Z",
    outcomes: ["Yes", "No"],
    tokenIds: [`${id}-yes`, `${id}-no`],
    prices: [0.55, 0.45],
    tickSize: 0.01,
    minOrderSize: 5,
    liquidity: 1_000,
    volume24hr: 500,
    ...overrides,
  };
}

test("selected market screen reports negative FOK parity, top-of-book spreads, ranking metadata, and neutral maker references", async () => {
  const snapshot = {
    generatedAt: "2026-08-30T00:00:00.000Z",
    markets: [capturedBinaryMarket("m1"), capturedBinaryMarket("closed", { closed: true })],
  };
  const prices = new Map([["m1-yes", { bid: 0.54, ask: 0.55 }], ["m1-no", { bid: 0.49, ask: 0.5 }]]);
  const requested = [];
  const fetchImpl = async (url) => {
    const tokenId = url.searchParams.get("token_id");
    requested.push(tokenId);
    const price = prices.get(tokenId);
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ asset_id: tokenId, timestamp: NOW, bids: [{ price: price.bid, size: 10 }], asks: [{ price: price.ask, size: 10 }] }),
    };
  };
  const result = await screenSelectedMarkets(snapshot, {
    markets: 1, shares: 10, feeRate: 0, settlementBuffer: 0.1, maxRequests: 2, concurrency: 2,
  }, { fetchImpl, nowMs: NOW });
  assert.deepEqual(requested.sort(), ["m1-no", "m1-yes"]);
  assert.equal(result.bounds.selectedMarketCount, 1);
  assert.equal(result.bounds.requestCount, 2);
  const market = result.markets[0];
  assert.equal(market.parity.blocked, false);
  assert.ok(market.parity.net < 0);
  assert.equal(market.outcomes.YES.bestBid, 0.54);
  assert.ok(Math.abs(market.outcomes.YES.spread - 0.01) < 1e-12);
  assert.deepEqual(market.metadata, { restricted: false, rules: "Rules m1", endDate: "2026-08-30T12:00:00.000Z" });
  assert.equal(market.ranking.hoursToEnd, 12);
  assert.equal(market.ranking.liquidity, 1_000);
  assert.equal(market.makerQuotes.YES.referenceType, "snapshot-price-neutral-reference-not-fair-value");
  assert.equal(market.makerQuotes.YES.expectedPnl, null);
  assert.equal(market.makerQuotes.YES.proposal.expectedPnl, null);
  assert.equal(market.makerQuotes.YES.rewardsIncludedInBasePnl, false);
  assert.equal(market.makerQuotes.YES.profitabilityClaim, false);
  assert.equal(result.profitabilityClaim, false);
});

test("selected market screen blocks parity and maker quote when a current book is incomplete", async () => {
  const snapshot = { generatedAt: "2026-08-30T00:00:00.000Z", markets: [capturedBinaryMarket("m2")] };
  const fetchImpl = async (url) => {
    const tokenId = url.searchParams.get("token_id");
    if (tokenId === "m2-no") return { ok: false, status: 503, headers: { get: () => "application/json" } };
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ asset_id: tokenId, timestamp: NOW, bids: [{ price: 0.5, size: 10 }], asks: [{ price: 0.55, size: 10 }] }),
    };
  };
  const result = await screenSelectedMarkets(snapshot, {
    markets: 1, shares: 10, feeRate: 0.02, settlementBuffer: 0.1, maxRequests: 2,
  }, { fetchImpl, nowMs: NOW });
  const market = result.markets[0];
  assert.equal(market.parity.blocker, "both-current-outcome-books-required");
  assert.deepEqual(market.bookErrors, [{ outcome: "NO", code: "http-503" }]);
  assert.equal(market.makerQuotes.NO.blocker, "current-book-required-for-post-only-check");
  assert.equal(JSON.stringify(market.bookErrors).includes("token_id"), false);
});

test("selected market screen enforces market and request bounds", async () => {
  await assert.rejects(screenSelectedMarkets({ markets: [] }, {
    markets: 101, shares: 1, feeRate: 0, settlementBuffer: 0,
  }), /invalid-markets/);
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: async () => ({ asset_id: url.searchParams.get("token_id"), timestamp: NOW, bids: [], asks: [{ price: 0.5, size: 1 }] }),
  });
  const result = await screenSelectedMarkets({ markets: [capturedBinaryMarket("bounded")] }, {
    markets: 1, shares: 1, feeRate: 0, settlementBuffer: 0, maxRequests: 1,
  }, { fetchImpl, nowMs: NOW });
  assert.equal(result.bounds.requestCount, 1);
  assert.equal(result.markets[0].parity.blocked, true);
  assert.ok(result.markets[0].bookErrors.some((error) => error.code === "request-budget-exceeded"));
});

test("CLI defaults to offline help and demo is deterministic synthetic JSON", () => {
  const cli = path.join(__dirname, "..", "polymarket-research-r1", "cli.js");
  const help = spawnSync(process.execPath, [cli], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Network access occurs only for explicit fetch, screen-events, or screen-markets commands/);
  const first = spawnSync(process.execPath, [cli, "demo"], { encoding: "utf8" });
  const second = spawnSync(process.execPath, [cli, "demo"], { encoding: "utf8" });
  assert.equal(first.status, 0);
  assert.equal(first.stdout, second.stdout);
  const demo = JSON.parse(first.stdout);
  assert.equal(demo.mode, "offline-synthetic-demo");
  assert.match(demo.conclusion, /No profitability is established/);
});
