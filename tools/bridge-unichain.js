const { ethers } = require("./node_modules/ethers");
const { rpcCall } = require("./shared-rpc");
const fs = require("fs"); const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const ENV_FILE = path.join(WORKSPACE, ".env.exploit");
const pk = fs.readFileSync(ENV_FILE, "utf8").match(/PRIVATE_KEY=([a-fA-F0-9]+)/)[1];
const WALLET = "0x24e46e91dFAAD1FA3d49C48Aa85ca9306885ce0a";

// Unichain bridge (OP Stack)
// OptimismPortal proxy is at the same address on all OP Stack chains via CREATE2
// Common pattern: 0xbEb5Fc579115071764c7423A4f12eDde41f106Ed
// But this varies per chain. Let me fetch the actual address.
async function findPortal() {
  // Try known OP Stack portal pattern
  // Optimism mainnet: 0xbEb5Fc579115071764c7423A4f12eDde41f106Ed
  // Base: 0x49048044D57e1C92A77f79988d21Fa8fAF74E97e
  // Unichain might share Base's pattern
  
  // Let me just use the L1StandardBridge to deposit ETH
  // For OP Stack: L1StandardBridge.depositETH{value: amount}(gasLimit, data)
  // The L1StandardBridge handles the deposit to L2
  
  // First, find Unichain's L1 contracts from their docs or explorers
  // Try the proxy admin pattern
  
  // Actually, let me just check: do we have funds on OP that we can use?
  const rpcOP = require("./shared-rpc").resolveRpc;
  const opRpc = await rpcOP(10);
  if (opRpc) {
    const p = new ethers.JsonRpcProvider(opRpc, 10, { staticNetwork: true });
    const bal = await p.getBalance(WALLET);
    console.log("OP balance:", Number(ethers.formatEther(bal)).toFixed(4), "ETH");
  }
  
  // For now, let me try the standard OP Stack bridge pattern
  // Actually, the simplest approach: just send some ETH on Ethereum
  // to the OptimismPortal contract with the correct calldata
  
  // Looking at Optimism's portal: 
  // depositTransaction(address _to, uint256 _value, uint64 _gasLimit, bool _isCreation, bytes _data)
  // We need the Unichain portal address on L1 (Ethereum)
  
  console.log("Searching for Unichain bridge contracts...");
  console.log("To bridge ETH to Unichain:");
  console.log("1. Find OptimismPortal on L1 for Unichain");
  console.log("2. Call depositTransaction(to=wallet, value=0.001ETH, gasLimit=50000, isCreation=false, data=0x)");
  console.log("3. Wait ~1-2 min for L2 relay");
  console.log("\nLet me try fetching from Unichain's own API...");
}

async function main() {
  await findPortal();
  
  // Direct approach: use the Superchain bridge via the op-stack SDK pattern
  // Unichain L1 contracts (from optimism superchain-registry repo)
  // URL: https://raw.githubusercontent.com/ethereum-optimism/superchain-registry/main/superchain/extra/addresses/mainnet/unichain.json
  
  // Let me try a direct fetch with different URL format
  const urls = [
    "https://raw.githubusercontent.com/ethereum-optimism/superchain-registry/refs/heads/main/superchain/extra/addresses/mainnet/unichain.json",
  ];
  
  for (const url of urls) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (resp.ok) {
        const j = await resp.json();
        console.log("Found addresses:", Object.keys(j).join(", "));
        console.log("\nOptimismPortal:", j.OptimismPortalProxy || "not found");
        console.log("L1StandardBridge:", j.L1StandardBridgeProxy || "not found");
        console.log("L1CrossDomainMessenger:", j.L1CrossDomainMessengerProxy || "not found");
      }
    } catch(e) {
      console.log("URL failed:", url, e.message);
    }
  }
}

main().catch(e => console.error(e));
