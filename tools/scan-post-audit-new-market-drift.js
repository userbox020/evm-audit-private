#!/usr/bin/env node
// Read-only post-audit new-market drift scanner.
// RPC URLs are resolved through tools/shared-rpc in memory only and are never printed or stored.

const fs = require("fs");
const path = require("path");
const { resolveRpcPool, rpcCall, PUBLIC_FALLBACKS } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "post-audit-new-market-drift.json");
const OUT_MD = path.join(WORKSPACE, "reports", "post-audit-new-market-drift-triage.md");
const QUIET = process.argv.includes("--quiet");

const FILES = {
  consumerFirstHighLtv: path.join(WORKSPACE, "reports", "raw", "fast", "consumer-first-high-ltv-collateral.json"),
  recentMorphoCreateMarkets: path.join(WORKSPACE, "reports", "raw", "fast", "recent-morpho-create-markets.json"),
  eulerV2Phase0: path.join(WORKSPACE, "reports", "raw", "fast", "euler-v2-phase0.json"),
  siloV2Phase0: path.join(WORKSPACE, "reports", "raw", "fast", "silo-v2-phase0.json"),
  newVaultDonationAttack: path.join(WORKSPACE, "reports", "raw", "fast", "new-vault-donation-attack.json"),
  evaultDonationSensitivity: path.join(WORKSPACE, "reports", "raw", "fast", "evault-donation-sensitivity.json"),
  erc4626ConsumerJoiner: path.join(WORKSPACE, "reports", "raw", "fast", "erc4626-consumer-joiner.json"),
  marketLaunchChoreographyRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "market-launch-choreography-routes.json"),
};

const DEFAULT_CHAINS = [1, 8453, 42161, 10, 137, 130, 42220, 1135, 1868, 534352, 146, 57073, 59144, 34443];
const CHAIN_NAMES = {
  1: "Ethereum",
  10: "Optimism",
  56: "BNB Chain",
  130: "Unichain",
  137: "Polygon",
  146: "Sonic",
  480: "World Chain",
  999: "Hyperliquid",
  1135: "Lisk",
  1868: "Soneium",
  34443: "Mode",
  42161: "Arbitrum",
  42220: "Celo",
  43114: "Avalanche",
  534352: "Scroll",
  57073: "Ink",
  59144: "Linea",
  80094: "Berachain",
};

const MORPHO_BLUE = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const ARBITRUM_LEGACY_MORPHO = "0x6c247b1F6182318877311737BaC0844bAa518F5e";
const MORPHO_CREATE_MARKET_TOPICS = [
  "0x8a41cabf57f8c9e58b85a041c8b6e82af3eb44c2a21833c0f03a639b5bcb1c49",
  "0xac4b2400f169220b0c0afdde7a0b32e775ba727ea1cb30b35f935cdaab8683ac",
];
const MORPHO_VAULT_FACTORIES = {
  1: [{ name: "MetaMorphoFactory", address: "0xA1D94F746dEfa1928926b84fB2596c06926C0405", deployTopic: "0x341ce009267aa0d78cc12b34155e223904a51ed49d144beb6eb8be87813edb4e", vaultTopicIndex: 3 }],
  8453: [{ name: "MetaMorphoFactory", address: "0x4501125508079A99ebBebCE205DeC9593C2b5857", deployTopic: "0x341ce009267aa0d78cc12b34155e223904a51ed49d144beb6eb8be87813edb4e", vaultTopicIndex: 3 }],
};

const POST_AUDIT_BASELINE = argValue("--baseline") || process.env.POST_AUDIT_DRIFT_BASELINE || null;
const SCAN_LOGS = !process.argv.includes("--artifact-only") && process.env.POST_AUDIT_DRIFT_SCAN_LOGS !== "0";
const LOOKBACK_BLOCKS = Number(argValue("--lookback-blocks") || process.env.POST_AUDIT_DRIFT_LOOKBACK_BLOCKS || "50000");
const LOG_CHUNK_BLOCKS = Number(argValue("--log-chunk-blocks") || process.env.POST_AUDIT_DRIFT_LOG_CHUNK_BLOCKS || "50000");
const MAX_LOGS_PER_CHAIN = Number(argValue("--max-logs-per-chain") || process.env.POST_AUDIT_DRIFT_MAX_LOGS_PER_CHAIN || "50");
const MAX_RPC_CHAINS = Number(argValue("--max-rpc-chains") || process.env.POST_AUDIT_DRIFT_MAX_RPC_CHAINS || "2");
const MAX_ROWS = Number(argValue("--max-rows") || process.env.POST_AUDIT_DRIFT_MAX_ROWS || "200");
const TOP_ROWS = Number(argValue("--top-rows") || process.env.POST_AUDIT_DRIFT_TOP_ROWS || "40");
const MIN_LTV = Number(argValue("--min-ltv") || process.env.POST_AUDIT_DRIFT_MIN_LTV || "0.85");
const MIN_LTV_PCT = MIN_LTV <= 1 ? MIN_LTV * 100 : MIN_LTV;
const MIN_MATERIAL_BORROW_USD = Number(argValue("--min-borrow-usd") || process.env.POST_AUDIT_DRIFT_MIN_BORROW_USD || "1000");
const MIN_MATERIAL_LIQUIDITY_USD = Number(argValue("--min-liquidity-usd") || process.env.POST_AUDIT_DRIFT_MIN_LIQUIDITY_USD || "10000");
const LOW_TVL_USD = Number(argValue("--low-tvl-usd") || process.env.POST_AUDIT_DRIFT_LOW_TVL_USD || "50000");
const USE_SHARED_RPC_POOL = process.env.POST_AUDIT_DRIFT_USE_SHARED_RPC_POOL === "1" || process.argv.includes("--use-shared-rpc-pool");

function argValue(name) {
  const prefix = `${name}=`;
  const item = process.argv.find((arg) => arg.startsWith(prefix));
  if (item) return item.slice(prefix.length);
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : null;
}

function parseChainIds(text, fallback) {
  if (!text) return [...fallback];
  const ids = String(text).split(/[\s,]+/).map((x) => Number(x.trim())).filter((x) => Number.isInteger(x) && x > 0);
  return ids.length ? [...new Set(ids)] : [...fallback];
}

function rel(file) {
  return path.relative(WORKSPACE, file).replace(/\\/g, "/");
}

function chainName(chainId) {
  return CHAIN_NAMES[Number(chainId)] || String(chainId);
}

