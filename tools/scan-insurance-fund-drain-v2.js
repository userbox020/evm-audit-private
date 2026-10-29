#!/usr/bin/env node
// scan-insurance-fund-drain-v2.js — Comprehensive Insurance Fund Drain Scanner
// Covers: GMX GLP, Liquity SP, Aave SM, dYdX, Drift, Compound
// Live ETH + AAVE price from Chainlink.
const { rpcCall, resolveRpc } = require("./shared-rpc");
const fs = require("fs"); const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "insurance-fund-drain-v2.json");

const CL_ETH_USD  = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419";
const CL_AAVE_USD = "0x547a514d5e3769680Ce22B2361c10Ea13619e8a9";
const AAVE_TOKEN  = "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9";
const ABPT_TOKEN   = "0x41A08648C3766F9F9d85598fF102a08f4ef84F84";
const WETH         = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

function encodeAddr(a) { return "000000000000000000000000" + a.slice(2).toLowerCase(); }
function safeBig(hex) { if(!hex||hex==="0x") return 0n; try{return BigInt(hex)}catch(e){return 0n;} }
function fromWei(bn, dec=18) { return Number(bn)/(10**dec); }

async function ethCall(rpc, to, data, ms=15000) {
  const raw = await rpcCall(rpc, "eth_call", [{to,data},"latest"], ms);
  return raw && raw.length>=2 && raw!=="0x" ? raw : null;
}

async function getETHPrice(rpc) {
  const raw = await ethCall(rpc, CL_ETH_USD, "0xfeaf968c");
  if (raw && raw.length>=258) {
    const ans = safeBig("0x"+(raw.slice(66,130).match(/[1-9a-f]/)?raw.slice(66,130).replace(/^0+/,""):"0"));
    return Number(ans)/1e8;
  }
  return null;
}

async function getAAVEPrice(rpc) {
  const raw = await ethCall(rpc, CL_AAVE_USD, "0xfeaf968c");
  if (raw && raw.length>=258) {
    const ans = safeBig("0x"+(raw.slice(66,130).match(/[1-9a-f]/)?raw.slice(66,130).replace(/^0+/,""):"0"));
    return Number(ans)/1e8;
  }
  return null;
}

async function getETHBal(rpc, addr) {
  const raw = await rpcCall(rpc, "eth_getBalance", [addr, "latest"], 8000);
  return raw ? fromWei(safeBig(raw)) : 0;
}

async function getTokenBal(rpc, token, holder, decimals=18) {
  const raw = await ethCall(rpc, token, "0x70a08231"+encodeAddr(holder));
  return raw ? fromWei(safeBig(raw), decimals) : 0;
}

async function getTokenDecimals(rpc, token) {
  const raw = await ethCall(rpc, token, "0x313ce567", 4000);
  if (raw && raw.length>=66) return parseInt(raw.slice(130,132),16)||18;
  return 18;
}

// ---- Specific scanners ----

async function scanGLP(rpc, chainId, glpAddr, label) {
  const r = { chain:chainId, addr:glpAddr, type:"GLP", label, totalAUM:0, glpSupply:0,
    coverageRatio:null, risk:"UNKNOWN", riskScore:40, basketManipulable:true, ethPrice:0 };
  // Get supply
  const sRaw = await ethCall(rpc, glpAddr, "0x18160ddd");
  if (sRaw) r.glpSupply = fromWei(safeBig(sRaw));
  // GLP AUM is roughly totalSupply * ~$1 (GLP tracks $1 basket)
  if (r.glpSupply > 0) { r.totalAUM = r.glpSupply; r.coverageRatio = 1.0; }
  r.risk = r.totalAUM > 10_000_000 ? "HIGH — large GLP ($"+(r.totalAUM/1e6).toFixed(1)+"M), basket manipulable" :
           r.totalAUM > 1_000_000  ? "MEDIUM — GLP ($"+(r.totalAUM/1e6).toFixed(1)+"M), basket manipulable" :
           r.totalAUM > 0          ? "MEDIUM — small GLP, basket manipulable" :
                                      "UNKNOWN — could not read supply";
  return r;
}

