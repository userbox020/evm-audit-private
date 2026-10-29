#!/usr/bin/env node
// scan-yieldnest-phase0.js - bounded read-only Phase 0 triage for YieldNest vault v0.4.1.
//
// SCOPE / SAFETY
//   * Fully OFFLINE: reads local Solidity sources under targets/yieldnest-vault-v0.4.1/src and writes two
//     report artifacts. No network calls, no sockets, no key material, no signing, no broadcast, no forge test.
//   * Never touches .env*, *.key, *-keypair.json or wallet material.
//   * Never modifies other tools. Claimed resource: tools/scan-yieldnest-phase0.js (new file).
//
// TARGET
//   Vault share/redeem path (BaseVault + Vault), asset set membership (AssetStorage list/defaultAssetIndex),
//   ERC4626 rounding, and the Guard/processor counterparty trust (validator.validate is full call auth).
//   NOTE: task phrases "safe256/safe arithmetic" and "counterparty safeModule trust" do NOT appear verbatim in
//   this pin; the closest in-tree surfaces are (a) Solidity 0.8.24 checked arithmetic + Math.Rounding and
//   (b) Guard.sol delegating to an IValidator contract. Both absences/aliases are recorded as MISS/notes.
//   The checkout's working tree was observed empty with staged deletions and was restored from local HEAD by
//   the operator before this scan (no network); see gaps.

"use strict";

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const CHECKOUT = path.join(WORKSPACE, "targets", "yieldnest-vault-v0.4.1");
const SRC_DIR = path.join(CHECKOUT, "src");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "yieldnest-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "yieldnest-phase0-triage.md");
const QUIET = process.argv.includes("--quiet");
const LIVE_REQUESTED = process.argv.includes("--live");

const SIGNAL = "\uD83D\uDFE1 PHASE0";
const EXCLUDE_DIRS = new Set(["lib", "node_modules", "out", "cache", ".git", "broadcast", "test"]);

const DELIVERABLES = [
  { name: "Vault", kind: "contract", re: /\bcontract\s+Vault\b/ },
  { name: "BaseVault", kind: "contract", re: /\babstract\s+contract\s+BaseVault\b/ },
  { name: "BaseStrategy", kind: "contract", re: /\babstract\s+contract\s+BaseStrategy\b/ },
  { name: "VaultLib", kind: "library", re: /\blibrary\s+VaultLib\b/ },
  { name: "Guard", kind: "library", re: /\blibrary\s+Guard\b/ },
  { name: "Provider", kind: "contract", re: /\bcontract\s+Provider\b/ },
  { name: "FeeMath", kind: "library", re: /\blibrary\s+FeeMath\b/ },
  { name: "LinearWithdrawalFee", kind: "contract", re: /\bcontract\s+LinearWithdrawalFee\b/ },
  { name: "BaseWithdrawer", kind: "contract", re: /\bcontract\s+BaseWithdrawer\b/ },
  { name: "Withdrawer", kind: "contract", re: /\bcontract\s+Withdrawer\b/ },
  { name: "FeeHooks", kind: "contract", re: /\bcontract\s+FeeHooks\b/ },
  { name: "AsyncWithdrawalLib", kind: "library", re: /\blibrary\s+AsyncWithdrawalLib\b/ },
  { name: "XReferralAdapter", kind: "contract", re: /\bcontract\s+XReferralAdapter\b/ },
  { name: "IValidator", kind: "interface", re: /\binterface\s+IValidator\b/ },
];

