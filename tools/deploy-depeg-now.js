// deploy-depeg-now.js - deploy DepegExploit only.
// Signed deployment is fail-closed unless ALLOW_LIVE_DEPLOY=1 is set.

const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const ENV_FILE = path.join(WORKSPACE, ".env.exploit");
const EXPLOIT_DIR = path.join(WORKSPACE, "exploits", "depeg-exploit");
const ARTIFACT_FILE = path.join(EXPLOIT_DIR, "out", "DepegExploit.sol", "DepegExploit.json");
const DEPLOY_FILE = path.join(EXPLOIT_DIR, "deploy.json");

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

function requireLiveDeploy(env) {
  if (env.ALLOW_LIVE_DEPLOY === "1" || process.env.ALLOW_LIVE_DEPLOY === "1") return;
  console.error("REFUSING live E5 deployment: set ALLOW_LIVE_DEPLOY=1 explicitly after fork/local tests pass.");
  process.exit(1);
}

function loadArtifact() {
  try {
    return JSON.parse(fs.readFileSync(ARTIFACT_FILE, "utf8"));
  } catch (_) {
    console.error(`Compiled artifact not found: ${ARTIFACT_FILE}`);
    console.error("Run: cd exploits/depeg-exploit && forge build");
    process.exit(1);
  }
}

async function main() {
  const env = loadEnv();
  requireLiveDeploy(env);
  const provider = new ethers.JsonRpcProvider(await resolveRpcUrl(1));
  const wallet = new ethers.Wallet(env.PRIVATE_KEY, provider);
  const artifact = loadArtifact();
  const bytecode = artifact.bytecode?.object || artifact.bytecode;
  const factory = new ethers.ContractFactory(artifact.abi, bytecode, wallet);
  const rawGasPrice = await provider.send("eth_gasPrice", []);
  const gasPrice = BigInt(rawGasPrice) * 150n / 100n;
  const bal = await provider.getBalance(wallet.address);
  console.log("Wallet:", wallet.address);
  console.log("Balance:", ethers.formatEther(bal), "ETH");
  console.log("Gas price:", ethers.formatUnits(gasPrice, "gwei"), "gwei");
  console.log("Bytecode:", Math.round(bytecode.length / 2), "bytes");
  console.log("Deploying DepegExploit...");
  const contract = await factory.deploy({ gasLimit: 2_000_000, gasPrice });
  await contract.waitForDeployment();
  const addr = await contract.getAddress();
  const receipt = await contract.deploymentTransaction().wait();
  console.log("Deployed:", addr);
  console.log("Tx:", receipt.hash);
  console.log("Gas used:", receipt.gasUsed.toString());
  fs.writeFileSync(DEPLOY_FILE, JSON.stringify({
    address: addr,
    txHash: receipt.hash,
    gasUsed: Number(receipt.gasUsed),
    artifactBytecodeHash: ethers.keccak256(bytecode),
    deployedAt: new Date().toISOString(),
  }, null, 2));
  console.log("Saved deploy.json");
}

main().catch(e => { console.error(e.shortMessage || e.message || e); process.exit(1); });
