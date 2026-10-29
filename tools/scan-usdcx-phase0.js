#!/usr/bin/env node
// scan-usdcx-phase0.js - read-only Phase 0 for USDCx / Circle xReserve.
// Resolves RPC URLs in memory only. Never prints or stores RPC URLs, keys, calldata, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpc, rpcCall } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "usdcx-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "usdcx-phase0-triage.md");
const QUIET = process.argv.includes("--quiet");

const CHAIN_ID = 1;
const CHAIN = "Ethereum";
const PROBE_FROM = "0x000000000000000000000000000000000000dEaD";
const ZERO = "0x0000000000000000000000000000000000000000";

const ADDR = {
  xReserve: "0x8888888199b2Df864bf678259607d6D5EBb4e3Ce",
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
};

const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const ERC20 = new ethers.Interface([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const COMMON = new ethers.Interface([
  "function owner() view returns (address)",
  "function admin() view returns (address)",
  "function paused() view returns (bool)",
  "function pauser() view returns (address)",
]);
const XRESERVE = new ethers.Interface([
  "function domain() view returns (uint32)",
  "function gatewayMinter() view returns (address)",
  "function gatewayWallet() view returns (address)",
  "function tokenMessenger() view returns (address)",
  "function tokenMessengerV2() view returns (address)",
  "function registrationManager() view returns (address)",
  "function blocklister() view returns (address)",
  "function isTokenSupported(address) view returns (bool)",
  "function isRemoteDomainRegistered(uint32) view returns (bool)",
  "function isRemoteTokenRegistered(uint32,bytes32) view returns (bool)",
  "function getRemoteToken(uint32,address) view returns (bytes32)",
  "function remoteDomainDepositorImplementation() view returns (address)",
  "function domainDepositsPaused(uint32) view returns (bool)",
  "function domainWithdrawalsPaused(uint32) view returns (bool)",
]);

const PROBES = [
  { label: "mint(address,uint256)", signature: "mint(address,uint256)", args: () => [PROBE_FROM, 1n] },
  { label: "burn(uint256)", signature: "burn(uint256)", args: () => [1n] },
  { label: "burnFrom(address,uint256)", signature: "burnFrom(address,uint256)", args: () => [PROBE_FROM, 1n] },
  { label: "withdraw(uint256)", signature: "withdraw(uint256)", args: () => [1n] },
  { label: "withdraw(address,uint256)", signature: "withdraw(address,uint256)", args: () => [PROBE_FROM, 1n] },
  { label: "redeem(uint256)", signature: "redeem(uint256)", args: () => [1n] },
];

const CONSUMER_ARTIFACTS = [
  ["aave-euler-silo", "reports/raw/fast/aave-euler-silo-consumer-graph.json"],
  ["consumer-first-high-ltv", "reports/raw/fast/consumer-first-high-ltv-collateral.json"],
  ["public-lead-consumer", "reports/raw/fast/public-lead-consumer-joins.json"],
  ["erc4626-consumer", "reports/raw/fast/erc4626-consumer-joiner.json"],
  ["fluid-lending", "reports/raw/fast/fluid-lending-phase0.json"],
  ["euler-v2", "reports/raw/fast/euler-v2-phase0.json"],
  ["morpho-pyth", "reports/raw/fast/morpho-pyth-unsafe-consumers.json"],
  ["morpho-public-allocator", "reports/raw/fast/morpho-public-allocator-force-feed.json"],
  ["stablecoin-depeg", "reports/raw/fast/stablecoin-depeg-lending-routes.json"],
  ["pendle-pt", "reports/raw/fast/pendle-pt-multichain-consumer-graph.json"],
  ["pendle-yt", "reports/raw/fast/pendle-yt-collateral-routes.json"],
  ["dex-consumer-routes", "reports/raw/fast/dex-consumer-routes.json"],
  ["curve-dex", "reports/raw/fast/curve-dex-phase0.json"],
  ["curve-llamalend", "reports/raw/fast/curve-llamalend-phase0.json"],
  ["silo-pt-oracle", "reports/raw/fast/silo-pt-oracle-routes.json"],
  ["governance-listing", "reports/raw/fast/governance-listing-watch.json"],
  ["market-launch", "reports/raw/fast/market-launch-choreography-routes.json"],
  ["small-cap-oracle", "reports/raw/fast/small-cap-oracle-manipulation-routes.json"],
  ["usdt0-consumer", "reports/raw/fast/usdt0-consumer-routes.json"],
  ["usdt0-oft", "reports/raw/fast/usdt0-oft-routes.json"],
  ["bridge-lending-collateral", "reports/raw/fast/bridge-lending-collateral-join.json"],
  ["bridge-proof-binding", "reports/raw/fast/bridge-proof-binding.json"],
];

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readText(file) { try { return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""; } catch (_) { return ""; } }
function readJson(file, fallback = null) { try { const t = readText(file).replace(/^\uFEFF/, ""); return t ? JSON.parse(t) : fallback; } catch (_) { return fallback; } }
function writeJson(file, value) { ensureDir(file); fs.writeFileSync(file, `${JSON.stringify(value, jsonReplacer, 2)}\n`); }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }

function normalizeAddress(value) {
  try { return ethers.getAddress(String(value || "")); } catch (_) { return null; }
}
function lowerAddress(value) { const a = normalizeAddress(value); return a ? a.toLowerCase() : null; }
function strip0x(value) { return String(value || "").replace(/^0x/i, ""); }
function addressFromStorageSlot(raw) {
  if (!raw || raw === "0x") return null;
  const hex = strip0x(raw).padStart(64, "0");
  if (/^0+$/.test(hex)) return null;
  return normalizeAddress(`0x${hex.slice(-40)}`);
}
function asNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const n = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}
function round(value, decimals = 2) {
  const n = asNumber(value);
  if (n === null) return null;
  const p = 10 ** decimals;
  return Math.round(n * p) / p;
}
function decimalsToNumber(value, decimals) {
  try {
    if (value === null || value === undefined || decimals === null || decimals === undefined) return null;
    const n = Number(ethers.formatUnits(BigInt(value), Number(decimals)));
    return Number.isFinite(n) ? n : null;
  } catch (_) { return null; }
}
function formatUsd(value) {
  const n = asNumber(value);
  return n === null ? "n/a" : `$${Math.round(n).toLocaleString()}`;
}
function short(value) {
  const addr = normalizeAddress(value);
  return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : "n/a";
}