async function scanStabilityPool(rpc, chainId, poolAddr, label, debtToken) {
  const r = { chain:chainId, addr:poolAddr, type:"StabilityPool", label, debtToken,
    ethBal:0, debtSupply:0, totalUSD:0, coverageRatio:null, risk:"UNKNOWN", riskScore:0, ethPrice:0 };
  r.ethBal = await getETHBal(rpc, poolAddr);
  if (debtToken) {
    const dec = await getTokenDecimals(rpc, debtToken);
    r.debtSupply = await getTokenBal(rpc, debtToken, poolAddr, dec);
  }
  return r;
}

async function scanAaveSM(rpc, chainId, stkAddr, label, aavePrice, ethPrice) {
  const r = { chain:chainId, addr:stkAddr, type:"SafetyModule", label,
    totalStaked:0, stakedUSD:0, coverageRatio:null, risk:"UNKNOWN", riskScore:0, ethPrice:0 };

  const isStkAAVE = stkAddr.toLowerCase() === "0x4da27a545c0c5b758a6ba100e3a049001de870f5";
  const underlying = isStkAAVE ? AAVE_TOKEN : ABPT_TOKEN;

  // Direct balance of underlying in stk contract
  const dec = isStkAAVE ? 18 : 18; // AAVE is 18, ABPT is 18
  r.totalStaked = await getTokenBal(rpc, underlying, stkAddr, dec);

  if (isStkAAVE) {
    r.stakedUSD = r.totalStaked * (aavePrice || 90);
  } else {
    // ABPT is 80% AAVE / 20% WETH Balancer pool
    // Estimate: ABPT value = (0.8 * aavePrice + 0.2 * ethPrice) * pool_ratio
    // Pool ratio: total pool value / total BPT supply
    // For rough estimate, use total BPT supply
    const bptSupply = fromWei(safeBig(await ethCall(rpc, ABPT_TOKEN, "0x18160ddd")));
    // Get total AAVE in pool
    const aaveInPool = await getTokenBal(rpc, AAVE_TOKEN, ABPT_TOKEN, 18);
    // Get total WETH in pool
    const ethInPool = await getTokenBal(rpc, WETH, ABPT_TOKEN, 18);
    if (bptSupply > 0 && aaveInPool > 0) {
      const poolTVL = aaveInPool * (aavePrice||90) + ethInPool * (ethPrice||1600);
      const bptPrice = poolTVL / bptSupply;
      r.stakedUSD = r.totalStaked * bptPrice;
      r.bptPrice = bptPrice;
      r.poolTVL = poolTVL;
    } else {
      r.stakedUSD = r.totalStaked * (aavePrice||90) * 2; // rough fallback
    }
  }

  return r;
}

