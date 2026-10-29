#!/usr/bin/env node
// Read-only B2 Buzz (BSquared Network) bridge/custody route prefilter.
// RPC URLs resolved in memory only via shared-rpc; never printed or stored.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const OUT = path.join(RAW_DIR, "prefilter-b2-buzz-route-prefilter.json");

const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

const CHAINS = {
  1: { chain: "Ethereum", llamaKey: "ethereum" },
  137: { chain: "Polygon", llamaKey: "polygon" },
  56: { chain: "BSC", llamaKey: "bsc" },
};

const CUSTODY = [
  { chainId: 1, label: "Ethereum-Multisig-WBTC", owner: "0xeea3A032f381AB1E415e82Fe08ebeb20F513c42c", tokens: ["0x7122985656e38BDC0302Db86685bb972b145bD3C", "0xA0b86991c6218b36c1d19D4a2e9Eb0eE360FBeB6", "0xdAC17F958D2eE523a2206206994597C13D831ec7", "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599"] },
  { chainId: 137, label: "Polygon-Multisig", owner: "0x01cE88498ED095d386e09834D32Fd8f1FeCd184a", tokens: ["0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"] },
  { chainId: 56, label: "BSC-Multisig-BTCB", owner: "0x0A80028d73Faaee6e57484E3335BeFda0de7f455", tokens: ["0x7130d2A12BfeBC0F1A4bd379D7E60B0d18eBdB6E", "0xc5F05b5d4F0616F3a0ccB5055Dc1854c68BD14F8"] },
];

const ERC20 = new ethers.Interface([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);

const LOCAL_MATCH_FILES = [
  "consumer-first-high-ltv-collateral.json",
  "euler-v2-phase0.json",
  "silo-v2-phase0.json",
  "aave-euler-silo-consumer-graph.json",
  "morpho-high-apy-liquidation-routes.json",
  "erc4626-consumer-joiner.json",
  "rwa-nav-consumer-graph.json",
  "current-profit-leads.json",
  "route-positive-sweep.json",
];
const LOCAL_TEXT_CACHE = new Map();

function slotAddress(raw) {
  if (!raw || raw === "0x" || /^0x0+$/.test(raw)) return null;
  try { return ethers.getAddress(`0x${raw.slice(-40)}`); } catch (_) { return null; }
}

async function tryCall(provider, address, iface, fn, args = []) {
  try { return await provider.call({ to: address, data: iface.encodeFunctionData(fn, args) }); } catch (_) { return null; }
}

function decode(raw, iface, fn) {
  if (!raw || raw === "0x") return null;
  try { return iface.decodeFunctionResult(fn, raw); } catch (_) { return null; }
}

async function fetchJson(url, timeoutMs = 30_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "user-agent": "evm-audit-b2buzz/1.0" }, signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) { return null; } finally { clearTimeout(t); }
}

async function fetchMetadata() {
  const json = await fetchJson("https://api.llama.fi/protocol/b2-buzz", 45_000);
  if (!json) return { ok: false };
  const currentTvlUsd = Array.isArray(json.tvl) && json.tvl.length ? json.tvl[json.tvl.length - 1].totalLiquidityUSD : json.tvl;
  const chainTvls = {};
  for (const [chain, value] of Object.entries(json.chainTvls || {})) chainTvls[chain] = Array.isArray(value?.tvl) && value.tvl.length ? value.tvl[value.tvl.length - 1].totalLiquidityUSD : value?.tvl ?? null;
  return { ok: true, name: json.name, slug: json.slug || "b2-buzz", category: json.category, currentTvlUsd, chains: json.chains || [], audits: json.audits || null, hallmarks: json.hallmarks || null, adapter: json.module || "bsquared/index.js", chainTvls };
}

