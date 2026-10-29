#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { AbiCoder, getAddress, id } = require("ethers");

const WORKSPACE = path.join(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "derive-v2-live.json");
const RPC_TIMEOUT_MS = 15_000;

const PROTOCOL_URL = "https://api.llama.fi/protocol/derive-v2";
const ADDRESSES_JS_URL = "https://raw.githubusercontent.com/DefiLlama/DefiLlama-Adapters/main/projects/lyra-v2/addresses.js";
const CORE_ASSETS_URL = "https://raw.githubusercontent.com/DefiLlama/DefiLlama-Adapters/main/projects/helper/coreAssets.json";
const NEW_DEPLOYMENTS_URL = "https://raw.githubusercontent.com/0xdomrom/socket-plugs/main/deployments/superbridge/prod_lyra_addresses.json";
const OLD_DEPLOYMENTS_URL = "https://raw.githubusercontent.com/0xdomrom/socket-plugs/main/deployments/superbridge/prod_lyra-old_addresses.json";
const CORE_DEPLOYMENT_URL = "https://raw.githubusercontent.com/derivexyz/v2-core/master/deployments/957/core.json";
const SHARED_DEPLOYMENT_URL = "https://raw.githubusercontent.com/derivexyz/v2-core/master/deployments/957/shared.json";
const MARKET_DEPLOYMENT_URLS = {
  ETH: "https://raw.githubusercontent.com/derivexyz/v2-core/master/deployments/957/ETH.json",
  BTC: "https://raw.githubusercontent.com/derivexyz/v2-core/master/deployments/957/BTC.json",
};

const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const CHAINS = {
  ethereum: { chainId: 1, llamaChain: "Ethereum", fallbacks: ["https://ethereum-rpc.publicnode.com"] },
  optimism: { chainId: 10, llamaChain: "Optimism", fallbacks: ["https://mainnet.optimism.io"] },
  base: { chainId: 8453, llamaChain: "Base", fallbacks: ["https://mainnet.base.org"] },
  arbitrum: { chainId: 42161, llamaChain: "Arbitrum", fallbacks: ["https://arb1.arbitrum.io/rpc"] },
  lyra: { chainId: 957, llamaChain: "Lyra", fallbacks: ["https://rpc.lyra.finance"] },
  blast: { chainId: 81457, llamaChain: "Blast", fallbacks: ["https://rpc.blast.io"] },
  mode: { chainId: 34443, llamaChain: "Mode", fallbacks: ["https://mainnet.mode.network"] },
};

const CHAIN_NAME_BY_ID = Object.fromEntries(Object.entries(CHAINS).map(([name, cfg]) => [String(cfg.chainId), name]));
const ABI = AbiCoder.defaultAbiCoder();

const VIEW_CALLS = {
  token: { signature: "token()", types: ["address"] },
  tokenUnderscore: { signature: "token__()", types: ["address"] },
  asset: { signature: "asset()", types: ["address"] },
  totalAssets: { signature: "totalAssets()", types: ["uint256"] },
  convertToAssets1e18: { signature: "convertToAssets(uint256)", args: ["uint256"], values: [10n ** 18n], types: ["uint256"] },
  convertToShares1e18: { signature: "convertToShares(uint256)", args: ["uint256"], values: [10n ** 18n], types: ["uint256"] },
  owner: { signature: "owner()", types: ["address"] },
  paused: { signature: "paused()", types: ["bool"] },
  cap: { signature: "cap()", types: ["uint256"] },
  depositCap: { signature: "depositCap()", types: ["uint256"] },
  withdrawalFee: { signature: "withdrawalFee()", types: ["uint256"] },
  exchangeRate: { signature: "exchangeRate()", types: ["uint256"] },
  controller: { signature: "controller()", types: ["address"] },
};

