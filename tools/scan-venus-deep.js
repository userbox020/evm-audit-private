#!/usr/bin/env node
// scan-venus-deep.js — Venus Protocol deep audit: BSC legacy core + multichain isolated pools + permissioned surfaces.
// Read-only. No signed transactions.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const OUT_BSC = path.join(OUT_DIR, "venus-bsc-legacy-deep.json");
const OUT_MULTI = path.join(OUT_DIR, "venus-multichain-deep.json");
const TIMEOUT = 15_000;

// ============= RPC RESOLVER =============

function toNum(n) { if (n == null) return 0; if (typeof n === "bigint") return Number(n); if (typeof n === "number") return n; try { return Number(BigInt(n)); } catch { return Number(n) || 0; } }
function toStr(n) { if (n == null) return "0"; return String(n); }
function fmt(n, dec) { const num = toNum(n); return num ? num / (10 ** dec) : 0; }
function fmtWad(n) { const num = toNum(n); return num ? (num / 1e16).toFixed(2) + "%" : "?"; }
function fmtRate(n) { const num = toNum(n); return num ? (num / 1e16).toFixed(2) + "%" : "?"; }
function bool(b) { return b === true || b === "true"; }
async function mc(contract, method, ...args) {
  try { return await contract[method](...args, { blockTag: "latest" }); } catch (e) { return null; }
}

// ============= ABIs =============
const VTOKEN_ABI = [
  "function underlying() view returns (address)",
  "function getCash() view returns (uint256)",
  "function totalBorrows() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function symbol() view returns (string)",
  "function borrowRatePerBlock() view returns (uint256)",
  "function supplyRatePerBlock() view returns (uint256)",
  "function interestRateModel() view returns (address)",
];

const COMPTROLLER_LEGACY_ABI = [
  "function getAllMarkets() view returns (address[])",
  "function markets(address) view returns (bool,uint256,bool,uint256,uint256,uint96,bool)",
  "function oracle() view returns (address)",
  "function admin() view returns (address)",
  "function pauseGuardian() view returns (address)",
  "function pendingAdmin() view returns (address)",
  "function comptrollerImplementation() view returns (address)",
  "function pendingComptrollerImplementation() view returns (address)",
  "function supplyCaps(address) view returns (uint256)",
  "function borrowCaps(address) view returns (uint256)",
  "function closeFactorMantissa() view returns (uint256)",
  "function liquidationIncentiveMantissa() view returns (uint256)",
  "function actionPaused(address,uint8) view returns (bool)",
  "function isForcedLiquidationEnabled(address) view returns (bool)",
  "function getXVSAddress() view returns (address)",
  "function getXVSVTokenAddress() view returns (address)",
  "function protocolPaused() view returns (bool)",
  "function isFlashLoanPaused() view returns (bool)",
  "function flashLoanPaused() view returns (bool)",
  "function treasuryAddress() view returns (address)",
  "function treasuryPercent() view returns (uint256)",
  "function authorizedFlashLoan(address) view returns (bool)",
  "function corePoolId() view returns (uint96)",
];

const COMPTROLLER_ISO_ABI = [
  "function getAllMarkets() view returns (address[])",
  "function markets(address) view returns (bool,uint256,uint256)",
  "function oracle() view returns (address)",
  "function owner() view returns (address)",
  "function accessControlManager() view returns (address)",
  "function supplyCaps(address) view returns (uint256)",
  "function borrowCaps(address) view returns (uint256)",
  "function closeFactorMantissa() view returns (uint256)",
  "function liquidationIncentiveMantissa() view returns (uint256)",
  "function minLiquidatableCollateral() view returns (uint256)",
  "function actionPaused(address,uint8) view returns (bool)",
  "function isForcedLiquidationEnabled(address) view returns (bool)",
];

const RESILIENT_ORACLE_ABI = [
  "function getTokenConfig(address) view returns (tuple(address asset, address[3] oracles, bool[3] enableFlagsForOracles))",
  "function getUnderlyingPrice(address) view returns (uint256)",
  "function getPrice(address) view returns (uint256)",
  "function getOracle(address,uint8) view returns (address,bool)",
  "function accessControlManager() view returns (address)",
];

