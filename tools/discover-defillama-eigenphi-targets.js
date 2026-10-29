#!/usr/bin/env node

const fs = require("fs/promises");
const path = require("path");

const OUT = path.join(__dirname, "..", "reports", "raw", "fast", "defillama-eigenphi-target-discovery.json");

const WORKSPACE_EXCLUSIONS = new Set([
  "aave-v3",
  "morpho-blue",
  "venus-core-pool",
  "hyperlend-pooled",
  "benqi-lending",
  "tectonic",
  "reserve-protocol",
  "polymarket",
  "fluid-lending",
  "fluid-dex",
  "silo-v3",
  "dolomite",
  "curve-dex",
  "llamalend",
  "gearbox",
  "fraxlend",
  "kamino-lend",
  "jupiter-lend",
  "jupiter-perpetual-exchange",
  "suilend",
  "drift",
  "spark-lend",
  "stargate",
  "across",
  "hyperlane",
  "wormhole",
  "synapse",
  "symbiosis",
  "zerolend",
  "yearn-finance",
  "uniswap-v4",
  "synthetix",
  "save",
  "navi-protocol",
  "pendle",
  "maple",
  "cap",
  "blend",
  "euler-v2",
  "lista-lending",
  "sparklend",
  "aave-v4",
  "blend-pools-v2",
]);

const SELECTED_SLUGS = [
  "avalon-usda",
  "lorenzo-susd1+",
  "usd-ai",
  "derive-v2",
  "solstice",
  "xstocks",
  "ethena-usde",
  "sky-lending",
  "infinifi",
  "bouncebit-cedefi-yield",
];

const ALLOWED_CATEGORIES = new Set([
  "Lending",
  "RWA Lending",
  "CDP",
  "Dexs",
  "Derivatives",
  "Options",
  "Basis Trading",
  "Yield",
  "Yield Aggregator",
  "RWA",
  "Liquid Staking",
  "Liquid Restaking",
  "Risk Curators",
  "Onchain Capital Allocator",
  "Stablecoin Issuer",
  "Stablecoin Wrapper",
  "Restaked BTC",
]);

const TARGET_NOTES = {
  "avalon-usda": {
    rank: 1,
    why: "Large multi-chain CDP with zero DeFiLlama audit count and accessible EVM chain coverage.",
    bugClasses: ["collateral oracle manipulation", "debt accounting", "liquidation discount errors", "cross-chain supply mismatch"],
    firstChecks: ["resolve CDP managers", "list collateral types/LTVs", "compare total debt vs token supply per chain"],
  },
  "lorenzo-susd1+": {
    rank: 2,
    why: "Extreme 7d growth stable-yield vault surface with zero DeFiLlama audit count.",
    bugClasses: ["ERC4626/share-price rounding", "donation inflation", "strategy NAV staleness", "minter role errors"],
    firstChecks: ["resolve vault/minter contracts", "query totalAssets/totalSupply/convertToAssets", "inspect roles/pauses/strategy adapters"],
  },
  "usd-ai": {
    rank: 3,
    why: "RWA lending on Arbitrum with material borrowed side and NAV-style valuation assumptions.",
    bugClasses: ["NAV staleness", "redemption queue insolvency", "credit pool accounting", "oracle authority drift"],
    firstChecks: ["resolve vault/minter/redemption contracts", "check NAV update authority/freshness", "list borrower pools and pause/caps"],
  },
  "derive-v2": {
    rank: 4,
    why: "Multi-chain derivatives/options surface with weak DeFiLlama audit signal and complex margin/oracle logic.",
    bugClasses: ["margin/liquidation math", "oracle settlement", "subaccount isolation", "expiry/funding edge cases"],
    firstChecks: ["map clearinghouse/margin/oracle contracts", "inspect account health formulas", "list markets and mark/index paths"],
  },
  solstice: {
    rank: 5,
    why: "High-growth Solana basis-trading/stablecoin surface, less locally saturated than Kamino/Jupiter/Drift.",
    bugClasses: ["PDA/account constraint gaps", "oracle trust/freshness", "mint/redeem accounting", "withdrawal queue edge cases"],
    firstChecks: ["fetch program IDs and upgrade authority", "inspect IDL/source availability", "enumerate custody/mint/oracle accounts"],
  },
  xstocks: {
    rank: 6,
    why: "Fast-growing tokenized equity/RWA surface on Solana and Arbitrum with bridge/wrapper accounting risk.",
    bugClasses: ["mint/burn authority gaps", "stale equity pricing", "wrapper supply mismatch", "token account spoofing"],
    firstChecks: ["map token mints/authorities", "check freeze/update authorities", "compare Solana and Arbitrum supplies"],
  },
  "ethena-usde": {
    rank: 7,
    why: "Very high TVL and complex mint/redeem/staking/custody paths; lower novelty but high ceiling.",
    bugClasses: ["signer limit drift", "cooldown accounting", "collateral ratio/oracle drift", "wrapper supply mismatch"],
    firstChecks: ["check minter config and delegated signer limits", "query sUSDe share invariants", "inspect mint/redeem caps"],
  },
  "sky-lending": {
    rank: 8,
    why: "Massive CDP TVL with growth; overlaps Spark/Sky but profitable if module config drift exists.",
    bugClasses: ["oracle/governance delay assumptions", "PSM/savings-rate accounting", "ilk param drift", "module authorization drift"],
    firstChecks: ["compare deployed modules to changelog", "query ilks/debt ceilings/oracles", "inspect ward/pause permissions"],
  },
  infinifi: {
    rank: 9,
    why: "Novel Ethereum yield/banking architecture with source-likely contract surface and meaningful TVL.",
    bugClasses: ["share accounting", "liquidity bucket mismatch", "withdrawal queue race", "strategy valuation drift"],
    firstChecks: ["identify vault/strategy contracts", "compare totalAssets to liabilities", "inspect roles/caps/strategy adapters"],
  },
  "bouncebit-cedefi-yield": {
    rank: 10,
    why: "Cross-chain CeDeFi/basis-yield wrapper with zero DeFiLlama audit count and EVM/Solana exposure.",
    bugClasses: ["mint/redeem accounting", "custody proof freshness", "share-price drift", "cross-chain wrapper supply mismatch"],
    firstChecks: ["resolve wrapper/vault contracts", "compare token supply across chains", "inspect mint/redeem caps and custody/oracle roles"],
  },
};

