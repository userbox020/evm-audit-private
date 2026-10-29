#!/usr/bin/env node
// scan-origin-arm-growth.js - read-only Origin ARM deployment and route gate map.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "origin-arm-growth-map.json");

const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const TOKENS = {
  WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  stETH: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84",
  OETH: "0x856c4Efb76C1D1AE02e20CEB03A2A6a08b0b8dC3",
  eETH: "0x35fA164735182de50811E8e2E824cFb9B6118ac2",
  sUSDe: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497",
  USDe: "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3",
  OS: "0xb1e25689D55734FD3ffFc939c4C3Eb52DFf8A794",
  wOS: "0x9F0dF7799f6FDAd409300080cfF680f5A23df4b1",
};

const ARMS = [
  {
    id: "origin-arm-oeth-weth",
    chainId: 1,
    label: "Origin ARM OETH/WETH",
    address: "0x6bac785889A4127dB0e0CeFEE88E0a9F1Aaf3cC7",
    baseToken: TOKENS.OETH,
    liquidityToken: TOKENS.WETH,
    docs: "https://docs.originprotocol.com/registry/contracts/arm-registry/origin-oeth-weth.md",
    owner: "0x35918cDE7233F2dD33fA41ae3Cb6aE0e42E0e69F",
    operator: "0x4b91827516f79d6F6a1F292eD99671663b09169a",
  },
  {
    id: "origin-arm-steth-weth",
    chainId: 1,
    label: "Lido ARM stETH/WETH",
    address: "0x85B78AcA6Deae198fBF201c82DAF6Ca21942acc6",
    baseToken: TOKENS.stETH,
    liquidityToken: TOKENS.WETH,
    docs: "https://docs.originprotocol.com/registry/contracts/arm-registry/lido-steth-weth.md",
    morphoMarket: "0x29c4Bb7B1eBcc53e8CBd16480B5bAe52C69806D3",
    capManager: "0xf54ebff575f699d281645c6F14Fe427dFFE629CF",
    withdrawalQueue: "0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1",
    morphoVault: "0x3Dfe70B05657949A5dB340754aD664810ac63b21",
  },
  {
    id: "origin-arm-eeth-weth",
    chainId: 1,
    label: "EtherFi ARM eETH/WETH",
    address: "0xfB0A3CF9B019BFd8827443d131b235B3E0FC58d2",
    baseToken: TOKENS.eETH,
    liquidityToken: TOKENS.WETH,
    docs: "https://docs.originprotocol.com/registry/contracts/arm-registry/etherfi-eeth-weth.md",
    morphoMarket: "0x8Cf42b82fFFa3E7714D62a2cA223acBeC1Eef095",
    capManager: "0xf2A18F7330141Ec737EB73A0A5Ea8E4d7e9bE7ec",
    withdrawalQueue: "0x308861A430be4cce5502d0A12724771Fc6DaF216",
    morphoVault: "0x3Dfe70B05657949A5dB340754aD664810ac63b21",
  },
  {
    id: "origin-arm-susde-usde",
    chainId: 1,
    label: "Ethena ARM sUSDe/USDe",
    address: "0xCEDa2d856238aA0D12f6329de20B9115f07C366d",
    baseToken: TOKENS.sUSDe,
    liquidityToken: TOKENS.USDe,
    docs: "https://docs.originprotocol.com/registry/contracts/arm-registry/ethena-susde-usde.md",
    aaveStrategy: "0x0DC20109Ea012f050BeDA184844c1eD5ec6dA33A",
    capManager: "0x687AFB5A52A15122fD5FC54A8B52cfd58346fb0C",
  },
  {
    id: "origin-arm-os-ws",
    chainId: 146,
    label: "Origin ARM OS/WS",
    address: "0x2F872623d1E1Af5835b08b0E49aAd2d81d649D30",
    baseToken: TOKENS.OS,
    liquidityToken: null,
    wrappedBaseToken: TOKENS.wOS,
    docs: "https://docs.originprotocol.com/registry/contracts/arm-registry/origin-os-ws.md",
  },
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

function encodeUint(value) {
  return BigInt(value).toString(16).padStart(64, "0");
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

async function ethCall(rpc, to, data) {
  const out = await rpcCall(rpc, "eth_call", [{ to, data }, "latest"]);
  return out && out !== "0x" ? out : null;
}

async function getBlock(rpc) {
  const block = await rpcCall(rpc, "eth_getBlockByNumber", ["latest", false]);
  return block ? { number: Number.parseInt(block.number, 16), timestamp: Number.parseInt(block.timestamp, 16) } : null;
}

async function getCodeInfo(rpc, address) {
  const code = await rpcCall(rpc, "eth_getCode", [address, "latest"]);
  return { codePresent: !!code && code !== "0x", codeBytes: code && code !== "0x" ? (cleanHex(code).length / 2) : 0 };
}

async function getStorageAddress(rpc, address, slot) {
  const word = await rpcCall(rpc, "eth_getStorageAt", [address, slot, "latest"]);
  return wordToAddress(word || "0x0");
}

async function tokenMeta(rpc, address) {
  if (!address) return null;
  const [code, symbolRaw, nameRaw, decimalsRaw, supplyRaw] = await Promise.all([
    getCodeInfo(rpc, address),
    ethCall(rpc, address, "0x95d89b41"),
    ethCall(rpc, address, "0x06fdde03"),
    ethCall(rpc, address, "0x313ce567"),
    ethCall(rpc, address, "0x18160ddd"),
  ]);
  const decimals = decimalsRaw ? Number(hexToBigInt(decimalsRaw)) : null;
  const totalSupplyRaw = supplyRaw ? hexToBigInt(supplyRaw) : null;
  return {
    address,
    ...code,
    symbol: decodeString(symbolRaw),
    name: decodeString(nameRaw),
    decimals,
    totalSupplyRaw: totalSupplyRaw == null ? null : totalSupplyRaw.toString(),
    totalSupply: totalSupplyRaw != null && decimals != null ? Number(totalSupplyRaw) / 10 ** decimals : null,
  };
}

async function tokenBalance(rpc, token, holder, decimals) {
  if (!token || !holder) return null;
  const raw = await ethCall(rpc, token, `0x70a08231${padAddress(holder)}`);
  if (!raw) return null;
  const value = hexToBigInt(raw);
  return { raw: value.toString(), human: decimals != null ? Number(value) / 10 ** decimals : null };
}

async function erc4626Probe(rpc, address, decimals) {
  const [assetRaw, totalAssetsRaw, oneShareAssetsRaw, oneAssetSharesRaw] = await Promise.all([
    ethCall(rpc, address, "0x38d52e0f"),
    ethCall(rpc, address, "0x01e1d114"),
    ethCall(rpc, address, `0x07a2d13a${encodeUint(10n ** BigInt(decimals || 18))}`),
    ethCall(rpc, address, `0xc6e6f592${encodeUint(10n ** BigInt(decimals || 18))}`),
  ]);
  return {
    isErc4626Like: !!assetRaw || !!totalAssetsRaw,
    asset: wordToAddress(assetRaw),
    totalAssetsRaw: totalAssetsRaw ? hexToBigInt(totalAssetsRaw).toString() : null,
    oneShareToAssetsRaw: oneShareAssetsRaw ? hexToBigInt(oneShareAssetsRaw).toString() : null,
    oneAssetToSharesRaw: oneAssetSharesRaw ? hexToBigInt(oneAssetSharesRaw).toString() : null,
  };
}

async function scanArm(rpcPool, arm) {
  const rpc = rpcPool[arm.chainId];
  if (!rpc) {
    return { ...arm, rpcResolved: false, routePositive: false, watchCandidate: false, blockers: ["RPC unavailable for chain"] };
  }
  const block = await getBlock(rpc);
  const [contract, impl, admin, beacon, baseMeta, liqMeta, wrappedBaseMeta] = await Promise.all([
    getCodeInfo(rpc, arm.address),
    getStorageAddress(rpc, arm.address, IMPL_SLOT),
    getStorageAddress(rpc, arm.address, ADMIN_SLOT),
    getStorageAddress(rpc, arm.address, BEACON_SLOT),
    tokenMeta(rpc, arm.baseToken),
    tokenMeta(rpc, arm.liquidityToken),
    tokenMeta(rpc, arm.wrappedBaseToken),
  ]);
  const armToken = await tokenMeta(rpc, arm.address);
  const [baseBalance, liquidityBalance, wrappedBaseBalance, nativeBalanceRaw, erc4626] = await Promise.all([
    tokenBalance(rpc, arm.baseToken, arm.address, baseMeta?.decimals),
    tokenBalance(rpc, arm.liquidityToken, arm.address, liqMeta?.decimals),
    tokenBalance(rpc, arm.wrappedBaseToken, arm.address, wrappedBaseMeta?.decimals),
    rpcCall(rpc, "eth_getBalance", [arm.address, "latest"]),
    erc4626Probe(rpc, arm.address, armToken?.decimals),
  ]);
  const externalContracts = {};
  for (const [key, value] of Object.entries(arm)) {
    if (["address", "baseToken", "liquidityToken", "wrappedBaseToken", "docs", "id", "label", "chainId", "owner", "operator"].includes(key)) continue;
    if (/^0x[0-9a-fA-F]{40}$/.test(String(value))) externalContracts[key] = { address: value, ...(await getCodeInfo(rpc, value)) };
  }
  const nativeBalance = nativeBalanceRaw ? hexToBigInt(nativeBalanceRaw) : 0n;
  const blockers = [
    "Growth lead mapping only; no current acquisition-vs-redemption quote-positive route",
    "ARM arbitrage pricing/queue timing not decoded into exact executable economics",
    "No fork-positive extraction proof",
    "No signed-action authorization or deployed route-specific executor",
  ];
  return {
    ...arm,
    rpcResolved: true,
    block,
    contract,
    proxy: { eip1967Implementation: impl, eip1967Admin: admin, eip1967Beacon: beacon },
    armToken,
    erc4626,
    baseToken: baseMeta,
    liquidityToken: liqMeta,
    wrappedBaseToken: wrappedBaseMeta,
    balances: {
      base: baseBalance,
      liquidity: liquidityBalance,
      wrappedBase: wrappedBaseBalance,
      nativeRaw: nativeBalance.toString(),
      nativeHuman: Number(nativeBalance) / 1e18,
    },
    documentedOperationalAccounts: { owner: arm.owner || null, operator: arm.operator || null },
    externalContracts,
    watchCandidate: false,
    routePositive: false,
    signedActionJustified: false,
    blockers,
  };
}

async function main() {
  const rpcPool = await resolveRpcPool();
  const rows = [];
  for (const arm of ARMS) rows.push(await scanArm(rpcPool, arm));
  const report = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-origin-arm-growth.js",
    scope: "Origin ARM public-growth lead deployment/source route map",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: false,
      signedActionJustified: false,
    },
    sourceDocs: [
      "https://docs.originprotocol.com/registry/contracts/arm-registry.md",
      "https://docs.originprotocol.com/automated-redemption-manager-arm/introduction-to-arm.md",
    ],
    summary: {
      armsInput: ARMS.length,
      armsMapped: rows.filter((r) => r.rpcResolved && r.contract?.codePresent).length,
      ethereumArmsMapped: rows.filter((r) => r.chainId === 1 && r.rpcResolved && r.contract?.codePresent).length,
      sonicArmsMapped: rows.filter((r) => r.chainId === 146 && r.rpcResolved && r.contract?.codePresent).length,
      erc4626Like: rows.filter((r) => r.erc4626?.isErc4626Like).length,
      watchCandidates: rows.filter((r) => r.watchCandidate).length,
      routePositive: rows.filter((r) => r.routePositive).length,
      signedActionJustified: false,
    },
    routePositiveRequires: [
      "decoded ARM pricing/queue/redemption state",
      "exact acquisition or sell quote for base/liquidity pair",
      "permissionless redemption/withdrawal path with timing accounted for",
      "gas/slippage/fees-adjusted positive net economics",
      "local fork extraction proof before any signed action",
    ],
    rows,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Origin ARM map: arms=${report.summary.armsInput} mapped=${report.summary.armsMapped} routePositive=${report.summary.routePositive}`);
  console.log(`Report: ${path.relative(WORKSPACE, OUT)}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
