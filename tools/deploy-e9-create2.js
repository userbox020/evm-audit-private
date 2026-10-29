const { ethers } = require("./node_modules/ethers");
const { rpcCall, resolveRpc } = require("./shared-rpc");
const fs = require("fs"); const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const ENV_FILE = path.join(WORKSPACE, ".env.exploit");
let privKey = process.env.PRIVATE_KEY;
if (!privKey && fs.existsSync(ENV_FILE)) {
  privKey = fs.readFileSync(ENV_FILE, "utf8").match(/PRIVATE_KEY=([a-fA-F0-9]+)/)?.[1];
}

const CHAINS = {1:"ETH",8453:"Base",42161:"Arb",10:"OP",137:"Poly",130:"Unichain"};
const CREATE2_FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const WALLET = "0x24e46e91dFAAD1FA3d49C48Aa85ca9306885ce0a";
const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
const SALT = "flash-liquidate-morpho";

async function main() {
  if (!privKey) { console.log("No PRIVATE_KEY"); return; }

  // Read artifact
  const artifactPath = path.join(WORKSPACE, "contracts", "flash-liquidate-aave-v3", "out", "FlashLiquidateMorpho.sol", "FlashLiquidateMorpho.json");
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const bytecode = artifact.bytecode.object;
  const encodedArgs = ethers.AbiCoder.defaultAbiCoder().encode(["address", "address"], [MORPHO, ROUTER]);
  const initCode = bytecode + encodedArgs.slice(2);
  const saltHash = ethers.keccak256(ethers.toUtf8Bytes(SALT));
  const initHash = ethers.keccak256(initCode);
  const addr = "0x" + ethers.keccak256(
    ethers.solidityPacked(["bytes1", "address", "bytes32", "bytes32"], ["0xff", CREATE2_FACTORY, saltHash, initHash])
  ).slice(26);

  console.log("=== E9 Morpho CREATE2 Deploy ===\n");
  console.log("Salt:", SALT);
  console.log("Target address:", addr);
  console.log("Init code:", (initCode.length-2)/2, "bytes\n");

  for (const [cid, name] of Object.entries(CHAINS)) {
    const chainId = parseInt(cid);
    const rpc = await resolveRpc(chainId);
    if (!rpc) { console.log(`${name}: NO RPC`); continue; }
    
    const p = new ethers.JsonRpcProvider(rpc, chainId, { staticNetwork: true });
    const wallet = new ethers.Wallet(privKey, p);
    
    try { var bal = Number(ethers.formatEther(await p.getBalance(WALLET))).toFixed(4); } catch(e) { bal = "err"; }
    try { var existing = await p.getCode(addr); } catch(e) { existing = "0x"; }
    const deployed = existing && existing.length > 10;
    
    if (deployed) {
      console.log(`${name.padEnd(12)} ${addr.slice(0,12)}... DEPLOYED ${(existing.length-2)/2}B bal=${bal}`);
      continue;
    }
    
    if (parseFloat(bal) < 0.0001) {
      console.log(`${name.padEnd(12)} ${addr.slice(0,12)}... NEED ${(0.001-parseFloat(bal)).toFixed(4)} ${name==="Poly"?"MATIC":"ETH"} bal=${bal}`);
      continue;
    }
    
    // Deploy
    try {
      const factoryAbi = ["function deploy(bytes memory initCode, bytes32 salt) public returns (address)"];
      const factory = new ethers.Contract(CREATE2_FACTORY, factoryAbi, wallet);
      console.log(`${name.padEnd(12)} Deploying... (bal=${bal}, nonce=${await p.getTransactionCount(WALLET)})`);
      const tx = await factory.deploy(initCode, saltHash, { gasLimit: 8000000 });
      console.log(`  TX: ${tx.hash.slice(0,16)}... waiting...`);
      const receipt = await tx.wait();
      const verify = await p.getCode(addr);
      if (verify && verify.length > 10) {
        console.log(`  DEPLOYED! ${(verify.length-2)/2}B block=${receipt.blockNumber}`);
      } else {
        console.log(`  FAILED — code=${verify.length}B (TX reverted?)`);
      }
    } catch(e) {
      console.log(`${name.padEnd(12)} DEPLOY FAILED: ${e.reason || e.message?.slice(0, 150)}`);
    }
  }
}

main().catch(e => console.error(e));
