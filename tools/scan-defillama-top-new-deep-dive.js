#!/usr/bin/env node
// Read-only deep-dive reducer for top new DeFiLlama oracle-classifier targets.
// Uses public APIs and local sanitized artifacts only; never reads RPC endpoint files.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const CLASSIFIER = path.join(WORKSPACE, "reports", "raw", "fast", "defillama-oracle-classifier.json");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "defillama-top-new-deep-dive.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "defillama-top-new-deep-dive.md");

const DEFAULT_SLUGS = [
  "beefy",
  "reservoir-protocol",
  "vfat.io",
  "homora-v2",
  "superform",
  "cian-yield-layer",
  "lazy-summer-protocol",
];
const SLUGS = parseList(argValue("--slugs") || process.env.DEFILLAMA_TOP_NEW_SLUGS, DEFAULT_SLUGS);
const MAX_YIELD_ROWS = Number(argValue("--max-yield-rows") || process.env.DEFILLAMA_TOP_NEW_MAX_YIELD_ROWS || "12");
const MAX_LOCAL_MATCHES = Number(argValue("--max-local-matches") || process.env.DEFILLAMA_TOP_NEW_MAX_LOCAL_MATCHES || "12");
const QUIET = process.argv.includes("--quiet");

const SURFACE_BY_CATEGORY = {
  CDP: "lending-oracle-liquidation",
  Lending: "lending-oracle-liquidation",
  "Leveraged Farming": "leveraged-farming-oracle-liquidation",
  "Yield Aggregator": "vault-yield-allocator",
};

function argValue(name) {
  const prefix = `${name}=`;
  const item = process.argv.find((arg) => arg.startsWith(prefix));
  if (item) return item.slice(prefix.length);
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : null;
}

function parseList(text, fallback) {
  if (!text) return fallback;
  const out = String(text).split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
  return out.length ? out : fallback;
}

function readJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function round(value, decimals = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function normalizeText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function slugTokens(slug, name) {
  return [...new Set(`${slug} ${name || ""}`.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3))];
}

function adapterRawUrl(tvlCodePath) {
  if (!tvlCodePath || !String(tvlCodePath).includes("github.com/DefiLlama/DefiLlama-Adapters")) return null;
  return String(tvlCodePath)
    .replace("https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/", "https://raw.githubusercontent.com/DefiLlama/DefiLlama-Adapters/main/");
}

async function fetchJson(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "user-agent": "evm-audit-defillama-top-new/1.0" }, signal: controller.signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, timeoutMs = 30_000) {
  if (!url) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "user-agent": "evm-audit-defillama-top-new/1.0" }, signal: controller.signal });
    if (!res.ok) return null;
    return await res.text();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function listFiles(dir, predicate) {
  const out = [];
  function walk(current) {
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (!predicate || predicate(full)) out.push(full);
    }
  }
  walk(dir);
  return out;
}

function localCoverage(slug, name) {
  const tokens = slugTokens(slug, name);
  const reportFiles = listFiles(path.join(WORKSPACE, "reports"), (file) => /\.(md|json)$/i.test(file) && !file.includes(`${path.sep}raw${path.sep}slow${path.sep}`));
  const matches = [];
  for (const file of reportFiles) {
    const rel = path.relative(WORKSPACE, file).replace(/\\/g, "/");
    const haystack = normalizeText(rel);
    const score = tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0);
    if (score > 0) matches.push({ file: rel, score });
  }
  matches.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  return matches.slice(0, MAX_LOCAL_MATCHES);
}

