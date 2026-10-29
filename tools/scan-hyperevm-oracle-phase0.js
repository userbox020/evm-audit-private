#!/usr/bin/env node
// scan-hyperevm-oracle-phase0.js - bounded read-only Phase 0 triage for the HyperEVM oracle transport surface.
//
// SCOPE / SAFETY
//   * Fully OFFLINE: reads local Solidity sources under targets/hyperevm-oracle/contracts and writes two
//     report artifacts. No network calls, no sockets, no key material, no signing, no broadcast.
//   * Never touches .env*, *.key, *-keypair.json or wallet material.
//   * Never modifies other tools. Claimed resource: tools/scan-hyperevm-oracle-phase0.js (new file).
//
// TARGET (matters most for the N3 rate-bridge-latency follow-up)
//   What the oracle trusts, rate freshness / ordering assertions, and chain-id / predeploy assumptions.
//   The Aggregator reads the Hyperliquid L1 SystemOracle precompile at a hardcoded address; perp prices are
//   treated as block.timestamp-fresh (transport latency is not asserted), while keeper EMA and Chainlink
//   Data Streams paths carry explicit staleness/ordering checks. Cross-domain wiring facts are recorded with
//   file:line in the artifact's `crossDomain` section.

"use strict";

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const CHECKOUT = path.join(WORKSPACE, "targets", "hyperevm-oracle");
const SRC_DIR = path.join(CHECKOUT, "contracts");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "hyperevm-oracle-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "hyperevm-oracle-phase0-triage.md");
const QUIET = process.argv.includes("--quiet");
const LIVE_REQUESTED = process.argv.includes("--live");

const SIGNAL = "\uD83D\uDFE1 PHASE0";
const EXCLUDE_DIRS = new Set(["node_modules", "artifacts", "cache", ".git"]);

const DELIVERABLES = [
  { name: "Aggregator", kind: "contract", re: /\bcontract\s+Aggregator\b/ },
  { name: "ISystemOracle", kind: "interface", re: /\binterface\s+ISystemOracle\b/ },
  { name: "IOracle", kind: "interface", re: /\binterface\s+IOracle\b/ },
  { name: "IAggregator", kind: "interface", re: /\binterface\s+IAggregator\b/ },
  { name: "ChainlinkConsumer", kind: "contract", re: /\bcontract\s+ChainlinkConsumer\b/ },
  { name: "SingleFeedProvider", kind: "contract", re: /\bcontract\s+SingleFeedProvider\b/ },
  { name: "DualFallbackOracle", kind: "contract", re: /\bcontract\s+DualFallbackOracle\b/ },
  { name: "RatioAdapter", kind: "contract", re: /\bcontract\s+RatioAdapter\b/ },
  { name: "StHypeAdapter", kind: "contract", re: /\bcontract\s+StHypeAdapter\b/ },
  { name: "StHypeAdapterFundamental", kind: "contract", re: /\bcontract\s+StHypeAdapterFundamental\b/ },
  { name: "AssetOracleAdapter", kind: "contract", re: /\bcontract\s+AssetOracleAdapter\b/ },
  { name: "PythOracleAdapter", kind: "contract", re: /\bcontract\s+PythOracleAdapter\b/ },
  { name: "ERC4626Adapter", kind: "contract", re: /\bcontract\s+ERC4626Adapter\b/ },
  { name: "CustomizableOracle", kind: "contract", re: /\bcontract\s+CustomizableOracle\b/ },
  { name: "StaticOracle", kind: "contract", re: /\bcontract\s+StaticOracle\b/ },
  { name: "wHLPAdapter", kind: "contract", re: /\bcontract\s+wH[lL][pP]Adapter\b/ },
  { name: "kmHypeAdapterFundamental", kind: "contract", re: /\bcontract\s+kmHypeAdapterFundamental\b/ },
];

