#!/usr/bin/env node
// Read-only USDT0 consumer joiner. Uses existing sanitized artifacts only;
// it does not read RPC endpoints or send transactions.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "usdt0-consumer-routes.json");

const FILES = {
  oft: path.join(WORKSPACE, "reports", "raw", "fast", "usdt0-oft-routes.json"),
  hyperlend: path.join(WORKSPACE, "reports", "raw", "fast", "hyperlend-live.json"),
  monitorState: path.join(WORKSPACE, "reports", "monitor", "state.json"),
  folks: path.join(WORKSPACE, "reports", "raw", "fast", "folks-live.json"),
  derive: path.join(WORKSPACE, "reports", "raw", "fast", "derive-v2-live.json"),
  e12xDryRuns: path.join(WORKSPACE, "reports", "raw", "fast", "e12x-route-dry-runs.json"),
  currentProfitLeads: path.join(WORKSPACE, "reports", "raw", "fast", "current-profit-leads.json"),
  dolomiteLive: path.join(WORKSPACE, "reports", "raw", "dolomite-berachain-live-map.json"),
  dolomiteOracle: path.join(WORKSPACE, "reports", "raw", "dolomite-berachain-oracle-candidate-analysis.json"),
  tydroReport: path.join(WORKSPACE, "reports", "tydro-triage.md"),
  venusReport: path.join(WORKSPACE, "reports", "venus-multichain-triage.md"),
  hyperlendReport: path.join(WORKSPACE, "reports", "hyperlend-triage.md"),
  aaveEulerSiloGraph: path.join(WORKSPACE, "reports", "raw", "fast", "aave-euler-silo-consumer-graph.json"),
};

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return null;
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (_) {
    return "";
  }
}

function norm(value) {
  const s = String(value || "").toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(s) ? s : null;
}

function hasUsdt0Symbol(value) {
  return /usdt0|usd[t₮]0|usd₮0/i.test(String(value || ""));
}

function walk(value, visitor, pathParts = [], out = []) {
  if (out.length > 2000) return out;
  if (!value || typeof value !== "object") return out;
  if (visitor(value, pathParts)) out.push({ path: pathParts.join("."), value });
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, visitor, pathParts.concat(String(i)), out));
  } else {
    for (const [key, child] of Object.entries(value)) walk(child, visitor, pathParts.concat(key), out);
  }
  return out;
}

function collectUsdt0Addresses(oft) {
  const addresses = new Set();
  for (const scan of oft?.scans || []) {
    const docsToken = norm(scan.docs?.token);
    if (docsToken) addresses.add(docsToken);
    const tokenAddress = norm(scan.token?.address);
    if (tokenAddress && hasUsdt0Symbol(scan.token?.symbol || scan.token?.name)) addresses.add(tokenAddress);
  }
  return addresses;
}

