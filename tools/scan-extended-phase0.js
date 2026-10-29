#!/usr/bin/env node
// scan-extended-phase0.js - bounded read-only Phase 0 triage for the Extended checkout
// (perp/DEX-style surface: margin state, liquidation/dispute windows, vault router).
//
// SCOPE / SAFETY
//   * Default mode is fully OFFLINE: this scanner only reads local sources under targets/extended
//     and writes two report artifacts. It performs NO network calls, opens no sockets, reads no key
//     material, signs nothing, and broadcasts nothing. It never touches .env*, *.key, *-keypair.json
//     or any wallet material.
//   * IMPORTANT / HONEST GAP: targets/extended is EMPTY in this workspace (0 entries, including
//     hidden files). There is no perp/DEX source to review. This scanner therefore fails closed:
//     it records MISS-CHECKOUT plus a MISS row for every declared deliverable and produces an
//     offline triage artifact that states the checkout is absent, rather than inventing rules hits.
//   * It never modifies other tools. Claimed resource: tools/scan-extended-phase0.js (new file).
//
// --live FLAG SEMANTICS (documented, NOT WIRED THIS REVISION)
//   A future `--live` mode would add a bounded READ-ONLY eth_call/eth_getCode pass over locally-known
//   perp/vault addresses. It is a STUB with an explicit TODO. NOT implemented; NO call is made in this
//   revision, so there is no endpoint to static-embed. If implemented, endpoints MUST come from
//   shared-rpc/env and must never print/store URLs.
//
// Usage:
//   node tools/scan-extended-phase0.js            # offline source triage (default)
//   node tools/scan-extended-phase0.js --quiet    # suppress stdout summary
//   node tools/scan-extended-phase0.js --live     # prints not-wired notice, then runs offline

"use strict";

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "extended-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "extended-phase0-triage.md");
const QUIET = process.argv.includes("--quiet");
const LIVE_REQUESTED = process.argv.includes("--live");

const SIGNAL = "\uD83D\uDFE1 PHASE0";

const CHECKOUT_CANDIDATES = [
  { id: "extended", dir: path.join(WORKSPACE, "targets", "extended") },
];

const EXCLUDE_DIRS = new Set(["lib", "out", "cache", "node_modules", ".git", "artifacts", "broadcast"]);
const SCAN_EXT = new Set([".sol"]);

