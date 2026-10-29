#!/usr/bin/env node
// Avalon USDa deep probe — read-only oracle, storage, role, and selector checks.

const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
const { resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "avalon-usda-deep-probe.json");
const CHAIN_ID = 1;
const QUIET = process.argv.includes("--quiet");

const POOL = "0x3f390dD6EF69f68f9877aACC086856a200808693";
const IMPLEMENTATION = "0x10d162bb7fa363201b0c749cd96322082f733a97";
const USD_A = "0x0b4D6DA52dF60D44Ce7140F1044F2aD5fabd6316";
const LFBTC = "0x3119a1AD5B63A000aB9CA3F2470611eB997B93B9";
const MINTER_SAFE = "0x5A79311083dC82aBc2DE1E5639673C876cc6757e";
const PROBE_FROM = "0x000000000000000000000000000000000000dEaD";

const STORAGE_SLOTS = {
  eip1967Implementation: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  eip1967Admin: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  slot0: "0x0",
  slot1: "0x1",
  slot2: "0x2",
  slot3: "0x3",
  slot4: "0x4",
  slot5: "0x5",
  slot6: "0x6",
  slot7: "0x7",
};

const ORACLE_CANDIDATES = [
  { name: "RedStone FBTC/USD live", address: "0x74E95F3Ec71372756a01eB9317864e3fdde1AC53" },
  { name: "RedStone BTC prior candidate", address: "0xa4dbd10397fecb0fe82e2a38e8c4a6290f4de240" },
  { name: "Chainlink BTC", address: "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c" },
  { name: "Chainlink ETH", address: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419" },
];

const SELECTOR_PROBES = [
  { selector: "0xc5ebeaec", sig: "borrow(uint256)", args: ["uint256"] },
  { selector: "0x35403023", sig: "supply(uint256)", args: ["uint256"] },
  { selector: "0x2e1a7d4d", sig: "withdraw(uint256)", args: ["uint256"] },
  { selector: "0x371fd8e6", sig: "repay(uint256)", args: ["uint256"] },
  { selector: "0x2f865568", sig: "liquidate(address)", args: ["address"] },
  { selector: "0xfc7b9c18", sig: "totalDebt()", args: [] },
  { selector: "0x053c212b", sig: "totalCollateral()", args: [] },
  { selector: "0x5c975abb", sig: "paused()", args: [] },
];

const ERC20_ABI = [
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
];

const SAFE_ABI = [
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
];

const FEED_ABI = [
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  "function latestAnswer() view returns (int256)",
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
];

function shortError(err) {
  return err?.reason || err?.shortMessage || err?.message?.slice(0, 140) || "unknown";
}

function slotAddress(value) {
  if (!value || value === "0x" || BigInt(value) === 0n) return null;
  return `0x${String(value).replace(/^0x/i, "").slice(-40)}`;
}

function padAddress(address) {
  return String(address).replace(/^0x/i, "").toLowerCase().padStart(64, "0");
}

function dummyArgs(types) {
  return types.map((type) => {
    if (type === "uint256") return "0000000000000000000000000000000000000000000000000de0b6b3a7640000";
    if (type === "address") return padAddress(PROBE_FROM);
    return "";
  }).join("");
}

function decodeProbe(sig, raw) {
  if (!raw || raw === "0x") return null;
  try {
    if (sig === "totalDebt()" || sig === "totalCollateral()") return ethers.formatUnits(BigInt(raw), 18);
    if (sig === "paused()") return Boolean(BigInt(raw));
    return raw;
  } catch (_) {
    return raw;
  }
}

async function safeCall(fn, fallback = null) {
  try {
    return await fn();
  } catch (_) {
    return fallback;
  }
}

async function probeFeed(provider, candidate, blockTimestamp) {
  const feed = new ethers.Contract(candidate.address, FEED_ABI, provider);
  const row = { ...candidate };
  try {
    const [round, decimals, description] = await Promise.all([
      feed.latestRoundData(),
      feed.decimals().catch(() => 8n),
      feed.description().catch(() => null),
    ]);
    const price = Number(ethers.formatUnits(round[1], Number(decimals)));
    const updatedAt = Number(round[3]);
    return {
      ...row,
      ok: true,
      description,
      decimals: Number(decimals),
      answer: round[1].toString(),
      price,
      updatedAt,
      ageSeconds: blockTimestamp ? Math.max(0, blockTimestamp - updatedAt) : null,
    };
  } catch (err) {
    const latestAnswer = await safeCall(() => feed.latestAnswer(), null);
    return {
      ...row,
      ok: false,
      latestAnswer: latestAnswer?.toString?.() || null,
      error: shortError(err),
    };
  }
}

async function probe() {
  const rpc = await resolveRpc(CHAIN_ID);
  if (!rpc) throw new Error("No Ethereum RPC resolved");

  const provider = new ethers.JsonRpcProvider(rpc, CHAIN_ID, { staticNetwork: true });
  const block = await provider.getBlock("latest");

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-avalon-usda-deep.js",
    scope: "Read-only Avalon USDa deep probe — storage, oracle, role, and selector checks",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      stateChangingCalls: false,
      simulationsViaEthCallOnly: true,
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
    },
    chain: { id: CHAIN_ID, name: "Ethereum", blockNumber: block.number, timestamp: block.timestamp },
    contracts: { pool: POOL, implementation: IMPLEMENTATION, usda: USD_A, lfbtc: LFBTC, minterSafe: MINTER_SAFE },
    storageSlots: {},
    oracleCandidates: [],
    tokenState: {},
    minterSafe: null,
    selectorProbes: [],
    implementationOracleScan: null,
    summary: {
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      status: "deep-read-only-probe-no-route-positive",
      blocker: "No permissionless exact-positive borrow/redeem/liquidation route or fork value-delta proof is produced by this probe.",
    },
    requiredForRoutePositive: [
      "verified source or decompiled semantics for oracle/risk/liquidation path",
      "permissionless money-path selector with non-reverting semantics for an attacker-controlled account",
      "exact economics positive after gas/slippage/fees",
      "local fork value-delta proof",
    ],
    nextReadOnlyStep: "Use the ABI classification and selector probes to focus decompilation on oracle/risk/liquidation access controls; keep gates closed until exact-positive economics exist.",
  };

  if (!QUIET) console.log("=== Storage Slots ===");
  for (const [name, slot] of Object.entries(STORAGE_SLOTS)) {
    const value = await provider.send("eth_getStorageAt", [POOL, slot, "latest"]);
    const address = slotAddress(value);
    artifact.storageSlots[name] = { slot, value, address };
    if (!QUIET) console.log(`  ${name}: ${address || value}`);
  }

  if (!QUIET) console.log("\n=== Oracle Candidates ===");
  for (const candidate of ORACLE_CANDIDATES) {
    const row = await probeFeed(provider, candidate, block.timestamp);
    artifact.oracleCandidates.push(row);
    if (!QUIET) console.log(`  ${candidate.name}: ${row.ok ? `${row.description || "?"} price=${row.price}` : `REVERT ${row.error}`}`);
  }

  if (!QUIET) console.log("\n=== Token State ===");
  for (const [label, address, decimalsHint] of [["LFBTC", LFBTC, 8], ["USDa", USD_A, 18]]) {
    const token = new ethers.Contract(address, ERC20_ABI, provider);
    const [symbol, name, decimals, totalSupply, poolBalance] = await Promise.all([
      safeCall(() => token.symbol()),
      safeCall(() => token.name()),
      safeCall(() => token.decimals(), BigInt(decimalsHint)),
      safeCall(() => token.totalSupply()),
      safeCall(() => token.balanceOf(POOL)),
    ]);
    const d = Number(decimals ?? decimalsHint);
    artifact.tokenState[label] = {
      address,
      symbol,
      name,
      decimals: d,
      totalSupplyRaw: totalSupply?.toString?.() || null,
      totalSupply: totalSupply === null ? null : ethers.formatUnits(totalSupply, d),
      poolBalanceRaw: poolBalance?.toString?.() || null,
      poolBalance: poolBalance === null ? null : ethers.formatUnits(poolBalance, d),
    };
    if (!QUIET) console.log(`  ${label}: supply=${artifact.tokenState[label].totalSupply} poolBal=${artifact.tokenState[label].poolBalance}`);
  }

  if (!QUIET) console.log("\n=== Minter Safe ===");
  try {
    const safe = new ethers.Contract(MINTER_SAFE, SAFE_ABI, provider);
    const [owners, threshold] = await Promise.all([safe.getOwners(), safe.getThreshold()]);
    artifact.minterSafe = { ok: true, owners: owners.length, threshold: threshold.toString() };
    if (!QUIET) console.log(`  Owners: ${owners.length}, Threshold: ${threshold}`);
  } catch (err) {
    artifact.minterSafe = { ok: false, error: shortError(err) };
    if (!QUIET) console.log(`  Safe probe failed: ${artifact.minterSafe.error}`);
  }

  if (!QUIET) console.log("\n=== Selector Probe (eth_call only) ===");
  for (const probeDef of SELECTOR_PROBES) {
    const data = `${probeDef.selector}${dummyArgs(probeDef.args)}`;
    const row = { selector: probeDef.selector, signature: probeDef.sig, probeFrom: PROBE_FROM };
    try {
      const raw = await provider.send("eth_call", [{ from: PROBE_FROM, to: POOL, data }, "latest"]);
      Object.assign(row, { ok: true, raw, decoded: decodeProbe(probeDef.sig, raw) });
      if (!QUIET) console.log(`  ${probeDef.sig.padEnd(25)} OK ${row.decoded ?? raw}`);
    } catch (err) {
      Object.assign(row, { ok: false, error: shortError(err) });
      if (!QUIET) console.log(`  ${probeDef.sig.padEnd(25)} REVERT ${row.error}`);
    }
    artifact.selectorProbes.push(row);
  }

  if (!QUIET) console.log("\n=== Oracle in Implementation Bytecode ===");
  const implCode = await provider.getCode(IMPLEMENTATION);
  const oracleBytecodeMatches = ORACLE_CANDIDATES.map((candidate) => {
    const foundInImplementation = implCode.toLowerCase().includes(candidate.address.slice(2).toLowerCase());
    if (!QUIET) console.log(`  ${candidate.name} (${candidate.address.slice(0, 10)}): ${foundInImplementation ? "FOUND" : "not found"}`);
    return { ...candidate, foundInImplementation };
  });
  artifact.implementationOracleScan = {
    implementationCodeBytes: implCode && implCode !== "0x" ? (implCode.length - 2) / 2 : 0,
    oracleBytecodeMatches,
  };

  const selectorOk = artifact.selectorProbes.filter((row) => row.ok).length;
  const selectorReverts = artifact.selectorProbes.length - selectorOk;
  artifact.summary = {
    ...artifact.summary,
    storageSlotsScanned: Object.keys(artifact.storageSlots).length,
    oracleCandidatesProbed: artifact.oracleCandidates.length,
    oracleCandidatesOk: artifact.oracleCandidates.filter((row) => row.ok).length,
    selectorsProbed: artifact.selectorProbes.length,
    selectorOk,
    selectorReverts,
    implementationOracleMatches: oracleBytecodeMatches.filter((row) => row.foundInImplementation).length,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT)}`);
  console.log(`Avalon deep probe: selectors=${artifact.summary.selectorsProbed} ok=${selectorOk} reverts=${selectorReverts} routePositive=0`);
}

probe().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
