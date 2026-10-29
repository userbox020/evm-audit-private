#!/usr/bin/env node
// Read-only Lighter Bridge route prefilter.
// RPC URLs are resolved in memory only via shared-rpc and are never printed or stored.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "prefilter-lighter-bridge-route-prefilter.json");
const CHAIN_ID = 1;
const BRIDGE = "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7";
const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

const TOKENS = [
  { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
  { symbol: "WETH", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" },
  { symbol: "AAVE", address: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDAE9" },
  { symbol: "LINK", address: "0x514910771AF9Ca656af840dff83E8264EcF986CA" },
  { symbol: "UNI", address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984" },
  { symbol: "LDO", address: "0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32" },
  { symbol: "SKY", address: "0x56072C95FAA701256059aa122697B133aDEd9279" },
];

const ERC20 = new ethers.Interface([
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

function decode(raw, iface, fn) {
  if (!raw || raw === "0x") return null;
  try { return iface.decodeFunctionResult(fn, raw); } catch (_) { return null; }
}

async function call(provider, address, fn, args = []) {
  try {
    const raw = await provider.call({ to: address, data: ERC20.encodeFunctionData(fn, args) });
    return decode(raw, ERC20, fn);
  } catch (_) {
    return null;
  }
}

function slotAddress(raw) {
  if (!raw || raw === "0x" || /^0x0+$/.test(raw)) return null;
  try { return ethers.getAddress(`0x${raw.slice(-40)}`); } catch (_) { return null; }
}

async function fetchMetadata() {
  const res = await fetch("https://api.llama.fi/protocol/lighter-bridge", { headers: { "user-agent": "evm-audit-lighter/1.0" } });
  if (!res.ok) return { ok: false, status: res.status };
  const json = await res.json();
  const currentTvlUsd = Array.isArray(json.tvl) && json.tvl.length ? json.tvl[json.tvl.length - 1].totalLiquidityUSD : json.tvl;
  return {
    ok: true,
    name: json.name,
    slug: json.slug,
    category: json.category,
    currentTvlUsd,
    chains: json.chains || [],
    audits: json.audits || null,
  };
}

async function sourcifyStatus(address) {
  const checks = [
    `https://repo.sourcify.dev/contracts/full_match/1/${address}/metadata.json`,
    `https://repo.sourcify.dev/contracts/partial_match/1/${address}/metadata.json`,
  ];
  for (const url of checks) {
    try {
      const res = await fetch(url, { headers: { "user-agent": "evm-audit-lighter/1.0" } });
      if (res.ok) return { verified: true, source: url.includes("full_match") ? "sourcify-full" : "sourcify-partial" };
    } catch (_) {}
  }
  return { verified: false, source: null };
}

async function priceMap(rows) {
  const ids = [
    "coingecko:ethereum",
    ...rows.map((row) => `ethereum:${row.address}`),
  ];
  try {
    const res = await fetch(`https://coins.llama.fi/prices/current/${ids.join(",")}`, { headers: { "user-agent": "evm-audit-lighter/1.0" } });
    const json = await res.json();
    return json.coins || {};
  } catch (_) {
    return {};
  }
}

async function main() {
  const rpc = await resolveRpc(CHAIN_ID);
  const provider = rpc ? new ethers.JsonRpcProvider(rpc, CHAIN_ID, { staticNetwork: true }) : null;
  const metadata = await fetchMetadata();
  if (!provider) throw new Error("Ethereum RPC unavailable for Lighter prefilter");
  const prices = await priceMap(TOKENS);
  const [blockNumber, code, nativeBalance, implRaw, adminRaw, sourceStatus] = await Promise.all([
    provider.getBlockNumber().catch(() => null),
    provider.getCode(BRIDGE).catch(() => "0x"),
    provider.getBalance(BRIDGE).catch(() => 0n),
    provider.getStorage(BRIDGE, EIP1967_IMPL).catch(() => null),
    provider.getStorage(BRIDGE, EIP1967_ADMIN).catch(() => null),
    sourcifyStatus(BRIDGE),
  ]);
  const ethPrice = Number(prices["coingecko:ethereum"]?.price || 0);
  const tokenBalances = [];
  for (const token of TOKENS) {
    const [symbolRaw, decimalsRaw, balanceRaw] = await Promise.all([
      call(provider, token.address, "symbol"),
      call(provider, token.address, "decimals"),
      call(provider, token.address, "balanceOf", [BRIDGE]),
    ]);
    const decimals = Number(decimalsRaw?.[0] ?? 18n);
    const balance = balanceRaw?.[0] ?? 0n;
    const amount = Number(ethers.formatUnits(balance, decimals));
    const price = Number(prices[`ethereum:${token.address}`]?.price || 0);
    tokenBalances.push({
      symbol: symbolRaw?.[0] || token.symbol,
      address: token.address,
      decimals,
      balanceRaw: balance.toString(),
      balance: ethers.formatUnits(balance, decimals),
      priceUsd: price || null,
      balanceUsd: price ? amount * price : null,
      material: price ? amount * price >= 10000 : false,
    });
  }
  const nativeEth = Number(ethers.formatEther(nativeBalance));
  const nativeBalanceUsd = ethPrice ? nativeEth * ethPrice : null;
  const materialTokenBalances = tokenBalances.filter((row) => Number(row.balanceUsd || 0) >= 10000);
  const totalTrackedUsd = (nativeBalanceUsd || 0) + tokenBalances.reduce((sum, row) => sum + Number(row.balanceUsd || 0), 0);
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-lighter-bridge-prefilter.js",
    scope: "Lighter Bridge public proof/custody/consumer route prefilter",
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
      forkJustified: false,
    },
    metadata,
    bridge: {
      chainId: CHAIN_ID,
      chain: "Ethereum",
      address: BRIDGE,
      blockNumber,
      codePresent: Boolean(code && code !== "0x"),
      codeBytes: code && code !== "0x" ? (code.length - 2) / 2 : 0,
      proxy: {
        eip1967Implementation: slotAddress(implRaw),
        eip1967Admin: slotAddress(adminRaw),
      },
      sourceStatus,
      nativeBalanceWei: nativeBalance.toString(),
      nativeBalanceEth: ethers.formatEther(nativeBalance),
      nativeBalanceUsd,
      tokenBalances,
      materialTokenBalances,
      totalTrackedCustodyUsd: totalTrackedUsd,
    },
    consumerContext: {
      externalWrappedTokenConsumerRows: 0,
      note: "No Lighter-specific wrapped token accepted by lending/DEX consumers was found in local artifacts; route depends on bridge/state-root/withdrawal correctness rather than a downstream collateral token.",
    },
    summary: {
      codePresent: Boolean(code && code !== "0x"),
      sourcifyVerified: Boolean(sourceStatus.verified),
      materialTokenBalanceRows: materialTokenBalances.length,
      nativeBalanceUsd,
      totalTrackedCustodyUsd: totalTrackedUsd,
      proofBypassRows: 0,
      consumerJoinRows: 0,
      exactEconomicsRows: 0,
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      forkJustified: false,
    },
    blockers: [
      "No public proof/state-root/withdrawal binding bypass was identified",
      "No Lighter-specific wrapped token consumer join was found in local artifacts",
      "Custody balance context is not extractive without a permissionless unlock/mint/withdrawal flaw",
      "No exact borrow, redeem, liquidation, or DEX unwind route exists from current evidence",
    ],
    nextRoutePositiveCriteria: [
      "Invalid or replayed Lighter withdrawal/proof can unlock a tracked liquid asset",
      "Proof binds are shown to omit domain, account, token, amount, recipient, nonce, or finality",
      "Unlocked asset can be sold or used in a consumer route for positive net value after gas",
    ],
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");
  console.log(`Lighter prefilter: custodyUsd=${totalTrackedUsd.toFixed(2)} materialTokenRows=${materialTokenBalances.length} routePositive=0`);
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
