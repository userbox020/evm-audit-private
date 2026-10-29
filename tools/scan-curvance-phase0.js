#!/usr/bin/env node
// scan-curvance-phase0.js - bounded read-only Phase 0 triage for the Curvance
// contracts-332721eb checkout (lending/credit plumbing).
//
// SCOPE / SAFETY
//   * Default mode is fully OFFLINE: this scanner only reads local Solidity sources under
//     targets/curvance-contracts-332721eb and writes two report artifacts. It performs NO
//     network calls, opens no sockets, reads no key material, signs nothing, and broadcasts
//     nothing. It never touches .env*, *.key, *-keypair.json or any wallet material.
//   * It never modifies other tools. Claimed resource: tools/scan-curvance-phase0.js (new file).
//
// --live FLAG SEMANTICS (documented, NOT WIRED THIS REVISION)
//   A future `--live` mode would add a bounded READ-ONLY eth_call/eth_getCode pass to confirm that
//   locally-audited bytecode matches onchain deployments (MarketManagerIsolated, OracleManager,
//   cTokens, Position Managers). That mode is a STUB with an explicit TODO. It is NOT implemented
//   and NO call is made in this revision, so there is no endpoint to static-embed. If implemented,
//   endpoints MUST come from the existing shared-rpc/env pattern and must never print/store URLs.
//
// Usage:
//   node tools/scan-curvance-phase0.js            # offline source triage (default)
//   node tools/scan-curvance-phase0.js --quiet    # suppress stdout summary
//   node tools/scan-curvance-phase0.js --live     # prints not-wired notice, then runs offline

"use strict";

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "curvance-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "curvance-phase0-triage.md");
const QUIET = process.argv.includes("--quiet");
const LIVE_REQUESTED = process.argv.includes("--live");

const SIGNAL = "\uD83D\uDFE1 PHASE0";

const CHECKOUT_CANDIDATES = [
  { id: "curvance", dir: path.join(WORKSPACE, "targets", "curvance-contracts-332721eb") },
];

const EXCLUDE_DIRS = new Set([
  "lib", "out", "cache", "node_modules", ".git", "artifacts", "broadcast", "disabled_tests",
  "mocks", "testnet",
]);

// Deliverables the task calls out. Missing ones are recorded as MISS gaps (fail-closed).
const DELIVERABLES = [
  { name: "MarketManagerIsolated", kind: "contract", re: /\bcontract\s+MarketManagerIsolated\b/ },
  { name: "LiquidityManagerIsolated", kind: "contract", re: /\bcontract\s+LiquidityManagerIsolated\b/ },
  { name: "OracleManager", kind: "contract", re: /\bcontract\s+OracleManager\b/ },
  { name: "BorrowableCToken", kind: "contract", re: /\b(?:abstract\s+)?contract\s+BorrowableCToken\b/ },
  { name: "LendingOptimizer", kind: "contract", re: /\bcontract\s+LendingOptimizer\b/ },
  { name: "BasePositionManager", kind: "contract", re: /\babstract\s+contract\s+BasePositionManager\b/ },
  { name: "CentralRegistry", kind: "contract", re: /\bcontract\s+CentralRegistry\b/ },
  { name: "CentralRegistryLib", kind: "library", re: /\blibrary\s+CentralRegistryLib\b/ },
  { name: "TokenConfig", kind: "struct", re: /\bstruct\s+TokenConfig\b/ },
  { name: "DynamicIRM", kind: "contract", re: /\bcontract\s+DynamicIRM\b/ },
  { name: "ICToken", kind: "interface", re: /\binterface\s+ICToken\b/ },
  { name: "IPositionManager", kind: "interface", re: /\binterface\s+IPositionManager\b/ },
];

