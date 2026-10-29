#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { id } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const ABI_PATH = path.join(WORKSPACE, "reports", "raw", "fast", "avalon-usda-heimdall", "decompile", "abi.json");
const RECOVERY_PATH = path.join(WORKSPACE, "reports", "raw", "fast", "avalon-usda-selector-recovery.json");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "avalon-usda-abi-classification.json");

const MONEY_RE = /(mint|borrow|redeem|withdraw|deposit|supply|liquidat|repay|claim|collateral|debt|transfer|sweep|burn)/i;
const ORACLE_RE = /(oracle|price|nav|rate|round|answer|feed|redstone|pyth|chainlink)/i;
const ADMIN_RE = /(owner|admin|role|upgrade|pause|unpause|set|config|keeper|minter|treasury|whitelist|blacklist|cap|limit|fee|ltv|threshold|ratio|risk)/i;
const TOKEN_VIEW_RE = /^(name|symbol|decimals|totalSupply|balanceOf|allowance|approve|transfer|transferFrom)\(/i;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function strip0x(value) {
  return String(value || "").replace(/^0x/i, "");
}

function selectorFromAbi(fn) {
  const unresolved = String(fn.name || "").match(/^Unresolved_([0-9a-fA-F]{8})$/);
  if (unresolved) return `0x${unresolved[1].toLowerCase()}`;
  const sig = `${fn.name}(${(fn.inputs || []).map((x) => x.type).join(",")})`;
  return id(sig).slice(0, 10).toLowerCase();
}

function canonicalAbiSignature(fn) {
  return `${fn.name}(${(fn.inputs || []).map((x) => x.type).join(",")})`;
}

function addRecovered(recovered, selector, row) {
  const key = selector.toLowerCase();
  if (!recovered.has(key)) recovered.set(key, { selector: key, signatures: new Set(), contracts: new Set(), flags: new Set() });
  const dst = recovered.get(key);
  for (const sig of row.signatures || row.textSignatures || []) if (sig) dst.signatures.add(sig);
  if (row.contract) dst.contracts.add(row.contract);
  if (row.label) dst.contracts.add(row.label);
  if (row.highInterest) dst.flags.add("highInterest");
  if (row.moneyPath) dst.flags.add("moneyPath");
  if (row.admin) dst.flags.add("admin");
}

function buildRecoveredMap(recovery) {
  const recovered = new Map();
  for (const row of recovery.summary?.topMoneySelectors || []) addRecovered(recovered, row.hex, row);
  for (const result of recovery.results || []) {
    for (const contract of result.contracts || []) {
      for (const selector of contract.push4Selectors || []) addRecovered(recovered, selector, { label: `${result.chain}:${contract.label}` });
      for (const detail of contract.selectorDetails || []) addRecovered(recovered, detail.hex, { ...detail, label: `${result.chain}:${contract.label}` });
    }
  }
  return recovered;
}

function categoryFor(row) {
  const sigText = row.signatureCandidates.join(" | ");
  const haystack = `${row.abiSignature} | ${sigText}`;
  const hasMoney = MONEY_RE.test(haystack);
  const hasOracle = ORACLE_RE.test(haystack);
  const hasAdmin = ADMIN_RE.test(haystack);

  if (/liquidat/i.test(haystack)) return "liquidation";
  if (/(borrow|debt)/i.test(haystack)) return "borrow-debt";
  if (/(redeem|withdraw|claim|sweep)/i.test(haystack)) return "exit-withdraw";
  if (/(mint|deposit|supply)/i.test(haystack)) return "mint-deposit";
  if (/repay/i.test(haystack)) return "repay";
  if (hasOracle) return "oracle-price";
  if (/(role|admin|owner|upgrade|keeper|minter|treasury)/i.test(haystack)) return "admin-access";
  if (/(pause|unpause)/i.test(haystack)) return "pause";
  if (/(cap|limit|ltv|threshold|ratio|risk|fee|config|set)/i.test(haystack)) return "risk-config";
  if (TOKEN_VIEW_RE.test(sigText) || TOKEN_VIEW_RE.test(row.abiSignature)) return "token-standard";
  if (hasMoney) return "money-path";
  if (hasAdmin) return "admin-config";
  if (row.stateMutability === "view" || row.stateMutability === "pure") return "unresolved-view";
  if (row.stateMutability === "payable" || row.stateMutability === "nonpayable") return "unresolved-external";
  return "unknown";
}

function riskWeightFor(row) {
  let score = 0;
  if (["borrow-debt", "exit-withdraw", "liquidation", "mint-deposit"].includes(row.category)) score += 50;
  if (["oracle-price", "risk-config"].includes(row.category)) score += 35;
  if (["admin-access", "pause"].includes(row.category)) score += 20;
  if (row.stateMutability === "payable" || row.stateMutability === "nonpayable") score += 20;
  if (row.stateMutability === "view") score += 5;
  if (row.signatureCandidates.length === 0) score += 10;
  if (row.contracts.some((x) => /poolProxy|implementation/i.test(x))) score += 15;
  if ((row.inputs || []).length <= 3) score += 5;
  return score;
}

function probePriority(row) {
  if (row.stateMutability === "pure") return "skip-pure";
  if (["borrow-debt", "exit-withdraw", "liquidation", "mint-deposit", "oracle-price"].includes(row.category)) return "high";
  if (["risk-config", "admin-access", "pause", "money-path"].includes(row.category)) return "medium";
  if (row.category === "unresolved-external") return "medium";
  return "low";
}

function summarize(rows) {
  const byCategory = {};
  const byMutability = {};
  for (const row of rows) {
    byCategory[row.category] = (byCategory[row.category] || 0) + 1;
    byMutability[row.stateMutability] = (byMutability[row.stateMutability] || 0) + 1;
  }
  return { byCategory, byMutability };
}

function main() {
  const abi = readJson(ABI_PATH).filter((x) => x.type === "function");
  const recovery = readJson(RECOVERY_PATH);
  const recovered = buildRecoveredMap(recovery);

  const rows = abi.map((fn) => {
    const selector = selectorFromAbi(fn);
    const rec = recovered.get(selector) || { signatures: new Set(), contracts: new Set(), flags: new Set() };
    const row = {
      selector,
      abiName: fn.name,
      abiSignature: canonicalAbiSignature(fn),
      inputs: (fn.inputs || []).map((x) => x.type),
      outputs: (fn.outputs || []).map((x) => x.type),
      stateMutability: fn.stateMutability || "unknown",
      signatureCandidates: [...rec.signatures].sort(),
      contracts: [...rec.contracts].sort(),
      recoveredFlags: [...rec.flags].sort(),
    };
    row.category = categoryFor(row);
    row.riskWeight = riskWeightFor(row);
    row.probePriority = probePriority(row);
    return row;
  }).sort((a, b) => b.riskWeight - a.riskWeight || a.selector.localeCompare(b.selector));

  const highPriority = rows.filter((x) => x.probePriority === "high").slice(0, 80);
  const mediumPriority = rows.filter((x) => x.probePriority === "medium").slice(0, 80);
  const unknownExternal = rows.filter((x) => x.category === "unresolved-external");

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/triage-avalon-heimdall-abi.js",
    scope: "Artifact-only Avalon USDa Heimdall ABI selector classification",
    safety: {
      rpcInventoryRead: false,
      rpcUrlsStored: false,
      signedActions: false,
      stateChangingCalls: false,
    },
    inputs: {
      heimdallAbi: path.relative(WORKSPACE, ABI_PATH),
      selectorRecovery: path.relative(WORKSPACE, RECOVERY_PATH),
    },
    summary: {
      abiFunctions: rows.length,
      recoveredSelectorsMatched: rows.filter((x) => x.signatureCandidates.length || x.contracts.length).length,
      highPriorityProbeCandidates: highPriority.length,
      mediumPriorityProbeCandidates: mediumPriority.length,
      unresolvedExternal: unknownExternal.length,
      routePositive: 0,
      signedActionJustified: false,
      ...summarize(rows),
    },
    highPriority,
    mediumPriority,
    unknownExternal: unknownExternal.slice(0, 120),
    rows,
    requiredForRoutePositive: [
      "public money-path selector with permissive access or exploitable oracle dependency",
      "live state shows extractive economics after fees/gas/slippage",
      "fork extraction proof",
    ],
    nextReadOnlyStep: "Use highPriority selectors for eth_call probing and resolved decompilation focus; keep routePositive=0 until a permissionless money path is mapped.",
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");
  console.log(`Avalon ABI classification wrote ${path.relative(WORKSPACE, OUT)}; functions=${rows.length}; high=${highPriority.length}; medium=${mediumPriority.length}; unresolvedExternal=${unknownExternal.length}`);
}

main();
