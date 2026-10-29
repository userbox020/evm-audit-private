#!/usr/bin/env node
"use strict";

// Bounded read-only HyperEVM consensus pass. Authorized endpoint material and
// qualification matrix text remain process-memory only. Published output uses
// anonymous family labels, sanitized categories, counts, and digests.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const Module = require("module");

const ROOT = path.resolve(__dirname, "..");
const NAME = "critical-etherfi-behype-hyperevm-consensus-r11";
const SCANNER = `tools/scan-${NAME}.js`;
const VALIDATOR = `tools/test-${NAME}.js`;
const RAW = `reports/raw/fast/${NAME}.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const REPORT = `reports/${NAME}.md`;
const INBOX = `coordination/inbox/critical/2026-07-22-${NAME}.json`;
const HANDOFF = `coordination/handoffs/2026-07-22-${NAME}-handoff.md`;
const R10_SCANNER = "tools/scan-critical-etherfi-behype-hyperevm-diagnostic-r10.js";
const R10R2_RAW = "reports/raw/fast/critical-etherfi-behype-hyperevm-diagnostic-r10-r2.json";
const R10R2_MANIFEST = "reports/raw/fast/critical-etherfi-behype-hyperevm-diagnostic-r10-r2-manifest.json";
const R8_RAW = "reports/raw/fast/critical-etherfi-behype-receive-type1-negative-check.json";
const R8_MANIFEST = "reports/raw/fast/critical-etherfi-behype-receive-type1-negative-check-manifest.json";
const RPC_INVENTORY = path.join(ROOT, "rpc_endpoints.txt");
const GRAPHQL_INVENTORY = path.join(ROOT, "graphql_endpoints.txt");
const ARCHIVE_MATRIX = path.join(ROOT, "hyperevm_archive_endpoints.md");
const REVISION = "etherfi-behype-hyperevm-consensus-r11-multifamily-archive-full-tuple";
const AGENT = "critical-etherfi-behype-hyper-consensus-r11-20260722";
const QUALIFICATION = "Distinct declared/observed provider-family groups are anonymous hostname-derived groups; backend/operator independence is not established.";
const CHAIN_ID = 999;
const RETAINED_DEPTH = 8;

const abs = (rel) => path.join(ROOT, rel);
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const canonical = (value) => typeof value === "bigint" ? value.toString() : Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const digest = (value) => sha(Buffer.from(JSON.stringify(canonical(value))));
const hashFile = (rel) => { const body = fs.readFileSync(abs(rel)); return { path: rel, bytes: body.length, sha256: sha(body) }; };
const readJson = (rel) => JSON.parse(fs.readFileSync(abs(rel), "utf8"));

function loadR10Core() {
  const filename = abs(R10_SCANNER); let source = fs.readFileSync(filename, "utf8");
  source = source.replace(/\nmain\(\)\.catch\([\s\S]*$/, "");
  source += "\nmodule.exports={rpc,rpcResponse,extractUrls,familyKey,parallelMap,diagnoseRoute,loadTargets,digest,canonical,hashFile,errorCategory,hex,num,lower,SUBSTAGES};\n";
  const child = new Module(filename, module); child.filename = filename; child.paths = Module._nodeModulePaths(path.dirname(filename)); child._compile(source, filename); return child.exports;
}

const core = loadR10Core();
const nativeFetch = global.fetch; const secretHeaders = new Map();
global.fetch = (input, init = {}) => { const key = String(input); const extra = secretHeaders.get(key) || {}; return nativeFetch(input, { ...init, headers: { ...extra, ...(init.headers || {}) } }); };

function writeOwned(rel, body) {
  if (![RAW, MANIFEST, REPORT, INBOX, HANDOFF].includes(rel)) throw new Error("write-refused");
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), body, "utf8");
}

function category(error) {
  const text = String(error?.message || error || "").toLowerCase(); const status = Number(error?.status); const code = Number(error?.code);
  if (status === 401 || status === 403) return "auth-or-origin-rejected";
  if (status === 429 || text.includes("rate")) return "rate-limited";
  if (code === -32601 || text.includes("method")) return "method-unsupported";
  if (text.includes("abort") || text.includes("timeout")) return "timeout";
  if (text.includes("cors") || text.includes("origin")) return "no-cors-or-origin-policy";
  if (text.includes("system") || text.includes("namespace")) return "system-transaction-namespace-difference";
  if (status >= 500) return "http-5xx";
  if (status >= 400) return "http-4xx";
  return "rpc-or-transport-error";
}

function parseHeaders(context) {
  const headers = {};
  for (const line of context.split(/\r?\n/)) {
    const match = line.match(/(?:^|[|`\s])((?:authorization|x-api-key|api-key|apikey|api_key))\s*[:=]\s*([^|`\s][^|`]*)/i);
    if (!match) continue; const name = match[1].toLowerCase() === "authorization" ? "authorization" : match[1]; const value = match[2].trim().replace(/^['"]|['"]$/g, ""); if (value) headers[name] = value;
  }
  return headers;
}

