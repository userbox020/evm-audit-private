#!/usr/bin/env node
// Read-only Spectra MetaVaults Outside V2 route prefilter.
// Endpoint-backed (inventory-read only), bounded, CommonJS, deterministic.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { getOrigin, loadRpcUrls, resolveRpcPool, PUBLIC_FALLBACKS } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const REPORTS_DIR = path.join(WORKSPACE, "reports");
const OUT_JSON = path.join(RAW_DIR, "prefilter-spectra-metavaults-route-prefilter.json");
const OUT_MD = path.join(WORKSPACE, "reports", "prefilter-spectra-metavaults-route-prefilter.md");

const QUIET = process.argv.includes("--quiet");

const TARGET_SLUG = "spectra-metavaults-outside-v2";
const TARGET_NAME = "Spectra MetaVaults Outside V2";
const TARGET_CHAIN_HINTS = ["Ethereum", "Arbitrum", "Avalanche", "Base", "Flare", "Katana"];
const TARGET_CATEGORY = "Onchain Capital Allocator";
const ADAPTER_URL = "https://raw.githubusercontent.com/DefiLlama/DefiLlama-Adapters/main/projects/spectra-metavaults/index.js";
const PROTOCOL_API = "https://api.llama.fi/protocol/spectra-metavaults-outside-v2";
const MAX_ADDRESSES = 24;
const MAX_MATCH_CONTEXT_ROWS = 24;

const CHAIN_CONFIG = [
  { chain: "Ethereum", chainId: 1, adapterKey: "ethereum", llamaKey: "ethereum", geckoNetwork: "eth", rpcPriority: 0 },
  { chain: "Arbitrum", chainId: 42161, adapterKey: "arbitrum", llamaKey: "arbitrum", geckoNetwork: "arbitrum", rpcPriority: 1 },
  { chain: "Avalanche", chainId: 43114, adapterKey: "avax", llamaKey: "avalanche", geckoNetwork: "avax", rpcPriority: 2 },
  { chain: "Base", chainId: 8453, adapterKey: "base", llamaKey: "base", geckoNetwork: "base", rpcPriority: 3 },
  { chain: "Flare", chainId: 14, adapterKey: "flare", llamaKey: "flare", geckoNetwork: null, rpcPriority: 4 },
  { chain: "Katana", chainId: 747474, adapterKey: "katana", llamaKey: "katana", geckoNetwork: null, rpcPriority: 5 },
];

const FALLBACK_ADDRESSES = [
  "0x16b28223b607b4d90e2ec628fdc1a0ad9ee1f6b8",
  "0xa355dd06f35bcfe98e45f743397b729b93c560be",
  "0xa2c9da26c1982cacaf01c5c691e0cf0aeb031ac1",
  "0xacf33983cab5f9e914e6a93a2f4d531b5c516602",
  "0x191ea03cccc27546ba9f5161b4948b6afce5263f",
  "0x2154a519d08bfd3f6e0303fd3ac0511c58424bbe",
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
const ONE_SHARE = 10n ** 18n;

const ERC20_IFACE = new ethers.Interface([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
]);

const ERC20_PROBES = [
  { group: "erc20", name: "symbol", signature: "symbol()", args: () => [] },
  { group: "erc20", name: "name", signature: "name()", args: () => [] },
  { group: "erc20", name: "decimals", signature: "decimals()", args: () => [] },
  { group: "erc20", name: "totalSupply", signature: "totalSupply()", args: () => [] },
].map((row) => ({ ...row, selector: ERC20_IFACE.getFunction(row.name).selector }));

const VAULT_IFACE = new ethers.Interface([
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "function maxDeposit(address receiver) view returns (uint256)",
  "function maxMint(address receiver) view returns (uint256)",
  "function maxWithdraw(address owner) view returns (uint256)",
  "function maxRedeem(address owner) view returns (uint256)",
]);

const VAULT_PROBES = [
  { group: "erc4626", name: "asset", signature: "asset()", args: () => [] },
  { group: "erc4626", name: "totalAssets", signature: "totalAssets()", args: () => [] },
  { group: "erc4626", name: "convertToAssets", signature: "convertToAssets(uint256)", args: () => [ONE_SHARE] },
  { group: "erc4626", name: "previewRedeem", signature: "previewRedeem(uint256)", args: () => [ONE_SHARE] },
  { group: "erc4626", name: "maxDeposit", signature: "maxDeposit(address)", args: () => [PROBE_FROM] },
  { group: "erc4626", name: "maxMint", signature: "maxMint(address)", args: () => [PROBE_FROM] },
  { group: "erc4626", name: "maxWithdraw", signature: "maxWithdraw(address)", args: () => [PROBE_FROM] },
  { group: "erc4626", name: "maxRedeem", signature: "maxRedeem(address)", args: () => [PROBE_FROM] },
].map((row) => ({ ...row, selector: VAULT_IFACE.getFunction(row.name).selector }));

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
  const address = normalizeAddress(value);
  return address ? address.toLowerCase() : null;
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
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "evm-audit-spectra-prefilter/1.2" },
    });
    if (!res.ok) return null;
    return await res.text();
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
      module: "projects/spectra-metavaults/index.js",
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
    module: json.module || "projects/spectra-metavaults/index.js",
  };
}