const CORE_VIEW_CALLS = {
  requiredSigners: { signature: "requiredSigners()", types: ["uint8"] },
  heartbeat: { signature: "heartbeat()", types: ["uint64"] },
  settlementHeartbeat: { signature: "settlementHeartbeat()", types: ["uint64"] },
  maxExpiry: { signature: "maxExpiry()", types: ["uint64"] },
  getSpot: { signature: "getSpot()", types: ["uint256", "uint256"] },
  owner: { signature: "owner()", types: ["address"] },
  adjustmentsPaused: { signature: "adjustmentsPaused()", types: ["bool"] },
  lastAccountId: { signature: "lastAccountId()", types: ["uint256"] },
  totalInsolventMM: { signature: "totalInsolventMM()", types: ["uint256"] },
  smAccount: { signature: "smAccount()", types: ["uint256"] },
};

const INTERESTING_SIGNATURES = [
  "deposit(uint256)",
  "deposit(uint256,address)",
  "initiateDeposit(uint256,address)",
  "initiateDeposit(address,uint256)",
  "requestWithdrawal(uint256)",
  "withdraw(uint256,address,address)",
  "mint(address,uint256)",
  "burn(address,uint256)",
  "settle()",
  "startAuction(uint256,uint256)",
  "bid(uint256,uint256,uint256,uint256)",
  "getMargin(uint256,bool)",
  "getMarginAndMarkToMarket(uint256,bool,uint256)",
  "submitData(bytes)",
  "acceptData(bytes)",
  "getSpot()",
  "getForwardPrice(uint64)",
  "liquidate(address)",
  "rebalance()",
  "token()",
  "token__()",
  "asset()",
  "totalAssets()",
  "owner()",
  "paused()",
];

const INTERESTING_SELECTORS = Object.fromEntries(INTERESTING_SIGNATURES.map((sig) => [sig, selector(sig)]));

function selector(signature) {
  return id(signature).slice(0, 10);
}

function encodeCall(signature, args = [], values = []) {
  return selector(signature) + (args.length ? ABI.encode(args, values).slice(2) : "");
}

function strip0x(x) {
  return String(x || "").replace(/^0x/i, "");
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
  const hex = strip0x(word).padStart(64, "0");
  const raw = "0x" + hex.slice(-40);
  if (/^0x0{40}$/i.test(raw)) return null;
  return normalizeAddress(raw);
}

function decodeOne(data, types) {
  if (!data || data === "0x") return null;
  try {
    return ABI.decode(types, data)[0];
  } catch (_) {
    return null;
  }
}

function decodeAll(data, types) {
  if (!data || data === "0x") return null;
  try {
    return [...ABI.decode(types, data)];
  } catch (_) {
    return null;
  }
}

function decodeString(data) {
  if (!data || data === "0x") return null;
  try {
    return String(ABI.decode(["string"], data)[0]);
  } catch (_) {
    const hex = strip0x(data);
    if (hex.length === 64) {
      return Buffer.from(hex, "hex").toString("utf8").replace(/\u0000+$/g, "") || null;
    }
    return null;
  }
}

function formatUnits(raw, decimals) {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  const value = BigInt(raw);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const frac = value % scale;
  const fracText = frac.toString().padStart(decimals, "0").replace(/0+$/, "").slice(0, 10);
  return fracText ? `${whole}.${fracText}` : whole.toString();
}

function extractRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function fetchText(url, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "user-agent": "evm-audit-derive-v2/1.0" }, signal: controller.signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url, timeoutMs = 20_000) {
  return JSON.parse(await fetchText(url, timeoutMs));
}

async function rpcCall(url, method, params, timeoutMs = RPC_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    return json.result;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveRpc(chainName) {
  const cfg = CHAINS[chainName];
  const candidates = [...extractRpcUrls(), ...(cfg.fallbacks || [])];
  const seen = new Set();
  for (const url of candidates) {
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      const chainId = Number(BigInt(await rpcCall(url, "eth_chainId", [], 5000)));
      if (chainId === cfg.chainId) return url;
    } catch (_) {
      // Never print or store RPC URLs.
    }
  }
  return null;
}

async function callOptional(rpc, to, data) {
  try {
    const result = await rpcCall(rpc, "eth_call", [{ to, data }, "latest"]);
    return result && result !== "0x" ? result : null;
  } catch (_) {
    return null;
  }
}