function inventoryCandidates() {
  const sources = [
    { text: fs.readFileSync(RPC_INVENTORY, "utf8"), sourceClass: "observed-prior-inventory", matrix: false },
    { text: fs.readFileSync(ARCHIVE_MATRIX, "utf8"), sourceClass: "declared-archive-matrix", matrix: true },
  ];
  const byUrl = new Map(); let parsedOccurrences = 0;
  for (const source of sources) {
    const lines = source.text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const urls = core.extractUrls(lines[index]); parsedOccurrences += urls.length;
      for (const url of urls) {
        const context = lines.slice(Math.max(0, index - 2), Math.min(lines.length, index + 3)).join("\n"); const lower = context.toLowerCase();
        const row = byUrl.get(url) || { url, sourceClasses: new Set(), matrixMatched: false, matrixArchiveDeclared: false, matrixRejected: false, matrixNoCorsHint: false, matrixBatchWeakHint: false, matrixSystemNamespaceHint: false, matrixHistoricalLatestFalsePositiveHint: false, headers: {} };
        row.sourceClasses.add(source.sourceClass); row.matrixMatched ||= source.matrix; row.matrixArchiveDeclared ||= source.matrix && /archive|historical|qualified|pass/.test(lower);
        row.matrixRejected ||= source.matrix && /reject|unqualified|not[- ]archive|fail(?:ed|ure)?/.test(lower);
        row.matrixNoCorsHint ||= /no[- ]cors|cors absent|browser cors/.test(lower); row.matrixBatchWeakHint ||= /batch.*(?:weak|fail|unsupported)|no[- ]batch/.test(lower);
        row.matrixSystemNamespaceHint ||= /system.*(?:transaction|namespace)|namespace.*system/.test(lower); row.matrixHistoricalLatestFalsePositiveHint ||= /latest[- ]state false positive|historical.*false positive|returns? latest/.test(lower);
        Object.assign(row.headers, parseHeaders(context)); byUrl.set(url, row);
      }
    }
  }
  const rows = [...byUrl.values()]; for (const row of rows) { if (Object.keys(row.headers).length) secretHeaders.set(row.url, row.headers); }
  return { rows, parsedOccurrences, matrixDigest: digest(rows.filter((row) => row.matrixMatched).map((row) => ({ archive: row.matrixArchiveDeclared, reject: row.matrixRejected, noCors: row.matrixNoCorsHint, batchWeak: row.matrixBatchWeakHint, systemNamespace: row.matrixSystemNamespaceHint, latestFalsePositive: row.matrixHistoricalLatestFalsePositiveHint })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))) };
}

async function batchProbe(row) {
  try {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 7000);
    try { const response = await global.fetch(row.url, { method: "POST", signal: controller.signal, headers: { "content-type": "application/json" }, body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }, { jsonrpc: "2.0", id: 2, method: "eth_blockNumber", params: [] }]) }); if (!response.ok) throw Object.assign(new Error("batch-http"), { status: response.status }); const body = await response.json(); return { supported: Array.isArray(body) && body.length === 2, category: Array.isArray(body) && body.length === 2 ? "batch-supported" : "batch-response-shape-failed" }; }
    finally { clearTimeout(timer); }
  } catch (error) { return { supported: false, category: category(error) }; }
}

