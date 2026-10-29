#!/usr/bin/env node
// Read-only recent Morpho CreateMarket event scanner across configured Morpho chains.
// RPC URLs are resolved in memory only and never printed or stored.

const fs = require("fs");
const path = require("path");
let ethers;
try { ({ ethers } = require("ethers")); } catch (_) { ({ ethers } = require("./node_modules/ethers")); }
const { resolveRpc, rpcCall, getImpl } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "recent-morpho-create-markets.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "recent-morpho-create-markets.md");

const MORPHO_GQL = "https://api.morpho.org/graphql";
const MORPHO_BLUE = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const ARBITRUM_LEGACY_MORPHO = "0x6c247b1F6182318877311737BaC0844bAa518F5e";
const DEFAULT_CHAINS = [1, 8453, 42161, 10, 137, 130, 42220, 1135, 1868, 534352, 146, 57073, 59144, 34443];
const CHAINS = parseChainIds(argValue("--chains") || process.env.MORPHO_CREATE_MARKET_CHAIN_IDS, DEFAULT_CHAINS);
const LOOKBACK_BLOCKS = Number(argValue("--lookback-blocks") || process.env.MORPHO_CREATE_MARKET_LOOKBACK_BLOCKS || "50000");
const LOG_CHUNK_BLOCKS = Number(argValue("--log-chunk-blocks") || process.env.MORPHO_CREATE_MARKET_LOG_CHUNK_BLOCKS || "2000");
const MAX_LOGS_PER_CHAIN = Number(argValue("--max-logs-per-chain") || process.env.MORPHO_CREATE_MARKET_MAX_LOGS_PER_CHAIN || "250");
const MAX_GRAPH_MARKETS_PER_CHAIN = Number(argValue("--max-graph-markets-per-chain") || process.env.MORPHO_CREATE_MARKET_MAX_GRAPH_MARKETS_PER_CHAIN || "1000");
const MIN_LLTV_PCT = Number(argValue("--min-lltv-pct") || process.env.MORPHO_CREATE_MARKET_MIN_LLTV_PCT || "70");
const MIN_LIQUIDITY_USD = Number(argValue("--min-liquidity-usd") || process.env.MORPHO_CREATE_MARKET_MIN_LIQUIDITY_USD || "10000");
const MIN_BORROW_USD = Number(argValue("--min-borrow-usd") || process.env.MORPHO_CREATE_MARKET_MIN_BORROW_USD || "1000");
const QUIET = process.argv.includes("--quiet");

const CREATE_MARKET_TOPICS = [
  "0x8a41cabf57f8c9e58b85a041c8b6e82af3eb44c2a21833c0f03a639b5bcb1c49",
  "0xac4b2400f169220b0c0afdde7a0b32e775ba727ea1cb30b35f935cdaab8683ac",
];

const CHAIN_NAMES = {
  1: "Ethereum",
  10: "Optimism",
  130: "Unichain",
  137: "Polygon",
  146: "Sonic",
  1135: "Lisk",
  1868: "Soneium",
  8453: "Base",
  34443: "Mode",
  42161: "Arbitrum",
  42220: "Celo",
  534352: "Scroll",
  57073: "Ink",
  59144: "Linea",
};

const PYTH_CORE = {
  1: ["0x4305FB66699C3B2702D4d05CF36551390A4c69C6", "0x14b9932cc9AC8Ee03301665a8644A753f46D8552"],
  8453: ["0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a", "0xbC16aee60f64864882BC6C4E428e148Fc0E272F5"],
  42161: ["0xff1a0f4744e8582DF1aE09D5611b887B6a12925C", "0xe15357fB7ab31E091583b9c4b4135BB2f176f38e"],
};

const PYTH_SELECTORS = [
  "getPriceUnsafe(bytes32)",
  "getEmaPriceUnsafe(bytes32)",
  "getPriceNoOlderThan(bytes32,uint256)",
  "getEmaPriceNoOlderThan(bytes32,uint256)",
  "updatePriceFeeds(bytes[])",
  "parsePriceFeedUpdates(bytes[],bytes32[],uint64,uint64)",
].map((sig) => ({ sig, selector: ethers.id(sig).slice(2, 10).toLowerCase() }));

const ERC20 = new ethers.Interface([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
]);
const MORPHO = new ethers.Interface([
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee)",
]);
const ORACLE = new ethers.Interface([
  "function price() view returns (uint256)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
]);
const ABI = ethers.AbiCoder.defaultAbiCoder();

