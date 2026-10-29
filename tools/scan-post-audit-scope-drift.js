#!/usr/bin/env node
// Read-only post-audit / out-of-scope code drift scanner.
// Finds changed or unaudited source/deployment surfaces that need deployed value-path proof before fork work.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT_JSON = path.join(WORKSPACE, "reports", "raw", "fast", "post-audit-scope-drift.json");
const OUT_MD = path.join(WORKSPACE, "reports", "post-audit-scope-drift-triage.md");
const QUIET = process.argv.includes("--quiet");
const NOW = Date.now();

const TARGETS = [
  { name: "Homora V2", chain: "Ethereum", priority: 10, root: "targets/homora-v2", auditDirs: ["audits"], sourceDirs: ["contracts"] },
  { name: "Uniswap V4 Core", chain: "Ethereum / multi-chain", priority: 9, root: "targets/uniswap-v4-core", auditDirs: ["docs/security/audits"], sourceDirs: ["src"] },
  { name: "Ether.fi Contracts", chain: "Ethereum", priority: 9, root: "targets/etherfi-contracts", auditDirs: ["audits"], sourceDirs: ["src", "deployment", "operations", "proposals"] },
  { name: "Cap Contracts", chain: "Ethereum / Base", priority: 8, root: "targets/cap-contracts", auditDirs: ["../cap-audits"], sourceDirs: ["contracts", "config"] },
  { name: "TermMax V2", chain: "multi-chain", priority: 8, root: "targets/termmax-contract-v2", auditDirs: ["../termmax-audits"], sourceDirs: ["contracts", "deployments"] },
  { name: "Exponent Core", chain: "Solana", priority: 8, root: "targets/exponent-core", auditDirs: ["../exponent-audits"], sourceDirs: ["programs", "libraries", "migrations"] },
  { name: "Kamino Klend", chain: "Solana", priority: 8, root: "targets/kamino-klend", auditDirs: ["../kamino-audits"], sourceDirs: ["programs", "libs", "migrations"] },
  { name: "Symbiosis Core", chain: "multi-chain", priority: 7, root: "targets/symbiosis-core-contracts", auditDirs: ["../symbiosis-audits"], sourceDirs: ["contracts"] },
  { name: "Dolomite Modules", chain: "Arbitrum / multi-chain", priority: 7, root: "targets/dolomite-margin-modules", auditDirs: ["."], sourceDirs: ["packages"] },
  { name: "BounceBit Vault", chain: "Ethereum / BNB", priority: 6, root: "targets/bouncebit-audits", auditDirs: ["."], sourceDirs: ["../bouncebit-contracts", "../bouncebit-vault", "../bouncebit"] },
];

const SOURCE_EXTS = new Set([".sol", ".vy", ".rs", ".move", ".ts", ".js", ".json", ".toml", ".md"]);
const AUDIT_EXTS = new Set([".pdf", ".md", ".txt", ".html", ".htm", ".json", ".csv"]);
const EXCLUDED_DIRS = new Set([".git", "node_modules", "target", "build", "dist", "out", "cache", "artifacts", "coverage", "generated", "abi", "lib", "vendor", ".next"]);
const EXCLUDED_SOURCE_PATH_RE = /[\\/](test|tests|mock|mocks|examples?|fixtures?|snapshots|coverage|contracts_coverage|typechain|abi|interfaces?|[^\\/]*-interfaces)[\\/]/i;

