#!/usr/bin/env node
// Read-only static probe for top recent old-money contract candidates.
// Uses only eth_call, eth_getCode, balances, and proxy-slot reads. No signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("./node_modules/ethers");
const { resolveRpcPool, rpcCall, getImpl } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const INPUT = path.join(WORKSPACE, "reports", "raw", "fast", "recent-contracts-old-money.json");
const OUT_JSON = path.join(WORKSPACE, "reports", "raw", "fast", "recent-contracts-old-money-probes.json");
const OUT_MD = path.join(WORKSPACE, "reports", "recent-contracts-old-money-probes.md");
const QUIET = process.argv.includes("--quiet");
const LIMIT = Math.max(1, Number(argValue("--limit") || process.env.RECENT_OLD_MONEY_PROBE_LIMIT || "10") || 10);
const PROBE_FROM = "0x000000000000000000000000000000000000dEaD";
const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

const ABI = ethers.AbiCoder.defaultAbiCoder();
const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function transferFrom(address,address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
]);

const TARGET_PROBES = [
  { name: "withdraw()", signature: "withdraw()", args: () => [] },
  { name: "withdraw(uint256):1", signature: "withdraw(uint256)", args: () => [1n] },
  { name: "withdraw(uint256):balance", signature: "withdraw(uint256)", args: (ctx) => [ctx.balanceRaw || 1n] },
  { name: "withdraw(address,uint256)", signature: "withdraw(address,uint256)", args: (ctx) => [ctx.tokenAddress, 1n] },
  { name: "claim()", signature: "claim()", args: () => [] },
  { name: "claimRewards()", signature: "claimRewards()", args: () => [] },
  { name: "harvest()", signature: "harvest()", args: () => [] },
  { name: "rebalance()", signature: "rebalance()", args: () => [] },
  { name: "migrate()", signature: "migrate()", args: () => [] },
  { name: "sweep(address)", signature: "sweep(address)", args: (ctx) => [ctx.tokenAddress] },
  { name: "sweepToken(address)", signature: "sweepToken(address)", args: (ctx) => [ctx.tokenAddress] },
  { name: "execute(bytes)", signature: "execute(bytes)", args: () => ["0x"] },
  { name: "execute(address,uint256,bytes)", signature: "execute(address,uint256,bytes)", args: (ctx) => [ctx.tokenAddress, 0n, "0x"] },
  { name: "multicall(bytes[])", signature: "multicall(bytes[])", args: () => [[]] },
  { name: "transferFrom(address,address,uint256)", signature: "transferFrom(address,address,uint256)", args: (ctx) => [ctx.contract, PROBE_FROM, 1n] },
  { name: "approve(address,uint256)", signature: "approve(address,uint256)", args: () => [PROBE_FROM, 1n] },
];

const DECIMALS = { USDC: 6, WETH: 18, WBTC: 8, cbBTC: 8 };

function argValue(name) {
  const prefix = `${name}=`;
  const item = process.argv.find((arg) => arg.startsWith(prefix));
  if (item) return item.slice(prefix.length);
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : null;
}

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function readJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function normalizeAddress(value) {
  try {
    return ethers.getAddress(value);
  } catch (_) {
    return null;
  }
}

function parseAddressSlot(raw) {
  if (!raw || raw === "0x" || raw === `0x${"0".repeat(64)}`) return null;
  try {
    return ethers.getAddress(`0x${raw.slice(-40)}`);
  } catch (_) {
    return null;
  }
}

function decimalsFor(row) {
  return DECIMALS[row.token] ?? 18;
}

function formatUsd(raw, row) {
  try {
    const amount = Number(ethers.formatUnits(raw || 0n, decimalsFor(row)));
    const price = row.currentBalanceUsd && row.currentBalanceUsd > 0 && amount > 0
      ? row.currentBalanceUsd / amount
      : row.token === "USDC" ? 1 : row.token === "WETH" ? 1587 : 62700;
    return Math.round(amount * price * 100) / 100;
  } catch (_) {
    return null;
  }
}

async function rawCall(rpc, tx, timeoutMs = 8_000) {
  const result = await rpcCall(rpc, "eth_call", [tx, "latest"], timeoutMs);
  return result === null || result === undefined ? null : result;
}

async function callIface(rpc, txBase, iface, fn, args = []) {
  const data = iface.encodeFunctionData(fn, args);
  const raw = await rawCall(rpc, { ...txBase, data });
  if (raw === null) return { ok: false, raw: null, decoded: null };
  let decoded = null;
  try {
    decoded = iface.decodeFunctionResult(fn, raw);
  } catch (_) {
    decoded = null;
  }
  return { ok: true, raw, decoded };
}

function selectorFor(signature) {
  return ethers.id(signature).slice(2, 10).toLowerCase();
}

function codeHasSelector(code, signature) {
  const c = String(code || "").toLowerCase();
  return c.includes(selectorFor(signature));
}

function boolReturn(call) {
  if (!call.ok) return false;
  if (call.decoded && call.decoded.length > 0) return call.decoded[0] === true;
  return call.raw === "0x";
}

