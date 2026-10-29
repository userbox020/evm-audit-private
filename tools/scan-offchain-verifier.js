#!/usr/bin/env node
// scan-offchain-verifier.js — LayerZero DVN/Executor Config Scanner (Novelty #11)
// Detects OApps using 1/1 DVN (single verifier) — KelpDAO $290M attack pattern
// Cross-references with lending collateral to compute blast radius
const fs = require("fs");
const path = require("path");
const { rpcCall, resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "offchain-verifier-risk.json");
const CHAIN_ID = 1;

// LayerZero Endpoint V2 on Ethereum
const LZ_ENDPOINT = "0x1a44076050125825900e736c501f859c50fE728c";
// Morpho Blue on Ethereum
const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
// Aave V3 Pool on Ethereum
const AAVE_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";

// Known OApps from prior LayerZero audit
const KNOWN_OAPPS = [
  { name: "Stargate", addr: "0x8731d54E9D02c286767d56ac03e8037C07e01e98", tokens: ["STG","USDC","USDT","WETH"] },
  { name: "Angle", addr: "0x0E1f20075F657956b96b5dDd7B05bcEf9C1F3D6B", tokens: ["agEUR"] },
  { name: "Radiant", addr: "0x3F569724cce63F7F24C5fF3f3B9B86f2F5f0d5Dc", tokens: ["RDNT","USDC","USDT","WETH"] },
];

async function ethCall(rpc, to, sel, args = "", ms = 8000) {
  const raw = await rpcCall(rpc, "eth_call", [{ to, data: "0x" + sel + args }, "latest"], ms);
  if (!raw || raw === "0x") return null;
  return raw;
}

async function getAaveCollateral(rpc) {
  const reservesHex = await ethCall(rpc, AAVE_POOL, "d1946dbc");
  if (!reservesHex) return [];
  const count = parseInt(reservesHex.slice(66, 130), 16);
  const tokens = [];
  for (let i = 0; i < Math.min(count, 30); i++) {
    tokens.push("0x" + reservesHex.slice(130 + 24 + i * 64, 130 + 64 + i * 64).toLowerCase());
  }
  return tokens;
}

async function getMorphoCollateral() {
  try {
    const r = await fetch("https://api.morpho.org/graphql", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: `{markets(first:200,where:{whitelisted:true,totalBorrowAssets_gt:"0",chainId_in:[1]}){items{collateralAsset{address symbol}loanAsset{address symbol}lltv state{totalBorrowAssetsUsd}}}}` }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json();
    return (j.data?.markets?.items || []).map(m => ({
      collateral: m.collateralAsset?.address?.toLowerCase(),
      loan: m.loanAsset?.address?.toLowerCase(),
      symbol: m.collateralAsset?.symbol,
      lltv: Number(m.lltv) / 1e16,
      borrowUsd: Number(m.state?.totalBorrowAssetsUsd || 0),
    }));
  } catch (_) { return []; }
}

async function getLZConfig(rpc, oapp, dstChainId = 42161) {
  // LZ V2 — confirmed ABI via Etherscan API
  // getSendLibrary(address _oapp, uint32 _dstEid) → address lib
  // getConfig(address _oapp, address _lib, uint32 _eid, uint32 _configType) → bytes config
  // EIDs: Ethereum=30101, Arbitrum=30110, Optimism=30111, Base=30184, BSC=30102, Polygon=30109
  const eidMap = { 1:30101, 42161:30110, 10:30111, 8453:30184, 56:30102, 137:30109 };
  const dstEid = eidMap[dstChainId] || 30110;
  
  // getSendLibrary — selector computed from keccak256('getSendLibrary(address,uint32)') = 0xb96a277f
  const libRaw = await ethCall(rpc, LZ_ENDPOINT, "b96a277f",
    "000000000000000000000000" + oapp.slice(2) + dstEid.toString(16).padStart(64, "0"));
  if (!libRaw) return { error: "no-send-library" };
  const sendLib = "0x" + libRaw.slice(26);
  
  // getConfig — selector computed from keccak256('getConfig(address,address,uint32,uint32)') = 0x14ab31d4
  const configRaw = await ethCall(rpc, LZ_ENDPOINT, "14ab31d4",
    "000000000000000000000000" + oapp.slice(2) +
    "000000000000000000000000" + sendLib.slice(2) +
    dstEid.toString(16).padStart(64, "0") +
    "0000000000000000000000000000000000000000000000000000000000000002"); // configType=2 (ULN/DVN)
  
  if (!configRaw || configRaw === "0x") return { error: "no-config", sendLib };
  
  // Decode ULN config: offset(32) → confirmation(32) → requiredDVNs(32) → optionalDVNs(32) → DVN addresses
  // Simplified: count addresses after requiredDVNs field
  const requiredDVNs = parseInt(configRaw.slice(2 + 64 + 64, 2 + 64 + 64 + 64), 16);
  const dvnAddrs = [];
  for (let i = 0; i < Math.min(requiredDVNs, 20); i++) {
    const addr = "0x" + configRaw.slice(2 + 64 + 64 + 64 + 64 + i * 64 + 24, 2 + 64 + 64 + 64 + 64 + (i + 1) * 64);
    dvnAddrs.push(addr);
  }
  return { sendLib, requiredDVNs, dvnAddresses: dvnAddrs, confirmations: parseInt(configRaw.slice(2 + 64, 2 + 64 + 64), 16) };
}

