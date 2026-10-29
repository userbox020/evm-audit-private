#!/usr/bin/env node
// Cooler Loans (Olympus V3) Phase 1: Live State Probe
// Reads MonoCooler + CoolerLtvOracle live state.
// RPC URLs resolved in memory only.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "cooler-loans-live-state.json");
const QUIET = process.argv.includes("--quiet");
const CHAIN_ID = 1; const TIMEOUT_MS = 15000;

const MONO_COOLER = "0xdb591Ea2e5Db886dA872654D58f6cc584b68e7cC";

const COOLER_ABI = [
  "function ltvOracle() view returns (address)",
  "function interestRateWad() view returns (uint96)",
  "function borrowsPaused() view returns (bool)",
  "function liquidationsPaused() view returns (bool)",
  "function treasuryBorrower() view returns (address)",
  "function collateralToken() view returns (address)",
  "function debtToken() view returns (address)",
  "function totalCollateral() view returns (uint128)",
  "function totalDebt() view returns (uint128)",
  "function accountState(address) view returns (tuple(uint128 collateral, uint128 debt, uint128 interestRate, uint128 latestBlock, uint128 interestIndex, uint128 prevInterestIndex))",
];

const ORACLE_ABI = [
  "function currentLtvs() view returns (uint96 originationLtv, uint96 liquidationLtv)",
  "function currentOriginationLtv() view returns (uint96)",
  "function originationLtvData() view returns (tuple(uint96 startingValue, uint96 targetValue, uint40 startTime, uint40 targetTime, uint96 slope, uint64 maxOriginationLtvDelta, uint32 minOriginationLtvTargetTimeDelta, uint96 maxOriginationLtvRateOfChange, uint64 maxLiquidationLtvPremiumBps, uint64 liquidationLtvPremiumBps))",
  "function maxOriginationLtvDelta() view returns (uint96)",
  "function maxLiquidationLtvPremiumBps() view returns (uint64)",
  "function liquidationLtvPremiumBps() view returns (uint64)",
];

const ERC20_ABI = ["function symbol() view returns (string)", "function decimals() view returns (uint8)", "function totalSupply() view returns (uint256)"];

function round(v,d=6){const n=typeof v==="number"?v:Number(String(v).replace(/[$,%_\\s]/g,""));if(!Number.isFinite(n))return null;const f=10**d;return Math.round(n*f)/f}

main().catch(e => { console.error(e.stack || e.message); process.exitCode = 1; });