const PRICE_ORACLE_LEGACY_ABI = [
  "function getUnderlyingPrice(address) view returns (uint256)",
];

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
];

const ACCESS_CONTROL_ABI = [
  "function isAllowedToCall(address,string) view returns (bool)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function getRoleAdmin(bytes32) view returns (bytes32)",
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
];

const CHAINLINK_ORACLE_ABI = [
  "function getTokenConfig(address) view returns (tuple(address asset, address[3] oracles, bool[3] enableFlagsForOracles))",
  "function maxStalePeriod(address) view returns (uint256)",
  "function getPrice(address) view returns (uint256)",
];

const CHAINLINK_FEED_ABI = [
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  "function aggregator() view returns (address)",
  "function description() view returns (string)",
  "function decimals() view returns (uint8)",
];

// ============= BSC LEGACY CORE =============
async function scanBscLegacy(provider) {
  console.log("\n=== BSC Legacy Core Pool ===");
  const comptroller = new ethers.Contract(
    "0xfD36E2c2a6789Db23113685031d7F16329158384",
    COMPTROLLER_LEGACY_ABI, provider
  );

  // Permissioned surfaces
  const perm = {};
  perm.comptroller_admin = await mc(comptroller, "admin");
  perm.pauseGuardian = await mc(comptroller, "pauseGuardian");
  perm.pendingAdmin = await mc(comptroller, "pendingAdmin");
  perm.impl = await mc(comptroller, "comptrollerImplementation");
  perm.pendingImpl = await mc(comptroller, "pendingComptrollerImplementation");
  perm.closeFactor = fmtWad(await mc(comptroller, "closeFactorMantissa"));
  perm.liqIncentive = fmtWad(await mc(comptroller, "liquidationIncentiveMantissa"));
  perm.protocolPaused = await mc(comptroller, "protocolPaused");
  perm.flashLoanPaused = await mc(comptroller, "flashLoanPaused");
  perm.treasury = await mc(comptroller, "treasuryAddress");
  perm.treasuryPct = await mc(comptroller, "treasuryPercent");
  perm.xvsAddr = await mc(comptroller, "getXVSAddress");
  perm.corePoolId = await mc(comptroller, "corePoolId");

  console.log("  Permissioned surfaces:");
  console.log(`    Admin:     ${perm.comptroller_admin}`);
  console.log(`    PauseGuard:${perm.pauseGuardian}`);
  console.log(`    Pending:   ${perm.pendingAdmin}`);
  console.log(`    Treasury:  ${perm.treasury} (${perm.treasuryPct ? (Number(perm.treasuryPct)/1e16).toFixed(2)+"%" : "?"})`);
  console.log(`    XVS:       ${perm.xvsAddr}`);
  console.log(`    Paused:    protocol=${perm.protocolPaused} flashLoan=${perm.flashLoanPaused}`);
  console.log(`    CloseFact: ${perm.closeFactor} LiqIncent: ${perm.liqIncentive}`);

  // Oracle
  const oracleAddr = await mc(comptroller, "oracle");
  console.log(`\n  Oracle: ${oracleAddr}`);

  // Get all markets
  let markets = await mc(comptroller, "getAllMarkets");
  if (!markets || !markets.length) {
    markets = await mc(comptroller, "allMarkets"); // fallback
  }
  if (!markets || !markets.length) {
    console.log("  ERROR: Could not get market list");
    return { perm, markets: [] };
  }
  console.log(`  Markets: ${markets.length} total`);

  const rows = [];
  const BATCH = 5;

  for (let i = 0; i < markets.length; i += BATCH) {
    const batch = markets.slice(i, i + BATCH);
    const batchResults = await Promise.all(batch.map(async (vtoken) => {
      const vc = new ethers.Contract(vtoken, VTOKEN_ABI, provider);

      const [mkt, underlying, cashB, borrowsB, supplyB, symbol, borrowCapsRaw, supplyCapsRaw,
        borrowPaused, liquidatePaused, forcedLiq, borrowRate, supplyRate, irm,
        oraclePriceRaw] = await Promise.all([
          mc(comptroller, "markets", vtoken),
          mc(vc, "underlying"),
          mc(vc, "getCash"),
          mc(vc, "totalBorrows"),
          mc(vc, "totalSupply"),
          mc(vc, "symbol"),
          mc(comptroller, "borrowCaps", vtoken),
          mc(comptroller, "supplyCaps", vtoken),
          mc(comptroller, "actionPaused", vtoken, 2),
          mc(comptroller, "actionPaused", vtoken, 5),
          mc(comptroller, "isForcedLiquidationEnabled", vtoken),
          mc(vc, "borrowRatePerBlock"),
          mc(vc, "supplyRatePerBlock"),
          mc(vc, "interestRateModel"),
          oracleAddr ? mc(new ethers.Contract(oracleAddr, PRICE_ORACLE_LEGACY_ABI, provider), "getUnderlyingPrice", vtoken) : null,
        ]);

      let assetSymbol = "", assetDecimals = 18, totalSupplyAsset = "?";
      if (underlying && underlying !== "0x0000000000000000000000000000000000000000") {
        const uc = new ethers.Contract(underlying, ERC20_ABI, provider);
        const [sym, dec, ts] = await Promise.all([
          mc(uc, "symbol"), mc(uc, "decimals"), mc(uc, "totalSupply")
        ]);
        assetSymbol = sym || "?";
        assetDecimals = Number(dec || 18);
        totalSupplyAsset = fmt(ts, assetDecimals);
      }

      const decimals = assetDecimals || 18;
      let listed = false, cfMantissa = 0n, ltMantissa = 0n;
      if (mkt && Array.isArray(mkt)) {
        // BSC legacy: (bool listed, uint collateralFactorMantissa, bool isComped, uint liquidationThresholdMantissa, ...)
        listed = mkt[0];
        cfMantissa = BigInt(mkt[1] || 0);
        ltMantissa = BigInt(mkt[3] || 0);
      }

      const cash = cashB ? fmt(cashB, decimals) : 0;
      const borrows = borrowsB ? fmt(borrowsB, decimals) : 0;
      const supply = supplyB ? fmt(supplyB, decimals) : 0;

      // Compute USD values from oracle price
      const oraclePrice = oraclePriceRaw ? Number(ethers.formatUnits(oraclePriceRaw, 18 + (18 - decimals))) : 0;
      const cashUsd = cash * oraclePrice;
      const borrowsUsd = borrows * oraclePrice;

      // Risk flags
      const flags = [];
      if (listed && cfMantissa >= 750000000000000000n) flags.push("cf>=75%");
      if (borrowPaused) flags.push("borrowPaused");
      if (liquidatePaused) flags.push("liquidatePaused");
      if (forcedLiq) flags.push("forcedLiq");
      if (supplyCapsRaw === 0n) flags.push("supplyCap=0");
      if (borrowCapsRaw === 0n) flags.push("borrowCap=0");
      if (symbol && /PT-|wst|weETH|rsETH|puf|sfrx|sUSDe|USDe|gm|yv|super/i.test(symbol)) flags.push("wrapperOrLP");

      return {
        vtoken,
        symbol: symbol || "?",
        assetSymbol,
        underlying: underlying || "native",
        decimals,
        listed,
        cf: cfMantissa ? fmtWad(cfMantissa) : "0%",
        lt: ltMantissa ? fmtWad(ltMantissa) : "0%",
        oraclePrice,
        cash, cashUsd: Math.round(cashUsd),
        borrows, borrowsUsd: Math.round(borrowsUsd),
        supply,
        totalSupplyAsset,
        supplyCap: supplyCapsRaw ? (supplyCapsRaw === ethers.MaxUint256 ? "max" : fmt(supplyCapsRaw, decimals)) : "?",
        borrowCap: borrowCapsRaw ? (borrowCapsRaw === ethers.MaxUint256 ? "max" : fmt(borrowCapsRaw, decimals)) : "?",
        borrowPaused: bool(borrowPaused),
        liquidatePaused: bool(liquidatePaused),
        forcedLiquidation: bool(forcedLiq),
      borrowRatePerBlock: borrowRate ? fmtRate(borrowRate) : "?",
      supplyRatePerBlock: supplyRate ? fmtRate(supplyRate) : "?",
        interestRateModel: irm || "?",
        flags: flags.join(","),
      };
    }));

    rows.push(...batchResults);
    const done = Math.min(i + BATCH, markets.length);
    process.stdout.write(`\r  Processing ${done}/${markets.length}`);
  }
  console.log("");

  // Summary stats
  const listed = rows.filter(r => r.listed);
  const highCF = rows.filter(r => r.listed && r.cf !== "0%" && parseFloat(r.cf) >= 75);
  const borrowable = rows.filter(r => r.listed && !r.borrowPaused && r.borrowCap !== "0");
  const totalCashUsd = listed.reduce((s, r) => s + (r.cashUsd || 0), 0);
  const totalBorrowsUsd = listed.reduce((s, r) => s + (r.borrowsUsd || 0), 0);

  console.log(`\n  Summary:`);
  console.log(`    Total markets: ${markets.length}`);
  console.log(`    Listed: ${listed.length}`);
  console.log(`    High-CF (>=75%): ${highCF.length}`);
  console.log(`    Borrowable: ${borrowable.length}`);
  console.log(`    Total Cash USD: $${(totalCashUsd/1e6).toFixed(1)}M`);
  console.log(`    Total Borrows USD: $${(totalBorrowsUsd/1e6).toFixed(1)}M`);

  return { perm, rows, summary: { total: markets.length, listed: listed.length, highCF: highCF.length, borrowable: borrowable.length, totalCashUsd, totalBorrowsUsd, oracle: oracleAddr } };
}

