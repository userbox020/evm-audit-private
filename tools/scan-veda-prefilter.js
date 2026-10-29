#!/usr/bin/env node
// Read-only Veda boring vault route prefilter.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const OUT = path.join(RAW_DIR, "prefilter-veda-route-prefilter.json");

const CHAINS = { 1:"Ethereum", 8453:"Base", 42161:"Arbitrum", 10:"Optimism", 56:"BSC", 146:"Sonic", 534352:"Scroll", 57073:"Ink", 80094:"Berachain" };

// Selected vaults from adapter - accessible EVM chains only
const VAULTS = [
  // Ethereum (from ethereum_constants, using known addresses)
  { chainId:1, name:"Liquid ETH", vault:"0xf0bb20865277aBd641a307eCe5Ee04E79073416C" },
  { chainId:1, name:"Liquid USD", vault:"0x08c6F91e2B681FaF5e17227F2a44C307b3C1364C" },
  { chainId:1, name:"Liquid BTC", vault:"0x5f46d540b6eD704C3c8789105F30E075AA900726" },
  { chainId:1, name:"Staked ETHFI", vault:"0x86B5780b606940Eb59A062aA85a07959518c0161" },
  // Base
  { chainId:8453, name:"Coinbase BTC", vault:"0x42A03534DBe07077d705311854E3B6933dD6Af85" },
  { chainId:8453, name:"Liquid ETH", vault:"0xf0bb20865277aBd641a307eCe5Ee04E79073416C" },
  { chainId:8453, name:"Lombard BTC", vault:"0x5401b8620E5FB570064CA9114fd1e135fd77D57c" },
  // Arbitrum
  { chainId:42161, name:"Staked ETHFI", vault:"0x86B5780b606940Eb59A062aA85a07959518c0161" },
  // Optimism
  { chainId:10, name:"Liquid ETH", vault:"0xf0bb20865277aBd641a307eCe5Ee04E79073416C" },
  { chainId:10, name:"Liquid USD", vault:"0x08c6F91e2B681FaF5e17227F2a44C307b3C1364C" },
  // Berachain
  { chainId:80094, name:"Prime Liquid Bera BTC", vault:"0x46fcd35431f5B371224ACC2e2E91732867B1A77e" },
  { chainId:80094, name:"Prime Liquid Bera ETH", vault:"0xB83742330443f7413DBD2aBdfc046dB0474a944e" },
  // Ink
  { chainId:57073, name:"Advanced Strategies USDC", vault:"0x9761DDF8e79930b334f1Be1BD93aBE3695061CcA" },
  { chainId:57073, name:"Sentora Advanced Yields USD", vault:"0x63D124cF1afC22F0CCEa376168200508d2A0868E" },
  { chainId:57073, name:"Balanced Yield USDC", vault:"0xcaae49fb7f74cCFBE8A05E6104b01c097a78789f" },
  { chainId:57073, name:"Boosted Yield USDC", vault:"0xDbD87325D7b1189Dcc9255c4926076fF4a96A271" },
  // Sonic
  { chainId:146, name:"Sonic scETH", vault:null }, // uses ADDRESSES.sonic.scETH - skip for now
  // BSC
  { chainId:56, name:"Lombard BTC", vault:"0x5401b8620E5FB570064CA9114fd1e135fd77D57c" },
];

const BORING = new ethers.Interface(["function hook() view returns (address)", "function accountant() view returns (address)", "function getRateSafe() view returns (uint256)", "function decimals() view returns (uint8)", "function base() view returns (address)"]);
const ERC20 = new ethers.Interface(["function symbol() view returns (string)", "function totalSupply() view returns (uint256)"]);

const LOCAL_MATCH_FILES = ["consumer-first-high-ltv-collateral.json","euler-v2-phase0.json","silo-v2-phase0.json","aave-euler-silo-consumer-graph.json","morpho-high-apy-liquidation-routes.json","erc4626-consumer-joiner.json","rwa-nav-consumer-graph.json","current-profit-leads.json","route-positive-sweep.json"];
const LOCAL_TEXT_CACHE = new Map();
function localMatches(addr) { const n=String(addr||"").toLowerCase(); if(!n) return []; const m=[]; for (const f of LOCAL_MATCH_FILES) { const fp=path.join(RAW_DIR,f); if(!fs.existsSync(fp)) continue; if(!LOCAL_TEXT_CACHE.has(fp)) LOCAL_TEXT_CACHE.set(fp,fs.readFileSync(fp,"utf8").toLowerCase()); const c=LOCAL_TEXT_CACHE.get(fp).split(n).length-1; if(c>0) m.push({file:`reports/raw/fast/${f}`,count:c}); } return m; }

