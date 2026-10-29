#!/usr/bin/env node
// EigenLayer Attack A: LRT NAV-DEX Divergence Scanner
// Compares on-chain LRT rate vs DEX market price.
// Rate functions: weETH→amountForShare(1e18), pufETH→convertToAssets(1e18)
// DeFiLlama for DEX market prices.
// Cross-references with Morpho/Aave LRT collateral listings for route viability.
// RPC URLs resolved in memory only.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "eigenlayer-lrt-nav-dex-divergence.json");
const QUIET = process.argv.includes("--quiet");
const CHAIN_ID = 1; const TIMEOUT_MS = 15000;

const LRTS = [
  { symbol: "weETH", addr: "0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee",
    rateTarget: "0x308861A430be4cce5502d0A12724771Fc6DaF216",
    rateFn: "amountForShare(uint256)", rateArg: ethers.parseUnits("1",18),
  },
  { symbol: "ezETH", addr: "0xbf5495Efe5DB9ce00f80364C8B423567e58d2110",
    rateTarget: null, rateFn: null, rateArg: null,
  },
  { symbol: "pufETH", addr: "0xD9A442856C234a39a81a089C06451EBAa4306a72",
    rateTarget: "0xD9A442856C234a39a81a089C06451EBAa4306a72",
    rateFn: "convertToAssets(uint256)", rateArg: ethers.parseUnits("1",18),
  },
];

const MORPHO_ROUTES = [
  { symbol:"weETH",loan:"WETH",lltv:0.945,marketId:"0x37e7484d642d90f14451f1910ba4b7b8e4c3ccdd0ec28f8b2bdb35479e472ba7",oracle:"0xbDd2F2D473E8D63d1BFb0185B5bDB8046ca48a72",liquidityUsd:3090692},
  { symbol:"weETH",loan:"RLUSD",lltv:0.86,marketId:"0xea4bfb18df0ee6bffb7b3f0270899a8adb92ab6b684709634c8276128813cfd4",oracle:"0x6ab351FfDe101BB24a97332f4f7162C1711f110b",liquidityUsd:3941094},
  { symbol:"ezETH",loan:"wstETH",lltv:0.945,marketId:"0xe7e9694b754c4d4f7e21faf7223f6fa71abaeb10296a4c43a54a7977149687d2",oracle:"0x95DB30fAb9A3754e42423000DF27732CB2396992",liquidityUsd:80},
];

function round(v,d=6){const n=typeof v==="number"?v:Number(String(v).replace(/[$,%_\\s]/g,""));if(!Number.isFinite(n))return null;const f=10**d;return Math.round(n*f)/f}

main().catch(e=>{console.error(e.stack||e.message);process.exitCode=1});
