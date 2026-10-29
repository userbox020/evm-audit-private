#!/usr/bin/env node
// scan-layerzero-oft-dvn-consumer-joins.js - sanitized LayerZero/OFT DVN config -> consumer join.
// Consumes existing local artifacts only. It never reads RPC inventory, env files, keys, or sends transactions.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "layerzero-oft-dvn-consumer-joins.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "layerzero-oft-dvn-consumer-joins-triage.md");
const QUIET = process.argv.includes("--quiet");

const FILES = {
  layerzeroV2Live: path.join(WORKSPACE, "reports", "raw", "fast", "layerzero-v2-live.json"),
  usdt0OftRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "usdt0-oft-routes.json"),
  usdt0ConsumerRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "usdt0-consumer-routes.json"),
  aaveEulerSiloGraph: path.join(WORKSPACE, "reports", "raw", "fast", "aave-euler-silo-consumer-graph.json"),
  bridgeNonlosslessJoin: path.join(WORKSPACE, "reports", "raw", "fast", "bridge-nonlossless-collateral-join.json"),
  bridgeSyntheticConsumerExposure: path.join(WORKSPACE, "reports", "raw", "fast", "bridge-synthetic-consumer-exposure.json"),
};

const MIN_MATERIAL_USD = Number(process.env.LZ_OFT_CONSUMER_MIN_USD || "10000");

const CHAIN_ALIASES = {
  eth: "ethereum",
  mainnet: "ethereum",
  ethereum: "ethereum",
  arb: "arbitrum",
  arbitrumone: "arbitrum",
  arbitrum_one: "arbitrum",
  arbitrum: "arbitrum",
  op: "optimism",
  optimism: "optimism",
  bnb: "bsc",
  binance: "bsc",
  binancesmartchain: "bsc",
  bsc: "bsc",
  polygonpos: "polygon",
  polygon: "polygon",
  avax: "avalanche",
  avalanche: "avalanche",
  base: "base",
  ink: "ink",
  unichain: "unichain",
};

function readJson(file, fallback = {}) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function rel(file) {
  return path.relative(WORKSPACE, file).replace(/\\/g, "/");
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const n = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 2) {
  const n = asNumber(value);
  if (n === null) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function normAddress(value) {
  const text = String(value || "").trim();
  return /^0x[a-fA-F0-9]{40}$/.test(text) ? text.toLowerCase() : null;
}

function normKey(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, "");
}

function chainKey(value) {
  const key = normKey(value);
  return CHAIN_ALIASES[key] || key || null;
}

function short(value) {
  const text = String(value || "");
  if (text.length <= 16) return text || "n/a";
  return `${text.slice(0, 10)}...${text.slice(-6)}`;
}

function unique(items) {
  return [...new Set((items || []).filter(Boolean))];
}

function maxNumber(...values) {
  const nums = values.map(asNumber).filter((n) => n !== null);
  return nums.length ? Math.max(...nums) : null;
}

function amountUsdFromFacts(facts = {}) {
  return maxNumber(
    facts.cashUsd,
    facts.otherReserveCashUsd,
    facts.availableLiquidityUsd,
    facts.totalSupplyUsd,
    facts.totalDebtUsd,
    facts.borrowLiquidityUsd,
    facts.routeLiquidityUsd,
    facts.liquidityUsd,
    facts.availableLiquidity,
    facts.totalDebt
  );
}

function numericCount(value) {
  const n = asNumber(value);
  return n === null ? 0 : n;
}

function dvnList(decoded, key) {
  return Array.isArray(decoded?.[key]) ? decoded[key].map(normAddress).filter(Boolean) : [];
}

function ulnWeakReasons(decoded, direction, deadDvn) {
  if (!decoded) return [];
  const reasons = [];
  const requiredCount = asNumber(decoded.requiredDVNCount);
  const optionalCount = asNumber(decoded.optionalDVNCount);
  const optionalThreshold = asNumber(decoded.optionalDVNThreshold);
  const dead = normAddress(deadDvn);
  const requiredDvns = dvnList(decoded, "requiredDVNs");
  const optionalDvns = dvnList(decoded, "optionalDVNs");
  if (requiredCount !== null && requiredCount <= 1) reasons.push(`${direction} requiredDVNCount=${requiredCount}`);
  if (requiredCount === 0 && optionalCount !== null && optionalCount <= 1) reasons.push(`${direction} optional-only quorum <=1`);
  if (optionalCount > 0 && optionalThreshold !== null && optionalThreshold <= 0) reasons.push(`${direction} optionalDVNThreshold=0`);
  if (dead && (requiredDvns.includes(dead) || optionalDvns.includes(dead))) reasons.push(`${direction} includes configured deadDVN`);
  return reasons;
}

