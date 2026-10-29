#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.join(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "usdai-arbitrum-live.json");
const RPC_TIMEOUT_MS = 15_000;

const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

const ADDRESSES = {
  usdai: "0x0A1a1A107E45b7Ced86833863f482BC5f4ed82EF",
  stakedUsdai: "0x0B2b2B2076d95dda7817e785989fE353fe955ef9",
  queuedDepositor: "0x81cc0DEE5e599784CBB4862c605c7003B0aC5A53",
  loanRouter: "0x0C2ED170F2bB1DF1a44292Ad621B577b3C9597D1",
  wrappedM: "0x437cc33344a0B27A429f795ff6B469C72698B291",
  pyusd: "0x46850aD61C2B7d64d08c9C754F45254596696984",
  usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  usdt: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
  legacyPool1: "0x0f62b8C58E1039F246d69bA2215ad5bF0D2Bb867",
  legacyPool2: "0xcd9d510c4e2fe45e6ed4fe8a3a30eeef3830cc14",
};

const CALLS = {
  name: "0x06fdde03",
  symbol: "0x95d89b41",
  decimals: "0x313ce567",
  totalSupply: "0x18160ddd",
  balanceOf: "0x70a08231",
  asset: "0x38d52e0f",
  totalAssets: "0x01e1d114",
  convertToAssets1e18: "0x07a2d13a" + "0".repeat(48) + "0de0b6b3a7640000",
  convertToShares1e18: "0xc6e6f592" + "0".repeat(48) + "0de0b6b3a7640000",
  maxDepositSelf: "0x402d267d",
  maxWithdrawSelf: "0xce96cb77",
  paused: "0x5c975abb",
  owner: "0x8da5cb5b",
  baseYieldAccrued: "0x1d63e61a",
  claimableBaseYield: "0x927c9b01",
  whitelistedTokens: "0x5e1762a0",
  loanRouterBalances: "0x66518b81",
  pools: "0xc5c51dca",
  currencyToken: "0x6b2fa374",
  liquidityNodesAll: "0x7e27c50f" + "0".repeat(64) + "0".repeat(32) + "ffffffffffffffffffffffffffffffff",
  nav: "0xc1590cd7",
  depositSharePrice: "0x1eb510a1",
  redemptionSharePrice: "0xecab31a0",
  redemptionQueueInfo: "0xf4a6564d",
  redemptionTimestamp: "0x1b235437",
  totalShares: "0x3a98ef39",
  bridgedSupply: "0x11c301e0",
  baseToken: "0xc55dae63",
  swapAdapter: "0x77bb1eb9",
  depositCapInfo: "0x8ddcc36b",
  queueInfo: "0x38e481a4",
  isWhitelistedToken: "0xab37f486",
  whitelistedTokenMinAmount: "0x1c5d9d11",
};

function extractRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function rpcCall(url, method, params, timeoutMs = RPC_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    return json.result;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveArbitrumRpc() {
  const candidates = [...extractRpcUrls(), "https://arb1.arbitrum.io/rpc"];
  const seen = new Set();
  for (const url of candidates) {
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      const chainId = Number(BigInt(await rpcCall(url, "eth_chainId", [], 5000)));
      if (chainId === 42161) return url;
    } catch (_) {
      // Never print or store RPC URLs.
    }
  }
  return null;
}

function strip0x(x) {
  return String(x || "").replace(/^0x/i, "");
}

function hexToBigInt(hex) {
  if (!hex || hex === "0x") return null;
  return BigInt(hex);
}

function addressFromWord(word) {
  if (!word || word === "0x" || BigInt(word) === 0n) return null;
  return "0x" + strip0x(word).slice(-40);
}

function encodeAddress(address) {
  return strip0x(address).toLowerCase().padStart(64, "0");
}

function encodeUint256(value) {
  return BigInt(value).toString(16).padStart(64, "0");
}

function decodeString(data) {
  if (!data || data === "0x") return null;
  const hex = strip0x(data);
  try {
    if (hex.length === 64) return Buffer.from(hex, "hex").toString("utf8").replace(/\u0000+$/g, "") || null;
    const offset = Number(BigInt("0x" + hex.slice(0, 64))) * 2;
    const len = Number(BigInt("0x" + hex.slice(offset, offset + 64))) * 2;
    return Buffer.from(hex.slice(offset + 64, offset + 64 + len), "hex").toString("utf8") || null;
  } catch (_) {
    return null;
  }
}