async function fetchAdapterAddresses() {
  const source = await fetchText(ADAPTER_URL, 35_000);
  if (!source) {
    return { ok: false, addresses: [], source: "fetch-failed" };
  }

  const chainRows = [];
  for (const row of CHAIN_CONFIG) {
    const address = parseAdapterAddressFromSource(source, row.adapterKey) || parseAdapterAddressFromSource(source, row.llamaKey);
    if (address) {
      chainRows.push({
        chain: row.chain,
        chainId: row.chainId,
        adapterKey: row.adapterKey,
        address,
      });
    }
  }

  if (chainRows.length === 0) {
    const found = [];
    const re = /0x[a-fA-F0-9]{40}/g;
    let match;
    while ((match = re.exec(source)) !== null) {
      const normalized = normalizeAddress(match[0]);
      if (normalized) found.push(normalized);
    }

    const addresses = uniqInOrder(found);
    if (addresses.length === 0) {
      return { ok: false, addresses: [], source: "no-addresses" };
    }

    return {
      ok: true,
      addresses: addresses.slice(0, MAX_ADDRESSES),
      source: "adapter-source-fallback-regex",
      sourceRows: [],
      addressChainMap: new Map(),
      addressesTotal: addresses.length,
    };
  }

  const addressChainMap = new Map();
  const dedupedChainRows = [];
  const seen = new Set();

  for (const row of chainRows) {
    const lower = row.address.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      dedupedChainRows.push(row);
    }
    addressChainMap.set(lower, {
      chain: row.chain,
      chainId: row.chainId,
      adapterKey: row.adapterKey,
      address: row.address,
    });
  }

  const addresses = dedupedChainRows.map((row) => row.address);
  if (addresses.length === 0) {
    return { ok: false, addresses: [], source: "no-addresses" };
  }

  return {
    ok: true,
    addresses: addresses.slice(0, MAX_ADDRESSES),
    source: "adapter-source",
    sourceRows: dedupedChainRows.slice(0, MAX_ADDRESSES),
    addressChainMap,
    addressesTotal: chainRows.length,
  };
}

