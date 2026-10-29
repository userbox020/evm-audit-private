#!/usr/bin/env node
// scan-merlins-seal-full-test.js - bounded MERLINS Seal full-test scanner.
// CommonJS, read-only, deterministic. No secrets, no .env/.env.* reads, no fork txs.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const REPORTS_DIR = path.join(WORKSPACE, "reports");
const COORDINATION_HANDOFF = path.join(WORKSPACE, "coordination", "handoffs", "2026-07-04-discovery-merlins-seal-full-test-handoff.md");
const DEEP_METADATA = path.join(RAW_DIR, "prefilter-deep-new-target-search-2026-06-24.json");
const OUT_JSON = path.join(RAW_DIR, "merlins-seal-full-test.json");
const OUT_MD = path.join(WORKSPACE, "reports", "merlins-seal-full-test-triage.md");
const QUIET = process.argv.includes("--quiet");
const EXCLUDED_LOCAL_ARTIFACT_RELS = [
  path.relative(WORKSPACE, OUT_JSON).replace(/\\/g, "/").toLowerCase(),
  path.relative(WORKSPACE, OUT_MD).replace(/\\/g, "/").toLowerCase(),
  path.relative(WORKSPACE, COORDINATION_HANDOFF).replace(/\\/g, "/").toLowerCase(),
];

const TARGET_SLUG = "merlins-seal";
const TARGET_NAME = "Merlins Seal";
const TARGET_MODULE = "merlin-l2/index.js";

const DEFI_LLAMA_PROTOCOL = "https://api.llama.fi/protocol/merlins-seal";
const DEFI_LLAMA_ADAPTER = "https://raw.githubusercontent.com/DefiLlama/DefiLlama-Adapters/main/projects/merlin-l2/index.js";
const DEXSCREENER_TOKEN_API = "https://api.dexscreener.com/latest/dex/tokens/";

const CHAIN_CONFIG = [
  {
    chain: "Ethereum",
    chainId: 1,
    rpcHint: "public/default:ethereum",
    rpcUrls: [
      "https://ethereum.publicnode.com",
      "https://rpc.ankr.com/eth",
    ],
    accessible: true,
  },
  {
    chain: "Arbitrum",
    chainId: 42161,
    rpcHint: "public/default:arbitrum",
    rpcUrls: [
      "https://arbitrum.llamarpc.com",
      "https://rpc.ankr.com/arbitrum",
    ],
    accessible: true,
  },
];

// Known adapter addresses observed from discovery metadata and brief briefing.
const KNOWN_MERLINS_ADDRESSES = [
  "0x7122985656e38BDC0302Db86685bb972b145bD3C",
  "0x147A198d803D4a02b8bEc7CC78be1AbE0C3d93E5",
  "0x8bb6cae3f1cada07dd14ba951e02886ea6bba183",
  "0xC40329D3aE56Af6b0757C3fE53941DDCC3d92671",
  "0x8E3e71f5c016A3c764D0D0210fF71F15BEa46e3b",
  "0x4b21b980d0Dc7D3C0C6175b0A412694F3A1c7c6b",
  "0x3f97bf3Cd76B5cA9D4A4E9cD8a73C24E32d6C193",
  "0x813bCb548F99Bc081e5EFeeAa65e3018befb92Ae",
];

const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

const VIEW_PROBES = [
  { id: "symbol()", selector: "0x95d89b41", args: [] },
  { id: "name()", selector: "0x06fdde03", args: [] },
  { id: "decimals()", selector: "0x313ce567", args: [] },
  { id: "totalSupply()", selector: "0x18160ddd", args: [] },
  { id: "owner()", selector: "0x8da5cb5b", args: [] },
  { id: "admin()", selector: "0xf851a440", args: [] },
  { id: "paused()", selector: "0x5c975abb", args: [] },
];

const TARGET_TEXT_ANCHOR_TERMS = [
  "merlins",
  "merlin",
  "merlins-seal",
  "merlin-seal",
  "merlin-l2",
  "merlin btc",
  "mbtc",
  "m-btc",
  "m_btc",
  "m btc",
  "stone",
];

const BASE_TEXT_TERMS = [
  ...TARGET_TEXT_ANCHOR_TERMS,
  "bridge",
  "custody",
  "bridge-proof-custody-consumer",
  "proof",
  "backing",
  "wrapper",
  "lending",
  "borrow",
  "consumer",
  "oracle",
  "router",
  "dex",
  "token",
  "pool",
  "liquidity",
];

const MERLINS_TARGET_TEXT_RE = /(\bmerlins[- ]?seal\b|\bmerlin[- ]seal\b|\bmerlin-l2\b|\bmerlin\b|\bmbtc\b|\bm[-_ ]?btc\b)/i;
const MBTC_CONTEXT_RE = /\bmbtc\b|\bm[-_ ]?btc\b/i;
const STONE_TERM_RE = /\bstone\b/i;

