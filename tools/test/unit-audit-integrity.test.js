"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  buildIntegrityCheckpoint,
  buildOperationalOutputSummary,
  buildStageOutputView,
  deriveAssetRouteMetrics,
  deriveSupplySanity,
  deriveUnitRouteSummary,
  implementationCoverage,
  loadArtifact,
  resolveCanonicalAsset,
  validateObservedProxyCoverage,
} = require("../lib/unit-audit-integrity");

const NOW = new Date("2026-07-09T12:00:00.000Z");

function temporaryWorkspace(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "unit-audit-integrity-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function spec() {
  return { path: "economics.json", required: true, evidenceClass: "marketEconomics", requiredPaths: ["generatedAt", "rows"], requiredTypes: { rows: "array" } };
}

function routeArtifact(generatedAt, rows) {
  return { generatedAt, rows };
}

function exactUnitRow(symbol, index, address, netUsd, routePositive = false) {
  return {
    symbol,
    token: { index, name: symbol, evmContract: address },
    dex: { exactDexQuote: true },
    routes: [{
      direction: "core-buy-evm-sell",
      sizeUsd: 100,
      netUsd,
      routePositive,
      core: { complete: true, quoteSpent: 100, baseBought: 2, costWithFeeUsd: 100.1 },
      dex: { exactDexQuote: true, usdOut: 110, counterparty: { usdLike: true } },
    }],
  };
}

test("missing required artifact is incomplete and route evidence is unknown", (t) => {
  const workspace = temporaryWorkspace(t);
  const loaded = loadArtifact(workspace, spec(), NOW);
  const route = deriveUnitRouteSummary(null, loaded.info);
  const checkpoint = buildIntegrityCheckpoint({ manifest: [loaded.info], routeSummary: route, mandatoryDomains: { economics: route.routeEvidenceStatus } });
  assert.equal(loaded.info.loadStatus, "missing");
  assert.equal(checkpoint.evidenceComplete, false);
  assert.equal(checkpoint.routeEvidenceStatus, "unknown");
});

test("malformed and schema-incompatible artifacts are incomplete and unknown", (t) => {
  const workspace = temporaryWorkspace(t);
  fs.writeFileSync(path.join(workspace, "economics.json"), "{broken", "utf8");
  const malformed = loadArtifact(workspace, spec(), NOW);
  assert.equal(malformed.info.parseStatus, "malformed");
  assert.equal(deriveUnitRouteSummary(null, malformed.info).routeEvidenceStatus, "unknown");
  fs.writeFileSync(path.join(workspace, "economics.json"), JSON.stringify({ generatedAt: NOW.toISOString() }), "utf8");
  const incompatible = loadArtifact(workspace, spec(), NOW);
  assert.equal(incompatible.info.schemaStatus, "incompatible");
  assert.equal(deriveUnitRouteSummary(incompatible.json, incompatible.info).routeEvidenceStatus, "unknown");
  fs.writeFileSync(path.join(workspace, "economics.json"), JSON.stringify({ generatedAt: NOW.toISOString(), rows: null }), "utf8");
  const nullRows = loadArtifact(workspace, spec(), NOW);
  assert.equal(nullRows.info.schemaStatus, "incompatible");
});

test("stale exact economics cannot promote operational status", (t) => {
  const workspace = temporaryWorkspace(t);
  fs.writeFileSync(path.join(workspace, "economics.json"), JSON.stringify(routeArtifact("2026-07-01T00:00:00.000Z", [exactUnitRow("USOL", 254, "0x068f321fa8fb9f0d135f290ef6a3e2813e1c8a29", 10, true)])));
  const loaded = loadArtifact(workspace, spec(), NOW);
  const route = deriveUnitRouteSummary(loaded.json, loaded.info);
  assert.equal(loaded.info.freshnessStatus, "stale");
  assert.equal(route.routePositiveOperational, 0);
  assert.equal(route.routeEvidenceStatus, "unknown");
});

test("fresh exact positive Unit row propagates and is not overwritten", (t) => {
  const workspace = temporaryWorkspace(t);
  fs.writeFileSync(path.join(workspace, "economics.json"), JSON.stringify(routeArtifact("2026-07-09T10:00:00.000Z", [exactUnitRow("USOL", 254, "0x068f321fa8fb9f0d135f290ef6a3e2813e1c8a29", 10, true)])));
  const loaded = loadArtifact(workspace, spec(), NOW);
  const route = deriveUnitRouteSummary(loaded.json, loaded.info);
  assert.equal(route.routePositiveOperational, 1);
  assert.equal(route.routeEvidenceStatus, "positive");
});