const DRIFT_HINT_TERMS = [
  "unaudited", "not audited", "not in scope", "out of scope", "out-of-scope", "TODO", "FIXME", "temporary", "legacy", "deprecated", "unsafe", "unchecked",
];
const VALUE_TERMS = [
  "transfer", "safeTransfer", "transferFrom", "mint", "burn", "deposit", "withdraw", "redeem", "borrow", "repay", "liquidate", "seize", "claim", "sweep", "rescue", "settle", "execute", "swap", "flashLoan", "bridge", "unlock", "send", "receive",
];
const CONFIG_TERMS = [
  "setOracle", "oracle", "price", "feed", "rateProvider", "setPrice", "setConfig", "configure", "setAdapter", "setRouter", "setVault", "upgradeTo", "upgradeToAndCall", "setImplementation", "implementation", "beacon", "diamondCut", "initialize", "reinitialize", "delegatecall", "grantRole", "revokeRole", "DEFAULT_ADMIN_ROLE", "pause", "unpause", "emergency", "guardian", "keeper",
];
const PATH_SCOPE_TERMS = [
  "periphery", "adapter", "adapters", "router", "routers", "strategy", "strategies", "oracle", "oracles", "module", "modules", "wrapper", "wrappers", "hook", "hooks", "keeper", "keepers", "bridge", "bridges", "relayer", "relayers", "extension", "extensions", "plugin", "plugins", "deployment", "deployments", "operation", "operations", "proposal", "proposals", "config",
];
const ROLE_GATED_TERMS = [
  "onlyOwner", "onlyAdmin", "onlyGovernor", "onlyGovernance", "onlyRole", "requiresAuth", "auth", "AccessControl", "Ownable", "Timelock", "timelock", "guardian", "governor", "admin", "multisig",
];
const PROTECTION_TERMS = [
  "nonReentrant", "whenNotPaused", "Pausable", "require", "revert", "assert", "whitelist", "allowlist", "isListed", "registry", "factory", "min", "max", "deadline", "slippage", "domainSeparator", "nonce",
];

function exists(filePath) {
  try { return fs.existsSync(filePath); } catch (_) { return false; }
}

function rel(filePath) {
  return path.relative(WORKSPACE, filePath).replace(/\\/g, "/");
}

function safeRead(filePath, maxBytes = 2_000_000) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > maxBytes) return "";
    return fs.readFileSync(filePath, "utf8");
  } catch (_) {
    return "";
  }
}

function lower(text) {
  return String(text || "").toLowerCase();
}

function unique(items) {
  return [...new Set((items || []).filter(Boolean))];
}

function matchedTerms(text, terms) {
  const source = lower(text);
  return terms.filter((term) => source.includes(lower(term)));
}

function stripComments(text) {
  return String(text || "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1 ")
    .replace(/^\s*#.*$/gm, " ");
}

function walk(root, exts, out = [], options = {}) {
  if (!exists(root)) return out;
  let stat;
  try { stat = fs.statSync(root); } catch (_) { return out; }
  if (stat.isFile()) {
    const ext = path.extname(root).toLowerCase();
    if (stat.size <= (options.maxBytes || 2_000_000) && exts.has(ext) && !(options.excludeSource && EXCLUDED_SOURCE_PATH_RE.test(root))) out.push(root);
    return out;
  }
  if (!stat.isDirectory()) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;
    walk(path.join(root, entry.name), exts, out, options);
  }
  return out;
}

function parseDateFromName(name) {
  const text = String(name || "");
  const ymd = text.match(/(20\d{2})[-_. ](\d{1,2})[-_. ](\d{1,2})/);
  if (ymd) {
    const ts = Date.UTC(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]));
    return Number.isFinite(ts) ? ts : null;
  }
  const compact = text.match(/(20\d{2})(\d{2})(\d{2})/);
  if (compact) {
    const ts = Date.UTC(Number(compact[1]), Number(compact[2]) - 1, Number(compact[3]));
    return Number.isFinite(ts) ? ts : null;
  }
  return null;
}

function isoDate(ts) {
  return ts ? new Date(ts).toISOString().slice(0, 10) : null;
}