function mapHyperlend(hyperlend, monitorState, addresses) {
  const reserve = (hyperlend?.coreReserves || []).find((r) => addresses.has(norm(r.token)) || hasUsdt0Symbol(r.symbol));
  const liquidity = (monitorState?.conditions?.hyperlend?.reserveLiquidity || []).find((r) => addresses.has(norm(r.asset)) || hasUsdt0Symbol(r.symbol));
  const stale = (monitorState?.conditions?.hyperlend?.staleSourceWatchpoints || []).find((r) => hasUsdt0Symbol(r.symbol));
  if (!reserve && !liquidity && !stale) return null;
  const cashUsd = liquidity?.cashUsd ?? null;
  const watch = Boolean(reserve?.active && reserve?.borrowingEnabled && cashUsd >= 1_000_000 && stale);
  return {
    id: "hyperlend-hyperevm-usdt0",
    protocol: "HyperLend",
    chain: "HyperEVM",
    chainId: 999,
    token: reserve?.token || liquidity?.asset || null,
    consumerType: "lending-reserve",
    facts: {
      symbol: reserve?.symbol || liquidity?.symbol || stale?.symbol || "USDT0",
      priceUsd: reserve?.priceUsd ?? null,
      ltv: reserve?.ltv ?? liquidity?.ltv ?? null,
      liquidationThreshold: reserve?.liquidationThreshold ?? null,
      active: reserve?.active ?? null,
      borrowingEnabled: reserve?.borrowingEnabled ?? liquidity?.borrowing ?? null,
      paused: reserve?.paused ?? null,
      oracleType: reserve?.oracleSourceInfo?.type || null,
      oracleDescription: reserve?.oracleSourceInfo?.feed?.description || reserve?.oracleSourceInfo?.description || null,
      oracleFeedAgeSeconds: reserve?.oracleFeedAgeSeconds ?? stale?.age ?? null,
      oracleVsRefPct: reserve?.oracleVsRefPct ?? stale?.divergence ?? null,
      cashUsd,
      routeCandidates: monitorState?.conditions?.hyperlend?.routeCandidates?.length || 0,
    },
    watchCandidate: watch,
    routePositive: false,
    blockers: [
      reserve?.oracleVsRefPct === null || reserve?.oracleVsRefPct === undefined ? "no reliable live reference divergence" : "divergence below route threshold",
      (monitorState?.conditions?.hyperlend?.routeCandidates?.length || 0) === 0 ? "no current HyperLend route candidates" : null,
      "no HyperEVM executor/fork proof for this branch",
    ].filter(Boolean),
  };
}

function mapFolks(folks, addresses) {
  const objects = walk(folks, (obj) => {
    return hasUsdt0Symbol(obj.docsSymbol) || hasUsdt0Symbol(obj.symbol) || addresses.has(norm(obj.docsAddress)) || addresses.has(norm(obj.actualAddress));
  }).map((x) => x.value);
  const pools = objects.filter((obj) => obj.docsSymbol && obj.poolState);
  const caps = objects.filter((obj) => obj.symbol && Object.prototype.hasOwnProperty.call(obj, "collateralUsed"));
  if (!pools.length && !caps.length) return [];
  return pools.map((pool) => {
    const cap = caps.find((c) => String(c.symbol || "").toLowerCase() === String(pool.docsSymbol || "").toLowerCase());
    const availableLiquidity = Number(pool.poolState?.availableLiquidity || 0) / 1e6;
    const totalDebt = Number(pool.poolState?.totalDebt || 0) / 1e6;
    const hasBreaker = Boolean(pool.oracle?.rootNode?.hasStalenessBreaker);
    return {
      id: `folks-${String(pool.docsSymbol || "usdt0").toLowerCase()}`,
      protocol: "Folks Finance",
      chain: String(pool.docsSymbol || "").split("_").pop() || "unknown",
      chainId: null,
      token: pool.actualAddress || pool.docsAddress || null,
      consumerType: "lending-pool",
      facts: {
        docsSymbol: pool.docsSymbol,
        fTokenSymbol: pool.erc20?.symbol || null,
        totalSupply: pool.erc20?.totalSupplyFormatted || null,
        availableLiquidity,
        totalDebt,
        utilizationBps: pool.poolState?.utilizationBps ?? null,
        collateralUsed: cap?.collateralUsed || null,
        borrowUsed: cap?.borrowUsed || null,
        collateralFactorBps: cap?.collateralFactorBps ?? null,
        borrowCap: cap?.borrowCap || null,
        oracleNodeType: pool.oracle?.rootNode?.nodeTypeName || null,
        hasStalenessBreaker: hasBreaker,
        oracleAgeSeconds: pool.oracle?.rootNode?.output?.ageSeconds ?? null,
      },
      watchCandidate: Boolean(availableLiquidity > 1_000_000 && totalDebt > 1_000_000 && !hasBreaker),
      routePositive: false,
      blockers: [
        hasBreaker ? "oracle has staleness breaker" : "oracle breaker not confirmed",
        "no live depeg/stale divergence mapped",
        "no fork-positive liquidation/borrow route",
      ],
    };
  });
}

