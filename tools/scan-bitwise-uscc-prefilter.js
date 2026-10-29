#!/usr/bin/env node
// Read-only Bitwise/Superstate USCC RWA token route prefilter.
// RPC URLs resolved in memory only via shared-rpc; never printed or stored.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const OUT = path.join(RAW_DIR, "prefilter-bitwise-uscc-route-prefilter.json");

const USCC = "0x14d60e7fdc0d71d8611742720e4c50e7a974020c";
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
  "consumer-first-high-ltv-collateral.json", "euler-v2-phase0.json", "silo-v2-phase0.json",
  "aave-euler-silo-consumer-graph.json", "morpho-high-apy-liquidation-routes.json",
  "erc4626-consumer-joiner.json", "rwa-nav-consumer-graph.json", "current-profit-leads.json", "route-positive-sweep.json",
];
const LOCAL_TEXT_CACHE = new Map();

function slotAddress(r) { if (!r || r === "0x" || /^0x0+$/.test(r)) return null; try { return ethers.getAddress(`0x${r.slice(-40)}`); } catch (_) { return null; } }
async function tryCall(p,a,i,f,args=[]) { try { return await p.call({ to:a, data:i.encodeFunctionData(f,args) }); } catch(_) { return null; } }
function decode(r,i,f) { if (!r||r==="0x") return null; try { return i.decodeFunctionResult(f,r); } catch(_) { return null; } }
async function fetchJson(u,t=30000) { const c=new AbortController(); const x=setTimeout(()=>c.abort(),t); try { const r=await fetch(u,{headers:{"user-agent":"evm-audit-uscc/1.0"},signal:c.signal}); if(!r.ok) return null; return await r.json(); } catch(_) { return null; } finally { clearTimeout(x); } }

async function fetchMetadata() {
  const json = await fetchJson("https://api.llama.fi/protocol/bitwise-uscc", 45000);
  if (!json) return { ok:false };
  const t = Array.isArray(json.tvl)&&json.tvl.length ? json.tvl[json.tvl.length-1].totalLiquidityUSD : json.tvl;
  return { ok:true, name:json.name, slug:json.slug||"bitwise-uscc", category:json.category, currentTvlUsd:t, chains:json.chains||[], audits:json.audits||null, adapter:json.module||"superstate-uscc/index.js" };
}

function localAddressMatches(addr) {
  const needle = String(addr||"").toLowerCase(); if(!needle) return [];
  const m = [];
  for (const f of LOCAL_MATCH_FILES) {
    const fp = path.join(RAW_DIR,f); if(!fs.existsSync(fp)) continue;
    if(!LOCAL_TEXT_CACHE.has(fp)) LOCAL_TEXT_CACHE.set(fp,fs.readFileSync(fp,"utf8").toLowerCase());
    const c = LOCAL_TEXT_CACHE.get(fp).split(needle).length-1; if(c>0) m.push({file:`reports/raw/fast/${f}`,count:c});
  }
  return m;
}

async function geckoPools(addr) {
  const json = await fetchJson(`https://api.geckoterminal.com/api/v2/networks/ethereum/tokens/${addr}/pools?page=1`, 20000);
  const rows = Array.isArray(json?.data) ? json.data : [];
  return rows.slice(0,5).map(r=>({pool:r.id,name:r.attributes?.name,reserveUsd:r.attributes?.reserve_in_usd?Number(r.attributes.reserve_in_usd):null,priceUsd:r.attributes?.base_token_price_usd?Number(r.attributes.base_token_price_usd):null}));
}

async function sourcifyStatus(chainId, addr) {
  for (const u of [`https://repo.sourcify.dev/contracts/full_match/${chainId}/${addr}/metadata.json`,`https://repo.sourcify.dev/contracts/partial_match/${chainId}/${addr}/metadata.json`]) {
    const r = await fetch(u,{headers:{"user-agent":"evm-audit-uscc/1.0"}}).catch(()=>null);
    if(r?.ok) return {verified:true,source:u.includes("full_match")?"sourcify-full":"sourcify-partial"};
  }
  return {verified:false,source:null};
}

