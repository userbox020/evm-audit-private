#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { AbiCoder, getAddress, id } = require("ethers");

const WORKSPACE = path.join(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "infinifi-live.json");
const LLAMA_PROTOCOL_URL = "https://api.llama.fi/protocol/infinifi";
const ADAPTER_URL = "https://raw.githubusercontent.com/DefiLlama/DefiLlama-Adapters/main/projects/infiniFi/index.js";
const ROOT_REGISTRY = "0x7A5C5dbA4fbD0e1e1A2eCDBe752fAe55f6E842B3";
const PROBE_FROM = "0x000000000000000000000000000000000000dEaD";
const ZERO = "0x0000000000000000000000000000000000000000";
const ZERO32 = "0x" + "0".repeat(64);
const RPC_TIMEOUT_MS = 20_000;
const ABI = AbiCoder.defaultAbiCoder();

const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const ROLE_NAMES = [
  "DEFAULT_ADMIN_ROLE",
  "GOVERNOR",
  "PAUSE",
  "UNPAUSE",
  "PROTOCOL_PARAMETERS",
  "MINOR_ROLES_MANAGER",
  "ENTRY_POINT",
  "RECEIPT_TOKEN_MINTER",
  "RECEIPT_TOKEN_BURNER",
  "GOVERNANCE_TOKEN_MINTER",
  "GOVERNANCE_TOKEN_BURNER",
  "LOCKED_TOKEN_MANAGER",
  "TRANSFER_RESTRICTOR",
  "FARM_MANAGER",
  "MANUAL_REBALANCER",
  "PERIODIC_REBALANCER",
  "EMERGENCY_WITHDRAWAL",
  "FARM_SWAP_CALLER",
  "ORACLE_MANAGER",
  "FINANCE_MANAGER",
  "PROPOSER_ROLE",
  "EXECUTOR_ROLE",
  "CANCELLER_ROLE",
  "OUTLAND_PORTAL",
  "OUTLAND_KEEPER",
  "ACCRUE_YIELD",
];

const ADDRESS_NAMES = [
  "USDC",
  "core",
  "farmRegistry",
  "accounting",
  "receiptToken",
  "stakedToken",
  "yieldSharing",
  "lockingController",
  "unwindingModule",
  "allocationVoting",
  "mintController",
  "redeemController",
  "afterMintHook",
  "beforeRedeemHook",
  "manualRebalancer",
  "gateway",
  "iUSD",
  "siUSD",
];

const FARM_TYPE_LABELS = { 0: "PROTOCOL", 1: "LIQUID", 2: "MATURITY" };

function sanitize(text) {
  return String(text || "").replace(/https?:\/\/\S+/g, "[redacted-url]");
}

function selector(signature) {
  return id(signature).slice(0, 10);
}

function encodeCall(signature, args = [], types = []) {
  return selector(signature) + (args.length ? ABI.encode(types, args).slice(2) : "");
}

function decodeTuple(data, types) {
  if (!data || data === "0x") return null;
  try {
    return [...ABI.decode(types, data)];
  } catch (_) {
    return null;
  }
}

function isAddress(value) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(value || ""));
}

function normalizeAddress(value) {
  if (!isAddress(value)) return null;
  try {
    return getAddress(value);
  } catch (_) {
    return String(value).toLowerCase();
  }
}

function addressFromWord(word) {
  if (!word || word === "0x") return null;
  const hex = String(word).replace(/^0x/i, "").padStart(64, "0");
  const raw = "0x" + hex.slice(-40);
  if (/^0x0{40}$/i.test(raw)) return null;
  return normalizeAddress(raw);
}

function bytes32ToString(value) {
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) return null;
  return Buffer.from(value.slice(2), "hex").toString("utf8").replace(/\u0000+$/g, "");
}

