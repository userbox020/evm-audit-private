#!/usr/bin/env node
// scan-alpaca-finance-2-phase0.js - bounded read-only Phase 0 for Alpaca Finance 2.0 on BNB Chain.
// RPC URLs are resolved in memory only. Never prints/stores RPC URLs, private keys, execution calldata, or signed actions.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");
const { rpcCall, resolveRpc, getImpl } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "alpaca-finance-2-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "alpaca-finance-2-phase0-triage.md");
const PUBLIC_TARGETS = path.join(WORKSPACE, "reports", "raw", "fast", "public-audit-target-discovery.json");
const REPORTS_DIR = path.join(WORKSPACE, "reports");
const QUIET = process.argv.includes("--quiet");

const SIGNAL_DORMANT = "\uD83D\uDFE2 DORMANT";
const CHAIN_ID = 56;
const CHAIN = "BNB Chain";
const GECKO_NETWORK = "bsc";
const ZERO = "0x0000000000000000000000000000000000000000";
const MATERIAL_USD = Number(process.env.ALPACA_V2_MATERIAL_USD || "10000");
const MATERIAL_BORROWER_USD = Number(process.env.ALPACA_V2_MATERIAL_BORROWER_USD || "1000");
const ORACLE_DIVERGENCE_BPS = Number(process.env.ALPACA_V2_ORACLE_DIVERGENCE_BPS || "300");
const NEAR_LIQUIDATION_BPS = Number(process.env.ALPACA_V2_NEAR_LIQUIDATION_BPS || "250");
const LOG_BLOCKS = Number(process.env.ALPACA_V2_LOG_BLOCKS || "100000");
const MAX_POSITION_SAMPLE = Number(process.env.ALPACA_V2_MAX_POSITION_SAMPLE || "80");
const MAX_LOCAL_JOINS = Number(process.env.ALPACA_V2_MAX_LOCAL_JOINS || "120");

const CONFIG_URLS = [
  { label: "defillama-adapter-upstream", url: "https://raw.githubusercontent.com/alpaca-finance/alpaca-v2-money-market/main/.mainnet.json" },
  { label: "public-github-mirror", url: "https://raw.githubusercontent.com/loopyluffy/alpaca-v2-money-market/main/.mainnet.json" },
];

