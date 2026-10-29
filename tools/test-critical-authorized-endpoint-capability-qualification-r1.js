#!/usr/bin/env node
"use strict";

// Offline validator. The four currently authorized inventories are read only to
// recompute commitments and deterministic leak checks; no endpoint is called.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const NAME = "critical-authorized-endpoint-capability-qualification-r1";
const SCANNER = `tools/scan-${NAME}.js`;
const VALIDATOR = `tools/test-${NAME}.js`;
const RAW = `reports/raw/fast/${NAME}.json`;
const LEAK = `reports/raw/fast/${NAME}-leak-scan.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const REPORT = `reports/${NAME}.md`;
const INBOX = `coordination/inbox/critical/2026-07-24-${NAME}.json`;
const HANDOFF = `coordination/handoffs/2026-07-24-${NAME}-handoff.md`;
const INVENTORIES = ["graphql_endpoints.txt", "base_full_stack_endpoints.md", "hyperevm_archive_endpoints.md", "rpc_endpoints.txt"];
const MATRIX = "reports/raw/fast/critical-etherfi-hyperevm-header-consensus-r13-r2-corrected-historical-matrix.json";
const EXPECTED_CLASSIFICATION = "INFORMATIONAL/READ-ONLY-ENDPOINT-CAPABILITY-QUALIFICATION/SANITIZED/FAIL-CLOSED/NO-EXECUTION";
const abs = (rel) => path.join(ROOT, rel);
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const canonical = (value) => typeof value === "bigint" ? value.toString() : Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
let checks = 0;
function check(value, message) { if (!value) throw new Error(message); checks++; }
function cleanUrl(text) { try { const value = text.replace(/\\\//g, "/").replace(/^[(`<\[]+|[)>`,.;\]]+$/g, ""); const parsed = new URL(value); return ["http:", "https:", "ws:", "wss:"].includes(parsed.protocol) ? parsed.href : null; } catch { return null; } }
function extractUrls(text) { return [...text.replace(/\\\//g, "/").matchAll(/(?:https?|wss?):\/\/[^\s"'`<>{}\[\]]+/gi)].map((row) => cleanUrl(row[0])).filter(Boolean); }
function secretLike(value) { const text = String(value || ""); return text.length >= 10 && ((/[a-z]/i.test(text) && /\d/.test(text)) || /^[0-9a-f]{12,}$/i.test(text) || text.length >= 20 && /[-_]/.test(text)); }
function inventorySecrets() {
  const secrets = { urls: new Set(), hosts: new Set(), values: new Set() }; const stats = {};
  for (const file of INVENTORIES) {
    const body = fs.readFileSync(abs(file)), text = body.toString("utf8"), urls = extractUrls(text);
    stats[file] = { bytes: body.length, sha256: sha(body), lineCount: text.split(/\r?\n/).length, candidateOccurrences: urls.length, uniqueCandidates: new Set(urls).size };
    for (const url of urls) { const parsed = new URL(url); secrets.urls.add(url); if (parsed.hostname.includes(".") || parsed.hostname.includes(":")) secrets.hosts.add(parsed.hostname.toLowerCase()); if (parsed.username) secrets.values.add(parsed.username); if (parsed.password) secrets.values.add(parsed.password); for (const value of parsed.searchParams.values()) if (secretLike(value)) secrets.values.add(value); for (const segment of parsed.pathname.split("/")) if (secretLike(segment)) secrets.values.add(segment); }
  }
  return { secrets, stats };
}
function genericLeak(text) {
  if (/(?:https?|wss?):\/\//i.test(text)) return true;
  const hosts = text.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi) || [];
  if (hosts.some((value) => !/\.(?:json|js|md|txt|sol)$/i.test(value))) return true;
  return /(?:authorization|x-api-key|api-key|apikey|api_key|bearer)\s*[:=]\s*[^\s,}\]]+/i.test(text);
}
function recomputeHyperFamilies(raw) {
  const chain999 = raw.providers.filter((row) => row.rpc.chainId === 999);
  return [...new Set(chain999.map((row) => row.familyId))].sort().map((familyId) => {
    const rows = chain999.filter((row) => row.familyId === familyId), eligible = rows.filter((row) => row.hyper?.selectedHeaderMatched);
    const commitments = [...new Set(eligible.filter((row) => row.hyper.allEightPassed).map((row) => row.hyper.matrixResultCommitment))];
    return { familyId, eligible: eligible.length, passed: eligible.filter((row) => row.hyper.allEightPassed).length, strict: eligible.length > 0 && eligible.every((row) => row.hyper.allEightPassed) && commitments.length === 1 };
  });
}
function familyCount(rows, predicate) { return new Set(rows.filter(predicate).map((row) => row.familyId)).size; }
function walk(value, visitor, pathParts = []) { visitor(value, pathParts); if (Array.isArray(value)) value.forEach((item, index) => walk(item, visitor, [...pathParts, String(index)])); else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) walk(item, visitor, [...pathParts, key]); }

