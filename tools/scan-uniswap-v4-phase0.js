#!/usr/bin/env node
// scan-uniswap-v4-phase0.js - bounded read-only Phase 0 triage for the Uniswap V4 core/hooks surface.
//
// SCOPE / SAFETY
//   * Default mode is fully OFFLINE: this scanner only reads local Solidity sources under
//     targets/uniswap-v4-core* and writes two report artifacts. It performs NO network calls,
//     opens no sockets, reads no key material, signs nothing, and broadcasts nothing.
//   * It never touches .env*, *.key, *-keypair.json or any wallet material.
//   * It never modifies other tools. Claimed resource: tools/scan-uniswap-v4-phase0.js (new file).
//
// --live FLAG SEMANTICS (documented, NOT WIRED THIS REVISION)
//   A future `--live` mode would add a bounded READ-ONLY eth_call/eth_getCode pass to confirm that
//   locally-audited bytecode matches onchain deployments (PoolManager proxies, hook addresses).
//   That mode is intentionally a STUB here with an explicit TODO. It is NOT implemented and NO
//   call is made in this revision, so there is no endpoint to static-embed.
//   If/when implemented, endpoints MUST NOT be hard-coded: they must be resolved in memory from the
//   existing shared RPC pattern (require("./shared-rpc").resolveRpcPool(...) / rpcCall(...)) backed
//   by process env, and must never print/store RPC URLs, calldata, or signed actions. This scanner
//   currently does not require shared-rpc at all, which keeps the default run hermetic and offline.
//
// Usage:
//   node tools/scan-uniswap-v4-phase0.js            # offline source triage (default)
//   node tools/scan-uniswap-v4-phase0.js --quiet    # suppress stdout summary
//   node tools/scan-uniswap-v4-phase0.js --live     # prints not-wired notice, then runs offline

"use strict";

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "uniswap-v4-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "uniswap-v4-phase0-triage.md");
const QUIET = process.argv.includes("--quiet");
const LIVE_REQUESTED = process.argv.includes("--live");

const SIGNAL = "\uD83D\uDFE1 PHASE0";

// Candidate local checkouts, most-complete first. The scanner verifies by Solidity file counts.
const CHECKOUT_CANDIDATES = [
  { id: "stage2c", dir: path.join(WORKSPACE, "targets", "uniswap-v4-core-stage2c-v4.0.0") },
  { id: "core", dir: path.join(WORKSPACE, "targets", "uniswap-v4-core") },
];

const EXCLUDE_DIRS = new Set(["lib", "out", "cache", "node_modules", ".git", "broadcast"]);

// Deliverables the task calls out explicitly. Missing ones are recorded as MISS gaps (fail-closed).
const DELIVERABLES = [
  { name: "PoolManager", kind: "contract", re: /\bcontract\s+PoolManager\b/ },
  { name: "Pool", kind: "library", re: /\blibrary\s+Pool\b/ },
  { name: "StateView", kind: "contract", re: /\bcontract\s+StateView\b/ },
  { name: "ProtocolFees", kind: "contract", re: /\b(?:abstract\s+)?contract\s+ProtocolFees\b/ },
  { name: "ERC6909", kind: "contract", re: /\b(?:abstract\s+)?contract\s+ERC6909\b/ },
  { name: "Hooks", kind: "library", re: /\blibrary\s+Hooks\b/ },
  { name: "LiquidityMath", kind: "library", re: /\blibrary\s+LiquidityMath\b/ },
  { name: "Lock", kind: "library", re: /\blibrary\s+Lock\b/ },
  { name: "SqrtPriceMath", kind: "library", re: /\blibrary\s+SqrtPriceMath\b/ },
  { name: "PriceMath/Pt*", kind: "library", re: /\blibrary\s+(?:PriceMath|Pt\w*)\b/ },
  { name: "Library.sol", kind: "file", re: /(?:^|[\\/])Library\.sol$/ },
  { name: "Extensions(.sol contract)", kind: "contract", re: /\bcontract\s+Extensions\b/ },
];

