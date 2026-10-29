#!/usr/bin/env node
// prove-morpho-wrapper-exit-blockers.js - read-only wrapper exit proof-gap audit for current Morpho liquidations.
// Resolves RPC in memory only. Never stores RPC URLs, keys, calldata for execution, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("./node_modules/ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "morpho-wrapper-exit-proof-gaps.json");
const INPUTS = {
  e9Salvage: path.join(WORKSPACE, "reports", "raw", "fast", "e9-liquidation-salvage-routes.json"),
  morphoHighApy: path.join(WORKSPACE, "reports", "raw", "fast", "morpho-high-apy-liquidation-routes.json"),
  currentLiquidatable: path.join(WORKSPACE, "reports", "raw", "fast", "current-liquidatable-exit-routes.json"),
  marketability: path.join(WORKSPACE, "reports", "raw", "fast", "morpho-liquidatable-marketability.json"),
};
const QUIET = process.argv.includes("--quiet");
const ZERO = ethers.ZeroAddress;

const ERC20 = new ethers.Interface([
  "function asset() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function maxRedeem(address owner) view returns (uint256)",
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "function symbol() view returns (string)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);
const WRAPPER_MANAGER = new ethers.Interface([
  "function manager() view returns (address)",
  "function maxRedeemCap(address yToken) view returns (uint256)",
  "function withdrawAssets(address yToken,address asset) view returns (bool)",
]);

function readJson(file, fallback = {}) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function rel(file) {
  return path.relative(WORKSPACE, file).replace(/\\/g, "/");
}

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function normalizeAddress(value) {
  try { return ethers.getAddress(value); } catch (_) { return null; }
}

function lowerAddress(value) {
  const addr = normalizeAddress(value);
  return addr ? addr.toLowerCase() : null;
}

function sameAddress(a, b) {
  const aa = lowerAddress(a);
  const bb = lowerAddress(b);
  return Boolean(aa && bb && aa === bb);
}

function toBigInt(value, fallback = 0n) {
  try {
    if (value === null || value === undefined || value === "") return fallback;
    return BigInt(value);
  } catch (_) {
    return fallback;
  }
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value ? 1 : 0;
  const n = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 6) {
  const n = asNumber(value);
  if (n === null) return null;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function loadRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function rpcCall(url, method, params = [], timeoutMs = 8000) {
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
    if (json.error) throw new Error(json.error.message || "rpc error");
    return json.result ?? null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveEthereumRpc() {
  for (const url of loadRpcUrls()) {
    try {
      if (Number(BigInt(await rpcCall(url, "eth_chainId", [], 6000))) === 1) return url;
    } catch (_) {
      // Do not print or persist RPC URLs.
    }
  }
  return null;
}

async function safeCall(provider, to, iface, fn, args = []) {
  try {
    const target = normalizeAddress(to);
    if (!target) return null;
    const raw = await provider.call({ to: target, data: iface.encodeFunctionData(fn, args) });
    return iface.decodeFunctionResult(fn, raw)[0];
  } catch (_) {
    return null;
  }
}

function rawFromQuote(row) {
  const quote = row?.quote || {};
  return {
    repayRaw: quote.repayAssetsRaw || quote.repaidAssetsRaw || null,
    seizedRaw: quote.seizedCollateralRaw || null,
  };
}

function bestSize(row) {
  const sizes = Array.isArray(row?.sizeResults) ? row.sizeResults : [];
  return sizes
    .filter((size) => !size.seizedExceedsCollateral && toBigInt(size.seizedCollateralRaw, 0n) > 0n)
    .sort((a, b) => (toBigInt(b.seizedCollateralRaw, 0n) > toBigInt(a.seizedCollateralRaw, 0n) ? 1 : -1))[0]
    || row?.best
    || sizes[0]
    || null;
}

function bestNetFromRow(row) {
  const direct = asNumber(row?.quote?.bestNetUsd ?? row?.quote?.bestNetProfitUsd ?? row?.bestNetUsd ?? row?.bestNetProfitUsd);
  const fromSizes = [];
  for (const size of row?.sizeResults || []) {
    for (const quote of size?.quotes || []) fromSizes.push(asNumber(quote.netProfitUsd));
  }
  const values = [direct, ...fromSizes].filter((v) => v !== null);
  return values.length ? Math.max(...values) : null;
}

function rawContext(row) {
  const quoteRaw = rawFromQuote(row);
  const size = bestSize(row);
  return {
    repayRaw: quoteRaw.repayRaw || size?.repaidAssetsRaw || size?.repayAssetsRaw || null,
    seizedRaw: quoteRaw.seizedRaw || size?.seizedCollateralRaw || row?.sizeContext?.seizedCollateralRaw || null,
  };
}

function sourceRow(row, source) {
  const raw = rawContext(row);
  return {
    source,
    marketId: row.marketId || null,
    borrower: row.borrower || row.user || null,
    pair: row.pair || null,
    healthFactor: round(row.healthFactor, 6),
    debtUsd: round(row.debtUsd ?? row.graph?.borrowAssetsUsd, 6),
    collateralUsd: round(row.collateralUsd ?? row.graph?.collateralUsd, 6),
    loanAsset: row.loanAsset || null,
    collateral: row.collateral || null,
    repayRaw: raw.repayRaw,
    seizedRaw: raw.seizedRaw,
    bestNetUsd: bestNetFromRow(row),
    currentLiquidatable: row.currentLiquidatable !== false && (asNumber(row.healthFactor) ?? 2) < 1,
  };
}

function addCandidate(map, row) {
  const collateral = normalizeAddress(row.collateral?.address);
  const loan = normalizeAddress(row.loanAsset?.address);
  if (!collateral || !loan || !row.currentLiquidatable) return;
  const key = `${String(row.marketId || "").toLowerCase()}:${String(row.borrower || "").toLowerCase()}:${collateral.toLowerCase()}:${loan.toLowerCase()}`;
  const existing = map.get(key) || {
    marketId: row.marketId,
    borrower: row.borrower,
    pair: row.pair,
    collateral: { ...row.collateral, address: collateral },
    loanAsset: { ...row.loanAsset, address: loan },
    healthFactor: row.healthFactor,
    debtUsd: row.debtUsd,
    collateralUsd: row.collateralUsd,
    maxSeizedRaw: "0",
    repayRawForMaxSeized: null,
    bestResearchNetUsd: null,
    sources: [],
  };
  existing.sources.push({ source: row.source, seizedRaw: row.seizedRaw, repayRaw: row.repayRaw, bestNetUsd: row.bestNetUsd });
  if ((asNumber(row.debtUsd) || 0) > (asNumber(existing.debtUsd) || 0)) existing.debtUsd = row.debtUsd;
  if ((asNumber(row.collateralUsd) || 0) > (asNumber(existing.collateralUsd) || 0)) existing.collateralUsd = row.collateralUsd;
  if ((asNumber(row.bestNetUsd) ?? -Infinity) > (asNumber(existing.bestResearchNetUsd) ?? -Infinity)) existing.bestResearchNetUsd = row.bestNetUsd;
  const seized = toBigInt(row.seizedRaw, 0n);
  if (seized > toBigInt(existing.maxSeizedRaw, 0n)) {
    existing.maxSeizedRaw = seized.toString();
    existing.repayRawForMaxSeized = row.repayRaw || null;
  }
  map.set(key, existing);
}

function collectCandidates(inputs) {
  const map = new Map();
  for (const row of inputs.e9Salvage?.results || []) addCandidate(map, sourceRow(row, "e9-salvage"));
  for (const row of inputs.morphoHighApy?.results || []) addCandidate(map, sourceRow(row, "morpho-high-apy"));
  for (const row of inputs.currentLiquidatable?.topRows || []) addCandidate(map, sourceRow(row, "current-liquidatable-ranker"));
  for (const row of inputs.marketability?.topRows || []) addCandidate(map, sourceRow(row, "morpho-marketability"));
  return [...map.values()];
}

async function probeCandidate(provider, candidate) {
  const wrapper = normalizeAddress(candidate.collateral?.address);
  const loan = normalizeAddress(candidate.loanAsset?.address);
  const seizedRaw = toBigInt(candidate.maxSeizedRaw, 0n);
  const probeShares = seizedRaw > 0n ? seizedRaw : 1n;

  const [assetRaw, totalSupplyRaw, totalAssetsRaw, previewRaw, convertRaw, maxRedeemZeroRaw] = await Promise.all([
    safeCall(provider, wrapper, ERC20, "asset"),
    safeCall(provider, wrapper, ERC20, "totalSupply"),
    safeCall(provider, wrapper, ERC20, "totalAssets"),
    safeCall(provider, wrapper, ERC20, "previewRedeem", [probeShares]),
    safeCall(provider, wrapper, ERC20, "convertToAssets", [probeShares]),
    safeCall(provider, wrapper, ERC20, "maxRedeem", [ZERO]),
  ]);
  const asset = normalizeAddress(assetRaw);
  let assetSymbol = null;
  let assetDecimals = null;
  if (asset) {
    assetSymbol = await safeCall(provider, asset, ERC20, "symbol").then((v) => typeof v === "string" ? v : null);
    assetDecimals = await safeCall(provider, asset, ERC20, "decimals").then((v) => v === null ? null : Number(v));
  }

  const manager = normalizeAddress(await safeCall(provider, wrapper, WRAPPER_MANAGER, "manager"));
  let managerProof = null;
  if (manager && asset) {
    const [withdrawEnabled, maxRedeemCapRaw, managerAssetBalanceRaw, wrapperAssetBalanceRaw] = await Promise.all([
      safeCall(provider, manager, WRAPPER_MANAGER, "withdrawAssets", [wrapper, asset]),
      safeCall(provider, manager, WRAPPER_MANAGER, "maxRedeemCap", [wrapper]),
      safeCall(provider, asset, ERC20, "balanceOf", [manager]),
      safeCall(provider, asset, ERC20, "balanceOf", [wrapper]),
    ]);
    const maxRedeemCap = toBigInt(maxRedeemCapRaw, 0n);
    const managerLiquidity = toBigInt(managerAssetBalanceRaw, 0n);
    const wrapperLiquidity = toBigInt(wrapperAssetBalanceRaw, 0n);
    const totalInstantLiquidity = managerLiquidity + wrapperLiquidity;
    const preview = toBigInt(previewRaw, 0n);
    managerProof = {
      manager,
      withdrawAssetEnabled: Boolean(withdrawEnabled),
      maxRedeemCapRaw: maxRedeemCap.toString(),
      managerAssetBalanceRaw: managerLiquidity.toString(),
      wrapperAssetBalanceRaw: wrapperLiquidity.toString(),
      totalInstantLiquidityRaw: totalInstantLiquidity.toString(),
      capCoversProbeShares: seizedRaw > 0n && maxRedeemCap >= seizedRaw,
      liquidityCoversPreviewAssets: preview > 0n && totalInstantLiquidity >= preview,
      instantCapacitySufficient: Boolean(withdrawEnabled && seizedRaw > 0n && preview > 0n && maxRedeemCap >= seizedRaw && totalInstantLiquidity >= preview),
    };
  }

  const preview = toBigInt(previewRaw, 0n);
  const repay = toBigInt(candidate.repayRawForMaxSeized, 0n);
  const directLoanAsset = Boolean(asset && loan && sameAddress(asset, loan));
  const positivePreviewAgainstRepay = Boolean(directLoanAsset && preview > 0n && repay > 0n && preview > repay);
  const blockers = [];
  if (!asset) blockers.push("Collateral did not expose ERC4626 asset()");
  if (seizedRaw <= 0n) blockers.push("No exact seized collateral size available for the current row");
  if (asset && !directLoanAsset) blockers.push("Wrapper asset is not the loan token; exact DEX tail is still required");
  if (directLoanAsset && repay > 0n && preview <= repay) blockers.push("previewRedeem output does not cover repay amount before gas/slippage");
  if (!manager) blockers.push("No wrapper manager cap/liquidity proof surface was detected");
  if (managerProof) {
    if (!managerProof.withdrawAssetEnabled) blockers.push("Wrapper manager does not enable the wrapper asset for withdrawal");
    if (toBigInt(managerProof.maxRedeemCapRaw, 0n) <= 0n) blockers.push("Wrapper manager instant redeem cap is zero");
    else if (!managerProof.capCoversProbeShares) blockers.push("Wrapper manager instant redeem cap is below probed seized shares");
    if (toBigInt(managerProof.totalInstantLiquidityRaw, 0n) <= 0n) blockers.push("Wrapper manager/wrapper instant asset liquidity is zero");
    else if (!managerProof.liquidityCoversPreviewAssets) blockers.push("Wrapper manager/wrapper instant asset liquidity is below previewRedeem output");
  }
  blockers.push("No fork/static trace proves same-block asset transfer from seized collateral", "Signed action remains fail-closed");

  return {
    marketId: candidate.marketId,
    borrower: candidate.borrower,
    pair: candidate.pair,
    healthFactor: candidate.healthFactor,
    debtUsd: candidate.debtUsd,
    collateralUsd: candidate.collateralUsd,
    loanAsset: candidate.loanAsset,
    collateral: candidate.collateral,
    sources: candidate.sources,
    maxSeizedRaw: candidate.maxSeizedRaw,
    repayRawForMaxSeized: candidate.repayRawForMaxSeized,
    bestResearchNetUsd: round(candidate.bestResearchNetUsd, 6),
    wrapperProbe: {
      erc4626Like: Boolean(asset),
      asset,
      assetSymbol,
      assetDecimals,
      directLoanAsset,
      totalSupplyRaw: totalSupplyRaw?.toString?.() || null,
      totalAssetsRaw: totalAssetsRaw?.toString?.() || null,
      previewRedeemRaw: previewRaw?.toString?.() || null,
      convertToAssetsRaw: convertRaw?.toString?.() || null,
      maxRedeemZeroRaw: maxRedeemZeroRaw?.toString?.() || null,
      positivePreviewAgainstRepay,
    },
    managerProof,
    sameBlockAssetTransferCapacity: Boolean(managerProof?.instantCapacitySufficient && directLoanAsset && positivePreviewAgainstRepay),
    sameBlockAssetTransferProven: false,
    routePositive: false,
    executableNow: false,
    signedActionJustified: false,
    blockers,
  };
}

async function main() {
  const inputs = Object.fromEntries(Object.entries(INPUTS).map(([key, file]) => [key, readJson(file, {})]));
  const rpc = await resolveEthereumRpc();
  if (!rpc) throw new Error("missing ethereum rpc");
  const provider = new ethers.JsonRpcProvider(rpc, 1, { staticNetwork: true });
  const candidates = collectCandidates(inputs);
  const rows = [];
  for (const candidate of candidates) rows.push(await probeCandidate(provider, candidate));
  rows.sort((a, b) => Number(b.sameBlockAssetTransferCapacity) - Number(a.sameBlockAssetTransferCapacity)
    || (asNumber(b.bestResearchNetUsd) ?? -Infinity) - (asNumber(a.bestResearchNetUsd) ?? -Infinity)
    || (asNumber(b.debtUsd) || 0) - (asNumber(a.debtUsd) || 0));

  const wrapperRows = rows.filter((row) => row.wrapperProbe.erc4626Like);
  const managerRows = rows.filter((row) => row.managerProof);
  const managerBlockedRows = managerRows.filter((row) => row.managerProof && !row.managerProof.instantCapacitySufficient);
  const capacityRows = rows.filter((row) => row.sameBlockAssetTransferCapacity);
  const directRows = rows.filter((row) => row.wrapperProbe.directLoanAsset);
  const positivePreviewRows = rows.filter((row) => row.wrapperProbe.positivePreviewAgainstRepay);
  const best = rows.find((row) => asNumber(row.bestResearchNetUsd) !== null) || null;
  const output = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/prove-morpho-wrapper-exit-blockers.js",
    scope: "Read-only wrapper/non-DEX exact-exit proof-gap audit for currently liquidatable Morpho rows",
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
    sourceArtifacts: Object.fromEntries(Object.entries(INPUTS).map(([key, file]) => [key, rel(file)])),
    sourceGeneratedAt: Object.fromEntries(Object.entries(inputs).map(([key, artifact]) => [key, artifact.generatedAt || artifact.scannedAt || null])),
    summary: {
      rowsInput: candidates.length,
      rowsProbed: rows.length,
      wrapperLikeRows: wrapperRows.length,
      directLoanAssetRows: directRows.length,
      positivePreviewRows: positivePreviewRows.length,
      managerRows: managerRows.length,
      managerBlockedRows: managerBlockedRows.length,
      instantCapacityRows: capacityRows.length,
      sameBlockAssetTransferProvenRows: 0,
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      bestResearchNetUsd: round(best?.bestResearchNetUsd, 6),
      bestPair: best?.pair || null,
      blocker: "Wrapper exits remain preview/cap/liquidity/fork-proof blocked; no same-block asset transfer is proven",
      status: capacityRows.length ? "wrapper-capacity-needs-fork-transfer-proof" : "wrapper-exit-blocked-no-instant-capacity",
    },
    rows,
    requiredForRoutePositive: [
      "current Morpho borrower remains liquidatable on-chain",
      "non-overseizing seized collateral size is exact",
      "wrapper asset is the loan token or has exact positive DEX tail",
      "instant redeem cap and asset liquidity cover seized shares and preview assets",
      "same-block asset transfer is proven by fork/static trace, not previewRedeem alone",
      "net remains positive after gas/slippage/flash fees",
      "fork extraction proof before any signed action",
    ],
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(output, jsonReplacer, 2)}\n`);
  if (!QUIET) {
    console.log(`Morpho wrapper exit proof gaps: rows=${output.summary.rowsProbed} wrappers=${output.summary.wrapperLikeRows} capacity=${output.summary.instantCapacityRows} proven=${output.summary.sameBlockAssetTransferProvenRows} routePositive=${output.summary.routePositive}`);
    console.log(`Report: ${rel(OUT)}`);
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exitCode = 1;
});
