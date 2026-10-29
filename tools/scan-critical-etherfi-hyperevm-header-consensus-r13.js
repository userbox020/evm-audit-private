#!/usr/bin/env node
"use strict";

// R13 block-1 header consensus preflight. Endpoint material remains internal;
// only anonymous family counts, canonical digests, and a consensus-derived
// public block hash may be published.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const Module = require("module");

const ROOT = path.resolve(__dirname, "..");
const NAME = "critical-etherfi-hyperevm-header-consensus-r13";
const SCANNER = `tools/scan-${NAME}.js`;
const VALIDATOR = `tools/test-${NAME}.js`;
const RAW = `reports/raw/fast/${NAME}.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const REPORT = `reports/${NAME}.md`;
const INBOX = `coordination/inbox/critical/2026-07-23-${NAME}.json`;
const HANDOFF = `coordination/handoffs/2026-07-23-${NAME}-handoff.md`;
const CORRECTED_MATRIX = `reports/raw/fast/${NAME}-corrected-historical-matrix.json`;
const R11_SCANNER = "tools/scan-critical-etherfi-behype-hyperevm-consensus-r11.js";
const R12_SCANNER = "tools/scan-critical-etherfi-behype-hyperevm-requalification-r12.js";
const R12_RAW = "reports/raw/fast/critical-etherfi-behype-hyperevm-requalification-r12.json";
const R12_MANIFEST = "reports/raw/fast/critical-etherfi-behype-hyperevm-requalification-r12-manifest.json";
const ARCHIVE_MATRIX = path.join(ROOT, "hyperevm_archive_endpoints.md");
const REVISION = "etherfi-hyperevm-header-consensus-r13-block1-full-header";
const MATRIX_REVISION = "etherfi-hyperevm-historical-matrix-r13-corrected-block1-hash";
const AGENT = "critical-etherfi-hyper-header-r13-20260723";
const QUALIFICATION = "Agreeing hostname-derived provider-family groups are anonymous; backend/operator independence is not established.";
const CHAIN_ID = 999;

const abs = (rel) => path.join(ROOT, rel);
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const canonical = (value) => typeof value === "bigint" ? value.toString() : Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const digest = (value) => sha(Buffer.from(JSON.stringify(canonical(value))));
const hashFile = (rel) => { const body = fs.readFileSync(abs(rel)); return { path: rel, bytes: body.length, sha256: sha(body) }; };
const readJson = (rel) => JSON.parse(fs.readFileSync(abs(rel), "utf8"));

function loadModule(rel, exportsText) { const filename = abs(rel); let source = fs.readFileSync(filename, "utf8"); source = source.replace(/\nmain\(\)\.catch\([\s\S]*$/, ""); source += `\nmodule.exports={${exportsText}};\n`; const child = new Module(filename, module); child.filename = filename; child.paths = Module._nodeModulePaths(path.dirname(filename)); child._compile(source, filename); return child.exports; }
const base = loadModule(R11_SCANNER, "core,inventoryCandidates,category"); const matrixParser = loadModule(R12_SCANNER, "parseMatrix"); const core = base.core;

function writeOwned(rel, body) { if (![RAW, MANIFEST, REPORT, INBOX, HANDOFF, CORRECTED_MATRIX].includes(rel)) throw new Error("write-refused"); fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), body, "utf8"); }
function category(error) { return base.category(error); }
function fixed(value, bytes) { return typeof value === "string" && new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value); }
function data(value, exactBytes = null) { if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) return false; return exactBytes == null || value.length === 2 + exactBytes * 2; }
function qty(value) { if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) throw new Error("invalid-header-quantity"); return `0x${BigInt(value).toString(16)}`; }

function malformedSpec(text) {
  const lines = text.split(/\r?\n/); const row = lines.find((line) => /^\s*\|.*hash.*\|\s*$/i.test(line) && /\b1\b/.test(line)); if (!row) throw new Error("matrix-block1-row-unparsed"); const match = row.match(/0x([0-9a-fA-F]+)/); if (!match) throw new Error("matrix-block1-hash-unparsed"); const observedBytes = match[1].length / 2; return { classification: observedBytes === 31 ? "matrix-spec-malformed-block1-hash-width" : "matrix-spec-unexpected-block1-hash-width", observedBytes, expectedBytes: 32, trustedForConsensus: false, substringMatchingUsed: false, prefixMatchingUsed: false, suffixMatchingUsed: false, paddingUsed: false };
}

function canonicalHeader(header) {
  if (!header || qty(header.number) !== "0x1") throw new Error("header-number-not-one");
  for (const key of ["hash", "parentHash", "stateRoot", "transactionsRoot", "receiptsRoot"]) if (!fixed(header[key], 32)) throw new Error(`header-${key.toLowerCase()}-width`);
  const timestamp = BigInt(header.timestamp); if (timestamp <= 0n) throw new Error("header-timestamp-invalid");
  const out = { number: "0x1", hash: header.hash.toLowerCase(), parentHash: header.parentHash.toLowerCase(), stateRoot: header.stateRoot.toLowerCase(), transactionsRoot: header.transactionsRoot.toLowerCase(), receiptsRoot: header.receiptsRoot.toLowerCase(), timestamp: qty(header.timestamp) };
  const fixedFields = { sha3Uncles: 32, miner: 20, logsBloom: 256, mixHash: 32, nonce: 8, withdrawalsRoot: 32, parentBeaconBlockRoot: 32, requestsHash: 32 };
  for (const [key, bytes] of Object.entries(fixedFields)) if (header[key] != null) { if (!fixed(header[key], bytes)) throw new Error(`header-${key.toLowerCase()}-width`); out[key] = header[key].toLowerCase(); }
  for (const key of ["difficulty", "gasLimit", "gasUsed", "baseFeePerGas", "blobGasUsed", "excessBlobGas"]) if (header[key] != null) out[key] = qty(header[key]);
  if (header.extraData != null) { if (!data(header.extraData)) throw new Error("header-extradata-schema"); out.extraData = header.extraData.toLowerCase(); }
  return canonical(out);
}

let rateLimitRetries = 0;
async function rpc(url, method, params, timeout = 9000) { try { return await core.rpc(url, method, params, timeout); } catch (error) { if (category(error) !== "rate-limited") throw error; rateLimitRetries++; await new Promise((resolve) => setTimeout(resolve, 600)); return core.rpc(url, method, params, timeout); } }

async function probe(row) {
  let chain999 = false;
  try { const chainId = Number(BigInt(await rpc(row.url, "eth_chainId", []))); if (chainId !== CHAIN_ID) return { row, chain999, success: false, category: "other-chain" }; chain999 = true; const block = await rpc(row.url, "eth_getBlockByNumber", ["0x1", false], 12000); const normalized = canonicalHeader(block); return { row, chain999, success: true, headerHash: normalized.hash, fingerprint: digest(normalized), canonical: normalized }; }
  catch (error) { return { row, chain999, success: false, category: category(error) === "rpc-or-transport-error" && /^(?:header-|invalid-header)/.test(String(error?.message || "")) ? String(error.message) : category(error) }; }
}

function aggregateFamilies(rows) {
  const keys = [...new Set(rows.map((row) => row.row.familyKey))].sort(); const ids = new Map(keys.map((key, index) => [key, `hyperevm-family-${String(index + 1).padStart(2, "0")}`])); const families = [];
  for (const key of keys) { const candidates = rows.filter((row) => row.row.familyKey === key); const successes = candidates.filter((row) => row.success); const fingerprints = [...new Set(successes.map((row) => row.fingerprint))]; const accepted = successes.length > 0 && fingerprints.length === 1; families.push({ familyId: ids.get(key), candidateCount: candidates.length, schemaValidCandidateCount: successes.length, accepted, internallyConsistent: fingerprints.length <= 1, fingerprint: accepted ? fingerprints[0] : null, blockHash: accepted ? successes[0].headerHash : null, canonical: accepted ? successes[0].canonical : null }); }
  return families;
}

function parseCorrectedMatrix(text, consensusHash, headerDigest, familyCount) {
  const spec = matrixParser.parseMatrix(text); const stateCanaries = [
    { id: "native-balance-block1", method: "eth_getBalance", blockNumber: spec.block1, account: spec.nativeAccount, expectedQuantity: `0x${BigInt(spec.block1Balance).toString(16)}` },
    { id: "native-balance-block100k", method: "eth_getBalance", blockNumber: spec.block100k, account: spec.nativeAccount, expectedQuantity: `0x${BigInt(spec.block100kBalance).toString(16)}` },
    { id: "code-before-deployment", method: "eth_getCode", blockNumber: spec.beforeDeployment, contract: spec.contract, expectedData: spec.beforeCode },
    { id: "code-at-deployment", method: "eth_getCode", blockNumber: spec.deployment, contract: spec.contract, expectedPredicate: spec.deploymentCode },
    { id: "storage-at-deployment", method: "eth_getStorageAt", blockNumber: spec.deployment, contract: spec.contract, storageKey: spec.storageKey, expectedWord: spec.storageDeployment },
    { id: "storage-at-block2m", method: "eth_getStorageAt", blockNumber: spec.block2m, contract: spec.contract, storageKey: spec.storageKey, expectedWord: spec.storage2m },
    { id: "balanceof-at-deployment", method: "eth_call", blockNumber: spec.deployment, contract: spec.contract, function: "balanceOf(address)", holder: spec.holder, expectedWord: spec.storageDeployment, mustMatchStorage: true },
    { id: "balanceof-at-block2m", method: "eth_call", blockNumber: spec.block2m, contract: spec.contract, function: "balanceOf(address)", holder: spec.holder, expectedWord: spec.storage2m, mustMatchStorage: true },
  ];
  const corrected = canonical({ schemaVersion: 1, revision: MATRIX_REVISION, generatedAt: new Date().toISOString(), sourceSpecificationStatus: "matrix-spec-malformed-block1-hash-width", sourceMalformedHashRetained: false, block1Header: { blockNumber: 1, fullBlockHash: consensusHash, fullHeaderCanonicalDigest: headerDigest, consensusFamilyCount: familyCount, minimumConsensusFamilies: 3 }, stateCanaries, schemaValidation: { fullBlockHash32Bytes: fixed(consensusHash, 32), stateCanaryCount: stateCanaries.length, stateCanariesSchemaValid: stateCanaries.length === 8 && stateCanaries.every((row) => Number.isSafeInteger(row.blockNumber) && row.blockNumber >= 1), substringPrefixSuffixOrPaddingUsed: false }, sourceSpecificationBinding: { path: "hyperevm_archive_endpoints.md", bytes: fs.statSync(ARCHIVE_MATRIX).size, sha256: sha(fs.readFileSync(ARCHIVE_MATRIX)) } }); corrected.matrixDigest = digest(corrected); return corrected;
}

function inventorySecrets(text) { const urls = core.extractUrls(text); const hosts = urls.map((url) => { try { return new URL(url).hostname; } catch { return null; } }).filter(Boolean); const tokens = []; for (const url of urls) try { const parsed = new URL(url); for (const value of parsed.searchParams.values()) if (value.length >= 8) tokens.push(value); for (const part of parsed.pathname.split("/")) if (part.length >= 16) tokens.push(part); } catch {} return { urls: [...new Set(urls)], hosts: [...new Set(hosts)], tokens: [...new Set(tokens)] }; }
function leakCheck(text, secrets, source = false) { if (/(?:https?|wss?):\/\//i.test(text)) throw new Error("scheme-leak"); if (!source) { const hosts = text.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi) || []; if (hosts.some((value) => !/\.(?:json|js|md|txt|sol)$/i.test(value))) throw new Error("host-leak"); } for (const value of [...secrets.urls, ...secrets.hosts, ...secrets.tokens]) if (value.length >= 8 && text.includes(value)) throw new Error("inventory-secret-leak"); }

function report(raw) {
  const groups = raw.fingerprintGroups.map((row) => `| ${row.fingerprint} | ${row.familyCount} |`).join("\n") || "| none | 0 |";
  return `# 🟠 WATCH — EtherFi HyperEVM header consensus R13\n\n**Run:** \`${raw.runId}\`  \n**Classification:** \`${raw.classification}\`  \n**Gates:** \`0/0/false\`; \`fork=false\`\n\n${QUALIFICATION}\n\nThe source matrix is classified \`matrix-spec-malformed-block1-hash-width\`; the malformed 31-byte value was not trusted, padded, or compared by substring/prefix/suffix.\n\nStrict block-1 full-header consensus status=${raw.consensus.status}; agreeing anonymous families=${raw.consensus.familyCount}; threshold=${raw.consensus.threshold}. ${raw.consensus.correctedBlockHash ? `The consensus-derived public full block hash is \`${raw.consensus.correctedBlockHash}\`.` : "No corrected block hash is published."}\n\n| Anonymous full-header fingerprint | Families |\n|---|---:|\n${groups}\n\nCorrected historical matrix emitted=${raw.correctedMatrix.emitted}${raw.correctedMatrix.path ? ` at \`${raw.correctedMatrix.path}\`` : ""}. No behavioral routes, anchors, economics, transactions, fork, signing, or mutation were performed.\n\n**nextReadOnlyStep:** ${raw.nextReadOnlyStep}\n`;
}