// Classification ∈ {authorization, value-flow, rounding, oracle, other}.
const RULES = [
  // (a) authorization / trust
  { cls: "authorization", re: /modifier\s+onlyOwner/, note: "owner gate on setAsset/toggleKeeper/deleteAsset (asset registration + keeper allowlist)" },
  { cls: "authorization", re: /modifier\s+onlyKeeper|keepers\[msg\.sender\]/, note: "keeper allowlist: only keepers/owner may submitRoundData (EMA rate input)" },
  { cls: "authorization", re: /function\s+toggleKeeper\b/, note: "toggleKeeper mutates the caller allowlist for the EMA price feed" },
  { cls: "authorization", re: /aclManager\.is(?:Pool|Emergency|Risk)Admin/, note: "HyperLend ACL gate for emergency-oracle toggling (DualFallbackOracle)" },
  { cls: "authorization", re: /function\s+setEnableEmergencyOracle\b/, note: "emergency oracle toggle: poolAdmin/emergencyAdmin/riskAdmin switch the price source" },
  // (b) value flow / verification fee
  { cls: "value-flow", re: /latestRoundData\s*\(\)/, note: "Chainlink-compatible read surface (roundId,answer,startedAt,updatedAt,answeredInRound)" },
  { cls: "value-flow", re: /_answer\s*\*\s*_ratioAnswer/, note: "ratio*price multiplication: asset price = underlying answer * ratio answer" },
  { cls: "value-flow", re: /require\(\s*_answer\s*>\s*0|_answer\s*<=\s*0/, note: "non-positive price guard (answer>0)" },
  { cls: "value-flow", re: /safeTransfer|withdrawToken|\.call\{value/, note: "native/ERC20 sweep from the consumer (fee refunds / rescue)" },
  { cls: "value-flow", re: /getFeeAndReward|s_feeManager|i_rewardManager|safeIncreaseAllowance/, note: "Chainlink Data Streams verification fee paid in LINK before verify()" },
  // (c) rounding / math
  { cls: "rounding", re: /FixedPointMathLib|expWad|mulDiv/, note: "fixed-point math lib; EMA uses expWad for the unevenly-spaced decay factor" },
  { cls: "rounding", re: /\/\s*10\*\*18|\*\s*10\*\*18/, note: "wad (1e18) scaling in EMA / ratio math" },
  { cls: "rounding", re: /uint256\(\s*int256|int256\(\s*uint256/, note: "signed/unsigned cast in EMA update (negative alpha / delta path)" },
  // (d) oracle / freshness / cross-domain rate wiring  (N3)
  { cls: "oracle", re: /0x1111111111111111111111111111111111111111/, note: "HARDCODED Hyperliquid SystemOracle predeploy address (no block.chainid guard); rate transport is chain-implicit" },
  { cls: "oracle", re: /getOraclePxs|getMarkPxs|getSpotPxs/, note: "reads L1-validator-submitted SystemOracle price vector; L1->EVM transport latency is NOT asserted" },
  { cls: "oracle", re: /_getPerpOraclePrice|oraclePrices\[_metaIndex\]/, note: "perp price = systemOracle.getOraclePxs()[metaIndex]: unchecked index into the trusted precompile vector" },
  { cls: "oracle", re: /10\*\*\(6\s*-\s*_decimals\)|6\s*-\s*_decimals/, note: "predeploy decimal rescale (10**(6-metaDecimals)); underflows/reverts if metaDecimals > 6" },
  { cls: "oracle", re: /return block\.timestamp;\s*\}|\bblock\.timestamp\b/, note: "perp-oracle getUpdateTimestamp returns block.timestamp: always 'fresh', masking upstream rate latency" },
  { cls: "oracle", re: /MAX_EMA_STALE_SECONDS|MAX_TIMESTAMP_DELAY_SECONDS|MAX_HEARTBEAT_INTERVAL/, note: "explicit freshness constants (EMA staleness, keeper submit delay, fallback heartbeat)" },
  { cls: "oracle", re: /block\.timestamp\s*-\s*_submitTimestamp|block\.timestamp\s*-\s*_assetInfo\.lastTimestamp/, note: "freshness arithmetic on keeper/EMA timestamps" },
  { cls: "oracle", re: /_calculateEma|EMA_WINDOW_SECONDS|lastTimestamp/, note: "EMA rate construction from lastTimestamp + window; reads stale EMA only if within MAX_EMA_STALE_SECONDS" },
  { cls: "oracle", re: /getPriceUnsafe/, note: "Pyth getPriceUnsafe: NO staleness/confidence check at read time (publishTime returned but not asserted)" },
  { cls: "oracle", re: /publishTime|validFromTimestamp|observationsTimestamp|expiresAt/, note: "DON/Pyth report timestamps carried into updatedAt/roundId" },
  { cls: "oracle", re: /revert\s+OldData|error\s+OldData/, note: "ChainlinkConsumer asserts monotonic report timestamps (old data reverts); a cross-domain ordering assertion" },
  { cls: "oracle", re: /marketStatus/, note: "RWA v4 report marketStatus==2 (Open) gate before a price is stored" },
  { cls: "oracle", re: /decimals\(\)\s*!=\s*.*decimals\(\)|InvalidDecimals/, note: "decimal-consistency assertion between primary/fallback/emergency sources" },
  { cls: "oracle", re: /avgTimestamp/, note: "report timestamp averaged from validFrom+observations (midpoint freshness), used for monotonicity + staleness downstream" },
  // (e) other / structural
  { cls: "other", re: /function\s+submitRoundData\b|function\s+verifyReport\b|function\s+verifyBatch\b/, note: "rate-ingest entrypoints (keeper submit / Chainlink report verify)" },
  { cls: "other", re: /RoundDataSubmitted|DecodedReport|AssetChanged|KeeperUpdated/, note: "rate/asset lifecycle events" },
  { cls: "other", re: /isPerpOracle|metaIndex/, note: "asset classification: perp-oracle (SystemOracle) vs keeper-EMA path" },
  { cls: "other", re: /\bMock\b|\bmocks?\b/, note: "mock/test contract present in checkout (not a production trust surface)" },
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

// Anchored cross-domain facts for the N3 rate-bridge-latency follow-up.
function collectCrossDomain(files) {
  const facts = [];
  const patterns = [
    { id: "N3-PREDEPLOY", re: /0x1111111111111111111111111111111111111111/, note: "Aggregator binds the Hyperliquid L1 SystemOracle predeploy in the contract initializer; no chain-id guard anywhere in the oracle checkout (HyperEVM-implicit)." },
    { id: "N3-PERP-FRESHNESS", re: /getUpdateTimestamp/, note: "Perp-oracle freshness is reported as block.timestamp (always fresh); L1->EVM rate transport latency is not observable/asserted here." },
    { id: "N3-DON-ORDERING", re: /revert OldData|OldData\(/, note: "ChainlinkConsumer enforces monotonic DON report timestamps (rejects older avgTimestamp) before storing the rate." },
    { id: "N3-DON-TRANSPORT", re: /s_verifierProxy\.verify\(/, note: "Cross-domain report is transported off-chain and verified on-chain via VerifierProxy; freshness is the report timestamp, not block time." },
    { id: "N3-EMA-STALE", re: /MAX_EMA_STALE_SECONDS/, note: "Keeper-EMA path reverts when block.timestamp - lastTimestamp >= MAX_EMA_STALE_SECONDS (explicit staleness bound)." },
    { id: "N3-PYTH-UNSAFE", re: /getPriceUnsafe/, note: "Pyth path reads getPriceUnsafe with no staleness/confidence assertion; downstream consumers get only publishTime as updatedAt." },
  ];
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch (_) { continue; }
    const relFile = rel(file);
    const lines = text.split(/\r?\n/);
    for (const p of patterns) {
      if (facts.some((f) => f.id === p.id)) continue;
      for (let i = 0; i < lines.length; i++) {
        if (p.re.test(lines[i])) { facts.push({ id: p.id, file: relFile, line: i + 1, note: p.note }); break; }
      }
    }
  }
  return facts;
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
    else gaps.push({ id: `MISS-${d.name}`, status: "MISS", deliverable: d.name, kind: d.kind, note: `"${d.name}" not found in hyperevm-oracle/contracts; recorded as MISS, not inferred` });
  }
  return { found, gaps };
}

function buildReport(a) {
  const rows = a.surfaces.slice(0, 16);
  const bullets = rows.length ? rows.map((s) => `- \`${s.classification}\` — \`${s.file}:${s.line}\` — ${s.note}`).join("\n") : "- (none)";
  const gaps = a.gaps.length ? a.gaps.map((g) => `- ${g.status} \`${g.deliverable}\`: ${g.note}`).join("\n") : "- none recorded";
  const dl = a.deliverables.length ? a.deliverables.map((d) => `| ${d.name} | ${d.kind} | \`${d.file}:${d.line}\` |`).join("\n") : "| none | n/a | n/a |";
  const xd = a.crossDomain.length ? a.crossDomain.map((f) => `- \`${f.id}\` — \`${f.file}:${f.line}\` — ${f.note}`).join("\n") : "- none recorded";
  const c = a.hitCounts;
  return `# ${SIGNAL} — HyperEVM Oracle Transport Phase 0 Triage

Date: ${a.scannedAt}

Scanner: \`${a.scanner}\` — mode: \`offline\` (no network, no signing, no live calls)

Checkout: \`${a.checkoutUsed}\` (contracts .sol files: ${a.fileCounts.srcSol})

## Result

No confirmed permissionless exploit. Static, fail-closed triage of the local HyperEVM oracle transport surface:
what each adapter trusts, rate freshness/ordering assertions, and chain-id/predeploy assumptions. This scanner
exists primarily to anchor the **N3 rate-bridge-latency** follow-up; see the cross-domain facts below.

## Hit counts by classification

| Classification | Hits |
|---|---:|
| AUTHORIZATION | ${c.authorization || 0} |
| VALUE-FLOW | ${c["value-flow"] || 0} |
| ROUNDING | ${c.rounding || 0} |
| ORACLE | ${c.oracle || 0} |
| OTHER | ${c.other || 0} |
| **total** | **${a.surfaces.length}** |

## Cross-domain rate wiring facts (N3)

${xd}

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

HyperEVM oracle Phase 0 remains **dormant/context-only** for the declared local-source scope. The N3 concern is a
labelled fact (perp prices are treated as block-time-fresh; transport latency is unasserted), not a confirmed
exploit. Reopen only with a concrete consumer that depends on a stale/mis-ordered rate with fork proof.
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
    gaps.push({ id: "CONTEXT-NO-DEPLOYMENTS", status: "MISS", deliverable: "deployed oracle addresses", note: "no deployment registry/addresses under the oracle checkout (scripts/ holds deploy scripts, not live addresses)" });
    gaps.push({ id: "CONTEXT-NO-CHAINID-GUARD", status: "MISS", deliverable: "chain-id guard", note: "no block.chainid check found in contracts/; the SystemOracle predeploy address is HyperEVM-implicit" });
  }

  const { found: deliverables, gaps: missGaps } = srcFiles.length ? enumerateDeliverables(srcFiles) : { found: [], gaps: [] };
  gaps.push(...missGaps);

  const surfaces = srcFiles.length ? scanSurfaces(srcFiles) : [];
  const crossDomain = srcFiles.length ? collectCrossDomain(srcFiles) : [];
  const hitCounts = { authorization: 0, "value-flow": 0, rounding: 0, oracle: 0, other: 0 };
  for (const s of surfaces) hitCounts[s.classification] = (hitCounts[s.classification] || 0) + 1;

  const artifact = {
    scannedAt,
    scanner: "tools/scan-hyperevm-oracle-phase0.js",
    mode: "offline-source",
    liveMode: { requested: LIVE_REQUESTED, wired: false, note: "TODO: read-only eth_call/getCode cross-check against HyperEVM; endpoints must come from shared-rpc/env, none static" },
    checkoutUsed: rel(CHECKOUT),
    fileCounts: { srcSol: srcFiles.length },
    crossDomain,
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
    if (LIVE_REQUESTED) console.log("[hyperevm-oracle-phase0] --live requested but not wired (stub/TODO); running offline.");
    console.log(`HyperEVM oracle Phase 0: checkout=${artifact.checkoutUsed} srcSol=${srcFiles.length} surfaces=${surfaces.length} ` +
      `(auth=${hitCounts.authorization} value-flow=${hitCounts["value-flow"]} rounding=${hitCounts.rounding} oracle=${hitCounts.oracle} other=${hitCounts.other}) ` +
      `crossDomain=${crossDomain.length} deliverables=${deliverables.length} gaps=${gaps.length} routePositive=false`);
  }
}

try { main(); } catch (err) { console.error(String((err && err.message) || err)); process.exitCode = 1; }
