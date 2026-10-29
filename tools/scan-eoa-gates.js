#!/usr/bin/env node
"use strict";

// scan-eoa-gates.js -- class N2 static sweep: EIP-7702 EOA-classification drift.
//
// SELF-TEST / RUN:
//   node --check tools/scan-eoa-gates.js
//   node tools/scan-eoa-gates.js
//   node tools/scan-eoa-gates.js --out reports/raw/fast/eoa-gates/r1.json
// No args required, deterministic, idempotent (fresh file reads each run), no
// network, no signing, no private-key material.
//
// ---------------------------------------------------------------------------
// CLASS NOTE (why this matters)
// ---------------------------------------------------------------------------
// EIP-7702 lets an EOA install a "delegation designator" so its account code is
// the 23-byte prefix 0xef0100 || <delegate address> instead of empty. The in-tree
// pin proves the exact runtime shape:
//   targets/origin-dollar-37175c/contracts/tests/unit/token/OUSD/concrete/EIP7702.t.sol
//     bytes3(eip7702User.code) == 0xef0100   and   eip7702User.code.length == 23
// with the test asserting the delegated account is "TreatedAsEOA".
//
// So every is-EOA idiom built on code absence FLIPS for a delegated EOA:
//   * `code.length == 0` / `extcodesize(x) == 0` / `!isContract(x)`  -> now FALSE
//     for a 7702 EOA (it looks like a contract).
//   * `require(isContract(x))` / `code.length > 0`                  -> now TRUE
//     for a 7702 EOA (it passes a "must be a real contract" guard).
//
// The interesting (VALUE_GATE) hits are upstream value branches that consult one
// of these idioms inside a STATE-CHANGING path -- rebase/accrual participation
// gates, reward/timeline accrual gates, refund/exclusion lists, fee delivery, or
// "is this a contract, therefore exclude from rebase / skip transfer" logic --
// because a delegated EOA silently moves to the other side of the branch.
// Constructor / factory-deploy-time checks and view-only helpers are classified
// DEPLOYMENT_TIME (safe) or UNKNOWN (flagged), not VALUE_GATE.
//
// This is a SOURCE-ONLY sweep. It cannot prove live deployment reachability; it
// enumerates candidate sites honestly labelled by static classification.
// ---------------------------------------------------------------------------

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const WORKSPACE = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// CONFIG (editable target list -- keep it bounded)
// ---------------------------------------------------------------------------
const CONFIG = {
  schema: "eoa-gates-scan/v1",
  tool: "scan-eoa-gates",
  toolClass: "N2",
  artifact: path.join(WORKSPACE, "reports", "raw", "fast", "eoa-gates", "r1.json"),
  targetRoot: path.join(WORKSPACE, "targets"),
  // Deployed-facing sweep: tests/mocks/scripts are tagged, not silently dropped.
  includeTests: true,
  includeScripts: true,
  // Vendored/build directories are excluded so the sweep is deployed-facing.
  excludeDirs: [
    "node_modules", "out", "artifacts", "cache", "broadcast", "forge-std",
    "dist", "build", "coverage", ".git", "typechain", "typechain-types", ".deps",
  ],
  maxHitsPerTarget: 400,
  maxFileBytes: 3_000_000,
  contextWindow: 8,
  targets: [
    "aave-v3-origin",
    "aave-horizon-mglobal-pr13-92a16781",
    "origin-dollar-37175c",
    "compound-comet",
    "morpho-blue",
    "morpho-vault-v2",
    "euler-evk",
    "euler-evc",
    "fluid-contracts-public",
    "liquity-bold",
    "stargate-v2",
    "layerzero-v2",
    "venus-isolated-pools",
    "sparklend-v1-core",
  ],
};

