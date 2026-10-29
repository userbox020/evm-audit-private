const { ethers } = require("./node_modules/ethers");
const { resolveRpc, rpcCall } = require("./shared-rpc");
const fs = require("fs"); const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const WALLET = "0x24e46e91dFAAD1FA3d49C48Aa85ca9306885ce0a";

const NEW_CHAINS = {
  43114: "Avalanche",
  56: "BSC",
  100: "Gnosis",
  534352: "Scroll",
  59144: "Linea",
  42220: "Celo",
  5000: "Mantle",
};

// Uniswap V3 Router CREATE2 address (same on all chains)
const UNI_V3_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564";

// Aave V3 pools per chain
const AAVE_POOLS = {
  43114: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  56: "0x6807dc923806fE8Fd134338EABCA509979a7e0cB",
  100: "0xb50201558B00496A145fE76f7424749556E326D8",
  534352: "0x11fCfe756c05AD438e312a7fd934381537D3cFfe",
  59144: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  42220: "0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402",
  5000: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
};

// WETH per chain
const WETH = {
  43114: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7", // WAVAX on Avalanche? Actually Aave uses WETH.e on Avalanche
  56: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8", // WETH on BSC
  100: "0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1", // WETH on Gnosis
  534352: "0x5300000000000000000000000000000000000004", // WETH on Scroll
  59144: "0xe5D7C2a44FfDDf6b295A15C148167daaAf5Cf34f", // WETH on Linea
  42220: "0x122013fd7dF1C6F636a5bb8f03108E876548b455", // WETH on Celo
  5000: "0xdEAddEaDdeadDEadDEADDEAddEADDEAddead1111", // WETH on Mantle
};

async function main() {
  console.log("=== New Chain Readiness Check ===\n");
  
  const results = [];
  
  for (const [cid, name] of Object.entries(NEW_CHAINS)) {
    const chainId = parseInt(cid);
    const rpc = await resolveRpc(chainId);
    if (!rpc) { results.push({chain:name,status:"NO RPC"}); console.log(`${name}: NO RPC`); continue; }
    
    const p = new ethers.JsonRpcProvider(rpc, chainId, { staticNetwork: true });
    
    // Check balance
    let bal = "err";
    try { bal = Number(ethers.formatEther(await p.getBalance(WALLET))).toFixed(4); } catch(e) {}
    
    // Check Aave V3 pool
    let aaveOk = false;
    try {
      const code = await p.getCode(AAVE_POOLS[chainId]);
      aaveOk = code && code.length > 10;
    } catch(_) {}
    
    // Check UniV3 router
    let uniOk = false;
    try {
      const code = await p.getCode(UNI_V3_ROUTER);
      uniOk = code && code.length > 10;
    } catch(_) {}
    
    // Check WETH
    let wethOk = false;
    try {
      const code = await p.getCode(WETH[chainId]);
      wethOk = code && code.length > 10;
    } catch(_) {}
    
    const ready = aaveOk && uniOk && wethOk;
    const needFunds = parseFloat(bal) < 0.001;
    const status = !ready ? "MISSING-DEPS" : (needFunds ? "NEED-FUNDS" : "READY");
    
    console.log(`${name.padEnd(12)} ${status.padEnd(14)} bal=${bal.padEnd(10)} Aave=${aaveOk} Uni=${uniOk} WETH=${wethOk}`);
    results.push({chain:name,chainId,status,bal,aaveOk,uniOk,wethOk,ready,needFunds});
  }
  
  const ready = results.filter(r => r.ready);
  const needFunds = results.filter(r => r.ready && r.needFunds);
  console.log(`\nReady: ${ready.length} | Need funds: ${needFunds.length} | Missing deps: ${results.filter(r=>!r.ready).length}`);
  
  if (needFunds.length > 0) {
    console.log("\n=== Chains needing funds (<0.001 ETH) ===");
    for (const r of needFunds) console.log(`  ${r.chain}: ${r.bal} ETH needed ~0.001`);
  }
}

main().catch(e => console.error(e));