function flagRemoteEid(flag) {
  const match = String(flag || "").match(/_(\d+)$/);
  return match ? Number(match[1]) : null;
}

function collectLayerZeroDefaultConfigs(layerzero) {
  const rows = [];
  const scanErrors = [];
  for (const result of layerzero.results || []) {
    const flags = Array.isArray(result.flags) ? result.flags : [];
    if (result.error || flags.includes("RPC_OR_SCAN_ERROR")) {
      scanErrors.push({ chain: result.chain || null, chainId: result.chainId || null, eid: result.eid || null, error: result.error || "RPC_OR_SCAN_ERROR" });
    }
    const remoteEids = new Set([
      ...Object.keys(result.endpoint?.remotes || {}),
      ...Object.keys(result.sendUln302?.remotes || {}),
      ...Object.keys(result.receiveUln302?.remotes || {}),
      ...flags.map(flagRemoteEid).filter(Boolean).map(String),
    ]);
    for (const remoteEidText of remoteEids) {
      const remoteEid = Number(remoteEidText);
      if (!Number.isFinite(remoteEid)) continue;
      const send = result.sendUln302?.remotes?.[remoteEidText]?.ulnConfig || null;
      const receive = result.receiveUln302?.remotes?.[remoteEidText]?.ulnConfig || null;
      const routeFlags = flags.filter((flag) => flag.endsWith(`_${remoteEid}`));
      const reasons = unique([
        ...ulnWeakReasons(send, "send-default", result.contracts?.deadDVN),
        ...ulnWeakReasons(receive, "receive-default", result.contracts?.deadDVN),
        ...routeFlags.map((flag) => flag.replace(/_/g, " ").toLowerCase()),
      ]);
      rows.push({
        id: `lz-default:${result.chainId || result.chain}:${remoteEid}`,
        chain: result.chain || null,
        chainKey: chainKey(result.chain),
        chainId: result.chainId || null,
        eid: asNumber(result.eid),
        remoteEid,
        defaultSendLibrary: result.endpoint?.remotes?.[remoteEidText]?.defaultSendLibrary || null,
        defaultReceiveLibrary: result.endpoint?.remotes?.[remoteEidText]?.defaultReceiveLibrary || null,
        sendRequiredDVNCount: asNumber(send?.requiredDVNCount),
        receiveRequiredDVNCount: asNumber(receive?.requiredDVNCount),
        sendConfirmations: asNumber(send?.confirmations),
        receiveConfirmations: asNumber(receive?.confirmations),
        flags: routeFlags,
        weakConfig: reasons.length > 0,
        weakReasons: reasons,
        sourceArtifact: rel(FILES.layerzeroV2Live),
      });
    }
  }
  return { rows, scanErrors };
}

