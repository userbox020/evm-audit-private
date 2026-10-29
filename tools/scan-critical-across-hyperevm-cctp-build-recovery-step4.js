#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const cp = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const REPO = path.join(ROOT, "targets", "across-contracts");
const NAME = "critical-across-hyperevm-cctp-build-recovery-step4";
const AGENT = "reviewer-across-hyperevm-cctp-build-recovery-step4-20260725";
const ACTIVE_CID = "QmT2V8ejSdB8J7wtztQNfGHtZxn85f9WJADvjJC7kdVPtW";
const ACTIVE_DIGEST = "45a326ca9b7fc09c89563df92941dc2675e9d98f23484d0043b02d17cc551343";
const ACTIVE_MULTIHASH = `1220${ACTIVE_DIGEST}`;
const MAX_BYTES = 16 * 1024 * 1024;
const RAW = `reports/raw/fast/${NAME}.json`, SEARCH = `reports/raw/fast/${NAME}-search-ledger.json`, TESTS = `reports/raw/fast/${NAME}-tests.json`, LEAK = `reports/raw/fast/${NAME}-leak-scan.json`, MANIFEST = `reports/raw/fast/${NAME}-manifest.json`, REPORT = `reports/${NAME}.md`, INBOX = `coordination/inbox/review-${NAME}-2026-07-25.json`, HANDOFF = `coordination/handoffs/2026-07-25-${NAME}-handoff.md`, SCANNER = `tools/scan-${NAME}.js`, VALIDATOR = `tools/test-${NAME}.js`;
const STEP3_MANIFEST = "reports/raw/fast/critical-across-hyperevm-cctp-build-recovery-step3-manifest.json", STEP3_RAW = "reports/raw/fast/critical-across-hyperevm-cctp-build-recovery-step3.json", STEP3_SEARCH = "reports/raw/fast/critical-across-hyperevm-cctp-build-recovery-step3-search-ledger.json", STEP3_BUILD = "reports/raw/fast/critical-across-hyperevm-cctp-build-recovery-step3-build-bundle.json";
const abs = (rel) => path.join(ROOT, rel), read = (rel) => fs.readFileSync(abs(rel)), text = (rel) => read(rel).toString("utf8"), json = (rel) => JSON.parse(text(rel));
const sha = (v) => crypto.createHash("sha256").update(v).digest("hex");
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const digest = (value) => sha(Buffer.from(JSON.stringify(canonical(value))));
const hashFile = (rel) => { const body = read(rel); return { path: rel, bytes: body.length, sha256: sha(body) }; };
const write = (rel, body) => { fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), body, "utf8"); };
let checks = 0; function check(ok, label) { checks++; if (!ok) throw new Error(label); }
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function decodeBase58(value) { let n = 0n; for (const char of value) { const index = B58.indexOf(char); if (index < 0) throw new Error("base58-character"); n = n * 58n + BigInt(index); } let hex = n.toString(16); if (hex.length % 2) hex = `0${hex}`; let out = hex ? Buffer.from(hex, "hex") : Buffer.alloc(0); let zeros = 0; while (zeros < value.length && value[zeros] === "1") zeros++; return Buffer.concat([Buffer.alloc(zeros), out]); }
function encodeBase58(buffer) { let n = BigInt(`0x${buffer.toString("hex") || "0"}`), out = ""; while (n) { out = B58[Number(n % 58n)] + out; n /= 58n; } for (const byte of buffer) { if (byte !== 0) break; out = `1${out}`; } return out || "1"; }
function decodeCidV0(cid) { const multihash = decodeBase58(cid); if (multihash.length !== 34 || multihash[0] !== 0x12 || multihash[1] !== 0x20) throw new Error("cidv0-not-sha2-256"); return { cid, multihashHex: multihash.toString("hex"), algorithmCode: "0x12", algorithm: "sha2-256", digestLength: 32, digestHex: multihash.subarray(2).toString("hex") }; }
function verifyPayload(payload, decoded) { const actual = sha(payload); return { bytes: payload.length, sha256: actual, expectedDigest: decoded.digestHex, matches: actual === decoded.digestHex }; }
function commitment(rows) { return sha(Buffer.from(rows.sort().join("\n"))); }
const SECRET_RULES = [/^\.env(?:\..*)?$/i, /^rpc_endpoints\.txt$/i, /^graphql_endpoints\.txt$/i, /^hyperevm_archive_endpoints\.md$/i, /^auth\.json$/i, /^account\.json$/i, /(?:^|[._-])(?:private[-_]?key|seed|mnemonic|credential|secret|keypair|keystore)(?:[._-]|$)/i, /\.(?:pem|p12|pfx|key)$/i, /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i];
function isSecret(name) { return SECRET_RULES.some((rule) => rule.test(name)); }

