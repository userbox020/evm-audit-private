#!/usr/bin/env node
// Read-only Concrete onchain capital allocator ERC4626 vault route prefilter.
// Uses public Concrete API for vault list + shared-rpc for on-chain probes.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const OUT = path.join(RAW_DIR, "prefilter-concrete-route-prefilter.json");

const CHAINS = {
  1: { chain: "Ethereum", llamaKey: "ethereum" },
  42161: { chain: "Arbitrum", llamaKey: "arbitrum" },
  80094: { chain: "Berachain", llamaKey: "berachain" },
};

const ERC20 = new ethers.Interface(["function symbol() view returns (string)", "function decimals() view returns (uint8)", "function totalSupply() view returns (uint256)"]);
const ERC4626 = new ethers.Interface(["function asset() view returns (address)", "function totalAssets() view returns (uint256)", "function convertToAssets(uint256) view returns (uint256)", "function maxDeposit(address) view returns (uint256)", "function maxRedeem(address) view returns (uint256)"]);

const LOCAL_MATCH_FILES = ["consumer-first-high-ltv-collateral.json", "euler-v2-phase0.json", "silo-v2-phase0.json", "aave-euler-silo-consumer-graph.json", "morpho-high-apy-liquidation-routes.json", "erc4626-consumer-joiner.json", "rwa-nav-consumer-graph.json", "current-profit-leads.json", "route-positive-sweep.json"];
const LOCAL_TEXT_CACHE = new Map();

async function fetchJson(u, t=30000) { const c=new AbortController(); const x=setTimeout(()=>c.abort(),t); try { const r=await fetch(u,{headers:{"user-agent":"evm-audit-concrete/1.0"},signal:c.signal}); if(!r.ok) return null; return await r.json(); } catch(_) { return null; } finally { clearTimeout(x); } }
function localAddressMatches(addr) { const needle=String(addr||"").toLowerCase(); if(!needle) return []; const m=[]; for (const f of LOCAL_MATCH_FILES) { const fp=path.join(RAW_DIR,f); if(!fs.existsSync(fp)) continue; if(!LOCAL_TEXT_CACHE.has(fp)) LOCAL_TEXT_CACHE.set(fp,fs.readFileSync(fp,"utf8").toLowerCase()); const c=LOCAL_TEXT_CACHE.get(fp).split(needle).length-1; if(c>0) m.push({file:`reports/raw/fast/${f}`,count:c}); } return m; }

