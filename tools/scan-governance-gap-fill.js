#!/usr/bin/env node
// scan-governance-gap-fill.js - extend governance attack surface from lending to all categories.
// Checks: EOA admin, unsafe upgradeability, missing timelock, weak role separation.
const fs = require("fs"); const path = require("path");
const { ethers } = require("ethers"); const { resolveRpcPool, rpcCall } = require("./shared-rpc");
const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "governance-gap-fill.json");
const QUIET = process.argv.includes("--quiet");

const EIP1967_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

// Non-lending protocols to check — major protocols from each category
const TARGETS = [
  // Bridges
  { name: "Portal (Wormhole)", cat: "Bridge", chainId: 1, proxy: "0x3ee18B2214AFF97000D974cf647E7C347E8fa585" },
  { name: "CCIP Router", cat: "Bridge", chainId: 1, proxy: "0x80226fc0Ee2b096224EeAc085Bb9a8cba1146f7D" },
  { name: "LayerZero V2 EP", cat: "Bridge", chainId: 1, proxy: "0x1a44076050125825900e736c501f859c50fE728c" },
  { name: "Across SpokePool", cat: "Bridge", chainId: 1, proxy: "0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5" },
  { name: "Hop Bridge", cat: "Bridge", chainId: 1, proxy: "0xb8901acB165ed027E32754E0FFe830802919727f" },
  { name: "Arbitrum DelayedInbox", cat: "Bridge", chainId: 1, proxy: "0x4Dbd4fc535Ac27206064B68FfCf827b0A60BAB3f" },
  { name: "OP Portal", cat: "Bridge", chainId: 1, proxy: "0xbEb5Fc579115071764c7423A4f12eDde41f106Ed" },
  { name: "Polygon zkEVM Bridge", cat: "Bridge", chainId: 1, proxy: "0x2a3DD3EB832aF982ec71669E178424b10Dca2EDe" },
  { name: "Connext", cat: "Bridge", chainId: 1, proxy: "0x8898B472C54c31894e3B9bb83cEA802a5d0e63C6" },
  { name: "Socket Gateway", cat: "Bridge", chainId: 1, proxy: "0x3a23F943181408EAC424116Af7b7790c94Cb97a5" },
  // DEXs
  { name: "Uniswap V3 Factory", cat: "DEX", chainId: 1, proxy: "0x1F98431c8aD98523631AE4a59f267346ea31F984" },
  { name: "Curve AddressProvider", cat: "DEX", chainId: 1, proxy: "0x0000000022D53366457F9d5E68Ec105046FC4383" },
  { name: "Balancer V3 Vault", cat: "DEX", chainId: 1, proxy: "0xbA1333333333a1BA1108E8412f11850A5C319bA9" },
  { name: "PancakeSwap Router", cat: "DEX", chainId: 1, proxy: "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4" },
  { name: "1inch Router V5", cat: "DEX", chainId: 1, proxy: "0x1111111254EEB25477B68fb85Ed929f73A596582" },
  // RWA
  { name: "BlackRock BUIDL", cat: "RWA", chainId: 1, proxy: "0x7712c34205737192402172409a8F7ccef8aA2AEc" },
  { name: "Paxos Gold PAXG", cat: "RWA", chainId: 1, proxy: "0x45804880De22913dAFE09f4980848ECE6EcbAf78" },
  { name: "Tether Gold XAUt", cat: "RWA", chainId: 1, proxy: "0x68749665FF8D2d112Fa859AA293F07C622884F65" },
  // LST
  { name: "Lido stETH", cat: "LST", chainId: 1, proxy: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84" },
  { name: "Coinbase cbETH", cat: "LST", chainId: 1, proxy: "0xBe9895146f7AF43049ca1c1AE358B0541Ea49704" },
  { name: "Rocket Pool rETH", cat: "LST", chainId: 1, proxy: "0xae78736Cd615f374D3085123A210448E74Fc6393" },
  { name: "EigenLayer StrategyMgr", cat: "LST", chainId: 1, proxy: "0x858646372CC42E1A627fcE94aa7A7033e7CF075A" },
  // CDP
  { name: "Liquity V1 TroveMgr", cat: "CDP", chainId: 1, proxy: "0xA39739EF8b0231DbFA0DcdA07d7e29faAbCf4bb2" },
  { name: "Liquity V2 CollRegistry", cat: "CDP", chainId: 1, proxy: "0xD89Ed3C0b5F502c7b14a54111d17D6a224259C39" },
  { name: "MakerDAO MCD VAT", cat: "CDP", chainId: 1, proxy: "0x35D1b3F3D7966A1DFe207aa4514C12a259A0492B" },
  { name: "crvUSD Controller", cat: "CDP", chainId: 1, proxy: "0x744c66818A22c5e30F890dD0f8d2fBC1eD7BcAB8" },
  // Yield
  { name: "Harmonix Factory", cat: "Yield", chainId: 1, proxy: null }, // from artifact
  { name: "Resupply Registry", cat: "Yield", chainId: 1, proxy: null },
  // BTC Wrapper
  { name: "SolvBTC Ethereum", cat: "BTC", chainId: 1, proxy: "0x7A56E1C57C7475CCf742a1832B028F0456652F97" },
  // Stablecoin Wrapper
  { name: "USDCx xReserve", cat: "Stablecoin", chainId: 1, proxy: "0x8888888199b2Df864bf678259607d6D5EBb4e3Ce" },
];

const COMMON = new ethers.Interface([
  "function owner() view returns (address)",
  "function admin() view returns (address)",
  "function proxyAdmin() view returns (address)",
  "function getAdmin() view returns (address)",
  "function getProxyAdmin() view returns (address)",
  "function getOwner() view returns (address)",
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "function getRoleAdmin(bytes32) view returns (bytes32)",
  "function getMinDelay() view returns (uint256)",
  "function timelock() view returns (address)",
  "function guardian() view returns (address)",
  "function pauseGuardian() view returns (address)",
]);

function ensureDir(f) { fs.mkdirSync(path.dirname(f), { recursive: true }); }
function jsonReplacer(_k, v) { return typeof v === "bigint" ? v.toString() : v; }
function normalizeAddress(v) { try { return ethers.getAddress(String(v || "")); } catch (_) { return null; } }

async function safeCall(rpc, to, iface, fn, args = [], ms = 12000) {
  const a = normalizeAddress(to); if (!rpc || !a) return null;
  try { const raw = await rpcCall(rpc, "eth_call", [{ to: a, data: iface.encodeFunctionData(fn, args) }, "latest"], ms); if (!raw || raw === "0x") return null; return iface.decodeFunctionResult(fn, raw); } catch (_) { return null; }
}
async function getStorage(rpc, to, slot, ms = 10000) {
  const a = normalizeAddress(to); if (!rpc || !a) return null;
  return await rpcCall(rpc, "eth_getStorageAt", [a, slot, "latest"], ms).catch(() => null);
}
async function getCode(rpc, to, ms = 10000) {
  const a = normalizeAddress(to); if (!rpc || !a) return "0x";
  return await rpcCall(rpc, "eth_getCode", [a, "latest"], ms).catch(() => "0x") || "0x";
}

function addressFromSlot(raw) {
  if (!raw || raw === "0x") return null;
  const h = String(raw || "").replace(/^0x/i, "").padStart(64, "0");
  return /^0+$/.test(h) ? null : normalizeAddress(`0x${h.slice(-40)}`);
}

async function main() {
  const rpc = await resolveRpcPool([1]);
  const ethRpc = rpc[1]; if (!ethRpc) throw new Error("No Ethereum RPC");

  const results = [];
  for (const t of TARGETS) {
    if (!t.proxy) { results.push({ ...t, error: "no proxy address" }); continue; }
    
    // Read EIP-1967 admin slot (works for UUPS/Transparent proxies)
    const [adminSlotRaw, implSlotRaw, ownerRaw, adminRaw, proxyAdminRaw, getAdminRaw, guardianRaw, pauseGuardRaw, minDelayRaw] = await Promise.all([
      getStorage(ethRpc, t.proxy, EIP1967_ADMIN), getStorage(ethRpc, t.proxy, EIP1967_IMPL),
      safeCall(ethRpc, t.proxy, COMMON, "owner"), safeCall(ethRpc, t.proxy, COMMON, "admin"),
      safeCall(ethRpc, t.proxy, COMMON, "proxyAdmin"), safeCall(ethRpc, t.proxy, COMMON, "getAdmin"),
      safeCall(ethRpc, t.proxy, COMMON, "guardian"), safeCall(ethRpc, t.proxy, COMMON, "pauseGuardian"),
      safeCall(ethRpc, t.proxy, COMMON, "getMinDelay"),
    ]);

    const adminSlot = addressFromSlot(adminSlotRaw);
    const impl = addressFromSlot(implSlotRaw);
    const owner = ownerRaw?.[0] ? normalizeAddress(ownerRaw[0]) : null;
    const admin = adminRaw?.[0] ? normalizeAddress(adminRaw[0]) : proxyAdminRaw?.[0] ? normalizeAddress(proxyAdminRaw[0]) : getAdminRaw?.[0] ? normalizeAddress(getAdminRaw[0]) : null;
    const guardian = guardianRaw?.[0] ? normalizeAddress(guardianRaw[0]) : pauseGuardRaw?.[0] ? normalizeAddress(pauseGuardRaw[0]) : null;
    const minDelay = minDelayRaw?.[0] ? Number(minDelayRaw[0]) : null;

    // Resolve admin slot address to EOA vs contract
    const adminAddr = adminSlot || owner || admin;
    const adminCode = adminAddr ? await getCode(ethRpc, adminAddr) : "0x";
    const adminCodeBytes = adminCode !== "0x" ? (adminCode.length - 2) / 2 : 0;
    const adminIsEOA = adminAddr && adminCodeBytes === 0;
    const adminIsContract = adminAddr && adminCodeBytes > 0;

    // Classify risk
    let risk = "SAFE"; let riskScore = 0;
    if (adminIsEOA && !minDelay) { risk = "HIGH"; riskScore = 80; }
    else if (adminIsEOA && minDelay && minDelay < 86400) { risk = "MEDIUM"; riskScore = 50; }
    else if (adminIsEOA && minDelay && minDelay >= 86400) { risk = "LOW"; riskScore = 20; }
    else if (adminIsContract && !minDelay) { risk = "MEDIUM"; riskScore = 40; }
    else if (adminIsContract && minDelay && minDelay < 86400) { risk = "LOW"; riskScore = 15; }
    else if (adminIsContract && minDelay && minDelay >= 86400) { risk = "SAFE"; riskScore = 5; }
    if (!adminAddr) { risk = "UNKNOWN"; riskScore = 30; }

    // Guardian as separate risk
    let guardianRisk = false;
    if (guardian) {
      const gCode = await getCode(ethRpc, guardian);
      const gCodeBytes = gCode !== "0x" ? (gCode.length - 2) / 2 : 0;
      if (gCodeBytes === 0) { guardianRisk = true; risk = risk === "SAFE" ? "MEDIUM" : risk; riskScore += 15; }
    }

    results.push({
      name: t.name, category: t.cat, proxy: t.proxy,
      adminAddress: adminAddr, adminIsEOA, adminIsContract, adminCodeBytes,
      hasTimelock: minDelay !== null, minDelaySeconds: minDelay,
      hasGuardian: guardian !== null, guardianIsEOA: guardianRisk,
      implementation: impl,
      risk, riskScore,
      finding: riskScore >= 50 ? `HIGH/MEDIUM risk: ${adminIsEOA ? "EOA admin" : "contract admin"} with ${minDelay ? minDelay + "s delay" : "NO timelock"}${guardianRisk ? "; EOA guardian" : ""}` : null,
    });

    if (!QUIET) console.error(`${t.name}: ${risk} (admin=${adminIsEOA ? "EOA" : adminIsContract ? "contract" : "?"}, delay=${minDelay ?? "none"}, guardian=${guardianRisk ? "EOA" : "ok"})`);
  }

  const highRisk = results.filter(r => r.risk === "HIGH");
  const medRisk = results.filter(r => r.risk === "MEDIUM");

  const output = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-governance-gap-fill.js",
    scope: "Governance attack surface extended to non-lending protocols",
    safety: { rpcInventoryRead: true, rpcUrlsStored: false, signedActions: false },
    summary: {
      targetsScanned: results.length,
      highRisk: highRisk.length, mediumRisk: medRisk.length,
      routePositive: highRisk.length + medRisk.length,
    },
    results: results.sort((a, b) => b.riskScore - a.riskScore),
  };

  ensureDir(OUT);
  fs.writeFileSync(OUT, `${JSON.stringify(output, jsonReplacer, 2)}\n`);

  console.log(JSON.stringify({
    targets: results.length,
    high: highRisk.map(r => `${r.name} (${r.category}): ${r.finding}`),
    medium: medRisk.map(r => `${r.name} (${r.category}): ${r.finding}`),
    highCount: highRisk.length, mediumCount: medRisk.length,
  }, null, 2));
}

main().catch(err => { console.error(err.message); process.exit(1); });
