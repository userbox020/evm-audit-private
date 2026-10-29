#!/usr/bin/env node
// Read-only atomic same-block exit proof probe for the Morpho WETH/yETH liquidation.

const fs = require("fs");
const path = require("path");
const { ethers } = require("./node_modules/ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "atomic-morpho-yeth-exit-proof.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "atomic-morpho-yeth-exit-proof.md");

const INPUTS = {
  e9Salvage: path.join(WORKSPACE, "reports", "raw", "fast", "e9-liquidation-salvage-routes.json"),
  currentLiquidatable: path.join(WORKSPACE, "reports", "raw", "fast", "current-liquidatable-exit-routes.json"),
  wrapperProof: path.join(WORKSPACE, "reports", "raw", "fast", "morpho-wrapper-exit-proof-gaps.json"),
  alternate: path.join(WORKSPACE, "reports", "raw", "fast", "morpho-yeth-alternate-exits.json"),
};

const QUIET = process.argv.includes("--quiet");

const ETH_RPC_FALLBACK = "https://ethereum.publicnode.com";
const ETH_PUBLIC_RPC_ENV = process.env.ETH_PUBLIC_RPC || "";

const TOKENS = {
  WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  yETH: "0x8464F6eCAe1EA58EC816C13f964030eAb8Ec123A",
  stETH: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84",
  WSTETH: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
};

const FEES = [100, 500, 3000, 10000];

const CURVE_POOLS = {
  YETH_WETH: "0xAfE3966e4DCbb3C7199bCC99BBac4B01A3E0E118",
  YETH_STETH: "0xd3f423038c55333d99B5C053113d73aDB694Eb16",
};

const UNISWAP_V3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const UNISWAP_V3_QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";

const ZERO = ethers.ZeroAddress;
const PROBE_FROM = "0x000000000000000000000000000000000000dEaD";

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

const FACTORY = new ethers.Interface(["function getPool(address tokenA,address tokenB,uint24 fee) view returns (address)"]);
const QUOTER = new ethers.Interface([
  "function quoteExactInput(bytes path,uint256 amountIn) view returns (uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)",
]);
const CURVE_COINS = new ethers.Interface(["function coins(uint256 i) view returns (address)"]);
const CURVE_INT128 = new ethers.Interface(["function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)"]);
const CURVE_UINT256 = new ethers.Interface(["function get_dy(uint256 i, uint256 j, uint256 dx) view returns (uint256)"]);

const CACHED = {
  pool: new Map(),
  dy: new Map(),
  coins: new Map(),
};

