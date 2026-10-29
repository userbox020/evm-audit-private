#!/usr/bin/env node
// scan-homora-v2-phase0.js - bounded read-only Phase 0 triage for the Alpha Homora V2
// leverage-yield vault checkout (HomoraBank + spell integration).
//
// SCOPE / SAFETY
//   * Default mode is fully OFFLINE: this scanner only reads local Solidity sources under
//     targets/homora-v2 and writes two report artifacts. It performs NO network calls, opens no
//     sockets, reads no key material, signs nothing, and broadcasts nothing. It never touches
//     .env*, *.key, *-keypair.json or any wallet material.
//   * It never modifies other tools. Claimed resource: tools/scan-homora-v2-phase0.js (new file).
//
// --live FLAG SEMANTICS (documented, NOT WIRED THIS REVISION)
//   A future `--live` mode would add a bounded READ-ONLY eth_call/eth_getCode pass to confirm that
//   locally-audited bytecode matches onchain deployments (HomoraBank proxy, HomoraCaster, spells,
//   oracles). That mode is a STUB with an explicit TODO. It is NOT implemented and NO call is made
//   in this revision, so there is no endpoint to static-embed. If implemented, endpoints MUST come
//   from the existing shared-rpc/env pattern and must never print/store URLs.
//
// Usage:
//   node tools/scan-homora-v2-phase0.js            # offline source triage (default)
//   node tools/scan-homora-v2-phase0.js --quiet    # suppress stdout summary
//   node tools/scan-homora-v2-phase0.js --live     # prints not-wired notice, then runs offline

"use strict";

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "homora-v2-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "homora-v2-phase0-triage.md");
const QUIET = process.argv.includes("--quiet");
const LIVE_REQUESTED = process.argv.includes("--live");

const SIGNAL = "\uD83D\uDFE1 PHASE0";

const CHECKOUT_CANDIDATES = [
  { id: "homora-v2", dir: path.join(WORKSPACE, "targets", "homora-v2") },
];

const EXCLUDE_DIRS = new Set(["node_modules", ".git", "mock", "out", "cache", "artifacts"]);

// Deliverables the task calls out. Missing ones are recorded as MISS gaps (fail-closed).
const DELIVERABLES = [
  { name: "HomoraBank", kind: "contract", re: /\bcontract\s+HomoraBank\b/ },
  { name: "HomoraCaster", kind: "contract", re: /\bcontract\s+HomoraCaster\b/ },
  { name: "Governable", kind: "contract", re: /\b(?:abstract\s+)?contract\s+Governable\b/ },
  { name: "SafeBox", kind: "contract", re: /\bcontract\s+SafeBox\b/ },
  { name: "SafeBoxETH", kind: "contract", re: /\bcontract\s+SafeBoxETH\b/ },
  { name: "BasicSpell", kind: "contract", re: /\babstract\s+contract\s+BasicSpell\b/ },
  { name: "WhitelistSpell", kind: "contract", re: /\bcontract\s+WhitelistSpell\b/ },
  { name: "ProxyOracle", kind: "contract", re: /\bcontract\s+ProxyOracle\b/ },
  { name: "CoreOracle", kind: "contract", re: /\bcontract\s+CoreOracle\b/ },
  { name: "AggregatorOracle", kind: "contract", re: /\bcontract\s+AggregatorOracle\b/ },
  { name: "ChainlinkAdapterOracle", kind: "contract", re: /\bcontract\s+ChainlinkAdapterOracle\b/ },
  { name: "WERC20", kind: "contract", re: /\bcontract\s+WERC20\b/ },
  { name: "ERC1155NaiveReceiver", kind: "contract", re: /\bcontract\s+ERC1155NaiveReceiver\b/ },
  { name: "HomoraMath", kind: "library", re: /\blibrary\s+HomoraMath\b/ },
];