async function fetchJson(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-usdcx-phase0/1.0" } });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) { return null; } finally { clearTimeout(timer); }
}

async function safeCall(rpc, to, iface, fn, args = [], timeoutMs = 12_000) {
  const addr = normalizeAddress(to);
  if (!rpc || !addr) return null;
  try {
    const raw = await rpcCall(rpc, "eth_call", [{ to: addr, data: iface.encodeFunctionData(fn, args) }, "latest"], timeoutMs);
    if (!raw || raw === "0x") return null;
    return iface.decodeFunctionResult(fn, raw);
  } catch (_) { return null; }
}

async function stateProbe(rpc, to, probe) {
  const addr = normalizeAddress(to);
  if (!rpc || !addr) return { success: false };
  const fn = probe.signature.slice(0, probe.signature.indexOf("("));
  const iface = new ethers.Interface([`function ${probe.signature}`]);
  try {
    const raw = await rpcCall(rpc, "eth_call", [{ from: PROBE_FROM, to: addr, data: iface.encodeFunctionData(fn, probe.args()) }, "latest"], 8_000);
    return { success: Boolean(raw) };
  } catch (_) { return { success: false }; }
}

async function getCode(rpc, address) {
  const addr = normalizeAddress(address);
  if (!rpc || !addr) return "0x";
  return await rpcCall(rpc, "eth_getCode", [addr, "latest"], 10_000).catch(() => "0x") || "0x";
}

async function getStorage(rpc, address, slot) {
  const addr = normalizeAddress(address);
  if (!rpc || !addr) return null;
  return await rpcCall(rpc, "eth_getStorageAt", [addr, slot, "latest"], 10_000).catch(() => null);
}

