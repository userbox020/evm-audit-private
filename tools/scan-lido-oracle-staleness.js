#!/usr/bin/env node
// Lido Phase 2+3: Oracle Report Staleness + Stake Limit Analysis
// Reads AccountingOracle report freshness, cross-protocol oracle divergence,
// and stake limit dynamics. RPC URLs resolved in memory only.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "lido-oracle-staleness.json");
const QUIET = process.argv.includes("--quiet");
const CHAIN_ID = 1; const TIMEOUT_MS = 15000;

const ACCOUNTING_ORACLE = "0x852deD011285fe67063a08005c71a85690503Cee";
const HASH_CONSENSUS = "0xD624B08C83bAECF0807Dd2c6880C3154a5F0B288";
const STAKING_ROUTER = "0xFdDf38947aFB03C621C71b06C9C70bce73f12999";
const WSTETH_ADDR = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0";
const STETH_ADDR = "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84";
const WITHDRAWAL_QUEUE = "0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1";

const AO_ABI = [
  "function getProcessingState() view returns (tuple(uint256,uint256,uint256,bool))",
  "function getLastProcessingRefSlot() view returns (uint256)",
  "function getConsensusVersion() view returns (uint256)",
  "function getContractVersion() view returns (uint256)",
];
const HC_ABI = [
  "function getCurrentFrame() view returns (uint256,uint256,uint256)",
  "function getConsensusState() view returns (tuple(uint256,uint256,uint256,bool,bool,bool))",
  "function getIsMember(address) view returns (bool)",
  "function getQuorum() view returns (uint256)",
  "function getFastLaneLengthSlots() view returns (uint256)",
];
const SR_ABI = [
  "function getStakeLimitFullInfo() view returns (uint256,uint256,uint256,uint256,uint256,uint256,bool,uint256,uint256)",
  "function getWithdrawalCredentials() view returns (bytes32)",
];
const W_ABI = [
  "function stEthPerToken() view returns (uint256)",
  "function tokensPerStEth() view returns (uint256)",
];

function round(v,d=6){const n=typeof v==="number"?v:Number(String(v).replace(/[$,%_\\s]/g,""));if(!Number.isFinite(n))return null;const f=10**d;return Math.round(n*f)/f}

main().catch(e => { console.error(e.stack || e.message); process.exitCode = 1; });
