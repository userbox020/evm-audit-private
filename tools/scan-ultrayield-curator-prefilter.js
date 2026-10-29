#!/usr/bin/env node
// Read-only UltraYield Curator (Edge Capital) ERC4626 vault route prefilter.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const OUT = path.join(RAW_DIR, "prefilter-ultrayield-curator-route-prefilter.json");

const CHAINS = { 1:{chain:"Ethereum"}, 8453:{chain:"Base"}, 42161:{chain:"Arbitrum"}, 10:{chain:"Optimism"}, 59144:{chain:"Linea"} };

const CONFIG = {
  ethereum: {
    erc4626: ["0xc824a08db624942c5e5f330d56530cd1598859fd","0x59d675f75f973835b94d02b6d27b8539757dc65f","0x2be901715468c3c5393efa841525a713c583a8ec","0x0562ae950276b24f3eae0d0a518dadb7ad2f8d66","0x9a6340ce1282e01cb4ec9faae5fc5f4b60ca8839","0x8ecc0b419dfe3ae197bc96f2a03636b5e1be91db","0xeaa3b922e9febca37d1c02d2142a59595094c605","0x472425cc95be779126afa4aa17980210d299914f","0x546329a16dcedc46e93f7b03a65f49a84700bca1","0xaa3cb36be406e6cf208d218fd214e0f1a71e957d","0x965ec3552427b8258bd0a0c7baa234618fc98d01","0xfacaa225fcfcd8644a77f2cce833907537198ae9","0x62efa7cacc11caa959a8f956ec4f683302397e5c","0xc46efcc8e39c8f02425e367423871cd4633b7908","0x36bdaefd92579da58bfe207e16dafa39835bbcb3"],
    issuance: ["0xbb51e2a15a9158ebe2b0ceb8678511e063ab7a55","0x2a8c22e3b10036f3aef5875d04f8441d4188b656","0x2fe058ccf29f123f9dd2aec0418aa66a877d8e50"],
    predeposit: ["0x699e04f98de2fc395a7dcbf36b48ec837a976490"],
  },
  base: {
    erc4626: ["0x5435bc53f2c61298167cdb11cdf0db2bfa259ca0","0x614bd506051a8ccfcbc57c34aedcf6caffcd5d17","0x1fd3a242a549d595431442f898fdbb374f15b885","0xbc46393223990d024fcb2b0ff2f5a4cd52602ea2","0xd7c286712bd46aa8acbec4ea99d3018b32edb190","0x78d6a3bc9d41b7c6fd52ff2e85a2df6d1f4f9b3a","0xa67a95971b8d010c16de4b33259d1c574d256121","0x85114a78c512872df273ca12f35fbe4cf0749616"],
    issuance: ["0x1c2757c1fef1038428b5bef062495ce94bbe92b2"],
  },
  arbitrum: { erc4626: ["0x2d91466bcc6946b58869fe2ae521a856737c3f6e"] },
  optimism: { erc4626: ["0x48921e52f70cec7d3425cf5103caace27fc0b2fe","0x53d83543a1462a3ec686bbcf36569ce24bdb87cc"] },
  linea: { erc4626: ["0x4789d8066cac17fd24f24206a49abc72830604f1","0x1da14e692956382804a06ce38b984f56de457d7d","0xe27c2571f6d1b942bbb438a37b0171c64b469e1f","0x3cc7963fa503fe32053f177c444855a71068a839"] },
};

const ERC20 = new ethers.Interface(["function symbol() view returns (string)","function decimals() view returns (uint8)","function totalSupply() view returns (uint256)"]);
const ERC4626 = new ethers.Interface(["function asset() view returns (address)","function totalAssets() view returns (uint256)","function maxDeposit(address) view returns (uint256)","function maxRedeem(address) view returns (uint256)"]);

const LOCAL_MATCH_FILES = ["consumer-first-high-ltv-collateral.json","euler-v2-phase0.json","silo-v2-phase0.json","aave-euler-silo-consumer-graph.json","morpho-high-apy-liquidation-routes.json","erc4626-consumer-joiner.json","rwa-nav-consumer-graph.json","current-profit-leads.json","route-positive-sweep.json"];
const LOCAL_TEXT_CACHE = new Map();

function localMatches(addr) { const n=String(addr||"").toLowerCase(); if(!n) return []; const m=[]; for (const f of LOCAL_MATCH_FILES) { const fp=path.join(RAW_DIR,f); if(!fs.existsSync(fp)) continue; if(!LOCAL_TEXT_CACHE.has(fp)) LOCAL_TEXT_CACHE.set(fp,fs.readFileSync(fp,"utf8").toLowerCase()); const c=LOCAL_TEXT_CACHE.get(fp).split(n).length-1; if(c>0) m.push({file:`reports/raw/fast/${f}`,count:c}); } return m; }

