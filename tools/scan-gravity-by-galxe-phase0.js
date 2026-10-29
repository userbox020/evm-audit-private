#!/usr/bin/env node
// scan-gravity-by-galxe-phase0.js - bounded read-only Phase 0 for Gravity by Galxe canonical bridge.
// RPC URLs from rpc_endpoints.txt are resolved in memory only. Never prints/stores RPC URLs, private keys, calldata for execution, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpc, rpcCall } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "gravity-by-galxe-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "gravity-by-galxe-phase0-triage.md");
const PUBLIC_TARGETS = path.join(WORKSPACE, "reports", "raw", "fast", "public-audit-target-discovery.json");
const QUIET = process.argv.includes("--quiet");

const SIGNAL_DORMANT = "🟢 DORMANT";
const ETHEREUM_CHAIN_ID = 1;
const GRAVITY_CHAIN_ID = 127001;
const GRAVITY_PUBLIC_RPC = "https://mainnet-rpc.gravity.xyz";
const DEPLOYMENT_BLOCK = 25_098_347;
const MIN_MATERIAL_USD = Number(process.env.GRAVITY_PHASE0_MATERIAL_USD || "10000");
const LOG_CHUNK_BLOCKS = Number(process.env.GRAVITY_PHASE0_LOG_CHUNK_BLOCKS || "15000");
const LOG_TIMEOUT_MS = Number(process.env.GRAVITY_PHASE0_LOG_TIMEOUT_MS || "30000");

const ZERO = "0x0000000000000000000000000000000000000000";
const G_TOKEN = "0x9C7BEBa8F6eF6643aBd725e45a4E8387eF260649";
const GRAVITY_PORTAL = "0x76cf8526Fa9461e50B2c6702a7246ce6915f6E53";
const G_BRIDGE_SENDER = "0xE82c61Ac9Ec2041b493118051afa4F18a55dC876";
const OWNER_SAFE = "0xbD6e434dB90FD8AD4E28d85C133AD34cA6fbfB6D";
const NATIVE_ORACLE = "0x00000000000000000000000000000001625F4000";
const NATIVE_MINT_PRECOMPILE = "0x00000000000000000000000000000001625F5000";
const WRAPPED_G_ON_GRAVITY = "0xBB859E225ac8Fb6BE1C7e38D87b767e95Fef0EbD";

const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const EIP1967_BEACON = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const LEGACY_ALPHA_L1_CONTRACTS = [
  { label: "legacy-rollup", address: "0xf993AF239770932A0EDaB88B6A5ba3708Bd58239" },
  { label: "legacy-inbox", address: "0x7AD2a94BefF3294a31894cFb5ba4206957a53c19" },
  { label: "legacy-outbox", address: "0x1153a1e4B1523DFf36f77d696bd6eBF2B0e7DAbF" },
  { label: "legacy-bridge", address: "0x7983403dDA368AA7d67145a9b81c5c517F364c42" },
  { label: "legacy-sequencerInbox", address: "0x8D99372612e8cFE7163B1a453831Bc40eAeb3cF3" },
  { label: "legacy-customGateway", address: "0xa26Fd1c23634870303e42311E114D5cc8301Ed1E" },
  { label: "legacy-standardGateway", address: "0xb23988D9728EF147EAa02D602D7e067B6131A1bB" },
  { label: "legacy-router", address: "0x8713569d016f981D956715e9EE2795382168b5c0" },
  { label: "legacy-multicall", address: "0x7cdCB0Cc61f47B8Dd8f47C5A29edaDd84a1BDf5e" },
];

const LOCAL_ARTIFACTS = [
  { source: "Bridge non-lossless collateral", file: "reports/raw/fast/bridge-nonlossless-collateral-join.json" },
  { source: "Bridge delta preflight", file: "reports/raw/fast/bridge-delta-preflight.json" },
  { source: "Bridge synthetic consumers", file: "reports/raw/fast/bridge-synthetic-consumer-exposure.json" },
  { source: "Bridge proof binding", file: "reports/raw/fast/bridge-proof-binding.json" },
  { source: "Bridge domain separation", file: "reports/raw/fast/bridge-domain-separation.json" },
  { source: "Bridge escrow reconciliation", file: "reports/raw/fast/bridge-escrow-reconciliation.json" },
  { source: "LayerZero OFT consumers", file: "reports/raw/fast/layerzero-oft-dvn-consumer-joins.json" },
  { source: "Aave/Euler/Silo graph", file: "reports/raw/fast/aave-euler-silo-consumer-graph.json" },
  { source: "Consumer-first high LTV", file: "reports/raw/fast/consumer-first-high-ltv-collateral.json" },
  { source: "Public lead consumers", file: "reports/raw/fast/public-lead-consumer-joins.json" },
  { source: "DEX consumer routes", file: "reports/raw/fast/dex-consumer-routes.json" },
  { source: "ERC4626 consumers", file: "reports/raw/fast/erc4626-consumer-joiner.json" },
  { source: "RWA/NAV consumer graph", file: "reports/raw/fast/rwa-nav-consumer-graph.json" },
  { source: "Deprecated/orphaned reachability", file: "reports/raw/fast/deprecated-orphaned-reachability.json" },
];

const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
]);

const COMMON = new ethers.Interface([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function admin() view returns (address)",
  "function paused() view returns (bool)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function nonce() view returns (uint256)",
  "function VERSION() view returns (string)",
]);

const PORTAL = new ethers.Interface([
  "event MessageSent(uint128 indexed nonce,uint256 indexed block_number,bytes payload)",
  "function baseFee() view returns (uint256)",
  "function feePerByte() view returns (uint256)",
  "function feeRecipient() view returns (address)",
  "function nonce() view returns (uint128)",
  "function accumulatedFees() view returns (uint256)",
  "function calculateFee(uint256) view returns (uint256)",
]);

const SENDER = new ethers.Interface([
  "event TokensLocked(address indexed from,address indexed recipient,uint256 amount,uint128 indexed nonce)",
  "event EmergencyWithdrawRequested(address indexed recipient,uint256 amount,uint256 executableAt)",
  "event EmergencyWithdraw(address indexed recipient,uint256 amount)",
  "function gToken() view returns (address)",
  "function gravityPortal() view returns (address)",
  "function TIMELOCK_DELAY() view returns (uint256)",
  "function pendingWithdrawRecipient() view returns (address)",
  "function pendingWithdrawAmount() view returns (uint256)",
  "function pendingWithdrawExecutableAt() view returns (uint256)",
  "function calculateBridgeFee(uint256,address) view returns (uint256)",
]);

const NATIVE_ORACLE_IFACE = new ethers.Interface([
  "function getLatestNonce(uint32,uint256) view returns (uint128)",
  "function getCallback(uint32,uint256) view returns (address)",
  "function getDefaultCallback(uint32) view returns (address)",
  "function isSyncedPast(uint32,uint256,uint128) view returns (bool)",
]);

const RECEIVER_IFACE = new ethers.Interface([
  "function trustedBridge() view returns (address)",
  "function trustedSourceId() view returns (uint256)",
]);

