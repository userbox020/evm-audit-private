"use strict";

// Offline suite for the wallet-balance collector. No network: RPC is injected,
// chain resolution is driven by a fake URL list, and serialization is checked to
// contain no endpoint material.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const collector = require("./watch-wallet-balances.js");
const { acquireWalletBalanceOutputOwner } = require("./lib/wallet-balance-output-owner");

const A1 = `0x${"11".repeat(20)}`;
const A2 = `0x${"22".repeat(20)}`;
const USER = "0x24e46e91dfaad1fa3d49c48aa85ca9306885ce0a";
const FAKE_URL = "http://fake.invalid";
// Well-known public Solana addresses (test-only): the wrapped-SOL mint and the
// canonical USDC SPL mint.
const SOL_ADDR = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WATCHLIST = { schema: "watch-addresses/v1", addresses: [{ address: A1, label: "one" }] };
const USDC_1 = collector.STABLECOINS[1][0];
const USDC_ONLY = { 1: [USDC_1] };

function word(value) { return BigInt(value).toString(16).padStart(64, "0"); }
function encString(text) {
  const bytes = Buffer.from(text, "utf8");
  const hex = bytes.toString("hex");
  const padded = hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");
  return `0x${word(32)}${word(bytes.length)}${padded}`;
}

function okCall(overrides = {}) {
  return async (url, method, params) => {
    if (method === "eth_chainId") return overrides.chainId || "0x1";
    if (method === "eth_blockNumber") return overrides.blockNumber || "0x10";
    if (method === "eth_getBalance") return overrides.balance || "0xde0b6b3a7640000";
    if (method === "eth_call") return null; // no token metadata unless overridden
    if (overrides.throwOn === method) throw Object.assign(new Error("boom"), { code: "TRANSPORT" });
    return null;
  };
}

// Fake on-chain token layer for the canonical chain-1 specs.
function stableCall({ tokenBalances = {}, symbolOverride = {}, decimalsOverride = {}, omitBalance = [] } = {}) {
  return async (_url, method, params) => {
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_blockNumber") return "0x10";
    if (method === "eth_getBalance") return "0xde0b6b3a7640000";
    if (method !== "eth_call") return null;
    const to = String(params[0].to).toLowerCase();
    const data = String(params[0].data);
    const spec = collector.STABLECOINS[1].find((row) => row.address === to);
    if (!spec) return null;
    if (data.startsWith(collector.TOKEN_SELECTOR.symbol)) {
      const symbol = Object.hasOwn(symbolOverride, spec.symbol) ? symbolOverride[spec.symbol] : spec.symbol;
      return symbol === null ? null : encString(symbol);
    }
    if (data.startsWith(collector.TOKEN_SELECTOR.decimals)) {
      const decimals = Object.hasOwn(decimalsOverride, spec.symbol) ? decimalsOverride[spec.symbol] : 6;
      return decimals === null ? null : `0x${word(decimals)}`;
    }
    if (data.startsWith(collector.TOKEN_SELECTOR.balanceOf)) {
      if (omitBalance.includes(spec.symbol)) return null;
      return `0x${word(tokenBalances[spec.symbol] !== undefined ? tokenBalances[spec.symbol] : "0")}`;
    }
    return null;
  };
}

test("synthetic watchlist loader preserves entries without reading the real watchlist", () => {
  const value = { schema: "watch-addresses/v1", addresses: [{ address: A1, label: "main" }] };
  assert.equal(value.schema, "watch-addresses/v1");
  const { addresses, errors } = collector.loadWatchlist("synthetic", { readFileSync: () => JSON.stringify(value) });
  assert.deepEqual(errors, []);
  assert.equal(addresses.some((row) => row.address === A1 && row.label === "main"), true);
});

test("address validation normalizes, dedupes, and never echoes raw input", () => {
  const mixed = `0x${"AB".repeat(20)}`;
  const { addresses, errors } = collector.validateWatchlist({
    schema: "watch-addresses/v1",
    addresses: [
      { address: mixed, label: "Whale" },
      { address: mixed.toLowerCase() },
      { address: "0x1234" },
      "not-an-object",
      { address: `0x${"cd".repeat(20)}`, label: 123 },
    ],
  });
  assert.deepEqual(addresses, [
    { label: "Whale", address: mixed.toLowerCase(), family: "evm" },
    { label: null, address: `0x${"cd".repeat(20)}`, family: "evm" },
  ]);
  assert.deepEqual(errors.map((row) => row.message), [
    "ADDRESS_DUPLICATE:1", "ADDRESS_INVALID:2", "ENTRY_INVALID:3", "LABEL_INVALID:4",
  ]);
  assert.equal(JSON.stringify(errors).includes("0x1234"), false);
});

