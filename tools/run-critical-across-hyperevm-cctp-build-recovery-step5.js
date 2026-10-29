#!/usr/bin/env node
"use strict";

// Network-capable only after a separately supplied, hash-bound approval. The
// default invocation is offline/readiness-only. The sole network operation is
// one fixed trustless-gateway raw-block GET for the active CID.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { TextDecoder } = require("util");

const ROOT = path.resolve(__dirname, "..");
const NAME = "critical-across-hyperevm-cctp-build-recovery-step5";
const MANIFEST_REL = `reports/raw/fast/${NAME}-manifest.json`;
const APPROVAL_REL = `reports/raw/fast/${NAME}-approval.json`;
const LOCK_REL = `reports/raw/fast/${NAME}-execution.lock.json`;
const RESULT_REL = `reports/raw/fast/${NAME}-retrieval-result.json`;
const RAW_BLOCK_REL = `reports/raw/verified/${NAME}-active.dagpb`;
const RUNNER_REL = `tools/run-${NAME}.js`;
const STEP4_AGGREGATE = "7d243499fe214f74312f53a0d6f1c7aed18ee51b8a0bd99b392fa8e784fba291";
const ACTIVE_CID = "QmT2V8ejSdB8J7wtztQNfGHtZxn85f9WJADvjJC7kdVPtW";
const ACTIVE_DIGEST = "45a326ca9b7fc09c89563df92941dc2675e9d98f23484d0043b02d17cc551343";
const FIXED_GATEWAY_ORIGIN = "https://ipfs.io";
const FIXED_GATEWAY_PATH = `/ipfs/${ACTIVE_CID}`;
const FIXED_GATEWAY_QUERY = "format=raw";
const POLICY = Object.freeze({
  maxRequests: 1,
  maxResponseBytes: 16 * 1024 * 1024,
  requestTimeoutMs: 20_000,
  approvalStartWindowMs: 15 * 60 * 1000,
  retries: 0,
  redirects: "manual",
  maxDecodeDepth: 2,
  maxProtobufFields: 4096,
  maxLinks: 1024,
  maxLinkCidBytes: 128,
  maxLinkNameBytes: 1024,
  maxBlockSizes: 1024,
  maxVarintBytes: 10,
  allowedContentTypes: ["application/vnd.ipld.raw", "application/vnd.ipld.dag-pb", "application/octet-stream"],
});