// Risk rules: classification in { authorization, value-flow, rounding, oracle, other }.
// Each rule records the first matching line of a file once per (file, rule).
const RULES = [
  // (a) authorization / access control
  { cls: "authorization", re: /_checkElevatedPermissions\s*\(/, note: "DAO elevated-permission gate (central-registry DAO only)" },
  { cls: "authorization", re: /_checkDaoPermissions\s*\(/, note: "DAO-only admin gate" },
  { cls: "authorization", re: /_checkMarketPermissions\s*\(/, note: "market-permission gate on market-manager entrypoints" },
  { cls: "authorization", re: /_checkDelegate\s*\(/, note: "delegation approval check for leverageFor/deleverageFor (approver-trust edge)" },
  { cls: "authorization", re: /msg\.sender\s*!=\s*cToken\b|msg\.sender\s*!=\s*address\(_?cToken\)/, note: "callback caller must be the cToken itself (onBorrow/onRedeem trust shape)" },
  { cls: "authorization", re: /\bdelegatecall\b/, note: "LowLevelCallsHelper / PluginDelegable delegatecall (plugin trust edge)" },
  { cls: "authorization", re: /isPositionManager\s*\[|addPositionManager|removePositionManager/, note: "Position Manager allow-list membership is the delegation gate" },
  { cls: "authorization", re: /CentralRegistryLib\._isCentralRegistry\s*\(/, note: "central-registry identity validation (self-referential trust root)" },
  { cls: "authorization", re: /\bonlyMarketManager\b|\bmodifier\s+only\w+/, note: "explicit role modifier on administrative/state entrypoints" },
  // (b) value flows
  { cls: "value-flow", re: /\bfunction\s+liquidate(?:Exact)?\s*\(/, note: "liquidation entrypoint; repays debt and seizes collateral to caller" },
  { cls: "value-flow", re: /\bfunction\s+flashLoan\s*\(|onFlashLoan\s*\(/, note: "flashloan callback trust: caller must return assets + fee by end of tx" },
  { cls: "value-flow", re: /\bfunction\s+canSeize\s*\(|\bseize\b/, note: "cross-market collateral seizure path between isolated markets" },
  { cls: "value-flow", re: /\bfunction\s+skim\s*\(/, note: "skim of excess underlying to DAO (rounding/donation excess recovery)" },
  { cls: "value-flow", re: /depositAsCollateral|withdrawByPositionManager|borrowForPositionManager/, note: "position-manager enshrined callback entrypoints on cTokens" },
  { cls: "value-flow", re: /convertToShares|convertToAssets|previewRedeem|previewDeposit/, note: "share/asset conversion used by every deposit/redeem route" },
  { cls: "value-flow", re: /_totalAssets\s*[-+]=|marketOutstandingDebt/, note: "total-assets / outstanding-debt accounting mutation" },
  { cls: "value-flow", re: /liquidationPenalty|liquidationBonus|\bbounty\b/, note: "liquidation incentive math (liquidation factor / bonus)" },
  { cls: "value-flow", re: /safeTransfer(?:From)?\s*\(/, note: "token movement sink on value paths" },
  // (c) rounding / math
  { cls: "rounding", re: /mulDivUp\s*\(|divRoundingUp\s*\(|ceilDiv\s*\(/, note: "round-up division: counterpart round-down path can floor to 0 near range edges" },
  { cls: "rounding", re: /\bmulDiv\s*\(|fullMulDiv\s*\(/, note: "floor mulDiv: verify inputs cannot truncate to 0 (share/exchange-rate class)" },
  { cls: "rounding", re: /RoundingUp|RoundingDown/, note: "explicit rounding direction (div-down class)" },
  { cls: "rounding", re: /exchangeRate|exchangeRateUpdated/, note: "cToken exchange rate: high-watermark / accrual-sensitive denominator" },
  { cls: "rounding", re: /HighWatermark|highWatermark/, note: "high-watermark accounting can be stale between accruals" },
  { cls: "rounding", re: /unchecked\s*\{/, note: "unchecked math block: parameter ranges that could zero out without revert" },
  { cls: "rounding", re: /FixedPointMathLib\.\w+\(|Math\.(?:min|max)\s*\(/, note: "fixed-point helper call: unit/precision assumption to verify" },
  // (d) oracle inputs
  { cls: "oracle", re: /getPriceIsolatedPair|getPricesForMarket|\.getPrice\s*\(/, note: "oracle price query feeding liquidity/liquidation checks" },
  { cls: "oracle", re: /errorCodeBreakpoint|BAD_SOURCE|CAUTION/, note: "oracle error-code breakpoint gates borrow/redeem/liquidate reverts" },
  { cls: "oracle", re: /_isSequencerValid|sequencerUptimeFeed|GRACE_PERIOD_TIME/, note: "L2 sequencer uptime gate with grace period" },
  { cls: "oracle", re: /_checkBounds|badSourceBound|cautionBound|MAX_DEVIATION_BOUND/, note: "dual-adaptor deviation circuit breaker" },
  { cls: "oracle", re: /latestRoundData|latestAnswer|IChainlink|IAggregator/, note: "raw Chainlink read: staleness/decimals handled by adaptor" },
  { cls: "oracle", re: /isApprovedAdaptor|addApprovedAdaptor|adaptors\.push/, note: "oracle adaptor allow-list: DAO-approved pricing source set" },
  // (e) other / protocol-specific
  { cls: "other", re: /\bfunction\s+listTokens\s*\(|setLiquidationPaused|setBorrowPaused|setCollateralizationPaused/, note: "market listing / pause admin surface" },
  { cls: "other", re: /TransientLiquidationConfig|setTransientLiquidationConfig/, note: "protocol-specific transient liquidation config override" },
  { cls: "other", re: /StrategyCToken|LendingOptimizer|VoucherCToken/, note: "strategy / optimizer / voucher wrapper token surface" },
  { cls: "other", re: /_accrueIfNeeded|accrueIfNeeded\s*\(/, note: "interest-accrual hook that front-runs every user action" },
  { cls: "other", re: /HoldPeriod|holdPeriod|_checkHoldPeriod/, note: "transfer hold-period gating (anti-flashloan economics)" },
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
  const srcDir = path.join(candidate.dir, "contracts");
  const all = fs.existsSync(candidate.dir) ? walkSol(candidate.dir) : [];
  const src = fs.existsSync(srcDir) ? walkSol(srcDir) : [];
  const libs = src.filter((f) => /[\\/]libraries[\\/]/.test(f)).length;
  const testSrc = src.filter((f) => /[\\/]tests?[\\/]/.test(f)).length;
  const oracles = src.filter((f) => /[\\/]oracles?[\\/]/i.test(f)).length;
  return { id: candidate.id, dir: candidate.dir, exists: fs.existsSync(candidate.dir), srcSol: src.length, totalSol: all.length, libraries: libs, testSrc, oracles, srcFiles: src };
}

function pickCheckout(counts) {
  const present = counts.filter((c) => c.exists && c.srcSol > 0);
  if (!present.length) return { chosen: null, counts, reason: "no checkout with Solidity sources found" };
  const sorted = [...present].sort((a, b) => b.srcSol - a.srcSol || b.totalSol - a.totalSol);
  return { chosen: sorted[0], counts, reason: `selected by contracts/.sol file count (${sorted[0].srcSol})` };
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
      note: `declared deliverable "${d.name}" not found in contracts src; recorded as MISS, not an error`,
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
  const fc = artifact.fileCounts.chosen || { srcSol: 0, libraries: 0, testSrc: 0, oracles: 0 };

  return `# ${SIGNAL} — Curvance contracts-332721eb Phase 0 Triage

Date: ${artifact.scannedAt}

Scanner: \`${artifact.scanner}\` — mode: \`offline\` (no network, no signing, no live calls this revision)

Checkout used: \`${artifact.checkoutUsed}\` (contracts .sol files: ${fc.srcSol}; libraries: ${fc.libraries}; oracles: ${fc.oracles}; test src: ${fc.testSrc})

## Result

No confirmed permissionless exploit. This is a static, fail-closed triage of the local Curvance
lending/credit surface: market-manager authorization, liquidation flow (repay + seize across isolated
markets), position-manager delegation callbacks, share accounting and rounding, and oracle
adaptor/deviation wiring. No execution, signing, or fork work is justified from this pass.

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

Curvance Phase 0 triage remains **dormant/context-only** for the declared local-source scope. Reopen only if
an authorization edge (position-manager delegation, oracle adaptor swap, transient liquidation config) turns
into an attacker-favorable, exact-positive route with fork proof.
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
    gaps.push({ id: "MISS-CHECKOUT", status: "MISS", deliverable: "checkout", note: `no local Curvance checkout found (looked for ${CHECKOUT_CANDIDATES.map((c) => rel(c.dir)).join(", ")})` });
  } else {
    srcFiles = chosen.srcFiles;
    gaps.push({
      id: "CONTEXT-NO-DEPLOYMENTS", status: "MISS", deliverable: "deployment addresses",
      note: "checkout contains no deployment/address registry; live MarketManager/OracleManager/cToken addresses are not available locally",
    });
  }

  const { found: deliverables, gaps: missGaps } = chosen ? enumerateDeliverables(srcFiles) : { found: [], gaps: [] };
  gaps.push(...missGaps);

  const surfaces = chosen ? scanSurfaces(srcFiles) : [];

  const hitCounts = { authorization: 0, "value-flow": 0, rounding: 0, oracle: 0, other: 0 };
  for (const s of surfaces) hitCounts[s.classification] = (hitCounts[s.classification] || 0) + 1;

  const checkoutUsed = chosen ? rel(chosen.dir) : "MISS";
  const fileCounts = {
    chosen: chosen ? { id: chosen.id, path: rel(chosen.dir), srcSol: chosen.srcSol, totalSol: chosen.totalSol, libraries: chosen.libraries, testSrc: chosen.testSrc, oracles: chosen.oracles } : null,
    candidates: counts.map((c) => ({ id: c.id, path: rel(c.dir), exists: c.exists, srcSol: c.srcSol, totalSol: c.totalSol, libraries: c.libraries, testSrc: c.testSrc, oracles: c.oracles })),
    selectionReason: chosenInfo.reason,
  };

  const artifact = {
    scannedAt,
    scanner: "tools/scan-curvance-phase0.js",
    mode: "offline-source",
    liveMode: { requested: LIVE_REQUESTED, wired: false, note: "TODO: read-only eth_call/eth_getCode bytecode-match pass; endpoints must come from shared-rpc/env, none static" },
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
    if (LIVE_REQUESTED) console.log("[curvance-phase0] --live requested but not wired this revision (stub/TODO); running offline.");
    console.log(
      `Curvance Phase 0: checkout=${checkoutUsed} srcSol=${chosen ? chosen.srcSol : 0} surfaces=${surfaces.length} ` +
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