test("empty watchlist produces the exact empty artifact with zero totals", async () => {
  const { artifact } = await collector.runOnce({
    watchlist: { schema: "watch-addresses/v1", addresses: [] },
    chainEndpoints: new Map(),
    call: okCall(),
    stablecoins: {},
    now: () => 1_700_000_000_000,
  });
  assert.deepEqual(Object.keys(artifact).sort(), ["addresses", "asOf", "chains", "durationMs", "errors", "schema", "solana", "totals", "watchlistPath"]);
  assert.equal(artifact.schema, "wallet-balances/v1");
  assert.equal(artifact.watchlistPath, "coordination/watch-addresses.json");
  assert.equal(artifact.asOf, new Date(1_700_000_000_000).toISOString());
  assert.deepEqual(artifact.addresses, []);
  assert.deepEqual(artifact.solana, []);
  assert.deepEqual(artifact.chains, []);
  assert.deepEqual(artifact.errors, []);
  assert.deepEqual(artifact.totals, {
    stableUsd: "0.00", nativeUsd: null, totalUsd: null, complete: false,
    note: collector.STABLE_USD_ASSUMPTION_NOTE, unpricedChains: [], priceSource: "defillama",
  });
  assert.equal(Number.isFinite(artifact.durationMs) && artifact.durationMs >= 0, true);
});

