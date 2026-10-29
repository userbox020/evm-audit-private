#!/usr/bin/env node
// auto-audit-target.js — Block 3: Automated Protocol Audit Pipeline
// Takes a DeFiLlama slug, clones GitHub, scans for exploit patterns
// Usage: node tools/auto-audit-target.js <slug> [--deep]

const cp = require("child_process");
const fs = require("fs"); const path = require("path");
const { rpcCall, resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const TARGETS_DIR = path.join(WORKSPACE, "targets");
const REPORTS_DIR = path.join(WORKSPACE, "reports", "raw", "fast");

// ─── High-Signal Exploit Pattern Detectors ───

const PATTERNS = [
  // Oracle patterns
  { name: "Pyth-unsafe", severity: "CRITICAL", patterns: ["getPriceUnsafe"], desc: "Pyth unsafe read — no staleness check" },
  { name: "Chainlink-no-stale", severity: "HIGH", patterns: ["latestAnswer()", "latestRoundData()"], desc: "Chainlink usage — verify staleness check" },
  { name: "RedStone-pull", severity: "HIGH", patterns: ["redstone", "getOracleNumericValue"], desc: "RedStone pull oracle — check staleness" },
  { name: "Single-oracle", severity: "HIGH", patterns: ["AggregatorV3Interface"], desc: "Single oracle source — no fallback" },
  
  // ERC4626 patterns
  { name: "ERC4626-donate", severity: "CRITICAL", patterns: ["function donate(", "donate(uint256"], desc: "Donation-capable vault — inflation risk" },
  { name: "ERC4626-collateral", severity: "HIGH", patterns: ["convertToAssets", "convertToShares"], desc: "ERC4626 vault — check if used as collateral" },
  
  // Reentrancy patterns
  { name: "No-reentrant", severity: "HIGH", patterns: ["nonReentrant"], inverse: true, desc: "Missing reentrancy guard — check external calls" },
  { name: "Borrow-no-reentrant", severity: "CRITICAL", patterns: ["function borrow(", "function liquidate("], checkNonReentrant: true, desc: "Borrow/liquidate without reentrancy guard" },
  
  // Centralization patterns
  { name: "OnlyOwner-critical", severity: "MEDIUM", patterns: ["onlyOwner", "setOracle", "setPriceFeed"], desc: "Admin can change oracle — centralization risk" },
  { name: "Upgradeable", severity: "MEDIUM", patterns: ["UUPSUpgradeable", "TransparentUpgradeable", "upgradeTo"], desc: "Upgradeable proxy — storage layout risk" },
  
  // Flash loan / MEV patterns
  { name: "Flash-loan", severity: "INFO", patterns: ["flashLoan", "IFlashLoan", "Balancer"], desc: "Flash loan patterns — protocol interaction" },
];

// ─── GitHub Detection ───

const GITHUB_ORGS = new Map(); // slug → known GitHub URL

async function findGitHubRepo(slug) {
  if (GITHUB_ORGS.has(slug)) return GITHUB_ORGS.get(slug);
  
  // Try common patterns
  const candidates = [
    `https://github.com/${slug}`,
    `https://github.com/${slug}/contracts`,
    `https://github.com/${slug}-protocol/contracts`,
    `https://github.com/${slug}-finance/contracts`,
  ];
  
  for (const url of candidates) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (resp.ok) { GITHUB_ORGS.set(slug, url); return url; }
    } catch (_) {}
  }
  return null;
}

// ─── Clone + Scan ───

async function cloneAndScan(slug, githubUrl) {
  const targetDir = path.join(TARGETS_DIR, `auto-${slug}`);
  
  // Clone if not exists
  if (!fs.existsSync(targetDir)) {
    console.log(`  Cloning ${githubUrl}...`);
    try {
      cp.execSync(`git clone "${githubUrl}" "${targetDir}" --depth 1`, { timeout: 30000, stdio: "pipe" });
    } catch (e) {
      return { error: `Clone failed: ${e.message.slice(0, 100)}` };
    }
  } else {
    console.log(`  Already cloned at ${targetDir}`);
  }
  
  // Find all .sol files
  const solFiles = findSolidityFiles(targetDir);
  console.log(`  Found ${solFiles.length} Solidity files`);
  
  if (solFiles.length === 0) return { error: "No Solidity files found" };
  
  // Scan each file for patterns
  const findings = [];
  for (const file of solFiles.slice(0, 100)) { // Cap at 100 files
    const content = fs.readFileSync(file, "utf8");
    const relativePath = path.relative(targetDir, file);
    
    for (const pattern of PATTERNS) {
      let found = false;
      for (const pat of pattern.patterns) {
        if (content.includes(pat)) {
          found = true;
          break;
        }
      }
      
      if (found) {
        // For borrow/liquidate without reentrancy
        if (pattern.checkNonReentrant && content.includes("nonReentrant")) continue;
        if (pattern.inverse !== undefined && pattern.inverse === (pattern.patterns.some(p => content.includes(p)))) continue;
        
        findings.push({
          pattern: pattern.name,
          severity: pattern.severity,
          file: relativePath,
          desc: pattern.desc,
        });
      }
    }
  }
  
  return { files: solFiles.length, findings };
}