async function probeRow(row, rpc) {
  const contract = normalizeAddress(row.contract);
  const tokenAddress = normalizeAddress(row.tokenAddress);
  const code = contract ? await rpcCall(rpc, "eth_getCode", [contract, "latest"]) : null;
  const tokenCode = tokenAddress ? await rpcCall(rpc, "eth_getCode", [tokenAddress, "latest"]) : null;
  const nativeBalanceRaw = contract ? await rpcCall(rpc, "eth_getBalance", [contract, "latest"]) : null;
  const implementation = contract ? await getImpl(rpc, contract).catch(() => null) : null;
  const adminSlotRaw = contract ? await rpcCall(rpc, "eth_getStorageAt", [contract, EIP1967_ADMIN_SLOT, "latest"]) : null;
  const eip1967Admin = parseAddressSlot(adminSlotRaw);
  const implCode = implementation ? await rpcCall(rpc, "eth_getCode", [implementation, "latest"]) : null;

  let balanceRaw = 0n;
  let allowanceRaw = 0n;
  let tokenTransferFromOne = { ok: false, raw: null, decoded: null };
  let tokenTransferFromFull = { ok: false, raw: null, decoded: null };
  if (contract && tokenAddress && tokenCode && tokenCode !== "0x") {
    const bal = await callIface(rpc, { to: tokenAddress }, ERC20, "balanceOf", [contract]);
    if (bal.ok && bal.decoded?.[0] !== undefined) balanceRaw = BigInt(bal.decoded[0].toString());
    const allowance = await callIface(rpc, { to: tokenAddress }, ERC20, "allowance", [contract, PROBE_FROM]);
    if (allowance.ok && allowance.decoded?.[0] !== undefined) allowanceRaw = BigInt(allowance.decoded[0].toString());
    tokenTransferFromOne = await callIface(rpc, { from: PROBE_FROM, to: tokenAddress }, ERC20, "transferFrom", [contract, PROBE_FROM, 1n]);
    if (balanceRaw > 0n) {
      tokenTransferFromFull = await callIface(rpc, { from: PROBE_FROM, to: tokenAddress }, ERC20, "transferFrom", [contract, PROBE_FROM, balanceRaw]);
    }
  }

  const ctx = { ...row, contract, tokenAddress, balanceRaw };
  const targetProbeRows = [];
  for (const probe of TARGET_PROBES) {
    if (!contract || !codeHasSelector(code, probe.signature)) continue;
    const iface = new ethers.Interface([`function ${probe.signature}`]);
    let args = [];
    try {
      args = probe.args(ctx);
    } catch (_) {
      continue;
    }
    const call = await callIface(rpc, { from: PROBE_FROM, to: contract }, iface, probe.signature, args);
    targetProbeRows.push({
      probe: probe.name,
      selector: `0x${selectorFor(probe.signature)}`,
      staticCallOk: call.ok,
      rawResultBytes: call.raw ? Math.max(0, (call.raw.length - 2) / 2) : 0,
      blocker: call.ok
        ? "staticcall success is not a proven drain without token balance delta, caller entitlement, exact decoded semantics, and fork proof"
        : "staticcall reverted or selector path is not callable by arbitrary probe sender",
    });
  }

  const publicTokenDrainOne = boolReturn(tokenTransferFromOne);
  const publicTokenDrainFull = boolReturn(tokenTransferFromFull);
  const publicTokenDrain = publicTokenDrainOne || publicTokenDrainFull;
  const targetStaticSuccessRows = targetProbeRows.filter((r) => r.staticCallOk).length;
  const watchCandidate = publicTokenDrain;
  const liveBalanceUsd = formatUsd(balanceRaw, row);
  return {
    chain: row.chain,
    chainId: row.chainId,
    token: row.token,
    symbol: row.token,
    tokenAddress,
    contract,
    pair: `${row.token}@${contract ? contract.slice(0, 10) : "unknown"}`,
    currentBalanceUsd: row.currentBalanceUsd,
    liveBalanceUsd,
    liquidityUsd: liveBalanceUsd,
    liveBalanceRaw: balanceRaw.toString(),
    nativeBalanceRaw,
    codeBytes: code && code !== "0x" ? Math.max(0, (code.length - 2) / 2) : 0,
    implementation,
    implementationCodeBytes: implCode && implCode !== "0x" ? Math.max(0, (implCode.length - 2) / 2) : 0,
    eip1967Admin,
    owner: row.owner || null,
    ownerCodeBytes: row.ownerCodeBytes ?? null,
    selectorsFromSourceScan: row.selectors || [],
    targetStaticSuccessRows,
    targetProbeRows,
    tokenAllowanceToProbeRaw: allowanceRaw.toString(),
    tokenTransferFromOneStaticOk: publicTokenDrainOne,
    tokenTransferFromFullStaticOk: publicTokenDrainFull,
    publicTokenDrainProbeSuccess: publicTokenDrain,
    watchCandidate,
    routePositive: false,
    blocker: publicTokenDrain
      ? "token transferFrom probe succeeded and requires immediate fork/state-delta validation before any signed action"
      : targetStaticSuccessRows > 0
        ? "target selector staticcall success is ambiguous/no-op without proven token balance delta, entitlement bypass, exact decoded semantics, and fork proof"
        : "no arbitrary-sender token transferFrom or target selector staticcall produced a permissionless value-movement proof",
  };
}