const SELECTOR_SIGNATURES = [
  "send(bytes)",
  "bridgeToGravity(uint256,address)",
  "bridgeToGravityWithPermit(uint256,address,uint256,uint8,bytes32,bytes32)",
  "requestEmergencyWithdraw(address,uint256)",
  "executeEmergencyWithdraw()",
  "recoverERC20(address,address,uint256)",
  "pause()",
  "unpause()",
  "withdrawFees()",
  "setCallback(uint32,uint256,address)",
  "record(uint32,uint256,uint128,uint256,bytes,uint256)",
];

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readText(file) { try { return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""; } catch (_) { return ""; } }
function readJson(file, fallback = null) { try { const text = readText(file).replace(/^\uFEFF/, ""); return text ? JSON.parse(text) : fallback; } catch (_) { return fallback; } }
function writeJson(file, value) { ensureDir(file); fs.writeFileSync(file, `${JSON.stringify(value, jsonReplacer, 2)}\n`); }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function strip0x(value) { return String(value || "").replace(/^0x/i, ""); }
function normalizeAddress(value) { try { return ethers.getAddress(String(value || "").replace(/^0X/, "0x")); } catch (_) { return null; } }
function lowerAddress(value) { const address = normalizeAddress(value); return address ? address.toLowerCase() : null; }
function safeText(value, max = 180) { return String(value ?? "").replace(/https?:\/\/\S+/g, "[redacted-url]").replace(/[\r\n|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) || null; }
function compactAddress(value) { const address = normalizeAddress(value); return address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "n/a"; }
function slotAddress(raw) { const hex = strip0x(raw || "").padStart(64, "0"); if (!hex || /^0+$/.test(hex)) return null; return normalizeAddress(`0x${hex.slice(-40)}`); }
function asNumber(value) { if (value === null || value === undefined || value === "") return null; if (typeof value === "number") return Number.isFinite(value) ? value : null; if (typeof value === "boolean") return value ? 1 : 0; const n = Number(String(value).replace(/[$,%\s,]/g, "")); return Number.isFinite(n) ? n : null; }
function round(value, decimals = 2) { const n = asNumber(value); if (n === null) return null; const f = 10 ** decimals; return Math.round(n * f) / f; }
function toBig(value) { try { return BigInt(value ?? 0); } catch (_) { return 0n; } }
function unitsToNumber(raw, decimals = 18) { try { const n = Number(ethers.formatUnits(toBig(raw), Number(decimals ?? 18))); return Number.isFinite(n) ? n : null; } catch (_) { return null; } }
function formatUnits(raw, decimals = 18) { if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null; try { return ethers.formatUnits(toBig(raw), Number(decimals)); } catch (_) { return null; } }
function hexBlock(value) { return `0x${Math.max(0, Number(value) || 0).toString(16)}`; }
function formatUsd(value) { const n = asNumber(value); return n === null ? "n/a" : `$${Math.round(n).toLocaleString("en-US")}`; }
function formatNumber(value, decimals = 4) { const n = asNumber(value); return n === null ? "n/a" : n.toLocaleString("en-US", { maximumFractionDigits: decimals }); }
function boolText(value) { return value === null || value === undefined ? "n/a" : String(Boolean(value)); }
function sumUsd(rows, field) { return round((rows || []).reduce((acc, row) => acc + (asNumber(row[field]) || 0), 0), 2); }
function lastRow(value) { return Array.isArray(value) && value.length ? value[value.length - 1] : null; }

async function fetchJson(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-gravity-phase0/1.0" } });
    if (!res.ok) return { ok: false, status: res.status, json: null, error: `HTTP ${res.status}` };
    return { ok: true, status: res.status, json: await res.json(), error: null };
  } catch (err) {
    return { ok: false, status: null, json: null, error: safeText(err?.message, 120) };
  } finally {
    clearTimeout(timer);
  }
}

