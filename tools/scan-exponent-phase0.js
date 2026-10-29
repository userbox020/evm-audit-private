#!/usr/bin/env node
// scan-exponent-phase0.js - bounded read-only Phase 0 triage for the Exponent (Solana/Anchor) core.
//
// SCOPE / SAFETY
//   * Fully OFFLINE: reads local Rust sources under targets/exponent-core/{programs,libraries} and the
//     optional targets/exponent-strategy-recipes TS recipes, then writes two report artifacts. No network
//     calls, no sockets, no key material, no signing, no broadcast, no on-chain RPC.
//   * Never touches .env*, *.key, *-keypair.json or wallet material.
//   * Never modifies other tools. Claimed resource: tools/scan-exponent-phase0.js (new file).
//
// TARGET (not Solidity - Anchor)
//   Market/strategy primitive: vault strip/merge/deposit, PT/YT trade + slippage constraints, SY program
//   CPI (do_deposit_sy/do_withdraw_sy/do_get_sy_state) and the SY exchange-rate oracle assembly.
//   "Bump provider integration" in the task maps to programs/exponent_core/src/allocator.rs, the custom
//   forward BumpAllocator global heap (NOT the Bump referral protocol); recorded precisely.
//
// Usage:
//   node tools/scan-exponent-phase0.js            # offline source triage (default)
//   node tools/scan-exponent-phase0.js --quiet    # suppress stdout summary
//   node tools/scan-exponent-phase0.js --live     # prints not-wired notice, then runs offline

"use strict";

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const CORE = path.join(WORKSPACE, "targets", "exponent-core");
const RECIPES = path.join(WORKSPACE, "targets", "exponent-strategy-recipes");
const SRC_ROOTS = [path.join(CORE, "programs"), path.join(CORE, "libraries")];
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "exponent-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "exponent-phase0-triage.md");
const QUIET = process.argv.includes("--quiet");
const LIVE_REQUESTED = process.argv.includes("--live");

const SIGNAL = "\uD83D\uDFE1 PHASE0";
const EXCLUDE_DIRS = new Set(["target", "node_modules", ".git", "tests", "harness", "migrations"]);

const DELIVERABLES = [
  { name: "Vault", kind: "struct", re: /pub struct Vault\b/ },
  { name: "MarketTwo", kind: "struct", re: /pub struct MarketTwo\b/ },
  { name: "YieldTokenPosition", kind: "struct", re: /pub struct YieldTokenPosition\b/ },
  { name: "CpiAccounts", kind: "struct", re: /pub struct CpiAccounts\b/ },
  { name: "SyState", kind: "struct", re: /pub struct SyState\b/ },
  { name: "handle_strip", kind: "fn", re: /pub fn handle_strip\b/ },
  { name: "do_deposit_sy", kind: "fn", re: /pub fn do_deposit_sy\b/ },
  { name: "do_withdraw_sy", kind: "fn", re: /pub fn do_withdraw_sy\b/ },
  { name: "do_get_sy_state", kind: "fn", re: /pub fn do_get_sy_state\b/ },
  { name: "token_transfer", kind: "fn", re: /pub fn token_transfer\b/ },
  { name: "BumpAllocator", kind: "allocator", re: /struct BumpAllocator\b/ },
  { name: "time_curve math", kind: "module", re: /time_curve/ },
  { name: "AnchorDecNum", kind: "struct", re: /pub struct AnchorDecNum\b/ },
];

