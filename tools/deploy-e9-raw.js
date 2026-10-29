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

async function main() {
  if (!privKey) { console.log("No PRIVATE_KEY"); return; }

  // Read artifact
  const artifactPath = path.join(WORKSPACE, "contracts", "flash-liquidate-aave-v3", "out", "FlashLiquidateMorpho.sol", "FlashLiquidateMorpho.json");
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const bytecode = artifact.bytecode.object;
  const encodedArgs = ethers.AbiCoder.defaultAbiCoder().encode(["address", "address"], [MORPHO, ROUTER]);
  const initCode = "0x" + bytecode.slice(2) + encodedArgs.slice(2);
  
  const saltHash = ethers.keccak256(ethers.toUtf8Bytes(SALT));
  const initHash = ethers.keccak256(initCode);
  
  // CREATE2 address
  const addr = "0x" + ethers.keccak256(
    ethers.solidityPacked(["bytes1", "address", "bytes32", "bytes32"], ["0xff", FACTORY, saltHash, initHash])
  ).slice(26);
  
  console.log("=== E9 Morpho — Raw Calldata Deployment ===\n");
  console.log("Salt:", SALT);
  console.log("Target address:", addr);
  console.log("Init code:", (initCode.length-2)/2, "bytes\n");

  // Arachnid factory: calldata = saltHash (32 bytes) + initCode
  const calldata = saltHash + initCode.slice(2);
  console.log("Calldata length:", calldata.length, "chars");

  // Deploy to Base first (cheapest gas)
  const chainId = 8453;
  const rpc = await resolveRpc(chainId);
  if (!rpc) return;
  
  const p = new ethers.JsonRpcProvider(rpc, chainId, { staticNetwork: true });
  const wallet = new ethers.Wallet(privKey, p);
  const bal = Number(ethers.formatEther(await p.getBalance(WALLET))).toFixed(4);
  const existing = await p.getCode(addr);
  
  console.log("Chain: Base (8453)");
  console.log("Balance:", bal, "ETH");
  console.log("Existing code:", (existing.length-2)/2, "bytes");
  
  if (existing.length > 10) {
    console.log("Already deployed!");
    return;
  }
  
  if (parseFloat(bal) < 0.0005) {
    console.log("Insufficient balance — need ~0.0005 ETH for gas");
    return;
  }

  // Send raw calldata to factory
  try {
    console.log("\nSending deployment tx...");
    const tx = await wallet.sendTransaction({
      to: FACTORY,
      data: calldata,
      gasLimit: 8000000,
    });
    console.log("TX:", tx.hash);
    const receipt = await tx.wait();
    console.log("Mined in block:", receipt.blockNumber);
    console.log("Gas used:", receipt.gasUsed.toString());
    
    const verify = await p.getCode(addr);
    console.log("Deployed code:", (verify.length-2)/2, "bytes");
    if (verify.length > 10) {
      console.log("\nSUCCESS! Deployed at", addr);
      
      // Verify contract works
      const ownerRaw = await p.call({ to: addr, data: ethers.id("owner()").slice(0,10) });
      if (ownerRaw && ownerRaw.length >= 66) {
        console.log("Owner:", "0x"+ownerRaw.slice(26,66));
      }
    }
  } catch(e) {
    console.log("Deploy failed:", e.reason || e.message?.slice(0, 200));
  }
}

main().catch(e => console.error(e));
