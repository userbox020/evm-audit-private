#!/usr/bin/env node
// scan-fresh-vault-donation.js — Scans recently deployed ERC4626 vaults for donation-attack vulnerability.
// Focuses on vaults with <$10K totalAssets that are listed as collateral in any lending protocol.
// If found: donation-inflate → collateral value rises → borrow → profit. No borrows needed? Wrong.
// Actually: if vault IS collateral somewhere, donation allows overborrowing.
// But even standalone: donation-inflate-share-price → redeem at inflated rate → profit IF redeem path exists.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const OUT = path.join(RAW_DIR, "fresh-vault-donation.json");
const QUIET = process.argv.includes("--quiet");

const CHAINS = [
  { id: 1, name: "Ethereum", morphoVaultFactory: "0x48e388e9f6Ca7CDeCD8b275fadBf1D276DDc0DD9", fromBlock: Math.max(1, 12800000) },
  { id: 8453, name: "Base", morphoVaultFactory: "0x48e388e9f6Ca7CDeCD8b275fadBf1D276DDc0DD9", fromBlock: Math.max(1, 19000000) },
  { id: 42161, name: "Arbitrum", morphoVaultFactory: "0x48e388e9f6Ca7CDeCD8b275fadBf1D276DDc0DD9", fromBlock: Math.max(1, 230000000) },
];

const LOOKBACK_BLOCKS = 50000; // ~7 days
const MIN_TOTAL_ASSETS_USD = 10000; // Below this = donation-vulnerable

const ERC4626_ABI = new ethers.Interface([
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function convertToShares(uint256) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function maxDeposit(address) view returns (uint256)",
  "function maxMint(address) view returns (uint256)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
]);

const ERC20_ABI = new ethers.Interface([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
]);

const CHAINLINK_FEED_SLOT = ethers.id("_priceFeed");

function loadRpcUrls() { if (!fs.existsSync(RPC_FILE)) return []; return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map(m => m[0]); }
async function rpcCall(url, method, params = [], ms = 15000) { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); try { const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: c.signal }); const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result ?? null; } finally { clearTimeout(t); } }
async function resolveRpc(chainId) { for (const url of loadRpcUrls()) { try { const id = Number(BigInt(await rpcCall(url, "eth_chainId", [], 6000))); if (id === chainId) return url; } catch (_) {} } return null; }

function asNumber(value) { if (value === null || value === undefined) return null; if (typeof value === "number") return Number.isFinite(value) ? value : null; const n = Number(String(value).replace(/[$,%\s,]/g, "")); return Number.isFinite(n) ? n : null; }
function round(v, d = 6) { const n = asNumber(v); return n === null ? null : Math.round(n * 10**d) / 10**d; }
function addr(v) { const t = String(v || "").toLowerCase(); return /^0x[0-9a-f]{40}$/.test(t) ? t : null; }

const CHUNK_SIZE = 10000;

async function getVaultLogs(rpc, factory, fromBlock, toBlock) {
  const topic = ethers.id("CreateVault(address,address)");
  const logs = [];
  for (let start = fromBlock; start <= toBlock; start += CHUNK_SIZE) {
    const end = Math.min(start + CHUNK_SIZE - 1, toBlock);
    try {
      const result = await rpcCall(rpc, "eth_getLogs", [{ address: factory, topics: [topic], fromBlock: "0x" + start.toString(16), toBlock: "0x" + end.toString(16) }], 30000);
      if (Array.isArray(result)) {
        for (const l of result) logs.push({ vault: "0x" + l.topics[2].slice(26).toLowerCase(), block: parseInt(l.blockNumber, 16) });
      }
    } catch(_) { /* chunk failed, try next */ }
  }
  return logs;
}