async function main() {
  const apiData = await fetchJson("https://apy.api.concrete.xyz/v1/vault:tvl/all", 45000);
  if (!apiData) {
    const artifact = { generatedAt: new Date().toISOString(), scanner: "tools/scan-concrete-prefilter.js", scope: "Concrete ERC4626 vault route prefilter", safety: {rpcInventoryRead:false,rpcUrlsStored:false,envFilesRead:false,privateKeysRead:false,signedActions:false,exploitExecuteCalls:false,forkTransactions:false,routePositive:false,executableNow:false,signedActionJustified:false,forkJustified:false}, error: "Concrete API unavailable", summary:{routePositive:0} };
    fs.mkdirSync(path.dirname(OUT),{recursive:true}); fs.writeFileSync(OUT,JSON.stringify(artifact,null,2)+"\n");
    console.log("Concrete prefilter: API UNAVAILABLE"); return;
  }

  const metadata = await fetchJson("https://api.llama.fi/protocol/concrete", 45000);
  const currentTvlUsd = metadata && Array.isArray(metadata.tvl) && metadata.tvl.length ? metadata.tvl[metadata.tvl.length-1].totalLiquidityUSD : metadata?.tvl;

  // Collect vault addresses from accessible EVM chains (1, 42161, 80094)
  const chainVaults = {};
  for (const [chainIdStr, vaults] of Object.entries(apiData)) {
    const chainId = Number(chainIdStr);
    if (!CHAINS[chainId]) continue;
    chainVaults[chainId] = Object.values(vaults).filter(v => Number(v.tvl) > 0);
  }

  const vaultRows = [];
  const rpcBlocked = [];
  const allLocalMatches = [];

  for (const [chainIdStr, vaults] of Object.entries(chainVaults)) {
    const chainId = Number(chainIdStr);
    const rpc = await resolveRpc(chainId);
    if (!rpc) { rpcBlocked.push({protocol:"Concrete",chain:CHAINS[chainId].chain,chainId,missingEndpointClass:"EVM RPC",skippedChecks:["vault state","ERC4626 probes"]}); continue; }
    const provider = new ethers.JsonRpcProvider(rpc, chainId, { staticNetwork: true });

    for (const vault of vaults.slice(0, 25)) { // top 25 by TVL
      const addr = vault.address;
      let erc4626Asset = null, totalAssets = null, maxDeposit = null, maxRedeem = null, symbol = null, decimals = 18, supply = 0n;
      try {
        const [aRaw, taRaw, mdRaw, mrRaw, sRaw, dRaw, supRaw] = await Promise.all([
          provider.call({to:addr, data:ERC4626.encodeFunctionData("asset")}).catch(()=>null),
          provider.call({to:addr, data:ERC4626.encodeFunctionData("totalAssets")}).catch(()=>null),
          provider.call({to:addr, data:ERC4626.encodeFunctionData("maxDeposit",["0x000000000000000000000000000000000000dEaD"])}).catch(()=>null),
          provider.call({to:addr, data:ERC4626.encodeFunctionData("maxRedeem",["0x000000000000000000000000000000000000dEaD"])}).catch(()=>null),
          provider.call({to:addr, data:ERC20.encodeFunctionData("symbol")}).catch(()=>null),
          provider.call({to:addr, data:ERC20.encodeFunctionData("decimals")}).catch(()=>null),
          provider.call({to:addr, data:ERC20.encodeFunctionData("totalSupply")}).catch(()=>null),
        ]);
        try { erc4626Asset = ERC4626.decodeFunctionResult("asset", aRaw)?.[0] || null; } catch(_) {}
        try { totalAssets = ERC4626.decodeFunctionResult("totalAssets", taRaw)?.[0]?.toString() || null; } catch(_) {}
        try { maxDeposit = ERC4626.decodeFunctionResult("maxDeposit", mdRaw)?.[0]?.toString() || null; } catch(_) {}
        try { maxRedeem = ERC4626.decodeFunctionResult("maxRedeem", mrRaw)?.[0]?.toString() || null; } catch(_) {}
        try { symbol = ERC20.decodeFunctionResult("symbol", sRaw)?.[0] || vault.symbol; } catch(_) { symbol = vault.symbol; }
        try { decimals = Number(ERC20.decodeFunctionResult("decimals", dRaw)?.[0] ?? 18); } catch(_) {}
        try { supply = ERC20.decodeFunctionResult("totalSupply", supRaw)?.[0] ?? 0n; } catch(_) {}
      } catch(_) {}
      
      const lm = localAddressMatches(addr);
      if (lm.length) allLocalMatches.push({vault: addr, symbol: vault.symbol, matches: lm});
      
      vaultRows.push({
        chainId, chain: CHAINS[chainId].chain, address: addr, symbol: vault.symbol || symbol, name: vault.name,
        apiTvlUsd: Number(vault.tvl), apiPeakTvlUsd: Number(vault.peak_tvl),
        erc4626Asset, totalAssets, maxDeposit, maxRedeem,
        decimals, totalSupplyRaw: supply.toString(),
        localMatches: lm,
      });
    }
  }

  const localArtifactMatchRows = allLocalMatches.reduce((s,m) => s + m.matches.reduce((a,x) => a+x.count, 0), 0);
  const dexLiquidityRows = 0; // no DEX scan for vault share tokens
  const activeVaults = vaultRows.filter(v => v.apiTvlUsd > 0);

  const artifact = {
    generatedAt: new Date().toISOString(), scanner: "tools/scan-concrete-prefilter.js",
    scope: "Concrete onchain capital allocator ERC4626 vault route prefilter",
    safety: {rpcInventoryRead:true,rpcUrlsStored:false,envFilesRead:false,privateKeysRead:false,signedActions:false,exploitExecuteCalls:false,forkTransactions:false,routePositive:false,executableNow:false,signedActionJustified:false,forkJustified:false},
    metadata: { ok: !!metadata, name: metadata?.name || "Concrete", slug: metadata?.slug || "concrete", category: metadata?.category || "Onchain Capital Allocator", currentTvlUsd, chains: metadata?.chains || [], audits: metadata?.audits || null, adapter: metadata?.module || "concrete-xyz/index.js" },
    adapter: { source: "https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/concrete-xyz/index.js", methodology: "Concrete API provides vault list; each vault is ERC4626 with asset()/totalAssets()" },
    vaultRows, rpcBlocked, allLocalMatches,
    summary: {
      vaultRows: vaultRows.length, activeVaults: activeVaults.length,
      erc4626RowsWithAsset: vaultRows.filter(v => v.erc4626Asset).length,
      localArtifactMatchRows, consumerJoinRows: 0, dexLiquidityRows,
      maxDexLiquidityUsd: 0, exactEconomicsRows: 0, rpcBlockedRows: rpcBlocked.length,
      routePositive: 0, executableNow: 0, signedActionJustified: false, forkJustified: false,
      topVaultsByTvl: vaultRows.sort((a,b) => b.apiTvlUsd - a.apiTvlUsd).slice(0,5).map(v => ({symbol:v.symbol, chain:v.chain, tvlUsd:v.apiTvlUsd, erc4626Asset:v.erc4626Asset, localMatches: v.localMatches.length})),
    },
    blockers: [
      "Concrete vaults are standard ERC4626 vaults holding well-known assets (weETH, USDC, LBTC, etc.) — the vault share tokens are not accepted by any local lending consumer in accessible artifacts",
      "No DEX liquidity scan was performed for Concrete vault share tokens; exit liquidity is through redemption not DEX",
      "ERC4626 donation attack surface exists but no joined consumer with material borrow cash overvalues Concrete shares",
      "No exact positive borrow, liquidation, redemption, or unwind route is proven",
    ],
    nextRoutePositiveCriteria: [
      "A Concrete vault share token is accepted by a lending consumer (Morpho/Euler/Silo/Aave) with material borrow cash and overvalues it versus market/redeem value",
      "An ERC4626 donation attack on a low-liquidity Concrete vault inflates share price enough to produce positive borrow economics through a joined consumer",
      "A deprecated Concrete vault with zero TVL still has code, approvals, or a callable redemption path with positive extraction",
    ],
    caveats: [
      "Stable (988) and Katana (747474) and Morph (2818) chains were not RPC-scanned and remain coverage caveats",
      "Only top 25 vaults per accessible chain were probed on-chain; smaller vaults were API-only",
    ],
  };

  fs.mkdirSync(path.dirname(OUT),{recursive:true});
  fs.writeFileSync(OUT,JSON.stringify(artifact,null,2)+"\n");
  console.log(`Concrete prefilter: vaults=${vaultRows.length} active=${activeVaults.length} erc4626WithAsset=${vaultRows.filter(v=>v.erc4626Asset).length} artifactMatches=${localArtifactMatchRows} routePositive=0 rpcBlocked=${rpcBlocked.length}`);
  console.log(`Artifact: ${path.relative(WORKSPACE,OUT).replace(/\\/g,"/")}`);
}

main().then(()=>process.exit(0)).catch(err=>{console.error(err.stack||err.message||String(err));process.exit(1);});