// ---------------------------------------------------------------------------
// idiom / classification rules
// ---------------------------------------------------------------------------
const IDIOM_PATTERNS = Object.freeze([
  { id: "code.length", re: /\.code\.length\b/ },
  { id: "code.size", re: /\.code\.size\b/ },
  { id: "address.code", re: /\.code\b(?!\.(?:length|size))/ },
  { id: "extcodesize", re: /\bextcodesize\b/ },
  { id: "isContract", re: /\b_?isContract\w*\s*\(/ },
  { id: "hasCode", re: /\b_?hasCode\w*\s*\(/ },
]);
const CODE_CHECK_RE = /\.code\.length\b|\.code\.size\b|\.code\b(?!\.(?:length|size))|\bextcodesize\b|\b_?isContract\w*\s*\(|\b_?hasCode\w*\s*\(/;
const SUPPORTS_INTERFACE_RE = /\bsupportsInterface\s*\(/;

const FUNC_START = /^\s*(?:function\s+([A-Za-z_$][\w$]*)\s*\(|constructor\s*\(|(receive|fallback)\s*\(|modifier\s+([A-Za-z_$][\w$]*)\s*\()/;
// Creation/deployment *code* idioms only (so a comment mentioning "constructor"
// or "construction" cannot mislabel a runtime value path). Constructor and
// initializer are detected from the enclosing signature, not from prose.
const CREATION_CTX = /\b(createDeterministic|predictCreateDeterministic|\bnew\s+[A-Z]\w*\s*\(|\bcreate2\b|\bcreate\s*\(|_deploy\w*|deployTo\b|deployContract\b|__[A-Za-z]*_init\w*|initializer)\b/;
const VALUE_CTX = /\b(rebase|accrual|accrue|reward|claim|mint|burn|transfer|redeem|deposit|withdraw|withdrawal|stake|unstake|timeline|supply|distribut|refund|fee|liq|liquidat|balance|debt|borrow|repay|swap|exit|rebalanc)\w*/i;
const TEST_PATH_RE = /(^|\/)(tests?|__tests__|mocks?)(\/|$)/i;
const SCRIPT_PATH_RE = /(^|\/)(scripts?|deploy(ments?)?|tasks?)(\/|$)/i;

// Pure comment / doc lines are not code; skip so prose mentioning "extcodesize"
// or "constructor" is not reported as an idiom hit.
function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("*/");
}

const CLASSIFICATIONS = Object.freeze(["DEPLOYMENT_TIME", "VALUE_GATE", "UNKNOWN"]);

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

// Nearest-preceding function/constructor signature enclosing each line.
// Heuristic (documented): starts on a `function`/`constructor`/`modifier`/
// `receive`/`fallback` signature and finalizes at the first `{` or `;`; the
// signature text is tested for view/pure. Good enough for static labelling.
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
      current = {
        kind: acc.kind,
        name: acc.name,
        isView: /\b(view|pure)\b/.test(head),
        signatureLine: i + 1,
      };
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

function isTestPath(rel) { return TEST_PATH_RE.test(rel); }
function isScriptPath(rel) { return SCRIPT_PATH_RE.test(rel); }

function classifyEoa({ idiom, funcInfo, context, deployedFacing, lineText }) {
  const fnName = funcInfo && funcInfo.name ? funcInfo.name : "";
  if (!deployedFacing) {
    return { classification: "UNKNOWN", note: "TEST_OR_SCRIPT_FILE_NOT_DEPLOYED_FACING: recorded for 7702 context, not a deployed value path." };
  }
  const isHelperDef = /function\s+_?isContract\w*\s*\(/.test(lineText)
    || (idiom !== "erc165-hasCode" && /^_?isContract\w*$/i.test(fnName));
  if (isHelperDef) {
    return { classification: "UNKNOWN", note: "HELPER_DEFINITION: declares or implements the is-EOA helper; not itself a gate. Call sites are classified separately." };
  }
  const isConstructor = funcInfo && funcInfo.kind === "constructor";
  const isView = funcInfo && funcInfo.isView;
  if (isView && !isConstructor) {
    return { classification: "UNKNOWN", note: "VIEW_OR_PURE: not a state-changing value path; classified UNKNOWN (not a VALUE_GATE)." };
  }
  const isInitializer = /^_?initializ/i.test(fnName) || /^__[A-Za-z]*_init/.test(fnName);
  if (isConstructor || isInitializer || CREATION_CTX.test(context)) {
    return { classification: "DEPLOYMENT_TIME", note: "DEPLOYMENT_TIME: constructor/initializer/deterministic-create path; a 7702 delegation cannot exist for the address at deploy time, so the branch cannot drift here." };
  }
  if (VALUE_CTX.test(context)) {
    return { classification: "VALUE_GATE", note: "VALUE_GATE: is-EOA branch inside a state-changing value path. Under EIP-7702 a delegated EOA (0xef0100||addr, 23 bytes) takes the opposite branch versus a plain EOA (code.length==0 is false / isContract true), flipping rebase/accrual/refund/exclusion behaviour." };
  }
  return { classification: "UNKNOWN", note: "NO_VALUE_BRANCH_IN_CONTEXT: state-changing but no value keyword in context window; flagged for review." };
}

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------
function scanTarget(targetName, cfg) {
  const dir = path.join(cfg.targetRoot, targetName);
  const result = {
    target: targetName,
    dir: relFromWorkspace(dir),
    status: "SCANNED",
    filesScanned: 0,
    filesSkipped: 0,
    hits: 0,
    byClassification: { DEPLOYMENT_TIME: 0, VALUE_GATE: 0, UNKNOWN: 0 },
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
    const codeCheckLines = [];
    for (let i = 0; i < lines.length; i += 1) if (!isCommentLine(lines[i]) && CODE_CHECK_RE.test(lines[i])) codeCheckLines.push(i);
    for (let i = 0; i < lines.length; i += 1) {
      const lineText = lines[i];
      if (isCommentLine(lineText)) continue;
      const matched = [];
      for (const p of IDIOM_PATTERNS) if (p.re.test(lineText)) matched.push(p.id);
      if (SUPPORTS_INTERFACE_RE.test(lineText)) {
        const nearCodeCheck = codeCheckLines.some((n) => Math.abs(n - i) <= cfg.contextWindow);
        if (nearCodeCheck) matched.push("erc165-hasCode");
      }
      if (matched.length === 0) continue;
      const funcInfo = enclosing[i];
      const lo = Math.max(0, i - cfg.contextWindow);
      const hi = Math.min(lines.length, i + cfg.contextWindow + 1);
      const context = `${funcInfo && funcInfo.name ? funcInfo.name : ""} ${lines.slice(lo, hi).join(" ")}`;
      for (const idiom of [...new Set(matched)]) {
        const verdict = classifyEoa({ idiom, funcInfo, context, deployedFacing, lineText });
        result.byIdiom[idiom] = (result.byIdiom[idiom] || 0) + 1;
        result.byClassification[verdict.classification] = (result.byClassification[verdict.classification] || 0) + 1;
        hits.push({
          target: targetName,
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
  // deterministic ordering then bounded truncation
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
  if (options.targets) cfg.targets = options.targets;
  const perTarget = [];
  const hits = [];
  for (const targetName of cfg.targets) {
    const { result, hits: targetHits } = scanTarget(targetName, cfg);
    perTarget.push(result);
    hits.push(...targetHits);
  }
  const byClassification = { DEPLOYMENT_TIME: 0, VALUE_GATE: 0, UNKNOWN: 0 };
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
    config: {
      includeTests: cfg.includeTests,
      includeScripts: cfg.includeScripts,
      maxHitsPerTarget: cfg.maxHitsPerTarget,
      contextWindow: cfg.contextWindow,
      excludeDirs: cfg.excludeDirs,
      targets: cfg.targets,
    },
    totals: {
      targetsRequested: cfg.targets.length,
      targetsScanned: perTarget.filter((t) => t.status === "SCANNED").length,
      targetsMiss: perTarget.filter((t) => t.status === "MISS").length,
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
      "Classification is heuristic (nearest-preceding signature + context window); VALUE_GATE is a triage label, not a proof of live reachability.",
      "Test/mock/script files are scanned but tagged deployedFacing=false and classified UNKNOWN.",
      "Vendored/build directories (node_modules/out/artifacts/cache/broadcast/forge-std*/dist/build/coverage/.git/typechain/.deps) are excluded.",
      "Vendored dependency libraries linked into the deployed bytecode (OpenZeppelin/solmate acceptance checks under lib/ or dependencies/) are included; they are legitimately deployed-facing but low-signal. Filter on the function/file to isolate protocol-owned gates.",
    ],
  };
  atomicWriteJson(cfg.artifact, artifact);
  return artifact;
}

function oneLine(a) {
  const c = a.totals.byClassification;
  return `${a.tool} (N2): ${a.totals.targetsScanned}/${a.totals.targetsRequested} targets scanned, ${a.totals.targetsMiss} MISS, ` +
    `${a.totals.filesScanned} files, ${a.totals.hits} hits ` +
    `[VALUE_GATE=${c.VALUE_GATE} DEPLOYMENT_TIME=${c.DEPLOYMENT_TIME} UNKNOWN=${c.UNKNOWN}]` +
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
    process.stderr.write(`scan-eoa-gates: FAILED ${error && error.message ? error.message : error}\n`);
    process.exitCode = 1;
  }
}

module.exports = { scan, scanTarget, parseEnclosing, classifyEoa, CONFIG };
