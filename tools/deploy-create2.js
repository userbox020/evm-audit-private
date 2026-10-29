#!/usr/bin/env node
// deploy-create2.js — CREATE2 deterministic deployment to L2s
// Uses Arachnid factory (0x4e59b44847b379578588920cA78FbF26c0B4956C)
// Same bytecode + same salt = same address on all chains
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const CONTRACTS_DIR = path.join(WORKSPACE, "contracts", "flash-liquidate-aave-v3");
const ENV_FILE = path.join(WORKSPACE, ".env.exploit");

// Arachnid deterministic deployment proxy — same address on ALL EVM chains
const CREATE2_FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C";

// Contract deployment configs per chain
const DEPLOY_CONFIGS = {
  // Base
  8453: {
    name: "Base",
    aavePool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
    morpho: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
    weth: "0x4200000000000000000000000000000000000006",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    uniswapRouter: "0x2626664c2603336E57B271c5C0b26F421741e481", // Router02 on Base
    collateralAave: "0xc1CBa3fCe344B92B9239f104B7B649bf824a2A5C", // wstETH on Base (example)
    borrowerAave: "0x0000000000000000000000000000000000000000", // placeholder — scan first
  },
  // Arbitrum
  42161: {
    name: "Arbitrum",
    aavePool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    morpho: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", // Morpho CREATE2 — same on most chains
    weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    uniswapRouter: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
    collateralAave: "0x5979D7b546E38E414f7E9822514be443A4802509", // wstETH on Arbitrum
    borrowerAave: "0x0000000000000000000000000000000000000000",
  },
  // Optimism
  10: {
    name: "Optimism",
    aavePool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    weth: "0x4200000000000000000000000000000000000006",
    usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    uniswapRouter: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
    collateralAave: "0x1F32b1c2345538c0c6f582fCB022739c4A194Ebb", // wstETH on Optimism
    borrowerAave: "0x0000000000000000000000000000000000000000",
  },
};

async function computeCreate2Address(factory, salt, initCode) {
  const saltHash = ethers.keccak256(ethers.toUtf8Bytes(salt));
  const initHash = ethers.keccak256(initCode);
  const addr = ethers.keccak256(
    ethers.solidityPacked(["bytes1", "address", "bytes32", "bytes32"], ["0xff", factory, saltHash, initHash])
  );
  return "0x" + addr.slice(26);
}

async function getCreate2Bytecode(contractName, constructorArgs) {
  const artifactPath = path.join(CONTRACTS_DIR, "out", `${contractName}.sol`, `${contractName}.json`);
  if (!fs.existsSync(artifactPath)) throw new Error(`Artifact not found: ${artifactPath}`);
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const bytecode = artifact.bytecode.object; // creation bytecode (without constructor args)
  const abi = artifact.abi;
  // Find constructor ABI
  const constructor = abi.find(a => a.type === "constructor");
  const iface = new ethers.Interface(abi);
  let encodedArgs = "0x";
  if (constructor && constructor.inputs.length > 0) {
    encodedArgs = ethers.AbiCoder.defaultAbiCoder().encode(constructor.inputs.map(i => i.type), constructorArgs);
  }
  return bytecode + encodedArgs.slice(2);
}

async function deployCreate2(rpc, factory, salt, initCode, wallet) {
  const saltHash = ethers.keccak256(ethers.toUtf8Bytes(salt));
  const address = await computeCreate2Address(factory, salt, initCode);
  const existingCode = await rpcCall(rpc, "eth_getCode", [address, "latest"], 5000);
  if (existingCode && existingCode !== "0x") {
    console.log(`  Already deployed at ${address}`);
    console.log(`  Bytecode: ${(existingCode.length - 2) / 2} bytes`);
    return { address, alreadyDeployed: true };
  }

  // 2. Deploy via CREATE2 factory
  const factoryAbi = ["function deploy(bytes memory initCode, bytes32 salt) payable returns (address)"];
  const factoryContract = new ethers.Contract(factory, factoryAbi, wallet);
  const gasPrice = (await wallet.provider.getFeeData()).gasPrice;
  
  console.log(`  Deploying to ${address}...`);
  const tx = await factoryContract.deploy(initCode, saltHash, { gasPrice, gasLimit: 5000000 });
  const receipt = await tx.wait();
  console.log(`  Deployed in tx: ${receipt.hash.slice(0, 16)}... block: ${receipt.blockNumber}`);
  return { address, txHash: receipt.hash, blockNumber: receipt.blockNumber, alreadyDeployed: false };
}

