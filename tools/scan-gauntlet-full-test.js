#!/usr/bin/env node
"use strict";

// scan-gauntlet-full-test.js
// Defensive Gauntlet/Aera route-first full test. Static/local + read-only eth_call probes only.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { getOrigin, loadRpcUrls, resolveRpcPool } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const REPORTS_DIR = path.join(WORKSPACE, "reports");
const OUT_JSON = path.join(RAW_DIR, "gauntlet-full-test.json");
const OUT_MD = path.join(REPORTS_DIR, "gauntlet-full-test-triage.md");
const OUT_JSON_REL = "reports/raw/fast/gauntlet-full-test.json";
const OUT_MD_REL = "reports/gauntlet-full-test-triage.md";

const DEEP_METADATA_FILE = path.join(RAW_DIR, "prefilter-deep-new-target-search-2026-06-24.json");
const EIGENPHI_DISCOVERY_FILE = path.join(RAW_DIR, "defillama-eigenphi-target-discovery.json");
const DEFILLAMA_PROTOCOLS_FILE = path.join(WORKSPACE, "reports", "raw", "defillama-protocols-full.json");

const QUIET = process.argv.includes("--quiet");
const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dEaD";
const ONE_18 = 10n ** 18n;
const RPC_TIMEOUT_MS = 6_000;
const ETH_CALL_TIMEOUT_MS = 6_000;
const MAX_LOCAL_MATCH_ROWS = 240;
const MAX_BRANDED_ROWS = 160;
const MAX_SELECTOR_PROBES = 240;

const TARGET = {
  slug: "gauntlet",
  name: "Gauntlet",
  category: "Risk Curators",
  discoveryRank: 9,
  tvlContext: "$1.398B",
  module: "gauntlet/index.js",
  adapterAddressCountContext: 79,
  surface: "generic-route-discovery",
  routeGraph: "producer asset -> accepted value -> consumer -> exit liquidity",
  productContext: [
    "Gauntlet/Aera vault infrastructure",
    "Aera V3",
    "Gauntlet Vaults",
    "MultiDepositorVault",
    "Provisioner",
    "PriceAndFeeCalculator",
    "OracleRegistry",
  ],
};

const CHAIN_CONFIG = [
  { chainLabel: "Ethereum", chainId: 1, adapterKey: "ethereum", inScope: true, caveat: false, priority: 0 },
  { chainLabel: "Base", chainId: 8453, adapterKey: "base", inScope: true, caveat: false, priority: 1 },
  { chainLabel: "Arbitrum", chainId: 42161, adapterKey: "arbitrum", inScope: true, caveat: false, priority: 2 },
  { chainLabel: "Optimism", chainId: 10, adapterKey: "optimism", inScope: true, caveat: false, priority: 3 },
  { chainLabel: "Polygon", chainId: 137, adapterKey: "polygon", inScope: true, caveat: false, priority: 4 },
  { chainLabel: "BNB/BSC", chainId: 56, adapterKey: "bsc", inScope: true, caveat: false, priority: 5 },
  { chainLabel: "Unichain", chainId: 130, adapterKey: "unichain", inScope: true, caveat: false, priority: 6 },
  { chainLabel: "Hyperliquid L1", chainId: 999, adapterKey: "hyperliquid", inScope: false, caveat: true, priority: 7 },
  { chainLabel: "Katana", chainId: null, adapterKey: "katana", inScope: false, caveat: true, priority: 8 },
  { chainLabel: "Stable", chainId: null, adapterKey: "stable", inScope: false, caveat: true, priority: 9 },
  { chainLabel: "Tempo", chainId: null, adapterKey: "tempo", inScope: false, caveat: true, priority: 10 },
  { chainLabel: "Solana", chainId: null, adapterKey: "solana", inScope: false, caveat: true, priority: 11 },
  { chainLabel: "dYdX/indexer", chainId: null, adapterKey: "dydx", inScope: false, caveat: true, priority: 12 },
];

const CHAIN_BY_LABEL = new Map(CHAIN_CONFIG.map((row) => [row.chainLabel.toLowerCase(), row]));
const CHAIN_BY_ID = new Map(CHAIN_CONFIG.filter((row) => Number.isFinite(row.chainId)).map((row) => [row.chainId, row]));

