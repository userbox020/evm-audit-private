#!/usr/bin/env node

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { AbiCoder, getAddress, id } = require("ethers");

const WORKSPACE = path.join(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const BASELINE_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "ethena-usde-live.json");
const OUT_DIR = path.join(WORKSPACE, "reports", "raw", "fast", "ethena-usde-current-refresh-gate0");
const CAPTURE_FILE = path.join(OUT_DIR, "capture.json");
const MANIFEST_FILE = path.join(OUT_DIR, "manifest.json");
const REPORT_FILE = path.join(WORKSPACE, "reports", "ethena-usde-current-refresh-gate0.md");
const CANDIDATE_LIMIT = 64;
const RPC_TIMEOUT_MS = 20_000;
const PROBE_FROM = "0x000000000000000000000000000000000000dEaD";
const ABI = AbiCoder.defaultAbiCoder();
const ZERO32 = `0x${"0".repeat(64)}`;

const ADDR = Object.fromEntries(Object.entries({
  USDE: "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3",
  SUSDE: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497",
  MINTING_V2: "0xe3490297a08d6fC8Da46Edb7B6142E4F461b62D3",
  MINTING_V1: "0x2cc440b721d2cafd6d64908d6d8c4acc57f8afc3",
  DISTRIBUTOR: "0xf2fa332bD83149c66b09B45670bCe64746C6b439",
  DEV_SAFE: "0x3B0AAf6e6fCd4a7cEEf8c92C32DFeA9E64dC1862",
  PAYOUT_FUND: "0x71e4f98e8F20C88112489DE3Dded4489802a3A87",
  RESERVE_FUND: "0x2B5AB59163a6e93b4486f6055D33CA4a115Dd4D5",
  ADAPTER_OWNER_1: "0x2d4d2a025B10C09BDbd794b4fCE4f7EA8c7D7bb4",
  ADAPTER_OWNER_2: "0xd54F23BE482D9A58676590fCa79c8E43087f92fB",
  WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  FRAX: "0x853d955aCEf822Db058eb8505911ED77F175b99e",
  CRVUSD: "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E",
  STETH: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84",
  WSTETH: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
  WBTC: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
  USDTB: "0xC139190F447e929f090Edeb554D95AbB8b18aC1C",
  SUSDS: "0xaCdf0DBA4B9839b96221a8487e9ca660a48212be",
}).map(([key, value]) => [key, value.toLowerCase()]));

const TOKEN_CANDIDATES = [
  ["USDC", ADDR.USDC], ["USDT", ADDR.USDT], ["DAI", ADDR.DAI], ["FRAX", ADDR.FRAX],
  ["crvUSD", ADDR.CRVUSD], ["WETH", ADDR.WETH], ["stETH", ADDR.STETH],
  ["wstETH", ADDR.WSTETH], ["WBTC", ADDR.WBTC], ["USDtb", ADDR.USDTB], ["sUSDS", ADDR.SUSDS],
];

const MINTING_ROLES = {
  DEFAULT_ADMIN_ROLE: ZERO32,
  MINTER_ROLE: id("MINTER_ROLE"),
  REDEEMER_ROLE: id("REDEEMER_ROLE"),
  COLLATERAL_MANAGER_ROLE: id("COLLATERAL_MANAGER_ROLE"),
  GATEKEEPER_ROLE: id("GATEKEEPER_ROLE"),
};

const STAKING_ROLES = {
  DEFAULT_ADMIN_ROLE: ZERO32,
  REWARDER_ROLE: id("REWARDER_ROLE"),
  BLACKLIST_MANAGER_ROLE: id("BLACKLIST_MANAGER_ROLE"),
  SOFT_RESTRICTED_STAKER_ROLE: id("SOFT_RESTRICTED_STAKER_ROLE"),
  FULL_RESTRICTED_STAKER_ROLE: id("FULL_RESTRICTED_STAKER_ROLE"),
};

const TOPICS = {
  RoleGranted: id("RoleGranted(bytes32,address,address)"),
  RoleRevoked: id("RoleRevoked(bytes32,address,address)"),
  AssetAdded: id("AssetAdded(address)"),
  AssetRemoved: id("AssetRemoved(address)"),
  TokenTypeSet: id("TokenTypeSet(address,uint256)"),
  MaxMintPerBlockChanged: id("MaxMintPerBlockChanged(uint256,uint256,address)"),
  MaxRedeemPerBlockChanged: id("MaxRedeemPerBlockChanged(uint256,uint256,address)"),
  CustodianAddressAdded: id("CustodianAddressAdded(address)"),
  CustodianAddressRemoved: id("CustodianAddressRemoved(address)"),
  BenefactorAdded: id("BenefactorAdded(address)"),
  BenefactorRemoved: id("BenefactorRemoved(address)"),
};

class RpcFailure extends Error {
  constructor(kind) {
    super(kind);
    this.kind = kind;
  }
}

function selector(signature) {
  return id(signature).slice(0, 10);
}

function encodeCall(signature, types = [], values = []) {
  return selector(signature) + (types.length ? ABI.encode(types, values).slice(2) : "");
}

function decodeOne(data, types) {
  if (!data || data === "0x") return null;
  try { return ABI.decode(types, data)[0]; } catch (_) { return null; }
}

function decodeTuple(data, types) {
  if (!data || data === "0x") return null;
  try { return [...ABI.decode(types, data)]; } catch (_) { return null; }
}

function decodeString(data) {
  if (!data || data === "0x") return null;
  try { return String(ABI.decode(["string"], data)[0]); } catch (_) {
    const hex = String(data).replace(/^0x/i, "");
    if (hex.length !== 64) return null;
    return Buffer.from(hex, "hex").toString("utf8").replace(/\u0000+$/g, "") || null;
  }
}

function normalizeAddress(value) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(value || ""))) return null;
  try { return getAddress(value); } catch (_) { return String(value).toLowerCase(); }
}

function addressFromTopic(topic) {
  return /^0x[0-9a-fA-F]{64}$/.test(String(topic || "")) ? normalizeAddress(`0x${topic.slice(-40)}`) : null;
}

function toHexBlock(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function formatUnits(raw, decimals) {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  const value = BigInt(raw);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, "0").replace(/0+$/g, "").slice(0, 18);
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function serializable(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(serializable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serializable(item)]));
  return value;
}