function mapDerive(derive, addresses) {
  const hits = walk(derive, (obj) => {
    return addresses.has(norm(obj.token)) || addresses.has(norm(obj.tokenMeta?.address)) || hasUsdt0Symbol(obj.symbol) || hasUsdt0Symbol(obj.tokenMeta?.symbol);
  }).map((x) => x.value);
  const vaults = hits.filter((obj) => obj.vault && (obj.balance || obj.tokenMeta));
  const bestByVault = new Map();
  for (const obj of vaults) {
    const token = obj.token || obj.tokenMeta?.address || null;
    const key = `${obj.vault}:${norm(token) || token}`;
    const prev = bestByVault.get(key);
    const score = (obj.chainId ? 4 : 0) + (obj.chain ? 2 : 0) + (obj.views?.owner ? 1 : 0);
    if (!prev || score > prev.score) bestByVault.set(key, { obj, token, score });
  }
  return [...bestByVault.values()].map(({ obj, token }, i) => ({
    id: `derive-v2-usdt0-${i}`,
    protocol: "Derive V2",
    chain: obj.chain || "unknown",
    chainId: obj.chainId ?? null,
    token,
    consumerType: "custody-vault",
    facts: {
      vault: obj.vault,
      balance: obj.balance?.formatted || obj.balance || null,
      symbol: obj.symbol || obj.tokenMeta?.symbol || null,
      owner: obj.views?.owner || null,
      flags: obj.flags || [],
      connectors: obj.connectors || null,
    },
    watchCandidate: false,
    routePositive: false,
    blockers: ["custody balance only", "no public drain/liquidation path mapped"],
  }));
}

function mapE12xDryRuns(e12x) {
  const hits = walk(e12x, (obj) => hasUsdt0Symbol(obj.loan?.symbol) || hasUsdt0Symbol(obj.symbol)).map((x) => x.value);
  return hits.filter((obj) => obj.loan?.symbol).map((obj, i) => ({
    id: `morpho-arbitrum-usdt0-${i}`,
    protocol: "Morpho Blue",
    chain: obj.chain || "unknown",
    chainId: obj.chainId ?? null,
    token: obj.loan?.address || null,
    consumerType: "morpho-loan-market",
    facts: {
      marketId: obj.marketId || null,
      loanSymbol: obj.loan?.symbol || null,
      collateralSymbol: obj.collateral?.symbol || null,
      lltvPct: obj.lltvPct ?? null,
      morphoLiquidityUsd: obj.morphoLiquidityUsd ?? null,
      divergencePct: obj.divergencePct ?? null,
      netProfitUsd: obj.netProfitUsd ?? null,
      routePositive: obj.routePositive ?? false,
      autoExecutable: obj.autoExecutable ?? false,
    },
    watchCandidate: false,
    routePositive: Boolean(obj.routePositive),
    blockers: obj.blockers || ["current dry-run route is not positive"],
  }));
}

function mapCurrentProfitLeads(leads, addresses) {
  const rows = [];
  for (const lead of leads?.leads || []) {
    const underlyings = lead.underlying || [];
    if (hasUsdt0Symbol(lead.symbol) || underlyings.some((addr) => addresses.has(norm(addr)))) {
      rows.push({
        id: `yield-${lead.project || "unknown"}-${lead.pool || rows.length}`,
        protocol: lead.project || "unknown",
        chain: lead.chain || "unknown",
        chainId: null,
        token: underlyings.find((addr) => addresses.has(norm(addr))) || null,
        consumerType: "yield-or-dex-lead",
        facts: {
          symbol: lead.symbol,
          tvlUsd: lead.tvlUsd ?? null,
          apyPct: lead.apyPct ?? null,
          candidateRoute: lead.candidateRoute || null,
          score: lead.score ?? null,
        },
        watchCandidate: false,
        routePositive: false,
        blockers: ["public yield signal only", "no on-chain route-positive economics"],
      });
    }
  }
  return rows;
}

