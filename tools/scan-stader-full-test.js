#!/usr/bin/env node
"use strict";

// scan-stader-full-test.js
// Read-only Stader full test using sanitized local discovery + authorized RPC inventory only.

const fs = require("fs");
const path = require("path");
const { getOrigin, loadRpcUrls, PUBLIC_FALLBACKS } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const REPORTS_DIR = path.join(WORKSPACE, "reports");

const OUT_JSON = path.join(RAW_DIR, "stader-full-test.json");
const OUT_MD = path.join(REPORTS_DIR, "stader-full-test-triage.md");
const OUT_JSON_REL = "reports/raw/fast/stader-full-test.json";
const OUT_MD_REL = "reports/stader-full-test-triage.md";

const DEEP_METADATA_FILE = path.join(RAW_DIR, "prefilter-deep-new-target-search-2026-06-24.json");
const STADER_PHASE0_FILE = path.join(RAW_DIR, "stader-phase0.json");
const ROUTE_SWEEP_FILE = path.join(RAW_DIR, "route-positive-sweep.json");

const QUIET = process.argv.includes("--quiet");

const TARGET = {
  slug: "stader",
  name: "Stader",
  category: "Liquid Staking",
  surface: "vault-yield-allocator",
  module: "stader/index.js",
  routeGraph: "vault share -> rate/strategy accounting -> consumer or exit venue -> borrow/redeem/unwind",
  sampleAddresses: [
    "0xcf5ea1b38380f6af39068375516daf40ed70d299",
    "0x4f4bfa0861f62309934a5551e0b2541ee82fdcf1",
    "0x7Af4730cc8EbAd1a050dcad5c03c33D2793EE91f",
    "0x30D20208d987713f46DFD34EF128Bb16C404D10f",
  ],
  tokenHints: ["stader", "stader token"],
};

const PROTOCOL_API = "https://api.llama.fi/protocol/stader";
const ADAPTER_SOURCE = "https://raw.githubusercontent.com/DefiLlama/DefiLlama-Adapters/main/projects/stader/index.js";

const CHAIN_CONFIG = [
  { chainLabel: "Ethereum", chainId: 1, inScope: true, caveat: false },
  { chainLabel: "Binance", chainId: 56, inScope: true, caveat: false },
  { chainLabel: "Fantom", chainId: 250, inScope: true, caveat: false },
  { chainLabel: "Hedera", chainId: null, inScope: false, caveat: true },
  { chainLabel: "Terra2", chainId: null, inScope: false, caveat: true },
  { chainLabel: "Near", chainId: null, inScope: false, caveat: true },
];

const CHAIN_BY_ID = new Map(
  CHAIN_CONFIG
    .filter((row) => Number.isFinite(row.chainId))
    .map((row) => [row.chainId, row]),
);

const CATEGORY_RULES = {
  consumer: ["consumer", "lending", "borrow", "debt", "collateral", "market", "liquidation", "loan", "margin", "vault", "route", "join"],
  oracle: ["oracle", "price", "feed", "chainlink", "pyth", "rate", "rate provider", "priceper", "exchange", "stale"],
  dex: ["dex", "swap", "pool", "amm", "uniswap", "curve", "balancer", "pancake", "liquidity", "router", "quote", "pair"],
  vault: ["erc4626", "vault", "share", "totalassets", "totalshares", "convert", "redeem", "withdraw", "claim", "unstake", "deposit"],
  lending: ["lending", "borrow", "cdp", "leverage", "liquidation", "borrower", "position"],
};

const JOIN_CATEGORIES = ["consumer", "oracle", "dex", "vault", "lending"];

const GENERATED_EXCLUDE = new Set([OUT_JSON_REL.toLowerCase(), OUT_MD_REL.toLowerCase()]);
const GENERATED_CONTEXT_EXCLUDE_RE = /(?:stader-full-test|route-positive-sweep|audit-completion-gates|low-fund-executable-route-filter|route-gate-consistency-audit|replica|history)/i;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ONE_18 = 10n ** 18n;
const ONE_0 = 0n;
const RPC_TIMEOUT_MS = 9_000;
const ETH_CALL_TIMEOUT_MS = 9_000;

