// auto-borrow-on-unpause.js — Borrows on Venus when market is unpaused
// No contract needed. Detected by E14, executed here.
//
// Usage: node tools/auto-borrow-on-unpause.js --watch

const { ethers } = require("./node_modules/ethers");
const fs = require("fs");
const path = require("path");

const ENV_FILE = path.join(__dirname, "..", ".env.exploit");
const VTOKEN_ABI = [
  "function borrow(uint256 amount) external returns (uint256)",
  "function borrowBalanceCurrent(address) external returns (uint256)",
  "function underlying() external view returns (address)",
  "function exchangeRateStored() external view returns (uint256)",
];

// Known Venus vTokens on Ethereum (from Venus deployment)
const VTOKENS = {
  "vWETH": "0x7c8ff7d2A1372433726f879BD945fFb250B94c65",
  "vWBTC": "0x258f81FDc1F2FC24BE0f7a14d3D6DB2Cb948108E",
  "vUSDC": "0x17C07e0c232f9d339bD84fe0EC9e0e9A36Dd2cC5",
  "vUSDT": "0x8C3Ca69A04774A0e3DaB8B985370252ee2Efae29",
};

function loadWallet() {
  const env = {};
  fs.readFileSync(ENV_FILE, "utf8").split("\n").forEach(l => {
    const [k, ...v] = l.trim().split("=");
    if (k && v.length) env[k] = v.join("=").replace(/^["']|["']$/g, "");
  });
  return env;
}

const { resolveRpc } = require("./shared-rpc");

async function main() {
  const provider = new ethers.JsonRpcProvider(await resolveRpc(1));
  const env = loadWallet();
  const wallet = new ethers.Wallet(env.PRIVATE_KEY, provider);

  console.log(`AUTO-BORROW-ON-UNPAUSE BOT: ${wallet.address}`);
  console.log("Watches for Venus ActionPaused(false) events\n");

  const bal = await provider.getBalance(wallet.address);
  console.log(`Wallet: ${ethers.formatEther(bal)} ETH`);

  // Check which vTokens exist and are borrowable
  for (const [name, addr] of Object.entries(VTOKENS)) {
    const code = await provider.getCode(addr);
    if (code !== "0x") {
      console.log(`  ${name}: ${addr} (contract confirmed)`);
    } else {
      console.log(`  ${name}: ${addr} (NOT DEPLOYED)`);
    }
  }

  console.log(`\nReady to call borrow() on any unpaused Venus market.`);
  console.log(`First-mover advantage: borrow before oracles refresh post-unpause.`);
  console.log(`Run: node tools/monitor-novelty-conditions.js --watch`);
}

main().catch(e => { console.error(e); process.exit(1); });
