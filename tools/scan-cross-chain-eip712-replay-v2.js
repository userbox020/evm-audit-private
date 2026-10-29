#!/usr/bin/env node
// scan-cross-chain-eip712-replay-v2.js - expanded version with 15+ multi-chain targets
const fs = require("fs"); const path = require("path");
const { ethers } = require("ethers"); const { resolveRpcPool, rpcCall } = require("./shared-rpc");
const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "cross-chain-eip712-replay-v2.json");

const TARGETS = [
  // Original 6 targets (verified)
  { name: "AaveV3Pool", chains: { 1: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2", 10: "0x794a61358D6845594F94dc1DB02A252b5b4814aD", 8453: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5", 42161: "0x794a61358D6845594F94dc1DB02A252b5b4814aD", 137: "0x794a61358D6845594F94dc1DB02A252b5b4814aD" } },
  { name: "MorphoBlue", chains: { 1: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", 8453: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", 42161: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb" } },
  { name: "CompoundV3cUSDC", chains: { 1: "0xc3d688B66703497DAA19211EEdff47f25384cdc3", 8453: "0xb125E6687d4313864e53df431d5425969c15Eb2F", 42161: "0xA5EDBDD9646f8dFF606d7448e414884C7d905dCA" } },
  { name: "EulerEVKFactory", chains: { 1: "0x29a56a1b8214D9Cf7c5561811750D5cBDb45CC8e", 8453: "0x7b2fF6f7A561C6D5C8c7DCbAb39346B3b8E72724" } },
  { name: "LayerZeroV2Endpoint", chains: { 1: "0x1a44076050125825900e736c501f859c50fE728c", 10: "0x1a44076050125825900e736c501f859c50fE728c", 42161: "0x1a44076050125825900e736c501f859c50fE728c", 8453: "0x1a44076050125825900e736c501f859c50fE728c" } },
  { name: "UniswapPermit2", chains: { 1: "0x000000000022D473030F116dDEE9F6B43aC78BA3", 10: "0x000000000022D473030F116dDEE9F6B43aC78BA3", 8453: "0x000000000022D473030F116dDEE9F6B43aC78BA3", 42161: "0x000000000022D473030F116dDEE9F6B43aC78BA3", 137: "0x000000000022D473030F116dDEE9F6B43aC78BA3" } },
  
  // NEW: 9 additional multi-chain protocols to check
  { name: "UniswapV3Factory", chains: { 1: "0x1F98431c8aD98523631AE4a59f267346ea31F984", 10: "0x1F98431c8aD98523631AE4a59f267346ea31F984", 8453: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD", 42161: "0x1F98431c8aD98523631AE4a59f267346ea31F984", 137: "0x1F98431c8aD98523631AE4a59f267346ea31F984" } },
  { name: "AcrossSpokePool", chains: { 1: "0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5", 10: "0x6f26Bf09B1C792e3228e5467807a900A503C0281", 42161: "0xe35e9842fceCA96570B734083f4a58e8F7C5f080", 8453: "0x09aea4fb805d3678096bba4b9b7c9bde329c4c27", 137: "0x9295EE1d8C5b022Be115A2AD3c30C72E34e7F096" } },
  { name: "HopBridge", chains: { 1: "0xb8901acB165ed027E32754E0FFe830802919727f", 10: "0x83f6244Bd87662118d96D9a6D44f09dfff14b30E", 42161: "0x3749C4f034022c39ecafFaBA182555d4508cacCC", 137: "0x553bC791D746767116fA2F5CeA0CbE9d51bE364b" } },
  { name: "BalancerV3Vault", chains: { 1: "0xbA1333333333a1BA1108E8412f11850A5C319bA9", 42161: "0xbA1333333333a1BA1108E8412f11850A5C319bA9", 8453: "0xbA1333333333a1BA1108E8412f11850A5C319bA9" } },
  { name: "SiloV3Factory", chains: { 1: "0x76255571aabf81A7Fb41afcd0a68302c34494d55", 42161: "0x4D919CEcfD4753B4fFA31c879bfF5f7c000c8a04" } },
  { name: "PendleRouter", chains: { 1: "0x00000000005bbb0ef59571E58418F9a4357b68A0", 42161: "0x00000000005bbb0ef59571E58418F9a4357b68A0", 10: "0x00000000005bbb0ef59571E58418F9a4357b68A0" } },
  { name: "SocketGateway", chains: { 1: "0x3a23F943181408EAC424116Af7b7790c94Cb97a5", 42161: "0x3a23F943181408EAC424116Af7b7790c94Cb97a5", 10: "0x3a23F943181408EAC424116Af7b7790c94Cb97a5" } },
  { name: "ChainlinkCCIPRouter", chains: { 1: "0x80226fc0Ee2b096224EeAc085Bb9a8cba1146f7D", 42161: "0x141fa059441E0ca23ce184B6A78bafD2A517Dde8", 10: "0x3206695CaF2992e0b08729DCaCfe16446bB3542e", 8453: "0x881e3A65B4d4a04Dd529061dd0071cf975F58bCD" } },
  { name: "Connext", chains: { 1: "0x8898B472C54c31894e3B9bb83cEA802a5d0e63C6", 42161: "0xEE9deC2712cCE65174B561151701Bf8b99C24C9F", 10: "0x8f7492DE823025b4CfaAB1D34c58963F2af5DEDA", 137: "0x11984dc4465481512eb5b777E44061C158CF2259" } },
];

const EIP712_IFACE = new ethers.Interface([
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
]);

function ensureDir(f) { fs.mkdirSync(path.dirname(f), { recursive: true }); }
function jsonReplacer(_k, v) { return typeof v === "bigint" ? v.toString() : v; }

async function main() {
  const allChainIds = [...new Set(TARGETS.flatMap(t => Object.keys(t.chains).map(Number)))];
  const rpcPool = await resolveRpcPool(allChainIds);
  
  const results = [];
  
  for (const target of TARGETS) {
    const domains = {};
    for (const [cidStr, addr] of Object.entries(target.chains)) {
      const cid = Number(cidStr); const rpc = rpcPool[cid];
      if (!rpc) { domains[cid] = "noRPC"; continue; }
      try {
        const raw = await rpcCall(rpc, "eth_call", [
          { to: addr, data: EIP712_IFACE.encodeFunctionData("DOMAIN_SEPARATOR", []) }, "latest"
        ], 12000);
        if (raw && raw !== "0x") {
          domains[cid] = EIP712_IFACE.decodeFunctionResult("DOMAIN_SEPARATOR", raw)[0];
        }
      } catch (_) { domains[cid] = "error"; }
    }
    
    // Find identical separators across chains
    const seen = {};
    for (const [cid, ds] of Object.entries(domains)) {
      if (!ds || typeof ds !== "string" || ds.length < 10) continue;
      if (!seen[ds]) seen[ds] = [];
      seen[ds].push(Number(cid));
    }
    
    const matches = Object.entries(seen).filter(([_, cids]) => cids.length > 1);
    
    console.error(`${target.name}: ${Object.values(domains).filter(d=>typeof d==="string"&&d.length>10).length} chains, ${matches.length} match(es)`);
    
    results.push({
      name: target.name,
      chainCount: Object.keys(target.chains).length,
      withResponse: Object.values(domains).filter(d => typeof d === "string" && d.length > 10).length,
      crossChainMatches: matches.length,
      exploitable: matches.length > 0,
    });
  }
  
  const exploitable = results.filter(r => r.exploitable);
  
  console.log(JSON.stringify({
    targets: TARGETS.length, totalChains: allChainIds.length,
    withEIP712: results.filter(r => r.withResponse > 0).length,
    crossChainMatches: results.filter(r => r.crossChainMatches > 0).length,
    exploitable: exploitable.length,
    failures: results.filter(r => r.withResponse === 0).map(r => r.name),
  }, null, 2));
  
  ensureDir(OUT);
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), results }, jsonReplacer, 2));
}

main().catch(err => { console.error(err.message); process.exit(1); });
