#!/usr/bin/env node
// Read-only governance/listing proposal watch for collateral/oracle/LTV changes.
// Uses public Snapshot GraphQL only; no keys, no signed actions, no RPC secrets.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "governance-listing-watch.json");

const PROPOSALS_PER_SPACE = Number(process.env.GOV_LISTING_PROPOSALS_PER_SPACE || "25");
const ACTIVE_RECENT_DAYS = Number(process.env.GOV_LISTING_RECENT_DAYS || "45");
const SNAPSHOT_ENDPOINT = "https://hub.snapshot.org/graphql";

const SPACES = [
  { id: "aave.eth", protocol: "Aave" },
  { id: "compound-finance.eth", protocol: "Compound" },
  { id: "morpho.eth", protocol: "Morpho" },
  { id: "eulerdao.eth", protocol: "Euler" },
  { id: "silo-finance.eth", protocol: "Silo" },
  { id: "pendle-finance.eth", protocol: "Pendle" },
  { id: "venus-xvs.eth", protocol: "Venus" },
  { id: "yearn", protocol: "Yearn" },
  { id: "curve.eth", protocol: "Curve" },
  { id: "makerdao-ses.eth", protocol: "Sky/Maker" },
];

const KEYWORDS = [
  { key: "new collateral", weight: 20 },
  { key: "collateral", weight: 14 },
  { key: "ltv", weight: 14 },
  { key: "lltv", weight: 14 },
  { key: "loan-to-value", weight: 14 },
  { key: "borrow cap", weight: 12 },
  { key: "supply cap", weight: 10 },
  { key: "oracle", weight: 14 },
  { key: "price feed", weight: 12 },
  { key: "chainlink", weight: 8 },
  { key: "redstone", weight: 8 },
  { key: "list", weight: 10 },
  { key: "listing", weight: 10 },
  { key: "market", weight: 8 },
  { key: "pt-", weight: 12 },
  { key: "pendle", weight: 10 },
  { key: "erc4626", weight: 12 },
  { key: "vault", weight: 10 },
  { key: "silo", weight: 8 },
  { key: "evault", weight: 10 },
  { key: "pause", weight: 8 },
  { key: "risk parameter", weight: 10 },
  { key: "parameter", weight: 6 },
  { key: "timelock", weight: 8 },
];

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function round(value, decimals = 6) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 20_000);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function snapshotQuery(space) {
  const query = `query($space:String!, $first:Int!) {
    proposals(first:$first, skip:0, where:{space_in:[$space]}, orderBy:"created", orderDirection:desc) {
      id
      title
      body
      state
      start
      end
      created
      scores_total
      choices
      space { id }
    }
  }`;
  const json = await fetchJson(SNAPSHOT_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { space: space.id, first: PROPOSALS_PER_SPACE } }),
    timeoutMs: 30_000,
  });
  if (json.errors) throw new Error(json.errors[0]?.message || "Snapshot GraphQL error");
  return json.data?.proposals || [];
}

function containsAny(text, patterns) {
  const t = String(text || "").toLowerCase();
  return patterns.some((p) => t.includes(p));
}