function decodeAddressArray(data) {
  const hex = strip0x(data);
  if (hex.length < 128) return null;
  try {
    const offset = Number(BigInt("0x" + hex.slice(0, 64))) * 2;
    const len = Number(BigInt("0x" + hex.slice(offset, offset + 64)));
    const values = [];
    for (let i = 0; i < Math.min(len, 128); i++) {
      values.push("0x" + hex.slice(offset + 64 + i * 64 + 24, offset + 128 + i * 64).toLowerCase());
    }
    return values;
  } catch (_) {
    return null;
  }
}

function decodeUintWords(data, count) {
  const hex = strip0x(data);
  const out = [];
  for (let i = 0; i < count && hex.length >= (i + 1) * 64; i++) {
    out.push(BigInt("0x" + hex.slice(i * 64, (i + 1) * 64)).toString());
  }
  return out;
}

function formatUnits(raw, decimals) {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const frac = raw % scale;
  const fracText = frac.toString().padStart(decimals, "0").replace(/0+$/, "").slice(0, 10);
  return fracText ? `${whole}.${fracText}` : whole.toString();
}

function extractPush4Selectors(bytecode) {
  const hex = strip0x(bytecode);
  const selectors = new Set();
  for (let i = 0; i < hex.length - 10; i += 2) {
    if (hex.slice(i, i + 2).toLowerCase() === "63") selectors.add("0x" + hex.slice(i + 2, i + 10).toLowerCase());
  }
  return [...selectors].sort();
}

async function callOptional(rpc, to, data) {
  try {
    const result = await rpcCall(rpc, "eth_call", [{ to, data }, "latest"]);
    return result && result !== "0x" ? result : null;
  } catch (_) {
    return null;
  }
}

async function tokenMeta(rpc, address) {
  const [nameRaw, symbolRaw, decimalsRaw, totalSupplyRaw] = await Promise.all([
    callOptional(rpc, address, CALLS.name),
    callOptional(rpc, address, CALLS.symbol),
    callOptional(rpc, address, CALLS.decimals),
    callOptional(rpc, address, CALLS.totalSupply),
  ]);
  const decimals = decimalsRaw ? Number(hexToBigInt(decimalsRaw)) : null;
  const totalSupply = hexToBigInt(totalSupplyRaw);
  return {
    address,
    name: decodeString(nameRaw),
    symbol: decodeString(symbolRaw),
    decimals,
    totalSupplyRaw: totalSupply?.toString() || null,
    totalSupply: formatUnits(totalSupply, decimals),
  };
}

async function tokenBalance(rpc, token, account, decimals) {
  const raw = await callOptional(rpc, token, CALLS.balanceOf + encodeAddress(account));
  const value = raw ? hexToBigInt(raw) : null;
  return { token, account, raw: value?.toString() || null, formatted: formatUnits(value, decimals) };
}

async function contractMeta(rpc, address) {
  const [code, implSlot, adminSlot] = await Promise.all([
    rpcCall(rpc, "eth_getCode", [address, "latest"]),
    rpcCall(rpc, "eth_getStorageAt", [address, IMPL_SLOT, "latest"]).catch(() => null),
    rpcCall(rpc, "eth_getStorageAt", [address, ADMIN_SLOT, "latest"]).catch(() => null),
  ]);
  return {
    address,
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    push4Selectors: extractPush4Selectors(code),
    eip1967Implementation: addressFromWord(implSlot),
    eip1967Admin: addressFromWord(adminSlot),
  };
}

