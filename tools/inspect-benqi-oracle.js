#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { ethers } = require("./node_modules/ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const CHAIN_ID = 43114;
const COMPTROLLER = "0x486Af39519B4Dc9a7fCcd318217352830E8AD9b4";
const PUBLIC_AVAX_RPC = "https://api.avax.network/ext/bc/C/rpc";

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
    return json.result ?? null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function extractRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function resolveRpc() {
  for (const url of [...extractRpcUrls(), PUBLIC_AVAX_RPC]) {
    const id = await rpcCall(url, "eth_chainId", []);
    if (!id || parseInt(id, 16) !== CHAIN_ID) continue;
    const oracle = await rpcCall(url, "eth_call", [{ to: COMPTROLLER, data: "0x7dc0d1d0" }, "latest"]);
    if (oracle && /^0x[0-9a-fA-F]+$/.test(oracle)) return url;
  }
  throw new Error("No Avalanche RPC endpoint found");
}

async function main() {
  const rpc = await resolveRpc();
  const provider = new ethers.JsonRpcProvider(rpc, undefined, { batchMaxCount: 1 });
  const comptroller = new ethers.Contract(COMPTROLLER, ["function oracle() view returns(address)"], provider);
  const oracle = await comptroller.oracle();
  const code = (await provider.getCode(oracle)).toLowerCase();
  const sigs = [
    "getUnderlyingPrice(address)",
    "getFeed(string)",
    "assetPrices(address)",
    "admin()",
    "prices(address)",
    "setFeed(string,address)",
    "getPrice(address)",
    "feeds(bytes32)",
  ];
  console.log(`oracle=${oracle} codeBytes=${(code.length - 2) / 2}`);
  for (const sig of sigs) {
    const selector = ethers.id(sig).slice(2, 10).toLowerCase();
    console.log(`${sig}: ${code.includes(selector) ? "present" : "absent"} (${selector})`);
  }
}

main().catch((err) => {
  console.error(`inspect failed: ${err.message}`);
  process.exitCode = 1;
});
