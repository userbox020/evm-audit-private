#!/usr/bin/env node
// Read-only WrappedFi bridge/proof-custody route prefilter.
// Endpoint-backed (inventory-read only), bounded, deterministic.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { getOrigin, loadRpcUrls, resolveRpcPool } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const REPORTS_DIR = path.join(WORKSPACE, "reports");
const OUT_JSON = path.join(RAW_DIR, "prefilter-wrappedfi-route-prefilter.json");
const OUT_MD = path.join(WORKSPACE, "reports", "prefilter-wrappedfi-route-prefilter.md");

const QUIET = process.argv.includes("--quiet");

const TARGET_SLUG = "wrapped";
const TARGET_NAME = "Wrapped";
const TARGET_CHAIN_HINTS = ["Ripple", "Celo", "Ethereum"];
const TARGET_CATEGORY = "Bridge";
const ADAPTER_URL = "https://raw.githubusercontent.com/DefiLlama/DefiLlama-Adapters/main/projects/wrappedfi/index.js";
const PROTOCOL_API = "https://api.llama.fi/protocol/wrapped";
const MAX_ADDRESSES = 12;
const MAX_MATCH_CONTEXT_ROWS = 24;

const CHAIN_CONFIG = [
  { chain: "Ethereum", chainId: 1, adapterKey: "ethereum", llamaKey: "ethereum", geckoNetwork: "eth", rpcPriority: 0 },
  { chain: "Celo", chainId: 42220, adapterKey: "celo", llamaKey: "celo", geckoNetwork: "celo", rpcPriority: 1 },
];

const NON_EVM_CHAIN_CONFIG = [
  { chain: "Ripple", chainId: null, notes: "non-EVM custody/proof chain in discovery context; unsupported by this EVM-only prefilter" },
];

const FALLBACK_ADDRESSES = [
  "0x84d9dcAc2f00F2Cd903E340b5241EB6e5c198572",
  "0xD6873b9592AB601E6cE6a6A781799d54961942F3",
];

const LOCAL_ARTIFACT_FILES = [
  "consumer-first-high-ltv-collateral.json",
  "euler-v2-phase0.json",
  "silo-v2-phase0.json",
  "aave-euler-silo-consumer-graph.json",
  "morpho-high-apy-liquidation-routes.json",
  "erc4626-consumer-joiner.json",
  "rwa-nav-consumer-graph.json",
  "current-profit-leads.json",
  "route-positive-sweep.json",
];

const CONSUMER_REPORT_PATTERNS = new Set([
  /consumer-first-high-ltv-collateral\.json$/,
  /euler-v2-phase0\.json$/,
  /silo-v2-phase0\.json$/,
  /aave-euler-silo-consumer-graph\.json$/,
  /morpho-high-apy-liquidation-routes\.json$/,
  /erc4626-consumer-joiner\.json$/,
  /rwa-nav-consumer-graph\.json$/,
  /route-positive-sweep\.json$/,
  /current-profit-leads\.json$/,
]);

const RPC_TIMEOUT_MS = 9_000;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const PROBE_FROM = ZERO_ADDRESS;

const ERC20_IFACE = new ethers.Interface([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
]);

const BRIDGE_IFACE = new ethers.Interface([
  "function owner() view returns (address)",
  "function admin() view returns (address)",
  "function paused() view returns (bool)",
  "function totalAssets() view returns (uint256)",
  "function asset() view returns (address)",
  "function underlying() view returns (address)",
  "function minter() view returns (address)",
  "function bridge() view returns (address)",
  "function gateway() view returns (address)",
  "function l1Token() view returns (address)",
  "function l2Token() view returns (address)",
  "function remoteToken() view returns (address)",
  "function canonicalToken() view returns (address)",
  "function token() view returns (address)",
  "function collateral() view returns (address)",
  "function balanceOf(address account) view returns (uint256)",
]);

const ERC20_PROBES = [
  { group: "erc20", name: "symbol", signature: "symbol()", args: () => [] },
  { group: "erc20", name: "name", signature: "name()", args: () => [] },
  { group: "erc20", name: "decimals", signature: "decimals()", args: () => [] },
  { group: "erc20", name: "totalSupply", signature: "totalSupply()", args: () => [] },
  { group: "erc20", name: "balanceOf", signature: "balanceOf(address)", args: () => [PROBE_FROM] },
].map((probe) => ({ ...probe, selector: ERC20_IFACE.getFunction(probe.name).selector }));

const BRIDGE_PROBES = [
  { group: "bridge", name: "owner", signature: "owner()", args: () => [] },
  { group: "bridge", name: "admin", signature: "admin()", args: () => [] },
  { group: "bridge", name: "paused", signature: "paused()", args: () => [] },
  { group: "bridge", name: "totalAssets", signature: "totalAssets()", args: () => [] },
  { group: "bridge", name: "asset", signature: "asset()", args: () => [] },
  { group: "bridge", name: "underlying", signature: "underlying()", args: () => [] },
  { group: "bridge", name: "minter", signature: "minter()", args: () => [] },
  { group: "bridge", name: "bridge", signature: "bridge()", args: () => [] },
  { group: "bridge", name: "gateway", signature: "gateway()", args: () => [] },
  { group: "bridge", name: "l1Token", signature: "l1Token()", args: () => [] },
  { group: "bridge", name: "l2Token", signature: "l2Token()", args: () => [] },
  { group: "bridge", name: "remoteToken", signature: "remoteToken()", args: () => [] },
  { group: "bridge", name: "canonicalToken", signature: "canonicalToken()", args: () => [] },
  { group: "bridge", name: "token", signature: "token()", args: () => [] },
  { group: "bridge", name: "collateral", signature: "collateral()", args: () => [] },
  { group: "bridge", name: "balanceOf", signature: "balanceOf(address)", args: () => [PROBE_FROM] },
].map((probe) => ({ ...probe, selector: BRIDGE_IFACE.getFunction(probe.name).selector }));

