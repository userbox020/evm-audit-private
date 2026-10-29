#!/usr/bin/env node
// Read-only Coinbase Wrapped Staked ETH (cbETH) route prefilter.
// Local-artifact + public-API bounded scan. No RPC/GraphQL/ENV reads.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const REPORTS_DIR = path.join(WORKSPACE, "reports");
const OUT_JSON = path.join(RAW_DIR, "prefilter-coinbase-wrapped-staked-eth-route-prefilter.json");
const OUT_MD = path.join(WORKSPACE, "reports", "prefilter-coinbase-wrapped-staked-eth-route-prefilter.md");
const DEEP_METADATA_FILE = path.join(RAW_DIR, "prefilter-deep-new-target-search-2026-06-24.json");

const QUIET = process.argv.includes("--quiet");
const OUT_JSON_BASENAME = path.basename(OUT_JSON).toLowerCase();
const OUT_MD_BASENAME = path.basename(OUT_MD).toLowerCase();

const TARGET = {
  slug: "coinbase-wrapped-staked-eth",
  name: "Coinbase Wrapped Staked ETH",
  symbol: "cbETH",
  chain: "Ethereum",
  chainId: 1,
  category: "Liquid Staking",
  surface: "vault-yield-allocator",
  routeGraph: "vault/share token -> rate/accounting -> consumer or exit venue -> borrow/redeem/unwind",
  module: "cbETH/index.js",
  tokenAddress: "0xBe9895146f7AF43049ca1c1AE358B0541Ea49704",
};

const PROTOCOL_API = "https://api.llama.fi/protocol/coinbase-wrapped-staked-eth";
const ADAPTER_SOURCE = "https://raw.githubusercontent.com/DefiLlama/DefiLlama-Adapters/main/projects/cbETH/index.js";
const DEXSCREENER_TOKEN_API = "https://api.dexscreener.com/latest/dex/tokens/";

const MAX_MATCH_CONTEXT_ROWS = 120;
const MAX_MATCH_CONTEXT_ROWS_PER_FILE = 24;
const MAX_DEX_ROWS = 12;

const SEARCH_TERMS = [
  { type: "address", term: TARGET.tokenAddress.toLowerCase(), label: `token-address:${TARGET.tokenAddress}` },
  { type: "symbol", term: TARGET.symbol.toLowerCase(), label: TARGET.symbol },
  { type: "slug", term: TARGET.slug.toLowerCase(), label: TARGET.slug },
  { type: "name", term: "coinbase wrapped staked eth", label: TARGET.name.toLowerCase() },
  { type: "module", term: "cbeth/index.js", label: "cbETH/index.js" },
];

const CATEGORY_RULES = {
  consumer: ["consumer", "lending", "borrow", "borrower", "collateral", "liquidation", "liquidat", "supply", "borrowing", "loan", "vault", "position", "depositor", "depositors", "margin", "redeem", "withdraw"],
  lending: ["aave", "euler", "morpho", "silo", "compound", "lending", "borrow", "borrower", "lendingpool", "loan", "cdp", "market", "borrower"],
  dex: ["dex", "swap", "pool", "amm", "uniswap", "curve", "balancer", "sushiswap", "pancake", "pair", "liquidity", "reserves", "router", "quoter", "route"],
  oracle: ["oracle", "chainlink", "pyth", "redstone", "band", "aggregator", "feed", "price", "price oracle", "price-feed", "stale"],
};

function log(...args) {
  if (!QUIET) {
    console.log(...args);
  }
}

function safeText(value, max = 220) {
  return String(value || "")
    .replace(/[\r\n|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max) || null;
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (_error) {
    return null;
  }
}

function readJson(filePath) {
  const text = readText(filePath);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_error) {
    return null;
  }
}

function toRel(filePath) {
  return path.relative(WORKSPACE, filePath).replace(/\\/g, "/");
}

