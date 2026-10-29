#!/usr/bin/env node
// Artifact-only intent/solver settlement abuse consolidator.
// Consumes existing local JSON artifacts only. No RPC, endpoint inventory, env/key reads,
// calldata execution, forks, signed actions, broadcasts, or wallet operations.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW = path.join(WORKSPACE, "reports", "raw", "fast");
const OUT_JSON = path.join(RAW, "intent-solver-settlement-abuse.json");
const OUT_MD = path.join(WORKSPACE, "reports", "intent-solver-settlement-abuse-triage.md");
const SCANNER = "tools/scan-intent-solver-settlement-abuse.js";
const QUIET = process.argv.includes("--quiet");

const INPUTS = {
  routerRfqSettlementDrift: { required: true, file: path.join(RAW, "router-rfq-settlement-drift.json") },
  mevSandwichOrderEconomics: { required: true, file: path.join(RAW, "mev-sandwich-order-economics.json") },
  uniswapxFillerProfit: { required: true, file: path.join(RAW, "uniswapx-filler-profit.json") },
  uniswapxFillerMev: { required: true, file: path.join(RAW, "uniswapx-filler-mev.json") },
  fusionResolverAnalysis: { required: true, file: path.join(RAW, "fusion-resolver-analysis.json") },
  crossChainSettlementQuotes: { required: true, file: path.join(RAW, "cross-chain-settlement-quotes.json") },
  signedPayloadReplay: { required: false, file: path.join(RAW, "signed-payload-replay.json") },
  predictionMarketLiveRoutes: { required: false, file: path.join(RAW, "prediction-market-live-routes.json") },
  routerApprovalDrain: { required: false, file: path.join(RAW, "router-approval-drain.json") },
};

function argNumber(name, fallback) {
  const eq = process.argv.find((arg) => arg.startsWith(`${name}=`));
  const raw = eq ? eq.slice(name.length + 1) : null;
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

const CONFIG = {
  maxRows: Math.max(1, Math.floor(argNumber("--maxRows", 250))),
  topRows: Math.max(1, Math.floor(argNumber("--topRows", 20))),
  minTransferProfitWatchUsd: argNumber("--minTransferProfitWatchUsd", 0),
};

function rel(file) {
  return path.relative(WORKSPACE, file).replace(/\\/g, "/");
}

function sanitizeString(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/\b(?:https?|wss?):\/\/[^\s<>"'`|)]+/gi, "[redacted-url]")
    .replace(/((?:api[_-]?key|authorization|bearer|secret|token|endpoint|rpc)\s*[:=]\s*)[^\s,;)}\]]+/gi, "$1[redacted]")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 1000);
}

function sanitizeValue(value, key = "") {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (/^(?:calldata|rawCalldata|signedTx|privateKey|mnemonic|seed|secret)$/i.test(key)) return "[redacted]";
    return sanitizeString(value);
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, key));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = sanitizeValue(v, k);
  return out;
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value).replace(/[$,%\s,]/g, "");
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function numberOrZero(value) {
  return asNumber(value) || 0;
}

function round(value, decimals = 6) {
  const n = asNumber(value);
  if (n === null) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function maxMetric(...values) {
  let best = 0;
  for (const value of values) {
    const n = asNumber(value);
    if (n !== null && n > best) best = n;
  }
  return best;
}

function readArtifact(key, def) {
  const meta = {
    key,
    path: rel(def.file),
    required: Boolean(def.required),
    exists: false,
    loaded: false,
  };

  try {
    if (!fs.existsSync(def.file)) return { data: null, meta: { ...meta, missing: true } };
    const stat = fs.statSync(def.file);
    const data = JSON.parse(fs.readFileSync(def.file, "utf8"));
    const summary = data && data.summary ? data.summary : {};
    return {
      data,
      meta: sanitizeValue({
        ...meta,
        exists: true,
        loaded: true,
        bytes: stat.size,
        generatedAt: data.generatedAt || data.scannedAt || null,
        scanner: data.scanner || null,
        scope: data.scope || null,
        routePositive: maxMetric(summary.routePositive, data.safety && data.safety.routePositive),
        executableNow: maxMetric(summary.executableNow, data.safety && data.safety.executableNow),
        exactEconomicsRows: maxMetric(summary.exactEconomicsRows, summary.branchExactEconomicsRows),
        forkProofRows: maxMetric(summary.forkProofRows),
        watchCandidates: maxMetric(summary.watchCandidates),
        keyCounts: selectedCounts(summary),
      }),
    };
  } catch (err) {
    return {
      data: null,
      meta: sanitizeValue({
        ...meta,
        exists: true,
        loaded: false,
        parseError: String(err && err.message ? err.message : err),
      }),
    };
  }
}

function selectedCounts(summary) {
  const fields = [
    "sourceRows",
    "fieldBindingProofRows",
    "deployedRows",
    "deployedRouterInventoryRows",
    "deployedWatchRows",
    "deprecatedReachabilityRows",
    "fillEvents",
    "uniqueFillers",
    "transferProfitRows",
    "transferOnlyPositiveRows",
    "decodedOrderRows",
    "sandwichSimulationRows",
    "exactQuoteRows",
    "branchQuoteRows",
    "verifiedFieldDiffRows",
    "liveApprovalOrEscrowRows",
    "balanceDeltaMismatchRows",
    "exactEconomicsRows",
    "forkProofRows",
    "routePositive",
    "executableNow",
  ];
  const out = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(summary || {}, field)) out[field] = summary[field];
  }
  if (Object.prototype.hasOwnProperty.call(summary || {}, "socketCrossChainRoutes")) out.socketCrossChainRoutes = summary.socketCrossChainRoutes;
  return out;
}