function auditMetadata(target, root) {
  const auditFiles = [];
  const existingAuditDirs = [];
  for (const dir of target.auditDirs || []) {
    const abs = path.resolve(root, dir);
    if (!exists(abs)) continue;
    existingAuditDirs.push(rel(abs));
    walk(abs, AUDIT_EXTS, auditFiles, { maxBytes: 25_000_000 });
  }
  const rows = unique(auditFiles).map((file) => {
    const ext = path.extname(file).toLowerCase();
    const text = ext === ".pdf" ? "" : safeRead(file, 800_000);
    const name = path.basename(file);
    const parsedDate = parseDateFromName(name) || parseDateFromName(rel(file));
    return {
      file: rel(file),
      name,
      ext,
      parsedDate: isoDate(parsedDate),
      parsedTime: parsedDate,
      scopeTerms: matchedTerms(`${name}\n${text}`, ["scope", "in scope", "out of scope", "not in scope", "unaudited", "audit", "review", "assessment"]),
      textSampled: Boolean(text),
    };
  }).sort((a, b) => (b.parsedTime || 0) - (a.parsedTime || 0) || a.file.localeCompare(b.file));
  const completedDates = rows.map((row) => row.parsedTime).filter((ts) => ts && ts <= NOW + 36 * 3_600_000);
  const latestAuditTime = completedDates.length ? Math.max(...completedDates) : null;
  const latestAudit = latestAuditTime ? rows.find((row) => row.parsedTime === latestAuditTime) : null;
  return {
    auditFiles: rows,
    auditFilesFound: rows.length,
    existingAuditDirs,
    latestAuditDate: isoDate(latestAuditTime),
    latestAuditTime,
    latestAuditFile: latestAudit?.file || null,
    scopeTermRows: rows.filter((row) => row.scopeTerms.length).length,
    outOfScopeAuditRows: rows.filter((row) => row.scopeTerms.some((term) => /out|not in|unaudited/i.test(term))).length,
  };
}

function gitChangeMap(root, sourceDirs, latestAuditTime) {
  if (!latestAuditTime || !exists(path.join(root, ".git"))) return new Map();
  const existing = (sourceDirs || [])
    .filter((dir) => exists(path.resolve(root, dir)))
    .map((dir) => String(dir).replace(/\\/g, "/"));
  if (!existing.length) return new Map();
  const since = new Date(latestAuditTime - 48 * 3_600_000).toISOString();
  const args = ["-C", root, "log", `--since=${since}`, "--name-only", "--format=@@%ct", "--", ...existing];
  try {
    const output = execFileSync("git", args, { encoding: "utf8", windowsHide: true, timeout: 20_000, maxBuffer: 40 * 1024 * 1024 });
    const map = new Map();
    let currentTs = null;
    for (const rawLine of output.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const marker = line.match(/^@@(\d+)$/);
      if (marker) {
        currentTs = Number(marker[1]);
        continue;
      }
      if (currentTs && !map.has(line)) map.set(line, { timestamp: currentTs, date: new Date(currentTs * 1000).toISOString().slice(0, 10) });
    }
    return map;
  } catch (_) {
    return new Map();
  }
}

function firstRiskLine(text, terms) {
  const lines = String(text || "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const source = lower(lines[i]);
    if (terms.some((term) => source.includes(lower(term)))) return i + 1;
  }
  return 1;
}

