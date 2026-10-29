// auto-borrow-new-market.js — Auto-supplies + borrows on fresh Morpho markets
// When E12 detects a new market, this bot checks if it's exploitable and acts.
// No contract needed — just supply() + borrow() transactions.
//
// Usage:
//   node tools/auto-borrow-new-market.js --watch    Auto-execute on new markets
//   node tools/auto-borrow-new-market.js --check     Show recent new markets

const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const MORPHO_BLUE = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const ENV_FILE = path.join(__dirname, "..", ".env.exploit");

// Morpho Blue ABIs
const MORPHO_ABI = [
  "function createMarket((address,address,address,address,uint256)) external",
  "function supply((address,address,address,address,uint256),uint256,uint256,address,bytes) external returns (uint256,uint256)",
  "function borrow((address,address,address,address,uint256),uint256,uint256,address,address) external returns (uint256,uint256)",
  "function market((bytes32) returns (uint128,uint128,uint128,uint128,uint128,uint128))",
  "function idToMarketParams(bytes32) view returns ((address,address,address,address,uint256))",
];
const ERC20_ABI = [
  "function approve(address,uint256) external returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

const CREATE_MARKET_TOPIC = "0x8a41cabf57f8c9e58b85a041c8b6e82af3eb44c2a21833c0f03a639b5bcb1c49";

const { resolveRpc } = require("./shared-rpc");

function loadWallet() {
  const env = {};
  fs.readFileSync(ENV_FILE, "utf8").split("\n").forEach(l => {
    const [k, ...v] = l.trim().split("=");
    if (k && v.length) env[k] = v.join("=").replace(/^["']|["']$/g, "");
  });
  return env;
}

async function getNewMarkets(provider, lastBlock) {
  const block = await provider.send("eth_blockNumber", []);
  const currentBlock = parseInt(block, 16);
  const fromBlock = lastBlock || currentBlock - 5000;

  const logs = await provider.send("eth_getLogs", [{
    address: MORPHO_BLUE,
    topics: [CREATE_MARKET_TOPIC],
    fromBlock: "0x" + fromBlock.toString(16),
    toBlock: "0x" + currentBlock.toString(16),
  }]);

  const markets = [];
  for (const log of (logs || [])) {
    const id = "0x" + log.topics[1].slice(26);
    const data = log.data.slice(2);
    const loanToken = "0x" + data.slice(24, 64);
    const collToken = "0x" + data.slice(88, 128);
    const oracle = "0x" + data.slice(152, 192);
    const irm = "0x" + data.slice(216, 256);
    const lltv = BigInt("0x" + data.slice(256, 320)).toString();
    markets.push({ id, loanToken, collToken, oracle, irm, lltv, txHash: log.transactionHash });
  }

  return { markets, currentBlock };
}

async function cmdCheck() {
  const provider = new ethers.JsonRpcProvider(await resolveRpc(1));
  const { markets } = await getNewMarkets(provider, 0);
  console.log(`Recent Morpho markets: ${markets.length}`);
  for (const m of markets.slice(-5)) {
    const loan = new ethers.Contract(m.loanToken, ERC20_ABI, provider);
    const coll = new ethers.Contract(m.collToken, ERC20_ABI, provider);
    const [loanSym, collSym] = await Promise.all([loan.symbol().catch(()=>"?"), coll.symbol().catch(()=>"?")]);
    console.log(`  ${loanSym}/${collSym} LLTV=${(Number(m.lltv)/1e16).toFixed(0)}% tx=${m.txHash.slice(0,10)}...`);
  }
}

async function cmdWatch() {
  const provider = new ethers.JsonRpcProvider(await resolveRpc(1));
  const env = loadWallet();
  const wallet = new ethers.Wallet(env.PRIVATE_KEY, provider);
  const morpho = new ethers.Contract(MORPHO_BLUE, MORPHO_ABI, wallet);

  let lastBlock = 0;
  const seen = new Set();

  console.log(`AUTO-BORROW BOT: ${wallet.address}`);
  console.log("Watching for new Morpho markets...\n");

  while (true) {
    const now = new Date().toLocaleTimeString();
    try {
      const { markets, currentBlock } = await getNewMarkets(provider, lastBlock);
      lastBlock = currentBlock;

      for (const m of markets) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);

        const loan = new ethers.Contract(m.loanToken, ERC20_ABI, provider);
        const coll = new ethers.Contract(m.collToken, ERC20_ABI, provider);
        const [loanSym, collSym, loanDec, collDec] = await Promise.all([
          loan.symbol().catch(() => "?"),
          coll.symbol().catch(() => "?"),
          loan.decimals().catch(() => 18),
          coll.decimals().catch(() => 18),
        ]);

        console.log(`[${now}] NEW MARKET: ${loanSym}/${collSym} LLTV=${(Number(m.lltv)/1e16).toFixed(0)}%`);

        const bal = await provider.getBalance(wallet.address);
        if (Number(ethers.formatEther(bal)) < 0.015) {
          console.log(`[${now}] INSUFFICIENT ETH (${ethers.formatEther(bal)} ETH)`);
          continue;
        }

        const rawGasPrice = await provider.send("eth_gasPrice", []);
        const gasPrice = BigInt(rawGasPrice) * 150n / 100n;

        // Check if loan token is WETH (we have ETH)
        if (m.loanToken.toLowerCase() !== "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2".toLowerCase()) {
          console.log(`[${now}] Loan token ${loanSym} — need pre-funding. Skipping.`);
          continue;
        }

        const marketParams = [m.loanToken, m.collToken, m.oracle, m.irm, m.lltv];

        // Supply a small amount of WETH as collateral
        const supplyAmount = ethers.parseEther("0.01"); // 0.01 ETH
        console.log(`[${now}] Supplying ${ethers.formatEther(supplyAmount)} ${loanSym}...`);

        const approveTx = await new ethers.Contract(m.loanToken, ERC20_ABI, wallet)
          .approve(MORPHO_BLUE, supplyAmount, { gasPrice });
        await approveTx.wait();

        const supplyTx = await morpho.supply(
          marketParams, supplyAmount, 0, wallet.address, "0x",
          { gasLimit: 300000, gasPrice }
        );
        console.log(`[${now}] Supply tx: ${supplyTx.hash}`);
        await supplyTx.wait();

        // Borrow collateral token at inflated LLTV
        const borrowAmount = ethers.parseUnits("0.008", loanDec); // 80% of supply
        console.log(`[${now}] Borrowing ${ethers.formatUnits(borrowAmount, loanDec)} ${loanSym}...`);
        try {
          const borrowTx = await morpho.borrow(
            marketParams, borrowAmount, 0, wallet.address, wallet.address,
            { gasLimit: 300000, gasPrice }
          );
          console.log(`[${now}] Borrow tx: ${borrowTx.hash}`);
          await borrowTx.wait();
          console.log(`[${now}] POSITION OPENED. Check wallet for borrowed ${loanSym}.`);
        } catch (e) {
          console.log(`[${now}] Borrow failed (likely cap/guard): ${e.shortMessage || e.message}`);
        }
      }
    } catch (e) {
      console.log(`[${now}] Error: ${e.shortMessage || e.message}`);
    }
    await new Promise(r => setTimeout(r, 300_000));
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--watch")) await cmdWatch();
  else await cmdCheck();
}
main().catch(e => { console.error(e); process.exit(1); });
