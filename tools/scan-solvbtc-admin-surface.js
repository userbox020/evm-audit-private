#!/usr/bin/env node
// scan-solvbtc-admin-surface.js - derive SolvBTC wrapper/CCIP permissioned surface from Phase 0.
// Resolves RPC URLs in memory only. Never prints or stores RPC URLs, calldata, keys, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpcPool, rpcCall } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const IN = path.join(WORKSPACE, "reports", "raw", "fast", "solvbtc-phase0.json");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "solvbtc-admin-surface.json");
const REPORT = path.join(WORKSPACE, "reports", "solvbtc-admin-surface-triage.md");
const QUIET = process.argv.includes("--quiet");
const ZERO = "0x0000000000000000000000000000000000000000";

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; }
}

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function normalizeAddress(value) {
  try { return ethers.getAddress(String(value || "")); } catch (_) { return null; }
}

function isZero(value) {
  const addr = normalizeAddress(value);
  return !addr || addr === ZERO;
}

function asNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(String(value).replace(/[$,%`,\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 2) {
  const n = asNumber(value);
  if (n === null) return null;
  const p = 10 ** decimals;
  return Math.round(n * p) / p;
}

function formatUsd(value) {
  const n = asNumber(value);
  return n === null ? "n/a" : `$${Math.round(n).toLocaleString()}`;
}

function short(value) {
  const addr = normalizeAddress(value);
  return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : "n/a";
}

async function getCodeInfo(rpc, address) {
  const addr = normalizeAddress(address);
  if (!rpc || !addr || addr === ZERO) return { address: addr, codePresent: false, codeBytes: 0, type: "missing" };
  const code = await rpcCall(rpc, "eth_getCode", [addr, "latest"], 10_000).catch(() => null);
  const codeBytes = code && code !== "0x" ? Math.max(0, (code.length - 2) / 2) : 0;
  return { address: addr, codePresent: codeBytes > 0, codeBytes, type: codeBytes > 0 ? "contract" : "eoa" };
}

function surfaceRows(phase0) {
  const wrappers = (phase0.tokenRows || [])
    .filter((row) => row.tokenRole === "solvbtcWrapper")
    .map((row) => ({
      sourceType: "solvbtc-wrapper-token",
      chain: row.chain,
      chainId: row.chainId,
      configKey: row.configKey,
      address: normalizeAddress(row.address),
      symbol: row.symbol || "SolvBTC",
      source: row.source,
      codePresent: Boolean(row.codePresent),
      codeBytes: row.codeBytes || 0,
      totalSupplyUsd: row.totalSupplyUsd || 0,
      owner: normalizeAddress(row.owner),
      admin: normalizeAddress(row.admin),
      pendingOwner: normalizeAddress(row.pendingOwner),
      minter: normalizeAddress(row.minter),
      implementation: normalizeAddress(row.implementation),
      adminSlot: normalizeAddress(row.adminSlot),
      beaconSlot: normalizeAddress(row.beaconSlot),
      routePositive: false,
    }));
  const pools = (phase0.contractRows || [])
    .filter((row) => row.role === "ccip-token-pool")
    .map((row) => ({
      sourceType: "ccip-token-pool",
      chain: row.chain,
      chainId: row.chainId,
      configKey: row.configKey,
      address: normalizeAddress(row.address),
      symbol: row.symbol || "SolvBTC",
      source: row.source,
      codePresent: Boolean(row.codePresent),
      codeBytes: row.codeBytes || 0,
      totalSupplyUsd: null,
      owner: normalizeAddress(row.owner),
      admin: normalizeAddress(row.admin),
      pendingOwner: null,
      minter: null,
      implementation: normalizeAddress(row.implementation),
      adminSlot: normalizeAddress(row.adminSlot),
      beaconSlot: normalizeAddress(row.beaconSlot),
      routePositive: false,
    }));
  return [...wrappers, ...pools].filter((row) => row.address);
}

function references(row) {
  const refs = [];
  for (const role of ["owner", "admin", "pendingOwner", "minter", "adminSlot", "implementation", "beaconSlot"]) {
    const address = row[role];
    if (isZero(address)) continue;
    refs.push({ role, address: normalizeAddress(address) });
  }
  return refs;
}

function summarizeRows(rows, classifications) {
  return rows.map((row) => {
    const refs = references(row).map((ref) => {
      const info = classifications.get(`${row.chainId}:${ref.address.toLowerCase()}`) || { type: "unknown", codePresent: null, codeBytes: null };
      return { ...ref, ...info };
    });
    const eoaPrivileged = refs.filter((ref) => ["owner", "admin", "pendingOwner", "minter", "adminSlot"].includes(ref.role) && ref.type === "eoa");
    const contractPrivileged = refs.filter((ref) => ["owner", "admin", "pendingOwner", "minter", "adminSlot"].includes(ref.role) && ref.type === "contract");
    const upgradeRefs = refs.filter((ref) => ["implementation", "beaconSlot"].includes(ref.role));
    return {
      ...row,
      privilegedRefs: refs,
      eoaPrivilegedRows: eoaPrivileged.length,
      contractPrivilegedRows: contractPrivileged.length,
      upgradeReferenceRows: upgradeRefs.length,
      permissionedRisk: eoaPrivileged.length > 0 ? "eoa-privileged-control" : contractPrivileged.length > 0 ? "contract-privileged-control" : "no-live-privileged-address-resolved",
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
      blockers: [
        "Permissioned control is not a permissionless exploit route by itself",
        eoaPrivileged.length > 0 ? "EOA privileged address present; requires governance/operator compromise or misconfiguration, not public execution" : null,
        contractPrivileged.length > 0 ? "Contract privileged address present; threshold/timelock not verified in this bounded pass" : null,
        upgradeRefs.length > 0 ? "Proxy/beacon/implementation reference needs source-level upgrade authorization review" : null,
        "No public mint/unlock/accounting bypass or exact positive economics",
      ].filter(Boolean),
    };
  });
}

function aggregateAddresses(rows) {
  const byKey = new Map();
  for (const row of rows) {
    for (const ref of row.privilegedRefs || []) {
      const key = `${row.chainId}:${ref.address.toLowerCase()}`;
      const prev = byKey.get(key) || {
        chain: row.chain,
        chainId: row.chainId,
        address: ref.address,
        type: ref.type,
        codePresent: ref.codePresent,
        codeBytes: ref.codeBytes,
        roles: new Set(),
        surfaceTypes: new Set(),
        surfaceCount: 0,
        wrapperSupplyUsd: 0,
      };
      prev.roles.add(ref.role);
      prev.surfaceTypes.add(row.sourceType);
      prev.surfaceCount += 1;
      prev.wrapperSupplyUsd += asNumber(row.totalSupplyUsd) || 0;
      byKey.set(key, prev);
    }
  }
  return [...byKey.values()].map((row) => ({
    ...row,
    roles: [...row.roles].sort(),
    surfaceTypes: [...row.surfaceTypes].sort(),
    wrapperSupplyUsd: round(row.wrapperSupplyUsd, 2),
    routePositive: false,
  })).sort((a, b) => (b.wrapperSupplyUsd || 0) - (a.wrapperSupplyUsd || 0) || b.surfaceCount - a.surfaceCount);
}

function writeReport(artifact) {
  const s = artifact.summary;
  const lines = [];
  lines.push("# 🟢 DORMANT - SolvBTC Admin Surface Triage");
  lines.push("");
  lines.push(`Generated: ${artifact.generatedAt}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|---|---:|");
  lines.push(`| Surfaces reviewed | \`${s.surfaceRows}\` |`);
  lines.push(`| SolvBTC wrappers | \`${s.wrapperRows}\` |`);
  lines.push(`| CCIP token pools | \`${s.ccipPoolRows}\` |`);
  lines.push(`| Privileged references | \`${s.privilegedReferenceRows}\` |`);
  lines.push(`| EOA privileged refs | \`${s.eoaPrivilegedReferenceRows}\` |`);
  lines.push(`| Contract privileged refs | \`${s.contractPrivilegedReferenceRows}\` |`);
  lines.push(`| Wrapper supply under reviewed rows | \`${formatUsd(s.wrapperSupplyUsd)}\` |`);
  lines.push(`| Route positive | \`${s.routePositive}\` |`);
  lines.push("");
  lines.push("## Top Privileged Addresses");
  lines.push("");
  lines.push("| Chain | Address | Type | Roles | Surfaces | Wrapper supply |");
  lines.push("|---|---|---|---|---:|---:|");
  for (const row of artifact.privilegedAddresses.slice(0, 12)) {
    lines.push(`| ${row.chain} | \`${row.address}\` | ${row.type} | ${row.roles.join(", ")} | ${row.surfaceCount} | ${formatUsd(row.wrapperSupplyUsd)} |`);
  }
  lines.push("");
  lines.push("## Gate");
  lines.push("");
  lines.push("- Admin/owner/beacon control is permissioned risk context, not a permissionless exploit route by itself.");
  lines.push("- No public mint, unlock, arbitrary value movement, accounting bypass, accepted-value divergence, or exact positive economics is proven.");
  lines.push("- Fork/executor/signed-action gates remain closed until a public route-positive path exists.");
  lines.push("");
  lines.push("## Next Read-Only Step");
  lines.push("");
  lines.push("Decode the common owner/beacon contracts only if source or verified-bytecode review is needed for permissioned-risk disclosure; do not promote to fork work without a permissionless impact path.");
  lines.push("");
  fs.writeFileSync(REPORT, `${lines.join("\n")}\n`);
}

async function main() {
  const phase0 = readJson(IN, null);
  if (!phase0) throw new Error(`missing ${path.relative(WORKSPACE, IN)}`);
  const baseRows = surfaceRows(phase0);
  const chainIds = [...new Set(baseRows.map((row) => Number(row.chainId)).filter(Boolean))];
  const rpcPool = await resolveRpcPool(chainIds);
  const classifications = new Map();
  for (const row of baseRows) {
    const rpc = rpcPool[row.chainId];
    for (const ref of references(row)) {
      const key = `${row.chainId}:${ref.address.toLowerCase()}`;
      if (classifications.has(key)) continue;
      classifications.set(key, await getCodeInfo(rpc, ref.address));
    }
  }
  const rows = summarizeRows(baseRows, classifications);
  const privilegedAddresses = aggregateAddresses(rows);
  const eoaPrivilegedReferenceRows = rows.reduce((sum, row) => sum + (row.eoaPrivilegedRows || 0), 0);
  const contractPrivilegedReferenceRows = rows.reduce((sum, row) => sum + (row.contractPrivilegedRows || 0), 0);
  const summary = {
    sourceGeneratedAt: phase0.generatedAt,
    surfaceRows: rows.length,
    wrapperRows: rows.filter((row) => row.sourceType === "solvbtc-wrapper-token").length,
    ccipPoolRows: rows.filter((row) => row.sourceType === "ccip-token-pool").length,
    privilegedReferenceRows: rows.reduce((sum, row) => sum + row.privilegedRefs.length, 0),
    uniquePrivilegedAddresses: privilegedAddresses.length,
    eoaPrivilegedReferenceRows,
    contractPrivilegedReferenceRows,
    upgradeReferenceRows: rows.reduce((sum, row) => sum + (row.upgradeReferenceRows || 0), 0),
    eoaPrivilegedSurfaceRows: rows.filter((row) => row.eoaPrivilegedRows > 0).length,
    contractPrivilegedSurfaceRows: rows.filter((row) => row.contractPrivilegedRows > 0).length,
    wrapperSupplyUsd: round(rows.reduce((sum, row) => sum + (asNumber(row.totalSupplyUsd) || 0), 0), 2),
    exactEconomicsRows: 0,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    blocker: "Only permissioned owner/admin/beacon context was observed; no permissionless SolvBTC mint/unlock/accounting bypass or exact-positive route was proven.",
  };
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-solvbtc-admin-surface.js",
    scope: "Read-only SolvBTC wrapper and CCIP token-pool owner/admin/proxy surface classification",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
    },
    sourceArtifact: "reports/raw/fast/solvbtc-phase0.json",
    summary,
    rows,
    privilegedAddresses,
    requiredForRoutePositive: [
      "public SolvBTC or CCIP mint/unlock/accounting/proof path reachable by an unprivileged caller",
      "affected wrapper or pool has material trusted consumer liquidity or directly extractable custody",
      "exact positive economics after fees, slippage, caps, queues, finality, and gas",
      "fork/local proof before any live or signed action",
    ],
    nextReadOnlyStep: "Treat admin rows as permissioned-risk context; decode owner/beacon contracts only for disclosure context unless a public route-positive path appears.",
  };
  ensureDir(OUT);
  fs.writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`);
  writeReport(artifact);
  if (!QUIET) {
    console.log(`SolvBTC admin surface: rows=${summary.surfaceRows} eoaPrivilegedRefs=${summary.eoaPrivilegedReferenceRows} contractPrivilegedRefs=${summary.contractPrivilegedReferenceRows} routePositive=${summary.routePositive}`);
    console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
    console.log(`Report: ${path.relative(WORKSPACE, REPORT).replace(/\\/g, "/")}`);
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