const LOCAL_TEXT_CACHE = new Map();

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function safeText(value, max = 140) {
  return String(value || "")
    .replace(/[\r\n|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max) || null;
}

function normalizeAddress(value) {
  try {
    return ethers.getAddress(String(value || "").trim());
  } catch (_error) {
    return null;
  }
}

function asLower(value) {
  const addr = normalizeAddress(value);
  return addr ? addr.toLowerCase() : null;
}

function uniqInOrder(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!item) continue;
    const key = String(item).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

async function fetchText(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "evm-audit-wrappedfi-prefilter/1.0" },
    });
    if (!response.ok) return null;
    return await response.text();
  } catch (_error) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, timeoutMs = 30_000) {
  const text = await fetchText(url, timeoutMs);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_error) {
    return null;
  }
}

async function fetchProtocolMetadata() {
  const json = await fetchJson(PROTOCOL_API, 35_000);
  if (!json) {
    return {
      ok: false,
      name: TARGET_NAME,
      slug: TARGET_SLUG,
      category: TARGET_CATEGORY,
      currentTvlUsd: null,
      chains: TARGET_CHAIN_HINTS,
      audits: null,
      url: null,
      module: "projects/wrappedfi/index.js",
    };
  }

  const tvlSeries = Array.isArray(json.tvl) ? json.tvl : [];
  const latest = tvlSeries.length ? tvlSeries[tvlSeries.length - 1]?.totalLiquidityUSD : null;
  return {
    ok: true,
    name: json.name || TARGET_NAME,
    slug: json.slug || TARGET_SLUG,
    category: json.category || TARGET_CATEGORY,
    currentTvlUsd: Number(latest) || null,
    chains: json.chains || TARGET_CHAIN_HINTS,
    audits: json.audits || json.audit_links || null,
    url: json.url || null,
    module: json.module || "projects/wrappedfi/index.js",
  };
}

function extractAddresses(text) {
  const re = /0x[a-fA-F0-9]{40}/g;
  const out = [];
  let match;
  while ((match = re.exec(text)) !== null) {
    const normalized = normalizeAddress(match[0]);
    if (normalized) out.push(normalized);
  }
  return out;
}

function parseAddressForChain(source, chainKey) {
  if (!source || !chainKey) return null;
  const escaped = String(chainKey).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const directKey = new RegExp(`"?${escaped}"?\s*:\s*"(0x[a-fA-F0-9]{40})"`, "i");
  const directMatch = source.match(directKey);
  if (directMatch?.[1]) return normalizeAddress(directMatch[1]);

  const directAssign = new RegExp(`(?:const|let|var)\\s+${escaped}\\s*=\\s*"(0x[a-fA-F0-9]{40})"`, "i");
  const assignMatch = source.match(directAssign);
  if (assignMatch?.[1]) return normalizeAddress(assignMatch[1]);

  const section = new RegExp(`"${escaped}"\s*:\s*(\[[\\s\\S]*?\]|\{[\\s\\S]*?\})`, "i");
  const sectionMatch = source.match(section);
  if (sectionMatch) {
    const inside = sectionMatch[1];
    const addresses = extractAddresses(inside);
    if (addresses.length) return addresses[0];
  }

  const chainObject = new RegExp(`chain\s*[:=]\s*['\"]${escaped}['\"][\\s\\S]{0,240}address\s*[:=]\s*['\"](0x[a-fA-F0-9]{40})['\"]`, "i");
  const chainObjMatch = source.match(chainObject);
  if (chainObjMatch?.[1]) return normalizeAddress(chainObjMatch[1]);

  return null;
}

async function fetchAdapterAddresses() {
  const source = await fetchText(ADAPTER_URL, 35_000);
  if (!source) {
    return {
      ok: false,
      source: "fetch-failed",
      addresses: FALLBACK_ADDRESSES.slice(),
      fallbackUsed: true,
      sourceRows: [],
      addressChainMap: new Map(),
      addressesTotal: FALLBACK_ADDRESSES.length,
      sourceAddressRows: 0,
    };
  }

  const chainRows = [];
  for (const chain of CHAIN_CONFIG) {
    let address = null;

    const keys = uniqInOrder([
      chain.adapterKey,
      chain.chain.toLowerCase(),
      chain.llamaKey,
      chain.chain.replace(/\s+/g, "").toLowerCase(),
    ]);
    for (const key of keys) {
      address = parseAddressForChain(source, key);
      if (address) break;
    }

    if (address) {
      chainRows.push({
        chain: chain.chain,
        chainId: chain.chainId,
        adapterKey: chain.adapterKey,
        address,
      });
    }
  }

  const seen = new Set();
  const dedupedChainRows = [];
  for (const row of chainRows) {
    const lower = row.address.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    dedupedChainRows.push(row);
  }

  const sourceAddressMap = new Map();
  for (const row of dedupedChainRows) {
    sourceAddressMap.set(row.address.toLowerCase(), {
      chain: row.chain,
      chainId: row.chainId,
      adapterKey: row.adapterKey,
      address: row.address,
    });
  }

  if (dedupedChainRows.length === 0) {
    const extracted = extractAddresses(source);
    if (extracted.length >= 1) {
      const fallback = uniqInOrder(extracted.concat(FALLBACK_ADDRESSES));
      return {
        ok: true,
        source: "adapter-source-fallback-regex",
        addresses: fallback.slice(0, MAX_ADDRESSES),
        fallbackUsed: true,
        sourceRows: [],
        addressChainMap: sourceAddressMap,
        addressesTotal: extracted.length,
        sourceAddressRows: 0,
      };
    }

    return {
      ok: false,
      source: "no-addresses",
      addresses: FALLBACK_ADDRESSES.slice(),
      fallbackUsed: true,
      sourceRows: [],
      addressChainMap: sourceAddressMap,
      addressesTotal: FALLBACK_ADDRESSES.length,
      sourceAddressRows: 0,
    };
  }

  return {
    ok: true,
    source: "adapter-source",
    addresses: uniqInOrder(dedupedChainRows.map((row) => row.address).concat(FALLBACK_ADDRESSES)).slice(0, MAX_ADDRESSES),
    fallbackUsed: false,
    sourceRows: dedupedChainRows.slice(0, MAX_ADDRESSES),
    addressChainMap: sourceAddressMap,
    addressesTotal: chainRows.length,
    sourceAddressRows: dedupedChainRows.length,
  };
}