function argValue(name) {
  const prefix = `${name}=`;
  const item = process.argv.find((arg) => arg.startsWith(prefix));
  if (item) return item.slice(prefix.length);
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : null;
}

function parseChainIds(text, fallback) {
  if (!text) return fallback;
  const ids = String(text).split(/[\s,]+/).map((x) => Number(x.trim())).filter((x) => Number.isInteger(x) && x > 0);
  return ids.length ? [...new Set(ids)] : fallback;
}

function chainName(chainId) {
  return CHAIN_NAMES[chainId] || String(chainId);
}

function morphoCandidates(chainId) {
  const out = [MORPHO_BLUE];
  if (Number(chainId) === 42161) out.push(ARBITRUM_LEGACY_MORPHO);
  return [...new Set(out.map((x) => normalizeAddress(x)).filter(Boolean))];
}

function normalizeAddress(value) {
  try { return ethers.getAddress(value); } catch (_) { return null; }
}

function lowerAddress(value) {
  const addr = normalizeAddress(value);
  return addr ? addr.toLowerCase() : null;
}

function round(value, decimals = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const n = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function addressNeedle(address) {
  const normalized = lowerAddress(address);
  return normalized ? normalized.slice(2) : null;
}

async function safeCall(provider, to, data) {
  try { return await provider.call({ to, data }); } catch (_) { return null; }
}

async function codeBytes(provider, address) {
  try {
    const code = await provider.getCode(address);
    return Math.max(0, (code.length - 2) / 2);
  } catch (_) {
    return 0;
  }
}

async function hasCode(provider, address) {
  return (await codeBytes(provider, address)) > 0;
}

function decodeCreateMarket(log) {
  const data = String(log.data || "0x").slice(2);
  if (data.length < 320) return null;
  const loanToken = normalizeAddress(`0x${data.slice(24, 64)}`);
  const collateralToken = normalizeAddress(`0x${data.slice(88, 128)}`);
  const oracle = normalizeAddress(`0x${data.slice(152, 192)}`);
  const irm = normalizeAddress(`0x${data.slice(216, 256)}`);
  if (!loanToken || !collateralToken || !oracle || !irm) return null;
  const lltvRaw = BigInt(`0x${data.slice(256, 320)}`);
  const computedMarketId = ethers.keccak256(ABI.encode(
    ["address", "address", "address", "address", "uint256"],
    [loanToken, collateralToken, oracle, irm, lltvRaw],
  ));
  const topicMarketId = log.topics?.[1] && String(log.topics[1]).length === 66 ? log.topics[1] : null;
  return {
    txHash: log.transactionHash,
    logIndex: Number.parseInt(log.logIndex || "0x0", 16),
    blockNumber: Number.parseInt(log.blockNumber || "0x0", 16),
    topic: log.topics?.[0] || null,
    topicMarketId,
    computedMarketId,
    marketId: topicMarketId || computedMarketId,
    marketIdMatchesComputed: !topicMarketId || topicMarketId.toLowerCase() === computedMarketId.toLowerCase(),
    loanToken,
    collateralToken,
    oracle,
    irm,
    lltvRaw: lltvRaw.toString(),
    lltvPct: Number(lltvRaw) / 1e16,
  };
}

async function tokenMeta(provider, token) {
  const address = normalizeAddress(token);
  if (!address) return null;
  const [symbolRaw, nameRaw, decimalsRaw] = await Promise.all([
    safeCall(provider, address, ERC20.encodeFunctionData("symbol", [])),
    safeCall(provider, address, ERC20.encodeFunctionData("name", [])),
    safeCall(provider, address, ERC20.encodeFunctionData("decimals", [])),
  ]);
  const out = { address };
  try { if (symbolRaw) out.symbol = ERC20.decodeFunctionResult("symbol", symbolRaw)[0]; } catch (_) {}
  try { if (nameRaw) out.name = ERC20.decodeFunctionResult("name", nameRaw)[0]; } catch (_) {}
  try { if (decimalsRaw) out.decimals = Number(ERC20.decodeFunctionResult("decimals", decimalsRaw)[0]); } catch (_) {}
  return out;
}

async function readMarket(provider, morpho, marketId) {
  const raw = await safeCall(provider, morpho, MORPHO.encodeFunctionData("market", [marketId]));
  if (!raw) return null;
  try {
    const [totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee] = MORPHO.decodeFunctionResult("market", raw);
    return {
      totalSupplyAssets: totalSupplyAssets.toString(),
      totalSupplyShares: totalSupplyShares.toString(),
      totalBorrowAssets: totalBorrowAssets.toString(),
      totalBorrowShares: totalBorrowShares.toString(),
      lastUpdate: Number(lastUpdate),
      fee: fee.toString(),
    };
  } catch (_) {
    return null;
  }
}

async function inspectOracle(provider, rpc, chainId, oracleAddress) {
  const oracle = normalizeAddress(oracleAddress);
  if (!oracle) return { oracle: null, codeBytes: 0, impl: null, classification: "invalid-oracle" };
  const code = await provider.getCode(oracle).catch(() => "0x");
  const impl = await getImpl(rpc, oracle).catch(() => null);
  const implCode = impl ? await provider.getCode(impl).catch(() => "0x") : "0x";
  const combined = `${code}${implCode}`.toLowerCase();
  const unsafeSelectorHits = PYTH_SELECTORS.filter((entry) => combined.includes(entry.selector)).map((entry) => entry.sig);
  const pythAddressHits = (PYTH_CORE[chainId] || []).filter((address) => {
    const needle = addressNeedle(address);
    return needle && combined.includes(needle);
  }).map((address) => normalizeAddress(address));
  let priceCallOk = false;
  let latestRoundDataOk = false;
  try {
    const raw = await provider.call({ to: oracle, data: ORACLE.encodeFunctionData("price", []) });
    priceCallOk = Boolean(raw && raw !== "0x");
  } catch (_) {}
  try {
    const raw = await provider.call({ to: oracle, data: ORACLE.encodeFunctionData("latestRoundData", []) });
    latestRoundDataOk = Boolean(raw && raw !== "0x");
  } catch (_) {}
  const bytes = Math.max(0, (code.length - 2) / 2);
  const implBytes = Math.max(0, (implCode.length - 2) / 2);
  const pythLinked = unsafeSelectorHits.length > 0 || pythAddressHits.length > 0;
  const pythUnsafe = unsafeSelectorHits.some((sig) => /Unsafe/.test(sig));
  let classification = "custom-or-aggregated-morpho-oracle";
  if (pythUnsafe) classification = "pyth-unsafe";
  else if (pythLinked) classification = "pyth-linked";
  else if (latestRoundDataOk) classification = "chainlink-like-direct-feed";
  else if (bytes > 0 && bytes <= 256 && implBytes === 0) classification = "tiny-or-forwarder-oracle";
  else if (priceCallOk) classification = "morpho-price-oracle";
  else if (bytes === 0 && implBytes === 0) classification = "missing-code";
  return {
    oracle,
    impl: impl ? normalizeAddress(impl) : null,
    codeBytes: bytes,
    implCodeBytes: implBytes,
    priceCallOk,
    latestRoundDataOk,
    pythLinked,
    pythUnsafe,
    unsafeSelectorHits,
    pythAddressHits,
    classification,
  };
}

async function gql(query, variables = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(MORPHO_GQL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    const json = await res.json();
    if (json.errors) throw new Error(json.errors[0]?.message || "Morpho GraphQL error");
    return json.data || {};
  } finally {
    clearTimeout(timer);
  }
}

async function fetchGraphMarkets(chainId) {
  const query = `query($first:Int!) {
    markets(first:$first, where:{chainId_in:[${Number(chainId)}]}) { items {
      marketId lltv
      loanAsset { address symbol decimals }
      collateralAsset { address symbol decimals }
      oracle { address }
      state { liquidityAssetsUsd supplyAssetsUsd borrowAssetsUsd utilization }
    } }
  }`;
  const data = await gql(query, { first: MAX_GRAPH_MARKETS_PER_CHAIN }).catch(() => ({ markets: { items: [] } }));
  const map = new Map();
  for (const item of data?.markets?.items || []) {
    if (item.marketId) map.set(String(item.marketId).toLowerCase(), item);
  }
  return map;
}

async function blockTimestamp(provider, cache, blockNumber) {
  if (!Number.isFinite(blockNumber) || blockNumber <= 0) return null;
  if (!cache.has(blockNumber)) {
    const block = await provider.getBlock(blockNumber).catch(() => null);
    cache.set(blockNumber, block?.timestamp || null);
  }
  return cache.get(blockNumber);
}

async function getLogsChunked(rpc, address, fromBlock, toBlock, topic) {
  const logs = [];
  let failedChunks = 0;
  for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK_BLOCKS) {
    const end = Math.min(toBlock, start + LOG_CHUNK_BLOCKS - 1);
    const batch = await rpcCall(rpc, "eth_getLogs", [{
      address,
      fromBlock: `0x${start.toString(16)}`,
      toBlock: `0x${end.toString(16)}`,
      topics: [topic],
    }], 20_000);
    if (Array.isArray(batch)) logs.push(...batch);
    else failedChunks += 1;
    if (logs.length >= MAX_LOGS_PER_CHAIN) break;
  }
  return { logs: logs.slice(-MAX_LOGS_PER_CHAIN), failedChunks };
}