// ============= ISOLATED POOLS MULTICHAIN =============
const ISO_CHAINS = {
  ethereum:    { chainId: 1,    comp: "0x687a01ecF6d3907658f7A7c714749fAC32336D1B" },
  basemainnet: { chainId: 8453, comp: "0x0C7973F9598AA62f9e03B94E92C967fD5437426C" },
  arbitrumone: { chainId: 42161, comp: "0x317c1A5739F39046E20b08ac9BeEa3f10fD43326" },
  opmainnet:   { chainId: 10,   comp: "0x5593FF68bE84C966821eF5F0a988C285D5B7CeC8" },
  unichainmainnet: { chainId: 130, comp: "0xC02c0786Ccd5f349eF2B3867e550F7E30556A5c7" },
  bscmainnet:  { chainId: 56,   comp: "0x79A56c1Fc7F52c7B9A0c7FdE7F6479aCc6Ad8dE4" },
};

async function scanIsolatedChain(name, cfg, provider) {
  console.log(`\n  --- ${name} ---`);
  const comp = new ethers.Contract(cfg.comp, COMPTROLLER_ISO_ABI, provider);

  const [owner, acm, oracle, closeFactor, liqIncentive, minLiq, markets] = await Promise.all([
    mc(comp, "owner"),
    mc(comp, "accessControlManager"),
    mc(comp, "oracle"),
    mc(comp, "closeFactorMantissa"),
    mc(comp, "liquidationIncentiveMantissa"),
    mc(comp, "minLiquidatableCollateral"),
    mc(comp, "getAllMarkets"),
  ]);

  console.log(`    Owner: ${owner}  ACM: ${acm}`);
  console.log(`    Oracle: ${oracle}  CloseFac: ${fmtWad(closeFactor)}  LiqInc: ${fmtWad(liqIncentive)}  MinLiq: $${fmt(minLiq, 18)}`);

  if (!markets || !markets.length) {
    console.log(`    No markets found`);
    return { comp: cfg.comp, owner, acm, oracle, closeFactor: fmtWad(closeFactor), liqIncentive: fmtWad(liqIncentive), minLiq: fmt(minLiq, 18), rows: [] };
  }

  const oracleContract = new ethers.Contract(oracle, RESILIENT_ORACLE_ABI, provider);
  const rows = [];

  for (const vtoken of markets) {
    const vc = new ethers.Contract(vtoken, VTOKEN_ABI, provider);

    const [mkt, underlying, cashB, borrowsB, supplyB, symbol, borrowCapsRaw, supplyCapsRaw,
      borrowPaused, liquidatePaused, forcedLiq] = await Promise.all([
        mc(comp, "markets", vtoken),
        mc(vc, "underlying"),
        mc(vc, "getCash"),
        mc(vc, "totalBorrows"),
        mc(vc, "totalSupply"),
        mc(vc, "symbol"),
        mc(comp, "borrowCaps", vtoken),
        mc(comp, "supplyCaps", vtoken),
        mc(comp, "actionPaused", vtoken, 2),
        mc(comp, "actionPaused", vtoken, 5),
        mc(comp, "isForcedLiquidationEnabled", vtoken),
      ]);

    let asset = underlying, assetSymbol = "", assetDecimals = 18;
    if (underlying && underlying !== ethers.ZeroAddress) {
      const uc = new ethers.Contract(underlying, ERC20_ABI, provider);
      const [sym, dec] = await Promise.all([mc(uc, "symbol"), mc(uc, "decimals")]);
      assetSymbol = sym || "?";
      assetDecimals = Number(dec || 18);
    }

    const decimals = assetDecimals || 18;
    let listed = false, cfMantissa = 0n, ltMantissa = 0n;
    if (mkt) { listed = mkt[0]; cfMantissa = BigInt(mkt[1] || 0); ltMantissa = BigInt(mkt[2] || 0); }

    // Oracle config
    let oracleCfg = { mainOracle: "", pivotOracle: "", fallbackOracle: "", flags: "" };
    if (underlying && underlying !== ethers.ZeroAddress) {
      try {
        const tcfg = await mc(oracleContract, "getTokenConfig", underlying);
        if (tcfg && tcfg.oracles && tcfg.enableFlagsForOracles) {
          oracleCfg = {
            mainOracle: tcfg.oracles[0] || "",
            pivotOracle: tcfg.oracles[1] || "",
            fallbackOracle: tcfg.oracles[2] || "",
            flags: tcfg.enableFlagsForOracles.join(","),
          };
        }
      } catch (_) { }
    }

    const cash = cashB ? fmt(cashB, decimals) : 0;
    const borrows = borrowsB ? fmt(borrowsB, decimals) : 0;

    const flags = [];
    if (listed && cfMantissa >= 750000000000000000n) flags.push("cf>=75%");
    if (oracleCfg.flags === "true,false,false") flags.push("singleOracle");
    if (borrowPaused) flags.push("borrowPaused");
    if (liquidatePaused) flags.push("liquidatePaused");
    if (forcedLiq) flags.push("forcedLiq");
    if (borrowCapsRaw === 0n) flags.push("borrowCap=0");
    if (supplyCapsRaw === 0n) flags.push("supplyCap=0");

    rows.push({
      vtoken, symbol: symbol || "?", assetSymbol, asset: asset || "native",
      listed, cf: fmtWad(cfMantissa), lt: fmtWad(ltMantissa),
      decimals, cash, borrows, supply: supplyB ? fmt(supplyB, decimals) : 0,
      supplyCap: supplyCapsRaw ? (supplyCapsRaw === ethers.MaxUint256 ? "max" : fmt(supplyCapsRaw, decimals)) : "?",
      borrowCap: borrowCapsRaw ? (borrowCapsRaw === ethers.MaxUint256 ? "max" : fmt(borrowCapsRaw, decimals)) : "?",
      borrowPaused: bool(borrowPaused), liquidatePaused: bool(liquidatePaused),
      forcedLiquidation: bool(forcedLiq),
      oracle: oracleCfg,
      flags: flags.join(","),
    });
  }

  const listedCount = rows.filter(r => r.listed).length;
  const singleOracle = rows.filter(r => r.flags.includes("singleOracle")).length;
  console.log(`    Markets: ${markets.length} total, ${listedCount} listed, ${singleOracle} single-oracle`);

  return {
    comp: cfg.comp, owner, acm, oracle,
    closeFactor: fmtWad(closeFactor), liqIncentive: fmtWad(liqIncentive), minLiq: fmt(minLiq, 18),
    rows,
  };
}