function listFilesRecursive(base, predicate, acc = []) {
  const entries = fs.readdirSync(base, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(base, entry.name);
    if (entry.isDirectory()) {
      listFilesRecursive(full, predicate, acc);
    } else if (entry.isFile() && predicate(full)) {
      acc.push(full);
    }
  }
  return acc;
}

function readTextCached(file) {
  if (!fs.existsSync(file)) return null;
  if (LOCAL_TEXT_CACHE.has(file)) return LOCAL_TEXT_CACHE.get(file);
  try {
    const text = fs.readFileSync(file, "utf8").toLowerCase();
    LOCAL_TEXT_CACHE.set(file, text);
    return text;
  } catch (_error) {
    return null;
  }
}

function occurrenceCount(text, needle) {
  if (!text || !needle) return 0;
  let count = 0;
  let index = text.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}

function earliestIndex(text, needle) {
  if (!text || !needle) return -1;
  return text.indexOf(needle);
}

function snippetFromText(text, needle, index) {
  if (!text || index < 0) return null;
  const start = Math.max(0, index - 72);
  const end = Math.min(text.length, index + needle.length + 72);
  return safeText(text.slice(start, end), 220);
}

function buildLocalFiles() {
  const files = [];
  for (const fileName of LOCAL_ARTIFACT_FILES) {
    files.push(path.join(RAW_DIR, fileName));
  }

  files.push(...listFilesRecursive(RAW_DIR, (file) => file.endsWith(".json")));
  files.push(...listFilesRecursive(REPORTS_DIR, (file) => file.endsWith(".json") || file.endsWith(".md")));

  const out = uniqInOrder(files.map((file) => path.normalize(file)).sort());
  return out.filter((file) => {
    const rel = path.relative(WORKSPACE, file).replace(/\\/g, "/");
    return rel !== path.relative(WORKSPACE, OUT_JSON).replace(/\\/g, "/") && rel !== path.relative(WORKSPACE, OUT_MD).replace(/\\/g, "/");
  });
}

function matchCategory(fileRel) {
  return Array.from(CONSUMER_REPORT_PATTERNS).some((re) => re.test(fileRel)) ? "consumer-artifact" : "report-or-source";
}

function localMatches(address, files, extraNeedles = []) {
  const baseNeedles = [];
  if (address) baseNeedles.push(String(address).toLowerCase());
  if (extraNeedles && extraNeedles.length) {
    for (const needle of extraNeedles) {
      if (!needle || typeof needle !== "string") continue;
      const lower = needle.toLowerCase().trim();
      if (lower) baseNeedles.push(lower);
    }
  }

  const needles = uniqInOrder(baseNeedles);
  const rows = [];
  let total = 0;
  let consumerMatchRows = 0;

  for (const file of files) {
    const text = readTextCached(file);
    if (!text) continue;

    let fileCount = 0;
    let sampleNeedle = null;
    let sampleIndex = Number.POSITIVE_INFINITY;

    for (const needle of needles) {
      const count = occurrenceCount(text, needle);
      if (!count) continue;
      fileCount += count;
      const idx = earliestIndex(text, needle);
      if (idx >= 0 && idx < sampleIndex) {
        sampleIndex = idx;
        sampleNeedle = needle;
      }
    }

    if (fileCount <= 0) continue;
    const rel = path.relative(WORKSPACE, file).replace(/\\/g, "/");
    const category = matchCategory(rel);
    if (category === "consumer-artifact") consumerMatchRows += 1;
    const sample = snippetFromText(text, sampleNeedle || "", sampleIndex);
    rows.push({ source: rel, category, count: fileCount, sample });
    total += fileCount;
  }

  rows.sort((a, b) => (b.count - a.count) || a.source.localeCompare(b.source));
  return { rows, total, consumerMatchRows };
}

function strip0x(value) {
  return String(value || "").replace(/^0x/i, "");
}

function serializeValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(serializeValue);
  if (typeof value === "object" && value !== null) {
    if (typeof value?.toString === "function" && typeof value !== "function") return value.toString();
    return null;
  }
  return value;
}

function parseAddressFromRaw(raw) {
  if (!raw || raw === "0x" || raw === "") return null;
  try {
    return ethers.getAddress(String(raw));
  } catch (_error) {
    return null;
  }
}

function normalizeDecimals(raw) {
  if (raw === null || raw === undefined) return 18;
  if (typeof raw === "bigint") return Number(raw);
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") {
    if (/^0x/i.test(raw)) {
      try {
        return Number(BigInt(raw));
      } catch (_error) {
        return 18;
      }
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 18;
  }
  return 18;
}

function positiveRaw(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;
  if (typeof value === "bigint") return value > 0n;
  if (typeof value === "string") {
    if (value === "0" || value === "0x" || value === "") return false;
    if (/^0x/i.test(value)) {
      try {
        return BigInt(value) > 0n;
      } catch (_error) {
        return value !== "0x" && value !== "0x0";
      }
    }
    return Number(value) > 0;
  }
  return false;
}

function asAddress(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") return null;
  return parseAddressFromRaw(raw);
}

function asBool(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw !== 0;
  if (typeof raw === "bigint") return raw !== 0n;
  if (typeof raw === "string") {
    if (raw === "0x1" || raw === "1") return true;
    if (raw === "0x0" || raw === "0") return false;
  }
  return null;
}

function errorClass(error) {
  const text = String(error?.name || error?.message || error || "unknown").toLowerCase();
  if (text.includes("abort") || text.includes("timeout")) return "timeout";
  if (text.includes("network") || text.includes("fetch") || text.includes("socket")) return "network-error";
  return "request-error";
}

async function rpcPost(url, method, params = [], timeoutMs = RPC_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { "content-type": "application/json" };
  const origin = getOrigin(url);
  if (origin) headers.origin = origin;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, status: response.status, error: `http-${response.status}` };
    }

    const json = await response.json();
    if (!json || json.error) {
      const message = json?.error?.message || "rpc-error";
      return { ok: false, status: response.status, error: String(message) };
    }

    return { ok: true, status: response.status, result: json.result ?? null };
  } catch (_error) {
    return { ok: false, status: 0, error: errorClass(_error) };
  } finally {
    clearTimeout(timer);
  }
}