function rowBase(category, sourceKey, extra = {}) {
  return sanitizeValue({
    category,
    sourceKey,
    sourcePath: INPUTS[sourceKey] ? rel(INPUTS[sourceKey].file) : null,
    routePositive: false,
    executableNow: false,
    signedActionJustified: false,
    exactEconomics: false,
    forkProof: false,
    ...extra,
  });
}

function collectRouterFieldBindingRows(router) {
  const rows = [];
  for (const target of router && Array.isArray(router.sourceTargets) ? router.sourceTargets : []) {
    for (const row of Array.isArray(target.topRows) ? target.topRows : []) {
      const proof = Array.isArray(row.fieldBindingProof) ? row.fieldBindingProof : [];
      const status = row.fieldBindingStatus || row.confidence || null;
      const isProof = proof.length > 0 || /^closed/i.test(String(row.confidence || "")) || (status && status !== "not-proven-relevant");
      if (!isProof) continue;
      rows.push(rowBase("router-rfq-field-binding-context", "routerRfqSettlementDrift", {
        signal: "closed-field-binding-context",
        target: row.target || target.name || null,
        protocol: row.target || target.name || null,
        chain: row.chain || target.chain || null,
        file: row.file || null,
        line: row.line || null,
        function: row.function || null,
        access: row.access || null,
        status,
        confidence: row.confidence || null,
        priorityScore: asNumber(row.priorityScore),
        proof,
        missingBindings: Array.isArray(row.missingBindings) ? row.missingBindings : [],
        blocker: row.blocker || "Closed field-binding proof; no verified signed-field/settlement-field drift remains open.",
      }));
    }
  }
  return rows;
}

function collectDeployedRouterRows(router) {
  const rows = [];
  const deployedRows = Array.isArray(router && router.deployedRows) ? router.deployedRows : [];
  for (const row of deployedRows.slice().sort((a, b) => numberOrZero(b.priorityScore) - numberOrZero(a.priorityScore))) {
    rows.push(rowBase("deployed-router-inventory-watch", "routerRfqSettlementDrift", {
      signal: "deployed-bytecode-watch",
      target: row.name || null,
      protocol: row.protocol || row.name || null,
      chain: row.chain || null,
      chainId: row.chainId || null,
      address: row.address || null,
      deployed: Boolean(row.deployed),
      deprecated: Boolean(row.deprecated),
      codeBytes: asNumber(row.codeBytes),
      selectorKinds: Array.isArray(row.selectorKinds) ? row.selectorKinds : [],
      selectorHits: Array.isArray(row.selectorHits) ? row.selectorHits : [],
      delegatecallCount: asNumber(row.delegatecallCount),
      callCount: asNumber(row.callCount),
      priorityScore: asNumber(row.priorityScore),
      oldApprovalDrainRisk: row.oldApprovalDrainRisk || null,
      blocker: row.blocker || "Deployed selector inventory is watch-only without verified source field drift, live approvals/escrow, exact economics, and fork/local proof.",
    }));
  }
  return rows;
}

function collectApprovalDrainRows(approval) {
  const results = Array.isArray(approval && approval.results) ? approval.results : [];
  return results
    .filter((row) => (Array.isArray(row.methods) && row.methods.length > 0) || /MED|HIGH|danger/i.test(String(row.risk || "")))
    .slice(0, CONFIG.topRows)
    .map((row) => rowBase("deployed-router-inventory-watch", "routerApprovalDrain", {
      signal: "optional-approval-drain-context",
      target: row.label || null,
      protocol: row.label || null,
      chain: row.chain || null,
      address: row.addr || null,
      deployed: Boolean(row.deployed),
      methods: Array.isArray(row.methods) ? row.methods : [],
      bytecodeSize: asNumber(row.bytecodeSize),
      isProxy: Boolean(row.isProxy),
      risk: row.risk || null,
      priorityScore: /HIGH/i.test(String(row.risk || "")) ? 65 : /MED/i.test(String(row.risk || "")) ? 45 : 25,
      blocker: "Approval-drain selector context is not an intent settlement exploit without victim approval reachability, decoded order/settlement mismatch, exact economics, and fork/local proof.",
    }));
}