const rawText = fs.readFileSync(abs(RAW), "utf8"), raw = JSON.parse(rawText);
const report = fs.readFileSync(abs(REPORT), "utf8"), inboxText = fs.readFileSync(abs(INBOX), "utf8"), inbox = JSON.parse(inboxText), handoff = fs.readFileSync(abs(HANDOFF), "utf8");
const leakText = fs.readFileSync(abs(LEAK), "utf8"), leak = JSON.parse(leakText), manifestText = fs.readFileSync(abs(MANIFEST), "utf8"), manifest = JSON.parse(manifestText);
const inventory = inventorySecrets();

check(raw.classification === EXPECTED_CLASSIFICATION, "classification mismatch");
check(raw.authorization.currentTurnExplicit === true && raw.authorization.defensiveReadOnlyOnly === true, "authorization scope mismatch");
check(JSON.stringify(raw.authorization.authorizedFiles) === JSON.stringify(INVENTORIES), "authorized files mismatch");
check(raw.inventory.uniqueCandidates === raw.providers.length, "candidate/provider count mismatch");
check(new Set(raw.providers.map((row) => row.providerId)).size === raw.providers.length, "provider IDs not unique");
check(raw.providers.every((row) => /^provider-[0-9a-f]{16}$/.test(row.providerId) && /^family-[0-9a-f]{16}$/.test(row.familyId)), "anonymous ID schema mismatch");
for (const [file, expected] of Object.entries(inventory.stats)) {
  const actual = raw.inventory.files[file];
  check(actual.bytes === expected.bytes && actual.sha256 === expected.sha256 && actual.lineCount === expected.lineCount && actual.candidateOccurrences === expected.candidateOccurrences && actual.uniqueCandidates === expected.uniqueCandidates, `inventory commitment/count mismatch: ${file}`);
  const manifestRow = manifest.inventoryCommitments[file];
  check(manifestRow.bytes === expected.bytes && manifestRow.sha256 === expected.sha256 && manifestRow.candidateOccurrences === expected.candidateOccurrences && manifestRow.uniqueCandidates === expected.uniqueCandidates, `manifest inventory mismatch: ${file}`);
}

const forbiddenKeys = new Set(["url", "uri", "host", "hostname", "domain", "providerName", "endpointName", "label", "headers", "header", "token", "key", "rawResponse", "responseBody"]);
walk(raw, (_, parts) => { const key = parts.at(-1); if (key) check(!forbiddenKeys.has(key), `forbidden key persisted: ${key}`); });
check(raw.safety.rawUrlsPersisted === false && raw.safety.domainsPersisted === false && raw.safety.keysHeadersTokensPersisted === false && raw.safety.endpointLabelsPersisted === false && raw.safety.rawResponsesPersisted === false, "persistence safety mismatch");
for (const key of ["signing", "transactions", "broadcasts", "mutation", "liveExploitCalls", "fundMovement", "forkCreated", "behavioralExploitCaptureRerun"]) check(raw.safety[key] === false, `safety flag ${key}`);
check(raw.safety.totalRequests <= raw.safety.requestBudget && raw.safety.requestBudget === 4200 && raw.safety.maxRequestsPerProvider === 34, "request budget mismatch");
check(raw.gates.routePositive === 0 && raw.gates.executableNow === 0 && raw.gates.signedActionJustified === false && raw.gates.forkCreated === false, "execution gates mismatch");

const matrix = JSON.parse(fs.readFileSync(abs(MATRIX), "utf8"));
check(matrix.stateCanaries.length === 8 && raw.hyperevm.stateCanaryCount === 8 && raw.hyperevm.matrixDigest === matrix.matrixDigest, "HyperEVM matrix mismatch");
check(raw.hyperevm.behavioralExploitCaptureRerun === false && raw.hyperevm.backendOperatorIndependenceClaimed === false, "HyperEVM scope mismatch");
const hyperFamilies = recomputeHyperFamilies(raw), strictCount = hyperFamilies.filter((row) => row.strict).length, assessedCount = hyperFamilies.filter((row) => row.eligible > 0).length;
check(raw.hyperevm.familyCount === hyperFamilies.length && raw.hyperevm.strictQualifiedFamilyCount === strictCount && raw.hyperevm.assessedFamilyCount === assessedCount, "HyperEVM family aggregation mismatch");
check(raw.hyperevm.thresholdMet === (strictCount >= raw.hyperevm.threshold) && raw.hyperevm.threshold === 3, "HyperEVM threshold mismatch");
for (const family of raw.hyperevm.families) { const expected = hyperFamilies.find((row) => row.familyId === family.familyId); check(Boolean(expected), "unknown HyperEVM family"); check(family.strictArchiveQualified === expected.strict && family.eligibleEndpointCount === expected.eligible && family.allEightPassEndpointCount === expected.passed, "HyperEVM strict family rule mismatch"); }