function readJson(file, fallback = null) {
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
  try {
    return ethers.getAddress(value);
  } catch (_) {
    return null;
  }
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
  const n = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 6) {
  const n = asNumber(value);
  if (n === null) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function formatUnitsNumber(value, decimals = 18) {
  try {
    const n = Number(ethers.formatUnits(toBigInt(value), decimals));
    return Number.isFinite(n) ? n : null;
  } catch (_) {
    return null;
  }
}

function compact(value, max = 120) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

async function rpcCall(url, method, params = [], timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    const json = await response.json();
    if (json?.error) throw new Error(json.error.message || "rpc error");
    return json.result ?? null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveEthereumRpc() {
  const candidates = [];
  if (ETH_PUBLIC_RPC_ENV && /^https?:\/\//i.test(ETH_PUBLIC_RPC_ENV)) candidates.push(ETH_PUBLIC_RPC_ENV);
  candidates.push(ETH_RPC_FALLBACK);

  const seen = new Set();
  for (const url of candidates) {
    const normalized = String(url || "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    try {
      const chainIdHex = await rpcCall(normalized, "eth_chainId", [], 6000);
      if (Number(BigInt(chainIdHex)) === 1) return normalized;
    } catch (_) {
      // Keep RPC URLs in-memory only and never print/persist them.
    }
  }
  throw new Error("No working Ethereum RPC endpoint available");
}

async function safeCall(provider, to, iface, fn, args = [], from = undefined) {
  try {
    const target = normalizeAddress(to);
    if (!target) return null;
    const tx = from ? { to: target, from, data: iface.encodeFunctionData(fn, args) } : { to: target, data: iface.encodeFunctionData(fn, args) };
    const raw = await provider.call(tx);
    const value = iface.decodeFunctionResult(fn, raw);
    return value[0];
  } catch (_) {
    return null;
  }
}

function encodePath(tokens, fees) {
  let encoded = "0x";
  for (let i = 0; i < tokens.length; i += 1) {
    encoded += normalizeAddress(tokens[i]).slice(2);
    if (i < fees.length) encoded += Number(fees[i]).toString(16).padStart(6, "0");
  }
  return encoded;
}

function routeLabel(tokens, fees) {
  return tokens.map((token, index) => `${compact(token, 12)}${index < fees.length ? `-${fees[index]}-` : ""}`).join("");
}

async function getUniPool(provider, tokenA, tokenB, fee) {
  const a = normalizeAddress(tokenA);
  const b = normalizeAddress(tokenB);
  if (!a || !b || sameAddress(a, b)) return null;
  const key = `${a.toLowerCase()}:${b.toLowerCase()}:${Number(fee)}`;
  if (CACHED.pool.has(key)) return CACHED.pool.get(key);

  const raw = await provider.call({
    to: UNISWAP_V3_FACTORY,
    data: FACTORY.encodeFunctionData("getPool", [a, b, Number(fee)]),
  }).catch(() => null);

  let pool = null;
  if (raw) {
    try {
      const [decoded] = FACTORY.decodeFunctionResult("getPool", raw);
      pool = decoded && !sameAddress(decoded, ZERO) ? normalizeAddress(decoded) : null;
    } catch (_) {}
  }

  CACHED.pool.set(key, pool);
  return pool;
}

async function quoteUniDirect(provider, tokenIn, tokenOut, amountIn) {
  const amount = toBigInt(amountIn, 0n);
  if (amount <= 0n || sameAddress(tokenIn, tokenOut)) {
    return [{
      source: "same-token",
      pathKind: "same-token",
      previewOnly: false,
      referenceOnly: false,
      amountInRaw: amount,
      amountOutRaw: amount,
      gasEstimate: 0n,
      path: { tokens: [normalizeAddress(tokenIn), normalizeAddress(tokenOut)], fees: [], label: "same-token", direct: true },
    }];
  }

  const out = [];
  const normIn = normalizeAddress(tokenIn);
  const normOut = normalizeAddress(tokenOut);
  for (const fee of FEES) {
    const pool = await getUniPool(provider, normIn, normOut, fee);
    if (!pool) continue;
    const raw = await provider.call({
      to: UNISWAP_V3_QUOTER_V2,
      data: QUOTER.encodeFunctionData("quoteExactInput", [encodePath([normIn, normOut], [fee]), amount]),
    }).catch(() => null);
    if (!raw) continue;
    try {
      const [amountOut, , , gasEstimate] = QUOTER.decodeFunctionResult("quoteExactInput", raw);
      if (amountOut > 0n) {
        out.push({
          source: "Uniswap V3 exactInputSingle",
          pathKind: "uniswap-v3-single",
          previewOnly: false,
          referenceOnly: false,
          amountInRaw: amount,
          amountOutRaw: amountOut,
          gasEstimate,
          path: {
            tokens: [normIn, normOut],
            fees: [fee],
            pools: [pool],
            direct: true,
            label: routeLabel([normIn, normOut], [fee]),
          },
        });
      }
    } catch (_) {}
  }
  return out;
}

async function curveCoinIndex(provider, pool, token) {
  const target = normalizeAddress(token);
  if (!target || !normalizeAddress(pool)) return null;
  const key = `${normalizeAddress(pool).toLowerCase()}:${target.toLowerCase()}`;
  if (CACHED.coins.has(key)) return CACHED.coins.get(key);

  let index = null;
  for (let i = 0; i < 8; i += 1) {
    const raw = await provider.call({
      to: pool,
      data: CURVE_COINS.encodeFunctionData("coins", [i]),
    }).catch(() => null);
    if (!raw) continue;
    try {
      const [addr] = CURVE_COINS.decodeFunctionResult("coins", raw);
      if (sameAddress(addr, target)) {
        index = i;
        break;
      }
    } catch (_) {}
  }

  CACHED.coins.set(key, index);
  return index;
}

async function curveQuoteFromPool(provider, pool, tokenIn, tokenOut, amountIn) {
  const amount = toBigInt(amountIn, 0n);
  if (amount <= 0n) return null;
  const inIdx = await curveCoinIndex(provider, pool, tokenIn);
  const outIdx = await curveCoinIndex(provider, pool, tokenOut);
  if (inIdx === null || outIdx === null || inIdx === outIdx) return null;

  const cacheKey = `${normalizeAddress(pool).toLowerCase()}:${inIdx}:${outIdx}:${amount.toString()}`;
  if (CACHED.dy.has(cacheKey)) return CACHED.dy.get(cacheKey);

  const tryCalls = [
    { iface: CURVE_INT128, args: [BigInt(inIdx), BigInt(outIdx), amount] },
    { iface: CURVE_UINT256, args: [BigInt(inIdx), BigInt(outIdx), amount] },
  ];

  for (const item of tryCalls) {
    const raw = await provider.call({
      to: pool,
      data: item.iface.encodeFunctionData("get_dy", item.args),
    }).catch(() => null);
    if (!raw) continue;
    try {
      const [dy] = item.iface.decodeFunctionResult("get_dy", raw);
      if (dy > 0n) {
        const out = { amountOut: toBigInt(dy, 0n), inIdx, outIdx };
        CACHED.dy.set(cacheKey, out);
        return out;
      }
    } catch (_) {}
  }

  const out = null;
  CACHED.dy.set(cacheKey, out);
  return out;
}

async function quoteCurvePool(provider, pool, tokenIn, tokenOut, amountIn, name) {
  const result = await curveQuoteFromPool(provider, pool, tokenIn, tokenOut, amountIn);
  if (!result || result.amountOut <= 0n) return null;
  return {
    source: `${name} direct`,
    pathKind: "curve-direct",
    previewOnly: false,
    referenceOnly: false,
    amountInRaw: toBigInt(amountIn),
    amountOutRaw: result.amountOut,
    gasEstimate: 0n,
    path: {
      pool,
      tokenIn: normalizeAddress(tokenIn),
      tokenOut: normalizeAddress(tokenOut),
      coinIn: { address: normalizeAddress(tokenIn), index: result.inIdx },
      coinOut: { address: normalizeAddress(tokenOut), index: result.outIdx },
      label: `curve-direct(${name})`,
    },
  };
}

async function quoteUniRouted(provider, tokenIn, tokenMid, tokenOut, amountIn, sourceLabel) {
  const amount = toBigInt(amountIn, 0n);
  if (amount <= 0n) return [];

  const normIn = normalizeAddress(tokenIn);
  const normMid = normalizeAddress(tokenMid);
  const normOut = normalizeAddress(tokenOut);
  if (!normIn || !normMid || !normOut || sameAddress(normIn, normMid) || sameAddress(normMid, normOut) || sameAddress(normIn, normOut)) return [];

  const out = [];
  for (const feeIn of FEES) {
    for (const feeOut of FEES) {
      const [poolIn, poolOut] = await Promise.all([
        getUniPool(provider, normIn, normMid, feeIn),
        getUniPool(provider, normMid, normOut, feeOut),
      ]);
      if (!poolIn || !poolOut) continue;

      const raw = await provider.call({
        to: UNISWAP_V3_QUOTER_V2,
        data: QUOTER.encodeFunctionData("quoteExactInput", [encodePath([normIn, normMid, normOut], [feeIn, feeOut]), amount]),
      }).catch(() => null);
      if (!raw) continue;

      try {
        const [amountOut, , , gasEstimate] = QUOTER.decodeFunctionResult("quoteExactInput", raw);
        if (amountOut > 0n) {
          out.push({
            source: `${sourceLabel} (${Number(feeIn).toString()}/${Number(feeOut).toString()})`,
            pathKind: "uniswap-v3-routed",
            previewOnly: false,
            referenceOnly: false,
            amountInRaw: amount,
            amountOutRaw: amountOut,
            gasEstimate,
            path: {
              tokens: [normIn, normMid, normOut],
              fees: [feeIn, feeOut],
              pools: [poolIn, poolOut],
              direct: false,
              label: routeLabel([normIn, normMid, normOut], [feeIn, feeOut]),
            },
          });
        }
      } catch (_) {}
    }
  }

  return out;
}

function selectBestSize(row) {
  const sizes = Array.isArray(row?.sizeResults) ? row.sizeResults : [];
  return sizes
    .filter((size) => !size?.seizedExceedsCollateral && toBigInt(size?.seizedCollateralRaw, 0n) > 0n)
    .sort((a, b) => {
      const aSeized = toBigInt(a?.seizedCollateralRaw, 0n);
      const bSeized = toBigInt(b?.seizedCollateralRaw, 0n);
      return bSeized > aSeized ? 1 : bSeized < aSeized ? -1 : 0;
    })[0]
    || null;
}

function sourceContext(inputs) {
  const rows = [];
  for (const row of inputs.e9Salvage?.results || []) rows.push({ ...row, __source: "e9", currentLiquidatable: true });
  for (const row of inputs.currentLiquidatable?.topRows || []) rows.push({ ...row, __source: "current-liquidatable" });
  for (const row of inputs.wrapperProof?.rows || []) rows.push({ ...row, __source: "morpho-wrapper-exit-proof" });
  for (const row of inputs.alternate?.topRows || inputs.alternate?.rows || []) rows.push({ ...row, __source: "morpho-yeth-alternate" });

  const targetRows = rows.filter((row) => sameAddress(row?.loanAsset?.address, TOKENS.WETH) && sameAddress(row?.collateral?.address, TOKENS.yETH));
  const best = targetRows[0] || {};

  const size = selectBestSize(best);
  const maxSeizedFromWrapper = toBigInt(best?.maxSeizedRaw, 0n);
  const maxSeizedFromSources = (() => {
    const options = [];
    if (size?.seizedCollateralRaw) options.push(toBigInt(size.seizedCollateralRaw, 0n));
    if (best?.seizedRaw) options.push(toBigInt(best.seizedRaw, 0n));
    if (maxSeizedFromWrapper > 0n) options.push(maxSeizedFromWrapper);
    return options.length ? options.sort((a, b) => (a > b ? -1 : a < b ? 1 : 0))[0] : 0n;
  })();

  const repayFromBest = toBigInt(size?.repaidAssetsRaw || size?.repayAssetsRaw || best?.repayRawForMaxSeized || best?.repayRaw || best?.repayRawForMaxSeized, 0n);
  const repayFromMax = (() => {
    const options = [];
    if (size?.repaidAssetsRaw) options.push(toBigInt(size.repaidAssetsRaw, 0n));
    if (size?.repayAssetsRaw) options.push(toBigInt(size.repayAssetsRaw, 0n));
    if (best?.repayRawForMaxSeized) options.push(toBigInt(best.repayRawForMaxSeized, 0n));
    if (best?.repayRaw) options.push(toBigInt(best.repayRaw, 0n));
    return options.length ? options[0] : repayFromBest;
  })();

  return {
    marketId: best?.marketId || "0x1f1ca1956b469f17c9b1b4b0290bd00147e23f6c475e7d503eb323839d3643db",
    borrower: best?.borrower || "0x57Eda1DB773cB6EF68b4f88eC7E7028C0694b0D9",
    pair: best?.pair || "WETH/yETH",
    healthFactor: round(best?.healthFactor, 6),
    debtUsd: round(best?.debtUsd ?? best?.graph?.borrowAssetsUsd, 6),
    collateralUsd: round(best?.collateralUsd ?? best?.graph?.collateralUsd, 6),
    loanAsset: {
      symbol: "WETH",
      address: TOKENS.WETH,
      priceUsd: asNumber(best?.loanAsset?.priceUsd ?? (best?.loanAsset?.price || inputs.e9Salvage?.results?.[0]?.loanAsset?.priceUsd)) || null,
    },
    collateral: {
      symbol: "yETH",
      address: TOKENS.yETH,
      priceUsd: asNumber(best?.collateral?.priceUsd || inputs.e9Salvage?.results?.[0]?.collateral?.priceUsd),
    },
    repayRaw: repayFromMax > 0n ? repayFromMax.toString() : "250722420700480738",
    seizedRaw: maxSeizedFromSources > 0n ? maxSeizedFromSources.toString() : "271783839123692412",
    flashFeeRaw: toBigInt(size?.flashFeeRaw || best?.flashFeeRaw || "0", 0n).toString(),
    gasUsd: asNumber(inputs.e9Salvage?.gas?.liquidationGasUsd) || 0,
    slippageBps: asNumber(inputs.e9Salvage?.thresholds?.slippageBps) || 100,
  };
}

function tokenSymbol(address) {
  const map = {
    [lowerAddress(TOKENS.WETH)]: "WETH",
    [lowerAddress(TOKENS.stETH)]: "stETH",
    [lowerAddress(TOKENS.WSTETH)]: "wstETH",
  };
  return map[lowerAddress(address)] || null;
}

async function collectUniPool(provider, otherToken, fee) {
  const pool = await getUniPool(provider, TOKENS.yETH, otherToken, fee);
  if (!pool) return null;

  const [yethBalanceRaw, otherBalanceRaw] = await Promise.all([
    safeCall(provider, TOKENS.yETH, ERC20, "balanceOf", [pool]).catch(() => null),
    safeCall(provider, otherToken, ERC20, "balanceOf", [pool]).catch(() => null),
  ]);

  return {
    token: normalizeAddress(otherToken),
    symbol: tokenSymbol(otherToken),
    fee,
    pool,
    yethBalanceRaw: yethBalanceRaw?.toString?.() || null,
    otherBalanceRaw: otherBalanceRaw?.toString?.() || null,
  };
}

function inventoryFromSources(ctx, provider) {
  const poolTargets = [TOKENS.WETH, TOKENS.WSTETH];
  return Promise.all(poolTargets.flatMap((token) => FEES.map((fee) => collectUniPool(provider, token, fee)))).then((rows) => ({
    uniswapV3Pairs: rows.filter(Boolean),
    curveYethPools: Object.entries(CURVE_POOLS).map(([name, address]) => ({ name, address })),
    balancerYethPools: [],
  }));
}

async function wrapperProbe(provider, seizedRaw) {
  const seized = toBigInt(seizedRaw, 0n);
  const probeShares = seized > 0n ? seized : 1n;

  const [assetRaw, totalSupplyRaw, totalAssetsRaw, previewRedeemRaw, convertToAssetsRaw, maxRedeemFromZeroRaw] = await Promise.all([
    safeCall(provider, TOKENS.yETH, ERC20, "asset"),
    safeCall(provider, TOKENS.yETH, ERC20, "totalSupply"),
    safeCall(provider, TOKENS.yETH, ERC20, "totalAssets"),
    safeCall(provider, TOKENS.yETH, ERC20, "previewRedeem", [probeShares]),
    safeCall(provider, TOKENS.yETH, ERC20, "convertToAssets", [probeShares]),
    safeCall(provider, TOKENS.yETH, ERC20, "maxRedeem", [ZERO]),
  ]);

  const asset = normalizeAddress(assetRaw);
  let assetSymbol = null;
  let assetDecimals = null;
  if (asset) {
    assetSymbol = await safeCall(provider, asset, ERC20, "symbol").then((v) => (typeof v === "string" ? v : null));
    const decimalsRaw = await safeCall(provider, asset, ERC20, "decimals").catch(() => null);
    assetDecimals = decimalsRaw === null || decimalsRaw === undefined ? null : Number(decimalsRaw);
  }

  const manager = normalizeAddress(await safeCall(provider, TOKENS.yETH, WRAPPER_MANAGER, "manager").catch(() => null));
  let managerProof = null;
  let sameBlockAssetTransferCapacity = false;

  if (manager && asset) {
    const [withdrawEnabled, maxRedeemCapRaw, managerAssetBalanceRaw, wrapperAssetBalanceRaw] = await Promise.all([
      safeCall(provider, manager, WRAPPER_MANAGER, "withdrawAssets", [TOKENS.yETH, asset]),
      safeCall(provider, manager, WRAPPER_MANAGER, "maxRedeemCap", [TOKENS.yETH]),
      safeCall(provider, asset, ERC20, "balanceOf", [manager]),
      safeCall(provider, asset, ERC20, "balanceOf", [TOKENS.yETH]),
    ]);

    const maxRedeemCap = toBigInt(maxRedeemCapRaw, 0n);
    const managerLiquidity = toBigInt(managerAssetBalanceRaw, 0n);
    const wrapperLiquidity = toBigInt(wrapperAssetBalanceRaw, 0n);
    const totalInstantLiquidity = managerLiquidity + wrapperLiquidity;
    const previewAssets = toBigInt(previewRedeemRaw, 0n);

    sameBlockAssetTransferCapacity = Boolean(withdrawEnabled && seized > 0n && maxRedeemCap >= seized && previewAssets > 0n && totalInstantLiquidity >= previewAssets);

    managerProof = {
      manager,
      withdrawAssetEnabled: Boolean(withdrawEnabled),
      maxRedeemCapRaw: maxRedeemCap.toString(),
      managerAssetBalanceRaw: managerLiquidity.toString(),
      wrapperAssetBalanceRaw: wrapperLiquidity.toString(),
      totalInstantLiquidityRaw: totalInstantLiquidity.toString(),
      capCoversProbeShares: seizeCondition(seized, maxRedeemCap),
      liquidityCoversPreviewAssets: seizeCondition(previewAssets, totalInstantLiquidity),
      instantCapacitySufficient: sameBlockAssetTransferCapacity,
    };
  }

  return {
    erc4626Like: Boolean(asset),
    asset,
    directLoanAsset: Boolean(asset && sameAddress(asset, TOKENS.WETH)),
    assetSymbol,
    assetDecimals,
    totalSupplyRaw: totalSupplyRaw?.toString?.() || null,
    totalAssetsRaw: totalAssetsRaw?.toString?.() || null,
    previewRedeemRaw: previewRedeemRaw?.toString?.() || null,
    convertToAssetsRaw: convertToAssetsRaw?.toString?.() || null,
    maxRedeemProbeFromRaw: maxRedeemFromZeroRaw?.toString?.() || null,
    managerProof,
    sameBlockAssetTransferCapacity,
    sameBlockAssetTransferProven: false,
  };
}

function seizeCondition(need, available) {
  return toBigInt(need, 0n) > 0n && toBigInt(available, 0n) >= toBigInt(need, 0n);
}

function scoreQuote(quote, ctx, sameBlockAssetTransferProven) {
  const amountOutRaw = toBigInt(quote.amountOutRaw, 0n);
  const repayRaw = toBigInt(ctx.repayRaw, 0n);
  const flashFeeRaw = toBigInt(ctx.flashFeeRaw, 0n);
  const loanPriceUsd = asNumber(ctx.loanAsset?.priceUsd) || 0;
  const grossProfitRaw = amountOutRaw - repayRaw - flashFeeRaw;
  const amountOut = formatUnitsNumber(amountOutRaw, 18) || 0;
  const expectedOutUsd = amountOut * loanPriceUsd;
  const grossProfitUsd = (formatUnitsNumber(grossProfitRaw, 18) || 0) * loanPriceUsd;
  const repayUsd = (formatUnitsNumber(repayRaw, 18) || 0) * loanPriceUsd;
  const slippageUsd = repayUsd * (asNumber(ctx.slippageBps) || 0) / 10_000;
  const netProfitUsd = grossProfitUsd - (asNumber(ctx.gasUsd) || 0) - slippageUsd;
  const exactSameBlockQuote = Boolean(!quote.previewOnly && !quote.referenceOnly);
  const exactPositive = Boolean(exactSameBlockQuote && grossProfitRaw > 0n && netProfitUsd > 0);
  const previewPositive = Boolean(quote.previewOnly && grossProfitRaw > 0n && netProfitUsd > 0);

  const blockers = [];
  if (quote.previewOnly) blockers.push("Wrapper preview is not same-block asset transfer proof");
  blockers.push(grossProfitRaw > 0n ? null : "Exit quote does not cover repay assets plus flash fee");
  blockers.push(netProfitUsd > 0 ? null : "Net profit after gas/slippage is not positive");
  if (exactSameBlockQuote && !sameBlockAssetTransferProven) blockers.push("No fork/static trace proves same-block yETH redemption transfers WETH");
  blockers.push("No fork extraction proof");
  blockers.push("Signed action remains fail-closed");

  return {
    ...quote,
    exactSameBlockQuote,
    amountOut,
    expectedOutUsd,
    grossProfitRaw: grossProfitRaw.toString(),
    grossProfitUsd,
    slippageUsd,
    gasUsd: asNumber(ctx.gasUsd) || 0,
    netProfitUsd,
    gasEstimate: quote.gasEstimate?.toString?.() || null,
    routePositive: exactPositive,
    previewPositive,
    blockers: blockers.filter(Boolean),
    path: quote.path,
  };
}

function quoteAll(provider, ctx, wrapper) {
  const amountIn = toBigInt(ctx.seizedRaw, 0n);
  const quotes = [];

  if (wrapper?.previewRedeemRaw) {
    const previewAssets = toBigInt(wrapper.previewRedeemRaw, 0n);
    if (previewAssets > 0n) {
      quotes.push({
        source: "ERC4626 previewRedeem to WETH",
        pathKind: "erc4626-preview-redeem",
        previewOnly: true,
        referenceOnly: false,
        amountInRaw: amountIn,
        amountOutRaw: previewAssets,
        gasEstimate: 0n,
        path: { wrapper: TOKENS.yETH, asset: wrapper.asset, previewAssetsRaw: wrapper.previewRedeemRaw },
      });
    }
  }

  return Promise.all([
    quoteUniDirect(provider, TOKENS.yETH, TOKENS.WETH, amountIn),
    quoteUniRouted(provider, TOKENS.yETH, TOKENS.WSTETH, TOKENS.WETH, amountIn, "Uniswap V3 yETH/wstETH/WETH"),
    quoteCurvePool(provider, CURVE_POOLS.YETH_WETH, TOKENS.yETH, TOKENS.WETH, amountIn, "Curve yETH/WETH"),
    (async () => {
      const headQuote = await quoteCurvePool(provider, CURVE_POOLS.YETH_STETH, TOKENS.yETH, TOKENS.STETH, amountIn, "Curve yETH/stETH");
      if (!headQuote) return [];
      const tails = await quoteUniDirect(provider, TOKENS.STETH, TOKENS.WETH, toBigInt(headQuote.amountOutRaw, 0n));
      return tails.map((tail) => ({
        source: `${headQuote.source} + ${tail.source}`,
        pathKind: `${headQuote.pathKind}+${tail.pathKind}`,
        previewOnly: false,
        referenceOnly: false,
        amountInRaw: amountIn,
        amountOutRaw: tail.amountOutRaw,
        gasEstimate: toBigInt(headQuote.gasEstimate || 0n, 0n) + toBigInt(tail.gasEstimate || 0n, 0n),
        path: {
          legs: [headQuote.path, tail.path],
        },
      }));
    })(),
  ]).then(async ([uniDirect, ystethRoutes, curveYethWethQuote, tailRoutes]) => {
    for (const quote of uniDirect) quotes.push(quote);
    for (const quote of ystethRoutes) quotes.push(quote);
    if (curveYethWethQuote) quotes.push(curveYethWethQuote);
    for (const q of tailRoutes || []) quotes.push(q);
    const seen = new Set();
    const deduped = [];
    for (const q of quotes) {
      if (!q || toBigInt(q.amountOutRaw, 0n) <= 0n) continue;
      const key = `${q.pathKind}:${q.amountOutRaw.toString()}:${JSON.stringify(q.path || {})}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(q);
    }

    const sameBlockProven = Boolean(wrapper?.sameBlockAssetTransferProven);
    return deduped.map((q) => scoreQuote(q, ctx, sameBlockProven));
  });
}

function summarize(outputQuotes, wrapper, ctx) {
  const exactSameBlockQuotes = outputQuotes.filter((q) => q.exactSameBlockQuote);
  const exactPositiveRows = outputQuotes.filter((q) => q.routePositive);
  const previewPositiveRows = outputQuotes.filter((q) => q.previewPositive);
  const bestExact = exactSameBlockQuotes.sort((a, b) => Number(b.netProfitUsd ?? -Infinity) - Number(a.netProfitUsd ?? -Infinity))[0] || null;
  const bestPreview = outputQuotes.filter((q) => q.previewOnly).sort((a, b) => Number(b.netProfitUsd ?? -Infinity) - Number(a.netProfitUsd ?? -Infinity))[0] || null;
  const bestQuote = outputQuotes.sort((a, b) => Number(b.netProfitUsd ?? -Infinity) - Number(a.netProfitUsd ?? -Infinity))[0] || null;

  const blockers = [
    exactPositiveRows.length ? null : "No exact same-block yETH->WETH route is positive after repay, gas, and slippage",
    previewPositiveRows.length ? "Best positive edge is wrapper preview-only, not same-block transfer proof" : null,
    wrapper?.managerProof?.maxRedeemCapRaw === "0" ? "Wrapper manager instant redeem cap is zero" : null,
    wrapper?.managerProof?.totalInstantLiquidityRaw === "0" ? "Wrapper manager/wrapper instant WETH liquidity is zero" : null,
    wrapper?.sameBlockAssetTransferProven ? null : "No fork/static trace proves same-block yETH redemption transfers WETH",
    "No fork extraction proof",
    "Signed action remains fail-closed",
  ].filter(Boolean);

  return {
    exactSameBlockQuotes: exactSameBlockQuotes.length,
    exactPositiveRows: exactPositiveRows.length,
    previewPositiveRows: previewPositiveRows.length,
    routePositive: exactPositiveRows.length,
    bestExactNetUsd: bestExact ? round(bestExact.netProfitUsd, 6) : null,
    bestPreviewNetUsd: bestPreview ? round(bestPreview.netProfitUsd, 6) : null,
    bestNetUsd: bestQuote ? round(bestQuote.netProfitUsd, 6) : null,
    bestSource: bestQuote?.source || null,
    bestPathKind: bestQuote?.pathKind || null,
    wrapperInstantCapacity: Boolean(wrapper?.sameBlockAssetTransferCapacity),
    sameBlockAssetTransferCapacity: Boolean(wrapper?.sameBlockAssetTransferCapacity),
    sameBlockAssetTransferProven: Boolean(wrapper?.sameBlockAssetTransferProven),
    blockers,
    status: exactPositiveRows.length
      ? "exact-positive-route-proven-pending-fork"
      : previewPositiveRows.length
        ? "preview-positive-wrapper-capacity-blocked"
        : "no-exact-positive-yeth-exit",
    summary: {
      status: exactPositiveRows.length
        ? "exact-positive-route-proven-pending-fork"
        : previewPositiveRows.length
          ? "preview-positive-wrapper-capacity-blocked"
          : "no-exact-positive-yeth-exit",
      routePositive: exactPositiveRows.length,
    },
  };
}

function writeReport(output) {
  const { summary, context, bestQuote, blockers } = output;
  const dormant = summary.routePositive === 0;
  const lines = [];

  lines.push(`${dormant ? "# 🟢 DORMANT" : "# 🟠 ROUTE-POSITIVE"} - Morpho WETH/yETH Atomic Exit Proof Probe`);
  lines.push("");
  lines.push("## Verdict");
  lines.push("");
  lines.push(dormant
    ? "No live execution is justified. The current Morpho WETH/yETH liquidation remains blocked until an exact same-block yETH->WETH route is route-positive and fork-proven for same-block transfer semantics."
    : "An exact positive route exists in quote scoring, but same-block semantics remain unproven and execution is still not justified without fork proof and verified semantics.");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|---|---:|");
  lines.push(`| Quotes scored | ${summary.quotesScored} |`);
  lines.push(`| Exact same-block quotes | ${summary.exactSameBlockQuotes} |`);
  lines.push(`| Exact positive rows | ${summary.exactPositiveRows} |`);
  lines.push(`| Preview-positive rows | ${summary.previewPositiveRows} |`);
  lines.push(`| Route positive | ${summary.routePositive} |`);
  lines.push(`| Best exact net USD | ${summary.bestExactNetUsd === null ? "n/a" : `$${summary.bestExactNetUsd}`} |`);
  lines.push(`| Best preview net USD | ${summary.bestPreviewNetUsd === null ? "n/a" : `$${summary.bestPreviewNetUsd}`} |`);
  lines.push(`| Uniswap V3 yETH/WETH pools | ${summary.uniswapYethPairs} |`);
  lines.push(`| Curve yETH pools | ${summary.curveYethPools} |`);
  lines.push(`| Wrapper instant capacity | ${summary.wrapperInstantCapacity ? "true" : "false"} |`);
  lines.push(`| Same-block asset transfer capacity | ${summary.sameBlockAssetTransferCapacity ? "true" : "false"} |`);
  lines.push(`| Same-block asset transfer proven | ${summary.sameBlockAssetTransferProven ? "true" : "false"} |`);
  lines.push("");

  lines.push("## Best Quote");
  lines.push("");
  if (bestQuote) {
    lines.push(`- Source: \`${bestQuote.source}\``);
    lines.push(`- Path kind: \`${bestQuote.pathKind}\``);
    lines.push(`- Net USD: \`${round(bestQuote.netProfitUsd, 6)}\``);
    lines.push(`- Route positive: \`${bestQuote.routePositive ? "true" : "false"}\``);
    lines.push(`- Amount out: \`${bestQuote.amountOut}\``);
    lines.push(`- Blockers: ${bestQuote.blockers.map((b) => `\`${compact(b, 100)}\``).join(", ")}`);
  } else {
    lines.push("- No usable quote was produced for the probed seized size.");
  }
  lines.push("");

  lines.push("## Blockers");
  lines.push("");
  for (const blocker of blockers) lines.push(`- ${blocker}`);
  lines.push("");

  lines.push("## Artifacts");
  lines.push("");
  lines.push(`- Raw: \`${rel(RAW_OUT)}\``);
  lines.push("- Scanner: `tools/scan-atomic-morpho-yeth-exit-proof.js`");

  lines.push("");
  lines.push(`### Context`);
  lines.push(`- Market ID: \`${context.marketId}\``);
  lines.push(`- Borrower: \`${context.borrower}\``);
  lines.push(`- Pair: ${context.pair}`);
  lines.push(`- Repay raw: \`${context.repayRaw}\``);
  lines.push(`- Seized raw: \`${context.seizedRaw}\``);
  lines.push(`- WETH price (USD): \`${context.loanAsset?.priceUsd || "n/a"}\``);

  fs.writeFileSync(REPORT_OUT, `${lines.join("\n")}\n`);
}

async function main() {
  const inputs = Object.fromEntries(Object.entries(INPUTS).map(([key, file]) => [key, readJson(file, {})]));
  const context = sourceContext(inputs);

  if (!context.marketId || !context.borrower || !context.seizedRaw || !context.repayRaw) {
    throw new Error("Missing required atomic context; check source artifacts");
  }

  const rpcUrl = await resolveEthereumRpc();
  const provider = new ethers.JsonRpcProvider(rpcUrl, 1, { staticNetwork: true });

  const wrapperPromise = wrapperProbe(provider, context.seizedRaw);

  const [block, wrapper, poolInventory] = await Promise.all([
    provider.getBlock("latest").catch(() => null),
    wrapperPromise,
    inventoryFromSources(context, provider),
  ]);

  const quotes = await quoteAll(provider, context, wrapper).catch(() => []);

  const scored = [...quotes].sort((a, b) => (Number(b.netProfitUsd ?? -Infinity) - Number(a.netProfitUsd ?? -Infinity)));

  const summaryCore = (() => {
    const exactSameBlock = scored.filter((q) => q.exactSameBlockQuote);
    const exactPositiveRows = scored.filter((q) => q.routePositive);
    const previewPositiveRows = scored.filter((q) => q.previewPositive);
    const bestExact = exactSameBlock.sort((a, b) => Number(b.netProfitUsd ?? -Infinity) - Number(a.netProfitUsd ?? -Infinity))[0] || null;
    const bestPreview = scored.filter((q) => q.previewOnly).sort((a, b) => Number(b.netProfitUsd ?? -Infinity) - Number(a.netProfitUsd ?? -Infinity))[0] || null;
    const best = scored[0] || null;
    return {
      quotesScored: scored.length,
      exactSameBlockQuotes: exactSameBlock.length,
      exactPositiveRows: exactPositiveRows.length,
      previewPositiveRows: previewPositiveRows.length,
      routePositive: exactPositiveRows.length,
      bestExactNetUsd: bestExact ? round(bestExact.netProfitUsd, 6) : null,
      bestPreviewNetUsd: bestPreview ? round(bestPreview.netProfitUsd, 6) : null,
      bestNetUsd: best ? round(best.netProfitUsd, 6) : null,
      bestSource: best?.source || null,
      bestPathKind: best?.pathKind || null,
      uniswapYethPairs: (poolInventory?.uniswapV3Pairs || []).length,
      curveYethPools: (poolInventory?.curveYethPools || []).length,
      wrapperInstantCapacity: Boolean(wrapper?.sameBlockAssetTransferCapacity),
      sameBlockAssetTransferCapacity: Boolean(wrapper?.sameBlockAssetTransferCapacity),
      sameBlockAssetTransferProven: Boolean(wrapper?.sameBlockAssetTransferProven),
      blockers: [
        exactPositiveRows.length ? null : "No exact same-block yETH->WETH route is positive after repay, gas, and slippage",
        previewPositiveRows.length ? "Best positive edge is wrapper preview-only, not same-block transfer proof" : null,
        wrapper?.managerProof?.maxRedeemCapRaw === "0" ? "Wrapper manager instant redeem cap is zero" : null,
        wrapper?.managerProof?.totalInstantLiquidityRaw === "0" ? "Wrapper manager/wrapper instant WETH liquidity is zero" : null,
        wrapper?.sameBlockAssetTransferProven ? null : "No fork/static trace proves same-block yETH redemption transfers WETH",
        "No fork extraction proof",
        "Signed action remains fail-closed",
      ].filter(Boolean),
    };
  })();

  const bestQuote = scored[0] || null;

  const output = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-atomic-morpho-yeth-exit-proof.js",
    scope: "Read-only atomic same-block exit proof probe for the top Morpho WETH/yETH current-liquidatable row",
    safety: {
      rpcInventoryRead: false,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      forkTransactions: false,
      liveTransactions: false,
      routePositive: summaryCore.routePositive > 0,
      signedActionJustified: false,
    },
    block: block
      ? {
          number: block.number,
          timestamp: block.timestamp,
          iso: new Date(Number(block.timestamp) * 1000).toISOString(),
        }
      : null,
    sourceArtifacts: Object.fromEntries(Object.entries(INPUTS).map(([key, file]) => [key, rel(file)])),
    sourceGeneratedAt: {
      e9Salvage: inputs.e9Salvage?.generatedAt || null,
      currentLiquidatable: inputs.currentLiquidatable?.generatedAt || null,
      wrapperProof: inputs.wrapperProof?.generatedAt || null,
      alternate: inputs.alternate?.generatedAt || null,
    },
    context,
    wrapper,
    inventory: poolInventory,
    summary: summaryCore,
    bestQuote,
    quotes: scored.slice(0, 24).map((q) => ({ ...q, amountOutRaw: q.amountOutRaw?.toString?.() || q.amountOutRaw })),
    blockers: summaryCore.blockers,
    requiredForRoutePositive: [
      "Current Morpho borrower remains liquidatable on-chain",
      "Exact seized size and repay values are used",
      "Same-block yETH->WETH route is exact-quoted positive after repay, gas, and slippage",
      "Wrapper path same-block transfer proof is observed if wrapper is used",
      "Wrapper manager cap/liquidity covers probe shares and previewed assets",
      "Fork/static trace proves same-block redemption to WETH",
      "Fork extraction proof before any signed action",
    ],
  };

  fs.mkdirSync(path.dirname(RAW_OUT), { recursive: true });
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(output, jsonReplacer, 2)}\n`);
  writeReport(output);

  if (!QUIET) {
    console.log(`atomicMorphoYethScan quotes=${output.summary.quotesScored} exactPositive=${output.summary.exactPositiveRows} previewPositive=${output.summary.previewPositiveRows} routePositive=${output.summary.routePositive}`);
    console.log(`Output: ${rel(RAW_OUT)}`);
    console.log(`Report: ${rel(REPORT_OUT)}`);
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exitCode = 1;
});