// Deliverables the task calls out. With an empty checkout every one is a fail-closed MISS row.
const DELIVERABLES = [
  { name: "PerpEngine / ClearingHouse", kind: "contract", re: /\b(?:contract|abstract\s+contract)\s+(?:PerpEngine|ClearingHouse|Vault)\b/ },
  { name: "Margin state / account struct", kind: "struct", re: /\bstruct\s+(?:MarginAccount|Account|Position|Trader)\b/ },
  { name: "Liquidation entrypoint", kind: "function", re: /\bfunction\s+liquidate\w*\s*\(/ },
  { name: "Dispute / challenge window", kind: "logic", re: /dispute|challenge|fraudWindow|resolutionWindow/i },
  { name: "Vault router", kind: "contract", re: /\b(?:contract|library)\s+(?:VaultRouter|Router|OrderRouter)\b/ },
  { name: "Order / market structs", kind: "struct", re: /\bstruct\s+(?:Order|Market|MarketConfig)\b/ },
  { name: "Funding / funding-rate math", kind: "logic", re: /fundingRate|funding_rate|accruedFunding/ },
  { name: "Oracle / mark price", kind: "logic", re: /markPrice|indexPrice|getPrice|oracle/i },
];

// Risk rules kept for roster parity with the other three scanners; they cannot hit on an empty checkout.
// classification in { authorization, value-flow, rounding, oracle, other }.
const RULES = [
  { cls: "authorization", re: /\bonly(?:Owner|Admin|Role|Keeper|Governor)\b/, note: "role-gated administrative/keeper entrypoint" },
  { cls: "authorization", re: /hasRole\s*\(|isKeeper\b|whitelist/i, note: "keeper/allow-list authorization gate" },
  { cls: "authorization", re: /\bdelegatecall\b/, note: "delegatecall surface (router/plugin trust edge)" },
  { cls: "value-flow", re: /\bfunction\s+liquidate\w*\s*\(/, note: "liquidation entrypoint (margin state + collateral seizure)" },
  { cls: "value-flow", re: /\bfunction\s+(?:deposit|withdraw)\w*\s*\(/, note: "vault/router deposit-withdraw value path" },
  { cls: "value-flow", re: /safeTransfer(?:From)?\s*\(|\.call\{value:/, note: "token/native movement sink" },
  { cls: "value-flow", re: /settle|closePosition|forceClose/, note: "position settlement / forced close path" },
  { cls: "rounding", re: /mulDiv(?:Up)?\s*\(|RoundingUp|ceilDiv\s*\(/, note: "rounding-direction-sensitive math" },
  { cls: "rounding", re: /unchecked\s*\{|int128|uint128/, note: "unchecked math / narrow integer width on margin math" },
  { cls: "oracle", re: /latestRoundData|latestAnswer|IAggregator|Pyth/, note: "oracle read feeding mark/index price" },
  { cls: "oracle", re: /markPrice|indexPrice|fundingRate/, note: "mark/index/funding composition" },
  { cls: "other", re: /dispute|challenge|fraudWindow|resolutionWindow/i, note: "dispute/challenge timing window" },
  { cls: "other", re: /\bfunction\s+\w*(?:Order|Market)\w*\s*\(/, note: "order/market management surface" },
];

// ----------------------------- helpers -----------------------------
function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }

function walkSrc(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return acc; }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      walkSrc(path.join(dir, entry.name), acc);
    } else if (entry.isFile() && SCAN_EXT.has(path.extname(entry.name))) {
      acc.push(path.join(dir, entry.name));
    }
  }
  return acc;
}

function topLevelEntries(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).map((e) => e.name); } catch (_) { return null; }
}

function rel(file) { return path.relative(WORKSPACE, file).replace(/\\/g, "/"); }

function countCheckout(candidate) {
  const all = fs.existsSync(candidate.dir) ? walkSrc(candidate.dir) : [];
  const top = fs.existsSync(candidate.dir) ? topLevelEntries(candidate.dir) : null;
  return {
    id: candidate.id, dir: candidate.dir, exists: fs.existsSync(candidate.dir),
    srcSol: all.length, totalSol: all.length, topLevelCount: top ? top.length : 0, topLevel: top, srcFiles: all,
  };
}

function pickCheckout(counts) {
  const present = counts.filter((c) => c.exists && c.srcSol > 0);
  if (!present.length) return { chosen: null, counts, reason: "no checkout with .sol sources found (targets/extended is empty)" };
  return { chosen: present[0], counts, reason: `selected by .sol file count (${present[0].srcSol})` };
}

// ----------------------------- scanning -----------------------------
function scanSurfaces(files) {
  const surfaces = [];
  const seen = new Set();
  const add = (cls, file, line, note, rule) => {
    const key = `${file}:${line}:${rule}`;
    if (seen.has(key)) return;
    seen.add(key);
    surfaces.push({ file, line, classification: cls, note });
  };

  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch (_) { continue; }
    const lines = text.split(/\r?\n/);
    const relFile = rel(file);
    const ruleHit = new Set();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const rule of RULES) {
        if (!rule.re.test(line)) continue;
        if (ruleHit.has(rule)) break;
        ruleHit.add(rule);
        add(rule.cls, relFile, i + 1, rule.note, rule.note);
      }
    }
  }
  return surfaces;
}

function enumerateDeliverables(files) {
  const found = [];
  const gaps = [];
  const byName = new Map();
  for (const file of files) {
    let text = "";
    try { text = fs.readFileSync(file, "utf8"); } catch (_) { continue; }
    const relFile = rel(file);
    for (const d of DELIVERABLES) {
      if (!d.re.test(text) && !d.re.test(relFile)) continue;
      if (!byName.has(d.name)) {
        let line = 1;
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) { if (d.re.test(lines[i]) || d.re.test(relFile)) { line = i + 1; break; } }
        byName.set(d.name, { name: d.name, kind: d.kind, file: relFile, line });
      }
    }
  }
  for (const d of DELIVERABLES) {
    if (byName.has(d.name)) found.push(byName.get(d.name));
    else gaps.push({
      id: `MISS-${d.name}`, status: "MISS", deliverable: d.name, kind: d.kind,
      note: `declared deliverable "${d.name}" not found (targets/extended is empty); recorded as fail-closed MISS, not an error`,
    });
  }
  return { found, gaps };
}

