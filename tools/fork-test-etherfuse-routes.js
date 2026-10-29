#!/usr/bin/env node
"use strict";

// fork-test-etherfuse-routes.js
// Local-only Etherfuse route/value-delta harness. Fail-closed unless the
// full-test scanner emits a route-positive candidate. No endpoint inventories,
// private-key files, live transactions, broadcasts, or wallet ops.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const IN_JSON = path.join(WORKSPACE, "reports", "raw", "fast", "etherfuse-full-test.json");
const PREFILTER_JSON = path.join(WORKSPACE, "reports", "raw", "fast", "prefilter-etherfuse-route-prefilter.json");
const OUT_JSON = path.join(WORKSPACE, "reports", "raw", "fast", "etherfuse-fork-route-test.json");
const OUT_MD = path.join(WORKSPACE, "reports", "etherfuse-fork-route-test.md");
const OUT_JSON_REL = "reports/raw/fast/etherfuse-fork-route-test.json";
const OUT_MD_REL = "reports/etherfuse-fork-route-test.md";
const QUIET = process.argv.includes("--quiet");
const GENERATED_AT = process.env.SCAN_GENERATED_AT || "2026-07-07T00:00:00.000Z";

const TARGET = {
  slug: "etherfuse",
  protocolSlug: "etherfuse",
  name: "Etherfuse",
  surface: "rwa-tokenized-bond-consumer",
  routeGraph: "tokenized bond -> transfer/redeem/NAV/oracle -> lending/DEX consumer -> borrow/redeem/unwind/exit",
  caveatChains: ["Solana", "Stellar", "Monad"],
};

const ACTION_SELECTOR_WATCHLIST = [
  { group: "erc20-transfer", name: "transfer", signature: "transfer(address,uint256)", selector: "0xa9059cbb" },
  { group: "erc20-transfer", name: "transferFrom", signature: "transferFrom(address,address,uint256)", selector: "0x23b872dd" },
  { group: "rwa-redemption", name: "redeem", signature: "redeem(uint256)", selector: "0xdb006a75" },
  { group: "rwa-redemption", name: "withdraw", signature: "withdraw(uint256)", selector: "0x2e1a7d4d" },
  { group: "rwa-redemption", name: "burn", signature: "burn(uint256)", selector: "0x42966c68" },
  { group: "rwa-redemption", name: "claim", signature: "claim() / claim(uint256)", selector: "watch-only" },
  { group: "oracle-nav", name: "latestAnswer", signature: "latestAnswer()", selector: "0x50d25bcd" },
  { group: "oracle-nav", name: "latestRoundData", signature: "latestRoundData()", selector: "0xfeaf968c" },
  { group: "erc4626", name: "totalAssets", signature: "totalAssets()", selector: "0x01e1d114" },
  { group: "erc4626", name: "convertToAssets", signature: "convertToAssets(uint256)", selector: "0x07a2d13a" },
  { group: "aave-consumer", name: "supply", signature: "supply(address,uint256,address,uint16)", selector: "0x617ba037" },
  { group: "aave-consumer", name: "borrow", signature: "borrow(address,uint256,uint256,uint16,address)", selector: "0xa415bcad" },
  { group: "dex-exit", name: "swapExactTokensForTokens", signature: "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)", selector: "0x38ed1739" },
  { group: "dex-exit", name: "exactInputSingle", signature: "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))", selector: "0x04e45aaf" },
];

function log(...args) { if (!QUIET) console.log(...args); }
function ensureDir(filePath) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch (_error) { return null; }
}
function mdEscape(value) { return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim(); }
function isLocalRpc(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return parsed.protocol === "http:" && (host === "127.0.0.1" || host === "localhost" || host === "::1");
  } catch (_error) {
    return false;
  }
}
function cliArg(name) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}
function shortAddress(value) { const text = String(value || ""); return /^0x[0-9a-fA-F]{40}$/.test(text) ? `${text.slice(0, 6)}...${text.slice(-4)}` : text; }
function isEvmAddress(value) { return /^0x[0-9a-fA-F]{40}$/.test(String(value || "")); }

function fallbackCandidateRows(prefilter) {
  const rows = [];
  for (const token of Array.isArray(prefilter?.tokenRows) ? prefilter.tokenRows : []) {
    rows.push({
      role: `${token.chain || token.chainId || "EVM"} ${token.symbol || token.name || "Etherfuse token"}`,
      chain: token.chain,
      chainId: token.chainId,
      address: token.address,
      rawAddress: token.address,
      candidateType: "etherfuse-tokenized-bond-token",
      status: "prefilter-token-context-only",
      routePositive: 0,
      addressSchemaValid: isEvmAddress(token.address),
      excludedFromAddressSchema: false,
      codePresent: Boolean(token.codePresent),
      blocker: "No route-positive full-test scanner candidate.",
    });
  }
  return rows;
}