test("global non-Unit best cannot contaminate canonical Unit summary", (t) => {
  const workspace = temporaryWorkspace(t);
  const rows = [
    exactUnitRow("NOTUNIT", 9999, "0x1111111111111111111111111111111111111111", 999, true),
    exactUnitRow("USOL", 254, "0x068f321fa8fb9f0d135f290ef6a3e2813e1c8a29", -0.8251, false),
  ];
  fs.writeFileSync(path.join(workspace, "economics.json"), JSON.stringify(routeArtifact("2026-07-09T10:00:00.000Z", rows)));
  const loaded = loadArtifact(workspace, spec(), NOW);
  const route = deriveUnitRouteSummary(loaded.json, loaded.info);
  assert.equal(route.bestExactUnitRoute.symbol, "USOL");
  assert.equal(route.bestExactUnitRoute.netUsd, -0.8251);
  assert.equal(route.routeEvidenceStatus, "negative");
});

test("estimated UPUMP-like row is kept separate and cannot count as exact", (t) => {
  const workspace = temporaryWorkspace(t);
  const row = exactUnitRow("UPUMP", 299, "0x27ec642013bcb3d80ca3706599d3cda04f6f4452", 20, true);
  row.dex.exactDexQuote = false;
  row.routes[0].dex.exactDexQuote = false;
  fs.writeFileSync(path.join(workspace, "economics.json"), JSON.stringify(routeArtifact("2026-07-09T10:00:00.000Z", [row])));
  const loaded = loadArtifact(workspace, spec(), NOW);
  const route = deriveUnitRouteSummary(loaded.json, loaded.info);
  assert.equal(route.exactRouteCount, 0);
  assert.equal(route.bestEstimatedUnitRoute.symbol, "UPUMP");
  assert.equal(route.routePositiveOperational, 0);
  assert.equal(route.routeEvidenceStatus, "unknown");
});

test("canonical identity conflict and symbol-only ambiguity are flagged", () => {
  const conflict = resolveCanonicalAsset({ symbol: "USOL", tokenIndex: 254, tokenId: "0xe1edd30daaf5caac3fe63569e24748da" });
  const symbolOnly = resolveCanonicalAsset({ symbol: "USOL" });
  assert.equal(conflict.status, "canonical-identity-conflict");
  assert.equal(symbolOnly.status, "symbol-only-identity-rejected");
});

test("every supplied strong identifier must uniquely match the selected canonical row", () => {
  assert.equal(resolveCanonicalAsset({ symbol: "USOL", tokenIndex: 254, hyperevmContract: "0x1111111111111111111111111111111111111111" }).status, "unknown-strong-identifier");
  assert.equal(resolveCanonicalAsset({ symbol: "USOL", tokenId: "0x49b67c39f5566535de22b29b0e51e685", hyperevmContract: "0xbe6727b535545c67d5caa73dea54865b92cf7907" }).status, "canonical-identity-conflict");
  const duplicateRegistry = [
    { key: "a", symbol: "A", aliases: ["A"], tokenIndex: 1, tokenId: "a", proxyAddress: "0x1" },
    { key: "b", symbol: "B", aliases: ["B"], tokenIndex: 1, tokenId: "b", proxyAddress: "0x2" },
  ];
  assert.equal(resolveCanonicalAsset({ tokenIndex: 1 }, duplicateRegistry).status, "ambiguous-strong-identifier");
});

test("exact promotion rejects incomplete Core and USD settlement shapes", (t) => {
  const workspace = temporaryWorkspace(t);
  const base = exactUnitRow("USOL", 254, "0x068f321fa8fb9f0d135f290ef6a3e2813e1c8a29", 10, true);
  const cases = [
    (row) => { delete row.routes[0].dex.counterparty; },
    (row) => { delete row.routes[0].core; },
    (row) => { row.routes[0].core.complete = false; },
    (row) => { row.routes[0].sizeUsd = 0; },
    (row) => { row.routes[0].core.quoteSpent = Number.NaN; },
    (row) => { row.routes[0].dex.counterparty = { usdLike: false }; row.routes[0].dex.finalCounterparty = { usdLike: true }; row.routes[0].dex.multiHopExact = false; },
    (row) => { row.routes[0].dex.counterparty = { usdLike: false }; row.routes[0].dex.finalCounterparty = { usdLike: false }; row.routes[0].dex.multiHopExact = true; row.routes[0].dex.unwind = { amountOut: 110 }; },
  ];
  for (const mutate of cases) {
    const row = structuredClone(base);
    mutate(row);
    fs.writeFileSync(path.join(workspace, "economics.json"), JSON.stringify(routeArtifact("2026-07-09T10:00:00.000Z", [row])));
    const loaded = loadArtifact(workspace, spec(), NOW);
    const route = deriveUnitRouteSummary(loaded.json, loaded.info);
    assert.equal(route.routePositiveOperational, 0);
    assert.notEqual(route.routeEvidenceStatus, "positive");
  }
});