function countOccurrences(haystack, needle) {
  if (!haystack || !needle) return 0;
  const index = haystack.indexOf(needle);
  if (index < 0) return 0;
  let count = 0;
  let cursor = 0;
  while (true) {
    const pos = haystack.indexOf(needle, cursor);
    if (pos < 0) break;
    count += 1;
    cursor = pos + needle.length;
  }
  return count;
}

function classifyCategory(text, filePath) {
  const hay = `${String(filePath || "").toLowerCase()} ${String(text || "").toLowerCase()}`;

  const has = (keys) => keys.some((k) => hay.includes(k));
  if (has(CATEGORY_RULES.consumer)) return "consumer";
  if (has(CATEGORY_RULES.lending)) return "lending";
  if (has(CATEGORY_RULES.dex)) return "dex";
  if (has(CATEGORY_RULES.oracle)) return "oracle";
  return "token";
}

function lineContext(lines, index) {
  const prev = index > 0 ? lines[index - 1] : "";
  const curr = lines[index] || "";
  const next = index + 1 < lines.length ? lines[index + 1] : "";
  return safeText(`${prev} ${curr} ${next}`);
}

function loadDeepMetadata() {
  if (!fs.existsSync(DEEP_METADATA_FILE)) {
    return { ok: false, source: "missing-deep-target-file" };
  }

  const doc = readJson(DEEP_METADATA_FILE);
  if (!doc || !Array.isArray(doc.rankedQueue)) {
    return { ok: false, source: "invalid-deep-target-file" };
  }

  const match = doc.rankedQueue.find((row) => String(row.slug || "").toLowerCase() === TARGET.slug);
  if (!match) return { ok: false, source: "missing-rank-entry" };

  return {
    ok: true,
    source: "reports/raw/fast/prefilter-deep-new-target-search-2026-06-24.json",
    name: match.name || TARGET.name,
    slug: match.slug || TARGET.slug,
    category: match.category || TARGET.category,
    chains: Array.isArray(match.chains) && match.chains.length ? match.chains : [TARGET.chain],
    module: match.adapter?.module || TARGET.module,
    surface: match.surface || TARGET.surface,
    routeGraph: match.routeGraph || TARGET.routeGraph,
    currentTvlUsd: match.tvlUsd != null ? Number(match.tvlUsd) : null,
    audits: match.audits || null,
    adapterAddressCount: Number(match.adapter?.adapterAddressCount || 0),
    adapterHints: Array.isArray(match.adapter?.adapterHints) ? match.adapter.adapterHints.slice(0, 6) : [],
  };
}

async function fetchWithTimeout(url, timeoutMs = 30_000, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: {
        ...(opts.headers || {}),
        "user-agent": "evm-audit-cbeth-prefilter/1.0",
      },
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, timeoutMs = 30_000) {
  const response = await fetchWithTimeout(url, timeoutMs).catch(() => null);
  if (!response || !response.ok) return null;
  try {
    return await response.json();
  } catch (_error) {
    return null;
  }
}

function listRawJsonFiles() {
  if (!fs.existsSync(RAW_DIR)) return [];
  return fs.readdirSync(RAW_DIR)
    .filter((file) => file.toLowerCase().endsWith(".json"))
    .filter((file) => file.toLowerCase() !== OUT_JSON_BASENAME)
    .map((file) => path.join(RAW_DIR, file));
}

function listReportMdFiles() {
  if (!fs.existsSync(REPORTS_DIR)) return [];
  return fs.readdirSync(REPORTS_DIR)
    .filter((file) => file.toLowerCase().endsWith(".md"))
    .filter((file) => file.toLowerCase() !== OUT_MD_BASENAME)
    .map((file) => path.join(REPORTS_DIR, file));
}