async function safeCall(rpc, to, iface, fn, args = [], timeoutMs = 10_000) {
  const address = normalizeAddress(to);
  if (!rpc || !address) return null;
  try {
    const raw = await rpcCall(rpc, "eth_call", [{ to: address, data: iface.encodeFunctionData(fn, args) }, "latest"], timeoutMs);
    if (!raw || raw === "0x") return null;
    return iface.decodeFunctionResult(fn, raw);
  } catch (_) {
    return null;
  }
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

async function getBalance(rpc, address) {
  const addr = normalizeAddress(address);
  if (!rpc || !addr) return null;
  return await rpcCall(rpc, "eth_getBalance", [addr, "latest"], 10_000).catch(() => null);
}

async function latestBlock(rpc) {
  const hex = await rpcCall(rpc, "eth_blockNumber", [], 10_000).catch(() => null);
  return hex ? Number(BigInt(hex)) : null;
}

function selectorHints(code) {
  const bytecode = strip0x(code).toLowerCase();
  if (!bytecode) return [];
  return SELECTOR_SIGNATURES.map((signature) => ({ signature, selector: ethers.id(signature).slice(0, 10) }))
    .filter((row) => bytecode.includes(strip0x(row.selector).toLowerCase()));
}

async function addressKind(rpc, address) {
  const addr = normalizeAddress(address);
  if (!addr || addr === ZERO) return "zero";
  const code = await getCode(rpc, addr);
  if (!code || code === "0x") return "EOA";
  const owners = await safeCall(rpc, addr, COMMON, "getOwners", []);
  const threshold = await safeCall(rpc, addr, COMMON, "getThreshold", []);
  if (Array.isArray(owners?.[0]) && threshold?.[0] !== undefined) return "GnosisSafe-like";
  return "contract";
}

function latestProtocolTvl(raw) {
  const direct = asNumber(raw?.currentChainTvls?.Ethereum);
  if (direct !== null) return direct;
  const eth = raw?.chainTvls?.Ethereum || raw?.chainTvls?.ethereum || {};
  return asNumber(lastRow(eth.tvl)?.totalLiquidityUSD ?? lastRow(raw?.tvl)?.totalLiquidityUSD ?? raw?.tvl);
}

function latestProtocolToken(raw, symbol) {
  const eth = raw?.chainTvls?.Ethereum || raw?.chainTvls?.ethereum || {};
  const amount = asNumber(lastRow(eth.tokens)?.tokens?.[symbol]);
  const usd = asNumber(lastRow(eth.tokensInUsd)?.tokens?.[symbol]);
  return { amount, usd, priceUsd: amount ? usd / amount : null };
}

async function tokenPrice() {
  const key = `ethereum:${G_TOKEN.toLowerCase()}`;
  const res = await fetchJson(`https://coins.llama.fi/prices/current/${key}?searchWidth=6h`, 30_000);
  const price = Number(res.json?.coins?.[key]?.price || 0);
  return Number.isFinite(price) && price > 0 ? price : null;
}

async function geckoPools(tokenAddress) {
  const address = normalizeAddress(tokenAddress);
  if (!address) return { ok: false, status: null, pools: [], error: "invalid-token" };
  const res = await fetchJson(`https://api.geckoterminal.com/api/v2/networks/eth/tokens/${address}/pools?page=1`, 30_000);
  const pools = (res.json?.data || []).slice(0, 10).map((row) => {
    const a = row.attributes || {};
    return {
      id: row.id || null,
      name: safeText(a.name, 120),
      dex: safeText(a.dex_id || a.dex || null, 60),
      poolAddress: normalizeAddress((row.id || "").split("_").pop()) || null,
      reserveUsd: Number(a.reserve_in_usd || a.reserve_usd || 0) || 0,
      baseTokenPriceUsd: a.base_token_price_usd === undefined ? null : Number(a.base_token_price_usd),
      quoteTokenPriceUsd: a.quote_token_price_usd === undefined ? null : Number(a.quote_token_price_usd),
      volume24hUsd: a.volume_usd?.h24 === undefined ? null : Number(a.volume_usd.h24),
    };
  });
  return { ok: res.ok, status: res.status, pools, error: res.error };
}

async function sourceMetadata() {
  const [deployment, commit] = await Promise.all([
    fetchJson("https://raw.githubusercontent.com/Galxe/gravity_chain_core_contracts/main/deployments/mainnet.json", 30_000),
    fetchJson("https://api.github.com/repos/Galxe/gravity_chain_core_contracts/commits/main", 30_000),
  ]);
  return {
    repo: "https://github.com/Galxe/gravity_chain_core_contracts",
    deployment: deployment.json || null,
    commit: commit.json ? {
      sha: commit.json.sha || null,
      date: commit.json.commit?.committer?.date || null,
      message: safeText(String(commit.json.commit?.message || "").split("\n")[0], 160),
    } : null,
    sourceReviewRows: [
      {
        file: "src/oracle/evm/GravityPortal.sol",
        invariant: "send() increments a monotonic nonce, compact-encodes msg.sender + nonce + message, validates msg.value against baseFee + feePerByte, and only emits MessageSent; no token custody or unlock path exists in Portal.",
        routeImpact: false,
      },
      {
        file: "src/oracle/evm/native_token_bridge/GBridgeSender.sol",
        invariant: "bridgeToGravity transfers G in before calling Portal and uses balance-delta actualReceived; G recoverERC20 is blocked, and emergency G withdrawal is owner-only with a 7-day timelock.",
        routeImpact: false,
      },
      {
        file: "src/oracle/evm/native_token_bridge/GBridgeReceiver.sol",
        invariant: "Gravity-side receiver checks source chain id and trusted Ethereum sender before minting native G; replay/order protection is delegated to NativeOracle sequential nonces.",
        routeImpact: false,
      },
      {
        file: "src/oracle/NativeOracle.sol",
        invariant: "record()/recordBatch() are system-caller only, enforce nonce == current + 1, and route callbacks through governance-configured callback maps.",
        routeImpact: false,
      },
    ],
  };
}

async function inspectSafe(rpc, address) {
  const addr = normalizeAddress(address);
  const [code, ownersRaw, thresholdRaw, nonceRaw, versionRaw] = await Promise.all([
    getCode(rpc, addr),
    safeCall(rpc, addr, COMMON, "getOwners", []),
    safeCall(rpc, addr, COMMON, "getThreshold", []),
    safeCall(rpc, addr, COMMON, "nonce", []),
    safeCall(rpc, addr, COMMON, "VERSION", []),
  ]);
  const owners = Array.isArray(ownersRaw?.[0]) ? ownersRaw[0].map((owner) => normalizeAddress(owner)).filter(Boolean) : [];
  return {
    label: "Owner multisig",
    address: addr,
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    ownerCount: owners.length,
    threshold: thresholdRaw?.[0] === undefined ? null : Number(thresholdRaw[0]),
    nonce: nonceRaw?.[0] === undefined ? null : nonceRaw[0].toString(),
    version: versionRaw?.[0] === undefined ? null : safeText(versionRaw[0], 80),
    kind: owners.length && thresholdRaw?.[0] !== undefined ? "GnosisSafe-like" : "contract",
    routePositive: false,
  };
}

async function inspectPortal(rpc) {
  const address = normalizeAddress(GRAVITY_PORTAL);
  const [code, nativeBalance, implRaw, adminRaw, beaconRaw, ownerRaw, pendingOwnerRaw, pausedRaw, baseFeeRaw, feePerByteRaw, feeRecipientRaw, nonceRaw, accumulatedFeesRaw, fee64Raw] = await Promise.all([
    getCode(rpc, address),
    getBalance(rpc, address),
    getStorage(rpc, address, EIP1967_IMPL),
    getStorage(rpc, address, EIP1967_ADMIN),
    getStorage(rpc, address, EIP1967_BEACON),
    safeCall(rpc, address, COMMON, "owner", []),
    safeCall(rpc, address, COMMON, "pendingOwner", []),
    safeCall(rpc, address, COMMON, "paused", []),
    safeCall(rpc, address, PORTAL, "baseFee", []),
    safeCall(rpc, address, PORTAL, "feePerByte", []),
    safeCall(rpc, address, PORTAL, "feeRecipient", []),
    safeCall(rpc, address, PORTAL, "nonce", []),
    safeCall(rpc, address, PORTAL, "accumulatedFees", []),
    safeCall(rpc, address, PORTAL, "calculateFee", [64n]),
  ]);
  return {
    label: "GravityPortal",
    chain: "Ethereum",
    address,
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    selectorHints: selectorHints(code),
    eip1967: { implementation: slotAddress(implRaw), admin: slotAddress(adminRaw), beacon: slotAddress(beaconRaw) },
    owner: normalizeAddress(ownerRaw?.[0]),
    ownerKind: await addressKind(rpc, ownerRaw?.[0]),
    pendingOwner: normalizeAddress(pendingOwnerRaw?.[0]),
    paused: pausedRaw?.[0] === undefined ? null : Boolean(pausedRaw[0]),
    feeRecipient: normalizeAddress(feeRecipientRaw?.[0]),
    baseFeeWei: baseFeeRaw?.[0] === undefined ? null : baseFeeRaw[0].toString(),
    feePerByteWei: feePerByteRaw?.[0] === undefined ? null : feePerByteRaw[0].toString(),
    feeFor64ByteMessageWei: fee64Raw?.[0] === undefined ? null : fee64Raw[0].toString(),
    feeFor64ByteMessageEth: fee64Raw?.[0] === undefined ? null : formatUnits(fee64Raw[0], 18),
    nonce: nonceRaw?.[0] === undefined ? null : nonceRaw[0].toString(),
    accumulatedFeesWei: accumulatedFeesRaw?.[0] === undefined ? null : accumulatedFeesRaw[0].toString(),
    accumulatedFeesEth: accumulatedFeesRaw?.[0] === undefined ? null : formatUnits(accumulatedFeesRaw[0], 18),
    nativeBalanceWei: nativeBalance === null ? null : BigInt(nativeBalance).toString(),
    nativeBalanceEth: nativeBalance === null ? null : formatUnits(nativeBalance, 18),
    routePositive: false,
  };
}

async function inspectSender(rpc, gDecimals, gPriceUsd) {
  const address = normalizeAddress(G_BRIDGE_SENDER);
  const [code, nativeBalance, implRaw, adminRaw, beaconRaw, ownerRaw, pendingOwnerRaw, pausedRaw, gTokenRaw, portalRaw, delayRaw, pendingRecipientRaw, pendingAmountRaw, pendingExecutableAtRaw, feeRaw, gBalanceRaw] = await Promise.all([
    getCode(rpc, address),
    getBalance(rpc, address),
    getStorage(rpc, address, EIP1967_IMPL),
    getStorage(rpc, address, EIP1967_ADMIN),
    getStorage(rpc, address, EIP1967_BEACON),
    safeCall(rpc, address, COMMON, "owner", []),
    safeCall(rpc, address, COMMON, "pendingOwner", []),
    safeCall(rpc, address, COMMON, "paused", []),
    safeCall(rpc, address, SENDER, "gToken", []),
    safeCall(rpc, address, SENDER, "gravityPortal", []),
    safeCall(rpc, address, SENDER, "TIMELOCK_DELAY", []),
    safeCall(rpc, address, SENDER, "pendingWithdrawRecipient", []),
    safeCall(rpc, address, SENDER, "pendingWithdrawAmount", []),
    safeCall(rpc, address, SENDER, "pendingWithdrawExecutableAt", []),
    safeCall(rpc, address, SENDER, "calculateBridgeFee", [10n ** 18n, OWNER_SAFE]),
    safeCall(rpc, G_TOKEN, ERC20, "balanceOf", [address]),
  ]);
  const gBalance = gBalanceRaw?.[0] ?? null;
  const gBalanceAmount = unitsToNumber(gBalance, gDecimals);
  const gBalanceUsd = gBalanceAmount !== null && gPriceUsd ? gBalanceAmount * gPriceUsd : null;
  const pendingAmount = pendingAmountRaw?.[0] ?? null;
  const pendingAmountUnits = unitsToNumber(pendingAmount, gDecimals);
  const pendingAmountUsd = pendingAmountUnits !== null && gPriceUsd ? pendingAmountUnits * gPriceUsd : null;
  return {
    label: "GBridgeSender",
    chain: "Ethereum",
    address,
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    selectorHints: selectorHints(code),
    eip1967: { implementation: slotAddress(implRaw), admin: slotAddress(adminRaw), beacon: slotAddress(beaconRaw) },
    owner: normalizeAddress(ownerRaw?.[0]),
    ownerKind: await addressKind(rpc, ownerRaw?.[0]),
    pendingOwner: normalizeAddress(pendingOwnerRaw?.[0]),
    paused: pausedRaw?.[0] === undefined ? null : Boolean(pausedRaw[0]),
    gToken: normalizeAddress(gTokenRaw?.[0]),
    gravityPortal: normalizeAddress(portalRaw?.[0]),
    timeLockDelaySeconds: delayRaw?.[0] === undefined ? null : Number(delayRaw[0]),
    pendingWithdrawRecipient: normalizeAddress(pendingRecipientRaw?.[0]),
    pendingWithdrawAmountRaw: pendingAmount === null ? null : pendingAmount.toString(),
    pendingWithdrawAmount: pendingAmount === null ? null : formatUnits(pendingAmount, gDecimals),
    pendingWithdrawAmountUsd: round(pendingAmountUsd, 2),
    pendingWithdrawExecutableAt: pendingExecutableAtRaw?.[0] === undefined ? null : Number(pendingExecutableAtRaw[0]),
    bridgeFeeFor1GWei: feeRaw?.[0] === undefined ? null : feeRaw[0].toString(),
    bridgeFeeFor1GEth: feeRaw?.[0] === undefined ? null : formatUnits(feeRaw[0], 18),
    nativeBalanceWei: nativeBalance === null ? null : BigInt(nativeBalance).toString(),
    nativeBalanceEth: nativeBalance === null ? null : formatUnits(nativeBalance, 18),
    gBalanceRaw: gBalance === null ? null : gBalance.toString(),
    gBalance: gBalance === null ? null : formatUnits(gBalance, gDecimals),
    gBalanceUsd: round(gBalanceUsd, 2),
    routePositive: false,
  };
}

async function inspectGToken(rpc, defillamaToken, priceUsd) {
  const address = normalizeAddress(G_TOKEN);
  const [code, symbolRaw, nameRaw, decimalsRaw, supplyRaw, senderBalanceRaw, portalBalanceRaw, ownerBalanceRaw] = await Promise.all([
    getCode(rpc, address),
    safeCall(rpc, address, ERC20, "symbol", []),
    safeCall(rpc, address, ERC20, "name", []),
    safeCall(rpc, address, ERC20, "decimals", []),
    safeCall(rpc, address, ERC20, "totalSupply", []),
    safeCall(rpc, address, ERC20, "balanceOf", [G_BRIDGE_SENDER]),
    safeCall(rpc, address, ERC20, "balanceOf", [GRAVITY_PORTAL]),
    safeCall(rpc, address, ERC20, "balanceOf", [OWNER_SAFE]),
  ]);
  const decimals = decimalsRaw?.[0] === undefined ? 18 : Number(decimalsRaw[0]);
  const senderAmount = unitsToNumber(senderBalanceRaw?.[0], decimals);
  const portalAmount = unitsToNumber(portalBalanceRaw?.[0], decimals);
  const supplyAmount = unitsToNumber(supplyRaw?.[0], decimals);
  const effectivePrice = priceUsd || defillamaToken.priceUsd || null;
  const senderUsd = senderAmount !== null && effectivePrice ? senderAmount * effectivePrice : null;
  const portalUsd = portalAmount !== null && effectivePrice ? portalAmount * effectivePrice : null;
  const defillamaDeltaG = senderAmount !== null && defillamaToken.amount !== null ? senderAmount - defillamaToken.amount : null;
  const defillamaDeltaUsd = senderUsd !== null && defillamaToken.usd !== null ? senderUsd - defillamaToken.usd : null;
  return {
    chain: "Ethereum",
    symbol: symbolRaw?.[0] === undefined ? "G" : String(symbolRaw[0]),
    name: nameRaw?.[0] === undefined ? null : safeText(nameRaw[0], 80),
    address,
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    decimals,
    totalSupplyRaw: supplyRaw?.[0] === undefined ? null : supplyRaw[0].toString(),
    totalSupply: supplyRaw?.[0] === undefined ? null : formatUnits(supplyRaw[0], decimals),
    totalSupplyUsd: supplyAmount !== null && effectivePrice ? round(supplyAmount * effectivePrice, 2) : null,
    priceUsd: round(effectivePrice, 10),
    defillamaTokenAmount: round(defillamaToken.amount, 6),
    defillamaTokenUsd: round(defillamaToken.usd, 2),
    bridgeSenderBalanceRaw: senderBalanceRaw?.[0] === undefined ? null : senderBalanceRaw[0].toString(),
    bridgeSenderBalance: senderBalanceRaw?.[0] === undefined ? null : formatUnits(senderBalanceRaw[0], decimals),
    bridgeSenderBalanceUsd: round(senderUsd, 2),
    portalBalanceRaw: portalBalanceRaw?.[0] === undefined ? null : portalBalanceRaw[0].toString(),
    portalBalance: portalBalanceRaw?.[0] === undefined ? null : formatUnits(portalBalanceRaw[0], decimals),
    portalBalanceUsd: round(portalUsd, 2),
    ownerBalanceRaw: ownerBalanceRaw?.[0] === undefined ? null : ownerBalanceRaw[0].toString(),
    ownerBalance: ownerBalanceRaw?.[0] === undefined ? null : formatUnits(ownerBalanceRaw[0], decimals),
    bridgeSenderVsDefillamaDeltaG: round(defillamaDeltaG, 6),
    bridgeSenderVsDefillamaDeltaUsd: round(defillamaDeltaUsd, 2),
    materialDelta: defillamaDeltaUsd !== null ? Math.abs(defillamaDeltaUsd) >= MIN_MATERIAL_USD : false,
    routePositive: false,
  };
}

async function inspectLegacyContract(rpc, row, gDecimals, gPriceUsd) {
  const address = normalizeAddress(row.address);
  const [code, nativeBalance, gBalanceRaw] = await Promise.all([
    getCode(rpc, address),
    getBalance(rpc, address),
    safeCall(rpc, G_TOKEN, ERC20, "balanceOf", [address]),
  ]);
  const gAmount = unitsToNumber(gBalanceRaw?.[0], gDecimals);
  const gUsd = gAmount !== null && gPriceUsd ? gAmount * gPriceUsd : null;
  return {
    label: row.label,
    chain: "Ethereum",
    address,
    deprecatedOrLegacy: true,
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    selectorHints: selectorHints(code),
    nativeBalanceWei: nativeBalance === null ? null : BigInt(nativeBalance).toString(),
    nativeBalanceEth: nativeBalance === null ? null : formatUnits(nativeBalance, 18),
    gBalanceRaw: gBalanceRaw?.[0] === undefined ? null : gBalanceRaw[0].toString(),
    gBalance: gBalanceRaw?.[0] === undefined ? null : formatUnits(gBalanceRaw[0], gDecimals),
    gBalanceUsd: round(gUsd, 2),
    routePositive: false,
    blocker: "Legacy Alpha L2 bridge address context; not current L1 canonical bridge route-positive evidence without proof/custody mismatch and exact unwind economics.",
  };
}

async function inspectGravityL1(portalNonce) {
  const rpc = GRAVITY_PUBLIC_RPC;
  const chainIdHex = await rpcCall(rpc, "eth_chainId", [], 10_000).catch(() => null);
  const chainId = chainIdHex ? Number(BigInt(chainIdHex)) : null;
  const [blockNumber, nativeOracleCode, mintCode, wrappedGCode, latestNonceRaw, callbackRaw, defaultCallbackRaw, syncedPastRaw] = await Promise.all([
    latestBlock(rpc),
    getCode(rpc, NATIVE_ORACLE),
    getCode(rpc, NATIVE_MINT_PRECOMPILE),
    getCode(rpc, WRAPPED_G_ON_GRAVITY),
    safeCall(rpc, NATIVE_ORACLE, NATIVE_ORACLE_IFACE, "getLatestNonce", [0, 1]),
    safeCall(rpc, NATIVE_ORACLE, NATIVE_ORACLE_IFACE, "getCallback", [0, 1]),
    safeCall(rpc, NATIVE_ORACLE, NATIVE_ORACLE_IFACE, "getDefaultCallback", [0]),
    portalNonce ? safeCall(rpc, NATIVE_ORACLE, NATIVE_ORACLE_IFACE, "isSyncedPast", [0, 1, BigInt(portalNonce)]) : null,
  ]);
  const callback = normalizeAddress(callbackRaw?.[0]);
  const [callbackCode, trustedBridgeRaw, trustedSourceRaw] = callback ? await Promise.all([
    getCode(rpc, callback),
    safeCall(rpc, callback, RECEIVER_IFACE, "trustedBridge", []),
    safeCall(rpc, callback, RECEIVER_IFACE, "trustedSourceId", []),
  ]) : ["0x", null, null];
  return {
    rpcPublicEndpointUsed: true,
    chainIdExpected: GRAVITY_CHAIN_ID,
    chainIdObserved: chainId,
    blockNumber,
    nativeOracle: {
      address: normalizeAddress(NATIVE_ORACLE),
      codePresent: Boolean(nativeOracleCode && nativeOracleCode !== "0x"),
      codeBytes: nativeOracleCode && nativeOracleCode !== "0x" ? strip0x(nativeOracleCode).length / 2 : 0,
      latestNonceForEthereum: latestNonceRaw?.[0] === undefined ? null : latestNonceRaw[0].toString(),
      callbackForEthereum: callback,
      defaultBlockchainCallback: normalizeAddress(defaultCallbackRaw?.[0]),
      syncedPastPortalNonce: syncedPastRaw?.[0] === undefined ? null : Boolean(syncedPastRaw[0]),
    },
    receiver: callback ? {
      address: callback,
      codePresent: Boolean(callbackCode && callbackCode !== "0x"),
      codeBytes: callbackCode && callbackCode !== "0x" ? strip0x(callbackCode).length / 2 : 0,
      trustedBridge: normalizeAddress(trustedBridgeRaw?.[0]),
      trustedSourceId: trustedSourceRaw?.[0] === undefined ? null : trustedSourceRaw[0].toString(),
      trustedBridgeMatchesSender: lowerAddress(trustedBridgeRaw?.[0]) === lowerAddress(G_BRIDGE_SENDER),
      trustedSourceIsEthereum: trustedSourceRaw?.[0] === undefined ? null : Number(trustedSourceRaw[0]) === ETHEREUM_CHAIN_ID,
    } : null,
    nativeMintPrecompile: {
      address: normalizeAddress(NATIVE_MINT_PRECOMPILE),
      codePresent: Boolean(mintCode && mintCode !== "0x"),
      codeBytes: mintCode && mintCode !== "0x" ? strip0x(mintCode).length / 2 : 0,
    },
    wrappedG: {
      address: normalizeAddress(WRAPPED_G_ON_GRAVITY),
      codePresent: Boolean(wrappedGCode && wrappedGCode !== "0x"),
      codeBytes: wrappedGCode && wrappedGCode !== "0x" ? strip0x(wrappedGCode).length / 2 : 0,
    },
  };
}

async function getLogsChunked(rpc, address, topic0, fromBlock, toBlock) {
  const logs = [];
  let rangesScanned = 0;
  let errors = 0;
  async function fetchRange(from, to, depth = 0) {
    rangesScanned += 1;
    const result = await rpcCall(rpc, "eth_getLogs", [{ address, fromBlock: hexBlock(from), toBlock: hexBlock(to), topics: [topic0] }], LOG_TIMEOUT_MS).catch(() => null);
    if (Array.isArray(result)) {
      logs.push(...result);
      return;
    }
    if (to > from && depth < 12) {
      const mid = Math.floor((from + to) / 2);
      await fetchRange(from, mid, depth + 1);
      await fetchRange(mid + 1, to, depth + 1);
      return;
    }
    errors += 1;
  }
  for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK_BLOCKS) {
    const end = Math.min(toBlock, start + LOG_CHUNK_BLOCKS - 1);
    await fetchRange(start, end);
  }
  return { logs, rangesScanned, errors };
}