async function probeSelector(url, address, iface, spec) {
  try {
    const encoded = iface.encodeFunctionData(spec.name, spec.args());
    const raw = await rpcPost(url, "eth_call", [{ to: address, from: PROBE_FROM, data: encoded }], RPC_TIMEOUT_MS);
    if (!raw.ok) {
      return {
        group: spec.group,
        name: spec.name,
        signature: spec.signature,
        selector: spec.selector,
        status: `rpc-${raw.error || "error"}`,
        raw: null,
        value: null,
      };
    }

    if (!raw.result || raw.result === "0x") {
      return {
        group: spec.group,
        name: spec.name,
        signature: spec.signature,
        selector: spec.selector,
        status: "empty-result",
        raw: raw.result || null,
        value: null,
      };
    }

    const decoded = iface.decodeFunctionResult(spec.name, raw.result);
    const flat = decoded.length === 1 ? decoded[0] : decoded;
    return {
      group: spec.group,
      name: spec.name,
      signature: spec.signature,
      selector: spec.selector,
      status: "ok",
      raw: raw.result,
      value: serializeValue(flat),
      decodeBytes: Math.max(0, (strip0x(raw.result).length / 2)),
      valueType: decoded.length === 1 ? typeof flat : "array",
    };
  } catch (_error) {
    return {
      group: spec.group,
      name: spec.name,
      signature: spec.signature,
      selector: spec.selector,
      status: "decode-error",
      raw: null,
      value: null,
      decodeError: _error?.message || "unknown",
    };
  }
}

function bridgeRowFromProbes(bridgeRows) {
  const find = (name) => bridgeRows.find((row) => row.name === name)?.value ?? null;
  const tokenProbe = find("token");
  const underlyingProbe = find("underlying");
  const assetProbe = find("asset");
  const canonicalProbe = find("canonicalToken");
  const l1Probe = find("l1Token");
  const l2Probe = find("l2Token");
  const remoteProbe = find("remoteToken");
  const collateralProbe = find("collateral");
  const bridgeProbe = find("bridge");
  const gatewayProbe = find("gateway");
  const ownerProbe = find("owner");
  const adminProbe = find("admin");
  const minterProbe = find("minter");
  const pausedProbe = find("paused");
  const totalAssetsProbe = find("totalAssets");
  const balanceProbe = find("balanceOf");

  return {
    owner: asAddress(ownerProbe),
    admin: asAddress(adminProbe),
    paused: asBool(pausedProbe),
    totalAssetsRaw: totalAssetsProbe === null ? null : String(totalAssetsProbe),
    totalAssets: totalAssetsProbe === null ? null : String(totalAssetsProbe),
    asset: parseAddressFromRaw(assetProbe) || null,
    underlying: asAddress(underlyingProbe),
    minter: asAddress(minterProbe),
    bridge: asAddress(bridgeProbe),
    gateway: asAddress(gatewayProbe),
    l1Token: asAddress(l1Probe),
    l2Token: asAddress(l2Probe),
    remoteToken: asAddress(remoteProbe),
    canonicalToken: asAddress(canonicalProbe),
    token: asAddress(tokenProbe),
    collateral: asAddress(collateralProbe),
    balanceOfZeroRaw: balanceProbe === null ? null : String(balanceProbe),
    knownTokenProbe: tokenProbe ? parseAddressFromRaw(tokenProbe) : (assetProbe ? parseAddressFromRaw(assetProbe) : (underlyingProbe ? parseAddressFromRaw(underlyingProbe) : null)),
  };
}

function getProbeValue(rows, group, name) {
  if (!rows) return null;
  return rows.find((row) => row.group === group && row.name === name)?.value ?? null;
}

