#!/usr/bin/env node
"use strict";

// fork-test-summer-fi-pro-routes.js
// Local-only Summer.fi Pro route/value-delta harness. Fail-closed unless the
// full-test scanner emits a route-positive candidate. No endpoint inventories,
// private-key files, live transactions, broadcasts, or wallet ops.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const IN_JSON = path.join(WORKSPACE, "reports", "raw", "fast", "summer-fi-pro-full-test.json");
const PREFILTER_JSON = path.join(WORKSPACE, "reports", "raw", "fast", "prefilter-summer-fi-pro-route-prefilter.json");
const OUT_JSON = path.join(WORKSPACE, "reports", "raw", "fast", "summer-fi-pro-fork-route-test.json");
const OUT_MD = path.join(WORKSPACE, "reports", "summer-fi-pro-fork-route-test.md");
const OUT_JSON_REL = "reports/raw/fast/summer-fi-pro-fork-route-test.json";
const OUT_MD_REL = "reports/summer-fi-pro-fork-route-test.md";
const QUIET = process.argv.includes("--quiet");
const GENERATED_AT = process.env.SCAN_GENERATED_AT || "2026-07-07T00:00:00.000Z";

const TARGET = {
  slug: "summer-fi-pro",
  protocolSlug: "summer-fi",
  name: "Summer.fi Pro / Oasis",
  surface: "automation-cdp-manager-oracle-liquidation",
  routeGraph: "automation/CDP manager -> MakerDAO/Aave/Spark/Morpho managed position -> oracle/liquidation/borrow/unwind",
};