const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const canonicalJson = (value) => JSON.stringify(canonical(value));
const aggregateRecords = (records) => sha(Buffer.from(records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n")));
const hashFile = (file) => { const body = fs.readFileSync(file); return { bytes: body.length, sha256: sha(body) }; };

class RetrievalStop extends Error {
  constructor(code, stage = "preflight") { super(code); this.code = code; this.stage = stage; }
}

function stop(code, stage) { throw new RetrievalStop(code, stage); }
function safePath(root, relative) {
  if (typeof relative !== "string" || path.isAbsolute(relative) || relative.includes("\0")) stop("PATH_INVALID");
  const resolved = path.resolve(root, relative), prefix = `${path.resolve(root)}${path.sep}`;
  if (!resolved.startsWith(prefix)) stop("PATH_OUTSIDE_WORKSPACE");
  return resolved;
}

function readJson(file, code) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { stop(code); }
}

function validateApproval(approval, binding, now, mode = "network") {
  if (!approval || typeof approval !== "object") stop("APPROVAL_REQUIRED");
  const expectedDecision = mode === "network" ? "APPROVED" : "APPROVED_FOR_MOCK_FIXTURE_ONLY";
  if (approval.decision !== expectedDecision) stop("APPROVAL_DECISION_INVALID");
  if (approval.exactlyOneExecution !== true) stop("APPROVAL_SINGLE_EXECUTION_REQUIRED");
  if (typeof approval.decisionTimestamp !== "string") stop("APPROVAL_TIMESTAMP_REQUIRED");
  const decidedAt = Date.parse(approval.decisionTimestamp);
  if (!Number.isFinite(decidedAt) || now < decidedAt || now - decidedAt > POLICY.approvalStartWindowMs) stop("APPROVAL_START_WINDOW_INVALID");
  if (!/^[0-9a-f]{64}$/.test(String(approval.executionId || ""))) stop("APPROVAL_EXECUTION_ID_INVALID");
  for (const key of ["proposalRunId", "packageManifestAggregateSha256", "runnerSha256", "cid", "digestSha256"])
    if (approval[key] !== binding[key]) stop("APPROVAL_BINDING_MISMATCH");
  return canonical({ decision: approval.decision, decisionTimestamp: approval.decisionTimestamp, executionId: approval.executionId, approvalCommitment: sha(Buffer.from(canonicalJson(approval))) });
}

function verifyPackage({ workspaceRoot = ROOT, manifestRelativePath = MANIFEST_REL, approval, now = Date.now(), mode = "network" }) {
  const manifestPath = safePath(workspaceRoot, manifestRelativePath);
  if (!fs.existsSync(manifestPath)) stop("PACKAGE_MANIFEST_MISSING");
  const manifest = readJson(manifestPath, "PACKAGE_MANIFEST_INVALID");
  if (manifest.proposalStatus !== "REVIEW_REQUESTED/NOT_AUTHORIZED/NOT_EXECUTED") stop("PACKAGE_STATUS_INVALID");
  if (manifest.predecessorBinding?.step4AggregateSha256 !== STEP4_AGGREGATE) stop("STEP4_AGGREGATE_MISMATCH");
  if (manifest.activeCid?.cid !== ACTIVE_CID || manifest.activeCid?.digestSha256 !== ACTIVE_DIGEST) stop("ACTIVE_CID_BINDING_MISMATCH");
  if (!Array.isArray(manifest.records) || manifest.records.length === 0) stop("PACKAGE_RECORDS_INVALID");
  const actual = manifest.records.map((record) => {
    if (!record || typeof record.path !== "string") stop("PACKAGE_RECORD_INVALID");
    const current = { path: record.path, ...hashFile(safePath(workspaceRoot, record.path)) };
    if (current.bytes !== record.bytes || current.sha256 !== record.sha256) stop("PACKAGE_RECORD_HASH_MISMATCH");
    return current;
  });
  if (aggregateRecords(actual) !== manifest.aggregateSha256) stop("PACKAGE_AGGREGATE_MISMATCH");
  const runner = actual.find((row) => row.path === RUNNER_REL);
  if (!runner) stop("RUNNER_NOT_MANIFEST_BOUND");
  const binding = {
    proposalRunId: manifest.runId,
    packageManifestAggregateSha256: manifest.aggregateSha256,
    runnerSha256: runner.sha256,
    cid: ACTIVE_CID,
    digestSha256: ACTIVE_DIGEST,
  };
  const approved = validateApproval(approval, binding, now, mode);
  return { manifest, binding, approved };
}

function readVarint(buffer, state) {
  let value = 0n, shift = 0n;
  for (let count = 0; count < POLICY.maxVarintBytes; count++) {
    if (state.offset >= buffer.length) stop("PROTOBUF_TRUNCATED", "decode");
    const byte = buffer[state.offset++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) stop("PROTOBUF_INTEGER_UNSAFE", "decode");
      return Number(value);
    }
    shift += 7n;
  }
  stop("PROTOBUF_VARINT_TOO_LONG", "decode");
}

function parseFields(buffer) {
  const fields = [], state = { offset: 0 };
  while (state.offset < buffer.length) {
    if (fields.length >= POLICY.maxProtobufFields) stop("PROTOBUF_FIELD_CAP", "decode");
    const key = readVarint(buffer, state), number = Math.floor(key / 8), wire = key % 8;
    if (number < 1 || ![0, 2].includes(wire)) stop("PROTOBUF_SCHEMA_INVALID", "decode");
    if (wire === 0) fields.push({ number, wire, value: readVarint(buffer, state) });
    else {
      const length = readVarint(buffer, state);
      if (length > POLICY.maxResponseBytes || state.offset + length > buffer.length) stop("PROTOBUF_LENGTH_INVALID", "decode");
      fields.push({ number, wire, value: buffer.subarray(state.offset, state.offset + length) });
      state.offset += length;
    }
  }
  return fields;
}