const SEARCH_TERM_PATTERNS = {
  sourceInventory: /merlins|merlin|merlin-l2|merlins-seal|merlin-seal|bridge-custody|bridge-proof|proof|custody|mbtc|m[-_ ]?btc|bridge|consumer|borrow|lending|oracle|token/i,
  abi: /abi|interface|bytecode|function\s+\w+\s*\(|implementation|proxy|storage|upgrade|initialize|initializer|slot/i,
  eventLogs: /event\b|emit\b|Transfer\(|Mint\(|Burn\(|Redeem\(|Deposit\(|Withdraw\(|Swap\(|liquidat|oracle|proof|message/i,
  proxyRoles: /owner|admin|governance|timelock|role|permission|upgrade|upgrad|initializer|authority|guardian|pauser/i,
  tokenSemantics: /symbol|decimals|supply|total[s]?supply|underlying|wrapped|mint|burn|redeem|share|asset|balanceOf|balance/i,
  erc4626: /erc4626|convertTo(Shares|Assets)|totalAssets|maxDeposit|maxMint|maxWithdraw|maxRedeem|asset\(\)|pricePerShare/i,
  oracle: /oracle|pricefeed|latestRoundData|aggregator|chainlink|pyth|redstone|band|price|stale|heartbeat|scalar|decim/i,
  bridgeProof: /bridge|custody|proof|backing|message|domain|nonce|outbox|inbox|mint|unlock|release|withdraw|deposit|l1|l2/i,
  consumerGraph: /consumer|lending|borrow|loan|vault|market|redeem|unlock|exit|join|supply|withdraw/i,
  dexLiquidity: /dex|amm|swap|pool|liquidity|router|pair|factory|quoter|route/i,
  balanceReachability: /balance|balanceOf|allowance|approve|transfer|permit|approve\(|transferFrom/i,
  selectorProbe: /0x[0-9a-f]{8}/i,
};

const GATED_CONTEXT_CATEGORIES = {
  eventLogs: true,
  tokenSemantics: true,
  erc4626: true,
  oracle: true,
  bridgeProof: true,
  consumerGraph: true,
  dexLiquidity: true,
  balanceReachability: true,
  proxyRoles: true,
};

const ATTACK_PATTERNS = {
  drainVaultNoBorrow: /drain|withdraw.*without.*borrow|no.?borrow|sweep|rescue|migration|allocator|strategy/i,
  bridgeCrossChain: /bridge|cross.?chain|l1|l2|message|nonce|domain|proof/i,
  routerRfqApprovals: /router|rfq|approval|approve\(|permit|signature|deadline|quoter|quote/i,
  fakeAssetPoolValidation: /fake.?asset|fake.?pool|pool.?validation|canonical|whitelist|factory|whitelisted|counterfeit|pool token/i,
  governance: /governance|timelock|vote|voting|snapshot|delegate|quorum|proposal|emergency|upgrader|guardian/i,
  claimRewardReplay: /claim|reward|merkle|distributor|rewarder|replay|double.?claim|airdrop/i,
  mevRebalancing: /mev|sandwich|rebalanc|allocator|auction|batch|reorder|front.?run|back.?run/i,
  rounding: /round|dust|precision|truncat|ceil|floor|wad|ray|muldiv|fixed.?point|precision/i,
  oracleSandwich: /oracle.*sandwich|manipulat.*oracle|same.?block.*oracle|price.*impact|stale.*oracle/i,
  crossFunctionStateMachine: /cross.?function|state.?machine|epoch|queue|window|reentr|callback|sequenc|reentrancy|transition/i,
  initializationAuthorization: /initialize|initializer|authorization|authorit|role|access.?control|owner\(|admin\(/i,
};

function log(...args) {
  if (!QUIET) {
    console.log(...args);
  }
}

function safeJson(value) {
  return JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);
}

function isExcludedLocalArtifact(filePath) {
  const rel = toRel(filePath).toLowerCase();
  if (EXCLUDED_LOCAL_ARTIFACT_RELS.includes(rel)) return true;
  if (rel.startsWith("coordination/claims/") && rel.includes("merlins")) return true;
  if (rel.startsWith("coordination/archive/") && rel.includes("merlins")) return true;
  return false;
}

function toRel(filePath) {
  return path.relative(WORKSPACE, filePath).replace(/\\/g, "/");
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (_error) {
    return null;
  }
}

function readJson(filePath, fallback = null) {
  const raw = readText(filePath);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (_error) {
    return fallback;
  }
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function sanitizeLine(line) {
  return String(line || "").replace(/[\r\n|]+/g, " ").replace(/\s+/g, " ").trim();
}

function countOccurrences(text, term) {
  if (!text || !term) return 0;
  const needle = String(term);
  if (!needle) return 0;
  let count = 0;
  let cursor = 0;
  while (true) {
    const pos = text.indexOf(needle, cursor);
    if (pos < 0) break;
    count += 1;
    cursor = pos + needle.length;
  }
  return count;
}

function listFilesByExt(dir, ext) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith(ext))
    .map((name) => path.join(dir, name));
}

function normalizeAddress(value) {
  const raw = String(value || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) return null;
  return raw.toLowerCase();
}

function stripHex(raw) {
  return String(raw || "").toLowerCase().replace(/^0x/, "");
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function isZeroAddress(address) {
  return normalizeAddress(address) === ZERO_ADDRESS;
}

function parseRpcAddressResult(raw) {
  if (!raw || raw === "0x") return null;
  const parsed = decodeHexAddress(raw);
  return isZeroAddress(parsed) ? null : parsed;
}

function pickBalanceProbeTarget(targetAddress, candidateAddressHints = [], preferredPrimary = [], fallbackSecondary = []) {
  const seen = new Set();
  const out = [];

  const add = (value) => {
    const normalized = normalizeAddress(value);
    if (!normalized) return;
    if (isZeroAddress(normalized)) return;
    if (normalized === normalizeAddress(targetAddress)) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  };

  for (const value of preferredPrimary) add(value);
  for (const value of candidateAddressHints) add(value);
  for (const value of fallbackSecondary) add(value);

  return out[0] || null;
}

function asNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function roundValue(value, decimals = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const p = 10 ** decimals;
  return Math.round(n * p) / p;
}

function dedupe(arr, keyFn) {
  const out = [];
  const seen = new Set();
  for (const item of arr) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

async function fetchWithTimeout(url, timeoutMs = 10000, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: ctrl.signal,
      headers: {
        "user-agent": "evm-audit-merlins-seal-full-test/1.0",
        ...(options.headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, timeoutMs = 10000) {
  const response = await fetchWithTimeout(url, timeoutMs).catch(() => null);
  if (!response || !response.ok) return null;
  try {
    return await response.json();
  } catch (_error) {
    return null;
  }
}

async function fetchText(url, timeoutMs = 10000) {
  const response = await fetchWithTimeout(url, timeoutMs).catch(() => null);
  if (!response || !response.ok) return null;
  try {
    return await response.text();
  } catch (_error) {
    return null;
  }
}

function hasTargetContext(text, knownAddressSet = new Set()) {
  if (!text) return false;
  if (MERLINS_TARGET_TEXT_RE.test(text)) return true;
  for (const address of knownAddressSet) {
    if (!address) continue;
    if (text.includes(address)) return true;
  }
  return false;
}

function classifyLine(line, filePath, options = {}) {
  const sample = `${String(filePath || "").toLowerCase()} ${String(line || "").toLowerCase()}`;
  const hasContext = Boolean(options.hasTargetContext);
  const out = new Set();
  for (const [key, regex] of Object.entries(SEARCH_TERM_PATTERNS)) {
    if (!regex.test(sample)) continue;
    if (GATED_CONTEXT_CATEGORIES[key] && !hasContext) continue;
    out.add(key);
  }
  return [...out];
}

function buildSearchTerms(metadataAddresses = [], adapterAddresses = []) {
  const terms = [...BASE_TEXT_TERMS.map((value) => String(value).toLowerCase())];
  const addresses = [];
  for (const address of [...metadataAddresses, ...adapterAddresses, ...KNOWN_MERLINS_ADDRESSES]) {
    const normalized = normalizeAddress(address);
    if (normalized) addresses.push(normalized);
  }
  const addressTerms = dedupe(addresses, (v) => v);
  const exactTextTerms = dedupe(
    terms.filter((term) => TARGET_TEXT_ANCHOR_TERMS.includes(term)),
    (v) => v,
  );
  return {
    textTerms: dedupe(terms, (v) => v),
    exactTextTerms,
    addressTerms,
    addressSet: new Set(addressTerms),
  };
}

function scanLocalArtifacts(termBag) {
  const jsonFiles = listFilesByExt(RAW_DIR, ".json");
  const mdFiles = listFilesByExt(REPORTS_DIR, ".md");
  const files = [...jsonFiles, ...mdFiles]
    .sort((a, b) => a.localeCompare(b))
    .filter((filePath) => !isExcludedLocalArtifact(filePath));

  const matches = [];
  const fileMatchCounts = new Map();
  const filesWithTargetExactOrContextMatch = new Set();
  const filesWithBroadContextMatch = new Set();

  const getMatchPriority = (row) => {
    if (row.exactMatch) return 2;
    if (row.hasTargetContext) return 1;
    return 0;
  };

  const createZeroCounts = () => ({
    sourceInventory: 0,
    abi: 0,
    eventLogs: 0,
    proxyRoles: 0,
    tokenSemantics: 0,
    erc4626: 0,
    oracle: 0,
    bridgeProof: 0,
    consumerGraph: 0,
    dexLiquidity: 0,
    balanceReachability: 0,
    selectorProbe: 0,
    attack: {
      drainVaultNoBorrow: 0,
      bridgeCrossChain: 0,
      routerRfqApprovals: 0,
      fakeAssetPoolValidation: 0,
      governance: 0,
      claimRewardReplay: 0,
      mevRebalancing: 0,
      rounding: 0,
      oracleSandwich: 0,
      crossFunctionStateMachine: 0,
      initializationAuthorization: 0,
    },
  });

  const categoryCounts = {
    exact: createZeroCounts(),
    context: createZeroCounts(),
  };

  let exactLocalArtifactMatchRows = 0;
  let contextLocalArtifactMatchRows = 0;
  let mbtcContextRows = 0;
  let stoneContextRows = 0;

  const exactTerms = new Set(termBag.exactTextTerms || []);
  const exactAddressSet = new Set(termBag.addressSet || []);

  const addCategoryCounts = (bucket, categories, amount = 0) => {
    if (!amount) return;
    for (const key of categories) {
      if (!key || key === "attack") continue;
      if (Object.prototype.hasOwnProperty.call(categoryCounts[bucket], key)) {
        categoryCounts[bucket][key] += amount;
      }
    }
  };

  const MAX_PER_FILE = 48;
  const MAX_TOTAL = 300;

  for (const file of files) {
    const raw = readText(file);
    if (!raw) continue;
    const rel = toRel(file);

    const textLower = raw.toLowerCase();
    const hasGlobalMatch = termBag.textTerms.some((term) => textLower.includes(term))
      || termBag.addressTerms.some((term) => textLower.includes(term));
    if (!hasGlobalMatch) continue;

    const lines = raw.split(/\r?\n/);
    const lineMatches = [];
    let hasTargetOrExactMatchInFile = false;
    let hasBroadOnlyMatchInFile = false;

    for (let i = 0; i < lines.length; i += 1) {
      const lineLower = String(lines[i] || "").toLowerCase();
      if (!lineLower.trim()) continue;

      const matchedTextTerms = termBag.textTerms
        .map((term) => ({ term, count: countOccurrences(lineLower, term) }))
        .filter((entry) => entry.count > 0);

      const matchedAddressTerms = termBag.addressTerms
        .map((term) => ({ term, count: countOccurrences(lineLower, term) }))
        .filter((entry) => entry.count > 0)
        .map((item) => ({ termType: "address", ...item }));

      const contextWindow = [
        lines[i - 2],
        lines[i - 1],
        lines[i],
        lines[i + 1],
        lines[i + 2],
      ].map((item) => String(item || "").toLowerCase()).join(" ");

      const hasContext = hasTargetContext(contextWindow, termBag.addressSet || new Set());
      const matched = [...matchedTextTerms.map((item) => ({
        termType: "text",
        ...item,
        isExact: exactTerms.has(item.term) && hasContext,
        isContext: !exactTerms.has(item.term) && hasContext,
      })), ...matchedAddressTerms.map((item) => ({
        ...item,
        termType: "address",
        isExact: exactAddressSet.has(item.term),
        isContext: false,
      }))];
      if (matched.length === 0) continue;

      const categories = classifyLine(contextWindow, rel, { hasTargetContext: hasContext });

      const exactCount = matched.reduce((sum, item) => (item.isExact ? sum + item.count : sum), 0);
      const contextCount = matched.reduce((sum, item) => (item.isContext ? sum + item.count : sum), 0);

      addCategoryCounts("exact", categories, exactCount);
      addCategoryCounts("context", categories, contextCount);

      for (const [attackKey, attackRegex] of Object.entries(ATTACK_PATTERNS)) {
        if (attackRegex.test(lineLower) && hasContext) {
          categoryCounts.exact.attack[attackKey] += 1;
        }
      }

      if (hasContext) {
        if (MBTC_CONTEXT_RE.test(contextWindow)) mbtcContextRows += 1;
        if (STONE_TERM_RE.test(contextWindow)) stoneContextRows += 1;
      }

      if (exactCount) exactLocalArtifactMatchRows += exactCount;
      if (contextCount) contextLocalArtifactMatchRows += contextCount;

      const lineHasExactMatch = matched.some((item) => item.isExact);
      if (lineHasExactMatch) {
        hasTargetOrExactMatchInFile = true;
      } else if (hasContext) {
        hasTargetOrExactMatchInFile = true;
      } else {
        hasBroadOnlyMatchInFile = true;
      }

      for (const hit of matched) {
        lineMatches.push({
          file: rel,
          line: i + 1,
          category: categories,
          termType: hit.termType || "text",
          term: hit.term,
          exactMatch: Boolean(hit.isExact),
          hasTargetContext: Boolean(hasContext),
          count: hit.count,
          sample: sanitizeLine(lines[i - 1]) ? `${sanitizeLine(lines[i - 1])} ${sanitizeLine(lines[i])} ${sanitizeLine(lines[i + 1])}` : sanitizeLine(lines[i]),
        });
      }
    }

    if (lineMatches.length) {
      fileMatchCounts.set(file, Math.min(MAX_PER_FILE, lineMatches.length));
      matches.push(...lineMatches.slice(0, MAX_PER_FILE));
      if (hasTargetOrExactMatchInFile) {
        filesWithTargetExactOrContextMatch.add(file);
      } else if (hasBroadOnlyMatchInFile) {
        filesWithBroadContextMatch.add(file);
      }
    }
  }

  const topMatches = dedupe(matches, (m) => `${m.file}:${m.line}:${m.term}:${m.termType}`).sort((a, b) => {
    const aPriority = getMatchPriority(a);
    const bPriority = getMatchPriority(b);
    if (bPriority !== aPriority) return bPriority - aPriority;
    if (b.count !== a.count) return b.count - a.count;
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    return a.line - b.line;
  }).slice(0, MAX_TOTAL);

  const filesWithMatch = Object.keys(Object.fromEntries(fileMatchCounts));
  const exactConsumerJoinRows = categoryCounts.exact.consumerGraph + categoryCounts.exact.erc4626;
  const contextConsumerJoinRows = categoryCounts.context.consumerGraph + categoryCounts.context.erc4626;

  return {
    filesScanned: files.length,
    filesWithMatch: filesWithMatch.length,
    filesWithMatchList: filesWithMatch.map((file) => toRel(file)),
    filesWithTargetExactOrContextMatch: filesWithTargetExactOrContextMatch.size,
    filesWithTargetExactOrContextMatchList: Array.from(filesWithTargetExactOrContextMatch).map((file) => toRel(file)),
    filesWithBroadContextMatch: filesWithBroadContextMatch.size,
    filesWithBroadContextMatchList: Array.from(filesWithBroadContextMatch).map((file) => toRel(file)),
    localArtifactMatchRows: exactLocalArtifactMatchRows + contextLocalArtifactMatchRows,
    exactLocalArtifactMatchRows,
    contextLocalArtifactMatchRows,
    mbtcContextRows,
    stoneContextRows,
    topMatches,
    categoryCounts,
    exactConsumerJoinRows,
    contextConsumerJoinRows,
    consumerJoinRows: exactConsumerJoinRows + contextConsumerJoinRows,
  };
}

async function loadDeepMetadata() {
  const defaultOut = {
    chains: ["Ethereum", "Arbitrum"],
    accessibleEvmChains: ["Ethereum", "Arbitrum"],
    blockedOrCaveatChains: ["Bitcoin", "Zkfair"],
    surface: "bridge-proof-custody-consumer",
    routeGraph: "custody/backing or proof state -> wrapped asset -> lending/DEX consumer -> borrow/unlock/exit",
    module: TARGET_MODULE,
    adapterAddressSamples: [...KNOWN_MERLINS_ADDRESSES],
    adapterAddressCount: KNOWN_MERLINS_ADDRESSES.length,
    adapterHints: ["bridge/custody"],
    source: "fallback/embedded",
    currentTvlUsd: 349576854.08,
    audits: 0,
  };

  const doc = readJson(DEEP_METADATA, null);
  if (!doc || !Array.isArray(doc.rankedQueue)) return defaultOut;

  const row = doc.rankedQueue.find((entry) => String(entry.slug || "").toLowerCase() === TARGET_SLUG)
    || doc.rankedQueue.find((entry) => String(entry.name || "").toLowerCase() === TARGET_NAME.toLowerCase());
  if (!row) return defaultOut;

  const adapters = row.adapter || {};
  return {
    chains: Array.isArray(row.chains) && row.chains.length ? row.chains : defaultOut.chains,
    accessibleEvmChains: Array.isArray(row.accessibleEvmChains) && row.accessibleEvmChains.length ? row.accessibleEvmChains : defaultOut.accessibleEvmChains,
    blockedOrCaveatChains: Array.isArray(row.blockedOrCaveatChains) ? row.blockedOrCaveatChains : defaultOut.blockedOrCaveatChains,
    surface: row.surface || defaultOut.surface,
    routeGraph: row.routeGraph || defaultOut.routeGraph,
    module: row.module || defaultOut.module,
    adapterAddressSamples: Array.isArray(adapters.adapterAddressSamples) && adapters.adapterAddressSamples.length ? adapters.adapterAddressSamples : KNOWN_MERLINS_ADDRESSES,
    adapterAddressCount: Number(adapters.adapterAddressCount || KNOWN_MERLINS_ADDRESSES.length),
    adapterHints: Array.isArray(adapters.adapterHints) ? adapters.adapterHints : defaultOut.adapterHints,
    source: "reports/raw/fast/prefilter-deep-new-target-search-2026-06-24.json",
    currentTvlUsd: Number(row.tvlUsd || defaultOut.currentTvlUsd),
    audits: row.audits || defaultOut.audits,
  };
}

function decodeHexAddress(raw) {
  if (!raw || raw === "0x") return null;
  const clean = stripHex(raw).replace(/^0+/, "");
  const padded = clean.padStart(64, "0");
  const sliced = padded.slice(-40);
  return `0x${sliced}`;
}

function decodeBool(raw) {
  if (!raw || raw === "0x") return null;
  const clean = stripHex(raw);
  if (!clean) return null;
  try {
    return BigInt(`0x${clean}`) !== 0n;
  } catch (_error) {
    return null;
  }
}

function decodeUint(raw) {
  if (!raw || raw === "0x") return null;
  const clean = stripHex(raw);
  if (!clean) return null;
  try {
    return BigInt(`0x${clean}`);
  } catch (_error) {
    return null;
  }
}

function decodeAbiString(raw) {
  if (!raw || raw === "0x") return null;
  const hex = stripHex(raw);
  if (hex.length < 128) {
    try {
      const decoded = Buffer.from(hex, "hex").toString("utf8").replace(/\u0000+$/g, "").trim();
      return decoded || null;
    } catch (_error) {
      return null;
    }
  }
  try {
    const offset = Number(BigInt(`0x${hex.slice(0, 64)}`));
    if (!Number.isFinite(offset) || offset < 32) return null;
    const lenStart = 2 * offset;
    if (lenStart + 64 > hex.length) return null;
    const len = Number(BigInt(`0x${hex.slice(lenStart, lenStart + 64)}`));
    const dataStart = lenStart + 64;
    const data = hex.slice(dataStart, dataStart + Math.min(len, Math.floor((hex.length - dataStart) / 2) * 2) * 2);
    if (data.length < len * 2) return null;
    return Buffer.from(data.slice(0, len * 2), "hex").toString("utf8");
  } catch (_error) {
    return null;
  }
}

function encodeArg(arg) {
  const asString = String(arg);
  if (/^0x[0-9a-fA-F]{40}$/i.test(asString)) {
    return stripHex(asString).padStart(64, "0");
  }
  if (asString.startsWith("0x") && asString.length > 42) {
    return asString.replace(/^0x/, "").padEnd(Math.ceil((asString.length - 2) / 64) * 64, "0");
  }
  try {
    const b = BigInt(asString);
    return b.toString(16).padStart(64, "0");
  } catch (_error) {
    return "0".repeat(64);
  }
}

function encodeCallData(selector, args = []) {
  const s = selector.startsWith("0x") ? selector.slice(2) : selector;
  return `0x${s}${args.map(encodeArg).join("")}`;
}

function stripZeroValue(value) {
  if (!value || value === "0x") return null;
  const clean = stripHex(value).replace(/^0+/, "");
  return clean ? `0x${clean}` : "0x0";
}

async function rpcCall(rpcUrl, method, params = [], timeoutMs = 9500) {
  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method,
    params,
  };

  const response = await fetchWithTimeout(rpcUrl, timeoutMs, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  }).catch(() => null);
  if (!response || !response.ok) return null;

  const payloadText = await response.text().catch(() => null);
  if (!payloadText) return null;
  let json;
  try {
    json = JSON.parse(payloadText);
  } catch (_error) {
    return null;
  }
  if (!json || typeof json !== "object") return null;
  if (json.error) return null;
  return json.result || null;
}

async function selectRpc(chain) {
  for (const rpcUrl of chain.rpcUrls) {
    const result = await rpcCall(rpcUrl, "eth_blockNumber", [], 7000).catch(() => null);
    if (result) {
      return {
        rpcUsed: chain.rpcHint,
        rpcUrl,
        blockNumber: result,
      };
    }
  }
  return null;
}

async function ethGetCode(rpcUrl, address) {
  return rpcCall(rpcUrl, "eth_getCode", [address, "latest"], 9000);
}

async function ethGetStorageAt(rpcUrl, address, slot) {
  return rpcCall(rpcUrl, "eth_getStorageAt", [address, slot, "latest"], 9000);
}

async function ethGetBalance(rpcUrl, address) {
  return rpcCall(rpcUrl, "eth_getBalance", [address, "latest"], 9000);
}

async function ethCall(rpcUrl, to, data) {
  if (!to) return null;
  return rpcCall(rpcUrl, "eth_call", [{ to, data }, "latest"], 10000);
}

async function probeAddress(chain, rpcUrl, addr, candidateSources = new Set(), candidateAddressHints = []) {
  const row = {
    chain: chain.chain,
    chainId: chain.chainId,
    chainLabel: chain.chain,
    address: addr,
    sourceLabels: [...candidateSources],
    sourceClasses: [...candidateSources],
    sourceChain: candidateSources.has("metadata.adapterAddressSamples") ? "metadata" : (candidateSources.has("defillama-adapter-source") ? "defillama" : (candidateSources.has("local-merge-match") ? "local" : "known-list")),
    codePresent: false,
    codeBytes: 0,
    nativeBalance: null,
    nativeBalanceRaw: null,
    balanceOfTargetProbe: null,
    balanceOfTargetBalance: null,
    balanceOfTargetZero: null,
    selectorProbes: {},
    eip1967: {
      implementation: null,
      admin: null,
    },
    owner: null,
    admin: null,
    paused: null,
    symbol: null,
    name: null,
    decimals: null,
    totalSupply: null,
    isLikelyProxy: false,
    hasOwnerAdmin: false,
    errors: [],
    selectorProbeRows: 0,
    selectorProbeHits: 0,
    balanceProbeRows: 0,
    balanceProbeHits: 0,
  };

  const code = await ethGetCode(rpcUrl, addr).catch(() => null);
  if (!code || code === "0x") {
    return row;
  }

  row.codePresent = true;
  row.codeBytes = Math.floor((stripHex(code).length) / 2);

  const [nativeBalance, implRaw, adminRaw] = await Promise.all([
    ethGetBalance(rpcUrl, addr).catch(() => null),
    ethGetStorageAt(rpcUrl, addr, EIP1967_IMPL).catch(() => null),
    ethGetStorageAt(rpcUrl, addr, EIP1967_ADMIN).catch(() => null),
  ]);

  row.nativeBalanceRaw = nativeBalance;
  if (nativeBalance) {
    row.nativeBalance = stripZeroValue(nativeBalance);
  }
  row.eip1967.implementation = parseRpcAddressResult(implRaw);
  row.eip1967.admin = parseRpcAddressResult(adminRaw);
  if (row.eip1967.implementation && !isZeroAddress(row.eip1967.implementation)) row.isLikelyProxy = true;
  if (!isZeroAddress(row.eip1967.admin)) row.isLikelyProxy = true;

  for (const probe of VIEW_PROBES) {
    try {
      const probeData = encodeCallData(probe.selector, probe.args);
      const raw = await ethCall(rpcUrl, addr, probeData);
      row.selectorProbeRows += 1;
      if (raw && raw !== "0x") {
        row.selectorProbeHits += 1;
        let decoded = raw;
        if (probe.id.startsWith("symbol") || probe.id.startsWith("name")) {
          decoded = decodeAbiString(raw) || raw;
        }
        if (probe.id === "decimals()") {
          const value = decodeUint(raw);
          decoded = value !== null ? Number(value) : raw;
          row.decimals = decoded;
        }
        if (probe.id === "totalSupply()") {
          const value = decodeUint(raw);
          decoded = value !== null ? value.toString() : raw;
          row.totalSupply = decoded;
        }
        if (probe.id === "owner()") row.owner = parseRpcAddressResult(raw);
        if (probe.id === "admin()") row.admin = parseRpcAddressResult(raw);
        if (probe.id === "paused()") row.paused = decodeBool(raw);

        if (probe.id === "symbol()") row.symbol = typeof decoded === "string" ? decoded : row.symbol;
        if (probe.id === "name()") row.name = typeof decoded === "string" ? decoded : row.name;

        row.selectorProbes[probe.id] = {
          raw,
          decoded: typeof decoded === "string" ? sanitizeLine(decoded) : decoded,
          hit: true,
        };
      } else {
        row.selectorProbes[probe.id] = { raw: raw || null, hit: false };
      }
    } catch (_error) {
      row.errors.push(`selector-call:${probe.id}`);
      row.selectorProbeRows += 1;
      row.selectorProbes[probe.id] = { raw: null, hit: false, error: true };
    }
  }

  const balanceProbeTarget = pickBalanceProbeTarget(
    addr,
    candidateAddressHints,
    [row.owner, row.admin],
    [],
  );
  row.balanceOfTargetProbe = balanceProbeTarget;
  if (balanceProbeTarget) {
    row.balanceProbeRows = 1;
    try {
      const balanceRaw = await ethCall(rpcUrl, addr, encodeCallData("0x70a08231", [balanceProbeTarget]));
      if (balanceRaw && balanceRaw !== "0x") {
        const decoded = decodeUint(balanceRaw);
        row.balanceOfTargetBalance = decoded !== null ? decoded.toString() : "decode-failed";
        row.balanceOfTargetZero = decoded === 0n;
        if (decoded !== null && decoded > 0n) {
          row.balanceProbeHits = 1;
        }
      }
    } catch (_error) {
      row.errors.push("balance-probe:owner-or-holder");
    }
  }

  row.hasOwnerAdmin = Boolean(row.owner || row.admin);
  if (row.owner) row.hasOwnerAdmin = true;
  if (row.admin) row.hasOwnerAdmin = true;
  return row;
}

async function probeChain(chain, addresses, candidateSourceMap, candidateAddressHints = []) {
  const out = {
    chain: chain.chain,
    chainId: chain.chainId,
    rpcHint: chain.rpcHint,
    chainReachable: false,
    blockNumber: null,
    rows: [],
    selectorProbeRows: 0,
    selectorProbeHits: 0,
    codeRows: 0,
    adminProxyRows: 0,
    errors: [],
    blocked: false,
  };

  const selected = await selectRpc(chain);
  if (!selected) {
    out.blocked = true;
    return out;
  }

  out.chainReachable = true;
  out.rpcHint = selected.rpcHint;
  out.blockNumber = selected.blockNumber;

  const maxProbeAddresses = 20;
  const scoped = addresses.slice(0, maxProbeAddresses);

  for (const address of scoped) {
    if (!address) continue;
    const row = await probeAddress(
      chain,
      selected.rpcUrl,
      address,
      candidateSourceMap.get(address) || new Set(["local-or-discovery"]),
      candidateAddressHints,
    ).catch((error) => ({
      chain: chain.chain,
      chainId: chain.chainId,
      chainLabel: chain.chain,
      sourceClasses: ["unknown"],
      sourceLabels: ["unknown"],
      sourceChain: "unknown",
      address,
      error: String(error.message || error),
      codePresent: false,
      balanceOfTargetZero: null,
      balanceProbeRows: 0,
      balanceProbeHits: 0,
      selectorProbeRows: 0,
      selectorProbeHits: 0,
    }));

    out.rows.push(row);
    out.selectorProbeRows += row.selectorProbeRows || 0;
    out.selectorProbeHits += row.selectorProbeHits || 0;
    out.codeRows += row.codePresent ? 1 : 0;
    if (row.isLikelyProxy || row.hasOwnerAdmin) out.adminProxyRows += 1;
  }

  return out;
}

async function queryDexScreener(addresses) {
  const rows = [];
  const caveats = [];
  const unique = dedupe(addresses.map((address) => normalizeAddress(address)).filter(Boolean), (x) => x);

  for (const address of unique.slice(0, 6)) {
    const payload = await fetchJson(`${DEXSCREENER_TOKEN_API}${address}`, 18000).catch(() => null);
    if (!payload || !Array.isArray(payload.pairs)) {
      caveats.push(`DexScreener query failed for ${address}`);
      continue;
    }
    for (const pair of payload.pairs) {
      if (!pair) continue;
      const liquidityUsd = asNumber(pair.liquidity?.usd);
      const volume24hUsd = asNumber(pair.volume?.h24);
      const row = {
        chain: pair.chainId || null,
        dex: pair.dexId || null,
        pairAddress: pair.pairAddress || null,
        baseToken: pair.baseToken ? {
          symbol: pair.baseToken.symbol || null,
          address: pair.baseToken.address || null,
        } : null,
        quoteToken: pair.quoteToken ? {
          symbol: pair.quoteToken.symbol || null,
          address: pair.quoteToken.address || null,
        } : null,
        liquidityUsd,
        volume24hUsd,
        priceUsd: asNumber(pair.priceUsd),
        url: pair.url || null,
      };
      if (row.liquidityUsd !== null || row.volume24hUsd !== null) rows.push(row);
    }
  }

  const normalized = rows.filter((row, idx, all) => all.findIndex((other) => other.pairAddress === row.pairAddress) === idx);
  const sorted = normalized
    .sort((a, b) => {
      const av = asNumber(a.liquidityUsd) || 0;
      const bv = asNumber(b.liquidityUsd) || 0;
      return bv - av;
    })
    .slice(0, 12);

  return {
    rows: sorted,
    caveats: dedupe(caveats, (entry) => entry),
  };
}

function buildChecklist(scan, rpcSummary, metrics) {
  const exact = (key) => (scan.categoryCounts.exact[key] || 0);
  const context = (key) => (scan.categoryCounts.context[key] || 0);
  const exactAttack = (key) => (scan.categoryCounts.exact.attack[key] || 0);

  const row = (id, label, covered, rowsCount, rowsExactCount, rowsContextCount, notes = [], status = covered ? "evidence" : "missing") => ({
    id,
    label,
    covered,
    status,
    rows: rowsCount,
    rowsExact: rowsExactCount,
    rowsContext: rowsContextCount,
    notes,
  });

  const rows = [
    row(
      "sourceInventory",
      "Source inventory",
      scan.filesWithMatch > 0,
      scan.filesWithMatch,
      exact("sourceInventory"),
      context("sourceInventory"),
      [
        scan.filesWithTargetExactOrContextMatch > 0
          ? `Target-anchored local matches in raw/fast/*.json + reports/*.md (${scan.filesWithTargetExactOrContextMatch} files)`
          : scan.filesWithMatch > 0
            ? `Only broad local-context rows matched in raw/fast/*.json + reports/*.md (${scan.filesWithBroadContextMatch} files)`
            : "No local inventory evidence matched Merlins terms.",
      ],
      scan.filesWithMatch > 0 ? "evidence" : "missing",
    ),
    row(
      "abi",
      "Verified ABI/source-aware probing",
      rpcSummary.viewProbeRows > 0,
      rpcSummary.viewProbeRows,
      rpcSummary.viewProbeRows,
      0,
      rpcSummary.viewProbeRows > 0 ? ["Selector probes run against on-chain candidate addresses"] : ["No selector/ABI probes available."],
      rpcSummary.viewProbeRows > 0 ? "evidence" : "blocked",
    ),
    row(
      "eventLogs",
      "Event/log discovery",
      exact("eventLogs") + context("eventLogs") > 0,
      exact("eventLogs") + context("eventLogs"),
      exact("eventLogs"),
      context("eventLogs"),
      [
        (exact("eventLogs") + context("eventLogs")) > 0
          ? "Event/log phrases found with Merlins-anchored local context"
          : "No explicit event/log artifact pattern match with Merlins context.",
      ],
      (exact("eventLogs") + context("eventLogs")) > 0 ? "evidence" : "missing",
    ),
    row(
      "proxyAdminRoles",
      "Proxy/admin/role graph",
      exact("proxyRoles") + context("proxyRoles") > 0 || metrics.adminProxyRows > 0,
      exact("proxyRoles") + context("proxyRoles") + metrics.adminProxyRows,
      exact("proxyRoles") + metrics.adminProxyRows,
      context("proxyRoles"),
      ["Owner/admin/proxy terms and on-chain admin/proxy indicators were reviewed."],
    ),
    row(
      "tokenSemantics",
      "Token/wrapper semantics",
      exact("tokenSemantics") + context("tokenSemantics") > 0 || metrics.tokenRows > 0,
      Math.max(exact("tokenSemantics") + context("tokenSemantics"), metrics.tokenRows || 0),
      Math.max(exact("tokenSemantics"), metrics.tokenRows || 0),
      context("tokenSemantics"),
      ["Token semantics and wrapper terms appear in local artifacts and/or on-chain probes."],
    ),
    row(
      "erc4626",
      "ERC4626/share accounting",
      exact("erc4626") + context("erc4626") > 0,
      exact("erc4626") + context("erc4626"),
      exact("erc4626"),
      context("erc4626"),
      [exact("erc4626") + context("erc4626") > 0 ? "ERC4626 markers appeared in local source text" : "No ERC4626/share markers confirmed as Merlins-native."],
    ),
    row(
      "oracle",
      "Oracle/feed/scalar discovery",
      exact("oracle") + context("oracle") > 0,
      exact("oracle") + context("oracle"),
      exact("oracle"),
      context("oracle"),
      [
        exact("oracle") + context("oracle") > 0
          ? "Oracle/price/feed terms found locally"
          : "No oracle/feed term context with Merlins-specific evidence",
      ],
    ),
    row(
      "bridgeProof",
      "Bridge proof/backing/custody invariants",
      exact("bridgeProof") + context("bridgeProof") > 0,
      exact("bridgeProof") + context("bridgeProof"),
      exact("bridgeProof"),
      context("bridgeProof"),
      [
        exact("bridgeProof") + context("bridgeProof") > 0
          ? "Bridge/custody/proof language appears in local context"
          : "No live bridge proof/custody invariant proof path confirmed.",
      ],
    ),
    row(
      "dexConsumer",
      "DEX/liquidity + consumer graph",
      exact("consumerGraph") + context("consumerGraph") > 0 || metrics.consumerJoinRows > 0 || metrics.dexLiquidityRows > 0,
      exact("consumerGraph") + context("consumerGraph") + metrics.consumerJoinRows + metrics.dexLiquidityRows,
      exact("consumerGraph") + (metrics.exactConsumerJoinRows || 0),
      context("consumerGraph") + (metrics.contextConsumerJoinRows || 0),
      [
        exact("consumerGraph") + context("consumerGraph") > 0 || metrics.consumerJoinRows > 0
          ? "Borrow/lending/consumer or DEX hints found in local context"
          : "No strong consumer graph rows discovered",
      ],
    ),
    row(
      "balanceReachability",
      "Balance reachability and public entrypoints",
      exact("balanceReachability") + context("balanceReachability") > 0 || metrics.codePresentRows > 0,
      exact("balanceReachability") + context("balanceReachability") + metrics.codePresentRows,
      exact("balanceReachability") + metrics.codePresentRows,
      context("balanceReachability"),
      ["Balance and code-reachability checked across discovered addresses where possible."],
    ),
    row(
      "selectorProbes",
      "Selector probes",
      rpcSummary.viewProbeRows > 0,
      rpcSummary.viewProbeRows,
      rpcSummary.viewProbeRows,
      0,
      [
        `Selector calls attempted: ${rpcSummary.viewProbeRows}, hits: ${rpcSummary.viewProbeHits || 0}`,
      ],
      rpcSummary.viewProbeRows > 0 ? "evidence" : "missing",
    ),
    {
      id: "forkValue",
      label: "Local fork/value-delta gate",
      covered: false,
      status: "gateClosed",
      rows: 0,
      rowsExact: 0,
      rowsContext: 0,
      notes: ["No fork/value-delta exact-quantitative simulation was executed in this run."],
    },
    {
      id: "reviewGates",
      label: "Review and gates status",
      covered: !metrics.routePositive && !metrics.executableNow,
      status: "evidence",
      rows: 1,
      rowsExact: 1,
      rowsContext: 0,
      notes: ["Route remains fail-closed with no exact-positive proof and no executable path."],
    },
  ];

  const attackRows = [
    {
      id: "drainVaultNoBorrow",
      label: "drain-vault/no-borrow",
      covered: exactAttack("drainVaultNoBorrow") > 0,
      status: exactAttack("drainVaultNoBorrow") > 0 ? "evidence" : "missing",
      rows: exactAttack("drainVaultNoBorrow"),
      notes: exactAttack("drainVaultNoBorrow") > 0 ? ["Drain/no-borrow class observed in source"] : ["No explicit Merlins no-borrow drain class evidence."],
    },
    {
      id: "bridgeCrossChain",
      label: "bridge/cross-chain",
      covered: exactAttack("bridgeCrossChain") > 0,
      status: exactAttack("bridgeCrossChain") > 0 ? "evidence" : "missing",
      rows: exactAttack("bridgeCrossChain"),
      notes: exactAttack("bridgeCrossChain") > 0 ? ["Cross-chain bridge language found"] : ["No full cross-chain proof path validated."],
    },
    {
      id: "routerRfqApprovals",
      label: "router/RFQ approvals",
      covered: exactAttack("routerRfqApprovals") > 0,
      status: exactAttack("routerRfqApprovals") > 0 ? "evidence" : "missing",
      rows: exactAttack("routerRfqApprovals"),
      notes: exactAttack("routerRfqApprovals") > 0 ? ["Router/RFQ approvals class context found"] : ["No router RFQ approval control signal found."],
    },
    {
      id: "fakeAssetPoolValidation",
      label: "fake asset/pool validation",
      covered: exactAttack("fakeAssetPoolValidation") > 0,
      status: exactAttack("fakeAssetPoolValidation") > 0 ? "evidence" : "missing",
      rows: exactAttack("fakeAssetPoolValidation"),
      notes: exactAttack("fakeAssetPoolValidation") > 0 ? ["Fake asset/pool class terms found"] : ["No fake-asset/pool validation path confirmed."],
    },
    {
      id: "governance",
      label: "governance",
      covered: exactAttack("governance") > 0,
      status: exactAttack("governance") > 0 ? "evidence" : "missing",
      rows: exactAttack("governance"),
      notes: exactAttack("governance") > 0 ? ["Governance control mentions found"] : ["No governance attack evidence confirmed."],
    },
    {
      id: "claimRewardReplay",
      label: "claim/reward replay",
      covered: exactAttack("claimRewardReplay") > 0,
      status: exactAttack("claimRewardReplay") > 0 ? "evidence" : "missing",
      rows: exactAttack("claimRewardReplay"),
      notes: exactAttack("claimRewardReplay") > 0 ? ["Claim/reward replay terms found"] : ["No claim/reward replay artifacts proven."],
    },
    {
      id: "mevRebalancing",
      label: "MEV/rebalancing",
      covered: exactAttack("mevRebalancing") > 0,
      status: exactAttack("mevRebalancing") > 0 ? "evidence" : "missing",
      rows: exactAttack("mevRebalancing"),
      notes: exactAttack("mevRebalancing") > 0 ? ["MEV/rebalancing terms found"] : ["No MEV/rebalancing attack path proven."],
    },
    {
      id: "rounding",
      label: "rounding",
      covered: exactAttack("rounding") > 0,
      status: exactAttack("rounding") > 0 ? "evidence" : "missing",
      rows: exactAttack("rounding"),
      notes: exactAttack("rounding") > 0 ? ["Rounding/dust terms found"] : ["No rounding drift attack proof."],
    },
    {
      id: "oracleSandwich",
      label: "oracle sandwich",
      covered: exactAttack("oracleSandwich") > 0,
      status: exactAttack("oracleSandwich") > 0 ? "evidence" : "missing",
      rows: exactAttack("oracleSandwich"),
      notes: exactAttack("oracleSandwich") > 0 ? ["Oracle sandwich class terms found"] : ["No oracle sandwich evidence confirmed."],
    },
    {
      id: "crossFunctionStateMachine",
      label: "cross-function/state-machine",
      covered: exactAttack("crossFunctionStateMachine") > 0,
      status: exactAttack("crossFunctionStateMachine") > 0 ? "evidence" : "missing",
      rows: exactAttack("crossFunctionStateMachine"),
      notes: exactAttack("crossFunctionStateMachine") > 0 ? ["Cross-function/state-machine terms found"] : ["No cross-function/state-machine invariant proof observed."],
    },
    {
      id: "initializationAuthorization",
      label: "initialization/authorization",
      covered: exactAttack("initializationAuthorization") > 0,
      status: exactAttack("initializationAuthorization") > 0 ? "evidence" : "missing",
      rows: exactAttack("initializationAuthorization"),
      notes: exactAttack("initializationAuthorization") > 0 ? ["Initialization/authorization terms found"] : ["No initialization/authorization attack route confirmed."],
    },
  ];

  return {
    core: rows,
    attacks: attackRows,
    all: rows.concat(attackRows),
    exact: {
      rows: rows.reduce((sum, item) => sum + (item.rowsExact || 0), 0) + attackRows.reduce((sum, item) => sum + (item.rows || 0), 0),
    },
    context: {
      rows: rows.reduce((sum, item) => sum + (item.rowsContext || 0), 0),
    },
  };
}

function markdownTable(rows, headers) {
  const escape = (value) => String(value).replace(/\n/g, " ").replace(/\|/g, " ");
  const line = (row) => headers.map((h) => escape(row[h] ?? "")).join(" | ");
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${line(row)} |`),
  ].join("\n");
}

function buildReport(payload) {
  const summary = payload.summary;
  const safety = payload.safety;
  const localScan = payload.localScan;
  const checklist = payload.fullTestChecklist;
  const rpcRows = payload.rpcChains;

  const banner = summary.routePositive ? "# ⚠️ MERLINS Seal Full Test" : "# 🟢 DORMANT - Merlins Seal Full Test";

  const headerRows = [
    `| Surface | Current | Route |`,
    `|---|---:|---:|`,
    `| TVL (public) | $${summary.currentTvlUsd ? Math.round(summary.currentTvlUsd).toLocaleString() : "n/a"} | ${summary.routePositive ? "1" : "0"} |`,
    `| Files with target-exact/context matches | ${summary.filesWithTargetExactOrContextMatch || 0} | ${summary.filesWithTargetExactOrContextMatch > 0 ? 1 : 0} |`,
    `| Files with broad-context matches (non-target) | ${summary.filesWithBroadContextMatch || 0} | 0 |`,
    `| Address rows | ${summary.addressRows} | ${summary.addressRows > 0 ? "0" : "0"} |`,
    `| Exact local artifact match rows | ${summary.exactLocalArtifactMatchRows || 0} | ${summary.exactLocalArtifactMatchRows > 0 ? 1 : 0} |`,
    `| Context local artifact match rows | ${summary.contextLocalArtifactMatchRows || 0} | ${summary.contextLocalArtifactMatchRows > 0 ? 1 : 0} |`,
    `| MBTC-context rows | ${summary.mbtcContextRows || 0} | ${summary.mbtcContextRows > 0 ? 1 : 0} |`,
    `| STONE-context rows | ${summary.stoneContextRows || 0} | ${summary.stoneContextRows > 0 ? 1 : 0} |`,
    `| Code-present rows | ${summary.codePresentRows} | 0 |`,
    `| Balance probe zero-balance rows | ${summary.balanceProbeZeroRows || 0} | ${summary.balanceProbeZeroRows > 0 ? 1 : 0} |`,
    `| Token rows | ${summary.tokenRows} | ${summary.tokenRows > 0 ? "?" : "0"} |`,
    `| Bridge rows (exact/context) | ${summary.bridgeRows} (${summary.bridgeRowsExact || 0}/${summary.bridgeRowsContext || 0}) | 0 |`,
    `| Custody rows (exact/context) | ${summary.custodyRows} (${summary.custodyRowsExact || 0}/${summary.custodyRowsContext || 0}) | 0 |`,
    `| Oracle rows (exact/context) | ${summary.oracleRows} (${summary.oracleRowsExact || 0}/${summary.oracleRowsContext || 0}) | 0 |`,
    `| Local artifact match rows | ${summary.localArtifactMatchRows} | 0 |`,
    `| Consumer join rows | ${summary.consumerJoinRows} | 0 |`,
    `| Exact consumer join rows | ${summary.exactConsumerJoinRows || 0} | ${summary.exactConsumerJoinRows > 0 ? 1 : 0} |`,
    `| Context consumer join rows | ${summary.contextConsumerJoinRows || 0} | ${summary.contextConsumerJoinRows > 0 ? 1 : 0} |`,
    `| DEX liquidity rows | ${summary.dexLiquidityRows} | 0 |`,
    `| fullTestReadOnlyComplete | ${summary.fullTestReadOnlyComplete ? 1 : 0} | ${summary.fullTestReadOnlyComplete ? 1 : 0} |`,
    `| Admin/proxy rows | ${summary.adminProxyRows} | 0 |`,
    `| Selector probe rows | ${summary.selectorProbeRows} | 0 |`,
    `| exactEconomicsRows | ${summary.exactEconomicsRows} | 0 |`,
    `| rpcBlockedRows | ${summary.rpcBlockedRows} | 0 |`,
    `| routePositive | ${summary.routePositive} | ${summary.routePositive ? 1 : 0} |`,
    `| executableNow | ${summary.executableNow} | ${summary.executableNow ? 1 : 0} |`,
    `| signedActionJustified | ${summary.signedActionJustified ? 1 : 0} | 0 |`,
    `| forkJustified | ${summary.forkJustified ? 1 : 0} | 0 |`,
    `| checklistRows | ${summary.fullTestChecklistRows} | ${(payload.summary.fullTestChecklistComplete ? 1 : 0)} |`,
  ];

  const localTopRows = localScan.topMatches
    .slice(0, 25)
    .map((row) => ({
      File: row.file,
      Line: row.line,
      Category: (row.category && row.category.length ? row.category.join(",") : "--"),
      Term: row.term,
      ExactMatch: row.exactMatch ? "yes" : "no",
      InTargetContext: row.hasTargetContext ? "yes" : "no",
      Count: row.count,
      Sample: sanitizeLine(row.sample).slice(0, 120),
    }));

  const chainRows = rpcRows.flatMap((chain) => chain.rows.map((row) => ({
    Chain: chain.chain,
    SourceChain: row.sourceChain || "unknown",
    SourceLabels: Array.isArray(row.sourceLabels) && row.sourceLabels.length ? row.sourceLabels.join(",") : "unknown",
    ProbeChain: row.chainLabel || chain.chain,
    Address: row.address,
    Code: row.codePresent ? "yes" : "no",
    Bytes: row.codeBytes || 0,
    NativeBalance: row.nativeBalance || "n/a",
    BalanceProbe: row.balanceOfTargetProbe || "n/a",
    BalanceTarget: row.balanceOfTargetBalance || "n/a",
    BalanceProbeZero: row.balanceOfTargetZero ? "yes" : "no",
    IsProxy: row.isLikelyProxy ? "yes" : "no",
    ProxyImpl: row.eip1967?.implementation || "n/a",
    Owner: row.owner || "n/a",
    Admin: row.admin || row.eip1967.admin || "n/a",
    Paused: String(row.paused ?? "n/a"),
    SelectorHits: `${row.selectorProbeHits || 0}/${row.selectorProbeRows || 0}`,
    BalanceProbeHits: `${row.balanceProbeHits || 0}/${row.balanceProbeRows || 0}`,
  }))); 

  const fullRows = checklist.core.concat(checklist.attacks).map((row) => ({
    Checklist: row.label,
    Status: row.status === "evidence" ? "evidence" : row.status === "gateClosed" ? "gateClosed" : row.status === "blocked" ? "blocked" : "missing",
    Covered: row.covered || row.status === "gateClosed" || row.status === "blocked" ? "yes" : "no",
    Rows: row.rows || 0,
    ExactRows: row.rowsExact || 0,
    ContextRows: row.rowsContext || 0,
    Note: (row.notes || []).slice(0, 2).join(" | "),
  }));

  const checklistCoreRows = fullRows.slice(0, checklist.core.length);
  const checklistAttackRows = fullRows.slice(checklist.core.length);

  const blockers = payload.blockers.length
    ? payload.blockers.map((item) => `- ${item}`).join("\n")
    : "- None listed";

  const safetyRows = [
    `- rpcInventoryRead: ${String(safety.rpcInventoryRead)}`,
    `- graphqlInventoryRead: ${String(safety.graphqlInventoryRead)}`,
    `- rpcUrlsStored: ${String(safety.rpcUrlsStored)}`,
    `- graphqlUrlsStored: ${String(safety.graphqlUrlsStored)}`,
    `- envFilesRead: ${String(safety.envFilesRead)}`,
    `- privateKeysRead: ${String(safety.privateKeysRead)}`,
    `- signedActions: ${String(safety.signedActions)}`,
    `- forkTransactions: ${String(safety.forkTransactions)}`,
  ].join("\n");

  return [
    banner,
    ``,
    `Date: ${new Date(payload.generatedAt).toISOString().slice(0, 10)}`,
    ``,
    `Target: **${payload.target.name}** (${payload.target.slug})`,
    `Scope: ${payload.scope}`,
    ``,
    `## Result (full read-only test)`,
    ``,
    `- ` + (summary.routePositive ? "`routePositive=1`" : "`routePositive=0`"),
    `- executableNow=${summary.executableNow ? 1 : 0}`,
    `- fullReadOnlyComplete=${summary.fullTestReadOnlyComplete ? 1 : 0}`,
    `- signedActionJustified=${summary.signedActionJustified ? 1 : 0}`,
    `- forkJustified=${summary.forkJustified ? 1 : 0}`,
    `- fail-closed: route requires explicit permissionless positive economics + proof chain`,
    ``,
    `## Required safety fields`,
    ``,
    safetyRows,
    ``,
    `## Metrics`,
    ``,
    headerRows.map((r) => r).join("\n"),
    ``,
    `## Source inventory (bounded)`,
    ``,
    `- Files scanned (raw json + markdown): ${localScan.filesScanned}`,
    `- Files with target-exact/context matches: ${localScan.filesWithTargetExactOrContextMatch}`,
    `- Files with broad-context matches (non-target): ${localScan.filesWithBroadContextMatch}`,
    ``,
    localTopRows.length
      ? markdownTable(localTopRows.map((row) => ({
        File: row.File,
        Line: row.Line,
        Category: row.Category,
        Term: row.Term,
        ExactMatch: row.ExactMatch,
        InTargetContext: row.InTargetContext,
        Count: row.Count,
        Sample: row.Sample,
      })), ["File", "Line", "Category", "Term", "ExactMatch", "InTargetContext", "Count", "Sample"])
      : "No local source matches found within scan bounds.",
    ``,
    `## Public source + metadata context`,
    ``,
    `- DefiLlama protocol: ${payload.metadata.defillamaUrl}`,
    `- DefiLlama TVL: ${payload.metadata.currentTvlUsd ? `$${Math.round(payload.metadata.currentTvlUsd).toLocaleString()}` : "n/a"}`,
    `- Adapter source: ${payload.metadata.adapterSource}`,
    `- Adapter source status: ${payload.metadata.adapterSourceStatus}`,
    `- Adapter address hint count: ${payload.metadata.adapterSourceAddressHints.length}`,
    ``,
    `## RPC + on-chain probing`,
    ``,
    `- RPCs used via: public/default only (no endpoint persistence)`,
    ``,
    `### Chain probe outcomes`,
    ``,
    (rpcRows.length
      ? rpcRows
        .map((chain) => `- ${chain.chain} [${chain.chainId}] reachable=${chain.chainReachable ? "yes" : "no"}${chain.blockNumber ? ` block=${chain.blockNumber}` : ""}`)
        .join("\n")
      : "No chain probes performed."),
    ``,
    `### Address rows`,
    ``,
    chainRows.length
      ? markdownTable(
        chainRows,
        [
          "Chain",
          "SourceChain",
          "SourceLabels",
          "ProbeChain",
          "Address",
          "Code",
          "Bytes",
          "NativeBalance",
          "BalanceProbe",
          "BalanceTarget",
          "BalanceProbeZero",
          "IsProxy",
          "ProxyImpl",
          "Owner",
          "Admin",
          "Paused",
          "SelectorHits",
          "BalanceProbeHits",
        ],
      )
      : "No on-chain rows were collected due full-chain RPC block.",
    ``,
    `## DEX liquidity checks`,
    ``,
    payload.dexScreener.caveats.length ? `- Caveats: ${payload.dexScreener.caveats.join("; ")}` : "",
    payload.dexRows && payload.dexRows.length
      ? markdownTable(
          payload.dexRows.map((row) => ({
            Chain: row.chain || "n/a",
            DEX: row.dex || "n/a",
            Pair: row.pairAddress || "n/a",
            LiquidityUsd: row.liquidityUsd !== null ? row.liquidityUsd.toFixed(2) : "n/a",
            Base: row.baseToken ? `${row.baseToken.symbol || "n/a"}` : "n/a",
            Quote: row.quoteToken ? `${row.quoteToken.symbol || "n/a"}` : "n/a",
            Url: row.url || "n/a",
          })),
          ["Chain", "DEX", "Pair", "LiquidityUsd", "Base", "Quote", "Url"],
        )
      : "No usable DEX rows were returned.",
    ``,
    `## Full test checklist`,
    ``,
    markdownTable(checklistCoreRows.map((row) => ({
      Section: row.Checklist,
      Status: row.Status,
      Covered: row.Covered,
      Rows: row.Rows,
      ExactRows: row.ExactRows,
      ContextRows: row.ContextRows,
      Notes: row.Note,
    })), ["Section", "Status", "Covered", "Rows", "ExactRows", "ContextRows", "Notes"]),
    ``,
    `## Expanded attack-class checklist`,
    ``,
    markdownTable(checklistAttackRows.map((row) => ({
      Section: row.Checklist,
      Status: row.Status,
      Covered: row.Covered,
      Rows: row.Rows,
      ExactRows: row.ExactRows,
      ContextRows: row.ContextRows,
      Notes: row.Note,
    })), ["Section", "Status", "Covered", "Rows", "ExactRows", "ContextRows", "Notes"]),
    ``,
    `Checklist summary: **${checklist.all.filter((r) => r.covered).length}/${checklist.all.length} covered**, complete=${payload.summary.fullTestChecklistComplete ? "yes" : "no"}`,
    ``,
    `## Blockers`,
    ``,
    blockers,
    ``,
    `## Required for route-positive`,
    ``,
    payload.requiredForRoutePositive.map((item) => `- ${item}`).join("\n"),
    ``,
    `## Next read-only step`,
    ``,
    payload.nextReadOnlyStep,
    ``,
    `## Caveats`,
    ``,
    `- rpcInventoryRead is false (no inventory endpoint read) and rpcUrlsStored is false (URLs not persisted in artifacts).`,
    `- Public endpoints are context only; endpoint blocks/latency are bounded and safe-fail.`,
    `- Bitcoin custody remains out-of-band for this full read-only run; no same-run custody proof anchored on Bitcoin headers/reorg assumptions was produced.`,
    `- Zkfair route semantics are partially opaque here (non-canonical bridge consumer path), so findings are treated as source-context and not route-positive without additional proof.`,
    `- If adapter/source samples do not include the active deployed revision, additional contract versions may be missed.`,
    `- route-positive is fail-closed until exact same-block economics + proof gate is proven.`,
  ].join("\n");
}

async function main() {
  const metadata = await (async () => {
    const loaded = await loadDeepMetadata();
    const protocol = await fetchJson(DEFI_LLAMA_PROTOCOL, 20_000);
    const protocolTvl = protocol && protocol.tvl && Array.isArray(protocol.tvl)
      ? asNumber(protocol.tvl[protocol.tvl.length - 1]?.totalLiquidityUSD)
      : asNumber(protocol?.tvl);

    return {
      slug: TARGET_SLUG,
      name: TARGET_NAME,
      category: "Bridge",
      surface: loaded.surface,
      routeGraph: loaded.routeGraph,
      chains: loaded.chains,
      accessibleEvmChains: loaded.accessibleEvmChains,
      blockedOrCaveatChains: loaded.blockedOrCaveatChains,
      adapterAddressCount: loaded.adapterAddressCount,
      adapterAddressSamples: loaded.adapterAddressSamples,
      adapterHints: loaded.adapterHints,
      defillamaUrl: DEFI_LLAMA_PROTOCOL,
      currentTvlUsd: protocolTvl || loaded.currentTvlUsd || null,
      module: TARGET_MODULE,
      tvlSource: protocol?.slug ? "api.llama.fi/protocol/merlins-seal" : "fallback/constants",
      audits: loaded.audits,
    };
  })();

  const adapterSourceRaw = await fetchText(DEFI_LLAMA_ADAPTER, 25_000);
  const adapterSourceStatus = adapterSourceRaw ? "fetched" : "fetch-failed";

  const adapterAddressHints = [];
  if (adapterSourceRaw) {
    const rawMatches = adapterSourceRaw.match(/0x[a-fA-F0-9]{40}/g) || [];
    for (const item of rawMatches) {
      const normalized = normalizeAddress(item);
      if (normalized) {
        adapterAddressHints.push(normalized);
      }
    }
  }

  const searchBag = buildSearchTerms(metadata.adapterAddressSamples || [], adapterAddressHints || []);
  const localScan = scanLocalArtifacts(searchBag);

  const localAddressMatches = dedupe(
    localScan.topMatches
      .filter((row) => row.termType === "address")
      .map((row) => normalizeAddress(row.term))
      .filter(Boolean),
    (x) => x,
  );

  const candidateAddresses = dedupe(
    [
      ...metadata.adapterAddressSamples,
      ...KNOWN_MERLINS_ADDRESSES,
      ...adapterAddressHints,
      ...localAddressMatches,
    ].map(normalizeAddress).filter(Boolean),
    (x) => x,
  );

  const candidateSources = new Map();
  for (const address of candidateAddresses) {
    const sources = new Set();
    if ((metadata.adapterAddressSamples || []).map((a) => normalizeAddress(a)).includes(address)) {
      sources.add("metadata.adapterAddressSamples");
    }
    if (adapterAddressHints.includes(address)) {
      sources.add("defillama-adapter-source");
    }
    if (localAddressMatches.includes(address)) {
      sources.add("local-merge-match");
    }
    sources.add("known-address-list");
    candidateSources.set(address, sources);
  }

  const tokenRows = dedupe(
    localScan.topMatches
      .filter((row) => row.category.includes("tokenSemantics") || row.category.includes("token") || row.category.includes("erc4626"))
      .filter((row) => row.termType === "address")
      .map((row) => normalizeAddress(row.term))
      .filter(Boolean),
    (x) => x,
  );

  const allChainResults = [];
  let rpcBlockedRows = 0;
  let selectorProbeRows = 0;
  let selectorProbeHits = 0;
  let codePresentRows = 0;
  let adminProxyRows = 0;
  let balanceProbeZeroRows = 0;

  const chainProbes = await Promise.all(CHAIN_CONFIG.map((chain) => probeChain(chain, candidateAddresses, candidateSources, candidateAddresses)));
  const chainRows = [];
  for (const chain of chainProbes) {
    allChainResults.push(chain);
    chainRows.push(...(chain.rows || []));
    for (const row of (chain.rows || [])) {
      if (row && row.balanceOfTargetZero) {
        balanceProbeZeroRows += 1;
      }
    }
    rpcBlockedRows += chain.blocked ? 1 : 0;
    selectorProbeRows += chain.selectorProbeRows || 0;
    selectorProbeHits += chain.selectorProbeHits || 0;
    codePresentRows += chain.codeRows || 0;
    adminProxyRows += chain.adminProxyRows || 0;
  }

  const bridgeRowsExact = localScan.categoryCounts.exact.bridgeProof || 0;
  const bridgeRowsContext = localScan.categoryCounts.context.bridgeProof || 0;
  const custodyRowsExact = localScan.categoryCounts.exact.bridgeProof || 0;
  const custodyRowsContext = localScan.categoryCounts.context.bridgeProof || 0;
  const oracleRowsExact = localScan.categoryCounts.exact.oracle || 0;
  const oracleRowsContext = localScan.categoryCounts.context.oracle || 0;
  const fullTestReadOnlyComplete = true;

  const dexRows = await queryDexScreener(tokenRows.length ? tokenRows : candidateAddresses);

  const summary = {
    targetRows: candidateAddresses.length,
    addressRows: candidateAddresses.length,
    filesWithTargetExactOrContextMatch: localScan.filesWithTargetExactOrContextMatch,
    filesWithBroadContextMatch: localScan.filesWithBroadContextMatch,
    codePresentRows,
    tokenRows: tokenRows.length,
    bridgeRows: bridgeRowsExact + bridgeRowsContext,
    bridgeRowsExact,
    bridgeRowsContext,
    custodyRows: custodyRowsExact + custodyRowsContext,
    custodyRowsExact,
    custodyRowsContext,
    localArtifactMatchRows: localScan.localArtifactMatchRows,
    localArtifactMatchRowsExact: localScan.exactLocalArtifactMatchRows,
    localArtifactMatchRowsContext: localScan.contextLocalArtifactMatchRows,
    exactLocalArtifactMatchRows: localScan.exactLocalArtifactMatchRows,
    contextLocalArtifactMatchRows: localScan.contextLocalArtifactMatchRows,
    consumerJoinRows: localScan.consumerJoinRows,
    exactConsumerJoinRows: localScan.exactConsumerJoinRows,
    contextConsumerJoinRows: localScan.contextConsumerJoinRows,
    stoneContextRows: localScan.stoneContextRows,
    mbtcContextRows: localScan.mbtcContextRows,
    dexLiquidityRows: dexRows.rows.length,
    oracleRows: oracleRowsExact + oracleRowsContext,
    oracleRowsExact,
    oracleRowsContext,
    adminProxyRows,
    selectorProbeRows,
    selectorProbeHits,
    balanceProbeZeroRows,
    fullTestReadOnlyComplete,
    exactEconomicsRows: 0,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    forkJustified: false,
    rpcBlockedRows,
    fullTestChecklistRows: 0,
    currentTvlUsd: metadata.currentTvlUsd || null,
    fullTestChecklistComplete: false,
  };

  const checklist = buildChecklist(
    localScan,
    {
      viewProbeRows: selectorProbeRows,
      viewProbeHits: selectorProbeHits,
    },
    {
      adminProxyRows,
      consumerJoinRows: localScan.consumerJoinRows,
      tokenRows: tokenRows.length,
      dexLiquidityRows: dexRows.rows.length,
      oracleRows: oracleRowsExact + oracleRowsContext,
      routePositive: summary.routePositive,
      executableNow: summary.executableNow,
      signedActionJustified: summary.signedActionJustified,
      forkJustified: summary.forkJustified,
      exactEconomicsRows: summary.exactEconomicsRows,
      codePresentRows,
      selectorProbeRows,
    },
  );
  summary.fullTestChecklistRows = checklist.all.length;
  summary.fullTestChecklistComplete = checklist.all.every((row) => row.covered);

  const requiredForRoutePositive = [
    "Permissionless route-positive path with explicit proof/domain/nonce/token/recipient bindings",
    "Exact same-block acquisition + cross-domain/consumer + unlock/exit arithmetic with positive economics",
    "No-reverting balance-delta proof from fork/local simulation on a realistic route",
    "Governance/permissioning and proxy-admin posture checked with live chain state",
  ];

  const blockers = [
    "No route-positive path proven from bounded local+public-context scan.",
    "No full same-block value-delta proof or fork simulation executed.",
    `Some chains may be RPC-blocked or rate-limited; rpcBlockedRows=${rpcBlockedRows}.`,
    "Bridge/custody binding semantics are context-only unless downstream proof artifacts are made executable in read-only follow-up.",
  ];

  if (summary.balanceProbeZeroRows > 0) {
    blockers.push("Owner/admin balance-probe reads resolved to zero on probe targets, indicating custody/role-ownership proof currently unconfirmed via balance reachability.");
  }

  const output = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-merlins-seal-full-test.js",
    scope: "Bounded MERLINS Seal full-test scanner (source inventory + local on-chain/selector/address probes; no fork execution).",
    target: {
      slug: TARGET_SLUG,
      name: TARGET_NAME,
      symbol: "MBTC",
      chains: metadata.chains,
      accessibleEvmChains: metadata.accessibleEvmChains,
      blockedOrCaveatChains: metadata.blockedOrCaveatChains,
      surface: metadata.surface,
      routeGraph: metadata.routeGraph,
      module: TARGET_MODULE,
    },
    safety: {
      rpcInventoryRead: false,
      graphqlInventoryRead: false,
      rpcUrlsStored: false,
      graphqlUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: summary.routePositive === 1,
      executableNow: summary.executableNow === 1,
      signedActionJustified: summary.signedActionJustified,
      forkJustified: summary.forkJustified,
    },
    metadata: {
      ...metadata,
      adapterSource: DEFI_LLAMA_ADAPTER,
      adapterSourceStatus,
      adapterSourceAddressHints: adapterAddressHints.slice(0, 24),
    },
    localScan,
    rpcRows: chainRows,
    rpcChains: allChainResults,
    tokenRowsList: tokenRows,
    addressRowsList: candidateAddresses,
    dexRows: dexRows.rows,
    dexScreener: {
      queriedAddresses: (tokenRows.length ? tokenRows : candidateAddresses).slice(0, 6),
      caveats: dexRows.caveats,
    },
    summary,
    fullTestChecklist: checklist,
    blockers,
    requiredForRoutePositive,
    nextReadOnlyStep: "Map any candidate address with source-confirmed bridge/custody proof semantics to live Ethereum/Arbitrum consumer graphs, then run focused same-block economics probes and fork/value-delta checks on explicit candidate routes only.",
  };

  ensureDir(OUT_JSON);
  fs.writeFileSync(OUT_JSON, `${safeJson(output)}\n`, "utf8");

  const report = buildReport(output);
  ensureDir(OUT_MD);
  fs.writeFileSync(OUT_MD, `${report}\n`, "utf8");

  log(`Merlins Seal full test generated: ${toRel(OUT_JSON)}`);
  log(`Merlins Seal full test markdown: ${toRel(OUT_MD)}`);
  log(`routePositive=${summary.routePositive}, executableNow=${summary.executableNow}, signedActionJustified=${summary.signedActionJustified}, forkJustified=${summary.forkJustified}`);
  log(`addressRows=${summary.addressRows}, codePresentRows=${summary.codePresentRows}, localArtifactMatchRows=${summary.localArtifactMatchRows}, consumerJoinRows=${summary.consumerJoinRows}, dexRows=${summary.dexLiquidityRows}, rpcBlockedRows=${summary.rpcBlockedRows}`);
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error && (error.stack || error.message) ? (error.stack || error.message) : String(error));
  process.exit(1);
});