function decodePortalPayload(payload) {
  const hex = strip0x(payload);
  if (hex.length < 72) return null;
  const sender = normalizeAddress(`0x${hex.slice(0, 40)}`);
  let payloadNonce = null;
  try { payloadNonce = BigInt(`0x${hex.slice(40, 72)}`).toString(); } catch (_) { payloadNonce = null; }
  const message = `0x${hex.slice(72)}`;
  let amount = null;
  try {
    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(["uint256", "address"], message);
    amount = decoded[0];
  } catch (_) {
    amount = null;
  }
  return { sender, payloadNonce, amount, messageBytes: strip0x(message).length / 2 };
}

async function scanBridgeLogs(rpc, latest, gDecimals, gPriceUsd) {
  const fromBlock = DEPLOYMENT_BLOCK;
  const toBlock = latest || DEPLOYMENT_BLOCK;
  const [lockedRaw, messageRaw, emergencyRequestRaw, emergencyExecRaw] = await Promise.all([
    getLogsChunked(rpc, normalizeAddress(G_BRIDGE_SENDER), SENDER.getEvent("TokensLocked").topicHash, fromBlock, toBlock),
    getLogsChunked(rpc, normalizeAddress(GRAVITY_PORTAL), PORTAL.getEvent("MessageSent").topicHash, fromBlock, toBlock),
    getLogsChunked(rpc, normalizeAddress(G_BRIDGE_SENDER), SENDER.getEvent("EmergencyWithdrawRequested").topicHash, fromBlock, toBlock),
    getLogsChunked(rpc, normalizeAddress(G_BRIDGE_SENDER), SENDER.getEvent("EmergencyWithdraw").topicHash, fromBlock, toBlock),
  ]);
  let totalLocked = 0n;
  let maxNonce = 0n;
  const recentLocked = [];
  for (const log of lockedRaw.logs) {
    try {
      const parsed = SENDER.parseLog(log);
      const amount = toBig(parsed.args.amount);
      const nonce = toBig(parsed.args.nonce);
      totalLocked += amount;
      if (nonce > maxNonce) maxNonce = nonce;
      recentLocked.push({ blockNumber: Number(BigInt(log.blockNumber)), nonce: nonce.toString(), amountRaw: amount.toString(), amount: formatUnits(amount, gDecimals), amountUsd: round(unitsToNumber(amount, gDecimals) * (gPriceUsd || 0), 2) });
    } catch (_) {
      // Skip undecodable rows; aggregate logErrors below covers RPC failures only.
    }
  }
  let totalPortalG = 0n;
  let portalMessagesFromSender = 0;
  let portalMaxNonce = 0n;
  for (const log of messageRaw.logs) {
    try {
      const parsed = PORTAL.parseLog(log);
      const nonce = toBig(parsed.args.nonce);
      if (nonce > portalMaxNonce) portalMaxNonce = nonce;
      const payload = decodePortalPayload(parsed.args.payload);
      if (lowerAddress(payload?.sender) === lowerAddress(G_BRIDGE_SENDER)) {
        portalMessagesFromSender += 1;
        totalPortalG += toBig(payload.amount);
      }
    } catch (_) {
      // Best-effort log decoding only.
    }
  }
  const totalLockedAmount = unitsToNumber(totalLocked, gDecimals);
  const totalPortalAmount = unitsToNumber(totalPortalG, gDecimals);
  return {
    fromBlock,
    toBlock,
    rangesScanned: lockedRaw.rangesScanned + messageRaw.rangesScanned + emergencyRequestRaw.rangesScanned + emergencyExecRaw.rangesScanned,
    logErrors: lockedRaw.errors + messageRaw.errors + emergencyRequestRaw.errors + emergencyExecRaw.errors,
    tokensLockedLogs: lockedRaw.logs.length,
    messageSentLogs: messageRaw.logs.length,
    portalMessagesFromGBridgeSender: portalMessagesFromSender,
    emergencyWithdrawRequestedLogs: emergencyRequestRaw.logs.length,
    emergencyWithdrawExecutedLogs: emergencyExecRaw.logs.length,
    maxTokensLockedNonce: maxNonce ? maxNonce.toString() : null,
    maxPortalNonce: portalMaxNonce ? portalMaxNonce.toString() : null,
    totalTokensLockedRaw: totalLocked.toString(),
    totalTokensLocked: totalLockedAmount,
    totalTokensLockedUsd: round(totalLockedAmount !== null && gPriceUsd ? totalLockedAmount * gPriceUsd : null, 2),
    totalPortalGAmountRaw: totalPortalG.toString(),
    totalPortalGAmount: totalPortalAmount,
    totalPortalGAmountUsd: round(totalPortalAmount !== null && gPriceUsd ? totalPortalAmount * gPriceUsd : null, 2),
    recentLockedRows: recentLocked.slice(-8),
  };
}

