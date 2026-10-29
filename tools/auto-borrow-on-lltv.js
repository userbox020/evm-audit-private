// auto-borrow-on-lltv.js — Borrows on Morpho when new LLTV tier is enabled
// No contract needed. E13 detects EnableLltv events, this bot acts.
//
// Usage: node tools/auto-borrow-on-lltv.js --watch

const { ethers } = require("./node_modules/ethers");
const fs = require("fs");
const path = require("path");

const MORPHO_BLUE = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const ENV_FILE = path.join(__dirname, "..", ".env.exploit");

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

  console.log(`AUTO-BORROW-ON-LLTV BOT: ${wallet.address}`);
  console.log("Watches for Morpho EnableLltv events (new risk tier)\n");

  const bal = await provider.getBalance(wallet.address);
  console.log(`Wallet: ${ethers.formatEther(bal)} ETH`);
  console.log(`Morpho Blue: ${MORPHO_BLUE}`);
  console.log(`\nWhen E13 fires (new LLTV enabled), any wallet can create a market`);
  console.log(`with that LLTV and be the first to borrow at that risk tier.`);
  console.log(`Cost: ~$20-30 gas for createMarket + supply + borrow.`);
  console.log(`Run: node tools/monitor-novelty-conditions.js --watch`);
}

main().catch(e => { console.error(e); process.exit(1); });