// ----------------------------- report -----------------------------
function buildReport(artifact) {
  const rows = artifact.surfaces.slice(0, 16);
  const bulletRows = rows.length
    ? rows.map((s) => `- \`${s.classification}\` — \`${s.file}:${s.line}\` — ${s.note}`).join("\n")
    : "- (none) — checkout is empty; no risk-surface rows recorded";
  const gapRows = artifact.gaps.length
    ? artifact.gaps.map((g) => `- ${g.status} \`${g.deliverable ?? g.id}\`: ${g.note}`).join("\n")
    : "- none recorded";
  const deliverableRows = artifact.deliverables.length
    ? artifact.deliverables.map((d) => `| ${d.name} | ${d.kind} | \`${d.file}:${d.line}\` |`).join("\n")
    : "| none | n/a | n/a |";
  const c = artifact.hitCounts;
  const cand = artifact.fileCounts.candidates[0] || { exists: false, srcSol: 0, topLevelCount: 0 };

  return `# ${SIGNAL} — Extended Phase 0 Triage

Date: ${artifact.scannedAt}

Scanner: \`${artifact.scanner}\` — mode: \`offline\` (no network, no signing, no live calls this revision)

Checkout used: \`${artifact.checkoutUsed}\` (exists: ${cand.exists}; .sol files: ${cand.srcSol}; top-level entries: ${cand.topLevelCount})

## Result

**Checkout absent / partial.** \`targets/extended\` is empty in this workspace (0 entries, including
hidden files). There is no perp/DEX source to review, so no authorization, value-flow, rounding, or
oracle rule can be evaluated against real code. This pass **fails closed**: it emits MISS-CHECKOUT plus
a MISS row for every declared perp/DEX deliverable (engine/clearing house, margin state, liquidation
entrypoint, dispute/challenge window, vault router, order/market structs, funding math, oracle/mark
price). No execution, signing, or fork work is justified. This is a coverage gap to report upward, not
a clean result.

## Hit counts by classification

| Classification | Hits |
|---|---:|
| authorization | ${c["authorization"] || 0} |
| value-flow | ${c["value-flow"] || 0} |
| rounding | ${c.rounding || 0} |
| oracle | ${c.oracle || 0} |
| other | ${c.other || 0} |
| **total** | **${artifact.surfaces.length}** |

## Surfaces (top ${rows.length})

${bulletRows}

## Deliverables found

| Name | Kind | Anchor |
|---|---|---|
${deliverableRows}

## Gaps

${gapRows}

## --live flag

Not wired this revision (TODO). Default mode is hermetic/offline; no endpoint value exists anywhere static.
A future read-only live pass must resolve endpoints in memory via the existing shared-rpc pattern
(\`resolveRpcPool\`/\`rpcCall\`, env-backed) and must never print/store RPC URLs, calldata, or signed actions.

## Close-out

Extended Phase 0 triage is **blocked by missing source** (empty checkout). Reopen after populating
\`targets/extended\` with the perp/DEX sources; then re-run this scanner to evaluate the declared
authorization / margin-state / liquidation-window / vault-router roster against real code.
`;
}

// ----------------------------- main -----------------------------
function main() {
  const counts = CHECKOUT_CANDIDATES.map(countCheckout);
  const chosenInfo = pickCheckout(counts);
  const scannedAt = new Date().toISOString();
  const candidateInfo = counts[0];

  const gaps = [];
  const chosen = chosenInfo.chosen;
  const srcFiles = chosen ? chosen.srcFiles : [];

  if (!chosen) {
    gaps.push({
      id: "MISS-CHECKOUT", status: "MISS", deliverable: "checkout",
      note: `${rel(candidateInfo.dir)} is present but EMPTY (top-level entries: ${candidateInfo.topLevelCount}, .sol files: ${candidateInfo.srcSol}); no perp/DEX source is available to review`,
    });
  }

  const { found: deliverables, gaps: missGaps } = enumerateDeliverables(srcFiles);
  gaps.push(...missGaps);

  const surfaces = scanSurfaces(srcFiles);

  const hitCounts = { authorization: 0, "value-flow": 0, rounding: 0, oracle: 0, other: 0 };
  for (const s of surfaces) hitCounts[s.classification] = (hitCounts[s.classification] || 0) + 1;

  const checkoutUsed = chosen ? rel(chosen.dir) : "MISS";
  const fileCounts = {
    chosen: chosen ? { id: chosen.id, path: rel(chosen.dir), srcSol: chosen.srcSol, totalSol: chosen.totalSol, topLevelCount: chosen.topLevelCount } : null,
    candidates: counts.map((c) => ({ id: c.id, path: rel(c.dir), exists: c.exists, srcSol: c.srcSol, totalSol: c.totalSol, topLevelCount: c.topLevelCount, topLevel: c.topLevel })),
    selectionReason: chosenInfo.reason,
  };

  const artifact = {
    scannedAt,
    scanner: "tools/scan-extended-phase0.js",
    mode: "offline-source",
    partial: true,
    liveMode: { requested: LIVE_REQUESTED, wired: false, note: "TODO: read-only eth_call/eth_getCode pass; endpoints must come from shared-rpc/env, none static" },
    checkoutUsed,
    fileCounts,
    safety: {
      offline: true, networkCalls: false, rpcUrlsStored: false, privateKeysRead: false,
      signedActions: false, broadcast: false, exploitExecuteCalls: false, forkTransactions: false,
    },
    surfaces,
    hitCounts,
    deliverables,
    gaps,
    routePositive: false,
    executableNow: false,
    signedActionJustified: false,
  };

  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(artifact, null, 2)}\n`);
  fs.writeFileSync(REPORT_OUT, buildReport(artifact));

  if (!QUIET) {
    if (LIVE_REQUESTED) console.log("[extended-phase0] --live requested but not wired this revision (stub/TODO); running offline.");
    console.log(
      `Extended Phase 0: checkout=${checkoutUsed} (EMPTY: targets/extended has ${candidateInfo.topLevelCount} top-level entries) srcSol=0 surfaces=${surfaces.length} ` +
        `(auth=${hitCounts["authorization"]} value=${hitCounts["value-flow"]} rounding=${hitCounts.rounding} oracle=${hitCounts.oracle} other=${hitCounts.other}) ` +
        `deliverables=${deliverables.length} gaps=${gaps.length} routePositive=false`,
    );
  }
}

try {
  main();
} catch (err) {
  console.error(String((err && err.message) || err));
  process.exitCode = 1;
}