function collectOftRoutes(usdt0) {
  const oapps = [];
  const routeConfigs = [];
  for (const scan of usdt0.scans || []) {
    const docs = scan.docs || {};
    const tokenAddress = normAddress(scan.token?.address || scan.oapp?.token || scan.escrowToken?.address || docs.token);
    const symbol = scan.token?.symbol || scan.escrowToken?.symbol || docs.symbol || docs.name || null;
    const base = {
      id: `usdt0-oft:${docs.chainId || "unknown"}:${tokenAddress || normKey(symbol)}`,
      bridge: "LayerZero OFT",
      source: "usdt0-oft-routes",
      group: docs.group || null,
      chain: docs.name || null,
      chainKey: chainKey(docs.name),
      chainId: asNumber(docs.chainId),
      lzEid: asNumber(docs.lzEid),
      oappName: docs.oappName || null,
      oapp: normAddress(docs.oapp || scan.oapp?.address),
      token: tokenAddress,
      tokenLower: tokenAddress,
      symbol,
      isSource: Boolean(docs.isSource),
      codePresent: Boolean(scan.oapp?.codePresent || scan.token?.codePresent || scan.escrowToken?.codePresent),
      peerMissing: (scan.peerChecks || []).filter((row) => row.missing).length,
      peerMismatches: (scan.peerChecks || []).filter((row) => row.matchesExpected === false).length,
      blocker: "USDT0 OFT route artifact is config inventory unless peer/DVN/escrow anomaly maps to material consumers and exact economics.",
    };
    oapps.push(base);
    for (const cfg of scan.routeConfigs || []) {
      const sendDecoded = cfg.sendUln?.decoded || null;
      const receiveDecoded = cfg.receiveUln?.decoded || null;
      const weakReasons = unique([
        ...(Array.isArray(cfg.weakDvnHints) ? cfg.weakDvnHints : []),
        ...ulnWeakReasons(sendDecoded, "send-oapp", null),
        ...ulnWeakReasons(receiveDecoded, "receive-oapp", null),
      ]);
      routeConfigs.push({
        id: `${base.id}:${cfg.remoteLzEid || cfg.remote || "remote"}`,
        oappId: base.id,
        bridge: base.bridge,
        source: base.source,
        chain: base.chain,
        chainKey: base.chainKey,
        chainId: base.chainId,
        lzEid: base.lzEid,
        token: base.token,
        tokenLower: base.tokenLower,
        symbol: base.symbol,
        oapp: base.oapp,
        remote: cfg.remote || null,
        remoteChainId: asNumber(cfg.remoteChainId),
        remoteLzEid: asNumber(cfg.remoteLzEid),
        expectedPeer: cfg.expectedPeer || null,
        sendLibrary: normAddress(cfg.sendLibrary),
        receiveLibrary: normAddress(cfg.receiveLibrary),
        isDefaultSendLibrary: Boolean(cfg.isDefaultSendLibrary),
        receiveLibraryIsDefault: Boolean(cfg.receiveLibraryIsDefault),
        sendRequiredDVNCount: asNumber(sendDecoded?.requiredDVNCount),
        receiveRequiredDVNCount: asNumber(receiveDecoded?.requiredDVNCount),
        sendConfirmations: asNumber(sendDecoded?.confirmations),
        receiveConfirmations: asNumber(receiveDecoded?.confirmations),
        weakConfig: weakReasons.length > 0,
        weakReasons,
        sourceArtifact: rel(FILES.usdt0OftRoutes),
      });
    }
  }
  return { oapps, routeConfigs };
}

function collectOftProducers(graph) {
  return (graph.producers || [])
    .filter((producer) => /^oft-/i.test(String(producer.category || "")) || (producer.sources || []).includes("usdt0-oft-routes"))
    .map((producer) => ({
      id: producer.id,
      chain: producer.chain || null,
      chainKey: chainKey(producer.chain),
      chainId: asNumber(producer.chainId),
      address: normAddress(producer.address),
      addressLower: normAddress(producer.addressLower || producer.address),
      symbol: producer.symbol || null,
      name: producer.name || null,
      category: producer.category || null,
      tags: producer.tags || [],
      sources: producer.sources || [],
      currentAnomaly: Boolean(producer.currentAnomaly),
      blocker: producer.blocker || null,
    }));
}

function consumerFromUsdt0(row, index) {
  const facts = row.facts || {};
  const liquidityUsd = amountUsdFromFacts(facts);
  return {
    id: row.id || `usdt0-consumer:${index}`,
    source: "usdt0-consumer-routes",
    protocol: row.protocol || null,
    chain: row.chain || null,
    chainKey: chainKey(row.chain),
    chainId: asNumber(row.chainId),
    token: normAddress(row.token),
    tokenLower: normAddress(row.token),
    symbol: facts.symbol || facts.docsSymbol || null,
    consumerType: row.consumerType || null,
    side: row.consumerType || null,
    liquidityUsd,
    ltv: maxNumber(facts.ltv, asNumber(facts.collateralFactorBps) !== null ? asNumber(facts.collateralFactorBps) / 100 : null),
    active: facts.active ?? null,
    borrowingEnabled: facts.borrowingEnabled ?? null,
    paused: facts.paused ?? null,
    watchCandidate: Boolean(row.watchCandidate),
    routePositive: Boolean(row.routePositive),
    blockers: row.blockers || [],
    sourceArtifact: rel(FILES.usdt0ConsumerRoutes),
  };
}

