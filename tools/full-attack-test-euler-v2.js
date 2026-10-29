#!/usr/bin/env node
// full-attack-test-euler-v2.js - Complete 8-point attack test suite for Euler V2.
// Tests: permissionless probes, oracle audit, access control, consumer graph,
// DEX liquidity, economic model, fork readiness, live state.
const fs = require("fs"); const path = require("path");
const { ethers } = require("ethers"); const { resolveRpc, rpcCall } = require("./shared-rpc");
const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "full-attack-test-euler-v2.json");
const QUIET = process.argv.includes("--quiet");
const PROBE_FROM = "0x000000000000000000000000000000000000dEaD";

const EVK_FACTORY = "0x29a56a1b8214D9Cf7c5561811750D5cBDb45CC8e";
const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

function ensureDir(f) { fs.mkdirSync(path.dirname(f), { recursive: true }); }
function jsonReplacer(_k, v) { return typeof v === "bigint" ? v.toString() : v; }
function normalizeAddress(v) { try { return ethers.getAddress(String(v || "")); } catch (_) { return null; } }
function round(v, d = 2) { const n = Number(v); return Number.isFinite(n) ? Math.round(n * (10 ** d)) / (10 ** d) : null; }

async function safeCall(rpc, to, iface, fn, args = [], ms = 12000) {
  const a = normalizeAddress(to); if (!rpc || !a) return null;
  try { const raw = await rpcCall(rpc, "eth_call", [{ to: a, data: iface.encodeFunctionData(fn, args) }, "latest"], ms); if (!raw || raw === "0x") return null; return iface.decodeFunctionResult(fn, raw); } catch (_) { return null; }
}

async function stateProbe(rpc, to, sig, args = [], ms = 8000) {
  const a = normalizeAddress(to); if (!rpc || !a) return { success: false };
  const fn = sig.slice(0, sig.indexOf("("));
  const iface = new ethers.Interface(["function " + sig]);
  try { await rpcCall(rpc, "eth_call", [{ from: PROBE_FROM, to: a, data: iface.encodeFunctionData(fn, args) }, "latest"], ms); return { success: true }; } catch (_) { return { success: false }; }
}

async function getCode(rpc, a) { const aa = normalizeAddress(a); return (!rpc || !aa) ? "0x" : (await rpcCall(rpc, "eth_getCode", [aa, "latest"], 10000).catch(() => "0x")) || "0x"; }
async function getStorage(rpc, a, slot) { const aa = normalizeAddress(a); return (!rpc || !aa) ? null : await rpcCall(rpc, "eth_getStorageAt", [aa, slot, "latest"], 10000).catch(() => null); }

