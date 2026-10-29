#!/usr/bin/env node
// EigenLayer Attacks B+C: Slashing griefing event scan + Rehypothecation chain drift
// B: Watches AllocationManager/DelegationManager events for same-block slash+deallocate griefing
// C: Traces stETH→EigenLayer→LRT→Morpho rehypothecation chain, computes cumulative drift
// RPC URLs resolved in memory only.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "eigenlayer-slashing-rehypothecation.json");
const CHAIN_ID = 1; const TIMEOUT_MS = 15000;
const LOOKBACK_BLOCKS = 50000;

const CONTRACTS = {
  allocationManager: "0x948a420b8CC1d6BFd0B6087C2E7c344a2CD0bc39",
  delegationManager: "0x39053D51B77DC0d36036Fc1fCc8Cb819df8Ef37A",
  strategyManager: "0x858646372CC42E1A627fcE94aa7A7033e7CF075A",
};
const STETH = "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84";
const WSTETH = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0";
const STETH_STRATEGY = "0x93c4b944D05dfe6df7645A86cd2206016c51564D";

const SLASH_TOPIC = "0x" + ethers.id("OperatorSlashed(address,bytes32,uint32[],uint256[])").slice(2);
const ALLOC_UPDATE_TOPIC = "0x" + ethers.id("OperatorSetAllocationUpdated(address,bytes32,(address[],uint64[]))").slice(2);

function round(v,d=6){const n=typeof v==="number"?v:Number(String(v).replace(/[$,%_\\s]/g,""));if(!Number.isFinite(n))return null;const f=10**d;return Math.round(n*f)/f}

main().catch(e=>{console.error(e.stack||e.message);process.exitCode=1});
