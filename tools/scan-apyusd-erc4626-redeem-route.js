#!/usr/bin/env node
// Read-only exact-quote scorer for the apyUSD buy-market -> UnlockReceipt claim route.
// RPC URLs are resolved in memory only and never printed or written.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const TRIAGE_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "current-profit-lead-triage.json");
const OUT_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "apyusd-erc4626-redeem-route.json");
const FORK_PROOF_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "apyusd-erc4626-fork-proof.json");

const CHAIN_ID = 1;
const SHARE = "0x38EEb52F0771140d10c4E9A9a72349A329Fe8a6A"; // apyUSD
const ASSET = "0x98A878b1Cd98131B271883B390f68D2c90674665"; // apxUSD
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const PROBE_RECEIVER = "0x000000000000000000000000000000000000dEaD";
const WAD = 10n ** 18n;
const FALLBACK_CURVE_POOLS = [
  {
    dexId: "curve",
    pairAddress: "0xe41be7B340f7c2EDA4DA1e99b42Ee1b228b526b7",
    liquidityUsd: null,
    baseToken: { address: SHARE },
    quoteToken: { address: ASSET },
    source: "static-apyusd-apxusd-curve-pool",
  },
];
const TRADE_SIZES_USD = (process.env.APYUSD_ROUTE_SIZES_USD || "100,1000,5000,10000,25000")
  .split(",")
  .map((x) => Number(x.trim()))
  .filter((x) => Number.isFinite(x) && x > 0);
const GAS_UNITS = Number(process.env.APYUSD_ROUTE_GAS_UNITS || "550000");
const SLIPPAGE_BUFFER_BPS = Number(process.env.APYUSD_ROUTE_SLIPPAGE_BPS || "50");
const MIN_NET_PROFIT_USD = Number(process.env.APYUSD_ROUTE_MIN_NET_USD || "25");
const CLAIM_DELAYS_DAYS = (process.env.APYUSD_CLAIM_DELAYS_DAYS || "3,4,7,20")
  .split(",")
  .map((x) => Number(x.trim()))
  .filter((x) => Number.isFinite(x) && x >= 0);
const TIMEOUT_MS = 15_000;

const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
]);
const ERC4626 = new ethers.Interface([
  "function asset() view returns (address)",
  "function receipt() view returns (address)",
  "function unlockingFee() view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function convertToShares(uint256 assets) view returns (uint256)",
  "function maxDeposit(address owner) view returns (uint256)",
  "function maxMint(address owner) view returns (uint256)",
  "function maxRedeem(address owner) view returns (uint256)",
  "function maxWithdraw(address owner) view returns (uint256)",
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "function previewWithdraw(uint256 assets) view returns (uint256)",
  "function redeem(uint256 shares,address receiver,address owner) returns (uint256)",
  "function withdraw(uint256 assets,address receiver,address owner) returns (uint256)",
]);
const UNLOCK_RECEIPT = new ethers.Interface([
  "function paused() view returns (bool)",
  "function feeCurve() view returns (tuple(uint256 minFee,uint256 maxFee,uint48 minDuration,uint48 maxDuration,uint256 curvature))",
]);
const CURVE_UINT = new ethers.Interface([
  "function coins(uint256) view returns (address)",
  "function balances(uint256) view returns (uint256)",
  "function get_dy(uint256 i,uint256 j,uint256 dx) view returns (uint256)",
]);
const CURVE_INT = new ethers.Interface([
  "function get_dy(int128 i,int128 j,uint256 dx) view returns (uint256)",
]);
const KNOWN_ERROR_IFACE = new ethers.Interface([
  "error ERC4626ExceededMaxRedeem(address,uint256,uint256)",
  "error ERC4626ExceededMaxWithdraw(address,uint256,uint256)",
  "error ERC20InsufficientBalance(address,uint256,uint256)",
  "error ERC20InsufficientAllowance(address,uint256,uint256)",
  "error ERC20InvalidSender(address)",
  "error ERC20InvalidReceiver(address)",
  "error ERC20InvalidApprover(address)",
  "error ERC20InvalidSpender(address)",
  "error ERC721InvalidReceiver(address)",
  "error ERC721InvalidSender(address)",
  "error InvalidCaller()",
  "error SafeERC20FailedOperation(address)",
  "error EnforcedPause()",
  "error ExpectedPause()",
  "error ReentrancyGuardReentrantCall()",
  "error OwnableUnauthorizedAccount(address)",
]);

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function normalizeAddress(value) {
  try { return ethers.getAddress(value); } catch (_) { return null; }
}