function exactly(fields, number, wire, required = false) {
  const rows = fields.filter((field) => field.number === number);
  if (rows.some((field) => field.wire !== wire) || rows.length > 1 || (required && rows.length !== 1)) stop("PROTOBUF_SCHEMA_INVALID", "decode");
  return rows[0]?.value;
}

function decodeLink(buffer) {
  const fields = parseFields(buffer);
  if (fields.some((field) => ![1, 2, 3].includes(field.number))) stop("DAGPB_LINK_SCHEMA_INVALID", "decode");
  const cidBytes = exactly(fields, 1, 2, true), nameBytes = exactly(fields, 2, 2, false), totalSize = exactly(fields, 3, 0, false);
  if (cidBytes.length < 2 || cidBytes.length > POLICY.maxLinkCidBytes) stop("DAGPB_LINK_CID_INVALID", "decode");
  if (nameBytes && nameBytes.length > POLICY.maxLinkNameBytes) stop("DAGPB_LINK_NAME_CAP", "decode");
  if (nameBytes) { try { new TextDecoder("utf-8", { fatal: true }).decode(nameBytes); } catch { stop("DAGPB_LINK_NAME_UTF8_INVALID", "decode"); } }
  return { cidCommitmentSha256: sha(cidBytes), cidBytes: cidBytes.length, nameBytes: nameBytes?.length || 0, totalSize: totalSize ?? null };
}

function decodeUnixFs(buffer) {
  const fields = parseFields(buffer);
  if (fields.some((field) => ![1, 2, 3, 4, 5, 6, 7, 8].includes(field.number))) stop("UNIXFS_SCHEMA_INVALID", "decode");
  const type = exactly(fields, 1, 0, true), data = exactly(fields, 2, 2, false), fileSize = exactly(fields, 3, 0, false);
  if (![0, 1, 2, 3, 4, 5].includes(type)) stop("UNIXFS_TYPE_INVALID", "decode");
  const blockSizes = fields.filter((field) => field.number === 4);
  if (blockSizes.length > POLICY.maxBlockSizes || blockSizes.some((field) => field.wire !== 0)) stop("UNIXFS_BLOCKSIZE_CAP", "decode");
  for (const singleton of [5, 6, 7, 8]) if (fields.filter((field) => field.number === singleton).length > 1) stop("UNIXFS_SCHEMA_INVALID", "decode");
  if (data && data.length > POLICY.maxResponseBytes) stop("UNIXFS_INLINE_DATA_CAP", "decode");
  return {
    type,
    inlineMetadataBytesExist: Boolean(data && data.length > 0),
    inlineMetadataBytes: data?.length || 0,
    inlineMetadataSha256: data?.length ? sha(data) : null,
    declaredFileSize: fileSize ?? null,
    blockSizeCount: blockSizes.length,
  };
}

function decodeDagPbUnixFs(block) {
  if (!Buffer.isBuffer(block) || block.length === 0 || block.length > POLICY.maxResponseBytes) stop("DAGPB_BLOCK_SIZE_INVALID", "decode");
  const fields = parseFields(block);
  if (fields.some((field) => ![1, 2].includes(field.number))) stop("DAGPB_NODE_SCHEMA_INVALID", "decode");
  const dataRows = fields.filter((field) => field.number === 1), linkRows = fields.filter((field) => field.number === 2);
  if (dataRows.length !== 1 || dataRows[0].wire !== 2 || linkRows.some((field) => field.wire !== 2)) stop("DAGPB_NODE_SCHEMA_INVALID", "decode");
  if (linkRows.length > POLICY.maxLinks) stop("DAGPB_LINK_CAP", "decode");
  const unixFs = decodeUnixFs(dataRows[0].value), links = linkRows.map((field) => decodeLink(field.value));
  return canonical({ codec: "dag-pb", unixFs, linkCount: links.length, linkCidCommitments: links.map((link, index) => ({ index, ...link })), linksFollowed: 0, decodeDepthUsed: links.length ? 2 : 1, maxDecodeDepth: POLICY.maxDecodeDepth });
}

function createSingleRequestTransport(fetchImpl) {
  let requests = 0;
  return {
    get count() { return requests; },
    async request(url, options) {
      if (requests >= POLICY.maxRequests) stop("SECOND_REQUEST_PREVENTED", "transport");
      requests++;
      return fetchImpl(url, options);
    },
  };
}

