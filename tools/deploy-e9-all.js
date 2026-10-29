const { ethers } = require("./node_modules/ethers");
const { rpcCall, resolveRpc } = require("./shared-rpc");
const fs = require("fs"); const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const ENV_FILE = path.join(WORKSPACE, ".env.exploit");
let privKey = process.env.PRIVATE_KEY;
if (!privKey && fs.existsSync(ENV_FILE)) {
  privKey = fs.readFileSync(ENV_FILE, "utf8").match(/PRIVATE_KEY=([a-fA-F0-9]+)/)?.[1];
}

const FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
const SALT = "flash-liquidate-morpho";
const WALLET = "0x24e46e91dFAAD1FA3d49C48Aa85ca9306885ce0a";

// All Morpho chains
const CHAINS = { 1:"ETH", 8453:"Base", 42161:"Arb", 10:"OP", 137:"Poly", 130:"Unichain", 480:"WorldChain" };

async function main() {
  if (!privKey) { console.log("No PRIVATE_KEY"); return; }

  // Build init code once
  const artifactPath = path.join(WORKSPACE, "contracts", "flash-liquidate-aave-v3", "out", "FlashLiquidateMorpho.sol", "FlashLiquidateMorpho.json");
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const bytecode = artifact.bytecode.object;
  const encodedArgs = ethers.AbiCoder.defaultAbiCoder().encode(["address", "address"], [MORPHO, ROUTER]);
  const initCode = "0x" + bytecode.slice(2) + encodedArgs.slice(2);
  const saltHash = ethers.keccak256(ethers.toUtf8Bytes(SALT));
  const initHash = ethers.keccak256(initCode);
  const calldata = saltHash + initCode.slice(2);
  
  // CREATE2 address
  const addr = "0x" + ethers.keccak256(
    ethers.solidityPacked(["bytes1", "address", "bytes32", "bytes32"], ["0xff", FACTORY, saltHash, initHash])
  ).slice(26);
  
  console.log("=== E9 Morpho — Multi-Chain Deployment ===\n");
  console.log(`Salt: ${SALT}`);
  console.log(`Address: ${addr}`);
  console.log(`Init code: ${(initCode.length-2)/2} bytes\n`);

  const results = [];
  
  for (const [cid, name] of Object.entries(CHAINS)) {
    const chainId = parseInt(cid);
    const rpc = await resolveRpc(chainId);
    if (!rpc) { results.push({ chain: name, addr, status: "NO RPC" }); console.log(`${name}: NO RPC`); continue; }
    
    const p = new ethers.JsonRpcProvider(rpc, chainId, { staticNetwork: true });
    const wallet = new ethers.Wallet(privKey, p);
    const bal = Number(ethers.formatEther(await p.getBalance(WALLET))).toFixed(4);
    const existing = await p.getCode(addr);
    
    if (existing && existing.length > 10) {
      results.push({ chain: name, addr, status: "ALREADY DEPLOYED", codeSize: (existing.length-2)/2 });
      console.log(`${name.padEnd(12)} ${addr.slice(0,12)}... DEPLOYED ${(existing.length-2)/2}B`);
      continue;
    }
    
    if (parseFloat(bal) < 0.0003) {
      results.push({ chain: name, addr, status: "NEED FUNDS", balance: bal });
      console.log(`${name.padEnd(12)} NEED ${(0.0005-parseFloat(bal)).toFixed(4)} ETH (bal=${bal})`);
      continue;
    }
    
    // Deploy
    try {
      process.stdout.write(`${name.padEnd(12)} Deploying... `);
      const tx = await wallet.sendTransaction({ to: FACTORY, data: calldata, gasLimit: 8000000 });
      const receipt = await tx.wait();
      const verify = await p.getCode(addr);
      if (verify && verify.length > 10) {
        results.push({ chain: name, addr, status: "DEPLOYED", codeSize: (verify.length-2)/2, gas: Number(receipt.gasUsed), tx: tx.hash });
        console.log(`OK ${(verify.length-2)/2}B gas=${receipt.gasUsed} tx=${tx.hash.slice(0,12)}...`);
      } else {
        results.push({ chain: name, addr, status: "FAILED", gas: Number(receipt.gasUsed) });
        console.log(`FAILED — code=${verify.length}B`);
      }
    } catch(e) {
      results.push({ chain: name, addr, status: "ERROR", error: e.reason || e.message?.slice(0, 100) });
      console.log(`ERROR: ${e.reason || e.message?.slice(0, 80)}`);
    }
  }

  // Summary
  console.log("\n=== Summary ===");
  const deployed = results.filter(r => r.status === "DEPLOYED" || r.status === "ALREADY DEPLOYED");
  for (const r of results) {
    console.log(`${r.chain.padEnd(12)} ${r.status.padEnd(18)} ${r.codeSize ? r.codeSize+"B" : ""} ${r.balance||""}`);
  }
  console.log(`\nDeployed: ${deployed.length}/${Object.keys(CHAINS).length}`);
  if (deployed.length > 0) {
    console.log(`\nE9 Morpho contract: ${addr}`);
    console.log(`Chains: ${deployed.map(r => r.chain).join(", ")}`);
  }
}

main().catch(e => console.error(e));