function snippet(text, line, radius = 2) {
  const lines = String(text || "").split(/\r?\n/);
  const start = Math.max(0, line - 1 - radius);
  const end = Math.min(lines.length, line + radius);
  return lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l.trim()}`).join(" ").slice(0, 500);
}

function accessSurface(ext, text, relPath) {
  const source = String(text || "");
  if (ext === ".sol" || ext === ".vy") {
    if (/\bfunction\s+[A-Za-z0-9_]+\s*\([^)]*\)[^{;]*(\bexternal\b|\bpublic\b)|@external|@public/i.test(source)) return "public-or-external";
    if (/constructor\s*\(|receive\s*\(|fallback\s*\(/i.test(source)) return "entrypoint";
  }
  if (ext === ".rs") {
    if (/#\[program\]|pub\s+fn\s+|#\[derive\(Accounts\)\]/i.test(source)) return "program-entrypoint";
  }
  if (ext === ".move") {
    if (/public\s+(entry\s+)?fun\s+/i.test(source)) return "public-entry";
  }
  if (ext === ".ts" || ext === ".js") {
    if (/export\s+(async\s+)?function|sendTransaction|populateTransaction|upgrade|deploy|execute|proposal/i.test(source)) return "ops-or-script-entry";
  }
  if (/\/(deployment|deployments|config|operations|proposals)\//i.test(relPath)) return "deployment-config";
  return "internal-or-unknown";
}

function classifySurface(relPath, text) {
  const source = `${relPath}\n${text}`;
  const surfaces = [];
  if (/oracle|price|feed|rateProvider|pyth|chainlink|redstone/i.test(source)) surfaces.push("oracle-or-rate-config");
  if (/upgrade|implementation|beacon|proxy|diamondCut|delegatecall|initialize|reinitialize|role|owner|admin|timelock/i.test(source)) surfaces.push("upgrade-or-admin");
  if (/router|swap|settle|bridge|relayer|adapter|executor|callback|hook/i.test(source)) surfaces.push("router-adapter-settlement");
  if (/vault|strategy|deposit|withdraw|redeem|share|asset|claim|reward/i.test(source)) surfaces.push("vault-strategy-accounting");
  if (/borrow|repay|liquidat|collateral|debt|ltv|lltv|seize/i.test(source)) surfaces.push("lending-liquidation");
  if (/\/deployment|\/deployments|\/config|\/operations|\/proposals/i.test(relPath)) surfaces.push("deployment-or-governance-config");
  return surfaces.length ? unique(surfaces) : ["source-drift-context"];
}

function pathScopeTerms(relPath) {
  const parts = lower(relPath).split("/");
  return PATH_SCOPE_TERMS.filter((term) => parts.some((part) => part === lower(term) || part.includes(lower(term))));
}

function analyzeFile(target, root, filePath, audit, changes) {
  const fileText = safeRead(filePath);
  if (!fileText) return null;
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".sol" && /^\s*interface\s+[A-Za-z0-9_]+/m.test(fileText)) return null;
  const relPath = rel(filePath);
  const rootRel = path.relative(root, filePath).replace(/\\/g, "/");
  const isCodeFile = ext === ".sol" || ext === ".vy" || ext === ".rs" || ext === ".move";
  const stripped = stripComments(fileText);
  const combined = `${relPath}\n${stripped}`;
  const rawCombined = `${relPath}\n${fileText}`;
  const valueTerms = matchedTerms(combined, VALUE_TERMS);
  const configTerms = matchedTerms(combined, CONFIG_TERMS);
  const driftHintTerms = matchedTerms(rawCombined, DRIFT_HINT_TERMS);
  const roleGatedTerms = matchedTerms(combined, ROLE_GATED_TERMS);
  const protectionTerms = matchedTerms(combined, PROTECTION_TERMS);
  const scopePathTerms = pathScopeTerms(rootRel);
  const access = accessSurface(ext, stripped, relPath);
  const publicSurface = /public|external|entry|ops|deployment-config/i.test(access);
  const change = changes.get(rootRel) || null;
  const postAuditChanged = Boolean(audit.latestAuditTime && change?.timestamp && change.timestamp * 1000 > audit.latestAuditTime + 12 * 3_600_000);
  const explicitScopeHint = driftHintTerms.some((term) => /unaudited|not audited|not in scope|out.?of.?scope/i.test(term));
  const outOfScopePath = scopePathTerms.length > 0;
  const valuePath = valueTerms.length > 0 || /mint|burn|deposit|withdraw|redeem|borrow|repay|liquidat|claim|swap|settle|bridge|execute/i.test(relPath);
  const privilegedConfig = configTerms.length > 0 || /oracle|config|upgrade|admin|owner|role|implementation|deployment|proposal/i.test(relPath);
  const weaklyProtected = roleGatedTerms.length === 0 || !/onlyOwner|onlyRole|AccessControl|Timelock|timelock|governance|guardian/i.test(roleGatedTerms.join("|"));
  const driftSignals = unique([
    postAuditChanged ? "changed-after-latest-audit" : null,
    explicitScopeHint ? "explicit-unaudited-or-out-of-scope-hint" : null,
    outOfScopePath ? "out-of-scope-like-path" : null,
    audit.auditFilesFound === 0 ? "no-local-audit-file" : null,
    publicSurface ? "public-or-deployment-entry" : null,
    valuePath ? "value-moving-path" : null,
    privilegedConfig ? "privileged-config-path" : null,
  ]);

  let confidence = "context";
  if ((postAuditChanged || explicitScopeHint) && publicSurface && (valuePath || privilegedConfig) && weaklyProtected && (isCodeFile || explicitScopeHint)) confidence = "high-static";
  else if ((postAuditChanged || explicitScopeHint || outOfScopePath) && (valuePath || privilegedConfig) && (publicSurface || weaklyProtected)) confidence = "medium-static";
  else if ((postAuditChanged || explicitScopeHint || outOfScopePath || driftHintTerms.length) && (valueTerms.length || configTerms.length)) confidence = "review";

  const priorityScore = Math.round(
    target.priority * 6
    + (confidence === "high-static" ? 45 : confidence === "medium-static" ? 29 : confidence === "review" ? 16 : 4)
    + (postAuditChanged ? 18 : 0)
    + (explicitScopeHint ? 14 : 0)
    + (outOfScopePath ? 7 : 0)
    + (publicSurface ? 7 : 0)
    + (valuePath ? 7 : 0)
    + (privilegedConfig ? 7 : 0)
    - (roleGatedTerms.length ? 8 : 0)
    - (/nonReentrant|whenNotPaused|domainSeparator|nonce|slippage|min|max/i.test(protectionTerms.join("|")) ? 4 : 0)
  );
  const line = firstRiskLine(fileText, [...DRIFT_HINT_TERMS, ...VALUE_TERMS, ...CONFIG_TERMS]);
  const blocker = confidence === "high-static"
    ? "Static drift row needs deployed address mapping, permissionless reachability, and exact positive value-path economics before fork work."
    : confidence === "medium-static"
      ? "Out-of-scope or post-audit-like source needs manual scope confirmation and deployed route economics."
      : "Review-only drift context; may be covered by audit scope, role-gated, or non-value-moving.";

  return {
    target: target.name,
    chain: target.chain,
    file: relPath,
    rootFile: rootRel,
    line,
    confidence,
    priorityScore,
    access,
    publicSurface,
    surfaces: classifySurface(relPath, combined),
    driftSignals,
    latestAuditDate: audit.latestAuditDate,
    latestAuditFile: audit.latestAuditFile,
    lastGitChangeDate: change?.date || null,
    postAuditChanged,
    outOfScopePath,
    explicitScopeHint,
    valuePath,
    privilegedConfig,
    valueTerms: valueTerms.slice(0, 10),
    configTerms: configTerms.slice(0, 12),
    driftHintTerms: driftHintTerms.slice(0, 8),
    scopePathTerms: scopePathTerms.slice(0, 8),
    roleGatedTerms: roleGatedTerms.slice(0, 8),
    protectionTerms: protectionTerms.slice(0, 10),
    routePositive: false,
    signedActionJustified: false,
    blocker,
    snippet: snippet(fileText, line, 2),
  };
}

function scanTarget(target) {
  const root = path.join(WORKSPACE, target.root);
  const audit = auditMetadata(target, root);
  const files = [];
  const existingSourceDirs = [];
  for (const dir of target.sourceDirs || []) {
    const abs = path.resolve(root, dir);
    if (!exists(abs)) continue;
    existingSourceDirs.push(rel(abs));
    walk(abs, SOURCE_EXTS, files, { excludeSource: true, maxBytes: 2_000_000 });
  }
  const uniqueFiles = unique(files);
  const changes = gitChangeMap(root, target.sourceDirs || [], audit.latestAuditTime);
  const rows = [];
  for (const file of uniqueFiles) {
    const row = analyzeFile(target, root, file, audit, changes);
    if (!row) continue;
    if (row.confidence !== "context" || row.priorityScore >= target.priority * 6 + 12) rows.push(row);
  }
  rows.sort((a, b) => b.priorityScore - a.priorityScore || a.file.localeCompare(b.file));
  return {
    name: target.name,
    chain: target.chain,
    root: target.root,
    priority: target.priority,
    auditDirs: target.auditDirs,
    sourceDirs: target.sourceDirs,
    existingAuditDirs: audit.existingAuditDirs,
    existingSourceDirs,
    auditFilesFound: audit.auditFilesFound,
    latestAuditDate: audit.latestAuditDate,
    latestAuditFile: audit.latestAuditFile,
    scopeTermRows: audit.scopeTermRows,
    outOfScopeAuditRows: audit.outOfScopeAuditRows,
    filesScanned: uniqueFiles.length,
    gitChangedFilesSinceAudit: changes.size,
    driftRows: rows.length,
    highStaticRows: rows.filter((row) => row.confidence === "high-static").length,
    mediumStaticRows: rows.filter((row) => row.confidence === "medium-static").length,
    reviewRows: rows.filter((row) => row.confidence === "review").length,
    postAuditChangedRows: rows.filter((row) => row.postAuditChanged).length,
    outOfScopeRows: rows.filter((row) => row.outOfScopePath).length,
    explicitUnauditedHintRows: rows.filter((row) => row.explicitScopeHint).length,
    valuePathRows: rows.filter((row) => row.valuePath).length,
    privilegedConfigRows: rows.filter((row) => row.privilegedConfig).length,
    publicSurfaceRows: rows.filter((row) => row.publicSurface).length,
    auditFiles: audit.auditFiles.slice(0, 20),
    topRows: rows.slice(0, 20),
  };
}

function table(rows, headers) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${headers.map((h) => String(row[h] ?? "").replace(/\r?\n/g, " ").replace(/\|/g, "/")).join(" | ")} |`),
  ].join("\n");
}

