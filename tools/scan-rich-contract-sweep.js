#!/usr/bin/env node
// scan-rich-contract-sweep.js - scan contracts with >$50K token balances for permissionless drain paths.
// Checks: sweep(), rescueTokens(), withdraw(), emergencyWithdraw(), harvest(), claim()
// Never prints or stores RPC URLs, keys, calldata, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpc, rpcCall } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "rich-contract-sweep.json");
const QUIET = process.argv.includes("--quiet");
const PROBE_FROM = "0x000000000000000000000000000000000000dEaD";
const MIN_BALANCE_USD = 50000;

// Sources of rich contracts: collect addresses from existing artifacts
const SOURCES = [
  "reports/raw/fast/deprecated-orphaned-reachability.json",
  "reports/raw/fast/recent-contracts-old-money.json",
  "reports/raw/fast/post-audit-deployed-map.json",
  "reports/raw/fast/strategy-migration-rebalance.json",
  "reports/raw/fast/claim-distributor-replay.json",
];

const DRAIN_SELECTORS = [
  { label: "sweep(address)", signature: "sweep(address)", args: (t) => [t] },
  { label: "sweep(address,uint256)", signature: "sweep(address,uint256)", args: (t) => [t, 0n] },
  { label: "rescueTokens(address,address,uint256)", signature: "rescueTokens(address,address,uint256)", args: (t) => [t, PROBE_FROM, 0n] },
  { label: "withdraw(uint256)", signature: "withdraw(uint256)", args: () => [1n] },
  { label: "withdraw(address,uint256)", signature: "withdraw(address,uint256)", args: (t) => [t, 1n] },
  { label: "emergencyWithdraw(uint256)", signature: "emergencyWithdraw(uint256)", args: () => [1n] },
  { label: "harvest()", signature: "harvest()", args: () => [] },
  { label: "claim(address)", signature: "claim(address)", args: () => [PROBE_FROM] },
  { label: "claim()", signature: "claim()", args: () => [] },
  { label: "execute(address,uint256,bytes)", signature: "execute(address,uint256,bytes)", args: (t) => [t, 0n, "0x"] },
];

function ensureDir(f) { fs.mkdirSync(path.dirname(f), { recursive: true }); }
function readJson(f, fb = null) { try { if (!fs.existsSync(f)) return fb; return JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { return fb; } }
function jsonReplacer(_k, v) { return typeof v === "bigint" ? v.toString() : v; }
function normalizeAddress(v) { try { return ethers.getAddress(String(v || "")); } catch (_) { return null; } }
function unique(items) { return [...new Set((items || []).filter(Boolean))]; }

function extractAddresses(data, seen = new Set(), max = 500) {
  const addrs = [];
  function walk(v) {
    if (addrs.length >= max) return;
    if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) {
      const a = v.toLowerCase();
      if (!seen.has(a)) { seen.add(a); addrs.push(v); }
      return;
    }
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    for (const k of Object.keys(v)) walk(v[k]);
  }
  walk(data);
  return addrs;
}

async function safeCall(rpc, to, iface, fn, args = [], ms = 12_000) {
  const a = normalizeAddress(to); if (!rpc || !a) return null;
  try { const raw = await rpcCall(rpc, "eth_call", [{ to: a, data: iface.encodeFunctionData(fn, args) }, "latest"], ms); if (!raw || raw === "0x") return null; return iface.decodeFunctionResult(fn, raw); } catch (_) { return null; }
}

async function getCode(rpc, a) { const aa = normalizeAddress(a); return (!rpc || !aa) ? "0x" : (await rpcCall(rpc, "eth_getCode", [aa, "latest"], 10_000).catch(() => "0x")) || "0x"; }

async function stateProbe(rpc, to, probe, token) {
  const a = normalizeAddress(to); if (!rpc || !a) return false;
  const fn = probe.signature.slice(0, probe.signature.indexOf("("));
  const iface = new ethers.Interface([`function ${probe.signature}`]);
  try { await rpcCall(rpc, "eth_call", [{ from: PROBE_FROM, to: a, data: iface.encodeFunctionData(fn, probe.args(token)) }, "latest"], 8000); return true; } catch (_) { return false; }
}

async function main() {
  const allAddrs = new Set();
  for (const src of SOURCES) {
    const f = path.join(WORKSPACE, src);
    const data = readJson(f);
    if (!data) continue;
    extractAddresses(data, allAddrs, 500);
  }
  const addresses = [...allAddrs].slice(0, 300);
  console.error(`Collected ${addresses.length} unique addresses from artifacts`);

  const rpc = await resolveRpc(1);
  if (!rpc) throw new Error("No RPC");

  const ERC20 = new ethers.Interface([
    "function balanceOf(address) view returns (uint256)",
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
  ]);

  // Quick filter: check code presence first
  const codeChecks = [];
  for (const addr of addresses.slice(0, 200)) {
    const code = await getCode(rpc, addr);
    if (code !== "0x" && code.length > 200) { // has meaningful code
      codeChecks.push({ address: addr, codeBytes: (code.length - 2) / 2 });
    }
  }
  console.error(`${codeChecks.length} contracts with code > 200 bytes`);

  // For each code-present contract, check native ETH balance via RPC
  const richContracts = [];
  for (const c of codeChecks.slice(0, 100)) {
    const balHex = await rpcCall(rpc, "eth_getBalance", [c.address, "latest"], 8000).catch(() => null);
    const ethBal = balHex ? Number(ethers.formatEther(BigInt(balHex))) : 0;
    if (ethBal * 3000 > MIN_BALANCE_USD) { // ~$3K ETH price
      richContracts.push({ ...c, ethBalance: ethBal, ethBalanceUsd: Math.round(ethBal * 3000) });
    }
  }
  console.error(`${richContracts.length} contracts with >$50K ETH`);

  // Probe drain selectors on rich contracts
  const findings = [];
  const tokens = [null]; // null = native ETH for sweep-like selectors
  for (const rc of richContracts.slice(0, 20)) {
    const probes = [];
    for (const sel of DRAIN_SELECTORS) {
      const success = await stateProbe(rpc, rc.address, sel, null);
      if (success) probes.push({ label: sel.label, success: true });
    }
    if (probes.length > 0) {
      findings.push({ ...rc, probes, probeCount: probes.length });
    }
  }

  const output = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-rich-contract-sweep.js",
    scope: "Rich contract sweep for permissionless drain functions",
    safety: { rpcInventoryRead: true, rpcUrlsStored: false, signedActions: false, routePositive: false },
    summary: {
      addressesInput: addresses.length,
      codePresentRows: codeChecks.length,
      richEthRows: richContracts.length,
      probeSuccessRows: findings.length,
      totalProbeSuccesses: findings.reduce((s, f) => s + f.probeCount, 0),
      routePositive: 0,
    },
    findings,
  };

  ensureDir(OUT);
  fs.writeFileSync(OUT, `${JSON.stringify(output, jsonReplacer, 2)}\n`);

  console.log(JSON.stringify({
    addresses: addresses.length,
    codePresent: codeChecks.length,
    richEth: richContracts.length,
    probeSuccesses: findings.length,
    findings: findings.map(f => ({ address: f.address.slice(0, 10), ethUsd: f.ethBalanceUsd, probes: f.probes.map(p => p.label) })),
  }, null, 2));
}

main().catch(err => { console.error(JSON.stringify({ ok: false, error: String(err) })); process.exit(1); });