function candidateRows(scanner, prefilter) {
  const scannerRows = Array.isArray(scanner?.candidateMatrix?.candidates) ? scanner.candidateMatrix.candidates : [];
  if (scannerRows.length) return scannerRows.map((row) => ({
    role: row.role,
    chain: row.chain,
    chainId: row.chainId,
    address: row.address,
    rawAddress: row.rawAddress,
    candidateType: row.candidateType,
    status: row.status,
    routePositive: Number(row.routePositive || 0) || 0,
    addressSchemaValid: row.addressSchemaValid,
    excludedFromAddressSchema: Boolean(row.excludedFromAddressSchema),
    codePresent: Boolean(row.codePresent),
    missingProofs: row.routeBlockingProofGaps || [],
    blocker: row.blocker,
  }));
  return fallbackCandidateRows(prefilter);
}

function buildPayload() {
  const scanner = readJson(IN_JSON) || {};
  const prefilter = readJson(PREFILTER_JSON) || {};
  const rpc = cliArg("--rpc") || null;
  const rpcProvided = Boolean(rpc);
  const rpcLocalhostOnly = rpc ? isLocalRpc(rpc) : null;
  const rows = candidateRows(scanner, prefilter);
  const routePositiveRows = rows.filter((row) => Number(row.routePositive || 0) > 0);
  const blockedNonLocalRpc = rpcProvided && !rpcLocalhostOnly;
  const status = blockedNonLocalRpc
    ? "blocked-non-local-rpc"
    : routePositiveRows.length === 0
      ? "no-route-positive-candidate"
      : "route-positive-candidate-requires-localhost-anvil-and-manual-implementation";
  const routePositive = 0;
  const executableNow = 0;
  const signedActionJustified = false;
  const forkJustified = false;
  const txAttempts = 0;
  const valueDeltaPositiveRows = 0;
  return {
    generatedAt: GENERATED_AT,
    deterministicOutput: true,
    scanner: "tools/fork-test-etherfuse-routes.js",
    target: TARGET,
    inputs: {
      scannerArtifact: "reports/raw/fast/etherfuse-full-test.json",
      priorPrefilter: "reports/raw/fast/prefilter-etherfuse-route-prefilter.json",
    },
    safety: {
      scannerArtifactRead: Boolean(scanner.generatedAt),
      priorPrefilterRead: Boolean(prefilter.generatedAt),
      endpointInventoryRead: false,
      rpcInventoryRead: false,
      graphqlInventoryRead: false,
      envFilesRead: false,
      privateKeysRead: false,
      keyMaterialRead: false,
      rawEndpointUrlsStored: false,
      rpcUrlsStored: false,
      graphqlUrlsStored: false,
      rawUrlsStored: false,
      rawDomainsStored: false,
      rawKeysTokensStored: false,
      liveTransactions: false,
      broadcasts: false,
      walletOperations: false,
      signedActions: false,
      exploitExecuteCalls: false,
      localForkTransactions: false,
      forkTransactions: false,
      anvilLocalhostOnly: rpcProvided ? rpcLocalhostOnly : true,
      rpcProvided,
      blockedNonLocalRpc,
    },
    routeGate: {
      status,
      routePositive,
      executableNow,
      signedActionJustified,
      forkJustified,
      forkGate: "closed-route-positive-zero",
      reason: routePositiveRows.length === 0
        ? "No route-positive Etherfuse candidate exists; local fork/value-delta transactions are non-meaningful and intentionally skipped."
        : "Route-positive candidate would still require localhost-only Anvil, permissionless value movement, exact positive economics, and manual harness implementation.",
    },
    summary: {
      status,
      scannerRoutePositive: Number(scanner?.summary?.routePositive || 0) || 0,
      scannerExactEconomicsRows: Number(scanner?.summary?.exactEconomicsRows || 0) || 0,
      scannerCandidateMatrixRows: Number(scanner?.summary?.candidateMatrixRows || rows.length || 0) || 0,
      scannerValidAddressCandidateRows: Number(scanner?.summary?.validAddressCandidateRows || 0) || 0,
      scannerInvalidAddressCandidateRows: Number(scanner?.summary?.invalidAddressCandidateRows || 0) || 0,
      candidateRows: rows.length,
      routePositiveCandidateRows: routePositiveRows.length,
      nonAddressExcludedRows: rows.filter((row) => row.excludedFromAddressSchema).length,
      txAttempts,
      valueDeltaPositiveRows,
      routePositive,
      executableNow,
      signedActionJustified,
      forkJustified,
      localForkTransactions: false,
    },
    candidates: rows,
    actionSelectorWatchlist: ACTION_SELECTOR_WATCHLIST,
    prerequisites: [
      "routePositive candidate exists in scanner artifact",
      "candidate has deployed code and permissionless transfer/redeem/NAV/oracle/role-bypass value movement",
      "exact asset linkage, consumer/exit liquidity, and netLiquidUsd > 0 are proven",
      "Solana/Stellar/Monad dependencies are resolved if route depends on them",
      "localhost-only Anvil RPC if any transaction simulation is used",
      "ephemeral local accounts only; no private-key files; no broadcast",
    ],
    skippedReason: "Scanner routePositive=0; tokenized-bond rows are context only and no permissionless redemption/transfer/NAV/consumer/economics route exists.",
  };
}