async function tokenMeta(rpc, address) {
  const [nameRaw, symbolRaw, decimalsRaw, totalSupplyRaw] = await Promise.all([
    callOptional(rpc, address, encodeCall("name()")),
    callOptional(rpc, address, encodeCall("symbol()")),
    callOptional(rpc, address, encodeCall("decimals()")),
    callOptional(rpc, address, encodeCall("totalSupply()")),
  ]);
  const decimals = decimalsRaw ? Number(decodeOne(decimalsRaw, ["uint8"]) ?? decodeOne(decimalsRaw, ["uint256"])) : null;
  const totalSupply = totalSupplyRaw ? decodeOne(totalSupplyRaw, ["uint256"]) : null;
  return {
    address,
    name: decodeString(nameRaw),
    symbol: decodeString(symbolRaw),
    decimals,
    totalSupplyRaw: totalSupply === null ? null : totalSupply.toString(),
    totalSupply: formatUnits(totalSupply, decimals),
  };
}

async function tokenBalance(rpc, token, account, decimals) {
  const raw = await callOptional(rpc, token, encodeCall("balanceOf(address)", ["address"], [account]));
  const value = raw ? decodeOne(raw, ["uint256"]) : null;
  return { raw: value === null ? null : value.toString(), formatted: formatUnits(value, decimals) };
}

function extractPush4Selectors(bytecode) {
  const hex = strip0x(bytecode);
  const selectors = new Set();
  for (let i = 0; i < hex.length - 10; i += 2) {
    if (hex.slice(i, i + 2).toLowerCase() === "63") selectors.add("0x" + hex.slice(i + 2, i + 10).toLowerCase());
  }
  return selectors;
}

function interestingSelectorMap(selectorSet) {
  const found = {};
  for (const [signature, sigSelector] of Object.entries(INTERESTING_SELECTORS)) {
    if (selectorSet.has(sigSelector)) found[signature] = sigSelector;
  }
  return found;
}

async function contractMeta(rpc, address) {
  const [code, implSlot, adminSlot, beaconSlot] = await Promise.all([
    rpcCall(rpc, "eth_getCode", [address, "latest"]).catch(() => "0x"),
    rpcCall(rpc, "eth_getStorageAt", [address, IMPL_SLOT, "latest"]).catch(() => null),
    rpcCall(rpc, "eth_getStorageAt", [address, ADMIN_SLOT, "latest"]).catch(() => null),
    rpcCall(rpc, "eth_getStorageAt", [address, BEACON_SLOT, "latest"]).catch(() => null),
  ]);
  const selectors = code && code !== "0x" ? extractPush4Selectors(code) : new Set();
  return {
    address,
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    push4SelectorCount: selectors.size,
    interestingSelectors: interestingSelectorMap(selectors),
    eip1967Implementation: addressFromWord(implSlot),
    eip1967Admin: addressFromWord(adminSlot),
    eip1967Beacon: addressFromWord(beaconSlot),
  };
}

async function inspectViews(rpc, address, tokenDecimals) {
  const result = {};
  for (const [name, spec] of Object.entries(VIEW_CALLS)) {
    const raw = await callOptional(rpc, address, encodeCall(spec.signature, spec.args || [], spec.values || []));
    if (!raw) continue;
    const value = decodeOne(raw, spec.types);
    if (value === null) continue;
    if (spec.types[0] === "address") result[name] = normalizeAddress(value);
    else if (spec.types[0] === "bool") result[name] = Boolean(value);
    else result[name] = { raw: value.toString(), formatted18: formatUnits(value, 18), formattedTokenDecimals: formatUnits(value, tokenDecimals) };
  }
  return result;
}

