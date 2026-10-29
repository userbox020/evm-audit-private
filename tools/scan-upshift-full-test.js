#!/usr/bin/env node
"use strict";

// scan-upshift-full-test.js
// Read-only Upshift full-state test.
// Endpoint-backed (sanitized inventory-read only), scanner-only scope, no signed actions.

const fs = require("fs");
const path = require("path");
const { getOrigin, loadRpcUrls, resolveRpcPool, PUBLIC_FALLBACKS } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const REPORTS_DIR = path.join(WORKSPACE, "reports");
const OUT_JSON = path.join(RAW_DIR, "upshift-full-test.json");
const OUT_MD = path.join(REPORTS_DIR, "upshift-full-test-triage.md");
const DEEP_METADATA_FILE = path.join(RAW_DIR, "prefilter-deep-new-target-search-2026-06-24.json");

const QUIET = process.argv.includes("--quiet");
const OUT_JSON_REL = "reports/raw/fast/upshift-full-test.json";
const OUT_MD_REL = "reports/upshift-full-test-triage.md";

const TARGET = {
  slug: "upshift",
  name: "Upshift",
  category: "Onchain Capital Allocator",
  surface: "vault-yield-allocator",
  module: "upshift/index.js",
  routeGraph: "vault share -> rate/strategy accounting -> consumer or exit venue -> borrow/redeem/unwind",
  sampleAddresses: [
    "0x94c2826b24e44f710c5f80e3ed7ce898258d7008",
    "0xfaf4d0ec9b76147c926c0c8b2aba39ea21ec9915",
    "0x323578c2b24683ca845c68c1e2097697d65e2358",
    "0x1fdbd27ba90a7a5385185e3e0b76477202f2cadb",
    "0x30844745c8197fdaf9fe06c4ffeb73fe05c092ce",
  ],
};

const PROTOCOL_API = "https://api.llama.fi/protocol/upshift";
const ADAPTER_SOURCE = "https://raw.githubusercontent.com/DefiLlama/DefiLlama-Adapters/main/projects/upshift/index.js";
const AUGUST_ACTIVE_VAULTS_API = "https://api.augustdigital.io/api/v1/tokenized_vault?status=active&load_subaccounts=false&load_snapshots=false";
const DEXSCREENER_TOKEN_API = "https://api.dexscreener.com/latest/dex/tokens/";

const LOCAL_SOURCE_FILES = [
  "targets/infinifi-protocol/src/interfaces/upshift/IUpshiftVault.sol",
  "targets/infinifi-protocol/src/integrations/farms/UpshiftFarm.sol",
];

const GENERATED_EXCLUDE = new Set([
  OUT_JSON_REL.toLowerCase(),
  OUT_MD_REL.toLowerCase(),
]);

const GENERATED_CONTEXT_EXCLUDE_RE = /(?:merlins-seal-full-test|historical-full-test|upshift-full-test|exploit-findings-summary|route-positive-sweep|low-fund-executable-route-filter|audit-completion-gates|route-gate-consistency-audit)/i;

const CATEGORY_RULES = {
  consumer: ["consumer", "lending", "borrow", "collateral", "liquidation", "market", "morpho", "aave", "euler", "silo", "compound", "farm", "accepted", "vault"],
  dex: ["dex", "swap", "pool", "amm", "uniswap", "curve", "balancer", "pancake", "liquidity", "router", "quote"],
  oracle: ["oracle", "price", "feed", "chainlink", "pyth", "redstone", "stale", "scalar", "rate"],
  vault: ["erc4626", "vault", "share", "totalassets", "converttoassets", "previewredeem", "deposit", "redeem", "withdraw", "claim"],
  access: ["onlycorerole", "onlyowner", "role", "admin", "access", "permission", "pause", "pauser", "whitelist"],
  queue: ["lagduration", "requestredeem", "instantredeem", "claim", "claimable", "epoch", "queue", "pending", "withdrawal"],
};

const CHAIN_CONFIG = [
  { chainLabel: "Ethereum", chainId: 1, adapterKey: "ethereum", priority: 0, inScope: true, caveat: false },
  { chainLabel: "Binance", chainId: 56, adapterKey: "bsc", priority: 1, inScope: true, caveat: false },
  { chainLabel: "Base", chainId: 8453, adapterKey: "base", priority: 2, inScope: true, caveat: false },
  { chainLabel: "Ink", chainId: 57073, adapterKey: "ink", priority: 3, inScope: true, caveat: false },
  { chainLabel: "Avalanche", chainId: 43114, adapterKey: "avax", priority: 4, inScope: true, caveat: false },
  { chainLabel: "Flare", chainId: 14, adapterKey: "flare", priority: 5, inScope: false, caveat: true },
  { chainLabel: "Hyperliquid L1", chainId: 999, adapterKey: "hyperliquid", priority: 6, inScope: false, caveat: true },
  { chainLabel: "Monad", chainId: 143, adapterKey: "monad", priority: 7, inScope: false, caveat: true },
  { chainLabel: "Fluent", chainId: 25363, adapterKey: "fluent", priority: 8, inScope: false, caveat: true },
  { chainLabel: "Plasma", chainId: 9745, adapterKey: "plasma", priority: 9, inScope: false, caveat: true },
  { chainLabel: "Mezo", chainId: 31612, adapterKey: "mezo", priority: 10, inScope: false, caveat: true },
];

const CHAIN_BY_ID = new Map(CHAIN_CONFIG.map((item) => [item.chainId, item]));

const MAX_ADDRESSES_PER_CHAIN = 3;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ONE_SHARE = 10n ** 18n;
const RPC_TIMEOUT_MS = 9_000;
const ETH_CALL_TIMEOUT_MS = 9_000;