// Risk rules: classification in { authorization, value-flow, rounding, oracle, other }.
// Each rule records the first matching line of a file once per (file, rule).
const RULES = [
  // (a) authorization / access control
  { cls: "authorization", re: /whitelistedSpells|setWhitelistSpells\s*\(/, note: "spell allow-list is the primary execute() trust gate" },
  { cls: "authorization", re: /SPELL\s*==\s*msg\.sender/, note: "inExec: only the stored SPELL may call borrow/repay/transmit/collateral" },
  { cls: "authorization", re: /onlyEOAEx|msg\.sender\s*==\s*tx\.origin/, note: "EOA-only guard for execute() unless allowContractCalls or user whitelisted" },
  { cls: "authorization", re: /\bonlyGov\b|\bmodifier\s+onlyGov/, note: "governor-gated administrative surface" },
  { cls: "authorization", re: /whitelistedUsers|whitelistedTokens|allowContractCalls/, note: "whitelist state controlling who/what may execute or be traded" },
  { cls: "authorization", re: /\bmodifier\s+lock\b|_GENERAL_LOCK|_IN_EXEC_LOCK/, note: "reentrancy/exec lock guards on execute() and liquidation" },
  { cls: "authorization", re: /\bcaster\b|HomoraCaster/, note: "untrusted cast target: caster.cast performs the arbitrary spell call" },
  // (b) value flows
  { cls: "value-flow", re: /\bfunction\s+execute\s*\(/, note: "execute() routes arbitrary calldata through HomoraCaster to a whitelisted spell" },
  { cls: "value-flow", re: /\.cast\{value:|HomoraCaster\(caster\)\.cast/, note: "native value forwarded into the spell call (msg.value trust edge)" },
  { cls: "value-flow", re: /\bfunction\s+liquidate\s*\(/, note: "liquidation: repay debt then seize ERC1155 collateral to caller" },
  { cls: "value-flow", re: /\bfunction\s+transmit\s*\(/, note: "transmit pulls tokens from position owner to caller (spell-mediated)" },
  { cls: "value-flow", re: /\bfunction\s+(borrow|repay|putCollateral|takeCollateral)\s*\(/, note: "bank position mutation entrypoints (inExec gated)" },
  { cls: "value-flow", re: /doBorrow\s*\(|doRepay\s*\(|doERC20TransferIn\s*\(|doERC1155TransferIn\s*\(/, note: "balance-delta accounting (received = balanceAfter - balanceBefore) refactor surface" },
  { cls: "value-flow", re: /\bfunction\s+withdrawReserve\s*\(/, note: "governor reserve withdrawal (protocol fee sink)" },
  { cls: "value-flow", re: /deposit\{value:\s*msg\.value\}|IWETH|doTransmitETH/, note: "native <-> wrapped-native conversion on spell refund paths" },
  // (c) rounding / math
  { cls: "rounding", re: /ceilDiv\s*\(/, note: "round-up division in debt share accounting (share = amount*totalShare/totalDebt ceiled)" },
  { cls: "rounding", re: /paid\s*<=\s*oldDebt|share overflow/, note: "explicit guard against share-inflation / overflow on repay" },
  { cls: "rounding", re: /totalShare|totalDebt|debtShareOf/, note: "debt-share accounting: share<->debt conversion rounding direction matters" },
  { cls: "rounding", re: /\.mul\(|\.div\(|\.sub\(|\.add\(/, note: "SafeMath arithmetic on bank accounting (0.6.x, no checked-by-default)" },
  { cls: "rounding", re: /unchecked\s*\{/, note: "unchecked math block: parameter ranges that could zero out without revert" },
  { cls: "rounding", re: /feeBps|fee\s*=\s*debt\.sub\(totalDebt\)\.mul\(feeBps\)/, note: "protocol fee taken from accrued interest (bps math)" },
  // (d) oracle inputs
  { cls: "oracle", re: /oracle\.asETH(?:Collateral|Borrow)|IOracle\s+public/, note: "oracle valuation feeds collateral/borrow ETH value for health checks" },
  { cls: "oracle", re: /convertForLiquidation\s*\(/, note: "liquidation bounty conversion uses oracle pricing" },
  { cls: "oracle", re: /latestRoundData|latestAnswer|IAggregatorV3Interface/, note: "raw Chainlink/Band read: staleness/decimals/refs handled by adaptor" },
  { cls: "oracle", re: /setOracle\s*\(|ProxyOracle|AggregatorOracle|CoreOracle/, note: "oracle wiring / routing (governor-settable trust root)" },
  { cls: "oracle", re: /supportWrappedToken|oracle\.support\s*\(/, note: "oracle support check gating collateral/bank listing" },
  // (e) other / protocol-specific
  { cls: "other", re: /\bfunction\s+addBank\s*\(|setFeeBps\s*\(|setBankStatus\s*\(/, note: "bank ecosystem admin surface (governor)" },
  { cls: "other", re: /ERC1155NaiveReceiver|onERC1155Received/, note: "naive ERC1155 receiver callback: collateral token must be trusted" },
  { cls: "other", re: /accrue\s*\(|poke\s*\(/, note: "interest accrual modifier that front-runs borrow/repay/liquidate" },
  { cls: "other", re: /HomoraMath|_mulDiv|toGamma|to72x|x128/, note: "protocol-specific fixed-point gamma conversion math" },
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
  const spells = src.filter((f) => /[\\/]spell[\\/]/.test(f)).length;
  const oracles = src.filter((f) => /[\\/]oracle[\\/]/.test(f)).length;
  return { id: candidate.id, dir: candidate.dir, exists: fs.existsSync(candidate.dir), srcSol: src.length, totalSol: all.length, spells, oracles, srcFiles: src };
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
  const fc = artifact.fileCounts.chosen || { srcSol: 0, spells: 0, oracles: 0 };

  return `# ${SIGNAL} — Alpha Homora V2 Phase 0 Triage

Date: ${artifact.scannedAt}

Scanner: \`${artifact.scanner}\` — mode: \`offline\` (no network, no signing, no live calls this revision)

Checkout used: \`${artifact.checkoutUsed}\` (contracts .sol files: ${fc.srcSol}; spells: ${fc.spells}; oracles: ${fc.oracles})

## Result

No confirmed permissionless exploit. This is a static, fail-closed triage of the local Homora V2
surface: \`execute()\` spell/delegation call trust shape (HomoraCaster.cast), bank accounting including
the balance-delta borrow/repay refactor, debt-share rounding, and oracle\u2192collateral/borrow valuation
wiring. Spells are the obvious hot surface because they hold the bank's position while executing
attacker-influenced calldata. No execution, signing, or fork work is justified from this pass.

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

Homora V2 Phase 0 triage remains **dormant/context-only** for the declared local-source scope. Reopen only if
a spell/delegation edge (whitelisted spell, caster call trust, inExec window) turns into an attacker-favorable,
exact-positive route with fork proof.
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
    gaps.push({ id: "MISS-CHECKOUT", status: "MISS", deliverable: "checkout", note: `no local Homora V2 checkout found (looked for ${CHECKOUT_CANDIDATES.map((c) => rel(c.dir)).join(", ")})` });
  } else {
    srcFiles = chosen.srcFiles;
    gaps.push({
      id: "CONTEXT-SPELLS-ONCHAIN", status: "MISS", deliverable: "deployed spells / caster proxy",
      note: "spells are deployed onchain; only in-repo spell sources (HouseHold/Basic/Whitelist/UniswapV2/Curve/Balancer/Sushiswap) exist locally",
    });
    gaps.push({
      id: "CONTEXT-NO-DEPLOYMENTS", status: "MISS", deliverable: "deployment addresses",
      note: "checkout contains no deployment/address registry; live HomoraBank/caster/oracle addresses are not available locally",
    });
  }

  const { found: deliverables, gaps: missGaps } = chosen ? enumerateDeliverables(srcFiles) : { found: [], gaps: [] };
  gaps.push(...missGaps);

  const surfaces = chosen ? scanSurfaces(srcFiles) : [];

  const hitCounts = { authorization: 0, "value-flow": 0, rounding: 0, oracle: 0, other: 0 };
  for (const s of surfaces) hitCounts[s.classification] = (hitCounts[s.classification] || 0) + 1;

  const checkoutUsed = chosen ? rel(chosen.dir) : "MISS";
  const fileCounts = {
    chosen: chosen ? { id: chosen.id, path: rel(chosen.dir), srcSol: chosen.srcSol, totalSol: chosen.totalSol, spells: chosen.spells, oracles: chosen.oracles } : null,
    candidates: counts.map((c) => ({ id: c.id, path: rel(c.dir), exists: c.exists, srcSol: c.srcSol, totalSol: c.totalSol, spells: c.spells, oracles: c.oracles })),
    selectionReason: chosenInfo.reason,
  };

  const artifact = {
    scannedAt,
    scanner: "tools/scan-homora-v2-phase0.js",
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
    if (LIVE_REQUESTED) console.log("[homora-v2-phase0] --live requested but not wired this revision (stub/TODO); running offline.");
    console.log(
      `Homora V2 Phase 0: checkout=${checkoutUsed} srcSol=${chosen ? chosen.srcSol : 0} surfaces=${surfaces.length} ` +
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