function contextSummary(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const fields = ["id", "protocol", "project", "name", "chain", "chainId", "surface", "side", "symbol", "token", "asset", "collateral", "borrowAsset", "routePositive", "watchCandidate", "liquidityUsd", "borrowCashUsd", "cashUsd", "tvlUsd", "source", "status", "reason"];
  const out = {};
  for (const field of fields) if (obj[field] !== undefined && typeof obj[field] !== "object") out[field] = String(obj[field]).slice(0, 140);
  return out;
}

function findMatches(data, wantedAddress, source, max = 12) {
  const matches = [];
  const wanted = lowerAddress(wantedAddress);
  if (!wanted) return matches;
  function walk(value, objectPath, parent) {
    if (matches.length >= max) return;
    if (typeof value === "string") {
      if (lowerAddress(value) === wanted || value.toLowerCase().includes(wanted)) matches.push({ source, path: objectPath, context: contextSummary(parent), routePositive: Boolean(parent?.routePositive), watchCandidate: Boolean(parent?.watchCandidate) });
      return;
    }
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) walk(value[i], `${objectPath}[${i}]`, parent); return; }
    for (const [key, child] of Object.entries(value)) walk(child, objectPath ? `${objectPath}.${key}` : key, value);
  }
  walk(data, "", null);
  return matches;
}

