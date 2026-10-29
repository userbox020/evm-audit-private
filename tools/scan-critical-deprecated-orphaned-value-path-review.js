#!/usr/bin/env node
// Focused read-only review for the deprecated/orphaned critical queue branch.
// RPC URLs are resolved in memory only and never written to artifacts.

const fs = require("fs");
const path = require("path");
const { resolveRpcPool, rpcCall } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const IN_JSON = path.join(WORKSPACE, "reports", "raw", "fast", "deprecated-orphaned-reachability.json");
const OUT_JSON = path.join(WORKSPACE, "reports", "raw", "fast", "critical-deprecated-orphaned-value-path-review.json");
const OUT_MD = path.join(WORKSPACE, "reports", "critical-deprecated-orphaned-value-path-review.md");

const SELECTORS = {
  owner: "0x8da5cb5b",
  token: "0xfc0c546a",
  underlyingToken: "0x2495a599",
  alchemicToken: "0xe278f284",
  alchemist: "0x8de925f6",
  collateralAddresses: "0x172f68ad",
  balanceOf: "0x70a08231",
};

const COMMON_TOKENS = {
  1: [
    ["DAI", "0x6B175474E89094C44Da98b954EedeAC495271d0F"],
    ["USDC", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"],
    ["USDT", "0xdAC17F958D2ee523a2206206994597C13D831ec7"],
    ["WETH", "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"],
  ],
  10: [
    ["WETH", "0x4200000000000000000000000000000000000006"],
    ["DAI", "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1"],
    ["USDC.e", "0x7F5c764cBc14f9669B88837ca1490cCa17c31607"],
    ["USDT", "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58"],
  ],
};

function rel(file) {
  return path.relative(WORKSPACE, file).replace(/\\/g, "/");
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; }
}

function lower(value) {
  return String(value || "").toLowerCase();
}

function isAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || ""));
}

function uniqueAddressRows(rows) {
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row || !isAddress(row.address)) continue;
    const key = lower(row.address);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function hexToBigInt(hex) {
  if (!hex || hex === "0x") return 0n;
  try { return BigInt(hex); } catch (_) { return 0n; }
}

function formatEth(wei) {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, "0").slice(0, 8);
  return Number(`${whole}.${frac}`);
}

function encodeUint256(value) {
  return BigInt(value).toString(16).padStart(64, "0");
}

function encodeAddress(value) {
  return String(value).replace(/^0x/i, "").toLowerCase().padStart(64, "0");
}

function decodeAddress(hex) {
  if (!hex || !/^0x[0-9a-fA-F]{64,}$/.test(hex)) return null;
  const addr = `0x${hex.slice(-40)}`;
  if (/^0x0{40}$/i.test(addr)) return null;
  return addr;
}

async function callAddress(rpc, target, selector) {
  const raw = await rpcCall(rpc, "eth_call", [{ to: target, data: selector }, "latest"], 7000);
  return decodeAddress(raw);
}

async function callAddressAtIndex(rpc, target, selector, index) {
  const raw = await rpcCall(rpc, "eth_call", [{ to: target, data: `${selector}${encodeUint256(index)}` }, "latest"], 7000);
  return decodeAddress(raw);
}

async function callBalanceOf(rpc, token, holder) {
  const raw = await rpcCall(rpc, "eth_call", [{ to: token, data: `${SELECTORS.balanceOf}${encodeAddress(holder)}` }, "latest"], 7000);
  return hexToBigInt(raw);
}

function sourcePath(row) {
  const first = row.sources?.[0];
  if (!first) return null;
  const relPath = first.replace(/:\d+$/, "");
  const full = path.join(WORKSPACE, relPath);
  return fs.existsSync(full) ? full : null;
}

function collectAddressArgs(value, out = []) {
  if (typeof value === "string" && isAddress(value)) out.push({ label: "constructor-arg", address: value });
  if (Array.isArray(value)) value.forEach((item) => collectAddressArgs(item, out));
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "string" && isAddress(item)) out.push({ label: key, address: item });
      else collectAddressArgs(item, out);
    }
  }
  return out;
}

function abiFunctions(deployment) {
  return (deployment?.abi || []).filter((item) => item.type === "function");
}

function mutativeFunctions(deployment) {
  return abiFunctions(deployment).filter((fn) => !["view", "pure"].includes(fn.stateMutability));
}

function hasFunction(deployment, name) {
  return abiFunctions(deployment).some((fn) => fn.name === name);
}

function functionSummary(fn) {
  const inputs = (fn.inputs || []).map((input) => input.name || input.type).filter(Boolean);
  return `${fn.name}(${inputs.join(",")})`;
}

function hasThirdPartySourceParam(fn) {
  if (["view", "pure"].includes(fn.stateMutability)) return false;
  return (fn.inputs || []).some((input) => /^(account|from|owner|sender|source|src|user|victim)$/i.test(input.name || ""));
}