function safetyRows(safety) {
  return ["scannerArtifactRead", "priorPrefilterRead", "endpointInventoryRead", "rpcInventoryRead", "graphqlInventoryRead", "envFilesRead", "privateKeysRead", "keyMaterialRead", "rawEndpointUrlsStored", "rpcUrlsStored", "graphqlUrlsStored", "rawUrlsStored", "rawDomainsStored", "rawKeysTokensStored", "liveTransactions", "broadcasts", "walletOperations", "signedActions", "exploitExecuteCalls", "localForkTransactions", "forkTransactions", "anvilLocalhostOnly", "rpcProvided", "blockedNonLocalRpc"].map((key) => `| ${key} | ${mdEscape(safety[key])} |`).join("\n");
}
function candidateTable(rows) {
  if (!rows.length) return "| (none) | n/a | n/a | n/a | n/a | false | no route-positive candidate |";
  return rows.map((row) => `| ${mdEscape(row.role)} | ${mdEscape(row.chain)} | ${mdEscape(row.address ? shortAddress(row.address) : row.rawAddress)} | ${mdEscape(row.candidateType)} | ${mdEscape(row.addressSchemaValid)} | ${mdEscape(row.excludedFromAddressSchema)} | ${mdEscape(row.status)} |`).join("\n");
}
function selectorTable(rows) {
  return rows.map((row) => `| ${mdEscape(row.group)} | ${mdEscape(row.name)} | ${mdEscape(row.signature)} | ${mdEscape(row.selector)} |`).join("\n");
}
function buildMarkdown(payload) {
  return `# 🟢 DORMANT - Etherfuse Fork Route Test

Generated: ${payload.generatedAt}

Status: ${payload.routeGate.status}. routePositive=${payload.routeGate.routePositive}, executableNow=${payload.routeGate.executableNow}, signedActionJustified=${payload.routeGate.signedActionJustified}, forkJustified=${payload.routeGate.forkJustified}.

## Result

No local fork transactions were attempted. txAttempts=${payload.summary.txAttempts}, valueDeltaPositiveRows=${payload.summary.valueDeltaPositiveRows}, routePositiveCandidateRows=${payload.summary.routePositiveCandidateRows}.

## Target / Gate

- Target: ${payload.target.name} (${payload.target.protocolSlug}/${payload.target.slug}).
- Route graph: ${payload.target.routeGraph}.
- Caveats: ${payload.target.caveatChains.join(", ")} are not route-negative closeouts for this EVM harness.
- Harness is inert unless the scanner emits a route-positive candidate with permissionless value movement, exact positive economics, and fork/static value-delta prerequisites.
- Reason: ${payload.routeGate.reason}

## Metrics

| Metric | Value |
|---|---:|
| status | ${mdEscape(payload.summary.status)} |
| scannerRoutePositive | ${payload.summary.scannerRoutePositive} |
| scannerExactEconomicsRows | ${payload.summary.scannerExactEconomicsRows} |
| scannerCandidateMatrixRows | ${payload.summary.scannerCandidateMatrixRows} |
| scannerValidAddressCandidateRows | ${payload.summary.scannerValidAddressCandidateRows} |
| scannerInvalidAddressCandidateRows | ${payload.summary.scannerInvalidAddressCandidateRows} |
| candidateRows | ${payload.summary.candidateRows} |
| routePositiveCandidateRows | ${payload.summary.routePositiveCandidateRows} |
| nonAddressExcludedRows | ${payload.summary.nonAddressExcludedRows} |
| txAttempts | ${payload.summary.txAttempts} |
| valueDeltaPositiveRows | ${payload.summary.valueDeltaPositiveRows} |
| routePositive | ${payload.summary.routePositive} |
| executableNow | ${payload.summary.executableNow} |
| signedActionJustified | ${payload.summary.signedActionJustified} |

## Safety Summary

| Field | Value |
|---|---:|
${safetyRows(payload.safety)}

## Candidate Matrix

| Role | Chain | Address/Raw | Type | Address Valid | Excluded From Schema | Status |
|---|---|---|---|---:|---:|---|
${candidateTable(payload.candidates)}

## Action / Proof Selector Watchlist

| Group | Name | Signature | Selector/Event |
|---|---|---|---|
${selectorTable(payload.actionSelectorWatchlist)}

## Blockers / Next Step

- ${payload.skippedReason}
- Re-run only after the full-test scanner has routePositive > 0 and exact positive economics.
- If RPC is supplied in future, it must be localhost-only Anvil and still use no endpoint inventories, private-key files, broadcasts, or wallet operations.
`;
}

function main() {
  const payload = buildPayload();
  ensureDir(OUT_JSON);
  fs.writeFileSync(OUT_JSON, `${JSON.stringify(payload, jsonReplacer, 2)}\n`, "utf8");
  ensureDir(OUT_MD);
  fs.writeFileSync(OUT_MD, buildMarkdown(payload), "utf8");
  log(`Wrote ${OUT_JSON_REL} and ${OUT_MD_REL}`);
  log(`status=${payload.summary.status}; txAttempts=${payload.summary.txAttempts}; valueDeltaPositiveRows=${payload.summary.valueDeltaPositiveRows}; routePositive=${payload.summary.routePositive}`);
}

main();