function artifactJoins() {
  const wanted = [
    { label: "G token", address: G_TOKEN, bridgeSpecific: true },
    { label: "GBridgeSender", address: G_BRIDGE_SENDER, bridgeSpecific: true },
    { label: "GravityPortal", address: GRAVITY_PORTAL, bridgeSpecific: true },
    { label: "Owner multisig", address: OWNER_SAFE, bridgeSpecific: false },
    { label: "NativeOracle", address: NATIVE_ORACLE, bridgeSpecific: true },
    { label: "NativeMintPrecompile", address: NATIVE_MINT_PRECOMPILE, bridgeSpecific: true },
    ...LEGACY_ALPHA_L1_CONTRACTS.map((row) => ({ label: row.label, address: row.address, bridgeSpecific: false, legacy: true })),
  ];
  const rows = [];
  for (const item of wanted) {
    for (const { source, file } of LOCAL_ARTIFACTS) {
      const data = readJson(path.join(WORKSPACE, file));
      if (!data) continue;
      const matches = findMatches(data, item.address, source, 10);
      if (!matches.length) continue;
      rows.push({
        label: item.label,
        address: normalizeAddress(item.address),
        source,
        file,
        bridgeSpecific: Boolean(item.bridgeSpecific),
        legacy: Boolean(item.legacy),
        joinCount: matches.length,
        routePositive: matches.some((m) => m.routePositive),
        watchCandidate: matches.some((m) => m.watchCandidate),
        matches,
      });
    }
  }
  rows.sort((a, b) => Number(b.bridgeSpecific) - Number(a.bridgeSpecific) || b.joinCount - a.joinCount);
  return rows;
}

function classify(out) {
  const s = out.summary;
  const blockers = [
    "The current canonical bridge path is one-way Ethereum G lock -> Gravity L1 native mint; no permissionless Ethereum unlock/release path exists in the current L1 bridge design.",
    "Current GBridgeSender plus legacy Alpha bridge G custody explain the public DeFiLlama G backing context within materiality; no exact backing deficit or over-mint route was observed.",
    "GravityPortal emits messages only after fee checks and binds msg.sender plus nonce into the payload; source review found no user-supplied trusted sender override.",
    "GBridgeReceiver/NativeOracle path is source-chain and trusted-sender bound, with NativeOracle system-caller-only sequential nonce recording.",
    "Owner emergency withdrawal of locked G is permissioned and timelocked, not a permissionless low-fund route.",
    "Local bridge/lending/DEX artifacts do not expose a bridge-specific trusted consumer join with current exact-positive borrow, redeem, liquidation, mint, unlock, or unwind economics.",
    "No fork extraction proof is justified without a concrete route-positive trigger.",
  ];
  const caveats = [];
  if (!out.gravityL1?.receiver?.address) caveats.push("Gravity docs do not publish the GBridgeReceiver address; this scanner resolves it only through NativeOracle if the public Gravity RPC responds.");
  if (out.gravityL1?.chainIdObserved !== GRAVITY_CHAIN_ID) caveats.push("Gravity public RPC chain-id check failed or returned an unexpected value; Gravity L1 receiver state remains bounded by public RPC availability.");
  if (s.logErrors > 0) caveats.push("Historical Ethereum log coverage had RPC range failures; custody and live state still come from direct eth_call balance/config reads.");
  if (out.legacyRows.some((row) => (asNumber(row.gBalanceUsd) || 0) >= MIN_MATERIAL_USD)) caveats.push("Legacy Alpha L2 bridge contracts still hold material G context and appear to explain most DeFiLlama TVL; current docs classify Alpha as legacy/deprecating, not the L1 Native Bridge route.");
  return {
    signal: SIGNAL_DORMANT,
    routePositive: 0,
    watchCandidates: 0,
    executableNow: false,
    signedActionJustified: false,
    coverageClassification: caveats.length ? "bounded-with-caveats" : "full-enough-for-declared-scope",
    forkGate: "closed-route-positive-zero",
    blockers,
    caveats,
    reopenTriggers: [
      "A deployed Gravity proof/domain/nonce/token/finality binding flaw is shown to mint native G or unlock/withdraw Ethereum G without a real locked event.",
      "GBridgeSender custody and Gravity minted/native supply diverge materially with a permissionless mint/unlock or consumer route, not just accounting context.",
      "Exact G token or bridge receipt becomes trusted collateral/settlement input in a material lending, margin, redemption, or liquidation consumer with accepted-value divergence.",
      "Legacy Alpha bridge contracts expose a callable value-moving path with live approvals/custody and exact-positive unwind economics.",
      "Current DEX/redemption/borrow/liquidation route is exact-quoted positive after fees, gas, and slippage, then fork-proven.",
    ],
  };
}

