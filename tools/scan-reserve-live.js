#!/usr/bin/env node
// Read-only Reserve Protocol live scanner. Never prints RPC URLs.
const fs = require("fs");
const path = require("path");
const { ethers } = require("./node_modules/ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const TARGET = path.join(WORKSPACE, "targets", "reserve-protocol");
const DEPLOYED = path.join(TARGET, "docs", "deployed-addresses");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "reserve-live.json");

const ZERO = "0x0000000000000000000000000000000000000000";
const FIX = 10n ** 18n;
const FIX_MAX = (1n << 192n) - 1n;

const RTOKEN_DOCS = [
  { chainId: 1, chain: "mainnet", file: "1-eUSD.md", name: "eUSD" },
  { chainId: 1, chain: "mainnet", file: "1-ETH+.md", name: "ETH+" },
  { chainId: 1, chain: "mainnet", file: "1-hyUSD.md", name: "hyUSD" },
  { chainId: 1, chain: "mainnet", file: "1-USDC+.md", name: "USDC+" },
  { chainId: 1, chain: "mainnet", file: "1-USD3.md", name: "USD3" },
  { chainId: 1, chain: "mainnet", file: "1-dgnETH.md", name: "dgnETH" },
  { chainId: 8453, chain: "base", file: "8453-hyUSD.md", name: "hyUSD" },
  { chainId: 8453, chain: "base", file: "8453-Vaya.md", name: "Vaya" },
  { chainId: 8453, chain: "base", file: "8453-bsdETH.md", name: "bsdETH" },
];

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];

const RTOKEN_ABI = [
  ...ERC20_ABI,
  "function main() view returns (address)",
  "function basketsNeeded() view returns (uint192)",
  "function issuanceAvailable() view returns (uint256)",
  "function redemptionAvailable() view returns (uint256)",
  "function issuanceThrottleParams() view returns (tuple(uint256 amtRate,uint192 pctRate))",
  "function redemptionThrottleParams() view returns (tuple(uint256 amtRate,uint192 pctRate))",
];

const MAIN_ABI = [
  "function rToken() view returns (address)",
  "function stRSR() view returns (address)",
  "function assetRegistry() view returns (address)",
  "function basketHandler() view returns (address)",
  "function backingManager() view returns (address)",
  "function distributor() view returns (address)",
  "function furnace() view returns (address)",
  "function broker() view returns (address)",
  "function rsrTrader() view returns (address)",
  "function rTokenTrader() view returns (address)",
  "function rsr() view returns (address)",
  "function tradingPausedOrFrozen() view returns (bool)",
  "function issuancePausedOrFrozen() view returns (bool)",
  "function frozen() view returns (bool)",
  "function version() view returns (string)",
];

const ASSET_REGISTRY_ABI = [
  "function erc20s() view returns (address[])",
  "function size() view returns (uint256)",
  "function lastRefresh() view returns (uint48)",
  "function toAsset(address) view returns (address)",
  "function isRegistered(address) view returns (bool)",
];

const BASKET_HANDLER_ABI = [
  "function nonce() view returns (uint48)",
  "function timestamp() view returns (uint48)",
  "function lastCollateralized() view returns (uint48)",
  "function warmupPeriod() view returns (uint48)",
  "function reweightable() view returns (bool)",
  "function enableIssuancePremium() view returns (bool)",
  "function fullyCollateralized() view returns (bool)",
  "function isReady() view returns (bool)",
  "function status() view returns (uint8)",
  "function price(bool) view returns (uint192 low,uint192 high)",
  "function quantity(address) view returns (uint192)",
  "function quote(uint192,bool,uint8) view returns (address[] erc20s,uint256[] quantities)",
  "function getPrimeBasket() view returns (address[] erc20s,bytes32[] targetNames,uint192[] targetAmts)",
  "function getHistoricalBasket(uint48) view returns (address[] erc20s,uint256[] quantities)",
  "function getBackupConfig(bytes32) view returns (address[] erc20s,uint256 max)",
];