function consumerFromAaveGraph(match, index) {
  const producer = match.producer || {};
  const market = match.market || {};
  const liquidityUsd = amountUsdFromFacts(market);
  return {
    id: `aave-euler-silo-oft:${index}:${match.protocol || "consumer"}:${producer.chainId || "chain"}:${producer.addressLower || producer.address || "token"}`,
    source: "aave-euler-silo-consumer-graph",
    protocol: match.protocol || market.protocol || null,
    chain: producer.chain || null,
    chainKey: chainKey(producer.chain),
    chainId: asNumber(producer.chainId),
    token: normAddress(producer.address),
    tokenLower: normAddress(producer.addressLower || producer.address),
    symbol: producer.symbol || market.symbol || null,
    consumerType: market.protocol || match.protocol || null,
    side: match.side || null,
    liquidityUsd,
    ltv: maxNumber(market.ltv !== undefined ? asNumber(market.ltv) * 100 : null, market.collateralFactor, market.collateralFactorPct),
    active: market.active ?? null,
    borrowingEnabled: market.borrowingEnabled ?? null,
    paused: market.paused ?? null,
    watchCandidate: Boolean(match.watchCandidate),
    routePositive: Boolean(match.routePositive),
    blockers: match.blockers || [],
    producerCategory: producer.category || null,
    producerId: producer.id || null,
    sourceArtifact: rel(FILES.aaveEulerSiloGraph),
  };
}