const ACTION_SELECTOR_WATCHLIST = [
  { group: "trigger-state", name: "activeTriggers", signature: "activeTriggers", selector: "watch-function" },
  { group: "record", name: "addRecord", signature: "addRecord", selector: "watch-function" },
  { group: "record", name: "removeRecord", signature: "removeRecord", selector: "watch-function" },
  { group: "trigger", name: "addTriggers", signature: "addTriggers", selector: "watch-function" },
  { group: "trigger", name: "removeTriggers", signature: "removeTriggers", selector: "watch-function" },
  { group: "bot", name: "automationBot", signature: "automationBot", selector: "watch-function" },
  { group: "lock", name: "clearLock", signature: "clearLock", selector: "watch-function" },
  { group: "execute", name: "execute", signature: "execute(bytes,bytes,address,uint256,uint256,address)", selector: "watch-function" },
  { group: "registry", name: "getAdapterAddress", signature: "getAdapterAddress", selector: "watch-function" },
  { group: "registry", name: "getCommandAddress", signature: "getCommandAddress", selector: "watch-function" },
  { group: "registry", name: "getValidatorAddress", signature: "getValidatorAddress", selector: "watch-function" },
  { group: "trigger-record", name: "getTriggerRecord", signature: "getTriggerRecord", selector: "watch-function" },
  { group: "registry", name: "serviceRegistry", signature: "serviceRegistry", selector: "watch-function" },
  { group: "trigger-state", name: "triggersCounter", signature: "triggersCounter", selector: "watch-function" },
  { group: "ownership", name: "owner", signature: "owner", selector: "watch-function" },
  { group: "pause", name: "paused", signature: "paused", selector: "watch-function" },
  { group: "command", name: "approvedCommands", signature: "approvedCommands", selector: "watch-function" },
  { group: "sunset", name: "isAutomationDeleted", signature: "isAutomationDeleted", selector: "watch-function" },
  { group: "gas", name: "MAX_GAS_PRICE", signature: "MAX_GAS_PRICE", selector: "watch-function" },
  { group: "event", name: "TriggerAdded", signature: "TriggerAdded", selector: "event" },
  { group: "event", name: "TriggerExecuted", signature: "TriggerExecuted", selector: "event" },
  { group: "event", name: "TriggerRemoved", signature: "TriggerRemoved", selector: "event" },
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
function normalizeAddress(value) {
  const raw = String(value || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) return null;
  return `0x${raw.slice(2).toLowerCase()}`;
}
function addressStatusFor(value) {
  if (normalizeAddress(value)) return "valid-evm-address";
  if (value === null || value === undefined || String(value).trim() === "") return "unresolved-non-address";
  return "invalid-non-address-from-prefilter";
}
function shortAddress(value) { const text = String(value || ""); return /^0x[0-9a-fA-F]{40}$/.test(text) ? `${text.slice(0, 6)}...${text.slice(-4)}` : text; }

function fallbackCandidateRows(prefilter) {
  const rows = [];
  for (const chain of Array.isArray(prefilter?.chainResults) ? prefilter.chainResults : []) {
    for (const [role, row] of Object.entries(chain.contracts || {})) {
      const normalizedAddress = normalizeAddress(row.address);
      const addressStatus = addressStatusFor(row.address);
      rows.push({
        role,
        chain: chain.chain,
        chainId: chain.chainId,
        address: normalizedAddress,
        normalizedAddress,
        addressStatus,
        addressHint: normalizedAddress ? null : "unresolved-non-address-from-prior-prefilter",
        candidateAddressValidation: normalizedAddress ? "included-valid-evm-address" : "excluded-unresolved-or-malformed-prefilter-address",
        protocolLayer: /dataprovider/i.test(role) ? "data-provider" : /morpho/i.test(role) ? "underlying-protocol" : /monitor/i.test(role) ? "monitor" : "automation",
        status: row.codePresent === false ? "prefilter-raw-no-code" : "prefilter-context-only",
        routePositive: 0,
        codePresent: row.codePresent === true,
        activeTriggerEstimate: Number(row.triggerEvents?.activeTriggerEstimate || 0) || 0,
        blocker: "No route-positive full-test scanner candidate.",
      });
    }
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
    normalizedAddress: row.normalizedAddress || normalizeAddress(row.address),
    addressStatus: row.addressStatus || addressStatusFor(row.address),
    addressHint: row.addressHint || null,
    candidateAddressValidation: row.candidateAddressValidation || (normalizeAddress(row.address) ? "included-valid-evm-address" : "excluded-unresolved-non-address"),
    protocolLayer: row.protocolLayer,
    status: row.status,
    routePositive: Number(row.routePositive || 0) || 0,
    codePresent: row.codePresentKnown === true,
    activeTriggerEstimate: Number(row.activeTriggerEstimate || 0) || 0,
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
    scanner: "tools/fork-test-summer-fi-pro-routes.js",
    target: TARGET,
    inputs: {
      scannerArtifact: "reports/raw/fast/summer-fi-pro-full-test.json",
      priorPrefilter: "reports/raw/fast/prefilter-summer-fi-pro-route-prefilter.json",
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
        ? "No route-positive Summer.fi Pro candidate exists; local fork/value-delta transactions are non-meaningful and intentionally skipped."
        : "Route-positive candidate would still require localhost-only Anvil, decoded trigger/position, permissionless action, exact positive economics, and manual harness implementation.",
    },
    summary: {
      status,
      scannerRoutePositive: Number(scanner?.summary?.routePositive || 0) || 0,
      scannerExactEconomicsRows: Number(scanner?.summary?.exactEconomicsRows || 0) || 0,
      scannerCandidateMatrixRows: Number(scanner?.summary?.candidateMatrixRows || rows.length || 0) || 0,
      candidateRows: rows.length,
      routePositiveCandidateRows: routePositiveRows.length,
      codePresentContextRows: rows.filter((row) => row.codePresent).length,
      estimatedActiveTriggerRows: rows.filter((row) => Number(row.activeTriggerEstimate || 0) > 0).length,
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
      "candidate has deployed code and permissionless value-moving trigger/execute path",
      "decoded active trigger maps to exact owner, position, collateral, debt, health, adapter, command, and validator",
      "ownership/proxy/paused/approvedCommands/serviceRegistry/OperationsRegistry constraints are proven bypassed or irrelevant",
      "current underlying MakerDAO/Aave/Spark/Morpho liquidation/borrow/unwind economics have netLiquidUsd > 0",
      "localhost-only Anvil RPC if any transaction simulation is used",
      "ephemeral local accounts only; no private-key files; no broadcast",
    ],
    skippedReason: "Scanner routePositive=0; active trigger estimates and code-present automation/data-provider rows are context only and do not justify fork transactions.",
  };
}

function safetyRows(safety) {
  return ["scannerArtifactRead", "priorPrefilterRead", "endpointInventoryRead", "rpcInventoryRead", "graphqlInventoryRead", "envFilesRead", "privateKeysRead", "keyMaterialRead", "rawEndpointUrlsStored", "rpcUrlsStored", "graphqlUrlsStored", "rawUrlsStored", "rawDomainsStored", "rawKeysTokensStored", "liveTransactions", "broadcasts", "walletOperations", "signedActions", "localForkTransactions", "anvilLocalhostOnly", "rpcProvided", "blockedNonLocalRpc"].map((key) => `| ${key} | ${mdEscape(safety[key])} |`).join("\n");
}
function candidateTable(rows) {
  if (!rows.length) return "| (none) | n/a | n/a | n/a | false | 0 | no route-positive candidate |";
  return rows.map((row) => `| ${mdEscape(row.role)} | ${mdEscape(row.chain)} | ${mdEscape(normalizeAddress(row.address) ? shortAddress(row.address) : (row.addressHint || row.addressStatus || "unresolved-non-address"))} | ${mdEscape(row.protocolLayer)} | ${mdEscape(row.codePresent)} | ${mdEscape(row.activeTriggerEstimate || 0)} | ${mdEscape(row.status)} |`).join("\n");
}
function selectorTable(rows) {
  return rows.map((row) => `| ${mdEscape(row.group)} | ${mdEscape(row.name)} | ${mdEscape(row.signature)} | ${mdEscape(row.selector)} |`).join("\n");
}
function buildMarkdown(payload) {
  return `# 🟢 DORMANT - Summer.fi Pro Local Fork Route Harness

Generated: ${payload.generatedAt}

Status: ${payload.routeGate.status}. routePositive=${payload.routeGate.routePositive}, executableNow=${payload.routeGate.executableNow}, signedActionJustified=${payload.routeGate.signedActionJustified}, forkJustified=${payload.routeGate.forkJustified}.

## Result

No local fork transactions were attempted. txAttempts=${payload.summary.txAttempts}, valueDeltaPositiveRows=${payload.summary.valueDeltaPositiveRows}, routePositiveCandidateRows=${payload.summary.routePositiveCandidateRows}.

## Target / Gate

- Target: ${payload.target.name} (${payload.target.protocolSlug}/${payload.target.slug}).
- Route graph: ${payload.target.routeGraph}.
- Harness is inert unless the scanner emits a route-positive candidate with decoded trigger/position, permissionless value-moving path, exact positive economics, and fork/static value-delta prerequisites.
- Reason: ${payload.routeGate.reason}

## Metrics

| Metric | Value |
|---|---:|
| status | ${mdEscape(payload.summary.status)} |
| scannerRoutePositive | ${payload.summary.scannerRoutePositive} |
| scannerExactEconomicsRows | ${payload.summary.scannerExactEconomicsRows} |
| scannerCandidateMatrixRows | ${payload.summary.scannerCandidateMatrixRows} |
| candidateRows | ${payload.summary.candidateRows} |
| routePositiveCandidateRows | ${payload.summary.routePositiveCandidateRows} |
| codePresentContextRows | ${payload.summary.codePresentContextRows} |
| estimatedActiveTriggerRows | ${payload.summary.estimatedActiveTriggerRows} |
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

| Role | Chain | Address | Layer | Code Present | Active Trigger Estimate | Status |
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