const TRADING_ABI = [
  "function maxTradeSlippage() view returns (uint192)",
  "function minTradeVolume() view returns (uint192)",
  "function trades(address) view returns (address)",
  "function tradesOpen() view returns (uint48)",
  "function tradesNonce() view returns (uint256)",
  "function tradingDelay() view returns (uint48)",
  "function backingBuffer() view returns (uint192)",
];

const BROKER_ABI = [
  "function batchTradeDisabled() view returns (bool)",
  "function dutchTradeDisabled(address) view returns (bool)",
  "function batchAuctionLength() view returns (uint48)",
  "function dutchAuctionLength() view returns (uint48)",
  "function batchTradeImplementation() view returns (address)",
  "function dutchTradeImplementation() view returns (address)",
  "function trustedFillerRegistry() view returns (address)",
  "function trustedFillerEnabled() view returns (bool)",
];

const ASSET_ABI = [
  "function erc20() view returns (address)",
  "function erc20Decimals() view returns (uint8)",
  "function isCollateral() view returns (bool)",
  "function price() view returns (uint192 low,uint192 high)",
  "function bal(address) view returns (uint192)",
  "function maxTradeVolume() view returns (uint192)",
  "function lastSave() view returns (uint48)",
  "function savedLowPrice() view returns (uint192)",
  "function savedHighPrice() view returns (uint192)",
  "function chainlinkFeed() view returns (address)",
  "function oracleError() view returns (uint192)",
  "function oracleTimeout() view returns (uint48)",
  "function maxOracleTimeout() view returns (uint48)",
  "function priceTimeout() view returns (uint48)",
  "function status() view returns (uint8)",
  "function targetName() view returns (bytes32)",
  "function refPerTok() view returns (uint192)",
  "function targetPerRef() view returns (uint192)",
  "function savedPegPrice() view returns (uint192)",
  "function whenDefault() view returns (uint256)",
  "function delayUntilDefault() view returns (uint48)",
  "function underlyingRefPerTok() view returns (uint192)",
];

const FEED_ABI = [
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
];

function extractRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function rpcCall(url, method, params, timeoutMs = 10_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctrl.signal,
    });
    const json = await res.json();
    return json.result ?? null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function resolveRpcPool() {
  const pool = {};
  const seen = new Set();
  for (const url of extractRpcUrls()) {
    const id = await rpcCall(url, "eth_chainId", [], 8000);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const chainId = parseInt(id, 16);
    if (chainId === 1 || chainId === 8453) pool[chainId] = url;
  }
  return pool;
}

async function getBlock(provider) {
  const b = await provider.getBlock("latest");
  return { number: Number(b.number), timestamp: Number(b.timestamp) };
}

async function tryCall(fn, fallback = null) {
  try {
    return await fn();
  } catch (_) {
    return fallback;
  }
}

function parseRTokenDoc(item) {
  const txt = fs.readFileSync(path.join(DEPLOYED, item.file), "utf8");
  const out = { ...item, components: {} };
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\|\s*([^|]+?)\s*\|\s*\[?(0x[a-fA-F0-9]{40})\]?/);
    if (!m) continue;
    const key = m[1].trim();
    if (["Contract", "---"].includes(key)) continue;
    out.components[key] = ethers.getAddress(m[2]);
  }
  out.rToken = out.components.RToken;
  return out;
}

function parseAssetDocs() {
  const map = {};
  for (const file of fs.readdirSync(DEPLOYED).filter((f) => /^(1|8453)-assets-.*\.md$/.test(f))) {
    const chainId = file.startsWith("8453-") ? 8453 : 1;
    const version = file.match(/assets-(.+)\.md$/)?.[1] || "unknown";
    const txt = fs.readFileSync(path.join(DEPLOYED, file), "utf8");
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\|\s*([^|]+?)\s*\|\s*\[?(0x[a-fA-F0-9]{40})\]?/);
      if (!m || m[1].trim() === "Contract") continue;
      const addr = ethers.getAddress(m[2]).toLowerCase();
      map[`${chainId}:${addr}`] = { name: m[1].trim(), version, file };
    }
  }
  return map;
}

function lowerSet(xs) {
  return new Set((xs || []).map((x) => String(x).toLowerCase()));
}