const TRADE_PATTERNS = [
  {
    rank: 1,
    pattern: "Uniswap v4 PoolManager/ERC-6909 internal-balance sandwich detection",
    why: "Transfer-log-only detectors miss parked balances and internal state flips.",
    nextCheck: "Scan v4 pools/hooks for high internal-balance turnover and low observable ERC20 transfer deltas.",
  },
  {
    rank: 2,
    pattern: "Lending liquidation routing with exact-denom repayment",
    why: "Volatility creates repeatable liquidation value when repay sourcing and collateral exit routing are fragmented.",
    nextCheck: "Prioritize protocols where liquidation eligibility and seize pricing use different oracle/status paths.",
  },
  {
    rank: 3,
    pattern: "Oracle/share-rate manipulation in correlated assets",
    why: "LST/LRT/ERC4626 exchange-rate paths remain high-impact when caps, snapshots, or staleness checks are weak.",
    nextCheck: "Map convertToAssets/share-rate feeds that directly determine borrow capacity or liquidation eligibility.",
  },
  {
    rank: 4,
    pattern: "Stablecoin/depeg aggregator failure routes",
    why: "Quote/slippage fallback behavior can diverge from user or protocol assumptions during depegs.",
    nextCheck: "Compare aggregator quote paths to direct DEX liquidity under simulated depeg/slippage stress.",
  },
  {
    rank: 5,
    pattern: "Passive stale limit-order self-arbitrage",
    why: "Overlapping fillable orders from the same or related wallets can expose low-risk bot flips.",
    nextCheck: "Scan public limit-order books for same-owner crossed prices and stale approvals.",
  },
  {
    rank: 6,
    pattern: "Solana triangular arbitrage around Jito bundles",
    why: "Raydium/Orca routes can be profitable but tip competition consumes most edge.",
    nextCheck: "Monitor high-volume SOL/USDC/meme routes and estimate tip-adjusted net profit from recent blocks.",
  },
];

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 15000);
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "evm-audit-target-discovery/1.0" },
      redirect: "follow",
      signal: controller.signal,
      ...options,
    });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