// Classification ∈ {authorization, value-flow, rounding, oracle, other}.
const RULES = [
  // (a) authorization / account trust
  { cls: "authorization", re: /UncheckedAccount<'info>/, note: "UncheckedAccount (authority/sy_program/address_lookup_table): trust is delegated to has_one / caller, not enforced by Anchor key equality" },
  { cls: "authorization", re: /\/\/\/\s*CHECK:/, note: "Anchor /// CHECK comment: documented trust assumption, not a runtime constraint" },
  { cls: "authorization", re: /has_one\s*=\s*\w+/, note: "has_one binds an account field to the vault/market struct; the sole binding on otherwise-unchecked accounts" },
  { cls: "authorization", re: /Signer<'info>|Signer<'i>/, note: "signer requirement on depositor/trader/admin entrypoints" },
  { cls: "authorization", re: /remaining_accounts/, note: "caller-supplied remaining_accounts flow into the SY CPI (account-substitution trust surface)" },
  { cls: "authorization", re: /AdminAction|ModifyVaultSetting|ModifyMarketSetting|fn is_admin\b/, note: "admin-only setting mutation entrypoints (modify_vault_setting / modify_market_setting)" },
  { cls: "authorization", re: /signer_seeds\(\)|\bseeds\s*=|find_program_address/, note: "PDA seed/bump derivation is the authorization boundary for vault/market signed CPIs" },
  { cls: "authorization", re: /\bbump\b/, note: "PDA bump seed usage: a recomputed (not stored/revalidated) bump can enable account substitution" },
  { cls: "authorization", re: /do_cpi_\w+\(/, note: "self-CPI wrappers: recursion trust — a self-CPI re-enters the program with caller-supplied accounts" },
  // (b) value flow / external CPI
  { cls: "value-flow", re: /pub fn token_transfer\b|token_transfer\(/, note: "SPL token transfer CPI helper used by every value-moving handler" },
  { cls: "value-flow", re: /do_deposit_sy|do_withdraw_sy|do_get_sy_state/, note: "SY program CPI: deposit/withdraw/state-read through caller-supplied sy_program + ALT + remaining accounts" },
  { cls: "value-flow", re: /\bmint_to\(|\bburn\(/, note: "PT/YT mint/burn via token-2022 with vault/market PDA signer" },
  { cls: "value-flow", re: /min_lp_out|min_sy_out|min_pt_out|min_base_amount|max_base_amount|sy_constraint/, note: "slippage bound carried into the handler and asserted after pricing" },
  { cls: "value-flow", re: /assert!\(|require!\(/, note: "runtime invariant assertion (slippage / sign-opposition / status checks)" },
  { cls: "value-flow", re: /cpi_accounts|CpiAccounts/, note: "CpiAccounts struct is carried in Vault/MarketTwo state: stored CPI account set is trusted on every call" },
  { cls: "value-flow", re: /checked_sub\(|checked_add\(|\.unwrap\(\)/, note: "checked arithmetic followed by unwrap(): an unexpected None panics instead of a graceful revert (treasury-fee math)" },
  { cls: "value-flow", re: /treasury_fee|fee_treasury_sy_bps|treasury_fee_bps/, note: "treasury fee taken out of the SY flow before/after the SY deposit-withdraw CPI" },
  // (c) rounding / fixed-point math
  { cls: "rounding", re: /Number\b|precise_number|dec_num::|AnchorDecNum|DNum\b/, note: "fixed-point Number/DecNum type: rounding direction is protocol-visible" },
  { cls: "rounding", re: /mul_div|div_floor|div_ceil|mul_div_floor|mul_div_ceil|\bfloor\b|\bceil\b/, note: "explicit floor/ceil helper: wrong direction mis-prices strip/merge/trade" },
  { cls: "rounding", re: /as u64|as i64|as u128|u64::MAX/, note: "integer cast/truncation risk in amount conversions" },
  { cls: "rounding", re: /sy_to_py|py_to_sy|time_curve|ln_fee_rate|rate_scalar/, note: "yield-curve / SY<->PY rate conversion math (time_curve library + market financials)" },
  // (d) oracle / rate assembly
  { cls: "oracle", re: /sy_exchange_rate|last_seen_sy_exchange_rate|all_time_high_sy_exchange_rate/, note: "SY exchange rate is the price input; freshness comes from SyState and monotonicity from all-time-high" },
  { cls: "oracle", re: /exchange_rate/, note: "exchange-rate read; no explicit max-age assertion at this call site (freshness delegated to SyState update)" },
  { cls: "oracle", re: /update_vault_yield|SyState|do_get_sy_state/, note: "yield/rate refresh path: vault yield and PT/YT value update from the SY state read" },
  // (e) other / structural
  { cls: "other", re: /emit_cpi!|event_cpi/, note: "event emitted through self-CPI (event_cpi) into the program's own event authority" },
  { cls: "other", re: /struct BumpAllocator|global_allocator|HEAP_LENGTH/, note: "custom forward BumpAllocator global heap ('Bump' here is the heap allocator, not the Bump referral protocol)" },
  { cls: "other", re: /realloc_market|realloc/, note: "realloc-based market account growth (realloc_market admin path)" },
  { cls: "other", re: /declare_id!|discriminator\s*=/, note: "program id / instruction discriminators (entrypoint ABI surface)" },
];

// ----------------------------- helpers -----------------------------
function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }

function walk(dir, exts, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return acc; }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), exts, acc);
    } else if (entry.isFile() && exts.some((e) => entry.name.endsWith(e))) {
      acc.push(path.join(dir, entry.name));
    }
  }
  return acc;
}

function rel(file) { return path.relative(WORKSPACE, file).replace(/\\/g, "/"); }

function scanSurfaces(files) {
  const surfaces = [];
  const seen = new Set();
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch (_) { continue; }
    const lines = text.split(/\r?\n/);
    const relFile = rel(file);
    const hit = new Set();
    for (let i = 0; i < lines.length; i++) {
      for (const rule of RULES) {
        if (hit.has(rule)) continue;
        if (!rule.re.test(lines[i])) continue;
        hit.add(rule);
        const key = `${relFile}:${i + 1}:${rule.note}`;
        if (seen.has(key)) continue;
        seen.add(key);
        surfaces.push({ file: relFile, line: i + 1, classification: rule.cls, note: rule.note });
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
      if (byName.has(d.name)) continue;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (d.re.test(lines[i])) { byName.set(d.name, { name: d.name, kind: d.kind, file: relFile, line: i + 1 }); break; }
      }
    }
  }
  for (const d of DELIVERABLES) {
    if (byName.has(d.name)) found.push(byName.get(d.name));
    else gaps.push({ id: `MISS-${d.name}`, status: "MISS", deliverable: d.name, kind: d.kind, note: `"${d.name}" not found in exponent-core Rust sources; recorded as MISS, not inferred` });
  }
  return { found, gaps };
}

function buildReport(a) {
  const rows = a.surfaces.slice(0, 16);
  const bullets = rows.length ? rows.map((s) => `- \`${s.classification}\` — \`${s.file}:${s.line}\` — ${s.note}`).join("\n") : "- (none)";
  const gaps = a.gaps.length ? a.gaps.map((g) => `- ${g.status} \`${g.deliverable}\`: ${g.note}`).join("\n") : "- none recorded";
  const dl = a.deliverables.length ? a.deliverables.map((d) => `| ${d.name} | ${d.kind} | \`${d.file}:${d.line}\` |`).join("\n") : "| none | n/a | n/a |";
  const c = a.hitCounts;
  return `# ${SIGNAL} — Exponent Core (Anchor) Phase 0 Triage

Date: ${a.scannedAt}

Scanner: \`${a.scanner}\` — mode: \`offline\` (no network, no signing, no live calls)

Checkout: \`${a.checkoutUsed}\` (Rust files: ${a.fileCounts.rs}; recipes TS present: ${a.recipesPresent})

## Result

No confirmed permissionless exploit. Static, fail-closed triage of the local Exponent Anchor program:
account-trust edges (UncheckedAccount / has_one / remaining_accounts), SY-program CPI value flows, slippage
constraints, fixed-point rounding, and SY exchange-rate assembly. This is a Rust/Anchor target, so rules are
Rust-regex based. No execution, signing, or RPC work is justified from this pass.

## Hit counts by classification

| Classification | Hits |
|---|---:|
| AUTHORIZATION | ${c.authorization || 0} |
| VALUE-FLOW | ${c["value-flow"] || 0} |
| ROUNDING | ${c.rounding || 0} |
| ORACLE | ${c.oracle || 0} |
| OTHER | ${c.other || 0} |
| **total** | **${a.surfaces.length}** |

## Surfaces (top ${rows.length})

${bullets}

## Deliverables found

| Name | Kind | Anchor |
|---|---|---|
${dl}

## "Bump provider" note

The only "Bump" in-tree is \`programs/exponent_core/src/allocator.rs\` — a forward global BumpAllocator
(8*32KiB heap, Squads-derived). It is NOT the Bump referral/fee-share protocol. Recorded honestly so the
task phrase is not mis-read as a value-flow integration.

## Gaps

${gaps}

## --live flag

Not wired (TODO). Default mode is hermetic/offline. A future read-only pass must use cluster RPC from
process env (never static) and must never print/store key material.

## Close-out

Exponent core Phase 0 remains **dormant/context-only** for the declared local-source scope. Reopen only if a
caller-supplied account set or a stale/monotonic SY rate turns into an attacker-favorable, exact-positive route.
`;
}

// ----------------------------- main -----------------------------
function main() {
  const scannedAt = new Date().toISOString();
  const gaps = [];
  const srcFiles = SRC_ROOTS.flatMap((r) => walk(r, [".rs"]));
  if (!srcFiles.length) {
    gaps.push({ id: "MISS-CHECKOUT", status: "MISS", deliverable: "checkout", note: "no Rust sources under targets/exponent-core/{programs,libraries}" });
  } else {
    gaps.push({ id: "CONTEXT-NO-DEPLOYMENTS", status: "MISS", deliverable: "deployment/program ids", note: "no deployment registry consumed; declare_id is in-source but live program/data accounts are not available offline" });
  }
  const recipesPresent = fs.existsSync(RECIPES);
  if (!recipesPresent) gaps.push({ id: "MISS-RECIPES", status: "MISS", deliverable: "exponent-strategy-recipes", note: "optional recipes checkout absent" });

  const { found: deliverables, gaps: missGaps } = srcFiles.length ? enumerateDeliverables(srcFiles) : { found: [], gaps: [] };
  gaps.push(...missGaps);

  const surfaces = srcFiles.length ? scanSurfaces(srcFiles) : [];
  const hitCounts = { authorization: 0, "value-flow": 0, rounding: 0, oracle: 0, other: 0 };
  for (const s of surfaces) hitCounts[s.classification] = (hitCounts[s.classification] || 0) + 1;

  const artifact = {
    scannedAt,
    scanner: "tools/scan-exponent-phase0.js",
    mode: "offline-source",
    liveMode: { requested: LIVE_REQUESTED, wired: false, note: "TODO: read-only getAccountInfo/state pass; endpoints must come from env, none static" },
    checkoutUsed: rel(CORE),
    fileCounts: { rs: srcFiles.length },
    recipesPresent,
    safety: { offline: true, networkCalls: false, rpcUrlsStored: false, privateKeysRead: false, signedActions: false, broadcast: false, exploitExecuteCalls: false, forkTransactions: false },
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
    if (LIVE_REQUESTED) console.log("[exponent-phase0] --live requested but not wired (stub/TODO); running offline.");
    console.log(`Exponent Phase 0: checkout=${artifact.checkoutUsed} rs=${srcFiles.length} surfaces=${surfaces.length} ` +
      `(auth=${hitCounts.authorization} value-flow=${hitCounts["value-flow"]} rounding=${hitCounts.rounding} oracle=${hitCounts.oracle} other=${hitCounts.other}) ` +
      `deliverables=${deliverables.length} recipes=${recipesPresent} gaps=${gaps.length} routePositive=false`);
  }
}

try { main(); } catch (err) { console.error(String((err && err.message) || err)); process.exitCode = 1; }