function readJsonWithMeta(key, file) {
  const meta = { key, path: rel(file), exists: false, parsed: false, generatedAt: null, scanner: null, summary: null, rows: null, error: null };
  try {
    if (!fs.existsSync(file)) {
      meta.error = "missing-input-artifact";
      return { meta, data: null };
    }
    meta.exists = true;
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    meta.parsed = true;
    meta.generatedAt = data?.generatedAt || null;
    meta.scanner = data?.scanner || null;
    meta.summary = summarizeInput(data);
    meta.rows = countRows(data);
    return { meta, data };
  } catch (err) {
    meta.error = `parse-failed:${String(err?.message || err).slice(0, 120)}`;
    return { meta, data: null };
  }
}

function summarizeInput(data) {
  if (!data || typeof data !== "object") return null;
  const summary = data.summary && typeof data.summary === "object" ? { ...data.summary } : null;
  if (!summary) return null;
  // Keep input metadata compact and report-safe.
  for (const key of Object.keys(summary)) {
    if (summary[key] && typeof summary[key] === "object") delete summary[key];
  }
  return summary;
}

function countRows(data) {
  if (!data || typeof data !== "object") return 0;
  const direct = [data.rows, data.topRows, data.vaultRows].filter(Array.isArray).reduce((sum, rows) => sum + rows.length, 0);
  if (direct) return direct;
  if (Array.isArray(data.results)) {
    return data.results.reduce((sum, result) => sum + (Array.isArray(result?.highLtvRowsDetail) ? result.highLtvRowsDetail.length : 0) + (Array.isArray(result?.topCandidates) ? result.topCandidates.length : 0), 0);
  }
  return 0;
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value).replace(/[$,%\s,_]/g, "");
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 6) {
  const n = asNumber(value);
  if (n === null) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function bool(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

function lowerAddress(value) {
  const text = String(value || "").trim();
  return /^0x[0-9a-fA-F]{40}$/.test(text) ? text.toLowerCase() : null;
}

function canonicalAddress(value) {
  const lower = lowerAddress(value);
  return lower ? `0x${lower.slice(2)}` : null;
}

function keyFor(chainId, address) {
  const lower = lowerAddress(address);
  return Number(chainId) && lower ? `${Number(chainId)}:${lower}` : null;
}

function marketKey(row) {
  const chainId = Number(row?.chainId);
  const protocol = String(row?.protocol || row?.sourceProtocol || row?.source || "unknown").toLowerCase();
  const id = String(row?.marketId || row?.consumer?.marketId || row?.consumer?.id || row?.consumer?.silo || row?.consumer?.config || row?.vault || row?.id || "").toLowerCase();
  const collateral = lowerAddress(row?.collateral?.address || row?.collateralAsset?.address || row?.consumer?.collateralAsset?.address || row?.collateralVault || row?.asset || row?.silo);
  const borrow = lowerAddress(row?.borrowAsset?.address || row?.loanAsset?.address || row?.consumer?.loanAsset?.address || row?.asset || row?.borrowEvault);
  if (!chainId) return null;
  return `${chainId}:${protocol}:${id || "unknown"}:${collateral || "unknown"}:${borrow || "unknown"}`;
}

function decodeAddressTopic(word) {
  const text = String(word || "");
  if (!/^0x[0-9a-fA-F]{64}$/.test(text)) return null;
  return canonicalAddress(`0x${text.slice(-40)}`);
}

function toBlockHex(n) {
  return `0x${Math.max(0, Math.floor(Number(n) || 0)).toString(16)}`;
}

function morphoCandidates(chainId) {
  const out = [MORPHO_BLUE];
  if (Number(chainId) === 42161) out.push(ARBITRUM_LEGACY_MORPHO);
  return [...new Set(out.map(canonicalAddress).filter(Boolean))];
}

function decodeMorphoCreateMarketLog(log) {
  const data = String(log?.data || "0x").slice(2);
  if (data.length < 320) return null;
  const loanToken = canonicalAddress(`0x${data.slice(24, 64)}`);
  const collateralToken = canonicalAddress(`0x${data.slice(88, 128)}`);
  const oracle = canonicalAddress(`0x${data.slice(152, 192)}`);
  const irm = canonicalAddress(`0x${data.slice(216, 256)}`);
  if (!loanToken || !collateralToken || !oracle || !irm) return null;
  let lltvRaw;
  try { lltvRaw = BigInt(`0x${data.slice(256, 320)}`); } catch (_) { return null; }
  const topicMarketId = log?.topics?.[1] && String(log.topics[1]).length === 66 ? String(log.topics[1]).toLowerCase() : null;
  return {
    chainId: null,
    blockNumber: Number.parseInt(log.blockNumber || "0x0", 16),
    txHash: log.transactionHash || null,
    logIndex: Number.parseInt(log.logIndex || "0x0", 16),
    marketId: topicMarketId,
    loanAsset: { address: loanToken },
    collateralAsset: { address: collateralToken },
    oracle,
    irm,
    lltvRaw: lltvRaw.toString(),
    lltvPct: Number(lltvRaw) / 1e16,
  };
}

async function getLatestBlock(rpc) {
  const block = await rpcCall(rpc, "eth_getBlockByNumber", ["latest", false], 8_000).catch(() => null);
  if (!block?.number) return null;
  return {
    number: Number(BigInt(block.number)),
    timestamp: block.timestamp ? Number(BigInt(block.timestamp)) : null,
    iso: block.timestamp ? new Date(Number(BigInt(block.timestamp)) * 1000).toISOString() : null,
  };
}

async function getLogsChunked(rpc, queryBase, fromBlock, toBlock) {
  const logs = [];
  let failedChunks = 0;
  for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK_BLOCKS) {
    const end = Math.min(toBlock, start + LOG_CHUNK_BLOCKS - 1);
    const batch = await rpcCall(rpc, "eth_getLogs", [{ ...queryBase, fromBlock: toBlockHex(start), toBlock: toBlockHex(end) }], 20_000).catch(() => null);
    if (Array.isArray(batch)) logs.push(...batch);
    else failedChunks += 1;
    if (logs.length >= MAX_LOGS_PER_CHAIN) break;
  }
  return { logs: logs.slice(-MAX_LOGS_PER_CHAIN), failedChunks };
}

async function scanFactoryLogs(chainIds) {
  const out = {
    mode: SCAN_LOGS ? (USE_SHARED_RPC_POOL ? "shared-rpc-pool-log-discovery" : "shared-rpc-public-fallback-log-discovery") : "artifact-only-disabled",
    requestedChainIds: chainIds,
    resolvedChainIds: [],
    chains: {},
    marketLogs: [],
    vaultLogs: [],
    caveats: [],
  };
  if (!SCAN_LOGS || chainIds.length === 0) return out;
  let rpcPool = {};
  if (USE_SHARED_RPC_POOL) {
    try {
      rpcPool = await resolveRpcPool(chainIds);
    } catch (_) {
      out.mode = "artifact-only-rpc-resolution-failed";
      out.caveats.push("shared-rpc resolution failed; scanner used local artifacts only for drift classification");
      return out;
    }
  } else {
    // Keep the default run bounded and secret-safe: use shared-rpc's public fallbacks
    // through rpcCall, without reading or persisting local endpoint inventory.
    rpcPool = Object.fromEntries(chainIds.map((chainId) => [chainId, PUBLIC_FALLBACKS[chainId]]).filter(([, url]) => Boolean(url)));
    out.caveats.push("direct log discovery used shared-rpc public fallbacks only; local RPC endpoint inventory was not read by this scanner");
  }

  for (const chainId of chainIds) {
    const rpc = rpcPool[chainId];
    const chain = { chainId, chain: chainName(chainId), rpcResolved: Boolean(rpc), blockNumber: null, fromBlock: null, marketFactoryLogs: 0, vaultFactoryLogs: 0, failedChunks: 0, errors: [] };
    out.chains[chainId] = chain;
    if (!rpc) {
      chain.errors.push("missing-rpc");
      continue;
    }
    out.resolvedChainIds.push(chainId);
    const latest = await getLatestBlock(rpc).catch(() => null);
    if (!latest?.number) {
      chain.errors.push("missing-latest-block");
      continue;
    }
    chain.blockNumber = latest.number;
    chain.blockTimestamp = latest.timestamp;
    chain.fromBlock = Math.max(0, latest.number - LOOKBACK_BLOCKS);

    for (const morpho of morphoCandidates(chainId)) {
      for (const topic of MORPHO_CREATE_MARKET_TOPICS) {
        const result = await getLogsChunked(rpc, { address: morpho, topics: [topic] }, chain.fromBlock, latest.number);
        chain.failedChunks += result.failedChunks;
        for (const log of result.logs) {
          const decoded = decodeMorphoCreateMarketLog(log);
          if (!decoded) continue;
          decoded.chainId = chainId;
          decoded.chain = chainName(chainId);
          decoded.morpho = morpho;
          decoded.source = "shared-rpc-morpho-create-market-log";
          decoded.blockTimestamp = null;
          out.marketLogs.push(decoded);
        }
      }
    }

    for (const factory of MORPHO_VAULT_FACTORIES[chainId] || []) {
      const result = await getLogsChunked(rpc, { address: factory.address, topics: [factory.deployTopic] }, chain.fromBlock, latest.number);
      chain.failedChunks += result.failedChunks;
      for (const log of result.logs) {
        const vault = decodeAddressTopic(log?.topics?.[factory.vaultTopicIndex]) || decodeAddressTopic(log?.topics?.[1]);
        out.vaultLogs.push({
          chainId,
          chain: chainName(chainId),
          source: "shared-rpc-morpho-vault-factory-log",
          factory: factory.address,
          factoryName: factory.name,
          vault,
          blockNumber: Number.parseInt(log.blockNumber || "0x0", 16),
          txHash: log.transactionHash || null,
          logIndex: Number.parseInt(log.logIndex || "0x0", 16),
        });
      }
    }
    chain.marketFactoryLogs = out.marketLogs.filter((row) => row.chainId === chainId).length;
    chain.vaultFactoryLogs = out.vaultLogs.filter((row) => row.chainId === chainId).length;
  }

  if (out.resolvedChainIds.length === 0) {
    out.mode = "artifact-only-no-rpc-resolved";
    out.caveats.push("shared-rpc resolved no requested chains; scanner used local artifacts only for drift classification");
  }
  return out;
}

function addClassifier(map, chainId, address, classifier) {
  const key = keyFor(chainId, address);
  if (!key) return;
  const prev = map.get(key) || { chainId: Number(chainId), address: canonicalAddress(address), classifiers: [] };
  const id = `${classifier.kind}:${classifier.source}:${classifier.detail || ""}`;
  if (!prev.classifiers.some((entry) => `${entry.kind}:${entry.source}:${entry.detail || ""}` === id)) prev.classifiers.push(classifier);
  map.set(key, prev);
}

function addRiskClassifiersFromNewVault(map, artifact) {
  for (const row of uniqueRows([artifact?.rows, artifact?.topRows])) {
    const vault = row?.vault || row;
    const address = vault?.address || row?.address || row?.vault;
    const chainId = Number(row?.chainId || vault?.chainId);
    if (!chainId || !lowerAddress(address)) continue;
    const totalAssetsUsd = asNumber(vault?.totalAssetsUsd ?? row?.totalAssetsUsd);
    const lowTvl = bool(row?.lowTvl) || bool(row?.tinyTvl) || (totalAssetsUsd !== null && totalAssetsUsd <= LOW_TVL_USD);
    const donationSensitive = lowTvl || bool(row?.watchCandidate) || bool(row?.preforkDonationPositive);
    addClassifier(map, chainId, address, {
      kind: "erc4626-donation-preflight",
      source: "new-vault-donation-attack",
      detail: lowTvl ? "low-tvl-or-tiny-vault" : "vault-donation-model-row",
      donationSensitive,
      lowTvl,
      depositOpen: row?.depositOpen ?? null,
      totalAssetsUsd: round(totalAssetsUsd, 4),
      watchCandidate: bool(row?.watchCandidate),
      exactEconomicsPositive: bool(row?.preforkDonationPositive),
      forkProof: false,
      routePositive: false,
    });
  }
}

function addRiskClassifiersFromEvaultDonation(map, artifact) {
  for (const row of artifact?.rows || []) {
    const chainId = Number(row?.chainId);
    const address = row?.collateral;
    if (!chainId || !lowerAddress(address)) continue;
    const netEdgeUsd = asNumber(row?.economics?.netEdgeUsd);
    const premiumGapBps = asNumber(row?.economics?.premiumGapBps);
    addClassifier(map, chainId, address, {
      kind: "evault-donation-sensitivity",
      source: "evault-donation-sensitivity",
      detail: bool(row?.publicMintOpen) ? "public-mint-open" : "sensitivity-row",
      donationSensitive: true,
      lowTvl: asNumber(row?.totalAssetsUsd) !== null && asNumber(row?.totalAssetsUsd) <= LOW_TVL_USD,
      publicMintOpen: row?.publicMintOpen ?? null,
      netEdgeUsd: round(netEdgeUsd, 6),
      premiumGapBps: round(premiumGapBps, 6),
      watchCandidate: bool(row?.watchCandidate),
      exactEconomicsPositive: netEdgeUsd !== null && netEdgeUsd > 0,
      forkProof: false,
      routePositive: false,
    });
  }
}

function addRiskClassifiersFromErc4626Joiner(map, artifact) {
  for (const result of artifact?.results || []) {
    for (const row of result?.topCandidates || []) {
      const vault = row?.vault || {};
      const address = vault?.address || row?.vault;
      const chainId = Number(row?.chainId || vault?.chainId || result?.chainId);
      if (!chainId || !lowerAddress(address)) continue;
      const totalAssetsUsd = asNumber(vault?.totalAssetsUsd);
      addClassifier(map, chainId, address, {
        kind: "erc4626-consumer-join",
        source: "erc4626-consumer-joiner",
        detail: row?.type || "consumer-join",
        consumerJoin: true,
        side: row?.side || null,
        lowTvl: totalAssetsUsd !== null && totalAssetsUsd <= LOW_TVL_USD,
        totalAssetsUsd: round(totalAssetsUsd, 4),
        watchCandidate: bool(row?.watchCandidate),
        exactEconomicsPositive: false,
        forkProof: false,
        routePositive: false,
      });
    }
  }
}

function addRiskClassifiersFromMarketLaunch(map, artifact) {
  for (const row of artifact?.rows || artifact?.topRows || []) {
    const chainId = Number(row?.chainId);
    const address = row?.collateral?.address;
    if (!chainId || !lowerAddress(address)) continue;
    addClassifier(map, chainId, address, {
      kind: "market-launch-choreography",
      source: "market-launch-choreography-routes",
      detail: row?.routeGate?.status || (row?.watchCandidate ? "watch" : "blocked"),
      lowTvl: bool(row?.launchSignals?.lowProducerTvl) || bool(row?.launchSignals?.zeroOrLowMarketSupply),
      consumerJoin: false,
      donationSensitive: false,
      watchCandidate: bool(row?.watchCandidate),
      exactEconomicsPositive: bool(row?.routeGate?.exactEconomicsPositive),
      forkProof: bool(row?.routeGate?.forkProof),
      routePositive: bool(row?.routePositive) && bool(row?.routeGate?.exactEconomicsPositive) && bool(row?.routeGate?.forkProof),
    });
  }
}

function addRiskClassifiersFromRecentMorpho(map, artifact) {
  for (const row of artifact?.rows || []) {
    const chainId = Number(row?.chainId);
    const address = row?.collateralAsset?.address;
    if (!chainId || !lowerAddress(address)) continue;
    const customOracle = isCustomOracle(row);
    if (!customOracle) continue;
    addClassifier(map, chainId, address, {
      kind: "custom-or-staleness-oracle-preflight",
      source: "recent-morpho-create-markets",
      detail: row?.oracleClassification || "non-direct-oracle",
      customOracle: true,
      oracleClassification: row?.oracleClassification || null,
      pythLinked: bool(row?.pythLinked),
      pythUnsafe: bool(row?.pythUnsafe),
      watchCandidate: bool(row?.watchCandidate),
      exactEconomicsPositive: false,
      forkProof: false,
      routePositive: false,
    });
  }
}

function uniqueRows(groups) {
  const out = [];
  const seen = new Set();
  for (const rows of groups) {
    for (const row of rows || []) {
      const key = JSON.stringify([row?.chainId || row?.vault?.chainId, lowerAddress(row?.vault?.address || row?.address || row?.vault), row?.marketId || row?.type || row?.source]);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }
  }
  return out;
}

function collectBaselineHighLtvRows(artifact) {
  const rows = [];
  for (const result of artifact?.results || []) {
    for (const row of result?.highLtvRowsDetail || []) {
      rows.push({ ...row, chainId: Number(row?.chainId || result?.chainId), chain: row?.chain || result?.chain, source: "consumer-first-high-ltv-collateral" });
    }
  }
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = marketKey(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function collectEulerRows(artifact) {
  const rows = [];
  for (const vault of artifact?.vaultRows || []) {
    const chainId = Number(vault?.chainId);
    if (!chainId) continue;
    for (const ltv of vault?.highLtvRows || []) {
      rows.push({
        source: "euler-v2-phase0",
        sourceProtocol: "Euler EVK",
        protocol: "Euler EVK",
        chainId,
        chain: vault?.chain || chainName(chainId),
        marketId: `${vault?.vault || "unknown"}:${ltv?.collateralVault || "unknown"}`,
        consumer: { evault: vault?.vault, oracle: vault?.oracle },
        collateral: { address: ltv?.collateralVault, symbol: null },
        borrowAsset: { address: vault?.asset, symbol: vault?.assetSymbol, decimals: vault?.assetDecimals },
        ltv: asNumber(ltv?.ltvBorrowBps) !== null ? asNumber(ltv?.ltvBorrowBps) / 10000 : null,
        routeLiquidityUsd: round(vault?.cashUsd, 6),
        borrowAssetsUsd: round(vault?.totalBorrowsUsd, 6),
        highLtv: true,
        materialBorrow: bool(vault?.materialBorrowCash) || (asNumber(vault?.cashUsd) || 0) >= MIN_MATERIAL_BORROW_USD,
      });
    }
  }
  return rows;
}

function collectSiloRows(artifact) {
  const rows = [];
  for (const row of artifact?.rows || []) {
    const chainId = Number(row?.chainId);
    const ltv = asNumber(row?.maxLtv);
    if (!chainId || ltv === null || ltv < MIN_LTV) continue;
    rows.push({
      source: "silo-v2-phase0",
      sourceProtocol: "Silo V2",
      protocol: "Silo V2",
      chainId,
      chain: row?.chain || chainName(chainId),
      marketId: String(row?.id ?? row?.config ?? row?.silo ?? "unknown"),
      consumer: { id: row?.id, config: row?.config, silo: row?.silo, solvencyOracle: row?.solvencyOracle, maxLtvOracle: row?.maxLtvOracle },
      collateral: { address: row?.asset, symbol: row?.assetSymbol, decimals: row?.assetDecimals },
      borrowAsset: { address: row?.oppositeAsset || null, symbol: row?.oppositeAssetSymbol || null },
      ltv,
      routeLiquidityUsd: round(row?.liquidityUsd, 6),
      borrowAssetsUsd: round(row?.debtAssetsUsd, 6),
      highLtv: true,
      materialBorrow: (asNumber(row?.liquidityUsd) || 0) >= MIN_MATERIAL_LIQUIDITY_USD || (asNumber(row?.debtAssetsUsd) || 0) >= MIN_MATERIAL_BORROW_USD,
    });
  }
  return rows;
}

function normalizeRecentMorphoRow(row, baselineTimestampSec) {
  const chainId = Number(row?.chainId);
  const lltvPct = asNumber(row?.lltvPct);
  const liquidityUsd = asNumber(row?.liquidityUsd);
  const borrowUsd = asNumber(row?.borrowUsd);
  const blockTimestamp = asNumber(row?.blockTimestamp);
  return {
    source: "recent-morpho-create-markets",
    sourceProtocol: "Morpho Blue",
    protocol: "Morpho Blue",
    chainId,
    chain: row?.chain || chainName(chainId),
    marketId: row?.marketId || row?.computedMarketId || null,
    blockNumber: row?.blockNumber || null,
    blockTimestamp: blockTimestamp || null,
    txHash: row?.txHash || null,
    consumer: { marketId: row?.marketId || row?.computedMarketId || null, oracle: row?.oracle || null },
    collateral: row?.collateralAsset || null,
    borrowAsset: row?.loanAsset || null,
    ltv: lltvPct !== null ? lltvPct / 100 : null,
    lltvPct,
    routeLiquidityUsd: round(liquidityUsd, 6),
    borrowAssetsUsd: round(borrowUsd, 6),
    supplyAssetsUsd: round(row?.supplyUsd, 6),
    oracle: row?.oracle || null,
    oracleClassification: row?.oracleClassification || null,
    pythLinked: bool(row?.pythLinked),
    pythUnsafe: bool(row?.pythUnsafe),
    highLtv: lltvPct !== null && lltvPct >= MIN_LTV_PCT,
    materialBorrow: (borrowUsd || 0) >= MIN_MATERIAL_BORROW_USD || (liquidityUsd || 0) >= MIN_MATERIAL_LIQUIDITY_USD,
    customOracle: isCustomOracle(row),
    newSinceBaselineArtifact: blockTimestamp !== null && baselineTimestampSec !== null ? blockTimestamp >= baselineTimestampSec : true,
  };
}

function normalizeLiveMarketLog(row) {
  const chainId = Number(row?.chainId);
  const lltvPct = asNumber(row?.lltvPct);
  return {
    source: "shared-rpc-morpho-create-market-log",
    sourceProtocol: "Morpho Blue",
    protocol: "Morpho Blue",
    chainId,
    chain: row?.chain || chainName(chainId),
    marketId: row?.marketId || null,
    blockNumber: row?.blockNumber || null,
    blockTimestamp: null,
    txHash: row?.txHash || null,
    consumer: { marketId: row?.marketId || null, oracle: row?.oracle || null },
    collateral: row?.collateralAsset || null,
    borrowAsset: row?.loanAsset || null,
    ltv: lltvPct !== null ? lltvPct / 100 : null,
    lltvPct,
    routeLiquidityUsd: null,
    borrowAssetsUsd: null,
    supplyAssetsUsd: null,
    oracle: row?.oracle || null,
    oracleClassification: "live-log-uninspected",
    highLtv: lltvPct !== null && lltvPct >= MIN_LTV_PCT,
    materialBorrow: false,
    customOracle: false,
    newSinceBaselineArtifact: true,
    coverageCaveat: "live log decoded without graph state/oracle bytecode enrichment; economics fail closed",
  };
}

function isCustomOracle(row) {
  if (bool(row?.pythUnsafe) || bool(row?.pythLinked)) return true;
  if (row?.oracleLatestRoundDataOk === false) return true;
  const cls = String(row?.oracleClassification || "").toLowerCase();
  return /pyth|unsafe|custom|aggregated|morpho-price|tiny|forwarder|stale|missing-code|non-direct/.test(cls);
}

function classifyMarket(row, classifiers, baselineCollateralSet) {
  const chainId = Number(row?.chainId);
  const collateralAddress = row?.collateral?.address || row?.collateralAsset?.address || row?.collateral;
  const ckey = keyFor(chainId, collateralAddress);
  const linked = ckey ? classifiers.get(ckey)?.classifiers || [] : [];
  const hasDonation = linked.some((entry) => entry.donationSensitive || entry.kind.includes("donation"));
  const hasConsumerJoin = linked.some((entry) => entry.consumerJoin || entry.kind.includes("consumer-join"));
  const hasLowTvl = linked.some((entry) => entry.lowTvl);
  const hasCustomOracleClassifier = linked.some((entry) => entry.customOracle || entry.kind.includes("staleness") || entry.kind.includes("oracle"));
  const exactEconomicsPositive = linked.some((entry) => entry.exactEconomicsPositive === true);
  const forkProof = linked.some((entry) => entry.forkProof === true);
  const importedRoutePositive = linked.some((entry) => entry.routePositive === true);
  const routePositive = Boolean(importedRoutePositive && exactEconomicsPositive && forkProof);
  const highLtv = bool(row?.highLtv) || (asNumber(row?.ltv) !== null && asNumber(row?.ltv) >= MIN_LTV) || (asNumber(row?.lltvPct) !== null && asNumber(row?.lltvPct) >= MIN_LTV_PCT);
  const materialBorrow = bool(row?.materialBorrow) || (asNumber(row?.borrowAssetsUsd) || 0) >= MIN_MATERIAL_BORROW_USD || (asNumber(row?.routeLiquidityUsd) || 0) >= MIN_MATERIAL_LIQUIDITY_USD;
  const customOracle = bool(row?.customOracle) || hasCustomOracleClassifier;
  const vulnerableCollateral = hasDonation || hasConsumerJoin || hasLowTvl || hasCustomOracleClassifier;
  const newCollateralSinceBaseline = ckey ? !baselineCollateralSet.has(ckey) : null;
  const recent = row?.source === "recent-morpho-create-markets" || row?.source === "shared-rpc-morpho-create-market-log" || bool(row?.newSinceBaselineArtifact);
  const watchCandidate = Boolean(recent && highLtv && vulnerableCollateral && !routePositive);
  const blockers = [];
  if (!recent) blockers.push("Row is not known to be post-baseline drift");
  if (!highLtv) blockers.push(`LTV/LLTV below ${MIN_LTV}`);
  if (!vulnerableCollateral) blockers.push("Collateral has no linked donation/staleness/ERC4626 classifier");
  if (!materialBorrow) blockers.push("Borrow/liquidity is not material or is unavailable in the source artifact");
  blockers.push("No exact collateral acquisition, borrow, and exit economics");
  blockers.push("No fork proof; fail-closed route-positive gate remains shut");

  return {
    protocol: row?.protocol || row?.sourceProtocol || "unknown",
    chainId,
    chain: row?.chain || chainName(chainId),
    source: row?.source || "unknown",
    marketId: row?.marketId || row?.consumer?.marketId || null,
    blockNumber: row?.blockNumber || null,
    blockTimestamp: row?.blockTimestamp || null,
    txHash: row?.txHash || null,
    consumer: row?.consumer || null,
    collateral: row?.collateral || row?.collateralAsset || null,
    borrowAsset: row?.borrowAsset || row?.loanAsset || null,
    ltv: round(row?.ltv, 6),
    lltvPct: round(row?.lltvPct, 4),
    routeLiquidityUsd: round(row?.routeLiquidityUsd, 4),
    borrowAssetsUsd: round(row?.borrowAssetsUsd, 4),
    supplyAssetsUsd: round(row?.supplyAssetsUsd, 4),
    oracle: row?.oracle || row?.consumer?.oracle || null,
    oracleClassification: row?.oracleClassification || null,
    newSinceBaselineArtifact: row?.newSinceBaselineArtifact ?? recent,
    newCollateralSinceBaseline,
    risk: {
      highLtv,
      materialBorrow,
      customOracle,
      lowTvlCollateral: hasLowTvl,
      donationSensitive: hasDonation,
      consumerJoin: hasConsumerJoin,
      vulnerableCollateral,
      exactEconomicsPositive,
      forkProof,
    },
    classifiers: linked,
    watchCandidate,
    routePositive,
    executableNow: false,
    signedActionJustified: false,
    coverageCaveat: row?.coverageCaveat || null,
    gate: {
      status: routePositive ? "route-positive-imported-with-exact-proof" : (watchCandidate ? "watch-only-needs-exact-economics-and-fork" : "blocked-or-informational"),
      exactEconomicsPositive,
      forkProof,
      importedRoutePositive,
    },
    blockers,
  };
}

function scoreRow(row) {
  let score = 0;
  if (row.watchCandidate) score += 100;
  if (row.risk.highLtv) score += 20;
  if (row.risk.materialBorrow) score += 20;
  if (row.risk.donationSensitive) score += 18;
  if (row.risk.lowTvlCollateral) score += 14;
  if (row.risk.consumerJoin) score += 12;
  if (row.risk.customOracle) score += 10;
  if (row.newCollateralSinceBaseline) score += 8;
  score += Math.min(20, Math.log10(Math.max(1, asNumber(row.routeLiquidityUsd) || 1)) * 2);
  return round(score, 3);
}

function countBy(rows, fn) {
  const out = {};
  for (const row of rows || []) {
    const key = fn(row) || "unknown";
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function buildByChain(chainIds, rows, factoryScan, recentVaultArtifactByChain = {}) {
  const all = new Set([...chainIds, ...rows.map((row) => Number(row.chainId)).filter(Boolean), ...Object.keys(factoryScan?.chains || {}).map(Number)]);
  const out = {};
  for (const chainId of [...all].sort((a, b) => a - b)) {
    const chainRows = rows.filter((row) => Number(row.chainId) === Number(chainId));
    const scan = factoryScan?.chains?.[chainId] || null;
    out[chainId] = {
      chain: chainName(chainId),
      rpcResolved: scan ? Boolean(scan.rpcResolved) : false,
      blockNumber: scan?.blockNumber || null,
      fromBlock: scan?.fromBlock || null,
      factoryLogRows: (scan?.marketFactoryLogs || 0) + (scan?.vaultFactoryLogs || 0),
      recentMarketRows: chainRows.filter((row) => row.source === "recent-morpho-create-markets" || row.source === "shared-rpc-morpho-create-market-log").length,
      recentVaultRows: (asNumber(recentVaultArtifactByChain[chainId]) || 0) + (factoryScan?.vaultLogs || []).filter((row) => Number(row.chainId) === Number(chainId)).length,
      highLtvRows: chainRows.filter((row) => row.risk?.highLtv).length,
      materialBorrowRows: chainRows.filter((row) => row.risk?.materialBorrow).length,
      customOracleRows: chainRows.filter((row) => row.risk?.customOracle).length,
      lowTvlCollateralRows: chainRows.filter((row) => row.risk?.lowTvlCollateral).length,
      watchCandidates: chainRows.filter((row) => row.watchCandidate).length,
      routePositive: 0,
      caveats: scan?.errors || [],
    };
  }
  return out;
}

function table(rows, headers) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${headers.map((h) => String(row[h] ?? "").replace(/\r?\n/g, " ").replace(/\|/g, "/")).join(" | ")} |`),
  ].join("\n");
}

function renderReport(artifact) {
  const s = artifact.summary;
  const topWatch = artifact.topRows.filter((row) => row.watchCandidate).slice(0, 10).map((row) => ({
    Protocol: row.protocol,
    Chain: row.chain,
    Collateral: row.collateral?.symbol || row.collateral?.address || "",
    Borrow: row.borrowAsset?.symbol || row.borrowAsset?.address || "",
    LTV: row.lltvPct !== null && row.lltvPct !== undefined ? `${row.lltvPct}%` : row.ltv,
    LiquidityUSD: row.routeLiquidityUsd ?? "n/a",
    Classifier: row.classifiers?.[0]?.kind || "",
    Gate: row.gate?.status || "",
  }));
  const blockers = [
    { Blocker: "No exact positive economics", Evidence: `exactEconomicsRows=${s.exactEconomicsRows}` },
    { Blocker: "No fork proof", Evidence: `forkProofRows=${s.forkProofRows}` },
    { Blocker: "No signed action justification", Evidence: `routePositive=${s.routePositive}, executableNow=${s.executableNow}, signedActionJustified=${s.signedActionJustified}` },
    { Blocker: "Coverage is bounded", Evidence: artifact.caveats.length ? artifact.caveats.join("; ") : "No blocking coverage caveat recorded" },
  ];
  return [
    "# Post-Audit New-Market Drift Triage",
    "",
    `Date: ${artifact.generatedAt.slice(0, 10)}`,
    "",
    "Artifact: `reports/raw/fast/post-audit-new-market-drift.json`",
    "",
    "Signal: ⚪ CLEAN / watch-only — no confirmed permissionless extraction; routePositive=0, executableNow=0, signedActionJustified=false.",
    "",
    "## Result",
    "",
    `Status: **${s.status}**. The scanner reviewed \`${s.marketsScanned}\` market rows and \`${s.vaultsScanned}\` vault/factory rows, found \`${s.watchCandidates}\` watch-only candidates, and kept \`routePositive=0\` / \`executableNow=0\` / \`signedActionJustified=false\`.`,
    "",
    "The pass was read-only. RPC endpoints, if resolved, were used only in memory through `tools/shared-rpc`; no endpoint URLs, env files, private keys, signed transactions, fork transactions, broadcasts, wallet operations, or exploit calls were used.",
    "",
    "## Key Counts",
    "",
    table([
      { Metric: "Recent market rows", Value: s.recentMarketRows },
      { Metric: "Recent vault rows", Value: s.recentVaultRows },
      { Metric: "Factory log rows", Value: s.factoryLogRows },
      { Metric: "High-LTV rows", Value: s.highLtvRows },
      { Metric: "Material-borrow rows", Value: s.materialBorrowRows },
      { Metric: "Custom/staleness oracle rows", Value: s.customOracleRows },
      { Metric: "Low-TVL collateral rows", Value: s.lowTvlCollateralRows },
      { Metric: "Donation-sensitive rows", Value: s.donationSensitiveRows },
      { Metric: "ERC4626 consumer-join rows", Value: s.consumerJoinRows },
      { Metric: "Watch candidates", Value: s.watchCandidates },
      { Metric: "Exact economics rows", Value: s.exactEconomicsRows },
      { Metric: "Fork-proof rows", Value: s.forkProofRows },
    ], ["Metric", "Value"]),
    "",
    "## Top Watch Candidates",
    "",
    topWatch.length ? table(topWatch, ["Protocol", "Chain", "Collateral", "Borrow", "LTV", "LiquidityUSD", "Classifier", "Gate"]) : "No immediate watch candidates were identified.",
    "",
    "## Blockers",
    "",
    table(blockers, ["Blocker", "Evidence"]),
    "",
    "## Next Read-Only Steps",
    "",
    `- ${artifact.nextReadOnlyStep}`,
    "- Re-run the relevant producer-specific scanner for any watch row before considering fork work.",
    "- Promote only if exact acquisition, borrow, exit, gas/slippage, and fork-proof gates all pass.",
    "",
  ].join("\n");
}

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  const loaded = Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, readJsonWithMeta(key, file)]));
  const inputMeta = Object.fromEntries(Object.entries(loaded).map(([key, item]) => [key, item.meta]));
  const consumerFirst = loaded.consumerFirstHighLtv.data || {};
  const recentMorpho = loaded.recentMorphoCreateMarkets.data || {};
  const eulerPhase0 = loaded.eulerV2Phase0.data || {};
  const siloPhase0 = loaded.siloV2Phase0.data || {};
  const newVaultDonation = loaded.newVaultDonationAttack.data || {};
  const evaultDonation = loaded.evaultDonationSensitivity.data || {};
  const erc4626Joiner = loaded.erc4626ConsumerJoiner.data || {};
  const marketLaunch = loaded.marketLaunchChoreographyRoutes.data || {};

  const baselineIso = POST_AUDIT_BASELINE || consumerFirst?.generatedAt || "2026-06-24T23:09:09.898Z";
  const baselineTimestampSec = Number.isFinite(Date.parse(baselineIso)) ? Math.floor(Date.parse(baselineIso) / 1000) : null;
  const baselineHighLtvRows = collectBaselineHighLtvRows(consumerFirst);
  const baselineCollateralSet = new Set(baselineHighLtvRows.map((row) => keyFor(row.chainId, row?.collateral?.address || row?.consumer?.collateralAsset?.address)).filter(Boolean));
  const baselineMarketSet = new Set(baselineHighLtvRows.map(marketKey).filter(Boolean));

  const classifiers = new Map();
  addRiskClassifiersFromNewVault(classifiers, newVaultDonation);
  addRiskClassifiersFromEvaultDonation(classifiers, evaultDonation);
  addRiskClassifiersFromErc4626Joiner(classifiers, erc4626Joiner);
  addRiskClassifiersFromMarketLaunch(classifiers, marketLaunch);
  addRiskClassifiersFromRecentMorpho(classifiers, recentMorpho);

  const configuredChains = parseChainIds(argValue("--chains") || process.env.POST_AUDIT_DRIFT_CHAINS || recentMorpho?.config?.chains?.join(","), DEFAULT_CHAINS);
  const chainIdsForRpc = configuredChains.slice(0, Math.max(0, MAX_RPC_CHAINS));
  const factoryScan = await scanFactoryLogs(chainIdsForRpc);

  const recentMarketArtifactRows = (recentMorpho?.rows || []).map((row) => normalizeRecentMorphoRow(row, baselineTimestampSec)).filter((row) => Number(row.chainId));
  const liveMarketRows = (factoryScan.marketLogs || []).map(normalizeLiveMarketLog).filter((row) => Number(row.chainId));
  const eulerRows = collectEulerRows(eulerPhase0);
  const siloRows = collectSiloRows(siloPhase0);

  const rawMarketRows = [...recentMarketArtifactRows, ...liveMarketRows, ...eulerRows, ...siloRows];
  const dedupedMarketRows = [];
  const seenMarkets = new Set();
  for (const row of rawMarketRows) {
    const key = marketKey(row) || JSON.stringify([row.chainId, row.source, row.marketId, row.txHash, row.blockNumber]);
    if (seenMarkets.has(key)) continue;
    seenMarkets.add(key);
    dedupedMarketRows.push(row);
  }

  const classifiedRows = dedupedMarketRows
    .map((row) => classifyMarket(row, classifiers, baselineCollateralSet))
    .map((row) => ({ ...row, driftScore: scoreRow(row), baselineMarketKnown: baselineMarketSet.has(marketKey(row)) }))
    .sort((a, b) => Number(b.watchCandidate) - Number(a.watchCandidate)
      || Number(b.risk.materialBorrow) - Number(a.risk.materialBorrow)
      || Number(b.risk.highLtv) - Number(a.risk.highLtv)
      || Number(b.driftScore || 0) - Number(a.driftScore || 0)
      || Number(b.routeLiquidityUsd || 0) - Number(a.routeLiquidityUsd || 0));

  const rows = classifiedRows.slice(0, MAX_ROWS);
  const exactEconomicsRows = classifiedRows.filter((row) => row.gate.exactEconomicsPositive).length;
  const forkProofRows = classifiedRows.filter((row) => row.gate.forkProof).length;
  const routePositive = classifiedRows.filter((row) => row.routePositive && row.gate.exactEconomicsPositive && row.gate.forkProof).length;
  const executableNow = 0;
  const recentVaultArtifactByChain = Object.fromEntries(Object.entries(newVaultDonation?.chains || {}).map(([chainId, row]) => [Number(chainId), asNumber(row?.recentFactoryVaults) || 0]));
  const recentVaultRows = Object.values(recentVaultArtifactByChain).reduce((sum, value) => sum + (asNumber(value) || 0), 0) + (factoryScan.vaultLogs || []).length;
  const factoryLogRows = (factoryScan.marketLogs || []).length + (factoryScan.vaultLogs || []).length;
  const caveats = [];
  for (const meta of Object.values(inputMeta)) if (!meta.parsed) caveats.push(`${meta.path}: ${meta.error}`);
  if (factoryScan.mode !== "shared-rpc-log-discovery") caveats.push(...(factoryScan.caveats || [factoryScan.mode]));
  if (SCAN_LOGS && factoryScan.resolvedChainIds.length < chainIdsForRpc.length) caveats.push(`shared-rpc coverage ${factoryScan.resolvedChainIds.length}/${chainIdsForRpc.length} requested chains; missing chains fail closed`);
  if (configuredChains.length > chainIdsForRpc.length) caveats.push(`direct log discovery bounded to ${chainIdsForRpc.length}/${configuredChains.length} configured chains; remaining chains covered by artifacts only`);
  if (factoryLogRows === 0) caveats.push("no live factory logs were discovered in bounded lookback; artifact-only drift evidence dominates");

  const summary = {
    marketsScanned: dedupedMarketRows.length,
    vaultsScanned: (newVaultDonation?.summary?.candidateVaults || 0) + (erc4626Joiner?.summary?.vaultsInput || 0) + (factoryScan.vaultLogs || []).length,
    factoryLogRows,
    recentMarketRows: recentMarketArtifactRows.length + liveMarketRows.length,
    recentVaultRows,
    highLtvRows: classifiedRows.filter((row) => row.risk.highLtv).length,
    materialBorrowRows: classifiedRows.filter((row) => row.risk.materialBorrow).length,
    customOracleRows: classifiedRows.filter((row) => row.risk.customOracle).length,
    lowTvlCollateralRows: classifiedRows.filter((row) => row.risk.lowTvlCollateral).length,
    watchCandidates: classifiedRows.filter((row) => row.watchCandidate).length,
    donationSensitiveRows: classifiedRows.filter((row) => row.risk.donationSensitive).length,
    consumerJoinRows: classifiedRows.filter((row) => row.risk.consumerJoin).length,
    exactEconomicsRows,
    forkProofRows,
    routePositive: routePositive > 0 && exactEconomicsRows > 0 && forkProofRows > 0 ? routePositive : 0,
    executableNow,
    signedActionJustified: false,
    status: routePositive > 0 && exactEconomicsRows > 0 && forkProofRows > 0
      ? "route-positive-imported-needs-human-review"
      : classifiedRows.some((row) => row.watchCandidate)
        ? "watch-only-new-market-drift-needs-exact-economics"
        : "no-route-positive-post-audit-new-market-drift",
  };

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-post-audit-new-market-drift.js",
    scope: "Read-only post-audit new-market drift scan since the 2026-06-24 high-LTV baseline artifact",
    safety: {
      rpcInventoryRead: Boolean(SCAN_LOGS && USE_SHARED_RPC_POOL),
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      liveTransactions: false,
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
    },
    config: {
      baselineArtifact: inputMeta.consumerFirstHighLtv.path,
      baselineGeneratedAt: baselineIso,
      baselineTimestampSec,
      minLtv: MIN_LTV,
      minLtvPct: MIN_LTV_PCT,
      minMaterialBorrowUsd: MIN_MATERIAL_BORROW_USD,
      minMaterialLiquidityUsd: MIN_MATERIAL_LIQUIDITY_USD,
      lowTvlUsd: LOW_TVL_USD,
      scanLogs: SCAN_LOGS,
      useSharedRpcPool: USE_SHARED_RPC_POOL,
      logLookbackBlocks: LOOKBACK_BLOCKS,
      logChunkBlocks: LOG_CHUNK_BLOCKS,
      maxLogsPerChain: MAX_LOGS_PER_CHAIN,
      configuredChains,
      rpcChainsAttempted: chainIdsForRpc,
      maxRows: MAX_ROWS,
      topRows: TOP_ROWS,
    },
    inputs: inputMeta,
    summary,
    byChain: buildByChain(configuredChains, classifiedRows, factoryScan, recentVaultArtifactByChain),
    rows,
    topRows: classifiedRows.slice(0, TOP_ROWS),
    factoryDiscovery: {
      mode: factoryScan.mode,
      requestedChainIds: factoryScan.requestedChainIds,
      resolvedChainIds: factoryScan.resolvedChainIds,
      marketLogs: (factoryScan.marketLogs || []).slice(0, 50),
      vaultLogs: (factoryScan.vaultLogs || []).slice(0, 50),
      caveats: factoryScan.caveats,
    },
    classifierSummary: {
      collateralKeys: classifiers.size,
      byKind: countBy([...classifiers.values()].flatMap((entry) => entry.classifiers), (entry) => entry.kind),
    },
    caveats,
    requiredForRoutePositive: [
      "post-baseline market/vault creation or configuration is confirmed on chain",
      "new market is high-LTV/LLTV with borrow-side liquidity and permissive caps/pause state",
      "collateral has an attacker-favorable donation, stale/custom oracle, or ERC4626 accounting path",
      "collateral acquisition/deposit path is permissionless and exact-quoted for target size",
      "borrow and exit routes are exact-quoted after slippage, fees, and gas",
      "exact economics are positive",
      "fork proof demonstrates positive net value without privileged actions",
    ],
    nextReadOnlyStep: summary.watchCandidates > 0
      ? "For each watch candidate, decode the producer/oracle path and exact-quote collateral acquisition plus borrow/exit liquidity; do not fork until exact economics are positive."
      : "Refresh recent market/vault artifacts and rerun producer-specific donation/oracle scanners; keep fail-closed unless exact positive economics and fork proof appear.",
  };

  fs.writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`);
  fs.writeFileSync(OUT_MD, `${renderReport(artifact)}\n`);
  if (!QUIET) {
    console.log(`Post-audit new-market drift: markets=${summary.marketsScanned} recentMarkets=${summary.recentMarketRows} recentVaults=${summary.recentVaultRows} watch=${summary.watchCandidates} routePositive=0 status=${summary.status}`);
    console.log(`Artifact: ${rel(OUT)}`);
  }
}

main().catch((err) => {
  const message = String(err?.stack || err?.message || err).replace(/https?:\/\/[^\s'"<>]+/g, "[redacted-url]");
  console.error(message);
  process.exitCode = 1;
});
