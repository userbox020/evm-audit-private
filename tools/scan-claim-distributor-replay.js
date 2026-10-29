#!/usr/bin/env node
// Read-only airdrop/reward/claim distributor replay and receiver-binding scanner.
// Scans local source plus a small live deployed distributor seed set. No proofs, signatures, or transactions are used.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW = path.join(WORKSPACE, "reports", "raw", "fast");
const OUT_JSON = path.join(RAW, "claim-distributor-replay.json");
const OUT_MD = path.join(WORKSPACE, "reports", "claim-distributor-replay.md");
const QUIET = process.argv.includes("--quiet");

const MAX_SOURCE_FILES = Number(process.env.CLAIM_REPLAY_MAX_SOURCE_FILES || "7000");
const MATERIAL_BALANCE_USD = Number(process.env.CLAIM_REPLAY_MATERIAL_BALANCE_USD || "10000");
const REVIEW_BALANCE_USD = Number(process.env.CLAIM_REPLAY_REVIEW_BALANCE_USD || "1000");
const PROBE_FROM = "0x000000000000000000000000000000000000dEaD";

const TARGETS = [
  { name: "Spark rewards", chain: "Ethereum", priority: 10, dirs: ["targets/spark-rewards", "targets/spark-address-registry", "targets/spark-interface"] },
  { name: "Stargate rewards", chain: "multi-chain", priority: 9, dirs: ["targets/stargate-v2/packages/stg-evm-v2/src/peripheral", "targets/stargate-v2"] },
  { name: "Compound rewards", chain: "multi-chain", priority: 8, dirs: ["targets/compound-comet/contracts", "targets/compound-comet/deployments"] },
  { name: "Silo incentives", chain: "multi-chain", priority: 8, dirs: ["targets/silo-contracts-v2", "targets/silo-vaults"] },
  { name: "Reserve rewards", chain: "Ethereum/Base", priority: 7, dirs: ["targets/reserve-protocol/contracts"] },
  { name: "Ethena distributor", chain: "Ethereum", priority: 7, dirs: ["targets/ethena", "targets/ethena-usde", "targets/ethena-usdtb"] },
  { name: "Bridge / RFQ claim surfaces", chain: "multi-chain", priority: 6, dirs: ["targets/debridge-contracts/contracts", "targets/debridge-contracts-v1/contracts", "targets/synapse-sanguine", "targets/across-contracts/contracts"] },
  { name: "Generic local targets", chain: "multi-chain", priority: 4, dirs: ["targets"] },
];