function listFilesRecursive(base, predicate, acc = []) {
  const items = fs.readdirSync(base, { withFileTypes: true });
  for (const entry of items) {
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
  if (!text) return 0;
  let count = 0;
  let index = text.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
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

  const unique = uniqInOrder(files.map((file) => path.normalize(file)).sort());
  return unique.filter((file) => {
    const rel = path.relative(WORKSPACE, file).replace(/\\/g, "/");
    if (rel === path.relative(WORKSPACE, OUT_JSON).replace(/\\/g, "/")) return false;
    return file !== OUT_MD;
  });
}

function matchCategory(fileRel) {
  const isConsumerArtifact = Array.from(CONSUMER_REPORT_PATTERNS).some((re) => re.test(fileRel));
  return isConsumerArtifact ? "consumer-artifact" : "report-or-source";
}

function localMatches(address, files) {
  const needle = address.toLowerCase();
  const rows = [];
  let total = 0;
  let consumerMatchRows = 0;

  for (const file of files) {
    const text = readTextCached(file);
    if (!text) continue;
    const count = occurrenceCount(text, needle);
    if (count <= 0) continue;

    const index = text.indexOf(needle);
    const sample = snippetFromText(text, needle, index);
    const rel = path.relative(WORKSPACE, file).replace(/\\/g, "/");
    const category = matchCategory(rel);
    if (category === "consumer-artifact") consumerMatchRows += 1;
    total += count;

    rows.push({ source: rel, category, count, sample });
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
    if (typeof raw === "string") {
      return ethers.getAddress(raw);
    }
  } catch (_error) {
    return null;
  }
  return null;
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
    const n = Number(raw);
    return Number.isFinite(n) ? n : 18;
  }
  return 18;
}

function parseAdapterAddressFromSource(source, adapterKey) {
  if (!source || !adapterKey) return null;
  const key = String(adapterKey).trim();
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sectionRegex = new RegExp(`\"?${escaped}\"?\\s*:\\s*\\[[\\s\\S]*?\\]`, "is");
  const sectionMatch = source.match(sectionRegex);
  if (!sectionMatch) return null;
  const entryRegex = /\"?metavaultRegistry\"?\s*:\s*[\"'](0x[a-fA-F0-9]{40})[\"']/i;
  const match = sectionMatch[0].match(entryRegex);
  return match?.[1] ? normalizeAddress(match[1]) : null;
}