async function identityProbe(row, targets, predecessor) {
  const out = { row, status: "pending", exclusionCategory: null, chain999: false, historicalHeaderMatches: false, historicalRuntimeAgreement: false, historicalStateQualified: false, archiveQualified: false, finalizedSupported: false, finalizedNumber: null, finalizedCategory: null, headNumber: null, headHashDigest: null, safeHeight: null, batch: null };
  try {
    const chainId = core.num(await core.rpc(row.url, "eth_chainId", [], 8000)); out.chain999 = chainId === CHAIN_ID; if (!out.chain999) { out.status = "excluded"; out.exclusionCategory = "other-chain"; return out; }
    const headNumber = core.num(await core.rpc(row.url, "eth_blockNumber", [], 8000)); const head = await core.rpc(row.url, "eth_getBlockByNumber", [core.hex(headNumber), false], 8000); if (!head?.hash) throw new Error("head-unavailable"); out.headNumber = headNumber; out.headHashDigest = digest(String(head.hash).toLowerCase());
    const historical = await core.rpc(row.url, "eth_getBlockByNumber", [core.hex(predecessor.pin.blockNumber), false], 10000); out.historicalHeaderMatches = String(historical?.hash || "").toLowerCase() === predecessor.pin.blockHash;
    const expectedCode = new Map(predecessor.providers[0].routes.map((route) => [route.routeLabel, route.checks["app-runtime"].digests.codeHash])); const runtimeMatches = [];
    for (const route of targets.routes) { const code = await core.rpc(row.url, "eth_getCode", [route["app"], core.hex(predecessor.pin.blockNumber)], 10000); runtimeMatches.push(Boolean(code && code !== "0x" && require("ethers").keccak256(code) === expectedCode.get(route.label))); }
    out.historicalRuntimeAgreement = runtimeMatches.length === 2 && runtimeMatches.every(Boolean); out.historicalStateQualified = out.historicalHeaderMatches && out.historicalRuntimeAgreement && !row.matrixRejected && !row.matrixHistoricalLatestFalsePositiveHint;
    out.archiveQualified = out.historicalStateQualified && (row.matrixMatched || predecessor.pin.blockNumber < headNumber - RETAINED_DEPTH);
    if (!out.historicalStateQualified) { out.status = "excluded"; out.exclusionCategory = row.matrixHistoricalLatestFalsePositiveHint ? "historical-latest-state-false-positive" : row.matrixRejected ? "historical-matrix-rejected" : !out.historicalHeaderMatches ? "historical-header-mismatch-or-unavailable" : "historical-runtime-disagreement"; return out; }
    try { const finalized = await core.rpc(row.url, "eth_getBlockByNumber", ["finalized", false], 8000); if (finalized?.hash) { out.finalizedSupported = true; out.finalizedNumber = core.num(finalized.number); } else out.finalizedCategory = "empty-finalized"; } catch (error) { out.finalizedCategory = category(error); }
    out.safeHeight = out.finalizedSupported ? out.finalizedNumber : Math.max(0, headNumber - RETAINED_DEPTH); out.batch = await batchProbe(row); out.status = "identity-qualified"; return out;
  } catch (error) { out.status = "excluded"; out.exclusionCategory = category(error); return out; }
}

function selectPin(rows) {
  const familyHeights = new Map(); for (const row of rows) familyHeights.set(row.row.familyKey, Math.max(familyHeights.get(row.row.familyKey) || 0, row.safeHeight));
  const heights = [...familyHeights.values()].sort((a, b) => b - a); if (!heights.length) return null; return heights.length >= 3 ? heights[2] : heights.length >= 2 ? heights[1] : heights[0];
}

async function bindPin(rows, pinNumber) {
  const checked = await core.parallelMap(rows.filter((row) => row.safeHeight >= pinNumber), 8, async (row) => {
    try { const header = await core.rpc(row.row.url, "eth_getBlockByNumber", [core.hex(pinNumber), false], 10000); return header?.hash && core.num(header.number) === pinNumber ? { ...row, exactPin: true, pinHash: String(header.hash).toLowerCase(), pinTimestamp: core.num(header.timestamp) } : { ...row, exactPin: false, pinCategory: "pin-header-unavailable" }; }
    catch (error) { return { ...row, exactPin: false, pinCategory: category(error) }; }
  });
  const groups = new Map(); for (const row of checked.filter((item) => item.exactPin)) { const set = groups.get(row.pinHash) || new Set(); set.add(row.row.familyKey); groups.set(row.pinHash, set); }
  const winner = [...groups.entries()].sort((a, b) => b[1].size - a[1].size)[0]; if (!winner) return { blockNumber: pinNumber, rows: [], checked, familyCount: 0 };
  const selected = checked.filter((row) => row.exactPin && row.pinHash === winner[0]); return { blockNumber: pinNumber, blockHash: winner[0], timestamp: selected[0].pinTimestamp, rows: selected, checked, familyCount: winner[1].size };
}

function routeDigest(route, includeAnchor) {
  const checks = {};
  for (const name of route.substageOrder) { if (!includeAnchor && ["anchor", "pin-recheck"].includes(name)) continue; const check = route.checks[name]; checks[name] = { status: check.status, category: check.category, digests: check.digests, successfulBooleanCount: check.successfulBooleanCount, digestCount: check.digestCount, configRows: check.configRows || null }; }
  return digest({ routeLabel: route.routeLabel, routeIdentityDigest: route.routeIdentityDigest, checks });
}