const STATIC_CONFIG = {
  proxyAdmin: "0x5379F32C8D5F663EACb61eeF63F722950294f452",
  nativeRelayer: "0xE1D2CA01bc88F325fF7266DD2165944f3CAf0D3D",
  timelock: "0x2D5408f2287BF9F9B05404794459a846651D0a59",
  opMultiSig: "0x18F59e8dDDef9e000863082a37fc56a2a5475D01",
  usdPlaceholder: "0x115dffFFfffffffffFFFffffFFffFfFfFFFFfFff",
  oracle: {
    alpacaV2Oracle02: "0xB265D1b4eb6Fc969B7C23eBa3A2d661C4c09E143",
    oracleMedianizer: "0x553b8adc2Ac16491Ec57239BeA7191719a2B880c",
  },
  moneyMarket: {
    moneyMarketDiamond: "0x7389aaf2e32872cABD766D0CEB384220e8F2A590",
    facets: {
      adminFacet: "0x7232A9E4C156d5828B5660353fBe5e6bE7F9d674",
      borrowFacet: "0xdE6F41147Ab3749d1f8E82d267A1FfD8e7599A5D",
      collateralFacet: "0x8cE125c65605f937AE16645a3642d3A335852936",
      diamondCutFacet: "0x2E28CbF8995969d4ea1F03FfB6f25dab8afEE45C",
      diamondLoupeFacet: "0xaDB5Be7b114Ca6721e00778F97e615B85D095952",
      flashloanFacet: "0xC934E6332f3af8B27da447eDa0273bd3867efAF2",
      lendFacet: "0x0d8AE68ee3eE728Ed7AE9E99Edc10f2cfc3959b1",
      liquidationFacet: "0x891D268a3Adc285BAa1A8d8704167A865e76446f",
      nonCollatBorrowFacet: "0xF22133299081534780777D1504A6B38955195b03",
      ownershipFacet: "0x09E6Fb57dfB952D44D915a335c29A7F485Df4CDE",
      viewFacet: "0xD53DEeFe0d1F5f0e2476044bdDfC399e50032345",
    },
    interestBearingTokenImplementation: "0x7f5EfBA7Fc83B69445Bbc704A2C5a03c66550425",
    debtTokenImplementation: "0xbAdedB738a08fe68b7a1c0038F64D62656D0d5D7",
    accountManager: { implementation: "0x456b43F8D71cA6666ca5eC848254D6E0A076Bc4e", proxy: "0xD20B887654dB8dC476007bdca83d22Fa51e93407" },
    repurchaser: "0x40d48e2fe8a9f65b114fd85489fda955dfe86c35",
    markets: [
      ["WBNB", "COLLATERAL", "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", "0x2928623eFF453Fb8C9BC744041637a4D2D5Fc56b", "0x855894fe37CFaeE188A1acCc5dd4b38d504F09E9", "0xe44bDd3f0b69f2c294A0250825BCF31eE3af4314"],
      ["USDC", "COLLATERAL", "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", "0x547593f6aFa897bb05828FBb8D587Ca31D9fF519", "0x049C15F84850FC0d76eFe3b0940a44fC3edD6e2E", "0x4132392C57B9D2DE1BA393A03f23Fcb880Bf8EE1"],
      ["USDT", "COLLATERAL", "0x55d398326f99059fF775485246999027B3197955", "0x90476BFEF61F190b54a439E2E98f8E43Fb9b4a45", "0xd9D0a0B8B9dc0f845797B678F00c6d7FAD577B56", "0x4132392C57B9D2DE1BA393A03f23Fcb880Bf8EE1"],
      ["BUSD", "COLLATERAL", "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56", "0x3f38BA29AcC107E6F0b059a17c9bAb0598d0f249", "0x7ffbcda33cD2F7812f9Da4c1189E745379F95B79", "0x4132392C57B9D2DE1BA393A03f23Fcb880Bf8EE1"],
      ["BTCB", "COLLATERAL", "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c", "0x6C9Cb3739d6B390A4BAcc4D5F0a2629cF5c383B3", "0x457a325E5c63aE73F684d9477826e07F56da749B", "0x89c53B34b5E6A1D0b2922941749e9Ee05ce58b42"],
      ["ETH", "COLLATERAL", "0x2170Ed0880ac9A755fd29B2688956BD959F933F8", "0x0A4FE32De91bE99a3EFAC80F6576976293B95369", "0x57496afdB38A0da228046c93695778c757075dEa", "0x89c53B34b5E6A1D0b2922941749e9Ee05ce58b42"],
      ["HIGH", "CROSS", "0x5f4Bde007Dc06b867f86EBFE4802e34A1fFEEd63", "0x0c9E2653B17b60E9aD9465D1cF478bD6d76a03F0", "0xeB27c21EBA6765608681ec96B0d9F697726884DA", "0xe44bDd3f0b69f2c294A0250825BCF31eE3af4314"],
      ["Cake", "COLLATERAL", "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82", "0x848204278E491f5f15B3F2dce593e6af9552b372", "0xE0ECA72bEe09695C82d9DD5422267270495eA0c2", "0xe44bDd3f0b69f2c294A0250825BCF31eE3af4314"],
      ["XRP", "COLLATERAL", "0x1D2F0da169ceB9fC7B3144628dB156f3F6c60dBE", "0xACb41b8bddF67727F07bf375b01edC40Ed51c4ff", "0x9c04F5D68fc754D79fBCAc8fC56469C0264F85DC", "0x89c53B34b5E6A1D0b2922941749e9Ee05ce58b42"],
      ["DOGE", "COLLATERAL", "0xbA2aE424d960c26247Dd6c32edC70B295c744C43", "0x72Ad41ecf9C6C1171F19FaCCBA2b347D64AFe57f", "0xBda539AFD66fEE61499B22769E4e413dc158f271", "0xe44bDd3f0b69f2c294A0250825BCF31eE3af4314"],
      ["LTC", "COLLATERAL", "0x4338665CBB7B2485A8855A139b75D5e34AB0DB94", "0x42b2D846785636CfB393b5EC48C6581f47c37EC3", "0x22c583069619eA08F260758E34Bc525B5833d11b", "0xe44bDd3f0b69f2c294A0250825BCF31eE3af4314"],
      ["THE", "ISOLATE", "0xF4C8E32EaDEC4BFe97E0F595AdD0f4450a863a11", "0x91E3A9B3f5a2c02Dd5cd40733fe4d52a87A213d9", "0x2C8A7592828007eF33D87B49732F174D9A0b6759", "0xe44bDd3f0b69f2c294A0250825BCF31eE3af4314"],
    ].map(([name, tier, token, ibToken, debtToken, interestModel]) => ({ name, tier, token, ibToken, debtToken, interestModel })),
  },
  miniFL: { proxy: "0x4579587AE043131999cE3d9C66199726972E3Fb7" },
  moneyMarketReader: "0x4913DEC75cC0e061Ba78ebbDb2584905760be4C6",
  sharedStrategies: { pancakeswap: { strategyLiquidateIb: "0xa70bc3Ef35382f1222A75fBA9BDD413a9F21Ab7b", strategyLiquidateIbV3: "0x980d31235aFfAad592f59b21B0c49B932E7a68A0" } },
  yieldSources: { pancakeSwap: { routerV2: "0x10ED43C718714eb63d5aA57B78B54704E256024E", routerV3: "0x1b81D678ffb9C0263b24A97847620C99d213eB14", factoryV3: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865" } },
};

const ERC20 = new ethers.Interface([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const BYTES32_TOKEN = new ethers.Interface(["function symbol() view returns (bytes32)", "function name() view returns (bytes32)"]);
const OWNABLE = new ethers.Interface(["function owner() view returns (address)"]);
const DIAMOND_LOUPE = new ethers.Interface([
  "function facetAddresses() view returns (address[])",
  "function facetFunctionSelectors(address) view returns (bytes4[])",
]);
const VIEW = new ethers.Interface([
  "function getTokenConfig(address) view returns ((uint8,uint16,uint16,uint64,uint256,uint256))",
  "function getIbTokenFromToken(address) view returns (address)",
  "function getDebtTokenFromToken(address) view returns (address)",
  "function getProtocolReserve(address) view returns (uint256)",
  "function getFloatingBalance(address) view returns (uint256)",
  "function getGlobalDebtValue(address) view returns (uint256)",
  "function getGlobalDebtValueWithPendingInterest(address) view returns (uint256)",
  "function getOverCollatTokenDebt(address) view returns (uint256,uint256)",
  "function getNonCollatTokenDebt(address) view returns (uint256)",
  "function getDebtLastAccruedAt(address) view returns (uint256)",
  "function getOverCollatInterestRate(address) view returns (uint256)",
  "function getOverCollatInterestModel(address) view returns (address)",
  "function getTotalCollat(address) view returns (uint256)",
  "function getLiquidationParams() view returns (uint16,uint16)",
  "function getMinDebtSize() view returns (uint256)",
  "function getFeeParams() view returns (uint16,uint16,uint16)",
  "function getFlashloanParams() view returns (uint16,uint16,address)",
  "function getOracle() view returns (address)",
  "function getMiniFL() view returns (address)",
  "function getMiniFLPoolIdOfToken(address) view returns (uint256)",
  "function isLiquidationStratOk(address) view returns (bool)",
  "function isLiquidatorOk(address) view returns (bool)",
  "function isAccountManagersOk(address) view returns (bool)",
  "function isRiskManagersOk(address) view returns (bool)",
  "function isOperatorsOk(address) view returns (bool)",
]);
const READER = new ethers.Interface([
  "function moneyMarket() view returns (address)",
  "function getPriceUSD(address) view returns (uint256)",
  "function getMarketMetadata(address) view returns ((address,address,(uint8,uint16,uint16,uint256,uint256),(uint8,uint16,uint16,uint256,uint256)))",
  "function getMarketStats(address) view returns ((uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256))",
  "function getMarketPriceInfo(address) view returns ((uint256,uint256,uint256))",
  "function getAlpacaGuardStatuses(address[]) view returns ((address,bool)[])",
  "function getSubAccountSummary(address,uint256) view returns ((uint256,uint256,uint256,uint256,uint256,(address,address,uint256,uint256,uint256,uint16)[],(address,uint256,uint256,uint256,uint16)[]))",
]);
const ORACLE02 = new ethers.Interface([
  "function getTokenPrice(address) view returns (uint256,uint256)",
  "function oracle() view returns (address)",
  "function specificOracles(address) view returns (address)",
]);
const MEDIANIZER = new ethers.Interface([
  "function getPrice(address,address) view returns (uint256,uint256)",
  "function primarySourceCount(address,address) view returns (uint256)",
  "function primarySources(address,address,uint256) view returns (address)",
  "function maxPriceDeviations(address,address) view returns (uint256)",
  "function maxPriceStales(address,address) view returns (uint256)",
]);
const PRICE_SOURCE = new ethers.Interface(["function getPrice(address,address) view returns (uint256,uint256)"]);

const LOG_OVER_COLLAT_BORROW = ethers.id("LogOverCollatBorrow(address,address,address,uint256,uint256,uint256)");
const LOG_ADD_COLLATERAL = ethers.id("LogAddCollateral(address,address,address,address,uint256)");
const LOG_LIQUIDATE = ethers.id("LogLiquidate(address,address,address,uint256,address,address,uint256,uint256,uint256)");
const LOG_REPURCHASE = ethers.id("LogRepurchase(address,address,uint256,address,address,uint256,uint256,uint256,uint256)");

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readText(file) { try { return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""; } catch (_) { return ""; } }
function readJson(file, fallback = null) { try { const t = readText(file).replace(/^\uFEFF/, ""); return t ? JSON.parse(t) : fallback; } catch (_) { return fallback; } }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function normalizeAddress(value) { try { return ethers.getAddress(String(value || "").replace(/^0X/, "0x")); } catch (_) { return null; } }
function lowerAddress(value) { const a = normalizeAddress(value); return a ? a.toLowerCase() : null; }
function nonZeroAddress(value) { const a = normalizeAddress(value); return a && lowerAddress(a) !== lowerAddress(ZERO) ? a : null; }
function strip0x(value) { return String(value || "").replace(/^0x/i, ""); }
function safeText(value, max = 160) { return String(value ?? "").replace(/https?:\/\/\S+/g, "[redacted-url]").replace(/0x[a-fA-F0-9]{120,}/g, "[redacted-calldata]").replace(/\s+/g, " ").trim().slice(0, max) || null; }
function shaRef(value) { return crypto.createHash("sha256").update(String(value || "").toLowerCase()).digest("hex").slice(0, 16); }
function toBig(value) { try { return BigInt(value ?? 0); } catch (_) { return 0n; } }
function units(value, decimals = 18) { try { return Number(ethers.formatUnits(toBig(value), Number(decimals ?? 18))); } catch (_) { return null; } }
function usd(raw, decimals, price) { const amount = units(raw, decimals); const p = Number(price); return amount === null || !Number.isFinite(p) ? null : amount * p; }
function round(value, decimals = 4) { const n = Number(value); if (!Number.isFinite(n)) return null; const f = 10 ** decimals; return Math.round(n * f) / f; }
function fmt(value, decimals = 2) { const n = Number(value); return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: decimals }) : "n/a"; }
function fmtUsd(value) { const n = Number(value); return Number.isFinite(n) ? `$${Math.round(n).toLocaleString()}` : "n/a"; }
function rel(file) { return path.relative(WORKSPACE, file).replace(/\\/g, "/"); }
function bpsDiff(a, b) { const x = Number(a); const y = Number(b); return Number.isFinite(x) && Number.isFinite(y) && y !== 0 ? round(((x - y) / y) * 10000, 2) : null; }
function hexBlock(value) { return `0x${BigInt(value).toString(16)}`; }
function topicAddress(topic) { return topic && topic.length >= 66 ? normalizeAddress(`0x${topic.slice(-40)}`) : null; }
function compactAddress(value) { const a = normalizeAddress(value); return a ? `${a.slice(0, 6)}...${a.slice(-4)}` : "n/a"; }
function tokenKey(addr) { return `bsc:${String(addr || "").toLowerCase()}`; }
function stableFallback(symbol) { return /^(USDC|USDT|BUSD|TUSD)$/i.test(String(symbol || "")) ? 1 : null; }

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

async function fetchJson(url, timeoutMs = 25_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-alpaca-v2-phase0/1.0" } });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
    return { ok: res.ok, status: res.status, json, error: res.ok ? null : safeText(text || `HTTP ${res.status}`, 160) };
  } catch (error) {
    return { ok: false, status: null, json: null, error: safeText(error?.message || error, 160) };
  } finally { clearTimeout(timer); }
}

async function safeCall(rpc, to, iface, fn, args = [], timeoutMs = 12_000) {
  const addr = normalizeAddress(to);
  if (!rpc || !addr || !iface) return null;
  try {
    const raw = await rpcCall(rpc, "eth_call", [{ to: addr, data: iface.encodeFunctionData(fn, args) }, "latest"], timeoutMs);
    if (!raw || raw === "0x") return null;
    return iface.decodeFunctionResult(fn, raw);
  } catch (_) { return null; }
}

async function getCode(rpc, address) {
  const addr = normalizeAddress(address);
  if (!rpc || !addr) return "0x";
  return await rpcCall(rpc, "eth_getCode", [addr, "latest"], 10_000).catch(() => "0x") || "0x";
}

async function addressKind(rpc, address) {
  const addr = normalizeAddress(address);
  if (!addr) return "invalid";
  const code = await getCode(rpc, addr);
  return code && code !== "0x" ? "contract" : "eoa-or-empty";
}

async function latestBlock(rpc) {
  const hex = await rpcCall(rpc, "eth_blockNumber", [], 8_000).catch(() => null);
  const block = hex ? await rpcCall(rpc, "eth_getBlockByNumber", [hex, false], 8_000).catch(() => null) : null;
  return { number: hex ? Number(BigInt(hex)) : null, timestamp: block?.timestamp ? Number(BigInt(block.timestamp)) : null };
}

function decodeBytes32String(value) { try { return value && value !== "0x" ? safeText(ethers.decodeBytes32String(value), 80) : null; } catch (_) { return null; } }

async function tokenBasics(rpc, token, fallback = {}) {
  const addr = normalizeAddress(token);
  if (!addr) return null;
  const [code, decimals, symbol, symbolBytes, name, nameBytes, totalSupply] = await Promise.all([
    getCode(rpc, addr),
    safeCall(rpc, addr, ERC20, "decimals"),
    safeCall(rpc, addr, ERC20, "symbol"),
    safeCall(rpc, addr, BYTES32_TOKEN, "symbol"),
    safeCall(rpc, addr, ERC20, "name"),
    safeCall(rpc, addr, BYTES32_TOKEN, "name"),
    safeCall(rpc, addr, ERC20, "totalSupply"),
  ]);
  return {
    chainId: CHAIN_ID,
    chain: CHAIN,
    address: addr,
    symbol: safeText(symbol?.[0], 40) || decodeBytes32String(symbolBytes?.[0]) || fallback.symbol || fallback.name || null,
    name: safeText(name?.[0], 100) || decodeBytes32String(nameBytes?.[0]) || fallback.name || null,
    decimals: decimals?.[0] === undefined ? 18 : Number(decimals[0]),
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    totalSupplyRaw: totalSupply?.[0] === undefined ? null : totalSupply[0].toString(),
    priceKey: tokenKey(addr),
  };
}

async function loadPrices(keys) {
  const out = {};
  const unique = [...new Set(keys.filter(Boolean).map((k) => String(k).toLowerCase()))];
  for (let i = 0; i < unique.length; i += 80) {
    const chunk = unique.slice(i, i + 80);
    const res = await fetchJson(`https://coins.llama.fi/prices/current/${chunk.join(",")}?searchWidth=6h`, 25_000);
    for (const [key, row] of Object.entries(res.json?.coins || {})) {
      const price = Number(row?.price);
      if (Number.isFinite(price)) out[key.toLowerCase()] = price;
    }
  }
  return out;
}

async function geckoPools(tokenAddress) {
  const addr = normalizeAddress(tokenAddress);
  if (!addr) return { ok: false, status: null, pools: [], error: "invalid-token" };
  const res = await fetchJson(`https://api.geckoterminal.com/api/v2/networks/${GECKO_NETWORK}/tokens/${addr}/pools?page=1`, 25_000);
  const pools = (res.json?.data || []).slice(0, 10).map((row) => {
    const a = row.attributes || {};
    return {
      address: row.id || null,
      name: safeText(a.name, 120),
      dex: safeText(a.dex_id || a.dex || null, 60),
      reserveUsd: Number(a.reserve_in_usd || a.reserve_usd || 0) || 0,
      baseTokenPriceUsd: a.base_token_price_usd === undefined ? null : Number(a.base_token_price_usd),
      quoteTokenPriceUsd: a.quote_token_price_usd === undefined ? null : Number(a.quote_token_price_usd),
      volume24hUsd: a.volume_usd?.h24 === undefined ? null : Number(a.volume_usd.h24),
    };
  });
  return { ok: res.ok, status: res.status, pools, error: res.error };
}

async function protocolMetadata() {
  const live = await fetchJson("https://api.llama.fi/protocol/alpaca-finance-2.0", 35_000);
  const discovery = readJson(PUBLIC_TARGETS, {});
  const rows = [
    ...(discovery.phase0Queue || []),
    ...(discovery.protocolCandidates || []),
    ...(discovery.targetedRefreshQueue || []),
    ...(discovery.consumerJoinFirst || []),
  ];
  const row = rows.find((p) => p?.slug === "alpaca-finance-2.0" || p?.name === "Alpaca Finance 2.0");
  const json = live.json || {};
  const bnbTvl = Number(json.currentChainTvls?.Binance ?? json.currentChainTvls?.BSC ?? row?.tvlUsd ?? 0) || null;
  return {
    name: json.name || row?.name || "Alpaca Finance 2.0",
    slug: json.slug || row?.slug || "alpaca-finance-2.0",
    category: json.category || row?.category || "Lending",
    chains: json.chains || row?.chains || ["Binance"],
    module: json.module || null,
    tvlUsd: round(json.tvl ?? row?.tvlUsd, 2),
    bnbTvlUsd: round(bnbTvl, 2),
    borrowedUsd: round(json.currentChainTvls?.borrowed ?? json.borrowed ?? null, 2),
    adapterCodePath: json.tvlCodePath || null,
    metadataSource: live.ok ? "defillama-protocol-api" : row ? "public-target-discovery" : "fallback",
    metadataError: live.ok ? null : live.error,
  };
}

async function loadConfig() {
  const attempts = [];
  for (const source of CONFIG_URLS) {
    const res = await fetchJson(source.url, 25_000);
    attempts.push({ label: source.label, ok: res.ok, status: res.status, error: res.error });
    if (res.ok && res.json?.moneyMarket?.moneyMarketDiamond && Array.isArray(res.json.moneyMarket.markets)) {
      return { config: res.json, source: source.label, attempts, fallbackUsed: false };
    }
  }
  return { config: STATIC_CONFIG, source: "static-embedded-fallback", attempts, fallbackUsed: true };
}

function decodeTokenConfig(raw) {
  const v = raw?.[0] !== undefined && Array.isArray(raw[0]) ? raw[0] : raw;
  if (!v) return null;
  return {
    tierId: Number(v.tier ?? v[0] ?? 0),
    tier: ["UNLISTED", "ISOLATE", "CROSS", "COLLATERAL"][Number(v.tier ?? v[0] ?? 0)] || String(v.tier ?? v[0] ?? "unknown"),
    collateralFactorBps: Number(v.collateralFactor ?? v[1] ?? 0),
    borrowingFactorBps: Number(v.borrowingFactor ?? v[2] ?? 0),
    to18ConversionFactor: (v.to18ConversionFactor ?? v[3] ?? null)?.toString?.() ?? null,
    maxCollateralRaw: (v.maxCollateral ?? v[4] ?? null)?.toString?.() ?? null,
    maxBorrowRaw: (v.maxBorrow ?? v[5] ?? null)?.toString?.() ?? null,
  };
}

function decodeReaderTokenConfig(raw) {
  if (!raw) return null;
  return {
    tierId: Number(raw.tier ?? raw[0] ?? 0),
    tier: ["UNLISTED", "ISOLATE", "CROSS", "COLLATERAL"][Number(raw.tier ?? raw[0] ?? 0)] || String(raw.tier ?? raw[0] ?? "unknown"),
    collateralFactorBps: Number(raw.collateralFactor ?? raw[1] ?? 0),
    borrowingFactorBps: Number(raw.borrowingFactor ?? raw[2] ?? 0),
    maxCollateralRaw: (raw.maxCollateral ?? raw[3] ?? null)?.toString?.() ?? null,
    maxBorrowRaw: (raw.maxBorrow ?? raw[4] ?? null)?.toString?.() ?? null,
  };
}

async function inspectOracleSources(rpc, config, token, blockTimestamp) {
  const addr = normalizeAddress(token);
  const diamond = config.moneyMarket.moneyMarketDiamond;
  const usdPlaceholder = normalizeAddress(config.usdPlaceholder);
  const oracleOut = await safeCall(rpc, diamond, VIEW, "getOracle");
  const oracle = normalizeAddress(oracleOut?.[0]) || normalizeAddress(config.oracle?.alpacaV2Oracle02);
  const [oracleOwner, oraclePrice, defaultOracle, specificOracle] = await Promise.all([
    safeCall(rpc, oracle, OWNABLE, "owner"),
    safeCall(rpc, oracle, ORACLE02, "getTokenPrice", [addr]),
    safeCall(rpc, oracle, ORACLE02, "oracle"),
    safeCall(rpc, oracle, ORACLE02, "specificOracles", [addr]),
  ]);
  const sourceOracle = nonZeroAddress(specificOracle?.[0]) || nonZeroAddress(defaultOracle?.[0]) || normalizeAddress(config.oracle?.oracleMedianizer);
  const [sourceOwner, countRaw, maxDeviationRaw, maxStaleRaw] = await Promise.all([
    safeCall(rpc, sourceOracle, OWNABLE, "owner"),
    sourceOracle && usdPlaceholder ? safeCall(rpc, sourceOracle, MEDIANIZER, "primarySourceCount", [addr, usdPlaceholder]) : null,
    sourceOracle && usdPlaceholder ? safeCall(rpc, sourceOracle, MEDIANIZER, "maxPriceDeviations", [addr, usdPlaceholder]) : null,
    sourceOracle && usdPlaceholder ? safeCall(rpc, sourceOracle, MEDIANIZER, "maxPriceStales", [addr, usdPlaceholder]) : null,
  ]);
  const sourceCount = countRaw?.[0] === undefined ? null : Number(countRaw[0]);
  const maxStaleSeconds = maxStaleRaw?.[0] === undefined ? null : Number(maxStaleRaw[0]);
  const sourceRows = [];
  if (sourceOracle && usdPlaceholder && sourceCount) {
    for (let i = 0; i < Math.min(sourceCount, 3); i++) {
      const src = await safeCall(rpc, sourceOracle, MEDIANIZER, "primarySources", [addr, usdPlaceholder, BigInt(i)]);
      const sourceAddress = normalizeAddress(src?.[0]);
      const sourcePrice = sourceAddress ? await safeCall(rpc, sourceAddress, PRICE_SOURCE, "getPrice", [addr, usdPlaceholder]) : null;
      const lastUpdate = sourcePrice?.[1] === undefined ? null : Number(sourcePrice[1]);
      sourceRows.push({
        index: i,
        sourceAddress,
        sourceKind: await addressKind(rpc, sourceAddress),
        priceUsd: sourcePrice?.[0] === undefined ? null : units(sourcePrice[0], 18),
        lastUpdate,
        ageSeconds: blockTimestamp && lastUpdate ? blockTimestamp - lastUpdate : null,
        staleVsMax: blockTimestamp && lastUpdate && maxStaleSeconds !== null ? blockTimestamp - lastUpdate > maxStaleSeconds : null,
      });
    }
  }
  return {
    token: addr,
    oracle,
    oracleKind: await addressKind(rpc, oracle),
    oracleOwner: normalizeAddress(oracleOwner?.[0]),
    oracleOwnerKind: await addressKind(rpc, oracleOwner?.[0]),
    sourceOracle,
    sourceOracleKind: await addressKind(rpc, sourceOracle),
    sourceOracleOwner: normalizeAddress(sourceOwner?.[0]),
    sourceOracleOwnerKind: await addressKind(rpc, sourceOwner?.[0]),
    specificOracle: nonZeroAddress(specificOracle?.[0]),
    sourceCount,
    maxDeviationRaw: maxDeviationRaw?.[0] === undefined ? null : maxDeviationRaw[0].toString(),
    maxStaleSeconds,
    oraclePriceUsd: oraclePrice?.[0] === undefined ? null : units(oraclePrice[0], 18),
    oracleLastTimestamp: oraclePrice?.[1] === undefined ? null : Number(oraclePrice[1]),
    sourceRows,
  };
}

async function inspectMarket(rpc, config, market, meta, prices, blockTimestamp) {
  const diamond = config.moneyMarket.moneyMarketDiamond;
  const reader = config.moneyMarketReader;
  const token = await tokenBasics(rpc, market.token, { symbol: market.name, name: market.name });
  const ibToken = await tokenBasics(rpc, market.ibToken, { symbol: `ib${market.name}`, name: `ib${market.name}` });
  const debtToken = await tokenBasics(rpc, market.debtToken, { symbol: `debt${market.name}`, name: `debt${market.name}` });
  const publicPriceUsd = prices[token.priceKey.toLowerCase()] ?? stableFallback(token.symbol);
  const [metadata, stats, priceInfo, tokenConfig, ibConfig, totalCollatToken, totalCollatIb, miniToken, miniIb, miniDebt, protocolReserve, floatingBalance, globalDebt, overDebt, nonCollatDebt, debtLastAccrued, interestRate, interestModel, guard] = await Promise.all([
    safeCall(rpc, reader, READER, "getMarketMetadata", [token.address]),
    safeCall(rpc, reader, READER, "getMarketStats", [token.address]),
    safeCall(rpc, reader, READER, "getMarketPriceInfo", [token.address]),
    safeCall(rpc, diamond, VIEW, "getTokenConfig", [token.address]),
    safeCall(rpc, diamond, VIEW, "getTokenConfig", [ibToken.address]),
    safeCall(rpc, diamond, VIEW, "getTotalCollat", [token.address]),
    safeCall(rpc, diamond, VIEW, "getTotalCollat", [ibToken.address]),
    safeCall(rpc, diamond, VIEW, "getMiniFLPoolIdOfToken", [token.address]),
    safeCall(rpc, diamond, VIEW, "getMiniFLPoolIdOfToken", [ibToken.address]),
    safeCall(rpc, diamond, VIEW, "getMiniFLPoolIdOfToken", [debtToken.address]),
    safeCall(rpc, diamond, VIEW, "getProtocolReserve", [token.address]),
    safeCall(rpc, diamond, VIEW, "getFloatingBalance", [token.address]),
    safeCall(rpc, diamond, VIEW, "getGlobalDebtValueWithPendingInterest", [token.address]),
    safeCall(rpc, diamond, VIEW, "getOverCollatTokenDebt", [token.address]),
    safeCall(rpc, diamond, VIEW, "getNonCollatTokenDebt", [token.address]),
    safeCall(rpc, diamond, VIEW, "getDebtLastAccruedAt", [token.address]),
    safeCall(rpc, diamond, VIEW, "getOverCollatInterestRate", [token.address]),
    safeCall(rpc, diamond, VIEW, "getOverCollatInterestModel", [token.address]),
    safeCall(rpc, reader, READER, "getAlpacaGuardStatuses", [[token.address]]),
  ]);
  const md = metadata?.[0] || null;
  const st = stats?.[0] || null;
  const pi = priceInfo?.[0] || null;
  const underlyingConfig = decodeTokenConfig(tokenConfig) || decodeReaderTokenConfig(md?.underlyingTokenConfig ?? md?.[2]);
  const interestBearingConfig = decodeTokenConfig(ibConfig) || decodeReaderTokenConfig(md?.ibTokenConfig ?? md?.[3]);
  const oraclePriceUsd = pi?.underlyingTokenPrice !== undefined ? units(pi.underlyingTokenPrice, 18) : pi?.[0] !== undefined ? units(pi[0], 18) : null;
  const ibPriceUsd = pi?.ibTokenPrice !== undefined ? units(pi.ibTokenPrice, 18) : pi?.[1] !== undefined ? units(pi[1], 18) : null;
  const reserveRaw = st?.reserve ?? st?.[3] ?? floatingBalance?.[0] ?? null;
  const debtRaw = st?.globalDebtValue ?? st?.[2] ?? globalDebt?.[0] ?? null;
  const totalTokenRaw = st?.totalToken ?? st?.[4] ?? null;
  const pendingInterestRaw = st?.pendingInterest ?? st?.[5] ?? null;
  const totalCollatIbRaw = totalCollatIb?.[0] ?? null;
  const totalCollatTokenRaw = totalCollatToken?.[0] ?? null;
  const maxBorrowRaw = underlyingConfig?.maxBorrowRaw;
  const maxCollateralRaw = interestBearingConfig?.maxCollateralRaw;
  const borrowCashUsd = usd(reserveRaw, token.decimals, oraclePriceUsd);
  const debtUsd = usd(debtRaw, token.decimals, oraclePriceUsd);
  const totalTokenUsd = usd(totalTokenRaw, token.decimals, oraclePriceUsd);
  const totalIbCollateralUsd = usd(totalCollatIbRaw, ibToken.decimals, ibPriceUsd);
  const maxBorrowUsd = usd(maxBorrowRaw, token.decimals, oraclePriceUsd);
  const maxCollateralUsd = usd(maxCollateralRaw, ibToken.decimals, ibPriceUsd);
  const gecko = await geckoPools(token.address);
  return {
    name: market.name,
    tierFromConfig: market.tier,
    token,
    ibToken,
    debtToken,
    interestModel: normalizeAddress(market.interestModel) || normalizeAddress(interestModel?.[0]),
    interestModelKind: await addressKind(rpc, normalizeAddress(market.interestModel) || normalizeAddress(interestModel?.[0])),
    underlyingConfig,
    ibTokenConfig: interestBearingConfig,
    miniFLPoolIds: {
      underlying: miniToken?.[0] === undefined ? null : Number(miniToken[0]),
      ibToken: miniIb?.[0] === undefined ? null : Number(miniIb[0]),
      debtToken: miniDebt?.[0] === undefined ? null : Number(miniDebt[0]),
    },
    guardActive: Boolean((guard?.[0] || [])[0]?.isGuardActivated ?? (guard?.[0] || [])[0]?.[1] ?? false),
    oraclePriceUsd: round(oraclePriceUsd, 8),
    ibPriceUsd: round(ibPriceUsd, 8),
    publicPriceUsd: publicPriceUsd === undefined ? null : round(publicPriceUsd, 8),
    oracleVsPublicBps: publicPriceUsd ? bpsDiff(oraclePriceUsd, publicPriceUsd) : null,
    underlyingToIbRate: pi?.underlyingToIbRate !== undefined ? units(pi.underlyingToIbRate, 18) : pi?.[2] !== undefined ? units(pi[2], 18) : null,
    reserveRaw: reserveRaw?.toString?.() ?? null,
    reserveUsd: round(borrowCashUsd, 2),
    globalDebtRaw: debtRaw?.toString?.() ?? null,
    globalDebtUsd: round(debtUsd, 2),
    totalTokenRaw: totalTokenRaw?.toString?.() ?? null,
    totalTokenUsd: round(totalTokenUsd, 2),
    pendingInterestRaw: pendingInterestRaw?.toString?.() ?? null,
    protocolReserveRaw: protocolReserve?.[0] === undefined ? null : protocolReserve[0].toString(),
    overCollatDebtSharesRaw: overDebt?.[0] === undefined ? null : overDebt[0].toString(),
    overCollatDebtRaw: overDebt?.[1] === undefined ? null : overDebt[1].toString(),
    nonCollatDebtRaw: nonCollatDebt?.[0] === undefined ? null : nonCollatDebt[0].toString(),
    totalCollateralTokenRaw: totalCollatTokenRaw?.toString?.() ?? null,
    totalCollateralIbRaw: totalCollatIbRaw?.toString?.() ?? null,
    totalIbCollateralUsd: round(totalIbCollateralUsd, 2),
    maxBorrowRaw: maxBorrowRaw || null,
    maxBorrowUsd: round(maxBorrowUsd, 2),
    borrowLimitRemainingUsd: maxBorrowUsd === null || debtUsd === null ? null : round(Math.max(0, maxBorrowUsd - debtUsd), 2),
    maxCollateralRaw: maxCollateralRaw || null,
    maxCollateralUsd: round(maxCollateralUsd, 2),
    debtLastAccruedAt: debtLastAccrued?.[0] === undefined ? null : Number(debtLastAccrued[0]),
    debtLastAccruedAgeSeconds: blockTimestamp && debtLastAccrued?.[0] !== undefined ? blockTimestamp - Number(debtLastAccrued[0]) : null,
    interestRatePerSecondRaw: interestRate?.[0] === undefined ? null : interestRate[0].toString(),
    topDexLiquidityUsd: round(gecko.pools[0]?.reserveUsd || 0, 2),
    topDexPriceUsd: gecko.pools[0]?.baseTokenPriceUsd ?? null,
    topDexPool: gecko.pools[0]?.name || null,
    dexPoolsOk: gecko.ok,
    materialBorrowCash: Number(borrowCashUsd || 0) >= MATERIAL_USD,
    materialDebt: Number(debtUsd || 0) >= MATERIAL_USD,
    acceptedValueDivergent: publicPriceUsd && Math.abs(Number(bpsDiff(oraclePriceUsd, publicPriceUsd) || 0)) >= ORACLE_DIVERGENCE_BPS,
  };
}

async function inspectContracts(rpc, config) {
  const mm = config.moneyMarket;
  const baseRows = [
    { label: "moneyMarketDiamond", role: "diamond", address: mm.moneyMarketDiamond },
    { label: "moneyMarketReader", role: "reader", address: config.moneyMarketReader },
    { label: "accountManagerProxy", role: "account-manager-proxy", address: mm.accountManager?.proxy },
    { label: "accountManagerConfigImpl", role: "account-manager-config-impl", address: mm.accountManager?.implementation },
    { label: "proxyAdmin", role: "proxy-admin", address: config.proxyAdmin },
    { label: "timelock", role: "timelock", address: config.timelock },
    { label: "opMultiSig", role: "ops-multisig", address: config.opMultiSig },
    { label: "nativeRelayer", role: "native-relayer", address: config.nativeRelayer },
    { label: "ibTokenImplementation", role: "ib-token-implementation", address: mm.interestBearingTokenImplementation },
    { label: "debtTokenImplementation", role: "debt-token-implementation", address: mm.debtTokenImplementation },
    { label: "miniFL", role: "rewards", address: config.miniFL?.proxy },
    { label: "alpacaV2Oracle02", role: "oracle", address: config.oracle?.alpacaV2Oracle02 },
    { label: "oracleMedianizer", role: "oracle-medianizer", address: config.oracle?.oracleMedianizer },
    { label: "repurchaser", role: "repurchaser", address: mm.repurchaser },
    { label: "strategyLiquidateIb", role: "liquidation-strategy", address: config.sharedStrategies?.pancakeswap?.strategyLiquidateIb },
    { label: "strategyLiquidateIbV3", role: "liquidation-strategy", address: config.sharedStrategies?.pancakeswap?.strategyLiquidateIbV3 },
    { label: "pancakeV2Router", role: "dex-router", address: config.yieldSources?.pancakeSwap?.routerV2 },
    { label: "pancakeV3Router", role: "dex-router", address: config.yieldSources?.pancakeSwap?.routerV3 },
    { label: "pancakeV3Factory", role: "dex-factory", address: config.yieldSources?.pancakeSwap?.factoryV3 },
    ...Object.entries(mm.facets || {}).map(([label, address]) => ({ label, role: "configured-facet", address })),
  ];
  const onchainFacets = await safeCall(rpc, mm.moneyMarketDiamond, DIAMOND_LOUPE, "facetAddresses");
  for (const address of Array.from(onchainFacets?.[0] || [])) baseRows.push({ label: "onchainFacet", role: "diamond-facet-live", address });
  const seen = new Set();
  const rows = [];
  for (const row of baseRows) {
    const address = normalizeAddress(row.address);
    if (!address) continue;
    const key = `${row.label}:${address.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const [code, owner, selectors, impl] = await Promise.all([
      getCode(rpc, address),
      safeCall(rpc, address, OWNABLE, "owner"),
      row.role.includes("facet") ? safeCall(rpc, mm.moneyMarketDiamond, DIAMOND_LOUPE, "facetFunctionSelectors", [address]) : null,
      row.label === "accountManagerProxy" ? getImpl(rpc, address).catch(() => null) : null,
    ]);
    rows.push({
      ...row,
      address,
      codePresent: Boolean(code && code !== "0x"),
      codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
      owner: normalizeAddress(owner?.[0]),
      ownerKind: await addressKind(rpc, owner?.[0]),
      selectors: selectors?.[0] ? selectors[0].length : null,
      eip1967Impl: normalizeAddress(impl),
      eip1967ImplMatchesConfig: impl && mm.accountManager?.implementation ? lowerAddress(impl) === lowerAddress(mm.accountManager.implementation) : null,
    });
  }
  return rows;
}

async function roleRows(rpc, config) {
  const diamond = config.moneyMarket.moneyMarketDiamond;
  const candidates = [
    { label: "accountManagerProxy", address: config.moneyMarket.accountManager?.proxy, checks: ["isAccountManagersOk"] },
    { label: "timelock", address: config.timelock, checks: ["isRiskManagersOk", "isOperatorsOk", "isLiquidatorOk"] },
    { label: "opMultiSig", address: config.opMultiSig, checks: ["isRiskManagersOk", "isOperatorsOk", "isLiquidatorOk"] },
    { label: "repurchaser", address: config.moneyMarket.repurchaser, checks: ["isLiquidatorOk"] },
    { label: "strategyLiquidateIb", address: config.sharedStrategies?.pancakeswap?.strategyLiquidateIb, checks: ["isLiquidationStratOk"] },
    { label: "strategyLiquidateIbV3", address: config.sharedStrategies?.pancakeswap?.strategyLiquidateIbV3, checks: ["isLiquidationStratOk"] },
  ];
  const rows = [];
  for (const c of candidates) {
    const address = normalizeAddress(c.address);
    if (!address) continue;
    const row = { label: c.label, address, kind: await addressKind(rpc, address) };
    for (const check of c.checks) {
      const out = await safeCall(rpc, diamond, VIEW, check, [address]);
      row[check] = out?.[0] === undefined ? null : Boolean(out[0]);
    }
    rows.push(row);
  }
  return rows;
}

async function getLogsRecursive(rpc, address, topics, fromBlock, toBlock, depth = 0) {
  const params = [{ address: normalizeAddress(address), fromBlock: hexBlock(fromBlock), toBlock: hexBlock(toBlock), topics }];
  const logs = await rpcCall(rpc, "eth_getLogs", params, 20_000).catch(() => null);
  if (Array.isArray(logs)) return { logs, chunksFailed: 0, chunksScanned: 1 };
  if (fromBlock >= toBlock || depth >= 18) return { logs: [], chunksFailed: 1, chunksScanned: 1 };
  const mid = Math.floor((fromBlock + toBlock) / 2);
  const left = await getLogsRecursive(rpc, address, topics, fromBlock, mid, depth + 1);
  const right = await getLogsRecursive(rpc, address, topics, mid + 1, toBlock, depth + 1);
  return { logs: [...left.logs, ...right.logs], chunksFailed: left.chunksFailed + right.chunksFailed, chunksScanned: left.chunksScanned + right.chunksScanned };
}

function deriveSubAccountId(account, subAccount) {
  try {
    const id = BigInt(account) ^ BigInt(subAccount);
    return id >= 0n && id <= 255n ? Number(id) : null;
  } catch (_) { return null; }
}

async function scanPositionLogs(rpc, config, latest) {
  const diamond = config.moneyMarket.moneyMarketDiamond;
  const fromBlock = Math.max(0, (latest.number || 0) - LOG_BLOCKS);
  const topics = [[LOG_OVER_COLLAT_BORROW, LOG_ADD_COLLATERAL, LOG_LIQUIDATE, LOG_REPURCHASE]];
  const result = latest.number ? await getLogsRecursive(rpc, diamond, topics, fromBlock, latest.number) : { logs: [], chunksFailed: 1, chunksScanned: 0 };
  const samples = new Map();
  const liquidationLogs = [];
  const repurchaseLogs = [];
  for (const log of result.logs) {
    const topic0 = log.topics?.[0];
    if (topic0 === LOG_LIQUIDATE) liquidationLogs.push(log);
    if (topic0 === LOG_REPURCHASE) repurchaseLogs.push(log);
    if (topic0 !== LOG_OVER_COLLAT_BORROW && topic0 !== LOG_ADD_COLLATERAL) continue;
    const account = topicAddress(log.topics?.[1]);
    const subAccount = topicAddress(log.topics?.[2]);
    const token = topicAddress(log.topics?.[3]);
    const subAccountId = deriveSubAccountId(account, subAccount);
    if (!account || !subAccount || subAccountId === null) continue;
    const key = `${lowerAddress(account)}:${subAccountId}`;
    const row = samples.get(key) || { account, subAccount, subAccountId, lastBlock: Number(BigInt(log.blockNumber || "0x0")), eventHints: new Set(), tokenHints: new Set() };
    row.lastBlock = Math.max(row.lastBlock, Number(BigInt(log.blockNumber || "0x0")));
    row.eventHints.add(topic0 === LOG_OVER_COLLAT_BORROW ? "borrow" : "collateral");
    if (token) row.tokenHints.add(lowerAddress(token));
    samples.set(key, row);
  }
  return {
    fromBlock,
    toBlock: latest.number,
    logsDecoded: result.logs.length,
    chunksFailed: result.chunksFailed,
    chunksScanned: result.chunksScanned,
    liquidationLogs: liquidationLogs.length,
    repurchaseLogs: repurchaseLogs.length,
    samples: [...samples.values()].sort((a, b) => b.lastBlock - a.lastBlock).slice(0, MAX_POSITION_SAMPLE).map((r) => ({ ...r, eventHints: [...r.eventHints], tokenHints: [...r.tokenHints] })),
  };
}

function decodeSummary(summary, tokenByAddress, liquidationThresholdBps) {
  const s = summary?.[0];
  if (!s) return null;
  const totalBorrowedUsd = units(s.totalBorrowedValue ?? s[1], 18);
  const totalCollateralUsd = units(s.totalCollateralValue ?? s[2], 18);
  const totalBorrowingPowerUsd = units(s.totalBorrowingPower ?? s[3], 18);
  const totalUsedBorrowingPowerUsd = units(s.totalUsedBorrowingPower ?? s[4], 18);
  const usageBps = totalBorrowingPowerUsd && totalBorrowingPowerUsd > 0 ? (totalUsedBorrowingPowerUsd / totalBorrowingPowerUsd) * 10000 : null;
  const bpsToLiquidation = usageBps === null || liquidationThresholdBps === null ? null : liquidationThresholdBps - usageBps;
  const bpsToRepurchase = usageBps === null ? null : 10000 - usageBps;
  const collats = Array.from(s.collaterals ?? s[5] ?? []).map((c) => {
    const underlying = normalizeAddress(c.underlyingToken ?? c[1]);
    const meta = tokenByAddress[lowerAddress(underlying)] || {};
    return { symbol: meta.symbol || compactAddress(underlying), amount: units(c.amount ?? c[2], meta.decimals || 18), collateralFactorBps: Number(c.collateralFactor ?? c[5] ?? 0) };
  });
  const debts = Array.from(s.debts ?? s[6] ?? []).map((d) => {
    const token = normalizeAddress(d.token ?? d[0]);
    const meta = tokenByAddress[lowerAddress(token)] || {};
    return { symbol: meta.symbol || compactAddress(token), amount: units(d.amount ?? d[2], meta.decimals || 18), borrowingFactorBps: Number(d.borrowingFactor ?? d[4] ?? 0) };
  });
  return {
    totalBorrowedUsd: round(totalBorrowedUsd, 2),
    totalCollateralUsd: round(totalCollateralUsd, 2),
    totalBorrowingPowerUsd: round(totalBorrowingPowerUsd, 2),
    totalUsedBorrowingPowerUsd: round(totalUsedBorrowingPowerUsd, 2),
    usageBps: round(usageBps, 2),
    bpsToLiquidation: round(bpsToLiquidation, 2),
    bpsToRepurchase: round(bpsToRepurchase, 2),
    collateralCount: collats.length,
    debtCount: debts.length,
    collateralSymbols: collats.map((c) => c.symbol).slice(0, 6),
    debtSymbols: debts.map((d) => d.symbol).slice(0, 6),
    material: Number(totalBorrowedUsd || 0) >= MATERIAL_BORROWER_USD,
    nearLiquidation: Number(totalBorrowedUsd || 0) >= MATERIAL_BORROWER_USD && bpsToLiquidation !== null && bpsToLiquidation >= 0 && bpsToLiquidation <= NEAR_LIQUIDATION_BPS,
    liquidatable: Number(totalBorrowedUsd || 0) >= MATERIAL_BORROWER_USD && bpsToLiquidation !== null && bpsToLiquidation <= 0,
    repurchasable: Number(totalBorrowedUsd || 0) >= MATERIAL_BORROWER_USD && bpsToRepurchase !== null && bpsToRepurchase < 0,
  };
}

async function samplePositions(rpc, config, logScan, tokenByAddress, liquidationThresholdBps) {
  const reader = config.moneyMarketReader;
  const rows = [];
  for (const sample of logScan.samples) {
    const summary = await safeCall(rpc, reader, READER, "getSubAccountSummary", [sample.account, BigInt(sample.subAccountId)], 15_000);
    const decoded = decodeSummary(summary, tokenByAddress, liquidationThresholdBps);
    if (!decoded) continue;
    rows.push({
      accountRef: shaRef(sample.account),
      subAccountRef: shaRef(sample.subAccount),
      subAccountId: sample.subAccountId,
      lastSeenBlock: sample.lastBlock,
      eventHints: sample.eventHints,
      tokenHintCount: sample.tokenHints.length,
      ...decoded,
    });
  }
  return rows.sort((a, b) => (b.totalBorrowedUsd || 0) - (a.totalBorrowedUsd || 0));
}

function localArtifactJoins(addresses) {
  const wanted = new Map();
  for (const row of addresses) {
    const addr = lowerAddress(row.address);
    if (addr) wanted.set(addr, row);
  }
  const rows = [];
  if (!fs.existsSync(REPORTS_DIR)) return rows;
  for (const file of fs.readdirSync(REPORTS_DIR)) {
    if (!file.endsWith(".md") || file === path.basename(REPORT_OUT)) continue;
    const full = path.join(REPORTS_DIR, file);
    const text = readText(full).toLowerCase();
    if (!text) continue;
    for (const [addr, meta] of wanted.entries()) {
      if (!text.includes(addr)) continue;
      const common = /^(WBNB|BNB|USDC|USDT|BUSD|BTCB|ETH|CAKE)$/i.test(meta.symbol || meta.label || "") && meta.kind === "underlying";
      rows.push({ file: `reports/${file}`, address: meta.address, label: meta.label || meta.symbol || null, kind: meta.kind, commonTokenContext: common });
      if (rows.length >= MAX_LOCAL_JOINS) return rows;
    }
  }
  return rows;
}

function classify({ marketRows, oracleRows, sampleRows, localJoinRows, roleRows, logScan }) {
  const materialBorrowRows = marketRows.filter((r) => Number(r.globalDebtUsd || 0) >= MATERIAL_USD);
  const materialCashRows = marketRows.filter((r) => Number(r.reserveUsd || 0) >= MATERIAL_USD);
  const acceptedValueDivergentRows = marketRows.filter((r) => r.acceptedValueDivergent && Number(r.reserveUsd || 0) >= MATERIAL_USD);
  const staleSourceRows = oracleRows.flatMap((r) => r.sourceRows.map((s) => ({ token: r.token, ...s, maxStaleSeconds: r.maxStaleSeconds }))).filter((s) => s.staleVsMax);
  const singleSourceRows = oracleRows.filter((r) => r.sourceCount === 1);
  const materialSampledRows = sampleRows.filter((r) => r.material);
  const nearLiquidationRows = sampleRows.filter((r) => r.nearLiquidation);
  const materialLiquidatableRows = sampleRows.filter((r) => r.liquidatable);
  const permissionlessRepurchaseRows = sampleRows.filter((r) => r.repurchasable);
  const directAlpacaJoinRows = localJoinRows.filter((r) => !r.commonTokenContext && /ib|debt|diamond|reader|account|facet|oracle|strategy/i.test(r.kind || r.label || ""));
  const whitelistedLiquidatorRows = roleRows.filter((r) => r.isLiquidatorOk === true);
  const watchCandidates = acceptedValueDivergentRows.length + nearLiquidationRows.length + permissionlessRepurchaseRows.length + directAlpacaJoinRows.length;
  const blockers = [];
  if (!permissionlessRepurchaseRows.length) blockers.push("No sampled material subaccount is currently repurchasable with used borrowing power above total borrowing power");
  if (!materialLiquidatableRows.length) blockers.push("No sampled material subaccount is currently past the liquidation threshold");
  blockers.push("LiquidationFacet.liquidationCall is liquidator-whitelist gated; public route requires a whitelisted caller or the permissionless repurchase path");
  if (!acceptedValueDivergentRows.length) blockers.push(`No material market has oracle/public price divergence above ${ORACLE_DIVERGENCE_BPS}bps with usable borrow cash`);
  if (!directAlpacaJoinRows.length) blockers.push("No Alpaca-specific ib/debt/diamond address joined to a material external trusted-consumer route in local artifacts");
  if (logScan.chunksFailed) blockers.push("Recent borrower sampling is bounded by one or more failed eth_getLogs chunks");
  blockers.push("No exact repay, repurchase/liquidate, seized-collateral exit, gas, slippage, and fee-positive route was proven");
  blockers.push("No fork extraction proof");
  return {
    materialBorrowRows,
    materialCashRows,
    acceptedValueDivergentRows,
    staleSourceRows,
    singleSourceRows,
    materialSampledRows,
    nearLiquidationRows,
    materialLiquidatableRows,
    permissionlessRepurchaseRows,
    directAlpacaJoinRows,
    whitelistedLiquidatorRows,
    watchCandidates,
    routePositive: 0,
    executableNow: false,
    signedActionJustified: false,
    blockers,
  };
}

function marketTable(rows) {
  return rows.map((r) => `| ${r.name} | ${r.underlyingConfig?.tier || r.tierFromConfig} | ${fmtUsd(r.reserveUsd)} | ${fmtUsd(r.globalDebtUsd)} | ${r.underlyingConfig?.collateralFactorBps || 0} | ${r.underlyingConfig?.borrowingFactorBps || 0} | ${r.oracleVsPublicBps ?? "n/a"} | ${fmtUsd(r.topDexLiquidityUsd)} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a | n/a |";
}

function positionTable(rows) {
  return rows.slice(0, 8).map((r) => `| ${r.accountRef} | ${r.subAccountId} | ${fmtUsd(r.totalBorrowedUsd)} | ${fmtUsd(r.totalBorrowingPowerUsd)} | ${fmtUsd(r.totalUsedBorrowingPowerUsd)} | ${r.usageBps ?? "n/a"} | ${r.bpsToLiquidation ?? "n/a"} | ${r.debtSymbols.join(",") || "n/a"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a | n/a |";
}

function generateReport(artifact) {
  const s = artifact.summary;
  const lines = [];
  lines.push(`${SIGNAL_DORMANT} - Alpaca Finance 2.0 Phase 0`);
  lines.push("");
  lines.push("## Verdict");
  lines.push("");
  lines.push("No confirmed permissionless exploit. This bounded pass maps Alpaca Finance 2.0's BNB Chain money-market diamond, reader, facets, account manager, oracle stack, configured markets, recent borrower-log samples, local artifact joins, and DEX/reference price context. No sampled material account is repurchasable or liquidatable with exact positive unwind economics, and the direct liquidation route is liquidator-whitelist gated. No fork or signed action is justified.");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|---|---:|`);
  lines.push(`| Public TVL | ${fmtUsd(s.defillamaCurrentTvlUsd)} |`);
  lines.push(`| BNB TVL | ${fmtUsd(s.bnbTvlUsd)} |`);
  lines.push(`| Markets scanned | ${s.marketRows} |`);
  lines.push(`| Material borrow rows | ${s.materialBorrowRows} |`);
  lines.push(`| Material cash rows | ${s.materialCashRows} |`);
  lines.push(`| Total borrow context | ${fmtUsd(s.totalDebtUsd)} |`);
  lines.push(`| Total reserve/cash context | ${fmtUsd(s.totalReserveUsd)} |`);
  lines.push(`| Recent logs decoded | ${s.logsDecoded} |`);
  lines.push(`| Sampled subaccounts | ${s.sampledSubaccounts} |`);
  lines.push(`| Near-liquidation sampled rows | ${s.nearLiquidationRows} |`);
  lines.push(`| Material liquidatable sampled rows | ${s.materialLiquidatableRows} |`);
  lines.push(`| Permissionless repurchase sampled rows | ${s.permissionlessRepurchaseRows} |`);
  lines.push(`| Accepted-value divergent rows | ${s.acceptedValueDivergentRows} |`);
  lines.push(`| Alpaca-specific local joins | ${s.directAlpacaJoinRows} |`);
  lines.push(`| Watch candidates | ${s.watchCandidates} |`);
  lines.push(`| Route positive | ${s.routePositive} |`);
  lines.push("");
  lines.push("## Markets");
  lines.push("");
  lines.push("| Market | Tier | Cash | Debt | CF bps | Borrow factor bps | Oracle/public bps | Top DEX liquidity |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|");
  lines.push(marketTable(artifact.marketRows));
  lines.push("");
  lines.push("## Sampled Borrowers");
  lines.push("");
  lines.push("Borrower addresses are not persisted; `accountRef` is a local hash reference.");
  lines.push("");
  lines.push("| accountRef | subAccountId | Borrowed | Borrow power | Used power | Usage bps | Bps to liq | Debt symbols |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---|");
  lines.push(positionTable(artifact.positionSampleRows));
  lines.push("");
  lines.push("## Blockers");
  lines.push("");
  for (const blocker of artifact.blockers) lines.push(`- ${blocker}`);
  lines.push("");
  lines.push("## Required For Route Positive");
  lines.push("");
  for (const req of artifact.requiredForRoutePositive) lines.push(`- ${req}`);
  lines.push("");
  lines.push("## Next Read-Only Step");
  lines.push("");
  lines.push(artifact.nextReadOnlyStep);
  lines.push("");
  lines.push("## Artifacts");
  lines.push("");
  lines.push(`- Raw: \`${rel(RAW_OUT)}\``);
  lines.push(`- Scanner: \`${rel(__filename)}\``);
  return lines.join("\n");
}

async function main() {
  const rpc = await resolveRpc(CHAIN_ID);
  if (!rpc) throw new Error("No BNB Chain RPC available from sanitized inventory or public fallback");
  const [metadata, configBundle, latest] = await Promise.all([protocolMetadata(), loadConfig(), latestBlock(rpc)]);
  const config = configBundle.config;
  const marketDefs = (config.moneyMarket?.markets || []).map((m) => ({ ...m, token: normalizeAddress(m.token), ibToken: normalizeAddress(m.ibToken), debtToken: normalizeAddress(m.debtToken), interestModel: normalizeAddress(m.interestModel) })).filter((m) => m.token && m.ibToken && m.debtToken);
  const basicTokens = await mapLimit(marketDefs.flatMap((m) => [
    { kind: "underlying", label: m.name, symbol: m.name, address: m.token },
    { kind: "ibToken", label: `ib${m.name}`, symbol: `ib${m.name}`, address: m.ibToken },
    { kind: "debtToken", label: `debt${m.name}`, symbol: `debt${m.name}`, address: m.debtToken },
  ]), 8, async (row) => ({ ...row, basics: await tokenBasics(rpc, row.address, row) }));
  const tokenByAddress = {};
  for (const row of basicTokens) if (row.basics?.address) tokenByAddress[lowerAddress(row.basics.address)] = row.basics;
  const prices = await loadPrices(marketDefs.map((m) => tokenKey(m.token)));
  const [contracts, roles, liquidationParams, feeParams, flashloanParams, readerMoneyMarket] = await Promise.all([
    inspectContracts(rpc, config),
    roleRows(rpc, config),
    safeCall(rpc, config.moneyMarket.moneyMarketDiamond, VIEW, "getLiquidationParams"),
    safeCall(rpc, config.moneyMarket.moneyMarketDiamond, VIEW, "getFeeParams"),
    safeCall(rpc, config.moneyMarket.moneyMarketDiamond, VIEW, "getFlashloanParams"),
    safeCall(rpc, config.moneyMarketReader, READER, "moneyMarket"),
  ]);
  const marketRows = await mapLimit(marketDefs, 3, (m) => inspectMarket(rpc, config, m, metadata, prices, latest.timestamp));
  const oracleRows = await mapLimit(marketDefs, 4, (m) => inspectOracleSources(rpc, config, m.token, latest.timestamp));
  const logScan = await scanPositionLogs(rpc, config, latest);
  const liquidationThresholdBps = liquidationParams?.[1] === undefined ? null : Number(liquidationParams[1]);
  const positionSampleRows = await samplePositions(rpc, config, logScan, tokenByAddress, liquidationThresholdBps);
  const localJoinRows = localArtifactJoins([
    { kind: "diamond", label: "moneyMarketDiamond", address: config.moneyMarket.moneyMarketDiamond },
    { kind: "reader", label: "moneyMarketReader", address: config.moneyMarketReader },
    { kind: "accountManager", label: "accountManager", address: config.moneyMarket.accountManager?.proxy },
    ...marketDefs.flatMap((m) => [
      { kind: "underlying", label: m.name, symbol: m.name, address: m.token },
      { kind: "ibToken", label: `ib${m.name}`, address: m.ibToken },
      { kind: "debtToken", label: `debt${m.name}`, address: m.debtToken },
    ]),
  ]);
  const classification = classify({ marketRows, oracleRows, sampleRows: positionSampleRows, localJoinRows, roleRows: roles, logScan });
  const totalDebtUsd = marketRows.reduce((sum, r) => sum + Number(r.globalDebtUsd || 0), 0);
  const totalReserveUsd = marketRows.reduce((sum, r) => sum + Number(r.reserveUsd || 0), 0);
  const totalIbCollateralUsd = marketRows.reduce((sum, r) => sum + Number(r.totalIbCollateralUsd || 0), 0);
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: rel(__filename),
    scope: "Read-only Alpaca Finance 2.0 BNB Chain money-market Phase 0 scan",
    safety: { rpcInventoryRead: false, rpcUrlsStored: false, envFilesRead: false, privateKeysRead: false, signedActions: false, exploitExecuteCalls: false, forkTransactions: false, routePositive: false, signedActionJustified: false },
    coverageClassification: "bounded-with-caveats",
    metadata,
    configSource: { source: configBundle.source, fallbackUsed: configBundle.fallbackUsed, attempts: configBundle.attempts, mirrorCommit: "9ec5be57664d675e2cc919718c02a752ba5f56cf" },
    chain: { chain: CHAIN, chainId: CHAIN_ID, latestBlock: latest.number, latestTimestamp: latest.timestamp },
    deployments: {
      moneyMarketDiamond: normalizeAddress(config.moneyMarket.moneyMarketDiamond),
      moneyMarketReader: normalizeAddress(config.moneyMarketReader),
      readerMoneyMarket: normalizeAddress(readerMoneyMarket?.[0]),
      accountManagerProxy: normalizeAddress(config.moneyMarket.accountManager?.proxy),
      accountManagerConfiguredImpl: normalizeAddress(config.moneyMarket.accountManager?.implementation),
      proxyAdmin: normalizeAddress(config.proxyAdmin),
      timelock: normalizeAddress(config.timelock),
      opMultiSig: normalizeAddress(config.opMultiSig),
    },
    parameters: { materialUsd: MATERIAL_USD, materialBorrowerUsd: MATERIAL_BORROWER_USD, oracleDivergenceBps: ORACLE_DIVERGENCE_BPS, nearLiquidationBps: NEAR_LIQUIDATION_BPS, logBlocks: LOG_BLOCKS, maxPositionSample: MAX_POSITION_SAMPLE },
    protocolParams: {
      maxLiquidateBps: liquidationParams?.[0] === undefined ? null : Number(liquidationParams[0]),
      liquidationThresholdBps,
      lendingFeeBps: feeParams?.[0] === undefined ? null : Number(feeParams[0]),
      repurchaseFeeBps: feeParams?.[1] === undefined ? null : Number(feeParams[1]),
      liquidationFeeBps: feeParams?.[2] === undefined ? null : Number(feeParams[2]),
      flashloanFeeBps: flashloanParams?.[0] === undefined ? null : Number(flashloanParams[0]),
      lenderFlashloanBps: flashloanParams?.[1] === undefined ? null : Number(flashloanParams[1]),
      flashloanTreasury: normalizeAddress(flashloanParams?.[2]),
    },
    summary: {
      defillamaCurrentTvlUsd: metadata.tvlUsd,
      bnbTvlUsd: metadata.bnbTvlUsd,
      marketRows: marketRows.length,
      materialBorrowRows: classification.materialBorrowRows.length,
      materialCashRows: classification.materialCashRows.length,
      totalDebtUsd: round(totalDebtUsd, 2),
      totalReserveUsd: round(totalReserveUsd, 2),
      totalIbCollateralUsd: round(totalIbCollateralUsd, 2),
      contractRows: contracts.length,
      contractsWithCode: contracts.filter((r) => r.codePresent).length,
      oracleRows: oracleRows.length,
      singleSourceOracleRows: classification.singleSourceRows.length,
      staleSourceRows: classification.staleSourceRows.length,
      acceptedValueDivergentRows: classification.acceptedValueDivergentRows.length,
      logFromBlock: logScan.fromBlock,
      logToBlock: logScan.toBlock,
      logsDecoded: logScan.logsDecoded,
      logErrors: logScan.chunksFailed,
      sampledSubaccounts: positionSampleRows.length,
      materialSampledRows: classification.materialSampledRows.length,
      nearLiquidationRows: classification.nearLiquidationRows.length,
      materialLiquidatableRows: classification.materialLiquidatableRows.length,
      permissionlessRepurchaseRows: classification.permissionlessRepurchaseRows.length,
      whitelistedLiquidatorRows: classification.whitelistedLiquidatorRows.length,
      localArtifactRows: localJoinRows.length,
      directAlpacaJoinRows: classification.directAlpacaJoinRows.length,
      watchCandidates: classification.watchCandidates,
      routePositive: classification.routePositive,
      executableNow: classification.executableNow,
      signedActionJustified: classification.signedActionJustified,
    },
    contractRows: contracts,
    roleRows: roles,
    marketRows,
    oracleRows,
    logScan: { ...logScan, samples: undefined },
    positionSampleRows,
    localArtifactRows: localJoinRows,
    watchRows: [
      ...classification.acceptedValueDivergentRows.map((r) => ({ type: "accepted-value-divergence", market: r.name, oracleVsPublicBps: r.oracleVsPublicBps, reserveUsd: r.reserveUsd })),
      ...classification.nearLiquidationRows.map((r) => ({ type: "near-liquidation", accountRef: r.accountRef, subAccountId: r.subAccountId, bpsToLiquidation: r.bpsToLiquidation, borrowedUsd: r.totalBorrowedUsd })),
      ...classification.permissionlessRepurchaseRows.map((r) => ({ type: "permissionless-repurchase", accountRef: r.accountRef, subAccountId: r.subAccountId, bpsToRepurchase: r.bpsToRepurchase, borrowedUsd: r.totalBorrowedUsd })),
    ],
    blockers: classification.blockers,
    requiredForRoutePositive: [
      "specific Alpaca subaccount is currently repurchasable or otherwise liquidatable through a permissionless path",
      "repay/repurchase/liquidation action is not blocked by whitelists, account-manager-only checks, pause state, or role gates",
      "collateral acquisition or seized collateral exit is exact-quoted positive after repurchase/liquidation fees, gas, and slippage",
      "oracle/accepted-value divergence is current, material, and maps to borrow cash or liquidation economics",
      "fork/static proof before any live or signed action",
    ],
    nextReadOnlyStep: "Keep Alpaca Finance 2.0 on borrower-log, oracle-source, and ib/debt-token consumer watch; exact-quote/fork only if a material subaccount becomes permissionlessly repurchasable/liquidatable or an accepted-value divergence maps to usable borrow cash and positive exit liquidity.",
    routePositive: classification.routePositive,
    executableNow: classification.executableNow,
    signedActionJustified: classification.signedActionJustified,
  };
  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, JSON.stringify(artifact, jsonReplacer, 2));
  fs.writeFileSync(REPORT_OUT, generateReport(artifact));
  if (!QUIET) {
    console.log(`${SIGNAL_DORMANT} - Alpaca Finance 2.0 Phase 0`);
    console.log(`Markets=${artifact.summary.marketRows}; sampledSubaccounts=${artifact.summary.sampledSubaccounts}; watchCandidates=${artifact.summary.watchCandidates}; routePositive=${artifact.summary.routePositive}`);
    console.log(`Report: ${rel(REPORT_OUT)}`);
  }
}

main().catch((error) => {
  console.error(`scan-alpaca-finance-2-phase0 failed: ${error?.stack || error?.message || error}`);
  process.exitCode = 1;
});
