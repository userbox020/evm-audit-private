#!/usr/bin/env node
"use strict";

// scan-fee-param-trust.js -- class N5 static sweep: fee-parameter trust on new chains.
//
// SELF-TEST / RUN:
//   node --check tools/scan-fee-param-trust.js
//   node tools/scan-fee-param-trust.js
//   node tools/scan-fee-param-trust.js --out reports/raw/fast/fee-param-trust/r1.json
// No args required, deterministic, idempotent (fresh file reads each run), no
// network, no signing, no private-key material.
//
// ---------------------------------------------------------------------------
// CLASS NOTE (why this matters)
// ---------------------------------------------------------------------------
// On newly-added chains the fee model is not the L1 model. A contract that trusts
// `tx.gasprice` / `block.basefee` / `gasleft()` / an L1-data-fee precompile or
// predeploy (GasPriceOracle 0x42..0F, L1Block 0x42..15, precompile 0x0a / L1SLOAD
// where present) to compute a fee, a refund, or a gas gate is trusting a value
// whose semantics differ on an OP-stack / Arbitrum / custom-gas chain (different
// basefee plumbing, L1 calldata-fee surcharge, gas metering changes, or a missing
// predeploy). A mis-scaled base fee silently over/under-charges or reverts a value
// path. Hits are classified:
//   FEE_MATH     -> the gas/env value feeds an arithmetic fee/cost computation
//   REFUND_PATH  -> it feeds a refund / rebate / leftover-return path
//   GAS_GATING   -> it feeds a require/if gas-threshold gate (incl. gasleft)
//   NODE         -> it is a raw node/env assumption or a precompile/predeploy id
//
// ETHOS (honest grounding): this is a SOURCE-ONLY sweep. New-chain fee-model
// checkouts were sparse; only targets/beefy-contracts-4621d2dd is fee-model
// adjacent, so the shared lending/vault roster is also swept and each target's
// fee-model relevance is labelled. Absence of hits is a valid pinned negative.
// ---------------------------------------------------------------------------

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const WORKSPACE = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// CONFIG (editable target list -- keep it bounded)
// ---------------------------------------------------------------------------
const CONFIG = {
  schema: "fee-param-trust-scan/v1",
  tool: "scan-fee-param-trust",
  toolClass: "N5",
  artifact: path.join(WORKSPACE, "reports", "raw", "fast", "fee-param-trust", "r1.json"),
  targetRoot: path.join(WORKSPACE, "targets"),
  // Sparse deployed-facing sweep: tests/scripts are skipped, not scanned.
  includeTests: false,
  includeScripts: false,
  excludeDirs: [
    "node_modules", "out", "artifacts", "cache", "broadcast", "forge-std",
    "dist", "build", "coverage", ".git", "typechain", "typechain-types", ".deps",
  ],
  maxHitsPerTarget: 400,
  maxFileBytes: 3_000_000,
  contextWindow: 8,
  // dir + honest fee-model relevance label
  targets: [
    { dir: "beefy-contracts-4621d2dd", relevance: "primary-fee-model" },
    { dir: "aave-v3-origin", relevance: "roster-context" },
    { dir: "aave-horizon-mglobal-pr13-92a16781", relevance: "roster-context" },
    { dir: "origin-dollar-37175c", relevance: "roster-context" },
    { dir: "compound-comet", relevance: "roster-context" },
    { dir: "morpho-blue", relevance: "roster-context" },
    { dir: "morpho-vault-v2", relevance: "roster-context" },
    { dir: "euler-evk", relevance: "roster-context" },
    { dir: "euler-evc", relevance: "roster-context" },
    { dir: "fluid-contracts-public", relevance: "roster-context" },
    { dir: "liquity-bold", relevance: "roster-context" },
    { dir: "stargate-v2", relevance: "roster-context" },
    { dir: "layerzero-v2", relevance: "roster-context" },
    { dir: "venus-isolated-pools", relevance: "roster-context" },
    { dir: "sparklend-v1-core", relevance: "roster-context" },
  ],
  ethos: "New-chain fee-model deployment grounding was sparse: only targets/beefy-contracts-4621d2dd is fee-model adjacent. The same bounded lending/vault roster as scan-eoa-gates is therefore swept as context, and every target carries an explicit relevance label. Negative (0-hit) targets are honest pins, not coverage claims.",
};