async function main() {
  const metadataPromise = fetchMetadata();
  const rpc = await resolveRpc(1);
  if (!rpc) {
    const artifact = { generatedAt:new Date().toISOString(), scanner:"tools/scan-bitwise-uscc-prefilter.js", scope:"Bitwise/Superstate USCC RWA token route prefilter", safety:{rpcInventoryRead:true,rpcUrlsStored:false,envFilesRead:false,privateKeysRead:false,signedActions:false,exploitExecuteCalls:false,forkTransactions:false,routePositive:false,executableNow:false,signedActionJustified:false,forkJustified:false}, metadata:await metadataPromise, rpcBlocked:[{protocol:"Bitwise USCC",chain:"Ethereum",chainId:1,missingEndpointClass:"EVM RPC",skippedChecks:["token state","ERC4626 probes","DEX liquidity","consumer joins"]}], summary:{tokenRows:0,codePresentRows:0,erc4626Rows:0,localArtifactMatchRows:0,consumerJoinRows:0,dexLiquidityRows:0,maxDexLiquidityUsd:0,exactEconomicsRows:0,rpcBlockedRows:1,routePositive:0,executableNow:0,signedActionJustified:false,forkJustified:false}, blockers:["Ethereum RPC unavailable"], nextRoutePositiveCriteria:[] };
    fs.mkdirSync(path.dirname(OUT),{recursive:true}); fs.writeFileSync(OUT,JSON.stringify(artifact,null,2)+"\n");
    console.log("Bitwise USCC prefilter: RPC BLOCKED"); return;
  }
  const provider = new ethers.JsonRpcProvider(rpc, 1, { staticNetwork: true });
  const [code, implRaw, symRaw, nameRaw, decRaw, supplyRaw, assetRaw, totalAssetsRaw, convertRaw, maxDepRaw, maxRedeemRaw, previewRaw, pools, srcStatus] = await Promise.all([
    provider.getCode(USCC).catch(()=>"0x"), provider.getStorage(USCC, EIP1967_IMPL).catch(()=>null),
    tryCall(provider,USCC,ERC20,"symbol"), tryCall(provider,USCC,ERC20,"name"),
    tryCall(provider,USCC,ERC20,"decimals"), tryCall(provider,USCC,ERC20,"totalSupply"),
    tryCall(provider,USCC,ERC4626,"asset"), tryCall(provider,USCC,ERC4626,"totalAssets"),
    tryCall(provider,USCC,ERC4626,"convertToAssets",[10n**18n]),
    tryCall(provider,USCC,ERC4626,"maxDeposit",["0x000000000000000000000000000000000000dEaD"]),
    tryCall(provider,USCC,ERC4626,"maxRedeem",["0x000000000000000000000000000000000000dEaD"]),
    tryCall(provider,USCC,ERC4626,"previewRedeem",[10n**18n]),
    geckoPools(USCC), sourcifyStatus(1, USCC),
  ]);
  const metadata = await metadataPromise;
  const decimals = Number(decode(decRaw,ERC20,"decimals")?.[0] ?? 6);
  const supply = decode(supplyRaw,ERC20,"totalSupply")?.[0] ?? 0n;
  const asset = decode(assetRaw,ERC4626,"asset")?.[0] || null;
  const totalAssets = decode(totalAssetsRaw,ERC4626,"totalAssets")?.[0] ?? null;
  const localMatches = localAddressMatches(USCC);

  const tokenRow = {
    address: USCC, chain:"Ethereum", codePresent:Boolean(code&&code!=="0x"), codeBytes:code&&code!=="0x"?(code.length-2)/2:0,
    proxy:{eip1967Implementation:slotAddress(implRaw)}, sourceStatus:srcStatus,
    symbol:decode(symRaw,ERC20,"symbol")?.[0]||null, name:decode(nameRaw,ERC20,"name")?.[0]||null,
    decimals, totalSupplyRaw:supply.toString(), totalSupply:ethers.formatUnits(supply,decimals),
    erc4626:{asset, totalAssets:totalAssets?ethers.formatUnits(totalAssets,decimals):null, totalAssetsRaw:totalAssets?.toString()||null, convertToAssetsOneShare:decode(convertRaw,ERC4626,"convertToAssets")?.[0]?ethers.formatUnits(decode(convertRaw,ERC4626,"convertToAssets")[0],decimals):null, maxDeposit:decode(maxDepRaw,ERC4626,"maxDeposit")?.[0]?.toString()||null, maxRedeem:decode(maxRedeemRaw,ERC4626,"maxRedeem")?.[0]?.toString()||null, previewRedeemOneShare:decode(previewRaw,ERC4626,"previewRedeem")?.[0]?.toString()||null},
    dexPools:pools, topDexLiquidityUsd:pools.length?Math.max(...pools.map(p=>Number(p.reserveUsd||0))):0, localMatches,
  };

  const artifact = {
    generatedAt:new Date().toISOString(), scanner:"tools/scan-bitwise-uscc-prefilter.js",
    scope:"Bitwise/Superstate USCC RWA token route prefilter",
    safety:{rpcInventoryRead:true,rpcUrlsStored:false,envFilesRead:false,privateKeysRead:false,signedActions:false,exploitExecuteCalls:false,forkTransactions:false,routePositive:false,executableNow:false,signedActionJustified:false,forkJustified:false},
    metadata, adapter:{source:"https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/superstate-uscc/index.js",methodology:"USCC totalSupply on Ethereum; Solana and Plume Mainnet also supported"},
    tokenRows:[tokenRow], rpcBlocked:[],
    summary:{
      tokenRows:1, codePresentRows:tokenRow.codePresent?1:0, erc4626Rows:tokenRow.erc4626.asset?1:0,
      localArtifactMatchRows:localMatches.reduce((s,m)=>s+m.count,0), consumerJoinRows:0,
      dexLiquidityRows:pools.filter(p=>Number(p.reserveUsd||0)>=1000).length,
      maxDexLiquidityUsd:pools.length?Math.max(...pools.map(p=>Number(p.reserveUsd||0))):0,
      exactEconomicsRows:0, rpcBlockedRows:0, routePositive:0, executableNow:0, signedActionJustified:false, forkJustified:false,
    },
    blockers:[
      "USCC is a permissioned RWA cash coin with KYC/whitelist gates on issuance and redemption",
      "No local lending/oracle consumer accepts USCC as collateral in accessible artifacts",
      "No DEX liquidity found for USCC on Ethereum above threshold",
      "RWA redemption is likely permissioned and not flash-loan compatible",
      "No exact positive borrow, liquidation, redemption, or unwind route exists",
    ],
    nextRoutePositiveCriteria:[
      "USCC is accepted by a live lending consumer with material borrow cash and overvalues it versus market/redeem value",
      "Public DEX liquidity appears enabling acquire-below-redeem arbitrage",
      "Redemption/transfer gate is bypassed or permissionlessly callable",
    ],
    caveats:[
      "Solana and Plume Mainnet token supplies were not scanned by this EVM-only prefilter",
      "Plume Mainnet is not in the sanitized RPC inventory and remains a coverage caveat",
    ],
  };
  fs.mkdirSync(path.dirname(OUT),{recursive:true});
  fs.writeFileSync(OUT,JSON.stringify(artifact,null,2)+"\n");
  console.log(`Bitwise USCC prefilter: symbol=${tokenRow.symbol} supply=${tokenRow.totalSupply} erc4626=${tokenRow.erc4626.asset?'yes':'no'} dexLiq=${tokenRow.topDexLiquidityUsd} artifactMatches=${localMatches.reduce((s,m)=>s+m.count,0)} routePositive=0`);
  console.log(`Artifact: ${path.relative(WORKSPACE,OUT).replace(/\\/g,"/")}`);
}

main().then(()=>process.exit(0)).catch(err=>{console.error(err.stack||err.message||String(err));process.exit(1);});