test("fake-RPC success records native balance and no endpoint material", async () => {
  const { artifact } = await collector.runOnce({
    watchlist: WATCHLIST,
    chainEndpoints: new Map([[1, FAKE_URL]]),
    call: okCall(),
    stablecoins: {},
    nativePrices: {},
    now: () => 1_700_000_000_000,
  });
  assert.equal(artifact.chains.length, 1);
  const chain = artifact.chains[0];
  assert.deepEqual(Object.keys(chain).sort(), ["addressRows", "chainId", "name"]);
  assert.equal(chain.chainId, 1);
  assert.equal(chain.name, "ethereum");
  const row = chain.addressRows[0];
  assert.deepEqual(Object.keys(row).sort(), ["address", "blockNumber", "error", "native", "stableUsdTotal", "tokens", "totalUsd"]);
  assert.equal(row.address, A1);
  assert.equal(row.blockNumber, 16);
  assert.equal(row.error, null);
  assert.deepEqual(row.native, { symbol: "ETH", raw: "1000000000000000000", formatted: "1", usd: null });
  assert.deepEqual(row.tokens, []);
  assert.equal(row.stableUsdTotal, "0.00");
  assert.equal(row.totalUsd, null, "no native price -> totalUsd is null");
  assert.equal(artifact.totals.stableUsd, "0.00");
  assert.equal(artifact.totals.nativeUsd, null);
  assert.equal(artifact.totals.totalUsd, null);
  assert.equal(artifact.totals.priceSource, "defillama");
  const text = JSON.stringify(artifact);
  assert.equal(/https?:\/\//iu.test(text), false);
  assert.equal(/fake\.invalid|endpoint|authorization|api[_-]?key/iu.test(text), false);
});

test("fake-RPC failures are sanitized per row and never drop an address", async () => {
  const { artifact } = await collector.runOnce({
    watchlist: { schema: "watch-addresses/v1", addresses: [{ address: A1 }, { address: A2 }] },
    chainEndpoints: new Map([[1, FAKE_URL]]),
    call: async (_url, method) => {
      if (method === "eth_blockNumber") return "0x10";
      if (method === "eth_getBalance") return null;
      return null;
    },
    stablecoins: {},
    nativePrices: {},
    now: () => 0,
  });
  const rows = artifact.chains[0].addressRows;
  assert.equal(rows.length, 2, "every address keeps a row");
  assert.deepEqual(rows.map((row) => row.error), ["BALANCE_READ_FAILED", "BALANCE_READ_FAILED"]);
  assert.deepEqual(rows.map((row) => row.native), [null, null]);
  assert.deepEqual(rows.map((row) => row.blockNumber), [16, 16]);
  assert.deepEqual(rows.map((row) => row.stableUsdTotal), ["0.00", "0.00"]);
  assert.deepEqual(rows.map((row) => row.totalUsd), [null, null]);

  const blockFailure = await collector.runOnce({
    watchlist: WATCHLIST,
    chainEndpoints: new Map([[1, FAKE_URL]]),
    call: async (_url, method) => { if (method === "eth_blockNumber") throw new Error("transport"); return null; },
    stablecoins: {},
    nativePrices: {},
    now: () => 0,
  });
  const bad = blockFailure.artifact.chains[0].addressRows[0];
  assert.equal(bad.error, "BLOCK_READ_FAILED");
  assert.equal(bad.blockNumber, null);
  assert.equal(bad.native, null);
});

test("multiple chains are ordered by chain id", async () => {
  const { artifact } = await collector.runOnce({
    watchlist: WATCHLIST,
    chainEndpoints: new Map([[8453, FAKE_URL], [1, FAKE_URL]]),
    call: okCall(),
    stablecoins: {},
    nativePrices: {},
    now: () => 0,
  });
  assert.deepEqual(artifact.chains.map((chain) => chain.chainId), [1, 8453]);
  assert.deepEqual(artifact.chains.map((chain) => chain.name), ["ethereum", "base"]);
  for (const chain of artifact.chains) for (const row of chain.addressRows) assert.deepEqual(row.tokens, []);
});

test("canonical stablecoins are validated on-chain and valued at exactly $1.00", async () => {
  const call = stableCall({
    tokenBalances: { USDC: "1000000", USDT: "2000000", DAI: "3000000000000000000" },
    decimalsOverride: { DAI: 18 },
  });
  const { artifact } = await collector.runOnce({
    watchlist: WATCHLIST, chainEndpoints: new Map([[1, FAKE_URL]]), call, nativePrices: {}, now: () => 0,
  });
  const row = artifact.chains[0].addressRows[0];
  assert.equal(row.tokens.length, 3);
  for (const token of row.tokens) {
    assert.deepEqual(Object.keys(token).sort(), ["address", "decimals", "formatted", "raw", "symbol", "usd"]);
    assert.match(token.address, /^0x[0-9a-f]{40}$/u);
  }
  const usdc = row.tokens.find((token) => token.symbol === "USDC");
  assert.deepEqual(usdc, { symbol: "USDC", address: USDC_1.address, decimals: 6, raw: "1000000", formatted: "1", usd: "1.00" });
  const usdt = row.tokens.find((token) => token.symbol === "USDT");
  assert.equal(usdt.usd, "2.00");
  const dai = row.tokens.find((token) => token.symbol === "DAI");
  assert.deepEqual({ decimals: dai.decimals, raw: dai.raw, formatted: dai.formatted, usd: dai.usd }, { decimals: 18, raw: "3000000000000000000", formatted: "3", usd: "3.00" });
  assert.equal(row.stableUsdTotal, "6.00");
  assert.equal(artifact.totals.stableUsd, "6.00");
  assert.match(artifact.totals.note, /\$1\.00/u);
  assert.deepEqual(artifact.totals.unpricedChains, []);
  assert.equal(/https?:\/\//iu.test(JSON.stringify(artifact)), false);
});

test("USD valuation rounds half-up to two decimals", async () => {
  for (const [raw, expected] of [["1000000", "1.00"], ["1005000", "1.01"], ["1004999", "1.00"], ["1999999", "2.00"]]) {
    const { artifact } = await collector.runOnce({
      watchlist: WATCHLIST,
      chainEndpoints: new Map([[1, FAKE_URL]]),
      call: stableCall({ tokenBalances: { USDC: raw } }),
      stablecoins: USDC_ONLY,
      nativePrices: {},
      now: () => 0,
    });
    const usdc = artifact.chains[0].addressRows[0].tokens[0];
    assert.equal(usdc.usd, expected, `raw=${raw}`);
  }
});

test("an unresolved token makes totals unknown even when native is priced", async () => {
  const { artifact } = await collector.runOnce({
    watchlist: WATCHLIST,
    chainEndpoints: new Map([[1, FAKE_URL]]),
    call: stableCall({ omitBalance: ["USDC"] }),
    stablecoins: USDC_ONLY,
    nativePrices: { ethereum: 2000 },
    now: () => 0,
  });
  const row = artifact.chains[0].addressRows[0];
  assert.deepEqual(row.tokens[0], { symbol: "USDC", address: USDC_1.address, decimals: 6, raw: null, formatted: null, usd: null });
  assert.equal(row.stableUsdTotal, null);
  assert.equal(row.totalUsd, null);
  assert.equal(artifact.totals.stableUsd, null);
  assert.equal(artifact.totals.totalUsd, null);
  assert.equal(artifact.totals.complete, false);
  assert.deepEqual(artifact.totals.unpricedChains, ["ethereum"]);
});

test("an on-chain identity mismatch skips the token with a sanitized warning", async () => {
  const { artifact } = await collector.runOnce({
    watchlist: WATCHLIST,
    chainEndpoints: new Map([[1, FAKE_URL]]),
    call: stableCall({ symbolOverride: { USDC: "FAKE" } }),
    stablecoins: USDC_ONLY,
    nativePrices: {},
    now: () => 0,
  });
  const row = artifact.chains[0].addressRows[0];
  assert.deepEqual(row.tokens, []);
  assert.deepEqual(artifact.errors, [{ scope: "token", message: "TOKEN_SKIPPED:USDC:identity" }]);
  assert.equal(artifact.totals.stableUsd, null);
});

test("symbol decoding accepts dynamic strings and bytes32 without echoing junk", () => {
  assert.equal(collector.decodeSymbol(encString("USDC")), "USDC");
  assert.equal(collector.decodeSymbol(`0x${Buffer.from("DAI", "utf8").toString("hex").padEnd(64, "0")}`), "DAI");
  assert.equal(collector.decodeSymbol("0x"), null);
  assert.equal(collector.decodeSymbol("0x00"), null);
});

test("chain enumeration keeps only chains matching the target set", async () => {
  const call = async (url, method) => {
    if (method !== "eth_chainId") return null;
    return url.includes("a.") ? "0x1" : "0x2105";
  };
  const resolved = await collector.enumerateChains({
    urls: ["http://a.invalid", "http://b.invalid"],
    chainIds: [1, 8453, 10],
    call,
    now: () => 0,
    fallbacks: {},
  });
  assert.equal(resolved.has(1), true);
  assert.equal(resolved.has(8453), true);
  assert.equal(resolved.has(10), false);
  assert.deepEqual([...resolved.keys()].sort((a, b) => a - b), [1, 8453]);
});

test("native formatting trims and caps the fraction", () => {
  assert.equal(collector.formatNative("0"), "0");
  assert.equal(collector.formatNative("1000000000000000000"), "1");
  assert.equal(collector.formatNative("1500000000000000000"), "1.5");
  assert.equal(collector.formatNative("1"), "0.00000000");
});

test("parseArgs accepts --once and --check and rejects anything else", () => {
  assert.deepEqual(collector.parseArgs([]), { check: false, once: true });
  assert.deepEqual(collector.parseArgs(["--once"]), { check: false, once: true });
  assert.deepEqual(collector.parseArgs(["--check"]), { check: true, once: false });
  assert.throws(() => collector.parseArgs(["--bogus"]), (error) => error.code === "USAGE");
  assert.throws(() => collector.parseArgs(["--once", "--check"]), (error) => error.code === "USAGE");
});

test("writeArtifact is atomic and round-trips the schema", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wallet-balances-"));
  try {
    const outPath = path.join(directory, "wallet-balances.json");
    const { artifact } = await collector.runOnce({
      watchlist: WATCHLIST, chainEndpoints: new Map([[1, FAKE_URL]]), call: okCall(), stablecoins: {}, nativePrices: {}, now: () => 0,
    });
    const owner = acquireWalletBalanceOutputOwner(outPath);
    let written;
    try { written = collector.writeArtifact(artifact, outPath, fs, owner); }
    finally { owner.release(); }
    assert.equal(written, outPath);
    const readback = JSON.parse(fs.readFileSync(outPath, "utf8"));
    assert.equal(readback.schema, "wallet-balances/v1");
    assert.equal(fs.readdirSync(directory).some((name) => name.includes(".tmp-")), false);
    assert.equal(/https?:\/\//iu.test(fs.readFileSync(outPath, "utf8")), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the 14 requested chains are each bound or explicitly unbound", () => {
  const requested = [100, 130, 146, 999, 1135, 1868, 5000, 9745, 34443, 43114, 57073, 59144, 81457, 534352];
  const bound = requested.filter((id) => (collector.STABLECOINS[id] || []).length > 0);
  const unbound = requested.filter((id) => collector.UNBOUND_STABLECOIN_CHAINS[id]);
  assert.equal(bound.length + unbound.length, requested.length, "every requested chain is accounted for");
  assert.equal(bound.length, 13);
  for (const id of requested) {
    for (const token of collector.STABLECOINS[id] || []) {
      assert.match(token.address, /^0x[0-9a-f]{40}$/u);
      assert.equal(token.address, token.address.toLowerCase());
      assert.equal(typeof token.symbol, "string");
    }
  }
  assert.equal(collector.STABLECOINS[1135][0].symbol, "USDC.e", "bridged symbol is recorded verbatim");
  assert.equal(collector.STABLECOINS[1868].some((t) => t.symbol === "USDC.e"), true, "Soneium bridged USDC keeps the on-chain USDC.e symbol");
  assert.equal(collector.STABLECOINS[100][0].symbol, "WXDAI", "Gnosis canonical USD stable is wrapped xDAI");
  assert.equal(collector.STABLECOINS[5000][0].symbol, "USDC", "Mantle canonical USDC");
  assert.equal(collector.STABLECOINS[81457], undefined, "Blast is intentionally unbound (rebasing USDB)");
  assert.deepEqual(unbound.map((id) => collector.UNBOUND_STABLECOIN_CHAINS[id]).sort(), ["blast"]);
});

test("native pricing applies the price with cent rounding and feeds totals", async () => {
  const whole = await collector.runOnce({
    watchlist: WATCHLIST, chainEndpoints: new Map([[1, FAKE_URL]]),
    call: okCall(), stablecoins: {}, nativePrices: { ethereum: 2000.5 }, now: () => 0,
  });
  const row = whole.artifact.chains[0].addressRows[0];
  assert.deepEqual(row.native, { symbol: "ETH", raw: "1000000000000000000", formatted: "1", usd: "2000.50" });
  assert.equal(row.totalUsd, "2000.50");
  assert.equal(whole.artifact.totals.nativeUsd, "2000.50");
  assert.equal(whole.artifact.totals.totalUsd, "2000.50");
  assert.equal(whole.artifact.totals.priceSource, "defillama");

  const half = await collector.runOnce({
    watchlist: WATCHLIST, chainEndpoints: new Map([[1, FAKE_URL]]),
    call: okCall({ balance: "0x14d1120d7b160000" }), stablecoins: {}, nativePrices: { ethereum: 2.25 }, now: () => 0,
  });
  assert.equal(half.artifact.chains[0].addressRows[0].native.usd, "3.38", "1.5 * 2.25 = 3.375 rounds up");
});

test("a failed price call is fail-closed and keeps the artifact valid", async () => {
  const { artifact } = await collector.runOnce({
    watchlist: WATCHLIST, chainEndpoints: new Map([[1, FAKE_URL]]),
    call: stableCall({ tokenBalances: { USDC: "1000000" } }), stablecoins: USDC_ONLY,
    priceFetcher: async () => ({ ok: false, prices: {} }), now: () => 0,
  });
  const row = artifact.chains[0].addressRows[0];
  assert.equal(row.native.usd, null);
  assert.equal(row.totalUsd, null);
  assert.equal(row.stableUsdTotal, "1.00");
  assert.equal(artifact.totals.stableUsd, "1.00");
  assert.equal(artifact.totals.nativeUsd, null);
  assert.equal(artifact.totals.totalUsd, null);
  assert.equal(artifact.totals.priceSource, "unavailable");
  assert.equal(/https?:\/\//iu.test(JSON.stringify(artifact)), false);
});

test("totalUsd propagates null when the native leg is unpriced even if stables are priced", async () => {
  const { artifact } = await collector.runOnce({
    watchlist: WATCHLIST, chainEndpoints: new Map([[1, FAKE_URL]]),
    call: stableCall({ tokenBalances: { USDC: "1000000" } }), stablecoins: USDC_ONLY,
    nativePrices: {}, now: () => 0,
  });
  const row = artifact.chains[0].addressRows[0];
  assert.equal(row.stableUsdTotal, "1.00");
  assert.equal(row.native.usd, null);
  assert.equal(row.totalUsd, null);
  assert.equal(artifact.totals.stableUsd, "1.00");
  assert.equal(artifact.totals.totalUsd, null);
});

test("chains without an authoritative binding emit a sanitized warning", async () => {
  const { artifact } = await collector.runOnce({
    watchlist: WATCHLIST, chainEndpoints: new Map([[81457, FAKE_URL]]),
    call: okCall(), stablecoins: {}, nativePrices: {}, now: () => 0,
  });
  assert.equal(artifact.errors.some((row) => row.message === "STABLECOIN_UNBOUND:blast:no-authoritative-address"), true);
  assert.equal(JSON.stringify(artifact.errors).includes(FAKE_URL), false);
  assert.deepEqual(artifact.chains[0].addressRows[0].tokens, []);
});

test("fetchNativePrices parses the response, retries once, and never returns the URL", async () => {
  let calls = 0;
  const success = await collector.fetchNativePrices(["ethereum", "binancecoin"], {
    fetchImpl: async (url) => {
      calls += 1;
      assert.equal(/coins\.llama\.fi/u.test(url), true);
      return { ok: true, json: async () => ({ coins: { "coingecko:ethereum": { price: 2500 }, "coingecko:binancecoin": { price: 600 } } }) };
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(success, { ok: true, prices: { ethereum: 2500, binancecoin: 600 } });

  let attempts = 0;
  const failure = await collector.fetchNativePrices(["ethereum"], {
    fetchImpl: async () => { attempts += 1; throw new Error("network"); },
  });
  assert.equal(attempts, 2, "bounded to one retry");
  assert.deepEqual(failure, { ok: false, prices: {} });

  assert.deepEqual(await collector.fetchNativePrices([]), { ok: true, prices: {} });
  assert.equal(JSON.stringify(success).includes("http"), false);
});

// --- solana branch -------------------------------------------------------------------------

function solanaCall(overrides = {}) {
  const seen = [];
  const call = async (url, method, params) => {
    seen.push({ url, method });
    if (method === "getVersion") return { "solana-core": "1.18.0" };
    if (method === "getSlot") return overrides.slot === undefined ? 123456 : overrides.slot;
    if (method === "getBalance") {
      if (overrides.balance === null) throw new Error("balance boom");
      return { context: { slot: 123456 }, value: overrides.balance === undefined ? 2_000_000_000 : overrides.balance };
    }
    if (method === "getTokenAccountsByOwner") {
      const mint = params[1].mint;
      if (overrides.omitToken === mint) throw new Error("token boom");
      const amounts = overrides.tokens && overrides.tokens[mint];
      if (!amounts) return { context: { slot: 123456 }, value: [] };
      return {
        context: { slot: 123456 },
        value: amounts.map((amount) => ({ account: { data: { parsed: { info: { tokenAmount: { amount, decimals: 6 } } } } } })),
      };
    }
    return null;
  };
  call.seen = seen;
  return call;
}

test("watchlist family defaults to evm and accepts base58 solana with back-compat", () => {
  const { addresses, errors } = collector.validateWatchlist({
    schema: "watch-addresses/v1",
    addresses: [
      { label: "sol", address: SOL_ADDR, family: "solana" },
      { label: "e", address: A1 },
      { label: "badfam", address: A1, family: "cosmos" },
      { label: "badaddr", address: "not-base58", family: "solana" },
      { label: "dup", address: SOL_ADDR, family: "solana" },
    ],
  });
  assert.deepEqual(errors.map((row) => row.message), ["FAMILY_INVALID:2", "ADDRESS_INVALID:3", "ADDRESS_DUPLICATE:4"]);
  assert.deepEqual(addresses, [
    { label: "sol", address: SOL_ADDR, family: "solana" },
    { label: "e", address: A1, family: "evm" },
  ]);
  // Solana base58 is case-sensitive and preserved verbatim.
  assert.equal(addresses[0].address, SOL_ADDR);
});

test("base58 validation decodes 32 bytes and rejects invalid input", () => {
  const bytes = collector.base58Decode(SOL_ADDR);
  assert.equal(bytes.length, 32);
  assert.equal(collector.base58Decode("0OIl"), null);
  assert.equal(collector.normalizeSolanaAddress(SOL_ADDR), SOL_ADDR);
  assert.equal(collector.normalizeSolanaAddress("abc"), null, "too short");
  assert.equal(collector.normalizeSolanaAddress(USER), null, "EVM address is not base58");
  assert.equal(collector.familyOf({}), "evm");
  assert.equal(collector.familyOf({ family: "SOLANA" }), "solana");
});

test("loadSolanaEndpoints reads solana/helius lines in-process plus the fallback", () => {
  const fsImpl = {
    readFileSync: () => [
      "# comment",
      "SOLANA_RPC=https://solana.example.invalid/abc",
      "HELIUS=https://atlas.helius.invalid/def",
      "OTHER=https://eth.example.invalid/geth",
    ].join("\n"),
  };
  const urls = collector.loadSolanaEndpoints({ fsImpl });
  assert.ok(urls.includes("https://solana.example.invalid/abc"));
  assert.ok(urls.includes("https://atlas.helius.invalid/def"));
  assert.equal(urls.some((url) => url.includes("eth.example.invalid")), false);
  assert.ok(urls.includes(collector.SOLANA_PUBLIC_FALLBACK));
  assert.deepEqual(collector.loadSolanaEndpoints({ fsImpl: { readFileSync() { throw new Error("ENOENT"); } } }), [collector.SOLANA_PUBLIC_FALLBACK]);
});

test("collectSolana reads SOL and SPL balances, prices SOL, and derives totalUsd", async () => {
  const call = solanaCall({ tokens: { [USDC_MINT]: ["1500000"] } });
  const { rows, errors } = await collector.collectSolana({
    entries: [{ label: "sol", address: SOL_ADDR, family: "solana" }],
    urls: [FAKE_URL],
    call,
    now: () => 0,
    priceAvailable: true,
    nativePrices: { solana: 150 },
  });
  assert.deepEqual(errors, []);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.address, SOL_ADDR);
  assert.equal(row.label, "sol");
  assert.equal(row.slot, 123456);
  assert.deepEqual(row.native, { symbol: "SOL", raw: "2000000000", formatted: "2", usd: "300.00" });
  const usdc = row.tokens.find((token) => token.symbol === "USDC");
  assert.deepEqual(usdc, { symbol: "USDC", mint: USDC_MINT, decimals: 6, raw: "1500000", formatted: "1.5", usd: "1.50" });
  const usdt = row.tokens.find((token) => token.symbol === "USDT");
  assert.equal(usdt.raw, "0");
  assert.equal(usdt.usd, "0.00");
  assert.equal(row.stableUsdTotal, "1.50");
  assert.equal(row.totalUsd, "301.50");
  assert.equal(call.seen.some((entry) => entry.method === "getBalance"), true);
  assert.equal(call.seen.some((entry) => entry.method === "getTokenAccountsByOwner"), true);
  assert.equal(/https?:\/\//u.test(JSON.stringify(rows)), false);
});

test("collectSolana fails closed when no endpoint responds", async () => {
  const { rows, errors } = await collector.collectSolana({
    entries: [{ label: "sol", address: SOL_ADDR, family: "solana" }],
    urls: [FAKE_URL],
    call: async () => { throw new Error("down"); },
    now: () => 0,
    priceAvailable: false,
    nativePrices: {},
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].error, "SOLANA_RPC_UNAVAILABLE");
  assert.equal(rows[0].native, null);
  assert.deepEqual(errors, [{ scope: "solana", message: "SOLANA_RPC_UNAVAILABLE" }]);
});

test("collectSolana records a native read failure without dropping the row", async () => {
  const { rows } = await collector.collectSolana({
    entries: [{ label: "sol", address: SOL_ADDR, family: "solana" }],
    urls: [FAKE_URL],
    call: solanaCall({ balance: null, tokens: { [USDC_MINT]: ["1000000"] } }),
    now: () => 0,
    priceAvailable: true,
    nativePrices: { solana: 150 },
  });
  assert.equal(rows[0].error, "BALANCE_READ_FAILED");
  assert.equal(rows[0].native, null);
  assert.equal(rows[0].totalUsd, null);
  assert.equal(rows[0].stableUsdTotal, "1.00");
});

test("runOnce keeps the artifact EVM-compatible and adds a priced solana row", async () => {
  const { artifact } = await collector.runOnce({
    watchlist: {
      schema: "watch-addresses/v1",
      addresses: [
        { label: "evm", address: A1 },
        { label: "sol", address: SOL_ADDR, family: "solana" },
      ],
    },
    chainEndpoints: new Map([[1, FAKE_URL]]),
    call: okCall(),
    stablecoins: {},
    solanaUrls: [FAKE_URL],
    solanaCall: solanaCall({ tokens: { [USDC_MINT]: ["1000000"] } }),
    nativePrices: { ethereum: 2000, solana: 150 },
    now: () => 0,
  });
  assert.equal(artifact.addresses.length, 1, "the addresses field stays EVM-only");
  assert.equal(artifact.addresses[0].address, A1);
  assert.equal(artifact.solana.length, 1);
  assert.equal(artifact.solana[0].address, SOL_ADDR);
  assert.equal(artifact.solana[0].totalUsd, "301.00");
  assert.equal(artifact.totals.priceSource, "defillama");
  const text = JSON.stringify(artifact);
  assert.equal(/https?:\/\//u.test(text), false);
  assert.equal(/fake\.invalid|endpoint|authorization|api[_-]?key/iu.test(text), false);
});

test("parseSolanaTokenAmounts sums accounts and nativeUsdFromRaw honours decimals", () => {
  const parsed = collector.parseSolanaTokenAmounts({
    value: [
      { account: { data: { parsed: { info: { tokenAmount: { amount: "1000000", decimals: 6 } } } } } },
      { account: { data: { parsed: { info: { tokenAmount: { amount: "500000", decimals: 6 } } } } } },
    ],
  });
  assert.deepEqual(parsed, { raw: "1500000", decimals: 6 });
  assert.deepEqual(collector.parseSolanaTokenAmounts(null), { raw: null, decimals: null });
  assert.deepEqual(collector.parseSolanaTokenAmounts({ value: [] }), { raw: "0", decimals: null });
  assert.deepEqual(collector.parseSolanaTokenAmounts({ value: [{}] }), { raw: null, decimals: null });
  assert.equal(collector.nativeUsdFromRaw("2000000000", 150, 9), "300.00");
  assert.equal(collector.nativeUsdFromRaw("1000000000000000000", 2000), "2000.00", "18-decimal default is unchanged");
});

test("an unresolved SPL token makes a priced SOL row and portfolio incomplete", async () => {
  const { rows, errors } = await collector.collectSolana({
    entries: [{ address: SOL_ADDR, family: "solana" }], urls: [FAKE_URL],
    call: solanaCall({ omitToken: USDC_MINT }), now: () => 0,
    priceAvailable: true, nativePrices: { solana: 150 },
  });
  assert.equal(rows[0].native.usd, "300.00");
  assert.equal(rows[0].stableUsdTotal, null);
  assert.equal(rows[0].totalUsd, null);
  const artifact = collector.buildArtifact({
    addresses: [{ address: SOL_ADDR, family: "solana" }], chains: [], solana: rows,
    errors, durationMs: 1, priceAvailable: true, now: () => 0,
  });
  assert.equal(artifact.totals.totalUsd, null);
  assert.equal(artifact.totals.complete, false);
});

test("synthetic legacy watchlist stays valid under the family schema", () => {
  const value = WATCHLIST;
  const { addresses, errors } = collector.validateWatchlist(value);
  assert.deepEqual(errors, []);
  assert.equal(addresses.some((row) => row.address === A1 && row.family === "evm"), true);
});

test("one monotonic budget bounds qualification, pricing, metadata and configured family reads", async () => {
  let clock = 0;
  const seen = [];
  const record = (method, timeoutMs, signal) => {
    assert.ok(signal instanceof AbortSignal);
    assert.equal(timeoutMs, 200 - clock);
    seen.push(method);
    clock += 10;
  };
  const { artifact } = await collector.runOnce({
    watchlist: { schema: "watch-addresses/v1", addresses: [{ address: A1 }, { address: SOL_ADDR, family: "solana" }] },
    urls: [FAKE_URL], fallbacks: {}, chainIds: [1], stablecoins: USDC_ONLY,
    deadlineMs: 200, monotonicNow: () => clock, now: () => 0,
    call: async (url, method, params, timeoutMs, options) => {
      record(method, timeoutMs, options.signal);
      assert.equal(options.noFallback, true);
      return stableCall()(url, method, params);
    },
    priceFetcher: async (_ids, options) => {
      record("prices", options.timeoutMs, options.signal);
      return { ok: true, prices: { ethereum: 2000, solana: 150 } };
    },
    solanaUrls: [FAKE_URL], solanaTokens: [],
    solanaCall: async (url, method, params, timeoutMs, options) => {
      record(method, timeoutMs, options.signal);
      return solanaCall()(url, method, params);
    },
  });
  assert.deepEqual(seen, ["eth_chainId", "prices", "eth_call", "eth_call", "eth_blockNumber", "eth_getBalance", "eth_call", "getVersion", "getSlot", "getBalance"]);
  assert.equal(artifact.durationMs, 100);
  assert.equal(artifact.totals.complete, true);
  assert.equal(collector.RUN_DEADLINE_MS, 225000);
  assert.equal(collector.BOUNDED_CHAIN_IDS.length, 28);
});

test("zero budget never falls back to a default or launches any read", async () => {
  const forbidden = () => { assert.fail("read after deadline"); };
  assert.equal((await collector.enumerateChains({ deadlineMs: 0, call: forbidden, fsImpl: { readFileSync: forbidden } })).size, 0);
  const solana = await collector.collectSolana({ entries: [{ address: SOL_ADDR }], deadlineMs: 0, call: forbidden, fsImpl: { readFileSync: forbidden } });
  assert.equal(solana.rows[0].native, null);
  await assert.rejects(collector.runOnce({ deadlineMs: 0, fsImpl: { readFileSync: forbidden } }), { code: "TIMEOUT" });
});

for (const stopAt of ["qualification", "pricing", "metadata", "balance", "solana"]) {
  test(`budget exhaustion during ${stopAt} stops new reads`, async () => {
    let clock = 0;
    let expired = false;
    const check = (stage) => {
      assert.equal(expired, false, "no new work after exhausted budget");
      if (stage === stopAt) { clock = 50; expired = true; }
    };
    await assert.rejects(collector.runOnce({
      watchlist: { schema: "watch-addresses/v1", addresses: [{ address: A1 }, { address: SOL_ADDR, family: "solana" }] },
      urls: [FAKE_URL], fallbacks: {}, chainIds: [1], stablecoins: USDC_ONLY,
      deadlineMs: 50, monotonicNow: () => clock,
      call: async (url, method, params) => {
        check(method === "eth_chainId" ? "qualification" : method === "eth_getBalance" ? "balance" : method === "eth_call" ? "metadata" : "block");
        return stableCall()(url, method, params);
      },
      priceFetcher: async () => { check("pricing"); return { ok: true, prices: {} }; },
      solanaUrls: [FAKE_URL], solanaTokens: [],
      solanaCall: async (url, method, params) => { check("solana"); return solanaCall()(url, method, params); },
    }), { code: "TIMEOUT" });
    assert.equal(expired, true);
  });
}

test("unresolved requested chains cannot produce a falsely complete or zero portfolio", async () => {
  const { artifact } = await collector.runOnce({
    watchlist: WATCHLIST, urls: [], fallbacks: {}, chainIds: [1, 8453], nativePrices: {},
    call: () => assert.fail("no candidates"),
  });
  assert.deepEqual(artifact.errors, [{ scope: "chain-1", message: "NO_ENDPOINT" }, { scope: "chain-8453", message: "NO_ENDPOINT" }]);
  assert.equal(artifact.totals.complete, false);
  assert.equal(artifact.totals.stableUsd, null);
  assert.equal(artifact.totals.nativeUsd, null);
  assert.equal(artifact.totals.totalUsd, null);
});

test("wall-clock jumps do not change the monotonic work budget", async () => {
  let wall = 0;
  const timeouts = [];
  const { artifact } = await collector.runOnce({
    watchlist: WATCHLIST, chainEndpoints: new Map([[1, FAKE_URL]]), stablecoins: {}, nativePrices: {},
    now: () => wall, monotonicNow: () => 0, deadlineMs: 100,
    call: async (url, method, params, timeout) => { timeouts.push(timeout); wall += 1e9; return okCall()(url, method, params); },
  });
  assert.deepEqual(timeouts, [100, 100]);
  assert.equal(artifact.durationMs, 0);
});

test("CLI failures expose only fixed codes", () => {
  for (const [code, exitCode] of Object.entries(collector.EXIT_CODES)) assert.deepEqual(collector.cliFailure({ code }), { code, exitCode });
  assert.deepEqual(collector.cliFailure({ code: "https://private.invalid/credential" }), { code: "COLLECT_FAILED", exitCode: 1 });
});
