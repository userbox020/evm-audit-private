#!/usr/bin/env node
// scan-bridgers-growth-map.js - read-only Bridgers custody/trading contract map.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "bridgers-growth-map.json");

const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const SHARED_BRIDGERS = "0xb685760ebd368a891f27ae547391f4e2a289895b";

const ROWS = [
  {
    chain: "Ethereum",
    adapterKey: "ethereum",
    chainId: 1,
    address: SHARED_BRIDGERS,
    defillamaTvlKey: "Ethereum",
    tokens: [
      ["ETH", null],
      ["BUSD", "0x4Fabb145d64652a948d72533023f6E7A623C7C53"],
      ["USDC", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"],
      ["USDT", "0xdAC17F958D2ee523a2206206994597C13D831ec7"],
      ["DAI", "0x6B175474E89094C44Da98b954EedeAC495271d0F"],
      ["WBTC", "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599"],
      ["WETH", "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"],
      ["AAVE", "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9"],
      ["HT", "0x6f259637dcD74C767781E37Bc6133cd6A68aa161"],
      ["PEPE", "0x6982508145454Ce325dDbE47a25d4ec3d2311933"],
      ["WLD", "0x163f8C2467924be0ae7B5347228CABF260318753"],
    ],
  },
  {
    chain: "BNB Chain",
    adapterKey: "bsc",
    chainId: 56,
    address: SHARED_BRIDGERS,
    defillamaTvlKey: "Binance",
    tokens: [
      ["BNB", null],
      ["BUSD", "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56"],
      ["USDC", "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"],
      ["USDT", "0x55d398326f99059fF775485246999027B3197955"],
      ["DAI", "0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3"],
      ["WBNB", "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"],
      ["BTCB", "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c"],
      ["ETH", "0x2170Ed0880ac9A755fd29B2688956BD959F933F8"],
      ["DOGE", "0xbA2aE424d960c26247Dd6c32edC70B295c744C43"],
    ],
  },
  {
    chain: "Polygon",
    adapterKey: "polygon",
    chainId: 137,
    address: SHARED_BRIDGERS,
    defillamaTvlKey: "Polygon",
    tokens: [
      ["MATIC", null],
      ["USDC", "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"],
      ["USDT", "0xc2132D05D31c914a87C6611C10748AEb04B58e8F"],
      ["WMATIC", "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"],
      ["DAI", "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063"],
    ],
  },
  {
    chain: "Fantom",
    adapterKey: "fantom",
    chainId: 250,
    address: SHARED_BRIDGERS,
    defillamaTvlKey: "Fantom",
    tokens: [
      ["FTM", null],
      ["USDC", "0x04068DA6C83AFCFA0e13ba15A6696662335D5B75"],
      ["USDT", "0x049d68029688eAbF473097a2fC38ef61633A3C7A"],
      ["DAI", "0x8D11eC38a3EB5E956B052f67Da8Bdc9bef8Abf3E"],
      ["WETH", "0x74b23882a30290451A17c44f4F05243b6b58C76d"],
    ],
  },
  {
    chain: "Arbitrum",
    adapterKey: "arbitrum",
    chainId: 42161,
    address: SHARED_BRIDGERS,
    defillamaTvlKey: "Arbitrum",
    tokens: [
      ["ETH", null],
      ["ARB", "0x912CE59144191C1204E64559FE8253a0e49E6548"],
      ["USDC_CIRCLE", "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"],
      ["USDC", "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8"],
      ["USDT", "0xFd086bC7CD5C481DCC9C85ebe478A1C0b69FCbb9"],
    ],
  },
  {
    chain: "Base",
    adapterKey: "base",
    chainId: 8453,
    address: "0xa18968cc31232724f1dbd0d1e8d0b323d89f3501",
    defillamaTvlKey: "Base",
    tokens: [
      ["ETH", null],
      ["WETH", "0x4200000000000000000000000000000000000006"],
      ["USDbC", "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA"],
      ["USDC", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"],
    ],
  },
  {
    chain: "zkSync Era",
    adapterKey: "era",
    chainId: 324,
    address: "0x2042ecdc71f9ffb2eb9cda7f801eccc5c6c8b7eb",
    defillamaTvlKey: "zkSync Era",
    tokens: [
      ["ETH", null],
      ["USDT", "0x493257fD37EDB34451f62EDf8D2a0C418852bA4C"],
      ["USDC", "0x3355df6D4c9C3035724Fd0e3914dE96A5a83aaf4"],
    ],
  },
  {
    chain: "Linea",
    adapterKey: "linea",
    chainId: 59144,
    address: "0x8159891dfe9de7fc3bf1b665eb1adda60f2acd0e",
    defillamaTvlKey: "Linea",
    tokens: [
      ["ETH", null],
      ["USDT", "0xA219439258ca9da29E9Cc4cE5596924745e12B93"],
      ["USDC", "0x176211869cA2b568f2A7D4EE941E073a821EE1ff"],
    ],
  },
  {
    chain: "Optimism",
    adapterKey: "optimism",
    chainId: 10,
    address: SHARED_BRIDGERS,
    defillamaTvlKey: "Optimism",
    tokens: [
      ["ETH", null],
      ["OP", "0x4200000000000000000000000000000000000042"],
      ["USDC_CIRCLE", "0x0b2C639c533813f4Aa9D7837CAF62653d097Ff85"],
      ["USDT", "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58"],
      ["USDC", "0x7F5c764cBc14f9669B88837ca1490cCa17c31607"],
    ],
  },
  {
    chain: "Avalanche",
    adapterKey: "avax",
    chainId: 43114,
    address: SHARED_BRIDGERS,
    defillamaTvlKey: "Avalanche",
    tokens: [
      ["AVAX", null],
      ["USDt", "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7"],
      ["USDC", "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E"],
      ["USDT_e", "0xc7198437980c041c805A1EDcbA50c1Ce5db95118"],
      ["USDC_e", "0xA7D7079b0FEaD91F3e65f86E8915Cb59c1a4C664"],
      ["DAI", "0xd586E7F844cEa2F87f50152665BCbc2C279D8d70"],
      ["ETH", "0xf20d962a6c8f70c731bd838a3a388d7d48fa6e15"],
    ],
  },
  {
    chain: "OKExChain",
    adapterKey: "okexchain",
    chainId: 66,
    address: SHARED_BRIDGERS,
    defillamaTvlKey: "OKExChain",
    tokens: [["OKT", null]],
  },
];

const NON_EVM_ROWS = [
  { chain: "Tron", address: "TPwezUWpEGmFBENNWJHwXHRG1D2NCEEt5s", defillamaTvlKey: "Tron" },
  { chain: "Solana", address: "FDF8AxHB8UK7RS6xay6aBvwS3h7kez9gozqz14JyfKsg", defillamaTvlKey: "Solana" },
  { chain: "Sui", address: "0x2b0876f0b7034320ad6d2f378501fe92e41c8b4780bda7769094d2431170e532", defillamaTvlKey: "Sui" },
  { chain: "Aptos", address: "0x4512ba8a4862edcb20d5027a8d1b47129299d4bed9e41a8a727b78808d6faef4", defillamaTvlKey: "Aptos" },
  { chain: "TON", address: "EQA7x9ynlRUvgiWsQRUTTkLwznG3ZyFDKprejQej75HDTo54", defillamaTvlKey: "TON" },
];

function extractRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function rpcCall(url, method, params, timeoutMs = 15_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctrl.signal,
    });
    const json = await res.json();
    return json.result ?? null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, timeoutMs = 30_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveRpcPool() {
  const pool = {};
  for (const url of extractRpcUrls()) {
    const id = await rpcCall(url, "eth_chainId", [], 8000);
    if (!id) continue;
    const chainId = Number.parseInt(id, 16);
    if (!pool[chainId]) pool[chainId] = url;
  }
  return pool;
}

function cleanHex(hex) {
  const value = hex || "0x";
  return value.startsWith("0x") ? value.slice(2) : value;
}

function hexToBigInt(hex) {
  try {
    return BigInt(`0x${cleanHex(hex) || "0"}`);
  } catch (_) {
    return 0n;
  }
}

function wordToAddress(word) {
  const h = cleanHex(word).padStart(64, "0");
  const addr = `0x${h.slice(-40)}`;
  return /^0x0{40}$/i.test(addr) ? null : addr;
}

function padAddress(addr) {
  return cleanHex(addr).toLowerCase().padStart(64, "0");
}

function decodeString(hex) {
  const h = cleanHex(hex);
  if (!h || h.length < 64) return null;
  try {
    if (h.length >= 128) {
      const offset = Number(hexToBigInt(`0x${h.slice(0, 64)}`));
      const lenStart = offset * 2;
      const len = Number(hexToBigInt(`0x${h.slice(lenStart, lenStart + 64)}`));
      if (len > 0 && len < 256) {
        const data = h.slice(lenStart + 64, lenStart + 64 + len * 2);
        return Buffer.from(data, "hex").toString("utf8").replace(/\0+$/g, "") || null;
      }
    }
    return Buffer.from(h.slice(0, 64), "hex").toString("utf8").replace(/\0+$/g, "") || null;
  } catch (_) {
    return null;
  }
}

function humanAmount(raw, decimals = 18) {
  try {
    const value = BigInt(raw || 0);
    const d = Math.max(0, Number(decimals ?? 18));
    const scale = 10n ** BigInt(d);
    const whole = value / scale;
    const frac = value % scale;
    const fracText = frac.toString().padStart(d, "0").slice(0, 8).replace(/0+$/g, "");
    return Number(`${whole.toString()}${fracText ? "." + fracText : ""}`);
  } catch (_) {
    return null;
  }
}

async function ethCall(rpc, to, data) {
  const out = await rpcCall(rpc, "eth_call", [{ to, data }, "latest"]);
  return out && out !== "0x" ? out : null;
}

async function getCodeInfo(rpc, address) {
  const code = await rpcCall(rpc, "eth_getCode", [address, "latest"]);
  return { codePresent: !!code && code !== "0x", codeBytes: code && code !== "0x" ? cleanHex(code).length / 2 : 0 };
}

async function getBlock(rpc) {
  const block = await rpcCall(rpc, "eth_getBlockByNumber", ["latest", false]);
  return block ? { number: Number.parseInt(block.number, 16), timestamp: Number.parseInt(block.timestamp, 16) } : null;
}

async function getStorageAddress(rpc, address, slot) {
  const word = await rpcCall(rpc, "eth_getStorageAt", [address, slot, "latest"]);
  return wordToAddress(word || "0x0");
}

async function tokenBalance(rpc, token, holder) {
  if (!token.address) {
    const raw = hexToBigInt(await rpcCall(rpc, "eth_getBalance", [holder, "latest"]));
    return {
      configuredSymbol: token.symbol,
      address: null,
      symbol: token.symbol,
      decimals: 18,
      balanceRaw: raw.toString(),
      balance: humanAmount(raw.toString(), 18),
      codePresent: null,
      nonLosslessHint: false,
    };
  }
  const [code, symbolRaw, nameRaw, decimalsRaw, balanceRaw] = await Promise.all([
    getCodeInfo(rpc, token.address),
    ethCall(rpc, token.address, "0x95d89b41"),
    ethCall(rpc, token.address, "0x06fdde03"),
    ethCall(rpc, token.address, "0x313ce567"),
    ethCall(rpc, token.address, `0x70a08231${padAddress(holder)}`),
  ]);
  const decimals = decimalsRaw ? Number(hexToBigInt(decimalsRaw)) : null;
  const symbol = decodeString(symbolRaw) || token.symbol;
  const name = decodeString(nameRaw);
  const raw = balanceRaw ? hexToBigInt(balanceRaw) : 0n;
  const nonLosslessHint = /(fee|tax|reflect|rebase|rebasing|elastic|deflat|burn|scaled|shares|staked|vault|transferfee)/i.test(`${symbol || ""} ${name || ""}`);
  return {
    configuredSymbol: token.symbol,
    address: token.address,
    symbol,
    name,
    decimals,
    balanceRaw: raw.toString(),
    balance: decimals == null ? null : humanAmount(raw.toString(), decimals),
    codePresent: code.codePresent,
    codeBytes: code.codeBytes,
    nonLosslessHint,
  };
}

async function scanRow(rpcPool, row, protocol) {
  const rpc = rpcPool[row.chainId];
  const defillamaTvlUsd = Number(protocol?.currentChainTvls?.[row.defillamaTvlKey] || 0) || null;
  if (!rpc) {
    return {
      ...row,
      defillamaTvlUsd,
      rpcResolved: false,
      status: "rpc-unavailable",
      tokenBalances: [],
      watchCandidate: false,
      routePositive: false,
      signedActionJustified: false,
      blockers: ["RPC unavailable for chain", "No read-only contract/balance verification for this row"],
    };
  }
  const [block, contract, impl, admin, beacon] = await Promise.all([
    getBlock(rpc),
    getCodeInfo(rpc, row.address),
    getStorageAddress(rpc, row.address, IMPL_SLOT),
    getStorageAddress(rpc, row.address, ADMIN_SLOT),
    getStorageAddress(rpc, row.address, BEACON_SLOT),
  ]);
  const tokens = row.tokens.map(([symbol, address]) => ({ symbol, address }));
  const tokenBalances = await Promise.all(tokens.map((t) => tokenBalance(rpc, t, row.address)));
  const nonzeroBalances = tokenBalances.filter((t) => BigInt(t.balanceRaw || 0) > 0n);
  const nonLosslessHints = tokenBalances.filter((t) => t.nonLosslessHint);
  const blockers = [
    "Growth lead custody/trading map only; no balance-delta accounting mismatch proven",
    "No joined lending/oracle consumer route for Bridgers custody balances",
    "No exact cross-chain route economics, gas, or slippage proof",
    "No fork-positive extraction proof",
    "No signed-action authorization or route-specific executor",
  ];
  return {
    ...row,
    defillamaTvlUsd,
    rpcResolved: true,
    block,
    contract,
    proxy: { eip1967Implementation: impl, eip1967Admin: admin, eip1967Beacon: beacon },
    status: contract.codePresent ? "mapped-read-only" : "no-code-at-adapter-owner",
    tokenBalances,
    nonzeroBalances,
    nonLosslessHints,
    watchCandidate: false,
    routePositive: false,
    signedActionJustified: false,
    blockers,
  };
}

async function main() {
  const [rpcPool, protocol] = await Promise.all([
    resolveRpcPool(),
    fetchJson("https://api.llama.fi/protocol/bridgers", 45_000),
  ]);
  const rows = [];
  for (const row of ROWS) rows.push(await scanRow(rpcPool, row, protocol));
  const nonEvmRows = NON_EVM_ROWS.map((row) => ({
    ...row,
    defillamaTvlUsd: Number(protocol?.currentChainTvls?.[row.defillamaTvlKey] || 0) || null,
    status: "non-evm-not-scanned-by-this-tool",
    watchCandidate: false,
    routePositive: false,
    signedActionJustified: false,
  }));
  const report = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-bridgers-growth-map.js",
    scope: "Bridgers public-growth lead custody/trading contract map",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      publicProtocolMetadataFetched: true,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: false,
      signedActionJustified: false,
    },
    sources: [
      "https://api.llama.fi/protocol/bridgers",
      "https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/bridgers-ai/index.js",
      "https://bridgers.ai/",
    ],
    protocol: {
      name: protocol?.name || "Bridgers",
      category: protocol?.category || "Dexs",
      url: protocol?.url || "https://bridgers.ai/",
      audits: protocol?.audits ?? 2,
      auditLinks: protocol?.audit_links || ["https://skynet.certik.com/zh-CN/projects/swft"],
      latestTotalTvlUsd: protocol?.tvl?.at(-1)?.totalLiquidityUSD ?? null,
    },
    summary: {
      evmRowsInput: ROWS.length,
      evmRowsRpcResolved: rows.filter((r) => r.rpcResolved).length,
      evmRowsCodePresent: rows.filter((r) => r.contract?.codePresent).length,
      evmRowsNoCode: rows.filter((r) => r.rpcResolved && !r.contract?.codePresent).length,
      nonEvmRowsDocumented: nonEvmRows.length,
      rowsWithNonzeroConfiguredBalances: rows.filter((r) => r.nonzeroBalances?.length).length,
      nonLosslessHintTokens: rows.reduce((acc, r) => acc + (r.nonLosslessHints?.length || 0), 0),
      watchCandidates: 0,
      routePositive: 0,
      signedActionJustified: false,
    },
    routePositiveRequires: [
      "material custody/trading balances in non-lossless or mis-accounted tokens",
      "source and destination balance-delta mismatch proving over-credit",
      "joined DEX/lending/withdraw route with current liquidity",
      "gas/slippage/fees-adjusted positive economics",
      "local fork extraction proof before any signed action",
    ],
    rows,
    nonEvmRows,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Bridgers map: evmRows=${report.summary.evmRowsInput} rpcResolved=${report.summary.evmRowsRpcResolved} codePresent=${report.summary.evmRowsCodePresent} routePositive=${report.summary.routePositive}`);
  console.log(`Report: ${path.relative(WORKSPACE, OUT)}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
