#!/usr/bin/env node
// scan-wsteth-dex-discount.js — wstETH DEX discount → unwrap arbitrage scanner
// Checks if wstETH trades below stETH backing on DEX, enabling:
// flash-loan ETH → buy wstETH at discount → unwrap to stETH → sell stETH for ETH → profit
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "wsteth-dex-discount.json");
const CHAIN_ID = 1;

main().catch(e => { console.error(e); process.exit(1); });