function scanLocalArtifacts() {
  const files = [...listRawJsonFiles(), ...listReportMdFiles()];
  files.sort((a, b) => a.localeCompare(b));

  const buckets = new Map();
  const categoryRows = { token: 0, consumer: 0, lending: 0, dex: 0, oracle: 0 };
  let totalAddressMatches = 0;
  let totalMatchRows = 0;

  for (const filePath of files) {
    const raw = readText(filePath);
    if (!raw) continue;

    const textLines = raw.split(/\r?\n/);
    const lowerLines = textLines.map((line) => String(line || "").toLowerCase());
    const rel = toRel(filePath);

    const bucket = {
      file: rel,
      matchRows: 0,
      categoryRows: { token: 0, consumer: 0, lending: 0, dex: 0, oracle: 0 },
      samples: [],
    };

    for (let i = 0; i < lowerLines.length; i += 1) {
      const lineLower = lowerLines[i] || "";
      for (const candidate of SEARCH_TERMS) {
        const count = countOccurrences(lineLower, candidate.term);
        if (count <= 0) continue;

        const category = classifyCategory(lineLower, rel);
        const sample = lineContext(textLines, i);

        bucket.matchRows += count;
        bucket.categoryRows[category] = (bucket.categoryRows[category] || 0) + count;
        categoryRows[category] = (categoryRows[category] || 0) + count;
        totalMatchRows += count;

        if (candidate.type === "address") totalAddressMatches += count;

        if (bucket.samples.length < MAX_MATCH_CONTEXT_ROWS_PER_FILE) {
          bucket.samples.push({
            line: i + 1,
            termType: candidate.type,
            term: candidate.label,
            category,
            count,
            sample,
          });
        }
      }
    }

    if (bucket.matchRows > 0) {
      buckets.set(filePath, bucket);
    }
  }

  const localArtifactMatches = [...buckets.values()]
    .map((bucket) => ({
      file: bucket.file,
      matchRows: bucket.matchRows,
      categoryRows: bucket.categoryRows,
      topSamples: bucket.samples
        .sort((a, b) => {
          if (b.count !== a.count) return b.count - a.count;
          if (a.line !== b.line) return a.line - b.line;
          return String(a.term).localeCompare(String(b.term));
        })
        .slice(0, MAX_MATCH_CONTEXT_ROWS_PER_FILE),
    }))
    .sort((a, b) => {
      if (b.matchRows !== a.matchRows) return b.matchRows - a.matchRows;
      return a.file.localeCompare(b.file);
    })
    .slice(0, MAX_MATCH_CONTEXT_ROWS);

  const topSamples = localArtifactMatches
    .flatMap((row) => row.topSamples.map((sample) => ({ ...sample, file: row.file })))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      if (a.file !== b.file) return a.file.localeCompare(b.file);
      return a.line - b.line;
    })
    .slice(0, MAX_MATCH_CONTEXT_ROWS);

  const consumerJoinRows = (categoryRows.consumer || 0) + (categoryRows.lending || 0);

  return {
    scanned: files.length,
    localArtifactMatches,
    topSamples,
    localArtifactMatchRows: totalMatchRows,
    categoryRows,
    consumerJoinRows,
    totalAddressMatchRows: totalAddressMatches,
  };
}

async function loadAdapterHintRows() {
  const adapterSource = await fetchJson(ADAPTER_SOURCE, 30_000);
  if (!adapterSource || typeof adapterSource !== "string") {
    return { source: "adapter-fetch-failed", addressHints: [] };
  }

  const addresses = [];
  const re = /0x[a-fA-F0-9]{40}/g;
  let m;
  while ((m = re.exec(adapterSource)) !== null) {
    addresses.push(m[0]);
    if (addresses.length >= 12) break;
  }

  return {
    source: "projects/cbETH/index.js",
    addressHints: [...new Set(addresses)],
  };
}