function positiveRaw(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;
  if (typeof value === "bigint") return value > 0n;
  if (typeof value === "string") {
    if (value === "0" || value === "0x" || value === "") return false;
    if (/^0x/i.test(value)) {
      try { return BigInt(value) > 0n; } catch (_error) { return true; }
    }
    return Number(value) > 0;
  }
  return false;
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
    return {
      group: spec.group,
      name: spec.name,
      signature: spec.signature,
      selector: spec.selector,
      status: "ok",
      raw: raw.result,
      value: decoded.length === 1 ? serializeValue(decoded[0]) : decoded.map((x) => serializeValue(x)),
      decodeBytes: Math.max(0, (strip0x(raw.result).length / 2)),
      valueType: decoded.length === 1 ? typeof decoded[0] : "array",
    };
  } catch (_error) {
    return {
      group: spec.group,
      name: spec.name,
      signature: spec.signature,
      selector: spec.selector,
      status: `decode-error`,
      raw: null,
      value: null,
      decodeError: _error?.message || "unknown",
    };
  }
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
    endpointSource: coverageCfg.endpointSource || "missing",
    adapterSourceChain: addressContext.sourceChain || null,
    sourceChainId: addressContext.sourceChainId || null,
    localMatches: addressContext.localMatches,
    localMatchRows: addressContext.localMatchRows,
    consumerJoinMatchRows: addressContext.consumerJoinMatchRows,
    consumerJoin: addressContext.consumerJoinMatchRows > 0,
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
    },
    selectorProbes: {
      erc20: [],
      erc4626: [],
    },
    erc4626Probe: {
      asset: null,
      totalAssetsRaw: null,
      totalAssets: null,
      totalAssetsUsd: null,
      convertToAssetsOneShareRaw: null,
      previewRedeemOneShareRaw: null,
      maxDepositRaw: null,
      maxMintRaw: null,
      maxWithdrawRaw: null,
      maxRedeemRaw: null,
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
    rowBase.selectorProbes.erc4626 = VAULT_PROBES.map((probe) => ({
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
    const vaultRows = await Promise.all(VAULT_PROBE_SET(rpcUrl, addressContext.address));
    rowBase.selectorProbes.erc20 = erc20Rows;
    rowBase.selectorProbes.erc4626 = vaultRows;
    rowBase.rpcCoverage.probeAttempts += erc20Rows.length + vaultRows.length;
    rowBase.rpcCoverage.probeSuccesses += erc20Rows.filter((row) => row.status === "ok").length + vaultRows.filter((row) => row.status === "ok").length;

    const find = (name) => rowBase.selectorProbes.erc4626.find((row) => row.name === name)?.value ?? null;
    const totalAssetsRaw = find("totalAssets");
    const convertRaw = find("convertToAssets");
    const previewRaw = find("previewRedeem");
    const maxDepositRaw = find("maxDeposit");
    const maxMintRaw = find("maxMint");
    const maxWithdrawRaw = find("maxWithdraw");
    const maxRedeemRaw = find("maxRedeem");
    const assetRaw = find("asset");

    const decimals = normalizeDecimals(erc20Rows.find((row) => row.name === "decimals" && row.status === "ok")?.value);
    const asset = parseAddressFromRaw(assetRaw);

    const assetsNumber = totalAssetsRaw === null ? null : totalAssetsRaw;
    const convertNumber = convertRaw === null ? null : convertRaw;
    const previewNumber = previewRaw === null ? null : previewRaw;

    rowBase.erc4626Probe = {
      asset,
      totalAssetsRaw: assetsNumber === null ? null : String(assetsNumber),
      totalAssets: totalAssetsRaw === null ? null : String(totalAssetsRaw),
      convertToAssetsOneShareRaw: convertNumber === null ? null : String(convertNumber),
      previewRedeemOneShareRaw: previewNumber === null ? null : String(previewNumber),
      maxDepositRaw: maxDepositRaw === null ? null : String(maxDepositRaw),
      maxMintRaw: maxMintRaw === null ? null : String(maxMintRaw),
      maxWithdrawRaw: maxWithdrawRaw === null ? null : String(maxWithdrawRaw),
      maxRedeemRaw: maxRedeemRaw === null ? null : String(maxRedeemRaw),
      decimals,
    };

    if (maxDepositRaw !== null && positiveRaw(maxDepositRaw)) rowBase.notes.push("maxDeposit-open");
    if (maxRedeemRaw !== null && positiveRaw(maxRedeemRaw)) rowBase.notes.push("maxRedeem-open");
    rowBase.notes.push(`metadata-${rowBase.erc4626Probe.asset ? "asset-present" : "asset-unknown"}`);
  } else {
    rowBase.selectorProbes.erc20 = ERC20_PROBES.map((probe) => ({
      ...probe,
      status: "skipped-no-code",
      raw: null,
      value: null,
    }));
    rowBase.selectorProbes.erc4626 = VAULT_PROBES.map((probe) => ({
      ...probe,
      status: "skipped-no-code",
      raw: null,
      value: null,
    }));
    rowBase.notes.push("no-code-probe-skipped");
  }

  if (!rowBase.notes.length) rowBase.notes.push("rpc-probed");

  return rowBase;
}

function VAULT_PROBE_SET(rpcUrl, address) {
  return VAULT_PROBES.map((probe) => probeSelector(rpcUrl, address, VAULT_IFACE, probe));
}

async function resolveEndpoints(chainRows) {
  const chainIds = chainRows.map((row) => row.chainId).filter((chainId) => Number.isFinite(chainId));
  const inventory = uniqInOrder(loadRpcUrls());
  const resolved = await resolveRpcPool(chainIds, inventory);

  const byChain = {};
  const chainSummaries = chainRows.map((row) => {
    const endpoint = resolved[row.chainId] || null;
    const fallback = row.chainId && PUBLIC_FALLBACKS[row.chainId] ? PUBLIC_FALLBACKS[row.chainId] : null;
    const endpointSource = !endpoint
      ? "missing"
      : (fallback && endpoint === fallback && !inventory.includes(endpoint) ? "fallback" : "inventory");

    byChain[row.chainId] = endpoint;
    return {
      chain: row.chain,
      chainId: row.chainId,
      endpointSource,
      rpcResolved: Boolean(endpoint),
      endpointFromInventory: Boolean(endpoint && endpointSource === "inventory"),
      endpointFromFallback: Boolean(endpointSource === "fallback"),
      endpointResolvedRows: null,
    };
  });

  return {
    inventoryRows: inventory.length,
    chainById: byChain,
    chainSummaries,
  };
}

function renderEndpointCoverage(endpointCoverage, chainSummaries) {
  const rows = chainSummaries.map((row) => `| ${row.chain} | ${row.chainId} | ${row.rowCount || 0} | ${row.endpointSource} | ${row.rpcResolved ? "yes" : "no"} | ${row.note || "-"} |`);
  return `| Chain | Chain ID | Chain rows | Endpoint Source | RPC Resolved | Note |
|---|---:|---:|---|---:|---|
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
    .slice(0, 12)
    .map((row) => {
      const codeLabel = row.rpcCoverage.codeProbeStatus === "ok" ? "code-present" : row.rpcCoverage.codeProbeStatus || "no-rpc";
      const depositLabel = row.erc4626Probe.maxDepositRaw && String(row.erc4626Probe.maxDepositRaw) !== "0" ? "open" : "closed";
      const match = row.localMatchRows || 0;
      return `| ${formatAddress(row.address)} | ${row.chain} | ${row.source} | ${match} | ${codeLabel} | ${depositLabel} | ${row.notes[0] || "probed"} |`;
    })
    .join("\n");

  const topContextRows = artifact.consumerContext.rows
    .slice(0, 12)
    .map((row) => `| ${row.address} | ${row.source} | ${row.count} | ${safeText(row.sample, 120)} |`)
    .join("\n");

  const topContextSection = topContextRows.length
    ? `\n## Top Local Consumer/Report Matches\n\n| Address | Source | Count | Context |\n|---|---|---:|---|\n${topContextRows}\n`
    : `\n## Top Local Consumer/Report Matches\n\n| Address | Source | Count | Context |\n|---|---|---:|---|\n| (none) | n/a | 0 | no matches in configured consumer artifacts |\n`;

  return `# 🟢 DORMANT - ${TARGET_NAME} Route Prefilter

Date: ${date}

Artifact: reports/raw/fast/prefilter-spectra-metavaults-route-prefilter.json

Claim: discovery/spectra-metavaults-route-prefilter

## Result

Endpoint-backed bounded scan completed for candidate rows across configured chain hints. Adapter/source discovery still produced only the six known candidate addresses and no exact route-positive or signed/executive proof was proven. No exact-positive fork/static value-delta route was verified on this pass; route remains dormant.

## Current Metrics

| Surface | Current Value | Route |
|---|---:|---:|
| DeFiLlama TVL | ${formatUsd(artifact.metadata.currentTvlUsd)} | 0 |
| Candidate addresses checked | ${summary.addressRowsChecked} | 0 |
| On-chain rows checked | ${summary.onchainRows} | 0 |
| Local artifact matches | ${summary.localArtifactMatchRows} (context-only) | 0 |
| Consumer join rows | ${summary.consumerJoinRows} | 0 |
| RPC-blocked chains | ${summary.rpcBlockedRows} | 0 |
| Code-present rows | ${summary.codePresentRows} | 0 |
| ERC4626 probe rows | ${summary.erc4626ProbeRows} | 0 |
| Public maxDeposit rows | ${summary.publicDepositRows} | 0 |
| Public maxRedeem rows | ${summary.publicRedeemRows} | 0 |

## Endpoint Coverage

${endpointRows}

## Top Rows

| Address | Chain | Source | Local Matches | On-chain | Public maxDeposit | Note |
|---|---|---|---:|---|---:|---|
${topRows || "| (none) | | | 0 | no-probe | 0 | no rows scanned |"}

${topContextSection}

## Route Gate

Route-negative remains by fail-closed logic unless exact positive economics are proven with exact borrow/redeem/lend outcomes.

### Remaining blockers

- no proven same-block redeem/exit/acquisition route was found from local and on-chain contextual evidence
- no material trusted lending/oracle consumer with confirmed borrower-side value overvalue was proven
- no exact-positive fork/static value-delta route was proven
- maxDeposit/maxRedeem are not confirmed positive at route scale

## Caveats

- Endpoint inventory read from \`rpc_endpoints.txt\` is used for resolution only; RPC URLs and GraphQL URLs are never persisted.
- Endpoint source and call status data are sanitized and do not include raw URLs.
- No GraphQL inventory was queried in this pass.
`;
}

async function main() {
  const startedAt = new Date().toISOString();
  const localFiles = buildLocalFiles();
  const [metadata, adapterResult, endpointResolution] = await Promise.all([
    fetchProtocolMetadata(),
    fetchAdapterAddresses(),
    resolveEndpoints(CHAIN_CONFIG),
  ]);

  const adapterUsedFallback = !adapterResult.ok;
  const baseAddresses = adapterUsedFallback
    ? FALLBACK_ADDRESSES
    : uniqInOrder([...(adapterResult.addresses || []), ...FALLBACK_ADDRESSES]);
  const addresses = baseAddresses.slice(0, MAX_ADDRESSES).map((value) => normalizeAddress(value)).filter(Boolean);
  const addressChainMap = adapterResult.ok && adapterResult.addressChainMap instanceof Map
    ? adapterResult.addressChainMap
    : new Map();

  const addressContexts = [];
  let localArtifactMatchRows = 0;
  let consumerJoinRows = 0;
  for (const address of addresses) {
    const local = localMatches(address, localFiles);
    localArtifactMatchRows += local.total;
    if (local.consumerMatchRows > 0) consumerJoinRows += 1;
    const chainHint = addressChainMap.get(address.toLowerCase()) || null;

    addressContexts.push({
      address,
      source: adapterUsedFallback
        ? "fallback"
        : chainHint
          ? `adapter-source:${chainHint.chain}`
          : adapterResult.source || "adapter-source",
      sourceChain: chainHint ? chainHint.chain : null,
      sourceChainId: chainHint ? chainHint.chainId : null,
      sourceChainAdapterKey: chainHint ? chainHint.adapterKey : null,
      localMatches: local.rows.slice(0, 3),
      localMatchRows: local.total,
      consumerJoinMatchRows: local.consumerMatchRows,
    });
  }

  const addressToConsumerRows = [];
  for (const row of addressContexts.filter((row) => row.consumerJoinMatchRows > 0)) {
    addressToConsumerRows.push({
      address: row.address,
      sourceRows: row.localMatches,
      count: row.localMatchRows,
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

  const rpcAvailableRows = addressRows.filter((row) => row.rpcCoverage.rpcAvailable);
  const rpcUnavailableRows = addressRows.filter((row) => !row.rpcCoverage.rpcAvailable);
  const selectorProbeRows = addressRows.reduce(
    (acc, row) => acc + (row.selectorProbes?.erc20?.length || 0) + (row.selectorProbes?.erc4626?.length || 0),
    0
  );
  const successfulSelectorRows = addressRows.reduce(
    (acc, row) => acc + (row.selectorProbes?.erc20 || []).filter((probe) => probe.status === "ok").length + (row.selectorProbes?.erc4626 || []).filter((probe) => probe.status === "ok").length,
    0
  );

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
    },
  };

  const codePresentRows = addressRows.filter((row) => row.rpcCoverage.codePresent).length;
  const erc4626ProbeRows = addressRows.filter((row) =>
    (row.selectorProbes.erc4626 || []).some((r) => r.status === "ok")
  ).length;
  const publicDepositRows = addressRows.filter((row) => positiveRaw(row.erc4626Probe.maxDepositRaw)).length;
  const publicRedeemRows = addressRows.filter((row) => positiveRaw(row.erc4626Probe.maxRedeemRaw)).length;
  const rpcBlockedRows = endpointChainSummaries.filter((row) => !row.rpcResolved).length;
  const rpcBlocked = endpointChainSummaries
    .filter((row) => !row.rpcResolved)
    .map((row) => ({
      protocol: TARGET_NAME,
      chain: row.chain,
      chainId: row.chainId,
      missingEndpointClass: "EVM RPC",
      candidateRows: addresses.length,
      skippedChecks: ["vault code/state probes", "ERC20 metadata", "ERC4626 vault-like probes", "consumer joins"],
      reason: "No matching RPC from rpc_endpoints.txt or immediate in-memory fallback for this bounded pass",
    }));

  const consumerContextRows = addressToConsumerRows.slice(0, MAX_MATCH_CONTEXT_ROWS).map((entry) => ({
    address: entry.address,
    source: entry.sourceRows[0]?.source || "consumer-artifact",
    count: entry.count,
    sample: entry.sourceRows[0]?.sample || null,
  }));

  const artifact = {
    generatedAt: startedAt,
    scanner: "tools/scan-spectra-metavaults-prefilter.js",
    scope: "Spectra MetaVaults Outside V2 route prefilter",
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
      source: "projects/spectra-metavaults/index.js",
      sourceAddressRows: adapterResult.sourceRows ? adapterResult.sourceRows.length : (adapterResult.addresses?.length || 0),
      fallbackUsed: adapterUsedFallback,
      fallbackAddresses: FALLBACK_ADDRESSES,
      sourceAddressSamples: adapterResult.addresses ? adapterResult.addresses.slice(0, 12) : [],
      sourceChainRows: adapterResult.sourceRows || [],
      sourceAddressLookup: Object.fromEntries(
        (adapterResult.sourceRows || []).map((row) => [String(row.chainId), row.chain])
      ),
      methodology: adapterUsedFallback
        ? "Adapter source fetch failed/unsupported; fallback addresses used"
        : "Adapter source addresses extracted from raw GitHub adapter source (bounded), fallback retained for resilience",
    },
    endpointCoverage,
    addressRows,
    onchainRows: addressRows,
    rpcBlocked,
    consumerContext: {
      totalLocalMatches: localArtifactMatchRows,
      rows: consumerContextRows,
    },
    summary: {
      addressRowsChecked: addressContexts.length,
      localArtifactMatchRows,
      consumerJoinRows,
      dexLiquidityRows: 0,
      maxDexLiquidityUsd: 0,
      exactEconomicsRows: 0,
      rpcBlockedRows,
      onchainRows: addressRows.length,
      codePresentRows,
      erc4626ProbeRows,
      publicDepositRows,
      publicRedeemRows,
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      forkJustified: false,
    },
    erc4626ProbeRows,
    codePresentRows,
    publicDepositRows,
    publicRedeemRows,
    blockers: [
      "No same-block redeem/exit/acquisition route was proven from local evidence.",
      "No material trusted consumer join with material borrow cash was proven.",
      "No exact-positive borrowing/liquidation/static value-delta route was proven.",
      "ERC20/ERC4626 on-chain probes ran where possible; missing RPC coverage remains a caveat, not route-negative proof.",
    ],
    nextRoutePositiveCriteria: [
      "A Spectra share token is accepted by a lending consumer with material borrow cash and an overvalue versus redeem/market value.",
      "A same-block redeem/exit path proves exact positive post-donation economics.",
      "An on-chain or DEX exit path is liquidity-safe at material size with exact route-positive value delta.",
    ],
    caveats: [
      "RPC endpoints were loaded from sanitized local inventory only; no endpoint URLs were stored in outputs.",
      "No GraphQL endpoint inventory was read in this pass.",
      "On-chain probes are bounded and best-effort; selector failure is recorded per probe while the run continues.",
    ],
  };

  ensureDir(OUT_JSON);
  fs.writeFileSync(OUT_JSON, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  const report = renderReport(artifact);
  fs.writeFileSync(OUT_MD, report, "utf8");

  if (!QUIET) {
    console.log(`Spectra endpoint-backed prefilter: addresses=${artifact.summary.addressRowsChecked}, onchainRows=${artifact.summary.onchainRows}, codeRows=${artifact.summary.codePresentRows}, erc4626Rows=${artifact.summary.erc4626ProbeRows}, rpcBlockedChains=${artifact.summary.rpcBlockedRows}, routePositive=${artifact.summary.routePositive}`);
    console.log(`Artifact: ${path.relative(WORKSPACE, OUT_JSON).replace(/\\/g, "/")}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