function mdRow(row) {
  return `| ${row.chain} | ${row.token} | \`${row.contract}\` | $${Math.round(row.currentBalanceUsd || 0)} | ${row.targetStaticSuccessRows} | ${row.publicTokenDrainProbeSuccess ? "yes" : "no"} | ${row.blocker.replace(/\|/g, "/")} |`;
}

async function main() {
  const input = readJson(INPUT, {});
  const rows = (input.topRows || []).filter((row) => row && row.routePositive !== true).slice(0, LIMIT);
  const chainIds = [...new Set(rows.map((row) => row.chainId).filter(Boolean))];
  const rpcPool = await resolveRpcPool(chainIds);
  const probedRows = [];
  for (const row of rows) {
    const rpc = rpcPool[row.chainId];
    if (!rpc) {
      probedRows.push({ ...row, error: "no-rpc", routePositive: false, blocker: "No RPC endpoint resolved for read-only probe" });
      continue;
    }
    probedRows.push(await probeRow(row, rpc));
  }

  const publicTokenDrainProbeSuccessRows = probedRows.filter((row) => row.publicTokenDrainProbeSuccess).length;
  const targetStaticSuccessRows = probedRows.reduce((acc, row) => acc + (row.targetStaticSuccessRows || 0), 0);
  const maxLiveBalanceUsd = Math.max(0, ...probedRows.map((row) => Number(row.liveBalanceUsd) || 0));
  const watchCandidates = publicTokenDrainProbeSuccessRows;
  const routePositive = 0;
  const report = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/probe-recent-contracts-old-money.js",
    scope: "Read-only static probes over top recent old-money contract candidates",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
    },
    sourceArtifacts: ["reports/raw/fast/recent-contracts-old-money.json"],
    gates: {
      routePositiveRequires: [
        "arbitrary-sender static probe proves token balance movement or allowance bypass",
        "exact extractable token amount is positive and material",
        "fork/state-delta proof confirms controlled asset movement",
        "no role, owner, allowance, or caller-entitlement blocker",
      ],
      signedActionRequires: [
        "explicit authorization",
        "fresh fork/staticCall/estimateGas proof",
        "minProfit/minOut gates",
      ],
    },
    summary: {
      inputGeneratedAt: input.generatedAt || null,
      rowsConsidered: rows.length,
      rowsProbed: probedRows.length,
      uniqueContracts: new Set(probedRows.map((row) => `${row.chainId}:${String(row.contract).toLowerCase()}`)).size,
      targetStaticSuccessRows,
      publicTokenDrainProbeSuccessRows,
      maxLiveBalanceUsd,
      watchCandidates,
      routePositive,
      executableNow: 0,
      signedActionJustified: false,
      blocker: publicTokenDrainProbeSuccessRows > 0
        ? "A public token drain static probe succeeded; fork/state-delta proof is required before route-positive promotion."
        : "Top recent old-money rows had no arbitrary-sender token transferFrom success or proven balance-delta value movement.",
    },
    topRows: probedRows,
  };

  ensureDir(OUT_JSON);
  fs.writeFileSync(OUT_JSON, `${JSON.stringify(report, jsonReplacer, 2)}\n`);

  const md = [
    publicTokenDrainProbeSuccessRows > 0
      ? "# 🟢 DORMANT - Recent Contracts Old Money Static Probes"
      : "# ⚪ CLEAN - Recent Contracts Old Money Static Probes",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    publicTokenDrainProbeSuccessRows > 0
      ? "Signal: Static token-drain probe succeeded and requires fork/state-delta validation before any signed action."
      : "Signal: No confirmed permissionless value movement or route-positive economics was found in the top static probes.",
    "",
    "## Summary",
    "",
    `- Rows probed: \`${report.summary.rowsProbed}\``,
    `- Unique contracts: \`${report.summary.uniqueContracts}\``,
    `- Target static-call success rows: \`${report.summary.targetStaticSuccessRows}\``,
    `- Public token drain probe successes: \`${report.summary.publicTokenDrainProbeSuccessRows}\``,
    `- Watch candidates: \`${report.summary.watchCandidates}\``,
    `- Route-positive: \`0\``,
    "",
    "## Top Probed Rows",
    "",
    "| Chain | Token | Contract | Balance | Target static successes | Token drain static success | Blocker |",
    "|---|---|---|---:|---:|---|---|",
    ...probedRows.map(mdRow),
    "",
    "## Gate",
    "",
    report.summary.blocker,
  ].join("\n");
  fs.writeFileSync(OUT_MD, `${md}\n`);

  if (!QUIET) {
    console.log(`recent-old-money-probes rows=${report.summary.rowsProbed} targetStaticSuccessRows=${targetStaticSuccessRows} publicTokenDrainProbeSuccessRows=${publicTokenDrainProbeSuccessRows} routePositive=0`);
    console.log(`Artifact: ${path.relative(WORKSPACE, OUT_JSON)}`);
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exitCode = 1;
});