async function fullObservation(row, pin, targets) {
  const routes = []; for (const route of targets.routes) routes.push(await core.diagnoseRoute(row.row.url, route, targets, pin));
  const retainedHashStable = routes.every((route) => route.checks["pin-recheck"].status === "success"); const allRoutesComplete = routes.every((route) => route.routeComplete);
  const behavioralTupleDigest = digest(routes.map((route) => routeDigest(route, false))); const anchorDigest = digest(routes.map((route) => route.checks.anchor.digests.anchorDigest || null)); const fullTupleAnchorDigest = digest({ behavioralTupleDigest, anchorDigest });
  const finalityMode = row.finalizedSupported && row.finalizedNumber >= pin.blockNumber ? "reported-finalized-height-bound" : retainedHashStable ? "non-finalized-retained-hash-stability-only" : "finality-unqualified";
  return { familyKey: row.row.familyKey, familyClass: row.row.familyClass, archiveQualified: row.archiveQualified, finalizedAtPin: row.finalizedSupported && row.finalizedNumber >= pin.blockNumber, retainedHashStable, finalityMode, headNumber: row.headNumber, headHashDigest: row.headHashDigest, batchSupported: row.batch?.supported === true, routes, allRoutesComplete, complete: allRoutesComplete && retainedHashStable && finalityMode !== "finality-unqualified", behavioralTupleDigest, anchorDigest, fullTupleAnchorDigest };
}

function aggregateFamilies(candidates, identityRows, pin, observations) {
  const keys = [...new Set(candidates.map((row) => row.familyKey))].sort(); const ids = new Map(keys.map((key, index) => [key, `hyperevm-family-${String(index + 1).padStart(2, "0")}`])); const out = [];
  for (const key of keys) {
    const sourceRows = candidates.filter((row) => row.familyKey === key); const identities = identityRows.filter((row) => row.row.familyKey === key && row.status === "identity-qualified"); const exact = pin.rows.filter((row) => row.row.familyKey === key); const full = observations.filter((row) => row.familyKey === key && row.complete); const digests = [...new Set(full.map((row) => row.fullTupleAnchorDigest))]; const complete = full.length > 0 && digests.length === 1; const exemplar = complete ? full[0] : null;
    out.push({ familyId: ids.get(key), familyClass: sourceRows.some((row) => row.sourceClasses.has("declared-archive-matrix")) ? "declared-archive-matrix" : "observed-prior-inventory", candidateCount: sourceRows.length, identityQualifiedCandidateCount: identities.length, exactPinCandidateCount: exact.length, fullCandidateCount: full.length, archiveQualified: identities.some((row) => row.archiveQualified), finalizedAtPin: full.some((row) => row.finalizedAtPin), retainedHashStable: full.some((row) => row.retainedHashStable), complete, ambiguousWithinFamily: digests.length > 1, finalityModes: [...new Set(full.map((row) => row.finalityMode))], headBinding: identities.length ? { observedHeadCount: identities.length, minHead: Math.min(...identities.map((row) => row.headNumber)), maxHead: Math.max(...identities.map((row) => row.headNumber)), headDigest: digest(identities.map((row) => ({ number: row.headNumber, hashDigest: row.headHashDigest })).sort((a, b) => a.number - b.number)) } : null, behavioralTupleDigest: exemplar?.behavioralTupleDigest || null, anchorDigest: exemplar?.anchorDigest || null, fullTupleAnchorDigest: exemplar?.fullTupleAnchorDigest || null, routes: exemplar ? exemplar.routes : [] });
  }
  return out;
}

function exclusionSummary(candidates, identityRows, pin, observations) {
  const counts = new Map(); const add = (substage, value) => { const key = `${substage}\0${value}`; counts.set(key, (counts.get(key) || 0) + 1); };
  for (const row of identityRows.filter((item) => item.status !== "identity-qualified")) add("identity", row.exclusionCategory || "unknown");
  for (const row of pin.checked.filter((item) => !item.exactPin)) add("pin-bind", row.pinCategory || "pin-unavailable");
  for (const observation of observations.filter((item) => !item.complete)) { const failed = observation.routes.flatMap((route) => route.firstFailure ? [route.firstFailure] : []); if (failed.length) for (const item of failed) add(item.failureSubstage, item.failureCategory); else add("full-tuple", observation.allRoutesComplete ? "finality-unqualified" : "route-incomplete"); }
  return [...counts.entries()].map(([key, count]) => { const [substage, value] = key.split("\0"); return { substage, category: value, count }; }).sort((a, b) => b.count - a.count || a.substage.localeCompare(b.substage) || a.category.localeCompare(b.category));
}