function isOwnerOnlyByAbiShape(fn, ownerReadable) {
  if (!ownerReadable) return false;
  return /^(withdraw|updateGlobalConfig|updateTokenConfig|transferOwnership|renounceOwnership)$/i.test(fn.name || "");
}

async function tokenCandidatesForRow(row, deployment, rpc) {
  const rows = [];
  for (const item of collectAddressArgs(deployment?.args || [])) rows.push(item);
  for (const [label, address] of COMMON_TOKENS[row.chainId] || []) rows.push({ label: `common:${label}`, address });
  if (rpc) {
    const dynamicCalls = [
      ["token()", hasFunction(deployment, "token") ? SELECTORS.token : null],
      ["underlyingToken()", hasFunction(deployment, "underlyingToken") ? SELECTORS.underlyingToken : null],
      ["alchemicToken()", hasFunction(deployment, "alchemicToken") ? SELECTORS.alchemicToken : null],
      ["alchemist()", hasFunction(deployment, "alchemist") ? SELECTORS.alchemist : null],
    ].filter(([, selector]) => selector);
    for (const [label, selector] of dynamicCalls) {
      const address = await callAddress(rpc, row.address, selector);
      if (address) rows.push({ label, address });
    }
    if (hasFunction(deployment, "collateralAddresses")) {
      for (let i = 0; i < 10; i += 1) {
        const address = await callAddressAtIndex(rpc, row.address, SELECTORS.collateralAddresses, i);
        if (!address) break;
        rows.push({ label: `collateralAddresses(${i})`, address });
      }
    }
  }
  return uniqueAddressRows(rows).filter((item) => lower(item.address) !== lower(row.address)).slice(0, 24);
}

async function reviewRow(row, rpcByChain) {
  const file = sourcePath(row);
  const deployment = readJson(file, {});
  const rpc = rpcByChain[row.chainId];
  const fns = mutativeFunctions(deployment);
  const ownerReadable = hasFunction(deployment, "owner");
  const owner = ownerReadable && rpc ? await callAddress(rpc, row.address, SELECTORS.owner) : null;
  const nativeWei = rpc ? hexToBigInt(await rpcCall(rpc, "eth_getBalance", [row.address, "latest"], 7000)) : BigInt(row.balanceWei || 0);
  const tokenCandidates = await tokenCandidatesForRow(row, deployment, rpc);
  const tokenBalances = [];
  for (const token of tokenCandidates) {
    if (!rpc) continue;
    const raw = await callBalanceOf(rpc, token.address, row.address);
    tokenBalances.push({ ...token, raw: raw.toString(), positive: raw > 0n });
  }
  const externalMutative = fns.map((fn) => ({
    name: fn.name,
    signatureHint: functionSummary(fn),
    stateMutability: fn.stateMutability,
    inputNames: (fn.inputs || []).map((input) => input.name || ""),
    hasThirdPartySourceParam: hasThirdPartySourceParam(fn),
    ownerOnlyByAbiShape: isOwnerOnlyByAbiShape(fn, ownerReadable),
  }));
  const positiveTokenBalances = tokenBalances.filter((token) => token.positive);
  const thirdPartyMutativeRows = externalMutative.filter((fn) => fn.hasThirdPartySourceParam && !fn.ownerOnlyByAbiShape);
  const ownerOnlyRows = externalMutative.filter((fn) => fn.ownerOnlyByAbiShape);
  const permissionlessValuePath = false;
  const blockers = [];
  if (nativeWei === 0n && positiveTokenBalances.length === 0) blockers.push("No current native/token balance found on the deployed deprecated row under checked token set");
  if (thirdPartyMutativeRows.length === 0) blockers.push("Public mutative ABI does not expose an arbitrary source/account/victim parameter; adapter and migration methods act on msg.sender-owned positions/tokens");
  if (ownerOnlyRows.length > 0) blockers.push("Value/configuration methods with direct withdrawal or update semantics are owner-gated by ABI/bytecode shape");
  blockers.push("No live approval/escrow/registry-consumed accounting path, exact economics, or fork extraction proof");
  return {
    address: row.address,
    chainId: row.chainId,
    source: file ? rel(file) : null,
    terms: row.deprecatedTerms,
    selectorHits: row.selectorHits,
    nativeBalanceWei: nativeWei.toString(),
    nativeBalanceEth: formatEth(nativeWei),
    ownerReadable,
    owner,
    mutativeFunctions: externalMutative,
    checkedTokenBalances: tokenBalances,
    positiveTokenBalances,
    thirdPartyMutativeRows,
    ownerOnlyRows,
    permissionlessValuePath,
    liveApprovalOrEscrow: false,
    exactEconomics: false,
    forkProof: false,
    routePositive: false,
    blockers,
  };
}

function table(rows, cols) {
  const header = `| ${cols.join(" | ")} |`;
  const sep = `| ${cols.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${cols.map((col) => String(row[col] ?? "").replace(/\|/g, "/")).join(" | ")} |`);
  return [header, sep, ...body].join("\n");
}