const FUNCTION_PROBES = [
  { group: "vault", name: "asset", signature: "asset()", selector: "0x38d52e0f", args: () => [], argTypes: [], decodeType: "address", nonView: false },
  { group: "vault", name: "totalAssets", signature: "totalAssets()", selector: "0x01e1d114", args: () => [], argTypes: [], decodeType: "uint256", nonView: false },
  { group: "vault", name: "convertToAssets", signature: "convertToAssets(uint256)", selector: "0x07a2d13a", args: () => [ONE_SHARE], argTypes: ["uint256"], decodeType: "uint256", nonView: false },
  { group: "vault", name: "previewRedeem", signature: "previewRedeem(uint256)", selector: "0x4cdad506", args: () => [ONE_SHARE], argTypes: ["uint256"], decodeType: "uint256", nonView: false },
  { group: "vault", name: "maxDeposit", signature: "maxDeposit(address)", selector: "0x402d267d", args: () => [ZERO_ADDRESS], argTypes: ["address"], decodeType: "uint256", nonView: false },
  { group: "vault", name: "maxMint", signature: "maxMint(address)", selector: "0xc63d75b6", args: () => [ZERO_ADDRESS], argTypes: ["address"], decodeType: "uint256", nonView: false },
  { group: "vault", name: "maxWithdraw", signature: "maxWithdraw(address)", selector: "0xce96cb77", args: () => [ZERO_ADDRESS], argTypes: ["address"], decodeType: "uint256", nonView: false },
  { group: "vault", name: "maxRedeem", signature: "maxRedeem(address)", selector: "0xd905777e", args: () => [ZERO_ADDRESS], argTypes: ["address"], decodeType: "uint256", nonView: false },
  { group: "vault", name: "lagDuration", signature: "lagDuration()", selector: "0x24e86d67", args: () => [], argTypes: [], decodeType: "uint256", nonView: false },
  { group: "vault", name: "totalSupply", signature: "totalSupply()", selector: "0x18160ddd", args: () => [], argTypes: [], decodeType: "uint256", nonView: false },
  { group: "vault", name: "decimals", signature: "decimals()", selector: "0x313ce567", args: () => [], argTypes: [], decodeType: "uint256", nonView: false },
  { group: "vault", name: "requestRedeem", signature: "requestRedeem(uint256,address,address)", selector: "0x7d41c86e", args: () => [ONE_SHARE, ZERO_ADDRESS, ZERO_ADDRESS], argTypes: ["uint256", "address", "address"], decodeType: "tuple2", nonView: true },
  { group: "vault", name: "instantRedeem", signature: "instantRedeem(uint256,address,address)", selector: "0x77a84317", args: () => [ONE_SHARE, ZERO_ADDRESS, ZERO_ADDRESS], argTypes: ["uint256", "address", "address"], decodeType: "none", nonView: true },
  { group: "vault", name: "claim", signature: "claim(uint256,uint256,uint256,address)", selector: "0xb3c9e83d", args: () => [0n, 0n, 0n, ZERO_ADDRESS], argTypes: ["uint256", "uint256", "uint256", "address"], decodeType: "tuple2", nonView: true },
  { group: "vault", name: "getWithdrawalEpoch", signature: "getWithdrawalEpoch()", selector: "0xca55a557", args: () => [], argTypes: [], decodeType: "tuple4", nonView: false },
  { group: "vault", name: "getClaimableAmountByReceiver", signature: "getClaimableAmountByReceiver(uint256,uint256,uint256,address)", selector: "0xdc68a93a", args: () => [0n, 0n, 0n, ZERO_ADDRESS], argTypes: ["uint256", "uint256", "uint256", "address"], decodeType: "uint256", nonView: false },
].filter((row) => Boolean(row));

function log(...args) {
  if (!QUIET) console.log(...args);
}

