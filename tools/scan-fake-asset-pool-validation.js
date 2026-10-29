#!/usr/bin/env node
// Read-only fake asset/pool/collateral validation scanner.
// Finds source paths where attacker-created tokens, pools, hooks, LPs, or collateral may be accepted without strong provenance checks.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT_JSON = path.join(WORKSPACE, "reports", "raw", "fast", "fake-asset-pool-validation.json");
const OUT_MD = path.join(WORKSPACE, "reports", "fake-asset-pool-validation-triage.md");
const QUIET = process.argv.includes("--quiet");

const TARGETS = [
  { name: "Cork-like hooks / Uniswap V4", chain: "Ethereum", priority: 10, surface: "hooks", dirs: ["targets/uniswap-v4-core/src", "targets/uniswap-v4-core/contracts", "targets/aerodrome-contracts/contracts", "targets/pendle-core-v2-public/contracts"] },
  { name: "DEX / AMM pool factories", chain: "multi-chain", priority: 8, surface: "pool", dirs: ["targets/curve-stablecoin/contracts", "targets/crvusd/contracts", "targets/stargate-v2/packages/stg-evm-v2/src", "targets/steamm-public", "targets/angle/contracts"] },
  { name: "Morpho / MetaMorpho", chain: "Ethereum/Base", priority: 9, surface: "collateral", dirs: ["targets/morpho-blue/src", "targets/morpho-blue-oracles/src", "targets/morpho-metamorpho/src", "targets/morpho-vault-v2/src"] },
  { name: "Euler EVK / EVC", chain: "Ethereum", priority: 9, surface: "collateral", dirs: ["targets/euler-evk/src", "targets/euler-evc/src", "targets/euler-oracle/src", "targets/euler-periphery/src"] },
  { name: "Silo", chain: "multi-chain", priority: 8, surface: "collateral", dirs: ["targets/silo-contracts-v2/silo-core/contracts", "targets/silo-contracts-v2/silo-oracles/contracts", "targets/silo-contracts-v2"] },
  { name: "Compound / Moonwell", chain: "multi-chain", priority: 8, surface: "collateral", dirs: ["targets/compound-comet/contracts", "targets/compound-open-oracle/contracts", "targets/moonwell-contracts-v2/src", "targets/moonwell-contracts/contracts"] },
  { name: "Aave / Spark / Hyperlend", chain: "multi-chain", priority: 8, surface: "collateral", dirs: ["targets/aave-v3-origin/src", "targets/sparklend-v1-core/contracts", "targets/hyperlend-core/contracts", "targets/hyperlend-isolated/contracts"] },
  { name: "Venus", chain: "multi-chain", priority: 8, surface: "collateral", dirs: ["targets/venus-protocol/contracts", "targets/venus-isolated-pools/contracts", "targets/venus-oracle/contracts"] },
  { name: "LlamaLend / Fraxlend", chain: "Ethereum", priority: 8, surface: "collateral", dirs: ["targets/llamalend/contracts", "targets/fraxlend/src"] },
  { name: "Dolomite / Gearbox / TermMax", chain: "multi-chain", priority: 7, surface: "collateral", dirs: ["targets/dolomite-margin/contracts", "targets/dolomite-margin-modules/packages", "targets/gearbox-core-v3/contracts", "targets/termmax-contract-v2/contracts", "targets/termmax/contracts"] },
  { name: "Ajna / Maple / Alchemix", chain: "Ethereum", priority: 7, surface: "collateral", dirs: ["targets/ajna-core/src", "targets/maple-core-v2/contracts", "targets/alchemix/contracts"] },
  { name: "Vaults / strategies", chain: "multi-chain", priority: 6, surface: "vault", dirs: ["targets/yearn-vaults-v3/contracts", "targets/tokenized-strategy/src", "targets/spark-vaults-v2/src", "targets/etherfi-contracts/src"] },
];