function findSolidityFiles(dir) {
  const results = [];
  const stack = [dir];
  const visited = new Set();
  
  while (stack.length > 0) {
    const current = stack.pop();
    if (visited.has(current)) continue;
    visited.add(current);
    
    try {
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(current, e.name);
        if (e.isDirectory() && !e.name.startsWith(".") && !e.name.startsWith("node_modules") && !e.name.startsWith("lib")) {
          stack.push(full);
        } else if (e.name.endsWith(".sol")) {
          results.push(full);
        }
      }
    } catch (_) {}
  }
  return results;
}

// ─── Generate Report ───

function generateReport(slug, result, githubUrl) {
  const findings = result.findings || [];
  const critical = findings.filter(f => f.severity === "CRITICAL");
  const high = findings.filter(f => f.severity === "HIGH");
  
  const report = {
    slug,
    github: githubUrl || "NOT FOUND",
    scannedAt: new Date().toISOString(),
    files: result.files || 0,
    totalFindings: findings.length,
    critical: critical.length,
    high: high.length,
    findingsByType: [...new Set(findings.map(f => f.pattern))],
    topFindings: findings.slice(0, 20),
  };
  
  report.score = Math.min(10, critical.length * 3 + high.length * 2 + findings.length);
  report.exploitability = report.score >= 9 ? "CRITICAL" : report.score >= 5 ? "HIGH" : report.score >= 2 ? "MEDIUM" : "LOW";
  
  return report;
}

// ─── Main ───

async function main() {
  const args = process.argv.slice(2);
  const slug = args[0];
  const deepMode = args.includes("--deep");
  
  if (!slug) {
    console.log("Usage: node tools/auto-audit-target.js <slug> [--deep]");
    console.log("Examples:");
    console.log("  node tools/auto-audit-target.js beefy");
    console.log("  node tools/auto-audit-target.js reservoir-protocol");
    
    // If no slug, try batch mode from classifier
    console.log("\nBatch mode — scanning top 5 new targets from classifier...\n");
    try {
      const classifierPath = path.join(REPORTS_DIR, "defillama-oracle-classifier.json");
      const data = JSON.parse(fs.readFileSync(classifierPath, "utf8"));
      const newTargets = (data.ranked || []).filter(r => r.isNew).slice(0, 5);
      
      for (const t of newTargets) {
        console.log(`\n═══ ${t.name} ($${(t.tvl/1e6).toFixed(0)}M) ═══`);
        const githubUrl = await findGitHubRepo(t.slug);
        
        if (!githubUrl) {
          console.log(`  GitHub not found`);
          continue;
        }
        
        console.log(`  GitHub: ${githubUrl}`);
        const result = await cloneAndScan(t.slug, githubUrl);
        
        if (result.error) {
          console.log(`  ${result.error}`);
          continue;
        }
        
        const report = generateReport(t.slug, result, githubUrl);
        const outPath = path.join(REPORTS_DIR, `auto-audit-${t.slug}.json`);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
        console.log(`  Score: ${report.score}/10 ${report.exploitability} | ${report.critical} CRITICAL, ${report.high} HIGH`);
        console.log(`  Report: ${outPath}`);
      }
    } catch (e) {
      console.log(`Batch error: ${e.message}`);
    }
    return;
  }
  
  // Single slug mode
  console.log(`Auto-auditing: ${slug}\n`);
  const githubUrl = await findGitHubRepo(slug);
  
  if (!githubUrl) {
    console.log(`GitHub not found for ${slug}`);
    return;
  }
  
  console.log(`GitHub: ${githubUrl}`);
  const result = await cloneAndScan(slug, githubUrl);
  
  if (result.error) {
    console.log(`Error: ${result.error}`);
    return;
  }
  
  const report = generateReport(slug, result, githubUrl);
  const outPath = path.join(REPORTS_DIR, `auto-audit-${slug}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  
  console.log(`\nReport: ${outPath}`);
  console.log(`Score: ${report.score}/10 — ${report.exploitability}`);
  console.log(`Files: ${report.files} | Findings: ${report.totalFindings} (${report.critical} CRITICAL, ${report.high} HIGH)`);
  if (report.topFindings.length > 0) {
    console.log("\nTop findings:");
    for (const f of report.topFindings.slice(0, 10)) {
      console.log(`  ${f.severity.padEnd(10)} ${f.pattern.padEnd(25)} ${f.file}`);
    }
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