function bigintJson(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function sha256Hex(text) {
  return crypto.createHash("sha256").update(text || "").digest("hex");
}

function formatUnits(raw, decimals, maxFrac = 8) {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  const value = BigInt(raw);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const frac = value % scale;
  const fracText = frac.toString().padStart(Number(decimals), "0").replace(/0+$/g, "").slice(0, maxFrac);
  return fracText ? `${whole}.${fracText}` : whole.toString();
}

function bps(num, den) {
  if (!den || BigInt(den) === 0n) return null;
  return Number((BigInt(num || 0) * 10_000n) / BigInt(den));
}

async function fetchText(url, timeoutMs = 25_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: { "user-agent": "evm-audit-infinifi/1.0" }, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${sanitize(text.slice(0, 220))}`);
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url, timeoutMs = 25_000) {
  return JSON.parse(await fetchText(url, timeoutMs));
}

function extractRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
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
    const json = await response.json();
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    return json.result;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveEthereumRpc() {
  const candidates = [...extractRpcUrls(), "https://ethereum.publicnode.com", "https://rpc.ankr.com/eth"];
  const seen = new Set();
  for (const url of candidates) {
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      const chainId = Number(BigInt(await rpcCall(url, "eth_chainId", [], 5000)));
      if (chainId === 1) return url;
    } catch (_) {
      // Never print or store RPC URLs.
    }
  }
  throw new Error("No Ethereum RPC available");
}

async function callRaw(rpc, to, signature, args = [], types = [], block = "latest", from = undefined) {
  const tx = { to, data: encodeCall(signature, args, types) };
  if (from) tx.from = from;
  return rpcCall(rpc, "eth_call", [tx, block], 10_000);
}

async function callOptional(rpc, to, signature, args = [], types = [], retTypes = null, block = "latest", from = undefined) {
  if (!isAddress(to)) return { ok: false, value: null, raw: null, error: "BAD_ADDRESS" };
  try {
    const raw = await callRaw(rpc, to, signature, args, types, block, from);
    if (!raw || raw === "0x") return { ok: false, value: null, raw, error: "EMPTY" };
    const value = retTypes ? decodeTuple(raw, retTypes) : raw;
    if (retTypes && value === null) return { ok: false, value: null, raw, error: "DECODE" };
    return { ok: true, value, raw, error: null };
  } catch (err) {
    return { ok: false, value: null, raw: null, error: sanitize(err.message || err).slice(0, 180) };
  }
}

async function stateProbe(rpc, to, signature, args = [], types = [], value = undefined) {
  try {
    const tx = { from: PROBE_FROM, to, data: encodeCall(signature, args, types) };
    if (value !== undefined) tx.value = `0x${BigInt(value).toString(16)}`;
    const raw = await rpcCall(rpc, "eth_call", [tx, "latest"], 10_000);
    return { success: true, result: raw && raw.length > 66 ? `${raw.slice(0, 66)}...` : raw };
  } catch (err) {
    return { success: false, error: sanitize(err.message || err).slice(0, 180) };
  }
}

async function getBlock(rpc) {
  const blockNumber = Number(BigInt(await rpcCall(rpc, "eth_blockNumber", [])));
  const block = await rpcCall(rpc, "eth_getBlockByNumber", [`0x${blockNumber.toString(16)}`, false]);
  return { number: blockNumber, timestamp: Number(BigInt(block.timestamp)) };
}

async function getCodeSummary(rpc, address) {
  if (!isAddress(address)) return { address, codePresent: false, codeBytes: 0, codeHash: null };
  const [code, implSlot, adminSlot, beaconSlot] = await Promise.all([
    rpcCall(rpc, "eth_getCode", [address, "latest"]).catch(() => "0x"),
    rpcCall(rpc, "eth_getStorageAt", [address, IMPL_SLOT, "latest"]).catch(() => null),
    rpcCall(rpc, "eth_getStorageAt", [address, ADMIN_SLOT, "latest"]).catch(() => null),
    rpcCall(rpc, "eth_getStorageAt", [address, BEACON_SLOT, "latest"]).catch(() => null),
  ]);
  return {
    address: normalizeAddress(address),
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? (code.length - 2) / 2 : 0,
    codeHash: code && code !== "0x" ? sha256Hex(code) : null,
    eip1967Implementation: addressFromWord(implSlot),
    eip1967Admin: addressFromWord(adminSlot),
    eip1967Beacon: addressFromWord(beaconSlot),
  };
}

async function fetchMetadata() {
  const [protocolResult, adapterResult] = await Promise.allSettled([
    fetchJson(LLAMA_PROTOCOL_URL, 35_000),
    fetchText(ADAPTER_URL, 25_000),
  ]);
  const protocol = protocolResult.status === "fulfilled" ? summarizeLlama(protocolResult.value) : { error: sanitize(protocolResult.reason?.message || protocolResult.reason) };
  const adapterText = adapterResult.status === "fulfilled" ? adapterResult.value : null;
  return {
    protocol,
    adapter: adapterText
      ? {
          path: "projects/infiniFi/index.js",
          url: ADAPTER_URL,
          sha256: sha256Hex(adapterText),
          bytes: Buffer.byteLength(adapterText),
          registry: /registry\s*=\s*['"]([^'"]+)/.exec(adapterText)?.[1] || null,
        }
      : { path: "projects/infiniFi/index.js", error: sanitize(adapterResult.reason?.message || adapterResult.reason) },
  };
}

function summarizeLlama(protocol) {
  const latest = Array.isArray(protocol.tvl) && protocol.tvl.length ? protocol.tvl[protocol.tvl.length - 1] : null;
  return {
    id: protocol.id,
    name: protocol.name,
    slug: protocol.slug,
    category: protocol.category,
    chains: protocol.chains,
    audits: protocol.audits,
    audit_links: protocol.audit_links,
    url: protocol.url,
    twitter: protocol.twitter,
    github: protocol.github,
    latestTvlUsd: latest?.totalLiquidityUSD ?? null,
    latestTvlDate: latest?.date ?? null,
    currentChainTvls: protocol.currentChainTvls,
    methodology: protocol.methodology,
  };
}

function roleId(name) {
  return name === "DEFAULT_ADMIN_ROLE" ? ZERO32 : id(name);
}

async function scanRoles(rpc, core) {
  const roles = {};
  for (const name of ROLE_NAMES) {
    const role = roleId(name);
    const [countRes, adminRes, probeRes] = await Promise.all([
      callOptional(rpc, core, "getRoleMemberCount(bytes32)", [role], ["bytes32"], ["uint256"]),
      callOptional(rpc, core, "getRoleAdmin(bytes32)", [role], ["bytes32"], ["bytes32"]),
      callOptional(rpc, core, "hasRole(bytes32,address)", [role, PROBE_FROM], ["bytes32", "address"], ["bool"]),
    ]);
    const count = countRes.ok ? Number(countRes.value[0]) : 0;
    const members = [];
    for (let i = 0; i < Math.min(count, 50); i++) {
      const member = await callOptional(rpc, core, "getRoleMember(bytes32,uint256)", [role, i], ["bytes32", "uint256"], ["address"]);
      if (member.ok) members.push(normalizeAddress(member.value[0]));
    }
    roles[name] = {
      id: role,
      admin: adminRes.ok ? adminRes.value[0] : null,
      adminName: adminRes.ok ? ROLE_NAMES.find((n) => roleId(n).toLowerCase() === adminRes.value[0].toLowerCase()) || null : null,
      count,
      members,
      probeHasRole: probeRes.ok ? probeRes.value[0] : null,
    };
  }
  return roles;
}

async function scanAddressBook(rpc, candidates) {
  const books = [];
  for (const gateway of candidates.filter((x) => isAddress(x))) {
    const entries = {};
    for (const name of ADDRESS_NAMES) {
      const res = await callOptional(rpc, gateway, "getAddress(string)", [name], ["string"], ["address"]);
      if (res.ok && res.value[0].toLowerCase() !== ZERO.toLowerCase()) entries[name] = normalizeAddress(res.value[0]);
    }
    if (Object.keys(entries).length) {
      books.push({ gateway, meta: await getCodeSummary(rpc, gateway), entries, probes: await scanGatewayProbes(rpc, gateway) });
    }
  }
  return books;
}

async function scanGatewayProbes(rpc, gateway) {
  return {
    setAddress: await stateProbe(rpc, gateway, "setAddress(string,address)", ["probe", PROBE_FROM], ["string", "address"]),
    setEnabledRouter: await stateProbe(rpc, gateway, "setEnabledRouter(address,bool)", [PROBE_FROM, true], ["address", "bool"]),
    setZapFee: await stateProbe(rpc, gateway, "setZapFee(uint256)", [0], ["uint256"]),
  };
}

async function tokenMeta(rpc, address, label = null) {
  if (!isAddress(address)) return null;
  const [nameRaw, symbolRaw, decimalsRaw, totalSupplyRaw, balanceProbeRaw] = await Promise.all([
    callOptional(rpc, address, "name()", [], [], ["string"]),
    callOptional(rpc, address, "symbol()", [], [], ["string"]),
    callOptional(rpc, address, "decimals()", [], [], ["uint8"]),
    callOptional(rpc, address, "totalSupply()", [], [], ["uint256"]),
    callOptional(rpc, address, "balanceOf(address)", [PROBE_FROM], ["address"], ["uint256"]),
  ]);
  const decimals = decimalsRaw.ok ? Number(decimalsRaw.value[0]) : null;
  const totalSupply = totalSupplyRaw.ok ? totalSupplyRaw.value[0] : null;
  return {
    label,
    address: normalizeAddress(address),
    name: nameRaw.ok ? nameRaw.value[0] : null,
    symbol: symbolRaw.ok ? symbolRaw.value[0] : null,
    decimals,
    totalSupplyRaw: totalSupply?.toString() || null,
    totalSupply: totalSupply !== null ? formatUnits(totalSupply, decimals ?? 18, 10) : null,
    probeBalanceRaw: balanceProbeRaw.ok ? balanceProbeRaw.value[0].toString() : null,
  };
}

async function scanRegistry(rpc, farmRegistry) {
  const [assetsRes, farmsRes] = await Promise.all([
    callOptional(rpc, farmRegistry, "getEnabledAssets()", [], [], ["address[]"]),
    callOptional(rpc, farmRegistry, "getFarms()", [], [], ["address[]"]),
  ]);
  const enabledAssets = assetsRes.ok ? assetsRes.value[0].map(normalizeAddress) : [];
  const farms = farmsRes.ok ? farmsRes.value[0].map(normalizeAddress) : [];
  const typeFarms = {};
  for (const type of [0, 1, 2]) {
    const res = await callOptional(rpc, farmRegistry, "getTypeFarms(uint256)", [type], ["uint256"], ["address[]"]);
    typeFarms[FARM_TYPE_LABELS[type]] = res.ok ? res.value[0].map(normalizeAddress) : [];
  }
  return { enabledAssets, farms, typeFarms };
}

async function scanFarm(rpc, farm, registry, block) {
  const [meta, views, assetTokenRes, probes] = await Promise.all([
    getCodeSummary(rpc, farm),
    viewMap(rpc, farm, {
      core: ["core()", [], [], ["address"]],
      paused: ["paused()", [], [], ["bool"]],
      assets: ["assets()", [], [], ["uint256"]],
      liquidity: ["liquidity()", [], [], ["uint256"]],
      cap: ["cap()", [], [], ["uint256"]],
      maxDeposit: ["maxDeposit()", [], [], ["uint256"]],
      maxSlippage: ["maxSlippage()", [], [], ["uint256"]],
      rewardContract: ["rewardContract()", [], [], ["address"]],
      vault: ["vault()", [], [], ["address"]],
      maturity: ["maturity()", [], [], ["uint256"]],
      pendleMarket: ["pendleMarket()", [], [], ["address"]],
      swapRouter: ["swapRouter()", [], [], ["address"]],
      oracle: ["oracle()", [], [], ["address"]],
    }),
    callOptional(rpc, farm, "assetToken()", [], [], ["address"]),
    scanFarmProbes(rpc, farm),
  ]);
  const assetToken = assetTokenRes.ok ? normalizeAddress(assetTokenRes.value[0]) : null;
  const assetMeta = assetToken ? await tokenMeta(rpc, assetToken) : null;
  const tokenBalance = assetToken ? await callOptional(rpc, assetToken, "balanceOf(address)", [farm], ["address"], ["uint256"]) : null;
  const vault = normalizeAddress(views.vault);
  const vaultInfo = vault ? await scanVault(rpc, vault, farm) : null;
  const farmTypes = [];
  for (const [label, list] of Object.entries(registry.typeFarms)) {
    if (list.map((x) => x.toLowerCase()).includes(farm.toLowerCase())) farmTypes.push(label);
  }
  const assetsRaw = views.assets ?? null;
  return {
    address: farm,
    meta,
    farmTypes,
    assetToken,
    assetMeta,
    views: normalizeViewValues(views),
    tokenBalanceRaw: tokenBalance?.ok ? tokenBalance.value[0].toString() : null,
    tokenBalance: tokenBalance?.ok ? formatUnits(tokenBalance.value[0], assetMeta?.decimals ?? 18, 8) : null,
    assets: assetsRaw !== undefined ? formatUnits(assetsRaw, assetMeta?.decimals ?? 18, 8) : null,
    liquidity: views.liquidity !== undefined ? formatUnits(views.liquidity, assetMeta?.decimals ?? 18, 8) : null,
    cap: views.cap !== undefined ? formatUnits(views.cap, assetMeta?.decimals ?? 18, 8) : null,
    maxDeposit: views.maxDeposit !== undefined ? formatUnits(views.maxDeposit, assetMeta?.decimals ?? 18, 8) : null,
    vaultInfo,
    probes,
    flags: [],
    blockTimestamp: block.timestamp,
  };
}

async function viewMap(rpc, address, spec) {
  const out = {};
  for (const [name, [signature, args, types, retTypes]] of Object.entries(spec)) {
    const res = await callOptional(rpc, address, signature, args, types, retTypes);
    if (res.ok) out[name] = scalarize(res.value[0]);
  }
  return out;
}

function scalarize(value) {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value)) return bytes32ToString(value) || value;
  if (isAddress(value)) return normalizeAddress(value);
  return value;
}

function normalizeViewValues(views) {
  const out = {};
  for (const [key, value] of Object.entries(views || {})) out[key] = scalarize(value);
  return out;
}

async function scanFarmProbes(rpc, farm) {
  return {
    deposit: await stateProbe(rpc, farm, "deposit()"),
    withdraw: await stateProbe(rpc, farm, "withdraw(uint256,address)", [1, PROBE_FROM], ["uint256", "address"]),
    setCap: await stateProbe(rpc, farm, "setCap(uint256)", [1], ["uint256"]),
    setMaxSlippage: await stateProbe(rpc, farm, "setMaxSlippage(uint256)", [0], ["uint256"]),
    claimRewards: await stateProbe(rpc, farm, "claimRewards(bytes)", ["0x"], ["bytes"]),
    pause: await stateProbe(rpc, farm, "pause()"),
    unpause: await stateProbe(rpc, farm, "unpause()"),
  };
}

async function scanVault(rpc, vault, farm) {
  const [meta, token, views] = await Promise.all([
    getCodeSummary(rpc, vault),
    tokenMeta(rpc, vault, "vault"),
    viewMap(rpc, vault, {
      asset: ["asset()", [], [], ["address"]],
      totalAssets: ["totalAssets()", [], [], ["uint256"]],
      totalSupply: ["totalSupply()", [], [], ["uint256"]],
      maxWithdrawFarm: ["maxWithdraw(address)", [farm], ["address"], ["uint256"]],
      convertToAssets1e18: ["convertToAssets(uint256)", ["1000000000000000000"], ["uint256"], ["uint256"]],
      convertToShares1e18: ["convertToShares(uint256)", ["1000000000000000000"], ["uint256"], ["uint256"]],
    }),
  ]);
  const decimals = token?.decimals ?? 18;
  return {
    meta,
    token,
    views: normalizeViewValues(views),
    totalAssets: views.totalAssets !== undefined ? formatUnits(views.totalAssets, decimals, 8) : null,
    totalSupply: views.totalSupply !== undefined ? formatUnits(views.totalSupply, decimals, 8) : null,
    maxWithdrawFarm: views.maxWithdrawFarm !== undefined ? formatUnits(views.maxWithdrawFarm, decimals, 8) : null,
  };
}

async function scanAssets(rpc, assets, accounting, farmsByAsset) {
  const out = [];
  for (const asset of assets) {
    const [meta, oracleRes, totalAssetsRes, totalAssetsValueRes] = await Promise.all([
      tokenMeta(rpc, asset),
      accounting ? callOptional(rpc, accounting, "oracle(address)", [asset], ["address"], ["address"]) : null,
      accounting ? callOptional(rpc, accounting, "totalAssets(address)", [asset], ["address"], ["uint256"]) : null,
      accounting ? callOptional(rpc, accounting, "price(address)", [asset], ["address"], ["uint256"]) : null,
    ]);
    const oracle = oracleRes?.ok ? normalizeAddress(oracleRes.value[0]) : null;
    out.push({
      asset,
      meta,
      oracle,
      oracleMeta: oracle ? await scanOracle(rpc, oracle) : null,
      accountingTotalAssetsRaw: totalAssetsRes?.ok ? totalAssetsRes.value[0].toString() : null,
      accountingTotalAssets: totalAssetsRes?.ok ? formatUnits(totalAssetsRes.value[0], meta?.decimals ?? 18, 8) : null,
      accountingPriceRaw: totalAssetsValueRes?.ok ? totalAssetsValueRes.value[0].toString() : null,
      accountingPrice: totalAssetsValueRes?.ok ? formatUnits(totalAssetsValueRes.value[0], 18, 8) : null,
      farms: farmsByAsset[asset.toLowerCase()] || [],
    });
  }
  return out;
}

async function scanOracle(rpc, oracle) {
  const [meta, priceRes, latest, views] = await Promise.all([
    getCodeSummary(rpc, oracle),
    callOptional(rpc, oracle, "price()", [], [], ["uint256"]),
    callOptional(rpc, oracle, "latestRoundData()", [], [], ["uint80", "int256", "uint256", "uint256", "uint80"]),
    viewMap(rpc, oracle, {
      fixedPrice: ["fixedPrice()", [], [], ["uint256"]],
      target: ["target()", [], [], ["address"]],
      stalePeriod: ["stalePeriod()", [], [], ["uint256"]],
    }),
  ]);
  return {
    meta,
    priceRaw: priceRes.ok ? priceRes.value[0].toString() : null,
    price: priceRes.ok ? formatUnits(priceRes.value[0], 18, 8) : null,
    latestRoundData: latest.ok
      ? {
          roundId: latest.value[0].toString(),
          answer: latest.value[1].toString(),
          updatedAt: latest.value[3].toString(),
          answeredInRound: latest.value[4].toString(),
        }
      : null,
    views: normalizeViewValues(views),
  };
}

async function scanProtocolState(rpc, addresses) {
  const receipt = addresses.receiptToken || addresses.iUSD;
  const staked = addresses.stakedToken || addresses.siUSD;
  const accounting = addresses.accounting;
  const mintController = addresses.mintController;
  const redeemController = addresses.redeemController;
  const yieldSharing = addresses.yieldSharing;
  const lockingController = addresses.lockingController;

  const out = { addresses };
  out.tokens = {};
  if (receipt) out.tokens.receiptToken = await tokenMeta(rpc, receipt, "receiptToken");
  if (staked) out.tokens.stakedToken = await tokenMeta(rpc, staked, "stakedToken");
  if (addresses.USDC) out.tokens.USDC = await tokenMeta(rpc, addresses.USDC, "USDC");

  out.accounting = accounting
    ? await viewMap(rpc, accounting, {
        farmRegistry: ["farmRegistry()", [], [], ["address"]],
        totalAssetsValue: ["totalAssetsValue()", [], [], ["uint256"]],
      })
    : null;
  out.yieldSharing = yieldSharing
    ? await viewMap(rpc, yieldSharing, {
        accounting: ["accounting()", [], [], ["address"]],
        receiptToken: ["receiptToken()", [], [], ["address"]],
        stakedToken: ["stakedToken()", [], [], ["address"]],
        lockingModule: ["lockingModule()", [], [], ["address"]],
        unaccruedYield: ["unaccruedYield()", [], [], ["int256"]],
        safetyBufferSize: ["safetyBufferSize()", [], [], ["uint256"]],
        performanceFee: ["performanceFee()", [], [], ["uint256"]],
        liquidReturnMultiplier: ["liquidReturnMultiplier()", [], [], ["uint256"]],
        targetIlliquidRatio: ["targetIlliquidRatio()", [], [], ["uint256"]],
        interpolationDuration: ["interpolationDuration()", [], [], ["uint256"]],
        vesting: ["vesting()", [], [], ["uint256"]],
        vested: ["vested()", [], [], ["uint256"]],
      })
    : null;
  out.mintController = mintController
    ? await viewMap(rpc, mintController, {
        assetToken: ["assetToken()", [], [], ["address"]],
        receiptToken: ["receiptToken()", [], [], ["address"]],
        accounting: ["accounting()", [], [], ["address"]],
        minAssetAmount: ["minAssetAmount()", [], [], ["uint256"]],
        afterMintHook: ["afterMintHook()", [], [], ["address"]],
        assets: ["assets()", [], [], ["uint256"]],
        liquidity: ["liquidity()", [], [], ["uint256"]],
        assetToReceipt1USDC: ["assetToReceipt(uint256)", ["1000000"], ["uint256"], ["uint256"]],
      })
    : null;
  out.redeemController = redeemController
    ? await viewMap(rpc, redeemController, {
        assetToken: ["assetToken()", [], [], ["address"]],
        receiptToken: ["receiptToken()", [], [], ["address"]],
        accounting: ["accounting()", [], [], ["address"]],
        minRedemptionAmount: ["minRedemptionAmount()", [], [], ["uint256"]],
        beforeRedeemHook: ["beforeRedeemHook()", [], [], ["address"]],
        assets: ["assets()", [], [], ["uint256"]],
        liquidity: ["liquidity()", [], [], ["uint256"]],
        totalPendingClaims: ["totalPendingClaims()", [], [], ["uint256"]],
        totalEnqueuedRedemptions: ["totalEnqueuedRedemptions()", [], [], ["uint256"]],
        queueLength: ["queueLength()", [], [], ["uint256"]],
        receiptToAsset1IUSD: ["receiptToAsset(uint256)", ["1000000000000000000"], ["uint256"], ["uint256"]],
      })
    : null;
  out.stakedToken = staked
    ? await viewMap(rpc, staked, {
        asset: ["asset()", [], [], ["address"]],
        yieldSharing: ["yieldSharing()", [], [], ["address"]],
        totalAssets: ["totalAssets()", [], [], ["uint256"]],
        totalSupply: ["totalSupply()", [], [], ["uint256"]],
        convertToAssets1e18: ["convertToAssets(uint256)", ["1000000000000000000"], ["uint256"], ["uint256"]],
        maxDepositProbe: ["maxDeposit(address)", [PROBE_FROM], ["address"], ["uint256"]],
        maxWithdrawProbe: ["maxWithdraw(address)", [PROBE_FROM], ["address"], ["uint256"]],
      })
    : null;
  out.lockingController = lockingController
    ? await viewMap(rpc, lockingController, {
        receiptToken: ["receiptToken()", [], [], ["address"]],
        unwindingModule: ["unwindingModule()", [], [], ["address"]],
        totalBalance: ["totalBalance()", [], [], ["uint256"]],
        rewardMultiplier: ["rewardMultiplier()", [], [], ["uint256"]],
      })
    : null;

  out.probes = {
    coreGrantGovernor: addresses.core ? await stateProbe(rpc, addresses.core, "grantRole(bytes32,address)", [roleId("GOVERNOR"), PROBE_FROM], ["bytes32", "address"]) : null,
    accountingSetOracle: accounting ? await stateProbe(rpc, accounting, "setOracle(address,address)", [PROBE_FROM, PROBE_FROM], ["address", "address"]) : null,
    yieldSharingAccrue: yieldSharing ? await stateProbe(rpc, yieldSharing, "accrue()") : null,
    mintControllerMint: mintController ? await stateProbe(rpc, mintController, "mint(address,uint256)", [PROBE_FROM, 1], ["address", "uint256"]) : null,
    redeemControllerRedeem: redeemController ? await stateProbe(rpc, redeemController, "redeem(address,uint256)", [PROBE_FROM, 1], ["address", "uint256"]) : null,
    stakedDirectDeposit: staked ? await stateProbe(rpc, staked, "deposit(uint256,address)", [1, PROBE_FROM], ["uint256", "address"]) : null,
  };

  return normalizeNested(out);
}

async function deriveAddressBook(rpc, addresses) {
  const out = { ...addresses };
  if (out.mintController) {
    if (!out.accounting) {
      const res = await callOptional(rpc, out.mintController, "accounting()", [], [], ["address"]);
      if (res.ok) out.accounting = normalizeAddress(res.value[0]);
    }
    if (!out.receiptToken && !out.iUSD) {
      const res = await callOptional(rpc, out.mintController, "receiptToken()", [], [], ["address"]);
      if (res.ok) out.receiptToken = normalizeAddress(res.value[0]);
    }
    if (!out.USDC) {
      const res = await callOptional(rpc, out.mintController, "assetToken()", [], [], ["address"]);
      if (res.ok) out.USDC = normalizeAddress(res.value[0]);
    }
  }
  if (out.accounting && !out.farmRegistry) {
    const res = await callOptional(rpc, out.accounting, "farmRegistry()", [], [], ["address"]);
    if (res.ok) out.farmRegistry = normalizeAddress(res.value[0]);
  }
  if (out.yieldSharing) {
    if (!out.accounting) {
      const res = await callOptional(rpc, out.yieldSharing, "accounting()", [], [], ["address"]);
      if (res.ok) out.accounting = normalizeAddress(res.value[0]);
    }
    if (!out.receiptToken && !out.iUSD) {
      const res = await callOptional(rpc, out.yieldSharing, "receiptToken()", [], [], ["address"]);
      if (res.ok) out.receiptToken = normalizeAddress(res.value[0]);
    }
    if (!out.stakedToken && !out.siUSD) {
      const res = await callOptional(rpc, out.yieldSharing, "stakedToken()", [], [], ["address"]);
      if (res.ok) out.stakedToken = normalizeAddress(res.value[0]);
    }
    if (!out.lockingController) {
      const res = await callOptional(rpc, out.yieldSharing, "lockingModule()", [], [], ["address"]);
      if (res.ok) out.lockingController = normalizeAddress(res.value[0]);
    }
  }
  return out;
}

function normalizeNested(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(normalizeNested);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizeNested(v)]));
  if (isAddress(value)) return normalizeAddress(value);
  return value;
}

function evaluate(out) {
  const flags = [];
  const farms = out.farms || [];
  const roleProbeHits = Object.entries(out.roles || {}).filter(([, r]) => r.probeHasRole === true).map(([name]) => name);
  if (roleProbeHits.length) flags.push({ severity: "critical", item: "PROBE_HAS_CORE_ROLE", detail: roleProbeHits });

  const protocolProbeHits = Object.entries(out.protocol?.probes || {}).filter(([, p]) => p?.success).map(([name]) => name);
  if (protocolProbeHits.length) flags.push({ severity: "critical", item: "PROTOCOL_PROBE_SUCCESS", detail: protocolProbeHits });

  const farmProbeHits = farms.flatMap((f) => Object.entries(f.probes || {}).filter(([, p]) => p.success).map(([name]) => `${f.address}:${name}`));
  if (farmProbeHits.length) flags.push({ severity: "critical", item: "FARM_PROBE_SUCCESS", detail: farmProbeHits.slice(0, 40) });

  const noCodeFarms = farms.filter((f) => !f.meta.codePresent).map((f) => f.address);
  if (noCodeFarms.length) flags.push({ severity: "high", item: "REGISTERED_FARM_NO_CODE", detail: noCodeFarms });

  const pausedWithAssets = farms.filter((f) => f.views.paused === true && BigInt(f.views.assets || 0) > 0n).map((f) => ({ farm: f.address, assets: f.assets }));
  if (pausedWithAssets.length) flags.push({ severity: "info", item: "PAUSED_FARM_WITH_ASSETS", detail: pausedWithAssets });

  const negativeYield = out.protocol?.yieldSharing?.unaccruedYield;
  if (negativeYield !== undefined && negativeYield !== null && BigInt(negativeYield) < 0n) flags.push({ severity: "medium", item: "NEGATIVE_UNACCRUED_YIELD", detail: negativeYield });

  const queueLength = out.protocol?.redeemController?.queueLength;
  if (queueLength !== undefined && BigInt(queueLength) > 0n) flags.push({ severity: "info", item: "REDEMPTION_QUEUE_NONEMPTY", detail: queueLength });
  return flags;
}

function summarize(out) {
  const totalFarmAssetsByToken = {};
  for (const farm of out.farms) {
    if (!farm.assetToken || farm.views.assets === undefined) continue;
    const key = farm.assetToken.toLowerCase();
    totalFarmAssetsByToken[key] = (BigInt(totalFarmAssetsByToken[key] || 0) + BigInt(farm.views.assets || 0)).toString();
  }
  return {
    block: out.block,
    rootRegistry: ROOT_REGISTRY,
    core: out.root.core,
    farmRegistry: out.root.farmRegistry,
    enabledAssets: out.registry.enabledAssets.length,
    farms: out.registry.farms.length,
    farmTypes: Object.fromEntries(Object.entries(out.registry.typeFarms).map(([k, v]) => [k, v.length])),
    entryPoints: out.roles.ENTRY_POINT?.members || [],
    governorMembers: out.roles.GOVERNOR?.members || [],
    totalFarmAssetsByToken,
    protocol: {
      receiptSupply: out.protocol?.tokens?.receiptToken?.totalSupply,
      stakedSupply: out.protocol?.tokens?.stakedToken?.totalSupply,
      accountingTotalAssetsValueRaw: out.protocol?.accounting?.totalAssetsValue,
      unaccruedYieldRaw: out.protocol?.yieldSharing?.unaccruedYield,
      redeemLiquidityRaw: out.protocol?.redeemController?.liquidity,
      redeemQueueLength: out.protocol?.redeemController?.queueLength,
      totalPendingClaims: out.protocol?.redeemController?.totalPendingClaims,
      totalEnqueuedRedemptions: out.protocol?.redeemController?.totalEnqueuedRedemptions,
    },
    flags: out.flags,
  };
}

function printSummary(out) {
  const s = out.summary;
  console.log(`infiniFi live scan complete at Ethereum block ${s.block.number}`);
  console.log(`Core=${s.core} farmRegistry=${s.farmRegistry}`);
  console.log(`Enabled assets=${s.enabledAssets}; farms=${s.farms}; types=${JSON.stringify(s.farmTypes)}`);
  console.log(`Entry points=${s.entryPoints.length}; governors=${s.governorMembers.length}; flags=${s.flags.length}`);
  if (s.flags.length) for (const flag of s.flags) console.log(`${flag.severity.toUpperCase()} ${flag.item}: ${JSON.stringify(flag.detail).slice(0, 300)}`);
  console.log(`Wrote ${OUT}`);
}

async function main() {
  const rpc = await resolveEthereumRpc();
  const [metadata, block] = await Promise.all([fetchMetadata(), getBlock(rpc)]);
  const rootMeta = await getCodeSummary(rpc, ROOT_REGISTRY);
  const [coreRes, farmRegistryRes] = await Promise.all([
    callOptional(rpc, ROOT_REGISTRY, "core()", [], [], ["address"]),
    callOptional(rpc, ROOT_REGISTRY, "farmRegistry()", [], [], ["address"]),
  ]);
  if (!coreRes.ok || !farmRegistryRes.ok) throw new Error("Root registry did not expose core() and farmRegistry()");
  const root = { meta: rootMeta, core: normalizeAddress(coreRes.value[0]), farmRegistry: normalizeAddress(farmRegistryRes.value[0]) };
  const roles = await scanRoles(rpc, root.core);
  const addressBooks = await scanAddressBook(rpc, [ROOT_REGISTRY, ...roles.ENTRY_POINT.members]);
  let mergedBook = Object.assign({}, ...addressBooks.map((book) => book.entries));
  if (!mergedBook.core) mergedBook.core = root.core;
  if (!mergedBook.farmRegistry) mergedBook.farmRegistry = root.farmRegistry;
  mergedBook = await deriveAddressBook(rpc, mergedBook);

  const registry = await scanRegistry(rpc, root.farmRegistry);
  const farms = [];
  for (const farm of registry.farms) farms.push(await scanFarm(rpc, farm, registry, block));
  const farmsByAsset = {};
  for (const farm of farms) {
    if (!farm.assetToken) continue;
    const key = farm.assetToken.toLowerCase();
    if (!farmsByAsset[key]) farmsByAsset[key] = [];
    farmsByAsset[key].push(farm.address);
  }
  const protocol = await scanProtocolState(rpc, mergedBook);
  const assets = await scanAssets(rpc, registry.enabledAssets, mergedBook.accounting, farmsByAsset);

  const out = {
    generatedAt: new Date().toISOString(),
    target: "infiniFi Ethereum",
    metadata,
    block,
    root,
    roles,
    addressBooks,
    registry,
    assets,
    farms,
    protocol,
    flags: [],
    summary: null,
  };
  out.flags = evaluate(out);
  out.summary = summarize(out);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, bigintJson, 2));
  printSummary(out);
}

main().catch((err) => {
  console.error(sanitize(err.stack || err.message || err));
  process.exit(1);
});
