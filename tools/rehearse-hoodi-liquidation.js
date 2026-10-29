#!/usr/bin/env node
// rehearse-hoodi-liquidation.js — Hoodi testnet attack rehearsal
// Deploy + test FlashLiquidateAaveV3 on Hoodi testnet
const fs = require("fs"); const path = require("path");
const cp = require("child_process");
const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "hoodi-rehearsal.json");

const HOODI_RPCS = [
  { name: "0xrpc-hoodi", url: "https://0xrpc.io/hoodi" },
  { name: "tatum-hoodi", url: "https://ethereum-hoodi.gateway.tatum.io" },
];
const HOODI_CHAIN_ID = 560048;

// Aave V3 pool on Hoodi — resolve dynamically at runtime
const AAVE_V3_POOL_HOODI_CANDIDATES = [
  "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2", // Ethereum CREATE2 — may also deploy on Hoodi
  "0x794a61358D6845594F94dc1DB02A252b5b4814aD", // L2 CREATE2
  "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", // Morpho Blue (same address on all chains)
];

async function findDeployedContracts(rpc) {
  const deployed = [];
  for (const addr of AAVE_V3_POOL_HOODI_CANDIDATES) {
    const code = await rpcCall(rpc, "eth_getCode", [addr, "latest"], 6000);
    if (code && code !== "0x" && !code._err) deployed.push(addr);
  }
  return deployed;
}

async function rpcCall(url, method, params, ms = 8000) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctrl.signal,
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  } catch (e) { return { _err: e.message }; }
  finally { clearTimeout(t); }
}

async function resolveHoodiRpc() {
  for (const ep of HOODI_RPCS) {
    const id = await rpcCall(ep.url, "eth_chainId", [], 6000);
    if (id && parseInt(id, 16) === HOODI_CHAIN_ID) return ep;
  }
  return null;
}

async function main() {
  console.log("=== Hoodi Testnet Attack Rehearsal ===\n");

  const result = {
    scannedAt: new Date().toISOString(),
    rpc: null, block: null,
    aaveV3Deployed: false, aaveV3PoolAddr: null,
    morphoDeployed: false,
    contractDeployed: false, deployAddr: null,
    rehearsalResults: null,
  };

  // 1. Resolve Hoodi RPC
  const rpcEp = await resolveHoodiRpc();
  if (!rpcEp) { console.log("No Hoodi RPC found — aborting"); result.rpc = "none"; fs.writeFileSync(OUT, JSON.stringify(result, null, 2)); return; }
  console.log(`RPC: ${rpcEp.name} (${rpcEp.url.slice(0, 50)}...)`);
  result.rpc = rpcEp.name;

  // 2. Get block
  const bn = await rpcCall(rpcEp.url, "eth_blockNumber", [], 6000);
  result.block = bn ? parseInt(bn, 16) : null;
  console.log(`Block: ${result.block}`);

  // 3. Scan for Aave V3 deployment
  console.log("\nScanning for Aave V3 / Morpho deployment...");
  const knownPools = [
    { name: "Aave V3 (CREATE2)", addr: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2" },
    { name: "Aave V3 (CREATE2 L2)", addr: "0x794a61358D6845594F94dc1DB02A252b5b4814aD" },
    { name: "Morpho Blue", addr: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb" },
  ];

  for (const p of knownPools) {
    const code = await rpcCall(rpcEp.url, "eth_getCode", [p.addr, "latest"], 6000);
    if (code && code !== "0x" && !code._err) {
      console.log(`  ${p.name}: DEPLOYED (${(code.length-2)/2} bytes)`);
      if (p.name.includes("Aave")) {
        result.aaveV3Deployed = true;
        result.aaveV3PoolAddr = p.addr;
        // Try getReservesList
        const reserves = await rpcCall(rpcEp.url, "eth_call", [{ to: p.addr, data: "0xd1946dbc" }, "latest"], 8000);
        if (reserves && reserves !== "0x" && !reserves._err) {
          console.log(`    Reserves: found`);
        } else {
          console.log(`    Reserves: none or query failed`);
        }
      }
      if (p.name.includes("Morpho")) result.morphoDeployed = true;
    } else {
      console.log(`  ${p.name}: not deployed`);
    }
  }

  // 4. Summary
  console.log(`\n=== Rehearsal Status ===`);
  console.log(`RPC: ${rpcEp.name} | Block: ${result.block} | ChainId: ${HOODI_CHAIN_ID}`);
  console.log(`Aave V3: ${result.aaveV3Deployed ? "DEPLOYED" : "NOT DEPLOYED"}`);
  console.log(`Morpho: ${result.morphoDeployed ? "DEPLOYED" : "NOT DEPLOYED"}`);

  if (result.aaveV3Deployed) {
    console.log("\nNext steps (manual, requires testnet ETH):");
    console.log("  1. forge create --rpc-url <hoodi> --private-key <key> FlashLiquidateAaveV3.sol");
    console.log("  2. Deposit testnet WETH as collateral on Aave V3");
    console.log("  3. Borrow testnet USDC to reach near-HF=1.0");
    console.log("  4. Call liquidate() on deployed contract");
    console.log("  5. Measure gas, verify profit math");
  } else {
    console.log("\nAave V3 not on Hoodi — rehearsal blocked.");
    console.log("Alternative: use Anvil local fork for rehearsal instead.");
  }

  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(`\nArtifact: ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