const OFFICIAL_SEEDS = [
  { product: "gtUSDa", asset: "USDC", chainLabel: "Ethereum", chainId: 1, role: "vault", address: "0x3bd9248048df95db4fbd748c6cd99c1baa40bad0" },
  { product: "gtUSDa", asset: "USDC", chainLabel: "Ethereum", chainId: 1, role: "provisioner", address: "0x74C4A66CE4F4779B11E7c63D42e51EEef3A80D11" },
  { product: "gtUSDa", asset: "USDC", chainLabel: "Ethereum", chainId: 1, role: "calculator", address: "0x8F3FfA11CD5915f0E869192663b905504A2Ef4a5" },
  { product: "gtUSDa", asset: "USDC", chainLabel: "Base", chainId: 8453, role: "vault", address: "0x000000000001CdB57E58Fa75Fe420a0f4D6640D5" },
  { product: "gtUSDa", asset: "USDC", chainLabel: "Base", chainId: 8453, role: "provisioner", address: "0x18CF8d963E1a727F9bbF3AEffa0Bd04FB4dBdA07" },
  { product: "gtUSDa", asset: "USDC", chainLabel: "Base", chainId: 8453, role: "calculator", address: "0x69dD4D44eed6BbC33B8A0bdFe17897Ab9044372e" },
  { product: "gtUSDa", asset: "USDC", chainLabel: "Arbitrum", chainId: 42161, role: "vault", address: "0x000000001DC8bd45d7E7829fb1c969cbe4D0D1eC" },
  { product: "gtUSDa", asset: "USDC", chainLabel: "Arbitrum", chainId: 42161, role: "provisioner", address: "0xDd4a42603E6d8E515C3468789375A98c376821b3" },
  { product: "gtUSDa", asset: "USDC", chainLabel: "Arbitrum", chainId: 42161, role: "calculator", address: "0xD61ecfB5cEd67Ef4F01E0dfae591c838BfA33932" },
  { product: "gtUSDa", asset: "USDC", chainLabel: "Optimism", chainId: 10, role: "vault", address: "0x000000001DC8bd45d7E7829fb1c969cbe4D0D1eC" },
  { product: "gtUSDa", asset: "USDC", chainLabel: "Optimism", chainId: 10, role: "provisioner", address: "0xCC923371F0d3A9cA75d98E767Df9dE1cdf5799Ef" },
  { product: "gtUSDa", asset: "USDC", chainLabel: "Optimism", chainId: 10, role: "calculator", address: "0xFB6De307b11C50D8B8A0790cd5c82c620D574440" },
  { product: "gpAAFalconX", asset: null, chainLabel: "Ethereum", chainId: 1, role: "vault", address: "0x00000000d8f3d6c5DFeB2D2b5ED2276095f3aF44" },
  { product: "gpAAFalconX", asset: null, chainLabel: "Ethereum", chainId: 1, role: "provisioner", address: "0x21994912f1D286995c4d4961303cBB8E44939944" },
  { product: "gpSyrupUSDC", asset: null, chainLabel: "Ethereum", chainId: 1, role: "vault", address: "0x00000000D283e5f8294e7E2dc06b55D43e060F49" },
  { product: "gpSyrupUSDC", asset: null, chainLabel: "Ethereum", chainId: 1, role: "provisioner", address: "0xA582D1b9c74892100986b7f2913468FaF350ba41" },
  { product: "gtBTC", asset: null, chainLabel: "Ethereum", chainId: 1, role: "vault", address: "0xefF0AE5b39271b33f448cD408b51DC8aA72a672b" },
  { product: "gtBTC", asset: null, chainLabel: "Ethereum", chainId: 1, role: "provisioner", address: "0xD580c26F7bD8A8a66fd32a97Df2308C083b65d9c" },
  { product: "gtUSCC", asset: null, chainLabel: "Ethereum", chainId: 1, role: "vault", address: "0x02b6bFD9561aC669305A0af0e5b88D9Cf850Bf67" },
  { product: "gtUSCC", asset: null, chainLabel: "Ethereum", chainId: 1, role: "provisioner", address: "0xa9cdBbaFD61bc29C80989e5805c41f611BA7a5DA" },
];

const LOCAL_CONTEXT_FILES = [
  "reports/raw/fast/new-vault-donation-attack.json",
  "reports/raw/fast/critical-erc4626-consumer-donation-review.json",
  "reports/raw/fast/erc4626-v4-hook-overlaps.json",
  "reports/raw/fast/opentrade-phase0-extra-producers.json",
  "reports/raw/fast/opentrade-phase0-rwa-nav-consumer-graph.json",
  "reports/raw/fast/erc4626-consumer-joiner.json",
  "reports/raw/fast/morpho-public-allocator-force-feed.json",
];

const CATEGORY_RULES = {
  consumer: ["consumer", "accepted", "collateral", "market", "borrow", "lending", "morpho", "aave", "euler", "silo", "compound", "open trade", "opentrade", "rwa nav"],
  oracle: ["oracle", "price", "feed", "chainlink", "pyth", "redstone", "nav", "valuation", "priceandfee", "price and fee", "oracleregistry", "rate"],
  vault: ["erc4626", "vault", "share", "totalassets", "converttoassets", "converttoshares", "preview", "redeem", "withdraw", "deposit", "multidepositor"],
  dex: ["dex", "swap", "pool", "amm", "uniswap", "curve", "balancer", "aerodrome", "pancake", "liquidity", "router", "quote", "exit liquidity"],
  access: ["owner", "guardian", "role", "admin", "permission", "pause", "pauser", "curator", "provisioner", "allocator", "registry"],
  economics: ["profit", "positive", "bps", "spread", "liquid", "slippage", "tvl", "liquidity", "price", "nav", "economics"],
};

const JOIN_CATEGORIES = ["consumer", "oracle", "vault", "dex"];

const VIEW_PROBES = [
  { group: "metadata", name: "name", signature: "name()", args: () => [], decode: ["string"] },
  { group: "metadata", name: "symbol", signature: "symbol()", args: () => [], decode: ["string"] },
  { group: "metadata", name: "decimals", signature: "decimals()", args: () => [], decode: ["uint8"] },
  { group: "erc20", name: "totalSupply", signature: "totalSupply()", args: () => [], decode: ["uint256"] },
  { group: "erc4626", name: "asset", signature: "asset()", args: () => [], decode: ["address"] },
  { group: "erc4626", name: "totalAssets", signature: "totalAssets()", args: () => [], decode: ["uint256"] },
  { group: "erc4626", name: "convertToAssets", signature: "convertToAssets(uint256)", args: () => [ONE_18], decode: ["uint256"] },
  { group: "erc4626", name: "convertToShares", signature: "convertToShares(uint256)", args: () => [ONE_18], decode: ["uint256"] },
  { group: "erc4626", name: "previewDeposit", signature: "previewDeposit(uint256)", args: () => [ONE_18], decode: ["uint256"] },
  { group: "erc4626", name: "previewRedeem", signature: "previewRedeem(uint256)", args: () => [ONE_18], decode: ["uint256"] },
  { group: "erc4626", name: "maxDeposit", signature: "maxDeposit(address)", args: () => [DEAD], decode: ["uint256"] },
  { group: "erc4626", name: "maxRedeem", signature: "maxRedeem(address)", args: () => [DEAD], decode: ["uint256"] },
  { group: "admin", name: "owner", signature: "owner()", args: () => [], decode: ["address"] },
  { group: "admin", name: "guardian", signature: "guardian()", args: () => [], decode: ["address"] },
  { group: "admin", name: "paused", signature: "paused()", args: () => [], decode: ["bool"] },
];

const PROVISIONER_PROBES = [
  { group: "provisioner", name: "requestDeposit", signature: "requestDeposit(uint256,address,address)", args: () => [1n, DEAD, DEAD], decode: [] },
  { group: "provisioner", name: "requestRedeem", signature: "requestRedeem(uint256,address,address)", args: () => [1n, DEAD, DEAD], decode: [] },
  { group: "provisioner", name: "claimDeposit", signature: "claimDeposit(uint256,address,address)", args: () => [0n, DEAD, DEAD], decode: [] },
  { group: "provisioner", name: "claimRedeem", signature: "claimRedeem(uint256,address,address)", args: () => [0n, DEAD, DEAD], decode: [] },
];

