#!/usr/bin/env node
// scan-cross-chain-eip712-replay.js - find EIP-712 verifiers on multiple chains
// with identical DOMAIN_SEPARATOR() enabling cross-chain signature replay.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpcPool, rpcCall, loadRpcUrls } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "cross-chain-eip712-replay.json");
const QUIET = process.argv.includes("--quiet");

// Known multi-chain protocol contracts to check
// Format: [name, address_on_each_chain]
const TARGETS = [
  // Aave V3 Pool (deployed on 12 chains)
  { name: "AaveV3Pool", chains: { 1: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2", 10: "0x794a61358D6845594F94dc1DB02A252b5b4814aD", 8453: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5", 42161: "0x794a61358D6845594F94dc1DB02A252b5b4814aD", 137: "0x794a61358D6845594F94dc1DB02A252b5b4814aD", 43114: "0x794a61358D6845594F94dc1DB02A252b5b4814aD" } },
  // Morpho Blue (deployed on 13 chains)
  { name: "MorphoBlue", chains: { 1: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", 8453: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", 42161: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb" } },
  // Compound V3 Comet
  { name: "CompoundV3cUSDC", chains: { 1: "0xc3d688B66703497DAA19211EEdff47f25384cdc3", 8453: "0xb125E6687d4313864e53df431d5425969c15Eb2F", 42161: "0xA5EDBDD9646f8dFF606d7448e414884C7d905dCA", 137: "0xF25212E676D1F7F89Cd72fFEe66158f541246445" } },
  // Euler EVK Factory
  { name: "EulerEVKFactory", chains: { 1: "0x29a56a1b8214D9Cf7c5561811750D5cBDb45CC8e", 8453: "0x7b2fF6f7A561C6D5C8c7DCbAb39346B3b8E72724" } },
  // LayerZero Endpoint (OFT/ONFT verifier)
  { name: "LayerZeroV2Endpoint", chains: { 1: "0x1a44076050125825900e736c501f859c50fE728c", 10: "0x1a44076050125825900e736c501f859c50fE728c", 42161: "0x1a44076050125825900e736c501f859c50fE728c", 8453: "0x1a44076050125825900e736c501f859c50fE728c" } },
  // Uniswap V3 Permit2
  { name: "Permit2", chains: { 1: "0x000000000022D473030F116dDEE9F6B43aC78BA3", 10: "0x000000000022D473030F116dDEE9F6B43aC78BA3", 8453: "0x000000000022D473030F116dDEE9F6B43aC78BA3", 42161: "0x000000000022D473030F116dDEE9F6B43aC78BA3", 137: "0x000000000022D473030F116dDEE9F6B43aC78BA3" } },
];

const EIP712_IFACE = new ethers.Interface([
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",
]);

function ensureDir(f) { fs.mkdirSync(path.dirname(f), { recursive: true }); }
function jsonReplacer(_k, v) { return typeof v === "bigint" ? v.toString() : v; }

async function main() {
  const allChainIds = [...new Set(TARGETS.flatMap(t => Object.keys(t.chains).map(Number)))];
  const rpcPool = await resolveRpcPool(allChainIds);
  
  const results = [];
  
  for (const target of TARGETS) {
    const domains = {};
    const details = {};
    
    for (const [cidStr, addr] of Object.entries(target.chains)) {
      const cid = Number(cidStr);
      const rpc = rpcPool[cid];
      if (!rpc) { details[cid] = { error: "no RPC" }; continue; }
      
      // First try DOMAIN_SEPARATOR()
      const dsRaw = await rpcCall(rpc, "eth_call", [
        { to: addr, data: EIP712_IFACE.encodeFunctionData("DOMAIN_SEPARATOR", []) }, "latest"
      ], 12000).catch(() => null);
      
      let ds = null;
      if (dsRaw && dsRaw !== "0x") {
        try { ds = EIP712_IFACE.decodeFunctionResult("DOMAIN_SEPARATOR", dsRaw)[0]; } catch (_) {}
      }
      
      // Try eip712Domain() for structural details
      let domainDetail = null;
      try {
        const raw = await rpcCall(rpc, "eth_call", [
          { to: addr, data: EIP712_IFACE.encodeFunctionData("eip712Domain", []) }, "latest"
        ], 12000);
        if (raw && raw !== "0x") {
          const d = EIP712_IFACE.decodeFunctionResult("eip712Domain", raw);
          domainDetail = {
            name: d[1] || null,
            version: d[2] || null,
            chainId: d[3] ? Number(d[3]) : null,
            verifyingContract: d[4] || null,
          };
        }
      } catch (_) {}
      
      domains[cid] = ds;
      details[cid] = { separator: ds, domain: domainDetail };
      
      if (!QUIET) console.error(`${target.name} chain ${cid}: DS=${ds?.slice(0,18)}... chainId=${domainDetail?.chainId}`);
    }
    
    // Compare: find identical separators across different chains
    const seen = {};
    const matches = [];
    for (const [cid, ds] of Object.entries(domains)) {
      if (!ds) continue;
      const key = ds;
      if (!seen[key]) seen[key] = [];
      seen[key].push(Number(cid));
    }
    
    for (const [ds, cids] of Object.entries(seen)) {
      if (cids.length > 1) {
        matches.push({ separator: ds, chains: cids, chainDetails: cids.map(c => details[c]?.domain) });
      }
    }
    
    results.push({
      name: target.name,
      addresses: target.chains,
      domains,
      details,
      crossChainMatches: matches,
      exploitable: matches.length > 0,
    });
  }
  
  const exploitable = results.filter(r => r.exploitable);
  
  const output = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-cross-chain-eip712-replay.js",
    scope: "Cross-chain EIP-712 domain separator comparison for signature replay",
    safety: { rpcInventoryRead: true, rpcUrlsStored: false, signedActions: false },
    summary: {
      targetsScanned: TARGETS.length,
      chainsCovered: allChainIds.length,
      withEIP712: results.filter(r => Object.values(r.domains).some(d => d)).length,
      crossChainMatches: results.filter(r => r.crossChainMatches.length > 0).length,
      exploitable: exploitable.length,
      routePositive: exploitable.length > 0 ? 1 : 0,
    },
    results,
  };
  
  ensureDir(OUT);
  fs.writeFileSync(OUT, `${JSON.stringify(output, jsonReplacer, 2)}\n`);
  
  console.log(JSON.stringify({
    targets: TARGETS.length,
    withEIP712: output.summary.withEIP712,
    crossChainMatches: output.summary.crossChainMatches,
    exploitable: output.summary.exploitable,
    findings: exploitable.map(r => ({
      name: r.name,
      matches: r.crossChainMatches.map(m => ({
        separator: m.separator?.slice(0, 18) + "...",
        chains: m.chains,
        chainIds: m.chainDetails?.map(d => d?.chainId),
      })),
    })),
  }, null, 2));
}

main().catch(err => { console.error(JSON.stringify({ ok: false, error: String(err) })); process.exit(1); });