function collectTransferProfitRows(mev, profit) {
  const mevRows = Array.isArray(mev && mev.transferRows) ? mev.transferRows : [];
  const fallbackRows = Array.isArray(profit && profit.results) ? profit.results : [];
  const sourceRows = mevRows.length ? mevRows : fallbackRows;
  return sourceRows
    .filter((row) => {
      const net = asNumber(row.netProfit ?? row.netUsd);
      const positiveFlag = row.transferOnlyPositive === true || (row.transferOnlyPositive === undefined && net !== null && net > 0);
      return positiveFlag && net !== null && net >= CONFIG.minTransferProfitWatchUsd;
    })
    .sort((a, b) => numberOrZero(b.netProfit ?? b.netUsd) - numberOrZero(a.netProfit ?? a.netUsd))
    .map((row) => rowBase("uniswapx-transfer-profit-watch-downgraded", mevRows.length ? "mevSandwichOrderEconomics" : "uniswapxFillerProfit", {
      signal: "watch-downgraded-transfer-only-profit",
      protocol: "UniswapX / filler transfer telemetry",
      chain: "Ethereum",
      txHash: row.txHash || row.pair || null,
      filler: row.filler || row.symbol || null,
      transfers: asNumber(row.transfers),
      gas: asNumber(row.gas),
      gasCost: round(row.gasCost, 6),
      valueToFiller: round(row.valueToFiller, 6),
      valueFromFiller: round(row.valueFromFiller, 6),
      grossProfitUsd: round(row.grossProfit ?? row.netUsd, 6),
      netProfitUsd: round(row.netProfit ?? row.netUsd, 6),
      marginPct: row.marginPct || null,
      transferOnlyPositive: true,
      decodedOrderFields: false,
      exactBalanceDeltaEconomics: false,
      downgradeReason: "Transfer-only positive balance delta lacks decoded order inputs/outputs, user limit price, auction curve, exact token pricing, sandwich/counterfactual simulation, and fork/local proof.",
      blocker: row.blocker || "Transfer-only profit is noisy telemetry and is downgraded to watch/context.",
      priorityScore: Math.max(1, Math.min(100, 30 + Math.log10(Math.max(1, numberOrZero(row.netProfit ?? row.netUsd))) * 10)),
    }));
}

function reactorRowsFrom(mev, fillerMev) {
  if (Array.isArray(mev && mev.reactorRows) && mev.reactorRows.length) return mev.reactorRows;
  const byReactor = fillerMev && fillerMev.byReactor ? fillerMev.byReactor : {};
  return Object.entries(byReactor).map(([reactor, data]) => ({ reactor, ...data }));
}

function collectFillerConcentrationRows(mev, fillerMev) {
  return reactorRowsFrom(mev, fillerMev).map((row) => {
    const fillEvents = numberOrZero(row.fillEvents ?? row.totalEvents);
    const top = Array.isArray(row.topFillers) && row.topFillers.length ? row.topFillers[0] : null;
    const topCount = numberOrZero(top && top.count);
    const share = fillEvents > 0 ? round((topCount / fillEvents) * 100, 2) : null;
    return rowBase("filler-concentration-context", Array.isArray(mev && mev.reactorRows) ? "mevSandwichOrderEconomics" : "uniswapxFillerMev", {
      signal: "filler-concentration-context",
      protocol: "UniswapX",
      chain: "Ethereum",
      reactor: row.reactor || null,
      address: row.address || null,
      totalEvents: asNumber(row.totalEvents),
      fillEvents,
      uniqueFillers: asNumber(row.uniqueFillers),
      topFiller: top && top.addr ? top.addr : null,
      topFillerCount: topCount,
      topFillerSharePct: share,
      topFillers: Array.isArray(row.topFillers) ? row.topFillers.slice(0, 5) : [],
      priorityScore: share === null ? 20 : Math.min(80, 20 + share),
      blocker: row.blocker || "Filler concentration is market-structure context only; it does not prove decoded order abuse, exact economics, or permissionless extraction.",
    });
  });
}