async function inspectCoreViews(rpc, address) {
  const result = {};
  for (const [name, spec] of Object.entries(CORE_VIEW_CALLS)) {
    const raw = await callOptional(rpc, address, encodeCall(spec.signature));
    if (!raw) continue;
    const values = decodeAll(raw, spec.types);
    if (!values) continue;
    if (spec.types.length === 1) {
      const value = values[0];
      if (spec.types[0] === "address") result[name] = normalizeAddress(value);
      else if (spec.types[0] === "bool") result[name] = Boolean(value);
      else result[name] = value.toString();
    } else {
      result[name] = values.map((value) => value.toString());
    }
  }
  return result;
}

function summarizeProtocol(protocol) {
  if (!protocol || typeof protocol !== "object") return null;
  const currentChainTvls = {};
  for (const [name, tvl] of Object.entries(protocol.currentChainTvls || {})) {
    if (typeof tvl === "number") currentChainTvls[name] = tvl;
  }
  const tvlHistory = Array.isArray(protocol.tvl) ? protocol.tvl : [];
  const latestTvlPoint = tvlHistory[tvlHistory.length - 1] || null;
  return {
    id: protocol.id,
    name: protocol.name,
    slug: protocol.slug,
    category: protocol.category,
    audits: protocol.audits,
    symbol: protocol.symbol,
    chains: protocol.chains,
    latestTvlUsd: typeof protocol.tvl === "number" ? protocol.tvl : latestTvlPoint?.totalLiquidityUSD || null,
    latestTvlDate: latestTvlPoint?.date || null,
    tvlHistoryPoints: tvlHistory.length,
    currentChainTvls,
  };
}

function evalAddressesModule(addressesJs, coreAssets) {
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require: (target) => {
      if (target === "../helper/coreAssets.json") return coreAssets;
      throw new Error(`blocked require: ${target}`);
    },
  };
  vm.runInNewContext(addressesJs, sandbox, { timeout: 1000 });
  return sandbox.module.exports;
}

function addRecord(records, record) {
  const chainName = CHAIN_NAME_BY_ID[String(record.chainId)];
  const vault = normalizeAddress(record.vault);
  const token = normalizeAddress(record.token);
  if (!chainName || !vault || !token) return;
  const key = `${record.chainId}:${vault.toLowerCase()}:${token.toLowerCase()}`;
  const existing = records.get(key);
  if (!existing) {
    records.set(key, {
      chain: chainName,
      chainId: Number(record.chainId),
      assetNames: record.assetName ? [record.assetName] : [],
      vault,
      token,
      sources: [record.source],
      isAppChain: Boolean(record.isAppChain),
      controller: normalizeAddress(record.controller),
      exchangeRate: normalizeAddress(record.exchangeRate),
      depositHook: normalizeAddress(record.depositHook),
      shareHandlerDepositHook: normalizeAddress(record.shareHandlerDepositHook),
      connectors: record.connectors || {},
    });
    return;
  }
  if (record.assetName && !existing.assetNames.includes(record.assetName)) existing.assetNames.push(record.assetName);
  if (!existing.sources.includes(record.source)) existing.sources.push(record.source);
  for (const [field, value] of Object.entries({
    controller: record.controller,
    exchangeRate: record.exchangeRate,
    depositHook: record.depositHook,
    shareHandlerDepositHook: record.shareHandlerDepositHook,
  })) {
    const normalized = normalizeAddress(value);
    if (!existing[field] && normalized) existing[field] = normalized;
  }
  existing.connectors = { ...existing.connectors, ...(record.connectors || {}) };
}

function addAppRecord(appRecords, record) {
  const chainName = CHAIN_NAME_BY_ID[String(record.chainId)];
  const token = normalizeAddress(record.token);
  const controller = normalizeAddress(record.controller);
  if (!chainName || (!token && !controller)) return;
  const key = `${record.chainId}:${record.assetName || "asset"}:${(token || controller).toLowerCase()}`;
  const existing = appRecords.get(key);
  if (!existing) {
    appRecords.set(key, {
      chain: chainName,
      chainId: Number(record.chainId),
      assetName: record.assetName || null,
      token,
      controller,
      exchangeRate: normalizeAddress(record.exchangeRate),
      depositHook: normalizeAddress(record.depositHook),
      shareHandlerDepositHook: normalizeAddress(record.shareHandlerDepositHook),
      connectors: record.connectors || {},
      source: record.source,
    });
    return;
  }
  for (const field of ["token", "controller", "exchangeRate", "depositHook", "shareHandlerDepositHook"]) {
    const normalized = normalizeAddress(record[field]);
    if (!existing[field] && normalized) existing[field] = normalized;
  }
  existing.connectors = { ...existing.connectors, ...(record.connectors || {}) };
}