function parseTydro(report) {
  const line = report.split(/\r?\n/).find((l) => /\|\s*2\s*\|\s*USDT0\s*\|/.test(l));
  if (!line) return null;
  const cells = line.split("|").map((x) => x.trim()).filter(Boolean);
  return {
    id: "tydro-ink-usdt0",
    protocol: "Tydro Aave V3",
    chain: "Ink",
    chainId: 57073,
    token: null,
    consumerType: "aave-reserve",
    facts: {
      marketRow: line.trim(),
      collateral: cells[2] || null,
      borrow: cells[3] || null,
      caps: cells[5] || null,
      supply: cells[6] || null,
      debt: cells[7] || null,
      cash: cells[8] || null,
      notes: cells[9] || null,
    },
    watchCandidate: true,
    routePositive: false,
    blockers: ["AaveOracle stale risk is residual only", "borrow/liquidation price path parity", "largest liquidatable debt was dust in Tydro scan"],
  };
}

function parseVenus(report) {
  const line = report.split(/\r?\n/).find((l) => /\|\s*USDT0\s*\|/.test(l));
  if (!line) return null;
  return {
    id: "venus-usdt0-oracle-row",
    protocol: "Venus",
    chain: "multichain",
    chainId: null,
    token: null,
    consumerType: "oracle-config-reference",
    facts: { row: line.trim() },
    watchCandidate: false,
    routePositive: false,
    blockers: ["oracle row only", "no live Venus USDT0 borrow route joined in current artifacts"],
  };
}

function mapDolomite(live, oracle, addresses) {
  const hits = walk({ live, oracle }, (obj) => addresses.has(norm(obj.token)) || addresses.has(norm(obj.address)) || hasUsdt0Symbol(obj.symbol) || hasUsdt0Symbol(obj.name)).map((x) => x.value);
  if (!hits.length) return [];
  const sample = hits.slice(0, 8).map((obj) => ({
    token: obj.token || obj.address || null,
    symbol: obj.symbol || null,
    name: obj.name || null,
    marketId: obj.marketId ?? obj.id ?? null,
  }));
  return [{
    id: "dolomite-berachain-usdt0",
    protocol: "Dolomite",
    chain: "Berachain",
    chainId: 80094,
    token: sample.find((row) => row.token)?.token || null,
    consumerType: "market-or-oracle-reference",
    facts: {
      hitCount: hits.length,
      sample,
    },
    watchCandidate: false,
    routePositive: false,
    blockers: ["existing Dolomite triage found no profitable path", "no USDT0-specific route-positive economics"],
  }];
}

function mapAaveEulerSiloGraph(graph, addresses) {
  const rows = [];
  for (const result of graph?.results || []) {
    for (const match of result.topMatches || []) {
      const producerAddress = norm(match.producer?.address);
      const marketReserve = norm(match.market?.reserve || match.market?.token || match.market?.asset);
      if (!addresses.has(producerAddress) && !addresses.has(marketReserve) && !hasUsdt0Symbol(match.producer?.symbol) && !hasUsdt0Symbol(match.market?.symbol || match.market?.tokenSymbol)) continue;
      if (match.protocol !== "Aave V3" && match.protocol !== "Silo V3" && match.protocol !== "Euler EVK") continue;
      const isReserve = match.side === "reserveAsset" || match.side === "collateralToken" || match.side === "collateralVault";
      rows.push({
        id: `${String(match.protocol || "consumer").toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${String(result.chain || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "-")}-usdt0-${rows.length}`,
        protocol: result.chain === "Ink" && match.protocol === "Aave V3" ? "Tydro Aave V3" : match.protocol,
        chain: result.chain || match.producer?.chain || "unknown",
        chainId: result.chainId ?? match.producer?.chainId ?? null,
        token: marketReserve || producerAddress || null,
        consumerType: `${String(match.protocol || "lending").toLowerCase().replace(/\s+/g, "-")}-${match.side}`,
        facts: {
          pool: match.market?.pool || null,
          reserve: match.market?.reserve || match.market?.token || match.market?.asset || null,
          symbol: match.market?.symbol || match.market?.tokenSymbol || match.producer?.symbol || null,
          producerCategory: match.producer?.category || null,
          ltv: match.market?.ltv ?? match.market?.borrowLtv ?? match.market?.maxLtv ?? null,
          liquidationThreshold: match.market?.liquidationThreshold ?? match.market?.lt ?? null,
          active: match.market?.active ?? null,
          borrowingEnabled: match.market?.borrowingEnabled ?? null,
          paused: match.market?.paused ?? null,
          cashUsd: match.market?.cashUsd ?? match.market?.liquidityUsd ?? null,
          otherRouteLiquidityUsd: match.market?.otherReserveCashUsd ?? match.market?.oppositeLiquidityUsd ?? match.market?.cashUsd ?? null,
          borrowCapWholeTokens: match.market?.borrowCapWholeTokens ?? null,
          supplyCapWholeTokens: match.market?.supplyCapWholeTokens ?? null,
          priceSource: match.market?.priceSource || match.market?.oracle || match.market?.solvencyOracle || null,
          graphReviewCandidate: Boolean(match.reviewCandidate),
          producerAnomaly: Boolean(match.producer?.currentAnomaly),
        },
        watchCandidate: Boolean(match.reviewCandidate && isReserve),
        routePositive: false,
        blockers: [
          "USDT0 OFT scan found no current peer/DVN/escrow anomaly",
          "no live USDT0 depeg or stale divergence mapped",
          "consumer graph review-only until producer-side anomaly appears",
          ...(match.blockers || []),
        ].filter(Boolean),
      });
    }
  }
  return rows;
}