function sameAddress(a, b) {
  const aa = normalizeAddress(a);
  const bb = normalizeAddress(b);
  return Boolean(aa && bb && aa.toLowerCase() === bb.toLowerCase());
}

function sanitize(text) {
  return String(text || "").replace(/https?:\/\/\S+/g, "[redacted-url]").slice(0, 240);
}

function extractRevertData(value, depth = 0) {
  if (!value || depth > 5) return null;
  if (typeof value === "string" && /^0x[0-9a-fA-F]{8,}/.test(value)) return value;
  if (typeof value !== "object") return null;
  for (const key of ["data", "error", "info", "body", "response"]) {
    const found = extractRevertData(value[key], depth + 1);
    if (found) return found;
  }
  return null;
}

function decodeRevertData(data) {
  if (!data || !/^0x[0-9a-fA-F]{8,}/.test(data)) return null;
  const selector = data.slice(0, 10).toLowerCase();
  if (selector === "0x08c379a0") {
    try {
      const [reason] = ethers.AbiCoder.defaultAbiCoder().decode(["string"], `0x${data.slice(10)}`);
      return { selector, name: "Error", signature: "Error(string)", args: [sanitize(reason)] };
    } catch (_) {
      return { selector, name: "Error", signature: "Error(string)", args: [] };
    }
  }
  if (selector === "0x4e487b71") {
    try {
      const [code] = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], `0x${data.slice(10)}`);
      return { selector, name: "Panic", signature: "Panic(uint256)", args: [code.toString()] };
    } catch (_) {
      return { selector, name: "Panic", signature: "Panic(uint256)", args: [] };
    }
  }
  try {
    const parsed = KNOWN_ERROR_IFACE.parseError(data);
    return { selector, name: parsed.name, signature: parsed.signature, args: parsed.args.map((arg) => typeof arg === "bigint" ? arg.toString() : String(arg)) };
  } catch (_) {
    return { selector, name: null, signature: null, args: [] };
  }
}

function loadRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  const text = fs.readFileSync(RPC_FILE, "utf8");
  return [...text.matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function rpcCall(url, method, params = [], timeoutMs = TIMEOUT_MS) {
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
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveRpcUrl(chainId) {
  for (const url of loadRpcUrls()) {
    try {
      const got = await rpcCall(url, "eth_chainId", [], 5000);
      if (Number(BigInt(got)) === chainId) return url;
    } catch (_) {
      // Try next endpoint; never print URLs.
    }
  }
  return null;
}

async function safeCall(provider, to, iface, name, args = []) {
  try {
    const raw = await provider.call({ to, data: iface.encodeFunctionData(name, args) });
    return { ok: true, value: iface.decodeFunctionResult(name, raw), raw, error: null };
  } catch (err) {
    return { ok: false, value: null, raw: null, error: sanitize(err?.shortMessage || err?.message || err) };
  }
}

async function safeEthCall(provider, tx) {
  try {
    const raw = await provider.call(tx);
    return { ok: true, raw, error: null, revert: null };
  } catch (err) {
    const data = extractRevertData(err);
    return { ok: false, raw: null, error: sanitize(err?.shortMessage || err?.message || err), revert: decodeRevertData(data) };
  }
}

function formatAmount(raw, decimals) {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  try { return Number(ethers.formatUnits(raw, decimals)); } catch (_) { return null; }
}

function parseAmount(value, decimals) {
  const safe = Math.max(0, Number(value) || 0);
  return ethers.parseUnits(safe.toFixed(Math.min(Number(decimals) || 18, 18)), decimals);
}

function round(value, decimals = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const p = 10 ** decimals;
  return Math.round(n * p) / p;
}

function revertLabel(revert) {
  if (!revert) return null;
  const base = revert.signature || revert.name || revert.selector || null;
  if (!base) return null;
  const args = Array.isArray(revert.args) && revert.args.length ? ` args=${revert.args.join(",")}` : "";
  return `${base}${args}`;
}

async function fetchPrice(address) {
  const normalized = normalizeAddress(address);
  if (!normalized) return null;
  try {
    const res = await fetch(`https://coins.llama.fi/prices/current/ethereum:${normalized}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    const json = await res.json();
    return Number(json?.coins?.[`ethereum:${normalized}`]?.price) || null;
  } catch (_) {
    return null;
  }
}

async function curveCoins(provider, pool) {
  const out = [];
  for (let i = 0; i < 8; i++) {
    const coin = await safeCall(provider, pool, CURVE_UINT, "coins", [BigInt(i)]);
    if (!coin.ok) break;
    const addr = normalizeAddress(coin.value[0]);
    if (!addr) break;
    out.push(addr);
  }
  return out;
}

async function curveQuote(provider, pool, i, j, amountInRaw) {
  const uintQuote = await safeCall(provider, pool, CURVE_UINT, "get_dy", [BigInt(i), BigInt(j), amountInRaw]);
  if (uintQuote.ok) return { ok: true, amountOutRaw: uintQuote.value[0], abi: "uint256" };
  const intQuote = await safeCall(provider, pool, CURVE_INT, "get_dy", [BigInt(i), BigInt(j), amountInRaw]);
  if (intQuote.ok) return { ok: true, amountOutRaw: intQuote.value[0], abi: "int128" };
  return { ok: false, amountOutRaw: 0n, error: uintQuote.error || intQuote.error || "quote failed" };
}

async function redeemabilityProbe(provider, holder, receiver, shareDecimals, assetDecimals) {
  const [shareBalanceCall, maxRedeemCall, maxWithdrawCall] = await Promise.all([
    safeCall(provider, SHARE, ERC20, "balanceOf", [holder]),
    safeCall(provider, SHARE, ERC4626, "maxRedeem", [holder]),
    safeCall(provider, SHARE, ERC4626, "maxWithdraw", [holder]),
  ]);
  const shareBalanceRaw = shareBalanceCall.ok ? shareBalanceCall.value[0] : 0n;
  const maxRedeemRaw = maxRedeemCall.ok ? maxRedeemCall.value[0] : 0n;
  const maxWithdrawRaw = maxWithdrawCall.ok ? maxWithdrawCall.value[0] : 0n;
  const oneShare = 10n ** BigInt(shareDecimals);
  const probeSharesRaw = [shareBalanceRaw, maxRedeemRaw, oneShare].reduce((min, value) => value < min ? value : min);
  const previewRedeemCall = probeSharesRaw > 0n ? await safeCall(provider, SHARE, ERC4626, "previewRedeem", [probeSharesRaw]) : { ok: false, value: null, error: "no redeemable shares" };
  const redeemCall = probeSharesRaw > 0n ? await safeEthCall(provider, {
    from: holder,
    to: SHARE,
    data: ERC4626.encodeFunctionData("redeem", [probeSharesRaw, receiver, holder]),
  }) : { ok: false, error: "no redeemable shares", revert: null };
  const probeWithdrawRaw = previewRedeemCall.ok && previewRedeemCall.value[0] > 0n
    ? (previewRedeemCall.value[0] < maxWithdrawRaw ? previewRedeemCall.value[0] : maxWithdrawRaw)
    : 0n;
  const previewWithdrawCall = probeWithdrawRaw > 0n ? await safeCall(provider, SHARE, ERC4626, "previewWithdraw", [probeWithdrawRaw]) : { ok: false, value: null, error: "no withdrawable assets" };
  const withdrawCall = probeWithdrawRaw > 0n ? await safeEthCall(provider, {
    from: holder,
    to: SHARE,
    data: ERC4626.encodeFunctionData("withdraw", [probeWithdrawRaw, receiver, holder]),
  }) : { ok: false, error: "no withdrawable assets", revert: null };
  return {
    holder,
    receiver,
    shareBalance: ethers.formatUnits(shareBalanceRaw, shareDecimals),
    maxRedeem: ethers.formatUnits(maxRedeemRaw, shareDecimals),
    maxWithdraw: ethers.formatUnits(maxWithdrawRaw, assetDecimals),
    probeShares: ethers.formatUnits(probeSharesRaw, shareDecimals),
    previewRedeemAssets: previewRedeemCall.ok ? ethers.formatUnits(previewRedeemCall.value[0], assetDecimals) : null,
    redeem: { ok: redeemCall.ok, error: redeemCall.error, revert: redeemCall.revert },
    probeWithdrawAssets: ethers.formatUnits(probeWithdrawRaw, assetDecimals),
    previewWithdrawShares: previewWithdrawCall.ok ? ethers.formatUnits(previewWithdrawCall.value[0], shareDecimals) : null,
    withdraw: { ok: withdrawCall.ok, error: withdrawCall.error, revert: withdrawCall.revert },
  };
}

function findCandidateFromTriage() {
  if (!fs.existsSync(TRIAGE_FILE)) return null;
  const triage = JSON.parse(fs.readFileSync(TRIAGE_FILE, "utf8"));
  for (const lead of triage.leads || []) {
    for (const token of lead.tokenAssessments || []) {
      if (sameAddress(token.address, SHARE) && token.erc4626?.routeHint?.type === "buy-market-redeem-share") {
        return { lead, token };
      }
    }
  }
  return null;
}

function candidateCurvePairs(candidate) {
  const fromTriage = (candidate?.token?.topDexPairs || [])
    .filter((p) => String(p.dexId || "").toLowerCase().includes("curve"))
    .filter((p) => sameAddress(p.baseToken?.address, SHARE) || sameAddress(p.quoteToken?.address, SHARE));
  const seen = new Set();
  const out = [];
  for (const pair of [...fromTriage, ...FALLBACK_CURVE_POOLS]) {
    const pool = normalizeAddress(pair.pairAddress);
    if (!pool || seen.has(pool.toLowerCase())) continue;
    seen.add(pool.toLowerCase());
    out.push(pair);
  }
  return out;
}

function loadForkProofStatus() {
  if (!fs.existsSync(FORK_PROOF_FILE)) return null;
  try {
    const proof = JSON.parse(fs.readFileSync(FORK_PROOF_FILE, "utf8"));
    if (proof?.result?.forkProfitPositive === true) return { status: "fork-positive", proof };
    if (proof?.result?.success === false || proof?.result?.forkProfitPositive === false) return { status: "fork-negative", proof };
    return { status: "unknown", proof };
  } catch (_) {
    return null;
  }
}

function gasCostUsd(gasPriceWei, ethPriceUsd) {
  const gasPrice = Number(gasPriceWei || 0n);
  if (!Number.isFinite(gasPrice) || !Number.isFinite(ethPriceUsd)) return null;
  return GAS_UNITS * gasPrice / 1e18 * ethPriceUsd;
}

function decodeFeeCurve(call) {
  if (!call?.ok) return null;
  const curve = call.value[0];
  if (!curve) return null;
  return {
    minFee: BigInt(curve[0]),
    maxFee: BigInt(curve[1]),
    minDuration: BigInt(curve[2]),
    maxDuration: BigInt(curve[3]),
    curvature: BigInt(curve[4]),
  };
}

function formatFeeCurve(curve) {
  if (!curve) return null;
  return {
    minFee: curve.minFee.toString(),
    maxFee: curve.maxFee.toString(),
    minDuration: curve.minDuration.toString(),
    maxDuration: curve.maxDuration.toString(),
    curvature: curve.curvature.toString(),
  };
}

function feeRateAtDelay(curve, delaySeconds) {
  if (!curve) return null;
  const elapsed = BigInt(Math.max(0, Math.round(delaySeconds)));
  if (elapsed >= curve.maxDuration) return curve.minFee;
  if (elapsed <= curve.minDuration) return curve.maxFee;
  const span = curve.maxDuration - curve.minDuration;
  if (span <= 0n) return curve.maxFee;
  const tHat = ((elapsed - curve.minDuration) * WAD) / span;
  let tHatPowK;
  if (curve.curvature === WAD) {
    tHatPowK = tHat;
  } else if (curve.curvature === 2n * WAD) {
    tHatPowK = (tHat * tHat) / WAD;
  } else {
    // Conservative fallback for non-live curvature values not needed by current apyUSD state.
    tHatPowK = 0n;
  }
  const delta = curve.maxFee > curve.minFee ? curve.maxFee - curve.minFee : 0n;
  return curve.maxFee - ((delta * tHatPowK) / WAD);
}

function feeOnAssetsRaw(assetsRaw, feeRateRaw) {
  if (!feeRateRaw || feeRateRaw <= 0n) return 0n;
  return (assetsRaw * feeRateRaw + WAD - 1n) / WAD;
}

function receiptClaimScenarios(assetsRaw, curve, assetDecimals, assetPriceUsd, inputUsd, gasUsd) {
  if (!curve || !assetPriceUsd) return [];
  return CLAIM_DELAYS_DAYS.map((delayDays) => {
    const delaySeconds = Math.round(delayDays * 86400);
    const feeRateRaw = feeRateAtDelay(curve, delaySeconds);
    const feeRaw = feeOnAssetsRaw(assetsRaw, feeRateRaw);
    const claimRaw = assetsRaw > feeRaw ? assetsRaw - feeRaw : 0n;
    const claimOutputUsd = formatAmount(claimRaw, assetDecimals) * assetPriceUsd;
    const receiptFeeUsd = formatAmount(feeRaw, assetDecimals) * assetPriceUsd;
    const slippageUsd = claimOutputUsd * SLIPPAGE_BUFFER_BPS / 10_000;
    const netUsd = claimOutputUsd - inputUsd - (gasUsd || 0) - slippageUsd;
    return {
      delayDays,
      delaySeconds,
      feeRateBps: round(Number(feeRateRaw || 0n) / 1e14, 6),
      receiptFeeAssets: round(formatAmount(feeRaw, assetDecimals), 10),
      receiptFeeUsd: round(receiptFeeUsd, 6),
      claimAssetsOut: round(formatAmount(claimRaw, assetDecimals), 10),
      claimOutputUsd: round(claimOutputUsd, 6),
      gasUsd: round(gasUsd, 6),
      slippageUsd: round(slippageUsd, 6),
      netUsd: round(netUsd, 6),
    };
  }).sort((a, b) => (Number(b.netUsd) || -Infinity) - (Number(a.netUsd) || -Infinity));
}

async function main() {
  const candidate = findCandidateFromTriage();
  const forkProofStatus = loadForkProofStatus();
  const forkProofPositive = forkProofStatus?.status === "fork-positive";
  const forkProofNegative = forkProofStatus?.status === "fork-negative";
  const forkFailureLabels = [
    revertLabel(forkProofStatus?.proof?.result?.redeemRevert),
    revertLabel(forkProofStatus?.proof?.result?.withdrawRevert),
    ...(forkProofStatus?.proof?.result?.claimScenarios || []).map((x) => revertLabel(x.claimRevert)).filter(Boolean),
  ].filter(Boolean);
  const rpc = await resolveRpcUrl(CHAIN_ID);
  if (!rpc) throw new Error("No Ethereum RPC resolved from inventory");
  const provider = new ethers.JsonRpcProvider(rpc, CHAIN_ID);

  const [block, gasPrice, ethPrice, assetPriceLive, sharePriceLive] = await Promise.all([
    provider.getBlock("latest"),
    provider.getFeeData().then((x) => x.gasPrice || 0n).catch(() => 0n),
    fetchPrice(WETH),
    fetchPrice(ASSET),
    fetchPrice(SHARE),
  ]);

  const assetPriceUsd = assetPriceLive || candidate?.token?.erc4626?.assetPriceUsd || null;
  const shareMarketPriceUsd = sharePriceLive || candidate?.token?.erc4626?.marketPriceUsd || null;
  const gasUsd = gasCostUsd(gasPrice, ethPrice || 0);

  const [shareMetaRaw, assetMetaRaw, assetCall, receiptCall, unlockingFeeCall, totalAssetsCall, totalSupplyCall, cashCall] = await Promise.all([
    Promise.all([
      safeCall(provider, SHARE, ERC20, "symbol"),
      safeCall(provider, SHARE, ERC20, "name"),
      safeCall(provider, SHARE, ERC20, "decimals"),
    ]),
    Promise.all([
      safeCall(provider, ASSET, ERC20, "symbol"),
      safeCall(provider, ASSET, ERC20, "name"),
      safeCall(provider, ASSET, ERC20, "decimals"),
    ]),
    safeCall(provider, SHARE, ERC4626, "asset"),
    safeCall(provider, SHARE, ERC4626, "receipt"),
    safeCall(provider, SHARE, ERC4626, "unlockingFee"),
    safeCall(provider, SHARE, ERC4626, "totalAssets"),
    safeCall(provider, SHARE, ERC20, "totalSupply"),
    safeCall(provider, ASSET, ERC20, "balanceOf", [SHARE]),
  ]);

  const shareDecimals = shareMetaRaw[2].ok ? Number(shareMetaRaw[2].value[0]) : 18;
  const assetDecimals = assetMetaRaw[2].ok ? Number(assetMetaRaw[2].value[0]) : 18;
  const erc4626AssetMatches = assetCall.ok && sameAddress(assetCall.value[0], ASSET);
  const totalAssetsRaw = totalAssetsCall.ok ? totalAssetsCall.value[0] : null;
  const totalSupplyRaw = totalSupplyCall.ok ? totalSupplyCall.value[0] : null;
  const assetCashRaw = cashCall.ok ? cashCall.value[0] : 0n;
  const oneShareAssets = await safeCall(provider, SHARE, ERC4626, "convertToAssets", [10n ** BigInt(shareDecimals)]);
  const shareNavUsd = oneShareAssets.ok && assetPriceUsd ? formatAmount(oneShareAssets.value[0], assetDecimals) * assetPriceUsd : null;
  const receiptAddress = receiptCall.ok ? normalizeAddress(receiptCall.value[0]) : null;
  const [feeCurveCall, receiptPausedCall] = receiptAddress ? await Promise.all([
    safeCall(provider, receiptAddress, UNLOCK_RECEIPT, "feeCurve"),
    safeCall(provider, receiptAddress, UNLOCK_RECEIPT, "paused"),
  ]) : [{ ok: false, value: null }, { ok: false, value: null }];
  const receiptFeeCurve = decodeFeeCurve(feeCurveCall);
  const receiptPaused = receiptPausedCall.ok ? Boolean(receiptPausedCall.value[0]) : null;
  const receiptConfigured = Boolean(receiptAddress && receiptFeeCurve && receiptPaused === false);

  const pairs = candidateCurvePairs(candidate);

  const poolRows = [];
  const rows = [];
  for (const pair of pairs) {
    const pool = normalizeAddress(pair.pairAddress);
    if (!pool) continue;
    const coins = await curveCoins(provider, pool);
    const inIndex = coins.findIndex((x) => sameAddress(x, ASSET));
    const outIndex = coins.findIndex((x) => sameAddress(x, SHARE));
    poolRows.push({ pool, dexId: pair.dexId || null, liquidityUsd: pair.liquidityUsd || null, source: pair.source || "current-profit-lead-triage", coins, inIndex, outIndex });
    if (inIndex < 0 || outIndex < 0 || !assetPriceUsd) continue;

    for (const sizeUsd of TRADE_SIZES_USD) {
      const amountInAsset = sizeUsd / assetPriceUsd;
      const amountInRaw = parseAmount(amountInAsset, assetDecimals);
      const quote = await curveQuote(provider, pool, inIndex, outIndex, amountInRaw);
      if (!quote.ok) {
        rows.push({ pool, sizeUsd, quoteOk: false, routePositive: false, blockers: [quote.error || "Curve quote failed"] });
        continue;
      }
      const assetsOut = await safeCall(provider, SHARE, ERC4626, "convertToAssets", [quote.amountOutRaw]);
      const assetsOutRaw = assetsOut.ok ? assetsOut.value[0] : 0n;
      const inputUsd = formatAmount(amountInRaw, assetDecimals) * assetPriceUsd;
      const receiptScenarios = receiptClaimScenarios(assetsOutRaw, receiptFeeCurve, assetDecimals, assetPriceUsd, inputUsd, gasUsd);
      const bestReceiptScenario = receiptScenarios[0] || null;
      const outputUsd = bestReceiptScenario?.claimOutputUsd ?? null;
      const slippageUsd = bestReceiptScenario?.slippageUsd ?? null;
      const netUsd = bestReceiptScenario?.netUsd ?? null;
      const assetCashOk = assetCashRaw >= assetsOutRaw;
      const routePositive = Boolean(
        erc4626AssetMatches &&
        assetsOut.ok &&
        receiptConfigured &&
        assetCashOk &&
        Number.isFinite(netUsd) &&
        netUsd >= MIN_NET_PROFIT_USD &&
        forkProofPositive
      );
      const blockers = [];
      if (!erc4626AssetMatches) blockers.push("ERC4626 asset() does not match expected apxUSD asset");
      if (!assetsOut.ok) blockers.push("convertToAssets failed for quoted shares");
      if (!receiptAddress) blockers.push("apyUSD receipt() is not configured");
      if (!receiptFeeCurve) blockers.push("UnlockReceipt feeCurve() could not be read");
      if (receiptPaused) blockers.push("UnlockReceipt is paused");
      if (!assetCashOk) blockers.push("vault direct asset cash below quoted redeem output");
      if (!bestReceiptScenario) blockers.push("no receipt-claim fee scenario could be modeled");
      if (!Number.isFinite(netUsd) || netUsd < MIN_NET_PROFIT_USD) blockers.push("net profit below min threshold after gas/slippage");
      if (!forkProofPositive) blockers.push(forkProofNegative ? `local fork proof is not positive${forkFailureLabels.length ? `: ${forkFailureLabels.join("; ")}` : ""}` : "local fork proof has not yet shown positive receipt-claim profit");
      rows.push({
        pool,
        dexId: pair.dexId || null,
        sizeUsd,
        quoteOk: true,
        quoteAbi: quote.abi,
        amountInAsset: round(formatAmount(amountInRaw, assetDecimals), 10),
        sharesOut: round(formatAmount(quote.amountOutRaw, shareDecimals), 10),
        receiptAssets: round(formatAmount(assetsOutRaw, assetDecimals), 10),
        assetsOut: bestReceiptScenario?.claimAssetsOut ?? round(formatAmount(assetsOutRaw, assetDecimals), 10),
        bestClaimDelayDays: bestReceiptScenario?.delayDays ?? null,
        receiptFeeAssets: bestReceiptScenario?.receiptFeeAssets ?? null,
        receiptFeeUsd: bestReceiptScenario?.receiptFeeUsd ?? null,
        receiptScenarios,
        inputUsd: round(inputUsd, 6),
        outputUsd: round(outputUsd, 6),
        gasUsd: round(gasUsd, 6),
        slippageUsd: round(slippageUsd, 6),
        netUsd: round(netUsd, 6),
        assetCashOk,
        routePositive,
        blockers,
      });
    }
  }

  rows.sort((a, b) => (Number(b.netUsd) || -Infinity) - (Number(a.netUsd) || -Infinity));
  const routePositiveRows = rows.filter((r) => r.routePositive);
  const watchRows = rows.filter((r) => r.quoteOk && (Number(r.outputUsd) || 0) > (Number(r.inputUsd) || 0));

  const out = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-apyusd-erc4626-redeem-route.js",
    scope: "Read-only apyUSD Curve buy-market -> UnlockReceipt claim route scoring",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: routePositiveRows.length > 0,
      signedActionJustified: false,
    },
    sourceArtifacts: {
      currentProfitLeadTriage: "reports\\raw\\fast\\current-profit-lead-triage.json",
      forkProof: fs.existsSync(FORK_PROOF_FILE) ? "reports\\raw\\fast\\apyusd-erc4626-fork-proof.json" : null,
    },
    chain: { id: CHAIN_ID, name: "Ethereum", blockNumber: block?.number || null, timestamp: block?.timestamp || null },
    candidate: {
      share: SHARE,
      asset: ASSET,
      receipt: receiptAddress,
      symbol: "apyUSD",
      assetSymbol: "apxUSD",
      erc4626AssetMatches,
      shareDecimals,
      assetDecimals,
      unlockingFee: unlockingFeeCall.ok ? unlockingFeeCall.value[0].toString() : null,
      receiptPaused,
      receiptFeeCurve: formatFeeCurve(receiptFeeCurve),
      shareMarketPriceUsd,
      assetPriceUsd,
      shareNavUsd: round(shareNavUsd, 8),
      navMarketDivergencePct: shareNavUsd && shareMarketPriceUsd ? round(((shareMarketPriceUsd / shareNavUsd) - 1) * 100, 4) : null,
      totalAssets: totalAssetsRaw ? ethers.formatUnits(totalAssetsRaw, assetDecimals) : null,
      totalSupply: totalSupplyRaw ? ethers.formatUnits(totalSupplyRaw, shareDecimals) : null,
      directAssetCash: ethers.formatUnits(assetCashRaw, assetDecimals),
      directAssetCashUsd: assetPriceUsd ? round(formatAmount(assetCashRaw, assetDecimals) * assetPriceUsd, 6) : null,
    },
    forkProofStatus: forkProofStatus ? {
      status: forkProofStatus.status,
      generatedAt: forkProofStatus.proof?.generatedAt || null,
      forkProfitPositive: forkProofStatus.proof?.result?.forkProfitPositive ?? null,
      redeemError: forkProofStatus.proof?.result?.redeemError || forkProofStatus.proof?.result?.error || null,
      redeemRevert: forkProofStatus.proof?.result?.redeemRevert || null,
      withdrawError: forkProofStatus.proof?.result?.withdrawError || null,
      withdrawRevert: forkProofStatus.proof?.result?.withdrawRevert || null,
      exitMethod: forkProofStatus.proof?.result?.exitMethod || null,
      receiptTokenId: forkProofStatus.proof?.result?.receiptTokenId || null,
      bestClaimDelayDays: forkProofStatus.proof?.result?.bestClaimDelayDays ?? null,
      netProfitUsd: round(forkProofStatus.proof?.result?.netProfitUsd, 6),
      blockers: forkProofStatus.proof?.result?.blockers || [],
    } : null,
    thresholds: {
      tradeSizesUsd: TRADE_SIZES_USD,
      gasUnits: GAS_UNITS,
      slippageBufferBps: SLIPPAGE_BUFFER_BPS,
      claimDelaysDays: CLAIM_DELAYS_DAYS,
      minNetProfitUsd: MIN_NET_PROFIT_USD,
    },
    gas: { gasPriceWei: gasPrice.toString(), ethPriceUsd: ethPrice, gasUsd: round(gasUsd, 6) },
    summary: {
      curvePoolsConsidered: poolRows.length,
      quotedRows: rows.filter((r) => r.quoteOk).length,
      watchCandidates: watchRows.length,
      routePositive: routePositiveRows.length,
      signedActionJustified: false,
      bestNetUsd: rows[0]?.netUsd ?? null,
      bestRoute: rows[0] ? `${rows[0].dexId || "curve"} ${rows[0].sizeUsd} ${"apxUSD->apyUSD->receipt->claim-apxUSD"}` : null,
    },
    pools: poolRows,
    rows,
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, jsonReplacer, 2));
  console.log(`apyUSD ERC4626 route: quotes=${out.summary.quotedRows} watch=${out.summary.watchCandidates} routePositive=${out.summary.routePositive} bestNet=$${out.summary.bestNetUsd}`);
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT_FILE)}`);
}

main().catch((err) => {
  console.error(`scan-apyusd-erc4626-redeem-route failed: ${sanitize(err?.message || err)}`);
  process.exitCode = 1;
});