async function loadProtocolMetadata() {
  const deep = loadDeepMetadata();
  const llama = await fetchJson(PROTOCOL_API, 35_000);

  const currentTvl = (() => {
    const tvl = Array.isArray(llama?.tvl) && llama.tvl.length ? Number(llama.tvl[llama.tvl.length - 1]?.totalLiquidityUSD) : null;
    if (Number.isFinite(tvl)) return tvl;
    if (Number.isFinite(Number(deep.currentTvlUsd))) return Number(deep.currentTvlUsd);
    if (Number.isFinite(Number(llama?.tvl))) return Number(llama.tvl);
    return null;
  })();

  return {
    source: llama?.name ? "api.llama.fi/protocol/coinbase-wrapped-staked-eth" : "fallback-constants-and-deep-target",
    ok: Boolean(llama || deep.ok),
    name: llama?.name || deep.name || TARGET.name,
    slug: llama?.slug || deep.slug || TARGET.slug,
    category: llama?.category || deep.category || TARGET.category,
    chains: Array.isArray(llama?.chains) && llama.chains.length ? llama.chains : (deep.chains || [TARGET.chain]),
    currentTvlUsd: currentTvl,
    audits: llama?.audits || deep.audits || null,
    module: deep.module || TARGET.module,
    surface: deep.surface || TARGET.surface,
    routeGraph: TARGET.routeGraph,
    adapterAddressCount: Number(deep.adapterAddressCount || 0),
    url: llama?.url || null,
    twitter: llama?.twitter || null,
    adapterHints: deep.adapterHints || [],
  };
}

