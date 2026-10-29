#!/usr/bin/env node
// Local sanitized consumer-join pass for top new DeFiLlama candidate addresses.
// Does not read RPC endpoint files, env files, private keys, or external state.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const IN = path.join(WORKSPACE, "reports", "raw", "fast", "defillama-top-new-deep-dive.json");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "defillama-top-new-consumer-joins.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "defillama-top-new-consumer-joins.md");
const QUIET = process.argv.includes("--quiet");

const EXCLUDE_FILES = new Set([
  "reports/raw/fast/defillama-top-new-deep-dive.json",
  "reports/defillama-top-new-deep-dive.md",
  "reports/raw/fast/defillama-oracle-classifier.json",
  "reports/raw/fast/prefilter-deep-new-target-search-2026-06-24.json",
  "reports/prefilter-deep-new-target-search-2026-06-24.md",
]);

const CONSUMER_PATH_RE = /(morpho|aave|euler|silo|venus|compound|llamalend|bend|moonwell|benqi|fluid|lending|borrow|collateral|liquidat|oracle|consumer|join|route)/i;
const ROUTE_POSITIVE_RE = /"routePositive"\s*:\s*(true|[1-9])|routePositive=([1-9])/i;

function readJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function rel(file) {
  return path.relative(WORKSPACE, file).replace(/\\/g, "/");
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

function candidateFiles() {
  const reports = listFiles(path.join(WORKSPACE, "reports"), (file) => /\.(json|md)$/i.test(file));
  return reports
    .filter((file) => !rel(file).includes("/raw/slow/"))
    .filter((file) => !EXCLUDE_FILES.has(rel(file)))
    .filter((file) => {
      try { return fs.statSync(file).size <= 12_000_000; } catch (_) { return false; }
    });
}

function lineFor(text, needle) {
  const idx = text.indexOf(needle);
  if (idx < 0) return null;
  return text.slice(0, idx).split("\n").length;
}

function rowSummary(row, files) {
  const addresses = [...new Set((row.adapter?.addresses || []).map((address) => String(address).toLowerCase()))];
  const matches = [];
  for (const address of addresses) {
    for (const file of files) {
      const relative = rel(file);
      let text;
      try { text = fs.readFileSync(file, "utf8"); } catch (_) { continue; }
      const lower = text.toLowerCase();
      if (!lower.includes(address)) continue;
      const consumerLikely = CONSUMER_PATH_RE.test(relative);
      matches.push({
        address,
        file: relative,
        line: lineFor(lower, address),
        consumerLikely,
        routePositiveMention: ROUTE_POSITIVE_RE.test(text),
      });
    }
  }
  const matchedAddresses = [...new Set(matches.map((match) => match.address))];
  const consumerLikelyMatches = matches.filter((match) => match.consumerLikely);
  return {
    slug: row.slug,
    name: row.name,
    category: row.category,
    surface: row.surface,
    addresses: addresses.length,
    matchedAddresses: matchedAddresses.length,
    totalMatches: matches.length,
    consumerLikelyMatches: consumerLikelyMatches.length,
    routePositiveMentions: matches.filter((match) => match.routePositiveMention).length,
    routePositive: false,
    watchCandidate: false,
    blocker: consumerLikelyMatches.length
      ? "Address appears in local route/consumer artifacts, but this pass did not prove current accepted-value divergence, material borrow/redeem path, exact economics, or fork proof."
      : "No adapter-extracted address joined to local lending/oracle/consumer route artifacts.",
    matches: matches.slice(0, 80),
  };
}

function renderReport(artifact) {
  const rows = artifact.rows.map((row) => `| ${row.name} | ${row.addresses} | ${row.matchedAddresses} | ${row.consumerLikelyMatches} | ${row.routePositiveMentions} | ${row.watchCandidate ? "yes" : "no"} |`).join("\n");
  const details = artifact.rows.map((row) => {
    const lines = row.matches.slice(0, 8).map((match) => `- \`${match.address}\` in \`${match.file}:${match.line || "?"}\`${match.consumerLikely ? " (consumer-like)" : ""}`);
    return [`### ${row.name}`, "", row.blocker, "", ...(lines.length ? lines : ["- No local address matches."]), ""].join("\n");
  }).join("\n");
  return [
    "# DeFiLlama Top New Consumer Joins",
    "",
    `Date: ${artifact.generatedAt.slice(0, 10)}`,
    "",
    "## Result",
    "",
    `Checked ${artifact.summary.addressesChecked} adapter-extracted addresses from ${artifact.summary.targets} top-new targets against local sanitized route artifacts. Watch candidates: ${artifact.summary.watchCandidates}. Route-positive rows: ${artifact.summary.routePositive}.`,
    "",
    "## Summary",
    "",
    "| Target | Addresses | Matched Addresses | Consumer-Like Matches | Route-Positive Mentions | Watch |",
    "| --- | ---: | ---: | ---: | ---: | --- |",
    rows || "| n/a | 0 | 0 | 0 | 0 | no |",
    "",
    "## Details",
    "",
    details,
    "## Gate",
    "",
    "A local address match is only context. Escalation requires a current consumer join with material borrow/redeem/liquidation/unlock liquidity, accepted-value divergence versus realizable value, exact positive economics, and fork proof.",
    "",
  ].join("\n");
}

function main() {
  const input = readJson(IN, { rows: [] });
  const files = candidateFiles();
  const rows = (input.rows || []).map((row) => rowSummary(row, files));
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-defillama-top-new-consumer-joins.js",
    scope: "Local sanitized address-to-consumer join for top new DeFiLlama candidates",
    safety: {
      publicApisOnly: false,
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
    input: "reports/raw/fast/defillama-top-new-deep-dive.json",
    filesSearched: files.length,
    summary: {
      targets: rows.length,
      addressesChecked: rows.reduce((sum, row) => sum + row.addresses, 0),
      targetsWithMatches: rows.filter((row) => row.matchedAddresses > 0).length,
      targetsWithConsumerLikeMatches: rows.filter((row) => row.consumerLikelyMatches > 0).length,
      watchCandidates: 0,
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      status: "no-route-positive-consumer-join",
    },
    rows,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`);
  fs.writeFileSync(REPORT_OUT, renderReport(artifact));
  if (!QUIET) {
    console.log(`Top-new consumer joins: targets=${rows.length} matches=${artifact.summary.targetsWithMatches} routePositive=0`);
    console.log(`Artifact: ${rel(OUT)}`);
  }
}

main();