function renderReport(artifact) {
  const targetRows = artifact.sourceTargets.map((row) => ({
    Target: row.name,
    AuditFiles: row.auditFilesFound,
    LatestAudit: row.latestAuditDate || "unknown",
    Sources: row.existingSourceDirs.length ? row.existingSourceDirs.length : "missing",
    Files: row.filesScanned,
    Rows: row.driftRows,
    High: row.highStaticRows,
    Medium: row.mediumStaticRows,
    Changed: row.postAuditChangedRows,
    OutScope: row.outOfScopeRows,
  }));
  const top = artifact.rankedRows.slice(0, 14).map((row) => ({
    Target: row.target,
    Surface: row.surfaces.join(", "),
    File: `${row.file}:${row.line}`,
    Confidence: row.confidence,
    Signals: row.driftSignals.slice(0, 4).join(", "),
    Audit: row.latestAuditDate || "unknown",
    Changed: row.lastGitChangeDate || "unknown",
    Blocker: row.blocker,
  }));
  return [
    "# 🟢 DORMANT — Post-Audit / Out-Of-Scope Drift Scan",
    "",
    `Date: ${artifact.generatedAt.slice(0, 10)}`,
    "",
    "## Result",
    "",
    `Scanned ${artifact.summary.filesScanned} source/deployment files across ${artifact.summary.targetsScanned} target groups with ${artifact.summary.auditFilesFound} local audit artifacts. Route gate remains closed: \`routePositive=0\`, \`executableNow=0\`, \`signedActionJustified=false\`.`,
    "",
    `The scan found ${artifact.summary.highStaticRows} high-static rows, ${artifact.summary.mediumStaticRows} medium-static rows, ${artifact.summary.postAuditChangedRows} rows changed after the latest local audit date, ${artifact.summary.outOfScopeRows} out-of-scope-like path rows, and ${artifact.summary.explicitUnauditedHintRows} explicit unaudited/out-of-scope hint rows. These are source leads only until deployed reachability and exact positive economics are proven.`,
    "",
    `Route-relevant gates remain closed: deployed reachability rows \`${artifact.summary.deployedReachabilityRows}\`, permissionless value-path rows \`${artifact.summary.permissionlessValuePathRows}\`, exact-economics rows \`${artifact.summary.exactEconomicsRows}\`, and fork-proof rows \`${artifact.summary.forkProofRows}\`.`,
    "",
    "## Target Coverage",
    "",
    table(targetRows, ["Target", "AuditFiles", "LatestAudit", "Sources", "Files", "Rows", "High", "Medium", "Changed", "OutScope"]),
    "",
    "## Top Rows",
    "",
    top.length ? table(top, ["Target", "Surface", "File", "Confidence", "Signals", "Audit", "Changed", "Blocker"]) : "No post-audit/out-of-scope drift rows found in local source checkouts.",
    "",
    "## Route-Positive Gate",
    "",
    "Do not fork or build executors until a row proves: the changed/out-of-scope code is deployed, the money-moving or privileged config path is permissionless or externally triggerable, live balances/approvals/borrow liquidity are reachable, and exact route economics are positive after gas/slippage/fees.",
    "",
    "## Artifacts",
    "",
    "- JSON: `reports/raw/fast/post-audit-scope-drift.json`",
    "- Scanner: `tools/scan-post-audit-scope-drift.js`",
    "- Related branches: `reports/raw/fast/router-rfq-settlement-drift.json`, `reports/raw/fast/bridge-proof-binding.json`, `reports/raw/fast/fake-asset-pool-validation.json`",
    "",
  ].join("\n");
}