async function readBodyBounded(body, cap) {
  if (!body || typeof body[Symbol.asyncIterator] !== "function") stop("HTTP_BODY_STREAM_REQUIRED", "transport");
  const chunks = []; let bytes = 0;
  for await (const value of body) {
    const chunk = Buffer.from(value); bytes += chunk.length;
    if (bytes > cap) stop("RESPONSE_SIZE_CAP_EXCEEDED", "transport");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

async function fetchVerifiedRawBlock({ fetchImpl, expectedDigest = ACTIVE_DIGEST, timeoutMs = POLICY.requestTimeoutMs, maxBytes = POLICY.maxResponseBytes }) {
  const transport = createSingleRequestTransport(fetchImpl), controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new RetrievalStop("REQUEST_TIMEOUT", "transport")); }, timeoutMs); });
  const task = (async () => {
    const url = `${FIXED_GATEWAY_ORIGIN}${FIXED_GATEWAY_PATH}?${FIXED_GATEWAY_QUERY}`;
    const response = await transport.request(url, { method: "GET", redirect: "manual", signal: controller.signal, headers: { accept: "application/vnd.ipld.raw" } });
    if (!response || !Number.isInteger(response.status)) stop("HTTP_RESPONSE_INVALID", "transport");
    if (response.status >= 300 && response.status < 400) stop("HTTP_REDIRECT_REJECTED", "transport");
    if (response.status !== 200 || response.ok !== true || response.redirected === true) stop("HTTP_SUCCESS_REQUIRED", "transport");
    const contentType = String(response.headers?.get?.("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    if (!POLICY.allowedContentTypes.includes(contentType)) stop("CONTENT_TYPE_REJECTED", "transport");
    const declaredLength = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) stop("RESPONSE_SIZE_CAP_EXCEEDED", "transport");
    const block = await readBodyBounded(response.body, maxBytes), observedDigest = sha(block);
    if (observedDigest !== expectedDigest) stop("RAW_BLOCK_HASH_MISMATCH", "verification");
    return { block, observedDigest, requestCount: transport.count, contentTypeAccepted: true };
  })();
  try { return await Promise.race([task, timeout]); }
  catch (error) { if (error?.name === "AbortError") stop("REQUEST_TIMEOUT", "transport"); throw error; }
  finally { clearTimeout(timer); }
}