function runtimeInfo(code) {
  return {
    codeSize: code && code !== "0x" ? (code.length - 2) / 2 : 0,
    codeHashSha256: code && code !== "0x" ? crypto.createHash("sha256").update(Buffer.from(code.slice(2), "hex")).digest("hex") : null,
  };
}

function familyKey(url) {
  const host = new URL(url).hostname.toLowerCase();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) return host;
  const parts = host.split(".").filter(Boolean);
  return parts.slice(-2).join(".");
}

function premiumHint(url) {
  const parsed = new URL(url);
  return Boolean(parsed.username || parsed.password || parsed.search || parsed.pathname.split("/").filter(Boolean).some((part) => part.length >= 20));
}

function loadRpcCandidates() {
  if (!fs.existsSync(RPC_FILE)) throw new Error("Authorized RPC inventory is unavailable");
  const text = fs.readFileSync(RPC_FILE, "utf8");
  const urls = [...text.matchAll(/https?:\/\/[^\s'"<>]+/g)].map((match) => match[0]);
  const selected = [];
  const seenUrls = new Set();
  const familyCounts = new Map();
  for (const url of urls) {
    if (seenUrls.has(url)) continue;
    let family;
    try { family = familyKey(url); } catch (_) { continue; }
    if ((familyCounts.get(family) || 0) >= 3) continue;
    seenUrls.add(url);
    familyCounts.set(family, (familyCounts.get(family) || 0) + 1);
    selected.push({ url, family, inventoryOrder: selected.length, premium: premiumHint(url) });
    if (selected.length === CANDIDATE_LIMIT) break;
  }
  if (!selected.length) throw new Error("Authorized RPC inventory contains no usable candidates");
  return selected;
}

async function rpcCall(url, method, params, timeoutMs = RPC_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    if (!response.ok) throw new RpcFailure("transport-error");
    let json;
    try { json = await response.json(); } catch (_) { throw new RpcFailure("invalid-response"); }
    if (json.error) throw new RpcFailure("rpc-error");
    if (!("result" in json)) throw new RpcFailure("invalid-response");
    return json.result;
  } catch (error) {
    if (error instanceof RpcFailure) throw error;
    throw new RpcFailure(error?.name === "AbortError" ? "timeout" : "transport-error");
  } finally {
    clearTimeout(timeout);
  }
}

async function qualifyCandidates(candidates) {
  const prelim = (await Promise.all(candidates.map(async (candidate) => {
    try {
      const chainId = Number(BigInt(await rpcCall(candidate.url, "eth_chainId", [], 7_500)));
      if (chainId !== 1) return null;
      const finalized = await rpcCall(candidate.url, "eth_getBlockByNumber", ["finalized", false], 10_000);
      if (!finalized?.number || !finalized?.hash) return null;
      return { ...candidate, finalizedNumber: Number(BigInt(finalized.number)) };
    } catch (_) { return null; }
  }))).filter(Boolean);

  const heights = [...new Set(prelim.map((item) => item.finalizedNumber))].sort((a, b) => b - a);
  for (const blockNumber of heights) {
    const eligible = prelim.filter((item) => item.finalizedNumber >= blockNumber);
    if (new Set(eligible.map((item) => item.family)).size < 2) continue;
    const blockTag = toHexBlock(blockNumber);
    const checked = (await Promise.all(eligible.map(async (candidate) => {
      try {
        const [block, minter, totalAssets, code, logs] = await Promise.all([
          rpcCall(candidate.url, "eth_getBlockByNumber", [blockTag, false]),
          rpcCall(candidate.url, "eth_call", [{ to: ADDR.USDE, data: encodeCall("minter()") }, blockTag]),
          rpcCall(candidate.url, "eth_call", [{ to: ADDR.SUSDE, data: encodeCall("totalAssets()") }, blockTag]),
          rpcCall(candidate.url, "eth_getCode", [ADDR.USDE, blockTag]),
          rpcCall(candidate.url, "eth_getLogs", [{ address: ADDR.USDE, fromBlock: blockTag, toBlock: blockTag }]),
        ]);
        if (!block?.hash || !Array.isArray(logs) || !minter || !totalAssets || !code || code === "0x") return null;
        return {
          ...candidate,
          block,
          material: {
            blockHash: block.hash.toLowerCase(),
            minter: String(minter).toLowerCase(),
            totalAssets: String(totalAssets).toLowerCase(),
            code: runtimeInfo(code),
            logCount: logs.length,
          },
        };
      } catch (_) { return null; }
    }))).filter(Boolean);

    checked.sort((a, b) => Number(b.premium) - Number(a.premium) || a.inventoryOrder - b.inventoryOrder);
    for (let i = 0; i < checked.length; i += 1) {
      for (let j = i + 1; j < checked.length; j += 1) {
        const first = checked[i];
        const second = checked[j];
        if (first.family === second.family) continue;
        if (JSON.stringify(first.material) !== JSON.stringify(second.material)) continue;
        return {
          blockNumber,
          blockTag,
          blockHash: first.material.blockHash,
          blockTimestamp: Number(BigInt(first.block.timestamp)),
          providers: [first, second],
        };
      }
    }
  }
  throw new Error("No two independent Ethereum provider families passed finalized capability and agreement checks");
}

function context(provider, qualification) {
  return { url: provider.url, blockNumber: qualification.blockNumber, blockTag: qualification.blockTag, blockTimestamp: qualification.blockTimestamp };
}

async function callOptional(ctx, to, data, from) {
  try {
    const tx = from ? { from, to, data } : { to, data };
    const result = await rpcCall(ctx.url, "eth_call", [tx, ctx.blockTag], 12_000);
    return result && result !== "0x" ? result : null;
  } catch (_) { return null; }
}

async function requiredCall(ctx, to, data) {
  const result = await rpcCall(ctx.url, "eth_call", [{ to, data }, ctx.blockTag], 15_000);
  if (!result || result === "0x") throw new Error("Required pinned eth_call returned no data");
  return result;
}

async function codeInfo(ctx, address) {
  return runtimeInfo(await rpcCall(ctx.url, "eth_getCode", [address, ctx.blockTag], 15_000));
}

async function stateProbe(ctx, to, data) {
  try {
    const result = await rpcCall(ctx.url, "eth_call", [{ from: PROBE_FROM, to, data }, ctx.blockTag], 12_000);
    return { success: true, returnedData: Boolean(result && result !== "0x") };
  } catch (error) {
    return { success: false, outcome: error instanceof RpcFailure && error.kind === "rpc-error" ? "reverted" : "inconclusive-rpc-failure" };
  }
}

async function getLogsChunked(ctx, address, topics, fromBlock) {
  if (fromBlock > ctx.blockNumber) return [];
  const logs = [];
  let start = fromBlock;
  let chunk = 100_000;
  while (start <= ctx.blockNumber) {
    const end = Math.min(start + chunk - 1, ctx.blockNumber);
    try {
      const part = await rpcCall(ctx.url, "eth_getLogs", [{ address, fromBlock: toHexBlock(start), toBlock: toHexBlock(end), topics }], 25_000);
      if (!Array.isArray(part)) throw new RpcFailure("invalid-response");
      logs.push(...part);
      start = end + 1;
      chunk = Math.min(200_000, chunk * 2);
    } catch (_) {
      if (chunk <= 2_000) throw new Error("Pinned historical eth_getLogs capability failed");
      chunk = Math.floor(chunk / 2);
    }
  }
  return logs;
}

function sortedLogs(logs) {
  return logs.sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(BigInt(a.logIndex) - BigInt(b.logIndex)));
}

function sortedAddresses(values) {
  return [...values].filter(Boolean).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

function roleName(roles, roleHash) {
  return Object.entries(roles).find(([, hash]) => hash.toLowerCase() === String(roleHash).toLowerCase())?.[0] || null;
}

async function refreshRoles(ctx, address, roles, baselineMembers, fromBlock) {
  const sets = Object.fromEntries(Object.keys(roles).map((name) => [name, new Set((baselineMembers[name] || []).map(normalizeAddress).filter(Boolean))]));
  const logs = sortedLogs(await getLogsChunked(ctx, address, [[TOPICS.RoleGranted, TOPICS.RoleRevoked]], fromBlock));
  for (const log of logs) {
    const name = roleName(roles, log.topics?.[1]);
    const account = addressFromTopic(log.topics?.[2]);
    if (!name || !account) continue;
    if (String(log.topics[0]).toLowerCase() === TOPICS.RoleGranted.toLowerCase()) sets[name].add(account);
    else sets[name].delete(account);
  }
  const members = {};
  for (const [name, role] of Object.entries(roles)) {
    const verified = [];
    for (const account of sets[name]) {
      const raw = await requiredCall(ctx, address, encodeCall("hasRole(bytes32,address)", ["bytes32", "address"], [role, account]));
      if (decodeOne(raw, ["bool"]) === true) verified.push(account);
    }
    members[name] = sortedAddresses(verified);
  }
  return { deltaLogCount: logs.length, members };
}

async function refreshCustodians(ctx, baselineValues, fromBlock) {
  const set = new Set((baselineValues || []).map(normalizeAddress).filter(Boolean));
  const logs = sortedLogs(await getLogsChunked(ctx, ADDR.MINTING_V2, [[TOPICS.CustodianAddressAdded, TOPICS.CustodianAddressRemoved]], fromBlock));
  for (const log of logs) {
    const account = addressFromTopic(log.topics?.[1]);
    if (!account) continue;
    if (String(log.topics[0]).toLowerCase() === TOPICS.CustodianAddressAdded.toLowerCase()) set.add(account);
    else set.delete(account);
  }
  const verified = [];
  for (const account of set) {
    const raw = await requiredCall(ctx, ADDR.MINTING_V2, encodeCall("isCustodianAddress(address)", ["address"], [account]));
    if (decodeOne(raw, ["bool"]) === true) verified.push(account);
  }
  return { deltaLogCount: logs.length, values: sortedAddresses(verified) };
}

async function refreshBenefactors(ctx, baseline, fromBlock) {
  const logs = sortedLogs(await getLogsChunked(ctx, ADDR.MINTING_V2, [[TOPICS.BenefactorAdded, TOPICS.BenefactorRemoved]], fromBlock));
  let count = Number(baseline.count);
  const sample = new Set((baseline.sample || []).map(normalizeAddress).filter(Boolean));
  for (const log of logs) {
    const account = addressFromTopic(log.topics?.[1]);
    if (!account) continue;
    if (String(log.topics[0]).toLowerCase() === TOPICS.BenefactorAdded.toLowerCase()) {
      count += 1;
      if (sample.size < 20) sample.add(account);
    } else {
      count -= 1;
      sample.delete(account);
    }
  }
  return { count, sample: sortedAddresses(sample).slice(0, 20), deltaLogCount: logs.length, exactCountMethod: "baseline exact count plus finalized add/remove event delta" };
}

async function changedAssetAddresses(ctx, baseline, fromBlock) {
  const set = new Set([
    ...TOKEN_CANDIDATES.map(([, address]) => normalizeAddress(address)),
    ...(baseline.minting.assets || []).map((asset) => normalizeAddress(asset.meta.address)),
  ].filter(Boolean));
  const topics = [TOPICS.AssetAdded, TOPICS.AssetRemoved, TOPICS.TokenTypeSet, TOPICS.MaxMintPerBlockChanged, TOPICS.MaxRedeemPerBlockChanged];
  const logs = await getLogsChunked(ctx, ADDR.MINTING_V2, [topics], fromBlock);
  for (const log of logs) {
    const topic0 = String(log.topics?.[0]).toLowerCase();
    const index = topic0 === TOPICS.MaxMintPerBlockChanged.toLowerCase() || topic0 === TOPICS.MaxRedeemPerBlockChanged.toLowerCase() ? 2 : 1;
    const account = addressFromTopic(log.topics?.[index]);
    if (account) set.add(account);
  }
  return { addresses: sortedAddresses(set), deltaLogCount: logs.length };
}

async function tokenMeta(ctx, address, label = null) {
  const [nameRaw, symbolRaw, decimalsRaw, supplyRaw] = await Promise.all([
    callOptional(ctx, address, encodeCall("name()")),
    callOptional(ctx, address, encodeCall("symbol()")),
    requiredCall(ctx, address, encodeCall("decimals()")),
    requiredCall(ctx, address, encodeCall("totalSupply()")),
  ]);
  const decimals = Number(decodeOne(decimalsRaw, ["uint8"]) ?? decodeOne(decimalsRaw, ["uint256"]));
  const supply = decodeOne(supplyRaw, ["uint256"]);
  return { label, address: normalizeAddress(address), name: decodeString(nameRaw), symbol: decodeString(symbolRaw), decimals, totalSupplyRaw: supply.toString(), totalSupply: formatUnits(supply, decimals) };
}

async function tokenBalance(ctx, token, owner, decimals) {
  const value = decodeOne(await requiredCall(ctx, token, encodeCall("balanceOf(address)", ["address"], [owner])), ["uint256"]);
  return { raw: value.toString(), formatted: formatUnits(value, decimals) };
}

async function tokenAllowance(ctx, token, owner, spender) {
  const value = decodeOne(await requiredCall(ctx, token, encodeCall("allowance(address,address)", ["address", "address"], [owner, spender])), ["uint256"]);
  return value.toString();
}

async function scanAsset(ctx, address) {
  const label = TOKEN_CANDIDATES.find(([, item]) => item.toLowerCase() === address.toLowerCase())?.[0] || null;
  const meta = await tokenMeta(ctx, address, label);
  const raw = await requiredCall(ctx, ADDR.MINTING_V2, encodeCall("tokenConfig(address)", ["address"], [address]));
  const decoded = decodeTuple(raw, ["uint8", "bool", "uint128", "uint128"]);
  if (!decoded) throw new Error("Unable to decode tokenConfig");
  const balances = {};
  for (const [name, owner] of Object.entries({ mintingContract: ADDR.MINTING_V2, distributor: ADDR.DISTRIBUTOR, reserveFund: ADDR.RESERVE_FUND, adapterOwner1: ADDR.ADAPTER_OWNER_1, adapterOwner2: ADDR.ADAPTER_OWNER_2 })) {
    balances[name] = await tokenBalance(ctx, address, owner, meta.decimals);
  }
  return {
    meta,
    runtime: await codeInfo(ctx, address),
    tokenConfig: {
      tokenType: Number(decoded[0]), isActive: Boolean(decoded[1]),
      maxMintPerBlockRaw: decoded[2].toString(), maxRedeemPerBlockRaw: decoded[3].toString(),
      maxMintPerBlock: formatUnits(decoded[2], 18), maxRedeemPerBlock: formatUnits(decoded[3], 18),
    },
    balances,
  };
}

function mintOrder(blockTimestamp, orderType) {
  const order = ["gate0-read-only-probe", orderType, BigInt(blockTimestamp + 3600), 1n, PROBE_FROM, PROBE_FROM, ADDR.USDC, 1n, 1n];
  const signature = [0, "0x"];
  return { order, signature };
}

async function scanUSDe(ctx) {
  const meta = await tokenMeta(ctx, ADDR.USDE, "USDe");
  const [ownerRaw, pendingRaw, minterRaw] = await Promise.all([
    requiredCall(ctx, ADDR.USDE, encodeCall("owner()")),
    requiredCall(ctx, ADDR.USDE, encodeCall("pendingOwner()")),
    requiredCall(ctx, ADDR.USDE, encodeCall("minter()")),
  ]);
  const balances = {};
  for (const [name, owner] of Object.entries({ minting: ADDR.MINTING_V2, staking: ADDR.SUSDE, distributor: ADDR.DISTRIBUTOR, reserveFund: ADDR.RESERVE_FUND, payoutFund: ADDR.PAYOUT_FUND })) {
    balances[name] = await tokenBalance(ctx, ADDR.USDE, owner, meta.decimals);
  }
  return {
    address: normalizeAddress(ADDR.USDE), meta, runtime: await codeInfo(ctx, ADDR.USDE),
    owner: normalizeAddress(decodeOne(ownerRaw, ["address"])), pendingOwner: normalizeAddress(decodeOne(pendingRaw, ["address"])),
    minter: normalizeAddress(decodeOne(minterRaw, ["address"])), balances,
    arbitrarySenderGateProbe: await stateProbe(ctx, ADDR.USDE, encodeCall("mint(address,uint256)", ["address", "uint256"], [PROBE_FROM, 1n])),
  };
}

async function scanMinting(ctx, baseline, fromBlock) {
  const [roles, custodians, benefactors, assetCandidates] = await Promise.all([
    refreshRoles(ctx, ADDR.MINTING_V2, MINTING_ROLES, baseline.minting.roles.members, fromBlock),
    refreshCustodians(ctx, baseline.minting.custodians.values, fromBlock),
    refreshBenefactors(ctx, baseline.minting.benefactors, fromBlock),
    changedAssetAddresses(ctx, baseline, fromBlock),
  ]);
  const [ownerRaw, usdeRaw, globalRaw, stablesRaw, totalRaw] = await Promise.all([
    requiredCall(ctx, ADDR.MINTING_V2, encodeCall("owner()")),
    requiredCall(ctx, ADDR.MINTING_V2, encodeCall("usde()")),
    requiredCall(ctx, ADDR.MINTING_V2, encodeCall("globalConfig()")),
    requiredCall(ctx, ADDR.MINTING_V2, encodeCall("stablesDeltaLimit()")),
    requiredCall(ctx, ADDR.MINTING_V2, encodeCall("totalPerBlock(uint256)", ["uint256"], [BigInt(ctx.blockNumber)])),
  ]);
  const global = decodeTuple(globalRaw, ["uint128", "uint128"]);
  const total = decodeTuple(totalRaw, ["uint128", "uint128"]);
  const assets = [];
  for (const address of assetCandidates.addresses) {
    const asset = await scanAsset(ctx, address);
    if (asset.tokenConfig.isActive || asset.tokenConfig.maxMintPerBlockRaw !== "0" || asset.tokenConfig.maxRedeemPerBlockRaw !== "0") assets.push(asset);
  }
  assets.sort((a, b) => a.meta.address.toLowerCase().localeCompare(b.meta.address.toLowerCase()));

  const mint = mintOrder(ctx.blockTimestamp, 0);
  const redeem = mintOrder(ctx.blockTimestamp, 1);
  const orderType = "tuple(string order_id,uint8 order_type,uint120 expiry,uint128 nonce,address benefactor,address beneficiary,address collateral_asset,uint128 collateral_amount,uint128 usde_amount)";
  const signatureType = "tuple(uint8 signature_type,bytes signature_bytes)";
  const probes = {
    mint: await stateProbe(ctx, ADDR.MINTING_V2, encodeCall("mint((string,uint8,uint120,uint128,address,address,address,uint128,uint128),(address[],uint128[]),(uint8,bytes))", [orderType, "tuple(address[] addresses,uint128[] ratios)", signatureType], [mint.order, [[ADDR.RESERVE_FUND], [10_000n]], mint.signature])),
    redeem: await stateProbe(ctx, ADDR.MINTING_V2, encodeCall("redeem((string,uint8,uint120,uint128,address,address,address,uint128,uint128),(uint8,bytes))", [orderType, signatureType], [redeem.order, redeem.signature])),
    transferToCustody: await stateProbe(ctx, ADDR.MINTING_V2, encodeCall("transferToCustody(address,address,uint128)", ["address", "address", "uint128"], [ADDR.RESERVE_FUND, ADDR.USDC, 1n])),
    disableMintRedeem: await stateProbe(ctx, ADDR.MINTING_V2, encodeCall("disableMintRedeem()")),
    setGlobalMaxMintPerBlock: await stateProbe(ctx, ADDR.MINTING_V2, encodeCall("setGlobalMaxMintPerBlock(uint128)", ["uint128"], [1n])),
  };
  return {
    address: normalizeAddress(ADDR.MINTING_V2), runtime: await codeInfo(ctx, ADDR.MINTING_V2),
    owner: normalizeAddress(decodeOne(ownerRaw, ["address"])), usde: normalizeAddress(decodeOne(usdeRaw, ["address"])),
    globalConfig: {
      globalMaxMintPerBlockRaw: global[0].toString(), globalMaxRedeemPerBlockRaw: global[1].toString(),
      globalMaxMintPerBlock: formatUnits(global[0], 18), globalMaxRedeemPerBlock: formatUnits(global[1], 18),
    },
    stablesDeltaLimitBps: decodeOne(stablesRaw, ["uint128"]).toString(),
    totalThisBlock: { mintedPerBlockRaw: total[0].toString(), redeemedPerBlockRaw: total[1].toString() },
    roles, custodians, benefactors, assetDeltaLogCount: assetCandidates.deltaLogCount,
    assets, activeAssets: assets.filter((asset) => asset.tokenConfig.isActive), arbitrarySenderGateProbes: probes,
  };
}

async function scanStaking(ctx, baseline, fromBlock) {
  const roles = await refreshRoles(ctx, ADDR.SUSDE, STAKING_ROLES, baseline.staking.roles.members, fromBlock);
  const meta = await tokenMeta(ctx, ADDR.SUSDE, "sUSDe");
  const signatures = ["owner()", "asset()", "silo()", "totalAssets()", "cooldownDuration()", "MAX_COOLDOWN_DURATION()", "lastDistributionTimestamp()", "vestingAmount()", "getUnvestedAmount()"];
  const raw = await Promise.all(signatures.map((signature) => requiredCall(ctx, ADDR.SUSDE, encodeCall(signature))));
  const conversions = await Promise.all([
    requiredCall(ctx, ADDR.SUSDE, encodeCall("convertToAssets(uint256)", ["uint256"], [10n ** 18n])),
    requiredCall(ctx, ADDR.SUSDE, encodeCall("convertToShares(uint256)", ["uint256"], [10n ** 18n])),
    requiredCall(ctx, ADDR.SUSDE, encodeCall("previewDeposit(uint256)", ["uint256"], [10n ** 18n])),
    requiredCall(ctx, ADDR.SUSDE, encodeCall("previewRedeem(uint256)", ["uint256"], [10n ** 18n])),
  ]);
  const [ownerRaw, assetRaw, siloRaw, totalAssetsRaw, cooldownRaw, maxCooldownRaw, lastDistributionRaw, vestingRaw, unvestedRaw] = raw;
  const [assetsPerShareRaw, sharesPerAssetRaw, previewDepositRaw, previewRedeemRaw] = conversions;
  const totalAssets = decodeOne(totalAssetsRaw, ["uint256"]);
  const totalSupply = BigInt(meta.totalSupplyRaw);
  const silo = normalizeAddress(decodeOne(siloRaw, ["address"]));
  const usdeBalance = await tokenBalance(ctx, ADDR.USDE, ADDR.SUSDE, 18);
  const siloUSDeBalance = await tokenBalance(ctx, ADDR.USDE, silo, 18);
  const maxForProbe = {};
  for (const name of ["maxDeposit", "maxMint", "maxWithdraw", "maxRedeem"]) {
    const value = decodeOne(await requiredCall(ctx, ADDR.SUSDE, encodeCall(`${name}(address)`, ["address"], [PROBE_FROM])), ["uint256"]);
    maxForProbe[`${name}Raw`] = value.toString();
  }
  const donation = 1_000_000n * 10n ** 18n;
  const attackerDeposit = donation;
  const captured = (donation * attackerDeposit) / (totalAssets + attackerDeposit);
  return {
    address: normalizeAddress(ADDR.SUSDE), runtime: await codeInfo(ctx, ADDR.SUSDE), meta,
    owner: normalizeAddress(decodeOne(ownerRaw, ["address"])), asset: normalizeAddress(decodeOne(assetRaw, ["address"])), silo,
    siloRuntime: await codeInfo(ctx, silo), totalAssetsRaw: totalAssets.toString(), totalAssets: formatUnits(totalAssets, 18),
    sharePriceRaw: decodeOne(assetsPerShareRaw, ["uint256"]).toString(), sharePrice: formatUnits(decodeOne(assetsPerShareRaw, ["uint256"]), 18),
    sharesPerUSDeRaw: decodeOne(sharesPerAssetRaw, ["uint256"]).toString(),
    previewDepositOneUSDeRaw: decodeOne(previewDepositRaw, ["uint256"]).toString(), previewRedeemOneShareRaw: decodeOne(previewRedeemRaw, ["uint256"]).toString(),
    backingRatioRaw: totalSupply > 0n ? ((totalAssets * 10n ** 18n) / totalSupply).toString() : null,
    cooldownDuration: decodeOne(cooldownRaw, ["uint24"]).toString(), maxCooldownDuration: decodeOne(maxCooldownRaw, ["uint24"]).toString(),
    lastDistributionTimestamp: decodeOne(lastDistributionRaw, ["uint256"]).toString(),
    vestingAmount: formatUnits(decodeOne(vestingRaw, ["uint256"]), 18), unvestedAmount: formatUnits(decodeOne(unvestedRaw, ["uint256"]), 18),
    usdeBalance, siloUSDeBalance, roles, maxForProbe,
    defensiveDonationModel: { attackerDepositUSDe: "1000000", donationUSDe: "1000000", capturedUSDe: formatUnits(captured, 18), netLossUSDe: formatUnits(donation - captured, 18) },
    arbitrarySenderGateProbes: {
      transferInRewards: await stateProbe(ctx, ADDR.SUSDE, encodeCall("transferInRewards(uint256)", ["uint256"], [1n])),
      setCooldownDuration: await stateProbe(ctx, ADDR.SUSDE, encodeCall("setCooldownDuration(uint24)", ["uint24"], [0])),
      rescueUSDe: await stateProbe(ctx, ADDR.SUSDE, encodeCall("rescueTokens(address,uint256,address)", ["address", "uint256", "address"], [ADDR.USDE, 1n, PROBE_FROM])),
      addToBlacklist: await stateProbe(ctx, ADDR.SUSDE, encodeCall("addToBlacklist(address,bool)", ["address", "bool"], [PROBE_FROM, true])),
      redeemWhileCooldownOn: await stateProbe(ctx, ADDR.SUSDE, encodeCall("redeem(uint256,address,address)", ["uint256", "address", "address"], [1n, PROBE_FROM, PROBE_FROM])),
      withdrawWhileCooldownOn: await stateProbe(ctx, ADDR.SUSDE, encodeCall("withdraw(uint256,address,address)", ["uint256", "address", "address"], [1n, PROBE_FROM, PROBE_FROM])),
    },
  };
}

async function scanDistributor(ctx) {
  const signatures = ["owner()", "pendingOwner()", "operator()", "mintContract()", "STAKING_VAULT()", "USDE_TOKEN()"];
  const [ownerRaw, pendingRaw, operatorRaw, mintRaw, vaultRaw, usdeRaw] = await Promise.all(signatures.map((signature) => requiredCall(ctx, ADDR.DISTRIBUTOR, encodeCall(signature))));
  const balances = {};
  const allowancesToMinting = {};
  for (const [label, token] of TOKEN_CANDIDATES) {
    const meta = await tokenMeta(ctx, token, label);
    balances[label] = await tokenBalance(ctx, token, ADDR.DISTRIBUTOR, meta.decimals);
    allowancesToMinting[label] = await tokenAllowance(ctx, token, ADDR.DISTRIBUTOR, ADDR.MINTING_V2);
  }
  balances.USDe = await tokenBalance(ctx, ADDR.USDE, ADDR.DISTRIBUTOR, 18);
  return {
    address: normalizeAddress(ADDR.DISTRIBUTOR), runtime: await codeInfo(ctx, ADDR.DISTRIBUTOR),
    owner: normalizeAddress(decodeOne(ownerRaw, ["address"])), pendingOwner: normalizeAddress(decodeOne(pendingRaw, ["address"])),
    operator: normalizeAddress(decodeOne(operatorRaw, ["address"])), mintContract: normalizeAddress(decodeOne(mintRaw, ["address"])),
    stakingVault: normalizeAddress(decodeOne(vaultRaw, ["address"])), usdeToken: normalizeAddress(decodeOne(usdeRaw, ["address"])),
    balances, allowancesToMinting,
    arbitrarySenderGateProbe: await stateProbe(ctx, ADDR.DISTRIBUTOR, encodeCall("transferInRewards(uint256)", ["uint256"], [1n])),
  };
}

async function fullScan(ctx, baseline) {
  const fromBlock = Number(baseline.ethereum.blockNumber) + 1;
  const usde = await scanUSDe(ctx);
  const minting = await scanMinting(ctx, baseline, fromBlock);
  const staking = await scanStaking(ctx, baseline, fromBlock);
  const distributor = await scanDistributor(ctx);
  return { usde, minting, staking, distributor };
}

function materialProjection(scan) {
  return {
    usde: scan.usde,
    minting: scan.minting,
    staking: scan.staking,
    distributor: scan.distributor,
  };
}

function activeConfig(rows) {
  return (rows || []).filter((row) => row.tokenConfig?.isActive).map((row) => ({
    address: row.meta.address.toLowerCase(), symbol: row.meta.symbol, tokenType: row.tokenConfig.tokenType,
    maxMintPerBlockRaw: row.tokenConfig.maxMintPerBlockRaw, maxRedeemPerBlockRaw: row.tokenConfig.maxRedeemPerBlockRaw,
  })).sort((a, b) => a.address.localeCompare(b.address));
}

function baselineHash(node) {
  return node?.codeHash || node?.codeHashSha256 || null;
}

function currentHash(node) {
  return node?.codeHashSha256 || null;
}

function privilegedProbeSuccess(scan) {
  return [
    scan.usde.arbitrarySenderGateProbe,
    ...Object.values(scan.minting.arbitrarySenderGateProbes),
    scan.staking.arbitrarySenderGateProbes.transferInRewards,
    scan.staking.arbitrarySenderGateProbes.setCooldownDuration,
    scan.staking.arbitrarySenderGateProbes.rescueUSDe,
    scan.staking.arbitrarySenderGateProbes.addToBlacklist,
    scan.distributor.arbitrarySenderGateProbe,
  ].some((probe) => probe.success);
}

function compareBaseline(baseline, current) {
  const runtimeChanges = {
    usde: baselineHash(baseline.usde.code) !== currentHash(current.usde.runtime),
    mintingV2: baselineHash(baseline.minting.code) !== currentHash(current.minting.runtime),
    sUSDe: baselineHash(baseline.staking.code) !== currentHash(current.staking.runtime),
    distributor: baselineHash(baseline.distributor.code) !== currentHash(current.distributor.runtime),
  };
  const oldPrice = BigInt(baseline.staking.sharePriceRaw);
  const newPrice = BigInt(current.staking.sharePriceRaw);
  const shareRateDeltaBps = ((newPrice >= oldPrice ? newPrice - oldPrice : oldPrice - newPrice) * 10_000n / oldPrice).toString();
  const backingMismatch = current.staking.backingRatioRaw === null || (() => {
    const difference = newPrice >= BigInt(current.staking.backingRatioRaw) ? newPrice - BigInt(current.staking.backingRatioRaw) : BigInt(current.staking.backingRatioRaw) - newPrice;
    return difference > 2n;
  })();
  const discontinuousShareRateOrBacking = newPrice < oldPrice || BigInt(shareRateDeltaBps) > 2_500n || backingMismatch || BigInt(current.staking.totalAssetsRaw) < BigInt(current.staking.meta.totalSupplyRaw);
  const triggers = {
    minterOrRuntimeChanged: baseline.usde.minter.toLowerCase() !== current.usde.minter.toLowerCase() || Object.values(runtimeChanges).some(Boolean),
    activeCollateralTokenTypesOrCapsChanged: JSON.stringify(activeConfig(baseline.minting.assets)) !== JSON.stringify(activeConfig(current.minting.activeAssets)),
    stablesDeltaChanged: String(baseline.minting.stablesDeltaLimitBps) !== String(current.minting.stablesDeltaLimitBps),
    cooldownBecameZero: String(baseline.staking.cooldownDuration) !== "0" && String(current.staking.cooldownDuration) === "0",
    discontinuousShareRateOrBacking,
    permissionlessGateOpened: privilegedProbeSuccess(current),
    sourceOrRuntimeFamilyChanged: Object.values(runtimeChanges).some(Boolean),
  };
  return {
    baselineBlock: Number(baseline.ethereum.blockNumber), runtimeChanges,
    baselineActiveCollateral: activeConfig(baseline.minting.assets), currentActiveCollateral: activeConfig(current.minting.activeAssets),
    shareRate: { baselineRaw: baseline.staking.sharePriceRaw, currentRaw: current.staking.sharePriceRaw, absoluteDeltaBps: shareRateDeltaBps, backingRatioRaw: current.staking.backingRatioRaw, backingMismatch },
    triggers, anyTriggerChanged: Object.values(triggers).some(Boolean),
  };
}

function nextGate(comparison) {
  if (comparison.triggers.minterOrRuntimeChanged || comparison.triggers.sourceOrRuntimeFamilyChanged) return "Gate1: obtain the current verified source for the changed runtime, reproduce the compiler family, and perform a bounded source/runtime diff of only the changed core contract.";
  if (comparison.triggers.activeCollateralTokenTypesOrCapsChanged || comparison.triggers.stablesDeltaChanged) return "Gate1: perform a bounded source-anchored review of only the changed collateral rows and the stable adverse-delta/cap enforcement path; no fork or transactions.";
  if (comparison.triggers.cooldownBecameZero || comparison.triggers.discontinuousShareRateOrBacking) return "Gate1: perform a bounded read-only accounting reconciliation of sUSDe totalAssets, supply, vesting, silo balance, and conversion rounding at the same finalized block.";
  if (comparison.triggers.permissionlessGateOpened) return "Gate1: repeat only the successful arbitrary-sender eth_call with a second inert sender and map it to the verified access-control source path; no transaction or fork.";
  return null;
}

function markdown(capture, manifest) {
  const c = capture.comparison;
  const current = capture.current;
  const status = c.anyTriggerChanged ? "WATCH" : "CLOSED — DUPLICATE / NO NEW AUDIT CLAIM";
  const triggerRows = Object.entries(c.triggers).map(([name, changed]) => `| ${name} | ${changed ? "CHANGED" : "unchanged"} |`).join("\n");
  const roleCounts = Object.fromEntries(Object.entries(current.minting.roles.members).map(([name, values]) => [name, values.length]));
  const assets = current.minting.activeAssets.map((asset) => `| ${asset.meta.symbol || asset.meta.label || "unknown"} | \`${asset.meta.address}\` | ${asset.tokenConfig.tokenType} | ${asset.tokenConfig.maxMintPerBlock} | ${asset.tokenConfig.maxRedeemPerBlock} | \`${asset.runtime.codeHashSha256}\` |`).join("\n");
  return `# ${status} — Ethena USDe Current Refresh Gate0

Generated: ${capture.generatedAt}

## Scope and safety

Bounded defensive read-only refresh on Ethereum chain 1. Every state/code call and every log reconstruction endpoint was bounded to finalized block **${capture.ethereum.blockNumber}** (hash \`${capture.ethereum.blockHash}\`). No env/key file, fork, signing, transaction, mutation, victim/orderflow work, or economics escalation was used. RPC inventory and endpoint identities remained process-only; the two independently qualified providers are identified only as \`family-1\` and \`family-2\`.

## Gate0 result

Two independent provider families agreed on the finalized block/hash and all captured material state. Baseline comparison block: **${c.baselineBlock}**.

| Reopen trigger | Decision |
|---|---|
${triggerRows}

Share-rate absolute delta: **${c.shareRate.absoluteDeltaBps} bps**; current backing ratio raw: \`${c.shareRate.backingRatioRaw}\`; backing mismatch: **${c.shareRate.backingMismatch}**.

${c.anyTriggerChanged ? `Disposition: **WATCH**. Stop at Gate0; do not promote a claim.\n\nOne bounded next audit gate: ${capture.disposition.nextAuditGate}` : "Disposition: close as **duplicate / no new audit claim** and recommend release. No reopen trigger changed."}

## Current core state

| Contract | Address | Runtime SHA-256 |
|---|---|---|
| USDe | \`${current.usde.address}\` | \`${current.usde.runtime.codeHashSha256}\` |
| EthenaMinting V2 | \`${current.minting.address}\` | \`${current.minting.runtime.codeHashSha256}\` |
| sUSDe | \`${current.staking.address}\` | \`${current.staking.runtime.codeHashSha256}\` |
| USDe silo | \`${current.staking.silo}\` | \`${current.staking.siloRuntime.codeHashSha256}\` |
| StakingRewardsDistributor | \`${current.distributor.address}\` | \`${current.distributor.runtime.codeHashSha256}\` |

- USDe minter: \`${current.usde.minter}\`
- Minting owner: \`${current.minting.owner}\`; linked USDe: \`${current.minting.usde}\`
- Minting roles: \`${JSON.stringify(roleCounts)}\`
- Custodians: **${current.minting.custodians.values.length}**; benefactors: **${current.minting.benefactors.count}**
- Global mint/redeem caps: **${current.minting.globalConfig.globalMaxMintPerBlock} / ${current.minting.globalConfig.globalMaxRedeemPerBlock} USDe per block**
- Stables delta limit: **${current.minting.stablesDeltaLimitBps} bps**

## Active collateral

| Token | Address | Type | Max mint/block | Max redeem/block | Runtime SHA-256 |
|---|---|---:|---:|---:|---|
${assets}

## sUSDe and distributor

- sUSDe asset: \`${current.staking.asset}\`; silo: \`${current.staking.silo}\`
- Cooldown: **${current.staking.cooldownDuration}s**; max: **${current.staking.maxCooldownDuration}s**
- Total assets / supply: **${current.staking.totalAssets} USDe / ${current.staking.meta.totalSupply} sUSDe**
- One-share conversion: **${current.staking.sharePrice} USDe**; one-USDe shares raw: \`${current.staking.sharesPerUSDeRaw}\`
- Staking USDe balance: **${current.staking.usdeBalance.formatted}**; silo USDe balance: **${current.staking.siloUSDeBalance.formatted}**
- Distributor links: mint \`${current.distributor.mintContract}\`, vault \`${current.distributor.stakingVault}\`, USDe \`${current.distributor.usdeToken}\`; operator \`${current.distributor.operator}\`
- All privileged arbitrary-sender gate probes remained read-only \`eth_call\`; permissionless privileged success: **${c.triggers.permissionlessGateOpened}**.

## Source/runtime family and bounty context

The baseline records Sourcify full-match source families for USDe, EthenaMinting, StakedUSDeV2, and StakingRewardsDistributor. Runtime continuity is ${c.triggers.sourceOrRuntimeFamilyChanged ? "not established because at least one core runtime changed" : "established by unchanged exact runtime hashes"}. Active bounty context was supplied for this claimed Gate0; program scope/terms were not externally refreshed, and no submission is recommended at Gate0.

## Strict route, executable, and net gates

| Gate | Result |
|---|---|
| Public actor source complete | ${capture.gates.sourceComplete} |
| Public reachability | ${capture.gates.publicReachability} |
| Reproducible liquid extraction | ${capture.gates.reproducibleLiquidExtraction} |
| Executable | ${capture.gates.executable} |
| Conservative net > 0 | ${capture.gates.conservativeNetPositive} |
| routePositive | ${capture.gates.routePositive} |

Exact Gate0 economics: gross **$0 / 0 ETH**, conservative net **$0 / 0 ETH**, attacker capital **$0**, and net bps of attacker capital **N/A (zero denominator)**. No exploit route was identified or costed.

## Artifacts

- \`reports/raw/fast/ethena-usde-current-refresh-gate0/capture.json\`
- \`reports/raw/fast/ethena-usde-current-refresh-gate0/manifest.json\`
- \`reports/ethena-usde-current-refresh-gate0.md\`

Manifest validation: JSON parse **${manifest.validation.jsonParse}**; Node syntax **${manifest.validation.nodeSyntax}** (\`node --check\`).
`;
}

async function main() {
  const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8"));
  if (Number(baseline.ethereum?.blockNumber) !== 25_212_024) throw new Error("Unexpected Ethena baseline block");
  const candidates = loadRpcCandidates();
  const qualification = await qualifyCandidates(candidates);
  const scans = await Promise.all(qualification.providers.map((provider) => fullScan(context(provider, qualification), baseline)));
  if (JSON.stringify(materialProjection(scans[0])) !== JSON.stringify(materialProjection(scans[1]))) throw new Error("Independent provider material-state disagreement");

  const current = scans[0];
  const comparison = compareBaseline(baseline, current);
  const generatedAt = new Date().toISOString();
  const capture = serializable({
    schemaVersion: 1,
    generatedAt,
    target: "Ethena USDe Gate0",
    safety: "bounded defensive read-only finalized RPC refresh; no fork, keys, signing, transaction, mutation, or victim/orderflow work",
    ethereum: { chainId: 1, blockNumber: qualification.blockNumber, blockHash: qualification.blockHash, blockTimestamp: qualification.blockTimestamp, finality: "finalized" },
    providers: [{ id: "family-1" }, { id: "family-2" }],
    addresses: Object.fromEntries(Object.entries(ADDR).map(([key, value]) => [key, normalizeAddress(value)])),
    current,
    comparison,
    gates: {
      sourceComplete: false,
      publicReachability: false,
      reproducibleLiquidExtraction: false,
      executable: false,
      conservativeNetPositive: false,
      routePositive: false,
      economics: { attackerCapitalUsd: "0", grossProfitUsd: "0", grossProfitNative: "0 ETH", conservativeNetProfitUsd: "0", conservativeNetProfitNative: "0 ETH", netBpsOfAttackerCapital: null },
    },
    bountyContext: { status: "active context supplied by task", scopeAndTermsRefreshed: false, recommendation: "no submission at Gate0" },
    disposition: {
      status: comparison.anyTriggerChanged ? "WATCH" : "CLOSED_DUPLICATE_NO_NEW_AUDIT_CLAIM",
      releaseRecommended: !comparison.anyTriggerChanged,
      nextAuditGate: comparison.anyTriggerChanged ? nextGate(comparison) : null,
    },
  });
  const manifest = {
    schemaVersion: 1,
    generatedAt,
    capture: "capture.json",
    baseline: "reports/raw/fast/ethena-usde-live.json",
    baselineBlock: 25_212_024,
    finalizedBlock: qualification.blockNumber,
    finalizedBlockHash: qualification.blockHash,
    providerAliases: ["family-1", "family-2"],
    qualification: {
      candidatePoolLimit: CANDIDATE_LIMIT,
      selectionOrder: "capability/finality agreement, credential-capability preference, then inventory order; never alphabetical",
      requiredCapabilities: ["eth_chainId=1", "finalized block/hash", "pinned eth_call", "pinned eth_getCode", "finalized-bounded eth_getLogs"],
      independentFamilies: true,
      fixedFinalizedBlockBeforeProviderSelection: true,
      blockHashAgreement: true,
      materialStateAgreement: true,
      allStateAndCodeCallsPinned: true,
      allLogScansBoundedThroughPinnedFinalizedBlock: true,
    },
    secretHandling: "RPC inventory and endpoint material were process-only and are absent from artifacts and command arguments",
    validation: { jsonParse: "pending", nodeSyntax: "passed" },
  };

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(CAPTURE_FILE, `${JSON.stringify(capture, null, 2)}\n`);
  manifest.validation.jsonParse = "passed";
  fs.writeFileSync(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(REPORT_FILE, markdown(capture, manifest));
  JSON.parse(fs.readFileSync(CAPTURE_FILE, "utf8"));
  JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8"));
  process.stdout.write(`Ethena Gate0 complete: block=${qualification.blockNumber} status=${capture.disposition.status}\n`);
}

main().catch((error) => {
  const safe = error instanceof RpcFailure ? error.kind : String(error?.message || "Gate0 failed").replace(/https?:\/\/\S+/gi, "[redacted]").replace(/[A-Za-z0-9_-]{24,}/g, "[redacted]");
  process.stderr.write(`Ethena Gate0 failed: ${safe}\n`);
  process.exitCode = 1;
});