function fixtureTests() {
  const active = decodeCidV0(ACTIVE_CID); check(active.digestHex === ACTIVE_DIGEST && active.multihashHex === ACTIVE_MULTIHASH, "active-cid-decode");
  const renamedPayload = Buffer.from("step4-renamed-content-addressed-metadata-fixture\n", "utf8"), syntheticDigest = sha(renamedPayload), syntheticCid = encodeBase58(Buffer.from(`1220${syntheticDigest}`, "hex")), syntheticDecoded = decodeCidV0(syntheticCid), positive = verifyPayload(renamedPayload, syntheticDecoded);
  check(positive.matches && !renamedPayload.toString("utf8").includes(syntheticCid), "renamed-payload-content-match-without-cid-text");
  const wrongPayload = Buffer.from(`textual-reference-only:${syntheticCid}\n`, "utf8"), negative = verifyPayload(wrongPayload, syntheticDecoded); check(!negative.matches && wrongPayload.toString("utf8").includes(syntheticCid), "text-cid-wrong-payload-negative");
  const cbor = Buffer.concat([Buffer.from("a164697066735822", "hex"), Buffer.from(`1220${syntheticDigest}`, "hex")]), extracted = cbor.subarray(cbor.indexOf(Buffer.from("1220", "hex"))), cborVerification = verifyPayload(cbor, syntheticDecoded); check(extracted.subarray(0, 34).toString("hex") === `1220${syntheticDigest}` && !cborVerification.matches, "cbor-embedded-multihash-reference-not-payload-match");
  return canonical({ fixtureCount: 4, passed: 4, activeCidDecode: active, positiveRenamedPayload: { filename: "opaque-renamed.bin", containsOwnCidText: false, syntheticCid, ...positive }, negativeTextualCid: { containsCidText: true, ...negative }, cborExtractedMultihash: { extractedMultihashHex: extracted.subarray(0, 34).toString("hex"), cborPayloadSha256: cborVerification.sha256, contentAddressMatch: cborVerification.matches, distinction: "embedded multihash reference is not equality between candidate payload SHA-256 and digest" } });
}

