#!/usr/bin/env node
// Lido Phase 1: Withdrawal Queue NFT Arbitrage Scanner
// Reads WithdrawalQueueERC721 state: queue depth, finalized-but-unclaimed ETH,
// NFT claimability, and GateSeal status.
// The attack: finalized positions have claimable ETH waiting. The unstETH NFT
// is ERC-721 transferable. Acquiring a discounted NFT = claiming the ETH = profit.
// RPC URLs resolved in memory only.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "lido-withdrawal-queue-scan.json");
const QUIET = process.argv.includes("--quiet");
const CHAIN_ID = 1; const TIMEOUT_MS = 15000;

const WITHDRAWAL_QUEUE = "0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1";
const LIDO_PROXY = "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84";
const WSTETH = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0";
const GATESEAL = "0x8A854C4E750CDf24f138f34A9061b2f556066912";

const WQ_ABI = [
  "function getLastRequestId() view returns (uint256)",
  "function getLastCheckpointIndex() view returns (uint256)",
  "function getLastFinalizedRequestId() view returns (uint256)",
  "function unfinalizedStETH() view returns (uint256)",
  "function unfinalizedRequestNumber() view returns (uint256)",
  "function getLockedEtherAmount() view returns (uint256)",
  "function isClaimable(uint256 requestId) view returns (bool)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function getWithdrawalStatus(uint256[] requestIds) view returns (tuple(uint256,uint256,uint256,bool,bytes32)[])",
  "function balanceOf(address owner) view returns (uint256)",
];

const GS_ABI = [
  "function getSealExpiryTimestamp() view returns (uint256)",
  "function isExpired() view returns (bool)",
  "function sealedContract() view returns (address)",
  "function sealDuration() view returns (uint256)",
];

function round(v,d=6){const n=typeof v==="number"?v:Number(String(v).replace(/[$,%_\\s]/g,""));if(!Number.isFinite(n))return null;const f=10**d;return Math.round(n*f)/f}

main().catch(e => { console.error(e.stack || e.message); process.exitCode = 1; });