function rowFromDecoded(chainId, morphoAddress, decoded, graphMarket, marketState, loanToken, collateralToken, oracleInfo, timestamp, latestTimestamp) {
  const liquidityUsd = asNumber(graphMarket?.state?.liquidityAssetsUsd) || 0;
  const borrowUsd = asNumber(graphMarket?.state?.borrowAssetsUsd) || 0;
  const supplyUsd = asNumber(graphMarket?.state?.supplyAssetsUsd) || 0;
  const highLltv = (decoded.lltvPct || 0) >= MIN_LLTV_PCT;
  const materialLiquidity = liquidityUsd >= MIN_LIQUIDITY_USD;
  const materialBorrow = borrowUsd >= MIN_BORROW_USD;
  const nonChainlinkLike = oracleInfo && !oracleInfo.latestRoundDataOk;
  const customRisk = oracleInfo && ["pyth-unsafe", "pyth-linked", "tiny-or-forwarder-oracle", "custom-or-aggregated-morpho-oracle", "morpho-price-oracle"].includes(oracleInfo.classification);
  const watchCandidate = Boolean(highLltv && materialLiquidity && customRisk);
  return {
    chainId,
    chain: chainName(chainId),
    morpho: morphoAddress,
    blockNumber: decoded.blockNumber,
    blockTimestamp: timestamp,
    ageHours: timestamp && latestTimestamp ? round((latestTimestamp - timestamp) / 3600, 2) : null,
    txHash: decoded.txHash,
    marketId: decoded.marketId,
    computedMarketId: decoded.computedMarketId,
    marketIdMatchesComputed: decoded.marketIdMatchesComputed,
    pair: `${graphMarket?.collateralAsset?.symbol || collateralToken?.symbol || "?"}/${graphMarket?.loanAsset?.symbol || loanToken?.symbol || "?"}`,
    loanAsset: graphMarket?.loanAsset || loanToken,
    collateralAsset: graphMarket?.collateralAsset || collateralToken,
    oracle: oracleInfo?.oracle || decoded.oracle,
    oracleImpl: oracleInfo?.impl || null,
    oracleClassification: oracleInfo?.classification || "unknown",
    oracleCodeBytes: oracleInfo?.codeBytes ?? null,
    oracleImplCodeBytes: oracleInfo?.implCodeBytes ?? null,
    oraclePriceCallOk: Boolean(oracleInfo?.priceCallOk),
    oracleLatestRoundDataOk: Boolean(oracleInfo?.latestRoundDataOk),
    pythLinked: Boolean(oracleInfo?.pythLinked),
    pythUnsafe: Boolean(oracleInfo?.pythUnsafe),
    unsafeSelectorHits: oracleInfo?.unsafeSelectorHits || [],
    lltvPct: round(decoded.lltvPct, 2),
    liquidityUsd: round(liquidityUsd, 2),
    supplyUsd: round(supplyUsd, 2),
    borrowUsd: round(borrowUsd, 2),
    utilization: round(asNumber(graphMarket?.state?.utilization), 6),
    marketState,
    highLltv,
    materialLiquidity,
    materialBorrow,
    nonChainlinkLike,
    watchCandidate,
    routePositive: false,
    executableNow: false,
    blocker: watchCandidate
      ? "Fresh high-LLTV liquid Morpho market with custom/non-direct oracle; needs feed/source decode, accepted-vs-realizable value comparison, exact borrow/exit economics, and fork proof."
      : "Fresh market does not currently satisfy high-LLTV + material-liquidity + custom-oracle watch gate.",
  };
}