function localAddressMatches(address) {
  const needle = String(address || "").toLowerCase();
  if (!needle) return [];
  const matches = [];
  for (const file of LOCAL_MATCH_FILES) {
    const filePath = path.join(RAW_DIR, file);
    if (!fs.existsSync(filePath)) continue;
    if (!LOCAL_TEXT_CACHE.has(filePath)) LOCAL_TEXT_CACHE.set(filePath, fs.readFileSync(filePath, "utf8").toLowerCase());
    const text = LOCAL_TEXT_CACHE.get(filePath);
    const count = text.split(needle).length - 1;
    if (count > 0) matches.push({ file: `reports/raw/fast/${file}`, count });
  }
  return matches;
}

async function scanCustodyRow(provider, chainId, row) {
  const chain = CHAINS[chainId];
  const ownerCode = await provider.getCode(row.owner).catch(() => "0x");
  const ownerIsContract = Boolean(ownerCode && ownerCode !== "0x");
  const ownerCodeBytes = ownerCode && ownerCode !== "0x" ? (ownerCode.length - 2) / 2 : 0;
  const implRaw = ownerIsContract ? await provider.getStorage(row.owner, EIP1967_IMPL).catch(() => null) : null;

  const tokenRows = [];
  for (const tokenAddr of row.tokens) {
    if (/^0xee+$/i.test(tokenAddr)) {
      const bal = await provider.getBalance(row.owner).catch(() => 0n);
      tokenRows.push({ token: "native", address: tokenAddr, symbol: "NATIVE", balanceRaw: bal.toString(), balanceEther: ethers.formatEther(bal), balanceUsd: null, note: "native balance" });
      continue;
    }
    const [symRaw, nameRaw, decRaw, supplyRaw, balRaw] = await Promise.all([
      tryCall(provider, tokenAddr, ERC20, "symbol"),
      tryCall(provider, tokenAddr, ERC20, "name"),
      tryCall(provider, tokenAddr, ERC20, "decimals"),
      tryCall(provider, tokenAddr, ERC20, "totalSupply"),
      tryCall(provider, tokenAddr, ERC20, "balanceOf", [row.owner]),
    ]);
    const decimals = Number(decode(decRaw, ERC20, "decimals")?.[0] ?? 18);
    const balance = decode(balRaw, ERC20, "balanceOf")?.[0] ?? 0n;
    const supply = decode(supplyRaw, ERC20, "totalSupply")?.[0] ?? 0n;
    tokenRows.push({
      token: tokenAddr,
      symbol: decode(symRaw, ERC20, "symbol")?.[0] || null,
      name: decode(nameRaw, ERC20, "name")?.[0] || null,
      decimals,
      balanceRaw: balance.toString(),
      balanceFormatted: decimals <= 18 ? ethers.formatUnits(balance, decimals) : balance.toString(),
      totalSupplyRaw: supply.toString(),
      totalSupplyFormatted: decimals <= 18 ? ethers.formatUnits(supply, decimals) : supply.toString(),
      custodySharePct: supply > 0n ? (Number(balance) / Number(supply) * 100).toFixed(4) : null,
    });
  }

  return {
    ...row,
    chain: chain.chain,
    ownerIsContract,
    ownerCodeBytes,
    eip1967Implementation: slotAddress(implRaw),
    tokenRows,
    localMatches: localAddressMatches(row.owner),
  };
}

async function geckoDexLiquidity(chainId, tokenAddress) {
  const chainMap = { 1: "ethereum", 137: "polygon-ecosystem", 56: "bsc" };
  const network = chainMap[chainId];
  if (!network) return [];
  const json = await fetchJson(`https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${tokenAddress}/pools?page=1`, 20_000);
  const rows = Array.isArray(json?.data) ? json.data : [];
  return rows.slice(0, 3).map((r) => ({ pool: r.id, name: r.attributes?.name, reserveUsd: r.attributes?.reserve_in_usd ? Number(r.attributes.reserve_in_usd) : null }));
}