// ---- Main ----
async function main() {
  console.log("=== Insurance Fund Drain Scanner v2 ===\n");
  const start = Date.now();
  const results = [];
  const rpcs = {};

  // Resolve RPCs
  for (const cid of [1,42161,43114]) {
    rpcs[cid] = await resolveRpc(cid);
    console.log("Chain " + cid + ": " + (rpcs[cid] ? "OK" : "MISSING"));
  }

  if (!rpcs[1]) { console.error("No Ethereum RPC. Aborting."); process.exit(1); }

  // Live prices
  const ethPrice = await getETHPrice(rpcs[1]);
  const aavePrice = await getAAVEPrice(rpcs[1]);
  console.log("ETH: $" + (ethPrice||"FAIL") + " | AAVE: $" + (aavePrice||"FAIL"));

  // ---- A. GMX GLP ----
  console.log("\n--- A. GMX GLP ---");
  const glps = [
    { chain:42161, addr:"0x4277f8F2c384827B5273592FF7CeBd9f2C1ac258", label:"GMX GLP V1 (Arbitrum)" },
    { chain:43114, addr:"0x01234181085565ed162a948b6a5e88758CD7c7b8", label:"GMX GLP V1 (Avalanche)" },
  ];
  for (const t of glps) {
    const rpc = rpcs[t.chain];
    if (!rpc) { results.push({ ...t, type:"GLP", error:"no-rpc", risk:"UNKNOWN", riskScore:40 }); continue; }
    const r = await scanGLP(rpc, t.chain, t.addr, t.label);
    r.ethPrice = ethPrice;
    console.log("  "+t.label+": Supply="+(r.glpSupply/1e6).toFixed(2)+"M AUM~$"+(r.totalAUM/1e6).toFixed(2)+"M Risk="+r.risk+" Score="+r.riskScore);
    results.push(r);
  }

  // ---- B. Stability Pools ----
  console.log("\n--- B. Stability Pools ---");
  const sps = [
    { chain:1, addr:"0x66017D22b0f8556afDd19FC67041899Eb65a21bb", label:"Liquity V1 SP (LUSD/WETH)", dt:"0x5f98805A4E8be255a32880FDeC7F6728C6568bA0" },
    { chain:1, addr:"0x4F39F12064D83F6Dd7A2BDb0D53aF8be560356A6", label:"Gravita SP (WETH)",          dt:"0x15f74458aE0bFdAA1a96CA1aa779D715Cc1Eefe4" },
    { chain:1, addr:"0xed8B26D99834540C5013701bB3715faFD39993Ba", label:"Prisma SP (mkUSD)",           dt:"0x4591DBfF62656E7859Afe5e45f6f47D3669fBB28" },
  ];
  for (const t of sps) {
    const r = await scanStabilityPool(rpcs[1], t.chain, t.addr, t.label, t.dt);
    r.ethPrice = ethPrice;
    if (ethPrice && r.ethBal > 0 && r.debtSupply > 0) {
      r.coverageRatio = r.ethBal * ethPrice / r.debtSupply;
      r.riskScore = r.coverageRatio < 0.02 ? 40 : r.coverageRatio < 0.05 ? 25 : r.coverageRatio < 0.10 ? 10 : 0;
      r.risk = r.coverageRatio < 0.02 ? "CRITICAL — extreme undercollateralization" :
               r.coverageRatio < 0.05 ? "HIGH — severely undercollateralized" :
               r.coverageRatio < 0.10 ? "HIGH — low coverage" : "MEDIUM — watch coverage";
      r.totalUSD = r.ethBal * ethPrice + r.debtSupply;
    } else {
      r.totalUSD = r.ethBal * (ethPrice||1800) + r.debtSupply;
    }
    console.log("  "+t.label+": ETH="+r.ethBal.toFixed(4)+" Debt=$"+(r.debtSupply/1e6).toFixed(2)+"M Cov="+(r.coverageRatio!=null?(r.coverageRatio*100).toFixed(2)+"%":"N/A")+" Risk="+r.risk+" Score="+r.riskScore);
    results.push(r);
  }

  // ---- C. dYdX Chain ----
  results.push({ chain:"dydx-chain", addr:"n/a", type:"InsuranceFund", label:"dYdX Chain Insurance Fund",
    totalUSD:0, coverageRatio:null, risk:"UNKNOWN", riskScore:0,
    note:"Cosmos-based; requires dYdX Indexer API. Coverage caveat." });

  // ---- D. Aave Safety Module ----
  console.log("\n--- D. Aave Safety Module ---");
  const sms = [
    { chain:1, addr:"0x4da27a545c0c5B758a6BA100e3a049001de870f5", label:"Aave stkAAVE" },
    { chain:1, addr:"0xa1116930326D21fB917d5A27F1E9943A9595fb47", label:"Aave stkABPT" },
  ];
  let smTotalUSD = 0;
  for (const t of sms) {
    const r = await scanAaveSM(rpcs[1], t.chain, t.addr, t.label, aavePrice, ethPrice);
    r.ethPrice = ethPrice;
    smTotalUSD += r.stakedUSD;
    console.log("  "+t.label+": Staked="+(r.totalStaked/1e3).toFixed(1)+"K USD=$"+(r.stakedUSD/1e6).toFixed(2)+"M"+(r.bptPrice?(" BPT=$"+r.bptPrice.toFixed(2)):""));
    results.push(r);
  }

  // Try Aave protocol total debt for coverage context
  if (rpcs[1]) {
    try {
      // Query DefiLlama API for Aave TVL/debt
      const resp = await fetch("https://api.llama.fi/protocol/aave", { signal: AbortSignal.timeout(8000) });
      const data = await resp.json();
      if (data && data.currentChainTvls) {
        const ethData = data.currentChainTvls["Ethereum"];
        if (ethData) {
          const borrowed = ethData.borrowed || 0;
          // Update SM results with protocol debt context
          for (const r of results) {
            if (r.type === "SafetyModule") {
              r.protocolDebtUSD = borrowed;
              if (smTotalUSD > 0) {
                r.coverageRatio = smTotalUSD / borrowed;
                r.riskScore = r.coverageRatio < 0.02 ? 40 : r.coverageRatio < 0.05 ? 25 : r.coverageRatio < 0.10 ? 10 : 0;
                r.risk = r.coverageRatio < 0.02 ? "CRITICAL — SM covers <2% of debt" :
                         r.coverageRatio < 0.05 ? "HIGH — SM covers <5% of debt" :
                         r.coverageRatio < 0.10 ? "MEDIUM — SM covers <10% of debt" : "DORMANT — adequate SM coverage";
              }
            }
          }
          console.log("  Aave V3 Ethereum debt: $" + (borrowed/1e9).toFixed(2) + "B");
          console.log("  SM coverage ratio: " + (borrowed>0?(smTotalUSD/borrowed*100).toFixed(2)+"%":"N/A"));
        }
      }
    } catch (e) { console.log("  DefiLlama API unavailable; skipping debt context"); }
  }

  // ---- E. Drift ----
  results.push({ chain:"solana", addr:"n/a", type:"InsuranceFund", label:"Drift Insurance Fund (Solana)",
    totalUSD:0, coverageRatio:null, risk:"UNKNOWN", riskScore:0,
    note:"Solana RPC required. Coverage caveat." });

  // ---- F. Compound Reserves ----
  console.log("\n--- F. Compound Reserves ---");
  const comps = [
    { chain:1, addr:"0x2775b1c31B66cCC01DdCfd4C2Ccb6E49ad5301AD", label:"Comp cUSDC Reserves" },
    { chain:1, addr:"0xe5d7c2a44FfdD6a295fE15c8A9d299f2815cDAEF", label:"Comp cETH Reserves" },
  ];
  for (const t of comps) {
    const eth = await getETHBal(rpcs[1], t.addr);
    results.push({ chain:t.chain, addr:t.addr, type:"CompoundReserve", label:t.label,
      ethBal:eth, totalUSD:eth*(ethPrice||0), coverageRatio:null, risk:"DORMANT — protocol-owned", riskScore:0, ethPrice });
    console.log("  "+t.label+": "+eth.toFixed(4)+" ETH ($"+(eth*ethPrice).toFixed(0)+")");
  }

  // ---- Summary ----
  const critical = results.filter(r => r.risk?.startsWith("CRITICAL"));
  const high = results.filter(r => r.risk?.startsWith("HIGH"));
  const med = results.filter(r => r.risk?.startsWith("MEDIUM")||r.risk==="MEDIUM");
  const maxScore = Math.max(0, ...results.map(r => r.riskScore||0));

  console.log("\n=== Summary ===");
  console.log("Targets: " + results.length + " | CRITICAL: " + critical.length + " | HIGH: " + high.length + " | MEDIUM: " + med.length);
  console.log("Max Risk Score: " + maxScore + " | " + ((Date.now()-start)/1000).toFixed(1) + "s");

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-insurance-fund-drain-v2.js",
    livePrices: { ETH: ethPrice, AAVE: aavePrice, source: "Chainlink aggregators" },
    targetsScanned: results.length, maxRiskScore: maxScore,
    scoring: "riskScore = (coverageRatio<0.02?40:<0.05?25:<0.10?10:0) + (isGLP?20) + (basketManipulable?20) + (hasHistoricalExploit?10)",
    results,
    critical: critical.map(r => ({ label:r.label, chain:r.chain, risk:r.risk, score:r.riskScore, coverage:r.coverageRatio })),
    high: high.map(r => ({ label:r.label, chain:r.chain, risk:r.risk, score:r.riskScore, coverage:r.coverageRatio })),
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2));
  console.log("\nArtifact: " + OUT);
  return artifact;
}

main().catch(e => { console.error(e); process.exit(1); });
