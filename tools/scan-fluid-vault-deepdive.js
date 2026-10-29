#!/usr/bin/env node
// Fluid/Instadapp deep-dive: fUSDC/fUSDT vault oracle freshness + liquidation configs
// Extends existing E5/E8 evaluators. RPC URLs resolved in memory only.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "fluid-vault-deepdive.json");
const CHAIN_ID = 1; const TIMEOUT_MS = 15000;

// Known Fluid VaultT1 addresses
const VAULTS = [
  { name: "wstETH/USDC", vault: "0x348aD11DB2c90e7FdF8e57420C569F76dBe38a59", oracle: "0x122Bd7fBacef5d42CB178CbA71DF03D03d3E8821", monitored: "E8" },
  { name: "fUSDC", vault: "0x9Fb7Bbe6BfDf28882c0c21eCABe2f93cbD9e3269", oracle: null, monitored: null },
  { name: "fUSDT", vault: "0x5C20B5504ecEf2c3A00e8CEA12B90f749AcC7BFE", oracle: null, monitored: null },
  { name: "Instadapp Lite", vault: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", oracle: null, monitored: null },
];

const VT1_ABI = [
  "function operate(uint256,uint256,uint256,uint256,address) returns (uint256,uint256)",
  "function vaultType() view returns (uint256)",
  "function supplyToken() view returns (address)",
  "function borrowToken() view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function totalBorrow() view returns (uint256)",
  "function exchangeRate() view returns (uint256)",
  "function liquidationMaxLTV() view returns (uint256)",
  "function liquidationRatio() view returns (uint256)",
  "function oracle() view returns (address)",
  "function isPaused() view returns (bool)",
  "function constantsView() view returns (tuple(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256))",
];

function round(v,d=6){const n=typeof v==="number"?v:Number(String(v).replace(/[$,%_\\s]/g,""));if(!Number.isFinite(n))return null;const f=10**d;return Math.round(n*f)/f}

main().catch(e => { console.error(e.stack || e.message); process.exitCode = 1; });