async function scanVault(rpc, vaultAddr) {
  const calls = [
    { fn: "asset" }, { fn: "totalAssets" }, { fn: "convertToAssets", args: [ethers.parseUnits("1", 18)] },
    { fn: "totalSupply" }, { fn: "maxDeposit", args: ["0x0000000000000000000000000000000000000000"] },
    { fn: "symbol" }, { fn: "name" }, { fn: "decimals" },
  ];

  const results = {};
  for (const c of calls) {
    try {
      const data = ERC4626_ABI.encodeFunctionData(c.fn, c.args || []);
      const raw = await rpcCall(rpc, "eth_call", [{ to: vaultAddr, data }, "latest"], 10000);
      if (raw && raw !== "0x") {
        results[c.fn] = ERC4626_ABI.decodeFunctionResult(c.fn, raw)[0];
      }
    } catch (_) {}
  }

  if (!results.totalAssets || !results.asset) return null;

  // Get asset info
  let assetSymbol = "?", assetDecimals = 18;
  try {
    const raw = await rpcCall(rpc, "eth_call", [{ to: results.asset, data: ERC20_ABI.encodeFunctionData("symbol", []) }, "latest"], 8000);
    assetSymbol = ERC20_ABI.decodeFunctionResult("symbol", raw)[0];
  } catch (_) {}
  try {
    const raw = await rpcCall(rpc, "eth_call", [{ to: results.asset, data: ERC20_ABI.encodeFunctionData("decimals", []) }, "latest"], 8000);
    assetDecimals = Number(ERC20_ABI.decodeFunctionResult("decimals", raw)[0]);
  } catch (_) {}

  // Get asset USD price (approximate via common tokens)
  let assetPriceUsd = 1; // default to $1 for stablecoins
  const assetAddr = addr(results.asset);
  if (assetAddr === addr("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2")) assetPriceUsd = 1600;
  else if (assetAddr === addr("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")) assetPriceUsd = 1;
  else if (assetAddr === addr("0xdAC17F958D2ee523a2206206994597C13D831ec7")) assetPriceUsd = 1;
  else if (assetAddr === addr("0x6B175474E89094C44Da98b954EedeAC495271d0F")) assetPriceUsd = 1;
  else if (assetAddr === addr("0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0")) assetPriceUsd = 2000;

  const totalAssetsRaw = BigInt(results.totalAssets || 0n);
  const totalAssetsFormatted = Number(totalAssetsRaw) / 10**assetDecimals;
  const totalAssetsUsd = totalAssetsFormatted * assetPriceUsd;
  const totalSupplyRaw = BigInt(results.totalSupply || 0n);
  const convertToAssetsOne = results.convertToAssets ? Number(BigInt(results.convertToAssets)) / 1e18 : null;
  const maxDepositRaw = results.maxDeposit ? BigInt(results.maxDeposit) : 0n;
  const depositOpen = maxDepositRaw > 0n;
  const donationVulnerable = totalAssetsUsd < MIN_TOTAL_ASSETS_USD && depositOpen && totalSupplyRaw > 0n;

  return {
    vault: vaultAddr,
    asset: results.asset,
    assetSymbol,
    assetDecimals,
    vaultSymbol: results.symbol || "?",
    vaultName: results.name || "?",
    totalAssetsRaw: totalAssetsRaw.toString(),
    totalAssetsFormatted: round(totalAssetsFormatted, 6),
    totalAssetsUsd: round(totalAssetsUsd, 2),
    totalSupplyRaw: totalSupplyRaw.toString(),
    convertToAssetsOneShare: round(convertToAssetsOne, 12),
    maxDepositOpen: depositOpen,
    depositOpen: depositOpen,
    donationVulnerable,
    // Simulate: donate $1K → what's the new share price?
    donationSimulation: donationVulnerable && totalSupplyRaw > 0n ? {
      donationAmountUsd: 1000,
      donationAmountAsset: 1000 / assetPriceUsd,
      totalAssetsBefore: round(totalAssetsFormatted, 6),
      totalSupplyBefore: round(Number(totalSupplyRaw) / 10**18, 6),
      newRateAfterDonate: round((totalAssetsFormatted + 1000/assetPriceUsd) / (Number(totalSupplyRaw) / 10**18), 12),
      inflationPct: round(((totalAssetsFormatted + 1000/assetPriceUsd) / totalAssetsFormatted - 1) * 100, 2),
    } : null,
  };
}

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  const allVaults = [];
  for (const chain of CHAINS) {
    const rpc = await resolveRpc(chain.id);
    if (!rpc) { console.log(`${chain.name}: no RPC`); continue; }
    const block = parseInt(await rpcCall(rpc, "eth_blockNumber", [], 8000), 16);
    const fromBlock = Math.max(chain.fromBlock, block - LOOKBACK_BLOCKS);
    console.log(`${chain.name}: scanning blocks ${fromBlock}-${block}...`);
    const logs = await getVaultLogs(rpc, chain.morphoVaultFactory, fromBlock, block);
    console.log(`  Found ${logs.length} CreateVault logs`);
    for (const log of logs.slice(0, 100)) {
      const info = await scanVault(rpc, log.vault);
      if (info) { info.chain = chain.name; info.chainId = chain.id; info.deployBlock = log.block; allVaults.push(info); }
    }
  }

  const donationVulnerable = allVaults.filter(v => v.donationVulnerable);
  donationVulnerable.sort((a, b) => (a.totalAssetsUsd || 0) - (b.totalAssetsUsd || 0));

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-fresh-vault-donation.js",
    summary: {
      vaultsScanned: allVaults.length,
      donationVulnerable: donationVulnerable.length,
      routePositive: 0,
      executableNow: 0,
      blocker: donationVulnerable.length > 0 ? "Vaults found but need consumer join (collateral listing) to become extractive" : "No donation-vulnerable vaults found in recent blocks",
    },
    donationVulnerableVaults: donationVulnerable.slice(0, 30),
    allVaults: allVaults.slice(0, 200),
  };

  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");
  console.log(`\nFresh vaults: scanned=${allVaults.length} donation-vulnerable=${donationVulnerable.length} routePositive=0`);
}
main().catch(e => { console.error(e); process.exit(1); });