async function scanChain(chainId) {
  const rpc = await resolveRpc(chainId);
  const byContract = [];
  if (!rpc) return { chainId, chain: chainName(chainId), rpcResolved: false, contracts: byContract, rows: [], error: "missing-rpc" };
  const provider = new ethers.JsonRpcProvider(rpc, chainId, { staticNetwork: true });
  const latest = await provider.getBlock("latest").catch(() => null);
  if (!latest) return { chainId, chain: chainName(chainId), rpcResolved: true, contracts: byContract, rows: [], error: "missing-latest-block" };
  const fromBlock = Math.max(0, Number(latest.number) - LOOKBACK_BLOCKS);
  const graphMarkets = await fetchGraphMarkets(chainId);
  const rows = [];
  const blockCache = new Map();
  const tokenCache = new Map();
  const oracleCache = new Map();

  for (const morpho of morphoCandidates(chainId)) {
    const present = await hasCode(provider, morpho);
    const contractSummary = { address: morpho, codePresent: present, logsFound: 0, failedChunks: 0 };
    byContract.push(contractSummary);
    if (!present) continue;
    const rawLogs = [];
    for (const topic of CREATE_MARKET_TOPICS) {
      const result = await getLogsChunked(rpc, morpho, fromBlock, Number(latest.number), topic);
      rawLogs.push(...result.logs);
      contractSummary.failedChunks += result.failedChunks;
    }
    const deduped = [];
    const seen = new Set();
    for (const log of rawLogs) {
      const key = `${log.transactionHash}:${log.logIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(log);
    }
    deduped.sort((a, b) => Number.parseInt(a.blockNumber || "0x0", 16) - Number.parseInt(b.blockNumber || "0x0", 16));
    contractSummary.logsFound = deduped.length;
    for (const log of deduped.slice(-MAX_LOGS_PER_CHAIN)) {
      const decoded = decodeCreateMarket(log);
      if (!decoded) continue;
      const marketId = decoded.computedMarketId.toLowerCase();
      const graphMarket = graphMarkets.get(marketId) || graphMarkets.get(String(decoded.marketId).toLowerCase()) || null;
      const loanKey = lowerAddress(decoded.loanToken);
      const collateralKey = lowerAddress(decoded.collateralToken);
      const oracleKey = lowerAddress(decoded.oracle);
      if (!tokenCache.has(loanKey)) tokenCache.set(loanKey, await tokenMeta(provider, decoded.loanToken));
      if (!tokenCache.has(collateralKey)) tokenCache.set(collateralKey, await tokenMeta(provider, decoded.collateralToken));
      if (!oracleCache.has(oracleKey)) oracleCache.set(oracleKey, await inspectOracle(provider, rpc, chainId, decoded.oracle));
      const [marketState, timestamp] = await Promise.all([
        readMarket(provider, morpho, decoded.computedMarketId),
        blockTimestamp(provider, blockCache, decoded.blockNumber),
      ]);
      rows.push(rowFromDecoded(
        chainId,
        morpho,
        decoded,
        graphMarket,
        marketState,
        tokenCache.get(loanKey),
        tokenCache.get(collateralKey),
        oracleCache.get(oracleKey),
        timestamp,
        latest.timestamp,
      ));
    }
  }
  return {
    chainId,
    chain: chainName(chainId),
    rpcResolved: true,
    blockNumber: latest.number,
    blockTimestamp: latest.timestamp,
    lookbackBlocks: LOOKBACK_BLOCKS,
    graphMarketsFetched: graphMarkets.size,
    contracts: byContract,
    rows,
  };
}

function renderReport(artifact) {
  const s = artifact.summary;
  const topRows = artifact.rows.slice(0, 10).map((row) => `| ${row.chain} | ${row.pair} | ${row.ageHours ?? "n/a"} | ${row.lltvPct ?? "n/a"} | ${row.liquidityUsd ?? 0} | ${row.borrowUsd ?? 0} | ${row.oracleClassification} | ${row.watchCandidate ? "yes" : "no"} |`).join("\n");
  return [
    "# Fresh Morpho CreateMarket Scan",
    "",
    `Date: ${artifact.generatedAt.slice(0, 10)}`,
    "",
    "## Result",
    "",
    `Read-only scan over ${s.chainsScanned} chains and the last ${artifact.config.lookbackBlocks} blocks per chain. Found ${s.recentMarkets} recent markets, ${s.watchCandidates} watch candidates, and ${s.routePositive} route-positive rows.`,
    "",
    "## Summary",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Chains with RPC | ${s.chainsWithRpc} |`,
    `| Morpho contracts with code | ${s.morphoContractsWithCode} |`,
    `| Recent markets | ${s.recentMarkets} |`,
    `| High LLTV rows | ${s.highLltvRows} |`,
    `| Material liquidity rows | ${s.materialLiquidityRows} |`,
    `| Material borrow rows | ${s.materialBorrowRows} |`,
    `| Non-direct-Chainlink/custom oracle rows | ${s.nonChainlinkLikeRows} |`,
    `| Watch candidates | ${s.watchCandidates} |`,
    `| Route-positive | ${s.routePositive} |`,
    "",
    "## Top Rows",
    "",
    "| Chain | Pair | Age h | LLTV % | Liquidity USD | Borrow USD | Oracle | Watch |",
    "| --- | --- | ---: | ---: | ---: | ---: | --- | --- |",
    topRows || "| n/a | n/a | n/a | n/a | 0 | 0 | n/a | no |",
    "",
    "## Gate",
    "",
    "A watch row is not route-positive. Escalation requires oracle/source decode, accepted value versus executable reference value, borrow or liquidation cash, exact exit liquidity, gas/slippage haircut, and fork extraction proof.",
    "",
    "## Artifacts",
    "",
    "- JSON: `reports/raw/fast/recent-morpho-create-markets.json`",
    "- Scanner: `tools/scan-recent-morpho-create-markets.js`",
    "",
  ].join("\n");
}

async function main() {
  const chains = [];
  for (const chainId of CHAINS) chains.push(await scanChain(chainId));
  const rows = chains.flatMap((chain) => chain.rows || []).sort((a, b) =>
    Number(b.watchCandidate) - Number(a.watchCandidate)
    || Number(b.materialBorrow) - Number(a.materialBorrow)
    || (b.borrowUsd || 0) - (a.borrowUsd || 0)
    || (b.liquidityUsd || 0) - (a.liquidityUsd || 0)
    || (a.ageHours ?? 1e9) - (b.ageHours ?? 1e9)
  );
  const summary = {
    chainsScanned: CHAINS.length,
    chainsWithRpc: chains.filter((chain) => chain.rpcResolved).length,
    morphoContractsWithCode: chains.reduce((sum, chain) => sum + (chain.contracts || []).filter((contract) => contract.codePresent).length, 0),
    recentMarkets: rows.length,
    highLltvRows: rows.filter((row) => row.highLltv).length,
    materialLiquidityRows: rows.filter((row) => row.materialLiquidity).length,
    materialBorrowRows: rows.filter((row) => row.materialBorrow).length,
    nonChainlinkLikeRows: rows.filter((row) => row.nonChainlinkLike).length,
    pythLinkedRows: rows.filter((row) => row.pythLinked).length,
    pythUnsafeRows: rows.filter((row) => row.pythUnsafe).length,
    watchCandidates: rows.filter((row) => row.watchCandidate).length,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    status: rows.some((row) => row.watchCandidate) ? "watch-candidates-need-route-economics" : "no-fresh-route-positive-morpho-market",
  };
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-recent-morpho-create-markets.js",
    scope: "Read-only recent Morpho CreateMarket event scan across configured chains",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
    },
    config: {
      chains: CHAINS,
      lookbackBlocks: LOOKBACK_BLOCKS,
      logChunkBlocks: LOG_CHUNK_BLOCKS,
      maxLogsPerChain: MAX_LOGS_PER_CHAIN,
      maxGraphMarketsPerChain: MAX_GRAPH_MARKETS_PER_CHAIN,
      minLltvPct: MIN_LLTV_PCT,
      minLiquidityUsd: MIN_LIQUIDITY_USD,
      minBorrowUsd: MIN_BORROW_USD,
    },
    summary,
    byChain: Object.fromEntries(chains.map((chain) => [chain.chainId, {
      chain: chain.chain,
      rpcResolved: Boolean(chain.rpcResolved),
      blockNumber: chain.blockNumber || null,
      graphMarketsFetched: chain.graphMarketsFetched || 0,
      contracts: chain.contracts || [],
      recentMarkets: (chain.rows || []).length,
      watchCandidates: (chain.rows || []).filter((row) => row.watchCandidate).length,
      error: chain.error || null,
    }])),
    rows: rows.slice(0, 150),
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`);
  fs.writeFileSync(REPORT_OUT, renderReport(artifact));
  if (!QUIET) {
    console.log(`Recent Morpho CreateMarket: markets=${summary.recentMarkets} watch=${summary.watchCandidates} routePositive=0`);
    console.log(`Report: ${path.relative(WORKSPACE, OUT)}`);
  }
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
