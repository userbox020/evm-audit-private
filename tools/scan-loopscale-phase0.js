#!/usr/bin/env node
// scan-loopscale-phase0.js - bounded read-only Phase 0 triage for the LoopScale checkout
// (Solana node/liquidity-layer lending: Loop/Round builder, oracle composition, node graph).
//
// SCOPE / SAFETY
//   * Default mode is fully OFFLINE: this scanner only reads local Rust/JSON sources under
//     targets/loopscale and writes two report artifacts. It performs NO network calls, opens no
//     sockets, reads no key material, signs nothing, and broadcasts nothing. It never touches
//     .env*, *.key, *-keypair.json or any wallet material.
//   * IMPORTANT: the LoopScale on-chain program source is NOT present in this checkout. The
//     checkout holds (a) the generated IDL/client (instruction surface), (b) the LoopScale
//     dependency program graph (marginfi-v2, damm-v2, whirlpools, raydium-clmm, rwa-token,
//     transfer-hook) and (c) hack/ recovery harness. The missing core program source is recorded
//     as a fail-closed MISS gap, not inferred.
//   * It never modifies other tools. Claimed resource: tools/scan-loopscale-phase0.js (new file).
//
// --live FLAG SEMANTICS (documented, NOT WIRED THIS REVISION)
//   A future `--live` mode would add a bounded READ-ONLY getAccountInfo/getProgramAccounts pass to
//   confirm that locally-audited program state matches onchain deployments. It is a STUB with an
//   explicit TODO. NOT implemented; NO call is made in this revision, so there is no endpoint to
//   static-embed. If implemented, endpoints MUST come from shared-rpc/env and must never print/store URLs.
//
// Usage:
//   node tools/scan-loopscale-phase0.js            # offline source triage (default)
//   node tools/scan-loopscale-phase0.js --quiet    # suppress stdout summary
//   node tools/scan-loopscale-phase0.js --live     # prints not-wired notice, then runs offline

"use strict";

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "loopscale-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "loopscale-phase0-triage.md");
const QUIET = process.argv.includes("--quiet");
const LIVE_REQUESTED = process.argv.includes("--live");

const SIGNAL = "\uD83D\uDFE1 PHASE0";

const CHECKOUT_CANDIDATES = [
  { id: "loopscale", dir: path.join(WORKSPACE, "targets", "loopscale") },
];

// Restrict to the protocol-relevant sub-trees; skip the vendored Anchor framework, SDKs, tests.
const SCAN_ROOTS = [
  "program/marginfi-v2", "program/damm-v2", "program/whirlpools", "program/raydium-clmm",
  "program/rwa-token", "program/transfer-hook", "client", "hack",
];
const EXCLUDE_DIRS = new Set([
  ".git", "target", "node_modules", "tests", "test", "test_utils", "bench", "examples", "docker",
  "docs", ".github", "ts", "cli", "avm", ".cargo", ".vscode", ".autodoc", "anchor", "brick",
  "rust-sdk", "lang", "spl", "fuzz", "migrations",
]);
const SCAN_EXT = new Set([".rs", ".json"]);