function recordsFromStaticModule(records, moduleExports) {
  for (const chainName of Object.keys(CHAINS)) {
    if (typeof moduleExports.getStaticTokensAndOwners !== "function") continue;
    let pairs = [];
    try {
      pairs = moduleExports.getStaticTokensAndOwners(chainName) || [];
    } catch (_) {
      pairs = [];
    }
    const chainId = CHAINS[chainName].chainId;
    pairs.forEach(([token, vault], index) => addRecord(records, {
      chainId,
      vault,
      token,
      assetName: `static-${index + 1}`,
      source: "defillama-addresses-js",
    }));
  }
}

function recordsFromDeployments(records, appRecords, deployments, source) {
  for (const [chainId, chainEntries] of Object.entries(deployments || {})) {
    if (!CHAIN_NAME_BY_ID[String(chainId)]) continue;
    for (const [assetName, entry] of Object.entries(chainEntries || {})) {
      const record = {
        chainId,
        assetName,
        source,
        isAppChain: entry.isAppChain,
        token: entry.NonMintableToken || entry.MintableToken,
        vault: entry.Vault,
        controller: entry.Controller,
        exchangeRate: entry.ExchangeRate,
        depositHook: entry.LyraTSADepositHook,
        shareHandlerDepositHook: entry.LyraTSAShareHandlerDepositHook,
        connectors: entry.connectors,
      };
      if (entry.Vault) addRecord(records, record);
      else addAppRecord(appRecords, record);
    }
  }
}

function collectExtraContracts(records, appRecords = []) {
  const byChain = new Map();
  for (const rec of [...records, ...appRecords]) {
    const values = [];
    for (const field of ["controller", "exchangeRate", "depositHook", "shareHandlerDepositHook"]) {
      if (rec[field]) values.push({ kind: field, address: rec[field], assetNames: rec.assetNames || [rec.assetName].filter(Boolean) });
    }
    for (const [remoteChainId, connectors] of Object.entries(rec.connectors || {})) {
      for (const [connectorKind, address] of Object.entries(connectors || {})) {
        values.push({ kind: `connector:${remoteChainId}:${connectorKind}`, address, assetNames: rec.assetNames || [rec.assetName].filter(Boolean) });
      }
    }
    for (const item of values) {
      const address = normalizeAddress(item.address);
      if (!address) continue;
      const key = `${rec.chain}:${address.toLowerCase()}`;
      const existing = byChain.get(key);
      if (!existing) byChain.set(key, { chain: rec.chain, address, kinds: [item.kind], assetNames: [...(item.assetNames || [])] });
      else {
        if (!existing.kinds.includes(item.kind)) existing.kinds.push(item.kind);
        for (const asset of item.assetNames || []) if (!existing.assetNames.includes(asset)) existing.assetNames.push(asset);
      }
    }
  }
  return [...byChain.values()];
}