test("positive net without source route-positive flag cannot promote", (t) => {
  const workspace = temporaryWorkspace(t);
  for (const missing of [false, true]) {
    const row = exactUnitRow("USOL", 254, "0x068f321fa8fb9f0d135f290ef6a3e2813e1c8a29", 10, false);
    if (missing) delete row.routes[0].routePositive;
    fs.writeFileSync(path.join(workspace, "economics.json"), JSON.stringify(routeArtifact("2026-07-09T10:00:00.000Z", [row])));
    const loaded = loadArtifact(workspace, spec(), NOW);
    const route = deriveUnitRouteSummary(loaded.json, loaded.info);
    assert.equal(route.routePositiveOperational, 0);
    assert.equal(route.routeEvidenceStatus, missing ? "unknown" : "negative");
  }
});

test("Unit-associated rejected identity keeps evidence unknown beside valid negative row", (t) => {
  const workspace = temporaryWorkspace(t);
  const conflicted = exactUnitRow("NOTUNIT", 254, "0x1111111111111111111111111111111111111111", -2, false);
  delete conflicted.symbol;
  conflicted.token.name = "NOTUNIT";
  const valid = exactUnitRow("USOL", 254, "0x068f321fa8fb9f0d135f290ef6a3e2813e1c8a29", -1, false);
  fs.writeFileSync(path.join(workspace, "economics.json"), JSON.stringify(routeArtifact("2026-07-09T10:00:00.000Z", [conflicted, valid])));
  const loaded = loadArtifact(workspace, spec(), NOW);
  const summary = deriveUnitRouteSummary(loaded.json, loaded.info);
  assert.equal(summary.bestExactUnitRoute.netUsd, -1);
  assert.equal(summary.identityFlags.length, 1);
  assert.equal(summary.routeEvidenceStatus, "unknown");
});

test("malformed positive-looking Unit route keeps evidence unknown beside valid negative row", (t) => {
  const workspace = temporaryWorkspace(t);
  const malformed = exactUnitRow("USOL", 254, "0x068f321fa8fb9f0d135f290ef6a3e2813e1c8a29", 50, true);
  malformed.routes[0].sizeUsd = "100";
  const valid = exactUnitRow("USOL", 254, "0x068f321fa8fb9f0d135f290ef6a3e2813e1c8a29", -1, false);
  fs.writeFileSync(path.join(workspace, "economics.json"), JSON.stringify(routeArtifact("2026-07-09T10:00:00.000Z", [malformed, valid])));
  const loaded = loadArtifact(workspace, spec(), NOW);
  const summary = deriveUnitRouteSummary(loaded.json, loaded.info);
  assert.equal(summary.bestExactUnitRoute.netUsd, -1);
  assert.equal(summary.structuralFlags.length, 1);
  assert.equal(summary.routePositiveOperational, 0);
  assert.equal(summary.routeEvidenceStatus, "unknown");
});

test("dynamic freshness accepts boundary and rejects future timestamps", (t) => {
  const workspace = temporaryWorkspace(t);
  const dynamicSpec = { ...spec(), evidenceClass: "dynamicSnapshot" };
  fs.writeFileSync(path.join(workspace, "economics.json"), JSON.stringify(routeArtifact("2026-07-08T12:00:00.000Z", [])));
  assert.equal(loadArtifact(workspace, dynamicSpec, NOW).info.freshnessStatus, "fresh");
  fs.writeFileSync(path.join(workspace, "economics.json"), JSON.stringify(routeArtifact("2026-07-09T12:06:00.000Z", [])));
  const future = loadArtifact(workspace, dynamicSpec, NOW);
  assert.equal(future.info.freshnessStatus, "future");
  assert.equal(future.info.evidenceUsable, false);
});