const FUNCTION_PROBES = [
  { group: "metadata", name: "symbol", signature: "symbol()", selector: "0x95d89b41", args: () => [], argTypes: [], decodeType: "string", nonView: false },
  { group: "metadata", name: "name", signature: "name()", selector: "0x06fdde03", args: () => [], argTypes: [], decodeType: "string", nonView: false },
  { group: "metadata", name: "decimals", signature: "decimals()", selector: "0x313ce567", args: () => [], argTypes: [], decodeType: "uint256", nonView: false },
  { group: "vault", name: "totalSupply", signature: "totalSupply()", selector: "0x18160ddd", args: () => [], argTypes: [], decodeType: "uint256", nonView: false },
  { group: "vault", name: "asset", signature: "asset()", selector: "0x38d52e0f", args: () => [], argTypes: [], decodeType: "address", nonView: false },
  { group: "vault", name: "totalAssets", signature: "totalAssets()", selector: "0x01e1d114", args: () => [], argTypes: [], decodeType: "uint256", nonView: false },
  { group: "vault", name: "convertToAssets", signature: "convertToAssets(uint256)", selector: "0x07a2d13a", args: () => [ONE_18], argTypes: ["uint256"], decodeType: "uint256", nonView: false },
  { group: "vault", name: "previewRedeem", signature: "previewRedeem(uint256)", selector: "0x4cdad506", args: () => [ONE_18], argTypes: ["uint256"], decodeType: "uint256", nonView: false },
  { group: "vault", name: "maxWithdraw", signature: "maxWithdraw(address)", selector: "0xce96cb77", args: () => [ZERO_ADDRESS], argTypes: ["address"], decodeType: "uint256", nonView: false },
  { group: "vault", name: "maxRedeem", signature: "maxRedeem(address)", selector: "0xd905777e", args: () => [ZERO_ADDRESS], argTypes: ["address"], decodeType: "uint256", nonView: false },
  { group: "vault", name: "exchangeRate", signature: "exchangeRate()", selector: "0x3ba0b9a9", args: () => [], argTypes: [], decodeType: "uint256", nonView: false },
  { group: "vault", name: "getExchangeRate", signature: "getExchangeRate()", selector: "0xe6aa216c", args: () => [], argTypes: [], decodeType: "uint256", nonView: false },
  { group: "vault", name: "pricePerShare", signature: "pricePerShare()", selector: "0x99530b06", args: () => [], argTypes: [], decodeType: "uint256", nonView: false },
  { group: "vault", name: "getPricePerFullShare", signature: "getPricePerFullShare()", selector: "0x77c7b8fc", args: () => [], argTypes: [], decodeType: "uint256", nonView: false },
  { group: "vault", name: "getRate", signature: "getRate()", selector: "0x679aefce", args: () => [], argTypes: [], decodeType: "uint256", nonView: false },
  { group: "vault", name: "rate", signature: "rate()", selector: "0x2c4e722e", args: () => [], argTypes: [], decodeType: "uint256", nonView: false },
  { group: "actions", name: "redeem", signature: "redeem(uint256,address,address)", selector: "0xba087652", args: () => [ONE_18, ZERO_ADDRESS, ZERO_ADDRESS], argTypes: ["uint256", "address", "address"], decodeType: "none", nonView: true },
  { group: "actions", name: "withdraw", signature: "withdraw(uint256,address,address)", selector: "0xb460af94", args: () => [ONE_18, ZERO_ADDRESS, ZERO_ADDRESS], argTypes: ["uint256", "address", "address"], decodeType: "none", nonView: true },
  { group: "actions", name: "instantRedeem", signature: "instantRedeem(uint256,address,address)", selector: "0x77a84317", args: () => [ONE_18, ZERO_ADDRESS, ZERO_ADDRESS], argTypes: ["uint256", "address", "address"], decodeType: "none", nonView: true },
  { group: "actions", name: "claim", signature: "claim(address,address,address)", selector: "0x2cd1b113", args: () => [ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS], argTypes: ["address", "address", "address"], decodeType: "none", nonView: true },
  { group: "actions", name: "claim", signature: "claim()", selector: "0x4e71d92d", args: () => [], argTypes: [], decodeType: "none", nonView: true },
  { group: "actions", name: "unstake", signature: "unstake(uint256)", selector: "0x2e17de78", args: () => [ONE_18], argTypes: ["uint256"], decodeType: "none", nonView: true },
];