async function inspectAppRecord(rpc, record) {
  const [token, tokenContract, controllerContract, exchangeRateContract] = await Promise.all([
    record.token ? tokenMeta(rpc, record.token) : null,
    record.token ? contractMeta(rpc, record.token) : null,
    record.controller ? contractMeta(rpc, record.controller) : null,
    record.exchangeRate ? contractMeta(rpc, record.exchangeRate) : null,
  ]);
  const [tokenViews, controllerViews, exchangeRateViews] = await Promise.all([
    record.token ? inspectViews(rpc, record.token, token?.decimals ?? 18) : {},
    record.controller ? inspectViews(rpc, record.controller, token?.decimals ?? 18) : {},
    record.exchangeRate ? inspectViews(rpc, record.exchangeRate, token?.decimals ?? 18) : {},
  ]);

  const flags = [];
  if (tokenContract?.eip1967Implementation) flags.push("proxy-token");
  if (controllerContract?.eip1967Implementation) flags.push("proxy-controller");
  if (exchangeRateContract?.eip1967Implementation) flags.push("proxy-exchange-rate");
  for (const [label, meta] of [["token", tokenContract], ["controller", controllerContract], ["exchangeRate", exchangeRateContract]]) {
    if (!meta) continue;
    if (meta.interestingSelectors["deposit(uint256)"] || meta.interestingSelectors["deposit(uint256,address)"]) flags.push(`${label}-deposit-selector`);
    if (meta.interestingSelectors["requestWithdrawal(uint256)"]) flags.push(`${label}-withdrawal-selector`);
    if (meta.interestingSelectors["liquidate(address)"]) flags.push(`${label}-liquidate-selector`);
  }

  return { ...record, tokenMeta: token, tokenContract, controllerContract, exchangeRateContract, tokenViews, controllerViews, exchangeRateViews, flags };
}

async function inspectRecord(rpc, record) {
  const [vaultContract, token] = await Promise.all([contractMeta(rpc, record.vault), tokenMeta(rpc, record.token)]);
  const [implementation, balance, views] = await Promise.all([
    vaultContract.eip1967Implementation ? contractMeta(rpc, vaultContract.eip1967Implementation) : null,
    tokenBalance(rpc, record.token, record.vault, token.decimals),
    inspectViews(rpc, record.vault, token.decimals),
  ]);

  const flags = [];
  if (vaultContract.eip1967Implementation) flags.push("proxy-vault");
  if (views.asset || views.totalAssets || views.convertToAssets1e18) flags.push("erc4626-like-view");
  if (views.token && views.token.toLowerCase() !== record.token.toLowerCase()) flags.push("token-view-mismatch");
  if (views.tokenUnderscore && views.tokenUnderscore.toLowerCase() !== record.token.toLowerCase()) flags.push("token-underscore-view-mismatch");
  if (balance.raw && BigInt(balance.raw) > 0n) flags.push("vault-holds-token-balance");
  if (vaultContract.interestingSelectors["deposit(uint256)"] || vaultContract.interestingSelectors["deposit(uint256,address)"]) flags.push("deposit-selector-on-vault");
  if (implementation?.interestingSelectors?.["deposit(uint256)"] || implementation?.interestingSelectors?.["deposit(uint256,address)"]) flags.push("deposit-selector-on-implementation");

  return { ...record, tokenMeta: token, balance, vaultContract, implementation, views, flags };
}

async function inspectExtraContract(rpc, item) {
  const meta = await contractMeta(rpc, item.address);
  const [ownerRaw, pausedRaw, tokenRaw, assetRaw] = await Promise.all([
    callOptional(rpc, item.address, encodeCall("owner()")),
    callOptional(rpc, item.address, encodeCall("paused()")),
    callOptional(rpc, item.address, encodeCall("token()")),
    callOptional(rpc, item.address, encodeCall("asset()")),
  ]);
  return {
    ...item,
    contract: meta,
    owner: ownerRaw ? normalizeAddress(decodeOne(ownerRaw, ["address"])) : null,
    paused: pausedRaw ? Boolean(decodeOne(pausedRaw, ["bool"])) : null,
    token: tokenRaw ? normalizeAddress(decodeOne(tokenRaw, ["address"])) : null,
    asset: assetRaw ? normalizeAddress(decodeOne(assetRaw, ["address"])) : null,
  };
}

function flattenNamedDeployments(coreDeployments, marketDeployments) {
  const out = [];
  for (const [name, address] of Object.entries(coreDeployments || {})) {
    if (normalizeAddress(address)) out.push({ group: "core", name, address: normalizeAddress(address) });
  }
  for (const [market, deployments] of Object.entries(marketDeployments || {})) {
    for (const [name, address] of Object.entries(deployments || {})) {
      if (normalizeAddress(address)) out.push({ group: `market:${market}`, name, address: normalizeAddress(address) });
    }
  }
  const seen = new Map();
  for (const item of out) {
    const key = item.address.toLowerCase();
    const existing = seen.get(key);
    if (!existing) seen.set(key, { address: item.address, labels: [{ group: item.group, name: item.name }] });
    else existing.labels.push({ group: item.group, name: item.name });
  }
  return [...seen.values()];
}