// Risk rules: classification ∈ { authorization, native-value, rounding, other }.
// Each rule records the first matching line of a file once per (file, rule).
const RULES = [
  // (a) callback authorization / hook dispatch shape
  { cls: "authorization", re: /noSelfCall\s*\(/, note: "hook self-call guard: dispatch skipped when msg.sender == hook; no owner/mask gate beyond this" },
  { cls: "authorization", re: /msg\.sender\s*==\s*address\(self\)/, note: "hook early-return when caller is the hook itself (beforeSwap/afterSwap/modifyLiquidity trust edge)" },
  { cls: "authorization", re: /msg\.sender\s*!=\s*address\(self\)/, note: "hook dispatch inverse guard in noSelfCall modifier" },
  { cls: "authorization", re: /hasPermission\s*\(/, note: "hook permission gate via hook-address low-bit flag mask (ALL_HOOK_MASK)" },
  { cls: "authorization", re: /isValidHookAddress\s*\(/, note: "hook address flag validation (permission encoded in deployed address)" },
  { cls: "authorization", re: /msg\.sender\s*!=\s*address\(key\.hooks\)/, note: "dynamic LP fee update restricted to the pool hook address" },
  { cls: "authorization", re: /protocolFeeController/, note: "protocol fee controller is the only privileged caller for fee set/collect" },
  { cls: "authorization", re: /\bonlyOwner\b/, note: "owner-gated administrative entrypoint (solmate Owned)" },
  { cls: "authorization", re: /\bnoDelegateCall\b/, note: "delegate-call guard: distinguishes direct caller from delegate caller for state-mutating entrypoints" },
  { cls: "authorization", re: /\bdelegatecall\b/, note: "delegatecall present: caller/implementer trust distinction matters for msg.sender" },
  // (b) native-value flows (take/settle) and balance checks
  { cls: "native-value", re: /msg\.value/, note: "native value payment path (settle uses msg.value only when synced currency is address(0))" },
  { cls: "native-value", re: /NonzeroNativeValue/, note: "reverts when msg.value > 0 for an ERC20 settle (native/ERC20 branch split)" },
  { cls: "native-value", re: /NativeTransferFailed/, note: "native transfer failure is bubbled/reverted rather than silently ignored" },
  { cls: "native-value", re: /isAddressZero\s*\(/, note: "native-vs-ERC20 branch on address(0) sentinel currency" },
  { cls: "native-value", re: /balanceOfSelf\s*\(/, note: "native balance read via address(this).balance (transfer-messageval balance check)" },
  { cls: "native-value", re: /CurrencyReserves\.(?:sync|reset|getSynced|resetCurrency)/, note: "sync/settle reserve accounting: transferred amount = balanceNow - balanceBefore" },
  { cls: "native-value", re: /\bfunction\s+take\s*\(/, note: "take() credits negative delta then transfers currency to recipient" },
  { cls: "native-value", re: /\bfunction\s+settle(?:For)?\s*\(/, note: "settle()/settleFor() payable entrypoints; recipient-trusted native settlement" },
  { cls: "native-value", re: /\bcurrency\.transfer\s*\(/, note: "currency.transfer dispatch: native uses call{value:amount} with success check" },
  // (c) integer / rounding idioms (comment flags where ranges could zero out)
  { cls: "rounding", re: /RoundingUp|RoundingDown/, note: "explicit rounding direction in price math (div-down class: near-zero input floors to 0)" },
  { cls: "rounding", re: /mulDivRoundingUp\s*\(|divRoundingUp\s*\(/, note: "rounding-up division/mulDiv: counterpart round-down path can floor to 0 near parameter range edges" },
  { cls: "rounding", re: /\bmulDiv\s*\(/, note: "FullMath mulDiv (floor-division): verify parameter ranges cannot truncate to 0 (log-encode / div-down class)" },
  { cls: "rounding", re: /\baddDelta\s*\(/, note: "LiquidityMath.addDelta: signed int128 added to masked uint128, reverts on overflow but not on zero" },
  { cls: "rounding", re: /shr\(128|signextend\(/, note: "assembly sign/width masking: watch zero/inverted/truncated ranges (div-down class)" },
  { cls: "rounding", re: /unchecked\s*\{/, note: "unchecked math block: comment flag for parameter ranges that could zero out without revert" },
  { cls: "rounding", re: /<<\s*FixedPoint96|>>\s*FixedPoint96|FixedPoint96\.RESOLUTION/, note: "Q96 fixed-point shift: precision-loss / zero-floor class near boundary ranges" },
  { cls: "rounding", re: /@dev[^\n]*round|round(s|ing)?\b[^\n]*zero/i, note: "source comment documenting rounding/zero behavior (div-down/log-encode class)" },
  // (d) other / structural hooks
  { cls: "other", re: /\bfunction\s+beforeSwap\s*\(|\bfunction\s+afterSwap\s*\(/, note: "swap-hook signature/implementation in this checkout (interface + test/mock only; real hooks deploy onchain)" },
  { cls: "other", re: /\bfunction\s+beforeInitialize\s*\(|\bfunction\s+afterInitialize\s*\(/, note: "initialize-hook signature/implementation in this checkout" },
];

// ----------------------------- helpers -----------------------------
function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }

function walkSol(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return acc; }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      walkSol(path.join(dir, entry.name), acc);
    } else if (entry.isFile() && entry.name.endsWith(".sol")) {
      acc.push(path.join(dir, entry.name));
    }
  }
  return acc;
}

function rel(file) { return path.relative(WORKSPACE, file).replace(/\\/g, "/"); }

function countCheckout(candidate) {
  const srcDir = path.join(candidate.dir, "src");
  const all = fs.existsSync(srcDir) ? walkSol(candidate.dir) : [];
  const src = fs.existsSync(srcDir) ? walkSol(srcDir) : [];
  const libs = src.filter((f) => /[\\/]libraries[\\/]/.test(f)).length;
  const testSrc = src.filter((f) => /[\\/]test[\\/]/.test(f)).length;
  return { id: candidate.id, dir: candidate.dir, exists: fs.existsSync(candidate.dir), srcSol: src.length, totalSol: all.length, libraries: libs, testSrc, srcFiles: src };
}

function pickCheckout(counts) {
  const present = counts.filter((c) => c.exists && c.srcSol > 0);
  if (!present.length) return { chosen: null, counts, reason: "no checkout with Solidity sources found" };
  const sorted = [...present].sort((a, b) => b.srcSol - a.srcSol || b.totalSol - a.totalSol);
  const best = sorted[0];
  // The task designates the stage2c checkout as the preferred, more-complete source of truth
  // (it carries compiled out/ artifacts and matches the callgraph stage2c reports). Prefer it
  // whenever it exists and is not materially smaller than the best candidate.
  const stage2c = present.find((c) => c.id === "stage2c");
  if (stage2c && stage2c.srcSol >= best.srcSol - 1) {
    return { chosen: stage2c, counts, reason: `preferred stage2c checkout (src .sol ${stage2c.srcSol} within 1 of best ${best.srcSol}; carries build artifacts referenced by reports/raw/fast callgraph stages)` };
  }
  return { chosen: best, counts, reason: `selected by src/.sol file count (${best.srcSol})` };
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
        // Record first match per (file, rule) to keep the artifact bounded and readable.
        if (ruleHit.has(rule)) break;
        ruleHit.add(rule);
        // Skip comment-only structural noise for hook implementation detection in non-test libraries.
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
        // find first declaring/matching line for a line anchor
        let line = 1;
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) { if (d.re.test(lines[i]) || d.re.test(relFile)) { line = i + 1; break; } }
        byName.set(d.name, { name: d.name, kind: d.kind, file: relFile, line });
      }
    }
  }
  for (const d of DELIVERABLES) {
    if (byName.has(d.name)) {
      found.push(byName.get(d.name));
    } else {
      gaps.push({
        id: `MISS-${d.name}`,
        status: "MISS",
        deliverable: d.name,
        kind: d.kind,
        note: `declared deliverable "${d.name}" not found in checkout src (likely v4-periphery/periphery-owned, absent from v4-core); recorded as MISS, not an error`,
      });
    }
  }
  return { found, gaps };
}

function detectHookClasses(files) {
  const hooks = [];
  for (const file of files) {
    let text = "";
    try { text = fs.readFileSync(file, "utf8"); } catch (_) { continue; }
    const hasHookFn = /\bfunction\s+(beforeSwap|afterSwap|beforeInitialize|afterInitialize|beforeAddLiquidity|afterAddLiquidity|beforeRemoveLiquidity|afterRemoveLiquidity|beforeDonate|afterDonate)\s*\(/.test(text);
    if (!hasHookFn) continue;
    const isTest = /[\\/]test[\\/]/.test(file);
    const nameMatch = text.match(/^[ \t]*(?:abstract\s+)?(?:contract|interface)\s+(\w+)/m);
    hooks.push({ name: nameMatch ? nameMatch[1] : path.basename(file, ".sol"), file: rel(file), kind: isTest ? "test-or-mock-hook" : "hook" });
  }
  return hooks;
}

// ----------------------------- report -----------------------------
function buildReport(artifact) {
  const rows = artifact.surfaces.slice(0, 14);
  const bulletRows = rows.length
    ? rows.map((s) => `- \`${s.classification}\` — \`${s.file}:${s.line}\` — ${s.note}`).join("\n")
    : "- (none) — no risk-surface rows recorded";
  const gapRows = artifact.gaps.length
    ? artifact.gaps.map((g) => `- ${g.status} \`${g.deliverable ?? g.id}\`: ${g.note}`).join("\n")
    : "- none recorded";
  const deliverableRows = artifact.deliverables.length
    ? artifact.deliverables.map((d) => `| ${d.name} | ${d.kind} | \`${d.file}:${d.line}\` |`).join("\n")
    : "| none | n/a | n/a |";
  const hookRows = artifact.hookClasses.length
    ? artifact.hookClasses.slice(0, 12).map((h) => `| ${h.name} | ${h.kind} | \`${h.file}\` |`).join("\n")
    : "| none | n/a | n/a |";
  const c = artifact.hitCounts;
  const fc = artifact.fileCounts.chosen || { srcSol: 0, libraries: 0, testSrc: 0 };

  return `# ${SIGNAL} — Uniswap V4 core/hooks Phase 0 Triage

Date: ${artifact.scannedAt}

Scanner: \`${artifact.scanner}\` — mode: \`offline\` (no network, no signing, no live calls this revision)

Checkout used: \`${artifact.checkoutUsed}\` (src .sol files: ${fc.srcSol}; libraries: ${fc.libraries}; test src: ${fc.testSrc})

## Result

No confirmed permissionless exploit. This is a static, fail-closed triage of the local V4 **core** surface:
hook dispatch authorization, msg.sender/delegate-caller trust edges, native-ETH take/settle value flows,
and integer/rounding idioms. Real hooks and periphery StateView live onchain or in other repos, so they are
recorded as MISS rather than inferred. No execution, signing, or fork work is justified from this pass.

## Hit counts by classification

| Classification | Hits |
|---|---:|
| authorization | ${c["authorization"] || 0} |
| native-value | ${c["native-value"] || 0} |
| rounding | ${c["rounding"] || 0} |
| other | ${c["other"] || 0} |
| **total** | **${artifact.surfaces.length}** |

## Surfaces (top ${rows.length})

${bulletRows}

## Deliverables found

| Name | Kind | Anchor |
|---|---|---|
${deliverableRows}

## Hook-related sources in checkout (interface + test/mocks)

| Contract | Kind | File |
|---|---|---|
${hookRows}

## Gaps

${gapRows}

## --live flag

Not wired this revision (TODO). Default mode is hermetic/offline; no endpoint value exists anywhere static.
A future read-only live pass must resolve endpoints in memory via the existing shared-rpc pattern
(\`resolveRpcPool\`/\`rpcCall\`, env-backed) and must never print/store RPC URLs, calldata, or signed actions.

## Close-out

V4 core Phase 0 triage remains **dormant/context-only** for the declared local-source scope. Reopen only if a
deployed hook or consumer turns a core trust edge (hook-address permission, msg.sender/delegate-caller,
native settle) into an attacker-favorable, exact-positive route with fork proof.
`;
}

// ----------------------------- main -----------------------------
function main() {
  const counts = CHECKOUT_CANDIDATES.map(countCheckout);
  const chosenInfo = pickCheckout(counts);
  const scannedAt = new Date().toISOString();

  const gaps = [];
  let chosen = chosenInfo.chosen;
  let srcFiles = [];
  if (!chosen) {
    gaps.push({ id: "MISS-CHECKOUT", status: "MISS", deliverable: "checkout", note: `no local V4 checkout found (looked for ${CHECKOUT_CANDIDATES.map((c) => rel(c.dir)).join(", ")})` });
  } else {
    srcFiles = chosen.srcFiles;
    gaps.push({
      id: "CONTEXT-HOOKS-ONCHAIN",
      status: "MISS",
      deliverable: "deployed hooks / hook registries",
      note: "V4 hooks are deployed onchain, not present in this v4-core checkout; only test/mock hook contracts exist under src/test",
    });
    gaps.push({
      id: "CONTEXT-NO-DEPLOYMENTS",
      status: "MISS",
      deliverable: "deployment addresses",
      note: "checkout contains no deployments/ or address registry; PoolManager/proxy addresses are not available locally",
    });
    if (!/executeAction|onlyFrom/.test(srcFiles.map((f) => { try { return fs.readFileSync(f, "utf8"); } catch (_) { return ""; } }).join("\n"))) {
      gaps.push({
        id: "CONTEXT-AUTH-SHAPE",
        status: "MISS",
        deliverable: "executeAction / onlyFrom authorization shape",
        note: "no executeAction/onlyFrom gate found in core; V4 core authorization is encoded in hook-address low-bit permission flags + msg.sender!=hook self-call guard",
      });
    }
  }

  const { found: deliverables, gaps: missGaps } = chosen ? enumerateDeliverables(srcFiles) : { found: [], gaps: [] };
  gaps.push(...missGaps);

  const surfaces = chosen ? scanSurfaces(srcFiles) : [];
  const hookClasses = chosen ? detectHookClasses(srcFiles) : [];

  const hitCounts = { authorization: 0, "native-value": 0, rounding: 0, other: 0 };
  for (const s of surfaces) hitCounts[s.classification] = (hitCounts[s.classification] || 0) + 1;

  const checkoutUsed = chosen ? rel(chosen.dir) : "MISS";
  const fileCounts = {
    chosen: chosen ? { id: chosen.id, path: rel(chosen.dir), srcSol: chosen.srcSol, totalSol: chosen.totalSol, libraries: chosen.libraries, testSrc: chosen.testSrc } : null,
    candidates: counts.map((c) => ({ id: c.id, path: rel(c.dir), exists: c.exists, srcSol: c.srcSol, totalSol: c.totalSol, libraries: c.libraries, testSrc: c.testSrc })),
    selectionReason: chosenInfo.reason,
  };

  const artifact = {
    scannedAt,
    scanner: "tools/scan-uniswap-v4-phase0.js",
    mode: "offline-source",
    liveMode: { requested: LIVE_REQUESTED, wired: false, note: "TODO: read-only eth_call/eth_getCode bytecode-match pass; endpoints must come from shared-rpc/env, none static" },
    checkoutUsed,
    fileCounts,
    safety: {
      offline: true,
      networkCalls: false,
      rpcUrlsStored: false,
      privateKeysRead: false,
      signedActions: false,
      broadcast: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
    },
    surfaces,
    hitCounts,
    deliverables,
    hookClasses,
    gaps,
    routePositive: false,
    executableNow: false,
    signedActionJustified: false,
  };

  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(artifact, null, 2)}\n`);
  fs.writeFileSync(REPORT_OUT, buildReport(artifact));

  if (!QUIET) {
    if (LIVE_REQUESTED) console.log("[uniswap-v4-phase0] --live requested but not wired this revision (stub/TODO); running offline.");
    console.log(
      `Uniswap V4 Phase 0: checkout=${checkoutUsed} srcSol=${chosen ? chosen.srcSol : 0} surfaces=${surfaces.length} ` +
        `(auth=${hitCounts["authorization"]} native=${hitCounts["native-value"]} rounding=${hitCounts.rounding} other=${hitCounts.other}) ` +
        `deliverables=${deliverables.length} hookClasses=${hookClasses.length} gaps=${gaps.length} routePositive=false`,
    );
  }
}

try {
  main();
} catch (err) {
  console.error(String((err && err.message) || err));
  process.exitCode = 1;
}
