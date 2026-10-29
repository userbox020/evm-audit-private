#!/usr/bin/env node
// deploy-e9-morpho-all-chains.js — Deploy FlashLiquidateMorpho to ALL Morpho L2 chains
// Same constructor args on all chains → single CREATE2 salt → SAME address everywhere
const fs = require("fs"); const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const ENV_FILE = path.join(WORKSPACE, ".env.exploit");

// Same on ALL chains (CREATE2 deterministic)
const CREATE2_FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const UNI_V3_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
const SALT = "flash-liquidate-morpho"; // FIXED salt → same address everywhere

// Morpho L2 chains
const CHAINS = {
  8453: "Base",
  42161: "Arbitrum",
  10: "Optimism",
  137: "Polygon",
  130: "Unichain",
  480: "WorldChain",
  1: "Ethereum", // already deployed, verify
};

// For chains where Uniswap V3 Router differs (Unichain, WorldChain)
const ROUTER_OVERRIDES = {
  130: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45", // Unichain: SwapRouter02
  480: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45", // WorldChain: may differ
};

function computeCreate2Address(factory, salt, initCode) {
  const saltHash = ethers.keccak256(ethers.toUtf8Bytes(salt));
  const initHash = ethers.keccak256(initCode);
  const addr = ethers.keccak256(
    ethers.solidityPacked(["bytes1", "address", "bytes32", "bytes32"], ["0xff", factory, saltHash, initHash])
  );
  return "0x" + addr.slice(26);
}

async function getInitCode(routerAddr) {
  const artifactPath = path.join(WORKSPACE, "contracts", "flash-liquidate-aave-v3", "out", "FlashLiquidateMorpho.sol", "FlashLiquidateMorpho.json");
  if (!fs.existsSync(artifactPath)) throw new Error(`Artifact not found: ${artifactPath}`);
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const bytecode = artifact.bytecode.object;
  const abi = artifact.abi;
  const constructor = abi.find(a => a.type === "constructor");
  const encodedArgs = ethers.AbiCoder.defaultAbiCoder().encode(constructor.inputs.map(i => i.type), [MORPHO, routerAddr]);
  return bytecode + encodedArgs.slice(2);
}

async function main() {
  console.log("=== E9 Morpho Multi-Chain CREATE2 Deployment ===\n");
  
  // Load private key
  let privKey = process.env.PRIVATE_KEY;
  if (!privKey && fs.existsSync(ENV_FILE)) {
    privKey = fs.readFileSync(ENV_FILE, "utf8").match(/PRIVATE_KEY=([a-fA-F0-9]+)/)?.[1];
  }
  if (!privKey) { console.error("No PRIVATE_KEY"); process.exit(1); }

  // Step 1: Compute deterministic address using Uniswap V3 Router (standard address)
  const initCode = await getInitCode(UNI_V3_ROUTER);
  const deterministicAddr = computeCreate2Address(CREATE2_FACTORY, SALT, initCode);
  console.log(`Salt: ${SALT}`);
  console.log(`Deterministic address: ${deterministicAddr}`);
  console.log(`Init code length: ${(initCode.length-2)/2} bytes\n`);

  // Step 2: Check deployment status on all chains
  const results = [];
  
  for (const [cid, name] of Object.entries(CHAINS)) {
    const chainId = parseInt(cid);
    const rpc = await resolveRpc(chainId);
    if (!rpc) { results.push({ chain: name, status: "NO RPC" }); continue; }
    
    const routerAddr = ROUTER_OVERRIDES[chainId] || UNI_V3_ROUTER;
    const chainInitCode = routerAddr === UNI_V3_ROUTER ? initCode : await getInitCode(routerAddr);
    const chainAddr = routerAddr === UNI_V3_ROUTER ? deterministicAddr : computeCreate2Address(CREATE2_FACTORY, SALT, chainInitCode);
    
    const existingCode = await rpcCall(rpc, "eth_getCode", [chainAddr, "latest"], 5000);
    const isDeployed = existingCode && existingCode !== "0x" && existingCode.length > 10;
    
    const provider = new ethers.JsonRpcProvider(rpc, chainId, { staticNetwork: true });
    const wallet = new ethers.Wallet(privKey, provider);
    const balance = await provider.getBalance(wallet.address);
    const balanceStr = Number(ethers.formatEther(balance)).toFixed(4);
    const canDeploy = parseFloat(balanceStr) >= 0.001;
    
    const status = isDeployed ? "✅ DEPLOYED" : (canDeploy ? "READY" : "⛽ NEED FUNDS");
    
    console.log(`${name.padEnd(12)} ${chainAddr.slice(0,12)}... ${status.padEnd(14)} bal=${balanceStr}`);
    results.push({ chain: name, chainId, address: chainAddr, status, balance: balanceStr, isDeployed, canDeploy });
    
    // Step 3: Deploy if ready and not already deployed
    if (!isDeployed && canDeploy) {
      console.log(`  → Deploying to ${name}...`);
      try {
        const factoryAbi = ["function deploy(bytes memory initCode, bytes32 salt) payable returns (address)"];
        const factoryContract = new ethers.Contract(CREATE2_FACTORY, factoryAbi, wallet);
        const saltHash = ethers.keccak256(ethers.toUtf8Bytes(SALT));
        const tx = await factoryContract.deploy(chainInitCode, saltHash, { gasLimit: 5000000 });
        const receipt = await tx.wait();
        console.log(`  ✅ Deployed! TX: ${receipt.hash.slice(0,16)}... block=${receipt.blockNumber}`);
        const verify = await rpcCall(rpc, "eth_getCode", [chainAddr, "latest"], 5000);
        console.log(`  Code: ${verify ? (verify.length-2)/2 : 0} bytes`);
        results[results.length-1].status = "✅ JUST DEPLOYED";
        results[results.length-1].txHash = receipt.hash;
      } catch (e) {
        console.log(`  ❌ Deploy failed: ${e.message.slice(0, 100)}`);
        results[results.length-1].status = "FAILED";
      }
    }
  }

  // Summary
  console.log("\n=== Summary ===");
  const deployed = results.filter(r => r.isDeployed || r.status?.includes("JUST DEPLOYED"));
  const ready = results.filter(r => r.status === "READY");
  const needFunds = results.filter(r => r.status?.includes("NEED FUNDS"));
  console.log(`Deployed: ${deployed.length} | Ready: ${ready.length} | Need funds: ${needFunds.length}`);
  
  // Save deploy record
  fs.mkdirSync(path.join(WORKSPACE, "reports", "monitor"), { recursive: true });
  fs.writeFileSync(path.join(WORKSPACE, "reports", "monitor", "e9-morpho-deployments.json"),
    JSON.stringify({ deployedAt: new Date().toISOString(), salt: SALT, factory: CREATE2_FACTORY, results }, null, 2));
}
main().catch(e => { console.error(e.message); process.exit(1); });