async function inspectCoreContract(rpc, item) {
  const [contract, views] = await Promise.all([contractMeta(rpc, item.address), inspectCoreViews(rpc, item.address)]);
  return { ...item, contract, views };
}

async function scanChain(chainName, allRecords, allAppRecords, extraContracts, coreDeployments) {
  const cfg = CHAINS[chainName];
  const records = allRecords.filter((r) => r.chain === chainName);
  const appRecords = allAppRecords.filter((r) => r.chain === chainName);
  const extras = extraContracts.filter((r) => r.chain === chainName);
  const rpc = await resolveRpc(chainName);
  if (!rpc) return { chain: chainName, chainId: cfg.chainId, rpcResolved: false, recordCount: records.length, appRecordCount: appRecords.length, extraContractCount: extras.length, error: "missing-rpc" };

  const [blockNumberRaw, blockRaw] = await Promise.all([
    rpcCall(rpc, "eth_blockNumber", []),
    rpcCall(rpc, "eth_getBlockByNumber", ["latest", false]).catch(() => null),
  ]);
  const blockNumber = Number(BigInt(blockNumberRaw));
  const blockTimestamp = blockRaw?.timestamp ? Number(BigInt(blockRaw.timestamp)) : null;

  const inspectedRecords = [];
  for (const record of records) inspectedRecords.push(await inspectRecord(rpc, record));

  const inspectedAppRecords = [];
  for (const record of appRecords) inspectedAppRecords.push(await inspectAppRecord(rpc, record));

  const inspectedExtras = [];
  for (const item of extras) inspectedExtras.push(await inspectExtraContract(rpc, item));

  const coreContracts = [];
  if (chainName === "lyra") {
    for (const item of flattenNamedDeployments(coreDeployments.core, coreDeployments.markets)) {
      coreContracts.push(await inspectCoreContract(rpc, item));
    }
  }

  const flags = [];
  const positiveRecords = inspectedRecords.filter((r) => r.balance.raw && BigInt(r.balance.raw) > 0n);
  const positiveBalances = positiveRecords.length;
  const proxies = inspectedRecords.filter((r) => r.vaultContract.eip1967Implementation).length;
  const mismatches = inspectedRecords.filter((r) => r.flags.includes("token-view-mismatch") || r.flags.includes("token-underscore-view-mismatch")).length;
  const erc4626Like = inspectedRecords.filter((r) => r.flags.includes("erc4626-like-view")).length;
  const appControllers = inspectedAppRecords.filter((r) => r.controllerContract?.codePresent).length;
  if (positiveBalances) flags.push(`positive-vault-balances=${positiveBalances}`);
  if (proxies) flags.push(`proxy-vaults=${proxies}`);
  if (mismatches) flags.push(`token-view-mismatches=${mismatches}`);
  if (erc4626Like) flags.push(`erc4626-like-views=${erc4626Like}`);
  if (appControllers) flags.push(`app-controllers=${appControllers}`);

  return {
    chain: chainName,
    chainId: cfg.chainId,
    llamaChain: cfg.llamaChain,
    rpcResolved: true,
    blockNumber,
    blockTimestamp,
    recordCount: records.length,
    appRecordCount: appRecords.length,
    extraContractCount: extras.length,
    summary: {
      positiveBalances,
      proxyVaults: proxies,
      tokenViewMismatches: mismatches,
      erc4626LikeViews: erc4626Like,
      appControllers,
      positiveVaults: positiveRecords.map((r) => ({
        assetNames: r.assetNames,
        vault: r.vault,
        token: r.token,
        symbol: r.tokenMeta.symbol,
        balance: r.balance.formatted,
      })),
    },
    records: inspectedRecords,
    appRecords: inspectedAppRecords,
    extraContracts: inspectedExtras,
    coreContracts,
    flags,
  };
}

