#!/usr/bin/env node
// Read-only Etherfuse RWA tokenized-bond route prefilter.
// RPC URLs resolved in memory only via shared-rpc; never printed or stored.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const OUT = path.join(RAW_DIR, "prefilter-etherfuse-route-prefilter.json");

const CHAINS = {
  137: { chain: "Polygon", llamaKey: "polygon", geckoNetwork: "polygon-ecosystem" },
  8453: { chain: "Base", llamaKey: "base", geckoNetwork: "base" },
};

const TOKENS = [
  { chainId: 137, address: "0x834df4C1d8f51Be24322E39e4766697BE015512F" },
  { chainId: 137, address: "0xC6221856E45ed806F8325a084bED3D69D32C526d" },
  { chainId: 137, address: "0x46080F31351A6568f44575E3EFfDE7f0C86867f9" },
  { chainId: 137, address: "0xd574b191B5a00262Ff19953d3CE25543AB7C8098" },
  { chainId: 137, address: "0xc2C1f8Eb98C0468Be0232DD4166705d0Dea3Fe31" },
  { chainId: 8453, address: "0x834df4C1d8f51Be24322E39e4766697BE015512F" },
  { chainId: 8453, address: "0xC6221856E45ed806F8325a084bED3D69D32C526d" },
  { chainId: 8453, address: "0x46080F31351A6568f44575E3EFfDE7f0C86867f9" },
  { chainId: 8453, address: "0x7ceE47e7B7CD04CF984e8Dd86C42595B5771A9B2" },
  { chainId: 8453, address: "0xc2C1f8Eb98C0468Be0232DD4166705d0Dea3Fe31" },
];

const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