for (const chain of raw.chainCapabilities) {
  const rows = raw.providers.filter((row) => row.rpc.chainId === chain.chainId), deep = rows.filter((row) => row.deep);
  check(chain.providerCount === rows.length && chain.familyCount === new Set(rows.map((row) => row.familyId)).size, `chain identity counts ${chain.chainId}`);
  check(chain.deepQualifiedProviderCount === deep.length && chain.deepQualifiedFamilyCount === new Set(deep.map((row) => row.familyId)).size, `chain deep counts ${chain.chainId}`);
  check(chain.archiveReadyFamilyCount === familyCount(deep, (row) => row.deep.archiveReady), `chain archive counts ${chain.chainId}`);
  check(chain.forkReadyFamilyCount === familyCount(deep, (row) => row.deep.forkReady), `chain fork counts ${chain.chainId}`);
  check(chain.oldLogsFamilyCount === familyCount(deep, (row) => row.deep.chunkedLogs.oldRange) && chain.recentLogsFamilyCount === familyCount(deep, (row) => row.deep.chunkedLogs.recentRange), `chain logs counts ${chain.chainId}`);
  check(chain.traceFamilyCount === familyCount(deep, (row) => row.deep.traceDebugReadOnly), `chain trace counts ${chain.chainId}`);
}
check(raw.graphql.finalityClaimed === false, "GraphQL finality incorrectly claimed");
check(raw.graphql.tested === raw.providers.filter((row) => row.graphql).length, "GraphQL tested count mismatch");
check(raw.graphql.protocolFamilyCount === familyCount(raw.providers, (row) => row.graphql?.protocol), "GraphQL protocol family mismatch");
check(raw.graphql.schemaFamilyCount === familyCount(raw.providers, (row) => row.graphql?.schema), "GraphQL schema family mismatch");
check(raw.graphql.indexedHeightFamilyCount === familyCount(raw.providers, (row) => row.graphql?.indexedHeight), "GraphQL indexed family mismatch");

const baseRows = raw.providers.filter((row) => row.inventoryFiles.includes("base_full_stack_endpoints.md")), baseChain = baseRows.filter((row) => row.rpc.chainId === 8453), baseDeep = baseChain.filter((row) => row.deep);
check(raw.baseFullStack.candidates === baseRows.length, "Base candidate count mismatch");
check(raw.baseFullStack.rpcFamilyCount === new Set(baseChain.map((row) => row.familyId)).size, "Base RPC family mismatch");
check(raw.baseFullStack.archiveReadyFamilyCount === familyCount(baseDeep, (row) => row.deep.archiveReady), "Base archive family mismatch");
check(raw.baseFullStack.traceFamilyCount === familyCount(baseDeep, (row) => row.deep.traceDebugReadOnly), "Base trace family mismatch");

check(leak.status === "PASS" && leak.deterministic === true && leak.findingCount === 0 && raw.leakScan.status === "PASS", "leak scan status mismatch");
for (const file of INVENTORIES) check(leak.inventoryCommitments[file] === inventory.stats[file].sha256, `leak commitment mismatch: ${file}`);
const published = [SCANNER, VALIDATOR, RAW, LEAK, MANIFEST, REPORT, INBOX, HANDOFF].map((rel) => fs.readFileSync(abs(rel), "utf8"));
for (const [index, text] of published.slice(2).entries()) check(!genericLeak(text), `generic endpoint leak in generated artifact ${index}`);
const joined = published.join("\n").toLowerCase();
for (const value of [...inventory.secrets.urls, ...inventory.secrets.hosts, ...inventory.secrets.values]) if (value.length >= 6) check(!joined.includes(value.toLowerCase()), "inventory material leaked");

check(report.includes("GraphQL is indexing capability only and is never treated as finality"), "report GraphQL caveat missing");
check(report.includes("Prior behavioral exploit capture was not rerun"), "report behavioral exclusion missing");
check(handoff.includes("prior behavioral exploit capture not rerun"), "handoff behavioral exclusion missing");
check(inbox.routePositive === 0 && inbox.executableNow === 0 && inbox.signedActionJustified === false, "inbox gates mismatch");

for (const record of manifest.records) { const data = fs.readFileSync(abs(record.path)); check(data.length === record.bytes && sha(data) === record.sha256, `manifest record mismatch: ${record.path}`); }
const aggregate = sha(Buffer.from(manifest.records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n")));
check(aggregate === manifest.aggregateSha256, "manifest aggregate mismatch");
check(manifest.runId === raw.runId && manifest.classification === raw.classification, "manifest identity mismatch");

console.log(JSON.stringify({ ok: true, checks, runId: raw.runId, classification: raw.classification, inventoryCandidates: Object.fromEntries(INVENTORIES.map((file) => [file, { occurrences: raw.inventory.files[file].candidateOccurrences, unique: raw.inventory.files[file].uniqueCandidates }])), uniqueCandidates: raw.inventory.uniqueCandidates, chainCapabilities: raw.chainCapabilities, graphql: raw.graphql, baseFullStack: raw.baseFullStack, hyperevm: { chain999ProviderCount: raw.hyperevm.chain999ProviderCount, assessedFamilyCount: raw.hyperevm.assessedFamilyCount, strictQualifiedFamilyCount: raw.hyperevm.strictQualifiedFamilyCount, thresholdMet: raw.hyperevm.thresholdMet }, totalRequests: raw.safety.totalRequests, leakScan: leak.status, manifestAggregateSha256: manifest.aggregateSha256 }, null, 2));