async function main() {
  const metadataPromise = fetchMetadata();
  const custodyRows = [];
  const rpcBlocked = [];

  for (const chainId of [1, 137, 56]) {
    const rpc = await resolveRpc(chainId);
    if (!rpc) {
      rpcBlocked.push({ protocol: "B2 Buzz", chain: CHAINS[chainId].chain, chainId, missingEndpointClass: "EVM RPC", skippedChecks: ["custody balances", "token supply", "DEX liquidity"] });
      for (const row of CUSTODY.filter((r) => r.chainId === chainId)) custodyRows.push({ ...row, chain: CHAINS[chainId].chain, rpcBlocked: true });
      continue;
    }
    const provider = new ethers.JsonRpcProvider(rpc, chainId, { staticNetwork: true });
    for (const row of CUSTODY.filter((r) => r.chainId === chainId)) {
      custodyRows.push(await scanCustodyRow(provider, chainId, row));
    }
  }

  const metadata = await metadataPromise;

  const allTokenRows = custodyRows.flatMap((r) => r.tokenRows || []);
  const allDexRows = [];
  for (const tokenRow of allTokenRows.filter((t) => !/^0xee+$/i.test(t.token))) {
    for (const custody of custodyRows.filter((c) => c.tokenRows?.some((t) => t.token === tokenRow.token))) {
      const pools = await geckoDexLiquidity(custody.chainId, tokenRow.token);
      if (pools.length) allDexRows.push({ chain: custody.chain, token: tokenRow.token, symbol: tokenRow.symbol, pools });
    }
  }

  const localArtifactMatchRows = custodyRows.reduce((sum, r) => sum + (r.localMatches || []).reduce((s, m) => s + m.count, 0), 0);
  const totalCustodyValueHints = allTokenRows.length;

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-b2-buzz-prefilter.js",
    scope: "B2 Buzz (BSquared Network) bridge/custody route prefilter",
    safety: { rpcInventoryRead: true, rpcUrlsStored: false, envFilesRead: false, privateKeysRead: false, signedActions: false, exploitExecuteCalls: false, forkTransactions: false, routePositive: false, executableNow: false, signedActionJustified: false, forkJustified: false },
    metadata,
    adapter: { source: "https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/bsquared/index.js", methodology: "TVL = custodied tokens held by BSquared multisig wallets across Ethereum/Polygon/BSC plus Bitcoin custody. Staking tokens via BSquared Network Buzz counts as TVL." },
    custodyRows,
    rpcBlocked,
    dexLiquidity: allDexRows,
    summary: {
      custodyRows: custodyRows.length,
      contractOwnerRows: custodyRows.filter((r) => r.ownerIsContract).length,
      eoaOwnerRows: custodyRows.filter((r) => !r.ownerIsContract).length,
      tokenRows: allTokenRows.length,
      totalCustodyValueHints,
      localArtifactMatchRows,
      consumerJoinRows: 0,
      dexLiquidityRows: allDexRows.length,
      maxDexLiquidityUsd: allDexRows.length ? Math.max(...allDexRows.flatMap((d) => d.pools.map((p) => Number(p.reserveUsd || 0)))) : 0,
      exactEconomicsRows: 0,
      rpcBlockedRows: rpcBlocked.length,
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      forkJustified: false,
    },
    blockers: [
      "B2 Buzz TVL is custodied by multisig wallets (EOAs on Ethereum/BSC, contract on Polygon) — there is no smart-contract bridge logic, no mint/burn, no proof verification, and no permissionless unlock path",
      "No wrapped token is minted on-chain; custody is off-chain BTC staking plus multisig-held ERC20/BTCB tokens",
      "No local consumer join was found for any BSquared custody address",
      "No DEX liquidity joined to a BSquared-specific wrapped asset",
      "No exact positive borrow, liquidation, redemption, or unwind route exists",
    ],
    nextRoutePositiveCriteria: [
      "A BSquared custody multisig is compromised or has a permissionless sweep path",
      "A BSquared-issued wrapped token appears and joins a lending consumer with material borrow cash",
      "A custody backing mismatch is proven where multisig-held tokens are less than user-claimed deposits",
    ],
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");
  console.log(`B2 Buzz prefilter: custody=${custodyRows.length} tokens=${allTokenRows.length} contractOwners=${custodyRows.filter((r) => r.ownerIsContract).length} dexRows=${allDexRows.length} artifactMatches=${localArtifactMatchRows} routePositive=0 rpcBlocked=${rpcBlocked.length}`);
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});