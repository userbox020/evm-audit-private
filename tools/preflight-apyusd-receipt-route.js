#!/usr/bin/env node
// Preflight summary for the apyUSD receipt-claim route.
// Consumes sanitized artifacts only; does not read RPC inventory, env files, or private keys.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const ROUTE_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "apyusd-erc4626-redeem-route.json");
const PROOF_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "apyusd-erc4626-fork-proof.json");
const OUT_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "apyusd-receipt-live-preflight.json");
const REPORT_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "apyusd-receipt-live-preflight.md");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function round(value, decimals = 6) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function ageMinutes(generatedAt) {
  const t = Date.parse(generatedAt || "");
  if (!Number.isFinite(t)) return null;
  return round((Date.now() - t) / 60000, 2);
}

function bestScenario(proof) {
  const scenarios = proof?.result?.claimScenarios || [];
  return scenarios
    .filter((x) => x.claimSuccess)
    .sort((a, b) => (Number(b.netProfitUsd) || -Infinity) - (Number(a.netProfitUsd) || -Infinity))[0] || null;
}

function render(out) {
  const checks = out.preflightChecks;
  return [
    "# 🔴 CONFIRMED — apyUSD Receipt Live Preflight",
    "",
    `Date: ${new Date().toISOString().slice(0, 10)}`,
    "",
    "## Result",
    "",
    `**${out.summary.status}.** ${out.summary.nextAction}`,
    "",
    "No live transaction, private key use, deployment, executor change, or exploit `execute()` call was made.",
    "",
    "## Checks",
    "",
    "| Check | Status |",
    "|---|---|",
    `| Route artifact fresh | ${checks.routeArtifactFresh ? "pass" : "fail"} |`,
    `| Fork proof fresh | ${checks.forkProofFresh ? "pass" : "fail"} |`,
    `| Receipt unpaused | ${checks.receiptUnpaused ? "pass" : "fail"} |`,
    `| Receipt fee curve unchanged | ${checks.receiptFeeCurveExpected ? "pass" : "fail"} |`,
    `| Route positive | ${checks.routePositive ? "pass" : "fail"} |`,
    `| Fork positive | ${checks.forkPositive ? "pass" : "fail"} |`,
    `| Explicit authorization | ${checks.explicitAuthorization ? "pass" : "blocked"} |`,
    `| Signed action justified | ${checks.signedActionJustified ? "open" : "closed"} |`,
    "",
    "## Current Economics",
    "",
    "| Metric | Value |",
    "|---|---:|",
    `| Best modeled net | $${out.economics.bestModeledNetUsd} |`,
    `| Best fork net | $${out.economics.bestForkNetUsd} |`,
    `| Best claim delay | ${out.economics.bestClaimDelayDays}d |`,
    `| Route-positive rows | ${out.economics.routePositiveRows} |`,
    `| Direct asset cash USD | $${out.economics.directAssetCashUsd} |`,
    "",
    "## Required Before Live Action",
    "",
    "- Explicit user authorization.",
    "- Live sender address and capital amount.",
    "- Fresh min-out quote immediately before swapping.",
    "- Sender-specific static call and gas estimate for `redeemForReceipt`.",
    "- Acceptance of delayed claim risk and fee/governance/pause risk.",
    "",
    "## Artifacts",
    "",
    "- JSON: `reports/raw/fast/apyusd-receipt-live-preflight.json`",
    "- Route: `reports/raw/fast/apyusd-erc4626-redeem-route.json`",
    "- Fork proof: `reports/raw/fast/apyusd-erc4626-fork-proof.json`",
    "",
  ].join("\n");
}

function main() {
  const route = readJson(ROUTE_FILE);
  const proof = readJson(PROOF_FILE);
  const routeAge = ageMinutes(route.generatedAt);
  const proofAge = ageMinutes(proof.generatedAt);
  const best = bestScenario(proof);
  const expectedCurve = route.candidate?.receiptFeeCurve || {};
  const routePositiveRows = Number(route.summary?.routePositive || 0);
  const forkPositive = proof.result?.success === true && proof.result?.forkProfitPositive === true && Number(proof.result?.netProfitUsd || 0) > 0;
  const preflightChecks = {
    routeArtifactFresh: routeAge !== null && routeAge <= 30,
    forkProofFresh: proofAge !== null && proofAge <= 30,
    receiptUnpaused: route.candidate?.receiptPaused === false,
    receiptFeeCurveExpected: expectedCurve.minFee === "0"
      && expectedCurve.maxFee === "34000000000000000"
      && expectedCurve.minDuration === "259200"
      && expectedCurve.maxDuration === "1728000"
      && expectedCurve.curvature === "1000000000000000000",
    routePositive: routePositiveRows > 0,
    forkPositive,
    explicitAuthorization: false,
    signedActionJustified: false,
  };
  const passedReadOnly = Object.entries(preflightChecks)
    .filter(([key]) => !["explicitAuthorization", "signedActionJustified"].includes(key))
    .every(([, value]) => value === true);
  const out = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/preflight-apyusd-receipt-route.js",
    scope: "Read-only apyUSD receipt route preflight package",
    safety: {
      rpcInventoryRead: false,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      liveSignedActions: false,
      localForkTransactions: false,
      exploitExecuteCalls: false,
      signedActionJustified: false,
    },
    sourceArtifacts: {
      route: "reports/raw/fast/apyusd-erc4626-redeem-route.json",
      forkProof: "reports/raw/fast/apyusd-erc4626-fork-proof.json",
    },
    freshness: {
      routeGeneratedAt: route.generatedAt,
      routeAgeMinutes: routeAge,
      forkProofGeneratedAt: proof.generatedAt,
      forkProofAgeMinutes: proofAge,
    },
    candidate: {
      share: route.candidate?.share || null,
      asset: route.candidate?.asset || null,
      receipt: route.candidate?.receipt || null,
      curvePool: route.pools?.[0]?.pool || null,
      receiptPaused: route.candidate?.receiptPaused ?? null,
      receiptFeeCurve: route.candidate?.receiptFeeCurve || null,
      unlockingFee: route.candidate?.unlockingFee || null,
    },
    economics: {
      routePositiveRows,
      bestModeledNetUsd: round(route.summary?.bestNetUsd, 6),
      bestForkNetUsd: round(proof.result?.netProfitUsd, 6),
      bestClaimDelayDays: proof.result?.bestClaimDelayDays ?? best?.delayDays ?? null,
      directAssetCashUsd: round(route.candidate?.directAssetCashUsd, 2),
      claimScenarios: proof.result?.claimScenarios || [],
    },
    preflightChecks,
    summary: {
      readOnlyPreflightPassed: passedReadOnly,
      status: passedReadOnly ? "read-only-preflight-pass-authorization-required" : "read-only-preflight-failed",
      routePositive: passedReadOnly ? 1 : 0,
      executableNow: 0,
      signedActionJustified: false,
      nextAction: passedReadOnly
        ? "Stop before live action: require explicit authorization, sender-specific staticCall/estimateGas, and minOut/minProfit gates."
        : "Do not proceed; refresh route/proof/config until preflight passes.",
    },
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  fs.writeFileSync(REPORT_FILE, render(out));
  console.log(`apyUSD preflight: status=${out.summary.status} routePositive=${out.summary.routePositive} signedActionJustified=${out.summary.signedActionJustified}`);
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT_FILE)}`);
}

main();