async function erc4626Views(rpc, address, decimals) {
  const calls = {
    asset: CALLS.asset,
    totalAssets: CALLS.totalAssets,
    convertToAssets1e18: CALLS.convertToAssets1e18,
    convertToShares1e18: CALLS.convertToShares1e18,
    maxDepositSelf: CALLS.maxDepositSelf + encodeAddress(address),
    maxWithdrawSelf: CALLS.maxWithdrawSelf + encodeAddress(address),
    paused: CALLS.paused,
    owner: CALLS.owner,
    baseYieldAccrued: CALLS.baseYieldAccrued,
    claimableBaseYield: CALLS.claimableBaseYield,
    nav: CALLS.nav,
    depositSharePrice: CALLS.depositSharePrice,
    redemptionSharePrice: CALLS.redemptionSharePrice,
    redemptionQueueInfo: CALLS.redemptionQueueInfo,
    redemptionTimestamp: CALLS.redemptionTimestamp,
    totalShares: CALLS.totalShares,
    bridgedSupply: CALLS.bridgedSupply,
    baseToken: CALLS.baseToken,
    swapAdapter: CALLS.swapAdapter,
    depositCapInfo: CALLS.depositCapInfo,
    loanRouterBalances: CALLS.loanRouterBalances,
    whitelistedTokens: CALLS.whitelistedTokens,
    pools: CALLS.pools,
  };
  const result = {};
  for (const [name, data] of Object.entries(calls)) {
    const raw = await callOptional(rpc, address, data);
    if (!raw) continue;
    if (["asset", "owner", "baseToken", "swapAdapter"].includes(name)) result[name] = addressFromWord(raw);
    else if (name === "paused") result[name] = Boolean(hexToBigInt(raw));
    else if (["whitelistedTokens", "pools"].includes(name)) result[name] = decodeAddressArray(raw) || { raw };
    else if (["redemptionQueueInfo", "depositCapInfo", "loanRouterBalances"].includes(name)) result[name] = { raw, words: decodeUintWords(raw, name === "redemptionQueueInfo" ? 5 : name === "loanRouterBalances" ? 3 : 2) };
    else {
      const value = hexToBigInt(raw);
      result[name] = { raw: value?.toString() || null, formatted18: formatUnits(value, 18), formattedTokenDecimals: formatUnits(value, decimals) };
    }
  }
  return result;
}

async function queuedTokenViews(rpc, token) {
  const [isWhitelistedRaw, minRaw] = await Promise.all([
    callOptional(rpc, ADDRESSES.queuedDepositor, CALLS.isWhitelistedToken + encodeAddress(token)),
    callOptional(rpc, ADDRESSES.queuedDepositor, CALLS.whitelistedTokenMinAmount + encodeAddress(token)),
  ]);
  const queues = [];
  for (const queueType of [0, 1]) {
    const raw = await callOptional(
      rpc,
      ADDRESSES.queuedDepositor,
      CALLS.queueInfo + encodeUint256(queueType) + encodeAddress(token) + encodeUint256(0) + encodeUint256(5),
    );
    queues.push({ queueType, rawPresent: Boolean(raw), words: raw ? decodeUintWords(raw, 2) : [] });
  }
  const min = minRaw ? hexToBigInt(minRaw) : null;
  return {
    token,
    isWhitelisted: isWhitelistedRaw ? Boolean(hexToBigInt(isWhitelistedRaw)) : null,
    minAmountRaw: min?.toString() || null,
    queues,
  };
}

async function inspectLoanRouter(rpc) {
  const raw = await callOptional(rpc, ADDRESSES.loanRouter, CALLS.loanRouterBalances);
  return raw ? { raw, words: decodeUintWords(raw, 3) } : null;
}

async function inspectLegacyPool(rpc, address) {
  const meta = await contractMeta(rpc, address);
  const currencyRaw = await callOptional(rpc, address, CALLS.currencyToken);
  const currencyToken = addressFromWord(currencyRaw);
  const liquidityNodesRaw = await callOptional(rpc, address, CALLS.liquidityNodesAll);
  return {
    address,
    contract: meta,
    currencyToken,
    liquidityNodesBytes: liquidityNodesRaw ? strip0x(liquidityNodesRaw).length / 2 : 0,
    liquidityNodesRawPresent: Boolean(liquidityNodesRaw),
  };
}