function log(...args) {
  if (!QUIET) console.log(...args);
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function writeJson(filePath, value) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, jsonReplacer, 2)}\n`, "utf8");
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (_) {
    return null;
  }
}

function readJson(filePath, fallback = null) {
  const text = (readText(filePath) || "").replace(/^\uFEFF/, "");
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch (_) {
    return fallback;
  }
}

function rel(filePath) {
  return path.relative(WORKSPACE, filePath).replace(/\\/g, "/");
}

function safeText(value, max = 260) {
  return String(value ?? "")
    .replace(/[\r\n|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max) || null;
}

function sanitizeText(value, max = 320) {
  let text = safeText(value, max);
  if (text === null) return null;
  text = text
    .replace(/\bhttps?:\/\/[^\s"'`<>|)]+/gi, "[redacted-url]")
    .replace(/\bwww\.[^\s"'`<>|)]+/gi, "[redacted-url]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/= -]+/gi, "Bearer [redacted]")
    .replace(/\b(authorization|api[-_]?key|access[-_]?key|private[-_]?key|secret[-_]?key|secret|token|password|pwd)\s*[:=]\s*["']?[^\s"',}\]]{8,}/gi, "$1=[redacted]")
    .replace(/\b0x[0-9a-fA-F]{64}\b/g, "[redacted-hex-key]")
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9._-]{20,}\.[A-Za-z0-9._-]{20,}\b/g, "[redacted-jwt]");
  return text;
}

function sanitizeError(error, max = 220) {
  return sanitizeText(error?.shortMessage || error?.message || error || "call failed", max);
}

function normalizeAddress(value) {
  const raw = String(value || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) return null;
  try {
    return ethers.getAddress(raw);
  } catch (_) {
    return raw.toLowerCase();
  }
}

function addressKey(value) {
  const address = normalizeAddress(value);
  return address ? address.toLowerCase() : null;
}

function uniqBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    const lower = String(key).toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(item);
  }
  return out;
}