function bigStr(x) {
  if (x === null || x === undefined) return null;
  if (typeof x === "bigint") return x.toString();
  return String(x);
}

function fixStr(x, places = 6) {
  if (x === null || x === undefined) return null;
  const bi = BigInt(x);
  if (bi === FIX_MAX) return "FIX_MAX";
  const neg = bi < 0n;
  const v = neg ? -bi : bi;
  const whole = v / FIX;
  const frac = v % FIX;
  const scale = 10n ** BigInt(places);
  const shown = (frac * scale) / FIX;
  return `${neg ? "-" : ""}${whole}.${shown.toString().padStart(places, "0")}`.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function bytes32ToAscii(b) {
  if (!b || b === "0x") return null;
  try { return ethers.decodeBytes32String(b); } catch (_) { return b; }
}

function statusName(x) {
  return ["SOUND", "IFFY", "DISABLED"][Number(x)] ?? String(x);
}

function looksCurve(name) {
  return /(^cvx|^crv|curve|3pool|frabp|mim|crvusd)/i.test(name || "");
}

function looksERC4626(name) {
  return /(steak|re7|metamorpho|morpho|sDAI|sFRAX|yv)/i.test(name || "");
}

async function scanAsset(provider, block, ctx, erc20Addr, assetAddr, docsMeta, sets) {
  const erc20 = new ethers.Contract(erc20Addr, ERC20_ABI, provider);
  const asset = new ethers.Contract(assetAddr, ASSET_ABI, provider);
  const broker = new ethers.Contract(ctx.broker, BROKER_ABI, provider);
  const bm = new ethers.Contract(ctx.backingManager, TRADING_ABI, provider);
  const bh = new ethers.Contract(ctx.basketHandler, BASKET_HANDLER_ABI, provider);

  const symbol = await tryCall(() => erc20.symbol());
  const decimals = await tryCall(() => erc20.decimals());
  const balanceBacking = await tryCall(() => erc20.balanceOf(ctx.backingManager));
  const assetBalBacking = await tryCall(() => asset.bal(ctx.backingManager));
  const isCollateral = await tryCall(() => asset.isCollateral(), false);
  const price = await tryCall(() => asset.price());
  const chainlinkFeed = await tryCall(() => asset.chainlinkFeed());
  const oracleTimeout = await tryCall(() => asset.oracleTimeout());
  const maxOracleTimeout = await tryCall(() => asset.maxOracleTimeout());
  const lastSave = await tryCall(() => asset.lastSave());
  const quantity = await tryCall(() => bh.quantity(erc20Addr));
  const openTrade = await tryCall(() => bm.trades(erc20Addr));
  const dutchDisabled = await tryCall(() => broker.dutchTradeDisabled(erc20Addr));

  let feed = null;
  if (chainlinkFeed && chainlinkFeed !== ZERO) {
    const f = new ethers.Contract(chainlinkFeed, FEED_ABI, provider);
    const latest = await tryCall(() => f.latestRoundData());
    const feedDecimals = await tryCall(() => f.decimals());
    if (latest) {
      feed = {
        address: chainlinkFeed,
        decimals: feedDecimals === null ? null : Number(feedDecimals),
        answer: bigStr(latest.answer),
        updatedAt: Number(latest.updatedAt),
        ageSeconds: block.timestamp - Number(latest.updatedAt),
      };
    } else {
      feed = { address: chainlinkFeed, error: "latestRoundData failed" };
    }
  }

  let collateral = null;
  if (isCollateral) {
    collateral = {
      status: statusName(await tryCall(() => asset.status())),
      targetName: bytes32ToAscii(await tryCall(() => asset.targetName())),
      refPerTok: fixStr(await tryCall(() => asset.refPerTok())),
      targetPerRef: fixStr(await tryCall(() => asset.targetPerRef())),
      savedPegPrice: fixStr(await tryCall(() => asset.savedPegPrice())),
      whenDefault: bigStr(await tryCall(() => asset.whenDefault())),
      delayUntilDefault: bigStr(await tryCall(() => asset.delayUntilDefault())),
      underlyingRefPerTok: fixStr(await tryCall(() => asset.underlyingRefPerTok())),
    };
  }

  const docsName = docsMeta?.name || null;
  const riskName = docsName || symbol || "";
  const inCurrentBasket = sets.current.has(erc20Addr.toLowerCase());
  const inPrimeBasket = sets.prime.has(erc20Addr.toLowerCase());
  const riskTags = [];
  if (inCurrentBasket && looksCurve(riskName)) riskTags.push("active-curve-lp-pricing");
  if (inCurrentBasket && looksERC4626(riskName)) riskTags.push("active-erc4626-share-pricing");
  if (collateral?.status && collateral.status !== "SOUND") riskTags.push(`status-${collateral.status}`);
  if (feed?.ageSeconds !== undefined && oracleTimeout !== null && feed.ageSeconds > Number(oracleTimeout) + 300) riskTags.push("feed-stale-vs-timeout");
  if (price && BigInt(price.high) === FIX_MAX) riskTags.push("unpriced-high-FIX_MAX");
  if (openTrade && openTrade !== ZERO) riskTags.push("open-trade");
  if (dutchDisabled) riskTags.push("dutch-disabled");

  return {
    erc20: erc20Addr,
    symbol,
    decimals: decimals === null ? null : Number(decimals),
    asset: assetAddr,
    docs: docsMeta || null,
    isCollateral,
    inCurrentBasket,
    inPrimeBasket,
    currentQuantityTokPerBU: fixStr(quantity),
    backingBalanceRaw: bigStr(balanceBacking),
    backingBalanceTok: decimals === null || balanceBacking === null ? null : ethers.formatUnits(balanceBacking, decimals),
    backingBalanceFix: fixStr(assetBalBacking),
    price: price ? { low: fixStr(price.low), high: fixStr(price.high) } : null,
    maxTradeVolume: fixStr(await tryCall(() => asset.maxTradeVolume())),
    lastSave: bigStr(lastSave),
    savedLowPrice: fixStr(await tryCall(() => asset.savedLowPrice())),
    savedHighPrice: fixStr(await tryCall(() => asset.savedHighPrice())),
    oracleError: fixStr(await tryCall(() => asset.oracleError())),
    oracleTimeout: bigStr(oracleTimeout),
    maxOracleTimeout: bigStr(maxOracleTimeout),
    priceTimeout: bigStr(await tryCall(() => asset.priceTimeout())),
    feed,
    collateral,
    openTrade,
    dutchDisabled,
    riskTags,
  };
}

async function scanRToken(provider, block, rdoc, assetDocMap) {
  const rtoken = new ethers.Contract(rdoc.rToken, RTOKEN_ABI, provider);
  const mainAddr = await tryCall(() => rtoken.main(), rdoc.components.Main);
  const main = new ethers.Contract(mainAddr, MAIN_ABI, provider);

  const components = {
    main: mainAddr,
    rToken: rdoc.rToken,
    stRSR: await tryCall(() => main.stRSR(), rdoc.components.StRSR),
    assetRegistry: await tryCall(() => main.assetRegistry(), rdoc.components.AssetRegistry),
    basketHandler: await tryCall(() => main.basketHandler(), rdoc.components.BasketHandler),
    backingManager: await tryCall(() => main.backingManager(), rdoc.components.BackingManager),
    broker: await tryCall(() => main.broker(), rdoc.components.Broker),
    rsrTrader: await tryCall(() => main.rsrTrader(), rdoc.components.RSRTrader),
    rTokenTrader: await tryCall(() => main.rTokenTrader(), rdoc.components.RTokenTrader),
    distributor: await tryCall(() => main.distributor(), rdoc.components.Distributor),
    furnace: await tryCall(() => main.furnace(), rdoc.components.Furnace),
    rsr: await tryCall(() => main.rsr()),
  };

  const ar = new ethers.Contract(components.assetRegistry, ASSET_REGISTRY_ABI, provider);
  const bh = new ethers.Contract(components.basketHandler, BASKET_HANDLER_ABI, provider);
  const bm = new ethers.Contract(components.backingManager, TRADING_ABI, provider);
  const broker = new ethers.Contract(components.broker, BROKER_ABI, provider);

  const nonce = await tryCall(() => bh.nonce());
  const prime = await tryCall(() => bh.getPrimeBasket());
  const current = nonce === null ? null : await tryCall(() => bh.getHistoricalBasket(nonce));
  const quote = await tryCall(() => bh.quote(FIX, false, 2));
  const quotePremium = await tryCall(() => bh.quote(FIX, true, 2));
  const basketPriceNoPremium = await tryCall(() => bh.price(false));
  const basketPricePremium = await tryCall(() => bh.price(true));
  const erc20s = await tryCall(() => ar.erc20s(), []);

  const sets = {
    prime: lowerSet(prime?.erc20s || prime?.[0]),
    current: lowerSet(current?.erc20s || current?.[0] || quote?.erc20s || quote?.[0]),
  };

  const assets = [];
  for (const erc20 of erc20s) {
    const assetAddr = await tryCall(() => ar.toAsset(erc20));
    if (!assetAddr || assetAddr === ZERO) continue;
    const docsMeta = assetDocMap[`${rdoc.chainId}:${assetAddr.toLowerCase()}`];
    assets.push(await scanAsset(provider, block, components, erc20, assetAddr, docsMeta, sets));
  }

  const symbol = await tryCall(() => rtoken.symbol(), rdoc.name);
  const supply = await tryCall(() => rtoken.totalSupply());
  const decimals = await tryCall(() => rtoken.decimals(), 18);
  const activeAssets = assets.filter((a) => a.inCurrentBasket);
  const flags = assets.flatMap((a) => a.riskTags.map((tag) => `${a.symbol || a.erc20}:${tag}`));
  const tradesOpen = await tryCall(() => bm.tradesOpen());

  return {
    chainId: rdoc.chainId,
    chain: rdoc.chain,
    name: rdoc.name,
    symbol,
    rToken: rdoc.rToken,
    components,
    protocolVersion: await tryCall(() => main.version()),
    block,
    supplyRaw: bigStr(supply),
    supply: supply === null ? null : ethers.formatUnits(supply, decimals),
    basketsNeeded: fixStr(await tryCall(() => rtoken.basketsNeeded())),
    issuanceAvailableRaw: bigStr(await tryCall(() => rtoken.issuanceAvailable())),
    redemptionAvailableRaw: bigStr(await tryCall(() => rtoken.redemptionAvailable())),
    paused: {
      tradingPausedOrFrozen: await tryCall(() => main.tradingPausedOrFrozen()),
      issuancePausedOrFrozen: await tryCall(() => main.issuancePausedOrFrozen()),
      frozen: await tryCall(() => main.frozen()),
    },
    basket: {
      nonce: bigStr(nonce),
      lastCollateralized: bigStr(await tryCall(() => bh.lastCollateralized())),
      timestamp: bigStr(await tryCall(() => bh.timestamp())),
      warmupPeriod: bigStr(await tryCall(() => bh.warmupPeriod())),
      reweightable: await tryCall(() => bh.reweightable()),
      enableIssuancePremium: await tryCall(() => bh.enableIssuancePremium()),
      fullyCollateralized: await tryCall(() => bh.fullyCollateralized()),
      isReady: await tryCall(() => bh.isReady()),
      status: statusName(await tryCall(() => bh.status())),
      priceNoPremium: basketPriceNoPremium
        ? { low: fixStr(basketPriceNoPremium.low), high: fixStr(basketPriceNoPremium.high) }
        : null,
      priceWithPremium: basketPricePremium
        ? { low: fixStr(basketPricePremium.low), high: fixStr(basketPricePremium.high) }
        : null,
      prime: prime ? {
        erc20s: Array.from(prime.erc20s || prime[0]),
        targetNames: Array.from(prime.targetNames || prime[1]).map(bytes32ToAscii),
        targetAmts: Array.from(prime.targetAmts || prime[2]).map((x) => fixStr(x)),
      } : null,
      current: current ? {
        erc20s: Array.from(current.erc20s || current[0]),
        quantities: Array.from(current.quantities || current[1]).map(bigStr),
      } : null,
      quoteOneBU: quote ? {
        erc20s: Array.from(quote.erc20s || quote[0]),
        quantities: Array.from(quote.quantities || quote[1]).map(bigStr),
      } : null,
      quoteOneBUPremium: quotePremium ? {
        erc20s: Array.from(quotePremium.erc20s || quotePremium[0]),
        quantities: Array.from(quotePremium.quantities || quotePremium[1]).map(bigStr),
      } : null,
    },
    trading: {
      maxTradeSlippage: fixStr(await tryCall(() => bm.maxTradeSlippage())),
      minTradeVolume: fixStr(await tryCall(() => bm.minTradeVolume())),
      tradingDelay: bigStr(await tryCall(() => bm.tradingDelay())),
      backingBuffer: fixStr(await tryCall(() => bm.backingBuffer())),
      tradesOpen: bigStr(tradesOpen),
      tradesNonce: bigStr(await tryCall(() => bm.tradesNonce())),
      batchTradeDisabled: await tryCall(() => broker.batchTradeDisabled()),
      batchAuctionLength: bigStr(await tryCall(() => broker.batchAuctionLength())),
      dutchAuctionLength: bigStr(await tryCall(() => broker.dutchAuctionLength())),
      batchTradeImplementation: await tryCall(() => broker.batchTradeImplementation()),
      dutchTradeImplementation: await tryCall(() => broker.dutchTradeImplementation()),
      trustedFillerRegistry: await tryCall(() => broker.trustedFillerRegistry()),
      trustedFillerEnabled: await tryCall(() => broker.trustedFillerEnabled()),
    },
    assetRegistry: {
      address: components.assetRegistry,
      size: bigStr(await tryCall(() => ar.size())),
      lastRefresh: bigStr(await tryCall(() => ar.lastRefresh())),
    },
    activeAssets: activeAssets.map((a) => ({
      symbol: a.symbol,
      erc20: a.erc20,
      asset: a.asset,
      docs: a.docs,
      quantity: a.currentQuantityTokPerBU,
      status: a.collateral?.status || null,
      price: a.price,
      feedAgeSeconds: a.feed?.ageSeconds ?? null,
      backingBalanceTok: a.backingBalanceTok,
      riskTags: a.riskTags,
    })),
    assets,
    flags,
  };
}

async function main() {
  const rpcs = await resolveRpcPool();
  const assetDocMap = parseAssetDocs();
  const rtokens = RTOKEN_DOCS.map(parseRTokenDoc).filter((x) => x.rToken);
  const providers = {};
  const blocks = {};
  for (const chainId of [1, 8453]) {
    if (!rpcs[chainId]) continue;
    providers[chainId] = new ethers.JsonRpcProvider(rpcs[chainId]);
    blocks[chainId] = await getBlock(providers[chainId]);
  }

  const results = [];
  for (const rdoc of rtokens) {
    const provider = providers[rdoc.chainId];
    if (!provider) {
      results.push({ ...rdoc, error: `missing RPC for chain ${rdoc.chainId}` });
      continue;
    }
    try {
      const res = await scanRToken(provider, blocks[rdoc.chainId], rdoc, assetDocMap);
      results.push(res);
      const active = res.activeAssets.map((a) => `${a.symbol || "?"}${a.riskTags.length ? "[" + a.riskTags.join(",") + "]" : ""}`).join(", ");
      console.log(`${res.chain}:${res.name} ${res.symbol} supply=${Number(res.supply || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} status=${res.basket.status} ready=${res.basket.isReady} reweightable=${res.basket.reweightable} tradesOpen=${res.trading.tradesOpen} basket=${active || "<empty>"}`);
      if (res.flags.length) console.log(`  flags: ${res.flags.join("; ")}`);
    } catch (e) {
      results.push({ ...rdoc, error: e.message });
      console.log(`${rdoc.chain}:${rdoc.name} scan failed: ${e.message}`);
    }
  }

  const out = {
    generatedAt: new Date().toISOString(),
    repo: "targets/reserve-protocol",
    commit: "9cda9d89",
    blocks,
    rtokens: results,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`Wrote ${path.relative(WORKSPACE, OUT)}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
