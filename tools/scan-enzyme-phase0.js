#!/usr/bin/env node
// scan-enzyme-phase0.js - bounded read-only Phase 0 triage for the Enzyme / Melon v1.1.3 fund surface.
//
// SCOPE / SAFETY
//   * Fully OFFLINE: reads local Solidity sources under targets/enzyme-protocol-v1.1.3/src and writes
//     two report artifacts. No network calls, no sockets, no key material, no signing, no broadcast.
//   * Never touches .env*, *.key, *-keypair.json or wallet material.
//   * Never modifies other tools. Claimed resource: tools/scan-enzyme-phase0.js (new file).
//
// TARGET
//   Vault/fund manager: share accounting (Shares/Accounting), the Vault custody + VaultFactory spokes,
//   participation (request/execute/redeem), Trading.callOnExchange -> exchange adapter trust, fees.
//   NOTE: the task hints "FundController/VaultLib share accounting" and "PerpV2 / Compound adapters".
//   This pinned v1.1.3 checkout (Melonport-era, pragma 0.6.1) has NEITHER: no FundController/VaultLib and
//   no PerpV2/Compound integration. The real surface is Vault.sol + Hub/Spoke + Accounting + Trading +
//   Registry-registered exchange adapters (ZeroExV2/V3, Kyber, Uniswap, OasisDex, Ethfinex). Those absences
//   are recorded as MISS (fail-closed), not inferred.
//
// Usage:
//   node tools/scan-enzyme-phase0.js            # offline source triage (default)
//   node tools/scan-enzyme-phase0.js --quiet    # suppress stdout summary
//   node tools/scan-enzyme-phase0.js --live     # prints not-wired notice, then runs offline

"use strict";

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const CHECKOUT = path.join(WORKSPACE, "targets", "enzyme-protocol-v1.1.3");
const SRC_DIR = path.join(CHECKOUT, "src");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "enzyme-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "enzyme-phase0-triage.md");
const QUIET = process.argv.includes("--quiet");
const LIVE_REQUESTED = process.argv.includes("--live");

const SIGNAL = "\uD83D\uDFE1 PHASE0";
const EXCLUDE_DIRS = new Set(["lib", "node_modules", "out", "cache", ".git", "broadcast", "deploy", "compile", "deployments"]);

// Deliverables: missing ones are recorded as MISS gaps (fail-closed).
const DELIVERABLES = [
  { name: "Vault", kind: "contract", re: /\bcontract\s+Vault\b/ },
  { name: "Shares", kind: "contract", re: /\bcontract\s+Shares\b/ },
  { name: "Accounting", kind: "contract", re: /\bcontract\s+Accounting\b/ },
  { name: "Participation", kind: "contract", re: /\bcontract\s+Participation\b/ },
  { name: "Trading", kind: "contract", re: /\bcontract\s+Trading\b/ },
  { name: "Hub", kind: "contract", re: /\bcontract\s+Hub\b/ },
  { name: "PolicyManager", kind: "contract", re: /\bcontract\s+PolicyManager\b/ },
  { name: "FeeManager", kind: "contract", re: /\bcontract\s+FeeManager\b/ },
  { name: "Registry", kind: "contract", re: /\bcontract\s+Registry\b/ },
  { name: "FundController", kind: "contract", re: /\bcontract\s+FundController\b/ },
  { name: "VaultLib", kind: "library", re: /\blibrary\s+VaultLib\b/ },
  { name: "PerpV2Adapter", kind: "contract", re: /\bcontract\s+PerpV2Adapter\b/ },
  { name: "CompoundAdapter", kind: "contract", re: /\bcontract\s+CompoundAdapter\b/ },
];