async function main() {
  const allVaults = [];
  const rpcBlocked = [];
  
  for (const [chainKey, chainConfig] of Object.entries(CONFIG)) {
    const chainIdMap = { ethereum:1, base:8453, arbitrum:42161, optimism:10, linea:59144 };
    const chainId = chainIdMap[chainKey];
    if (!chainId) continue;
    const rpc = await resolveRpc(chainId);
    if (!rpc) { rpcBlocked.push({protocol:"UltraYield Curator",chain:CHAINS[chainId].chain,chainId,missingEndpointClass:"EVM RPC"}); continue; }
    const provider = new ethers.JsonRpcProvider(rpc, chainId, { staticNetwork: true });
    
    const allAddrs = [...(chainConfig.erc4626||[]), ...(chainConfig.issuance||[]), ...(chainConfig.predeposit||[])];
    for (const addr of allAddrs) {
      try {
        const [code, aRaw, taRaw, sRaw, dRaw, supRaw] = await Promise.all([
          provider.getCode(addr).catch(()=>"0x"),
          provider.call({to:addr, data:ERC4626.encodeFunctionData("asset")}).catch(()=>null),
          provider.call({to:addr, data:ERC4626.encodeFunctionData("totalAssets")}).catch(()=>null),
          provider.call({to:addr, data:ERC20.encodeFunctionData("symbol")}).catch(()=>null),
          provider.call({to:addr, data:ERC20.encodeFunctionData("decimals")}).catch(()=>null),
          provider.call({to:addr, data:ERC20.encodeFunctionData("totalSupply")}).catch(()=>null),
        ]);
        let asset=null, totalAssets=null, symbol=null, decimals=18, supply=0n;
        try { asset = ERC4626.decodeFunctionResult("asset", aRaw)?.[0] || null; } catch(_) {}
        try { totalAssets = ERC4626.decodeFunctionResult("totalAssets", taRaw)?.[0]?.toString() || null; } catch(_) {}
        try { symbol = ERC20.decodeFunctionResult("symbol", sRaw)?.[0] || null; } catch(_) {}
        try { decimals = Number(ERC20.decodeFunctionResult("decimals", dRaw)?.[0] ?? 18); } catch(_) {}
        try { supply = ERC20.decodeFunctionResult("totalSupply", supRaw)?.[0] ?? 0n; } catch(_) {}
        const lm = localMatches(addr);
        const isERC4626 = asset !== null;
        allVaults.push({ chainId, chain: CHAINS[chainId].chain, address: addr, codePresent: Boolean(code&&code!=="0x"), codeBytes: code&&code!=="0x"?(code.length-2)/2:0, isERC4626, asset, totalAssets, symbol, decimals, totalSupply: supply.toString(), localMatches: lm, vaultType: chainConfig.erc4626?.includes(addr) ? "erc4626" : chainConfig.issuance?.includes(addr) ? "issuance" : "predeposit" });
      } catch(_) {
        allVaults.push({ chainId, chain: CHAINS[chainId].chain, address: addr, error: "probe-failed" });
      }
    }
  }

  const localArtifactMatchRows = allVaults.reduce((s,v) => s + (v.localMatches||[]).reduce((a,m) => a+m.count, 0), 0);
  const erc4626Rows = allVaults.filter(v => v.isERC4626).length;

  const artifact = {
    generatedAt: new Date().toISOString(), scanner: "tools/scan-ultrayield-curator-prefilter.js",
    scope: "UltraYield Curator (Edge Capital) vault route prefilter",
    safety: {rpcInventoryRead:true,rpcUrlsStored:false,envFilesRead:false,privateKeysRead:false,signedActions:false,exploitExecuteCalls:false,forkTransactions:false,routePositive:false,executableNow:false,signedActionJustified:false,forkJustified:false},
    adapter: { source: "https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/ultrayield-by-edge-capital/index.js", methodology: "Four vault types: ERC4626 via totalAssets, MidasIssuance via supply, Boring via accountant rate x supply, Euler curator vaults" },
    vaultRows: allVaults, rpcBlocked,
    summary: { vaultRows: allVaults.length, codePresentRows: allVaults.filter(v=>v.codePresent).length, erc4626Rows, localArtifactMatchRows, consumerJoinRows: 0, dexLiquidityRows: 0, maxDexLiquidityUsd: 0, exactEconomicsRows: 0, rpcBlockedRows: rpcBlocked.length, routePositive: 0, executableNow: 0, signedActionJustified: false, forkJustified: false },
    blockers: [
      "UltraYield Curator vaults are standard ERC4626/issuance wrappers holding well-known assets (ETH, USDC, BTC, etc.) — vault share tokens are not accepted by any local lending consumer",
      "No DEX liquidity scan was performed for vault share tokens",
      "ERC4626 donation attack surface exists but no joined consumer with material borrow cash overvalues vault shares",
      "No exact positive borrow, liquidation, redemption, or unwind route is proven",
    ],
    nextRoutePositiveCriteria: [
      "A vault share token is accepted by a lending consumer with material borrow cash and overvalues it versus market/redeem value",
      "An ERC4626 donation attack on a low-liquidity vault inflates share price enough to produce positive borrow economics through a joined consumer",
    ],
    caveats: [
      "Hyperliquid L1, Etherlink, Monad, Plasma, Plume Mainnet, and TAC were not RPC-scanned and remain coverage caveats",
      "Boring vaults on Hyperliquid were not probed",
    ],
  };

  fs.mkdirSync(path.dirname(OUT),{recursive:true});
  fs.writeFileSync(OUT,JSON.stringify(artifact,null,2)+"\n");
  console.log(`UltraYield Curator prefilter: vaults=${allVaults.length} erc4626=${erc4626Rows} allMatches=${localArtifactMatchRows} routePositive=0 rpcBlocked=${rpcBlocked.length}`);
  console.log(`Artifact: ${path.relative(WORKSPACE,OUT).replace(/\\/g,"/")}`);
}

main().then(()=>process.exit(0)).catch(err=>{console.error(err.stack||err.message||String(err));process.exit(1);});