async function scanRowOnChain(addressContext, chainCfg, rpcUrl, chainCoverageCfg) {
  const coverageCfg = chainCoverageCfg || {};
  const rowBase = {
    address: addressContext.address,
    chain: chainCfg.chain,
    chainId: chainCfg.chainId,
    chainKey: chainCfg.adapterKey,
    chainHint: chainCfg.chain,
    chainPriority: chainCfg.rpcPriority,
    source: addressContext.source,
    sourceChain: addressContext.sourceChain || null,
    sourceChainId: addressContext.sourceChainId || null,
    sourceChainAdapterKey: addressContext.sourceChainAdapterKey || null,
    endpointSource: coverageCfg.endpointSource || "missing",
    localMatches: addressContext.localMatches || [],
    localMatchRows: addressContext.localMatchRows || 0,
    consumerJoinMatchRows: addressContext.consumerMatchRows || 0,
    consumerJoin: addressContext.consumerMatchRows > 0,
    onchainProbe: Boolean(rpcUrl),
    rpcCoverage: {
      rpcAvailable: Boolean(rpcUrl),
      endpointSource: coverageCfg.endpointSource,
      chainIdCallStatus: null,
      blockNumberCallStatus: null,
      codeProbeStatus: null,
      chainIdObserved: null,
      chainIdMatch: null,
      blockNumber: null,
      codePresent: false,
      codeBytes: 0,
      probeAttempts: 0,
      probeSuccesses: 0,
      selectorRowsAttempted: 0,
      selectorRowsSuccessful: 0,
    },
    selectorProbes: {
      erc20: [],
      bridge: [],
    },
    bridgeProbe: {
      owner: null,
      admin: null,
      paused: null,
      totalAssetsRaw: null,
      totalAssets: null,
      asset: null,
      underlying: null,
      minter: null,
      bridge: null,
      gateway: null,
      l1Token: null,
      l2Token: null,
      remoteToken: null,
      canonicalToken: null,
      token: null,
      collateral: null,
      balanceOfZeroRaw: null,
      knownTokenProbe: null,
    },
    notes: [],
  };

  if (!rpcUrl) {
    rowBase.notes.push("rpc-unavailable");
    rowBase.rpcCoverage.chainIdCallStatus = "missing-rpc";
    rowBase.rpcCoverage.blockNumberCallStatus = "missing-rpc";
    rowBase.rpcCoverage.codeProbeStatus = "missing-rpc";
    rowBase.selectorProbes.erc20 = ERC20_PROBES.map((probe) => ({
      ...probe,
      status: "skipped-rpc",
      raw: null,
      value: null,
    }));
    rowBase.selectorProbes.bridge = BRIDGE_PROBES.map((probe) => ({
      ...probe,
      status: "skipped-rpc",
      raw: null,
      value: null,
    }));
    return rowBase;
  }

  const [chainIdRaw, blockNumberRaw, codeRaw] = await Promise.all([
    rpcPost(rpcUrl, "eth_chainId", [], RPC_TIMEOUT_MS),
    rpcPost(rpcUrl, "eth_blockNumber", [], RPC_TIMEOUT_MS),
    rpcPost(rpcUrl, "eth_getCode", [addressContext.address, "latest"], RPC_TIMEOUT_MS),
  ]);

  rowBase.rpcCoverage.probeAttempts += 3;
  if (chainIdRaw.ok) {
    rowBase.rpcCoverage.chainIdCallStatus = "ok";
    const parsed = Number.parseInt(String(chainIdRaw.result || "0"), 16);
    rowBase.rpcCoverage.chainIdObserved = Number.isFinite(parsed) ? parsed : null;
    rowBase.rpcCoverage.chainIdMatch = Number.isFinite(parsed) && parsed === chainCfg.chainId;
    if (rowBase.rpcCoverage.chainIdMatch === false) rowBase.notes.push("chain-id-mismatch");
  } else {
    rowBase.rpcCoverage.chainIdCallStatus = `rpc-${chainIdRaw.error || "error"}`;
    rowBase.notes.push("chain-id-call-failed");
  }

  if (blockNumberRaw.ok) {
    rowBase.rpcCoverage.blockNumberCallStatus = "ok";
    rowBase.rpcCoverage.blockNumber = blockNumberRaw.result;
  } else {
    rowBase.rpcCoverage.blockNumberCallStatus = `rpc-${blockNumberRaw.error || "error"}`;
    rowBase.notes.push("block-number-call-failed");
  }

  if (codeRaw.ok) {
    rowBase.rpcCoverage.codeProbeStatus = codeRaw.result && codeRaw.result !== "0x" ? "ok" : "empty-code";
    if (codeRaw.result && codeRaw.result !== "0x") {
      rowBase.rpcCoverage.codePresent = true;
      rowBase.rpcCoverage.codeBytes = codeRaw.result.length ? (codeRaw.result.length - 2) / 2 : 0;
    } else {
      rowBase.notes.push("no-contract-code");
    }
  } else {
    rowBase.rpcCoverage.codeProbeStatus = `rpc-${codeRaw.error || "error"}`;
    rowBase.notes.push("getCode-failed");
  }

  if (rowBase.rpcCoverage.codePresent) {
    const erc20Rows = await Promise.all(ERC20_PROBES.map((probe) => probeSelector(rpcUrl, addressContext.address, ERC20_IFACE, probe)));
    const bridgeRows = await Promise.all(BRIDGE_PROBES.map((probe) => probeSelector(rpcUrl, addressContext.address, BRIDGE_IFACE, probe)));

    rowBase.selectorProbes.erc20 = erc20Rows;
    rowBase.selectorProbes.bridge = bridgeRows;

    rowBase.rpcCoverage.probeAttempts += erc20Rows.length + bridgeRows.length;
    rowBase.rpcCoverage.probeSuccesses += erc20Rows.filter((row) => row.status === "ok").length + bridgeRows.filter((row) => row.status === "ok").length;
    rowBase.rpcCoverage.selectorRowsAttempted = erc20Rows.length + bridgeRows.length;
    rowBase.rpcCoverage.selectorRowsSuccessful = erc20Rows.filter((row) => row.status === "ok").length + bridgeRows.filter((row) => row.status === "ok").length;

    const findERC20 = (name) => getProbeValue(erc20Rows, "erc20", name);
    const findBridge = (name) => getProbeValue(bridgeRows, "bridge", name);

    const decimals = normalizeDecimals(findERC20("decimals"));
    const totalSupply = findERC20("totalSupply");
    const totalSupplyRaw = totalSupply === null ? null : String(totalSupply);
    const bridgeProbe = bridgeRowFromProbes(bridgeRows);
    const knownTokenProbe = bridgeProbe.knownTokenProbe || asAddress(findERC20("balanceOf")) || asAddress(findBridge("asset"));

    rowBase.bridgeProbe = {
      ...bridgeProbe,
      knownTokenProbe,
      decimals,
      totalSupplyRaw: totalSupplyRaw,
      totalSupply: totalSupplyRaw,
      symbol: findERC20("symbol") ?? null,
      name: findERC20("name") ?? null,
    };

    if (asBool(findBridge("paused")) === true) rowBase.notes.push("bridge-paused");
    if (positiveRaw(findBridge("totalAssets"))) rowBase.notes.push("total-assets-positive");
    if (knownTokenProbe) rowBase.notes.push("token-probe-present");
    if (asAddress(findERC20("symbol")) !== null) {
      // intentionally empty; balanceOf probe may exist but address-only is enough
    }
  } else {
    rowBase.selectorProbes.erc20 = ERC20_PROBES.map((probe) => ({ ...probe, status: "skipped-no-code", raw: null, value: null }));
    rowBase.selectorProbes.bridge = BRIDGE_PROBES.map((probe) => ({ ...probe, status: "skipped-no-code", raw: null, value: null }));
    rowBase.notes.push("no-code-probe-skipped");
  }

  if (!rowBase.notes.length) rowBase.notes.push("rpc-probed");
  return rowBase;
}

function BRIDGE_PROBE_SET(rpcUrl, address) {
  return BRIDGE_PROBES.map((probe) => probeSelector(rpcUrl, address, BRIDGE_IFACE, probe));
}

