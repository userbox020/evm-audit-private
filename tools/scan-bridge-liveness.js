#!/usr/bin/env node
// scan-bridge-liveness.js - check bridge protocols for relay griefing, finality DoS, dispute abuse.
const fs = require("fs"); const path = require("path");
const { ethers } = require("ethers"); const { resolveRpc, rpcCall } = require("./shared-rpc");
const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "bridge-liveness.json");
const QUIET = process.argv.includes("--quiet");

// Bridge contracts to probe for liveness risks
const BRIDGES = [
  {
    name: "OP Portal (Optimism)", chainId: 1,
    proxy: "0xbEb5Fc579115071764c7423A4f12eDde41f106Ed",
    checks: {
      finalityWindow: "FINALIZATION_PERIOD_SECONDS() -> uint256",
      isPaused: "paused() -> bool",
      guardian: "GUARDIAN() -> address",
    },
    risks: ["7-day finality window can delay withdrawals", "Guardian can pause — single point of failure if EOA"],
  },
  {
    name: "Arbitrum DelayedInbox", chainId: 1,
    proxy: "0x4Dbd4fc535Ac27206064B68FfCf827b0A60BAB3f",
    checks: {
      isPaused: "paused() -> bool",
      bridge: "bridge() -> address",
    },
    risks: ["Retryable tickets can expire unclaimed", "Sequencer downtime blocks L1→L2 messages"],
  },
  {
    name: "Portal TokenBridge (Wormhole)", chainId: 1,
    proxy: "0x3ee18B2214AFF97000D974cf647E7C347E8fa585",
    checks: {
      isInitialized: "isInitialized(address) -> bool",
      chainId: "chainId() -> uint16",
    },
    risks: ["Guardian quorum (13/19) required for VAA — liveness depends on guardians", "Guardian set can be updated but requires governance"],
  },
  {
    name: "Across SpokePool", chainId: 1,
    proxy: "0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5",
    checks: {
      paused: "paused() -> bool",
    },
    risks: ["Relayer fill mechanism — single relayer failure could delay fills", "Optimistic oracle dispute window (2 hours) can delay settlement"],
  },
  {
    name: "Hop Bridge", chainId: 1,
    proxy: "0xb8901acB165ed027E32754E0FFe830802919727f",
    checks: {},
    risks: ["Bonder liveness — if all bonders go offline, transfers are stuck", "Challenge period for bonder fraud proofs"],
  },
  {
    name: "Polygon zkEVM Bridge", chainId: 1,
    proxy: "0x2a3DD3EB832aF982ec71669E178424b10Dca2EDe",
    checks: {},
    risks: ["Proof submission window — delayed proof = delayed withdrawals", "Emergency state can freeze bridge"],
  },
  {
    name: "Connext", chainId: 1,
    proxy: "0x8898B472C54c31894e3B9bb83cEA802a5d0e63C6",
    checks: {},
    risks: ["Router liquidity dependency — if routers withdraw liquidity, transfers fail", "Watcher/relayer liveness for fraud proofs"],
  },
  {
    name: "LayerZero V2 Endpoint", chainId: 1,
    proxy: "0x1a44076050125825900e736c501f859c50fE728c",
    checks: {},
    risks: ["DVN (Decentralized Verifier Network) liveness — if DVNs are down, messages stuck", "Executor liveness — if executor is down, messages not delivered"],
  },
  {
    name: "Socket Gateway", chainId: 1,
    proxy: "0x3a23F943181408EAC424116Af7b7790c94Cb97a5",
    checks: {},
    risks: ["Single EOA admin (governance scan found HIGH risk)", "If admin pauses or changes routing, user funds may be stuck"],
  },
];

const GAS = 30000000; // 30M gas block limit — check if bridge ops fit

// Generic probes
const PROBES = [
  { name: "paused", sig: "function paused() view returns (bool)", args: [] },
  { name: "isPaused", sig: "function isPaused() view returns (bool)", args: [] },
  { name: "finalizationPeriod", sig: "function FINALIZATION_PERIOD_SECONDS() view returns (uint256)", args: [] },
  { name: "guardian", sig: "function GUARDIAN() view returns (address)", args: [] },
  { name: "bridge", sig: "function bridge() view returns (address)", args: [] },
  { name: "owner", sig: "function owner() view returns (address)", args: [] },
];