class FileExecutionGuard {
  constructor(root = ROOT) { this.root = root; }
  acquire(approved) {
    const lock = safePath(this.root, LOCK_REL), result = safePath(this.root, RESULT_REL), raw = safePath(this.root, RAW_BLOCK_REL);
    if ([lock, result, raw].some((file) => fs.existsSync(file))) stop("EXECUTION_ALREADY_CONSUMED");
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    const record = canonical({ schemaVersion: 1, status: "STARTED/SINGLE-EXECUTION-CONSUMED", executionId: approved.executionId, approvalCommitment: approved.approvalCommitment, responseBytesPersisted: 0, gatewayUrlPersisted: false, requestHeadersPersisted: false, responseHeadersPersisted: false });
    try { fs.writeFileSync(lock, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" }); } catch { stop("EXECUTION_ALREADY_CONSUMED"); }
  }
}

class MemoryExecutionGuard {
  constructor() { this.consumed = false; }
  acquire() { if (this.consumed) stop("EXECUTION_ALREADY_CONSUMED"); this.consumed = true; }
}

function sanitizedResult(verified, decoded, packageInfo) {
  return canonical({
    schemaVersion: 1,
    status: "VERIFIED/RAW-BLOCK-HASH-MATCH/DAG-PB-UNIXFS-DECODED/LINKS-NOT-FOLLOWED",
    proposalRunId: packageInfo.binding.proposalRunId,
    packageManifestAggregateSha256: packageInfo.binding.packageManifestAggregateSha256,
    runnerSha256: packageInfo.binding.runnerSha256,
    cid: ACTIVE_CID,
    digestSha256: verified.observedDigest,
    rawBlockBytes: verified.block.length,
    requestCount: verified.requestCount,
    maxRequests: POLICY.maxRequests,
    contentTypeAccepted: verified.contentTypeAccepted,
    decoded,
    gatewayId: "public-ipfs-io-trustless-raw",
    gatewayUrlPersisted: false,
    gatewayQueryPersisted: false,
    requestHeadersPersisted: false,
    responseHeadersPersisted: false,
    linksFetched: 0,
    cidEnumerationPerformed: false,
    rpcOrInventoryReads: 0,
  });
}

async function runRetrieval(options = {}) {
  const workspaceRoot = options.workspaceRoot || ROOT, mode = options.mode || "network";
  const packageInfo = (options.packageVerifier || verifyPackage)({ workspaceRoot, manifestRelativePath: options.manifestRelativePath || MANIFEST_REL, approval: options.approval, now: options.now ?? Date.now(), mode });
  const guard = options.guard || new FileExecutionGuard(workspaceRoot);
  guard.acquire(packageInfo.approved);
  const verified = await fetchVerifiedRawBlock({ fetchImpl: options.fetchImpl || global.fetch, expectedDigest: options.expectedDigest || ACTIVE_DIGEST, timeoutMs: options.timeoutMs || POLICY.requestTimeoutMs, maxBytes: options.maxBytes || POLICY.maxResponseBytes });
  const decoded = decodeDagPbUnixFs(verified.block); // Hash equality is already established.
  const result = sanitizedResult(verified, decoded, packageInfo);
  if (options.persist !== false) {
    const rawPath = safePath(workspaceRoot, RAW_BLOCK_REL), resultPath = safePath(workspaceRoot, RESULT_REL);
    fs.mkdirSync(path.dirname(rawPath), { recursive: true });
    fs.writeFileSync(rawPath, verified.block, { flag: "wx" });
    fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  }
  return result;
}

function parseCli(argv) {
  if (argv.length === 0) return { execute: false };
  if (argv.length !== 3 || argv[0] !== "--execute" || argv[1] !== "--approval") stop("CLI_ARGUMENTS_INVALID");
  const supplied = path.resolve(argv[2]), expected = safePath(ROOT, APPROVAL_REL);
  if (supplied !== expected) stop("APPROVAL_PATH_NOT_FIXED");
  return { execute: true, approvalPath: supplied };
}

module.exports = { NAME, ROOT, MANIFEST_REL, APPROVAL_REL, LOCK_REL, RESULT_REL, RAW_BLOCK_REL, RUNNER_REL, STEP4_AGGREGATE, ACTIVE_CID, ACTIVE_DIGEST, FIXED_GATEWAY_ORIGIN, FIXED_GATEWAY_PATH, POLICY, RetrievalStop, sha, canonical, canonicalJson, aggregateRecords, validateApproval, verifyPackage, parseFields, decodeUnixFs, decodeLink, decodeDagPbUnixFs, createSingleRequestTransport, readBodyBounded, fetchVerifiedRawBlock, FileExecutionGuard, MemoryExecutionGuard, sanitizedResult, runRetrieval, parseCli };

if (require.main === module) {
  (async () => {
    const args = parseCli(process.argv.slice(2));
    if (!args.execute) {
      process.stdout.write(`${JSON.stringify({ status: "REVIEW_REQUESTED/NOT_AUTHORIZED/NOT_EXECUTED", networkInvoked: false, requestCount: 0, maxRequests: POLICY.maxRequests, maxResponseBytes: POLICY.maxResponseBytes, requestTimeoutMs: POLICY.requestTimeoutMs, approvalStartWindowMs: POLICY.approvalStartWindowMs, approvalRequired: true })}\n`);
      return;
    }
    const approval = readJson(args.approvalPath, "APPROVAL_FILE_INVALID");
    const result = await runRetrieval({ approval, mode: "network" });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  })().catch((error) => {
    const failure = error instanceof RetrievalStop ? error : new RetrievalStop("UNEXPECTED_RUNNER_FAILURE", "internal");
    process.stderr.write(`${JSON.stringify({ status: "STOPPED", category: failure.code, stage: failure.stage, responseBodyPersisted: false, responseHeadersPersisted: false })}\n`);
    process.exitCode = 1;
  });
}