async function main() {
  const rpc = await resolveArbitrumRpc();
  if (!rpc) throw new Error("missing Arbitrum RPC");
  const blockNumber = Number(BigInt(await rpcCall(rpc, "eth_blockNumber", [])));

  const contracts = {};
  for (const [name, address] of Object.entries(ADDRESSES)) {
    if (["wrappedM", "pyusd", "usdc", "usdt"].includes(name)) continue;
    const meta = await contractMeta(rpc, address);
    contracts[name] = { proxy: meta, implementation: meta.eip1967Implementation ? await contractMeta(rpc, meta.eip1967Implementation) : null };
  }

  const tokens = {};
  for (const [name, address] of Object.entries({ usdai: ADDRESSES.usdai, stakedUsdai: ADDRESSES.stakedUsdai, wrappedM: ADDRESSES.wrappedM, pyusd: ADDRESSES.pyusd, usdc: ADDRESSES.usdc, usdt: ADDRESSES.usdt })) {
    tokens[name] = await tokenMeta(rpc, address);
  }

  const views = {
    usdai: await erc4626Views(rpc, ADDRESSES.usdai, tokens.usdai.decimals),
    stakedUsdai: await erc4626Views(rpc, ADDRESSES.stakedUsdai, tokens.stakedUsdai.decimals),
    queuedDepositor: await erc4626Views(rpc, ADDRESSES.queuedDepositor, 18),
    queuedTokens: [
      await queuedTokenViews(rpc, ADDRESSES.usdc),
      await queuedTokenViews(rpc, ADDRESSES.usdt),
      await queuedTokenViews(rpc, ADDRESSES.pyusd),
    ],
    loanRouterBalances: await inspectLoanRouter(rpc),
  };

  const balanceOwners = [ADDRESSES.usdai, ADDRESSES.stakedUsdai, ADDRESSES.queuedDepositor, ADDRESSES.loanRouter];
  const balanceTokens = [tokens.wrappedM, tokens.pyusd, tokens.usdc, tokens.usdt];
  const balances = [];
  for (const token of balanceTokens) {
    for (const owner of balanceOwners) {
      balances.push(await tokenBalance(rpc, token.address, owner, token.decimals));
    }
  }

  const legacyPools = [
    await inspectLegacyPool(rpc, ADDRESSES.legacyPool1),
    await inspectLegacyPool(rpc, ADDRESSES.legacyPool2),
  ];

  const flags = [];
  for (const [name, meta] of Object.entries(contracts)) {
    if (meta.proxy.eip1967Implementation) flags.push(`${name}-proxy`);
  }
  if (views.usdai.asset && views.usdai.totalAssets) flags.push("usdai-erc4626-like");
  if (views.stakedUsdai.asset && views.stakedUsdai.totalAssets) flags.push("staked-usdai-erc4626-like");
  if (views.usdai.baseYieldAccrued?.raw && BigInt(views.usdai.baseYieldAccrued.raw) > 0n) flags.push("usdai-claimable-yield-present");
  if (views.stakedUsdai.claimableBaseYield?.raw && BigInt(views.stakedUsdai.claimableBaseYield.raw) > 0n) flags.push("staked-claimable-yield-present");
  if (views.stakedUsdai.depositSharePrice?.raw && views.stakedUsdai.redemptionSharePrice?.raw) {
    const deposit = BigInt(views.stakedUsdai.depositSharePrice.raw);
    const redemption = BigInt(views.stakedUsdai.redemptionSharePrice.raw);
    if (redemption > deposit) flags.push("redemption-price-above-deposit-price");
    if (deposit > redemption) flags.push("deposit-price-above-redemption-price");
  }
  if (views.stakedUsdai.redemptionQueueInfo?.words?.[3] && BigInt(views.stakedUsdai.redemptionQueueInfo.words[3]) > 0n) flags.push("redemption-queue-pending");
  if (balances.some((b) => b.account.toLowerCase() === ADDRESSES.queuedDepositor.toLowerCase() && b.raw && BigInt(b.raw) > 0n)) flags.push("queued-depositor-holds-assets");

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-usdai-arbitrum.js",
    safety: { rpcUrlsStored: false, signedActions: false },
    sources: [
      "https://api.llama.fi/protocol/usd-ai",
      "https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/usdai/index.js",
      "https://api.goldsky.com/api/public/project_clzibgddg2epg01ze4lq55scx/subgraphs/loan_router_arbitrum/0.0.3/gn",
    ],
    chain: "arbitrum",
    chainId: 42161,
    blockNumber,
    addresses: ADDRESSES,
    contracts,
    tokens,
    views,
    balances,
    legacyPools,
    flags,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");
  console.log(`wrote ${OUT}`);
  console.log(`arbitrum block=${blockNumber} flags=${flags.join(",")}`);
}

main().catch((e) => {
  console.error(e.stack || e.message || String(e));
  process.exitCode = 1;
});