test("mixed exact and estimated routes remain separated per asset", () => {
  const row = exactUnitRow("USOL", 254, "0x068f321fa8fb9f0d135f290ef6a3e2813e1c8a29", -1, false);
  const estimated = structuredClone(row.routes[0]);
  estimated.netUsd = 5;
  estimated.dex.exactDexQuote = false;
  row.routes.push(estimated);
  const metrics = deriveAssetRouteMetrics(row);
  assert.equal(metrics.bestExactNetUsd, -1);
  assert.equal(metrics.bestEstimatedNetUsd, 5);
});

test("scanner output summary stays internally positive for a qualifying fixture", () => {
  const routeSummary = { routeEvidenceStatus: "positive", routePositiveOperational: 1, qualifyingPositiveRoutes: [{ symbol: "USOL", netUsd: 10 }] };
  const output = buildOperationalOutputSummary(routeSummary, ["Existing exact routes are net-negative", "Reserve evidence remains unknown"]);
  assert.equal(output.routePositiveCandidates.length, 1);
  assert.match(output.narrative, /positive candidate/);
  assert.equal(output.blockers.some((value) => /net-negative/.test(value)), false);
  assert.equal(output.blockers.includes("Reserve evidence remains unknown"), true);
});

test("all five stage render modes remain consistent for positive route state", () => {
  const routeSummary = { routeEvidenceStatus: "positive", routePositiveOperational: 1, qualifyingPositiveRoutes: [{ symbol: "USOL", netUsd: 10 }] };
  const checkpoint = { auditClassification: "POSITIVE/REVIEW", routeEvidenceStatus: "positive", routePositiveOperational: 1 };
  for (const stage of ["step-1", "step-2", "step-3", "step-4", "step-5"]) {
    const view = buildStageOutputView(stage, routeSummary, checkpoint, [{ symbol: "USOL", routePositive: 0 }], ["Existing routes are net-negative"]);
    assert.match(view.signal, /POSITIVE\/REVIEW/);
    assert.doesNotMatch(view.signal, /DORMANT/);
    assert.equal(view.routeTableRows[0].routePositive, 1);
    assert.doesNotMatch(view.reportText, /net-negative/);
    assert.match(view.reportText, /positive candidate/);
  }
});

test("six to three to two implementation coverage remains incomplete", () => {
  const three = implementationCoverage(["UBTC", "UETH", "USOL"]);
  const two = implementationCoverage(["UETH", "USOL"]);
  assert.equal(three.observedProxyCount, 6);
  assert.equal(three.complete, false);
  assert.equal(two.complete, false);
  assert.equal(two.missingProxySymbols.length, 4);
});

test("supply sanity compares raw integer units with BigInt", () => {
  const result = deriveSupplySanity({ evm: { totalSupplyRaw: "900719925474099300000", systemBalanceRaw: "900719925474099299999" } });
  assert.equal(result.arithmetic, "BigInt");
  assert.equal(result.systemBalanceExceedsSupply, false);
  assert.equal(result.probativeForNativeBacking, false);
});

test("invalid BigInt evidence remains unknown instead of throwing", () => {
  const missing = deriveSupplySanity({ evm: { totalSupplyRaw: "not-an-integer", systemBalanceRaw: "5" } });
  assert.equal(missing.systemBalanceExceedsSupply, null);
  assert.match(missing.status, /^unknown/);
});

test("canonical six-proxy coverage mismatch remains incomplete", () => {
  const coverage = validateObservedProxyCoverage({ rows: [{ token: { index: 254, name: "USOL", evmContract: "0x068f321fa8fb9f0d135f290ef6a3e2813e1c8a29" } }] });
  assert.equal(coverage.complete, false);
  assert.equal(coverage.status, "incomplete-canonical-coverage");
});

test("CLEAN cannot be emitted while any mandatory domain is unknown", () => {
  const checkpoint = buildIntegrityCheckpoint({
    manifest: [],
    routeSummary: { routeEvidenceStatus: "negative", routePositiveOperational: 0 },
    mandatoryDomains: { economics: "negative", reserveBacking: "unknown" },
  });
  assert.equal(checkpoint.evidenceComplete, false);
  assert.equal(checkpoint.closureEligible, false);
  assert.equal(checkpoint.auditClassification, "INCOMPLETE/WATCH");
  assert.notEqual(checkpoint.auditClassification, "CLEAN");
});