async function main() {
  const matrixText = fs.readFileSync(ARCHIVE_MATRIX, "utf8"); const secrets = inventorySecrets(matrixText); const sourceSpec = malformedSpec(matrixText); if (sourceSpec.classification !== "matrix-spec-malformed-block1-hash-width" || sourceSpec.observedBytes !== 31) throw new Error("matrix-malformation-not-confirmed"); const inventory = base.inventoryCandidates(); const candidates = inventory.rows.filter((row) => row.matrixMatched); for (const row of candidates) row.familyKey = core.familyKey(row.url);
  const probed = await core.parallelMap(candidates, 12, probe); const families = aggregateFamilies(probed); const accepted = families.filter((row) => row.accepted); const groups = new Map(); for (const family of accepted) { const set = groups.get(family.fingerprint) || new Set(); set.add(family.familyId); groups.set(family.fingerprint, set); } const sortedGroups = [...groups.entries()].sort((a, b) => b[1].size - a[1].size); const winner = sortedGroups[0]; const familyCount = winner?.[1].size || 0; const consensusPassed = familyCount >= 3; const winnerFamilies = consensusPassed ? accepted.filter((row) => winner[1].has(row.familyId)) : []; const hashes = [...new Set(winnerFamilies.map((row) => row.blockHash))]; const correctedBlockHash = consensusPassed && hashes.length === 1 && fixed(hashes[0], 32) ? hashes[0] : null; if (consensusPassed && !correctedBlockHash) throw new Error("consensus-hash-ambiguous");
  const fingerprintGroups = sortedGroups.map(([fingerprint, set]) => ({ fingerprint, familyCount: set.size })); const exclusions = {}; for (const row of probed.filter((item) => !item.success)) exclusions[row.category] = (exclusions[row.category] || 0) + 1; for (const family of families.filter((row) => !row.internallyConsistent)) exclusions["within-family-header-disagreement"] = (exclusions["within-family-header-disagreement"] || 0) + 1;
  let correctedMatrix = null; if (consensusPassed) { correctedMatrix = parseCorrectedMatrix(matrixText, correctedBlockHash, winner[0], familyCount); writeOwned(CORRECTED_MATRIX, JSON.stringify(correctedMatrix, null, 2) + "\n"); }
  const classification = consensusPassed ? "WATCH/PREFLIGHT-PASS/HYPEREVM-BLOCK1-THREE-FAMILY-FULL-HEADER-CONSENSUS/CORRECTED-MATRIX-EMITTED/NO-BACKEND-INDEPENDENCE-CLAIM" : "WATCH/COVERAGE_OPEN/HYPEREVM-BLOCK1-FULL-HEADER-CONSENSUS-NOT-MET/NO-BACKEND-INDEPENDENCE-CLAIM"; const nextReadOnlyStep = consensusPassed ? "Use only the versioned corrected R13 historical matrix artifact in R14 to rerun exact state canaries; do not modify or trust the malformed source hash." : "Obtain at least three anonymous archive-qualified families agreeing the strict full block-1 canonical header before correcting the matrix or proceeding to R14."; const r12 = readJson(R12_RAW); const predecessor = { status: "IMMUTABLE-PREDECESSOR/HYPEREVM-R12", runId: r12.runId, raw: hashFile(R12_RAW), manifest: hashFile(R12_MANIFEST) };
  const metrics = { archiveCandidatesTested: candidates.length, chain999Candidates: probed.filter((row) => row.chain999).length, strictHeaderCandidates: probed.filter((row) => row.success).length, archiveQualifiedFamilies: accepted.length, fingerprintGroupCount: fingerprintGroups.length, consensusFamilies: familyCount };
  const raw = canonical({ schemaVersion: 1, revision: REVISION, generatedAt: new Date().toISOString(), scanner: SCANNER, agentId: AGENT, role: "critical-research", classification, providerFamilyQualification: QUALIFICATION, backendOperatorIndependenceEstablished: false, backendOperatorIndependenceClaimed: false, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, sourceMatrixSchema: sourceSpec, metrics, fingerprintGroups, consensus: { status: consensusPassed ? "PASS" : "NOT_MET", threshold: 3, familyCount, fullHeaderCanonicalDigest: consensusPassed ? winner[0] : null, correctedBlockHash, exactAgreement: consensusPassed }, correctedMatrix: { emitted: Boolean(correctedMatrix), path: correctedMatrix ? CORRECTED_MATRIX : null, sha256: correctedMatrix ? hashFile(CORRECTED_MATRIX).sha256 : null, matrixDigest: correctedMatrix?.matrixDigest || null, schemaValidated: correctedMatrix?.schemaValidation.fullBlockHash32Bytes === true && correctedMatrix?.schemaValidation.stateCanariesSchemaValid === true }, exclusions, immutablePredecessorR12: predecessor, gates: { routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false }, safety: { readOnly: true, boundedPass: true, archiveMatrixRead: true, rateLimitAwareRetryCount: rateLimitRetries, rawInventoryPersisted: false, endpointIdentifiersPersisted: false, providerNamesPersisted: false, providerDomainsPersisted: false, keysPersisted: false, headersPersisted: false, substringMatchingUsed: false, prefixMatchingUsed: false, suffixMatchingUsed: false, paddingUsed: false, behavioralRoutes: false, anchors: false, economics: false, transactions: false, forkCreated: false, signing: false, mutation: false }, nextReadOnlyStep }); raw.runId = `etherfi-hyperevm-header-consensus-r13-${digest(raw).slice(0, 20)}-${hashFile(SCANNER).sha256.slice(0, 12)}`;
  writeOwned(RAW, JSON.stringify(raw, null, 2) + "\n"); writeOwned(REPORT, report(raw)); const inbox = canonical({ findingId: NAME, revision: REVISION, runId: raw.runId, agentId: AGENT, role: "critical-research", status: classification, classification, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, metrics, consensus: raw.consensus, correctedMatrix: raw.correctedMatrix, exclusions, immutablePredecessorR12: predecessor, artifacts: [SCANNER, VALIDATOR, RAW, MANIFEST, REPORT, INBOX, HANDOFF, R12_RAW, R12_MANIFEST, ...(correctedMatrix ? [CORRECTED_MATRIX] : [])], nextAction: nextReadOnlyStep }); writeOwned(INBOX, JSON.stringify(inbox, null, 2) + "\n"); writeOwned(HANDOFF, `# EtherFi HyperEVM header consensus R13 handoff\n\n- Run \`${raw.runId}\`; classification \`${classification}\`; gates \`0/0/false\`, fork=false.\n- ${QUALIFICATION}\n- Source matrix classification: \`matrix-spec-malformed-block1-hash-width\`; no padding or partial matching.\n- Strict header families/consensus families ${metrics.archiveQualifiedFamilies}/${familyCount}; status=${raw.consensus.status}.\n- Corrected matrix emitted=${raw.correctedMatrix.emitted}${raw.correctedMatrix.path ? ` at \`${raw.correctedMatrix.path}\`` : ""}.\n- No behavior, anchors, economics, transactions, signing, fork, or mutation.\n- Next: ${nextReadOnlyStep}\n`);
  const recordPaths = [SCANNER, VALIDATOR, RAW, REPORT, INBOX, HANDOFF, R12_RAW, R12_MANIFEST, ...(correctedMatrix ? [CORRECTED_MATRIX] : [])]; const records = recordPaths.map(hashFile); const aggregateSha256 = sha(Buffer.from(records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n"))); const manifest = canonical({ schemaVersion: 1, revision: REVISION, runId: raw.runId, generatedAt: raw.generatedAt, classification, algorithm: "sha256", providerFamilyQualification: QUALIFICATION, backendOperatorIndependenceEstablished: false, backendOperatorIndependenceClaimed: false, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, sourceMatrixSchema: sourceSpec, metrics, fingerprintGroups, consensus: raw.consensus, correctedMatrix: raw.correctedMatrix, exclusions, immutablePredecessorR12: predecessor, gates: raw.gates, safety: raw.safety, records, aggregateSha256 }); writeOwned(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  for (const rel of [SCANNER, VALIDATOR, RAW, MANIFEST, REPORT, INBOX, HANDOFF, ...(correctedMatrix ? [CORRECTED_MATRIX] : [])]) leakCheck(fs.readFileSync(abs(rel), "utf8"), secrets, rel === SCANNER || rel === VALIDATOR); process.stdout.write(JSON.stringify({ runId: raw.runId, classification, metrics, consensus: raw.consensus, fingerprintGroups, correctedMatrix: raw.correctedMatrix, exclusions, manifestAggregateSha256: aggregateSha256, checks: raw.safety, nextReadOnlyStep }) + "\n");
}

main().catch((error) => { process.stderr.write(`HyperEVM R13 failed: ${category(error)}\n`); process.exitCode = 1; });