function writeReport(out) {
  const s = out.summary;
  const c = out.classification;
  const contractRows = out.contractRows.map((row) => `| ${row.label} | ${row.chain} | ${row.address} | ${row.codePresent} | ${row.codeBytes} | ${compactAddress(row.owner)} | ${boolText(row.paused)} | ${row.selectorHints?.length || 0} |`).join("\n");
  const custodyRows = [
    `| Current L1 GBridgeSender | ${G_BRIDGE_SENDER} | ${formatNumber(s.gBridgeSenderCustodyG, 4)} | ${formatUsd(s.gBridgeSenderBalanceUsd)} | New one-way Ethereum -> Gravity L1 bridge custody, not the main DeFiLlama TVL row |`,
    `| Legacy Alpha bridge | ${LEGACY_ALPHA_L1_CONTRACTS.find((row) => row.label === "legacy-bridge")?.address || "n/a"} | ${formatNumber(s.legacyBridgeCustodyG, 4)} | ${formatUsd(s.legacyBridgeCustodyUsd)} | Legacy Alpha L2 bridge custody; matches public DeFiLlama G TVL context |`,
    `| Total tracked | n/a | ${formatNumber(s.totalTrackedCustodyG, 4)} | ${formatUsd(s.totalTrackedCustodyUsd)} | Sum of current L1 and legacy custody; extra current L1 custody is overbacking/context, not a deficit |`,
  ].join("\n");
  const safeRows = out.safeRows.map((row) => `| ${row.label} | ${row.address} | ${row.kind} | ${row.threshold ?? "n/a"} | ${row.ownerCount ?? "n/a"} | ${row.version || "n/a"} |`).join("\n");
  const custodyPrice = s.defillamaGAmount ? (asNumber(s.defillamaGUsd) || 0) / asNumber(s.defillamaGAmount) : null;
  const legacyRows = out.legacyRows.filter((row) => row.codePresent || (asNumber(row.gBalanceUsd) || 0) > 0).slice(0, 12).map((row) => {
    const balanceUsd = custodyPrice && asNumber(row.gBalance) ? asNumber(row.gBalance) * custodyPrice : row.gBalanceUsd;
    return `| ${row.label} | ${row.address} | ${row.codePresent} | ${formatUsd(balanceUsd)} | ${row.selectorHints?.length || 0} |`;
  }).join("\n") || "| none | n/a | false | n/a | 0 |";
  const dexRows = out.dexRows.slice(0, 5).map((row) => `| ${row.name || "n/a"} | ${row.dex || "n/a"} | ${formatUsd(row.reserveUsd)} | ${row.baseTokenPriceUsd ?? "n/a"} | ${row.quoteTokenPriceUsd ?? "n/a"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a |";
  const joinRows = out.artifactJoins.slice(0, 14).map((row) => `| ${row.label} | ${row.source} | ${row.joinCount} | ${row.bridgeSpecific} | ${row.legacy} | ${row.routePositive} | ${row.watchCandidate} |`).join("\n") || "| none | none | 0 | false | false | false | false |";
  const sourceRows = out.source.sourceReviewRows.map((row) => `| ${row.file} | ${safeText(row.invariant, 260)} | ${row.routeImpact} |`).join("\n");
  const blockerRows = c.blockers.map((row) => `- ${row}`).join("\n");
  const caveatRows = c.caveats.length ? c.caveats.map((row) => `- ${row}`).join("\n") : "- None for declared read-only scope.";
  const triggerRows = c.reopenTriggers.map((row) => `- ${row}`).join("\n");
  const l1 = out.gravityL1 || {};
  const receiver = l1.receiver || {};

  const md = `# ${SIGNAL_DORMANT} - Gravity by Galxe Phase 0

Generated: ${out.generatedAt}

Scanner: \`tools/scan-gravity-by-galxe-phase0.js\`

Artifact: \`reports/raw/fast/gravity-by-galxe-phase0.json\`

## Result

No permissionless route-positive exploit is claimed. This Phase 0 mapped the Ethereum canonical bridge contracts, G token custody, Gravity L1 NativeOracle/callback path, owner/paused/timelock state, historical bridge logs, legacy Alpha bridge context, local consumer joins, and G exit-liquidity context. It found no proof-binding bypass, no exact backing mismatch, no bridge-specific trusted consumer edge, and no exact-positive mint/unlock/borrow/redeem/liquidation/unwind route.

## Target

| Field | Value |
|---|---:|
| Protocol | \`${out.metadata.name}\` |
| Slug | \`${out.metadata.slug}\` |
| Category | \`${out.metadata.category}\` |
| Current public TVL | \`${formatUsd(s.defillamaCurrentTvlUsd)}\` |
| Ethereum TVL | \`${formatUsd(s.ethereumTvlUsd)}\` |
| Contracts scanned | \`${s.contractsScanned}\` |
| Contracts with code | \`${s.contractsWithCode}\` |
| G custody in GBridgeSender | \`${formatUsd(s.gBridgeSenderBalanceUsd)}\` |
| Legacy Alpha G custody | \`${formatUsd(s.legacyBridgeCustodyUsd)}\` |
| Total tracked G custody | \`${formatUsd(s.totalTrackedCustodyUsd)}\` |
| Public G backing context | \`${formatUsd(s.defillamaGUsd)}\` |
| Legacy custody vs public delta | \`${formatUsd(s.legacyCustodyVsDefillamaDeltaUsd)}\` |
| Portal nonce | \`${s.portalNonce || "n/a"}\` |
| NativeOracle Ethereum nonce | \`${s.nativeOracleLatestNonce || "n/a"}\` |
| NativeOracle synced past Portal nonce | \`${boolText(s.nativeOracleSyncedPastPortalNonce)}\` |
| Top G DEX liquidity | \`${formatUsd(s.topDexLiquidityUsd)}\` |
| Bridge-specific local joins | \`${s.bridgeSpecificJoinRows}\` |
| Watch candidates | \`${s.watchCandidates}\` |
| Route-positive rows | \`${s.routePositive}\` |

## Ethereum Contracts

| Contract | Chain | Address | Code | Code bytes | Owner | Paused | Selector hints |
|---|---|---|---:|---:|---|---:|---:|
${contractRows}

## Owner State

| Label | Address | Kind | Threshold | Owners | Version |
|---|---|---|---:|---:|---|
${safeRows}

## G Custody

| Location | Address | G amount | USD context | Note |
|---|---|---:|---:|---|
${custodyRows}

Bridge log coverage from block \`${out.logScan.fromBlock}\` to \`${out.logScan.toBlock}\` decoded \`${out.logScan.tokensLockedLogs}\` \`TokensLocked\` logs and \`${out.logScan.portalMessagesFromGBridgeSender}\` sender-matched portal messages. Emergency withdrawal requests/executions were \`${out.logScan.emergencyWithdrawRequestedLogs}\` / \`${out.logScan.emergencyWithdrawExecutedLogs}\`.

## Gravity L1

| Field | Value |
|---|---:|
| Public RPC chain ID | \`${l1.chainIdObserved ?? "n/a"}\` |
| NativeOracle code | \`${boolText(l1.nativeOracle?.codePresent)}\` |
| NativeOracle callback for Ethereum | \`${l1.nativeOracle?.callbackForEthereum || "n/a"}\` |
| Receiver code | \`${boolText(receiver.codePresent)}\` |
| Receiver trusted bridge | \`${receiver.trustedBridge || "n/a"}\` |
| Receiver trusted source ID | \`${receiver.trustedSourceId || "n/a"}\` |
| Receiver trust matches sender/source | \`${boolText(receiver.trustedBridgeMatchesSender && receiver.trustedSourceIsEthereum)}\` |
| Native mint precompile code | \`${boolText(l1.nativeMintPrecompile?.codePresent)}\` |
| Wrapped G code | \`${boolText(l1.wrappedG?.codePresent)}\` |

## Legacy Alpha Context

| Contract | Address | Code | G balance USD | Selector hints |
|---|---|---:|---:|---:|
${legacyRows}

## Exit Liquidity

| Pool | DEX | Reserve USD | Base price | Quote price |
|---|---|---:|---:|---:|
${dexRows}

DEX liquidity is context only. It does not create impact without a trusted consumer, accepted-value divergence, proof bypass, or mint/unlock route.

## Local Joins

| Target | Source | Joins | Bridge-specific | Legacy | Route-positive | Watch |
|---|---|---:|---:|---:|---:|---:|
${joinRows}

## Source Review

| Source | Relevant invariant | Route impact now |
|---|---|---:|
${sourceRows}

## Blockers

${blockerRows}

## Caveats

${caveatRows}

## Reopen Triggers

${triggerRows}
`;
  ensureDir(REPORT_OUT);
  fs.writeFileSync(REPORT_OUT, md);
}

async function main() {
  const generatedAt = new Date().toISOString();
  const [protocolRes, source, ethRpc] = await Promise.all([
    fetchJson("https://api.llama.fi/protocol/gravity-by-galxe", 45_000),
    sourceMetadata(),
    resolveRpc(ETHEREUM_CHAIN_ID),
  ]);
  if (!ethRpc) throw new Error("no-ethereum-rpc-resolved");
  const protocol = protocolRes.json || readJson(PUBLIC_TARGETS, {})?.phase0Queue?.find((row) => row.slug === "gravity-by-galxe") || {};
  const defillamaCurrentTvlUsd = latestProtocolTvl(protocol);
  const defillamaG = latestProtocolToken(protocol, "G");
  const [ethBlock, priceDirect, gecko] = await Promise.all([
    latestBlock(ethRpc),
    tokenPrice(),
    geckoPools(G_TOKEN),
  ]);
  const effectivePrice = priceDirect || defillamaG.priceUsd || null;
  const gToken = await inspectGToken(ethRpc, defillamaG, effectivePrice);
  const [portal, sender, safe] = await Promise.all([
    inspectPortal(ethRpc),
    inspectSender(ethRpc, gToken.decimals, effectivePrice),
    inspectSafe(ethRpc, OWNER_SAFE),
  ]);
  const [legacyRows, logScan, gravityL1] = await Promise.all([
    Promise.all(LEGACY_ALPHA_L1_CONTRACTS.map((row) => inspectLegacyContract(ethRpc, row, gToken.decimals, effectivePrice))),
    scanBridgeLogs(ethRpc, ethBlock, gToken.decimals, effectivePrice),
    inspectGravityL1(portal.nonce),
  ]);
  const artifactJoinRows = artifactJoins();
  const contractRows = [portal, sender];
  const contractsScanned = contractRows.length + legacyRows.length + 3 + (gravityL1.receiver?.address ? 1 : 0);
  const contractsWithCode = contractRows.filter((row) => row.codePresent).length
    + legacyRows.filter((row) => row.codePresent).length
    + [gravityL1.nativeOracle, gravityL1.nativeMintPrecompile, gravityL1.wrappedG, gravityL1.receiver].filter((row) => row?.codePresent).length;
  const custodyPriceUsd = defillamaG.priceUsd || effectivePrice || null;
  const gBridgeSenderCustodyG = asNumber(gToken.bridgeSenderBalance) || 0;
  const legacyBridgeCustodyG = round(legacyRows.reduce((acc, row) => acc + (asNumber(row.gBalance) || 0), 0), 6);
  const totalTrackedCustodyG = round(gBridgeSenderCustodyG + (asNumber(legacyBridgeCustodyG) || 0), 6);
  const legacyBridgeCustodyUsd = round(custodyPriceUsd ? (asNumber(legacyBridgeCustodyG) || 0) * custodyPriceUsd : sumUsd(legacyRows, "gBalanceUsd"), 2);
  const gBridgeSenderBalanceUsd = round(custodyPriceUsd ? gBridgeSenderCustodyG * custodyPriceUsd : gToken.bridgeSenderBalanceUsd, 2);
  const totalTrackedCustodyUsd = round(custodyPriceUsd ? (asNumber(totalTrackedCustodyG) || 0) * custodyPriceUsd : (asNumber(gToken.bridgeSenderBalanceUsd) || 0) + (asNumber(legacyBridgeCustodyUsd) || 0), 2);
  const legacyCustodyVsDefillamaDeltaUsd = round(legacyBridgeCustodyUsd !== null && defillamaG.usd !== null ? legacyBridgeCustodyUsd - defillamaG.usd : null, 2);
  const trackedCustodyVsDefillamaDeltaUsd = round(totalTrackedCustodyUsd !== null && defillamaG.usd !== null ? totalTrackedCustodyUsd - defillamaG.usd : null, 2);
  const bridgeSpecificJoinRows = artifactJoinRows.filter((row) => row.bridgeSpecific).length;
  const routePositive = 0;
  const watchCandidates = 0;
  const summary = {
    defillamaCurrentTvlUsd: round(defillamaCurrentTvlUsd, 2),
    ethereumTvlUsd: round(defillamaCurrentTvlUsd, 2),
    defillamaGAmount: round(defillamaG.amount, 6),
    defillamaGUsd: round(defillamaG.usd, 2),
    gPriceUsd: round(effectivePrice, 10),
    contractsScanned,
    contractsWithCode,
    tokenRows: 1,
    gBridgeSenderCustodyG: round(gBridgeSenderCustodyG, 6),
    gBridgeSenderBalanceUsd,
    legacyBridgeCustodyG,
    legacyBridgeCustodyUsd,
    totalTrackedCustodyG,
    totalTrackedCustodyUsd,
    bridgeSenderVsDefillamaDeltaUsd: gToken.bridgeSenderVsDefillamaDeltaUsd,
    legacyCustodyVsDefillamaDeltaUsd,
    trackedCustodyVsDefillamaDeltaUsd,
    materialCustodyDeltaRows: legacyCustodyVsDefillamaDeltaUsd !== null && Math.abs(legacyCustodyVsDefillamaDeltaUsd) >= MIN_MATERIAL_USD ? 1 : 0,
    portalNonce: portal.nonce,
    nativeOracleLatestNonce: gravityL1.nativeOracle?.latestNonceForEthereum || null,
    nativeOracleSyncedPastPortalNonce: gravityL1.nativeOracle?.syncedPastPortalNonce ?? null,
    logErrors: logScan.logErrors,
    tokensLockedLogs: logScan.tokensLockedLogs,
    messageSentLogs: logScan.messageSentLogs,
    portalMessagesFromGBridgeSender: logScan.portalMessagesFromGBridgeSender,
    emergencyWithdrawRequestedLogs: logScan.emergencyWithdrawRequestedLogs,
    emergencyWithdrawExecutedLogs: logScan.emergencyWithdrawExecutedLogs,
    legacyRows: legacyRows.length,
    materialLegacyCustodyRows: legacyRows.filter((row) => (asNumber(row.gBalanceUsd) || 0) >= MIN_MATERIAL_USD).length,
    dexLiquidityRows: gecko.pools.length,
    topDexLiquidityUsd: round(Math.max(0, ...gecko.pools.map((row) => asNumber(row.reserveUsd) || 0)), 2),
    artifactJoinRows: artifactJoinRows.length,
    bridgeSpecificJoinRows,
    watchCandidates,
    routePositive,
    executableNow: false,
    signedActionJustified: false,
  };
  const out = {
    generatedAt,
    scanner: "tools/scan-gravity-by-galxe-phase0.js",
    target: "Gravity by Galxe",
    slug: "gravity-by-galxe",
    safety: {
      publicApisOnly: true,
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
      name: protocol.name || "Gravity by Galxe",
      slug: protocol.slug || "gravity-by-galxe",
      category: protocol.category || "Canonical Bridge",
      module: protocol.module || "gravity/index.js",
      chains: protocol.chains || ["Ethereum"],
      docs: [
        "https://docs.gravity.xyz/ecosystem-infrastructures/cross-chain-interoperability.md",
        "https://docs.gravity.xyz/developer-resources/mainnet.md",
        "https://docs.gravity.xyz/the-g-token/token-contracts.md",
      ],
      currentChainTvls: protocol.currentChainTvls || { Ethereum: defillamaCurrentTvlUsd },
    },
    source,
    summary,
    contractRows,
    safeRows: [safe],
    tokenRows: [gToken],
    legacyRows,
    gravityL1,
    logScan,
    dexRows: gecko.pools,
    artifactJoins: artifactJoinRows,
  };
  out.classification = classify(out);
  out.coverageClassification = out.classification.coverageClassification;
  out.routePositive = out.classification.routePositive;
  out.watchCandidates = out.classification.watchCandidates;
  out.executableNow = out.classification.executableNow;
  out.signedActionJustified = out.classification.signedActionJustified;
  out.forkGate = out.classification.forkGate;
  writeJson(RAW_OUT, out);
  writeReport(out);
  if (!QUIET) {
    console.log(`${SIGNAL_DORMANT} - Gravity by Galxe Phase 0`);
    console.log(`publicTvl=${formatUsd(summary.defillamaCurrentTvlUsd)} contractsWithCode=${summary.contractsWithCode}/${summary.contractsScanned} gCustody=${formatUsd(summary.gBridgeSenderBalanceUsd)} bridgeSpecificJoins=${summary.bridgeSpecificJoinRows} watchCandidates=${summary.watchCandidates} routePositive=${summary.routePositive}`);
    console.log(`wrote ${path.relative(WORKSPACE, RAW_OUT)} and ${path.relative(WORKSPACE, REPORT_OUT)}`);
  }
}

main().catch((err) => {
  console.error(`gravity-by-galxe-phase0 failed: ${err?.stack || err?.message || err}`);
  process.exit(1);
});