async function scanIsolatedPools(providerMap) {
  console.log("\n=== Isolated Pools Multichain ===");
  const results = {};
  for (const [name, cfg] of Object.entries(ISO_CHAINS)) {
    const provider = providerMap[name === "bscmainnet" ? "bsc" : name] || providerMap.default;
    if (!provider) { console.log(`  SKIP ${name}: no provider`); continue; }
    try {
      results[name] = await scanIsolatedChain(name, cfg, provider);
    } catch (e) {
      console.log(`  ERROR ${name}: ${e.message}`);
    }
  }
  return results;
}

// ============= MAIN =============
async function main() {
  console.log("Venus Deep Audit Scanner");

  // Resolve providers
  const bscUrl = await resolveRpc(56);
  if (!bscUrl) { console.error("No BSC RPC available"); process.exit(1); }
  const bscProvider = new ethers.JsonRpcProvider(bscUrl, 56, { staticNetwork: true });

  const ethUrl = await resolveRpc(1);
  const ethProvider = ethUrl ? new ethers.JsonRpcProvider(ethUrl, 1, { staticNetwork: true }) : null;

  console.log(`BSC RPC: ${bscUrl.slice(0,50)}...`);
  console.log(`ETH RPC: ${ethUrl ? ethUrl.slice(0,50)+"..." : "N/A"}`);

  // BSC Legacy Core
  const bscResult = await scanBscLegacy(bscProvider);
  fs.writeFileSync(OUT_BSC, JSON.stringify(bscResult, (key, value) => typeof value === "bigint" ? value.toString() : value, 2));
  console.log(`\nBSC artifact written: ${OUT_BSC}`);

  // Isolated pools multichain (use eth as default, bsc for bscmainnet)
  const providerMap = { default: ethProvider, bsc: bscProvider };
  const isoResult = await scanIsolatedPools(providerMap);
  fs.writeFileSync(OUT_MULTI, JSON.stringify(isoResult, (key, value) => typeof value === "bigint" ? value.toString() : value, 2));
  console.log(`\nMultichain artifact written: ${OUT_MULTI}`);

  // Permissioned surface summary
  console.log("\n=== Permissioned Surface Summary ===");
  console.log(`\nBSC Legacy Core:`);
  console.log(`  Admin:   ${bscResult.perm.comptroller_admin}`);
  console.log(`  PauseGuard: ${bscResult.perm.pauseGuardian}  ProtocolPaused: ${bscResult.perm.protocolPaused}`);
  console.log(`  Treasury: ${bscResult.perm.treasury} (${bscResult.perm.treasuryPct ? (Number(bscResult.perm.treasuryPct)/1e16).toFixed(2)+"%" : "?"})`);

  for (const [name, result] of Object.entries(isoResult)) {
    console.log(`\n${name} Isolated:`);
    console.log(`  Owner:  ${result.owner}`);
    console.log(`  ACM:    ${result.acm}`);
    console.log(`  Oracle: ${result.oracle}`);
  }

  // Attack surface analysis
  console.log("\n=== Attack Surface Analysis ===");

  // BSC Legacy: check for high-CF borrowable markets with single oracle dependencies
  const highRiskBsc = bscResult.rows.filter(r => {
    if (!r.listed) return false;
    const cf = parseFloat(r.cf);
    if (cf < 75 || isNaN(cf)) return false;
    if (r.borrowPaused || parseFloat(String(r.borrowCap)) <= 0) return false;
    return true;
  });
  console.log(`\nBSC Legacy high-CF borrowable: ${highRiskBsc.length}`);
  for (const r of highRiskBsc.slice(0, 10)) {
    console.log(`  ${r.symbol.padEnd(20)} CF:${r.cf.padEnd(8)} LT:${r.lt.padEnd(8)} Cash:$${Math.round(r.cashUsd||0).toLocaleString().padEnd(12)} Borrows:$${Math.round(r.borrowsUsd||0).toLocaleString()}`);
  }

  // Isolated: single-oracle high-CF
  for (const [name, result] of Object.entries(isoResult)) {
    const highRiskIso = result.rows.filter(r => {
      if (!r.listed) return false;
      const cf = parseFloat(r.cf);
      if (cf < 75 || isNaN(cf)) return false;
      if (r.borrowPaused || String(r.borrowCap) === "0") return false;
      if (!r.oracle.flags.includes("true,false,false")) return false;
      return true;
    });
    if (highRiskIso.length > 0) {
      console.log(`\n${name} single-oracle high-CF borrowable: ${highRiskIso.length}`);
      for (const r of highRiskIso) {
        console.log(`  ${r.symbol.padEnd(20)} CF:${r.cf.padEnd(8)} LT:${r.lt.padEnd(8)} Oracle:${r.oracle.mainOracle}`);
      }
    }
  }

  console.log("\nDone.");
}

main().catch(e => { console.error(e); process.exit(1); });