async function resolveEndpoints(chainRows) {
  const chainIds = chainRows.map((row) => row.chainId).filter((chainId) => Number.isFinite(chainId));
  const inventory = uniqInOrder(loadRpcUrls());
  const resolved = await resolveRpcPool(chainIds, inventory);

  const byChain = {};
  const chainSummaries = chainRows.map((row) => {
    const endpoint = resolved[row.chainId] || null;
    const endpointSource = !endpoint
      ? "missing"
      : (inventory.includes(endpoint) ? "inventory" : "fallback");
    byChain[row.chainId] = endpoint;
    return {
      chain: row.chain,
      chainId: row.chainId,
      endpointSource,
      rpcResolved: Boolean(endpoint),
      endpointFromInventory: endpointSource === "inventory",
      endpointFromFallback: endpointSource === "fallback",
      rpcAvailableRows: null,
      rowCount: null,
      rpcCoverageSummary: null,
    };
  });

  return {
    inventoryRows: inventory.length,
    chainById: byChain,
    chainSummaries,
  };
}

function renderEndpointCoverage(endpointCoverage, chainSummaries) {
  const rows = chainSummaries.map((row) => `| ${row.chain} | ${row.chainId} | ${row.endpointSource} | ${row.rpcResolved ? "yes" : "no"} | ${(row.endpointFromFallback ? "fallback" : row.endpointFromInventory ? "inventory" : row.endpointFromFallback ? "fallback" : "-")} | ${(row.rpcCoverageSummary?.rowsAttempted || 0)} | ${(row.rpcCoverageSummary?.rpcRowsAttempted || 0)} |`);
  return `| Chain | Chain ID | Endpoint Source | RPC Resolved | Coverage Bucket | Rows Attempted | RPC Rows Attempted |
|---|---:|---|---:|---|---:|---:|
 ${rows.join("\n")}`;
}

function formatAddress(addr) {
  if (!addr) return "n/a";
  return `${addr.slice(0, 8)}...${addr.slice(-6)}`;
}

function formatUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "n/a";
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function renderReport(artifact) {
  const date = artifact.generatedAt.slice(0, 10);
  const summary = artifact.summary;
  const endpointRows = renderEndpointCoverage(artifact.endpointCoverage, artifact.endpointCoverage.chains);

  const topRows = artifact.addressRows
    .slice()
    .sort((a, b) => (b.localMatchRows || 0) - (a.localMatchRows || 0) || a.chainId - b.chainId)
    .slice(0, 16)
    .map((row) => {
      const codeLabel = row.rpcCoverage.codeProbeStatus === "ok" ? "code-present" : row.rpcCoverage.codeProbeStatus || "no-rpc";
      const bridgeLabel = (row.selectorProbes.bridge || []).some((probe) => probe.name === "totalAssets" && probe.status === "ok") ? "bridge-probed" : "bridge-not-probed";
      const match = row.localMatchRows || 0;
      return `| ${formatAddress(row.address)} | ${row.chain} | ${row.source} | ${row.endpointSource} | ${match} | ${codeLabel} | ${bridgeLabel} | ${row.notes[0] || "probed"} |`;
    })
    .join("\n");

  const topContextRows = artifact.consumerContext.rows
    .slice(0, 12)
    .map((row) => `| ${row.address} | ${row.source} | ${row.count} | ${safeText(row.sample, 120)} |`)
    .join("\n");

  const topContextSection = topContextRows.length
    ? `
## Top Local Artifact/Report Matches

| Address | Source | Count | Context |
|---|---|---:|---|
${topContextRows}
`
    : `
## Top Local Artifact/Report Matches

| Address | Source | Count | Context |
|---|---|---:|---|
| (none) | n/a | 0 | no matches in candidate scopes 
`;

  const nonEvm = artifact.nonEvmChains.length ? artifact.nonEvmChains.map((row) => `- ${row.chain}: ${row.note}`).join("\n") : "- none";

  return `# 🟢 DORMANT - ${TARGET_NAME} Route Prefilter

Date: ${date}

Artifact: reports/raw/fast/prefilter-wrappedfi-route-prefilter.json

Claim: discovery/wrappedfi-route-prefilter

## Result

Endpoint-backed bounded prefilter completed for candidate rows across configured chain hints. Adapter/source discovery produced the bounded candidate set and local artifact matching is run against reports/raw/fast and reports/**/*.md. No exact route-positive or signed/executive proof was proven in this pass. Route remains dormant.

## Current Metrics

| Surface | Current Value | Route |
|---|---:|---:|
| DefiLlama TVL | ${formatUsd(artifact.metadata.currentTvlUsd)} | 0 |
| Candidate addresses checked | ${summary.addressRowsChecked} | 0 |
| Address rows checked | ${summary.addressRowsCount} | 0 |
| Local artifact matches | ${summary.localArtifactMatchRows} | 0 |
| Consumer join rows | ${summary.consumerJoinRows} | 0 |
| RPC-blocked rows | ${summary.rpcBlockedRows} | 0 |
| On-chain rows checked | ${summary.onchainRows} | 0 |
| Code-present rows | ${summary.codePresentRows} | 0 |
| Bridge probe rows | ${summary.bridgeProbeRows} | 0 |
| Selector probes attempted | ${artifact.endpointCoverage.rpcCoverageSummary.selectorRowsAttempted || 0} | 0 |
| Selector probes successful | ${artifact.endpointCoverage.rpcCoverageSummary.selectorRowsSuccessful || 0} | 0 |

## Endpoint Coverage

${endpointRows}

### Non-EVM coverage context

${nonEvm}

## Top Rows

| Address | Chain | Source | Endpoint | Local Matches | Code | Bridge Probes | Note |
|---|---|---|---|---:|---|---:|---|
${topRows || "| (none) | | | | 0 | no-probe | 0 | no rows scanned |"}

${topContextSection}

## Route Gate

Route-negative remains by fail-closed logic unless exact positive economics are proven with exact borrow/redeem/liquidation exits and same-block proof checks.

### Remaining blockers

- no proven proof/domain/nonce/domain-sep binding bypass demonstrated from on-chain or local artifact evidence
- no exact borrower/consumer path proven for any candidate token
- no exact-positive token acquisition/disposition route with mathematically exact positive value found
- Ripple remains a non-EVM coverage caveat and is not route-negative in this pass

## Caveats

- Endpoint inventory read from rpc_endpoints.txt is used for resolution only; endpoint URLs are never persisted.
- graphql_endpoints.txt is not read in this run (graphqlInventoryRead=false).
- Optional DEX/consumer enrichment is local-artifact-only and intentionally bounded to matching rows only.
`;
}