async function main() {
  const rpc = await resolveRpc(1); if (!rpc) throw new Error("No RPC");
  const results = { generatedAt: new Date().toISOString(), scanner: "tools/full-attack-test-euler-v2.js" };
  const checks = {};
  
  // CHECK 1: Permissionless Surface Scan
  console.error("=== CHECK 1: Permissionless Surface Scan ===");
  const PERMISSIONLESS_SIGS = [
    "mint(address,uint256)", "burn(uint256)", "burnFrom(address,uint256)",
    "withdraw(uint256)", "withdraw(address,uint256)", "redeem(uint256)",
    "sweep(address)", "rescueTokens(address,address,uint256)", "recoverERC20(address,uint256)",
    "claim()", "claim(address)", "harvest()", "migrate()",
    "execute(address,uint256,bytes)", "pause()", "unpause()",
  ];
  const permProbes = [];
  for (const sig of PERMISSIONLESS_SIGS) {
    const result = await stateProbe(rpc, EVK_FACTORY, sig);
    permProbes.push({ sig, success: result.success });
  }
  const permOk = permProbes.filter(p => p.success);
  checks.permissionless = { target: EVK_FACTORY, probes: permProbes.length, successes: permOk.length, successfulSigs: permOk.map(p => p.sig), verdict: permOk.length > 0 ? "VULNERABLE" : "SAFE" };
  console.error(`  ${permOk.length}/${permProbes.length} probes succeeded`);

  // CHECK 2: Oracle Audit
  console.error("=== CHECK 2: Oracle Audit ===");
  // Read eVault Phase 0 artifact to find watch candidates
  const evPhase0 = (() => { try { return JSON.parse(fs.readFileSync(path.join(WORKSPACE, "reports/raw/fast/euler-v2-phase0.json"), "utf8")); } catch (_) { return null; } })();
  const watchCandidates = (evPhase0?.watchCandidates || []).slice(0, 10);
  const oracleResults = [];
  for (const wc of watchCandidates) {
    if (!wc.oracle) continue;
    const code = await getCode(rpc, wc.oracle);
    const bytes = code !== "0x" ? (code.length - 2) / 2 : 0;
    oracleResults.push({ vault: wc.vaultSymbol || wc.collateralSymbol, oracle: wc.oracle?.slice(0, 10), codeBytes: bytes, type: bytes === 0 ? "no-code" : bytes <= 100 ? "minimal" : bytes <= 500 ? "small" : bytes <= 2000 ? "medium" : "large" });
  }
  checks.oracle = { candidatesChecked: oracleResults.length, customOracles: oracleResults.filter(o => o.type === "large"), verdict: oracleResults.some(o => o.type === "large") ? "NEEDS_DEEP_REVIEW" : "STANDARD" };
  console.error(`  ${oracleResults.length} oracles checked, ${oracleResults.filter(o => o.type === "large").length} large custom`);

  // CHECK 3: Access Control Audit  
  console.error("=== CHECK 3: Access Control Audit ===");
  const COMMON = new ethers.Interface(["function owner() view returns (address)", "function admin() view returns (address)", "function paused() view returns (bool)"]);
  const [implSlot, adminSlot, ownerRaw, adminRaw, pausedRaw] = await Promise.all([
    getStorage(rpc, EVK_FACTORY, EIP1967_IMPL), getStorage(rpc, EVK_FACTORY, EIP1967_ADMIN),
    safeCall(rpc, EVK_FACTORY, COMMON, "owner"), safeCall(rpc, EVK_FACTORY, COMMON, "admin"),
    safeCall(rpc, EVK_FACTORY, COMMON, "paused"),
  ]);
  const impl = implSlot && implSlot !== "0x" ? normalizeAddress("0x" + implSlot.slice(66-40)) : null;
  const adminSlotAddr = adminSlot && adminSlot !== "0x" ? normalizeAddress("0x" + adminSlot.slice(66-40)) : null;
  const owner = ownerRaw?.[0] ? normalizeAddress(ownerRaw[0]) : null;
  const admin = adminRaw?.[0] ? normalizeAddress(adminRaw[0]) : adminSlotAddr;
  const paused = pausedRaw ? Boolean(pausedRaw[0]) : null;
  
  let adminType = "unknown";
  if (admin) { const code = await getCode(rpc, admin); const bytes = code !== "0x" ? (code.length - 2) / 2 : 0; adminType = bytes === 0 ? "EOA" : "contract"; }
  
  checks.accessControl = { proxy: EVK_FACTORY, implementation: impl, admin: admin, adminType, paused, verdict: adminType === "EOA" ? "HIGH_RISK" : adminType === "contract" ? "MEDIUM" : "UNKNOWN" };
  console.error(`  Admin: ${adminType}, Paused: ${paused}`);

  // CHECK 4: Consumer Graph Scan
  console.error("=== CHECK 4: Consumer Graph Scan ===");
  const consumerArtifacts = ["aave-euler-silo-consumer-graph.json", "consumer-first-high-ltv-collateral.json", "morpho-public-allocator-force-feed.json"];
  let consumerMatches = 0;
  for (const art of consumerArtifacts) {
    try { const j = JSON.parse(fs.readFileSync(path.join(WORKSPACE, "reports/raw/fast", art), "utf8")); const text = JSON.stringify(j); if (text.includes(EVK_FACTORY.toLowerCase())) consumerMatches++; } catch (_) {}
  }
  checks.consumerGraph = { artifactsScanned: consumerArtifacts.length, matches: consumerMatches, verdict: consumerMatches > 0 ? "HAS_CONSUMERS" : "NO_CONSUMERS" };
  console.error(`  ${consumerMatches} consumer matches`);

  // CHECK 5: DEX Exit Liquidity
  console.error("=== CHECK 5: DEX Exit Liquidity ===");
  // Check if any eVault share token has DEX liquidity
  const shareTokens = watchCandidates.map(w => w.vaultAddress).filter(Boolean);
  let dexLiquidity = 0;
  if (shareTokens.length > 0) {
    try {
      const url = "https://api.dexscreener.com/latest/dex/tokens/" + shareTokens.slice(0, 5).join(",");
      const res = await fetch(url, { headers: { "user-agent": "evm-audit/1.0" } });
      const data = await res.json();
      dexLiquidity = (data.pairs || []).reduce((s, p) => s + (p.liquidity?.usd || 0), 0);
    } catch (_) {}
  }
  checks.dexLiquidity = { tokensChecked: shareTokens.length, totalLiquidityUsd: round(dexLiquidity), verdict: dexLiquidity > 10000 ? "LIQUID" : dexLiquidity > 0 ? "THIN" : "NONE" };
  console.error(`  DEX liquidity: $${round(dexLiquidity)}`);

  // CHECK 6: Economic Model
  console.error("=== CHECK 6: Economic Model ===");
  // For the donation vulnerability: model using existing eVault donation sensitivity data
  const evDonation = (() => { try { return JSON.parse(fs.readFileSync(path.join(WORKSPACE, "reports/raw/fast/evault-collateral-nav-manipulation.json"), "utf8")); } catch (_) { return null; } })();
  const donationWatch = (evDonation?.watchCandidates || []).slice(0, 5);
  const econResults = donationWatch.map(dw => {
    const bestNet = round(dw.bestModeledNetUsd || dw.bestNetUsd || 0);
    const requiredPremium = round(dw.bestRequiredPremiumBps || 0);
    return { vault: dw.collateralSymbol || dw.vaultSymbol, bestNetUsd: bestNet, requiredPremiumBps: requiredPremium, routePositive: bestNet > 0 };
  });
  checks.economicModel = { candidatesModeled: econResults.length, routePositive: econResults.filter(e => e.routePositive).length, bestNet: econResults.reduce((b, e) => Math.max(b, e.bestNetUsd), -Infinity), verdict: econResults.some(e => e.routePositive) ? "ROUTE_POSITIVE" : "ROUTE_NEGATIVE" };
  console.error(`  ${econResults.length} modeled, best net: $${checks.economicModel.bestNet}`);

  // CHECK 7: Fork Test Readiness
  console.error("=== CHECK 7: Fork Test Readiness ===");
  const hasForkProof = fs.existsSync(path.join(WORKSPACE, "reports/raw/fast/fork-proof-euler-v2.json"));
  checks.forkTest = { forkProofExists: hasForkProof, verdict: hasForkProof ? "FORK_PROVEN" : checks.economicModel.verdict === "ROUTE_POSITIVE" ? "FORK_NEEDED" : "NOT_NEEDED" };
  console.error(`  Fork proof: ${hasForkProof ? "EXISTS" : "MISSING"}`);

  // CHECK 8: Live State
  console.error("=== CHECK 8: Live State Check ===");
  const liveState = { defillamaTvl: evPhase0?.summary?.defillamaCurrentTvlUsd || "unknown", totalBorrowCash: evPhase0?.summary?.totalBorrowCashUsd || "unknown", totalVaults: evPhase0?.summary?.vaultRows || "unknown", watchCandidates: evPhase0?.summary?.watchCandidates || 0 };
  checks.liveState = { ...liveState, blockChecked: parseInt(await rpcCall(rpc, "eth_blockNumber", [], 8000).then(r => r ? parseInt(r, 16) : 0)), verdict: "ACTIVE" };
  console.error(`  TVL: ${liveState.defillamaTvl}, Watch: ${liveState.watchCandidates}`);

  // Final verdict
  const overallVerdict = checks.permissionless.verdict === "VULNERABLE" ? "PERMISSIONLESS_DRAIN_FOUND" :
    checks.economicModel.verdict === "ROUTE_POSITIVE" ? "ROUTE_POSITIVE_NEEDS_FORK" :
    checks.accessControl.verdict === "HIGH_RISK" ? "ADMIN_RISK" :
    "ROUTE_NEGATIVE_SAFE";

  results.checks = checks;
  results.overallVerdict = overallVerdict;
  results.gaps = [];
  if (!checks.forkTest.forkProofExists && checks.economicModel.verdict === "ROUTE_POSITIVE") results.gaps.push("FORK_TEST_MISSING");
  if (checks.permissionless.successes === 0) results.gaps.push("NO_PERMISSIONLESS_SURFACE");
  if (checks.consumerGraph.verdict === "NO_CONSUMERS") results.gaps.push("NO_LENDING_CONSUMERS");
  if (checks.dexLiquidity.verdict === "NONE") results.gaps.push("NO_DEX_LIQUIDITY");

  ensureDir(OUT);
  fs.writeFileSync(OUT, JSON.stringify(results, jsonReplacer, 2));

  console.log(JSON.stringify({
    protocol: "Euler V2 (EVK Factory)",
    checks: {
      permissionless: checks.permissionless.successes + "/" + checks.permissionless.probes + " probes ok",
      oracle: checks.oracle.candidatesChecked + " checked, " + checks.oracle.customOracles.length + " custom",
      accessControl: checks.accessControl.adminType + " admin" + (checks.accessControl.paused ? ", PAUSED" : ""),
      consumerGraph: checks.consumerGraph.matches + " matches",
      dexLiquidity: "$" + checks.dexLiquidity.totalLiquidityUsd,
      economicModel: checks.economicModel.bestNet + " best net",
      forkTest: checks.forkTest.verdict,
      liveState: "TVL=$" + checks.liveState.defillamaTvl + ", " + checks.liveState.watchCandidates + " watch",
    },
    overallVerdict,
    gaps: results.gaps,
  }, null, 2));
}

main().catch(err => { console.error(err.message); process.exit(1); });