function scoreProposal(space, proposal) {
  const now = Math.floor(Date.now() / 1000);
  const text = `${proposal.title || ""}\n${proposal.body || ""}`.toLowerCase();
  const matchedKeywords = [];
  let score = 0;
  for (const kw of KEYWORDS) {
    if (text.includes(kw.key)) {
      matchedKeywords.push(kw.key);
      score += kw.weight;
    }
  }
  const state = String(proposal.state || "").toLowerCase();
  const end = Number(proposal.end || 0);
  const created = Number(proposal.created || 0);
  const recent = created > 0 && now - created <= ACTIVE_RECENT_DAYS * 86400;
  const active = state === "active" || (Number(proposal.start || 0) <= now && end >= now);
  if (active) score += 20;
  if (recent) score += 8;
  if (containsAny(text, ["pt-", "pendle", "erc4626", "vault", "evault"])) score += 8;
  if (containsAny(text, ["increase", "raise", "enable", "list", "add"]) && containsAny(text, ["ltv", "collateral", "oracle", "market"])) score += 8;

  const watchCandidate = score >= 25 && (active || recent);
  return {
    protocol: space.protocol,
    space: space.id,
    id: proposal.id,
    title: proposal.title || null,
    state: proposal.state || null,
    start: proposal.start || null,
    end: proposal.end || null,
    created: proposal.created || null,
    createdIso: proposal.created ? new Date(Number(proposal.created) * 1000).toISOString() : null,
    active,
    recent,
    scoresTotal: round(proposal.scores_total, 6),
    matchedKeywords,
    listingRiskScore: Math.min(100, score),
    watchCandidate,
    routePositive: false,
    blockers: [
      watchCandidate ? "Governance/listing proposal needs on-chain target/config mapping" : "No active/recent high-signal listing keywords",
      "No live collateral consumer route economics",
      "No fork proof or exact config-choreography simulation",
    ],
    excerpt: String(proposal.body || "").replace(/\s+/g, " ").slice(0, 500),
  };
}

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const rows = [];
  const spaces = {};
  for (const space of SPACES) {
    try {
      const proposals = await snapshotQuery(space);
      const scored = proposals.map((proposal) => scoreProposal(space, proposal));
      rows.push(...scored);
      spaces[space.id] = { protocol: space.protocol, proposals: proposals.length, watchCandidates: scored.filter((r) => r.watchCandidate).length, ok: true };
    } catch (err) {
      spaces[space.id] = { protocol: space.protocol, proposals: 0, watchCandidates: 0, ok: false, error: err.message || String(err) };
    }
  }
  rows.sort((a, b) => Number(b.watchCandidate) - Number(a.watchCandidate) || Number(b.listingRiskScore) - Number(a.listingRiskScore) || Number(b.created || 0) - Number(a.created || 0));
  const watchRows = rows.filter((r) => r.watchCandidate);
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-governance-listing-watch.js",
    scope: "Read-only Snapshot governance/listing proposal watch for collateral/oracle/LTV changes",
    safety: {
      rpcInventoryRead: false,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: false,
      signedActionJustified: false,
    },
    thresholds: { proposalsPerSpace: PROPOSALS_PER_SPACE, recentDays: ACTIVE_RECENT_DAYS, watchScore: 25 },
    spaces,
    summary: {
      spacesScanned: SPACES.length,
      spacesOk: Object.values(spaces).filter((s) => s.ok).length,
      proposalsScored: rows.length,
      watchCandidates: watchRows.length,
      routePositive: 0,
      signedActionJustified: false,
      topScore: rows[0]?.listingRiskScore || 0,
      activeWatchCandidates: watchRows.filter((r) => r.active).length,
      recentWatchCandidates: watchRows.filter((r) => r.recent).length,
    },
    topRows: rows.slice(0, 30),
    rows,
    requiredForRoutePositive: [
      "proposal maps to a concrete on-chain collateral/listing/oracle/timelock action",
      "the target asset is low-TVL, manipulable, stale-priced, or otherwise misvalued",
      "borrow-side liquidity and exact acquisition/exit economics are positive",
      "local fork/config simulation proves extractable net value",
    ],
    nextReadOnlyStep: watchRows.length
      ? "Resolve top watch proposal into on-chain target addresses/config diffs, then run consumer/economics scanners for the affected assets."
      : "Keep as governance watch; no fork work without a concrete high-signal listing/config proposal.",
  };
  fs.writeFileSync(OUT, JSON.stringify(artifact, jsonReplacer, 2) + "\n");
  console.log(`Governance listing watch: proposals=${artifact.summary.proposalsScored} watch=${artifact.summary.watchCandidates} routePositive=0`);
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