const TOKENS = {
  USDE: { chainId: 1, address: "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3", decimals: 18, priceUsd: 1 },
  USDC: { chainId: 1, address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, priceUsd: 1 },
  USDT: { chainId: 1, address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6, priceUsd: 1 },
  DAI: { chainId: 1, address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", decimals: 18, priceUsd: 1 },
  UNI: { chainId: 1, address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", decimals: 18, priceUsd: null },
  COMP: { chainId: 1, address: "0xc00e94Cb662C3520282E6f5717214004A7f26888", decimals: 18, priceUsd: null },
  SPK: { chainId: 1, address: "0xc20059e0317DE91738d13af027DfC4a50781b066", decimals: 18, priceUsd: null },
  STSPK: { chainId: 1, address: "0xc6132FAF04627c8d05d6E759FAbB331Ef2D8F8fD", decimals: 18, priceUsd: null },
};

const LIVE_TARGETS = [
  {
    label: "SparkRewards",
    protocol: "Spark",
    chainId: 1,
    address: "0xbaf21A27622Db71041Bd336a573DDEdC8eB65122",
    tokens: ["SPK", "STSPK", "USDE", "USDC"],
    expectedBinding: "claim(epoch, account, token, cumulativeAmount, expectedMerkleRoot, merkleProof) binds account/token/amount and cumulative claimed state",
  },
  {
    label: "Spark PointsRewards",
    protocol: "Spark",
    chainId: 1,
    address: "0xe9eaE48Ed66C63fD4D12e315BC7d31Aacd89a909",
    tokens: ["SPK", "USDE", "USDC"],
    expectedBinding: "points/reward claim seed; requires source/live proof before any route-positive treatment",
  },
  {
    label: "Ethena Distributor",
    protocol: "Ethena",
    chainId: 1,
    address: "0xf2fa332bD83149c66b09B45670bCe64746C6b439",
    tokens: ["USDE", "USDC", "USDT", "DAI"],
    expectedBinding: "operator-distributor flow; permissionless transferInRewards probe should stay gated",
  },
  {
    label: "Uniswap UNI MerkleDistributor",
    protocol: "Uniswap",
    chainId: 1,
    address: "0x090D4613473dEE047c3f2706764f49E0821D256e",
    tokens: ["UNI"],
    expectedBinding: "legacy UNI Merkle distributor should use index/account/amount proof and claimed bitmap",
  },
  {
    label: "Compound III Rewards",
    protocol: "Compound",
    chainId: 1,
    address: "0x1B0e765F6224C21223AeA2af16c1C46E38885a40",
    tokens: ["COMP", "USDC"],
    expectedBinding: "CometRewards claim flow should accrue per market/user and not allow arbitrary receiver drain",
  },
];

const CLAIM_SIGNATURES = [
  "claim()",
  "claim(address)",
  "claim(uint256)",
  "claim(address,uint256)",
  "claim(uint256,address,uint256,bytes32[])",
  "claim(uint256,address,address,uint256,bytes32,bytes32[])",
  "claimRewards()",
  "claimRewards(address)",
  "claimFor(address)",
  "claimTo(address)",
  "getReward()",
  "getReward(address)",
  "transferInRewards(uint256)",
];

const NO_PROOF_PROBES = [
  { signature: "claim()", args: [] },
  { signature: "claim(address)", args: [PROBE_FROM] },
  { signature: "claimRewards()", args: [] },
  { signature: "claimRewards(address)", args: [PROBE_FROM] },
  { signature: "claimFor(address)", args: [PROBE_FROM] },
  { signature: "claimTo(address)", args: [PROBE_FROM] },
  { signature: "getReward()", args: [] },
  { signature: "getReward(address)", args: [PROBE_FROM] },
  { signature: "transferInRewards(uint256)", args: [1n] },
];

const TEXT_EXTS = new Set([".sol", ".vy", ".ts", ".js", ".rs", ".go", ".move"]);
const EXCLUDED_DIRS = new Set([".git", "node_modules", "target", "build", "dist", "out", "cache", "artifacts", "coverage", "generated", "abi", "lib", "vendor", "docs", "doc"]);
const EXCLUDED_PATH_RE = /[\\/](test|tests|mock|mocks|script|scripts|examples?|fixtures?|audits?|cypress|support)[\\/]/i;

const CLAIM_TERMS = ["claim", "claimFor", "claimTo", "claimRewards", "getReward", "airdrop", "distributor", "rewarder", "vesting", "rebate", "merkle"];
const PROOF_TERMS = ["MerkleProof", "merkleProof", "merkle", "proof", "root", "leaf", "verify", "signature", "ecrecover", "EIP712", "_hashTypedData"];
const BINDING_TERMS = ["account", "user", "claimant", "msg.sender", "recipient", "receiver", "to", "token", "amount", "cumulativeAmount", "epoch", "index", "chainId", "block.chainid", "address(this)"];
const CONSUMPTION_TERMS = ["claimed", "isClaimed", "claimedBitMap", "claimedBitmap", "bitmap", "nonces", "used", "spent", "consumed", "cumulative", "claimedAmounts"];
const VALUE_TERMS = ["transfer", "safeTransfer", "transferFrom", "mint", "withdraw", "reward", "token", "amount", "balance", "payout"];
const ROLE_TERMS = ["onlyOwner", "onlyRole", "onlyAdmin", "requiresAuth", "auth", "operator", "guardian", "AccessControl", "Ownable"];
const RECEIVER_TERMS = ["receiver", "recipient", "to", "account"];
const STRONG_BINDINGS = ["msg.sender", "account", "token", "amount", "cumulativeAmount", "epoch", "index"];

function rel(file) {
  return path.relative(WORKSPACE, file).replace(/\\/g, "/");
}

function exists(file) {
  try { return fs.existsSync(file); } catch (_) { return false; }
}

function readText(file) {
  try { return fs.readFileSync(file, "utf8"); } catch (_) { return ""; }
}

function stripComments(text) {
  return String(text || "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1 ")
    .replace(/#.*$/gm, " ");
}

function lower(text) {
  return String(text || "").toLowerCase();
}

function matchedTerms(text, terms) {
  const l = lower(text);
  return terms.filter((term) => l.includes(term.toLowerCase()));
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

function snippet(text, line, radius = 2) {
  const lines = text.split(/\r?\n/);
  const start = Math.max(0, line - 1 - radius);
  const end = Math.min(lines.length, line + radius);
  return lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l.trim()}`).join(" ").slice(0, 500);
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

function walk(root, out = []) {
  if (out.length >= MAX_SOURCE_FILES || !exists(root)) return out;
  const stat = fs.statSync(root);
  if (stat.isFile()) {
    if (stat.size <= 2_000_000 && TEXT_EXTS.has(path.extname(root).toLowerCase()) && !EXCLUDED_PATH_RE.test(root)) out.push(root);
    return out;
  }
  if (!stat.isDirectory()) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (out.length >= MAX_SOURCE_FILES) break;
    if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;
    walk(path.join(root, entry.name), out);
  }
  return out;
}

function extractFunctions(text, ext) {
  const rows = [];
  if (ext === ".vy") {
    const re = /^\s*@external[\s\S]*?^\s*def\s+([A-Za-z0-9_]+)\s*\([^\n]*\):/gm;
    let match;
    while ((match = re.exec(text))) {
      const start = match.index;
      const next = text.slice(match.index + 1).search(/^\s*(?:@external|def\s+)/m);
      const end = next === -1 ? text.length : match.index + 1 + next;
      rows.push({ name: match[1], line: lineNumberAt(text, start), header: match[0], body: stripComments(text.slice(start, end)) });
    }
    return rows;
  }
  const re = /function\s+([A-Za-z0-9_]+)\s*\([^;{]*\)[^{;]*\{/g;
  let match;
  while ((match = re.exec(text))) {
    const open = text.indexOf("{", match.index);
    if (open === -1) continue;
    const end = findBlockEnd(text, open);
    rows.push({ name: match[1], line: lineNumberAt(text, match.index), header: text.slice(match.index, open + 1), body: stripComments(text.slice(match.index, end)) });
    re.lastIndex = end;
  }
  return rows;
}

function accessKind(header) {
  if (/\bexternal\b|@external/i.test(header)) return "external";
  if (/\bpublic\b/i.test(header)) return "public";
  if (/\binternal\b/i.test(header)) return "internal";
  if (/\bprivate\b/i.test(header)) return "private";
  return "unknown";
}

function classifySourceRow(target, base) {
  const publicSurface = ["external", "public"].includes(base.access);
  const hasProof = base.proofTerms.length > 0;
  const hasValueMove = base.valueTerms.length > 0;
  const hasConsumption = base.consumptionTerms.length > 0;
  const hasStrongBinding = base.bindingTerms.some((term) => STRONG_BINDINGS.map((x) => x.toLowerCase()).includes(term.toLowerCase()));
  const receiverLike = base.receiverTerms.length > 0;
  const roleGated = base.roleTerms.length > 0;
  const missing = [];
  if (!hasProof) missing.push("proof-or-signature-binding");
  if (!hasConsumption) missing.push("consumption-state");
  if (!hasStrongBinding) missing.push("account-token-amount-epoch-binding");
  if (receiverLike && !/msg\.sender|account\s*==\s*(receiver|recipient|to)|receiver\s*==\s*account|recipient\s*==\s*account/i.test(base.combined)) missing.push("receiver-binding-proof");

  let confidence = "review";
  if (publicSurface && hasValueMove && missing.includes("consumption-state") && missing.includes("account-token-amount-epoch-binding")) confidence = "high-static";
  else if (publicSurface && hasValueMove && missing.length >= 2) confidence = "medium-static";
  else if (publicSurface && hasProof && hasConsumption && hasStrongBinding) confidence = "scoped-claim";
  if (roleGated && confidence === "high-static") confidence = "medium-static";

  const priorityScore = target.priority * 5
    + (confidence === "high-static" ? 45 : confidence === "medium-static" ? 25 : confidence === "scoped-claim" ? 8 : 5)
    + (publicSurface ? 8 : 0)
    + (hasValueMove ? 8 : 0)
    + (receiverLike ? 4 : 0)
    - (hasConsumption ? 10 : 0)
    - (hasStrongBinding ? 8 : 0)
    - (roleGated ? 6 : 0);

  return {
    ...base,
    publicSurface,
    roleGated,
    confidence,
    priorityScore: Math.round(priorityScore * 100) / 100,
    missingScopes: missing,
    routePositive: false,
    signedActionJustified: false,
    blocker: confidence === "scoped-claim"
      ? "claim path appears scoped by proof/binding/consumption state"
      : "static claim/reward surface needs deployed address, live balances, proof replay, and exact extraction proof",
  };
}

function rowsFromFile(target, filePath) {
  const text = readText(filePath);
  if (!text) return [];
  const ext = path.extname(filePath).toLowerCase();
  const funcs = extractFunctions(text, ext);
  const rows = [];
  for (const fn of funcs) {
    const combined = `${fn.header}\n${fn.body}`;
    const claimTerms = matchedTerms(combined, CLAIM_TERMS);
    const isClaimNamed = /claim|reward|airdrop|distribut|vesting|rebate/i.test(fn.name);
    if (!claimTerms.length && !isClaimNamed) continue;
    rows.push(classifySourceRow(target, {
      target: target.name,
      chain: target.chain,
      file: rel(filePath),
      line: fn.line,
      function: fn.name,
      access: accessKind(fn.header),
      claimTerms: claimTerms.slice(0, 10),
      proofTerms: matchedTerms(combined, PROOF_TERMS).slice(0, 10),
      bindingTerms: matchedTerms(combined, BINDING_TERMS).slice(0, 12),
      consumptionTerms: matchedTerms(combined, CONSUMPTION_TERMS).slice(0, 12),
      receiverTerms: matchedTerms(combined, RECEIVER_TERMS).slice(0, 8),
      valueTerms: matchedTerms(combined, VALUE_TERMS).slice(0, 10),
      roleTerms: matchedTerms(combined, ROLE_TERMS).slice(0, 8),
      snippet: snippet(text, fn.line, 2),
      combined,
    }));
  }
  if (rows.length || !matchedTerms(text, CLAIM_TERMS).length) return rows;
  const line = Math.max(1, text.split(/\r?\n/).findIndex((l) => /claim|reward|airdrop|distributor|vesting|MerkleProof/i.test(l)) + 1);
  const sample = stripComments(text).slice(0, 50_000);
  rows.push(classifySourceRow(target, {
    target: target.name,
    chain: target.chain,
    file: rel(filePath),
    line,
    function: path.basename(filePath),
    access: "file",
    claimTerms: matchedTerms(sample, CLAIM_TERMS).slice(0, 10),
    proofTerms: matchedTerms(sample, PROOF_TERMS).slice(0, 10),
    bindingTerms: matchedTerms(sample, BINDING_TERMS).slice(0, 12),
    consumptionTerms: matchedTerms(sample, CONSUMPTION_TERMS).slice(0, 12),
    receiverTerms: matchedTerms(sample, RECEIVER_TERMS).slice(0, 8),
    valueTerms: matchedTerms(sample, VALUE_TERMS).slice(0, 10),
    roleTerms: matchedTerms(sample, ROLE_TERMS).slice(0, 8),
    snippet: snippet(text, line, 2),
    combined: sample,
  }));
  return rows;
}

function scanSourceTarget(target, seenFiles) {
  const files = [];
  for (const dir of target.dirs) walk(path.join(WORKSPACE, dir), files);
  const uniqueFiles = files.filter((file) => {
    const key = rel(file);
    if (seenFiles.has(key)) return false;
    seenFiles.add(key);
    return true;
  });
  const rows = uniqueFiles.flatMap((file) => rowsFromFile(target, file));
  rows.sort((a, b) => b.priorityScore - a.priorityScore);
  return {
    name: target.name,
    chain: target.chain,
    dirs: target.dirs,
    filesScanned: uniqueFiles.length,
    claimRows: rows.length,
    highStaticRows: rows.filter((r) => r.confidence === "high-static").length,
    mediumStaticRows: rows.filter((r) => r.confidence === "medium-static").length,
    scopedClaimRows: rows.filter((r) => r.confidence === "scoped-claim").length,
    topRows: rows.slice(0, 15).map(({ combined, ...row }) => row),
  };
}

function selector(signature) {
  return ethers.id(signature).slice(0, 10).toLowerCase();
}

function ifaceFor(signature) {
  return new ethers.Interface([`function ${signature}`]);
}

async function callOptional(rpc, target, signature, args = []) {
  try {
    const iface = ifaceFor(signature);
    const data = iface.encodeFunctionData(signature.slice(0, signature.indexOf("(")), args);
    const raw = await rpcCall(rpc, "eth_call", [{ from: PROBE_FROM, to: target, data }, "latest"], 8000);
    if (!raw) return { ok: false, signature, error: "no-response-or-revert" };
    return { ok: true, signature, raw: raw.slice(0, 74) };
  } catch (err) {
    return { ok: false, signature, error: String(err && err.message ? err.message : err).slice(0, 160) };
  }
}

function encodeBalanceOf(owner) {
  return "0x70a08231" + owner.slice(2).toLowerCase().padStart(64, "0");
}

function decodeUint(raw) {
  if (!raw || raw === "0x") return null;
  try { return BigInt(raw); } catch (_) { return null; }
}

function formatUnits(raw, decimals) {
  if (raw === null || raw === undefined) return null;
  try { return Number(ethers.formatUnits(raw, decimals)); } catch (_) { return null; }
}

async function tokenBalance(rpc, tokenKey, owner) {
  const meta = TOKENS[tokenKey];
  if (!meta) return null;
  const raw = await rpcCall(rpc, "eth_call", [{ to: meta.address, data: encodeBalanceOf(owner) }, "latest"], 8000);
  const amountRaw = decodeUint(raw);
  const amount = formatUnits(amountRaw, meta.decimals);
  const usd = meta.priceUsd === null || amount === null ? null : amount * meta.priceUsd;
  return { token: tokenKey, address: meta.address, decimals: meta.decimals, amountRaw: amountRaw === null ? null : amountRaw.toString(), amount, priceUsd: meta.priceUsd, usd };
}

async function scanLiveTarget(target, rpcCache) {
  const rpc = rpcCache[target.chainId] || await resolveRpc(target.chainId);
  rpcCache[target.chainId] = rpc;
  const row = {
    ...target,
    rpcResolved: Boolean(rpc),
    deployed: false,
    codeBytes: 0,
    selectorsFound: [],
    noProofProbes: [],
    balances: [],
    pricedBalanceUsd: 0,
    materialPricedBalanceUsd: false,
    watchCandidate: false,
    routePositive: false,
    signedActionJustified: false,
    blocker: "RPC unavailable",
  };
  if (!rpc) return row;

  const code = await rpcCall(rpc, "eth_getCode", [target.address, "latest"], 8000);
  if (!code || code === "0x") {
    row.blocker = "target has no bytecode at configured address";
    return row;
  }
  row.deployed = true;
  row.codeBytes = (code.length - 2) / 2;
  const codeLower = code.toLowerCase();
  row.selectorsFound = CLAIM_SIGNATURES
    .map((sig) => ({ signature: sig, selector: selector(sig) }))
    .filter((s) => codeLower.includes(s.selector.slice(2)));
  row.noProofProbes = [];
  for (const probe of NO_PROOF_PROBES) {
    if (!row.selectorsFound.some((s) => s.signature === probe.signature)) continue;
    row.noProofProbes.push(await callOptional(rpc, target.address, probe.signature, probe.args));
  }
  row.balances = [];
  for (const token of target.tokens || []) {
    const bal = await tokenBalance(rpc, token, target.address).catch(() => null);
    if (bal) row.balances.push(bal);
  }
  row.pricedBalanceUsd = Math.round(row.balances.reduce((acc, b) => acc + (Number.isFinite(b.usd) ? b.usd : 0), 0) * 100) / 100;
  row.materialPricedBalanceUsd = row.pricedBalanceUsd >= MATERIAL_BALANCE_USD;
  const publicNoProofSuccess = row.noProofProbes.some((p) => p.ok);
  const hasClaimSelector = row.selectorsFound.length > 0;
  row.watchCandidate = Boolean(hasClaimSelector && (row.pricedBalanceUsd >= REVIEW_BALANCE_USD || publicNoProofSuccess));
  row.blocker = row.routePositive
    ? null
    : publicNoProofSuccess
      ? "eth_call succeeded for a no-proof selector, but no state-delta/fork proof or exact asset movement exists"
      : hasClaimSelector
        ? "claim-like selectors exist but no no-proof public claim call succeeded; proof/binding still required"
        : "no claim-like selector detected in deployed bytecode";
  return row;
}

function buildMarkdown(out) {
  const lines = [];
  lines.push("# Claim Distributor Replay");
  lines.push("");
  lines.push(`Generated: ${out.generatedAt}`);
  lines.push("");
  lines.push("Signal: No confirmed permissionless claim/distributor replay drain or route-positive extraction path.");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Source files scanned: ${out.summary.sourceFilesScanned}`);
  lines.push(`- Source claim rows: ${out.summary.sourceClaimRows}`);
  lines.push(`- High static rows: ${out.summary.highStaticRows}`);
  lines.push(`- Live targets scanned: ${out.summary.liveTargetsScanned}`);
  lines.push(`- Live deployed targets: ${out.summary.liveDeployedTargets}`);
  lines.push(`- Live watch candidates: ${out.summary.liveWatchCandidates}`);
  lines.push(`- Route-positive: ${out.summary.routePositive}`);
  lines.push(`- Executable now: ${out.summary.executableNow}`);
  lines.push("");
  lines.push("## Live Targets");
  lines.push("");
  lines.push("| Target | Deployed | Selectors | Priced balance USD | Watch | Blocker |");
  lines.push("|---|---:|---:|---:|---:|---|");
  for (const row of out.liveRows) {
    lines.push(`| ${escapeCell(row.label)} | ${row.deployed ? "yes" : "no"} | ${row.selectorsFound.length} | ${row.pricedBalanceUsd} | ${row.watchCandidate ? "yes" : "no"} | ${escapeCell(row.blocker)} |`);
  }
  lines.push("");
  lines.push("## Top Source Rows");
  lines.push("");
  lines.push("| Target | File | Function | Confidence | Missing scopes | Blocker |");
  lines.push("|---|---|---|---|---|---|");
  for (const row of out.topRows.slice(0, 20)) {
    lines.push(`| ${escapeCell(row.target)} | ${escapeCell(row.file)}:${row.line} | ${escapeCell(row.function)} | ${row.confidence} | ${escapeCell((row.missingScopes || []).join(", "))} | ${escapeCell(row.blocker)} |`);
  }
  lines.push("");
  lines.push("## Gate");
  lines.push("");
  lines.push(out.summary.blocker);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function escapeCell(value) {
  return String(value === null || value === undefined ? "" : value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

async function main() {
  fs.mkdirSync(RAW, { recursive: true });
  const seenFiles = new Set();
  const sourceRows = TARGETS.map((target) => scanSourceTarget(target, seenFiles));
  const rankedSourceRows = sourceRows.flatMap((row) => row.topRows).sort((a, b) => b.priorityScore - a.priorityScore);

  const rpcCache = {};
  const liveRows = [];
  for (const target of LIVE_TARGETS) liveRows.push(await scanLiveTarget(target, rpcCache));
  liveRows.sort((a, b) => (b.routePositive ? 1 : 0) - (a.routePositive ? 1 : 0) || (b.pricedBalanceUsd || 0) - (a.pricedBalanceUsd || 0));

  const sourceFilesScanned = sourceRows.reduce((acc, row) => acc + row.filesScanned, 0);
  const sourceClaimRows = sourceRows.reduce((acc, row) => acc + row.claimRows, 0);
  const highStaticRows = sourceRows.reduce((acc, row) => acc + row.highStaticRows, 0);
  const mediumStaticRows = sourceRows.reduce((acc, row) => acc + row.mediumStaticRows, 0);
  const scopedClaimRows = sourceRows.reduce((acc, row) => acc + row.scopedClaimRows, 0);
  const liveWatchCandidates = liveRows.filter((row) => row.watchCandidate).length;
  const routePositive = liveRows.filter((row) => row.routePositive).length;
  const publicNoProofProbeSuccessRows = liveRows.filter((row) => row.noProofProbes.some((p) => p.ok)).length;

  const out = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-claim-distributor-replay.js",
    scope: "Read-only airdrop/reward/claim distributor replay, receiver-binding, and live-balance prefilter",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: routePositive > 0,
      signedActionJustified: false,
    },
    thresholds: {
      maxSourceFilesPerTarget: MAX_SOURCE_FILES,
      reviewBalanceUsd: REVIEW_BALANCE_USD,
      materialBalanceUsd: MATERIAL_BALANCE_USD,
    },
    summary: {
      sourceTargetsScanned: sourceRows.length,
      sourceFilesScanned,
      sourceClaimRows,
      highStaticRows,
      mediumStaticRows,
      scopedClaimRows,
      liveTargetsScanned: liveRows.length,
      liveTargetsWithRpc: liveRows.filter((row) => row.rpcResolved).length,
      liveDeployedTargets: liveRows.filter((row) => row.deployed).length,
      liveTargetsWithClaimSelectors: liveRows.filter((row) => row.selectorsFound.length > 0).length,
      liveWatchCandidates,
      publicNoProofProbeSuccessRows,
      routePositive,
      executableNow: 0,
      signedActionJustified: false,
      blocker: routePositive > 0
        ? "At least one live claim row requires manual review, state-delta proof, and fork proof before any action."
        : "No live claim/distributor row proves replayable proof, arbitrary receiver drain, successful no-proof asset movement, exact positive value, or fork/local extraction proof.",
    },
    sourceRows,
    liveRows,
    topRows: rankedSourceRows.slice(0, 50),
    gaps: [
      "Live deployed distributor seed set is intentionally small; extend with protocol-specific addresses before closing an externally scoped target.",
      "Static high/medium rows are source review leads only until mapped to deployed bytecode, live balances, and replayable proof material.",
    ],
  };

  fs.writeFileSync(OUT_JSON, `${JSON.stringify(out, null, 2)}\n`);
  fs.writeFileSync(OUT_MD, buildMarkdown(out));
  if (!QUIET) {
    console.log(`Claim distributor replay: sourceRows=${sourceClaimRows} highStatic=${highStaticRows} liveTargets=${liveRows.length} watch=${liveWatchCandidates} routePositive=${routePositive}`);
    console.log(`Report: ${rel(OUT_JSON)}`);
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