function decodeXmlText(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#8217;/g, "'")
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function textBetween(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? decodeXmlText(m[1]).trim() : null;
}

function parseRssItems(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((m) => {
    const item = m[1];
    return {
      title: textBetween(item, "title"),
      description: textBetween(item, "description"),
      link: textBetween(item, "link"),
      pubDate: textBetween(item, "pubDate"),
    };
  });
}

function chainScore(chains) {
  const names = (chains || []).join("|");
  let score = 0;
  if (/Ethereum|Base|Arbitrum|Optimism|Avalanche|Binance|BNB|Sonic|Mantle|Berachain|Unichain|Ink/i.test(names)) score += 10;
  if (/Solana|Sui|Aptos|Stellar|Hyperliquid/i.test(names)) score += 5;
  if (/Sonic|Berachain|Mantle|Hyperliquid|Solana/i.test(names)) score += 4;
  return score;
}

function categoryScore(category) {
  return {
    Lending: 14,
    "RWA Lending": 14,
    CDP: 13,
    Derivatives: 10,
    "Basis Trading": 10,
    Yield: 8,
    "Yield Aggregator": 8,
    RWA: 8,
    Dexs: 6,
    "Liquid Staking": 5,
    "Liquid Restaking": 5,
  }[category] || 0;
}

function scoreProtocol(p) {
  const tvlScore = Math.log10(Math.max(Number(p.tvl || 0), 1)) * 8;
  const growth = Number.isFinite(Number(p.change_7d)) ? Number(p.change_7d) * 0.45 : 0;
  const auditBonus = Number(p.audits || 0) === 0 ? 8 : 0;
  const excludedPenalty = WORKSPACE_EXCLUSIONS.has(p.slug) ? -80 : 0;
  return tvlScore + growth + categoryScore(p.category) + chainScore(p.chains) + auditBonus + excludedPenalty;
}

async function main() {
  const protocols = await (await fetchWithTimeout("https://api.llama.fi/protocols")).json();
  const bySlug = new Map(protocols.map((p) => [p.slug, p]));

  const selectedTargets = SELECTED_SLUGS.map((slug) => {
    const p = bySlug.get(slug) || { slug, name: slug };
    const notes = TARGET_NOTES[slug] || {};
    return {
      rank: notes.rank,
      name: p.name,
      slug,
      category: p.category,
      tvlUsd: p.tvl,
      change7d: p.change_7d,
      audits: p.audits,
      chains: p.chains || [],
      score: Number(scoreProtocol(p).toFixed(2)),
      why: notes.why,
      bugClasses: notes.bugClasses || [],
      firstChecks: notes.firstChecks || [],
    };
  }).sort((a, b) => a.rank - b.rank);

  const rankedPublicCandidates = protocols
    .filter((p) => Number(p.tvl || 0) >= 30_000_000 && ALLOWED_CATEGORIES.has(p.category))
    .map((p) => ({
      name: p.name,
      slug: p.slug,
      category: p.category,
      tvlUsd: p.tvl,
      change7d: p.change_7d,
      audits: p.audits,
      chains: p.chains || [],
      excludedByWorkspace: WORKSPACE_EXCLUSIONS.has(p.slug),
      score: Number(scoreProtocol(p).toFixed(2)),
    }))
    .filter((p) => !p.excludedByWorkspace)
    .sort((a, b) => b.score - a.score)
    .slice(0, 40);

  let rssItems = [];
  let archiveItems = [];
  const endpointChecks = [];

  for (const url of [
    "https://eigenphi.substack.com/feed",
    "https://eigenphi.substack.com/archive",
    "https://eigenphi.substack.com/sitemap.xml",
    "https://eigenphi.substack.com/api/v1/archive?sort=new&search=&offset=0&limit=40",
    "https://api.eigenphi.io/api/v1/mev/top",
    "https://tx.eigenphi.io",
  ]) {
    try {
      const res = await fetchWithTimeout(url, { timeoutMs: 10000 });
      endpointChecks.push({ url, status: res.status, ok: res.ok, finalUrl: res.url });
      const ct = res.headers.get("content-type") || "";
      if (url.endsWith("/feed")) {
        rssItems = parseRssItems(await res.text()).slice(0, 30);
      } else if (url.includes("/api/v1/archive") && ct.includes("application/json")) {
        const data = await res.json();
        archiveItems = (Array.isArray(data) ? data : data.posts || []).slice(0, 40).map((x) => ({
          title: x.title,
          subtitle: x.subtitle || x.description || null,
          postDate: x.post_date || x.postDate || x.date || null,
          canonicalUrl: x.canonical_url || x.canonicalUrl || x.url || null,
        }));
      }
    } catch (e) {
      endpointChecks.push({ url, ok: false, error: e.name || e.message || String(e) });
    }
  }

  const artifact = {
    generatedAt: new Date().toISOString(),
    mode: "public-readonly-research",
    safety: {
      rpcInventoryRead: false,
      rpcUrlsStored: false,
      signedActions: false,
    },
    sources: [
      "https://api.llama.fi/protocols",
      "https://eigenphi.substack.com/feed",
      "https://eigenphi.substack.com/archive",
      "https://eigenphi.substack.com/sitemap.xml",
      "https://eigenphi.substack.com/api/v1/archive?sort=new&search=&offset=0&limit=40",
    ],
    defillama: {
      totalProtocols: protocols.length,
      selectedTargets,
      rankedPublicCandidates,
    },
    eigenphi: {
      endpointChecks,
      recentRssItems: rssItems,
      recentArchiveItems: archiveItems,
      protocolsMentionedByResearch: [
        "Uniswap v4",
        "Curve",
        "PancakeSwap v3",
        "DODO",
        "KyberSwap",
        "0x",
        "1inch",
        "Bebop",
        "Raydium",
        "Orca",
        "Aave V2",
        "Lodestar",
        "GMX",
        "GLP",
        "PlutusDAO",
        "Jito",
      ],
      tradePatterns: TRADE_PATTERNS,
    },
  };

  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(artifact, null, 2) + "\n");
  console.log(`wrote ${OUT}`);
  console.log(`selectedTargets=${selectedTargets.length} rankedPublicCandidates=${rankedPublicCandidates.length} rssItems=${rssItems.length}`);
}

main().catch((e) => {
  console.error(e.stack || e.message || String(e));
  process.exitCode = 1;
});