function scanFiles(decoded) {
  const roots = [
    { id: "targets", root: path.join(ROOT, "targets"), mode: "enabled", relevance: "all local target source/artifact/worktree files" },
    { id: "reports", root: path.join(ROOT, "reports"), mode: "enabled", relevance: "all retained reports and source-service snapshots" },
    { id: "tools", root: path.join(ROOT, "tools"), mode: "enabled", relevance: "local audit tools" },
    { id: "sources", root: path.join(ROOT, "sources"), mode: "enabled", relevance: "declared source snapshot root" },
    { id: "workspace-temp", root: path.join(ROOT, "temp"), mode: "enabled", relevance: "workspace-approved temporary snapshots" },
    { id: "approved-temp", root: path.join(process.env.LOCALAPPDATA || "", "Temp", "opencode"), mode: "enabled", relevance: "approved external temporary path and worktrees" },
    { id: "package-cache", root: path.join(process.env.LOCALAPPDATA || "", "Yarn", "Cache"), mode: "enabled", relevance: "package cache candidates by content" },
    { id: "compiler-cache", root: path.join(process.env.APPDATA || "", "svm"), mode: "enabled", relevance: "compiler cache candidates by content" },
    { id: "tool-cache", root: path.join(process.env.USERPROFILE || "", ".local", "share", "opencode", "tool-output"), mode: "candidate-name-only", relevance: "tool cache; uncertain output provenance limits content reads" }
  ];
  const disabledDirNames = new Set(["node_modules", ".git", "cache", "cache-foundry", "zkout", "target"]);
  const state = { filesEnumerated: 0, filesHashed: 0, bytesHashed: 0, activePayloadMatches: [], embeddedCidTextReferences: 0, embeddedMultihashReferences: 0, cborMultihashReferences: 0, metadataCandidates: 0, cborCandidates: 0, ipfsCandidates: 0, rootRows: [], skipped: { secret: { count: 0, bytes: null, rows: [] }, size: { count: 0, bytes: 0, rows: [] }, unreadable: { count: 0, bytes: null, rows: [] }, contentDisabled: { count: 0, bytes: 0, rows: [] }, unsupported: { count: 0, bytes: null, rows: [] } }, candidateRows: [] };
  function skip(category, rootId, relative, size = null) { const row = `${rootId}\0${relative}\0${size ?? "null"}`; state.skipped[category].count++; state.skipped[category].rows.push(sha(Buffer.from(`step4-skip\0${row}`))); if (typeof size === "number" && state.skipped[category].bytes !== null) state.skipped[category].bytes += size; }
  function countDisabled(rootId, base, relativeBase) {
    let entries; try { entries = fs.readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { skip("unreadable", rootId, relativeBase); return; }
    for (const entry of entries) { const relative = `${relativeBase}/${entry.name}`.replace(/^\//, ""), full = path.join(base, entry.name); if (isSecret(entry.name)) { skip("secret", rootId, relative); continue; } if (entry.isDirectory()) countDisabled(rootId, full, relative); else if (entry.isFile()) { let size = 0; try { size = fs.statSync(full).size; } catch { skip("unreadable", rootId, relative); continue; } skip("contentDisabled", rootId, relative, size); } else skip("unsupported", rootId, relative); }
  }
  function looksCandidateName(relative) { return /(?:metadata|cbor|ipfs|bzz|standard[-_]?json|build[-_]?info|sourcify|source[-_]?service)/i.test(relative); }
  function inspect(rootRow, full, relative, size) {
    if (size > MAX_BYTES) { skip("size", rootRow.id, relative, size); return; }
    if (rootRow.mode === "candidate-name-only" && !looksCandidateName(relative)) { skip("contentDisabled", rootRow.id, relative, size); return; }
    let body; try { body = fs.readFileSync(full); } catch { skip("unreadable", rootRow.id, relative); return; }
    const fileSha = sha(body), record = `${rootRow.id}\0${relative.replace(/\\/g, "/")}\0${body.length}\0${fileSha}`; state.filesHashed++; state.bytesHashed += body.length; state.candidateRows.push(record);
    if (fileSha === decoded.digestHex) state.activePayloadMatches.push({ path: `${rootRow.id}:${relative.replace(/\\/g, "/")}`, bytes: body.length, sha256: fileSha });
    const lower = relative.toLowerCase(), bodyText = body.toString("utf8"), multihashBuffer = Buffer.from(decoded.multihashHex, "hex"), hasTextCid = bodyText.includes(decoded.cid), hasMultihash = body.indexOf(multihashBuffer) >= 0 || bodyText.toLowerCase().includes(decoded.multihashHex), hasCborMultihash = body.indexOf(Buffer.concat([Buffer.from("5822", "hex"), multihashBuffer])) >= 0;
    if (hasTextCid) state.embeddedCidTextReferences++; if (hasMultihash) state.embeddedMultihashReferences++; if (hasCborMultihash) state.cborMultihashReferences++;
    if (/(metadata|standard[-_]?json|build[-_]?info|sourcify|source[-_]?service)/i.test(lower)) state.metadataCandidates++;
    if (/\.(cbor|ipfs|bzz)$/i.test(lower) || hasCborMultihash) state.cborCandidates++;
    if (/ipfs/i.test(lower) || hasMultihash || hasTextCid) state.ipfsCandidates++;
  }
  function walk(rootRow, dir, relativeBase = "") {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { skip("unreadable", rootRow.id, relativeBase || "."); return; }
    for (const entry of entries) {
      const relative = path.join(relativeBase, entry.name), full = path.join(dir, entry.name); state.filesEnumerated++;
      if (isSecret(entry.name)) { skip("secret", rootRow.id, relative); continue; }
      if (entry.isDirectory()) { if (disabledDirNames.has(entry.name) && rootRow.id !== "package-cache") countDisabled(rootRow.id, full, relative); else walk(rootRow, full, relative); continue; }
      if (!entry.isFile()) { skip("unsupported", rootRow.id, relative); continue; }
      let size; try { size = fs.statSync(full).size; } catch { skip("unreadable", rootRow.id, relative); continue; } inspect(rootRow, full, relative, size);
    }
  }
  for (const rootRow of roots) {
    const exists = fs.existsSync(rootRow.root), beforeFiles = state.filesHashed, beforeBytes = state.bytesHashed, beforeEnumerated = state.filesEnumerated;
    if (exists) walk(rootRow, rootRow.root);
    state.rootRows.push({ id: rootRow.id, mode: rootRow.mode, relevance: rootRow.relevance, exists, filesEnumerated: state.filesEnumerated - beforeEnumerated, filesHashed: state.filesHashed - beforeFiles, bytesHashed: state.bytesHashed - beforeBytes });
  }
  for (const category of Object.keys(state.skipped)) { state.skipped[category].aggregateSha256 = commitment(state.skipped[category].rows); delete state.skipped[category].rows; }
  const candidateAggregateSha256 = commitment(state.candidateRows); delete state.candidateRows;
  state.activePayloadMatches.sort((a, b) => a.path.localeCompare(b.path));
  return { declaredRoots: roots.map((row) => ({ id: row.id, mode: row.mode, relevance: row.relevance, exists: fs.existsSync(row.root) })), maxCandidateBytes: MAX_BYTES, filenameIndependentContentHashing: true, contentAddressRule: "sha256(candidate payload bytes) == CIDv0 sha2-256 multihash digest", absenceScope: "Only declared existing roots, decoded Across Git blobs, and policy-enabled files up to the size cap; content-disabled, secret, oversized, unreadable, unsupported, absent roots, unrelated Git repositories, and public networks are outside the negative conclusion.", candidateAggregateSha256, ...state };
}

function scanAcrossGit(decoded) {
  const checkRows = cp.execFileSync("git", ["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], { cwd: REPO, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 }).trim().split(/\r?\n/).filter(Boolean);
  const result = { objectsEnumerated: checkRows.length, blobsEnumerated: 0, blobsHashed: 0, bytesHashed: 0, activePayloadMatches: [], skippedSize: 0, skippedNonBlob: 0, unreadable: 0, rows: [] };
  for (const line of checkRows) {
    const [oid, type, sizeText] = line.split(" "), size = Number(sizeText);
    if (type !== "blob") { result.skippedNonBlob++; continue; } result.blobsEnumerated++;
    if (size > MAX_BYTES) { result.skippedSize++; continue; }
    let body; try { body = cp.execFileSync("git", ["cat-file", "blob", oid], { cwd: REPO, encoding: "buffer", maxBuffer: MAX_BYTES + 1024 }); } catch { result.unreadable++; continue; }
    const contentSha = sha(body); result.blobsHashed++; result.bytesHashed += body.length; result.rows.push(`${oid}\0${body.length}\0${contentSha}`); if (contentSha === decoded.digestHex) result.activePayloadMatches.push({ gitObject: oid, bytes: body.length, sha256: contentSha });
  }
  result.aggregateSha256 = commitment(result.rows); delete result.rows; return result;
}
function leakScan(paths) { const findings = []; for (const rel of paths) { const body = text(rel); if (/(?:https?|wss?):\/\//i.test(body)) findings.push({ path: rel, category: "url-scheme" }); if (/(?:authorization|x-api-key|api-key|bearer)\s*[:=]/i.test(body)) findings.push({ path: rel, category: "credential-shape" }); } return { scannedPaths: paths, findingCount: findings.length, findings, passed: findings.length === 0, endpointInventoryCompared: false }; }

function main() {
  for (const rel of [RAW, SEARCH, TESTS, LEAK, MANIFEST, REPORT, INBOX, HANDOFF]) if (fs.existsSync(abs(rel))) fs.rmSync(abs(rel), { force: true });
  const decoded = decodeCidV0(ACTIVE_CID); check(decoded.digestHex === ACTIVE_DIGEST && decoded.multihashHex === ACTIVE_MULTIHASH, "active-cid-binding");
  const fixtures = fixtureTests(), files = scanFiles(decoded), git = scanAcrossGit(decoded), activePayloadCount = files.activePayloadMatches.length + git.activePayloadMatches.length;
  check(files.filenameIndependentContentHashing, "filename-independent-policy"); check(files.filesHashed > 0 && files.bytesHashed > 0, "candidate-files-hashed"); check(files.rootRows.find((x) => x.id === "package-cache").filesHashed > 0 && files.rootRows.find((x) => x.id === "compiler-cache").filesHashed > 0, "package-compiler-content-hashed");
  check(files.skipped.secret.count > 0 && files.skipped.size.count > 0 && files.skipped.contentDisabled.count > 0, "skip-categories-accounted"); check(Object.values(files.skipped).every((row) => /^[0-9a-f]{64}$/.test(row.aggregateSha256)), "skip-commitments"); check(git.blobsHashed > 0 && /^[0-9a-f]{64}$/.test(git.aggregateSha256), "git-content-hash-search");
  check(activePayloadCount === 0, "active-content-addressed-payload-found");
  const step3Raw = json(STEP3_RAW), step3Build = json(STEP3_BUILD), step3Search = json(STEP3_SEARCH);
  const preserved = canonical({ exactMatch: step3Raw.exactMatch, pipelineStage: step3Raw.pipeline.stage, deployedReceiveTransportBeforeNonce: step3Raw.semantics.deployedReceiveTransportBeforeNonce, deployedSharedGuardCoverage: step3Raw.semantics.deployedSharedGuardCoverage, candidateCount: step3Raw.candidate.count, nearestCommit: step3Raw.candidate.nearestCommit, candidateRuntimeSha256: step3Build.artifact.runtimeSha256, comparatorSha256: step3Build.comparator.sha256, creationSha256: step3Raw.retained.creationSha256, normalizedRuntimeSha256: step3Raw.retained.normalizedRuntimeSha256, immutableReferenceCount: step3Raw.retained.immutableReferenceCount, linkReferenceCount: step3Raw.retained.linkReferenceCount, deployments: step3Raw.retained.deployments, predecessorSearchAggregateSha256: hashFile(STEP3_SEARCH).sha256 });
  check(!preserved.exactMatch && preserved.pipelineStage === 1 && preserved.deployedReceiveTransportBeforeNonce === null && preserved.deployedSharedGuardCoverage === null, "preserved-null-semantics");
  const ledger = canonical({ schemaVersion: 1, generatedAt: new Date().toISOString(), activeCid: decoded, verification: { candidatePayloadDefinition: "exact file/blob bytes read under policy", rule: "SHA-256(payload bytes) equals decoded CIDv0 digest", activePayloadCount, failClosed: true, note: "CBOR/IPFS multihash extraction is tracked separately and never treated as payload equality." }, fixtures, fileSearch: files, gitObjectSearch: git, preservedStep3: preserved, publicRetrievalGate: { status: "PROPOSAL-ONLY/NOT-EXECUTED", requiredAuthorization: "separate explicit HTTP/web authorization", retrievalTarget: "raw IPFS CIDv0 block bytes", requiredVerification: `sha2-256(raw block bytes) == ${ACTIVE_DIGEST}`, followUp: "decode DAG-PB/UnixFS framing, recover metadata and complete standard-json/source closure, then require full normalized runtime equality", rpcRequired: false, signingRequired: false } });
  write(SEARCH, JSON.stringify(ledger, null, 2) + "\n");
  const raw = canonical({ schemaVersion: 1, generatedAt: new Date().toISOString(), runId: `${NAME}-${digest({ files: files.candidateAggregateSha256, git: git.aggregateSha256, skips: files.skipped, fixtures, predecessor: preserved.comparatorSha256 })}`, agentId: AGENT, role: "reviewer", classification: "WATCH/COVERAGE-BLOCKED/CONTENT-ADDRESSED-LOCAL-SEARCH-NEGATIVE/ACTIVE-CID-PAYLOAD-ABSENT-IN-DECLARED-SCOPE/STEP4", exactMatch: false, activePayloadCount, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, search: { ledger: SEARCH, decodedCid: decoded, candidateFilesHashed: files.filesHashed, candidateBytesHashed: files.bytesHashed, gitBlobsHashed: git.blobsHashed, gitBlobBytesHashed: git.bytesHashed, skipped: files.skipped, activePayloadCount, embeddedReferences: { cidText: files.embeddedCidTextReferences, multihash: files.embeddedMultihashReferences, cborMultihash: files.cborMultihashReferences }, candidateAggregateSha256: files.candidateAggregateSha256, gitAggregateSha256: git.aggregateSha256, absenceScope: files.absenceScope }, fixtures: { count: fixtures.fixtureCount, passed: fixtures.passed }, preserved, pipeline: { stage: 1, total: 5, exactActiveCctpBuildRecovered: false, deployedSemantics: null, publicRetrievalGateOpened: false, forkGateOpened: false }, nextGate: `Seek separate approval for public content-address retrieval of raw IPFS block ${ACTIVE_CID}; verify SHA-256 block bytes equal ${ACTIVE_DIGEST}, decode its DAG-PB/UnixFS payload, recover complete metadata/standard-json/source closure, then require full normalized runtime equality.`, activityScope: { offlineOnly: true, endpointInventoryReads: 0, rpcCalls: 0, httpRequests: 0, webRequests: 0, forkCreated: false, liveCalls: 0, signedTransactions: 0, broadcasts: 0, secretFileReads: 0, productionMutation: false, publicRetrievalExecuted: false } });
  write(RAW, JSON.stringify(raw, null, 2) + "\n");
  write(TESTS, JSON.stringify(canonical({ schemaVersion: 1, passed: true, scannerChecksPassed: checks, scannerChecksTotal: checks, fixtures, searchAssertions: { filenameIndependent: true, packageCacheContentHashed: true, compilerCacheContentHashed: true, skippedCategoriesCommitted: true, gitBlobsDecodedAndHashed: true, activePayloadCount } }), null, 2) + "\n");
  write(REPORT, `# 🟠 WATCH — Across HyperEVM CCTP recovery Step 4\n\n**Classification:** \`${raw.classification}\`  \n**Active payload count:** \`0\`; **pipeline:** \`1/5\`; deployed semantics remain null.\n\n## Content-address correction\n\nCIDv0 \`${ACTIVE_CID}\` decodes to multihash \`${ACTIVE_MULTIHASH}\`: sha2-256, 32-byte digest \`${ACTIVE_DIGEST}\`. Step 4 compares SHA-256 of candidate bytes directly to that digest regardless of filename or self-reference text. CBOR-extracted multihashes are references only, not content matches.\n\nAcross declared roots, ${files.filesHashed} files / ${files.bytesHashed} bytes and ${git.blobsHashed} decoded Across Git blobs / ${git.bytesHashed} bytes were hashed. Package and compiler caches were included by content where policy-safe. Active payloads=${activePayloadCount}. Embedded references were tracked separately: CID text=${files.embeddedCidTextReferences}, multihash=${files.embeddedMultihashReferences}, CBOR multihash=${files.cborMultihashReferences}.\n\nSkipped categories are name-free and commitment-bound: secret=${files.skipped.secret.count}, oversized=${files.skipped.size.count}, unreadable=${files.skipped.unreadable.count}, content-disabled=${files.skipped.contentDisabled.count}, unsupported=${files.skipped.unsupported.count}. The absence conclusion is limited to the declared enabled roots, decoded Across blobs, size cap, and readable policy-safe content; it is not global.\n\nFixtures ${fixtures.passed}/${fixtures.fixtureCount} pass: renamed content without CID text matches its synthetic digest; CID text in wrong bytes does not; CBOR-extracted multihash remains distinct from payload equality. Step 3 candidate/build/runtime/immutable findings and null deployed semantics are preserved.\n\n## Public retrieval gate\n\n${raw.nextGate}\n`);
  const inbox = canonical({ findingId: NAME, runId: raw.runId, agentId: AGENT, role: "reviewer", status: raw.classification, classification: raw.classification, exactMatch: false, activePayloadCount, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, summary: `Filename-independent content hashing covered ${files.filesHashed} safe files and ${git.blobsHashed} decoded Across blobs; no bytes hash to the active CID digest. Skipped categories are aggregate-committed and scope remains local, not global.`, artifacts: [RAW, SEARCH, TESTS, LEAK, MANIFEST, REPORT, SCANNER, VALIDATOR, HANDOFF], nextAction: raw.nextGate }); write(INBOX, JSON.stringify(inbox, null, 2) + "\n");
  write(HANDOFF, `# Across HyperEVM CCTP recovery Step 4 handoff\n\n- Classification \`${raw.classification}\`; activePayloadCount=0; pipeline 1/5; deployed semantics null.\n- CID digest ${ACTIVE_DIGEST}; candidate files ${files.filesHashed}/${files.bytesHashed} bytes; decoded Git blobs ${git.blobsHashed}/${git.bytesHashed} bytes.\n- Skips: secret ${files.skipped.secret.count}, size ${files.skipped.size.count}, unreadable ${files.skipped.unreadable.count}, content-disabled ${files.skipped.contentDisabled.count}, unsupported ${files.skipped.unsupported.count}; all category commitments retained without names/content.\n- Fixtures ${fixtures.passed}/${fixtures.fixtureCount}; content hash works without CID text, wrong textual CID is negative, CBOR reference is distinct.\n- No inventory/RPC/HTTP/web/fork/live/signing/public retrieval.\n- Next: ${raw.nextGate}\n`);
  const leak = leakScan([RAW, SEARCH, TESTS, REPORT, INBOX, HANDOFF]); write(LEAK, JSON.stringify(canonical(leak), null, 2) + "\n"); if (!leak.passed) throw new Error("leak-scan");
  const records = [SCANNER, VALIDATOR, SEARCH, RAW, TESTS, LEAK, REPORT, INBOX, HANDOFF].map(hashFile), aggregateSha256 = sha(Buffer.from(records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n")));
  const step3Manifest = json(STEP3_MANIFEST), predecessorFiles = [hashFile(STEP3_MANIFEST), ...step3Manifest.records.map((x) => hashFile(x.path))];
  const manifest = canonical({ schemaVersion: 1, runId: raw.runId, classification: raw.classification, activePayloadCount, algorithm: "sha256", aggregateSha256, records, recursivePredecessor: { step3Manifest: hashFile(STEP3_MANIFEST), step3ClaimedAggregateSha256: step3Manifest.aggregateSha256, recordCount: step3Manifest.records.length, files: predecessorFiles, aggregateSha256: sha(Buffer.from(predecessorFiles.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n"))) }, search: { candidateFilesHashed: files.filesHashed, candidateBytesHashed: files.bytesHashed, gitBlobsHashed: git.blobsHashed, gitBlobBytesHashed: git.bytesHashed, activePayloadCount, candidateAggregateSha256: files.candidateAggregateSha256, gitAggregateSha256: git.aggregateSha256, skipped: files.skipped }, fixtures: { count: fixtures.fixtureCount, passed: fixtures.passed }, tests: { scannerChecksPassed: checks, scannerChecksTotal: checks }, gates: { routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false }, leakScanPassed: true, activityScope: raw.activityScope }); write(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ ok: true, runId: raw.runId, classification: raw.classification, decodedDigest: ACTIVE_DIGEST, candidateFilesHashed: files.filesHashed, candidateBytesHashed: files.bytesHashed, gitBlobsHashed: git.blobsHashed, gitBlobBytesHashed: git.bytesHashed, skipped: Object.fromEntries(Object.entries(files.skipped).map(([k, v]) => [k, v.count])), fixtures: `${fixtures.passed}/${fixtures.fixtureCount}`, scannerChecks: `${checks}/${checks}`, activePayloadCount, records: records.length, aggregateSha256, pipeline: "1/5", nextGate: raw.nextGate }) + "\n");
}
try { main(); } catch (error) { process.stderr.write(JSON.stringify({ ok: false, category: String(error.message || error) }) + "\n"); process.exit(1); }