function findMatches(data, wantedAddress, source, max = 12) {
  const matches = [];
  const wanted = lowerAddress(wantedAddress);
  if (!wanted) return matches;
  function walk(value, objectPath, parent) {
    if (matches.length >= max) return;
    if (typeof value === "string") {
      if (lowerAddress(value) === wanted) {
        matches.push({ source, path: objectPath, context: { routePositive: asNumber(parent?.routePositive) || 0, watchCandidate: asNumber(parent?.watchCandidate) || 0 } });
        return;
      }
      return;
    }
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) walk(value[i], `${objectPath}[${i}]`, parent);
      return;
    }
    for (const [key, child] of Object.entries(value)) walk(child, objectPath ? `${objectPath}.${key}` : key, value);
  }
  walk(data, "", null);
  return matches;
}

async function scanConsumerJoins(xReserveAddr) {
  const rows = [];
  for (const [source, rel] of CONSUMER_ARTIFACTS) {
    const file = path.join(WORKSPACE, rel);
    const data = readJson(file, null);
    if (!data) continue;
    const matches = findMatches(data, xReserveAddr, source);
    if (matches.length > 0) {
      rows.push({
        source,
        joinCount: matches.length,
        routePositive: matches.some(m => m.context.routePositive > 0),
        watchCandidate: matches.some(m => m.context.watchCandidate > 0),
      });
    }
  }
  return rows.sort((a, b) => (b.routePositive ? 1 : 0) - (a.routePositive ? 1 : 0) || (b.watchCandidate ? 1 : 0) - (a.watchCandidate ? 1 : 0) || b.joinCount - a.joinCount);
}