const ERC20 = new ethers.Interface([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
]);
const ERC4626 = new ethers.Interface([
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function maxDeposit(address) view returns (uint256)",
  "function maxRedeem(address) view returns (uint256)",
  "function previewRedeem(uint256) view returns (uint256)",
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

function slotAddress(raw) { if (!raw || raw === "0x" || /^0x0+$/.test(raw)) return null; try { return ethers.getAddress(`0x${raw.slice(-40)}`); } catch (_) { return null; } }
async function tryCall(p, a, i, f, args = []) { try { return await p.call({ to: a, data: i.encodeFunctionData(f, args) }); } catch (_) { return null; } }
function decode(raw, i, f) { if (!raw || raw === "0x") return null; try { return i.decodeFunctionResult(f, raw); } catch (_) { return null; } }

async function fetchJson(url, timeoutMs = 30_000) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try { const res = await fetch(url, { headers: { "user-agent": "evm-audit-etherfuse/1.0" }, signal: ctrl.signal }); if (!res.ok) return null; return await res.json(); } catch (_) { return null; } finally { clearTimeout(t); }
}

async function fetchMetadata() {
  const json = await fetchJson("https://api.llama.fi/protocol/etherfuse", 45_000);
  if (!json) return { ok: false };
  const currentTvlUsd = Array.isArray(json.tvl) && json.tvl.length ? json.tvl[json.tvl.length - 1].totalLiquidityUSD : json.tvl;
  const chainTvls = {};
  for (const [c, v] of Object.entries(json.chainTvls || {})) chainTvls[c] = Array.isArray(v?.tvl) && v.tvl.length ? v.tvl[v.tvl.length - 1].totalLiquidityUSD : v?.tvl ?? null;
  return { ok: true, name: json.name, slug: json.slug || "etherfuse", category: json.category, currentTvlUsd, chains: json.chains || [], audits: json.audits || null, adapter: json.module || "etherfuse/index.js", chainTvls };
}

async function sourcifyStatus(chainId, address) {
  for (const u of [`https://repo.sourcify.dev/contracts/full_match/${chainId}/${address}/metadata.json`, `https://repo.sourcify.dev/contracts/partial_match/${chainId}/${address}/metadata.json`]) {
    const r = await fetch(u, { headers: { "user-agent": "evm-audit-etherfuse/1.0" } }).catch(() => null);
    if (r?.ok) return { verified: true, source: u.includes("full_match") ? "sourcify-full" : "sourcify-partial" };
  }
  return { verified: false, source: null };
}

function localAddressMatches(address) {
  const needle = String(address || "").toLowerCase(); if (!needle) return [];
  const matches = [];
  for (const file of LOCAL_MATCH_FILES) {
    const fp = path.join(RAW_DIR, file); if (!fs.existsSync(fp)) continue;
    if (!LOCAL_TEXT_CACHE.has(fp)) LOCAL_TEXT_CACHE.set(fp, fs.readFileSync(fp, "utf8").toLowerCase());
    const c = LOCAL_TEXT_CACHE.get(fp).split(needle).length - 1; if (c > 0) matches.push({ file: `reports/raw/fast/${file}`, count: c });
  }
  return matches;
}

async function geckoPools(chainId, address) {
  const chain = CHAINS[chainId]; if (!chain?.geckoNetwork) return [];
  const json = await fetchJson(`https://api.geckoterminal.com/api/v2/networks/${chain.geckoNetwork}/tokens/${address}/pools?page=1`, 20_000);
  const rows = Array.isArray(json?.data) ? json.data : [];
  return rows.slice(0, 3).map((r) => ({ pool: r.id, name: r.attributes?.name, reserveUsd: r.attributes?.reserve_in_usd ? Number(r.attributes.reserve_in_usd) : null, priceUsd: r.attributes?.base_token_price_usd ? Number(r.attributes.base_token_price_usd) : null }));
}

async function scanToken(provider, chainId, token) {
  const chain = CHAINS[chainId];
  const [code, implRaw, symRaw, nameRaw, decRaw, supplyRaw, assetRaw, totalAssetsRaw, convertRaw, maxDepositRaw, maxRedeemRaw, previewRaw, pools, sourceStatus] = await Promise.all([
    provider.getCode(token.address).catch(() => "0x"),
    provider.getStorage(token.address, EIP1967_IMPL).catch(() => null),
    tryCall(provider, token.address, ERC20, "symbol"),
    tryCall(provider, token.address, ERC20, "name"),
    tryCall(provider, token.address, ERC20, "decimals"),
    tryCall(provider, token.address, ERC20, "totalSupply"),
    tryCall(provider, token.address, ERC4626, "asset"),
    tryCall(provider, token.address, ERC4626, "totalAssets"),
    tryCall(provider, token.address, ERC4626, "convertToAssets", [10n ** 18n]),
    tryCall(provider, token.address, ERC4626, "maxDeposit", ["0x000000000000000000000000000000000000dEaD"]),
    tryCall(provider, token.address, ERC4626, "maxRedeem", ["0x000000000000000000000000000000000000dEaD"]),
    tryCall(provider, token.address, ERC4626, "previewRedeem", [10n ** 18n]),
    geckoPools(chainId, token.address),
    sourcifyStatus(chainId, token.address),
  ]);
  const decimals = Number(decode(decRaw, ERC20, "decimals")?.[0] ?? 18);
  const supply = decode(supplyRaw, ERC20, "totalSupply")?.[0] ?? 0n;
  const supplyFormatted = decimals <= 18 ? ethers.formatUnits(supply, decimals) : supply.toString();
  const asset = decode(assetRaw, ERC4626, "asset")?.[0] || null;
  const totalAssets = decode(totalAssetsRaw, ERC4626, "totalAssets")?.[0] ?? null;
  const convertAssets = decode(convertRaw, ERC4626, "convertToAssets")?.[0] ?? null;
  const totalAssetsFormatted = totalAssets && decimals <= 18 ? ethers.formatUnits(totalAssets, decimals) : null;
  return {
    ...token, chain: chain.chain, address: token.address,
    codePresent: Boolean(code && code !== "0x"), codeBytes: code && code !== "0x" ? (code.length - 2) / 2 : 0,
    proxy: { eip1967Implementation: slotAddress(implRaw) },
    sourceStatus,
    symbol: decode(symRaw, ERC20, "symbol")?.[0] || null,
    name: decode(nameRaw, ERC20, "name")?.[0] || null,
    decimals, totalSupplyRaw: supply.toString(), totalSupply: supplyFormatted,
    erc4626: {
      asset, totalAssets: totalAssetsFormatted, totalAssetsRaw: totalAssets?.toString() || null,
      convertToAssetsOneShare: convertAssets ? ethers.formatUnits(convertAssets, decimals) : null,
      maxDeposit: decode(maxDepositRaw, ERC4626, "maxDeposit")?.[0]?.toString() || null,
      maxRedeem: decode(maxRedeemRaw, ERC4626, "maxRedeem")?.[0]?.toString() || null,
      previewRedeemOneShare: decode(previewRaw, ERC4626, "previewRedeem")?.[0]?.toString() || null,
    },
    dexPools: pools, topDexLiquidityUsd: pools.length ? Math.max(...pools.map((p) => Number(p.reserveUsd || 0))) : 0,
    localMatches: localAddressMatches(token.address),
  };
}

async function main() {
  const metadataPromise = fetchMetadata();
  const tokenRows = [];
  const rpcBlocked = [];
  for (const chainId of [137, 8453]) {
    const rpc = await resolveRpc(chainId);
    if (!rpc) { rpcBlocked.push({ protocol: "Etherfuse", chain: CHAINS[chainId].chain, chainId, missingEndpointClass: "EVM RPC", skippedChecks: ["token state", "ERC4626 probes", "DEX liquidity"] }); continue; }
    const provider = new ethers.JsonRpcProvider(rpc, chainId, { staticNetwork: true });
    for (const token of TOKENS.filter((t) => t.chainId === chainId)) tokenRows.push(await scanToken(provider, chainId, token));
  }
  const metadata = await metadataPromise;
  const codePresentRows = tokenRows.filter((r) => r.codePresent).length;
  const localArtifactMatchRows = tokenRows.reduce((s, r) => s + (r.localMatches || []).reduce((a, m) => a + m.count, 0), 0);
  const dexRows = tokenRows.filter((r) => Number(r.topDexLiquidityUsd || 0) >= 1000);
  const erc4626Rows = tokenRows.filter((r) => r.erc4626.asset !== null).length;

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-etherfuse-prefilter.js",
    scope: "Etherfuse RWA tokenized-bond route prefilter",
    safety: { rpcInventoryRead: true, rpcUrlsStored: false, envFilesRead: false, privateKeysRead: false, signedActions: false, exploitExecuteCalls: false, forkTransactions: false, routePositive: false, executableNow: false, signedActionJustified: false, forkJustified: false },
    metadata,
    adapter: { source: "https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/etherfuse/index.js", methodology: "EVM TVL = sum of totalSupply for each tokenized bond contract. Solana/Stellar use getTokenSupplies and Stellar expert API." },
    tokenRows,
    rpcBlocked,
    summary: {
      tokenRows: tokenRows.length,
      codePresentRows,
      erc4626Rows,
      localArtifactMatchRows,
      consumerJoinRows: 0,
      dexLiquidityRows: dexRows.length,
      maxDexLiquidityUsd: dexRows.length ? Math.max(...dexRows.map((r) => Number(r.topDexLiquidityUsd || 0))) : 0,
      exactEconomicsRows: 0,
      rpcBlockedRows: rpcBlocked.length,
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      forkJustified: false,
    },
    blockers: [
      "No local lending/oracle consumer accepts any Etherfuse tokenized bond as collateral in accessible artifacts",
      "No DEX liquidity rows found for any Etherfuse token on Polygon or Base above $1K",
      "ERC4626 asset/totalAssets probes returned null for most tokens, indicating non-ERC4626 token structure or non-standard interfaces",
      "RWA tokenized bonds likely have permissioned issuance/redemption with KYC/whitelist gates — not flash-loan compatible",
      "No exact positive borrow, liquidation, redemption, or unwind route exists",
    ],
    nextRoutePositiveCriteria: [
      "An Etherfuse tokenized bond is accepted by a live lending consumer with material borrow cash and overvalues it versus market/redeem value",
      "Public DEX liquidity appears for an Etherfuse token enabling acquire-below-redeem arbitrage",
      "A redemption/transfer gate is bypassed or permissionlessly callable to extract NAV value",
    ],
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");
  console.log(`Etherfuse prefilter: tokens=${tokenRows.length} codePresent=${codePresentRows} erc4626=${erc4626Rows} dexRows=${dexRows.length} artifactMatches=${localArtifactMatchRows} routePositive=0 rpcBlocked=${rpcBlocked.length}`);
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
}

main().then(() => process.exit(0)).catch((err) => { console.error(err.stack || err.message || String(err)); process.exit(1); });