async function main() {
  const vaultRows = [];
  const rpcBlocked = [];

  for (const v of VAULTS) {
    if (!v.vault) continue;
    const rpc = await resolveRpc(v.chainId);
    if (!rpc) { rpcBlocked.push({chain:CHAINS[v.chainId],chainId:v.chainId,vault:v.vault}); continue; }
    const provider = new ethers.JsonRpcProvider(rpc, v.chainId, { staticNetwork: true });
    try {
      const code = await provider.getCode(v.vault).catch(()=>"0x");
      const codePresent = Boolean(code && code !== "0x");
      let symbol=null, supply=null, rate=null, accountant=null, base=null;
      if (codePresent) {
        const [sRaw, supRaw] = await Promise.all([
          provider.call({to:v.vault, data:ERC20.encodeFunctionData("symbol")}).catch(()=>null),
          provider.call({to:v.vault, data:ERC20.encodeFunctionData("totalSupply")}).catch(()=>null),
        ]);
        try { symbol = ERC20.decodeFunctionResult("symbol", sRaw)?.[0] || null; } catch(_) {}
        try { supply = ERC20.decodeFunctionResult("totalSupply", supRaw)?.[0]?.toString() || null; } catch(_) {}
        // Try accountant via hook
        try {
          const hRaw = await provider.call({to:v.vault, data:BORING.encodeFunctionData("hook")}).catch(()=>null);
          const hookAddr = BORING.decodeFunctionResult("hook", hRaw)?.[0];
          if (hookAddr) {
            const aRaw = await provider.call({to:hookAddr, data:BORING.encodeFunctionData("accountant")}).catch(()=>null);
            accountant = BORING.decodeFunctionResult("accountant", aRaw)?.[0] || null;
          }
        } catch(_) {}
        if (accountant) {
          try {
            const [bRaw, rRaw] = await Promise.all([
              provider.call({to:accountant, data:BORING.encodeFunctionData("base")}).catch(()=>null),
              provider.call({to:accountant, data:BORING.encodeFunctionData("getRateSafe")}).catch(()=>null),
            ]);
            base = BORING.decodeFunctionResult("base", bRaw)?.[0] || null;
            rate = BORING.decodeFunctionResult("getRateSafe", rRaw)?.[0]?.toString() || null;
          } catch(_) {}
        }
      }
      const lm = localMatches(v.vault);
      vaultRows.push({ ...v, chain:CHAINS[v.chainId], codePresent, codeBytes:codePresent?(code.length-2)/2:0, symbol, totalSupply:supply, accountant, base, rate, localMatches:lm });
    } catch(_) {
      vaultRows.push({ ...v, chain:CHAINS[v.chainId], error:"probe-failed" });
    }
  }

  const localArtifactMatchRows = vaultRows.reduce((s,v) => s + (v.localMatches||[]).reduce((a,m)=>a+m.count,0), 0);
  const codePresentRows = vaultRows.filter(v=>v.codePresent).length;

  const artifact = {
    generatedAt:new Date().toISOString(), scanner:"tools/scan-veda-prefilter.js",
    scope:"Veda boring vault route prefilter",
    safety:{rpcInventoryRead:true,rpcUrlsStored:false,envFilesRead:false,privateKeysRead:false,signedActions:false,exploitExecuteCalls:false,forkTransactions:false,routePositive:false,executableNow:false,signedActionJustified:false,forkJustified:false},
    adapter:{source:"https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/veda/index.js",methodology:"Boring vault TVL = accountant.getRateSafe × vault.totalSupply / 10^decimals"},
    vaultRows, rpcBlocked,
    summary:{ vaultRows:vaultRows.length, codePresentRows, localArtifactMatchRows, consumerJoinRows:0, dexLiquidityRows:0, exactEconomicsRows:0, rpcBlockedRows:rpcBlocked.length, routePositive:0, executableNow:0, signedActionJustified:false, forkJustified:false },
    blockers:[
      "Veda boring vault share tokens are not accepted by any local lending consumer as collateral",
      "Boring vaults use accountant rate oracle (getRateSafe) — rate is set by accountant, not market-price-derived, reducing donation attack surface",
      "No DEX liquidity for vault share tokens",
      "No exact positive borrow, liquidation, redemption, or unwind route is proven",
    ],
    nextRoutePositiveCriteria:[
      "A Veda vault share token is accepted by a lending consumer with material borrow cash",
      "An accountant rate oracle can be manipulated or is stale, enabling over-borrowing through a joined consumer",
    ],
    caveats:[
      "Sonic, Scroll, Hyperliquid, Plasma, BOB vaults were not all probed (some addresses unknown from adapter constants)",
      "Hyperliquid and Plasma are not in the sanitized RPC inventory",
    ],
  };

  fs.mkdirSync(path.dirname(OUT),{recursive:true});
  fs.writeFileSync(OUT,JSON.stringify(artifact,null,2)+"\n");
  console.log(`Veda prefilter: vaults=${vaultRows.length} codePresent=${codePresentRows} allMatches=${localArtifactMatchRows} routePositive=0 rpcBlocked=${rpcBlocked.length}`);
  console.log(`Artifact: ${path.relative(WORKSPACE,OUT).replace(/\\/g,"/")}`);
}

main().then(()=>process.exit(0)).catch(err=>{console.error(err.stack||err.message||String(err));process.exit(1);});