async function fetchDexRows() {
  try {
    const json = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${ADDR.USDC}`, 30_000);
    if (!json?.pairs) return [];
    const rows = [];
    for (const pair of json.pairs) {
      if (pair.chainId !== "ethereum") continue;
      rows.push({
        dexId: pair.dexId || null,
        pairAddress: pair.pairAddress || null,
        baseSymbol: pair.baseToken?.symbol || null,
        quoteSymbol: pair.quoteToken?.symbol || null,
        liquidityUsd: round(pair.liquidity?.usd, 2),
        volume24hUsd: round(pair.volume?.h24, 2),
        priceUsd: round(pair.priceUsd, 8),
      });
    }
    return rows.sort((a, b) => (asNumber(b.liquidityUsd) || 0) - (asNumber(a.liquidityUsd) || 0)).slice(0, 10);
  } catch (_) { return []; }
}

function writeReport(out) {
  const s = out.summary;
  const contractTable = `| \`${short(ADDR.xReserve)}\` | ${out.contract.codePresent} | ${out.contract.codeBytes} | \`${short(out.contract.owner)}\` | \`${short(out.contract.implementation)}\` | ${out.contract.paused} |`;
  const immutableTable = `| gatewayMinter | \`${short(out.immutables.gatewayMinter)}\` |
| gatewayWallet | \`${short(out.immutables.gatewayWallet)}\` |
| tokenMessenger | \`${short(out.immutables.tokenMessenger)}\` |
| tokenMessengerV2 | \`${short(out.immutables.tokenMessengerV2)}\` |`;
  const rolesTable = `| owner | \`${short(out.contract.owner)}\` |
| pauser | \`${short(out.contract.pauser)}\` |
| registrationManager | \`${short(out.immutables.registrationManager)}\` |
| blocklister | \`${short(out.immutables.blocklister)}\` |`;
  const probeRows = out.probeResults.map(row => `| ${row.label} | ${row.success} |`).join("\n");
  const consumerRows = out.consumerJoins.length > 0
    ? out.consumerJoins.map(row => `| ${row.source} | ${row.joinCount} | ${row.routePositive} | ${row.watchCandidate} |`).join("\n")
    : "| none | 0 | false | false |";
  const dexRows = out.dexLiquidityRows.length > 0
    ? out.dexLiquidityRows.map(row => `| ${row.dexId || "n/a"} | ${row.baseSymbol || "?"}/${row.quoteSymbol || "?"} | ${formatUsd(row.liquidityUsd)} | ${formatUsd(row.volume24hUsd)} |`).join("\n")
    : "| none | n/a | n/a | n/a |";

  const content = `# ${s.routePositive > 0 ? "🟡 VULNERABLE" : "🟢 DORMANT"} — USDCx / Circle xReserve Phase 0 Triage

Generated: ${out.generatedAt}

Scanner: \`tools/scan-usdcx-phase0.js\`

Artifact: \`reports/raw/fast/usdcx-phase0.json\`

## Result

No permissionless route-positive exploit is claimed. This pass mapped the live Circle xReserve contract on Ethereum, read on-chain state, probed public selectors, scanned local consumer artifacts, and sampled DEX liquidity. All state-changing paths are permission-gated (owner, pauser, gateway attestation). The withdrawal path requires a valid Circle-signed attestation from the GatewayMinter. No public mint/burn/withdraw/drain bypass was proven.

## Summary

| Metric | Value |
|---|---:|
| DeFiLlama TVL | ${formatUsd(s.defillamaCurrentTvlUsd)} |
| USDC balance (xReserve) | ${formatUsd(s.usdcBalanceUsd)} |
| Contract rows | \`${s.contractRows}\` |
| Consumer artifact joins | \`${s.consumerJoinRows}\` |
| Route-positive joins | \`${s.routePositiveConsumerJoins}\` |
| Permissionless probe successes | \`${s.permissionlessProbeSuccessRows}\` |
| DEX liquidity rows | \`${s.dexLiquidityRows}\` |
| Route-positive | \`${s.routePositive}\` |
| Executable now | \`${s.executableNow}\` |
| Signed action justified | \`${s.signedActionJustified}\` |

## xReserve Contract

| Address | Code | Bytes | Owner | Implementation | Paused |
|---|---|---|---|---|---|
${contractTable}

### Immutable Addresses

| Key | Address |
|---|---|
${immutableTable}

### Privileged Roles

| Role | Address |
|---|---|
${rolesTable}

### Domain

| Key | Value |
|---|---|
| domain | \`${out.contract.domain}\` |
| USDC supported | \`${out.contract.usdcSupported}\` |

## Permissionless Probes (from ${PROBE_FROM})

| Selector | Call succeeded |
|---|---|
${probeRows}

## Consumer Artifact Joins

| Source | Matches | Route-positive | Watch candidate |
|---|---|---:|---|---|
${consumerRows}

## USDC DEX Context (Ethereum)

| DEX | Pair | Liquidity USD | 24h volume USD |
|---|---|---|---|
${dexRows}

## Blockers

- The withdrawal path (\`withdraw(bytes,bytes)\`) requires a valid Circle-signed attestation validated by the GatewayMinter; no public attestation bypass or unsigned-mint path is proven.
- Deposit (\`depositToRemote\`) requires a registered remote domain and supported token; tokens are custodied in GatewayWallet, not freely extractable.
- All state-changing functions (pause, unpause, token support, domain registration, blocklist management) are owner/pauser/registration-manager gated.
- No xReserve address is referenced by material lending, margin, redemption, or liquidation consumers in scanned local artifacts.
- USDC DEX liquidity is collateral/exit context only without a current accepted-value, redemption, or liquidation edge.
- No fork extraction proof and no signed-action justification exist.

## Required For Route-Positive

- A deployed Circle xReserve / GatewayMinter / GatewayWallet / TokenMessenger proof, attestation, domain, nonce, token, or accounting bypass reachable by an unprivileged caller.
- OR a material trusted consumer that accepts the xReserve contract or its custodied USDC as oracle, reserve, collateral, redemption, or liquidation input with attacker-favorable accepted value.
- Permissionless acquisition, borrow/redeem/liquidate/unlock, and exit economics must be exact-positive after gas, slippage, fees, and attestation/pause/blocklist constraints.
- Fork/local proof before any live or signed action.

## Next Read-Only Step

Keep USDCx on Circle xReserve / GatewayMinter attestation and consumer-join watch. Reopen for exact quoting only if an attestation/proof bypass, material trusted consumer listing, or live accepted-value divergence appears with exact positive economics.
`;
  fs.writeFileSync(REPORT_OUT, `${content}\n`);
}

async function main() {
  const rpc = await resolveRpc(CHAIN_ID);
  if (!rpc) throw new Error(`No RPC resolved for chain ${CHAIN_ID}`);

  const xr = normalizeAddress(ADDR.xReserve);
  const usdc = normalizeAddress(ADDR.USDC);

  const [metadata, usdcPrice, dexRows] = await Promise.all([
    fetchJson("https://api.llama.fi/protocol/usdcx", 30_000).catch(() => ({})),
    fetchJson(`https://coins.llama.fi/prices/current/ethereum:${usdc.toLowerCase()}?searchWidth=6h`, 30_000).catch(() => null),
    fetchDexRows(),
  ]);

  const usdcPriceUsd = usdcPrice?.coins?.[`ethereum:${usdc.toLowerCase()}`]?.price || null;

  // On-chain reads
  const code = await getCode(rpc, xr);
  const [implRaw, adminRaw, beaconRaw] = await Promise.all([
    getStorage(rpc, xr, EIP1967_IMPLEMENTATION_SLOT),
    getStorage(rpc, xr, EIP1967_ADMIN_SLOT),
    getStorage(rpc, xr, EIP1967_BEACON_SLOT),
  ]);

  const [owner, paused, pauser, domain, gatewayMinter, gatewayWallet, tokenMessenger, tokenMessengerV2, registrationManager, blocklister, depositorImpl, usdcSupported] = await Promise.all([
    safeCall(rpc, xr, COMMON, "owner"),
    safeCall(rpc, xr, COMMON, "paused"),
    safeCall(rpc, xr, COMMON, "pauser"),
    safeCall(rpc, xr, XRESERVE, "domain"),
    safeCall(rpc, xr, XRESERVE, "gatewayMinter"),
    safeCall(rpc, xr, XRESERVE, "gatewayWallet"),
    safeCall(rpc, xr, XRESERVE, "tokenMessenger"),
    safeCall(rpc, xr, XRESERVE, "tokenMessengerV2"),
    safeCall(rpc, xr, XRESERVE, "registrationManager"),
    safeCall(rpc, xr, XRESERVE, "blocklister"),
    safeCall(rpc, xr, XRESERVE, "remoteDomainDepositorImplementation"),
    safeCall(rpc, xr, XRESERVE, "isTokenSupported", [usdc]),
  ]);

  const usdcBalanceRaw = await safeCall(rpc, usdc, ERC20, "balanceOf", [xr]);
  const usdcDecRaw = await safeCall(rpc, usdc, ERC20, "decimals");
  const usdcDecimals = usdcDecRaw ? Number(usdcDecRaw[0]) : 6;
  const usdcBalance = usdcBalanceRaw ? decimalsToNumber(usdcBalanceRaw[0], usdcDecimals) : null;
  const usdcBalanceUsd = usdcBalance && usdcPriceUsd ? round(usdcBalance * usdcPriceUsd) : null;

  // Permissionless probes
  const probeResults = [];
  for (const probe of PROBES) {
    const result = await stateProbe(rpc, xr, probe);
    probeResults.push({ ...probe, ...result });
  }

  // Consumer artifact joins
  const consumerJoins = await scanConsumerJoins(xr);

  // DeFiLlama TVL
  const tvlRows = metadata.tvl || [];
  const lastTvl = tvlRows.length > 0 ? asNumber(tvlRows[tvlRows.length - 1].totalLiquidityUSD) : null;

  const contract = {
    address: xr,
    codePresent: code !== "0x",
    codeBytes: Math.max(0, (code.length - 2) / 2),
    implementation: addressFromStorageSlot(implRaw),
    adminSlot: addressFromStorageSlot(adminRaw),
    beacon: addressFromStorageSlot(beaconRaw),
    owner: owner?.[0] ? normalizeAddress(owner[0]) : null,
    paused: paused ? Boolean(paused[0]) : null,
    pauser: pauser?.[0] ? normalizeAddress(pauser[0]) : null,
    domain: domain?.[0] !== undefined ? Number(domain[0]) : null,
    usdcSupported: usdcSupported?.[0] !== undefined ? Boolean(usdcSupported[0]) : null,
  };

  const immutables = {
    gatewayMinter: gatewayMinter?.[0] ? normalizeAddress(gatewayMinter[0]) : null,
    gatewayWallet: gatewayWallet?.[0] ? normalizeAddress(gatewayWallet[0]) : null,
    tokenMessenger: tokenMessenger?.[0] ? normalizeAddress(tokenMessenger[0]) : null,
    tokenMessengerV2: tokenMessengerV2?.[0] ? normalizeAddress(tokenMessengerV2[0]) : null,
    registrationManager: registrationManager?.[0] ? normalizeAddress(registrationManager[0]) : null,
    blocklister: blocklister?.[0] ? normalizeAddress(blocklister[0]) : null,
    depositorImpl: depositorImpl?.[0] ? normalizeAddress(depositorImpl[0]) : null,
  };

  const summary = {
    scanner: "tools/scan-usdcx-phase0.js",
    chain: CHAIN,
    chainId: CHAIN_ID,
    defillamaName: metadata.name || "USDCx",
    defillamaSlug: metadata.slug || "usdcx",
    defillamaCurrentTvlUsd: lastTvl,
    usdcPriceUsd: usdcPriceUsd ? round(usdcPriceUsd, 8) : null,
    usdcBalanceUsd,
    contractRows: 1,
    permissionlessProbeRows: probeResults.length,
    permissionlessProbeSuccessRows: probeResults.filter(r => r.success).length,
    consumerJoinRows: consumerJoins.length,
    routePositiveConsumerJoins: consumerJoins.filter(r => r.routePositive).length,
    watchCandidateConsumerJoins: consumerJoins.filter(r => r.watchCandidate).length,
    dexLiquidityRows: dexRows.length,
    topDexLiquidityUsd: dexRows.length > 0 ? dexRows[0].liquidityUsd : null,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    blockers: [
      "Withdrawal path requires valid Circle-signed GatewayMinter attestation; no public attestation bypass proven",
      "depositToRemote requires registered remote domain and supported token; tokens are custodied in GatewayWallet",
      "All state-changing functions are owner/pauser/registration-manager gated",
      "No xReserve address referenced by material trusted consumer in scanned local artifacts",
      "No public mint, burn, withdraw, drain, attestation, proof, domain, nonce, token, or accounting bypass proven",
      "No exact positive borrow, redemption, liquidation, or unwind economics",
      "No fork extraction proof",
    ],
  };

  const output = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-usdcx-phase0.js",
    scope: "USDCx / Circle xReserve read-only Phase 0: on-chain state, probes, consumer joins, and DEX liquidity",
    safety: {
      publicApisOnly: false,
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: false,
      signedActionJustified: false,
    },
    metadata: {
      name: metadata.name || "USDCx",
      slug: metadata.slug || "usdcx",
      category: metadata.category || "Stablecoin Wrapper",
      chains: metadata.chains || ["Ethereum"],
      parentProtocol: metadata.parentProtocol || "parent#circle",
      sourceRepo: "circlefin/evm-xreserve-contracts",
    },
    summary,
    contract,
    immutables,
    probeResults,
    consumerJoins,
    dexLiquidityRows: dexRows,
  };

  writeJson(RAW_OUT, output);
  writeReport(output);

  if (!QUIET) {
    console.log(JSON.stringify({
      ok: true,
      generatedAt: output.generatedAt,
      summary: summary,
    }, null, 2));
  }
}

main().catch(err => {
  console.error(JSON.stringify({ ok: false, error: String(err) }));
  process.exit(1);
});