async function main() {
  console.log("=== CREATE2 L2 Contract Deployment ===\n");

  // Load private key
  let privKey = process.env.PRIVATE_KEY;
  if (!privKey && fs.existsSync(ENV_FILE)) {
    privKey = fs.readFileSync(ENV_FILE, "utf8").match(/PRIVATE_KEY=([a-fA-F0-9]+)/)?.[1];
  }
  if (!privKey) { console.error("No PRIVATE_KEY in env or .env.exploit"); process.exit(1); }

  const results = [];

  for (const [chainId, cfg] of Object.entries(DEPLOY_CONFIGS)) {
    const cid = Number(chainId);
    console.log(`\n${cfg.name} (c${cid})`);

    const rpcUrl = await resolveRpc(cid);
    if (!rpcUrl) { console.log("  No RPC"); results.push({ chain: cfg.name, error: "no-rpc" }); continue; }

    const provider = new ethers.JsonRpcProvider(rpcUrl, cid, { staticNetwork: true });
    const wallet = new ethers.Wallet(privKey, provider);

    const balance = await provider.getBalance(wallet.address);
    console.log(`  Wallet: ${wallet.address.slice(0, 10)}... balance=${ethers.formatEther(balance)} ETH`);

    if (balance < ethers.parseEther("0.001")) {
      console.log(`  INSUFFICIENT BALANCE — need >=0.001 ETH for deployment`);
      results.push({ chain: cfg.name, error: "insufficient-balance", balance: ethers.formatEther(balance) });
      continue;
    }

    // Deploy FlashLiquidateAaveV3 (if aave borrower known)
    if (cfg.borrowerAave !== "0x0000000000000000000000000000000000000000") {
      const saltAave = `flash-liquidate-aave-v3-${cid}`;
      const initCodeAave = await getCreate2Bytecode("FlashLiquidateAaveV3", [
        cfg.aavePool, cfg.weth, cfg.collateralAave, cfg.uniswapRouter, cfg.borrowerAave
      ]);
      const addrAave = await computeCreate2Address(CREATE2_FACTORY, saltAave, initCodeAave);
      console.log(`  FlashLiquidateAaveV3: ${addrAave.slice(0, 10)}... (deferred — needs borrower scan)`);
      results.push({ chain: cfg.name, contract: "FlashLiquidateAaveV3", address: addrAave, status: "address-computed", note: "needs borrower scan" });
    }

    // Deploy FlashLiquidateMorpho (works without borrower — liquidate() takes borrower as arg)
    if (cfg.morpho) {
      const saltMorpho = `flash-liquidate-morpho-${cid}`;
      const initCodeMorpho = await getCreate2Bytecode("FlashLiquidateMorpho", [cfg.morpho, cfg.uniswapRouter]);
      const addrMorpho = await computeCreate2Address(CREATE2_FACTORY, saltMorpho, initCodeMorpho);
      
      console.log(`  FlashLiquidateMorpho: pre-computed address: ${addrMorpho.slice(0, 10)}...`);
      
      // Check if already deployed
      const existing = await rpcCall(rpcUrl, "eth_getCode", [addrMorpho, "latest"], 5000);
      if (existing && existing !== "0x") {
        console.log(`    Already deployed — ${(existing.length - 2) / 2} bytes`);
        results.push({ chain: cfg.name, contract: "FlashLiquidateMorpho", address: addrMorpho, status: "already-deployed" });
      } else {
        console.log(`    Not yet deployed — ready for CREATE2 deployment`);
        results.push({ chain: cfg.name, contract: "FlashLiquidateMorpho", address: addrMorpho, status: "ready", note: "needs funding" });
      }
    }
  }

  // Summary
  console.log("\n=== Summary ===");
  for (const r of results) {
    const status = r.error || r.status || "unknown";
    console.log(`  ${r.chain}: ${r.contract || "—"} ${r.address?.slice(0, 10) || "—"}... ${status}${r.balance ? ' (bal='+r.balance+')' : ''}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