function collectConsumers(usdt0Consumers, graph) {
  const consumers = [];
  (usdt0Consumers.consumers || []).forEach((row, index) => consumers.push(consumerFromUsdt0(row, index)));
  let matchIndex = 0;
  for (const result of graph.results || []) {
    for (const match of result.topMatches || []) {
      const category = match.producer?.category || "";
      if (!/^oft-/i.test(category) && !(match.producer?.sources || []).includes("usdt0-oft-routes")) continue;
      consumers.push(consumerFromAaveGraph(match, matchIndex++));
    }
  }
  const seen = new Set();
  return consumers.filter((row) => {
    const key = `${row.protocol}:${row.chainId || row.chainKey}:${row.tokenLower || normKey(row.symbol)}:${row.side || row.consumerType}:${round(row.liquidityUsd, 2)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function tokenKeys(row) {
  const keys = [];
  if (row.tokenLower) keys.push(`addr:${row.chainId || row.chainKey}:${row.tokenLower}`);
  if (row.symbol) keys.push(`sym:${row.chainId || row.chainKey}:${normKey(row.symbol)}`);
  return keys;
}

function indexByToken(rows) {
  const map = new Map();
  for (const row of rows) {
    for (const key of tokenKeys(row)) {
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(row);
    }
  }
  return map;
}

function collectDefaultRowsForOapp(oapp, defaultRows) {
  return defaultRows.filter((row) => {
    if (oapp.chainId && row.chainId && oapp.chainId === row.chainId) return true;
    return oapp.chainKey && row.chainKey && oapp.chainKey === row.chainKey;
  });
}

function joinConsumersToConfigs({ consumers, oapps, routeConfigs, defaultRows }) {
  const oappsByToken = indexByToken(oapps);
  const routeConfigsByOapp = new Map();
  for (const cfg of routeConfigs) {
    if (!routeConfigsByOapp.has(cfg.oappId)) routeConfigsByOapp.set(cfg.oappId, []);
    routeConfigsByOapp.get(cfg.oappId).push(cfg);
  }

  const joined = [];
  for (const consumer of consumers) {
    const matchMap = new Map();
    for (const candidate of tokenKeys(consumer).flatMap((key) => oappsByToken.get(key) || [])) {
      matchMap.set(candidate.id, candidate);
    }
    const matches = [...matchMap.values()];
    for (const oapp of matches) {
      const configs = routeConfigsByOapp.get(oapp.id) || [];
      const weakOappConfigs = configs.filter((cfg) => cfg.weakConfig);
      const defaultRelevant = collectDefaultRowsForOapp(oapp, defaultRows);
      const defaultWeakRows = defaultRelevant.filter((row) => row.weakConfig);
      const usesDefaultLibrary = configs.some((cfg) => cfg.isDefaultSendLibrary || cfg.receiveLibraryIsDefault);
      const joinedWeakConfig = weakOappConfigs.length > 0 || (usesDefaultLibrary && defaultWeakRows.length > 0);
      const material = (asNumber(consumer.liquidityUsd) || 0) >= MIN_MATERIAL_USD;
      joined.push({
        id: `lz-oft-join:${consumer.id}:${oapp.id}`,
        protocol: consumer.protocol,
        consumerType: consumer.consumerType,
        side: consumer.side || null,
        chain: consumer.chain || oapp.chain,
        chainId: consumer.chainId || oapp.chainId,
        token: consumer.token || oapp.token,
        symbol: consumer.symbol || oapp.symbol,
        oapp: oapp.oapp,
        oappName: oapp.oappName,
        oappGroup: oapp.group,
        lzEid: oapp.lzEid,
        liquidityUsd: round(consumer.liquidityUsd, 2),
        ltv: round(consumer.ltv, 4),
        materialConsumer: material,
        configRouteRows: configs.length,
        weakOappConfigRows: weakOappConfigs.length,
        weakDefaultConfigRows: usesDefaultLibrary ? defaultWeakRows.length : 0,
        usesDefaultLibrary,
        joinedWeakConfig,
        exactEconomicsRows: 0,
        forkProofRows: 0,
        routePositive: false,
        watchCandidate: joinedWeakConfig && material,
        blockers: unique([
          ...consumer.blockers,
          joinedWeakConfig ? null : "No OApp-specific weak DVN config is joined to this consumer",
          usesDefaultLibrary && defaultWeakRows.length ? "LayerZero endpoint default weak config requires proof that this OApp route uses the affected default" : null,
          "No exact bridge mint/unlock, borrow/redeem, exit economics, or fork proof",
        ]),
        sourceArtifacts: unique([oapp.sourceArtifact, consumer.sourceArtifact, rel(FILES.layerzeroV2Live)]),
      });
    }
  }
  return joined.sort((a, b) => Number(b.joinedWeakConfig) - Number(a.joinedWeakConfig) || (b.liquidityUsd || 0) - (a.liquidityUsd || 0));
}

function topRows(rows, limit = 12) {
  return rows.slice(0, limit).map((row) => ({
    protocol: row.protocol,
    chain: row.chain,
    token: row.token,
    symbol: row.symbol,
    consumerType: row.consumerType,
    side: row.side,
    liquidityUsd: row.liquidityUsd,
    configRouteRows: row.configRouteRows,
    weakOappConfigRows: row.weakOappConfigRows,
    weakDefaultConfigRows: row.weakDefaultConfigRows,
    joinedWeakConfig: row.joinedWeakConfig,
    routePositive: row.routePositive,
    blocker: row.blockers?.[0] || null,
  }));
}

function topDefaultRows(rows, limit = 12) {
  return rows
    .filter((row) => row.weakConfig)
    .slice(0, limit)
    .map((row) => ({
      chain: row.chain,
      chainId: row.chainId,
      eid: row.eid,
      remoteEid: row.remoteEid,
      sendRequiredDVNCount: row.sendRequiredDVNCount,
      receiveRequiredDVNCount: row.receiveRequiredDVNCount,
      flags: row.flags,
      weakReasons: row.weakReasons,
      routePositive: false,
      blocker: "Endpoint default weakness is inventory only until a concrete OApp route and consumer economics are proven.",
    }));
}

function mdTable(rows, columns, empty) {
  if (!rows.length) return empty;
  const header = `| ${columns.map((c) => c.title).join(" | ")} |`;
  const sep = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${columns.map((c) => String(c.value(row) ?? "n/a").replace(/\|/g, "/")).join(" | ")} |`);
  return [header, sep, ...body].join("\n");
}

function writeReport(out) {
  const s = out.summary;
  const date = new Date(out.generatedAt).toISOString().slice(0, 10);
  const joinedRows = out.topRows || [];
  const defaults = out.topDefaultWeakRows || [];
  const joinedTable = mdTable(joinedRows, [
    { title: "Protocol", value: (r) => r.protocol },
    { title: "Chain", value: (r) => r.chain },
    { title: "Token", value: (r) => `${r.symbol || "?"} ${short(r.token)}` },
    { title: "Side", value: (r) => r.side || r.consumerType },
    { title: "Liq USD", value: (r) => r.liquidityUsd === null ? "n/a" : r.liquidityUsd },
    { title: "OAppCfg", value: (r) => r.configRouteRows },
    { title: "WeakCfg", value: (r) => r.weakOappConfigRows + r.weakDefaultConfigRows },
    { title: "Blocker", value: (r) => r.blocker },
  ], "No OFT consumer joins were mapped from the current artifacts.");
  const defaultTable = mdTable(defaults, [
    { title: "Chain", value: (r) => r.chain },
    { title: "EID", value: (r) => r.eid },
    { title: "Remote", value: (r) => r.remoteEid },
    { title: "SendDVN", value: (r) => r.sendRequiredDVNCount },
    { title: "RecvDVN", value: (r) => r.receiveRequiredDVNCount },
    { title: "Flags", value: (r) => (r.flags || []).slice(0, 2).join(", ") || "none" },
    { title: "Blocker", value: (r) => r.blocker },
  ], "No weak endpoint-default DVN rows were present in the LayerZero artifact.");

  const lines = [
    "# 🟢 DORMANT - LayerZero/OFT DVN Consumer Joins",
    "",
    `Date: ${date}`,
    "",
    "## Result",
    "",
    `Joined LayerZero/OFT DVN config inventory to known OFT consumers using sanitized local artifacts only. The branch remains fail-closed: \`weakConfigConsumerRows=${s.weakConfigConsumerRows}\`, \`exactEconomicsRows=0\`, \`forkProofRows=0\`, \`routePositive=0\`, \`executableNow=0\`, \`signedActionJustified=false\`. Endpoint-default weak DVN rows are inventory only unless a concrete OApp uses the affected default and maps to material consumer economics.`,
    "",
    "## Coverage",
    "",
    "| LZ Chains | Default Configs | Weak Defaults | OApps | OApp Configs | Weak OApp Configs | Consumers | Joined | Material Joined | Weak Consumer Joins |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    `| ${s.layerZeroChains} | ${s.defaultConfigRows} | ${s.weakDefaultConfigRows} | ${s.oappRows} | ${s.oappRouteConfigRows} | ${s.weakOappConfigRows} | ${s.consumerRows} | ${s.joinedRows} | ${s.materialJoinedRows} | ${s.weakConfigConsumerRows} |`,
    "",
    "## Top Consumer Joins",
    "",
    joinedTable,
    "",
    "## Endpoint Default Weak Rows",
    "",
    defaultTable,
    "",
    "## Route-Positive Gate",
    "",
    "Do not quote, fork, or build executors from this branch unless a concrete OFT/OApp route has a live weak DVN/peer/escrow condition, the affected token is accepted by a material same-chain consumer, exact acquisition/bridge/borrow/redeem/exit economics are positive after gas/slippage/fees, and fork/local proof demonstrates net extraction.",
    "",
    "## Artifacts",
    "",
    "- JSON: `reports/raw/fast/layerzero-oft-dvn-consumer-joins.json`",
    "- Scanner: `tools/scan-layerzero-oft-dvn-consumer-joins.js`",
    "- Inputs: `reports/raw/fast/layerzero-v2-live.json`, `reports/raw/fast/usdt0-oft-routes.json`, `reports/raw/fast/usdt0-consumer-routes.json`, `reports/raw/fast/aave-euler-silo-consumer-graph.json`",
    "",
  ];
  ensureDir(REPORT_OUT);
  fs.writeFileSync(REPORT_OUT, `${lines.join("\n")}\n`);
}

function main() {
  const artifacts = Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, readJson(file, {})]));
  const defaults = collectLayerZeroDefaultConfigs(artifacts.layerzeroV2Live || {});
  const oft = collectOftRoutes(artifacts.usdt0OftRoutes || {});
  const producers = collectOftProducers(artifacts.aaveEulerSiloGraph || {});
  const consumers = collectConsumers(artifacts.usdt0ConsumerRoutes || {}, artifacts.aaveEulerSiloGraph || {});
  const joined = joinConsumersToConfigs({ consumers, oapps: oft.oapps, routeConfigs: oft.routeConfigs, defaultRows: defaults.rows });
  const materialJoined = joined.filter((row) => row.materialConsumer);
  const weakConsumerJoins = joined.filter((row) => row.joinedWeakConfig && row.materialConsumer);
  const exactEconomicsRows = 0;
  const forkProofRows = 0;
  const routePositive = 0;
  const topLiquidityUsd = materialJoined.length ? Math.max(...materialJoined.map((row) => asNumber(row.liquidityUsd) || 0)) : null;
  const weakDefaultConfigRows = defaults.rows.filter((row) => row.weakConfig).length;
  const weakOappConfigRows = oft.routeConfigs.filter((row) => row.weakConfig).length;

  const out = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-layerzero-oft-dvn-consumer-joins.js",
    scope: "Read-only LayerZero/OFT DVN config to consumer join over local sanitized artifacts",
    safety: {
      rpcInventoryRead: false,
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
    thresholds: {
      minMaterialUsd: MIN_MATERIAL_USD,
      routePositiveRequires: [
        "concrete OFT/OApp peer, DVN, or escrow weakness on a deployed route",
        "affected token accepted by a material same-chain consumer",
        "exact acquisition, bridge, borrow/redeem/liquidation, and exit economics positive after costs",
        "fork/local proof of net value extraction",
      ],
    },
    inputs: Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, rel(file)])),
    summary: {
      layerZeroChains: (artifacts.layerzeroV2Live?.results || []).length,
      layerZeroScanErrors: defaults.scanErrors.length,
      defaultConfigRows: defaults.rows.length,
      weakDefaultConfigRows,
      defaultConfigOnlyRows: weakDefaultConfigRows,
      oappRows: oft.oapps.length,
      oappRouteConfigRows: oft.routeConfigs.length,
      weakOappConfigRows,
      oftProducerRows: producers.length,
      consumerRows: consumers.length,
      joinedRows: joined.length,
      materialJoinedRows: materialJoined.length,
      joinedWeakConfigRows: joined.filter((row) => row.joinedWeakConfig).length,
      weakConfigConsumerRows: weakConsumerJoins.length,
      exactEconomicsRows,
      forkProofRows,
      routePositive,
      executableNow: 0,
      signedActionJustified: false,
      topLiquidityUsd: round(topLiquidityUsd, 2),
      blocker: "No material OFT consumer is joined to an OApp-specific weak DVN/peer/escrow condition with exact positive economics and fork proof.",
    },
    layerZeroScanErrors: defaults.scanErrors,
    topDefaultWeakRows: topDefaultRows(defaults.rows),
    topOappWeakConfigRows: oft.routeConfigs.filter((row) => row.weakConfig).slice(0, 12),
    oftProducers: producers,
    topRows: topRows(joined),
    joinedRows: joined,
    routePositiveRows: [],
    blockers: [
      "LayerZero endpoint default weak rows are inventory only without a concrete OApp using the affected default.",
      "USDT0 OApp route configs currently do not show weak DVN hints in the source artifact.",
      "Consumer joins have no exact positive acquisition/bridge/borrow/redeem/exit economics or fork/local proof.",
    ],
    requiredForRoutePositive: [
      "concrete OFT/OApp peer, DVN, or escrow weakness on a deployed route",
      "affected token accepted by a material same-chain consumer",
      "exact route economics positive after gas/slippage/fees",
      "fork/local proof demonstrates net value extraction",
    ],
    nextReadOnlyStep: "Treat endpoint-default DVN flags as inventory; only add exact economics if a concrete OApp-specific weak route maps to a material consumer.",
  };

  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(out, null, 2)}\n`);
  writeReport(out);

  if (!QUIET) {
    console.log(`Wrote ${rel(RAW_OUT)}`);
    console.log(`Wrote ${rel(REPORT_OUT)}`);
    console.log(`LayerZero/OFT joins=${out.summary.joinedRows}; weakConfigConsumerRows=${out.summary.weakConfigConsumerRows}; routePositive=0`);
  }
}

main();