function pickProbeMetadata(addressRows) {
  const symbolMap = new Map();
  for (const row of addressRows) {
    const addressLower = String(row.address || "").toLowerCase();
    const symbol = getProbeValue(row.selectorProbes?.erc20, "erc20", "symbol");
    const name = getProbeValue(row.selectorProbes?.erc20, "erc20", "name");
    if (symbol && !symbolMap.has(addressLower)) {
      symbolMap.set(addressLower, { symbol, name });
    } else if (name && symbolMap.has(addressLower) && !symbolMap.get(addressLower).name) {
      const existing = symbolMap.get(addressLower);
      existing.name = name;
      symbolMap.set(addressLower, existing);
    }
  }
  return symbolMap;
}

async function main() {
  const startedAt = new Date().toISOString();
  const localFiles = buildLocalFiles();
  const [metadata, adapterResult, endpointResolution] = await Promise.all([
    fetchProtocolMetadata(),
    fetchAdapterAddresses(),
    resolveEndpoints(CHAIN_CONFIG),
  ]);

  const addresses = uniqInOrder((adapterResult.addresses || []).concat(FALLBACK_ADDRESSES)).slice(0, MAX_ADDRESSES)
    .map((value) => normalizeAddress(value))
    .filter(Boolean);

  const addressChainMap = adapterResult.addressChainMap instanceof Map ? adapterResult.addressChainMap : new Map();
  const adapterAddressRows = Array.isArray(adapterResult.sourceRows) ? adapterResult.sourceRows : [];
  const addressContexts = [];

  for (const address of addresses) {
    const chainHint = addressChainMap.get(address.toLowerCase()) || null;
    const baseMatches = localMatches(address, localFiles, [TARGET_NAME]);

    addressContexts.push({
      address,
      source: adapterResult.ok && adapterAddressRows.length ? `adapter-source${chainHint ? `:${chainHint.chain}` : ""}` : "fallback",
      sourceChain: chainHint ? chainHint.chain : null,
      sourceChainId: chainHint ? chainHint.chainId : null,
      sourceChainAdapterKey: chainHint ? chainHint.adapterKey : null,
      localMatches: baseMatches.rows.slice(0, 3),
      localMatchRows: baseMatches.total,
      consumerMatchRows: baseMatches.consumerMatchRows,
    });
  }

  const endpointChainSummaries = endpointResolution.chainSummaries.map((row) => ({
    ...row,
    rowCount: addresses.length,
    note: row.rpcResolved ? null : "no matching inventory endpoint found",
  }));

  const chainById = endpointResolution.chainById;
  const chainSummaryById = Object.fromEntries(endpointChainSummaries.map((row) => [row.chainId, row]));

  const addressRows = [];
  for (const ctx of addressContexts) {
    for (const chainCfg of CHAIN_CONFIG) {
      const chainSummary = chainSummaryById[chainCfg.chainId];
      const row = await scanRowOnChain(ctx, chainCfg, chainById[chainCfg.chainId], {
        endpointSource: chainSummary?.endpointSource || "missing",
      });
      addressRows.push(row);
    }
  }

  const metadataMap = pickProbeMetadata(addressRows);
  for (const ctx of addressContexts) {
    const rowMeta = metadataMap.get(ctx.address.toLowerCase()) || {};
    const extraNeedles = [rowMeta.symbol, rowMeta.name].filter(Boolean);
    const local = localMatches(ctx.address, localFiles, extraNeedles);
    ctx.localMatches = local.rows.slice(0, 3);
    ctx.localMatchRows = local.total;
    ctx.consumerMatchRows = local.consumerMatchRows;
  }

  const localMatchByAddress = new Map(addressContexts.map((ctx) => [ctx.address.toLowerCase(), ctx]));
  for (const row of addressRows) {
    const ctx = localMatchByAddress.get(row.address.toLowerCase());
    if (!ctx) continue;
    row.localMatches = ctx.localMatches;
    row.localMatchRows = ctx.localMatchRows;
    row.consumerJoinMatchRows = ctx.consumerMatchRows;
    row.consumerJoin = ctx.consumerMatchRows > 0;
  }

  const addressToConsumerRows = [];
  for (const ctx of addressContexts.filter((entry) => entry.consumerMatchRows > 0)) {
    addressToConsumerRows.push({
      address: ctx.address,
      source: ctx.localMatches?.[0]?.source || "local-artifact",
      count: ctx.localMatchRows,
      sample: ctx.localMatches?.[0]?.sample || null,
    });
  }

  const rpcAvailableRows = addressRows.filter((row) => row.rpcCoverage.rpcAvailable);
  const rpcUnavailableRows = addressRows.filter((row) => !row.rpcCoverage.rpcAvailable);
  const endpointCoveredRows = endpointChainSummaries.length;
  const selectorProbeRows = addressRows.reduce((acc, row) => acc + (row.selectorProbes?.erc20?.length || 0) + (row.selectorProbes?.bridge?.length || 0), 0);
  const successfulSelectorRows = addressRows.reduce((acc, row) => acc + (row.selectorProbes?.erc20 || []).filter((rowProbe) => rowProbe.status === "ok").length + (row.selectorProbes?.bridge || []).filter((rowProbe) => rowProbe.status === "ok").length, 0);
  const codePresentRows = addressRows.filter((row) => row.rpcCoverage.codePresent).length;
  const bridgeProbeRows = addressRows.filter((row) => (row.selectorProbes.bridge || []).some((r) => r.status === "ok")).length;
  const rpcBlockedRows = endpointChainSummaries.filter((row) => !row.rpcResolved).length;

  const rpcBlocked = endpointChainSummaries.filter((row) => !row.rpcResolved).map((row) => ({
    protocol: TARGET_NAME,
    chain: row.chain,
    chainId: row.chainId,
    missingEndpointClass: "EVM RPC",
    candidateRows: addresses.length,
    skippedChecks: ["contract metadata", "bridge-like selector probes", "consumer joins"],
    reason: "No matching RPC from rpc_endpoints.txt or allowed fallback for this bounded pass",
  }));

  const nonEvmChains = NON_EVM_CHAIN_CONFIG.map((row) => ({ chain: row.chain, chainId: row.chainId, note: row.notes }));

  const localArtifactMatchRows = addressContexts.reduce((sum, row) => sum + (row.localMatchRows || 0), 0);
  const consumerJoinRows = addressContexts.reduce((sum, row) => sum + (row.consumerMatchRows > 0 ? 1 : 0), 0);

  const endpointSummaryCountByChain = new Map();
  for (const chain of CHAIN_CONFIG) {
    endpointSummaryCountByChain.set(chain.chainId, addresses.length);
  }
  for (const chainSummary of endpointChainSummaries) {
    chainSummary.rpcCoverageSummary = {
      rowsAttempted: chainSummary.rowCount || 0,
      rpcRowsAttempted: chainSummary.rpcResolved
        ? (endpointSummaryCountByChain.get(chainSummary.chainId) || 0)
        : 0,
    };
  }

  const endpointCoverage = {
    rpcInventoryRead: true,
    rpcInventoryRows: endpointResolution.inventoryRows,
    rpcInventorySource: "rpc_endpoints.txt",
    endpointSource: "inventory-backed",
    graphqlInventoryRead: false,
    graphqlUrlsStored: false,
    chains: endpointChainSummaries,
    rpcCoverageSummary: {
      rowsAttempted: addressRows.length,
      rpcRowsAttempted: rpcAvailableRows.length,
      rpcRowsUnavailable: rpcUnavailableRows.length,
      codeRowsAttempted: rpcAvailableRows.filter((row) => row.rpcCoverage.codeProbeStatus !== "missing-rpc").length,
      selectorRowsAttempted: selectorProbeRows,
      selectorRowsSuccessful: successfulSelectorRows,
      endpointRows: endpointCoveredRows,
    },
  };

  const artifact = {
    generatedAt: startedAt,
    scanner: "tools/scan-wrappedfi-prefilter.js",
    scope: "WrappedFi proof/custody bridge consumer route prefilter",
    safety: {
      rpcInventoryRead: true,
      graphqlInventoryRead: false,
      rpcUrlsStored: false,
      graphqlUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
      forkJustified: false,
    },
    metadata,
    adapter: {
      source: "projects/wrappedfi/index.js",
      sourceAddressRows: adapterAddressRows.length,
      sourceAddressTotal: adapterResult.addressesTotal,
      fallbackUsed: !adapterResult.ok || adapterResult.fallbackUsed,
      fallbackAddresses: FALLBACK_ADDRESSES,
      sourceAddressSamples: adapterResult.addresses ? adapterResult.addresses.slice(0, 12) : [],
      sourceChainRows: adapterAddressRows,
      sourceAddressLookup: Object.fromEntries(adapterAddressRows.map((row) => [String(row.chainId), row.chain])),
      methodology: (adapterResult.ok && !adapterResult.fallbackUsed)
        ? "Bounded DefiLlama adapter source extraction from projects/wrappedfi/index.js with deterministic local parsing"
        : "Adapter source fetch failed/incomplete; fallback to discovered address context only",
    },
    endpointCoverage,
    addressRows,
    onchainRows: addressRows,
    nonEvmChains,
    rpcBlocked,
    consumerContext: {
      totalLocalMatches: localArtifactMatchRows,
      rows: addressToConsumerRows.slice(0, MAX_MATCH_CONTEXT_ROWS).map((entry) => ({
        address: entry.address,
        source: entry.source,
        count: entry.count,
        sample: entry.sample,
      })),
    },
    summary: {
      addressRowsChecked: addressContexts.length,
      addressRowsCount: addressRows.length,
      localArtifactMatchRows,
      consumerJoinRows,
      onchainRows: addressRows.length,
      codePresentRows,
      bridgeProbeRows,
      publicDepositRows: 0,
      publicRedeemRows: 0,
      rpcBlockedRows,
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      forkJustified: false,
    },
    blockers: [
      "No on-chain proof/domain/nonce/recipient binding bypass was identified from the bounded probe set.",
      "No material wrapped token consumer route with accepted-value/borrow path is proven in local artifacts.",
      "No exact positive same-block mint/burn/withdraw/redeem path with deterministic economics was proven.",
      "Ripple is non-EVM in discovery context and remains a coverage caveat, not route-negative proof.",
    ],
    nextRoutePositiveCriteria: [
      "A proof/state-backing flaw proves unlocked/wrapped mint or bypass under current governance/domain constraints without permissionless gates.",
      "Proven downstream consumer (lending/borrow/Dex unwind) receives wrapped token with material overvalue and positive immediate exit economics.",
      "Exact same-block route with full custody/deposit/redeem proof is proven with deterministic positive value delta.",
    ],
    caveats: [
      "Endpoint inventory read from `rpc_endpoints.txt` only; endpoint URLs are never persisted in outputs.",
      "GraphQL inventory was not used (`graphqlInventoryRead=false`).",
      "Optional DEX/consumer enrichment is local-only and bounded to artifact/report matches.",
      "Celo and Ethereum probing is best effort; failures are recorded per selector and are caveats only.",
    ],
  };

  ensureDir(OUT_JSON);
  fs.writeFileSync(OUT_JSON, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  const report = renderReport(artifact);
  fs.writeFileSync(OUT_MD, report, "utf8");

  if (!QUIET) {
    console.log(`WrappedFi endpoint-backed prefilter: addresses=${artifact.summary.addressRowsChecked}, onchainRows=${artifact.summary.onchainRows}, codeRows=${artifact.summary.codePresentRows}, bridgeProbeRows=${artifact.summary.bridgeProbeRows}, rpcBlockedChains=${artifact.summary.rpcBlockedRows}, routePositive=${artifact.summary.routePositive}`);
    console.log(`Artifact: ${path.relative(WORKSPACE, OUT_JSON).replace(/\\/g, "/")}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