// ---------------------------------------------------------------------------
// idiom / classification rules
// ---------------------------------------------------------------------------
const PATTERNS = Object.freeze([
  { id: "tx.gasprice", re: /\btx\.gasprice\b/i },
  { id: "block.basefee", re: /\bblock\.basefee\b/i },
  { id: "block.blobbasefee", re: /\bblock\.blobbasefee\b/i },
  { id: "gasleft", re: /\bgasleft\s*\(/ },
  { id: "yul-basefee", re: /\bbasefee\s*\(/ },
  { id: "yul-gasprice", re: /\bgasprice\s*\(/ },
  { id: "l1-fee-getter", re: /\bgetL1Fee\b|\bl1Fee\b|\bL1_FEE\b|\bgetL1GasUsed\b/ },
  { id: "gas-price-oracle", re: /\b(OVM_)?GasPriceOracle\b/ },
  { id: "l1-block", re: /\bL1Block(Number|Address)?\b|\bL1_BLOCK\b/ },
  { id: "precompile-0x0a", re: /\bL1SLOAD\b|\baddress\s*\(\s*0x0*a\s*\)/i },
  { id: "l1-fee-predeploy", re: /0x420000000000000000000000000000000000000[fF]\b|0x4200000000000000000000000000000000000015\b|0x420000000000000000000000000000000000001[aA]\b/ },
]);
const PRECOMPILE_IDIOMS = new Set(["precompile-0x0a", "l1-fee-predeploy", "gas-price-oracle", "l1-block"]);

const FUNC_START = /^\s*(?:function\s+([A-Za-z_$][\w$]*)\s*\(|constructor\s*\(|(receive|fallback)\s*\(|modifier\s+([A-Za-z_$][\w$]*)\s*\()/;
const REFUND_RE = /\b(refund|reimburse|rebate|gasback|swapback|leftover|excess|unused|remainder)\w*/i;
const FEE_RE = /\b(fee|charge|cost|price|calc|quote|pay|payment|value|amount|gasused|basis|debt|asset|reimburse)\w*/i;
const GATING_RE = /\b(require|assert|revert|min|max|enough|limit|forward|remaining|threshold|bound|leftover|check)\w*/i;
const ATTEST_RE = /\b(attest|oracle|predeploy|precompile)\w*/i;

const CLASSIFICATIONS = Object.freeze(["FEE_MATH", "REFUND_PATH", "GAS_GATING", "NODE"]);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function relPosix(target) { return target.split(path.sep).join("/"); }
function relFromWorkspace(file) { return relPosix(path.relative(WORKSPACE, file)); }

function atomicWriteJson(file, value, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${crypto.randomUUID()}`;
  try {
    fsImpl.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    fsImpl.renameSync(temporary, file);
  } finally {
    try { fsImpl.rmSync(temporary, { force: true }); } catch (_) { /* ignore */ }
  }
}

// Nearest-preceding function signature (same documented heuristic as scan-eoa-gates).
function parseEnclosing(lines) {
  const out = new Array(lines.length).fill(null);
  let current = null;
  let acc = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (acc === null) {
      const m = FUNC_START.exec(line);
      if (m) {
        let kind = "function";
        let name = m[1] || null;
        if (/^\s*constructor\s*\(/.test(line)) { kind = "constructor"; name = "constructor"; }
        else if (/^\s*modifier\s*/.test(line)) { kind = "modifier"; name = m[3] || null; }
        else if (/^\s*receive\s*\(/.test(line)) { kind = "receive"; name = "receive"; }
        else if (/^\s*fallback\s*\(/.test(line)) { kind = "fallback"; name = "fallback"; }
        acc = { kind, name, text: line };
      }
    } else {
      acc.text += ` ${line}`;
    }
    if (acc !== null && /[;{]/.test(line)) {
      const head = acc.text.split("{")[0].split(";")[0];
      current = { kind: acc.kind, name: acc.name, isView: /\b(view|pure)\b/.test(head), signatureLine: i + 1 };
      acc = null;
    }
    out[i] = current;
  }
  return out;
}

function walkSolidity(dir, cfg, stats) {
  const files = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (_) { return files; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      const name = entry.name.toLowerCase();
      if (cfg.excludeDirs.includes(name) || name.startsWith("forge-std")) { stats.skippedDirs += 1; continue; }
      files.push(...walkSolidity(full, cfg, stats));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".sol")) {
      files.push(full);
    }
  }
  return files;
}

const TEST_PATH_RE = /(^|\/)(tests?|__tests__|mocks?)(\/|$)/i;
const SCRIPT_PATH_RE = /(^|\/)(scripts?|deploy(ments?)?|tasks?)(\/|$)/i;
function isTestPath(rel) { return TEST_PATH_RE.test(rel); }
function isScriptPath(rel) { return SCRIPT_PATH_RE.test(rel); }

// Pure comment / doc lines are not code; skip so prose mentioning "basefee" or
// "@param tx.gasprice" is not reported as an idiom hit.
function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("*/");
}

function classifyFee({ idiom, funcInfo, context, lineText }) {
  const fn = funcInfo && funcInfo.name ? funcInfo.name : "";
  const hay = `${fn} ${context}`;
  if (REFUND_RE.test(hay)) {
    return { classification: "REFUND_PATH", note: "REFUND_PATH: the gas/env value feeds a refund/rebate/leftover path; on a new chain the refunded amount is computed from a differently-scaled basefee/L1-fee." };
  }
  if (PRECOMPILE_IDIOMS.has(idiom) || ATTEST_RE.test(hay)) {
    return { classification: "NODE", note: "NODE: precompile/predeploy id or node/env fee source (GasPriceOracle 0x42..0F / L1Block 0x42..15 / precompile 0x0a). Trusting it presumes the new chain exposes the same address with the same semantics." };
  }
  if (idiom === "gasleft") {
    return { classification: "GAS_GATING", note: "GAS_GATING: gasleft() consumed in a gas-threshold branch; gas metering differs across new chains, so the gate can flip." };
  }
  // An explicit require/if gas comparison is a gate, not fee arithmetic.
  const isGate = /\b(require|assert|revert)\s*\(/.test(lineText)
    || /^\s*if\s*\(/.test(lineText)
    || /[<>]=?/.test(lineText);
  if (isGate && /gasprice|basefee/.test(idiom)) {
    return { classification: "GAS_GATING", note: "GAS_GATING: tx.gasprice/block.basefee consumed in a gas-threshold gate; basefee plumbing differs on new chains, so the gate can admit/reject differently." };
  }
  if (idiom === "l1-fee-getter") {
    return { classification: "FEE_MATH", note: "FEE_MATH: L1 data-fee getter feeds fee arithmetic; the L1 surcharge model differs per chain/runtime." };
  }
  if (/([*\/])/.test(lineText) || FEE_RE.test(hay)) {
    return { classification: "FEE_MATH", note: "FEE_MATH: tx.gasprice/block.basefee feeds fee/cost arithmetic; basefee plumbing and units differ on new chains." };
  }
  return { classification: "NODE", note: "NODE: raw node/env gas value consumed without a fee-math or refund branch in context; a node-level semantic assumption." };
}

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------
function scanTarget(spec, cfg) {
  const dir = path.join(cfg.targetRoot, spec.dir);
  const result = {
    target: spec.dir,
    relevance: spec.relevance,
    dir: relFromWorkspace(dir),
    status: "SCANNED",
    filesScanned: 0,
    filesSkipped: 0,
    hits: 0,
    byClassification: { FEE_MATH: 0, REFUND_PATH: 0, GAS_GATING: 0, NODE: 0 },
    byIdiom: {},
    truncated: false,
    missReason: null,
  };
  const hits = [];
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    result.status = "MISS";
    result.missReason = "target-directory-absent";
    return { result, hits };
  }
  const walkStats = { skippedDirs: 0 };
  const files = walkSolidity(dir, cfg, walkStats).sort();
  for (const file of files) {
    const rel = relFromWorkspace(file);
    const inTest = isTestPath(rel);
    const inScript = isScriptPath(rel);
    if ((!cfg.includeTests && inTest) || (!cfg.includeScripts && inScript)) { result.filesSkipped += 1; continue; }
    let stat;
    try { stat = fs.statSync(file); } catch (_) { result.filesSkipped += 1; continue; }
    if (stat.size > cfg.maxFileBytes) { result.filesSkipped += 1; continue; }
    let text;
    try { text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""); }
    catch (_) { result.filesSkipped += 1; continue; }
    result.filesScanned += 1;
    const deployedFacing = !(inTest || inScript);
    const lines = text.split(/\r?\n/);
    const enclosing = parseEnclosing(lines);
    for (let i = 0; i < lines.length; i += 1) {
      const lineText = lines[i];
      if (isCommentLine(lineText)) continue;
      const matched = [];
      for (const p of PATTERNS) if (p.re.test(lineText)) matched.push(p.id);
      if (matched.length === 0) continue;
      const funcInfo = enclosing[i];
      const lo = Math.max(0, i - cfg.contextWindow);
      const hi = Math.min(lines.length, i + cfg.contextWindow + 1);
      const context = `${funcInfo && funcInfo.name ? funcInfo.name : ""} ${lines.slice(lo, hi).join(" ")}`;
      for (const idiom of [...new Set(matched)]) {
        const verdict = classifyFee({ idiom, funcInfo, context, lineText });
        result.byIdiom[idiom] = (result.byIdiom[idiom] || 0) + 1;
        result.byClassification[verdict.classification] = (result.byClassification[verdict.classification] || 0) + 1;
        hits.push({
          target: spec.dir,
          file: rel,
          line: i + 1,
          idiom,
          classification: verdict.classification,
          deployedFacing,
          function: funcInfo && funcInfo.name ? funcInfo.name : null,
          note: verdict.note,
          snippet: lineText.trim().slice(0, 300),
        });
      }
    }
  }
  hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.idiom.localeCompare(b.idiom));
  if (hits.length > cfg.maxHitsPerTarget) {
    result.truncated = true;
    hits.length = cfg.maxHitsPerTarget;
  }
  result.hits = hits.length;
  return { result, hits };
}

function scan(options = {}) {
  const cfg = { ...CONFIG, ...(options.config || {}) };
  if (options.out) cfg.artifact = options.out;
  if (options.targets) cfg.targets = options.targets.map((t) => (typeof t === "string" ? { dir: t, relevance: "explicit" } : t));
  const perTarget = [];
  const hits = [];
  for (const spec of cfg.targets) {
    const { result, hits: targetHits } = scanTarget(spec, cfg);
    perTarget.push(result);
    hits.push(...targetHits);
  }
  const byClassification = { FEE_MATH: 0, REFUND_PATH: 0, GAS_GATING: 0, NODE: 0 };
  const byIdiom = {};
  for (const h of hits) {
    byClassification[h.classification] = (byClassification[h.classification] || 0) + 1;
    byIdiom[h.idiom] = (byIdiom[h.idiom] || 0) + 1;
  }
  const artifact = {
    schema: cfg.schema,
    tool: cfg.tool,
    toolClass: cfg.toolClass,
    scannedAt: new Date().toISOString(),
    targetRoot: relFromWorkspace(cfg.targetRoot),
    artifactPath: relFromWorkspace(cfg.artifact),
    ethos: cfg.ethos,
    config: {
      includeTests: cfg.includeTests,
      includeScripts: cfg.includeScripts,
      maxHitsPerTarget: cfg.maxHitsPerTarget,
      contextWindow: cfg.contextWindow,
      excludeDirs: cfg.excludeDirs,
      targets: cfg.targets.map((t) => ({ dir: t.dir, relevance: t.relevance })),
    },
    totals: {
      targetsRequested: cfg.targets.length,
      targetsScanned: perTarget.filter((t) => t.status === "SCANNED").length,
      targetsMiss: perTarget.filter((t) => t.status === "MISS").length,
      targetsWithHits: perTarget.filter((t) => t.hits > 0).length,
      filesScanned: perTarget.reduce((n, t) => n + t.filesScanned, 0),
      filesSkipped: perTarget.reduce((n, t) => n + t.filesSkipped, 0),
      hits: hits.length,
      hitsTruncated: perTarget.some((t) => t.truncated),
      byClassification,
      byIdiom,
    },
    perTarget,
    hits,
    notScanned: perTarget.filter((t) => t.status === "MISS").map((t) => ({ target: t.target, reason: t.missReason })),
    notes: [
      "Source-only static sweep; no RPC, no signing, no execution.",
      "Classification is heuristic (nearest-preceding signature + context window); a triage label, not a proof of live reachability.",
      "Sparse/deployed-facing: test and script files are skipped by default (includeTests/includeScripts), so a 0-hit target is a negative pin, not coverage of its tests.",
      "Vendored/build directories (node_modules/out/artifacts/cache/broadcast/forge-std*/dist/build/coverage/.git/typechain/.deps) are excluded.",
    ],
  };
  atomicWriteJson(cfg.artifact, artifact);
  return artifact;
}

function oneLine(a) {
  const c = a.totals.byClassification;
  return `${a.tool} (N5): ${a.totals.targetsScanned}/${a.totals.targetsRequested} targets scanned, ${a.totals.targetsMiss} MISS, ` +
    `${a.totals.filesScanned} files, ${a.totals.hits} hits ` +
    `[FEE_MATH=${c.FEE_MATH} REFUND_PATH=${c.REFUND_PATH} GAS_GATING=${c.GAS_GATING} NODE=${c.NODE}]` +
    `${a.totals.hitsTruncated ? " (TRUNCATED)" : ""} -> ${a.artifactPath}`;
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--out" && argv[i + 1]) { options.out = path.resolve(WORKSPACE, argv[++i]); }
    else if (a.startsWith("--out=")) { options.out = path.resolve(WORKSPACE, a.slice("--out=".length)); }
    else if (a === "--targets" && argv[i + 1]) { options.targets = argv[++i].split(",").map((s) => s.trim()).filter(Boolean); }
    else if (a.startsWith("--targets=")) { options.targets = a.slice("--targets=".length).split(",").map((s) => s.trim()).filter(Boolean); }
  }
  return options;
}

if (require.main === module) {
  try {
    const artifact = scan(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${oneLine(artifact)}\n`);
  } catch (error) {
    process.stderr.write(`scan-fee-param-trust: FAILED ${error && error.message ? error.message : error}\n`);
    process.exitCode = 1;
  }
}

module.exports = { scan, scanTarget, parseEnclosing, classifyFee, CONFIG };