function log(...args) {
  if (!QUIET) console.log(...args);
}

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function safeText(value, max = 220) {
  return String(value || "")
    .replace(/[\r\n|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max) || null;
}

function sanitizeArtifactContext(value, max = 280) {
  let text = safeText(value, max);
  if (text === null) return null;

  const redactedUrl = "[redacted-url]";
  const redactedValue = "[redacted]";
  text = text
    .replace(/\bhttps?:\/\/[\w\-._~:/?#\[\]@!$&'()*+,;=%]+/g, redactedUrl)
    .replace(/\bwww\.[^\s\"'`<>|)]+/g, redactedUrl)
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/= -]+/gi, `Bearer ${redactedValue}`)
    .replace(/\b(authorization|api[-_]?key|access[-_]?key|private[-_]?key|secret[-_]?key|secret|token|password|pwd)\s*[:=]\s*["']?[^\s"',}\]]{8,}/gi, `$1=${redactedValue}`)
    .replace(/\b0x[0-9a-fA-F]{64}\b/g, "[redacted-hex-key]")
    .replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9._-]{20,}\.[A-Za-z0-9._-]{20,}/g, "[redacted-jwt]");

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

function writeJson(filePath, value) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, jsonReplacer, 2)}\n`, "utf8");
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function rel(filePath) {
  return path.relative(WORKSPACE, filePath).replace(/\\/g, "/");
}

function normalizeAddress(raw) {
  const value = String(raw || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) return null;
  return value.toLowerCase();
}

function uniq(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const value = String(item || "").trim();
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

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function fetchText(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "evm-audit-stader-full-test/1.0" },
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

function extractAddresses(text) {
  const re = /0x[a-fA-F0-9]{40}/g;
  const out = [];
  let match;
  while ((match = re.exec(String(text || ""))) !== null) {
    const a = normalizeAddress(match[0]);
    if (a) out.push(a);
  }
  return uniq(out);
}

function classifyText(text, filePath) {
  const hay = `${String(filePath || "").toLowerCase()} ${String(text || "").toLowerCase()}`;
  const cats = [];
  for (const [category, terms] of Object.entries(CATEGORY_RULES)) {
    if (terms.some((term) => hay.includes(term))) {
      cats.push(category);
    }
  }
  return cats.length ? cats : ["context"];
}

function listScanFiles() {
  const files = [];
  for (const dir of [RAW_DIR, REPORTS_DIR]) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      const st = fs.statSync(full);
      if (!st.isFile()) continue;
      if (!/\.(json|md)$/i.test(entry)) continue;
      const lower = rel(full).toLowerCase();
      if (GENERATED_EXCLUDE.has(lower)) continue;
      if (GENERATED_CONTEXT_EXCLUDE_RE.test(lower)) continue;
      files.push(full);
    }
  }
  return uniq(files);
}

function scanLocalArtifacts(searchAddresses, tokenTerms = [], exactTerms = []) {
  const addressSet = new Set(searchAddresses.map((a) => String(a).toLowerCase()));
  const exactTermSet = new Set(exactTerms.map((s) => String(s).toLowerCase()));
  const contextTermSet = new Set(tokenTerms.map((s) => String(s).toLowerCase()));
  const rows = [];
  const exactRows = [];
  const contextRows = [];
  const categoryCounts = { consumer: 0, oracle: 0, vault: 0, dex: 0, lending: 0, context: 0 };
  let filesWithExact = 0;
  let filesWithContext = 0;

  for (const file of listScanFiles()) {
    const text = readText(file);
    if (!text) continue;
    const lower = text.toLowerCase();
    const filePath = rel(file);

    const hasExactAddress = [...addressSet].some((a) => lower.includes(a));
    const hasExactTerm = [...exactTermSet].some((t) => lower.includes(t));
    const hasContextTerm = [...contextTermSet].some((t) => lower.includes(t));
    if (!hasExactAddress && !hasExactTerm && !hasContextTerm) continue;

    if (hasExactAddress || hasExactTerm) filesWithExact += 1;
    else filesWithContext += 1;

    const lines = text.split(/\r?\n/);
    const lowerLines = lines.map((line) => line.toLowerCase());
    let sampled = 0;
    const seen = new Set();

    for (let i = 0; i < lowerLines.length && sampled < 24; i += 1) {
      const line = lowerLines[i];
      let matched = null;
      let matchType = "context";

      const exactAddress = [...addressSet].find((a) => line.includes(a));
      if (exactAddress) {
        matched = exactAddress;
        matchType = "exact-address";
      } else {
        const exactTerm = [...exactTermSet].find((term) => term && line.includes(term));
        if (exactTerm) {
          matched = exactTerm;
          matchType = "exact-term";
        } else {
          const contextTerm = [...contextTermSet].find((term) => term && line.includes(term));
          if (contextTerm) {
            matched = contextTerm;
            matchType = "context";
          }
        }
      }

      if (!matched) continue;

      const key = `${filePath}::${i + 1}::${matched}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const context = sanitizeArtifactContext(`${lines[i - 1] || ""} ${lines[i] || ""} ${lines[i + 1] || ""}`, 260);
      const categories = classifyText(context || "", filePath);
      const row = {
        file: filePath,
        line: i + 1,
        matchType,
        matched,
        categories,
        context,
      };
      rows.push(row);

      if (matchType === "exact-address" || matchType === "exact-term") {
        exactRows.push(row);
      } else {
        contextRows.push(row);
      }

      for (const cat of categories) categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
      sampled += 1;
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

function loadDeepMetadata() {
  const data = readJson(DEEP_METADATA_FILE);
  const row = data?.rankedTargetQueue?.find((r) => String(r?.slug || "").toLowerCase() === TARGET.slug);
  if (!row) {
    const rank = (data?.ranked || data?.rows || []).find((r) => String(r?.slug || "").toLowerCase() === TARGET.slug);
    if (rank) return parseDeepRow(rank, rel(DEEP_METADATA_FILE));
    return {
      ok: false,
      source: rel(DEEP_METADATA_FILE),
      reason: "missing-stader-row",
      slug: TARGET.slug,
      name: TARGET.name,
      category: TARGET.category,
      chains: ["Ethereum", "Binance", "Fantom", "Hedera", "Terra2", "Near"],
      accessibleEvmChains: ["Ethereum", "Binance", "Fantom"],
      accessibleNonEvmChains: [],
      blockedOrCaveatChains: ["Hedera", "Terra2", "Near"],
      surface: TARGET.surface,
      routeGraph: TARGET.routeGraph,
      firstReadOnlyChecks: [],
      tvlUsd: null,
      adapter: { module: TARGET.module, adapterFetched: null, adapterAddressSamples: [] },
    };
  }

  return parseDeepRow(row, rel(DEEP_METADATA_FILE));
}

function parseDeepRow(row, source) {
  return {
    ok: true,
    source,
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    tvlUsd: toNumber(row.tvlUsd) || 0,
    chains: row.chains || [],
    accessibleEvmChains: row.accessibleEvmChains || [],
    accessibleNonEvmChains: row.accessibleNonEvmChains || [],
    blockedOrCaveatChains: row.blockedOrCaveatChains || [],
    surface: row.surface || TARGET.surface,
    routeGraph: row.routeGraph || TARGET.routeGraph,
    firstReadOnlyChecks: row.firstReadOnlyChecks || [],
    audits: row.audits || null,
    module: row.adapter?.module || TARGET.module,
    adapterFetched: Boolean(row.adapter?.adapterFetched),
    adapterAddressCount: Number(row.adapter?.adapterAddressCount || 0),
    adapterHints: row.adapter?.adapterHints || [],
    adapterAddressSamples: (row.adapter?.adapterAddressSamples || []).map(normalizeAddress).filter(Boolean),
  };
}

function loadRoutePositiveRow() {
  const data = readJson(ROUTE_SWEEP_FILE);
  const row = (data?.ranked || []).find(
    (r) =>
      String(r?.id || "").toLowerCase() === "stader-phase0-sweep" ||
      String(r?.protocol || "").toLowerCase() === TARGET.name.toLowerCase(),
  );

  if (!row) {
    return {
      id: "stader-phase0-sweep",
      protocol: TARGET.name,
      routePositive: 0,
      executableNow: false,
      signedActionJustified: false,
      forkGate: "closed-route-positive-zero",
      blockers: [],
      requiredForRoutePositive: [],
      nextReadOnlyStep: "Await local route-positive enrichment for Stader from full test and follow standard consumer joins before any signed path.",
    };
  }

  return {
    id: row.id || "stader-phase0-sweep",
    protocol: row.protocol || TARGET.name,
    chain: row.chain || "",
    surface: row.surface || TARGET.surface,
    routePositive: Number(row.routePositive || 0),
    executableNow: Boolean(row.executableNow),
    signedActionJustified: Boolean(row.signedActionJustified),
    forkGate: row.forkGate || "closed-route-positive-zero",
    blockers: Array.isArray(row.blockers) ? row.blockers : [],
    requiredForRoutePositive: Array.isArray(row.requiredForRoutePositive) ? row.requiredForRoutePositive : [],
    nextReadOnlyStep: row.nextReadOnlyStep || "Use route-positive source artifacts only when local exact joins exist.",
    sourceArtifacts: row.sourceArtifacts || [],
    topRows: Array.isArray(row.topRows) ? row.topRows : [],
  };
}

function buildAddressContextsFromArtifacts(phase0Data, routePositiveRow, explicitAddresses, adapterAddresses) {
  const contexts = [];

  for (const address of explicitAddresses) {
    contexts.push({ address, chainId: null, chainLabel: null, source: "target-sample-or-deep-adapter" });
  }

  if (Array.isArray(adapterAddresses)) {
    for (const address of adapterAddresses) {
      contexts.push({ address, chainId: null, chainLabel: null, source: "adapter-source" });
    }
  }

  if (phase0Data && Array.isArray(phase0Data.rows)) {
    for (const row of phase0Data.rows) {
      const address = normalizeAddress(row.address);
      if (!address) continue;
      const chain = Number(row.chainId);
      contexts.push({
        address,
        chainId: Number.isFinite(chain) ? chain : null,
        chainLabel: CHAIN_BY_ID.get(chain)?.chainLabel || null,
        source: "scan-stader-phase0",
        label: row.label || null,
      });
    }
  }

  if (Array.isArray(routePositiveRow?.topRows)) {
    for (const item of routePositiveRow.topRows) {
      const address = normalizeAddress(item?.protocol || item?.address || item?.token || item?.contract || item?.vault || item?.operator);
      if (!address) continue;
      const chainName = item.chain && String(item.chain).toLowerCase() !== "unknown" ? String(item.chain) : null;
      const chainId = Number(item.chainId) || null;
      const chainLabel = chainId && CHAIN_BY_ID.has(chainId) ? CHAIN_BY_ID.get(chainId)?.chainLabel : chainName;

      contexts.push({
        address,
        chainId: chainId || null,
        chainLabel: chainLabel || null,
        source: "route-positive-toprow",
      });
    }
  }

  const unique = uniqBy(contexts, (item) => `${item.address}:${item.chainId || "na"}:${item.chainLabel || "na"}:${item.source}`);
  return unique.map((row) => ({
    address: normalizeAddress(row.address),
    chainId: Number.isFinite(row.chainId) ? row.chainId : null,
    chainLabel: row.chainLabel || null,
    source: row.source,
    label: row.label || null,
  })).filter((row) => Boolean(row.address));
}

function createProbeTargets(contexts) {
  const targets = [];
  for (const ctx of contexts) {
    if (ctx.chainId && CHAIN_BY_ID.has(ctx.chainId)) {
      targets.push(ctx);
      continue;
    }

    for (const chain of CHAIN_CONFIG) {
      if (!chain.inScope || !chain.chainId) continue;
      targets.push({
        address: ctx.address,
        chainId: chain.chainId,
        chainLabel: chain.chainLabel,
        source: `${ctx.source}|uncertain-chain`,
        label: ctx.label || null,
      });
    }
  }

  return uniqBy(targets, (item) => `${item.address}:${item.chainId}`);
}

function hexPayload(raw) {
  return String(raw || "")
    .replace(/^0x/, "")
    .toLowerCase();
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

function decodeWord(raw, index = 0) {
  const h = hexPayload(raw);
  if (!h) return null;
  const needed = (index + 1) * 64;
  const padded = h.padStart(needed, "0");
  const start = padded.length - (index + 1) * 64;
  const end = start + 64;
  return padded.slice(start, end) || null;
}

function decodeWordAsBigInt(raw, index = 0) {
  const w = decodeWord(raw, index);
  if (!w) return null;
  try {
    return BigInt(`0x${w}`);
  } catch (_) {
    return null;
  }
}

function decodeAddress(raw, index = 0) {
  const word = decodeWord(raw, index);
  if (!word) return null;
  return `0x${word.slice(-40)}`;
}

function decodeString(raw) {
  const h = hexPayload(raw);
  if (!h) return null;

  // 32-byte fixed-string fallback
  const fixed = h;
  try {
    const fixedBuf = Buffer.from(fixed, "hex");
    const firstZero = fixedBuf.indexOf(0);
    const fixedText = fixedBuf.slice(0, firstZero >= 0 ? firstZero : fixedBuf.length).toString("utf8");
    if (fixedText && fixedText.trim()) return fixedText.replace(/\u0000+$/, "");
  } catch (_) {
    // keep going
  }

  // dynamic ABI string: [offset][len][payload]
  try {
    const offset = Number(toBigIntFromHex(h.slice(0, 64)));
    if (!Number.isFinite(offset) || offset % 32 !== 0) return null;
    const lenPos = offset * 2;
    const lenHex = h.slice(lenPos, lenPos + 64);
    const len = Number(toBigIntFromHex(lenHex));
    if (!Number.isFinite(len)) return null;
    const dataStart = lenPos + 64;
    const dataEnd = dataStart + len * 2;
    if (dataEnd > h.length) return null;
    const payload = h.slice(dataStart, dataEnd);
    return Buffer.from(payload, "hex").toString("utf8");
  } catch (_) {
    return null;
  }
}

function decodeProbeValue(raw, kind) {
  if (!kind || kind === "none") return null;
  if (kind === "uint256") {
    const val = decodeWordAsBigInt(raw, 0);
    return val === null ? null : val;
  }
  if (kind === "address") return decodeAddress(raw, 0);
  if (kind === "string") return decodeString(raw);
  return null;
}

function encodeArg(value, kind = "uint256") {
  const k = String(kind || "").toLowerCase();
  if (k === "address") {
    const normalized = normalizeAddress(value);
    return normalized ? normalized.replace(/^0x/, "").padStart(64, "0") : "0".repeat(64);
  }
  if (k === "string") {
    return "0".repeat(64);
  }
  const bi = BigInt(value || 0n);
  const hex = bi.toString(16);
  return hex.length > 64 ? hex.slice(-64) : hex.padStart(64, "0");
}

function callDataFromProbe(probe) {
  const args = probe.args();
  const encoded = args
    .map((arg, index) => encodeArg(arg, probe.argTypes[index]))
    .join("");
  return `${probe.selector}${encoded}`;
}

function rpcCallClassification(resp) {
  if (!resp) return { ok: false, status: "unknown", transportOk: false, rpcError: "no-response" };
  if (resp.ok) return { ok: true, status: "ok", transportOk: true, rpcError: null };
  if (!resp.transport) return { ok: false, status: "transport-error", transportOk: false, rpcError: resp.error || "transport" };
  if (/execution reverted/i.test(String(resp.error || ""))) {
    return { ok: false, status: "reverted", transportOk: true, rpcError: resp.error || "execution-reverted" };
  }
  return { ok: false, status: resp.error || "rpc-error", transportOk: true, rpcError: resp.error || "rpc-error" };
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
      return { ok: false, status: res.status, transport: true, error: `http-${res.status}`, body: text || null, json };
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

    return { ok: true, status: res.status, transport: true, result: json.result, json };
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

async function resolveChainRpcFromInventory(chainId, rpcInventory) {
  for (const url of rpcInventory) {
    const response = await rpcPost(url, "eth_chainId", [], RPC_TIMEOUT_MS);
    const ok = rpcCallClassification(response);
    if (!ok.ok) continue;
    const observed = toBigIntFromHex(response.result);
    if (observed === null) continue;
    if (Number(observed) === chainId) {
      return url;
    }
  }
  return null;
}

async function probeChainState(chainConfig, rpcInventory, allowPublicFallback = false) {
  const chainId = chainConfig.chainId;
  const row = {
    chainLabel: chainConfig.chainLabel,
    chainId,
    inScope: Boolean(chainConfig.inScope),
    caveat: Boolean(chainConfig.caveat),
    rpcInventoryRows: Array.isArray(rpcInventory) ? rpcInventory.length : 0,
    rpcResolved: false,
    rpcSource: "none",
    rpcStatus: "unresolved",
    rpcError: null,
    chainIdObserved: null,
    chainIdMatch: null,
    blockNumber: null,
    blockNumberHex: null,
    blockStatus: "not-probed",
    latestBlockFromRpc: false,
    rpcUrl: null,
  };

  if (!Number.isFinite(chainId)) return row;

  const inventoryResolved = await resolveChainRpcFromInventory(chainId, rpcInventory);
  const publicFallback = allowPublicFallback ? PUBLIC_FALLBACKS[chainId] || null : null;
  const resolved = inventoryResolved || publicFallback;
  if (!resolved) {
    row.rpcStatus = "unresolved-inventory-miss";
    return row;
  }

  row.rpcResolved = true;
  row.rpcSource = inventoryResolved ? "rpc-inventory" : "public-fallback";
  row.rpcStatus = "ready";
  row.rpcUrl = resolved;

  const chainResp = await rpcPost(resolved, "eth_chainId", [], RPC_TIMEOUT_MS);
  const chainClass = rpcCallClassification(chainResp);
  if (!chainClass.ok) {
    row.rpcStatus = chainClass.status;
    row.rpcError = chainClass.rpcError;
    return row;
  }

  const observed = toBigIntFromHex(chainResp.result);
  if (observed !== null) {
    row.chainIdObserved = Number(observed);
    row.chainIdMatch = row.chainIdObserved === chainId;
  }

  const blockResp = await rpcPost(resolved, "eth_blockNumber", [], RPC_TIMEOUT_MS);
  const blockClass = rpcCallClassification(blockResp);
  if (blockClass.ok && blockResp.result) {
    row.blockStatus = "ok";
    row.blockNumberHex = String(blockResp.result);
    const blockNum = toBigIntFromHex(blockResp.result);
    row.blockNumber = blockNum === null ? null : blockNum.toString();
    row.latestBlockFromRpc = true;
  } else {
    row.blockStatus = blockClass.status;
  }

  return row;
}

async function runSingleFunctionProbe(rpcUrl, address, probe) {
  const callData = callDataFromProbe(probe);
  const transport = await rpcPost(rpcUrl, "eth_call", [{ to: address, data: callData }, "latest"], ETH_CALL_TIMEOUT_MS);
  const cls = rpcCallClassification(transport);
  const raw = transport.ok ? transport.result : null;
  const decoded = cls.ok ? decodeProbeValue(raw, probe.decodeType) : null;

  return {
    group: probe.group,
    name: probe.name,
    signature: probe.signature,
    selector: probe.selector,
    nonView: Boolean(probe.nonView),
    status: cls.status,
    transportOk: cls.transportOk,
    rpcError: cls.rpcError,
    raw: raw || null,
    decoded: jsonReplacer(null, decoded),
  };
}

async function probeAddress(context, chainProbe, rpcInventory = []) {
  const address = context.address;
  const row = {
    chainLabel: context.chainLabel,
    chainId: context.chainId,
    address,
    source: context.source || "unknown",
    label: context.label || null,
    rpcProvider: {
      source: chainProbe.rpcSource,
      resolved: chainProbe.rpcResolved,
      status: chainProbe.rpcStatus,
      chainIdObserved: chainProbe.chainIdObserved,
      chainIdMatch: chainProbe.chainIdMatch,
      blockStatus: chainProbe.blockStatus,
      blockNumber: chainProbe.blockNumber,
      blockNumberHex: chainProbe.blockNumberHex,
      latestBlockFromRpc: chainProbe.latestBlockFromRpc,
      chainProvider: chainProbe.caveat ? "non-production-later-chain" : "endpoint-backed",
      rpcInventoryRows: chainProbe.rpcInventoryRows,
      rpcError: chainProbe.rpcError || null,
    },
    codePresent: false,
    codeHexSize: null,
    codeStatus: "not-probed",
    probes: [],
    nonViewEthCallAvailable: {
      redeem: null,
      withdraw: null,
      claim: null,
      unstake: null,
    },
    specific: {},
    chainIdUncertain: !Number.isFinite(context.chainId),
  };

  if (!chainProbe.rpcResolved) {
    row.codeStatus = "no-rpc";
    return row;
  }

  const chainConfig = CHAIN_BY_ID.get(context.chainId);
  let rpcUrl = chainProbe.rpcUrl || null;
  if (!rpcUrl) {
    const fallbackRpc = chainConfig ? await resolveChainRpcFromInventory(context.chainId, rpcInventory) : null;
    if (!fallbackRpc) {
      row.codeStatus = "no-rpc";
      return row;
    }
    rpcUrl = fallbackRpc;
    row.rpcProvider.rpcSource = "rpc-inventory-fallback";
    row.rpcProvider.status = "ready";
  }

  const codeResp = await rpcPost(rpcUrl, "eth_getCode", [address, "latest"], RPC_TIMEOUT_MS);
  const codeClass = rpcCallClassification(codeResp);
  if (!codeClass.ok) {
    row.codeStatus = codeClass.status;
    return row;
  }

  const codeHex = codeResp.result || "0x";
  const codeSize = Math.max(0, Math.floor((hexPayload(codeHex).length || 0) / 2));
  row.codeStatus = codeHex === "0x" || codeSize === 0 ? "empty" : "present";
  row.codePresent = row.codeStatus === "present";
  row.codeHexSize = codeSize;
  if (!row.codePresent) return row;

  const rpcUrlForProbes = rpcUrl || (await resolveChainRpcFromInventory(context.chainId, rpcInventory));
  for (const probe of FUNCTION_PROBES) {
    const probeRow = await runSingleFunctionProbe(rpcUrlForProbes, address, probe);
    row.probes.push(probeRow);

    if (probe.name === "asset" && probeRow.decoded) row.specific.asset = probeRow.decoded;
    if (probe.name === "decimals" && probeRow.decoded !== null) row.specific.decimals = String(probeRow.decoded);
    if (probe.name === "totalSupply" && probeRow.decoded !== null) row.specific.totalSupply = String(probeRow.decoded);
    if (probe.name === "totalAssets" && probeRow.decoded !== null) row.specific.totalAssets = String(probeRow.decoded);
    if (probe.name === "convertToAssets" && probeRow.decoded !== null) row.specific.convertToAssets1e18 = String(probeRow.decoded);
    if (probe.name === "previewRedeem" && probeRow.decoded !== null) row.specific.previewRedeem1e18 = String(probeRow.decoded);
    if (probe.name === "maxWithdraw" && probeRow.decoded !== null) row.specific.maxWithdrawForZero = String(probeRow.decoded);
    if (probe.name === "maxRedeem" && probeRow.decoded !== null) row.specific.maxRedeemForZero = String(probeRow.decoded);
    if (probe.name === "exchangeRate" && probeRow.decoded !== null) row.specific.exchangeRate = String(probeRow.decoded);
    if (probe.name === "pricePerShare" && probeRow.decoded !== null) row.specific.pricePerShare = String(probeRow.decoded);

    if (probe.name === "redeem") row.nonViewEthCallAvailable.redeem = probeRow.status;
    if (probe.name === "withdraw") row.nonViewEthCallAvailable.withdraw = probeRow.status;
    if (probe.name === "claim") row.nonViewEthCallAvailable.claim = row.nonViewEthCallAvailable.claim || probeRow.status;
    if (probe.name === "unstake") row.nonViewEthCallAvailable.unstake = probeRow.status;
  }

  return row;
}

function collectJoinCounts(artifactRows) {
  let exact = 0;
  let context = 0;

  const isJoinCategory = (row) =>
    Array.isArray(row.categories) && row.categories.some((category) => JOIN_CATEGORIES.includes(category));

  for (const row of artifactRows.exactRows) {
    if (isJoinCategory(row)) exact += 1;
  }

  for (const row of artifactRows.contextRows) {
    if (isJoinCategory(row)) context += 1;
  }

  return {
    exact,
    context,
    total: exact + context,
  };
}

function renderReport(payload) {
  const lines = [];
  const dormant = payload.routePositive === 0 && !payload.exactEconomicsRows;
  lines.push(`${dormant ? "# 🟢 DORMANT" : "# ⚠️ WATCH-WEAK"} — Stader Full Read-Only Test`);
  lines.push("");
  lines.push(`Generated: ${payload.generatedAt}`);
  lines.push("");
  lines.push("## Verdict");
  lines.push("");
  if (dormant) {
    lines.push("No route-positive Stader exploit is proven. Continue as read-only watch path until exact consumer/consumer join and exact-positive route economics are confirmed.");
  } else {
    lines.push("Route-positive evidence exists; re-check signed and fork gates before any live action.");
  }

  lines.push("");
  lines.push("## Summary");
  lines.push("- routePositive: `" + payload.routePositive + "`");
  lines.push("- executableNow: `" + payload.executableNow + "`");
  lines.push("- signedActionJustified: `" + payload.signedActionJustified + "`");
  lines.push("- forkJustified: `" + payload.forkJustified + "`");
  lines.push("- forkGate: " + payload.forkGate);
  lines.push("- exactEconomicsRows: " + payload.summary.exactEconomicsRows);
  lines.push("- total probe rows: " + payload.summary.totalProbeRows);
  lines.push("- consumer joins (exact/context): " + payload.summary.exactConsumerJoinRows + " / " + payload.summary.contextConsumerJoinRows);

  lines.push("");
  lines.push("## Safety");
  lines.push(`- rpcInventoryRead: ${payload.safety.rpcInventoryRead}`);
  lines.push(`- rpcUrlsStored: ${payload.safety.rpcUrlsStored}`);
  lines.push(`- rpcInventoryRows: ${payload.endpointCoverage.rpcInventoryRows}`);
  lines.push(`- chainResolvedFromInventory: ${payload.endpointCoverage.chainResolvedFromInventory}`);
  lines.push(`- chainCount: ${payload.endpointCoverage.chainCount}`);
  lines.push(`- graphqlInventoryRead: ${payload.safety.graphqlInventoryRead}`);
  lines.push(`- envFilesRead: ${payload.safety.envFilesRead}`);
  lines.push(`- privateKeysRead: ${payload.safety.privateKeysRead}`);
  lines.push(`- signedActions: ${payload.safety.signedActions}`);

  lines.push("");
  lines.push("## Endpoint coverage (sanitized)");
  for (const chain of payload.endpointCoverage.chainProbes) {
    lines.push(
      `- ${chain.chainLabel} (id ${chain.chainId}): rpc=${chain.rpcResolved ? "resolved" : chain.rpcStatus}; block=${chain.blockNumber || "n/a"}; caveat=${chain.caveat}`,
    );
  }

  lines.push("");
  lines.push("## Address contexts");
  lines.push(`- addressRows: ${payload.addressRows.length}`);
  if (payload.addressRows.length) {
    for (const row of payload.addressRows.slice(0, 12)) {
      lines.push(`- ${row.address} (${row.chainLabel || "chain-uncertain"}/${row.chainId || "uncertain"}) @ ${row.source}`);
    }
  } else {
    lines.push("- none");
  }

  lines.push("");
  lines.push("## Live contract probe samples");
  if (!payload.liveProbes.length) {
    lines.push("- none");
  }
  for (const row of payload.liveProbes.slice(0, 8)) {
    lines.push(`- ${row.chainLabel}/${row.chainId} ${row.address}: code=${row.codeStatus}, rpc=${row.rpcProvider.status}, block=${row.rpcProvider.blockNumber || "n/a"}`);
    lines.push(
      `  - nonView eth_call availability: redeem=${row.nonViewEthCallAvailable.redeem}, withdraw=${row.nonViewEthCallAvailable.withdraw}, claim=${row.nonViewEthCallAvailable.claim}, unstake=${row.nonViewEthCallAvailable.unstake}`,
    );
    for (const probe of row.probes.slice(0, 10)) {
      const value = probe.decoded === null ? "n/a" : `${JSON.stringify(probe.decoded)} (${probe.status})`;
      lines.push(`  - ${probe.group}.${probe.name} => ${value}`);
    }
    if (row.specific && Object.keys(row.specific).length) {
      lines.push(`  - specific: ${JSON.stringify(row.specific)}`);
    }
    lines.push("");
  }

  lines.push("## Local artifact / source matches");
  if (!payload.localArtifactSamples.length) {
    lines.push("- none");
  }
  for (const match of payload.localArtifactSamples.slice(0, 30)) {
    lines.push(`- \`${match.file}:${match.line}\` (${match.matchType}; ${match.categories.join(", ")}) ${match.context}`);
  }

  lines.push("");
  lines.push("## Blockers");
  for (const blocker of payload.blockers) lines.push(`- ${blocker}`);

  lines.push("");
  lines.push("## Required for route-positive");
  for (const req of payload.requiredForRoutePositive) lines.push(`- ${req}`);

  lines.push("");
  lines.push(`Next read-only step: ${payload.nextReadOnlyStep}`);

  return `${lines.join("\n")}\n`;
}

async function main() {
  const metadata = loadDeepMetadata();
  const protocol = await fetchJson(PROTOCOL_API, 30_000);
  const adapterText = await fetchText(ADAPTER_SOURCE, 30_000);
  const adapterAddresses = extractAddresses(adapterText || "");

  const routePositiveRow = loadRoutePositiveRow();
  const phase0Data = readJson(STADER_PHASE0_FILE);

  const knownAddresses = uniq([
    ...TARGET.sampleAddresses,
    ...(metadata.adapterAddressSamples || []),
    ...adapterAddresses,
  ].map(normalizeAddress).filter(Boolean));

  const addressContexts = buildAddressContextsFromArtifacts(phase0Data, routePositiveRow, knownAddresses, adapterAddresses);
  const probeTargets = createProbeTargets(addressContexts).slice(0, 50);
  const searchTermsExact = [TARGET.slug, TARGET.name.toLowerCase(), TARGET.module.toLowerCase(), ...TARGET.sampleAddresses.map((a) => a.toLowerCase())];
  const tokenContextTerms = TARGET.tokenHints.slice(0, 12).map((term) => term.toLowerCase());

  const localArtifacts = scanLocalArtifacts(
    uniq(addressContexts.map((row) => row.address)),
    tokenContextTerms,
    searchTermsExact,
  );

  const skipRpcInventory = process.env.STADER_SKIP_RPC_INVENTORY === "1";
  const rpcInventory = skipRpcInventory ? [] : loadRpcUrls();
  const rpcInventoryRead = !skipRpcInventory && Array.isArray(rpcInventory) && rpcInventory.length > 0;
  const rpcInventoryRows = Array.isArray(rpcInventory) ? rpcInventory.length : 0;

  const chainProbes = [];
  for (const chainConfig of CHAIN_CONFIG.filter((c) => c.inScope)) {
    chainProbes.push(await probeChainState(chainConfig, rpcInventory, skipRpcInventory));
  }

  const chainProbeById = new Map(chainProbes.filter((c) => Number.isFinite(c.chainId)).map((row) => [row.chainId, row]));

  const liveProbes = [];
  for (const target of probeTargets) {
    const chainProbe = chainProbeById.get(target.chainId) || {
      rpcResolved: false,
      rpcStatus: "missing-chain-state",
      chainIdMatch: false,
      blockNumber: null,
      blockNumberHex: null,
      blockStatus: "not-probed",
      rpcSource: "none",
      rpcInventoryRows,
    };
    liveProbes.push(await probeAddress(target, chainProbe));
  }

  const joinCounts = collectJoinCounts(localArtifacts);

  const caveatChains = (metadata.blockedOrCaveatChains || []).concat(metadata.accessibleNonEvmChains || []).filter(Boolean);
  const exactEconomicsRows = 0;
  const routePositive = Number(payloadRoutePositive(metadata, routePositiveRow, liveProbes));

  const endpointCoverage = {
    rpcInventoryRows,
    chainCount: chainProbes.length,
    chainResolvedFromInventory: chainProbes.filter((c) => c.rpcResolved && c.rpcSource === "rpc-inventory").length,
    chainResolvedFromPublicFallback: chainProbes.filter((c) => c.rpcResolved && c.rpcSource === "public-fallback").length,
    chainProbes: chainProbes.map((row) => ({
      chainLabel: row.chainLabel,
      chainId: row.chainId,
      inScope: row.inScope,
      caveat: row.caveat,
      rpcStatus: row.rpcStatus,
      rpcInventoryRows: row.rpcInventoryRows,
      chainIdObserved: row.chainIdObserved,
      chainIdMatch: row.chainIdMatch,
      blockNumber: row.blockNumber,
      blockNumberHex: row.blockNumberHex,
      blockStatus: row.blockStatus,
      rpcError: row.rpcError,
      rpcSource: row.rpcSource,
    })),
  };

  const summary = {
    targetTvls: {
      protocolTvlUsd: toNumber(protocol?.tvl) || toNumber(metadata.tvlUsd) || null,
      chainTvls: protocol?.chainTvls || {},
    },
    exactLocalArtifactMatchRows: localArtifacts.exactRows.length,
    contextLocalArtifactMatchRows: localArtifacts.contextRows.length,
    localArtifactMatchRows: localArtifacts.rows.length,
    filesWithExactMatch: localArtifacts.filesWithExact,
    filesWithContextMatch: localArtifacts.filesWithContext,
    exactConsumerJoinRows: joinCounts.exact,
    contextConsumerJoinRows: joinCounts.context,
    consumerJoinRows: joinCounts.total,
    categoryCounts: localArtifacts.categoryCounts,
    addressRows: addressContexts.length,
    totalProbeRows: liveProbes.length,
    liveProbeRowsWithRpc: liveProbes.filter((row) => row.rpcProvider.resolved).length,
    liveProbeRowsWithCode: liveProbes.filter((row) => row.codePresent).length,
    nonViewProbeRows: liveProbes.reduce(
      (acc, row) =>
        acc +
        (row.nonViewEthCallAvailable.redeem ? 1 : 0) +
        (row.nonViewEthCallAvailable.withdraw ? 1 : 0) +
        (row.nonViewEthCallAvailable.claim ? 1 : 0) +
        (row.nonViewEthCallAvailable.unstake ? 1 : 0),
      0,
    ),
    chainResolvedFromInventory: endpointCoverage.chainResolvedFromInventory,
    routePositive,
    executableNow: 0,
    exactEconomicsRows,
    caveatChains: caveatChains.length,
    caveatChainList: caveatChains,
  };

  const blockers = [
    "Only Ethereum has known verified contract addresses in local artifacts; BNB/Fantom evidence is currently limited/no proven same surface mapping.",
    "Probed vault interfaces (metadata, ERC20 fields, ERC4626-style getters) are read-only and do not prove callable value movement paths.",
    "No exact permissionless mint/burn/withdraw/redeem path was established in local protocol surface mapping.",
    "No exact Stader/ETHx/SD/consumer-route economic row was proven during this full-test scan.",
    "Fork/value-delta gates remain closed while routePositive=0.",
  ];

  const requiredForRoutePositive = [
    "Exact Stader/ETHx/SD vault share surface must be joined to a material lending/oracle/DEX consumer with accepted value.",
    "Exact permissionless acquisition path to protocol token/value must be shown and then proven with live-route economics (gains after fees/slippage).",
    "Consumer/oracle path with exact positive economics + confirmed route and finality costs must be demonstrated.",
    "Fork/value-delta or other immutable proof must be produced before any signed/live action.",
    "Endpoint-backed evidence must remain in-scope, watch-only unless fork/execution gates open.",
  ];

  const nextReadOnlyStep = "Probe exact non-view/read-only routes with chain-resolved certainty only, then join specific consumer/oracle/DEX artifacts before any fork/signed execution consideration.";

  const payload = {
    generatedAt: new Date().toISOString(),
    scanner: "scan-stader-full-test.js",
    scope: "Stader liquid staking full-test read-only",
    target: TARGET,
    metadata: {
      name: metadata.name || TARGET.name,
      category: metadata.category || TARGET.category,
      slug: metadata.slug || TARGET.slug,
      chains: metadata.chains || ["Ethereum", "Binance", "Fantom", "Hedera", "Terra2", "Near"],
      accessibleEvmChains: metadata.accessibleEvmChains || ["Ethereum", "Binance", "Fantom"],
      accessibleNonEvmChains: metadata.accessibleNonEvmChains || [],
      blockedOrCaveatChains: caveatChains,
      surface: metadata.surface || TARGET.surface,
      routeGraph: metadata.routeGraph || TARGET.routeGraph,
      firstReadOnlyChecks: metadata.firstReadOnlyChecks || [],
      source: metadata.source || rel(DEEP_METADATA_FILE),
    },
    protocol: protocol
      ? {
          name: protocol.name || null,
          slug: protocol.slug || null,
          category: protocol.category || null,
          tvl: toNumber(protocol.tvl) || null,
          currentChainTvls: protocol.currentChainTvls || protocol.chainTvls || null,
        }
      : null,
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
      liveSends: false,
    },
    endpointCoverage,
    addressRows: addressContexts.map((entry) => ({
      address: entry.address,
      chainId: entry.chainId || null,
      chainLabel: entry.chainLabel || null,
      source: entry.source || null,
      label: entry.label || null,
    })),
    sourceArtifacts: {
      deepMetadata: metadata.source || rel(DEEP_METADATA_FILE),
      adapterSource: sanitizeArtifactContext(ADAPTER_SOURCE, 160),
      protocolApi: sanitizeArtifactContext(PROTOCOL_API, 160),
      phase0Source: rel(STADER_PHASE0_FILE),
      routePositiveSource: rel(ROUTE_SWEEP_FILE),
    },
    localArtifactSamples: localArtifacts.rows.slice(0, 120),
    localArtifactCategoryCounts: localArtifacts.categoryCounts,
    localJoinCounts: {
      exactConsumerJoinRows: joinCounts.exact,
      contextConsumerJoinRows: joinCounts.context,
      consumerJoinRows: joinCounts.total,
    },
    liveProbes,
    summary,
    routePositive,
    executableNow: 0,
    signedActionJustified: false,
    forkJustified: false,
    forkGate: routePositive > 0 ? "open-route-positive-pending-gate" : "closed-route-positive-zero",
    blockers,
    requiredForRoutePositive,
    nextReadOnlyStep,
  };

  payload.forkGate = payload.forkGate || "closed-route-positive-zero";
  payload.executableNow = 0;

  if (!QUIET) {
    payload.fullTestReadOnlyComplete = true;
  }

  writeJson(OUT_JSON, payload);
  fs.writeFileSync(OUT_MD, renderReport(payload), "utf8");

  log(JSON.stringify({ json: OUT_JSON_REL, markdown: OUT_MD_REL, routePositive: payload.routePositive, probes: payload.summary.totalProbeRows }, null, 2));
}

function payloadRoutePositive(metadata, routePositiveRow, liveProbes) {
  const routePositiveFromMetadata = Number(metadata?.routePositive || routePositiveRow?.routePositive || 0);
  const positiveProbes = liveProbes.filter((probe) => probe.codePresent && (probe.nonViewEthCallAvailable.redeem || probe.nonViewEthCallAvailable.withdraw || probe.nonViewEthCallAvailable.unstake || probe.nonViewEthCallAvailable.claim) && probe.codeHexSize > 0);
  // Keep fail-closed unless explicit, external exact-economics evidence is added via local route-positive artifacts.
  if (routePositiveFromMetadata > 0) return routePositiveFromMetadata;
  if (positiveProbes.length > 0) return 0;
  return 0;
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