function renderReport(artifact) {
  const s = artifact.summary;
  const rows = artifact.rows.map((row) => ({
    Address: `${row.address.slice(0, 6)}...${row.address.slice(-4)}`,
    Chain: row.chainId,
    NativeETH: row.nativeBalanceEth,
    TokenBalances: row.positiveTokenBalances.length,
    ThirdPartyParams: row.thirdPartyMutativeRows.length,
    OwnerOnly: row.ownerOnlyRows.length,
    RoutePositive: row.routePositive ? 1 : 0,
    Blocker: row.blockers[0],
  }));
  return [
    "# 🟢 DORMANT - Critical Deprecated/Orphaned Value-Path Review",
    "",
    `Date: ${artifact.generatedAt.slice(0, 10)}`,
    "",
    "## Result",
    "",
    `Reviewed the top deployed deprecated/orphaned rows from \`reports/raw/fast/deprecated-orphaned-reachability.json\` with read-only RPC owner/balance/token checks. This remains fail-closed: \`rowsReviewed=${s.rowsReviewed}\`, \`rowsWithNativeBalance=${s.rowsWithNativeBalance}\`, \`rowsWithTokenBalance=${s.rowsWithTokenBalance}\`, \`rowsWithThirdPartyMutativeParams=${s.rowsWithThirdPartyMutativeParams}\`, \`permissionlessValuePathRows=0\`, \`liveApprovalOrEscrowRows=0\`, \`exactEconomicsRows=0\`, \`forkProofRows=0\`, \`routePositive=0\`, \`executableNow=0\`, \`signedActionJustified=false\`.`,
    "",
    "## Reviewed Rows",
    "",
    table(rows, ["Address", "Chain", "NativeETH", "TokenBalances", "ThirdPartyParams", "OwnerOnly", "RoutePositive", "Blocker"]),
    "",
    "## Gate",
    "",
    "Do not fork this branch until a specific deprecated/orphaned row is proven to have permissionless access to live approvals, escrow, protocol balances, or registry-consumed accounting plus exact positive economics.",
    "",
    "## Artifacts",
    "",
    "- Raw: `reports/raw/fast/critical-deprecated-orphaned-value-path-review.json`",
    "- Source inventory: `reports/raw/fast/deprecated-orphaned-reachability.json`",
    "",
  ].join("\n");
}

async function main() {
  const source = readJson(IN_JSON, {});
  const candidates = (source.rankedRows || []).filter((row) => row.deployedReachability).slice(0, 10);
  const chainIds = [...new Set(candidates.map((row) => Number(row.chainId)).filter(Boolean))];
  const rpcByChain = await resolveRpcPool(chainIds);
  const rows = [];
  for (const row of candidates) rows.push(await reviewRow(row, rpcByChain));
  const summary = {
    sourceGeneratedAt: source.generatedAt || null,
    sourceDeprecatedReachabilityRows: source.summary?.deprecatedReachabilityRows || 0,
    rowsReviewed: rows.length,
    rowsWithNativeBalance: rows.filter((row) => BigInt(row.nativeBalanceWei) > 0n).length,
    rowsWithTokenBalance: rows.filter((row) => row.positiveTokenBalances.length > 0).length,
    rowsWithThirdPartyMutativeParams: rows.filter((row) => row.thirdPartyMutativeRows.length > 0).length,
    permissionlessValuePathRows: 0,
    liveApprovalOrEscrowRows: 0,
    exactEconomicsRows: 0,
    forkProofRows: 0,
    watchCandidates: 0,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
  };
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-critical-deprecated-orphaned-value-path-review.js",
    scope: "Read-only value-path review for top deployed deprecated/orphaned reachability rows",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      liveTransactions: false,
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
    },
    summary,
    rows,
    requiredForRoutePositive: [
      "specific deprecated/orphaned deployed path is permissionlessly callable without trusted role compromise",
      "path reaches live approvals, escrow, protocol balances, or registry-consumed accounting",
      "exact extraction, borrow, redeem, claim, swap, or liquidation economics are positive after gas/slippage/fees",
      "fork/local proof demonstrates net value extraction",
    ],
    nextReadOnlyStep: "Keep this branch as inventory unless a target-specific deprecated row gains token/native balances, third-party source parameters, live approvals/escrow, or registry-consumed accounting.",
  };
  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, `${JSON.stringify(artifact, null, 2)}\n`);
  fs.writeFileSync(OUT_MD, renderReport(artifact));
  console.log(`Critical deprecated review: reviewed=${summary.rowsReviewed} tokenBalanceRows=${summary.rowsWithTokenBalance} thirdPartyParamRows=${summary.rowsWithThirdPartyMutativeParams} routePositive=0`);
  console.log(`Artifact: ${rel(OUT_JSON)}`);
}

main().catch((err) => {
  console.error(String(err?.message || err).replace(/https?:\/\/[^\s'"<>]+/g, "[redacted-rpc]").slice(0, 240));
  process.exitCode = 1;
});