async function graphqlProbe() {
  const text = fs.readFileSync(GRAPHQL_INVENTORY, "utf8"); const urls = core.extractUrls(text); const rows = await core.parallelMap(urls, 12, async (url) => {
    try { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 7000); try { const response = await global.fetch(url, { method: "POST", signal: controller.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "query { __typename }" }) }); if (!response.ok) throw Object.assign(new Error("protocol-http"), { status: response.status }); const body = await response.json(); return { success: Boolean(body && (body.data || body.errors)), category: body && (body.data || body.errors) ? "protocol-response" : "protocol-schema-unrecognized" }; } finally { clearTimeout(timer); } }
    catch (error) { return { success: false, category: category(error) }; }
  });
  const categories = {}; for (const row of rows) categories[row.category] = (categories[row.category] || 0) + 1; return { candidatesTested: urls.length, protocolResponses: rows.filter((row) => row.success).length, categories, usedForFinalityOrStateConsensus: false };
}

function assertNoLeak(text) {
  if (/(?:https?|wss?):\/\//i.test(text)) throw new Error("scheme-leak");
  if (/\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|xyz|cloud|tech|finance|money|pro)\b/i.test(text)) throw new Error("host-leak");
  if (/(?:authorization|x-api-key|api-key|apikey|api_key|bearer|cookie|set-cookie)\s*[:=]\s*[^\s,}\]]+/i.test(text)) throw new Error("credential-leak");
  if (/"(?:url|domain|providerName|rawLine|headers?|address|endpointId|endpointIdentifier)"\s*:/i.test(text)) throw new Error("identifier-field-leak");
}

function report(raw) {
  const exclusions = raw.excludedCategories.map((row) => `| ${row.substage} | ${row.category} | ${row.count} |`).join("\n") || "| none | none | 0 |";
  return `# 🟠 WATCH — EtherFi BeHYPE HyperEVM consensus R11\n\n**Run:** \`${raw.runId}\`  \n**Classification:** \`${raw.classification}\`  \n**Gates:** \`0/0/false\`; \`fork=false\`\n\n${QUALIFICATION}\n\nAt fresh conservative pin ${raw.pin.blockNumber} / \`${raw.pin.blockHash}\`, ${raw.metrics.consensusFamilies} distinct anonymous declared/observed families match the canonical full selected-library behavioral tuple plus bounded anchor. Reported-finalized support is qualified separately from retained-hash-only support.\n\n| Metric | Count |\n|---|---:|\n| Authorized RPC candidates | ${raw.metrics.rpcCandidatesTested} |\n| Matrix-listed archive candidates | ${raw.metrics.matrixArchiveCandidates} |\n| Archive-qualified families | ${raw.metrics.archiveQualifiedFamilies} |\n| Reported-finalized families at pin | ${raw.metrics.finalizedFamiliesAtPin} |\n| Full behavioral families | ${raw.metrics.fullFamilies} |\n| Matching tuple plus anchor families | ${raw.metrics.consensusFamilies} |\n\n| Exclusion substage | Sanitized category | Count |\n|---|---|---:|\n${exclusions}\n\nGraphQL/data APIs were protocol probes only and were not used for finality or state consensus. HyperEVM threshold ready=${raw.coverage.hyperEvmThresholdReady}; immutable Optimism R8-r2 ready=${raw.coverage.optimismPredecessorReady}; two-chain coverage ready=${raw.coverage.twoChainCoverageReady}. This enables only a separately reviewed economics model; R11 performed no economics.\n\nNo endpoint/provider identities, domains, URLs, keys, headers, raw inventory lines, or raw responses are retained. No stake, send, message, protocol retry, sweep, signing, fork, transaction, or mutation occurred.\n\n**nextReadOnlyStep:** ${raw.nextReadOnlyStep}\n`;
}