function uniq(items) {
  return uniqBy(items, (item) => item);
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  const n = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function hexPayload(raw) {
  return String(raw || "").replace(/^0x/, "").toLowerCase();
}

function toBigIntFromHex(raw) {
  const h = hexPayload(raw);
  if (!h) return null;
  try {
    return BigInt(`0x${h}`);
  } catch (_) {
    return null;
  }
}

function selectorFromSignature(signature) {
  try {
    return ethers.id(signature).slice(0, 10);
  } catch (_) {
    return null;
  }
}

function serializeDecoded(value) {
  if (value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(serializeDecoded);
  if (value && typeof value === "object") {
    if (typeof value.toString === "function" && value.constructor?.name !== "Object") return value.toString();
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = serializeDecoded(v);
    return out;
  }
  if (typeof value === "string") return sanitizeText(value, 160);
  return value;
}

function decodeResult(probe, raw) {
  if (!raw || raw === "0x" || !probe.decode || probe.decode.length === 0) return null;
  try {
    const iface = new ethers.Interface([`function ${probe.signature}`]);
    const decoded = iface.decodeFunctionResult(probe.name, raw);
    if (decoded.length === 1) return serializeDecoded(decoded[0]);
    return serializeDecoded([...decoded]);
  } catch (_) {
    try {
      const coder = ethers.AbiCoder.defaultAbiCoder();
      const decoded = coder.decode(probe.decode, raw);
      if (decoded.length === 1) return serializeDecoded(decoded[0]);
      return serializeDecoded([...decoded]);
    } catch (err) {
      return sanitizeError(err, 120);
    }
  }
}

function encodeCallData(probe) {
  const iface = new ethers.Interface([`function ${probe.signature}`]);
  return iface.encodeFunctionData(probe.name, probe.args());
}

function rpcCallClassification(resp) {
  if (!resp) return { ok: false, status: "unknown", transportOk: false, reverted: false, rpcError: "no-response" };
  if (resp.ok) return { ok: true, status: "ok", transportOk: true, reverted: false, rpcError: null };
  const rawError = sanitizeText(resp.error || "rpc-error", 180);
  if (!resp.transport) return { ok: false, status: rawError || "transport-error", transportOk: false, reverted: false, rpcError: rawError };
  if (/execution reverted|revert|reverted/i.test(rawError || "")) return { ok: false, status: "reverted", transportOk: true, reverted: true, rpcError: rawError };
  return { ok: false, status: rawError || "rpc-error", transportOk: true, reverted: false, rpcError: rawError };
}

async function rpcPost(url, method, params, timeoutMs = RPC_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { "content-type": "application/json" };
  const origin = getOrigin(url);
  if (origin) headers.origin = origin;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_) {
      json = null;
    }
    if (!res.ok) return { ok: false, status: res.status, transport: true, error: `http-${res.status}` };
    if (!json) return { ok: false, status: res.status, transport: true, error: "invalid-json" };
    if (json.error && !("result" in json)) {
      return { ok: false, status: res.status, transport: true, error: sanitizeText(json.error.message || json.error.code || "rpc-error", 180) };
    }
    return { ok: true, status: res.status, transport: true, result: json.result ?? null };
  } catch (err) {
    return { ok: false, status: 0, transport: false, error: err?.name === "AbortError" ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

async function probeChainState(chainConfig, rpcUrl, rpcInventoryRows) {
  const row = {
    chainLabel: chainConfig.chainLabel,
    chainId: chainConfig.chainId,
    inScope: Boolean(chainConfig.inScope),
    caveat: Boolean(chainConfig.caveat),
    rpcInventoryRows,
    rpcResolved: false,
    rpcSource: "none",
    rpcStatus: "not-probed",
    chainIdObserved: null,
    chainIdMatch: null,
    blockNumber: null,
    blockNumberHex: null,
    blockStatus: "not-probed",
    rpcError: null,
    _rpcUrl: rpcUrl || null,
  };

  if (!Number.isFinite(chainConfig.chainId)) {
    row.rpcStatus = "no-evm-chain-id";
    return row;
  }
  if (!rpcUrl) {
    row.rpcStatus = "unresolved";
    return row;
  }

  row.rpcResolved = true;
  row.rpcSource = "shared-rpc-helper";
  const chainResp = await rpcPost(rpcUrl, "eth_chainId", [], RPC_TIMEOUT_MS);
  const chainClass = rpcCallClassification(chainResp);
  if (!chainClass.ok) {
    row.rpcStatus = chainClass.status;
    row.rpcError = chainClass.rpcError;
    return row;
  }
  row.rpcStatus = "ready";
  const observed = toBigIntFromHex(chainResp.result);
  if (observed !== null) {
    row.chainIdObserved = Number(observed);
    row.chainIdMatch = row.chainIdObserved === chainConfig.chainId;
  }

  const blockResp = await rpcPost(rpcUrl, "eth_blockNumber", [], RPC_TIMEOUT_MS);
  const blockClass = rpcCallClassification(blockResp);
  if (blockClass.ok && blockResp.result) {
    row.blockStatus = "ok";
    row.blockNumberHex = String(blockResp.result);
    const block = toBigIntFromHex(blockResp.result);
    row.blockNumber = block === null ? null : block.toString();
  } else {
    row.blockStatus = blockClass.status;
  }
  return row;
}

function sanitizedChainProbe(row) {
  return {
    chainLabel: row.chainLabel,
    chainId: row.chainId,
    inScope: row.inScope,
    caveat: row.caveat,
    rpcInventoryRows: row.rpcInventoryRows,
    rpcResolved: row.rpcResolved,
    rpcSource: row.rpcSource,
    rpcStatus: row.rpcStatus,
    chainIdObserved: row.chainIdObserved,
    chainIdMatch: row.chainIdMatch,
    blockNumber: row.blockNumber,
    blockNumberHex: row.blockNumberHex,
    blockStatus: row.blockStatus,
    rpcError: row.rpcError,
  };
}

async function runSelectorProbe(rpcUrl, chainProbe, target, probe) {
  const selector = selectorFromSignature(probe.signature);
  let data = selector;
  try {
    data = encodeCallData(probe);
  } catch (err) {
    return {
      chainLabel: target.chainLabel,
      chainId: target.chainId,
      blockNumber: chainProbe.blockNumber,
      address: target.address,
      product: target.product,
      role: target.role,
      group: probe.group,
      name: probe.name,
      signature: probe.signature,
      selector,
      success: false,
      reverted: false,
      status: "encode-error",
      errorSnippet: sanitizeError(err),
      resultSnippet: null,
      classification: "unavailable",
    };
  }

  const response = await rpcPost(rpcUrl, "eth_call", [{ from: DEAD, to: target.address, data }, "latest"], ETH_CALL_TIMEOUT_MS);
  const cls = rpcCallClassification(response);
  const decoded = cls.ok ? decodeResult(probe, response.result) : null;
  return {
    chainLabel: target.chainLabel,
    chainId: target.chainId,
    blockNumber: chainProbe.blockNumber,
    address: target.address,
    product: target.product,
    role: target.role,
    group: probe.group,
    name: probe.name,
    signature: probe.signature,
    selector,
    success: cls.ok,
    reverted: cls.reverted,
    status: cls.status,
    errorSnippet: cls.ok ? null : sanitizeText(cls.rpcError || cls.status, 180),
    resultSnippet: cls.ok ? sanitizeText(typeof decoded === "string" ? decoded : JSON.stringify(decoded), 180) : null,
    classification: cls.ok ? "watch-only-nonreverting-eth-call" : cls.reverted ? "reverted-eth-call" : "error-or-unavailable",
  };
}

function probesForRole(role) {
  if (role === "vault") return VIEW_PROBES;
  if (role === "provisioner") {
    return [
      ...VIEW_PROBES.filter((probe) => ["metadata", "admin"].includes(probe.group)),
      ...PROVISIONER_PROBES,
    ];
  }
  if (role === "calculator") return VIEW_PROBES.filter((probe) => ["metadata", "admin", "erc4626"].includes(probe.group));
  return VIEW_PROBES.filter((probe) => ["metadata", "admin"].includes(probe.group));
}

async function probeAddressTarget(target, chainProbe) {
  const row = {
    chainLabel: target.chainLabel,
    chainId: target.chainId,
    blockNumber: chainProbe.blockNumber,
    address: target.address,
    product: target.product,
    asset: target.asset || null,
    role: target.role,
    source: target.source,
    codePresent: false,
    codeBytes: null,
    codeStatus: "not-probed",
    selectorResults: [],
  };

  if (!chainProbe.rpcResolved || chainProbe.rpcStatus !== "ready" || !chainProbe._rpcUrl) {
    row.codeStatus = "no-rpc";
    return row;
  }

  const codeResp = await rpcPost(chainProbe._rpcUrl, "eth_getCode", [target.address, "latest"], RPC_TIMEOUT_MS);
  const codeClass = rpcCallClassification(codeResp);
  if (!codeClass.ok) {
    row.codeStatus = codeClass.status;
    return row;
  }
  const codeHex = codeResp.result || "0x";
  const codeBytes = Math.max(0, Math.floor(hexPayload(codeHex).length / 2));
  row.codePresent = codeHex !== "0x" && codeBytes > 0;
  row.codeBytes = codeBytes;
  row.codeStatus = row.codePresent ? "present" : "empty";
  if (!row.codePresent) return row;

  const probes = probesForRole(target.role);
  for (const probe of probes) {
    if (row.selectorResults.length >= MAX_SELECTOR_PROBES) break;
    row.selectorResults.push(await runSelectorProbe(chainProbe._rpcUrl, chainProbe, target, probe));
  }
  return row;
}

function normalizeSeedRows() {
  return OFFICIAL_SEEDS.map((row) => ({
    ...row,
    address: normalizeAddress(row.address),
    source: "official-public-seed",
  })).filter((row) => Boolean(row.address));
}

function collectAdapterSamples(deepRows) {
  const rows = [];
  for (const row of deepRows) {
    const samples = row?.adapter?.adapterAddressSamples || row?.adapterAddressSamples || [];
    for (const address of samples) {
      const normalized = normalizeAddress(address);
      if (!normalized) continue;
      rows.push({
        product: "adapter-sample",
        asset: null,
        chainLabel: null,
        chainId: null,
        role: "adapter-sample",
        address: normalized,
        source: "local-deep-discovery-adapter-sample",
      });
    }
  }
  return rows;
}

function buildAddressRows(seedRows, adapterRows) {
  return uniqBy([...seedRows, ...adapterRows], (row) => `${row.chainId || "na"}:${row.address}:${row.role}:${row.product}`);
}

function findRowsBySlug(data, slug, max = 8) {
  const out = [];
  const seen = new Set();
  function visit(value, depth = 0) {
    if (out.length >= max || depth > 8 || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    if (String(value.slug || "").toLowerCase() === slug) {
      const key = JSON.stringify({ slug: value.slug, name: value.name, rank: value.rank, module: value.module || value.adapter?.module });
      if (!seen.has(key)) {
        seen.add(key);
        out.push(value);
      }
    }
    for (const child of Object.values(value)) visit(child, depth + 1);
  }
  visit(data, 0);
  return out;
}

function sanitizeDiscoveryRow(row, source) {
  if (!row) return null;
  return {
    source,
    rank: row.rank ?? null,
    kind: row.kind ?? null,
    slug: row.slug || null,
    name: row.name || null,
    category: row.category || null,
    tvlUsd: asNumber(row.tvlUsd ?? row.tvl) || null,
    chains: Array.isArray(row.chains) ? row.chains : [],
    accessibleEvmChains: Array.isArray(row.accessibleEvmChains) ? row.accessibleEvmChains : [],
    accessibleNonEvmChains: Array.isArray(row.accessibleNonEvmChains) ? row.accessibleNonEvmChains : [],
    blockedOrCaveatChains: Array.isArray(row.blockedOrCaveatChains) ? row.blockedOrCaveatChains : [],
    surface: row.surface || null,
    routeGraph: row.routeGraph || null,
    module: row.adapter?.module || row.module || null,
    adapterFetched: row.adapter?.adapterFetched ?? null,
    adapterAddressCount: asNumber(row.adapter?.adapterAddressCount) || null,
    adapterHints: row.adapter?.adapterHints || [],
    adapterAddressSamples: (row.adapter?.adapterAddressSamples || []).map(normalizeAddress).filter(Boolean),
    routePositive: asNumber(row.routePositive) || 0,
    executableNow: asNumber(row.executableNow) || 0,
    signedActionJustified: Boolean(row.signedActionJustified),
    forkJustified: Boolean(row.forkJustified),
  };
}

function loadDiscoveryRows() {
  const deep = readJson(DEEP_METADATA_FILE, {});
  const eigen = readJson(EIGENPHI_DISCOVERY_FILE, {});
  const deepRows = findRowsBySlug(deep, TARGET.slug, 6).map((row) => sanitizeDiscoveryRow(row, rel(DEEP_METADATA_FILE))).filter(Boolean);
  const eigenRows = findRowsBySlug(eigen, TARGET.slug, 6).map((row) => sanitizeDiscoveryRow(row, rel(EIGENPHI_DISCOVERY_FILE))).filter(Boolean);
  return { deepRows, eigenRows };
}

function loadDefillamaProtocolRecord() {
  const data = readJson(DEFILLAMA_PROTOCOLS_FILE, null);
  const rows = Array.isArray(data?.value) ? data.value : Array.isArray(data) ? data : [];
  const row = rows.find((item) => String(item?.slug || "").toLowerCase() === TARGET.slug) || null;
  if (!row) return null;
  return {
    source: rel(DEFILLAMA_PROTOCOLS_FILE),
    id: row.id || null,
    name: row.name || null,
    slug: row.slug || null,
    category: row.category || null,
    module: row.module || null,
    chains: Array.isArray(row.chains) ? row.chains : [],
    chain: row.chain || null,
    tvl: asNumber(row.tvl) || null,
    chainTvls: row.chainTvls || null,
    audits: row.audits || null,
    misrepresentedTokens: row.misrepresentedTokens ?? null,
  };
}

function listScanFiles() {
  const files = [];
  function addDir(dir) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) continue;
      if (!/\.(json|md)$/i.test(entry.name)) continue;
      const r = rel(full).toLowerCase();
      if (r === OUT_JSON_REL.toLowerCase() || r === OUT_MD_REL.toLowerCase()) continue;
      if (/(?:full-test|route-positive-sweep|audit-completion-gates|low-fund-executable-route-filter|route-gate-consistency-audit|exploit-findings-summary|handoff|shared_context|state)/i.test(r)) continue;
      files.push(full);
    }
  }
  addDir(path.join(WORKSPACE, "reports"));
  addDir(RAW_DIR);
  for (const file of [DEFILLAMA_PROTOCOLS_FILE, DEEP_METADATA_FILE, EIGENPHI_DISCOVERY_FILE, ...LOCAL_CONTEXT_FILES.map((p) => path.join(WORKSPACE, p))]) {
    if (fs.existsSync(file)) files.push(file);
  }
  return uniq(files.map((file) => path.resolve(file)));
}

function categoriesFor(text, filePath = "") {
  const hay = `${filePath} ${String(text || "")}`.toLowerCase();
  const out = [];
  for (const [category, terms] of Object.entries(CATEGORY_RULES)) {
    if (terms.some((term) => hay.includes(term.toLowerCase()))) out.push(category);
  }
  return out.length ? out : ["context"];
}

function snippetAround(text, index, width = 180) {
  const start = Math.max(0, index - width);
  const end = Math.min(text.length, index + width);
  return sanitizeText(text.slice(start, end), 360);
}

function scanLocalArtifacts(addressRows) {
  const exactAddresses = uniq(addressRows.map((row) => addressKey(row.address)).filter(Boolean));
  const exactNames = uniq([
    ...OFFICIAL_SEEDS.map((row) => row.product),
    "gtUSDa",
    "gpAAFalconX",
    "gpSyrupUSDC",
    "gtBTC",
    "gtUSCC",
  ].map((term) => String(term).toLowerCase()));
  const contextTerms = uniq([
    "gauntlet",
    "aera",
    "aera v3",
    "gauntlet vault",
    "gauntlet vaults",
    "gauntlet usdc",
    "gauntlet weth",
    "gauntlet wbtc",
    "aera vault",
    "multidepositorvault",
    "priceandfeecalculator",
    "oracleregistry",
  ]);

  const rows = [];
  let filesWithExact = 0;
  let filesWithContext = 0;

  for (const file of listScanFiles()) {
    const text = readText(file);
    if (!text) continue;
    const lower = text.toLowerCase();
    const filePath = rel(file);
    const fileHasExact = exactAddresses.some((term) => lower.includes(term)) || exactNames.some((term) => lower.includes(term));
    const fileHasContext = contextTerms.some((term) => lower.includes(term));
    if (!fileHasExact && !fileHasContext) continue;
    if (fileHasExact) filesWithExact += 1;
    else filesWithContext += 1;

    const lines = text.split(/\r?\n/);
    const lowerLines = lines.map((line) => line.toLowerCase());
    let sampled = 0;
    const seen = new Set();
    for (let i = 0; i < lowerLines.length && sampled < 30; i += 1) {
      const line = lowerLines[i];
      const exactAddress = exactAddresses.find((term) => line.includes(term));
      const exactName = exactNames.find((term) => {
        if (!line.includes(term)) return false;
        if (term === "gtbtc" && !/(gauntlet|aera|0x[a-f0-9]{40})/.test(line)) return false;
        return true;
      });
      const contextTerm = contextTerms.find((term) => line.includes(term));
      if (!exactAddress && !exactName && !contextTerm) continue;
      const term = exactAddress || exactName || contextTerm;
      const lineIndex = line.indexOf(term);
      const context = snippetAround(lines[i], Math.max(0, lineIndex), 210);
      const matchType = exactAddress ? "exact-address" : exactName ? "exact-name" : "context";
      const key = `${filePath}:${i + 1}:${matchType}:${term}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const categories = categoriesFor(context, filePath);
      rows.push({
        file: filePath,
        line: i + 1,
        matchType,
        matched: term,
        categories,
        context,
      });
      sampled += 1;
      if (rows.length >= MAX_LOCAL_MATCH_ROWS) break;
    }
    if (rows.length >= MAX_LOCAL_MATCH_ROWS) break;
  }

  const exactRows = rows.filter((row) => row.matchType === "exact-address" || row.matchType === "exact-name");
  const contextRows = rows.filter((row) => !exactRows.includes(row));
  return {
    rows,
    exactRows,
    contextRows,
    filesWithExact,
    filesWithContext,
    categoryCounts: rows.reduce((acc, row) => {
      for (const cat of row.categories) acc[cat] = (acc[cat] || 0) + 1;
      return acc;
    }, {}),
  };
}

function compactObjectContext(value) {
  if (!value || typeof value !== "object") return null;
  const fields = ["name", "symbol", "label", "protocol", "market", "vault", "asset", "chain", "chainId", "address", "token", "pool", "tvl", "liquidityUsd", "routePositive"];
  const parts = [];
  for (const field of fields) {
    if (value[field] === null || value[field] === undefined) continue;
    let val = value[field];
    if (typeof val === "object") val = JSON.stringify(val).slice(0, 120);
    parts.push(`${field}=${val}`);
  }
  if (!parts.length) return sanitizeText(JSON.stringify(value).slice(0, 380), 360);
  return sanitizeText(parts.join("; "), 360);
}

function extractAddressFromObject(value) {
  if (!value || typeof value !== "object") return null;
  for (const key of ["address", "vault", "pool", "token", "contract", "asset", "market", "pairAddress"]) {
    const address = normalizeAddress(value[key]);
    if (address) return address;
  }
  return null;
}

function extractBrandedRows() {
  const files = LOCAL_CONTEXT_FILES.map((file) => path.join(WORKSPACE, file)).filter((file) => fs.existsSync(file));
  const out = [];
  const re = /gauntlet|aera|gtusda|gpaafalconx|gpsyrupusdc|gtbtc|gtuscc|multidepositorvault|priceandfeecalculator|oracleregistry/i;

  function visit(value, file, jsonPath, depth = 0) {
    if (out.length >= MAX_BRANDED_ROWS || depth > 8 || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length && out.length < MAX_BRANDED_ROWS; i += 1) visit(value[i], file, `${jsonPath}[${i}]`, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    const context = compactObjectContext(value);
    const json = JSON.stringify(value).slice(0, 2_500);
    if (re.test(json)) {
      out.push({
        file: rel(file),
        jsonPath,
        address: extractAddressFromObject(value),
        name: sanitizeText(value.name || value.vaultName || value.label || value.marketName || null, 120),
        protocol: sanitizeText(value.protocol || value.project || value.parentProtocol || null, 120),
        chain: sanitizeText(value.chain || value.chainName || value.chainLabel || null, 80),
        chainId: value.chainId ?? null,
        categories: categoriesFor(`${context} ${jsonPath}`, rel(file)),
        context,
        classification: "local-context-only-not-route-positive",
      });
    }
    for (const [key, child] of Object.entries(value)) {
      if (out.length >= MAX_BRANDED_ROWS) break;
      if (child && typeof child === "object") visit(child, file, `${jsonPath}.${key}`, depth + 1);
    }
  }

  for (const file of files) {
    const data = readJson(file, null);
    if (!data) continue;
    visit(data, file, "$", 0);
  }

  return uniqBy(out, (row) => `${row.file}:${row.jsonPath}:${row.context}`);
}

function collectJoinRows(localRows) {
  const isJoin = (row) => Array.isArray(row.categories) && row.categories.some((category) => JOIN_CATEGORIES.includes(category));
  const consumerRows = localRows.rows.filter(isJoin);
  const exactConsumerRows = localRows.exactRows.filter(isJoin);
  const dexRows = localRows.rows.filter((row) => row.categories.includes("dex"));
  return { consumerRows, exactConsumerRows, dexRows };
}

async function runLiveProbes(seedRows, rpcInventory) {
  const chainIds = uniq(CHAIN_CONFIG.filter((c) => Number.isFinite(c.chainId)).map((c) => c.chainId));
  const pool = await resolveRpcPool(chainIds, rpcInventory);
  const chainProbes = [];
  for (const chain of CHAIN_CONFIG.sort((a, b) => a.priority - b.priority)) {
    chainProbes.push(await probeChainState(chain, Number.isFinite(chain.chainId) ? pool[chain.chainId] : null, rpcInventory.length));
  }
  const chainById = new Map(chainProbes.filter((row) => Number.isFinite(row.chainId)).map((row) => [row.chainId, row]));

  const probeTargets = seedRows.filter((row) => Number.isFinite(row.chainId)).slice(0, 60);
  const liveAddressProbes = [];
  for (const target of probeTargets) {
    const chainProbe = chainById.get(target.chainId) || { rpcResolved: false, rpcStatus: "missing-chain-state", blockNumber: null, _rpcUrl: null };
    liveAddressProbes.push(await probeAddressTarget(target, chainProbe));
  }
  return { chainProbes, liveAddressProbes };
}

function selectorRowsFromLive(liveAddressProbes) {
  const rows = [];
  for (const probe of liveAddressProbes) {
    for (const selector of probe.selectorResults || []) rows.push(selector);
  }
  return rows.slice(0, MAX_SELECTOR_PROBES);
}

function renderMarkdown(payload) {
  const lines = [];
  const s = payload.summary;
  lines.push("# 🟢 DORMANT — Gauntlet Full Test");
  lines.push("");
  lines.push(`Generated: ${payload.generatedAt}`);
  lines.push("");
  lines.push("No route-positive or executable Gauntlet/Aera path is proven. Current evidence is seed/context mapping, local artifact joins, and read-only availability probes only.");
  lines.push("");
  lines.push("## Summary");
  for (const key of ["addressRows", "seedAddressRows", "codePresentRows", "selectorProbeRows", "selectorProbeSuccessRows", "localArtifactMatchRows", "exactLocalArtifactMatchRows", "consumerJoinRows", "exactConsumerJoinRows", "dexLiquidityRows", "exactEconomicsRows", "routePositive", "executableNow", "signedActionJustified", "forkJustified", "forkGate"]) {
    lines.push(`- ${key}: ${s[key]}`);
  }
  lines.push(`- caveatChains: ${(s.caveatChains || []).join(", ") || "none"}`);
  lines.push("");
  lines.push("## Safety");
  for (const [key, value] of Object.entries(payload.safety)) lines.push(`- ${key}: ${value}`);
  lines.push("");
  lines.push("## Scope/Caveats");
  lines.push(`- Target: ${payload.target.name} (${payload.target.slug}), category=${payload.target.category}, module=${payload.target.module}, discoveryRank≈${payload.target.discoveryRank}, TVL context≈${payload.target.tvlContext}.`);
  lines.push(`- Route graph: ${payload.target.routeGraph}.`);
  lines.push(`- EVM-first chains checked or caveated: ${payload.scope.evmChains.join(", ")}.`);
  lines.push(`- Non-EVM/indexer caveats: ${payload.scope.caveatChains.join(", ")}.`);
  lines.push("- Non-reverting eth_call results are availability/revert classification only and are not treated as value movement.");
  lines.push("");
  lines.push("## Evidence");
  lines.push(`- Official seed address rows: ${s.seedAddressRows}; total address rows including adapter samples: ${s.addressRows}.`);
  lines.push(`- Local discovery rows: deep=${payload.discovery.deepRows.length}, eigenphi=${payload.discovery.eigenphiRows.length}, defillamaProtocolRecord=${payload.discovery.defillamaProtocolRecord ? "present" : "missing"}.`);
  lines.push(`- RPC/code probes: codePresentRows=${s.codePresentRows}, selectorProbeRows=${s.selectorProbeRows}, selectorProbeSuccessRows=${s.selectorProbeSuccessRows}.`);
  lines.push(`- Local artifact matches: total=${s.localArtifactMatchRows}, exact=${s.exactLocalArtifactMatchRows}, consumerJoinRows=${s.consumerJoinRows}, exactConsumerJoinRows=${s.exactConsumerJoinRows}.`);
  lines.push(`- DEX/liquidity context rows: ${s.dexLiquidityRows}; exact-positive economics rows: ${s.exactEconomicsRows}.`);
  lines.push("");
  lines.push("### Live probe samples");
  const liveSamples = payload.liveAddressProbes.filter((row) => row.codePresent).slice(0, 8);
  if (!liveSamples.length) lines.push("- No seed address with code was probed successfully under available RPC coverage.");
  for (const row of liveSamples) {
    lines.push(`- ${row.chainLabel}/${row.chainId} ${row.product}.${row.role} ${row.address}: codeBytes=${row.codeBytes}, block=${row.blockNumber || "n/a"}, selectors=${row.selectorResults.length}, success=${row.selectorResults.filter((p) => p.success).length}`);
  }
  lines.push("");
  lines.push("### Local artifact samples");
  if (!payload.localArtifactSamples.length) lines.push("- none");
  for (const row of payload.localArtifactSamples.slice(0, 12)) {
    lines.push(`- \`${row.file}:${row.line}\` [${row.matchType}; ${row.categories.join(",")}] ${row.context}`);
  }
  lines.push("");
  lines.push("### Gauntlet/Aera branded local rows");
  if (!payload.brandedLocalRows.length) lines.push("- none");
  for (const row of payload.brandedLocalRows.slice(0, 10)) {
    lines.push(`- \`${row.file}\` ${row.name || row.protocol || row.address || row.jsonPath}: ${row.context || "context-only"}`);
  }
  lines.push("");
  lines.push("## Blockers");
  for (const blocker of payload.blockers) lines.push(`- ${blocker}`);
  lines.push("");
  lines.push("## Reopen Criteria");
  for (const req of payload.reopenCriteria) lines.push(`- ${req}`);
  lines.push("");
  lines.push("## Next Read-Only Step");
  lines.push("");
  lines.push(payload.nextReadOnlyStep);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function main() {
  const generatedAt = new Date().toISOString();
  const discovery = loadDiscoveryRows();
  const defillamaProtocolRecord = loadDefillamaProtocolRecord();
  const seedRows = normalizeSeedRows();
  const adapterRows = collectAdapterSamples(discovery.deepRows);
  const addressRows = buildAddressRows(seedRows, adapterRows);
  const localArtifacts = scanLocalArtifacts(addressRows);
  const brandedLocalRows = extractBrandedRows();
  const joins = collectJoinRows(localArtifacts);

  const skipRpcInventory = process.env.GAUNTLET_SKIP_RPC_INVENTORY === "1";
  const rpcInventory = skipRpcInventory ? [] : loadRpcUrls();
  const { chainProbes, liveAddressProbes } = await runLiveProbes(seedRows, rpcInventory);
  const selectorProbeRows = selectorRowsFromLive(liveAddressProbes);

  const caveatChains = uniq([
    ...CHAIN_CONFIG.filter((row) => row.caveat).map((row) => row.chainLabel),
    ...(discovery.deepRows[0]?.blockedOrCaveatChains || []),
    ...(discovery.deepRows[0]?.accessibleNonEvmChains || []),
  ]);

  const routePositive = 0;
  const executableNow = 0;
  const signedActionJustified = false;
  const forkJustified = false;
  const forkGate = "closed-route-positive-zero";

  const summary = {
    addressRows: addressRows.length,
    seedAddressRows: seedRows.length,
    codePresentRows: liveAddressProbes.filter((row) => row.codePresent).length,
    selectorProbeRows: selectorProbeRows.length,
    selectorProbeSuccessRows: selectorProbeRows.filter((row) => row.success).length,
    localArtifactMatchRows: localArtifacts.rows.length,
    exactLocalArtifactMatchRows: localArtifacts.exactRows.length,
    consumerJoinRows: joins.consumerRows.length,
    exactConsumerJoinRows: joins.exactConsumerRows.length,
    dexLiquidityRows: joins.dexRows.length,
    exactEconomicsRows: 0,
    caveatChains,
    routePositive,
    executableNow,
    signedActionJustified,
    forkJustified,
    forkGate,
    brandedLocalRows: brandedLocalRows.length,
    chainProbeRows: chainProbes.length,
    rpcResolvedChains: chainProbes.filter((row) => row.rpcStatus === "ready").length,
    filesWithExactMatch: localArtifacts.filesWithExact,
    filesWithContextMatch: localArtifacts.filesWithContext,
  };

  const blockers = [
    "No exact Gauntlet/Aera seed vault or provisioner is joined to a material consumer with attacker-favorable accepted-value semantics.",
    "Local Gauntlet-branded Morpho/ERC4626/RWA rows are context-only and do not prove a permissionless value-movement path from producer asset to consumer to exit liquidity.",
    "Read-only selector successes are availability signals only; no state-changing value delta, share-price manipulation, withdrawal/claim drain, or oracle mispricing was measured.",
    "No exact-positive acquisition, deposit/request/claim/redeem, borrow/liquidation, or unwind economics were found in local artifacts.",
    "Provisioner, owner/guardian/pauser, curator, registry, queue, and chain/indexer constraints remain unresolved gates.",
    "Solana/dYdX/indexer and newer/caveated EVM chains remain coverage caveats for this EVM-first pass.",
    "Fork/value-delta and signed-action gates remain closed because routePositive=0.",
  ];

  const reopenCriteria = [
    "Exact seed or newly resolved Gauntlet/Aera vault/provisioner/calculator address maps to a material lending/oracle/DEX/RWA consumer with accepted value.",
    "Permissionless path can move value through deposit/request/claim/redeem/withdraw/borrow/liquidate/unwind without role, allowlist, queue, or pause blockers.",
    "Concrete economics are positive after fees, caps, delays, slippage, oracle freshness, liquidity depth, and gas.",
    "Local fork/static value-delta proof shows attacker-controlled positive balance movement before any live preflight.",
    "Independent defensive review and explicit route-specific authorization occur before any signed transaction consideration.",
  ];

  const payload = {
    generatedAt,
    scanner: "tools/scan-gauntlet-full-test.js",
    target: TARGET,
    scope: {
      kind: "defensive route-first full-test scanner",
      evmFirst: true,
      evmChains: CHAIN_CONFIG.filter((row) => Number.isFinite(row.chainId)).map((row) => row.chainLabel),
      caveatChains,
      routeGraph: TARGET.routeGraph,
    },
    safety: {
      localArtifactsRead: true,
      rpcInventorySkipped: skipRpcInventory,
      rpcInventoryRead: !skipRpcInventory && Array.isArray(rpcInventory) && rpcInventory.length > 0,
      graphqlInventoryRead: false,
      envFilesRead: false,
      privateKeysRead: false,
      keyMaterialRead: false,
      rpcUrlsStored: false,
      rawUrlsStored: false,
      signedActions: false,
      liveTransactions: false,
      broadcasts: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      ethCallOnly: true,
    },
    sourceArtifacts: [
      rel(DEEP_METADATA_FILE),
      rel(EIGENPHI_DISCOVERY_FILE),
      rel(DEFILLAMA_PROTOCOLS_FILE),
      ...LOCAL_CONTEXT_FILES,
    ],
    discovery: {
      deepRows: discovery.deepRows,
      eigenphiRows: discovery.eigenRows,
      defillamaProtocolRecord,
    },
    addressRows,
    endpointCoverage: {
      rpcInventoryRows: rpcInventory.length,
      chainCount: chainProbes.length,
      chainResolvedFromInventoryOrFallback: chainProbes.filter((row) => row.rpcStatus === "ready").length,
      chainProbes: chainProbes.map(sanitizedChainProbe),
    },
    liveAddressProbes,
    selectorProbeRows,
    localArtifactSamples: localArtifacts.rows.slice(0, 100),
    localArtifactCategoryCounts: localArtifacts.categoryCounts,
    localArtifactExactSamples: localArtifacts.exactRows.slice(0, 80),
    consumerJoinRows: joins.consumerRows.slice(0, 100),
    exactConsumerJoinRows: joins.exactConsumerRows.slice(0, 80),
    dexLiquidityContextRows: joins.dexRows.slice(0, 80),
    brandedLocalRows,
    summary,
    routePositive,
    executableNow,
    signedActionJustified,
    forkJustified,
    forkGate,
    blockers,
    reopenCriteria,
    nextReadOnlyStep: "Keep Gauntlet dormant unless an exact seed/newly resolved Aera vault joins to a material consumer with exact-positive economics; then run a focused local fork/static value-delta proof before any live preflight.",
  };

  writeJson(OUT_JSON, payload);
  ensureDir(OUT_MD);
  fs.writeFileSync(OUT_MD, renderMarkdown(payload), "utf8");
  log(JSON.stringify({ raw: OUT_JSON_REL, report: OUT_MD_REL, summary }, jsonReplacer, 2));
}

main().catch((error) => {
  console.error(sanitizeError(error) || "scan failed");
  process.exit(1);
});
