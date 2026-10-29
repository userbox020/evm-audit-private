const { ethers } = require("./node_modules/ethers");
const { rpcCall } = require("./shared-rpc");
const fs = require("fs"); const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const ENV_FILE = path.join(WORKSPACE, ".env.exploit");
const pk = fs.readFileSync(ENV_FILE, "utf8").match(/PRIVATE_KEY=([a-fA-F0-9]+)/)[1];
const WALLET = "0x24e46e91dFAAD1FA3d49C48Aa85ca9306885ce0a";

const FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
const SALT = "flash-liquidate-morpho";
const ADDR = "0x2cd636ccee97243688ddaa4b1f93b13f60d3a00f";

const artifact = JSON.parse(fs.readFileSync(path.join(WORKSPACE, "contracts", "flash-liquidate-aave-v3", "out", "FlashLiquidateMorpho.sol", "FlashLiquidateMorpho.json"), "utf8"));
const bytecode = artifact.bytecode.object;
const args = ethers.AbiCoder.defaultAbiCoder().encode(["address", "address"], [MORPHO, ROUTER]);
const initCode = "0x" + bytecode.slice(2) + args.slice(2);
const saltHash = ethers.keccak256(ethers.toUtf8Bytes(SALT));
const calldata = saltHash + initCode.slice(2);

async function deployChain(name, chainId, rpcUrl) {
  console.log(`\n--- ${name} (chain ${chainId}) ---`);
  
  const p = new ethers.JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
  const bal = await p.getBalance(WALLET);
  const balStr = Number(ethers.formatEther(bal)).toFixed(6);
  console.log(`Balance: ${balStr} ETH`);
  
  const existing = await p.getCode(ADDR);
  if (existing && existing.length > 10) {
    console.log(`Already deployed: ${(existing.length-2)/2}B`);
    return { chain: name, status: "already deployed" };
  }
  
  if (bal < ethers.parseEther("0.0003")) {
    console.log(`NEED ~0.0005 ETH (have ${balStr})`);
    return { chain: name, status: "need funds", balance: balStr };
  }
  
  const wallet = new ethers.Wallet(pk, p);
  try {
    const tx = await wallet.sendTransaction({ to: FACTORY, data: calldata, gasLimit: 8000000 });
    const receipt = await tx.wait();
    const verify = await p.getCode(ADDR);
    console.log(`DEPLOYED: ${(verify.length-2)/2}B gas=${receipt.gasUsed}`);
    return { chain: name, status: "deployed", gas: Number(receipt.gasUsed) };
  } catch(e) {
    console.log(`FAILED: ${e.reason || e.message?.slice(0, 100)}`);
    return { chain: name, status: "failed", error: e.message?.slice(0, 100) };
  }
}

async function main() {
  console.log("=== Deploy E9 to Unichain + WorldChain ===\n");
  
  const results = [];
  
  // Unichain via public RPC
  results.push(await deployChain("Unichain", 130, "https://mainnet.unichain.org"));
  
  // WorldChain via Sky proxy
  results.push(await deployChain("WorldChain", 480, "https://proxy.sky.money/rpc/480"));
  
  console.log("\n=== Results ===");
  for (const r of results) console.log(`${r.chain}: ${r.status}`);
}

main().catch(e => console.error(e));
