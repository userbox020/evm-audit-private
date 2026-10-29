#!/usr/bin/env node
// scan-rusd-psm-arbitrage.js — Reservoir rUSD PSM premium scanner
// Checks if rUSD trades >$1.00 on DEX. If so, flash-loan USDC → PSM.mint → sell rUSD → profit
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "rusd-psm-arbitrage.json");
const CHAIN_ID = 1;

main().catch(e => { console.error(e); process.exit(1); });