function offlineFinalize() {
  const raw = readJson(RAW); raw.offlineFinalization = { networkCalls: false, endpointInventoryReads: false, evidenceValuesChanged: false, packagingCorrectionOnly: true, finalizedAt: new Date().toISOString() };
  delete raw.runId; raw.runId = `etherfi-behype-hyperevm-consensus-r11-${digest(raw).slice(0, 20)}-${hashFile(SCANNER).sha256.slice(0, 12)}`;
  writeOwned(RAW, JSON.stringify(canonical(raw), null, 2) + "\n"); writeOwned(REPORT, report(raw));
  const inbox = canonical({ findingId: NAME, revision: REVISION, runId: raw.runId, agentId: AGENT, role: "critical-research", status: raw.classification, classification: raw.classification, providerFamilyQualification: QUALIFICATION, backendOperatorIndependenceEstablished: false, backendOperatorIndependenceClaimed: false, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, pin: raw.pin, metrics: raw.metrics, canonicalConsensus: raw.canonicalConsensus, excludedCategories: raw.excludedCategories, coverage: raw.coverage, immutablePredecessorR10R2: raw.immutablePredecessorR10R2, immutablePredecessorR8R2: raw.immutablePredecessorR8R2, artifacts: [SCANNER, VALIDATOR, RAW, MANIFEST, REPORT, INBOX, HANDOFF, R10R2_RAW, R10R2_MANIFEST, R8_RAW, R8_MANIFEST, R10_SCANNER], nextAction: raw.nextReadOnlyStep }); writeOwned(INBOX, JSON.stringify(inbox, null, 2) + "\n");
  writeOwned(HANDOFF, `# EtherFi BeHYPE HyperEVM consensus R11 handoff\n\n- Run \`${raw.runId}\`; classification \`${raw.classification}\`; gates \`0/0/false\`, fork=false.\n- ${QUALIFICATION}\n- Fresh pin ${raw.pin.blockNumber} / \`${raw.pin.blockHash}\`; exact-pin/full/consensus families ${raw.metrics.exactPinFamilies}/${raw.metrics.fullFamilies}/${raw.metrics.consensusFamilies}.\n- Archive-qualified/finalized/retained-only families ${raw.metrics.archiveQualifiedFamilies}/${raw.metrics.finalizedFamiliesAtPin}/${raw.metrics.retainedHashOnlyFamilies}.\n- Two-chain coverage ready=${raw.coverage.twoChainCoverageReady}; economics not performed and remains separately review-gated.\n- Offline finalization changed packaging hashes only; no network/inventory read or evidence change.\n- No endpoint identities, raw inventories/responses, secrets, transactions, or mutation persisted.\n- Next: ${raw.nextReadOnlyStep}\n`);
  const records = [SCANNER, VALIDATOR, RAW, REPORT, INBOX, HANDOFF, R10R2_RAW, R10R2_MANIFEST, R8_RAW, R8_MANIFEST, R10_SCANNER].map(hashFile); const aggregateSha256 = sha(Buffer.from(records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n"))); const manifest = canonical({ schemaVersion: 1, revision: REVISION, runId: raw.runId, generatedAt: raw.generatedAt, classification: raw.classification, algorithm: "sha256", providerFamilyQualification: QUALIFICATION, backendOperatorIndependenceEstablished: false, backendOperatorIndependenceClaimed: false, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, pin: raw.pin, metrics: raw.metrics, capabilityHints: raw.capabilityHints, qualificationMatrix: raw.qualificationMatrix, graphqlProtocolProbe: raw.graphqlProtocolProbe, canonicalConsensus: raw.canonicalConsensus, excludedCategories: raw.excludedCategories, coverage: raw.coverage, immutablePredecessorR10R2: raw.immutablePredecessorR10R2, immutablePredecessorR8R2: raw.immutablePredecessorR8R2, gates: raw.gates, safety: raw.safety, offlineFinalization: raw.offlineFinalization, records, aggregateSha256 }); writeOwned(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  for (const rel of [SCANNER, VALIDATOR, RAW, MANIFEST, REPORT, INBOX, HANDOFF]) assertNoLeak(fs.readFileSync(abs(rel), "utf8")); process.stdout.write(JSON.stringify({ runId: raw.runId, classification: raw.classification, counts: raw.metrics, pin: raw.pin, canonicalConsensus: raw.canonicalConsensus, coverage: raw.coverage, excludedCategories: raw.excludedCategories, manifestAggregateSha256: aggregateSha256, offlineFinalization: raw.offlineFinalization, checks: raw.safety, nextReadOnlyStep: raw.nextReadOnlyStep }) + "\n");
}

async function main() {
  if (process.env.R11_OFFLINE_FINALIZE === "1") return offlineFinalize();
  const targets = core.loadTargets(); const predecessor = readJson(R10R2_RAW); const optimism = readJson(R8_RAW); const inventory = inventoryCandidates();
  for (const row of inventory.rows) { row.familyKey = core.familyKey(row.url); row.familyClass = row.sourceClasses.has("declared-archive-matrix") ? "declared-archive-matrix" : "observed-prior-inventory"; }
  const identityRows = await core.parallelMap(inventory.rows, 16, (row) => identityProbe(row, targets, predecessor)); const qualified = identityRows.filter((row) => row.status === "identity-qualified"); const pinNumber = selectPin(qualified); if (!pinNumber) throw new Error("no-identity-qualified-pin"); const pin = await bindPin(qualified, pinNumber);
  const observations = await core.parallelMap(pin.rows, 3, (row) => fullObservation(row, pin, targets)); const families = aggregateFamilies(inventory.rows, identityRows, pin, observations); const completeFamilies = families.filter((row) => row.complete); const consensusGroups = new Map(); for (const family of completeFamilies) { const set = consensusGroups.get(family.fullTupleAnchorDigest) || new Set(); set.add(family.familyId); consensusGroups.set(family.fullTupleAnchorDigest, set); } const consensusFamilies = Math.max(0, ...[...consensusGroups.values()].map((set) => set.size)); const canonicalDigest = [...consensusGroups.entries()].sort((a, b) => b[1].size - a[1].size)[0]?.[0] || null;
  const hyperEvmThresholdReady = consensusFamilies >= 2; const optimismPredecessorReady = optimism.behavioralConsensusReady === true && optimism.consensus?.full >= 2; const twoChainCoverageReady = hyperEvmThresholdReady && optimismPredecessorReady;
  const classification = hyperEvmThresholdReady ? "WATCH/COVERAGE_READY/HYPEREVM-MULTI-FAMILY-FULL-BEHAVIORAL-CONSENSUS/PROVISIONAL-FINALITY/NO-BACKEND-INDEPENDENCE-CLAIM" : "WATCH/COVERAGE_OPEN/HYPEREVM-FAMILY-THRESHOLD-NOT-MET/PROVISIONAL-FINALITY/NO-BACKEND-INDEPENDENCE-CLAIM";
  const graphql = await graphqlProbe(); const excludedCategories = exclusionSummary(inventory.rows, identityRows, pin, observations); const hintCounts = { noCors: inventory.rows.filter((row) => row.matrixNoCorsHint).length, batchWeak: inventory.rows.filter((row) => row.matrixBatchWeakHint).length, systemTransactionNamespace: inventory.rows.filter((row) => row.matrixSystemNamespaceHint).length, historicalLatestStateFalsePositive: inventory.rows.filter((row) => row.matrixHistoricalLatestFalsePositiveHint).length };
  const metrics = { rpcCandidatesTested: inventory.rows.length, parsedRpcCandidateOccurrences: inventory.parsedOccurrences, matrixArchiveCandidates: inventory.rows.filter((row) => row.matrixMatched).length, identityQualifiedCandidates: qualified.length, chain999Candidates: identityRows.filter((row) => row.chain999).length, exactPinCandidates: pin.rows.length, exactPinFamilies: pin.familyCount, archiveQualifiedFamilies: families.filter((row) => row.archiveQualified).length, finalizedFamiliesAtPin: families.filter((row) => row.finalizedAtPin).length, retainedHashOnlyFamilies: families.filter((row) => row.complete && !row.finalizedAtPin && row.retainedHashStable).length, fullFamilies: completeFamilies.length, consensusFamilies, graphqlCandidatesTested: graphql.candidatesTested, graphqlProtocolResponses: graphql.protocolResponses };
  const nextReadOnlyStep = twoChainCoverageReady ? "Submit the R11 two-chain coverage package for independent review, then build a separately reviewed economics model without assuming backend/operator independence." : "Obtain enough distinct declared/observed HyperEVM families to match the full behavioral tuple plus anchor at one fresh pin; do not begin economics.";
  const predecessorR10 = { status: "IMMUTABLE-PREDECESSOR/HYPEREVM-R10-R2", raw: hashFile(R10R2_RAW), manifest: hashFile(R10R2_MANIFEST), runId: predecessor.runId }; const predecessorR8 = { status: "IMMUTABLE-PREDECESSOR/OPTIMISM-R8-R2", raw: hashFile(R8_RAW), manifest: hashFile(R8_MANIFEST), runId: optimism.runId };
  const raw = canonical({ schemaVersion: 1, revision: REVISION, generatedAt: new Date().toISOString(), scanner: SCANNER, agentId: AGENT, role: "critical-research", classification, providerFamilyQualification: QUALIFICATION, backendOperatorIndependenceEstablished: false, backendOperatorIndependenceClaimed: false, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, pin: { blockNumber: pin.blockNumber, blockHash: pin.blockHash, timestamp: pin.timestamp, selectionRule: "third-highest distinct-family conservative safe height when at least three qualified families exist; otherwise second-highest when at least two exist", exactPinFamilyCount: pin.familyCount, crossFamilyHashAgreement: pin.familyCount >= 2, finalityQualification: "reported-finalized where available; otherwise retained-hash stability only" }, metrics, capabilityHints: hintCounts, qualificationMatrix: { entriesMatched: metrics.matrixArchiveCandidates, digest: inventory.matrixDigest, rawMatrixPersisted: false }, graphqlProtocolProbe: graphql, families, canonicalConsensus: { fullTupleAnchorDigest: canonicalDigest, familyCount: consensusFamilies, threshold: 2, preferredThreshold: 3, thresholdMet: hyperEvmThresholdReady, preferredThresholdMet: consensusFamilies >= 3 }, excludedCategories, coverage: { hyperEvmThresholdReady, optimismPredecessorReady, twoChainCoverageReady, economicsModelReviewEligible: twoChainCoverageReady, economicsPerformed: false }, immutablePredecessorR10R2: predecessorR10, immutablePredecessorR8R2: predecessorR8, retainedR10Scanner: hashFile(R10_SCANNER), gates: { routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, twoChainCoverageReady, economicsBlockedPendingSeparateReview: true }, safety: { readOnly: true, boundedPass: true, boundedRetryCount: 1, priorIncompleteRunReconciled: true, rpcInventoryRead: true, graphqlInventoryRead: true, archiveMatrixRead: true, serverSideRequests: true, individualCallsUsed: true, batchOnlyDependency: false, rawResponsesPersisted: false, rawInventoryLinesPersisted: false, endpointIdentifiersPersisted: false, providerNamesPersisted: false, providerDomainsPersisted: false, keysPersisted: false, headersPersisted: false, economicsCalls: false, transactions: false, stakeCalls: false, messageSendCalls: false, protocolRetryCalls: false, sweepCalls: false, signing: false, forkCreated: false, mutation: false }, nextReadOnlyStep });
  raw.runId = `etherfi-behype-hyperevm-consensus-r11-${digest(raw).slice(0, 20)}-${hashFile(SCANNER).sha256.slice(0, 12)}`;
  writeOwned(RAW, JSON.stringify(raw, null, 2) + "\n"); writeOwned(REPORT, report(raw));
  const inbox = canonical({ findingId: NAME, revision: REVISION, runId: raw.runId, agentId: AGENT, role: "critical-research", status: classification, classification, providerFamilyQualification: QUALIFICATION, backendOperatorIndependenceEstablished: false, backendOperatorIndependenceClaimed: false, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, pin: raw.pin, metrics, canonicalConsensus: raw.canonicalConsensus, excludedCategories, coverage: raw.coverage, immutablePredecessorR10R2: predecessorR10, immutablePredecessorR8R2: predecessorR8, artifacts: [SCANNER, VALIDATOR, RAW, MANIFEST, REPORT, INBOX, HANDOFF, R10R2_RAW, R10R2_MANIFEST, R8_RAW, R8_MANIFEST, R10_SCANNER], nextAction: nextReadOnlyStep }); writeOwned(INBOX, JSON.stringify(inbox, null, 2) + "\n");
  writeOwned(HANDOFF, `# EtherFi BeHYPE HyperEVM consensus R11 handoff\n\n- Run \`${raw.runId}\`; classification \`${classification}\`; gates \`0/0/false\`, fork=false.\n- ${QUALIFICATION}\n- Fresh pin ${pin.blockNumber} / \`${pin.blockHash}\`; exact-pin/full/consensus families ${metrics.exactPinFamilies}/${metrics.fullFamilies}/${metrics.consensusFamilies}.\n- Archive-qualified/finalized/retained-only families ${metrics.archiveQualifiedFamilies}/${metrics.finalizedFamiliesAtPin}/${metrics.retainedHashOnlyFamilies}.\n- Two-chain coverage ready=${twoChainCoverageReady}; economics not performed and remains separately review-gated.\n- No endpoint identities, raw inventories/responses, secrets, transactions, or mutation persisted.\n- Next: ${nextReadOnlyStep}\n`);
  const records = [SCANNER, VALIDATOR, RAW, REPORT, INBOX, HANDOFF, R10R2_RAW, R10R2_MANIFEST, R8_RAW, R8_MANIFEST, R10_SCANNER].map(hashFile); const aggregateSha256 = sha(Buffer.from(records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n"))); const manifest = canonical({ schemaVersion: 1, revision: REVISION, runId: raw.runId, generatedAt: raw.generatedAt, classification, algorithm: "sha256", providerFamilyQualification: QUALIFICATION, backendOperatorIndependenceEstablished: false, backendOperatorIndependenceClaimed: false, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, pin: raw.pin, metrics, capabilityHints: hintCounts, qualificationMatrix: raw.qualificationMatrix, graphqlProtocolProbe: graphql, canonicalConsensus: raw.canonicalConsensus, excludedCategories, coverage: raw.coverage, immutablePredecessorR10R2: predecessorR10, immutablePredecessorR8R2: predecessorR8, gates: raw.gates, safety: raw.safety, records, aggregateSha256 }); writeOwned(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  for (const rel of [SCANNER, VALIDATOR, RAW, MANIFEST, REPORT, INBOX, HANDOFF]) assertNoLeak(fs.readFileSync(abs(rel), "utf8"));
  process.stdout.write(JSON.stringify({ runId: raw.runId, classification, counts: metrics, pin: raw.pin, canonicalConsensus: raw.canonicalConsensus, coverage: raw.coverage, excludedCategories, manifestAggregateSha256: aggregateSha256, checks: raw.safety, nextReadOnlyStep }) + "\n");
}

main().catch((error) => { process.stderr.write(`HyperEVM R11 failed: ${category(error)}\n`); process.exitCode = 1; });