const TEXT_EXTS = new Set([".sol", ".vy", ".rs", ".move", ".ts", ".js"]);
const EXCLUDED_DIRS = new Set([".git", "node_modules", "target", "build", "dist", "out", "cache", "artifacts", "coverage", "generated", "abi", "lib", "vendor", "docs", "doc"]);
const EXCLUDED_PATH_RE = /[\\/](test|tests|mock|mocks|script|scripts|examples?|fixtures?|gitmodules|offchain-helpers)[\\/]/i;

const ENTRY_TERMS = [
  "createPool", "createPair", "initializePool", "initPool", "deployPool", "registerPool", "addPool", "setPool",
  "createMarket", "initializeMarket", "supportMarket", "listMarket", "addMarket", "enableMarket", "setMarket",
  "addCollateral", "setCollateral", "supplyCollateral", "depositCollateral", "setAsset", "addAsset", "registerAsset", "configureAsset",
  "beforeSwap", "afterSwap", "beforeAddLiquidity", "afterAddLiquidity", "onSwap", "hook", "callback", "unlockCallback",
  "mint", "redeem", "withdraw", "claim", "borrow", "liquidate", "swap", "settle", "execute",
];
const ASSET_TERMS = [
  "token0", "token1", "tokenA", "tokenB", "tokenIn", "tokenOut", "asset", "underlying", "collateral", "quoteToken", "baseToken", "loanToken", "borrowToken", "debtToken", "lpToken", "pool", "pair", "market", "vault", "oracle", "rateProvider", "hook", "PoolKey", "poolId",
];
const USER_SUPPLIED_TERMS = ["calldata", "memory", "address", "PoolKey", "params", "input", "data", "bytes", "msg.sender", "recipient", "receiver"];
const VALUE_TERMS = ["mint", "burn", "redeem", "withdraw", "claim", "borrow", "liquidate", "seize", "transfer", "safeTransfer", "transferFrom", "swap", "settle", "payout", "repay", "flash"];
const HOOK_TERMS = ["beforeSwap", "afterSwap", "beforeAddLiquidity", "afterAddLiquidity", "hook", "PoolManager", "unlockCallback", "callback", "IHook", "Hooks"];
const LISTING_TERMS = ["collateralFactor", "loanToValue", "ltv", "lltv", "liquidationThreshold", "borrowCap", "supplyCap", "oracle", "price", "supportMarket", "isListed", "assetConfig", "marketConfig"];
const POOL_TERMS = ["factory", "create2", "initCodeHash", "POOL_INIT_CODE_HASH", "getPair", "getPool", "poolId", "PoolKey", "token0", "token1", "sortTokens", "sqrtPrice", "tickSpacing"];
const STRONG_VALIDATION_TERMS = [
  "whitelist", "allowlist", "isWhitelisted", "isAllowed", "isSupported", "supportedAssets", "isListed", "listed", "assetConfig", "marketConfig", "collateralConfig",
  "registry", "factory", "getPair", "getPool", "allPools", "poolManager", "PoolManager", "onlyPoolManager", "onlyHook", "onlyMarket", "onlyComptroller", "onlyEVC", "onlyVault",
  "extcodehash", "codehash", "INIT_CODE_HASH", "POOL_INIT_CODE_HASH", "CREATE2", "computeAddress", "canonical", "trusted", "approved", "oracle", "priceOracle", "riskManager", "controller",
];
const WEAK_VALIDATION_TERMS = ["require", "revert", "!= address(0)", "address(0)", "decimals", "symbol", "name", "balanceOf", "totalSupply", "token0", "token1"];
const ROLE_GATED_TERMS = ["onlyOwner", "onlyAdmin", "onlyGovernor", "onlyGovernance", "onlyGovernanceOrGuardian", "onlyRole", "requiresAuth", "auth", "AccessControl", "Ownable", "governance", "governor", "admin", "timelock"];
const CALLBACK_GUARD_TERMS = ["msg.sender == address(poolManager)", "msg.sender != address(poolManager)", "onlyPoolManager", "poolManager.unlock", "PoolManagerOnly", "NotPoolManager", "Unauthorized", "onlyHook"];
const FAKE_RISK_HINTS = ["arbitrary", "custom", "external", "untrusted", "user", "params", "calldata", "bytes", "data", "unknown", "fallback", "default", "create"];