// Deliverables the task calls out. Missing ones are recorded as MISS gaps (fail-closed).
const DELIVERABLES = [
  // Strict: requires BOTH an Anchor #[program] block and a `mod loopscale` crate module in the same
  // file, so comment/generated-client mentions do NOT count. Absent here -> fail-closed MISS.
  { name: "LoopScale core program source", kind: "rust", re: /\bmod\s+loopscale\b/, all: [/#\[program\]/] },
  { name: "LoopScale IDL (instruction surface)", kind: "json", re: /create_loan|liquidate_ledger|loopscale_idl\.json/ },
  { name: "marginfi-v2 bank accounting", kind: "rust", re: /asset_share_value|liability_share_value/ },
  { name: "marginfi-v2 liquidation", kind: "rust", re: /lending_account_liquidate|LiquidateEvent/ },
  { name: "marginfi-v2 risk engine / health", kind: "rust", re: /RiskEngine|check_account_init_health|HealthCache/ },
  { name: "marginfi-v2 bank oracle config", kind: "rust", re: /configure_bank_oracle|BankConfig|oracle_setup/ },
  { name: "damm-v2 cp-amm", kind: "rust", re: /declare_id!\("cpamdp/ },
  { name: "whirlpools CLMM", kind: "rust", re: /whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc/ },
  { name: "raydium-clmm", kind: "rust", re: /raydium.*clmm|amm_v3|personal_position_state/ },
  { name: "rwa-token policy engine", kind: "rust", re: /policy_engine|execute_transfer_hook/ },
  { name: "transfer-hook", kind: "rust", re: /TransferHook|transfer_hook_interface/ },
  { name: "hack recovery / CPI callback harness", kind: "rust", re: /LOOP_EXPLOITED|Exploit CPI callback/ },
];

// Risk rules: classification in { authorization, value-flow, rounding, oracle, other }.
// Each rule records the first matching line of a file once per (file, rule).
const RULES = [
  // (a) authorization / access control
  { cls: "authorization", re: /\bhas_one\s*=|\bowner\s*==\s*|constraint\s*=/, note: "Anchor account ownership / constraint checks (PDA + authority binding)" },
  { cls: "authorization", re: /Signer<|is_signer|\.is_signer\b/, note: "signer requirement on an account (missing signer = forged authority)" },
  { cls: "authorization", re: /\bauthority\b/, note: "authority field/param: gate that guards privileged state changes" },
  { cls: "authorization", re: /policy_engine|execute_transfer_hook|transfer_hook_interface::execute/, note: "transfer-hook policy engine = per-transfer authorization surface" },
  { cls: "authorization", re: /IdentityFilter|PolicyType|delegate\b/, note: "policy identity/delegate parameters (policy composition trust edge)" },
  { cls: "authorization", re: /\bseeds\s*=|\bbump\b|find_program_address/, note: "PDA seed derivation: wrong seeds let an attacker substitute accounts" },
  { cls: "authorization", re: /assert_eq!\(\s*ctx\.accounts\./, note: "runtime account-equality assertion tying caller to stored authority" },
  // (b) value flows
  { cls: "value-flow", re: /asset_share_value|liability_share_value/, note: "marginfi share accounting: asset/liability share value converts balances<->shares" },
  { cls: "value-flow", re: /lending_account_liquidate|liquidate_ledger|Liquidate/, note: "liquidation entrypoint / event (repay debt, seize collateral)" },
  { cls: "value-flow", re: /transfer_checked|token::transfer|spl_token::transfer|\btransfer\(/, note: "SPL token movement sink on value paths" },
  { cls: "value-flow", re: /flashloan|flash_loan|flashLoan/, note: "flashloan path: same-tx repayment invariant" },
  { cls: "value-flow", re: /create_loan|borrow_principal|repay_principal|deposit_collateral|withdraw_collateral/, note: "Loop/Round builder instruction surface from the IDL (loan lifecycle)" },
  { cls: "value-flow", re: /close_balance|realloc|handle_bankruptcy|Overliquidation/i, note: "balance close / realloc / bankruptcy paths (accounting teardown)" },
  { cls: "value-flow", re: /CPI|invoke\(|invoke_signed\(/, note: "cross-program invocation: trust edge to the callee program (node graph)" },
  // (c) rounding / math
  { cls: "rounding", re: /checked_mul|checked_div|checked_add|checked_sub/, note: "checked integer math on share/value accounting (rounding direction lives here)" },
  { cls: "rounding", re: /saturating_|wrapping_|unchecked_/, note: "saturating/wrapping arithmetic: silent clamp or overflow class" },
  { cls: "rounding", re: /\.floor\(\)|\.ceil\(\)|round\b/, note: "explicit floor/ceil rounding on decimal shares (0-floor near range edges)" },
  { cls: "rounding", re: /as u64|as u128|as i64|try_into\(\)/, note: "truncating numeric cast: precision/overflow loss between decimal widths" },
  { cls: "rounding", re: /PodDecimal|Decimal|WAD|BPS|PERCENT|_share_value/, note: "fixed-point/decimal representation feeding health and share math" },
  // (d) oracle inputs
  { cls: "oracle", re: /oracle_setup|oracle\s*:|bank_oracle|configure_bank_oracle/, note: "bank oracle configuration feeding risk-engine health" },
  { cls: "oracle", re: /Pyth|Switchboard|price_feed|feed_id|PriceFeed/, note: "oracle provider/feed binding (owner/feed-id validation)" },
  { cls: "oracle", re: /stale|max_age|max_age_secs|last_update|confidence|\bconf\b/, note: "staleness/confidence checks on oracle reads" },
  { cls: "oracle", re: /get_price|get_price_unchecked|price_from|load_price/, note: "oracle price load used for collateral valuation" },
  { cls: "oracle", re: /tick|sqrt_price|whirlpool.*price|TickArray/, note: "CLMM tick/sqrt-price maths contributing oracle composition" },
  // (e) other / protocol-specific
  { cls: "other", re: /lock_loan|unlock_loan|refinance_ledger|sell_ledger/, note: "protocol-specific loan lifecycle instructions (lock/unlock/refinance/sell)" },
  { cls: "other", re: /create_vault|update_vault|create_strategy|StakeEvent/, note: "vault/strategy surface (user vault LP accounting, rewards)" },
  { cls: "other", re: /create_timelock|execute_timelock|cancel_timelock/, note: "timelock admin surface (delayed privilege escalation)" },
  { cls: "other", re: /process_instruction|entrypoint!|#\[program\]/, note: "program entrypoint dispatch (anchor/pinocchio instruction router)" },
];

// ----------------------------- helpers -----------------------------
function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }

function walkSrc(root, acc = []) {
  if (!fs.existsSync(root)) return acc;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return acc; }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      walkSrc(path.join(root, entry.name), acc);
    } else if (entry.isFile() && SCAN_EXT.has(path.extname(entry.name))) {
      acc.push(path.join(root, entry.name));
    }
  }
  return acc;
}

function collectFiles(candidate) {
  const files = [];
  for (const sub of SCAN_ROOTS) walkSrc(path.join(candidate.dir, sub), files);
  return files;
}

function rel(file) { return path.relative(WORKSPACE, file).replace(/\\/g, "/"); }

function countCheckout(candidate) {
  const files = collectFiles(candidate);
  const rs = files.filter((f) => f.endsWith(".rs"));
  const json = files.filter((f) => f.endsWith(".json"));
  const roots = SCAN_ROOTS.filter((s) => fs.existsSync(path.join(candidate.dir, s)));
  return {
    id: candidate.id, dir: candidate.dir, exists: fs.existsSync(candidate.dir),
    srcSol: rs.length, totalSol: files.length, rust: rs.length, json: json.length,
    rootsPresent: roots, srcFiles: files,
  };
}

function pickCheckout(counts) {
  const present = counts.filter((c) => c.exists && c.srcSol > 0);
  if (!present.length) return { chosen: null, counts, reason: "no checkout with Rust/JSON sources found" };
  return { chosen: present[0], counts, reason: `selected LoopScale checkout (Rust ${present[0].rust}, JSON ${present[0].json})` };
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
      if (d.all && !d.all.every((rx) => rx.test(text))) continue;
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
      note: `declared deliverable "${d.name}" not found in scanned sources; recorded as MISS, not an error`,
    });
  }
  return { found, gaps };
}

// ----------------------------- report -----------------------------
function buildReport(artifact) {
  const rows = artifact.surfaces.slice(0, 16);
  const bulletRows = rows.length
    ? rows.map((s) => `- \`${s.classification}\` — \`${s.file}:${s.line}\` — ${s.note}`).join("\n")
    : "- (none) — no risk-surface rows recorded";
  const gapRows = artifact.gaps.length
    ? artifact.gaps.map((g) => `- ${g.status} \`${g.deliverable ?? g.id}\`: ${g.note}`).join("\n")
    : "- none recorded";
  const deliverableRows = artifact.deliverables.length
    ? artifact.deliverables.map((d) => `| ${d.name} | ${d.kind} | \`${d.file}:${d.line}\` |`).join("\n")
    : "| none | n/a | n/a |";
  const c = artifact.hitCounts;
  const fc = artifact.fileCounts.chosen || { srcSol: 0, rust: 0, json: 0 };

  return `# ${SIGNAL} — LoopScale Phase 0 Triage

Date: ${artifact.scannedAt}

Scanner: \`${artifact.scanner}\` — mode: \`offline\` (no network, no signing, no live calls this revision)

Checkout used: \`${artifact.checkoutUsed}\` (Rust files: ${fc.rust}; JSON: ${fc.json}; scanned roots: ${(fc.rootsPresent || []).join(", ")})

## Result

**Partial checkout.** The LoopScale core on-chain program source is NOT present locally: the checkout
holds only the generated IDL/client (instruction surface), the LoopScale dependency program graph
(marginfi-v2, damm-v2, whirlpools, raydium-clmm, rwa-token, transfer-hook) and a hack/ recovery
harness. This is a static, fail-closed triage of those available sources: Anchor account
authorization/signers, share accounting and liquidation (marginfi), oracle composition, and the IDL
instruction surface for the Loop/Round builder. The core Loop/Round builder logic is recorded as a
MISS gap rather than inferred. No execution, signing, or fork work is justified from this pass.

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

LoopScale Phase 0 triage remains **dormant/context-only** and **incomplete by construction** (core program
source absent). Reopen only after obtaining the LoopScale program source, or if a dependency program edge
(marginfi share/oracle, transfer-hook policy, IDL account substitution) turns into an attacker-favorable,
exact-positive route with fork/replay proof.
`;
}

// ----------------------------- main -----------------------------
function main() {
  const counts = CHECKOUT_CANDIDATES.map(countCheckout);
  const chosenInfo = pickCheckout(counts);
  const scannedAt = new Date().toISOString();

  const gaps = [];
  const chosen = chosenInfo.chosen;
  let srcFiles = [];
  if (!chosen) {
    gaps.push({ id: "MISS-CHECKOUT", status: "MISS", deliverable: "checkout", note: `no local LoopScale checkout found (looked for ${CHECKOUT_CANDIDATES.map((c) => rel(c.dir)).join(", ")})` });
  } else {
    srcFiles = chosen.srcFiles;
    gaps.push({
      id: "MISS-CORE-PROGRAM", status: "MISS", deliverable: "LoopScale core on-chain program source",
      note: "the LoopScale program crate is closed-source and absent from this checkout; only the generated IDL/client, dependency program graph, and hack/ recovery harness are present. Loop/Round builder logic is NOT statically reviewed here",
    });
    gaps.push({
      id: "CONTEXT-NO-DEPLOYMENTS", status: "MISS", deliverable: "program / account addresses",
      note: "checkout contains no deployment/address registry; live program IDs and account PDAs are not available locally",
    });
  }

  const { found: deliverables, gaps: missGaps } = chosen ? enumerateDeliverables(srcFiles) : { found: [], gaps: [] };
  gaps.push(...missGaps);

  const surfaces = chosen ? scanSurfaces(srcFiles) : [];

  const hitCounts = { authorization: 0, "value-flow": 0, rounding: 0, oracle: 0, other: 0 };
  for (const s of surfaces) hitCounts[s.classification] = (hitCounts[s.classification] || 0) + 1;

  const checkoutUsed = chosen ? rel(chosen.dir) : "MISS";
  const fileCounts = {
    chosen: chosen ? { id: chosen.id, path: rel(chosen.dir), srcSol: chosen.srcSol, totalSol: chosen.totalSol, rust: chosen.rust, json: chosen.json, rootsPresent: chosen.rootsPresent } : null,
    candidates: counts.map((c) => ({ id: c.id, path: rel(c.dir), exists: c.exists, srcSol: c.srcSol, totalSol: c.totalSol, rust: c.rust, json: c.json, rootsPresent: c.rootsPresent })),
    selectionReason: chosenInfo.reason,
  };

  const artifact = {
    scannedAt,
    scanner: "tools/scan-loopscale-phase0.js",
    mode: "offline-source",
    liveMode: { requested: LIVE_REQUESTED, wired: false, note: "TODO: read-only getAccountInfo/getProgramAccounts pass; endpoints must come from shared-rpc/env, none static" },
    checkoutUsed,
    partial: true,
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
    if (LIVE_REQUESTED) console.log("[loopscale-phase0] --live requested but not wired this revision (stub/TODO); running offline.");
    console.log(
      `LoopScale Phase 0: checkout=${checkoutUsed} (PARTIAL: core program source absent) rust=${chosen ? chosen.rust : 0} json=${chosen ? chosen.json : 0} surfaces=${surfaces.length} ` +
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
