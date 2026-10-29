#!/usr/bin/env node
// scan-bridge-delta-preflight.js - focused read-only bridge delta preflight.
// Re-checks top bridge->consumer joins for concrete balance-delta/backing evidence.
// Reads RPC inventory in memory only; never prints or stores RPC URLs.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const JOIN_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "bridge-nonlossless-collateral-join.json");
const HYPERLANE_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "hyperlane-warp-routes.json");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "bridge-delta-preflight.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "bridge-delta-preflight-triage.md");
const QUIET = process.argv.includes("--quiet");

const TOP_ROWS = Number(process.env.BRIDGE_DELTA_PREFLIGHT_TOP_ROWS || "40");
const RPC_CONCURRENCY = Number(process.env.BRIDGE_DELTA_PREFLIGHT_CONCURRENCY || "6");
const MATERIAL_USD = Number(process.env.BRIDGE_DELTA_PREFLIGHT_MATERIAL_USD || "10000");

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const CHAIN_IDS = {
  ethereum: 1,
  mainnet: 1,
  optimism: 10,
  bsc: 56,
  gnosis: 100,
  unichain: 130,
  polygon: 137,
  mantle: 5000,
  base: 8453,
  arbitrum: 42161,
  avalanche: 43114,
  ink: 57073,
  blast: 81457,
  berachain: 80094,
  scroll: 534352,
  linea: 59144,
  worldchain: 480,
  hyperevm: 999,
};