function main() {
  const sourceTargets = TARGETS.map(scanTarget);
  const rankedRows = sourceTargets.flatMap((target) => target.topRows).sort((a, b) => b.priorityScore - a.priorityScore || a.file.localeCompare(b.file));
  const summary = {
    targetsScanned: sourceTargets.length,
    targetsWithAudit: sourceTargets.filter((row) => row.auditFilesFound > 0).length,
    targetsWithSource: sourceTargets.filter((row) => row.filesScanned > 0).length,
    auditFilesFound: sourceTargets.reduce((acc, row) => acc + row.auditFilesFound, 0),
    filesScanned: sourceTargets.reduce((acc, row) => acc + row.filesScanned, 0),
    gitChangedFilesSinceAudit: sourceTargets.reduce((acc, row) => acc + row.gitChangedFilesSinceAudit, 0),
    driftRows: sourceTargets.reduce((acc, row) => acc + row.driftRows, 0),
    staticDriftRows: sourceTargets.reduce((acc, row) => acc + row.driftRows, 0),
    highStaticRows: sourceTargets.reduce((acc, row) => acc + row.highStaticRows, 0),
    mediumStaticRows: sourceTargets.reduce((acc, row) => acc + row.mediumStaticRows, 0),
    reviewRows: sourceTargets.reduce((acc, row) => acc + row.reviewRows, 0),
    postAuditChangedRows: sourceTargets.reduce((acc, row) => acc + row.postAuditChangedRows, 0),
    outOfScopeRows: sourceTargets.reduce((acc, row) => acc + row.outOfScopeRows, 0),
    explicitUnauditedHintRows: sourceTargets.reduce((acc, row) => acc + row.explicitUnauditedHintRows, 0),
    valuePathRows: sourceTargets.reduce((acc, row) => acc + row.valuePathRows, 0),
    privilegedConfigRows: sourceTargets.reduce((acc, row) => acc + row.privilegedConfigRows, 0),
    publicSurfaceRows: sourceTargets.reduce((acc, row) => acc + row.publicSurfaceRows, 0),
    deployedReachabilityRows: 0,
    permissionlessValuePathRows: 0,
    exactEconomicsRows: 0,
    forkProofRows: 0,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    blocker: "No row proves deployed post-audit/out-of-scope drift with permissionless reachability and exact positive value-path economics.",
  };
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-post-audit-scope-drift.js",
    scope: "Read-only source/audit artifact scan for post-audit and out-of-scope code drift",
    safety: {
      rpcInventoryRead: false,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: false,
      signedActionJustified: false,
    },
    scanCategories: ["changed-after-latest-audit", "out-of-scope-like-path", "explicit-unaudited-hint", "value-moving-path", "privileged-config-path"],
    summary,
    sourceTargets,
    rankedRows: rankedRows.slice(0, 140),
    requiredForRoutePositive: [
      "changed or out-of-scope code is mapped to a deployed contract or active governance/deployment payload",
      "entrypoint is permissionless or externally triggerable without trusted role compromise",
      "path moves funds, changes oracle/config, or reaches settlement/liquidation/borrow/redeem accounting",
      "live balances, approvals, borrow liquidity, or redemption/exit liquidity are exact-quoted",
      "fork/local proof demonstrates positive net extraction after gas, slippage, and fees",
    ],
    nextReadOnlyStep: "Manually inspect the top post-audit drift rows for deployed address mapping and consumer/value-path joins; fork only if deployed reachability plus exact positive economics is proven.",
  };

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, `${JSON.stringify(artifact, null, 2)}\n`);
  fs.writeFileSync(OUT_MD, `${renderReport(artifact)}\n`);

  if (!QUIET) {
    console.log(`post-audit-scope-drift: targets=${summary.targetsScanned}; auditTargets=${summary.targetsWithAudit}; sourceTargets=${summary.targetsWithSource}; files=${summary.filesScanned}; highStatic=${summary.highStaticRows}; medium=${summary.mediumStaticRows}; routePositive=0`);
    console.log(`Report: ${rel(OUT_MD)}`);
  }
}

main();