function normalizeUsd(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function queryDexScreenerPairs() {
  const address = TARGET.tokenAddress.toLowerCase();
  const rows = [];
  let caveat = null;

  const payload = await fetchJson(`${DEXSCREENER_TOKEN_API}${address}`, 20_000).catch(() => null);
  if (!payload || !Array.isArray(payload.pairs)) {
    caveat = "DexScreener token endpoint not accessible or returned no pair array";
    return { caveat, rows: [] };
  }

  for (const pair of payload.pairs) {
    if (!pair) continue;
    const liquidityUsd = normalizeUsd(pair.liquidity?.usd);
    const pairRow = {
      chain: pair.chainId || null,
      dex: pair.dexId || null,
      pairAddress: pair.pairAddress || null,
      priceUsd: normalizeUsd(pair.priceUsd),
      fdvUsd: normalizeUsd(pair.fdv),
      volume24hUsd: normalizeUsd(pair.volume?.h24),
      liquidityUsd,
      url: pair.url || null,
      baseToken: pair.baseToken ? { symbol: pair.baseToken.symbol || null, address: pair.baseToken.address || null } : null,
      quoteToken: pair.quoteToken ? { symbol: pair.quoteToken.symbol || null, address: pair.quoteToken.address || null } : null,
    };

    if (pairRow.liquidityUsd == null && pairRow.volume24hUsd == null) continue;
    rows.push(pairRow);
  }

  const sorted = rows
    .sort((a, b) => {
      const la = Number(a.liquidityUsd || 0);
      const lb = Number(b.liquidityUsd || 0);
      return lb - la;
    })
    .slice(0, MAX_DEX_ROWS);

  return { caveat: sorted.length ? null : "DexScreener returned no usable liquidity rows for cbETH", rows: sorted };
}

function topLine(item, fallback = "n/a") {
  return safeText(item && item.sample ? item.sample : fallback, 180);
}

function mkTokenRows(localScan) {
  const addressRows = localScan.totalAddressMatchRows;
  return [
    {
      chain: TARGET.chain,
      chainId: TARGET.chainId,
      symbol: TARGET.symbol,
      name: TARGET.name,
      address: TARGET.tokenAddress,
      source: "known-token",
      localMatchRows: addressRows,
      localCategoryRows: localScan.topSamples
        .filter((m) => m.termType === "address")
        .reduce((acc, m) => {
          acc[m.category] = (acc[m.category] || 0) + m.count;
          return acc;
        }, { consumer: 0, lending: 0, dex: 0, oracle: 0, token: 0 }),
      localSamples: localScan.topSamples
        .filter((m) => m.termType === "address")
        .map((m) => ({ file: m.file, line: m.line, category: m.category, sample: m.sample })),
    },
  ];
}

async function main() {
  const protocolMetadata = await loadProtocolMetadata();
  const adapterHints = await loadAdapterHintRows();
  const scan = scanLocalArtifacts();
  const dex = await queryDexScreenerPairs();

  const tokenRows = mkTokenRows(scan);
  const topSampleForSummary = scan.topSamples.map((row) => ({
    file: row.file,
    line: row.line,
    term: row.term,
    termType: row.termType,
    category: row.category,
    count: row.count,
    sample: topLine(row),
  }));

  const summary = {
    tokenRows: tokenRows.length,
    localArtifactMatchRows: scan.localArtifactMatchRows,
    consumerJoinRows: scan.consumerJoinRows,
    dexLiquidityRows: dex.rows.length,
    exactEconomicsRows: 0,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    forkJustified: false,
    rpcBlockedRows: 0,
  };

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-coinbase-wrapped-staked-eth-prefilter.js",
    scope: "Coinbase Wrapped Staked ETH route prefilter",
    safety: {
      rpcInventoryRead: false,
      graphqlInventoryRead: false,
      rpcUrlsStored: false,
      graphqlUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      forkTransactions: false,
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
      forkJustified: false,
    },
    metadata: {
      ...protocolMetadata,
      deepMetadataSource: protocolMetadata.source,
      dexauditMetadata: {
        source: DEEP_METADATA_FILE,
        adapterAddressCount: protocolMetadata.adapterAddressCount,
        adapterHints: protocolMetadata.adapterHints,
      },
      adapterSource: ADAPTER_SOURCE,
      adapterSourceHints: adapterHints.addressHints,
      adapterSourceStatus: adapterHints.source,
    },
    tokenRows,
    localArtifactMatches: scan.localArtifactMatches,
    localMatchTopSamples: topSampleForSummary,
    localArtifactMatchRows: scan.localArtifactMatchRows,
    categoryRows: scan.categoryRows,
    consumerJoinRows: scan.consumerJoinRows,
    dexLiquidityRows: dex.rows,
    dexScreener: {
      endpoint: `${DEXSCREENER_TOKEN_API}${TARGET.tokenAddress}`,
      rows: dex.rows,
      caveat: dex.caveat,
    },
    rpcBlocked: [],
    summary,
    blockers: [
      "No on-chain / RPC probing was performed in this pass (rpcInventoryRead=false by explicit constraint).",
      "No local-only consumer route was proven from artifact text; token, lending, DEX, and oracle references are context-only and non-route positive.",
      "No exact same-block route with positive economics was proven from local artifacts and public APIs.",
      "No exact-positive fork/static-value delta or executable path was proven.",
      dex.caveat || "DEX/route liquidity was checked only via optional DexScreener public endpoint and counted as context where available.",
    ].filter(Boolean),
    requiredForRoutePositive: [
      "Evidence of a permissionless consumer/lender accepting cbETH with proven live economic mismatch or imbalance",
      "Proof of exact acquisition->consumer->exit/redeem chain with positive delta under same-block and post-cost assumptions",
      "Public on-chain probes confirming cbETH producer accounting/asset relation and accepted value semantics",
      "Fork extraction or equivalent read-only exact positive route proof",
    ],
    nextReadOnlyStep: "Query cbETH producer and top cited consumer contracts on a public read-only endpoint once RPC is available, then rerun focused route-economic checks for exact positive same-block math.",
  };

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  const artifactPath = path.relative(WORKSPACE, OUT_JSON).replace(/\\/g, "/");
  const mdPath = path.relative(WORKSPACE, OUT_MD).replace(/\\/g, "/");
  const tvlDisplay = typeof protocolMetadata.currentTvlUsd === "number" ? `$${Math.round(protocolMetadata.currentTvlUsd).toLocaleString()}` : "n/a";

  const md = `# 🟢 DORMANT - Coinbase Wrapped Staked ETH Route Prefilter\n` +
    `\nDate: ${artifact.generatedAt.slice(0, 10)}\n` +
    `\nArtifact: ${artifactPath}\n` +
    `\nClaim: discovery/coinbase-wrapped-staked-eth-route-prefilter\n` +
    `\n## Result\n\n` +
    `Bounded read-only prefilter completed over local artifacts (reports/raw/fast/*.json and reports/*.md), DefiLlama protocol metadata, optional adapter-source/address hints, and optional DexScreener token liquidity lookup. ` +
    `No exact route-positive conditions were proven. Route remains dormant.\n\n` +
    `## Current Metrics\n\n` +
    `| Surface | Current Value | Route |\n` +
    `|---|---:|---:|\n` +
    `| DefiLlama TVL | ${tvlDisplay} | 0 |\n` +
    `| Token rows | ${summary.tokenRows} | 0 |\n` +
    `| Local artifact match rows | ${summary.localArtifactMatchRows} | 0 |\n` +
    `| Consumer join rows (context) | ${summary.consumerJoinRows} | 0 |\n` +
    `| DEX liquidity rows | ${summary.dexLiquidityRows} | 0 |\n` +
    `| Exact economics rows | ${summary.exactEconomicsRows} | 0 |\n` +
    `| routePositive | ${summary.routePositive} | ${summary.routePositive === 0 ? 0 : 1} |\n` +
    `| executableNow | ${summary.executableNow} | ${summary.executableNow === 0 ? 0 : 1} |\n` +
    `| rpcBlockedRows | ${summary.rpcBlockedRows} | 0 |\n\n` +
    `## Route Gate\n\n` +
    `Fail-closed: routePositive remains negative unless exact producer anomaly + permissionless live consumer acceptance + exact positive acquisition/exit economics are proven from read-only evidence.\n\n` +
    `## Local Artifacts / Context Matches (Top)\n\n` +
    `| File | Category | Term | Count | Sample |\n` +
    `|---|---|---|---:|---|\n` +
    `${topSampleForSummary
      .slice(0, 30)
      .map((row) => `| ${row.file} | ${row.category} | ${row.term} | ${row.count} | ${row.sample ? row.sample.replace(/[|]/g, " ") : "n/a"} |`)
      .join("\n")}\n\n` +
    `## DexScreener Liquidity Context\n\n` +
    `${dex.rows.length > 0 ? `| Chain | DEX | Pair | Liquidity USD | Base | Quote | URL |\n|---|---|---|---:|---|---|---|\n${dex.rows
      .map((row) => `| ${row.chain || "n/a"} | ${row.dex || "n/a"} | ${row.pairAddress || "n/a"} | ${row.liquidityUsd != null ? Number(row.liquidityUsd).toFixed(2) : "n/a"} | ${(row.baseToken?.symbol || "n/a")}/${(row.quoteToken?.symbol || "n/a")} | ${row.url || "n/a"} |`)
      .join("\n")}` : `No usable DexScreener rows were obtained. ${dex.caveat ? `Caveat: ${dex.caveat}` : ""}` }\n\n` +
    `## Remaining blockers\n\n` +
    `${artifact.blockers.map((b) => `- ${b}`).join("\n")}\n\n` +
    `## Required for route-positive\n\n` +
    `${artifact.requiredForRoutePositive.map((item) => `- ${item}`).join("\n")}\n` +
    `\n## Caveats\n\n` +
    `- rpcInventoryRead=false, graphqlInventoryRead=false, envFilesRead=false, privateKeysRead=false, signedActions=false, forkTransactions=false.\n` +
    `- Optional DexScreener lookup is non-fatal and only adds context, not proof.\n` +
    `- Artifact matches are context-only (textual evidence); no exact exact-positive on-chain route economics were proven.\n`;

  fs.writeFileSync(OUT_MD, `${md}\n`, "utf8");

  log(`cbETH prefilter complete: tokenRows=${summary.tokenRows}, localArtifactMatchRows=${summary.localArtifactMatchRows}, consumerJoinRows=${summary.consumerJoinRows}, dexRows=${summary.dexLiquidityRows}, routePositive=${summary.routePositive}`);
  log(`Artifact: ${artifactPath}`);
  log(`Report: ${mdPath}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error && (error.stack || error.message) ? (error.stack || error.message) : String(error));
    process.exit(1);
  });