async function loadRecords() {
  const marketFetches = Object.entries(MARKET_DEPLOYMENT_URLS).map(async ([market, url]) => [market, await fetchJson(url)]);
  const [protocol, addressesJs, coreAssets, newDeployments, oldDeployments, coreDeployment, sharedDeployment, marketDeploymentEntries] = await Promise.all([
    fetchJson(PROTOCOL_URL).catch((e) => ({ error: e.message || String(e) })),
    fetchText(ADDRESSES_JS_URL),
    fetchJson(CORE_ASSETS_URL),
    fetchJson(NEW_DEPLOYMENTS_URL),
    fetchJson(OLD_DEPLOYMENTS_URL),
    fetchJson(CORE_DEPLOYMENT_URL),
    fetchJson(SHARED_DEPLOYMENT_URL),
    Promise.all(marketFetches),
  ]);

  const records = new Map();
  const appRecords = new Map();
  let staticModuleError = null;
  try {
    recordsFromStaticModule(records, evalAddressesModule(addressesJs, coreAssets));
  } catch (e) {
    staticModuleError = e.message || String(e);
  }
  recordsFromDeployments(records, appRecords, oldDeployments, "prod_lyra-old_addresses.json");
  recordsFromDeployments(records, appRecords, newDeployments, "prod_lyra_addresses.json");

  return {
    protocol: summarizeProtocol(protocol),
    staticModuleError,
    records: [...records.values()],
    appRecords: [...appRecords.values()],
    coreDeployments: { core: coreDeployment, shared: sharedDeployment, markets: Object.fromEntries(marketDeploymentEntries) },
  };
}

async function main() {
  const loaded = await loadRecords();
  const extraContracts = collectExtraContracts(loaded.records, loaded.appRecords);
  const chains = [];
  for (const chainName of Object.keys(CHAINS)) {
    console.log(`Scanning ${chainName}...`);
    chains.push(await scanChain(chainName, loaded.records, loaded.appRecords, extraContracts, loaded.coreDeployments));
  }

  const summary = {
    totalRecords: loaded.records.length,
    totalAppRecords: loaded.appRecords.length,
    totalExtraContracts: extraContracts.length,
    chainsResolved: chains.filter((c) => c.rpcResolved).length,
    chainsMissingRpc: chains.filter((c) => !c.rpcResolved).map((c) => c.chain),
    positiveVaultBalances: chains.reduce((sum, c) => sum + (c.records || []).filter((r) => r.balance?.raw && BigInt(r.balance.raw) > 0n).length, 0),
    tokenViewMismatches: chains.reduce((sum, c) => sum + (c.records || []).filter((r) => r.flags?.includes("token-view-mismatch") || r.flags?.includes("token-underscore-view-mismatch")).length, 0),
    byChain: Object.fromEntries(chains.map((c) => [c.chain, c.summary || { error: c.error || "unscanned" }])),
  };

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-derive-v2.js",
    safety: { rpcUrlsStored: false, signedActions: false },
    sources: [
      PROTOCOL_URL,
      ADDRESSES_JS_URL,
      CORE_ASSETS_URL,
      NEW_DEPLOYMENTS_URL,
      OLD_DEPLOYMENTS_URL,
      CORE_DEPLOYMENT_URL,
      SHARED_DEPLOYMENT_URL,
      ...Object.values(MARKET_DEPLOYMENT_URLS),
    ],
    protocol: loaded.protocol,
    staticModuleError: loaded.staticModuleError,
    summary,
    chains,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");
  console.log(`wrote ${OUT}`);
  console.log(chains.map((c) => `${c.chain}: ${c.rpcResolved ? "ok" : "missing-rpc"} records=${c.recordCount} flags=${(c.flags || []).join(",")}`).join("\n"));
}

main().catch((e) => {
  console.error(e.stack || e.message || String(e));
  process.exitCode = 1;
});