function collectArchitectureRows(fusion) {
  const results = fusion && fusion.results ? fusion.results : {};
  const architecture = results.architecture || {};
  return Object.entries(architecture).map(([key, row]) => rowBase("solver-architecture-context", "fusionResolverAnalysis", {
    signal: "solver-architecture-context",
    protocol: key,
    model: row.model || null,
    fillerAccess: row.fillerAccess || null,
    mevRisk: row.mevRisk || null,
    fillersFound: row.fillersFound || null,
    note: (results[key] && results[key].note) || null,
    priorityScore: /HIGH/i.test(String(row.mevRisk || "")) ? 45 : /MED/i.test(String(row.mevRisk || "")) ? 35 : 20,
    blocker: "Architecture notes describe solver/filler trust and access assumptions only; no settlement field drift, exact economics, or fork/local proof is present.",
  }));
}

function collectCrossChainQuoteRows(cross) {
  const topCrossChain = Array.isArray(cross && cross.topCrossChainRows) && cross.topCrossChainRows.length
    ? cross.topCrossChainRows
    : Array.isArray(cross && cross.crossChainRows)
      ? cross.crossChainRows.slice().sort((a, b) => numberOrZero(b.netUsd) - numberOrZero(a.netUsd))
      : [];
  const branchRows = Array.isArray(cross && cross.branchRows) ? cross.branchRows : [];
  const rows = [];
  for (const row of topCrossChain.slice(0, CONFIG.topRows)) {
    rows.push(rowBase("cross-chain-settlement-quote-context", "crossChainSettlementQuotes", {
      signal: "quote-context-downgraded",
      protocol: "Cross-chain settlement quotes",
      route: `${row.originChainId ?? "?"}->${row.destinationChainId ?? "?"}`,
      pair: row.label || row.requestId || null,
      branch: row.branch || null,
      inputSymbol: row.inputSymbol || null,
      outputSymbol: row.outputSymbol || null,
      inputUsd: round(row.inputUsd, 6),
      outputUsd: round(row.outputUsd, 6),
      minOutUsd: round(row.minOutUsd, 6),
      gasUsd: round(row.gasUsd, 6),
      netUsd: round(row.netUsd, 6),
      bridgeProvider: row.bridgeProvider || null,
      dexProvider: row.dexProvider || null,
      estimatedTimeSec: asNumber(row.estimatedTimeSec),
      statusCheckAvailable: Boolean(row.statusCheckAvailable),
      quoteMetadataOnly: true,
      downgradeReason: "Quote metadata is downgraded until joined to a proven settlement branch with decoded fields, exact positive economics, and fork/local proof.",
      blocker: row.blocker || "Quote metadata alone is not a route-positive exploit branch.",
      priorityScore: 25 + Math.max(-25, Math.min(25, numberOrZero(row.netUsd))),
    }));
  }
  for (const row of branchRows.slice(0, CONFIG.topRows)) {
    rows.push(rowBase("cross-chain-settlement-quote-context", "crossChainSettlementQuotes", {
      signal: "branch-quote-context-downgraded",
      protocol: "Cross-chain branch quotes",
      route: `${row.originChainId ?? "?"}->${row.destinationChainId ?? "?"}`,
      pair: row.label || row.id || null,
      branch: row.branch || null,
      inputSymbol: row.inputSymbol || null,
      outputSymbol: row.outputSymbol || null,
      routesReturned: asNumber(row.routesReturned),
      outputUsd: round(row.outputUsd, 6),
      minOutUsd: round(row.minOutUsd, 6),
      gasUsd: round(row.gasUsd, 6),
      netUsd: round(row.netUsd, 6),
      bridgeProvider: row.bridgeProvider || null,
      dexProvider: row.dexProvider || null,
      triggerReady: Boolean(row.triggerReady),
      quoteMetadataOnly: true,
      downgradeReason: "Branch quote remains downgraded without proven settlement abuse, exact positive economics, and fork/local proof.",
      blocker: row.blocker || "Branch quote remains route-negative or trigger/fork blocked.",
      priorityScore: 20 + Math.max(-20, Math.min(20, numberOrZero(row.netUsd))),
    }));
  }
  return rows;
}

