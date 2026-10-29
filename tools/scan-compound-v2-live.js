#!/usr/bin/env node
// scan-compound-v2.js — Compound V2 live state scanner
// Comptroller + all cToken markets + PriceOracle
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
const { rpcCall, resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "compound-v2-live.json");
const CHAIN_ID = 1;

main().catch(e => { console.error(e); process.exit(1); });