async function main() {
  console.log("=== Off-Chain Verifier / DVN Risk Scanner ===\n");

  const rpc = await resolveRpc(CHAIN_ID);
  if (!rpc) { console.error("No ETH RPC"); process.exit(1); }

  const results = [];
  const blastRadius = [];

  // 1. Get lending collateral tokens
  console.log("Collecting lending collateral...");
  const [aaveTokens, morphoMarkets] = await Promise.all([
    getAaveCollateral(rpc),
    getMorphoCollateral(),
  ]);
  console.log(`  Aave V3: ${aaveTokens.length} collateral tokens`);
  console.log(`  Morpho Blue: ${morphoMarkets.length} markets`);

  // 2. Check each known OApp
  console.log("\nOApp DVN Config Check:");
  for (const oapp of KNOWN_OAPPS) {
    console.log(`  ${oapp.name} (${oapp.addr.slice(0,10)}...)...`);
    try {
      const config = await getLZConfig(rpc, oapp.addr);
      const dvnCount = config.dvnAddresses?.length || 0;
      const isOneToOne = dvnCount === 1;
      
      // Check if any OApp token is listed as lending collateral
      const lendingExposure = [];
      for (const token of oapp.tokens) {
        if (aaveTokens.includes(oapp.addr.toLowerCase())) {
          lendingExposure.push("Aave V3");
        }
        // Check Morpho
        const morphoExposure = morphoMarkets.filter(m => 
          m.collateral === oapp.addr.toLowerCase() || m.loan === oapp.addr.toLowerCase()
        );
        if (morphoExposure.length > 0) {
          lendingExposure.push(`Morpho (${morphoExposure.length} markets)`);
        }
      }

      const risk = isOneToOne && lendingExposure.length > 0 ? "CRITICAL" :
                   isOneToOne ? "HIGH" :
                   lendingExposure.length > 0 ? "MEDIUM" : "LOW";

      console.log(`    DVNs=${dvnCount} 1:1=${isOneToOne} risk=${risk} exposure=${lendingExposure.join(",") || "none"}`);
      
      results.push({
        oapp: oapp.name,
        address: oapp.addr,
        dvnCount,
        oneToOne: isOneToOne,
        lendingExposure,
        risk,
      });

      if (risk === "CRITICAL" || risk === "HIGH") {
        blastRadius.push({ oapp: oapp.name, risk, lendingExposure, totalBorrowUsd: morphoMarkets.filter(m => lendingExposure.some(e => e.includes("Morpho"))).reduce((s,m) => s + m.borrowUsd, 0) });
      }
    } catch (e) {
      console.log(`    Error: ${e.message?.slice(0, 60)}`);
      results.push({ oapp: oapp.name, error: e.message?.slice(0, 60) });
    }
  }

  // 3. Compute blast radius
  console.log("\nBlast Radius (1:1 DVN + lending exposure):");
  for (const b of blastRadius) {
    console.log(`  ${b.oapp}: ${b.risk} — borrow exposure=$${(b.totalBorrowUsd/1e6).toFixed(1)}M across ${b.lendingExposure.join(", ")}`);
  }

  // 4. Summary
  const critical = results.filter(r => r.risk === "CRITICAL");
  const highRisk = results.filter(r => r.risk === "HIGH");
  console.log(`\n=== Summary ===`);
  console.log(`OApps scanned: ${KNOWN_OAPPS.length}`);
  console.log(`CRITICAL (1/1 DVN + lending collateral): ${critical.length}`);
  console.log(`HIGH (1/1 DVN, no lending): ${highRisk.length}`);
  console.log(`Attack model: Compromise single DVN/Executor → forge cross-chain messages → mint/burn tokens → exploit lending collateral`);

  fs.writeFileSync(OUT, JSON.stringify({
    scannedAt: new Date().toISOString(),
    chainId: CHAIN_ID,
    oappsScanned: KNOWN_OAPPS.length,
    criticalOApps: critical.length,
    highRiskOApps: highRisk.length,
    results,
    blastRadius,
    note: "KelpDAO $290M precedent — single verifier compromise enables forged cross-chain messages. Any OApp token accepted as lending collateral at high LTV creates a bridge→lending cascade risk.",
  }, null, 2));
  console.log(`\nArtifact: ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