function collectSignedPayloadRows(signed, prediction) {
  const rows = [];
  if (signed) {
    for (const row of (Array.isArray(signed.reportRows) ? signed.reportRows : []).slice(0, CONFIG.topRows)) {
      rows.push(rowBase("signed-payload-replay-context", "signedPayloadReplay", {
        signal: "signed-payload-replay-context",
        target: row.target || null,
        chain: row.chain || null,
        file: row.file || null,
        line: row.line || null,
        function: row.function || null,
        access: row.access || null,
        confidence: row.confidence || null,
        priorityScore: asNumber(row.priorityScore),
        missingScopes: Array.isArray(row.missingScopes) ? row.missingScopes : [],
        replayVectorCount: asNumber(row.replayVectorCount),
        blocker: row.blocker || "Signed-payload row is context only without live mainnet route, exact economics, and fork/local proof.",
      }));
    }
    let added = rows.length;
    for (const target of Array.isArray(signed.sourceRows) ? signed.sourceRows : []) {
      if (added >= CONFIG.topRows) break;
      for (const row of Array.isArray(target.topRows) ? target.topRows : []) {
        if (added >= CONFIG.topRows) break;
        rows.push(rowBase("signed-payload-replay-context", "signedPayloadReplay", {
          signal: "signed-payload-replay-context",
          target: row.target || target.name || null,
          chain: row.chain || target.chain || null,
          file: row.file || null,
          line: row.line || null,
          function: row.function || null,
          access: row.access || null,
          confidence: row.confidence || null,
          priorityScore: asNumber(row.priorityScore),
          hasDomainScope: Boolean(row.hasDomainScope),
          hasNonceLike: Boolean(row.hasNonceLike),
          hasConsumptionState: Boolean(row.hasConsumptionState),
          hasActionScope: Boolean(row.hasActionScope),
          missingScopes: Array.isArray(row.missingScopes) ? row.missingScopes : [],
          blocker: row.blocker || "Domain/nonce/action/consumption scoping prevents replay-positive classification.",
        }));
        added += 1;
      }
    }
  }

  if (prediction) {
    const summary = prediction.summary || {};
    rows.push(rowBase("signed-payload-replay-context", "predictionMarketLiveRoutes", {
      signal: "prediction-market-live-route-context",
      target: "Prediction-market order/collateral live routes",
      chain: prediction.chain && prediction.chain.name ? prediction.chain.name : null,
      liveTargets: asNumber(summary.liveTargets),
      materialBalanceRows: asNumber(summary.materialBalanceRows),
      vaultCollateralUsd: round(summary.vaultCollateralUsd, 2),
      signedReplayScopedRows: asNumber(summary.signedReplayScopedRows),
      signedReplayHighStaticRows: asNumber(summary.signedReplayHighStaticRows),
      signedReplayMediumStaticRows: asNumber(summary.signedReplayMediumStaticRows),
      watchCandidates: asNumber(summary.watchCandidates),
      priorityScore: 30,
      blocker: summary.blocker || "Prediction-market live route context has no permissionless order/collateral extraction with exact economics and fork/local proof.",
    }));
  }
  return rows;
}

function inputRoutePositiveDowngrades(inputs) {
  const rows = [];
  for (const [key, data] of Object.entries(inputs)) {
    const summary = data && data.summary ? data.summary : {};
    const sourceRoutePositive = maxMetric(summary.routePositive, data && data.safety && data.safety.routePositive);
    const sourceExecutableNow = maxMetric(summary.executableNow, data && data.safety && data.safety.executableNow);
    if (sourceRoutePositive > 0 || sourceExecutableNow > 0) {
      rows.push(rowBase("source-route-positive-downgraded", key, {
        signal: "source-route-positive-fail-closed",
        sourceRoutePositive,
        sourceExecutableNow,
        downgradeReason: "Intent/solver consolidator requires decoded settlement fields, exact economics, and fork/local proof; source positives are not propagated automatically.",
        blocker: "Fail-closed route gate: no executable route is emitted by this artifact-only scanner.",
      }));
    }
  }
  return rows;
}

function rankedRows(rows) {
  return rows.slice().sort((a, b) => {
    const aw = /watch/i.test(String(a.signal || a.category || "")) ? 1 : 0;
    const bw = /watch/i.test(String(b.signal || b.category || "")) ? 1 : 0;
    if (aw !== bw) return bw - aw;
    const ap = numberOrZero(a.netProfitUsd ?? a.netUsd ?? a.priorityScore);
    const bp = numberOrZero(b.netProfitUsd ?? b.netUsd ?? b.priorityScore);
    return bp - ap;
  });
}

function topRowView(row) {
  return {
    category: row.category,
    signal: row.signal,
    sourceKey: row.sourceKey,
    protocol: row.protocol || row.target || null,
    chain: row.chain || row.route || null,
    subject: row.txHash || row.pair || row.target || row.reactor || row.function || null,
    netUsd: row.netProfitUsd ?? row.netUsd ?? null,
    priorityScore: round(row.priorityScore, 2),
    routePositive: false,
    blocker: row.blocker || row.downgradeReason || null,
  };
}