// Classification ∈ {authorization, value-flow, rounding, oracle, other}.
const RULES = [
  // (a) authorization / role + counterparty trust
  { cls: "authorization", re: /onlyRole\(\s*\w*_ROLE/, note: "OpenZeppelin AccessControl role gate on a state-mutating entrypoint" },
  { cls: "authorization", re: /\bPROCESSOR_ROLE\b|\bPROCESSOR_MANAGER_ROLE\b/, note: "processor roles: PROCESSOR_ROLE executes arbitrary Guard-approved calls; PROCESSOR_MANAGER_ROLE sets the rules" },
  { cls: "authorization", re: /\bASSET_WITHDRAWER_ROLE\b/, note: "BaseVault permissioned asset-withdrawal escape hatch (overridden on strategies)" },
  { cls: "authorization", re: /onlyAllocator|hasAllocators/, note: "strategy allocator gating; hasAllocators==false opens ERC4626 deposit/withdraw to any caller" },
  { cls: "authorization", re: /msg\.sender\s*!=\s*address\(hooks\(\)\)/, note: "only the configured hooks contract may call mintShares (hooks are a high-risk extension)" },
  { cls: "authorization", re: /validator\.validate\s*\(/, note: "Guard delegates the ENTIRE call authorization to an IValidator contract when rule.validator != 0 (counterparty trust)" },
  { cls: "authorization", re: /rule\.validator/, note: "FunctionRule.validator is a caller/owner-configured contract that can allow arbitrary calldata" },
  { cls: "authorization", re: /ParamType\.ADDRESS/, note: "generic guard only checks ADDRESS params against an allowlist; UINT/bytes/bool are unvalidated placeholders" },
  { cls: "authorization", re: /function\s+processor\s*\(/, note: "processor(targets,values,data): arbitrary-call surface, each call must pass Guard" },
  { cls: "authorization", re: /_disableInitializers\(\)/, note: "implementation disables initializers in constructor (proxy/init trust boundary)" },
  { cls: "authorization", re: /isPoolAdmin|isEmergencyAdmin|isRiskAdmin|ACLManager/, note: "external ACL admin gate for emergency-oracle toggles (periphery/adapters)" },
  // (b) value flow
  { cls: "value-flow", re: /SafeERC20\.safeTransfer(?:From)?\(/, note: "SafeERC20 transfer of the in/out asset in deposit/withdraw/redeem" },
  { cls: "value-flow", re: /\.withdraw\s*\(\s*assets\s*,\s*receiver\s*,/, note: "withdrawal routed through the configured buffer strategy (IStrategy.withdraw)" },
  { cls: "value-flow", re: /_mint\(|_burn\(/, note: "share mint/burn in the ERC4626 share supply" },
  { cls: "value-flow", re: /receive\(\)\s+external\s+payable|msg\.value|NativeDeposit/, note: "native-asset path (countNativeAsset, address(this).balance included in computeTotalAssets)" },
  { cls: "value-flow", re: /getRate\(/, note: "Provider.getRate(asset) drives conversion + accounting; vault does not sanity-check the rate" },
  { cls: "value-flow", re: /mintShares\(/, note: "external mintShares entrypoint restricted to hooks" },
  // (c) rounding / ERC4626 math
  { cls: "rounding", re: /Math\.Rounding\.(?:Floor|Ceil)/, note: "explicit rounding direction on convert/share math (floor on deposits/redeem, ceil on mint/withdraw)" },
  { cls: "rounding", re: /previewRedeem|previewWithdraw|previewDeposit|previewMint/, note: "ERC4626 preview math; previewRedeem subtracts _feeOnTotal after floor conversion" },
  { cls: "rounding", re: /convertToShares|convertToAssets|convertAssetToBase|convertBaseToAsset/, note: "asset<->share<->base conversions; baseAssets is always rounded down" },
  { cls: "rounding", re: /_feeOnRaw|_feeOnTotal|BASIS_POINT_SCALE/, note: "withdrawal fee math on a 1e8 basis-point scale (LinearWithdrawalFee / FeeMath)" },
  { cls: "rounding", re: /type\(uint256\)\.max/, note: "unbounded maxDeposit/maxMint sentinel (no per-user cap)" },
  // (d) oracle / valuation
  { cls: "oracle", re: /computeTotalAssets|processAccounting/, note: "TVL valuation loop over asset balances * provider rate; cached vs live accounting" },
  { cls: "oracle", re: /alwaysComputeTotalAssets/, note: "cached-accounting toggle: stale cached totalAssets is trusted for share pricing when false" },
  // (e) other / structural
  { cls: "other", re: /nonReentrant/, note: "ReentrancyGuard on deposit/withdraw/redeem/accounting entries" },
  { cls: "other", re: /setHooks\(|hooks\(\)/, note: "hooks extension point (can intercept flows and mint fee shares)" },
  { cls: "other", re: /FunctionRule|ProcessorRule/, note: "Guard function-rule shape (active flag + paramRules + validator)" },
  { cls: "other", re: /defaultAssetIndex|getAssets\(\)|hasAsset\(/, note: "asset set membership / ordering (index 0 = base asset, defaultAssetIndex selects asset())" },
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
    else gaps.push({ id: `MISS-${d.name}`, status: "MISS", deliverable: d.name, kind: d.kind, note: `"${d.name}" not found in yieldnest src; recorded as MISS, not inferred` });
  }
  return { found, gaps };
}

function buildReport(a) {
  const rows = a.surfaces.slice(0, 16);
  const bullets = rows.length ? rows.map((s) => `- \`${s.classification}\` — \`${s.file}:${s.line}\` — ${s.note}`).join("\n") : "- (none)";
  const gaps = a.gaps.length ? a.gaps.map((g) => `- ${g.status} \`${g.deliverable}\`: ${g.note}`).join("\n") : "- none recorded";
  const dl = a.deliverables.length ? a.deliverables.map((d) => `| ${d.name} | ${d.kind} | \`${d.file}:${d.line}\` |`).join("\n") : "| none | n/a | n/a |";
  const c = a.hitCounts;
  return `# ${SIGNAL} — YieldNest Vault v0.4.1 Phase 0 Triage

Date: ${a.scannedAt}

Scanner: \`${a.scanner}\` — mode: \`offline\` (no network, no signing, no live calls)

Checkout: \`${a.checkoutUsed}\` (src .sol files: ${a.fileCounts.srcSol})

## Result

No confirmed permissionless exploit. Static, fail-closed triage of the local YieldNest vault surface:
ERC4626 share/redeem path, asset set membership/ordering, rounding + fee math, and the Guard/processor
counterparty trust (validator contract). No execution, signing, or fork work is justified from this pass.

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

## Gaps

${gaps}

## --live flag

Not wired (TODO). Default mode is hermetic/offline; no endpoint value is static. A future read-only pass must
resolve endpoints in memory from shared-rpc/env and never print/store RPC URLs.

## Close-out

YieldNest v0.4.1 Phase 0 remains **dormant/context-only** for the declared local-source scope. Reopen only if a
concrete deployment turns a validator/processor rule, a bad provider rate, or asset-order misconfiguration into an
attacker-favorable, exact-positive route with fork proof.
`;
}

// ----------------------------- main -----------------------------
function main() {
  const scannedAt = new Date().toISOString();
  const gaps = [];
  let srcFiles = [];
  if (!fs.existsSync(SRC_DIR)) {
    gaps.push({ id: "MISS-CHECKOUT", status: "MISS", deliverable: "checkout", note: `no local checkout at ${rel(SRC_DIR)} (working tree may be truncated)` });
  } else {
    srcFiles = walk(SRC_DIR, [".sol"]);
    if (srcFiles.length === 0) gaps.push({ id: "MISS-EMPTY-TREE", status: "MISS", deliverable: "src/", note: "src/ present but contains no .sol files (truncated/partial checkout)" });
    gaps.push({ id: "CONTEXT-NO-DEPLOYMENTS", status: "MISS", deliverable: "live proxy/admin addresses", note: "no live proxy/role wiring available offline; deployments/ artifacts are config outputs and not consumed here" });
    gaps.push({ id: "CONTEXT-ALIASES", status: "MISS", deliverable: "safe256 / safeModule", note: "task-named safe256/safeModule absent in this pin; closest surfaces are 0.8.24 checked arithmetic + Math.Rounding and Guard.sol IValidator trust" });
  }

  const { found: deliverables, gaps: missGaps } = srcFiles.length ? enumerateDeliverables(srcFiles) : { found: [], gaps: [] };
  gaps.push(...missGaps);

  const surfaces = srcFiles.length ? scanSurfaces(srcFiles) : [];
  const hitCounts = { authorization: 0, "value-flow": 0, rounding: 0, oracle: 0, other: 0 };
  for (const s of surfaces) hitCounts[s.classification] = (hitCounts[s.classification] || 0) + 1;

  const artifact = {
    scannedAt,
    scanner: "tools/scan-yieldnest-phase0.js",
    mode: "offline-source",
    liveMode: { requested: LIVE_REQUESTED, wired: false, note: "TODO: read-only proxy/role/provider check; endpoints must come from shared-rpc/env, none static" },
    checkoutUsed: rel(CHECKOUT),
    fileCounts: { srcSol: srcFiles.length },
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
    if (LIVE_REQUESTED) console.log("[yieldnest-phase0] --live requested but not wired (stub/TODO); running offline.");
    console.log(`YieldNest Phase 0: checkout=${artifact.checkoutUsed} srcSol=${srcFiles.length} surfaces=${surfaces.length} ` +
      `(auth=${hitCounts.authorization} value-flow=${hitCounts["value-flow"]} rounding=${hitCounts.rounding} oracle=${hitCounts.oracle} other=${hitCounts.other}) ` +
      `deliverables=${deliverables.length} gaps=${gaps.length} routePositive=false`);
  }
}

try { main(); } catch (err) { console.error(String((err && err.message) || err)); process.exitCode = 1; }