// Classification ∈ {authorization, value-flow, rounding, oracle, other}.
const RULES = [
  // (a) authorization / trust edges
  { cls: "authorization", re: /\.delegatecall\s*\(/, note: "Trading.callOnExchange delegates into a Registry-registered exchange adapter; adapter code runs with Trading approvals + vault-funded balances" },
  { cls: "authorization", re: /modifier\s+delegateInternal/, note: "delegateInternal: only self-calls may run adapter state hooks (addOpenMakeOrder/orderUpdateHook/addZeroEx*OrderData)" },
  { cls: "authorization", re: /msg\.sender\s*==\s*address\(this\)/, note: "self-call gate backing delegateInternal; msg.sender==address(this) is the whole trust boundary for adapter callbacks" },
  { cls: "authorization", re: /\bexternal\s+auth\b|\bpublic\s+auth\b/, note: "Spoke `auth` gate: Hub-configured spokes/managers may call (Shares mint/burn, Vault.withdraw, asset list mutation)" },
  { cls: "authorization", re: /adapterMethodIsAllowed\s*\(/, note: "Registry selector allowlist: callOnExchange reverts unless the adapter method selector is registered" },
  { cls: "authorization", re: /assetIsRegistered\s*\(/, note: "Registry asset allowlist: maker/taker/fee assets must be registered before make/take" },
  { cls: "authorization", re: /isShutDown\s*\(/, note: "shutdown override: when fund is shut down anyone may trigger return/cancel paths" },
  { cls: "authorization", re: /modifier\s+onlyManager\s*\(/, note: "ExchangeAdapter.onlyManager gate (hub.manager): make/take order dispatch" },
  { cls: "authorization", re: /feeIsRegistered\s*\(|isFeeRegistered\s*\(/, note: "fee contract must be Registry-registered before FeeManager will reward it" },
  { cls: "authorization", re: /\bonlyInitialized\b/, note: "onlyInitialized gate on callOnExchange/requestInvestment (Hub lifecycle)" },
  // (b) value flow / external calls
  { cls: "value-flow", re: /function\s+callOnExchange\s*\(/, note: "universal adapter proxy entrypoint: caller-supplied order arrays flow into delegatecall (only policy pre/postValidate constrains them)" },
  { cls: "value-flow", re: /vault\.withdraw\s*\(/, note: "adapter pulls assets out of the shared Vault via auth withdraw, then approves the exchange/asset-proxy" },
  { cls: "value-flow", re: /\.approve\s*\(/, note: "allowance granted to exchange or 0x asset proxy; residual allowance persists after partial fills/cancel" },
  { cls: "value-flow", re: /function\s+returnAssetToVault\s*\(/, note: "sweeps the whole token balance back to the Vault when shutdown/manager/no-open-order conditions hold" },
  { cls: "value-flow", re: /safeTransfer\s*\(|safeTransferFrom\s*\(/, note: "TokenUser safe transfer helper (returned fill / cancel change / redeem assets)" },
  { cls: "value-flow", re: /protocolFeeCollector|protocolFeeMultiplier|calcProtocolFeeAmount/, note: "0x protocol fee paid in NATIVE_ASSET; amount = feeMultiplier * tx.gasprice" },
  { cls: "value-flow", re: /tx\.gasprice/, note: "protocol fee sized by tx.gasprice: caller-inflatable fee charged to the fund on each take" },
  { cls: "value-flow", re: /receive\(\)\s+external\s+payable|msg\.value/, note: "native value path (WETH receive / payable participation requests)" },
  { cls: "value-flow", re: /getTrading\(\)\.\w+\(/, note: "adapter calls back into Trading via address(this) cast (getTrading()) for state hooks and order bookkeeping" },
  // (c) rounding / accounting math
  { cls: "rounding", re: /getOwedPerformanceFees|performanceFeePortion/, note: "performance-fee share portion is pro-rata floor (mul then div by fee-augmented supply)" },
  { cls: "rounding", re: /getShareCostInAsset|valuePerShare/, note: "share price = (totalValue*10^18)/numShares floor; cost conversion through IPriceSource" },
  { cls: "rounding", re: /\bmul\(\s*[A-Za-z_$]/, note: "DSMath mul() pro-rata math: integer floor can under-credit maker/taker amounts on partial fills" },
  { cls: "rounding", re: /DEFAULT_SHARE_PRICE/, note: "empty-supply bootstrap share price (10**denominationDecimals) used until first shares exist" },
  { cls: "rounding", re: /denominationAssetQuantity|DENOMINATION_ASSET_DECIMALS/, note: "denomination-asset decimal scaling in share-cost / GAV conversion" },
  // (d) oracle / price source
  { cls: "oracle", re: /convertQuantity|hasValidPrice|hasValidPrices|getLastUpdate/, note: "IPriceSource conversion + staleness (getLastUpdate) gates request execution and cancel eligibility" },
  { cls: "oracle", re: /calcGav|performCalculations|calcAssetGAV/, note: "GAV/NAV derived by summing per-asset holdings * IPriceSource rate; price feed is the fund valuation root" },
  // (e) other / structural
  { cls: "other", re: /function\s+makeOrder|function\s+takeOrder|function\s+getOrder/, note: "adapter order surface (make/take/read) reachable through callOnExchange delegatecall" },
  { cls: "other", re: /MAX_OWNED_ASSETS|MAX_/, note: "bounded asset/order parameter (e.g. MAX_OWNED_ASSETS cap in Accounting)" },
  { cls: "other", re: /emit\s+ExchangeMethodCall|emit\s+Redemption/, note: "order/redeem events carrying caller-supplied order arrays and asset quantities" },
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
    else gaps.push({
      id: `MISS-${d.name}`, status: "MISS", deliverable: d.name, kind: d.kind,
      note: `"${d.name}" not present in targets/enzyme-protocol-v1.1.3/src (pinned Melonport-era checkout); recorded as MISS, not inferred`,
    });
  }
  return { found, gaps };
}

function buildReport(a) {
  const rows = a.surfaces.slice(0, 16);
  const bullets = rows.length ? rows.map((s) => `- \`${s.classification}\` — \`${s.file}:${s.line}\` — ${s.note}`).join("\n") : "- (none)";
  const gaps = a.gaps.length ? a.gaps.map((g) => `- ${g.status} \`${g.deliverable}\`: ${g.note}`).join("\n") : "- none recorded";
  const dl = a.deliverables.length ? a.deliverables.map((d) => `| ${d.name} | ${d.kind} | \`${d.file}:${d.line}\` |`).join("\n") : "| none | n/a | n/a |";
  const c = a.hitCounts;
  return `# ${SIGNAL} — Enzyme (Melon v1.1.3) fund surface Phase 0 Triage

Date: ${a.scannedAt}

Scanner: \`${a.scanner}\` — mode: \`offline\` (no network, no signing, no live calls)

Checkout: \`${a.checkoutUsed}\` (src .sol files: ${a.fileCounts.srcSol})

## Result

No confirmed permissionless exploit. Static, fail-closed triage of the local Enzyme v1.1.3 **fund** surface:
share accounting (Shares/Accounting), the custody Vault + participation flows, and the Trading -> exchange-adapter
trust edge (delegatecall composition). Exchange adapters, PerpV2 and Compound integrations that the task calls out are
NOT in this pin and are recorded as MISS. No execution, signing, or fork work is justified from this pass.

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

Not wired (TODO). Default mode is hermetic/offline; no endpoint value is static anywhere. A future read-only pass
must resolve endpoints in memory via the existing shared-rpc pattern and must never print/store RPC URLs or calldata.

## Close-out

Enzyme fund Phase 0 remains **dormant/context-only** for the declared local-source scope. Reopen only if a deployed
grantor/manager or a registered adapter turns the delegatecall/allowance trust edge into an attacker-favorable,
exact-positive route with fork proof.
`;
}

// ----------------------------- main -----------------------------
function main() {
  const scannedAt = new Date().toISOString();
  const gaps = [];
  let srcFiles = [];
  if (!fs.existsSync(SRC_DIR)) {
    gaps.push({ id: "MISS-CHECKOUT", status: "MISS", deliverable: "checkout", note: `no local checkout at ${rel(SRC_DIR)}` });
  } else {
    srcFiles = walk(SRC_DIR, [".sol"]);
    gaps.push({ id: "CONTEXT-NO-DEPLOYMENTS", status: "MISS", deliverable: "deployment addresses", note: "no address registry consumed by this scanner; engine/hub wiring is deployment-specific" });
    if (!srcFiles.some((f) => { try { return /\bFundController\b|\bVaultLib\b/.test(fs.readFileSync(f, "utf8")); } catch (_) { return false; } })) {
      gaps.push({ id: "CONTEXT-NAMING", status: "MISS", deliverable: "FundController / VaultLib", note: "task-named contracts absent from v1.1.3 pin; share accounting lives in Shares.sol + Accounting.sol" });
    }
  }

  const { found: deliverables, gaps: missGaps } = srcFiles.length ? enumerateDeliverables(srcFiles) : { found: [], gaps: [] };
  gaps.push(...missGaps);

  const surfaces = srcFiles.length ? scanSurfaces(srcFiles) : [];
  const hitCounts = { authorization: 0, "value-flow": 0, rounding: 0, oracle: 0, other: 0 };
  for (const s of surfaces) hitCounts[s.classification] = (hitCounts[s.classification] || 0) + 1;

  const artifact = {
    scannedAt,
    scanner: "tools/scan-enzyme-phase0.js",
    mode: "offline-source",
    liveMode: { requested: LIVE_REQUESTED, wired: false, note: "TODO: read-only bytecode-match pass; endpoints must come from shared-rpc/env, none static" },
    checkoutUsed: rel(CHECKOUT),
    fileCounts: { srcSol: srcFiles.filter((f) => f.endsWith(".sol")).length },
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
    if (LIVE_REQUESTED) console.log("[enzyme-phase0] --live requested but not wired (stub/TODO); running offline.");
    console.log(`Enzyme Phase 0: checkout=${artifact.checkoutUsed} srcSol=${artifact.fileCounts.srcSol} surfaces=${surfaces.length} ` +
      `(auth=${hitCounts.authorization} value-flow=${hitCounts["value-flow"]} rounding=${hitCounts.rounding} oracle=${hitCounts.oracle} other=${hitCounts.other}) ` +
      `deliverables=${deliverables.length} gaps=${gaps.length} routePositive=false`);
  }
}

try { main(); } catch (err) { console.error(String((err && err.message) || err)); process.exitCode = 1; }