function ensureDir(f) { fs.mkdirSync(path.dirname(f), { recursive: true }); }
function jsonReplacer(_k, v) { return typeof v === "bigint" ? v.toString() : v; }
function normalizeAddress(v) { try { return ethers.getAddress(String(v || "")); } catch (_) { return null; } }

async function main() {
  const rpc = await resolveRpc(1);
  if (!rpc) throw new Error("No RPC");

  const results = [];
  for (const b of BRIDGES) {
    const probes = {};
    for (const p of PROBES) {
      try {
        const iface = new ethers.Interface([p.sig]);
        const raw = await rpcCall(rpc, "eth_call", [
          { to: b.proxy, data: iface.encodeFunctionData(p.name, p.args) }, "latest"
        ], 12000);
        if (raw && raw !== "0x") {
          const decoded = iface.decodeFunctionResult(p.name, raw);
          probes[p.name] = decoded[0]?.toString() || "decoded-null";
        }
      } catch (_) {}
    }
    
    // Analyze liveness
    let livenessScore = 0;
    const findings = [];
    
    // Check pause state
    if (probes.paused === "true" || probes.isPaused === "true") {
      findings.push("BRIDGE PAUSED — all operations blocked");
      livenessScore += 80;
    }
    
    // Check finalization window
    if (probes.finalizationPeriod) {
      const period = Number(ethers.formatUnits(probes.finalizationPeriod, 0));
      findings.push(`Finalization period: ${period}s (${(period/86400).toFixed(1)} days) — long windows delay user withdrawals`);
      livenessScore += period > 604800 ? 25 : period > 86400 ? 15 : 5; // >7d = high, >1d = medium
    }
    
    // Check guardian
    if (probes.guardian) {
      const g = probes.guardian;
      const code = await rpcCall(rpc, "eth_getCode", [g, "latest"], 8000).catch(() => "0x");
      const isEOA = !code || code === "0x" || code === "0x0";
      if (isEOA) {
        findings.push(`Guardian is EOA (${g.slice(0,10)}...) — single point of liveness failure`);
        livenessScore += 30;
      } else {
        findings.push(`Guardian is contract with ${(code.length-2)/2} bytes code`);
      }
    }
    
    // Check owner (for Socket Gateway style)
    if (probes.owner) {
      const o = probes.owner;
      const code = await rpcCall(rpc, "eth_getCode", [o, "latest"], 8000).catch(() => "0x");
      const isEOA = !code || code === "0x" || code === "0x0";
      if (isEOA) {
        findings.push(`Owner is EOA (${o.slice(0,10)}...) — single point of liveness failure`);
        livenessScore += 35;
      }
    }
    
    // Add known structural risks
    for (const r of (b.risks || [])) findings.push(r);
    
    results.push({
      name: b.name, proxy: b.proxy,
      probes: Object.keys(probes).length,
      livenessScore,
      findings,
      severity: livenessScore >= 50 ? "HIGH" : livenessScore >= 20 ? "MEDIUM" : "LOW",
    });
    
    if (!QUIET) console.error(`${b.name}: score=${livenessScore} (${results[results.length-1].severity})`);
  }

  const high = results.filter(r => r.severity === "HIGH");
  const med = results.filter(r => r.severity === "MEDIUM");

  const output = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-bridge-liveness.js",
    scope: "Bridge protocol liveness and griefing assessment",
    safety: { rpcInventoryRead: true, rpcUrlsStored: false, signedActions: false },
    summary: {
      bridgesScanned: results.length,
      high: high.length, medium: med.length,
      routePositive: high.length + med.length,
    },
    results,
  };

  ensureDir(OUT);
  fs.writeFileSync(OUT, `${JSON.stringify(output, jsonReplacer, 2)}\n`);

  console.log(JSON.stringify({
    bridges: results.length, high: high.length, medium: med.length,
    highList: high.map(r => r.name),
    details: results.map(r => ({
      name: r.name, score: r.livenessScore, severity: r.severity,
      keyFinding: r.findings.find(f => f.includes("EOA") || f.includes("PAUSED") || f.includes("days")) || r.findings[0],
    })),
  }, null, 2));
}

main().catch(err => { console.error(err.message); process.exit(1); });