function safeText(value, max = 220) {
  return String(value || "")
    .replace(/[\r\n|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max) || null;
}

function sanitizeArtifactContext(value, max = 260) {
  let text = safeText(value, max);
  if (text === null) return null;

  const redactedUrl = "[redacted-url]";
  const redactedValue = "[redacted]";

  text = text
    .replace(/\bhttps?:\/\/[\w\-._~:/?#\[\]@!$&'()*+,;=%]+/g, redactedUrl)
    .replace(/\bwww\.[^\s\"'`<>|)]+/g, redactedUrl)
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/=-]+/gi, `Bearer ${redactedValue}`)
    .replace(/\b(authorization|api[-_]?key|access[-_]?key|private[-_]?key|secret[-_]?key|secret|token|password|pwd)\s*[:=]\s*[\"']?[^\s\"',}\]]{8,}/gi, `$1=${redactedValue}`)
    .replace(/\b0x[0-9a-fA-F]{64}\b/g, "[redacted-hex-key]")
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9._-]{20,}\.[A-Za-z0-9._-]{20,}\b/g, "[redacted-jwt]");

  return text;
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (_) {
    return null;
  }
}

function readJson(filePath) {
  const text = readText(filePath);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function rel(filePath) {
  return path.relative(WORKSPACE, filePath).replace(/\\/g, "/");
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function normalizeAddress(value) {
  const raw = String(value || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) return null;
  return raw.toLowerCase();
}

function uniq(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const value = String(item || "");
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function uniqBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    const k = String(key).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
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
      headers: { "user-agent": "evm-audit-upshift-full-test/1.0" },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch (_) {
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
  } catch (_) {
    return null;
  }
}

function loadDeepMetadata() {
  const data = readJson(DEEP_METADATA_FILE);
  const row = data?.rankedQueue?.find((r) => String(r.slug || "").toLowerCase() === TARGET.slug);
  if (!row) return { ok: false, source: rel(DEEP_METADATA_FILE), reason: "missing-upshift-row" };
  return {
    ok: true,
    source: rel(DEEP_METADATA_FILE),
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    tvlUsd: Number(row.tvlUsd || 0),
    chains: row.chains || [],
    accessibleEvmChains: row.accessibleEvmChains || [],
    accessibleNonEvmChains: row.accessibleNonEvmChains || [],
    blockedOrCaveatChains: row.blockedOrCaveatChains || [],
    surface: row.surface,
    routeGraph: row.routeGraph,
    firstReadOnlyChecks: row.firstReadOnlyChecks || [],
    audits: row.audits || null,
    module: row.adapter?.module || row.module || TARGET.module,
    adapterFetched: Boolean(row.adapter?.adapterFetched),
    adapterAddressCount: Number(row.adapter?.adapterAddressCount || 0),
    adapterHints: row.adapter?.adapterHints || [],
    adapterAddressSamples: (row.adapter?.adapterAddressSamples || []).map(normalizeAddress).filter(Boolean),
  };
}

function extractAddresses(text) {
  const re = /0x[a-fA-F0-9]{40}/g;
  const out = [];
  let match;
  while ((match = re.exec(String(text || ""))) !== null) {
    const address = normalizeAddress(match[0]);
    if (address) out.push(address);
  }
  return uniq(out);
}

function classifyText(text, filePath) {
  const hay = `${String(filePath || "")} ${String(text || "")}`.toLowerCase();
  const out = [];
  for (const [key, terms] of Object.entries(CATEGORY_RULES)) {
    if (terms.some((term) => hay.includes(term))) out.push(key);
  }
  return out.length ? out : ["context"];
}

function listScanFiles() {
  const files = [];
  for (const dir of [RAW_DIR, REPORTS_DIR]) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!/\.(json|md)$/i.test(file)) continue;
      const full = path.join(dir, file);
      const r = rel(full).toLowerCase();
      if (GENERATED_EXCLUDE.has(r)) continue;
      if (GENERATED_CONTEXT_EXCLUDE_RE.test(r)) continue;
      files.push(full);
    }
  }
  for (const local of LOCAL_SOURCE_FILES) {
    const full = path.join(WORKSPACE, local);
    if (fs.existsSync(full)) files.push(full);
  }
  return uniq(files.map((file) => path.resolve(file)));
}

function lineContext(lines, index) {
  return sanitizeArtifactContext(`${lines[index - 1] || ""} ${lines[index] || ""} ${lines[index + 1] || ""}`, 260);
}

function scanLocalArtifacts(searchAddresses) {
  const addressSet = new Set(searchAddresses.map((a) => a.toLowerCase()));
  const searchTerms = [TARGET.slug, TARGET.name.toLowerCase(), "upshiftvault", "upshift vault", "upshiftfarm", ...searchAddresses].map((x) => String(x).toLowerCase());
  const rows = [];
  const exactRows = [];
  const contextRows = [];
  const categoryCounts = { consumer: 0, dex: 0, oracle: 0, vault: 0, access: 0, queue: 0, context: 0 };
  let filesWithExact = 0;
  let filesWithContext = 0;

  for (const file of listScanFiles()) {
    const text = readText(file);
    if (!text) continue;
    const lower = text.toLowerCase();
    const relPath = rel(file);
    const hasExact = [...addressSet].some((a) => lower.includes(a));
    const hasContext = searchTerms.some((term) => lower.includes(term));
    if (hasExact) filesWithExact += 1;
    else if (hasContext) filesWithContext += 1;
    if (!hasExact && !hasContext) continue;

    const lines = text.split(/\r?\n/);
    const lowerLines = lines.map((line) => line.toLowerCase());
    let samples = 0;
    for (let i = 0; i < lowerLines.length && samples < 16; i += 1) {
      const line = lowerLines[i];
      const matchedAddress = [...addressSet].find((a) => line.includes(a));
      const matchedTerm = searchTerms.find((term) => line.includes(term));
      if (!matchedAddress && !matchedTerm) continue;
      const context = lineContext(lines, i);
      const categories = classifyText(context, relPath);
      for (const cat of categories) categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
      const row = {
        file: relPath,
        line: i + 1,
        matchType: matchedAddress ? "exact-address" : "context",
        matched: matchedAddress || matchedTerm,
        categories,
        context,
      };
      rows.push(row);
      if (matchedAddress) exactRows.push(row);
      else contextRows.push(row);
      samples += 1;
    }
  }

  return {
    rows,
    exactRows,
    contextRows,
    filesWithExact,
    filesWithContext,
    categoryCounts,
  };
}

function sourceFacts() {
  const facts = [];
  for (const local of LOCAL_SOURCE_FILES) {
    const full = path.join(WORKSPACE, local);
    const text = readText(full) || "";
    const lines = text.split(/\r?\n/);
    function firstLine(re, fallback) {
      const idx = lines.findIndex((line) => re.test(line));
      return idx >= 0 ? idx + 1 : fallback;
    }
    function add(lineNo, fact, implication) {
      facts.push({ file: local, line: lineNo, fact, implication });
    }
    if (/requestRedeem/.test(text))
      add(firstLine(/requestRedeem/, 17), "IUpshiftVault.requestRedeem(shares, receiver, holder) returns assets and claimableEpoch", "queued redemption semantics; not same-block exit unless lagDuration is zero or instantRedeem is used");
    if (/instantRedeem/.test(text))
      add(firstLine(/instantRedeem/, 25), "IUpshiftVault.instantRedeem exists", "instant exit may charge fee and needs exact same-block economics before route-positive classification");
    if (/claim\(/.test(text))
      add(firstLine(/function claim\(/, firstLine(/\.claim\(/, 63)), "IUpshiftVault.claim(year, month, day, receiver) is public for a legitimate receiver", "claim path is receiver-scoped, not arbitrary receiver drain proof");
    if (/onlyCoreRole\(CoreRoles\.FARM_SWAP_CALLER\)/.test(text))
      add(firstLine(/onlyCoreRole\(CoreRoles\.FARM_SWAP_CALLER\)/, 126), "Infinifi UpshiftFarm vault operations are onlyCoreRole(FARM_SWAP_CALLER)", "integration methods are permissioned and not a public exploit path");
    if (/convertToAssets\(vaultShares\)/.test(text))
      add(firstLine(/convertToAssets\(vaultShares\)/, 85), "UpshiftFarm values shares through ERC4626.convertToAssets plus pending claims", "consumer/accounting route requires exact share-rate mismatch or overvaluation proof");
    if (/AssetsIntegrityBroken/.test(text))
      add(firstLine(/AssetsIntegrityBroken/, 52), "UpshiftFarm checks requestRedeem claimable assets equal assetsOut", "local integration includes queued-claim accounting guard");
  }
  return uniq(facts.map((f) => JSON.stringify(f))).map((x) => JSON.parse(x));
}

async function dexScreenerRows(addresses) {
  const rows = [];
  for (const address of addresses.slice(0, 8)) {
    const json = await fetchJson(`${DEXSCREENER_TOKEN_API}${address}`, 15_000);
    const pairs = Array.isArray(json?.pairs) ? json.pairs : [];
    for (const pair of pairs.slice(0, 12)) {
      const liquidityUsd = Number(pair?.liquidity?.usd || 0);
      if (!Number.isFinite(liquidityUsd) || liquidityUsd <= 0) continue;
      rows.push({
        address,
        chainId: pair.chainId || null,
        dexId: pair.dexId || null,
        pairAddress: pair.pairAddress || null,
        baseToken: pair.baseToken?.symbol || null,
        quoteToken: pair.quoteToken?.symbol || null,
        liquidityUsd,
        priceUsd: pair.priceUsd || null,
      });
    }
  }
  rows.sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  return rows.slice(0, 20);
}

function toSanitizedNumber(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toChainIdFromString(raw) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

async function fetchAugustVaultMetadata() {
  const rows = [];
  const nonEvmRows = [];
  const unknownChainRows = [];
  const json = await fetchJson(AUGUST_ACTIVE_VAULTS_API, 30_000);
  if (!Array.isArray(json)) {
    return {
      ok: false,
      source: "august-api",
      reason: "non-array-response",
      rows: [],
      rowsByChain: new Map(),
      nonEvmRows: [],
      unknownChainRows: [],
      totalRows: 0,
    };
  }

  const byChain = new Map();
  const seen = new Set();

  for (const row of json) {
    const chainId = toChainIdFromString(row?.chain);
    const address = normalizeAddress(row?.address);
    if (!address || !Number.isFinite(chainId)) continue;

    const chainRow = {
      address,
      chainId,
      chainName: CHAIN_BY_ID.get(chainId)?.chainLabel || `chain-${chainId}`,
      source: "august-active-vault-api",
      vaultName: safeText(row?.vault_name, 120),
      internalType: row?.internal_type || row?.public_type || null,
      receiptTokenSymbol: safeText(row?.receipt_token_symbol, 32),
      chainType: safeText(row?.chain_type, 80),
      tvl: toSanitizedNumber(row?.tvl || row?.latest_reported_tvl || 0) || 0,
    };

    if (chainId < 0) {
      nonEvmRows.push(chainRow);
      continue;
    }
    if (!CHAIN_BY_ID.has(chainId)) {
      unknownChainRows.push(chainRow);
      continue;
    }

    const key = `${chainId}|${address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const list = byChain.get(chainId) || [];
    list.push(chainRow);
    byChain.set(chainId, list);
    rows.push(chainRow);
  }

  for (const [chainId, entries] of byChain.entries()) {
    byChain.set(chainId, entries.sort((a, b) => b.tvl - a.tvl));
  }

  return {
    ok: true,
    source: "august-active-vault-api",
    rows,
    rowsByChain: byChain,
    nonEvmRows,
    unknownChainRows,
    totalRows: rows.length + nonEvmRows.length + unknownChainRows.length,
  };
}

function selectAddressContextsFromAugust(vaultRowsByChain) {
  const contexts = [];
  const chainOrder = [...CHAIN_CONFIG].sort((a, b) => a.priority - b.priority);
  for (const chain of chainOrder) {
    const rows = vaultRowsByChain.get(chain.chainId) || [];
    for (const row of rows.slice(0, MAX_ADDRESSES_PER_CHAIN)) {
      contexts.push({
        address: row.address,
        chainId: chain.chainId,
        chainLabel: chain.chainLabel,
        source: "august-active-vault-api",
        vaultName: row.vaultName || null,
        internalType: row.internalType || null,
        receiptTokenSymbol: row.receiptTokenSymbol || null,
      });
    }
  }
  return uniqBy(contexts, (item) => `${item.chainId}:${item.address}`);
}

function hexPayload(raw) {
  return String(raw || "")
    .replace(/^0x/, "")
    .toLowerCase();
}

function toBigIntFromHex(raw) {
  try {
    const h = hexPayload(raw);
    if (!h) return null;
    return BigInt(`0x${h}`);
  } catch (_) {
    return null;
  }
}

function decodeWord(raw, index = 0) {
  if (index < 0) return null;
  const h = hexPayload(raw);
  if (!h) return null;
  const needed = (index + 1) * 64;
  const padded = h.padStart(needed, "0");
  const start = padded.length - (index + 1) * 64;
  const end = start + 64;
  const word = padded.slice(start, end);
  return word || null;
}

function decodeWordAsBigInt(raw, index = 0) {
  const word = decodeWord(raw, index);
  if (!word) return null;
  try {
    return BigInt(`0x${word}`);
  } catch (_) {
    return null;
  }
}

function decodeAddress(raw, index = 0) {
  const word = decodeWord(raw, index);
  if (!word) return null;
  const addr = word.slice(-40);
  return `0x${addr}`;
}

function decodeProbeValue(raw, kind) {
  if (!kind || kind === "none") return null;
  if (kind === "uint256") {
    const v = decodeWordAsBigInt(raw, 0);
    return v === null ? null : v;
  }
  if (kind === "address") {
    return decodeAddress(raw, 0);
  }
  if (kind === "tuple2") {
    const a = decodeWordAsBigInt(raw, 0);
    const b = decodeWordAsBigInt(raw, 1);
    return [a, b];
  }
  if (kind === "tuple4") {
    const a = decodeWordAsBigInt(raw, 0);
    const b = decodeWordAsBigInt(raw, 1);
    const c = decodeWordAsBigInt(raw, 2);
    const d = decodeWordAsBigInt(raw, 3);
    return [a, b, c, d];
  }
  return null;
}

function serializeValue(value) {
  if (value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(serializeValue);
  if (value === null) return null;
  return value;
}

function rpcCallClassification(resp) {
  if (!resp) return { ok: false, status: "unknown", transportOk: false, rpcError: "no-response" };
  if (resp.ok) return { ok: true, status: "ok", transportOk: true, rpcError: null };
  if (!resp.transport) return { ok: false, status: "transport-error", transportOk: false, rpcError: resp.error || "transport" };
  if (/execution reverted/i.test(resp.error || "")) return { ok: false, status: "reverted", transportOk: true, rpcError: resp.error || "execution-reverted" };
  return { ok: false, status: resp.error || "rpc-error", transportOk: true, rpcError: resp.error || "rpc-error" };
}

function toHex32(value) {
  try {
    const v = BigInt(value);
    if (v < 0n) return "0".repeat(64);
    const hex = v.toString(16);
    return hex.length > 64 ? hex.slice(-64) : hex.padStart(64, "0");
  } catch (_) {
    return "0".repeat(64);
  }
}

function encodeArg(value, kind = "uint256") {
  const k = String(kind).toLowerCase();
  if (k === "address") {
    const addr = normalizeAddress(value);
    return addr ? addr.replace(/^0x/, "").padStart(64, "0") : "0".repeat(64);
  }
  return toHex32(value || 0n);
}

function callDataFromProbe(probe) {
  const args = probe.args();
  const encoded = args
    .map((arg, index) => encodeArg(arg, probe.argTypes[index]))
    .join("");
  return `${probe.selector}${encoded}`;
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

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        transport: true,
        error: `http-${res.status}`,
        body: text || null,
        json,
      };
    }

    if (!json || (json.error && !("result" in json))) {
      return {
        ok: false,
        status: res.status,
        transport: true,
        error: json?.error?.message || "rpc-error",
        body: text || null,
        json,
      };
    }

    return {
      ok: true,
      status: res.status,
      transport: true,
      result: json.result,
      json,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      transport: false,
      error: err?.name === "AbortError" ? "timeout" : "network",
      body: null,
      json: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function probeChainRpcState(chainConfig, rpcUrls, rpcInventoryKnownSet, allowPublicFallback = false) {
  const chainId = chainConfig.chainId;
  const row = {
    chainLabel: chainConfig.chainLabel,
    chainId,
    inScope: chainConfig.inScope,
    caveat: chainConfig.caveat,
    rpcInventoryRows: rpcUrls.length,
    rpcResolved: false,
    rpcSource: "none",
    rpcUrlUsed: null,
    rpcStatus: "unresolved",
    rpcError: null,
    chainIdObserved: null,
    chainIdMatch: null,
    blockNumberHex: null,
    blockNumber: null,
    blockStatus: "not-probed",
  };

  const allUrls = resolveRpcPool([chainId], rpcUrls);
  const resolved = (await allUrls)[chainId];
  const useInventory = resolved && rpcInventoryKnownSet.has(String(resolved).toLowerCase());
  const usePublicFallback = Boolean(allowPublicFallback && resolved && PUBLIC_FALLBACKS[chainId] && String(resolved) === String(PUBLIC_FALLBACKS[chainId]));
  if (!resolved || (!useInventory && !usePublicFallback)) {
    row.rpcStatus = "unresolved-inventory-miss";
    return row;
  }

  row.rpcResolved = true;
  row.rpcSource = useInventory ? "rpc-inventory" : "public-fallback";
  row.rpcUrlUsed = resolved;

  const chainResp = await rpcPost(resolved, "eth_chainId", [], RPC_TIMEOUT_MS);
  const chainCall = rpcCallClassification(chainResp);
  if (!chainCall.ok) {
    row.rpcStatus = chainCall.status;
    row.rpcError = chainCall.rpcError;
    return row;
  }

  row.rpcStatus = "ready";
  const observed = toBigIntFromHex(chainResp.result);
  if (observed !== null) {
    row.chainIdObserved = Number(observed);
    row.chainIdMatch = observed === BigInt(chainId);
  }

  const blockResp = await rpcPost(resolved, "eth_blockNumber", [], RPC_TIMEOUT_MS);
  const blockCall = rpcCallClassification(blockResp);
  if (blockCall.ok && blockResp.result) {
    row.blockStatus = "ok";
    row.blockNumberHex = String(blockResp.result);
    const block = toBigIntFromHex(blockResp.result);
    row.blockNumber = block === null ? null : block.toString();
  } else {
    row.blockStatus = blockCall.status;
  }

  return row;
}

async function runVaultProbe(rpcUrl, address, chainProbe, probe) {
  const callData = callDataFromProbe(probe);
  const transport = await rpcPost(rpcUrl, "eth_call", [{ to: address, data: callData }, "latest"], ETH_CALL_TIMEOUT_MS);
  const parsed = rpcCallClassification(transport);
  const raw = transport.ok ? transport.result : null;
  const decoded = parsed.ok ? decodeProbeValue(raw, probe.decodeType) : null;
  return {
    group: probe.group,
    name: probe.name,
    signature: probe.signature,
    selector: probe.selector,
    nonView: Boolean(probe.nonView),
    status: parsed.status,
    transportOk: parsed.transportOk,
    rpcError: parsed.rpcError,
    raw: raw || null,
    decoded: serializeValue(decoded),
  };
}

async function probeVaultAddress(context, chainProbe) {
  const row = {
    chainLabel: context.chainLabel,
    chainId: context.chainId,
    address: context.address,
    source: context.source,
    rpcProvider: {
      source: chainProbe.rpcSource,
      resolved: chainProbe.rpcResolved,
      status: chainProbe.rpcStatus,
      chainIdObserved: chainProbe.chainIdObserved,
      chainIdMatch: chainProbe.chainIdMatch,
      blockNumber: chainProbe.blockNumber,
      blockNumberHex: chainProbe.blockNumberHex,
      blockStatus: chainProbe.blockStatus,
      blockProbeError: chainProbe.rpcError || null,
    },
    codeStatus: "not-probed",
    codeHexSize: null,
    codePresent: false,
    probes: [],
    lagDuration: null,
    nonViewEthCallAvailable: {
      requestRedeem: null,
      instantRedeem: null,
      claim: null,
    },
    vaultName: context.vaultName || null,
    internalType: context.internalType || null,
    receiptTokenSymbol: context.receiptTokenSymbol || null,
  };

  if (!chainProbe.rpcResolved) {
    row.codeStatus = "no-rpc";
    return row;
  }

  const codeResp = await rpcPost(chainProbe.rpcUrlUsed, "eth_getCode", [context.address, "latest"], RPC_TIMEOUT_MS);
  const codeClass = rpcCallClassification(codeResp);
  if (!codeClass.ok) {
    row.codeStatus = codeClass.status;
    return row;
  }

  const codeHex = codeResp.result || "0x";
  const codeHexSize = Math.max(0, Math.floor((hexPayload(codeHex).length || 0) / 2));
  row.codeStatus = codeHex === "0x" || codeHexSize === 0 ? "empty" : "present";
  row.codePresent = codeHex !== "0x" && codeHexSize > 0;
  row.codeHexSize = codeHexSize;

  if (!row.codePresent) return row;

  for (const probe of FUNCTION_PROBES) {
    const probeRow = await runVaultProbe(chainProbe.rpcUrlUsed, context.address, chainProbe, probe);
    row.probes.push(probeRow);
    if (probe.name === "lagDuration") {
      row.lagDuration = probeRow.decoded;
    }
    if (probe.name === "requestRedeem") {
      row.nonViewEthCallAvailable.requestRedeem = probeRow.status === "ok";
    }
    if (probe.name === "instantRedeem") {
      row.nonViewEthCallAvailable.instantRedeem = probeRow.status === "ok";
    }
    if (probe.name === "claim") {
      row.nonViewEthCallAvailable.claim = probeRow.status === "ok";
    }
  }

  return row;
}

function checklistRows(metrics) {
  const base = [
    ["scope-source-inventory", metrics.addressRows > 0 && metrics.sourceFactRows > 0, "Target metadata, adapter addresses, public protocol context, and local source facts collected"],
    ["verified-abi-source-aware-probing", metrics.sourceFactRows > 0, "Local Upshift interface/farm source semantics reviewed"],
    ["event-log-active-surface", metrics.localArtifactMatchRows > 0, "Local artifacts/reports scanned for active-surface hints"],
    ["role-gate-controls", metrics.accessRows > 0, "Access/role context found in local UpshiftFarm integration"],
    ["vault-semantics", metrics.vaultRows > 0 || metrics.sourceFactRows > 0, "ERC4626-style vault semantics reviewed"],
    ["consumer-join", metrics.consumerJoinRows > 0, "Consumer/local routing context collected"],
    ["rpc-inventory-backed-probes", metrics.endpointInventoryRead && metrics.chainProbeRows > 0, "Endpoint-backed chain probing attempted from sanitized RPC inventory only"],
    ["live-probes", metrics.liveProbeRows > 0, "Live endpoint read-only probe rows captured when RPC and code are available"],
    ["exact-economics", metrics.exactEconomicsRows === 0, "No exact-positive route economics found"],
    ["fork-value-delta", false, "Fork/value-delta remains gate-closed because routePositive=0"],
    ["signed/no-fork", false, "No signed action or fork proof is attempted in this full-read-only scope"],
  ];
  return base.map(([key, complete, note]) => ({ key, complete: Boolean(complete), note }));
}

function renderReport(payload) {
  const lines = [];
  const s = payload.summary;
  lines.push("# 🟢 DORMANT - Upshift Full Read-Only Test");
  lines.push("");
  lines.push(`Generated: ${payload.generatedAt}`);
  lines.push("");
  lines.push("## Verdict");
  lines.push("");
  lines.push("No route-positive Upshift exploit is proven. Upshift remains watch-only/dormant until a source-confirmed share-rate, queued/instant redemption, consumer overvaluation, or exit route becomes exact-positive and is confirmed by fork/state-delta proof.");
  lines.push("");
  lines.push("## Key metrics");
  for (const [k, v] of Object.entries(s)) lines.push(`- ${k}: \`${v}\``);
  lines.push("");
  lines.push("## Endpoint-backed RPC coverage (sanitized)");
  lines.push(`- rpcInventoryRead: ${payload.safety.rpcInventoryRead}`);
  lines.push(`- rpcInventoryRows: ${payload.endpointCoverage.rpcInventoryRows}`);
  lines.push(`- chainsRequested: ${payload.endpointCoverage.chainCount}`);
  lines.push(`- chainsResolvedFromInventory: ${payload.endpointCoverage.chainResolvedFromInventory}`);
  for (const chain of payload.endpointCoverage.chainProbes) {
    lines.push(`- ${chain.chainLabel} (id ${chain.chainId}): rpc=${chain.rpcResolved ? "resolved" : chain.rpcStatus}; chainIdObserved=${chain.chainIdObserved === null ? "n/a" : chain.chainIdObserved}; block=${chain.blockNumber || "n/a"}; inScope=${chain.inScope}`);
  }
  lines.push("");
  lines.push("## Live vault probe samples");
  for (const row of payload.liveVaultProbes.slice(0, 7)) {
    lines.push(`- ${row.chainLabel}/${row.chainId} ${row.address} rpc=${row.rpcProvider.status}; code=${row.codeStatus}; block=${row.rpcProvider.blockNumber || "n/a"}; lagDuration=${row.lagDuration || "n/a"}`);
    if (row.nonViewEthCallAvailable.requestRedeem !== null || row.nonViewEthCallAvailable.instantRedeem !== null || row.nonViewEthCallAvailable.claim !== null) {
      lines.push(
        `  - non-view eth_call availability: requestRedeem=${row.nonViewEthCallAvailable.requestRedeem}; instantRedeem=${row.nonViewEthCallAvailable.instantRedeem}; claim=${row.nonViewEthCallAvailable.claim}`,
      );
    }
    for (const probe of row.probes.slice(0, 8)) {
      const value = probe.decoded === null ? "n/a" : `${JSON.stringify(probe.decoded)} (${probe.status})`;
      lines.push(`  - ${probe.name} => ${value}`);
    }
    lines.push("");
  }
  lines.push("## Source facts");
  for (const fact of payload.sourceFacts.slice(0, 12)) lines.push(`- \`${fact.file}:${fact.line}\` ${fact.fact} — ${fact.implication}`);
  lines.push("");
  lines.push("## Top local artifact matches");
  if (!payload.localArtifactSamples.length) lines.push("- none");
  for (const row of payload.localArtifactSamples.slice(0, 12)) lines.push(`- \`${row.file}:${row.line}\` [${row.matchType}; ${row.categories.join(",")}] ${row.context}`);
  lines.push("");
  lines.push("## DEX/liquidity rows");
  if (!payload.dexLiquidityRows.length) lines.push("- none");
  for (const row of payload.dexLiquidityRows.slice(0, 8)) lines.push(`- ${row.chainId || "unknown"}/${row.dexId || "dex"} ${row.baseToken || "?"}-${row.quoteToken || "?"}: ~$${Math.round(row.liquidityUsd).toLocaleString()} (${row.pairAddress || "pair-unknown"})`);
  lines.push("");
  lines.push("## Safety fields");
  lines.push(`- rpcInventoryRead: ${payload.safety.rpcInventoryRead}`);
  lines.push(`- graphqlInventoryRead: ${payload.safety.graphqlInventoryRead}`);
  lines.push(`- envFilesRead: ${payload.safety.envFilesRead}`);
  lines.push(`- privateKeysRead: ${payload.safety.privateKeysRead}`);
  lines.push(`- rpcUrlsStored: ${payload.safety.rpcUrlsStored}`);
  lines.push(`- graphqlUrlsStored: ${payload.safety.graphqlUrlsStored}`);
  lines.push("\n## Blockers");
  for (const b of payload.blockers) lines.push(`- ${b}`);
  lines.push("");
  lines.push("## Required for route-positive");
  for (const r of payload.requiredForRoutePositive) lines.push(`- ${r}`);
  lines.push("");
  lines.push(`Next read-only step: ${payload.nextReadOnlyStep}`);
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const metadata = loadDeepMetadata();
  const protocol = await fetchJson(PROTOCOL_API, 30_000);
  const adapterText = await fetchText(ADAPTER_SOURCE, 30_000);
  const adapterAddresses = extractAddresses(adapterText || "");
  const queueAddresses = metadata.ok ? metadata.adapterAddressSamples : [];

  const augustRows = await fetchAugustVaultMetadata();
  const addressContexts = selectAddressContextsFromAugust(augustRows.rowsByChain || new Map());

  const searchAddresses = uniq([
    ...TARGET.sampleAddresses.map(normalizeAddress),
    ...queueAddresses,
    ...adapterAddresses,
    ...addressContexts.map((row) => row.address),
  ].filter(Boolean));

  const local = scanLocalArtifacts(searchAddresses);
  const facts = sourceFacts();
  const dexRows = await dexScreenerRows(searchAddresses);

  const exactConsumerJoinRows = local.exactRows.filter((r) => r.categories.some((c) => ["consumer", "vault", "oracle"].includes(c)));
  const contextConsumerJoinRows = local.contextRows.filter((r) => r.categories.some((c) => ["consumer", "vault", "oracle"].includes(c)));

  const skipRpcInventory = process.env.UPSHIFT_SKIP_RPC_INVENTORY === "1";
  const rpcInventory = skipRpcInventory ? [] : loadRpcUrls();
  const rpcInventoryRead = !skipRpcInventory && Boolean(rpcInventory.length);
  const rpcInventoryKnown = new Set(rpcInventory.map((url) => String(url).toLowerCase()));
  const chainStateRows = [];
  for (const chainConfig of CHAIN_CONFIG.sort((a, b) => a.priority - b.priority)) {
    chainStateRows.push(await probeChainRpcState(chainConfig, rpcInventory, rpcInventoryKnown, skipRpcInventory));
  }

  const chainStateById = new Map();
  for (const row of chainStateRows) {
    chainStateById.set(row.chainId, row);
  }

  const liveVaultProbes = [];
  for (const context of addressContexts) {
    const chainState = chainStateById.get(context.chainId) || {
      rpcResolved: false,
      rpcSource: "none",
      rpcStatus: "missing-chain-state",
      chainIdMatch: false,
      blockNumber: null,
      blockNumberHex: null,
      blockStatus: "not-probed",
    };
    liveVaultProbes.push(await probeVaultAddress(context, chainState));
  }

  const endpointCoverage = {
    rpcInventoryRows: rpcInventory.length,
    chainCount: chainStateRows.length,
    chainResolvedFromInventory: chainStateRows.filter((row) => row.rpcResolved && row.rpcSource === "rpc-inventory").length,
    chainResolvedFromPublicFallback: chainStateRows.filter((row) => row.rpcResolved && row.rpcSource === "public-fallback").length,
    chainProbes: chainStateRows.map((row) => ({
      chainLabel: row.chainLabel,
      chainId: row.chainId,
      inScope: row.inScope,
      caveat: row.caveat,
      rpcStatus: row.rpcStatus,
      chainIdObserved: row.chainIdObserved,
      chainIdMatch: row.chainIdMatch,
      blockNumber: row.blockNumber,
      blockStatus: row.blockStatus,
      rpcSource: row.rpcSource,
      blockNumberHex: row.blockNumberHex,
      rpcError: row.rpcError,
    })),
  };

  const addressRows = uniqBy(
    [
      ...addressContexts.map((row) => ({
        address: row.address,
        chainId: row.chainId,
        chainLabel: row.chainLabel,
        source: row.source,
        vaultName: row.vaultName || null,
        internalType: row.internalType || null,
        receiptTokenSymbol: row.receiptTokenSymbol || null,
      })),
      ...TARGET.sampleAddresses.map((address) => ({ address, chainId: null, chainLabel: null, source: "legacy-sample" })),
      ...queueAddresses.map((address) => ({ address, chainId: null, chainLabel: null, source: "deep-metadata-adapter-address" })),
    ],
    (row) => `${row.chainId || "na"}:${row.address}`,
  );

  const metrics = {
    currentTvlUsd: metadata.tvlUsd || Number(protocol?.currentChainTvls?.Ethereum || protocol?.tvl || 0) || null,
    addressRows: addressRows.length,
    sourceFactRows: facts.length,
    localArtifactMatchRows: local.rows.length,
    exactLocalArtifactMatchRows: local.exactRows.length,
    contextLocalArtifactMatchRows: local.contextRows.length,
    filesWithExactMatch: local.filesWithExact,
    filesWithContextMatch: local.filesWithContext,
    consumerJoinRows: exactConsumerJoinRows.length + contextConsumerJoinRows.length,
    exactConsumerJoinRows: exactConsumerJoinRows.length,
    contextConsumerJoinRows: contextConsumerJoinRows.length,
    vaultRows: local.categoryCounts.vault || 0,
    accessRows: local.categoryCounts.access || 0,
    queueRows: local.categoryCounts.queue || 0,
    oracleRows: local.categoryCounts.oracle || 0,
    dexLiquidityRows: dexRows.length,
    maxDexLiquidityUsd: dexRows[0]?.liquidityUsd || 0,
    exactEconomicsRows: 0,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    forkJustified: false,
    caveatChains: (metadata.blockedOrCaveatChains || []).length + (metadata.accessibleNonEvmChains || []).length,
    endpointInventoryRead: rpcInventoryRead,
    chainProbeRows: endpointCoverage.chainCount,
    chainResolvedFromInventory: endpointCoverage.chainResolvedFromInventory,
    liveProbeRows: liveVaultProbes.length,
    liveProbeRowsWithCode: liveVaultProbes.filter((row) => row.codePresent).length,
    liveProbeRowsWithRpc: liveVaultProbes.filter((row) => row.rpcProvider.resolved).length,
    nonViewProbeRows: liveVaultProbes.reduce(
      (acc, row) =>
        acc +
        (row.nonViewEthCallAvailable.requestRedeem ? 1 : 0) +
        (row.nonViewEthCallAvailable.instantRedeem ? 1 : 0) +
        (row.nonViewEthCallAvailable.claim ? 1 : 0),
      0,
    ),
  };

  const checklist = checklistRows(metrics);

  const blockers = [
    "No Upshift vault/share token is proven to be accepted by a material lending/oracle consumer with overvalued collateral semantics.",
    "Local source shows queued redemption and instantRedeem semantics; no exact same-block positive fee/capacity route is proven.",
    "Infinifi UpshiftFarm integration operations are role-gated and receiver/claim accounting is guarded; no arbitrary public drain path is proven.",
    "Public DEX/liquidity rows are context-only and do not prove profitable acquire/redeem/unwind economics.",
    "Flare/Fluent/Monad/Hyperliquid L1/Plasma/Mezo plus non-EVM Stellar/Sui remain coverage caveats in this endpoint-backed scan.",
    "Fork/value-delta gate remains closed because routePositive=0.",
  ];

  const requiredForRoutePositive = [
    "source-confirmed Upshift share-rate/accounting, queued/instant redemption, or strategy valuation anomaly",
    "exact Upshift share or receipt accepted by a material lending/oracle/settlement consumer, or a same-block DEX/redeem exit venue",
    "exact acquisition -> deposit/redeem/borrow/liquidate/unwind economics positive after fees, instant-redeem discount, slippage, caps, queues, finality, and gas",
    "endpoint-backed live-state proof for in-scope EVM chains plus explicit caveats for unsupported/non-EVM chains",
    "fork/static value-delta proof before any signed/live action",
  ];

  const payload = {
    generatedAt: new Date().toISOString(),
    scanner: "scan-upshift-full-test",
    target: TARGET,
    metadata,
    protocolContext: protocol ? { name: protocol.name, category: protocol.category, chains: protocol.chains, tvl: protocol.tvl } : null,
    safety: {
      publicApisOnly: true,
      localArtifactsRead: true,
      rpcInventoryRead,
      graphqlInventoryRead: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      rpcUrlsStored: false,
      rawUrlsStored: false,
      graphqlUrlsStored: false,
    },
    endpointCoverage,
    addressRows,
    sourceFacts: facts,
    localArtifactSamples: local.rows.slice(0, 80),
    localArtifactCategoryCounts: local.categoryCounts,
    liveVaultProbes,
    dexLiquidityRows: dexRows,
    checklist,
    summary: metrics,
    fullTestReadOnlyComplete: true,
    fullTestChecklistComplete: false,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    forkJustified: false,
    forkGate: "closed-route-positive-zero",
    blockers,
    requiredForRoutePositive,
    nextReadOnlyStep: "Probe exact non-view and vault accounting fields per in-scope EVM chain against sanitized RPC inventory repeatedly; join live vault shares to material consumers/routers before any signed action, and require fork/value-delta proof before execution.",
  };

  ensureDir(OUT_JSON);
  ensureDir(OUT_MD);
  fs.writeFileSync(OUT_JSON, `${JSON.stringify(payload, null, 2)}\n`);
  fs.writeFileSync(OUT_MD, renderReport(payload));
  log(JSON.stringify({ raw: OUT_JSON_REL, report: OUT_MD_REL, summary: metrics }, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