function analyzeAdapter(source) {
  if (!source) return { fetched: false, bytes: 0, addressCount: 0, addresses: [], hints: [] };
  const addresses = [...new Set((source.match(/0x[a-fA-F0-9]{40}/g) || []).map((address) => address))];
  const checks = [
    ["ERC4626", /ERC4626|convertToAssets|previewRedeem|totalAssets/i],
    ["oracle", /oracle|price|Chainlink|RedStone|Pyth|latestRoundData/i],
    ["lending", /borrow|lend|collateral|liquidat/i],
    ["vault", /vault|strategy|allocator|yield/i],
    ["bridge/custody", /bridge|custody|escrow|lock|mint|burn/i],
    ["router/arbitrary-call", /execute|multicall|call\(|delegatecall/i],
    ["redeem/withdraw", /redeem|withdraw|claim/i],
  ];
  return {
    fetched: true,
    bytes: source.length,
    addressCount: addresses.length,
    addresses: addresses.slice(0, 20),
    hints: checks.filter(([, regex]) => regex.test(source)).map(([label]) => label),
  };
}

function matchYieldRows(yieldRows, slug, name) {
  const normalizedSlug = normalizeText(slug);
  const normalizedName = normalizeText(name);
  const tokens = slugTokens(slug, name);
  return yieldRows
    .filter((row) => {
      const project = normalizeText(row.project || row.projectName || "");
      const pool = normalizeText(row.pool || row.symbol || "");
      return project.includes(normalizedSlug)
        || project.includes(normalizedName)
        || tokens.some((token) => project.includes(token) || pool.includes(token));
    })
    .sort((a, b) => (Number(b.tvlUsd) || 0) - (Number(a.tvlUsd) || 0))
    .slice(0, MAX_YIELD_ROWS)
    .map((row) => ({
      project: row.project || null,
      chain: row.chain || null,
      symbol: row.symbol || null,
      pool: row.pool || null,
      tvlUsd: round(row.tvlUsd, 2),
      apy: round(row.apy, 4),
      apyBase: round(row.apyBase, 4),
      apyReward: round(row.apyReward, 4),
      ilRisk: row.ilRisk || null,
      exposure: row.exposure || null,
      predictions: row.predictions || null,
    }));
}

function routeGraph(category) {
  if (category === "CDP" || category === "Lending") return "collateral token -> accepted/oracle value -> borrow/liquidation path -> exit liquidity";
  if (category === "Leveraged Farming") return "LP/share position -> oracle/accounting value -> debt health/liquidation -> unwind liquidity";
  if (category === "Yield Aggregator") return "vault/share token -> NAV/share-rate accounting -> lending/DEX consumer -> redeem/unwind";
  return "producer asset -> accepted value -> consumer -> exit liquidity";
}

function statusFor(row, coverage, adapter, yields, dedicated) {
  if (dedicated?.routePositive > 0) return "route-positive-from-dedicated-artifact";
  if (dedicated?.watchCandidates > 0) return "watch-candidates-from-dedicated-artifact";
  if (dedicated) return "covered-dormant-no-route-positive";
  if (row.category === "Yield Aggregator" && coverage.length === 0 && adapter.addressCount === 0 && yields.length === 0) return "research-only-no-deployed-addresses";
  if (row.category === "Yield Aggregator") return "research-needs-consumer-join";
  if (row.category === "CDP" || row.category === "Lending" || row.category === "Leveraged Farming") return "research-needs-market-oracle-state";
  return "research-needs-route-graph";
}

function blockersFor(row, coverage, adapter, yields, dedicated) {
  if (dedicated?.blockers?.length) return dedicated.blockers;
  const blockers = [];
  if (!adapter.fetched) blockers.push("DefiLlama adapter source unavailable or registry-only; deployed addresses unresolved from this pass.");
  if (adapter.fetched && adapter.addressCount === 0) blockers.push("Adapter source did not expose direct EVM addresses for live state probing.");
  if (row.category === "Yield Aggregator") blockers.push("No joined lending/borrow consumer for protocol share tokens was proven in this pass.");
  if (row.category === "CDP" || row.category === "Lending") blockers.push("No exact market/oracle/cap/borrow-cash state was mapped to a positive borrow or liquidation route in this pass.");
  if (row.category === "Leveraged Farming") blockers.push("No same-block contract-callable leverage/liquidation route with exact unwind economics was proven in this pass.");
  if (!yields.length) blockers.push("No matching active DeFiLlama yield pool rows were found for route liquidity context.");
  blockers.push("No accepted-value versus realizable-value divergence, exact quote, or fork proof exists.");
  return [...new Set(blockers)];
}

function dedicatedArtifact(slug) {
  if (slug === "reservoir-protocol") {
    const artifact = readJson(path.join(WORKSPACE, "reports", "raw", "fast", "reservoir-phase0.json"), null);
    if (!artifact) return null;
    return {
      artifact: "reports/raw/fast/reservoir-phase0.json",
      report: "reports/reservoir-deep-triage.md",
      routePositive: artifact.summary?.routePositive || 0,
      watchCandidates: artifact.summary?.watchCandidates || 0,
      blockers: [
        "Credit Enforcer adapter probes found no active adapter rows.",
        "rUSD/srUSD/wsrUSD PSM/DEX route is not exact-positive.",
        "No material borrower/account-health route was proven.",
      ],
      summary: artifact.summary || null,
    };
  }
  if (slug === "homora-v2") {
    return {
      artifact: "reports/homora-v2-triage.md",
      report: "reports/homora-v2-triage.md",
      routePositive: 0,
      watchCandidates: 0,
      blockers: [
        "HomoraBank execute path is blocked by onlyEOAEx/contract-call restrictions.",
        "Band oracle staleness remains conditional and not currently divergent enough for a low/no-capital route.",
        "No exact positive unwind/liquidation economics or fork proof exists.",
      ],
      summary: null,
    };
  }
  return null;
}

function renderReport(artifact) {
  const rows = artifact.rows.map((row) => `| ${row.name} | ${row.category} | $${row.tvlUsdM}M | ${row.surface} | ${row.adapter.addressCount} | ${row.yieldRows.length} | ${row.localCoverage.length} | ${row.status} |`).join("\n");
  const detail = artifact.rows.map((row, i) => [
    `### ${i + 1}. ${row.name}`,
    "",
    `Route graph: \`${row.routeGraph}\``,
    "",
    `Status: \`${row.status}\``,
    "",
    "Blockers:",
    ...row.blockers.map((blocker) => `- ${blocker}`),
    "",
  ].join("\n")).join("\n");
  return [
    "# DeFiLlama Top New Deep Dive",
    "",
    `Date: ${artifact.generatedAt.slice(0, 10)}`,
    "",
    "## Result",
    "",
    `Deep-dived ${artifact.summary.targets} top new DeFiLlama candidates. Route-positive rows: ${artifact.summary.routePositive}. Watch candidates: ${artifact.summary.watchCandidates}.`,
    "",
    "## Summary",
    "",
    "| Target | Category | TVL | Surface | Adapter Addresses | Yield Rows | Local Matches | Status |",
    "| --- | --- | ---: | --- | ---: | ---: | ---: | --- |",
    rows || "| n/a | n/a | $0M | n/a | 0 | 0 | 0 | n/a |",
    "",
    "## Details",
    "",
    detail,
    "## Gate",
    "",
    "Fork work remains closed until a candidate maps a concrete producer anomaly to a live consumer, exact borrow/redeem/liquidation/unlock liquidity, positive read-only economics after fees/slippage/gas, and fork extraction proof.",
    "",
    "## Artifacts",
    "",
    "- JSON: `reports/raw/fast/defillama-top-new-deep-dive.json`",
    "- Scanner: `tools/scan-defillama-top-new-deep-dive.js`",
    "",
  ].join("\n");
}

async function main() {
  const classifier = readJson(CLASSIFIER, { ranked: [] });
  const yieldData = await fetchJson("https://yields.llama.fi/pools").catch(() => ({ data: [] }));
  const yieldRows = Array.isArray(yieldData?.data) ? yieldData.data : [];
  const rows = [];
  for (const slug of SLUGS) {
    const classifierRow = (classifier.ranked || []).find((row) => row.slug === slug);
    const protocol = await fetchJson(`https://api.llama.fi/protocol/${encodeURIComponent(slug)}`).catch(() => null);
    const base = classifierRow || protocol || { slug, name: slug, category: "Unknown", tvl: 0, chains: [] };
    const tvlCodePath = base.tvlCodePath || protocol?.tvlCode || protocol?.module || null;
    const source = await fetchText(adapterRawUrl(tvlCodePath || base.tvlCodePath));
    const adapter = analyzeAdapter(source);
    const coverage = localCoverage(slug, base.name);
    const yields = matchYieldRows(yieldRows, slug, base.name);
    const dedicated = dedicatedArtifact(slug);
    const status = statusFor(base, coverage, adapter, yields, dedicated);
    const blockers = blockersFor(base, coverage, adapter, yields, dedicated);
    rows.push({
      slug,
      name: base.name || protocol?.name || slug,
      category: base.category || protocol?.category || "Unknown",
      tvlUsd: round(base.tvl || protocol?.tvl || 0, 2),
      tvlUsdM: round((base.tvl || protocol?.tvl || 0) / 1e6, 3),
      chains: base.chains || protocol?.chains || [],
      audits: base.audits || protocol?.audits || [],
      oracleNames: base.oracleNames || [],
      riskLabel: base.riskLabel || null,
      surface: SURFACE_BY_CATEGORY[base.category] || "generic-route-discovery",
      routeGraph: routeGraph(base.category),
      adapter: {
        tvlCodePath: tvlCodePath || base.tvlCodePath || null,
        rawUrl: adapterRawUrl(tvlCodePath || base.tvlCodePath),
        ...adapter,
      },
      yieldRows: yields,
      localCoverage: coverage,
      dedicatedArtifact: dedicated,
      status,
      blockers,
      watchCandidate: dedicated ? dedicated.watchCandidates > 0 : false,
      routePositive: dedicated ? dedicated.routePositive > 0 : false,
      executableNow: false,
    });
  }
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-defillama-top-new-deep-dive.js",
    scope: "Top new DeFiLlama oracle-classifier candidate deep dive",
    safety: {
      publicApisOnly: true,
      localArtifactsRead: true,
      rpcInventoryRead: false,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
    },
    config: { slugs: SLUGS, maxYieldRows: MAX_YIELD_ROWS, maxLocalMatches: MAX_LOCAL_MATCHES },
    summary: {
      targets: rows.length,
      withAdapterSource: rows.filter((row) => row.adapter.fetched).length,
      adapterAddressRows: rows.filter((row) => row.adapter.addressCount > 0).length,
      withYieldRows: rows.filter((row) => row.yieldRows.length > 0).length,
      withLocalCoverage: rows.filter((row) => row.localCoverage.length > 0).length,
      watchCandidates: rows.filter((row) => row.watchCandidate).length,
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      status: "no-route-positive-top-new-target",
    },
    rows,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`);
  fs.writeFileSync(REPORT_OUT, renderReport(artifact));
  if (!QUIET) {
    console.log(`DeFiLlama top-new deep dive: targets=${rows.length} watch=${artifact.summary.watchCandidates} routePositive=0`);
    console.log(`Artifact: ${path.relative(WORKSPACE, OUT)}`);
  }
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