function uniqConsumers(consumers) {
  const seen = new Set();
  const out = [];
  for (const c of consumers.filter(Boolean)) {
    const key = [c.id, c.protocol, c.chain, c.token, JSON.stringify(c.facts || {}).slice(0, 120)].join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function main() {
  ensureDir(OUT);
  const oft = readJson(FILES.oft);
  const addresses = collectUsdt0Addresses(oft);
  const consumers = uniqConsumers([
    mapHyperlend(readJson(FILES.hyperlend), readJson(FILES.monitorState), addresses),
    ...mapFolks(readJson(FILES.folks), addresses),
    ...mapDerive(readJson(FILES.derive), addresses),
    ...mapE12xDryRuns(readJson(FILES.e12xDryRuns)),
    ...mapCurrentProfitLeads(readJson(FILES.currentProfitLeads), addresses),
    parseTydro(readText(FILES.tydroReport)),
    parseVenus(readText(FILES.venusReport)),
    ...mapDolomite(readJson(FILES.dolomiteLive), readJson(FILES.dolomiteOracle), addresses),
    ...mapAaveEulerSiloGraph(readJson(FILES.aaveEulerSiloGraph), addresses),
  ]);
  const watchCandidates = consumers.filter((c) => c.watchCandidate);
  const routePositive = consumers.filter((c) => c.routePositive);
  const out = {
    generatedAt: new Date().toISOString(),
    scope: "USDT0 consumer join over local sanitized artifacts",
    safety: {
      rpcInventoryRead: false,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: routePositive.length > 0,
      signedActionJustified: false,
    },
    inputs: Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, path.relative(WORKSPACE, file).replace(/\\/g, "/")])),
    usdt0Addresses: [...addresses].sort(),
    summary: {
      consumersMapped: consumers.length,
      watchCandidates: watchCandidates.length,
      routePositive: routePositive.length,
      signedActionJustified: false,
      topWatch: watchCandidates.map((c) => c.id),
    },
    consumers,
    nextRoutePositiveCriteria: [
      "consumer values USDT0 near par while market price or bridge redemption is materially below par",
      "stale USDT/USDT0 oracle age exceeds the consumer's accepted window and divergence is material",
      "consumer has borrow or liquidation liquidity large enough to cover gas/slippage",
      "USDT0 OFT peer/DVN/escrow anomaly is live and maps to a lending/DEX exit",
      "fork simulation extracts positive value from the exact consumer route",
    ],
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`USDT0 consumer join: consumers=${out.summary.consumersMapped} watch=${out.summary.watchCandidates} routePositive=${out.summary.routePositive}`);
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
}

main();