const SELECTORS = {
  asset: "0x38d52e0f",
  balanceOf: "0x70a08231",
  convertToAssets: "0x07a2d13a",
  decimals: "0x313ce567",
  name: "0x06fdde03",
  stEthPerToken: "0x035faf82",
  symbol: "0x95d89b41",
  tokensPerStEth: "0x336d2698",
  totalAssets: "0x01e1d114",
  totalSupply: "0x18160ddd",
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

function chainKey(value) {
  const text = String(value || "").trim().toLowerCase().replace(/\s+/g, "");
  const aliases = {
    eth: "ethereum",
    mainnet: "ethereum",
    arb: "arbitrum",
    arbitrumone: "arbitrum",
    op: "optimism",
    optimisticethereum: "optimism",
    bnb: "bsc",
    binance: "bsc",
    binancesmartchain: "bsc",
    polygonpos: "polygon",
    bera: "berachain",
  };
  return aliases[text] || text || null;
}

function normAddress(value) {
  const text = String(value || "").trim();
  return EVM_ADDRESS_RE.test(text) ? text.toLowerCase() : null;
}

function encodeAddressArg(address) {
  return String(address || "").replace(/^0x/i, "").padStart(64, "0");
}

function encodeUintArg(value) {
  return BigInt(value).toString(16).padStart(64, "0");
}

function toBigInt(value) {
  if (value === null || value === undefined || value === "") return null;
  try {
    return BigInt(value);
  } catch (_) {
    return null;
  }
}

function loadRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function rpcCall(url, method, params = [], timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    const json = await res.json();
    if (json.error) throw new Error("rpc error");
    return json.result ?? null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveRpcPool(chainIds) {
  const wanted = new Set(chainIds.filter((id) => id !== null && id !== undefined));
  const pool = {};
  for (const url of loadRpcUrls()) {
    try {
      const chainIdHex = await rpcCall(url, "eth_chainId", [], 5000);
      const chainId = Number(BigInt(chainIdHex));
      if (wanted.has(chainId) && !pool[chainId]) pool[chainId] = url;
      if (Object.keys(pool).length >= wanted.size) break;
    } catch (_) {
      // Never print or persist RPC URLs.
    }
  }
  return pool;
}

async function ethCall(rpc, to, data) {
  if (!rpc || !EVM_ADDRESS_RE.test(to || "")) return null;
  try {
    return await rpcCall(rpc, "eth_call", [{ to, data }, "latest"], 10_000);
  } catch (_) {
    return null;
  }
}

function decodeUint(raw) {
  if (!raw || raw === "0x") return null;
  try {
    return BigInt(raw).toString();
  } catch (_) {
    return null;
  }
}

function decodeAddress(raw) {
  if (!raw || raw === "0x") return null;
  const hex = raw.replace(/^0x/i, "").padStart(64, "0");
  if (/^0+$/.test(hex)) return null;
  const address = `0x${hex.slice(-40)}`;
  return EVM_ADDRESS_RE.test(address) ? address.toLowerCase() : null;
}

function decodeString(raw) {
  if (!raw || raw === "0x") return null;
  try {
    const hex = raw.slice(2);
    if (hex.length === 64) {
      const text = Buffer.from(hex, "hex").toString("utf8").replace(/\0+$/g, "").trim();
      return text || null;
    }
    const offset = Number(BigInt(`0x${hex.slice(0, 64)}`));
    const lenStart = offset * 2;
    const len = Number(BigInt(`0x${hex.slice(lenStart, lenStart + 64)}`));
    if (!Number.isFinite(len) || len < 0 || len > 1024) return null;
    return Buffer.from(hex.slice(lenStart + 64, lenStart + 64 + len * 2), "hex").toString("utf8").replace(/\0/g, "").trim() || null;
  } catch (_) {
    return null;
  }
}

function humanAmount(raw, decimals) {
  const value = toBigInt(raw);
  if (value === null || decimals === null || decimals === undefined) return null;
  try {
    const d = Number(decimals);
    const scale = 10n ** BigInt(Math.max(0, d));
    const whole = value / scale;
    const frac = value % scale;
    const fracText = frac.toString().padStart(d, "0").slice(0, 8).replace(/0+$/, "");
    return `${whole.toString()}${fracText ? "." + fracText : ""}`;
  } catch (_) {
    return null;
  }
}

async function readErc20(rpc, token, holder = null) {
  if (!rpc || !EVM_ADDRESS_RE.test(token || "")) return null;
  const [code, symbolRaw, nameRaw, decimalsRaw, totalSupplyRaw, balanceRaw] = await Promise.all([
    rpcCall(rpc, "eth_getCode", [token, "latest"], 10_000).catch(() => null),
    ethCall(rpc, token, SELECTORS.symbol),
    ethCall(rpc, token, SELECTORS.name),
    ethCall(rpc, token, SELECTORS.decimals),
    ethCall(rpc, token, SELECTORS.totalSupply),
    holder && EVM_ADDRESS_RE.test(holder) ? ethCall(rpc, token, SELECTORS.balanceOf + encodeAddressArg(holder)) : Promise.resolve(null),
  ]);
  const decimals = decodeUint(decimalsRaw);
  const totalSupply = decodeUint(totalSupplyRaw);
  const balance = decodeUint(balanceRaw);
  return {
    hasCode: Boolean(code && code !== "0x"),
    symbol: decodeString(symbolRaw),
    name: decodeString(nameRaw),
    decimals,
    totalSupplyRaw: totalSupply,
    totalSupply: humanAmount(totalSupply, decimals),
    balanceRaw: balance,
    balance: humanAmount(balance, decimals),
  };
}

async function readTraits(rpc, token, decimals) {
  if (!rpc || !EVM_ADDRESS_RE.test(token || "")) return {};
  const one = 10n ** BigInt(Math.max(0, Number(decimals || 18)));
  const [assetRaw, totalAssetsRaw, convertRaw, stEthPerTokenRaw, tokensPerStEthRaw] = await Promise.all([
    ethCall(rpc, token, SELECTORS.asset),
    ethCall(rpc, token, SELECTORS.totalAssets),
    ethCall(rpc, token, SELECTORS.convertToAssets + encodeUintArg(one)),
    ethCall(rpc, token, SELECTORS.stEthPerToken),
    ethCall(rpc, token, SELECTORS.tokensPerStEth),
  ]);
  const asset = decodeAddress(assetRaw);
  const convertToAssetsRaw = decodeUint(convertRaw);
  const totalAssets = decodeUint(totalAssetsRaw);
  const stEthPerToken = decodeUint(stEthPerTokenRaw);
  const tokensPerStEth = decodeUint(tokensPerStEthRaw);
  return {
    erc4626Like: Boolean(asset && (convertToAssetsRaw || totalAssets)),
    asset,
    totalAssetsRaw: totalAssets,
    convertToAssetsOneRaw: convertToAssetsRaw,
    stEthPerTokenRaw: stEthPerToken,
    tokensPerStEthRaw: tokensPerStEth,
    wstEthLike: Boolean(stEthPerToken || tokensPerStEth),
  };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const current = idx++;
      out[current] = await fn(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function routeTokenKey(row) {
  return [row.routeId, chainKey(row.chain), normAddress(row.token), String(row.signalKind || "")].join(":");
}

function buildMaterialRows(joinArtifact) {
  const groups = new Map();
  for (const row of (joinArtifact.topRows || []).slice(0, TOP_ROWS)) {
    const key = routeTokenKey(row);
    if (!key || key.includes("null")) continue;
    if (!groups.has(key)) {
      groups.set(key, {
        ...row,
        chainKey: chainKey(row.chain),
        tokenKey: normAddress(row.token),
        consumerRows: [],
        consumerProtocols: new Set(),
        maxConsumerLiquidityUsd: 0,
      });
    }
    const group = groups.get(key);
    group.consumerRows.push({
      protocol: row.consumerProtocol || null,
      side: row.consumerSide || null,
      source: row.consumerSource || null,
      market: row.consumerMarket || null,
      liquidityUsd: round(row.liquidityUsd, 2),
      ltv: asNumber(row.ltv),
      borrowingEnabled: row.borrowingEnabled ?? null,
    });
    if (row.consumerProtocol) group.consumerProtocols.add(row.consumerProtocol);
    group.maxConsumerLiquidityUsd = Math.max(group.maxConsumerLiquidityUsd, asNumber(row.liquidityUsd) || 0);
  }
  return [...groups.values()].map((row) => ({
    ...row,
    consumerProtocols: [...row.consumerProtocols],
    materialConsumer: row.maxConsumerLiquidityUsd >= MATERIAL_USD,
  })).sort((a, b) => b.maxConsumerLiquidityUsd - a.maxConsumerLiquidityUsd);
}

function buildHyperlaneLookup(hyperlane) {
  const routes = new Map();
  for (const route of hyperlane.topRoutes || []) routes.set(route.routeId, route);
  const liveRows = new Map();
  for (const row of hyperlane.liveBalanceRows || []) {
    const key = [row.routeId, chainKey(row.chainName), normAddress(row.addressOrDenom), normAddress(row.collateralAddressOrDenom)].join(":");
    liveRows.set(key, row);
  }
  return { routes, liveRows };
}

function findRouteToken(row, lookup) {
  const route = lookup.routes.get(row.routeId);
  const cKey = chainKey(row.chain);
  const tokenKey = normAddress(row.token);
  const tokens = route?.topTokens || [];
  return tokens.find((token) => {
    if (chainKey(token.chainName) !== cKey) return false;
    return normAddress(token.addressOrDenom) === tokenKey || normAddress(token.collateralAddressOrDenom) === tokenKey;
  }) || null;
}

function routeTokensFor(routeId, lookup) {
  const route = lookup.routes.get(routeId);
  return (route?.topTokens || []).filter((token) => EVM_ADDRESS_RE.test(token.addressOrDenom || "") || EVM_ADDRESS_RE.test(token.collateralAddressOrDenom || ""));
}

function rawPositive(value) {
  const n = toBigInt(value);
  return n !== null && n > 0n;
}

function addRaw(a, b) {
  const an = toBigInt(a) || 0n;
  const bn = toBigInt(b) || 0n;
  return (an + bn).toString();
}

async function probeToken(row, token, rpcPool) {
  const cKey = chainKey(token.chainName || row.chain);
  const chainId = CHAIN_IDS[cKey] || null;
  const rpc = chainId ? rpcPool[chainId] : null;
  if (!chainId) return { ...token, chainKey: cKey, chainId, liveProbeStatus: "unsupported-chain" };
  if (!rpc) return { ...token, chainKey: cKey, chainId, liveProbeStatus: "missing-rpc" };
  const bridgeToken = normAddress(token.addressOrDenom);
  const collateralToken = normAddress(token.collateralAddressOrDenom);
  const [bridgeErc20, collateralErc20] = await Promise.all([
    bridgeToken ? readErc20(rpc, bridgeToken) : Promise.resolve(null),
    collateralToken ? readErc20(rpc, collateralToken, bridgeToken) : Promise.resolve(null),
  ]);
  const traitToken = collateralToken || bridgeToken;
  const traitDecimals = collateralErc20?.decimals || bridgeErc20?.decimals || 18;
  const traits = await readTraits(rpc, traitToken, traitDecimals);
  return {
    routeId: token.routeId || row.routeId,
    chainName: token.chainName || row.chain,
    chainKey: cKey,
    chainId,
    symbol: token.symbol || row.symbol,
    name: token.name || null,
    standard: token.standard || null,
    addressOrDenom: token.addressOrDenom || null,
    collateralAddressOrDenom: token.collateralAddressOrDenom || null,
    riskClass: token.riskClass || null,
    liveProbeStatus: bridgeErc20?.hasCode || collateralErc20?.hasCode ? "ok" : "no-token-code",
    bridgeToken: bridgeErc20,
    collateralToken: collateralErc20,
    traits,
    positiveBridgeSupply: rawPositive(bridgeErc20?.totalSupplyRaw),
    positiveLockedCollateral: rawPositive(collateralErc20?.balanceRaw),
  };
}

function routeBacking(routeId, routeProbeRows, rebaseChecks) {
  const rows = routeProbeRows.filter((row) => row.routeId === routeId && row.liveProbeStatus === "ok");
  const syntheticRows = rows.filter((row) => /Synthetic|XERC20/i.test(row.standard || ""));
  const wrappedSupplyRaw = syntheticRows.reduce((acc, row) => addRaw(acc, row.bridgeToken?.totalSupplyRaw), "0");
  const lockedCollateralRaw = rows.reduce((acc, row) => addRaw(acc, row.collateralToken?.balanceRaw), "0");
  const knownWrappedRows = syntheticRows.filter((row) => row.bridgeToken?.totalSupplyRaw !== null && row.bridgeToken?.totalSupplyRaw !== undefined).length;
  const knownCollateralRows = rows.filter((row) => row.collateralToken?.balanceRaw !== null && row.collateralToken?.balanceRaw !== undefined).length;
  const rebaseCheck = (rebaseChecks || []).find((check) => check.routeId === routeId) || null;
  let backingDeltaRaw = null;
  let backingDeltaBps = null;
  const wrapped = toBigInt(wrappedSupplyRaw);
  const locked = toBigInt(lockedCollateralRaw);
  if (wrapped !== null && locked !== null && knownWrappedRows > 0 && knownCollateralRows > 0) {
    backingDeltaRaw = (locked - wrapped).toString();
    const base = wrapped > locked ? wrapped : locked;
    if (base > 0n) backingDeltaBps = Number((locked - wrapped) * 10000n / base);
  }
  return {
    routeId,
    probedRows: rows.length,
    syntheticRows: syntheticRows.length,
    knownWrappedRows,
    knownCollateralRows,
    wrappedSupplyRaw,
    lockedCollateralRaw,
    backingDeltaRaw,
    backingDeltaBps,
    rebaseDeltaBps: asNumber(rebaseCheck?.deltaBps),
    rebaseShareMatched: rebaseCheck?.shareMatched ?? null,
  };
}

function assessRow(row, routeToken, directProbe, routeState) {
  const signalKind = String(row.signalKind || "");
  const standard = String(routeToken?.standard || "");
  const nameText = `${routeToken?.symbol || row.symbol || ""} ${routeToken?.name || ""} ${standard}`;
  const sourceLockboxConsumer = /collateral-lockbox-leg/i.test(signalKind);
  const remoteSyntheticConsumer = /wrapped-or-synthetic-leg/i.test(signalKind);
  const rebaseStandard = /Rebase/i.test(standard);
  const feeOrRebaseHint = /fee|tax|reflect|rebase|rebasing|elastic|deflat|burn|transfer[-_\s]?fee/i.test(nameText);
  const valueBearingOnly = /staked|restaked|staking|wrapped liquid|vault|share|receipt|yield|ezeth|wsteth/i.test(nameText) && !feeOrRebaseHint && !rebaseStandard;
  const traits = directProbe?.traits || {};
  const concreteMismatch = Boolean(
    (routeState.rebaseDeltaBps !== null && Math.abs(routeState.rebaseDeltaBps) > 1)
    || (remoteSyntheticConsumer && (traits.erc4626Like || rebaseStandard || feeOrRebaseHint) && routeState.backingDeltaBps !== null && Math.abs(routeState.backingDeltaBps) > 1)
  );
  const materialMismatch = concreteMismatch && row.materialConsumer && remoteSyntheticConsumer;
  const blockers = [];
  if (sourceLockboxConsumer) blockers.push("Consumer match is the source-chain collateral/lockbox token, not the remote over-credited synthetic token.");
  if (!remoteSyntheticConsumer) blockers.push("No material consumer row accepts a wrapped/synthetic bridge leg in this preflight set.");
  if (valueBearingOnly || traits.wstEthLike) blockers.push("Value-bearing or wstETH-style rate wrapper is not transfer-loss/rebase balance-delta proof.");
  if (!rebaseStandard && !traits.erc4626Like && !feeOrRebaseHint) blockers.push("No concrete non-lossless token trait was observed for the probed bridge leg.");
  if (routeState.backingDeltaBps === null) blockers.push("Route backing comparison is incomplete because wrapped supply or locked collateral data is unavailable for at least one side.");
  if (routeState.backingDeltaBps !== null && Math.abs(routeState.backingDeltaBps) <= 1) blockers.push("Observed route backing/share comparison is matched within the scanner threshold.");
  if (!materialMismatch) blockers.push("No live material bridge mismatch is joined to exact borrow/exit economics or fork proof.");
  return {
    id: row.id,
    bridge: row.bridge,
    routeId: row.routeId,
    chain: row.chain,
    symbol: row.symbol,
    signalKind: row.signalKind,
    standard: routeToken?.standard || null,
    bridgeToken: normAddress(routeToken?.addressOrDenom),
    collateralToken: normAddress(routeToken?.collateralAddressOrDenom),
    consumerRows: row.consumerRows.length,
    consumerProtocols: row.consumerProtocols,
    maxConsumerLiquidityUsd: round(row.maxConsumerLiquidityUsd, 2),
    materialConsumer: row.materialConsumer,
    sourceLockboxConsumer,
    remoteSyntheticConsumer,
    liveProbeStatus: directProbe?.liveProbeStatus || "not-probed",
    live: {
      bridgeSupplyRaw: directProbe?.bridgeToken?.totalSupplyRaw || null,
      bridgeSupply: directProbe?.bridgeToken?.totalSupply || null,
      lockedCollateralRaw: directProbe?.collateralToken?.balanceRaw || null,
      lockedCollateral: directProbe?.collateralToken?.balance || null,
      collateralTotalSupplyRaw: directProbe?.collateralToken?.totalSupplyRaw || null,
      collateralTotalSupply: directProbe?.collateralToken?.totalSupply || null,
      erc4626Like: Boolean(traits.erc4626Like),
      wstEthLike: Boolean(traits.wstEthLike),
      rebaseStandard,
      feeOrRebaseHint,
      valueBearingOnly,
    },
    routeBacking: routeState,
    concreteMismatch,
    materialMismatch,
    exactEconomicsRows: 0,
    forkProofRows: 0,
    routePositive: false,
    blockers: [...new Set(blockers)],
  };
}

function report(out) {
  const rows = out.rows.slice(0, 10).map((row) => `| ${row.routeId} | ${row.chain} | ${row.symbol} | ${row.signalKind} | ${row.consumerProtocols.join("+") || "n/a"} | $${round(row.maxConsumerLiquidityUsd, 2) ?? 0} | ${row.blockers[0] || "none"} |`);
  return [
    "# 🟢 DORMANT - Bridge Delta Preflight",
    "",
    `Date: ${new Date(out.generatedAt).toISOString().slice(0, 10)}`,
    "",
    "## Result",
    "",
    `Probed ${out.summary.uniqueJoinRows} unique top bridge-consumer joins and ${out.summary.routeProbeRows} route token rows. No concrete bridge balance-delta/backing mismatch was found. Route-relevant gates remain closed: \`materialMismatchRows=${out.summary.materialMismatchRows}\`, \`exactEconomicsRows=${out.summary.exactEconomicsRows}\`, \`forkProofRows=${out.summary.forkProofRows}\`, \`routePositive=0\`, \`executableNow=0\`, \`signedActionJustified=false\`.`,
    "",
    `The dominant blocker is leg mismatch: ${out.summary.sourceLockboxConsumerRows} joined rows are source-chain lockbox/collateral consumers, while ${out.summary.remoteSyntheticConsumerRows} rows are remote wrapped/synthetic consumer joins. A bridge over-credit route needs the consumer to accept the over-credited wrapped/synthetic token, not only the source collateral token.`,
    "",
    "## Top Preflight Rows",
    "",
    "| Route | Chain | Token | Leg | Consumers | Liquidity | Primary Blocker |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "## Route-Positive Gate",
    "",
    "Do not quote or fork until a row has a live nominal-vs-balance-delta or locked-vs-remote-supply mismatch, the mismatched wrapped/synthetic token is accepted by a material consumer, exact borrow/exit economics are positive, and fork/local proof demonstrates net value extraction.",
    "",
    "## Artifacts",
    "",
    `- JSON: \`${rel(RAW_OUT)}\``,
    `- Scanner: \`${rel(path.join(WORKSPACE, "tools", "scan-bridge-delta-preflight.js"))}\``,
    `- Inputs: \`${rel(JOIN_FILE)}\`, \`${rel(HYPERLANE_FILE)}\``,
    "",
  ].join("\n");
}

async function main() {
  const joinArtifact = readJson(JOIN_FILE, {});
  const hyperlane = readJson(HYPERLANE_FILE, {});
  const lookup = buildHyperlaneLookup(hyperlane);
  const materialRows = buildMaterialRows(joinArtifact).filter((row) => row.bridge === "Hyperlane Warp");
  const routeIds = [...new Set(materialRows.map((row) => row.routeId).filter(Boolean))];
  const routeTokens = routeIds.flatMap((routeId) => routeTokensFor(routeId, lookup).map((token) => ({ ...token, routeId })));
  const wantedChainIds = [...new Set(routeTokens.map((token) => CHAIN_IDS[chainKey(token.chainName)]).filter(Boolean))];
  const rpcPool = await resolveRpcPool(wantedChainIds);
  const routeProbeRows = await mapLimit(routeTokens, RPC_CONCURRENCY, (token) => probeToken({ routeId: token.routeId, chain: token.chainName, symbol: token.symbol }, token, rpcPool));
  const routeStateById = Object.fromEntries(routeIds.map((routeId) => [routeId, routeBacking(routeId, routeProbeRows, hyperlane.rebaseRouteChecks || [])]));
  const directProbeByKey = new Map();
  for (const probe of routeProbeRows) {
    directProbeByKey.set([probe.routeId, chainKey(probe.chainName), normAddress(probe.addressOrDenom), normAddress(probe.collateralAddressOrDenom)].join(":"), probe);
  }
  const rows = materialRows.map((row) => {
    const token = findRouteToken(row, lookup);
    const key = [row.routeId, chainKey(row.chain), normAddress(token?.addressOrDenom), normAddress(token?.collateralAddressOrDenom)].join(":");
    return assessRow(row, token, directProbeByKey.get(key), routeStateById[row.routeId] || { routeId: row.routeId });
  });
  const summary = {
    inputTopRows: (joinArtifact.topRows || []).length,
    uniqueJoinRows: materialRows.length,
    routeIds: routeIds.length,
    routeProbeRows: routeProbeRows.length,
    rpcChainsWanted: wantedChainIds.length,
    rpcChainsResolved: Object.keys(rpcPool).length,
    sourceLockboxConsumerRows: rows.filter((row) => row.sourceLockboxConsumer).length,
    remoteSyntheticConsumerRows: rows.filter((row) => row.remoteSyntheticConsumer).length,
    valueBearingOnlyRows: rows.filter((row) => row.live.valueBearingOnly || row.live.wstEthLike).length,
    erc4626LikeRows: rows.filter((row) => row.live.erc4626Like).length,
    rebaseStandardRows: rows.filter((row) => row.live.rebaseStandard).length,
    concreteMismatchRows: rows.filter((row) => row.concreteMismatch).length,
    materialMismatchRows: rows.filter((row) => row.materialMismatch).length,
    exactEconomicsRows: 0,
    forkProofRows: 0,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    blocker: "No material consumer accepts a live over-credited wrapped/synthetic bridge token with proven balance-delta mismatch.",
  };
  const out = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-bridge-delta-preflight.js",
    scope: "Focused read-only balance-delta/backing preflight over top bridge non-lossless collateral joins",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      signedActionJustified: false,
    },
    thresholds: {
      topRows: TOP_ROWS,
      materialUsd: MATERIAL_USD,
      routePositiveRequires: [
        "live nominal-vs-balance-delta or locked-vs-remote-supply mismatch",
        "mismatched wrapped/synthetic token accepted by a material consumer",
        "exact positive borrow/redeem/liquidation/exit economics",
        "fork/local proof of net value extraction",
      ],
    },
    sourceArtifacts: [rel(JOIN_FILE), rel(HYPERLANE_FILE)],
    summary,
    routeStates: Object.values(routeStateById),
    routeProbeRows,
    rows,
    routePositiveRows: [],
    blockers: [
      "Top material joins are source-chain collateral/lockbox-token consumers, not remote wrapped/synthetic consumer exposure.",
      "Value-bearing token labels are not transfer-loss or balance-delta proof.",
      "No row has exact positive borrow/exit economics or fork/local proof.",
    ],
    requiredForRoutePositive: [
      "bridge path credits or releases nominal amount above observed received/burned/locked balance",
      "the over-credited wrapped/synthetic token is accepted by a material consumer",
      "consumer state permits permissionless value extraction",
      "exact acquisition and exit economics are positive after gas/slippage/fees",
      "fork/local proof demonstrates extractable net profit",
    ],
    nextReadOnlyStep: "Search for wrapped/synthetic bridge legs accepted by consumers; skip lockbox-only matches unless a live bridge backing deficit appears.",
  };
  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(out, null, 2)}\n`);
  fs.writeFileSync(REPORT_OUT, report(out));
  if (!QUIET) {
    console.log(`Wrote ${rel(RAW_OUT)}`);
    console.log(`uniqueJoinRows=${summary.uniqueJoinRows} concreteMismatchRows=${summary.concreteMismatchRows} routePositive=0 executableNow=0 signedActionJustified=false`);
  }
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