function exists(filePath) {
  try { return fs.existsSync(filePath); } catch (_) { return false; }
}

function rel(filePath) {
  return path.relative(WORKSPACE, filePath).replace(/\\/g, "/");
}

function safeRead(filePath) {
  try { return fs.readFileSync(filePath, "utf8"); } catch (_) { return ""; }
}

function walk(root, out = []) {
  if (!exists(root)) return out;
  const stat = fs.statSync(root);
  if (stat.isFile()) {
    if (stat.size <= 2_000_000 && TEXT_EXTS.has(path.extname(root).toLowerCase()) && !EXCLUDED_PATH_RE.test(root)) out.push(root);
    return out;
  }
  if (!stat.isDirectory()) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;
    walk(path.join(root, entry.name), out);
  }
  return out;
}

function stripComments(text) {
  return String(text || "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1 ");
}

function lower(text) {
  return String(text || "").toLowerCase();
}

function matchedTerms(text, terms) {
  const source = lower(text);
  return terms.filter((term) => source.includes(lower(term)));
}

function unique(items) {
  return [...new Set((items || []).filter(Boolean))];
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

function findBlockEnd(text, openBrace) {
  let depth = 0;
  for (let i = openBrace; i < text.length; i++) {
    const c = text[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

function extractSolFunctions(text) {
  const rows = [];
  const re = /function\s+([A-Za-z0-9_]+)\s*\([^;{]*\)[^{;]*\{/g;
  let match;
  while ((match = re.exec(text))) {
    const open = text.indexOf("{", match.index);
    if (open === -1) continue;
    const end = findBlockEnd(text, open);
    rows.push({
      name: match[1],
      line: lineNumberAt(text, match.index),
      header: text.slice(match.index, open + 1),
      body: stripComments(text.slice(match.index, end)),
    });
    re.lastIndex = end;
  }
  return rows;
}

function rowsFromTextFile(fileText) {
  const rows = [];
  const lines = fileText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (/createPool|createMarket|collateral|PoolKey|hook|callback|oracle|asset|market|mint|redeem|withdraw|borrow|liquidate/i.test(lines[i])) {
      const start = Math.max(0, i - 6);
      const end = Math.min(lines.length, i + 16);
      rows.push({ name: "text-context", line: i + 1, header: lines[i], body: stripComments(lines.slice(start, end).join("\n")) });
      if (rows.length >= 18) break;
    }
  }
  return rows;
}

function snippet(text, line, radius = 2) {
  const lines = text.split(/\r?\n/);
  const start = Math.max(0, line - 1 - radius);
  const end = Math.min(lines.length, line + radius);
  return lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l.trim()}`).join(" ").slice(0, 500);
}

function accessKind(header) {
  if (/\bexternal\b/i.test(header)) return "external";
  if (/\bpublic\b/i.test(header)) return "public";
  if (/\binternal\b/i.test(header)) return "internal";
  if (/\bprivate\b/i.test(header)) return "private";
  return "unknown";
}

function targetScope(files) {
  const sample = files.map(safeRead).join("\n").slice(0, 12_000_000);
  return {
    validationTerms: matchedTerms(sample, STRONG_VALIDATION_TERMS),
    hookGuardTerms: matchedTerms(sample, CALLBACK_GUARD_TERMS),
    listingTerms: matchedTerms(sample, LISTING_TERMS),
    poolTerms: matchedTerms(sample, POOL_TERMS),
  };
}

function classifySurface(fnName, text, targetSurface) {
  const combined = `${fnName}\n${text}`;
  const surfaces = [];
  if (matchedTerms(combined, HOOK_TERMS).length || /hook|callback/i.test(fnName)) surfaces.push("hook-callback");
  if (matchedTerms(combined, POOL_TERMS).length || /pool|pair/i.test(fnName)) surfaces.push("pool-provenance");
  if (matchedTerms(combined, LISTING_TERMS).length || /market|collateral|asset/i.test(fnName)) surfaces.push("collateral-listing");
  if (/vault|share|rateProvider|lpToken|redeem|withdraw|mint/i.test(combined)) surfaces.push("receipt-or-lp-asset");
  if (!surfaces.length) surfaces.push(targetSurface || "asset-validation");
  return unique(surfaces);
}

function missingValidation(surfaceKinds, localStrong, localHookGuard) {
  const missing = [];
  const strong = localStrong.join("|");
  if (surfaceKinds.includes("hook-callback") && localHookGuard.length === 0) missing.push("hook-caller/pool-manager guard");
  if (surfaceKinds.includes("pool-provenance") && !/factory|getPair|getPool|codehash|INIT_CODE_HASH|CREATE2|PoolKey|poolId/i.test(strong)) missing.push("factory/codehash/pool-key provenance");
  if (surfaceKinds.includes("collateral-listing") && !/whitelist|allowlist|isListed|assetConfig|marketConfig|registry|controller|riskManager|priceOracle|oracle/i.test(strong)) missing.push("asset whitelist/listing/oracle config");
  if (surfaceKinds.includes("receipt-or-lp-asset") && !/underlying|registry|vault|canonical|trusted|oracle|priceOracle|factory|approved/i.test(strong)) missing.push("underlying/receipt provenance");
  if (localStrong.length === 0) missing.push("strong provenance validation");
  return unique(missing);
}

function analyzeRow(target, filePath, fileText, fn, scope) {
  const combined = `${fn.header}\n${fn.body}`;
  const access = accessKind(fn.header);
  const publicSurface = access === "external" || access === "public" || fn.name === "text-context";
  const entryTerms = matchedTerms(`${fn.name}\n${combined}`, ENTRY_TERMS);
  const assetTerms = matchedTerms(combined, ASSET_TERMS);
  const userSuppliedTerms = matchedTerms(`${fn.header}\n${combined.slice(0, 1200)}`, USER_SUPPLIED_TERMS);
  const valueTerms = matchedTerms(combined, VALUE_TERMS);
  const hookTerms = matchedTerms(combined, HOOK_TERMS);
  const listingTerms = matchedTerms(combined, LISTING_TERMS);
  const poolTerms = matchedTerms(combined, POOL_TERMS);
  const strongValidationTerms = matchedTerms(combined, STRONG_VALIDATION_TERMS);
  const weakValidationTerms = matchedTerms(combined, WEAK_VALIDATION_TERMS);
  const callbackGuardTerms = matchedTerms(combined, CALLBACK_GUARD_TERMS);
  const roleGatedTerms = matchedTerms(`${fn.header}\n${combined.slice(0, 1500)}`, ROLE_GATED_TERMS);
  const riskHints = matchedTerms(combined, FAKE_RISK_HINTS);
  const surfaceKinds = classifySurface(fn.name, combined, target.surface);
  const missing = missingValidation(surfaceKinds, strongValidationTerms, callbackGuardTerms);
  const targetHasStrongValidation = scope.validationTerms.length > 0 || scope.hookGuardTerms.length > 0;
  const headerAssetInput = /address\s+(token|asset|pool|pair|collateral|underlying|vault|oracle|market|baseToken|quoteToken|loanToken|borrowToken|debtToken)|PoolKey\s+|MarketParams\s+|AssetConfig\s+|CollateralConfig\s+/i.test(fn.header);
  const configuratorLike = /create|initialize|support|set|add|register|configure|list/i.test(fn.name) && assetTerms.length >= 1;
  const hookLikeInput = surfaceKinds.includes("hook-callback") && (hookTerms.length > 0 || /hook|callback/i.test(fn.name));
  const acceptsAssetLikeInput = headerAssetInput || configuratorLike || hookLikeInput || fn.name === "text-context";
  const valueOrConfigMoving = valueTerms.length > 0 || listingTerms.length > 0 || /create|initialize|support|set|add|register|configure|list/i.test(fn.name);
  const weakOnly = strongValidationTerms.length === 0 && weakValidationTerms.length > 0;
  const noLocalProvenance = strongValidationTerms.length === 0 || missing.length >= 2;
  const highSignalShape = (
    surfaceKinds.includes("pool-provenance") && (configuratorLike || headerAssetInput || /pool|pair/i.test(fn.name))
  ) || (
    surfaceKinds.includes("collateral-listing") && (configuratorLike || /collateral|market|asset|oracle|ltv|borrow|supply/i.test(fn.name))
  ) || (
    surfaceKinds.includes("hook-callback") && /hook|callback|before|after|unlock/i.test(fn.name)
  );

  let confidence = "context";
  if (publicSurface && highSignalShape && acceptsAssetLikeInput && valueOrConfigMoving && noLocalProvenance && missing.length >= 2 && roleGatedTerms.length === 0) confidence = "high-static";
  else if (publicSurface && acceptsAssetLikeInput && valueOrConfigMoving && missing.length >= 1 && roleGatedTerms.length <= 1) confidence = "medium-static";
  else if (publicSurface && (acceptsAssetLikeInput || entryTerms.length) && (assetTerms.length || hookTerms.length || listingTerms.length || poolTerms.length)) confidence = "review";
  else if (entryTerms.length || assetTerms.length >= 2) confidence = "context";

  const priorityScore = Math.round(
    target.priority * 6
    + (confidence === "high-static" ? 46 : confidence === "medium-static" ? 30 : confidence === "review" ? 16 : 5)
    + (publicSurface ? 6 : 0)
    + (valueTerms.length ? 8 : 0)
    + (hookTerms.length ? 8 : 0)
    + (listingTerms.length ? 6 : 0)
    + (poolTerms.length ? 5 : 0)
    + (weakOnly ? 4 : 0)
    + Math.min(6, riskHints.length)
    - (roleGatedTerms.length ? 16 : 0)
    - (strongValidationTerms.length ? 8 : 0)
    - (callbackGuardTerms.length ? 6 : 0)
    - (targetHasStrongValidation && confidence === "context" ? 3 : 0)
  );
  const blocker = confidence === "high-static"
    ? "Static row accepts asset/pool/hook-like inputs without obvious local provenance checks, but no deployed consumer accepts an attacker-created asset with positive economics."
    : confidence === "medium-static"
      ? "Potential validation gap needs manual provenance comparison against factory, registry, oracle, and deployed consumer state."
      : "Context row only; target-wide validation, role gates, or non-value-moving semantics may close this path.";

  return {
    target: target.name,
    chain: target.chain,
    file: rel(filePath),
    line: fn.line,
    function: fn.name,
    access,
    confidence,
    priorityScore,
    surfaceKinds,
    publicSurface,
    acceptsAssetLikeInput,
    valueOrConfigMoving,
    entryTerms: entryTerms.slice(0, 10),
    assetTerms: assetTerms.slice(0, 12),
    userSuppliedTerms: userSuppliedTerms.slice(0, 8),
    valueTerms: valueTerms.slice(0, 8),
    hookTerms: hookTerms.slice(0, 8),
    listingTerms: listingTerms.slice(0, 8),
    poolTerms: poolTerms.slice(0, 8),
    strongValidationTerms: strongValidationTerms.slice(0, 10),
    weakValidationTerms: weakValidationTerms.slice(0, 8),
    callbackGuardTerms: callbackGuardTerms.slice(0, 8),
    roleGatedTerms: roleGatedTerms.slice(0, 8),
    missingValidation: missing,
    routePositive: false,
    signedActionJustified: false,
    blocker,
    snippet: snippet(fileText, fn.line, 2),
  };
}

function scanTarget(target) {
  const files = [];
  const existingDirs = [];
  for (const dir of target.dirs) {
    const abs = path.join(WORKSPACE, dir);
    if (exists(abs)) existingDirs.push(dir);
    walk(abs, files);
  }
  const uniqueFiles = [...new Set(files)];
  const scope = targetScope(uniqueFiles);
  const rows = [];
  for (const filePath of uniqueFiles) {
    const text = safeRead(filePath);
    if (!text) continue;
    const ext = path.extname(filePath).toLowerCase();
    const functions = ext === ".sol" || ext === ".vy" ? extractSolFunctions(text) : rowsFromTextFile(text);
    for (const fn of functions) {
      const combined = `${fn.name}\n${fn.header}\n${fn.body}`;
      if (matchedTerms(combined, ENTRY_TERMS).length === 0 && matchedTerms(combined, ASSET_TERMS).length < 2) continue;
      const row = analyzeRow(target, filePath, text, fn, scope);
      if (row.confidence !== "context" || row.priorityScore >= target.priority * 6 + 8) rows.push(row);
    }
  }
  rows.sort((a, b) => b.priorityScore - a.priorityScore || a.file.localeCompare(b.file));
  return {
    name: target.name,
    chain: target.chain,
    surface: target.surface,
    dirs: target.dirs,
    existingDirs,
    filesScanned: uniqueFiles.length,
    validationRows: rows.length,
    highStaticRows: rows.filter((row) => row.confidence === "high-static").length,
    mediumStaticRows: rows.filter((row) => row.confidence === "medium-static").length,
    reviewRows: rows.filter((row) => row.confidence === "review").length,
    hookRows: rows.filter((row) => row.surfaceKinds.includes("hook-callback")).length,
    poolRows: rows.filter((row) => row.surfaceKinds.includes("pool-provenance")).length,
    collateralRows: rows.filter((row) => row.surfaceKinds.includes("collateral-listing")).length,
    receiptRows: rows.filter((row) => row.surfaceKinds.includes("receipt-or-lp-asset")).length,
    missingProvenanceRows: rows.filter((row) => row.missingValidation.length > 0).length,
    roleGatedRows: rows.filter((row) => row.roleGatedTerms.length > 0).length,
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
    Dirs: row.existingDirs.length ? row.existingDirs.length : "missing",
    Files: row.filesScanned,
    Rows: row.validationRows,
    High: row.highStaticRows,
    Medium: row.mediumStaticRows,
    Hooks: row.hookRows,
    Collateral: row.collateralRows,
  }));
  const top = artifact.rankedRows.slice(0, 14).map((row) => ({
    Target: row.target,
    Surface: row.surfaceKinds.join(", "),
    Function: row.function,
    File: `${row.file}:${row.line}`,
    Confidence: row.confidence,
    Missing: row.missingValidation.join(", "),
    Blocker: row.blocker,
  }));
  return [
    "# 🟢 DORMANT — Fake Asset/Pool Validation Scan",
    "",
    `Date: ${artifact.generatedAt.slice(0, 10)}`,
    "",
    "## Result",
    "",
    `Scanned ${artifact.summary.filesScanned} local source files across ${artifact.summary.targetsScanned} target groups for Cork/Resupply-style fake token, fake pool, fake LP, unauthorized hook callback, and spoofed collateral acceptance patterns. Route gate remains closed: \`routePositive=0\`, \`executableNow=0\`, \`signedActionJustified=false\`.`,
    "",
    `The scan found ${artifact.summary.highStaticRows} high-static rows, ${artifact.summary.mediumStaticRows} medium-static rows, ${artifact.summary.reviewRows} review rows, ${artifact.summary.hookRows} hook/callback rows, and ${artifact.summary.collateralRows} collateral/listing rows. These are static review leads only until a deployed consumer accepts an attacker-created asset or pool and exact borrow/redeem/unwind economics are positive.`,
    "",
    `Route-relevant gates remain closed: deployed acceptance rows \`${artifact.summary.deployedAcceptanceRows}\`, consumer-linked rows \`${artifact.summary.consumerLinkedRows}\`, exact-economics rows \`${artifact.summary.exactEconomicsRows}\`, and fork-proof rows \`${artifact.summary.forkProofRows}\`.`,
    "",
    "## Target Coverage",
    "",
    table(targetRows, ["Target", "Dirs", "Files", "Rows", "High", "Medium", "Hooks", "Collateral"]),
    "",
    "## Top Rows",
    "",
    top.length ? table(top, ["Target", "Surface", "Function", "File", "Confidence", "Missing", "Blocker"]) : "No fake-asset validation rows found in local source checkouts.",
    "",
    "## Route-Positive Gate",
    "",
    "Do not fork or build executors until a row proves: an attacker-created token/pool/hook/LP is accepted by a deployed value-moving consumer, the path is permissionless, live borrow/redeem/DEX liquidity exists, and exact economics are positive after gas/slippage.",
    "",
    "## Artifacts",
    "",
    "- JSON: `reports/raw/fast/fake-asset-pool-validation.json`",
    "- Scanner: `tools/scan-fake-asset-pool-validation.js`",
    "- Related branches: `reports/raw/fast/new-vault-donation-attack.json`, `reports/raw/fast/factory-launch-donation-watch.json`, `reports/raw/fast/consumer-first-high-ltv-collateral.json`",
    "",
  ].join("\n");
}

function main() {
  const sourceTargets = TARGETS.map(scanTarget);
  const rankedRows = sourceTargets.flatMap((target) => target.topRows).sort((a, b) => b.priorityScore - a.priorityScore || a.file.localeCompare(b.file));
  const summary = {
    targetsScanned: sourceTargets.length,
    targetsWithSource: sourceTargets.filter((row) => row.filesScanned > 0).length,
    filesScanned: sourceTargets.reduce((acc, row) => acc + row.filesScanned, 0),
    validationRows: sourceTargets.reduce((acc, row) => acc + row.validationRows, 0),
    staticSourceRows: sourceTargets.reduce((acc, row) => acc + row.validationRows, 0),
    highStaticRows: sourceTargets.reduce((acc, row) => acc + row.highStaticRows, 0),
    mediumStaticRows: sourceTargets.reduce((acc, row) => acc + row.mediumStaticRows, 0),
    reviewRows: sourceTargets.reduce((acc, row) => acc + row.reviewRows, 0),
    hookRows: sourceTargets.reduce((acc, row) => acc + row.hookRows, 0),
    poolRows: sourceTargets.reduce((acc, row) => acc + row.poolRows, 0),
    collateralRows: sourceTargets.reduce((acc, row) => acc + row.collateralRows, 0),
    receiptRows: sourceTargets.reduce((acc, row) => acc + row.receiptRows, 0),
    missingProvenanceRows: sourceTargets.reduce((acc, row) => acc + row.missingProvenanceRows, 0),
    roleGatedRows: sourceTargets.reduce((acc, row) => acc + row.roleGatedRows, 0),
    deployedAcceptanceRows: 0,
    consumerLinkedRows: 0,
    exactEconomicsRows: 0,
    forkProofRows: 0,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    blocker: "No row proves a deployed consumer accepts attacker-created assets/pools with exact positive borrow, redeem, or unwind economics.",
  };
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-fake-asset-pool-validation.js",
    scope: "Read-only fake asset, fake pool, hook callback, and collateral acceptance validation scan",
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
    validationCategories: ["hook-callback", "pool-provenance", "collateral-listing", "receipt-or-lp-asset"],
    summary,
    sourceTargets,
    rankedRows: rankedRows.slice(0, 120),
    requiredForRoutePositive: [
      "deployed value-moving consumer accepts attacker-created token, pool, hook, LP, receipt, or collateral",
      "acceptance path is permissionless and not role-gated by governance/admin/oracle configuration",
      "borrow, redeem, swap, or liquidation liquidity is live and material",
      "exact route economics are positive after gas, slippage, flash fees, and unwind costs",
      "fork/local proof demonstrates value extraction",
    ],
    nextReadOnlyStep: "Manually inspect top high-static rows for exact provenance checks and deployed consumer state; fork only if attacker-created asset acceptance plus positive economics is proven.",
  };

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, `${JSON.stringify(artifact, null, 2)}\n`);
  fs.writeFileSync(OUT_MD, `${renderReport(artifact)}\n`);

  if (!QUIET) {
    console.log(`fake-asset-pool-validation: targets=${summary.targetsScanned}; sourceTargets=${summary.targetsWithSource}; files=${summary.filesScanned}; highStatic=${summary.highStaticRows}; medium=${summary.mediumStaticRows}; routePositive=0`);
    console.log(`Report: ${rel(OUT_MD)}`);
  }
}

main();