function sortTopRows(rows) {
  const ranked = rankedRows(rows);
  const categoryOrder = [
    "uniswapx-transfer-profit-watch-downgraded",
    "deployed-router-inventory-watch",
    "cross-chain-settlement-quote-context",
    "router-rfq-field-binding-context",
    "filler-concentration-context",
    "solver-architecture-context",
    "signed-payload-replay-context",
  ];
  const selected = [];
  const seen = new Set();
  for (const category of categoryOrder) {
    const row = ranked.find((candidate) => candidate.category === category);
    if (row && !seen.has(row)) {
      selected.push(row);
      seen.add(row);
    }
  }
  for (const row of ranked) {
    if (selected.length >= CONFIG.topRows) break;
    if (seen.has(row)) continue;
    selected.push(row);
    seen.add(row);
  }
  return selected.slice(0, CONFIG.topRows).map(topRowView);
}

function escapeCell(value) {
  return sanitizeString(value === null || value === undefined ? "" : value).replace(/\|/g, "\\|");
}

function buildMarkdown(out) {
  const lines = [];
  lines.push("# Intent/Solver Settlement Abuse Triage");
  lines.push("");
  lines.push(`Generated: ${out.generatedAt}`);
  lines.push("");
  lines.push("Signal: ⚪ CLEAN / watch-only — no confirmed permissionless extraction; routePositive=0, executableNow=0, signedActionJustified=false.");
  lines.push("");
  lines.push("## Key Counts");
  lines.push("");
  lines.push(`- Artifacts loaded: ${out.summary.artifactsLoaded}`);
  lines.push(`- Router source rows / field-binding proofs: ${out.summary.sourceRows} / ${out.summary.fieldBindingProofRows}`);
  lines.push(`- Deployed router inventory/watch/deprecated rows: ${out.summary.deployedRouterInventoryRows} / ${out.summary.deployedWatchRows} / ${out.summary.deprecatedReachabilityRows}`);
  lines.push(`- UniswapX fills / unique fillers: ${out.summary.fillEvents} / ${out.summary.uniqueFillers}`);
  lines.push(`- Transfer profit rows / transfer-only positive / downgraded: ${out.summary.transferProfitRows} / ${out.summary.transferOnlyPositiveRows} / ${out.summary.transferOnlyProfitDowngradedRows}`);
  lines.push(`- Decoded orders / sandwich simulations: ${out.summary.decodedOrderRows} / ${out.summary.sandwichSimulationRows}`);
  lines.push(`- Cross-chain exact quote rows / branch quote rows: ${out.summary.crossChainExactQuoteRows} / ${out.summary.branchQuoteRows}`);
  lines.push(`- Verified field diff / live approval-escrow / balance-delta mismatch: ${out.summary.verifiedFieldDiffRows} / ${out.summary.liveApprovalOrEscrowRows} / ${out.summary.balanceDeltaMismatchRows}`);
  lines.push(`- Exact economics / fork proof rows: ${out.summary.exactEconomicsRows} / ${out.summary.forkProofRows}`);
  lines.push(`- Best transfer-only net USD: ${out.summary.bestTransferOnlyNetUsd}`);
  lines.push(`- Watch candidates: ${out.summary.watchCandidates}`);
  lines.push(`- Status: \`${out.summary.status}\``);
  lines.push("");
  lines.push("## Downgrade Caveat");
  lines.push("");
  lines.push("Transfer-only profit rows and quote rows are downgraded to watch/context unless they are joined to decoded order/settlement fields, exact balance-delta economics, and fork/local proof. Current route gates remain fail-closed.");
  lines.push("");
  lines.push("## Top Rows");
  lines.push("");
  lines.push("| Category | Signal | Source | Subject | Net USD | Blocker |");
  lines.push("|---|---|---|---|---:|---|");
  for (const row of out.topRows) {
    lines.push(`| ${escapeCell(row.category)} | ${escapeCell(row.signal)} | ${escapeCell(row.sourceKey)} | ${escapeCell(row.subject || row.protocol)} | ${row.netUsd ?? ""} | ${escapeCell(row.blocker)} |`);
  }
  lines.push("");
  lines.push("## Blockers");
  lines.push("");
  for (const caveat of out.caveats) lines.push(`- ${escapeCell(caveat)}`);
  lines.push("");
  lines.push("## Required For Route Positive");
  lines.push("");
  for (const item of out.requiredForRoutePositive) lines.push(`- ${escapeCell(item)}`);
  lines.push("");
  lines.push("## Next Read-Only Steps");
  lines.push("");
  for (const item of out.nextReadOnlyStep) lines.push(`- ${escapeCell(item)}`);
  lines.push("");
  lines.push("## Artifacts");
  lines.push("");
  lines.push(`- JSON: \`${rel(OUT_JSON)}\``);
  lines.push(`- Scanner: \`${SCANNER}\``);
  return `${lines.join("\n")}\n`;
}

function main() {
  fs.mkdirSync(RAW, { recursive: true });

  const loaded = {};
  const inputMeta = {};
  const caveats = [
    "Artifact-only scanner: no RPC calls, endpoint inventories, env files, keys, calldata execution, signed actions, broadcasts, wallet operations, or fork transactions were used.",
    "Router/RFQ deployed bytecode and selector hits are watch-only until joined to verified-source field drift, live approval/escrow reachability, exact economics, and fork/local proof.",
    "UniswapX transfer-only positive rows are downgraded because they lack decoded order fields, user limit price, auction curve, exact token pricing, sandwich/counterfactual simulation, and fork/local proof.",
    "Cross-chain quote rows are quote metadata only until joined to a proven permissionless branch with exact positive economics and fork/local proof.",
    "Filler concentration and solver architecture notes are context only; solver access assumptions do not prove extraction.",
  ];

  for (const [key, def] of Object.entries(INPUTS)) {
    const { data, meta } = readArtifact(key, def);
    loaded[key] = data;
    inputMeta[key] = meta;
    if (!meta.loaded) {
      caveats.push(`${def.required ? "Required" : "Optional"} input ${key} was not loaded from ${rel(def.file)}${meta.parseError ? `: ${meta.parseError}` : "."}`);
    }
  }

  const router = loaded.routerRfqSettlementDrift || {};
  const mev = loaded.mevSandwichOrderEconomics || {};
  const profit = loaded.uniswapxFillerProfit || {};
  const fillerMev = loaded.uniswapxFillerMev || {};
  const fusion = loaded.fusionResolverAnalysis || {};
  const cross = loaded.crossChainSettlementQuotes || {};

  const rows = [];
  rows.push(...collectRouterFieldBindingRows(router));
  rows.push(...collectDeployedRouterRows(router));
  rows.push(...collectTransferProfitRows(mev, profit));
  rows.push(...collectFillerConcentrationRows(mev, fillerMev));
  rows.push(...collectArchitectureRows(fusion));
  rows.push(...collectCrossChainQuoteRows(cross));
  rows.push(...collectSignedPayloadRows(loaded.signedPayloadReplay, loaded.predictionMarketLiveRoutes));
  rows.push(...collectApprovalDrainRows(loaded.routerApprovalDrain));

  const sourceRoutePositiveDowngrades = inputRoutePositiveDowngrades(loaded);
  const transferDowngradedRows = rows.filter((row) => row.category === "uniswapx-transfer-profit-watch-downgraded");
  const quoteRows = rows.filter((row) => row.category === "cross-chain-settlement-quote-context");
  const downgradedRows = sanitizeValue([
    {
      category: "uniswapx-transfer-profit-watch-downgraded",
      sourceKey: transferDowngradedRows[0] ? transferDowngradedRows[0].sourceKey : "mevSandwichOrderEconomics",
      rowsDowngraded: transferDowngradedRows.length,
      reason: "Transfer-only positive profit is not exact order economics.",
      routePositive: false,
    },
    {
      category: "cross-chain-settlement-quote-context",
      sourceKey: "crossChainSettlementQuotes",
      rowsDowngraded: maxMetric(cross.summary && cross.summary.exactQuoteRows) + maxMetric(cross.summary && cross.summary.branchQuoteRows),
      reason: "Quote metadata is not a proven settlement abuse branch.",
      routePositive: false,
    },
    ...sourceRoutePositiveDowngrades,
  ]);

  const routerSummary = router.summary || {};
  const mevSummary = mev.summary || {};
  const crossSummary = cross.summary || {};
  const positiveProfitRows = transferDowngradedRows.length;
  const transferProfitRows = maxMetric(mevSummary.transferProfitRows, Array.isArray(mev.transferRows) ? mev.transferRows.length : null, profit.fillsAnalyzed, Array.isArray(profit.results) ? profit.results.length : null);
  const transferOnlyPositiveRows = maxMetric(mevSummary.transferOnlyPositiveRows, positiveProfitRows);
  const deployedWatchRows = maxMetric(routerSummary.deployedWatchRows, routerSummary.deployedRows, Array.isArray(router.deployedRows) ? router.deployedRows.length : null);
  const bestTransferOnlyNetUsd = transferDowngradedRows.reduce((best, row) => {
    const n = asNumber(row.netProfitUsd);
    return n === null ? best : Math.max(best, n);
  }, 0);
  const watchCandidates = deployedWatchRows + transferOnlyPositiveRows;
  const status = watchCandidates > 0
    ? "intent-solver-settlement-watch-needs-decoded-order-balance-delta-economics"
    : "intent-solver-settlement-no-route-positive";

  const summary = {
    artifactsLoaded: Object.values(inputMeta).filter((meta) => meta.loaded).length,
    sourceRows: maxMetric(routerSummary.sourceRows),
    fieldBindingProofRows: maxMetric(routerSummary.fieldBindingProofRows),
    deployedRouterInventoryRows: maxMetric(routerSummary.deployedRouterInventoryRows, routerSummary.deployedRows, Array.isArray(router.deployedRows) ? router.deployedRows.length : null),
    deployedWatchRows,
    deprecatedReachabilityRows: maxMetric(routerSummary.deprecatedReachabilityRows, Array.isArray(router.deployedRows) ? router.deployedRows.filter((row) => row.deprecated).length : null),
    fillEvents: maxMetric(mevSummary.fillEvents, Object.values(fillerMev.byReactor || {}).reduce((sum, row) => sum + numberOrZero(row.fillEvents), 0)),
    uniqueFillers: maxMetric(mevSummary.uniqueFillers, ...reactorRowsFrom(mev, fillerMev).map((row) => row.uniqueFillers)),
    transferProfitRows,
    transferOnlyPositiveRows,
    transferOnlyProfitDowngradedRows: transferOnlyPositiveRows,
    decodedOrderRows: maxMetric(mevSummary.decodedOrderRows),
    sandwichSimulationRows: maxMetric(mevSummary.sandwichSimulationRows),
    crossChainExactQuoteRows: maxMetric(crossSummary.exactQuoteRows),
    branchQuoteRows: maxMetric(crossSummary.branchQuoteRows),
    verifiedFieldDiffRows: maxMetric(routerSummary.verifiedFieldDiffRows),
    liveApprovalOrEscrowRows: maxMetric(routerSummary.liveApprovalOrEscrowRows),
    balanceDeltaMismatchRows: maxMetric(routerSummary.balanceDeltaMismatchRows),
    exactEconomicsRows: 0,
    forkProofRows: 0,
    watchCandidates,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    bestTransferOnlyNetUsd: round(bestTransferOnlyNetUsd, 6),
    status,
  };

  const requiredForRoutePositive = [
    "Decoded intent/order/settlement fields: maker/taker, tokens, amounts, recipient, deadline, nonce/fill state, user limits, and auction/solver terms.",
    "Verified deployed settlement path where signed order fields differ from executed transfer fields or solver execution can permissionlessly extract value.",
    "Live approval, escrow, balance, or custody reachability on the deployed path without privileged roles or off-chain-only solver access.",
    "Exact balance-delta economics after gas, fees, slippage, token pricing, finality/bridge costs, and user-loss/filler-profit accounting.",
    "Fork/local proof demonstrating net extraction before any signed action, broadcast, wallet operation, or exploit execution.",
  ];

  const nextReadOnlyStep = [
    "Join positive transfer-only fills to decoded UniswapX/order/RFQ payload fields and per-token balance deltas from existing artifacts or new read-only decoders.",
    "Join cross-chain quote rows to a proven settlement/bridge mismatch branch before treating quote economics as exploit economics.",
    "For router inventory rows, require verified-source field-diff proof plus live approval/escrow reachability before any fork-proof request.",
  ];

  const allRows = rows.slice(0, CONFIG.maxRows);
  const out = sanitizeValue({
    generatedAt: new Date().toISOString(),
    scanner: SCANNER,
    scope: "Artifact-only intent/solver settlement abuse consolidation over router/RFQ, UniswapX/MEV, solver architecture, cross-chain quote, and signed-payload context artifacts",
    safety: {
      artifactOnly: true,
      rpcInventoryRead: false,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      calldataExecuted: false,
      forkTransactions: false,
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
    },
    config: CONFIG,
    inputs: inputMeta,
    summary,
    rows: allRows,
    topRows: sortTopRows(allRows),
    sourceRoutePositiveDowngradedRows: sourceRoutePositiveDowngrades.length,
    downgradedRows,
    caveats,
    requiredForRoutePositive,
    nextReadOnlyStep,
  });

  fs.writeFileSync(OUT_JSON, `${JSON.stringify(out, null, 2)}\n`);
  fs.writeFileSync(OUT_MD, buildMarkdown(out));
  if (!QUIET) {
    console.log(`Intent/solver settlement abuse: status=${out.summary.status} watch=${out.summary.watchCandidates} routePositive=${out.summary.routePositive} executableNow=${out.summary.executableNow}`);
    console.log(`Counts: deployedWatch=${out.summary.deployedWatchRows} transferOnlyDowngraded=${out.summary.transferOnlyProfitDowngradedRows} crossChainExactQuotes=${out.summary.crossChainExactQuoteRows} branchQuotes=${out.summary.branchQuoteRows}`);
    console.log(`Artifact: ${rel(OUT_JSON)}`);
  }
}

main();
