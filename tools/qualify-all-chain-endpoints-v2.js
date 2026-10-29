#!/usr/bin/env node
'use strict';

/*
 * Bounded, read-only, aggregate-only endpoint capability qualification.
 * Endpoint material is deliberately retained only in process memory.
 */
const crypto = require('crypto');
const dns = require('dns');
const fs = require('fs');
const https = require('https');
const net = require('net');
const path = require('path');
const preflight = require('./preflight-all-chain-endpoints-v2.js');

const ROOT = path.resolve(__dirname, '..');
const INVENTORY_REL = 'rpc_endpoints.txt';
const OUTPUT_REL = preflight.CAPABILITY_REL;
const PREFLIGHT_REL = preflight.MARKER_REL;
const CONSUMED_REL = preflight.CONSUMED_REL;
const SCHEMA = 'all-chain-endpoint-capability-v2';
const PROTOCOLS = Object.freeze(['EVM', 'SOLANA', 'SUI', 'COMETBFT', 'COSMOS_LCD', 'MIDGARD', 'TRON']);
const AUTHORITATIVE = new Set(['EVM', 'SOLANA', 'SUI', 'COMETBFT', 'COSMOS_LCD', 'TRON']);
const LIMITS = Object.freeze({
  inventoryBytes: 2 * 1024 * 1024, uniqueRecords: 320, chainIdentities: 96,
  phase1Requests: 1280, phase2Requests: 1728, requests: 3072, logicalOps: 3328,
  perEndpointRequests: 9, perEndpointLogicalOps: 10, responsePhase1: 1024 * 1024,
  responsePhase2: 2 * 1024 * 1024, endpointBytes: 8 * 1024 * 1024,
  globalBytes: 256 * 1024 * 1024, requestBytes: 64 * 1024, responseHeaders: 16 * 1024,
  artifactBytes: 1024 * 1024, concurrency: 8, perFamilyConcurrency: 1,
  startsPerSecond: 8, phase1TimeoutMs: 5000, phase2TimeoutMs: 10000,
  traceTimeoutMs: 15000, endpointPhase1WallMs: 20000, endpointTotalWallMs: 90000,
  globalWallMs: 2700000, dnsTimeoutMs: 3000, dnsMaxAnswers: 4,
});
const FAILURE_CODES = Object.freeze([
  'AMBIGUOUS', 'UNCLASSIFIED', 'UNSAFE_URL', 'WSS_COUNT_ONLY', 'DNS_UNSAFE', 'DNS_FAILURE',
  'TIMEOUT', 'NETWORK', 'REDIRECT', 'COMPRESSION', 'HEADERS_TOO_LARGE', 'CONTENT_LENGTH',
  'RESPONSE_TOO_LARGE', 'GLOBAL_BYTE_BUDGET', 'HTTP_STATUS', 'JSON_INVALID', 'SCHEMA_INVALID',
  'RPC_ERROR', 'METHOD_UNSUPPORTED', 'IDENTITY_UNKNOWN', 'IDENTITY_MISMATCH', 'STALE', 'FUTURE',
  'SPREAD', 'NO_SAMPLE', 'HISTORICAL_UNAVAILABLE', 'BATCH_INVALID', 'BUDGET', 'WALL_BUDGET',
  'ALLOWLIST', 'DEADLINE', 'ENDPOINT_DEADLINE', 'ENDPOINT_CAP', 'INTERNAL_INVARIANT', 'COMMIT_INVALID', 'PIN_DISAGREEMENT',
]);
const FAILURE_SET = new Set(FAILURE_CODES);
const SOLANA_GENESIS = Object.freeze({
  '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d': 'solana:mainnet-beta',
  'EtWTRABZaYq6iMfeYKouRu166VU2xqa1': 'solana:testnet',
  '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY': 'solana:devnet',
});
const SUI_IDS = Object.freeze({ '35834a8a': 'sui:mainnet', '4c78adac': 'sui:testnet', '46e69ebb': 'sui:devnet' });
const THOR_IDS = new Set(['thorchain-mainnet-v1', 'thorchain-stagenet-v2']);
const TRON_MAINNET_GENESIS = '00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc';
const TRON_EVM_CHAIN_ID = '0x2b6653dc';
const TRON_NETWORKS = new Set(['tron:mainnet']);
const FATAL_CODES = new Set(['BUDGET', 'GLOBAL_BYTE_BUDGET', 'WALL_BUDGET', 'DEADLINE', 'INTERNAL_INVARIANT']);
const NONPROBEABLE_REASONS = new Set(['NON_PROBEABLE_WSS', 'NON_PROBEABLE_UNSUPPORTED_DIALECT',
  'NON_PROBEABLE_APP_SURFACE', 'NON_PROBEABLE_GRAPHQL', 'NON_PROBEABLE_TEMPLATE_REFERENCE',
  'NON_PROBEABLE_ALREADY_SUFFIXED', 'NON_PROBEABLE_UNSUPPORTED_PROTOCOL', 'NON_PROBEABLE_INSECURE_TRANSPORT']);
const APPROVED_HEADERS = new Set(['authorization', 'x-api-key', 'api-key', 'apikey', 'tron-pro-api-key', 'x-project-id']);
const RUNTIME_STAGE_SUBCODES = Object.freeze({
  GATE: Object.freeze(['MARKER_MISSING', 'MARKER_INVALID', 'MARKER_STALE', 'ALREADY_CONSUMED', 'CAPABILITY_EXISTS', 'TEMP_REMNANT', 'HARDLINK_FAILED', 'VERIFY_FAILED', 'FILE_FSYNC_FAILED', 'DIRECTORY_FSYNC_FAILED', 'SOURCE_UNLINK_FAILED', 'PARTIAL']),
  PRENETWORK: Object.freeze(['INVOCATION_ARGS_FORBIDDEN', 'INVOCATION_EXEC_ARGV_FORBIDDEN', 'INVOCATION_ENV_FORBIDDEN', 'INVENTORY_ROOT_INVALID', 'INVENTORY_PATH_INVALID', 'INVENTORY_FILE_INVALID', 'INVENTORY_SIZE_INVALID', 'INVENTORY_READ_INCONSISTENT', 'INVENTORY_UTF8_INVALID', 'CLASSIFICATION_EMPTY', 'CLASSIFICATION_RECORD_OVERFLOW', 'CLASSIFICATION_CHAIN_OVERFLOW', 'CLASSIFICATION_AMBIGUOUS', 'CLASSIFICATION_UNCLASSIFIED', 'CLASSIFICATION_CONFLICT', 'WSS_GATE_COUNTERPART_MISSING', 'OUTPUT_PREFLIGHT_PARENT_UNSAFE', 'OUTPUT_PREFLIGHT_FINAL_EXISTS', 'OUTPUT_PREFLIGHT_TEMP_EXISTS', 'OUTPUT_PREFLIGHT_PROBE_OPEN', 'OUTPUT_PREFLIGHT_PROBE_WRITE', 'OUTPUT_PREFLIGHT_PROBE_FILE_FSYNC', 'OUTPUT_PREFLIGHT_PROBE_HARDLINK', 'OUTPUT_PREFLIGHT_PROBE_FINAL_VERIFY', 'OUTPUT_PREFLIGHT_PROBE_TEMP_UNLINK', 'OUTPUT_PREFLIGHT_PROBE_LINK_UNLINK', 'OUTPUT_PREFLIGHT_DIRECTORY_FSYNC', 'OUTPUT_PREFLIGHT_CLEANUP']),
  PHASE1: Object.freeze(['BUDGET', 'GLOBAL_BYTE_BUDGET', 'WALL_BUDGET', 'DEADLINE', 'INTERNAL_INVARIANT']), PINNING: Object.freeze(['BUDGET', 'GLOBAL_BYTE_BUDGET', 'WALL_BUDGET', 'DEADLINE', 'INTERNAL_INVARIANT']), PHASE2: Object.freeze(['BUDGET', 'GLOBAL_BYTE_BUDGET', 'WALL_BUDGET', 'DEADLINE', 'INTERNAL_INVARIANT']),
  ARTIFACT: Object.freeze(['CHAIN_OVERFLOW', 'LEAK_CHECK', 'ARTIFACT_SIZE', 'ARTIFACT_INVALID', 'OUTPUT_EXISTS', 'PUBLISH_FAILED']), INTERNAL: Object.freeze(['UNEXPECTED']),
});
const RUNTIME_STAGES = Object.freeze(Object.keys(RUNTIME_STAGE_SUBCODES));
const PRENETWORK_PREFLIGHT_STAGES = Object.freeze(['INVOCATION', 'INVENTORY', 'CLASSIFICATION', 'WSS_GATE', 'OUTPUT_PREFLIGHT']);
const RUNTIME_TOKENS = Object.freeze({
  PASS: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_OK',
  FAIL_GATE_MARKER_MISSING: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_GATE_MARKER_MISSING', FAIL_GATE_MARKER_INVALID: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_GATE_MARKER_INVALID', FAIL_GATE_MARKER_STALE: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_GATE_MARKER_STALE', FAIL_GATE_ALREADY_CONSUMED: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_GATE_ALREADY_CONSUMED', FAIL_GATE_CAPABILITY_EXISTS: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_GATE_CAPABILITY_EXISTS',
  FAIL_GATE_TEMP_REMNANT: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_GATE_TEMP_REMNANT', FAIL_GATE_HARDLINK_FAILED: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_GATE_HARDLINK_FAILED', FAIL_GATE_VERIFY_FAILED: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_GATE_VERIFY_FAILED', FAIL_GATE_FILE_FSYNC_FAILED: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_GATE_FILE_FSYNC_FAILED', FAIL_GATE_DIRECTORY_FSYNC_FAILED: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_GATE_DIRECTORY_FSYNC_FAILED', FAIL_GATE_SOURCE_UNLINK_FAILED: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_GATE_SOURCE_UNLINK_FAILED', FAIL_GATE_PARTIAL: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_GATE_PARTIAL',
  FAIL_PRENETWORK_INVOCATION_ARGS_FORBIDDEN: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_PRENETWORK_INVOCATION_ARGS_FORBIDDEN', FAIL_PRENETWORK_INVOCATION_EXEC_ARGV_FORBIDDEN: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_PRENETWORK_INVOCATION_EXEC_ARGV_FORBIDDEN', FAIL_PRENETWORK_INVOCATION_ENV_FORBIDDEN: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_PRENETWORK_INVOCATION_ENV_FORBIDDEN', FAIL_PRENETWORK_INVENTORY_ROOT_INVALID: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_PRENETWORK_INVENTORY_ROOT_INVALID', FAIL_PRENETWORK_INVENTORY_PATH_INVALID: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_PRENETWORK_INVENTORY_PATH_INVALID', FAIL_PRENETWORK_INVENTORY_FILE_INVALID: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_PRENETWORK_INVENTORY_FILE_INVALID', FAIL_PRENETWORK_INVENTORY_SIZE_INVALID: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_PRENETWORK_INVENTORY_SIZE_INVALID', FAIL_PRENETWORK_INVENTORY_READ_INCONSISTENT: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_PRENETWORK_INVENTORY_READ_INCONSISTENT', FAIL_PRENETWORK_INVENTORY_UTF8_INVALID: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_PRENETWORK_INVENTORY_UTF8_INVALID', FAIL_PRENETWORK_CLASSIFICATION_EMPTY: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_PRENETWORK_CLASSIFICATION_EMPTY', FAIL_PRENETWORK_CLASSIFICATION_RECORD_OVERFLOW: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_PRENETWORK_CLASSIFICATION_RECORD_OVERFLOW', FAIL_PRENETWORK_CLASSIFICATION_CHAIN_OVERFLOW: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_PRENETWORK_CLASSIFICATION_CHAIN_OVERFLOW', FAIL_PRENETWORK_CLASSIFICATION_AMBIGUOUS: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_PRENETWORK_CLASSIFICATION_AMBIGUOUS', FAIL_PRENETWORK_CLASSIFICATION_UNCLASSIFIED: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_PRENETWORK_CLASSIFICATION_UNCLASSIFIED', FAIL_PRENETWORK_CLASSIFICATION_CONFLICT: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_PRENETWORK_CLASSIFICATION_CONFLICT', FAIL_PRENETWORK_WSS_GATE_COUNTERPART_MISSING: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_PRENETWORK_WSS_GATE_COUNTERPART_MISSING', FAIL_PRENETWORK_OUTPUT_PREFLIGHT_PARENT_UNSAFE: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_PRENETWORK_OUTPUT_PREFLIGHT_PARENT_UNSAFE', FAIL_PRENETWORK_OUTPUT_PREFLIGHT_FINAL_EXISTS: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_PRENETWORK_OUTPUT_PREFLIGHT_FINAL_EXISTS', FAIL_PRENETWORK_OUTPUT_PREFLIGHT_TEMP_EXISTS: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_PRENETWORK_OUTPUT_PREFLIGHT_TEMP_EXISTS', FAIL_PRENETWORK_OUTPUT_PREFLIGHT_PROBE_OPEN: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_PRENETWORK_OUTPUT_PREFLIGHT_PROBE_OPEN', FAIL_PRENETWORK_OUTPUT_PREFLIGHT_PROBE_WRITE: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_PRENETWORK_OUTPUT_PREFLIGHT_PROBE_WRITE', FAIL_PRENETWORK_OUTPUT_PREFLIGHT_PROBE_FILE_FSYNC: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_PRENETWORK_OUTPUT_PREFLIGHT_PROBE_FILE_FSYNC', FAIL_PRENETWORK_OUTPUT_PREFLIGHT_PROBE_HARDLINK: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_PRENETWORK_OUTPUT_PREFLIGHT_PROBE_HARDLINK', FAIL_PRENETWORK_OUTPUT_PREFLIGHT_PROBE_FINAL_VERIFY: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_PRENETWORK_OUTPUT_PREFLIGHT_PROBE_FINAL_VERIFY', FAIL_PRENETWORK_OUTPUT_PREFLIGHT_PROBE_TEMP_UNLINK: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_PRENETWORK_OUTPUT_PREFLIGHT_PROBE_TEMP_UNLINK', FAIL_PRENETWORK_OUTPUT_PREFLIGHT_PROBE_LINK_UNLINK: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_PRENETWORK_OUTPUT_PREFLIGHT_PROBE_LINK_UNLINK', FAIL_PRENETWORK_OUTPUT_PREFLIGHT_DIRECTORY_FSYNC: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_PRENETWORK_OUTPUT_PREFLIGHT_DIRECTORY_FSYNC', FAIL_PRENETWORK_OUTPUT_PREFLIGHT_CLEANUP: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_PRENETWORK_OUTPUT_PREFLIGHT_CLEANUP',
  FAIL_PHASE1_BUDGET: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_PHASE1_BUDGET', FAIL_PHASE1_GLOBAL_BYTE_BUDGET: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_PHASE1_GLOBAL_BYTE_BUDGET', FAIL_PHASE1_WALL_BUDGET: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_PHASE1_WALL_BUDGET', FAIL_PHASE1_DEADLINE: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_PHASE1_DEADLINE', FAIL_PHASE1_INTERNAL_INVARIANT: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_PHASE1_INTERNAL_INVARIANT', FAIL_PINNING_BUDGET: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_PINNING_BUDGET', FAIL_PINNING_GLOBAL_BYTE_BUDGET: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_PINNING_GLOBAL_BYTE_BUDGET', FAIL_PINNING_WALL_BUDGET: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_PINNING_WALL_BUDGET', FAIL_PINNING_DEADLINE: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_PINNING_DEADLINE', FAIL_PINNING_INTERNAL_INVARIANT: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_PINNING_INTERNAL_INVARIANT', FAIL_PHASE2_BUDGET: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_PHASE2_BUDGET', FAIL_PHASE2_GLOBAL_BYTE_BUDGET: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_PHASE2_GLOBAL_BYTE_BUDGET', FAIL_PHASE2_WALL_BUDGET: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_PHASE2_WALL_BUDGET', FAIL_PHASE2_DEADLINE: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_PHASE2_DEADLINE', FAIL_PHASE2_INTERNAL_INVARIANT: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_PHASE2_INTERNAL_INVARIANT',
  FAIL_ARTIFACT_CHAIN_OVERFLOW: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_ARTIFACT_CHAIN_OVERFLOW', FAIL_ARTIFACT_LEAK_CHECK: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_ARTIFACT_LEAK_CHECK', FAIL_ARTIFACT_ARTIFACT_SIZE: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_ARTIFACT_ARTIFACT_SIZE', FAIL_ARTIFACT_ARTIFACT_INVALID: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_ARTIFACT_ARTIFACT_INVALID', FAIL_ARTIFACT_OUTPUT_EXISTS: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_ARTIFACT_OUTPUT_EXISTS', FAIL_ARTIFACT_PUBLISH_FAILED: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_ARTIFACT_PUBLISH_FAILED', FAIL_INTERNAL_UNEXPECTED: 'ALL_CHAIN_ENDPOINT_CAPABILITY_V2_FAIL_INTERNAL_UNEXPECTED',
});

class SafeError extends Error {
  constructor(code) { super(code); this.name = 'SafeError'; this.code = code; }
}
function fail(code) { throw new SafeError(code); }
function own(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }
function integer(value) { return Number.isSafeInteger(value) && value >= 0; }
function quantity(value) { return typeof value === 'string' && /^(?:0x0|0x[1-9a-f][0-9a-f]*)$/i.test(value); }
function finiteFailure(code) { return FAILURE_SET.has(code) ? code : 'NETWORK'; }
function rethrowFatal(error) { if (!(error instanceof SafeError)) terminal('INTERNAL', 'UNEXPECTED'); if (FATAL_CODES.has(error.code)) throw error; }
function latencyBucket(ms) { return ms < 250 ? 'LT_250MS' : ms < 1000 ? '250_999MS' : ms < 3000 ? '1_2999S' : 'GE_3S'; }
function normalizeTime(value) {
  if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
  if (!Number.isFinite(value)) return null;
  if (value > 1e15) value /= 1e6;
  else if (value > 1e12) value /= 1e3;
  return Math.floor(value);
}
function safeTimestamp(seconds, nowMs, pastMs, futureMs) {
  if (!integer(seconds)) return 'SCHEMA_INVALID';
  const delta = seconds * 1000 - nowMs;
  if (delta > futureMs) return 'FUTURE';
  if (delta < -pastMs) return 'STALE';
  return null;
}

function validateInvocation({ argv = process.argv.slice(2), execArgv = process.execArgv, env = process.env } = {}) {
  if (!Array.isArray(argv) || argv.length) fail('ARGS_FORBIDDEN');
  if (!Array.isArray(execArgv) || execArgv.length) fail('EXEC_ARGV_FORBIDDEN');
  const exact = new Set(['NODE_OPTIONS', 'NODE_DEBUG', 'NODE_DEBUG_NATIVE', 'SSLKEYLOGFILE',
    'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    'OPENSSL_CONF', 'USE_ENV_PROXY']);
  for (const [name, raw] of Object.entries(env || {})) {
    if (raw === undefined || raw === null || String(raw) === '') continue;
    const upper = name.toUpperCase();
    if (upper.includes('PROXY')) fail('ENV_FORBIDDEN');
    if (exact.has(upper) || upper.includes('KEYLOG') || upper.includes('ENDPOINT') || upper.includes('RPC') ||
        upper.includes('SOLANA') || upper.includes('SUI') || upper.includes('DEBUG') || upper.includes('TOKEN') ||
        upper.includes('PRIVATE_KEY') || upper.includes('WALLET') || upper.includes('TLS') || upper.includes('SSL')) fail('ENV_FORBIDDEN');
  }
  return true;
}

function strictUtf8(buffer) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch (_) { fail('INVENTORY_UTF8'); }
}
function readInventory({ root = ROOT, fsOps = fs } = {}) {
  const file = path.join(root, INVENTORY_REL);
  let stat;
  try { stat = fsOps.lstatSync(file); } catch (_) { fail('INVENTORY_INVALID'); }
  if (!stat.isFile() || stat.isSymbolicLink()) fail('INVENTORY_INVALID');
  if (stat.size > LIMITS.inventoryBytes) fail('INVENTORY_SIZE');
  const body = fsOps.readFileSync(file);
  if (body.length !== stat.size || body.length > LIMITS.inventoryBytes) fail('INVENTORY_SIZE');
  return strictUtf8(body);
}

function sectionProtocols(text) {
  const matches = [];
  if (/\bevm\b|\bethereum\b|\beip[- ]?155\b/i.test(text)) matches.push('EVM');
  if (/\bsolana\b/i.test(text)) matches.push('SOLANA');
  if (/\bsui\b/i.test(text)) matches.push('SUI');
  if (/\b(?:cometbft|tendermint|consensus gateway|legacy gateway|rpc)\b/i.test(text) && /\bthorchain\b/i.test(text)) matches.push('COMETBFT');
  if (/\bcosmos\b/i.test(text) && /\b(?:lcd|rest)\b/i.test(text)) matches.push('COSMOS_LCD');
  if (/\bmidgard\b/i.test(text)) matches.push('MIDGARD');
  if (/\btron\b/i.test(text)) matches.push('TRON');
  return [...new Set(matches)];
}
function sectionProtocol(text) { const matches = sectionProtocols(text); return matches.length === 1 ? matches[0] : null; }
function declaredContext(text, protocol) {
  const chain = text.match(/\b(?:chain(?:id)?|network|eip155)\s*[:=]\s*([a-z0-9._-]{1,64})\b/i)?.[1] || null;
  const familyRaw = text.match(/\bfamily\s*[:=]\s*(?:"([^"]{1,64})"|'([^']{1,64})'|([^\]\r\n]{1,64}?))(?=\s+(?:(?:chain|network|eip155|family)\s*[:=]|archive\b|historical\b|trace\b|premium\b|credentialed\b|paid\b|native\b)|\s*\]|\s*$)/i);
  const family = familyRaw ? normalizeFamily(familyRaw[1] || familyRaw[2] || familyRaw[3]) : null;
  const lower = text.toLowerCase();
  let network = chain;
  if (protocol === 'TRON') {
    if (/\bmainnet\b/.test(lower)) network = 'mainnet';
    else if (/\bnile\b/.test(lower)) network = 'nile';
    else if (/\bshasta\b/.test(lower)) network = 'shasta';
  }
  return { declaredChain: chain, declaredNetwork: network, explicitFamily: family,
    nativeTronDeclared: protocol === 'TRON' && /\bnative\b/i.test(text) && /\/wallet(?:solidity)?\b/i.test(text),
    phase2Declared: /\b(?:archive|historical|trace)\b/i.test(text),
    premium: /\b(?:premium|credentialed|paid)\b/i.test(text) };
}
function registrableHost(host) {
  if (net.isIP(host)) return host.toLowerCase();
  const parts = host.toLowerCase().split('.').filter(Boolean);
  return parts.length < 3 ? host.toLowerCase() : parts.slice(-2).join('.');
}
function normalizeFamily(value) { return String(value).normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' '); }
function validUrl(raw) {
  if (/[{}<>]|\$\{|%\w+%|YOUR[_-]|REPLACE/i.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (!['https:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) return null;
    if (!url.hostname || url.port && !/^\d+$/.test(url.port)) return null;
    return url;
  } catch (_) { return null; }
}
function parseAnnotations(text) {
  const headers = Object.create(null); let origin = null;
  for (const match of text.matchAll(/\[origin:\s*([^\]\r\n]{1,1024})\]/gi)) {
    if (match[1].trim() === 'null') { if (origin !== null && origin !== 'null') fail('AMBIGUOUS'); origin = 'null'; continue; }
    const candidate = match[1].trim(); let parsed; try { parsed = new URL(candidate); } catch (_) { parsed = null; }
    if (/[\r\n\0]/.test(candidate) || parsed && (['file:', 'data:', 'javascript:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash)) fail('AMBIGUOUS');
    const normalized = parsed ? parsed.origin === 'null' ? candidate : parsed.origin : candidate;
    if (origin !== null && origin !== normalized) fail('AMBIGUOUS'); origin = normalized;
  }
  for (const match of text.matchAll(/\[header:\s*([a-z0-9-]{1,64})=([^\]\r\n]{1,1024})\]/gi)) {
    const name = match[1].toLowerCase(), value = match[2].trim();
    if (!APPROVED_HEADERS.has(name) || /[\r\n]/.test(value) || own(headers, name) && headers[name] !== value) fail('AMBIGUOUS'); headers[name] = value;
  }
  return { headers, origin };
}
function alreadySuffixed(url) {
  return /\/(?:status|block|commit|block_results|syncing|node_info|blocks\/latest|wallet(?:solidity)?\/[a-z0-9_]+|v2\/(?:health|network))\/?$/i.test(url.pathname);
}
function graphqlSurface(url, context) { return /\bgraphql\b/i.test(context) || !!(url && (/(?:^|\/)graphql(?:\/|$)/i.test(url.pathname) || /(?:^|[?&])(?:api|type|protocol)=graphql(?:&|$)/i.test(url.search))); }
function parseInventory(text) {
  const records = new Map(); const occurrences = [];
  const declarationContracts = new Map();
  const chains = new Set();
  const leakCorpus = new Set();
  let section = '';
  let unclassified = 0;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (/^\s*(?:#{1,6}\s+|[^|]{1,100}:\s*$)/.test(line) || /^\s*\[/.test(line) && /\b(?:evm|ethereum|solana|sui|thorchain|cosmos|midgard|tron|origin|header|family|network|chain)\b/i.test(line)) section = line.slice(0, 1024);
    const urls = line.match(/(?:https?|wss?):\/\/[^\s"'`<>\[\]]+/gi) || [];
    for (let raw of urls) {
      raw = raw.replace(/[),.;]+$/, '');
      leakCorpus.add(raw);
      const context = `${section}\n${line.replace(/(?:https?|wss?):\/\/[^\s"'`<>\[\]]+/gi, ' ')}`;
      if (new RegExp(`\\[origin:\\s*${raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(line)) { occurrences.push({ category: 'ORIGIN_METADATA' }); leakCorpus.add(raw); continue; }
      if (new RegExp(`\\[header:[^\\]]*=${raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(line)) { occurrences.push({ category: 'HEADER_METADATA' }); leakCorpus.add(raw); continue; }
      const url = validUrl(raw);
      let protocol = sectionProtocol(context);
      if (url && /\/v2(?:\/|$)/i.test(url.pathname) && /\bthorchain\b/i.test(context)) protocol = 'MIDGARD';
      const declared = declaredContext(context, protocol);
      const annotations = parseAnnotations(context);
      const providerLabel = context.match(/\b(?:provider|label)\s*[:=]\s*([a-z0-9._ -]{2,80})\b/i)?.[1]?.trim() || null;
      let category = 'SUPPORTED_PROBE_ENDPOINT', reason = null;
      if (/[{}<>]|\$\{|%\w+%|YOUR[_-]|REPLACE/i.test(raw) || /\b(?:template|placeholder|example|documentation|docs?|reference)\b/i.test(context)) { category = 'NON_PROBEABLE'; reason = 'NON_PROBEABLE_TEMPLATE_REFERENCE'; }
      else if (!url) { category = 'NON_PROBEABLE'; reason = 'NON_PROBEABLE_INSECURE_TRANSPORT'; }
      else if (graphqlSurface(url, context)) { category = 'OUT_OF_SCOPE_NONPROBEABLE'; reason = 'NON_PROBEABLE_GRAPHQL'; }
      else if (url.protocol === 'wss:') { category = 'NON_PROBEABLE'; reason = 'NON_PROBEABLE_WSS'; }
      else if (protocol === 'TRON' && !declared.nativeTronDeclared) { category = 'NON_PROBEABLE'; reason = 'NON_PROBEABLE_UNSUPPORTED_DIALECT'; }
      else if ((protocol === 'COMETBFT' || protocol === 'COSMOS_LCD') && /\/thorchain\//i.test(url.pathname) || /\b(?:thornode|thorchain app|app\s+\/thorchain)\b/i.test(context)) { category = 'NON_PROBEABLE'; reason = 'NON_PROBEABLE_APP_SURFACE'; }
      else if (protocol !== 'MIDGARD' && /\/v2\//i.test(url.pathname)) { category = 'NON_PROBEABLE'; reason = 'NON_PROBEABLE_APP_SURFACE'; }
      else if (alreadySuffixed(url)) { category = 'NON_PROBEABLE'; reason = 'NON_PROBEABLE_ALREADY_SUFFIXED'; }
      else if (!protocol && sectionProtocols(context).length > 1) fail('AMBIGUOUS');
      else if (!protocol) { category = 'NON_PROBEABLE'; reason = 'NON_PROBEABLE_UNSUPPORTED_PROTOCOL'; }
      if (reason && !NONPROBEABLE_REASONS.has(reason)) fail('INTERNAL_INVARIANT');
      const canonicalHeaders = Object.entries(annotations.headers).sort(([a], [b]) => a.localeCompare(b));
      const endpointIdentity = `${url ? url.href : raw}\0${annotations.origin || ''}\0${JSON.stringify(canonicalHeaders)}`;
      const declaredBoolean = (name, fallback) => new RegExp(`\\b${name}\\s*[:=]\\s*false\\b`, 'i').test(context) ? false : fallback ? true : null;
      const declaration = { protocol, chain: declared.declaredChain, network: declared.declaredNetwork, transport: url && url.protocol || null,
        nativeTronDeclared: declaredBoolean('native', declared.nativeTronDeclared), phase2Declared: declaredBoolean('(?:archive|historical|trace)', declared.phase2Declared),
        premium: declaredBoolean('(?:premium|credentialed|paid)', declared.premium), family: declared.explicitFamily, category, reason };
      if (declarationContracts.has(endpointIdentity)) { const prior = declarationContracts.get(endpointIdentity); for (const key of Object.keys(declaration)) { if (prior[key] !== null && declaration[key] !== null && prior[key] !== declaration[key]) fail('AMBIGUOUS'); if (prior[key] === null && declaration[key] !== null) prior[key] = declaration[key]; } }
      else declarationContracts.set(endpointIdentity, declaration);
      const behavior = JSON.stringify(declaration);
      const normalized = `${endpointIdentity}\0${behavior}`;
      occurrences.push({ category, reason, protocol, originAnnotations: annotations.origin === null ? 0 : 1, approvedFields: Object.keys(annotations.headers).length });
      if (records.has(normalized)) continue;
      const row = { order: index, protocol, url, raw, ...declared, headers: Object.create(null), calls: 0,
        logicalOps: 0, bytes: 0, phase1ActiveMs: 0, totalActiveMs: 0, operationStart: null, operationPhase: null, category, reason, origin: annotations.origin };
      for (const [name, value] of canonicalHeaders) row.headers[name] = value;
      if (url) {
        row.family = declared.explicitFamily || registrableHost(url.hostname);
        for (const item of [raw, url.href, url.hostname, url.pathname, url.search, row.family, row.origin, ...Object.keys(row.headers), ...Object.values(row.headers)]) if (item) leakCorpus.add(String(item));
      }
      if (providerLabel) leakCorpus.add(providerLabel);
      if (category !== 'SUPPORTED_PROBE_ENDPOINT') unclassified += 1;
      if (declared.declaredChain) chains.add(`${protocol || 'UNKNOWN'}:${declared.declaredChain}`);
      records.set(normalized, row);
    }
  }
  if (records.size > LIMITS.uniqueRecords) fail('RECORD_OVERFLOW');
  if (chains.size > LIMITS.chainIdentities) fail('CHAIN_OVERFLOW');
  return { records: [...records.values()], occurrences, occurrenceCount: occurrences.length, unclassified, leakCorpus };
}

function isUnsafeAddress(address) {
  const kind = net.isIP(address);
  if (kind === 4) {
    const p = address.split('.').map(Number); const n = ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
    const inRange = (base, bits) => (n >>> (32 - bits)) === (base >>> (32 - bits));
    return inRange(0x00000000, 8) || inRange(0x0a000000, 8) || inRange(0x64400000, 10) ||
      inRange(0x7f000000, 8) || inRange(0xa9fe0000, 16) || inRange(0xac100000, 12) ||
      inRange(0xc0000000, 24) || inRange(0xc0000200, 24) || inRange(0xc0a80000, 16) ||
      inRange(0xc6120000, 15) || inRange(0xc6336400, 24) || inRange(0xcb007100, 24) ||
      inRange(0xe0000000, 4) || inRange(0xf0000000, 4);
  }
  if (kind === 6) {
    const value = address.toLowerCase().split('%')[0];
    const halves = value.split('::'); if (halves.length > 2) return true;
    const left = halves[0] ? halves[0].split(':') : [], right = halves[1] ? halves[1].split(':') : [];
    const groups = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
    if (groups.length !== 8 || groups.some((x) => !/^[0-9a-f]{1,4}$/.test(x))) return true;
    let n = 0n; for (const group of groups) n = (n << 16n) + BigInt(`0x${group}`);
    const cidr = (base, bits) => n >> BigInt(128 - bits) === BigInt(base) >> BigInt(128 - bits);
    return cidr(0n, 128) || cidr(1n, 128) || cidr(0x00000000000000000000ffff00000000n, 96) ||
      cidr(0x0064ff9b000100000000000000000000n, 48) || cidr(0x01000000000000000000000000000000n, 64) ||
      cidr(0x20010000000000000000000000000000n, 23) || cidr(0x20010db8000000000000000000000000n, 32) ||
      cidr(0x20020000000000000000000000000000n, 16) || cidr(0x3fff0000000000000000000000000000n, 20) ||
      cidr(0x5f000000000000000000000000000000n, 16) || cidr(0xfc000000000000000000000000000000n, 7) ||
      cidr(0xfe800000000000000000000000000000n, 10) || cidr(0xff000000000000000000000000000000n, 8);
  }
  return true;
}
async function publicResolution(hostname, lookup = dns.promises.lookup, timeoutMs = LIMITS.dnsTimeoutMs) {
  let timer; let rows;
  try { rows = await Promise.race([lookup(hostname, { all: true, verbatim: true }), new Promise((_, reject) => { timer = setTimeout(() => reject(new SafeError('TIMEOUT')), timeoutMs); })]); }
  catch (error) { throw error instanceof SafeError ? error : new SafeError('DNS_FAILURE'); } finally { clearTimeout(timer); }
  if (!Array.isArray(rows) || !rows.length || rows.length > LIMITS.dnsMaxAnswers || rows.some((row) => !row || isUnsafeAddress(row.address))) throw new SafeError('DNS_UNSAFE');
  return rows[0];
}

class Budget {
  constructor({ clock = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), pace = true } = {}) {
    this.clock = clock; this.sleep = sleep; this.pace = pace; this.phase1 = 0; this.phase2 = 0; this.logical = 0;
    this.bytes = 0; this.starts = []; this.active = 0; this.maxActive = 0; this.familyActive = new Map(); this.globalStart = clock();
    this.maxRollingStarts = 0; this.maxCandidateRequests = 0; this.maxCandidateLogicalOps = 0; this.maxCandidateBytes = 0;
    this.maxCandidateActiveMs = 0; this.maxCandidatePhase1ActiveMs = 0; this.activeRequests = new Set(); this.paceTail = Promise.resolve(); this.fatalExhaustion = false; this.fatalCode = null;
    this.abortController = new AbortController(); this.methodCounts = Object.create(null);
  }
  assertLive() { if (this.fatalExhaustion || this.abortController.signal.aborted) throw new SafeError(this.fatalCode || 'DEADLINE'); }
  beginOperation(row, phase) { this.assertLive(); if (row.operationStart !== null && row.operationStart !== undefined) throw new SafeError('INTERNAL_INVARIANT'); row.operationStart = this.clock(); row.operationPhase = phase; }
  endOperation(row) {
    if (row.operationStart === null || row.operationStart === undefined) return; const elapsed = Math.max(0, this.clock() - row.operationStart);
    row.totalActiveMs = (row.totalActiveMs || 0) + elapsed; if (row.operationPhase === 1) row.phase1ActiveMs = (row.phase1ActiveMs || 0) + elapsed;
    this.maxCandidateActiveMs = Math.max(this.maxCandidateActiveMs, row.totalActiveMs); this.maxCandidatePhase1ActiveMs = Math.max(this.maxCandidatePhase1ActiveMs, row.phase1ActiveMs || 0); row.operationStart = null; row.operationPhase = null;
  }
  deadlineState(row, phase) {
    const now = this.clock(), current = row && row.operationStart !== null && row.operationStart !== undefined ? Math.max(0, now - row.operationStart) : 0;
    const global = LIMITS.globalWallMs - (now - this.globalStart), total = LIMITS.endpointTotalWallMs - ((row && row.totalActiveMs || 0) + current);
    const phaseOne = phase === 1 ? LIMITS.endpointPhase1WallMs - ((row && row.phase1ActiveMs || 0) + (row && row.operationPhase === 1 ? current : 0)) : Number.POSITIVE_INFINITY;
    const remaining = Math.min(global, total, phaseOne); return { remaining, globalLimited: global <= total && global <= phaseOne };
  }
  remaining(row, phase) { return this.deadlineState(row, phase).remaining; }
  ensureDeadline(row, phase) { this.assertLive(); const state = this.deadlineState(row, phase); if (state.remaining <= 1) { if (state.globalLimited) this.fatal('DEADLINE'); throw new SafeError('ENDPOINT_DEADLINE'); } return state.remaining; }
  async awaitLive(promise) {
    this.assertLive(); let onAbort;
    const aborted = new Promise((_, reject) => { onAbort = () => reject(new SafeError(this.fatalCode || 'DEADLINE')); this.abortController.signal.addEventListener('abort', onAbort, { once: true }); });
    try { const value = await Promise.race([promise, aborted]); this.assertLive(); return value; }
    finally { this.abortController.signal.removeEventListener('abort', onAbort); }
  }
  async start(row, phase, logical, label = 'UNKNOWN') {
    const operation = async () => {
      this.assertLive(); let now = this.clock(); const wall = now - this.globalStart;
      if (wall >= LIMITS.globalWallMs) return this.fatal('WALL_BUDGET'); this.ensureDeadline(row, phase);
      if (this.phase1 + this.phase2 + 1 > LIMITS.requests || this.logical + logical > LIMITS.logicalOps) return this.fatal('BUDGET');
      if (phase === 1 && this.phase1 + 1 > LIMITS.phase1Requests || phase === 2 && this.phase2 + 1 > LIMITS.phase2Requests) return this.fatal('BUDGET');
      if (row.calls + 1 > LIMITS.perEndpointRequests || row.logicalOps + logical > LIMITS.perEndpointLogicalOps) throw new SafeError('ENDPOINT_CAP');
      if (this.pace) {
        while (true) {
          this.assertLive(); this.ensureDeadline(row, phase);
          now = this.clock(); this.starts = this.starts.filter((value) => now - value < 1000);
          if (this.starts.length < LIMITS.startsPerSecond) break;
          await this.awaitLive(this.sleep(Math.max(1, 1000 - (now - this.starts[0])))); this.ensureDeadline(row, phase);
        }
      }
      this.assertLive(); this.ensureDeadline(row, phase);
      this.starts.push(this.clock()); if (this.pace) this.maxRollingStarts = Math.max(this.maxRollingStarts, this.starts.length);
      row.calls += 1; row.logicalOps += logical; this.logical += logical;
      this.maxCandidateRequests = Math.max(this.maxCandidateRequests, row.calls); this.maxCandidateLogicalOps = Math.max(this.maxCandidateLogicalOps, row.logicalOps);
      if (phase === 1) this.phase1 += 1; else this.phase2 += 1;
      const matrixKey = `${row.protocol}:P${phase}:${label}`; this.methodCounts[matrixKey] = (this.methodCounts[matrixKey] || 0) + 1;
    };
    const prior = this.paceTail; let release; this.paceTail = new Promise((resolve) => { release = resolve; });
    await this.awaitLive(prior); this.assertLive(); try { return await operation(); } finally { release(); }
  }
  fatal(code) { if (!this.fatalExhaustion) { this.fatalExhaustion = true; this.fatalCode = code; this.abortController.abort(); for (const request of this.activeRequests) try { request.destroy(); } catch (_) {} } throw new SafeError(this.fatalCode || code); }
  register(request) { this.assertLive(); this.activeRequests.add(request); if (this.fatalExhaustion) { try { request.destroy(); } catch (_) {} this.assertLive(); } }
  unregister(request) { this.activeRequests.delete(request); }
  addBytes(row, amount) {
    row.bytes += amount; this.bytes += amount;
    if (row.bytes > LIMITS.endpointBytes) throw new SafeError('RESPONSE_TOO_LARGE');
    this.maxCandidateBytes = Math.max(this.maxCandidateBytes, row.bytes);
    if (this.bytes > LIMITS.globalBytes) this.fatal('GLOBAL_BYTE_BUDGET');
  }
  summary() { return { phase1Requests: this.phase1, phase2Requests: this.phase2, totalRequests: this.phase1 + this.phase2,
    logicalOps: this.logical, responseBytes: this.bytes, maxConcurrencyObserved: this.maxActive,
    maxFamilyConcurrencyObserved: this.maxFamilyActive || 0, maxRollingStarts: this.maxRollingStarts,
    maxCandidateRequests: this.maxCandidateRequests, maxCandidateLogicalOps: this.maxCandidateLogicalOps,
    maxCandidateResponseBytes: this.maxCandidateBytes, maxCandidatePhase1ActiveMs: this.maxCandidatePhase1ActiveMs, maxCandidateActiveMs: this.maxCandidateActiveMs,
    globalWallMs: Math.max(0, this.clock() - this.globalStart), fatalExhaustion: this.fatalExhaustion,
    methodCounts: Object.fromEntries(Object.entries(this.methodCounts).sort()) }; }
}

async function directHttps(request, { lookup = dns.promises.lookup, resolve = publicResolution, requestImpl = https.request, budget, row, phase, clock = Date.now } = {}) {
  budget.assertLive();
  const url = new URL(request.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new SafeError('UNSAFE_URL');
  for (const [name, value] of Object.entries(row.headers || {})) if (!APPROVED_HEADERS.has(name.toLowerCase()) || /[\r\n]/.test(String(value))) throw new SafeError('ALLOWLIST');
  for (const [name, value] of Object.entries(request.headers || {})) if (!APPROVED_HEADERS.has(name.toLowerCase()) || /[\r\n]/.test(String(value))) throw new SafeError('ALLOWLIST');
  if (row.origin !== null && row.origin !== undefined && /[\r\n\0]/.test(String(row.origin))) throw new SafeError('ALLOWLIST');
  let remaining = budget.ensureDeadline(row, phase);
  const resolved = await budget.awaitLive(resolve(url.hostname, lookup, Math.min(LIMITS.dnsTimeoutMs, remaining)));
  budget.assertLive(); remaining = budget.ensureDeadline(row, phase);
  const body = request.body === undefined ? null : Buffer.from(JSON.stringify(request.body), 'utf8');
  if (body && body.length > LIMITS.requestBytes) throw new SafeError('BUDGET');
  const cap = phase === 1 ? LIMITS.responsePhase1 : LIMITS.responsePhase2;
  remaining = budget.ensureDeadline(row, phase);
  const methodTimeoutMs = request.timeoutMs || (phase === 1 ? LIMITS.phase1TimeoutMs : LIMITS.phase2TimeoutMs);
  let timeoutMs = Math.min(methodTimeoutMs, remaining), deadlineCode = budget.deadlineState(row, phase).globalLimited ? 'DEADLINE' : 'ENDPOINT_DEADLINE';
  if (timeoutMs <= 1) budget.fatal('DEADLINE'); budget.assertLive();
  const started = clock();
  return new Promise((resolve, reject) => {
    let settled = false; let timer; let req;
    const done = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); if (req) budget.unregister(req);
      error ? reject(error) : resolve({ ...value, latencyMs: Math.max(0, clock() - started) }); };
    const headers = { ...row.headers, ...(request.headers || {}), accept: 'application/json', 'accept-encoding': 'identity', connection: 'close' };
    if (row.origin) headers.origin = row.origin;
    for (const reserved of ['host', 'content-length', 'transfer-encoding', 'upgrade', 'proxy-authorization', 'proxy-connection']) delete headers[reserved];
    if (body) { headers['content-type'] = 'application/json'; headers['content-length'] = String(body.length); }
    const options = { protocol: 'https:', hostname: url.hostname, port: url.port || 443, servername: url.hostname,
      path: request.path || `${url.pathname}${url.search}`, method: request.method, headers, agent: false,
      maxHeaderSize: LIMITS.responseHeaders,
      lookup: (_host, optionsOrCallback, maybeCallback) => {
        const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
        const all = typeof optionsOrCallback === 'object' && optionsOrCallback.all;
        callback(null, all ? [{ address: resolved.address, family: resolved.family }] : resolved.address, resolved.family);
      },
    };
    try {
      budget.assertLive(); const freshState = budget.deadlineState(row, phase), freshRemaining = budget.ensureDeadline(row, phase); timeoutMs = Math.min(methodTimeoutMs, freshRemaining); deadlineCode = freshState.globalLimited ? 'DEADLINE' : 'ENDPOINT_DEADLINE'; if (timeoutMs <= 1) throw new SafeError(deadlineCode);
      req = requestImpl(options, (res) => {
        const headerBytes = Object.entries(res.headers || {}).reduce((n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(String(v)) + 4, 2);
        if (headerBytes > LIMITS.responseHeaders) { res.destroy(); return done(new SafeError('HEADERS_TOO_LARGE')); }
        if (res.statusCode >= 300 && res.statusCode < 400) { res.destroy(); return done(new SafeError('REDIRECT')); }
        if (res.statusCode !== 200) { res.destroy(); return done(new SafeError('HTTP_STATUS')); }
        const contentType = res.headers && res.headers['content-type'];
        if (typeof contentType !== 'string' || !/^application\/json(?:\s*;\s*charset=[a-z0-9._-]+)?$/i.test(contentType.trim())) { res.destroy(); return done(new SafeError('SCHEMA_INVALID')); }
        const encoding = res.headers && res.headers['content-encoding'];
        if (encoding && String(encoding).toLowerCase() !== 'identity') { res.destroy(); return done(new SafeError('COMPRESSION')); }
        const length = res.headers && res.headers['content-length'];
        if (length !== undefined && (!/^(0|[1-9]\d*)$/.test(String(length)) || Number(length) > cap)) { res.destroy(); return done(new SafeError('CONTENT_LENGTH')); }
        const chunks = []; let total = 0;
        res.on('data', (chunk) => { total += chunk.length; if (total > cap) { res.destroy(); done(new SafeError('RESPONSE_TOO_LARGE')); } else chunks.push(Buffer.from(chunk)); });
        res.on('error', () => done(new SafeError('NETWORK')));
        res.on('end', () => {
          if (settled) return;
          if (length !== undefined && Number(length) !== total) return done(new SafeError('CONTENT_LENGTH'));
          try { budget.addBytes(row, total); } catch (error) { return done(error); }
          let json; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { return done(new SafeError('JSON_INVALID')); }
          try { budget.ensureDeadline(row, phase); } catch (error) { return done(error); }
          if (clock() - started >= timeoutMs) { if (timeoutMs < methodTimeoutMs || timeoutMs === methodTimeoutMs && budget.remaining(row, phase) <= 1) { if (deadlineCode === 'DEADLINE') { try { budget.fatal('DEADLINE'); } catch (error) { return done(error); } } return done(new SafeError('ENDPOINT_DEADLINE')); } return done(new SafeError('TIMEOUT')); }
          done(null, { json });
        });
      });
      budget.assertLive(); budget.register(req); budget.ensureDeadline(row, phase);
      req.on('error', () => done(new SafeError('NETWORK')));
      const timeoutError = () => { if (timeoutMs < methodTimeoutMs) { if (deadlineCode === 'DEADLINE') { try { budget.fatal('DEADLINE'); } catch (error) { done(error); } } else done(new SafeError('ENDPOINT_DEADLINE')); } else done(new SafeError('TIMEOUT')); };
      req.setTimeout(timeoutMs, () => { req.destroy(); timeoutError(); });
      timer = setTimeout(() => { req.destroy(); timeoutError(); }, timeoutMs);
      if (body) req.write(body); req.end();
    } catch (error) { done(error instanceof SafeError ? error : new SafeError('NETWORK')); }
  });
}

function joinPath(baseUrl, suffix) {
  const url = new URL(baseUrl);
  const baseSearch = url.search ? url.search.slice(1) : '';
  const base = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
  const queryAt = suffix.indexOf('?'); const suffixPath = queryAt === -1 ? suffix : suffix.slice(0, queryAt);
  const suffixSearch = queryAt === -1 ? '' : suffix.slice(queryAt + 1);
  url.pathname = `${base}${suffixPath}`; url.search = [baseSearch, suffixSearch].filter(Boolean).join('&'); return url.href;
}
function rpcEnvelope(json, id) {
  if (!json || typeof json !== 'object' || Array.isArray(json) || json.jsonrpc !== '2.0' || json.id !== id) throw new SafeError('SCHEMA_INVALID');
  if (own(json, 'error')) {
    const code = json.error && json.error.code;
    if (code === -32601 || /method (?:not found|unsupported)/i.test(String(json.error && json.error.message || ''))) throw new SafeError('METHOD_UNSUPPORTED');
    throw new SafeError('RPC_ERROR');
  }
  if (!own(json, 'result')) throw new SafeError('SCHEMA_INVALID');
  return json.result;
}
function batchEnvelope(json, ids) {
  if (!Array.isArray(json) || json.length !== ids.length) throw new SafeError('BATCH_INVALID');
  const byId = new Map();
  for (const item of json) {
    if (!item || typeof item !== 'object' || item.jsonrpc !== '2.0' || !ids.includes(item.id) || byId.has(item.id) || own(item, 'error') || !own(item, 'result')) throw new SafeError('BATCH_INVALID');
    byId.set(item.id, item.result);
  }
  if (byId.size !== ids.length) throw new SafeError('BATCH_INVALID');
  return ids.map((id) => byId.get(id));
}
const RPC_ALLOW = Object.freeze({
  EVM: { 1: new Set(['eth_chainId', 'eth_getBlockByNumber']), 2: new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getBalance', 'eth_getLogs', 'debug_traceTransaction', 'trace_transaction']) },
  SOLANA: { 1: new Set(['getGenesisHash', 'getSlot', 'getBlockTime', 'getBlock']), 2: new Set(['getGenesisHash', 'getSlot', 'getBlock', 'getTransaction']) },
  SUI: { 1: new Set(['sui_getChainIdentifier', 'sui_getLatestCheckpointSequenceNumber', 'sui_getCheckpoint']), 2: new Set(['sui_getChainIdentifier', 'sui_getCheckpoint', 'sui_getTransactionBlock']) },
  COMETBFT: { 1: new Set(), 2: new Set(['status', 'block']) }, COSMOS_LCD: { 1: new Set(), 2: new Set() }, MIDGARD: { 1: new Set(), 2: new Set() }, TRON: { 1: new Set(), 2: new Set() },
});
const REST_ALLOW = Object.freeze({
  COMETBFT: { 1: { GET: [/^\/status$/, /^\/block\?height=\d+$/, /^\/commit\?height=\d+$/] }, 2: { GET: [/^\/block\?height=\d+$/, /^\/block_results\?height=\d+$/] } },
  COSMOS_LCD: { 1: { GET: [/^\/cosmos\/base\/tendermint\/v1beta1\/(?:node_info|syncing|blocks\/latest)$/, /^\/cosmos\/base\/tendermint\/v1beta1\/blocks\/\d+$/] },
    2: { GET: [/^\/cosmos\/base\/tendermint\/v1beta1\/blocks\/\d+$/, /^\/cosmos\/base\/tendermint\/v1beta1\/block_results\/\d+$/] } },
  MIDGARD: { 1: { GET: [/^\/(?:v2\/)?(?:health|network)$/] }, 2: {} },
  TRON: { 1: { POST: [/^\/wallet\/getblockbynum$/, /^\/wallet\/getnowblock$/, /^\/walletsolidity\/getblockbynum$/], GET: [/^\/walletsolidity\/getnowblock$/] },
    2: { POST: [/^\/walletsolidity\/(?:getblockbynum|gettransactioninfobyid)$/] } },
});
function assertRpcAllowed(row, phase, method) {
  const allow = RPC_ALLOW[row.protocol] && RPC_ALLOW[row.protocol][phase];
  if (!allow || !allow.has(method) || /(?:eth_call|debug_traceCall|trace_call|simulate|send|sign|state.?override)/i.test(method)) throw new SafeError('ALLOWLIST');
}
function assertRpcParams(row, phase, method, params) {
  if (!Array.isArray(params) || /(?:stateOverride|state_override|\b(?:simulate|sign|send)\b)/i.test(JSON.stringify(params))) throw new SafeError('ALLOWLIST');
  const hexTag = (x) => typeof x === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(x);
  let ok = false;
  if (row.protocol === 'EVM') {
    if (method === 'eth_chainId') ok = params.length === 0;
    else if (method === 'eth_getBlockByNumber') ok = params.length === 2 && params[1] === false && (['latest', 'finalized'].includes(params[0]) || hexTag(params[0]));
    else if (method === 'eth_getBalance') ok = params.length === 2 && /^0x[0-9a-f]{40}$/i.test(params[0]) && hexTag(params[1]);
    else if (method === 'eth_getLogs') ok = params.length === 1 && params[0] && JSON.stringify(Object.keys(params[0])) === JSON.stringify(['fromBlock', 'toBlock']) && params[0].fromBlock === params[0].toBlock && hexTag(params[0].fromBlock);
    else if (method === 'debug_traceTransaction') ok = params.length === 2 && hex32(params[0]) && params[1] && params[1].tracer === 'callTracer' && params[1].timeout === '10s' && Object.keys(params[1]).length === 2;
    else if (method === 'trace_transaction') ok = params.length === 1 && hex32(params[0]);
  } else if (row.protocol === 'SOLANA') {
    if (method === 'getGenesisHash') ok = params.length === 0;
    else if (method === 'getSlot') ok = params.length === 1 && params[0] && ['processed', 'finalized'].includes(params[0].commitment) && Object.keys(params[0]).length === 1;
    else if (method === 'getBlockTime') ok = params.length === 1 && integer(params[0]);
    else if (method === 'getBlock') ok = params.length === 2 && integer(params[0]) && params[1] && params[1].commitment === 'finalized' && ['signatures', 'none'].includes(params[1].transactionDetails) && params[1].rewards === false && params[1].maxSupportedTransactionVersion === 0;
    else if (method === 'getTransaction') ok = params.length === 2 && base58Bytes(params[0]) === 64 && params[1] && params[1].commitment === 'finalized' && params[1].encoding === 'json' && params[1].maxSupportedTransactionVersion === 0;
  } else if (row.protocol === 'SUI') {
    if (['sui_getChainIdentifier', 'sui_getLatestCheckpointSequenceNumber'].includes(method)) ok = params.length === 0;
    else if (method === 'sui_getCheckpoint') ok = params.length === 1 && /^\d+$/.test(String(params[0]));
    else if (method === 'sui_getTransactionBlock') ok = params.length === 2 && suiDigest(params[0]) && params[1] && params[1].showEvents === true && Object.keys(params[1]).length === 1;
  } else if (row.protocol === 'COMETBFT') {
    if (method === 'status') ok = params.length === 0;
    else if (method === 'block') ok = params.length === 1 && /^\d+$/.test(String(params[0]));
  }
  if (!ok) throw new SafeError('ALLOWLIST');
}
function assertRestAllowed(row, phase, verb, suffix) {
  if (suffix.includes('..') || /[#{}<>]/.test(suffix)) throw new SafeError('ALLOWLIST');
  const list = REST_ALLOW[row.protocol] && REST_ALLOW[row.protocol][phase] && REST_ALLOW[row.protocol][phase][verb];
  if (!list || !list.some((pattern) => pattern.test(suffix))) throw new SafeError('ALLOWLIST');
}
function assertRestBody(row, verb, suffix, body) {
  if (verb === 'GET') { if (body !== undefined) throw new SafeError('ALLOWLIST'); return; }
  if (row.protocol !== 'TRON' || !body || typeof body !== 'object' || Array.isArray(body)) throw new SafeError('ALLOWLIST');
  if (/getblockbynum$/.test(suffix)) { if (JSON.stringify(Object.keys(body)) !== JSON.stringify(['num']) || !integer(body.num)) throw new SafeError('ALLOWLIST'); return; }
  if (/getnowblock$/.test(suffix)) { if (Object.keys(body).length) throw new SafeError('ALLOWLIST'); return; }
  if (/gettransactioninfobyid$/.test(suffix)) { if (JSON.stringify(Object.keys(body)) !== JSON.stringify(['value']) || !plainHex32(body.value)) throw new SafeError('ALLOWLIST'); return; }
  throw new SafeError('ALLOWLIST');
}
function makeRequester({ transport = directHttps, budget, lookup, requestImpl, clock = Date.now } = {}) {
  let id = 1000;
  async function raw(row, phase, spec, logical = 1) {
    budget.assertLive(); budget.beginOperation(row, phase);
    try { await budget.start(row, phase, logical, spec.label); budget.assertLive(); budget.ensureDeadline(row, phase);
      return await transport(spec, { lookup, requestImpl, budget, row, phase, clock }); }
    finally { budget.endOperation(row); }
  }
  async function rpc(row, phase, method, params = [], timeoutMs, stage = '') {
    assertRpcAllowed(row, phase, method); assertRpcParams(row, phase, method, params);
    const callId = ++id; const body = { jsonrpc: '2.0', id: callId, method, params };
    const response = await raw(row, phase, { url: row.url.href, path: `${row.url.pathname}${row.url.search}`, method: 'POST', body, timeoutMs, label: `${stage ? `${stage}:` : ''}RPC:${method}` });
    return { result: rpcEnvelope(response.json, callId), latencyMs: response.latencyMs };
  }
  async function batch(row, phase, calls) {
    if (!Array.isArray(calls) || calls.length !== 2) throw new SafeError('ALLOWLIST');
    for (const [method, params] of calls) { assertRpcAllowed(row, phase, method); assertRpcParams(row, phase, method, params); }
    const ids = calls.map(() => ++id); const body = calls.map(([method, params], i) => ({ jsonrpc: '2.0', id: ids[i], method, params }));
    const response = await raw(row, phase, { url: row.url.href, path: `${row.url.pathname}${row.url.search}`, method: 'POST', body, label: `BATCH:${calls.map((x) => x[0]).join('+')}` }, calls.length);
    return { results: batchEnvelope(response.json, ids), latencyMs: response.latencyMs };
  }
  async function get(row, phase, suffix, stage = '') {
    assertRestAllowed(row, phase, 'GET', suffix); assertRestBody(row, 'GET', suffix, undefined);
    const target = joinPath(row.url.href, suffix); const response = await raw(row, phase, { url: target, path: new URL(target).pathname + new URL(target).search, method: 'GET', label: `${stage ? `${stage}:` : ''}GET:${suffix.replace(/\d+/g, 'H')}` });
    return { result: response.json, latencyMs: response.latencyMs };
  }
  async function post(row, phase, suffix, body, stage = '') {
    assertRestAllowed(row, phase, 'POST', suffix); assertRestBody(row, 'POST', suffix, body);
    const target = joinPath(row.url.href, suffix); const parsed = new URL(target); const response = await raw(row, phase, { url: target, path: parsed.pathname + parsed.search, method: 'POST', body, label: `${stage ? `${stage}:` : ''}POST:${suffix.replace(/\d+/g, 'H')}` });
    return { result: response.json, latencyMs: response.latencyMs };
  }
  return { rpc, batch, get, post, raw };
}

function hexNumber(value) { if (!quantity(value)) throw new SafeError('SCHEMA_INVALID'); const n = Number(BigInt(value)); if (!Number.isSafeInteger(n)) throw new SafeError('SCHEMA_INVALID'); return n; }
function hex32(value) { return typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value); }
function plainHex32(value) { return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value); }
function base58Bytes(value) {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(value)) return -1;
  let n = 0n; for (const char of value) n = n * 58n + BigInt('123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'.indexOf(char));
  let bytes = n === 0n ? 0 : Math.ceil(n.toString(16).length / 2); for (const char of value) { if (char !== '1') break; bytes += 1; } return bytes;
}
function base64Bytes(value, size = null) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  try { const bytes = Buffer.from(value, 'base64'); return (size === null || bytes.length === size) && bytes.toString('base64') === value; } catch (_) { return false; }
}
function suiDigest(value) { return base58Bytes(value) === 32; }
function solanaBlock(value, slot, details = 'signatures') {
  if (!value || !suiDigest(value.blockhash) || !suiDigest(value.previousBlockhash) || !integer(value.parentSlot) || value.parentSlot >= slot || !integer(value.blockTime)) return null;
  if (own(value, 'blockHeight') && value.blockHeight !== null && !integer(value.blockHeight)) return null;
  if (own(value, 'rewards') && value.rewards !== null && !Array.isArray(value.rewards)) return null;
  if (details === 'signatures' && (!Array.isArray(value.signatures) || value.signatures.some((x) => base58Bytes(x) !== 64) || own(value, 'transactions'))) return null;
  if (details === 'none' && (own(value, 'signatures') || own(value, 'transactions'))) return null;
  return value;
}
function solanaTransaction(value, slot) {
  if (!value || value.slot !== slot || !value.transaction || !Array.isArray(value.transaction.signatures) || value.transaction.signatures.some((x) => base58Bytes(x) !== 64) ||
      !value.transaction.message || typeof value.transaction.message !== 'object' || !value.meta || value.meta.logMessages !== null && !Array.isArray(value.meta.logMessages)) return false;
  if (own(value, 'version') && value.version !== 'legacy' && !integer(value.version)) return false;
  return true;
}
function evmHeader(value) {
  if (!value || typeof value !== 'object' || !quantity(value.number) || !quantity(value.timestamp) || !hex32(value.hash) || !hex32(value.parentHash) || !hex32(value.stateRoot) || !Array.isArray(value.transactions) || value.transactions.some((x) => !hex32(x))) throw new SafeError('SCHEMA_INVALID');
  return { height: hexNumber(value.number), timestamp: hexNumber(value.timestamp), hash: value.hash.toLowerCase(), parentHash: value.parentHash.toLowerCase(), stateRoot: value.stateRoot.toLowerCase(),
    beneficiary: typeof value.miner === 'string' && /^0x[0-9a-f]{40}$/i.test(value.miner) ? value.miner : null, transactions: value.transactions };
}
async function phase1Evm(row, q, now) {
  const chain = await q.rpc(row, 1, 'eth_chainId', []); const chainId = hexNumber(chain.result);
  if (row.declaredChain && /^(?:eip155:)?\d+$/i.test(row.declaredChain) && Number(row.declaredChain.replace(/^eip155:/i, '')) !== chainId) throw new SafeError('IDENTITY_MISMATCH');
  const latest = evmHeader((await q.rpc(row, 1, 'eth_getBlockByNumber', ['latest', false])).result);
  const finalized = evmHeader((await q.rpc(row, 1, 'eth_getBlockByNumber', ['finalized', false])).result);
  const freshness = safeTimestamp(finalized.timestamp, now, 15 * 60e3, 60e3); if (freshness) throw new SafeError(freshness);
  if (finalized.height > latest.height || latest.height - finalized.height > 128) throw new SafeError('SPREAD');
  return { chainKey: String(chainId), latest: latest.height, finalized: finalized.height, timestamp: finalized.timestamp,
    sample: finalized.transactions[0] || null, beneficiary: finalized.beneficiary, pinKey: `${finalized.height}:${finalized.hash}`,
    pinDigest: finalized.hash, chainIdHex: chain.result.toLowerCase(), latency: latencyBucket(chain.latencyMs) };
}
async function phase1Solana(row, q, now) {
  const genesisResponse = await q.rpc(row, 1, 'getGenesisHash', []); const genesis = genesisResponse.result; const chainKey = SOLANA_GENESIS[genesis]; if (chainKey !== 'solana:mainnet-beta') throw new SafeError('IDENTITY_UNKNOWN');
  const processed = (await q.rpc(row, 1, 'getSlot', [{ commitment: 'processed' }])).result;
  const finalized = (await q.rpc(row, 1, 'getSlot', [{ commitment: 'finalized' }])).result;
  if (!integer(processed) || !integer(finalized) || finalized > processed || processed - finalized > 2048) throw new SafeError('SPREAD');
  const blockTime = (await q.rpc(row, 1, 'getBlockTime', [finalized])).result; const freshness = safeTimestamp(blockTime, now, 2 * 60e3, 5e3); if (freshness) throw new SafeError(freshness);
  return { chainKey, latest: processed, finalized, timestamp: blockTime, sample: null, pinKey: String(finalized), pinDigest: String(finalized), genesis, latency: latencyBucket(genesisResponse.latencyMs) };
}
async function phase1Sui(row, q, now) {
  const identityResponse = await q.rpc(row, 1, 'sui_getChainIdentifier', []); const identity = identityResponse.result; const chainKey = SUI_IDS[String(identity).toLowerCase()]; if (!chainKey) throw new SafeError('IDENTITY_UNKNOWN');
  const latestRaw = (await q.rpc(row, 1, 'sui_getLatestCheckpointSequenceNumber', [])).result; if (!/^\d+$/.test(String(latestRaw))) throw new SafeError('SCHEMA_INVALID');
  const latest = Number(latestRaw); if (!integer(latest)) throw new SafeError('SCHEMA_INVALID');
  const checkpoint = (await q.rpc(row, 1, 'sui_getCheckpoint', [String(latest)])).result;
  const sequence = Number(checkpoint && checkpoint.sequenceNumber); const timestamp = normalizeTime(checkpoint && checkpoint.timestampMs);
  if (!integer(sequence) || sequence !== latest || !integer(timestamp) || !suiDigest(checkpoint && checkpoint.digest) || !/^\d+$/.test(String(checkpoint && checkpoint.epoch)) ||
      !Array.isArray(checkpoint && checkpoint.transactions) || checkpoint.transactions.some((x) => !suiDigest(x))) throw new SafeError('SCHEMA_INVALID');
  const freshness = safeTimestamp(timestamp, now, 2 * 60e3, 5e3); if (freshness) throw new SafeError(freshness);
  return { chainKey, latest, finalized: sequence, timestamp, sample: checkpoint.transactions[0] || null, pinKey: `${sequence}:${checkpoint.digest}`,
    pinDigest: checkpoint.digest, latency: latencyBucket(identityResponse.latencyMs) };
}
function cometSignatureValid(value) {
  if (!value || ![1, 2, 3].includes(Number(value.block_id_flag))) return false; const flag = Number(value.block_id_flag);
  if (flag === 1) return (value.validator_address === '' || value.validator_address === null || value.validator_address === undefined) &&
    (value.timestamp === '' || value.timestamp === null || value.timestamp === undefined || /^0001-01-01T00:00:00(?:\.0+)?Z$/.test(value.timestamp)) &&
    (value.signature === '' || value.signature === null || value.signature === undefined);
  return /^[0-9a-f]{40}$/i.test(value.validator_address || '') && Number.isFinite(Date.parse(value.timestamp)) && base64Bytes(value.signature, 64);
}
function cosmosSignatureValid(value) {
  if (!value || !['BLOCK_ID_FLAG_ABSENT', 'BLOCK_ID_FLAG_COMMIT', 'BLOCK_ID_FLAG_NIL'].includes(value.block_id_flag)) return false;
  if (value.block_id_flag === 'BLOCK_ID_FLAG_ABSENT') return (value.validator_address === '' || value.validator_address === undefined) && (value.signature === null || value.signature === undefined || value.signature === '');
  return base64Bytes(value.validator_address, 20) && Number.isFinite(Date.parse(value.timestamp)) && base64Bytes(value.signature, 64);
}
async function phase1Comet(row, q, now) {
  const statusResponse = await q.get(row, 1, '/status'); const status = statusResponse.result; const info = status && status.result && status.result.node_info; const sync = status && status.result && status.result.sync_info;
  const chainKey = info && info.network; if (!THOR_IDS.has(chainKey)) throw new SafeError('IDENTITY_UNKNOWN');
  const latest = Number(sync && sync.latest_block_height), latestHash = sync && sync.latest_block_hash; const timestamp = Math.floor(Date.parse(sync && sync.latest_block_time) / 1000);
  if (!integer(latest) || !integer(timestamp) || sync.catching_up !== false || !plainHex32(latestHash)) throw new SafeError('SCHEMA_INVALID');
  const blockRaw = (await q.get(row, 1, `/block?height=${latest}`)).result; const block = blockRaw && blockRaw.result && blockRaw.result.block; const blockHeader = block && block.header;
  if (Number(blockHeader && blockHeader.height) !== latest || blockHeader.chain_id !== chainKey || !plainHex32(blockRaw && blockRaw.result && blockRaw.result.block_id && blockRaw.result.block_id.hash) || blockRaw.result.block_id.hash.toLowerCase() !== latestHash.toLowerCase()) throw new SafeError('COMMIT_INVALID');
  const commitRaw = (await q.get(row, 1, `/commit?height=${latest}`)).result; const signedHeader = commitRaw && commitRaw.result && commitRaw.result.signed_header;
  const header = signedHeader && signedHeader.header, commit = signedHeader && signedHeader.commit, signatures = commit && commit.signatures;
  if (Number(header && header.height) !== latest || header.chain_id !== chainKey || Number(commit && commit.height) !== latest || commit.round === undefined ||
      !(commit && commit.block_id && plainHex32(commit.block_id.hash)) || commit.block_id.hash.toLowerCase() !== latestHash.toLowerCase() ||
      commitRaw.result.canonical !== true || !Array.isArray(signatures) || signatures.length === 0 || signatures.some((x) => !cometSignatureValid(x)) || !signatures.some((x) => Number(x.block_id_flag) === 2)) throw new SafeError('COMMIT_INVALID');
  const freshness = safeTimestamp(timestamp, now, 15 * 60e3, 60e3); if (freshness) throw new SafeError(freshness);
  return { chainKey, latest, finalized: latest, timestamp, sample: null, pinKey: `${latest}:${latestHash.toLowerCase()}`, pinDigest: latestHash.toLowerCase(), latency: latencyBucket(statusResponse.latencyMs) };
}
function cosmosChainKey(value) { return typeof value === 'string' && /^[a-z][a-z0-9-]{1,47}-[a-z0-9][a-z0-9.-]{0,31}$/i.test(value) ? `cosmos:${value}` : null; }
async function phase1Lcd(row, q, now) {
  const nodeResponse = await q.get(row, 1, '/cosmos/base/tendermint/v1beta1/node_info'); const node = nodeResponse.result;
  const rawId = node && (node.default_node_info && node.default_node_info.network || node.node_info && node.node_info.network); const chainKey = cosmosChainKey(rawId); if (!chainKey) throw new SafeError('IDENTITY_UNKNOWN');
  const syncing = (await q.get(row, 1, '/cosmos/base/tendermint/v1beta1/syncing')).result;
  if (!syncing || syncing.syncing !== false) throw new SafeError('SCHEMA_INVALID');
  const latest = (await q.get(row, 1, '/cosmos/base/tendermint/v1beta1/blocks/latest')).result;
  const header = latest && (latest.block && latest.block.header || latest.sdk_block && latest.sdk_block.header); const height = Number(header && header.height); const timestamp = Math.floor(Date.parse(header && header.time) / 1000);
  const commit = latest && (latest.block && latest.block.last_commit || latest.sdk_block && latest.sdk_block.last_commit);
  const commitHeight = Number(commit && commit.height), blockId = latest && latest.block_id && latest.block_id.hash;
  const signatures = commit && commit.signatures; const headerChain = header && (header.chain_id || header.chainId);
  if (!integer(height) || !integer(timestamp) || headerChain !== rawId || !base64Bytes(blockId, 32) || !integer(commitHeight) || commitHeight !== height - 1 ||
      !(commit.block_id && base64Bytes(commit.block_id.hash, 32)) || !Array.isArray(signatures) || signatures.length === 0 ||
      signatures.some((x) => !cosmosSignatureValid(x)) || !signatures.some((x) => x.block_id_flag === 'BLOCK_ID_FLAG_COMMIT')) throw new SafeError('COMMIT_INVALID');
  const freshness = safeTimestamp(timestamp, now, 15 * 60e3, 60e3); if (freshness) throw new SafeError(freshness);
  return { chainKey, latest: height, finalized: commitHeight, timestamp, sample: null, pinKey: `${commitHeight}:${commit.block_id.hash}`,
    pinDigest: commit.block_id.hash, latency: latencyBucket(nodeResponse.latencyMs) };
}
async function phase1Midgard(row, q) {
  const mounted = /\/v2\/?$/i.test(row.url && row.url.pathname || ''); const route = (leaf) => mounted ? `/${leaf}` : `/v2/${leaf}`;
  const healthResponse = await q.get(row, 1, route('health')); const health = healthResponse.result; if (!health || typeof health !== 'object') throw new SafeError('SCHEMA_INVALID');
  const network = (await q.get(row, 1, route('network'))).result; const height = Number(network && (network.currentHeight || network.height || network.lastThorNode));
  if (!integer(height)) throw new SafeError('SCHEMA_INVALID');
  return { chainKey: 'thorchain-mainnet-v1', latest: height, finalized: null, timestamp: null, sample: null, latency: latencyBucket(healthResponse.latencyMs), indexerOnly: true };
}
async function phase1Tron(row, q, now) {
  const network = String(row.declaredNetwork || '').toLowerCase(); const chainKey = `tron:${network}`; if (!TRON_NETWORKS.has(chainKey)) throw new SafeError('IDENTITY_UNKNOWN');
  const genesisResponse = await q.post(row, 1, '/wallet/getblockbynum', { num: 0 }); const genesis = genesisResponse.result;
  if (!genesis || String(genesis.blockID).toLowerCase() !== TRON_MAINNET_GENESIS) throw new SafeError('IDENTITY_MISMATCH');
  const latestRaw = (await q.post(row, 1, '/wallet/getnowblock', {})).result; const finalRaw = (await q.get(row, 1, '/walletsolidity/getnowblock')).result;
  const parse = (x) => ({ height: x && x.block_header && x.block_header.raw_data && x.block_header.raw_data.number, blockID: x && x.blockID,
    timestamp: normalizeTime(x && x.block_header && x.block_header.raw_data && x.block_header.raw_data.timestamp),
    sample: Array.isArray(x && x.transactions) && x.transactions[0] && x.transactions[0].txID || null });
  const latest = parse(latestRaw), finalized = parse(finalRaw);
  for (const block of [latest, finalized]) if (!integer(block.height) || !plainHex32(block.blockID) || BigInt(`0x${block.blockID.slice(0, 16)}`) !== BigInt(block.height) || block.sample && !plainHex32(block.sample)) throw new SafeError('SCHEMA_INVALID');
  if (!integer(latest.height) || !integer(finalized.height) || finalized.height > latest.height || latest.height - finalized.height > 128) throw new SafeError('SPREAD');
  const freshness = safeTimestamp(finalized.timestamp, now, 5 * 60e3, 30e3); if (freshness) throw new SafeError(freshness);
  return { chainKey, latest: latest.height, finalized: finalized.height, timestamp: finalized.timestamp, sample: finalized.sample,
    pinKey: `${finalized.height}:${finalized.blockID.toLowerCase()}`, pinDigest: finalized.blockID.toLowerCase(), evmChainId: TRON_EVM_CHAIN_ID, latency: latencyBucket(genesisResponse.latencyMs) };
}
const PHASE1 = Object.freeze({ EVM: phase1Evm, SOLANA: phase1Solana, SUI: phase1Sui, COMETBFT: phase1Comet, COSMOS_LCD: phase1Lcd, MIDGARD: phase1Midgard, TRON: phase1Tron });

async function readCommonPin(candidate, q, position) {
  const { row, p1 } = candidate;
  if (!integer(position) || position > p1.finalized) throw new SafeError('PIN_DISAGREEMENT');
  if (row.protocol === 'EVM') {
    const header = evmHeader((await q.rpc(row, 1, 'eth_getBlockByNumber', [`0x${position.toString(16)}`, false], undefined, 'PIN')).result);
    if (header.height !== position) throw new SafeError('PIN_DISAGREEMENT'); return { digest: header.hash, sample: header.transactions[0] || null };
  }
  if (row.protocol === 'SOLANA') {
    const block = (await q.rpc(row, 1, 'getBlock', [position, { commitment: 'finalized', transactionDetails: 'none', rewards: false, maxSupportedTransactionVersion: 0 }], undefined, 'PIN')).result;
    if (!solanaBlock(block, position, 'none')) throw new SafeError('PIN_DISAGREEMENT'); return { digest: block.blockhash, sample: null };
  }
  if (row.protocol === 'SUI') {
    const checkpoint = (await q.rpc(row, 1, 'sui_getCheckpoint', [String(position)], undefined, 'PIN')).result;
    if (Number(checkpoint && checkpoint.sequenceNumber) !== position || !suiDigest(checkpoint && checkpoint.digest)) throw new SafeError('PIN_DISAGREEMENT');
    return { digest: checkpoint.digest, sample: Array.isArray(checkpoint.transactions) ? checkpoint.transactions[0] || null : null };
  }
  if (row.protocol === 'COMETBFT') {
    const blockRaw = (await q.get(row, 1, `/block?height=${position}`, 'PIN')).result, commitRaw = (await q.get(row, 1, `/commit?height=${position}`, 'PIN')).result;
    const blockHash = blockRaw && blockRaw.result && blockRaw.result.block_id && blockRaw.result.block_id.hash;
    const signed = commitRaw && commitRaw.result && commitRaw.result.signed_header, commit = signed && signed.commit, header = signed && signed.header;
    if (!plainHex32(blockHash) || Number(blockRaw.result.block.header.height) !== position || blockRaw.result.block.header.chain_id !== p1.chainKey ||
        Number(header && header.height) !== position || header.chain_id !== p1.chainKey || Number(commit && commit.height) !== position ||
        !commit.block_id || !plainHex32(commit.block_id.hash) || commit.block_id.hash.toLowerCase() !== blockHash.toLowerCase() || commitRaw.result.canonical !== true ||
        !Array.isArray(commit.signatures) || commit.signatures.length === 0 || commit.signatures.some((x) => !cometSignatureValid(x)) || !commit.signatures.some((x) => Number(x.block_id_flag) === 2)) throw new SafeError('PIN_DISAGREEMENT');
    return { digest: blockHash.toLowerCase(), sample: null };
  }
  if (row.protocol === 'COSMOS_LCD') {
    const raw = (await q.get(row, 1, `/cosmos/base/tendermint/v1beta1/blocks/${position}`, 'PIN')).result, block = raw && (raw.block || raw.sdk_block);
    if (Number(block && block.header && block.header.height) !== position || `cosmos:${block.header.chain_id || block.header.chainId}` !== p1.chainKey || !base64Bytes(raw && raw.block_id && raw.block_id.hash, 32)) throw new SafeError('PIN_DISAGREEMENT');
    return { digest: raw.block_id.hash, sample: null };
  }
  if (row.protocol === 'TRON') {
    const block = (await q.post(row, 1, '/walletsolidity/getblockbynum', { num: position }, 'PIN')).result, id = block && block.blockID;
    if (Number(block && block.block_header && block.block_header.raw_data && block.block_header.raw_data.number) !== position || !plainHex32(id) || BigInt(`0x${id.slice(0, 16)}`) !== BigInt(position)) throw new SafeError('PIN_DISAGREEMENT');
    return { digest: id.toLowerCase(), sample: Array.isArray(block.transactions) && block.transactions[0] && block.transactions[0].txID || null };
  }
  throw new SafeError('PIN_DISAGREEMENT');
}

function unsupported(error) { return error && error.code === 'METHOD_UNSUPPORTED'; }
function endpointCapped(error, out) { if (!error || error.code !== 'ENDPOINT_CAP') return false; for (const key of Object.keys(out)) if (out[key] === 'NOT_ATTEMPTED') out[key] = 'NOT_ATTEMPTED_CAP'; return true; }
function strictEvmLogs(value, target) {
  return Array.isArray(value) && value.every((log) => log && typeof log === 'object' && /^0x[0-9a-f]{40}$/i.test(log.address) &&
    Array.isArray(log.topics) && log.topics.every(hex32) && typeof log.data === 'string' && /^0x(?:[0-9a-f]{2})*$/i.test(log.data) &&
    quantity(log.blockNumber) && hexNumber(log.blockNumber) === target && hex32(log.blockHash) && hex32(log.transactionHash) && quantity(log.logIndex));
}
function bytesHex(value) { return typeof value === 'string' && /^0x(?:[0-9a-f]{2})*$/i.test(value); }
function gethDefaultTrace(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && (integer(value.gas) || quantity(value.gas)) && typeof value.failed === 'boolean' && own(value, 'returnValue') && bytesHex(`0x${String(value.returnValue).replace(/^0x/i, '')}`) &&
    Array.isArray(value.structLogs) && value.structLogs.length > 0 && value.structLogs.every((x) => x && integer(x.pc) && typeof x.op === 'string' && x.op.length > 0 &&
      (integer(x.gas) || quantity(x.gas)) && (integer(x.gasCost) || quantity(x.gasCost)) && integer(x.depth));
}
function callTraceFrame(value, depth = 0) {
  if (depth > 32 || !value || typeof value !== 'object' || Array.isArray(value) || !/^(?:CALL|CALLCODE|DELEGATECALL|STATICCALL|CREATE|CREATE2|SELFDESTRUCT)$/.test(value.type) ||
      !/^0x[0-9a-f]{40}$/i.test(value.from || '') || !bytesHex(value.input) || own(value, 'output') && !bytesHex(value.output) || own(value, 'error') && typeof value.error !== 'string') return false;
  if (!/^CREATE/.test(value.type) && !/^0x[0-9a-f]{40}$/i.test(value.to || '')) return false;
  return !own(value, 'calls') || Array.isArray(value.calls) && value.calls.every((x) => callTraceFrame(x, depth + 1));
}
function parityTrace(value) {
  const address = (x) => /^0x[0-9a-f]{40}$/i.test(x || ''), amount = (x) => quantity(x) || integer(x);
  return Array.isArray(value) && value.length > 0 && value.every((x) => {
    if (!x || typeof x !== 'object' || !/^(?:call|create|suicide|reward)$/.test(x.type) || !x.action || typeof x.action !== 'object' ||
        !Array.isArray(x.traceAddress) || !x.traceAddress.every(integer) || own(x, 'error') && typeof x.error !== 'string' || own(x, 'result') && x.result !== null && typeof x.result !== 'object') return false;
    if (x.type === 'call') return address(x.action.from) && address(x.action.to) && bytesHex(x.action.input) && amount(x.action.gas) && amount(x.action.value) &&
      (typeof x.error === 'string' || x.result && amount(x.result.gasUsed) && bytesHex(x.result.output));
    if (x.type === 'create') return address(x.action.from) && bytesHex(x.action.init) && amount(x.action.gas) && amount(x.action.value) &&
      (typeof x.error === 'string' || x.result && address(x.result.address) && bytesHex(x.result.code) && amount(x.result.gasUsed));
    if (x.type === 'suicide') return address(x.action.address) && address(x.action.refundAddress) && amount(x.action.balance);
    return address(x.action.author) && amount(x.action.value) && typeof x.action.rewardType === 'string' && x.action.rewardType.length > 0;
  });
}
function debugTraceShape(value) { return gethDefaultTrace(value) || callTraceFrame(value); }
async function phase2Evm(row, q, p1) {
  const out = { historicalHeader: 'NOT_ATTEMPTED', historicalState: 'NOT_ATTEMPTED', logs: 'NOT_ATTEMPTED', batch: 'NOT_ATTEMPTED', trace: 'NOT_ATTEMPTED' };
  const target = Math.max(0, p1.finalized - Math.min(100000, Math.floor(p1.finalized / 2))); const tag = `0x${target.toString(16)}`;
  let header;
  try { header = evmHeader((await q.rpc(row, 2, 'eth_getBlockByNumber', [tag, false])).result); out.historicalHeader = header.height === target ? 'SUPPORTED' : 'FAILED'; } catch (error) { rethrowFatal(error); if (endpointCapped(error, out)) return out; out.historicalHeader = unsupported(error) ? 'UNSUPPORTED' : 'FAILED'; return out; }
  if (out.historicalHeader === 'SUPPORTED' && header.beneficiary && /^0x[0-9a-f]{40}$/i.test(header.beneficiary)) {
    try { out.historicalState = quantity((await q.rpc(row, 2, 'eth_getBalance', [header.beneficiary, tag])).result) ? 'SUPPORTED' : 'FAILED'; } catch (error) { rethrowFatal(error); if (endpointCapped(error, out)) return out; out.historicalState = unsupported(error) ? 'UNSUPPORTED' : 'FAILED'; }
  }
  try { out.logs = strictEvmLogs((await q.rpc(row, 2, 'eth_getLogs', [{ fromBlock: tag, toBlock: tag }])).result, target) ? 'SUPPORTED' : 'FAILED'; } catch (error) { rethrowFatal(error); if (endpointCapped(error, out)) return out; out.logs = unsupported(error) ? 'UNSUPPORTED' : 'FAILED'; }
  try { const result = await q.batch(row, 2, [['eth_chainId', []], ['eth_getBlockByNumber', [tag, false]]]); const batchHeader = evmHeader(result.results[1]); out.batch = result.results.length === 2 && String(hexNumber(result.results[0])) === p1.chainKey && batchHeader.height === target && batchHeader.hash === header.hash ? 'SUPPORTED' : 'FAILED'; } catch (error) { rethrowFatal(error); if (endpointCapped(error, out)) return out; out.batch = unsupported(error) ? 'UNSUPPORTED' : 'FAILED'; }
  if (p1.sample) {
    try { const trace = await q.rpc(row, 2, 'debug_traceTransaction', [p1.sample, { tracer: 'callTracer', timeout: '10s' }], LIMITS.traceTimeoutMs); out.trace = debugTraceShape(trace.result) ? 'SUPPORTED' : 'FAILED'; }
    catch (error) {
      rethrowFatal(error);
      if (unsupported(error)) {
        try { const trace = await q.rpc(row, 2, 'trace_transaction', [p1.sample], LIMITS.traceTimeoutMs); out.trace = parityTrace(trace.result) ? 'SUPPORTED' : 'FAILED'; }
        catch (fallback) { rethrowFatal(fallback); if (endpointCapped(fallback, out)) return out; out.trace = unsupported(fallback) ? 'UNSUPPORTED' : 'FAILED'; }
      } else { if (endpointCapped(error, out)) return out; out.trace = 'FAILED'; }
    }
  } else out.trace = 'INCONCLUSIVE';
  return out;
}
async function phase2Solana(row, q, p1) {
  const out = { historicalBlock: 'NOT_ATTEMPTED', historicalTransactionLogs: 'NOT_ATTEMPTED', batch: 'NOT_ATTEMPTED' };
  const target = Math.max(0, p1.finalized - Math.min(100000, Math.floor(p1.finalized / 2))); let sample = null, sampleSlot = null, unsupportedCount = 0;
  for (let offset = 0; offset < 3; offset++) {
    try {
      const requested = target + offset; const block = (await q.rpc(row, 2, 'getBlock', [requested, { commitment: 'finalized', transactionDetails: 'signatures', rewards: false, maxSupportedTransactionVersion: 0 }])).result;
      if (solanaBlock(block, requested, 'signatures')) {
        out.historicalBlock = 'SUPPORTED'; sample = block.signatures[0] || null; sampleSlot = requested; break;
      }
    } catch (error) { rethrowFatal(error); if (endpointCapped(error, out)) return out; if (unsupported(error)) unsupportedCount += 1; }
  }
  if (out.historicalBlock !== 'SUPPORTED') out.historicalBlock = unsupportedCount === 3 ? 'UNSUPPORTED' : 'FAILED';
  if (sample) { try { const tx = (await q.rpc(row, 2, 'getTransaction', [sample, { commitment: 'finalized', encoding: 'json', maxSupportedTransactionVersion: 0 }])).result; out.historicalTransactionLogs = solanaTransaction(tx, sampleSlot) ? 'SUPPORTED' : 'FAILED'; } catch (error) { rethrowFatal(error); if (endpointCapped(error, out)) return out; out.historicalTransactionLogs = unsupported(error) ? 'UNSUPPORTED' : 'FAILED'; } } else if (out.historicalBlock === 'SUPPORTED') out.historicalTransactionLogs = 'INCONCLUSIVE';
  try { const b = await q.batch(row, 2, [['getGenesisHash', []], ['getSlot', [{ commitment: 'finalized' }]]]); const sampled = p1.commonFinalized ?? p1.finalized;
    out.batch = b.results.length === 2 && SOLANA_GENESIS[b.results[0]] === p1.chainKey && integer(b.results[1]) && b.results[1] >= sampled ? 'SUPPORTED' : 'FAILED'; } catch (error) { rethrowFatal(error); if (endpointCapped(error, out)) return out; out.batch = unsupported(error) ? 'UNSUPPORTED' : 'FAILED'; }
  return out;
}
async function phase2Sui(row, q, p1) {
  const out = { historicalCheckpoint: 'NOT_ATTEMPTED', historicalTransactionEvents: 'NOT_ATTEMPTED', batch: 'NOT_ATTEMPTED' };
  const target = Math.max(0, p1.finalized - Math.min(10000, Math.floor(p1.finalized / 2))); let sample = null;
  try { const cp = (await q.rpc(row, 2, 'sui_getCheckpoint', [String(target)])).result; const valid = Number(cp && cp.sequenceNumber) === target && suiDigest(cp.digest) && /^\d+$/.test(String(cp.epoch)) && integer(normalizeTime(cp.timestampMs)) && Array.isArray(cp.transactions) && cp.transactions.every(suiDigest); out.historicalCheckpoint = valid ? 'SUPPORTED' : 'FAILED'; sample = valid ? cp.transactions[0] || null : null; } catch (error) { rethrowFatal(error); if (endpointCapped(error, out)) return out; out.historicalCheckpoint = unsupported(error) ? 'UNSUPPORTED' : 'FAILED'; }
  if (sample) { try { const tx = (await q.rpc(row, 2, 'sui_getTransactionBlock', [sample, { showEvents: true }])).result; out.historicalTransactionEvents = tx && tx.digest === sample && Array.isArray(tx.events) ? 'SUPPORTED' : 'FAILED'; } catch (error) { rethrowFatal(error); if (endpointCapped(error, out)) return out; out.historicalTransactionEvents = unsupported(error) ? 'UNSUPPORTED' : 'FAILED'; } } else if (out.historicalCheckpoint === 'SUPPORTED') out.historicalTransactionEvents = 'INCONCLUSIVE';
  try { const b = await q.batch(row, 2, [['sui_getChainIdentifier', []], ['sui_getCheckpoint', [String(target)]]]); out.batch = b.results.length === 2 && SUI_IDS[String(b.results[0]).toLowerCase()] === p1.chainKey && Number(b.results[1] && b.results[1].sequenceNumber) === target && suiDigest(b.results[1].digest) ? 'SUPPORTED' : 'FAILED'; } catch (error) { rethrowFatal(error); if (endpointCapped(error, out)) return out; out.batch = unsupported(error) ? 'UNSUPPORTED' : 'FAILED'; }
  return out;
}
async function phase2Comet(row, q, p1) {
  const out = { historicalBlock: 'NOT_ATTEMPTED', historicalResults: 'NOT_ATTEMPTED', batch: 'NOT_ATTEMPTED' }; const target = Math.max(1, p1.finalized - Math.min(10000, Math.floor(p1.finalized / 2)));
  let txCount = null;
  try { const b = (await q.get(row, 2, `/block?height=${target}`)).result; const block = b && b.result && b.result.block; const txs = block && block.data && block.data.txs;
    const valid = Number(block && block.header && block.header.height) === target && block.header.chain_id === p1.chainKey && plainHex32(b.result.block_id && b.result.block_id.hash) && (txs === null || txs === undefined || Array.isArray(txs) && txs.every((x) => base64Bytes(x))); out.historicalBlock = valid ? 'SUPPORTED' : 'FAILED'; txCount = valid ? Array.isArray(txs) ? txs.length : 0 : null; } catch (error) { rethrowFatal(error); if (endpointCapped(error, out)) return out; out.historicalBlock = unsupported(error) ? 'UNSUPPORTED' : 'FAILED'; }
  try { const r = (await q.get(row, 2, `/block_results?height=${target}`)).result; const results = r && r.result; const txs = results && (own(results, 'txs_results') ? results.txs_results : results.txsResults);
    const cardinality = txCount === 0 ? txs === undefined || txs === null : txCount > 0 && Array.isArray(txs) && txs.length === txCount;
    out.historicalResults = Number(results && results.height) === target && cardinality ? 'SUPPORTED' : 'FAILED'; } catch (error) { rethrowFatal(error); if (endpointCapped(error, out)) return out; out.historicalResults = unsupported(error) ? 'UNSUPPORTED' : 'FAILED'; }
  try { const b = await q.batch(row, 2, [['status', []], ['block', [String(target)]]]); out.batch = b.results.length === 2 && Number(b.results[1] && b.results[1].block && b.results[1].block.header && b.results[1].block.header.height) === target ? 'SUPPORTED' : 'FAILED'; } catch (error) { rethrowFatal(error); if (endpointCapped(error, out)) return out; out.batch = unsupported(error) ? 'UNSUPPORTED' : 'FAILED'; }
  return out;
}
async function phase2Lcd(row, q, p1) {
  const out = { historicalBlock: 'NOT_ATTEMPTED', historicalResults: 'NOT_ATTEMPTED', batch: 'NOT_APPLICABLE', trace: 'NOT_APPLICABLE' }; const target = Math.max(1, p1.finalized - Math.min(10000, Math.floor(p1.finalized / 2)));
  let txCount = null;
  try { const b = (await q.get(row, 2, `/cosmos/base/tendermint/v1beta1/blocks/${target}`)).result; const block = b && (b.block || b.sdk_block), txs = block && block.data && block.data.txs;
    const valid = Number(block && block.header && block.header.height) === target && base64Bytes(b && b.block_id && b.block_id.hash, 32) && (txs === null || txs === undefined || Array.isArray(txs) && txs.every((x) => base64Bytes(x))); out.historicalBlock = valid ? 'SUPPORTED' : 'FAILED'; txCount = valid ? Array.isArray(txs) ? txs.length : 0 : null; } catch (error) { rethrowFatal(error); if (endpointCapped(error, out)) return out; out.historicalBlock = unsupported(error) ? 'UNSUPPORTED' : 'FAILED'; }
  try { const r = (await q.get(row, 2, `/cosmos/base/tendermint/v1beta1/block_results/${target}`)).result; const txs = r && (own(r, 'txs_results') ? r.txs_results : r.txsResults);
    const cardinality = txCount === 0 ? txs === undefined || txs === null : txCount > 0 && Array.isArray(txs) && txs.length === txCount;
    out.historicalResults = Number(r && r.height) === target && cardinality ? 'SUPPORTED' : 'FAILED'; } catch (error) { rethrowFatal(error); if (endpointCapped(error, out)) return out; out.historicalResults = unsupported(error) ? 'UNSUPPORTED' : 'FAILED'; }
  return out;
}
async function phase2Tron(row, q, p1) {
  const out = { historicalBlock: 'NOT_ATTEMPTED', transactionInfoLogs: 'NOT_ATTEMPTED', batch: 'NOT_APPLICABLE', trace: 'NOT_APPLICABLE' }; const target = Math.max(0, p1.finalized - Math.min(100000, Math.floor(p1.finalized / 2))); let sample = null;
  try { const b = (await q.post(row, 2, '/walletsolidity/getblockbynum', { num: target })).result; const id = b && b.blockID; const valid = Number(b && b.block_header && b.block_header.raw_data && b.block_header.raw_data.number) === target && plainHex32(id) && BigInt(`0x${id.slice(0, 16)}`) === BigInt(target); sample = Array.isArray(b && b.transactions) && b.transactions[0] && b.transactions[0].txID || null; out.historicalBlock = valid && (!sample || plainHex32(sample)) ? 'SUPPORTED' : 'FAILED'; if (out.historicalBlock !== 'SUPPORTED') sample = null; } catch (error) { rethrowFatal(error); if (endpointCapped(error, out)) return out; out.historicalBlock = unsupported(error) ? 'UNSUPPORTED' : 'FAILED'; }
  if (sample) { try { const info = (await q.post(row, 2, '/walletsolidity/gettransactioninfobyid', { value: sample })).result; out.transactionInfoLogs = info && info.id === sample && Array.isArray(info.log) ? 'SUPPORTED' : 'FAILED'; } catch (error) { rethrowFatal(error); if (endpointCapped(error, out)) return out; out.transactionInfoLogs = unsupported(error) ? 'UNSUPPORTED' : 'FAILED'; } } else if (out.historicalBlock === 'SUPPORTED') out.transactionInfoLogs = 'INCONCLUSIVE';
  return out;
}
const PHASE2 = Object.freeze({ EVM: phase2Evm, SOLANA: phase2Solana, SUI: phase2Sui, COMETBFT: phase2Comet, COSMOS_LCD: phase2Lcd, TRON: phase2Tron });

function rank(a, b) {
  const bool = (v) => v ? 1 : 0;
  return bool(b.row.phase2Declared) - bool(a.row.phase2Declared) || bool(b.row.premium) - bool(a.row.premium) ||
    b.p1.timestamp - a.p1.timestamp || ['LT_250MS', '250_999MS', '1_2999S', 'GE_3S'].indexOf(a.p1.latency) - ['LT_250MS', '250_999MS', '1_2999S', 'GE_3S'].indexOf(b.p1.latency) || a.row.order - b.row.order;
}
async function mapLimit(rows, limit, worker, budget) {
  const out = new Array(rows.length); let next = 0;
  async function run() {
    while (true) {
      budget.assertLive();
      const i = next++; if (i >= rows.length) return; const family = rows[i].family;
      while ((budget.familyActive.get(family) || 0) >= LIMITS.perFamilyConcurrency) { budget.assertLive(); await budget.awaitLive(budget.sleep(1)); budget.assertLive(); }
      budget.assertLive();
      budget.familyActive.set(family, (budget.familyActive.get(family) || 0) + 1); budget.maxFamilyActive = Math.max(budget.maxFamilyActive || 0, budget.familyActive.get(family)); budget.active += 1; budget.maxActive = Math.max(budget.maxActive, budget.active);
      try { budget.assertLive(); out[i] = await worker(rows[i], i); budget.assertLive(); } finally { budget.active -= 1; budget.familyActive.set(family, budget.familyActive.get(family) - 1); }
    }
  }
  const settled = await Promise.allSettled(Array.from({ length: Math.min(limit, rows.length || 1) }, run)); const rejected = settled.find((result) => result.status === 'rejected');
  if (rejected) { if (budget.fatalExhaustion) throw new SafeError(budget.fatalCode || 'DEADLINE'); throw rejected.reason; } return out;
}
function failureCounts(results) { const out = {}; for (const r of results) if (!r.ok) out[r.code] = (out[r.code] || 0) + 1; return Object.fromEntries(Object.entries(out).sort()); }
const CAPABILITY_KEYS = Object.freeze({ EVM: ['batch', 'historicalHeader', 'historicalState', 'logs', 'trace'], SOLANA: ['batch', 'historicalBlock', 'historicalTransactionLogs'],
  SUI: ['batch', 'historicalCheckpoint', 'historicalTransactionEvents'], COMETBFT: ['batch', 'historicalBlock', 'historicalResults'],
  COSMOS_LCD: ['batch', 'historicalBlock', 'historicalResults', 'trace'], TRON: ['batch', 'historicalBlock', 'trace', 'transactionInfoLogs'] });
function aggregateCapabilities(protocol, outputs) {
  const result = {};
  for (const key of CAPABILITY_KEYS[protocol] || []) {
    const defaultValue = (protocol === 'COSMOS_LCD' || protocol === 'TRON') && ['batch', 'trace'].includes(key) ? 'NOT_APPLICABLE' : 'FAILED';
    const rows = outputs.map((x) => ({ family: x.family, value: x.output && x.output[key] !== undefined ? x.output[key] : defaultValue }));
    if (!rows.length) {
      const notApplicable = (protocol === 'COSMOS_LCD' || protocol === 'TRON') && ['batch', 'trace'].includes(key);
      result[key] = { status: notApplicable ? 'NOT_APPLICABLE' : 'NOT_ATTEMPTED', familyPassCount: 0, attempted: 0, success: 0, failed: 0, inconclusive: 0, unsupported: 0, notAttempted: notApplicable ? 0 : 1, notAttemptedCap: 0 }; continue;
    }
    if (rows.every((x) => x.value === 'NOT_APPLICABLE')) { result[key] = { status: 'NOT_APPLICABLE', familyPassCount: 0, attempted: 0, success: 0, failed: 0, inconclusive: 0, unsupported: 0, notAttempted: 0, notAttemptedCap: 0 }; continue; }
    const normalized = rows.map((x) => ({ ...x, value: x.value === true || /^SUPPORTED/.test(String(x.value)) ? 'SUPPORTED' : x.value === false ? 'FAILED' : x.value }));
    const attemptedRows = normalized.filter((x) => !['NOT_APPLICABLE', 'NOT_ATTEMPTED', 'NOT_ATTEMPTED_CAP'].includes(x.value));
    const passed = attemptedRows.filter((x) => x.value === 'SUPPORTED');
    const familyPassCount = new Set(passed.map((x) => x.family)).size, attempted = attemptedRows.length, success = passed.length;
    const failed = attemptedRows.filter((x) => x.value === 'FAILED').length, inconclusive = attemptedRows.filter((x) => x.value === 'INCONCLUSIVE').length;
    const unsupportedCount = attemptedRows.filter((x) => x.value === 'UNSUPPORTED').length, notAttempted = normalized.filter((x) => x.value === 'NOT_ATTEMPTED').length;
    const notAttemptedCap = normalized.filter((x) => x.value === 'NOT_ATTEMPTED_CAP').length;
    const capabilityStatus = familyPassCount >= 2 ? 'SUPPORTED' : familyPassCount === 1 ? 'PARTIAL_SINGLE_FAMILY' : attempted === 0 ? notAttemptedCap ? 'NOT_ATTEMPTED_CAP' : 'NOT_ATTEMPTED' :
      failed > 0 ? 'FAILED' : inconclusive > 0 ? 'INCONCLUSIVE' : unsupportedCount === attempted ? 'UNSUPPORTED' : 'INCONCLUSIVE';
    result[key] = { status: capabilityStatus, familyPassCount, attempted, success, failed, inconclusive, unsupported: unsupportedCount, notAttempted, notAttemptedCap };
  }
  if (protocol === 'MIDGARD') return {};
  return result;
}
function phase2Useful(output) {
  return Object.values(output || {}).some((value) => value === true || value === 'SUPPORTED' || /^SUPPORTED_/.test(String(value)));
}

function artifactBase(nowIso, parsed, budgetSummary) {
  const reasonCounts = {}; for (const row of parsed.records.filter((x) => x.category !== 'SUPPORTED_PROBE_ENDPOINT')) reasonCounts[row.reason] = (reasonCounts[row.reason] || 0) + 1;
  const probeable = parsed.records.filter((r) => r.category === 'SUPPORTED_PROBE_ENDPOINT').length;
  const nonprobeable = parsed.records.length - probeable;
  const categoryCounts = {}; for (const occurrence of parsed.occurrences) categoryCounts[occurrence.category] = (categoryCounts[occurrence.category] || 0) + 1;
  const endpointOccurrences = parsed.occurrences.filter((x) => !['ORIGIN_METADATA', 'HEADER_METADATA'].includes(x.category));
  const protocolCounts = {}; for (const protocol of PROTOCOLS) { const rows = parsed.records.filter((x) => x.protocol === protocol); protocolCounts[protocol] = {
    classifiedRecords: rows.length, probeableCandidates: rows.filter((x) => x.category === 'SUPPORTED_PROBE_ENDPOINT').length,
    nonprobeableRecords: rows.filter((x) => x.category !== 'SUPPORTED_PROBE_ENDPOINT').length, wssGaps: rows.filter((x) => x.reason === 'NON_PROBEABLE_WSS').length }; }
  return {
    schema: SCHEMA, generatedAt: nowIso, status: nonprobeable ? 'COMPLETE_WITH_GAPS' : 'COMPLETE',
    diagnosticGate: { status: 'PASS', stage: 'READY', subcode: 'READY', consumed: true },
    phaseSeparation: { phase1CompletedBeforeSelection: true, everyProbeableCandidateEvaluated: true, everyClassifiedRecordEvaluated: nonprobeable === 0, phase2AuthoritativePassingChainsOnly: true },
    inventory: { occurrenceCount: parsed.occurrenceCount, uniqueNormalizedRecords: parsed.records.length, classifiedRecords: parsed.records.length,
      probeableCandidates: probeable, nonprobeableRecords: nonprobeable, duplicateOccurrences: endpointOccurrences.length - parsed.records.length,
      categoryCounts: Object.fromEntries(Object.entries(categoryCounts).sort()), annotationCounts: { origins: endpointOccurrences.reduce((n, x) => n + (x.originAnnotations || 0), 0), approvedFields: endpointOccurrences.reduce((n, x) => n + (x.approvedFields || 0), 0) },
      protocolCounts, nonprobeableGapCounts: Object.fromEntries(Object.entries(reasonCounts).sort()) },
    protocols: [], chains: [], budgets: { limits: { phase1Requests: LIMITS.phase1Requests, phase2Requests: LIMITS.phase2Requests,
      totalRequests: LIMITS.requests, logicalOps: LIMITS.logicalOps, perCandidateRequests: LIMITS.perEndpointRequests,
      perCandidateLogicalOps: LIMITS.perEndpointLogicalOps, globalResponseBytes: LIMITS.globalBytes }, used: budgetSummary },
    safety: { readOnly: true, graphqlOutOfScope: true, httpsOnlyProbes: true, wssCountOnly: true, redirectsFollowed: 0,
      retries: 0, compressionAccepted: false, environmentProxiesRejected: true, directNodeHttps: true, dnsPublicResolutionEveryRequest: true,
      dnsAddressPinnedPerRequest: true, dnsToConnectTOCTOUNonclaim: false, keepAlive: false, backendOperatorIndependenceClaimed: false,
      secretConnectionMaterialPersisted: false, secretConnectionMaterialHashed: false, rawResponsesPersisted: false,
      exactChainObjectsPersisted: false,
      signedTransactions: false, broadcasts: false, mutation: false, ethCall: false, simulation: false,
      hypotheticalTrace: false, stateOverrides: false },
    leakCheck: { status: 'PASS', directCorpusScan: true, genericPatternScan: true },
    nonclaims: ['BACKEND_OPERATOR_INDEPENDENCE_NOT_ESTABLISHED', 'CAPABILITY_OBSERVATION_NOT_AVAILABILITY_GUARANTEE', 'COMMIT_SIGNATURES_STRUCTURAL_NOT_CRYPTOGRAPHIC_VOTING_POWER', 'WINDOWS_DIRECTORY_FSYNC_DURABILITY_NOT_GUARANTEED'],
  };
}
function leakScan(serialized, corpus) {
  const lower = serialized.toLowerCase();
  for (const item of corpus) if (String(item).length >= 3 && lower.includes(String(item).toLowerCase())) fail('LEAK_CHECK');
  if (/(?:https?|wss):\/\//i.test(serialized) || /\b(?:authorization|bearer|x-api-key|api[_-]?key|credential|token)\b\s*[:=]/i.test(serialized)) fail('LEAK_CHECK');
  const domain = /(?:^|["\s])(?:[a-z0-9-]+\.)+[a-z]{2,63}(?:["\s]|$)/i;
  if (domain.test(serialized)) fail('LEAK_CHECK');
  const forbiddenKey = /(?:url|uri|host|domain|provider|family|endpoint|header|credential|authorization|bearer|token|api.?key)/i;
  const permitted = new Set(['historicalHeader', 'familyPassCount', 'maxFamilyConcurrencyObserved', 'SUPPORTED_PROBE_ENDPOINT', 'HEADER_METADATA']);
  let parsed; try { parsed = JSON.parse(serialized); } catch (_) { fail('LEAK_CHECK'); }
  (function walk(value) {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) { if (!permitted.has(key) && forbiddenKey.test(key)) fail('LEAK_CHECK'); walk(child); }
  })(parsed);
}

function ensureOutputParent(root, fsOps = fs) {
  const output = path.join(root, OUTPUT_REL); const relative = path.relative(root, output);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('OUTPUT_PATH');
  let current = root;
  for (const part of path.dirname(OUTPUT_REL).split(/[\\/]/)) {
    current = path.join(current, part);
    try { const st = fsOps.lstatSync(current); if (!st.isDirectory() || st.isSymbolicLink()) fail('OUTPUT_PATH'); }
    catch (error) { if (error instanceof SafeError) throw error; if (!error || error.code !== 'ENOENT') fail('OUTPUT_PATH'); fsOps.mkdirSync(current); }
  }
  try { fsOps.lstatSync(output); fail('OUTPUT_EXISTS'); } catch (error) { if (error instanceof SafeError) throw error; if (!error || error.code !== 'ENOENT') fail('OUTPUT_EXISTS'); }
  return output;
}
function preflightOutput({ root = ROOT, fsOps = fs } = {}) {
  const output = ensureOutputParent(root, fsOps); const parent = path.dirname(output); const base = path.basename(output);
  const source = path.join(parent, `.${base}.${process.pid}.${crypto.randomBytes(10).toString('hex')}.preflight`);
  const linked = `${source}.link`; let fd;
  try {
    fd = fsOps.openSync(source, 'wx', 0o600); fsOps.writeFileSync(fd, 'preflight\n', 'utf8'); fsOps.fsyncSync(fd); fsOps.closeSync(fd); fd = undefined;
    fsOps.linkSync(source, linked); const a = fsOps.lstatSync(source), b = fsOps.lstatSync(linked);
    if (!a.isFile() || !b.isFile() || a.size !== b.size) fail('PUBLISH_FAILED');
  } catch (error) {
    if (fd !== undefined) try { fsOps.closeSync(fd); } catch (_) {}
    try { fsOps.unlinkSync(linked); } catch (_) {} try { fsOps.unlinkSync(source); } catch (_) {}
    throw error instanceof SafeError ? error : new SafeError('PUBLISH_FAILED');
  }
  try { fsOps.unlinkSync(linked); fsOps.unlinkSync(source); } catch (_) { fail('PUBLISH_FAILED'); }
  return output;
}
function atomicPublish(serialized, { root = ROOT, fsOps = fs, validate = null, randomBytes = crypto.randomBytes, platform = process.platform } = {}) {
  if (Buffer.byteLength(serialized) > LIMITS.artifactBytes) terminal('ARTIFACT', 'ARTIFACT_SIZE');
  if (validate) { try { validate(serialized); } catch (_) { terminal('ARTIFACT', 'ARTIFACT_INVALID'); } }
  let parent; try { parent = preflight.safeParent(root, OUTPUT_REL, { fsOps, create: false }); } catch (_) { terminal('ARTIFACT', 'PUBLISH_FAILED'); }
  const output = path.join(root, OUTPUT_REL); absent(output, fsOps, 'ARTIFACT', 'OUTPUT_EXISTS'); let names;
  try { names = fsOps.readdirSync(parent); } catch (_) { terminal('ARTIFACT', 'PUBLISH_FAILED'); }
  if (names.some((name) => preflight.TEMP_PATTERNS.capability.test(name))) terminal('ARTIFACT', 'PUBLISH_FAILED');
  const temp = path.join(parent, `.capability.json.${process.pid}.${randomBytes(8).toString('hex')}.tmp`); const expected = Buffer.from(serialized, 'utf8'); let fd; let linked = false;
  try {
    fd = fsOps.openSync(temp, 'wx', 0o600); fsOps.writeFileSync(fd, expected); fsOps.fsyncSync(fd); fsOps.closeSync(fd); fd = undefined;
    fsOps.linkSync(temp, output); linked = true;
    const stat = fsOps.lstatSync(output), body = fsOps.readFileSync(output); if (!stat.isFile() || stat.isSymbolicLink() || body.length !== expected.length || !body.equals(expected)) throw new Error('verify');
    preflight.fsyncDirectory(parent, { fsOps, platform, stage: 'OUTPUT_PREFLIGHT' }); fsOps.unlinkSync(temp); preflight.fsyncDirectory(parent, { fsOps, platform, stage: 'OUTPUT_PREFLIGHT' });
  } catch (error) {
    if (fd !== undefined) try { fsOps.closeSync(fd); } catch (_) {}
    try { fsOps.unlinkSync(temp); } catch (_) {} if (linked) try { fsOps.unlinkSync(output); } catch (_) {}
    if (error instanceof SafeError && error.code === 'OUTPUT_EXISTS') terminal('ARTIFACT', 'OUTPUT_EXISTS'); terminal('ARTIFACT', 'PUBLISH_FAILED');
  }
  return output;
}

function terminal(stage, subcode) { const error = new SafeError(subcode); error.stage = stage; error.subcode = subcode; throw error; }
function prenetworkPair(stage, subcode) { const mapped = `${stage}_${subcode}`; if (!PRENETWORK_PREFLIGHT_STAGES.includes(stage) || !preflight.STAGE_SUBCODES[stage]?.includes(subcode) || !RUNTIME_STAGE_SUBCODES.PRENETWORK.includes(mapped)) terminal('INTERNAL', 'UNEXPECTED'); return mapped; }
function prenetwork(error) { const normalized = new SafeError(error.subcode); normalized.stage = 'PRENETWORK'; normalized.subcode = prenetworkPair(error.stage, error.subcode); throw normalized; }
function absent(file, fsOps, stage, subcode) { try { fsOps.lstatSync(file); terminal(stage, subcode); } catch (error) { if (error instanceof SafeError) throw error; if (!error || error.code !== 'ENOENT') terminal(stage, subcode); } }
function consumeGate({ root = ROOT, fsOps = fs, now = Date.now(), platform = process.platform } = {}) {
  const markerPath = path.join(root, PREFLIGHT_REL), consumedPath = path.join(root, CONSUMED_REL), capabilityPath = path.join(root, OUTPUT_REL);
  let parent; try { preflight.safeRoot(root, fsOps); parent = preflight.safeParent(root, PREFLIGHT_REL, { fsOps, create: false }); } catch (_) { terminal('GATE', 'MARKER_INVALID'); }
  let markerDirNames; try { markerDirNames = fsOps.readdirSync(parent); } catch (_) { terminal('GATE', 'MARKER_INVALID'); } if (markerDirNames.some((name) => preflight.TEMP_PATTERNS.marker.test(name))) terminal('GATE', 'TEMP_REMNANT');
  try { fsOps.lstatSync(consumedPath); terminal('GATE', 'ALREADY_CONSUMED'); } catch (error) { if (error instanceof SafeError) throw error; if (!error || error.code !== 'ENOENT') terminal('GATE', 'MARKER_INVALID'); }
  try { fsOps.lstatSync(capabilityPath); terminal('GATE', 'CAPABILITY_EXISTS'); } catch (error) { if (error instanceof SafeError) throw error; if (!error || error.code !== 'ENOENT') terminal('GATE', 'CAPABILITY_EXISTS'); }
  let before, bytes, after; try { before = fsOps.lstatSync(markerPath); bytes = fsOps.readFileSync(markerPath); after = fsOps.lstatSync(markerPath); }
  catch (_) { terminal('GATE', 'MARKER_MISSING'); }
  if (!before.isFile() || before.isSymbolicLink() || before.size > preflight.MAX_MARKER_BYTES || !Buffer.isBuffer(bytes) || bytes.length !== before.size || after.size !== before.size || after.dev !== before.dev || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs) terminal('GATE', 'MARKER_INVALID');
  let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (_) { terminal('GATE', 'MARKER_INVALID'); }
  let markerValue; try { markerValue = preflight.validateMarkerSerialized(text, { now, requirePass: true }); } catch (_) {
    let candidate; try { candidate = JSON.parse(text); } catch (_) {} if (candidate && Number.isFinite(Date.parse(candidate.expiresAt)) && now >= Date.parse(candidate.expiresAt)) terminal('GATE', 'MARKER_STALE'); terminal('GATE', 'MARKER_INVALID');
  }
  if (markerValue.status !== 'PASS' || markerValue.stage !== 'READY' || markerValue.subcode !== 'READY') terminal('GATE', 'MARKER_INVALID');
  try { fsOps.linkSync(markerPath, consumedPath); } catch (_) { terminal('GATE', 'HARDLINK_FAILED'); }
  let consumedStat, consumedBytes; try { consumedStat = fsOps.lstatSync(consumedPath); consumedBytes = fsOps.readFileSync(consumedPath); } catch (_) { terminal('GATE', 'VERIFY_FAILED'); }
  if (!consumedStat.isFile() || consumedStat.isSymbolicLink() || consumedBytes.length !== bytes.length || !consumedBytes.equals(bytes)) terminal('GATE', 'VERIFY_FAILED');
  let fd; try { fd = fsOps.openSync(consumedPath, 'r+'); fsOps.fsyncSync(fd); fsOps.closeSync(fd); fd = undefined; } catch (_) { if (fd !== undefined) try { fsOps.closeSync(fd); } catch (_) {} terminal('GATE', 'FILE_FSYNC_FAILED'); }
  try { preflight.fsyncDirectory(parent, { fsOps, platform, stage: 'OUTPUT_PREFLIGHT' }); } catch (_) { terminal('GATE', 'DIRECTORY_FSYNC_FAILED'); }
  try { fsOps.unlinkSync(markerPath); } catch (_) { terminal('GATE', 'SOURCE_UNLINK_FAILED'); }
  try { preflight.fsyncDirectory(parent, { fsOps, platform, stage: 'OUTPUT_PREFLIGHT' }); } catch (_) { terminal('GATE', 'DIRECTORY_FSYNC_FAILED'); }
  try { fsOps.lstatSync(markerPath); terminal('GATE', 'PARTIAL'); } catch (error) { if (error instanceof SafeError) throw error; if (!error || error.code !== 'ENOENT') terminal('GATE', 'PARTIAL'); }
  try { const finalStat = fsOps.lstatSync(consumedPath), finalBytes = fsOps.readFileSync(consumedPath); if (!finalStat.isFile() || finalStat.isSymbolicLink() || !finalBytes.equals(bytes)) terminal('GATE', 'PARTIAL'); } catch (error) { if (error instanceof SafeError) throw error; terminal('GATE', 'PARTIAL'); }
  return { marker: markerValue, serialized: text };
}
function offlineRecheck({ root = ROOT, fsOps = fs, randomBytes = crypto.randomBytes, platform = process.platform } = {}) {
  let text, parsed; try { text = preflight.readInventory({ root, fsOps }); parsed = preflight.classify(text); preflight.wssCounterparts(parsed); }
  catch (error) { if (error instanceof preflight.PreflightError) prenetwork(error); terminal('INTERNAL', 'UNEXPECTED'); }
  try { preflight.probeOutputFilesystem({ root, fsOps, randomBytes, platform }); } catch (error) { if (error instanceof preflight.PreflightError) prenetwork(error); terminal('INTERNAL', 'UNEXPECTED'); }
  return { text, parsed };
}
function fatalAt(stage, error, budget) { const code = error instanceof SafeError && FATAL_CODES.has(error.code) ? error.code : 'INTERNAL_INVARIANT'; try { budget.fatal(code); } catch (_) {} terminal(stage, code); }

async function run(options = {}) {
  const clock = options.clock || Date.now, root = options.root || ROOT, fsOps = options.fsOps || fs;
  try { preflight.validateInvocation({ argv: options.argv, execArgv: options.execArgv, env: options.env }); } catch (error) { if (error instanceof preflight.PreflightError) prenetwork(error); terminal('INTERNAL', 'UNEXPECTED'); }
  consumeGate({ root, fsOps, now: clock(), platform: options.platform });
  const { text, parsed } = offlineRecheck({ root, fsOps, randomBytes: options.randomBytes || crypto.randomBytes, platform: options.platform || process.platform }); const budget = options.budget || new Budget({ clock, sleep: options.sleep, pace: options.pace !== false });
  const probeRows = parsed.records.filter((r) => r.category === 'SUPPORTED_PROBE_ENDPOINT');
  const q = makeRequester({ transport: options.transport, budget, lookup: options.lookup, requestImpl: options.requestImpl, clock });
  const httpRows = probeRows.filter((r) => r.protocol && r.url && r.url.protocol === 'https:');
  let p1Results;
  try {
    p1Results = await mapLimit(httpRows, LIMITS.concurrency, async (row) => {
      row.phase1ActiveMs = row.phase1ActiveMs || 0; row.totalActiveMs = row.totalActiveMs || 0;
      try { const p1 = await PHASE1[row.protocol](row, q, clock()); return { ok: true, row, p1 }; }
      catch (error) { if (!(error instanceof SafeError)) terminal('INTERNAL', 'UNEXPECTED'); if (FATAL_CODES.has(error.code)) fatalAt('PHASE1', error, budget); return { ok: false, row, code: finiteFailure(error.code) }; }
    }, budget);
  } catch (error) {
    if (error instanceof SafeError && error.stage === 'PHASE1' && RUNTIME_STAGE_SUBCODES.PHASE1.includes(error.subcode)) throw error;
    if (budget.fatalExhaustion || error instanceof SafeError && FATAL_CODES.has(error.code)) fatalAt('PHASE1', new SafeError(budget.fatalCode || error.code), budget);
    terminal('INTERNAL', 'UNEXPECTED');
  }
  const chains = new Map();
  for (const result of p1Results.filter((x) => x.ok && AUTHORITATIVE.has(x.row.protocol))) {
    const key = `${result.row.protocol}\0${result.p1.chainKey}`; if (!chains.has(key)) chains.set(key, []); chains.get(key).push(result);
  }
  if (chains.size > LIMITS.chainIdentities) terminal('ARTIFACT', 'CHAIN_OVERFLOW');
  const chainArtifacts = []; const pairingGaps = Object.fromEntries(PROTOCOLS.map((p) => [p, 0]));
  for (const [, allCandidates] of chains) {
    allCandidates.sort(rank); const seenHosts = new Set(); const hostDedupedCandidates = allCandidates.filter((candidate) => {
      const host = candidate.row.url.hostname.toLowerCase(); if (seenHosts.has(host)) return false; seenHosts.add(host); return true;
    });
    const protocol = hostDedupedCandidates[0].row.protocol;
    const spreadLimit = protocol === 'SOLANA' ? 2048 : protocol === 'SUI' ? 100 : protocol === 'COMETBFT' || protocol === 'COSMOS_LCD' ? 20 : 128;
    let proposed = null;
    for (let i = 0; i < hostDedupedCandidates.length && !proposed; i++) for (let j = i + 1; j < hostDedupedCandidates.length; j++) {
      if (hostDedupedCandidates[i].row.family !== hostDedupedCandidates[j].row.family && Math.abs(hostDedupedCandidates[i].p1.latest - hostDedupedCandidates[j].p1.latest) <= spreadLimit) { proposed = [hostDedupedCandidates[i], hostDedupedCandidates[j]]; break; }
    }
    if (!proposed) { pairingGaps[protocol] += 1; continue; }
    const commonFinalized = Math.min(proposed[0].p1.finalized, proposed[1].p1.finalized);
    const spareForPin = hostDedupedCandidates.find((x) => !proposed.includes(x) && !proposed.some((s) => s.row.family === x.row.family) && x.p1.finalized >= commonFinalized && proposed.every((s) => Math.abs(x.p1.latest - s.p1.latest) <= spreadLimit));
    const pinTargets = [...proposed, ...(spareForPin ? [spareForPin] : [])], pinned = []; let commonPinFailures = 0;
    for (const candidate of pinTargets) {
      try { const pin = await readCommonPin(candidate, q, commonFinalized); candidate.p1.commonFinalized = commonFinalized; candidate.p1.commonPinDigest = pin.digest; if (pin.sample) candidate.p1.sample = pin.sample; pinned.push(candidate); }
      catch (error) { if (!(error instanceof SafeError)) terminal('INTERNAL', 'UNEXPECTED'); if (FATAL_CODES.has(error.code)) fatalAt('PINNING', error, budget); commonPinFailures += 1; }
    }
    const selected = proposed.every((candidate) => pinned.includes(candidate)) && proposed[0].p1.commonPinDigest === proposed[1].p1.commonPinDigest ? proposed : null;
    if (!selected) { pairingGaps[protocol] += 1; continue; }
    const candidates = hostDedupedCandidates, families = new Set(candidates.map((x) => x.row.family));
    const third = pinned.find((x) => !selected.includes(x) && !selected.some((s) => s.row.family === x.row.family) && x.p1.commonPinDigest === selected[0].p1.commonPinDigest);
    const phase2Outputs = []; let replacementUsed = false; let candidateFailures = 0; let candidateSuccesses = 0;
    for (let i = 0; i < selected.length; i++) {
      try { const output = await PHASE2[selected[i].row.protocol](selected[i].row, q, selected[i].p1); phase2Outputs.push({ family: selected[i].row.family, output });
        if (Object.values(output).includes('FAILED')) {
          candidateFailures += 1;
          if (!replacementUsed && third) { replacementUsed = true; try { const replacement = await PHASE2[third.row.protocol](third.row, q, third.p1); phase2Outputs.push({ family: third.row.family, output: replacement }); if (Object.values(replacement).includes('FAILED')) candidateFailures += 1; else candidateSuccesses += 1; } catch (replacementError) { if (!(replacementError instanceof SafeError)) terminal('INTERNAL', 'UNEXPECTED'); if (FATAL_CODES.has(replacementError.code)) fatalAt('PHASE2', replacementError, budget); candidateFailures += 1; phase2Outputs.push({ family: third.row.family, output: null }); } }
        } else candidateSuccesses += 1; }
      catch (error) {
        if (!(error instanceof SafeError)) terminal('INTERNAL', 'UNEXPECTED'); if (FATAL_CODES.has(error.code)) fatalAt('PHASE2', error, budget); candidateFailures += 1; phase2Outputs.push({ family: selected[i].row.family, output: null });
        if (!replacementUsed && third) { replacementUsed = true; try { const output = await PHASE2[third.row.protocol](third.row, q, third.p1); phase2Outputs.push({ family: third.row.family, output }); candidateSuccesses += 1; } catch (replacementError) { if (!(replacementError instanceof SafeError)) terminal('INTERNAL', 'UNEXPECTED'); if (FATAL_CODES.has(replacementError.code)) fatalAt('PHASE2', replacementError, budget); candidateFailures += 1; phase2Outputs.push({ family: third.row.family, output: null }); } }
      }
    }
    const attemptedCandidates = 2 + (replacementUsed ? 1 : 0), capabilities = aggregateCapabilities(selected[0].row.protocol, phase2Outputs);
    const failedObservations = Object.values(capabilities).some((capability) => capability.failed > 0);
    const limitedObservations = Object.values(capabilities).some((capability) => capability.notAttemptedCap > 0);
    const phase2Completion = candidateSuccesses === 0 ? 'FAILED' : candidateFailures || failedObservations || limitedObservations || commonPinFailures ? 'PARTIAL' : 'COMPLETE';
    const chainKey = selected[0].p1.chainKey;
    const chainWssGap = parsed.records.some((row) => row.reason === 'NON_PROBEABLE_WSS' && row.protocol === selected[0].row.protocol &&
      (!row.declaredChain && !row.declaredNetwork || [row.declaredChain, row.declaredNetwork].filter(Boolean).some((value) => chainKey === value || chainKey.endsWith(`:${value}`))));
    chainArtifacts.push({ chainKey, protocol: selected[0].row.protocol, status: phase2Completion === 'FAILED' ? 'PHASE1_PASS_PHASE2_FAILED' : 'PASS', phase1: {
      qualifyingCandidates: candidates.length, distinctGroupCount: families.size, retainedCandidates: 2, validPair: true,
      commonPinAgreement: true, commonPinReadVerified: true, commonPinFailures, protocolSpreadWithinLimit: true, wssGap: chainWssGap },
      phase2: { ran: true, attemptedCandidates: 2 + (replacementUsed ? 1 : 0), spareCandidateAvailable: !!third,
        replacementUsed, candidateSuccesses, candidateFailures, completion: phase2Completion,
        attemptAccountingValid: attemptedCandidates === candidateSuccesses + candidateFailures, capabilities },
      backendOperatorIndependenceClaimed: false });
  }
  chainArtifacts.sort((a, b) => a.protocol.localeCompare(b.protocol) || a.chainKey.localeCompare(b.chainKey));
  const protocols = PROTOCOLS.map((protocol) => {
    const results = p1Results.filter((x) => x.row.protocol === protocol); const passed = results.filter((x) => x.ok);
    return { protocol, classifiedRecords: parsed.records.filter((x) => x.protocol === protocol).length,
      probeableCandidates: httpRows.filter((x) => x.protocol === protocol).length,
      nonprobeableRecords: parsed.records.filter((x) => x.protocol === protocol && x.category !== 'SUPPORTED_PROBE_ENDPOINT').length,
      wssGaps: parsed.records.filter((x) => x.protocol === protocol && x.reason === 'NON_PROBEABLE_WSS').length,
      phase1: { attempted: results.length, qualified: passed.length, failures: failureCounts(results) },
      passingChains: chainArtifacts.filter((x) => x.protocol === protocol).length, pairingGaps: pairingGaps[protocol],
      phase2Ran: chainArtifacts.some((x) => x.protocol === protocol), authoritativeFinality: protocol !== 'MIDGARD' };
  });
  const artifact = artifactBase(new Date(clock()).toISOString(), parsed, budget.summary()); artifact.protocols = protocols; artifact.chains = chainArtifacts;
  if (parsed.unclassified || p1Results.some((x) => !x.ok) || Object.values(pairingGaps).some(Boolean) || chainArtifacts.some((x) => x.phase2.completion !== 'COMPLETE')) artifact.status = 'COMPLETE_WITH_GAPS';
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`; try { leakScan(serialized, parsed.leakCorpus); } catch (_) { terminal('ARTIFACT', 'LEAK_CHECK'); }
  const validatorModule = options.validator ? null : require('./validate-all-chain-endpoints-v2.js');
  const validateBeforePublish = (textToValidate) => options.validator ? options.validator(textToValidate, { now: clock() }) :
    validatorModule.validateSerializedAgainstFixedInventory(textToValidate, { root, fsOps, now: clock() });
  if (options.publish !== false) atomicPublish(serialized, { root, fsOps, validate: validateBeforePublish });
  return { artifact, serialized, calls: budget.summary() };
}

function runtimeDisposition(error) {
  if (error instanceof SafeError) {
    if (error.stage && RUNTIME_STAGE_SUBCODES[error.stage] && RUNTIME_STAGE_SUBCODES[error.stage].includes(error.subcode)) return { stage: error.stage, subcode: error.subcode };
    if (RUNTIME_STAGE_SUBCODES.ARTIFACT.includes(error.code)) return { stage: 'ARTIFACT', subcode: error.code };
  }
  return { stage: 'INTERNAL', subcode: 'UNEXPECTED' };
}
function runtimeToken(status, stage, subcode) { return status === 'PASS' ? RUNTIME_TOKENS.PASS : RUNTIME_TOKENS[`FAIL_${stage}_${subcode}`] || RUNTIME_TOKENS.FAIL_INTERNAL_UNEXPECTED; }
function cli(options = {}, io = process) { return run(options).then(() => { io.stdout.write(`${runtimeToken('PASS')}\n`); return 0; }, (error) => { const terminalState = runtimeDisposition(error); io.stdout.write(`${runtimeToken('FAIL', terminalState.stage, terminalState.subcode)}\n`); return 1; }); }
if (require.main === module) cli().then((code) => { process.exitCode = code; });

module.exports = { ROOT, INVENTORY_REL, OUTPUT_REL, PREFLIGHT_REL, CONSUMED_REL, SCHEMA, RUNTIME_STAGES, RUNTIME_STAGE_SUBCODES, RUNTIME_TOKENS, PRENETWORK_PREFLIGHT_STAGES, PROTOCOLS, LIMITS, FAILURE_CODES, SOLANA_GENESIS, SUI_IDS,
  THOR_IDS, TRON_NETWORKS, TRON_MAINNET_GENESIS, TRON_EVM_CHAIN_ID, FATAL_CODES, NONPROBEABLE_REASONS, SafeError, validateInvocation: preflight.validateInvocation, readInventory: preflight.readInventory, parseInventory: preflight.parseInventory, sectionProtocol: preflight.sectionProtocol, sectionProtocols: preflight.sectionProtocols, validUrl: preflight.validUrl,
  isUnsafeAddress, publicResolution, Budget, directHttps, rpcEnvelope, batchEnvelope, assertRpcAllowed, assertRpcParams, assertRestAllowed, assertRestBody, makeRequester, solanaBlock, PHASE1, PHASE2,
  phase1Evm, phase1Solana, phase1Sui, phase1Comet, phase1Lcd, phase1Midgard, phase1Tron,
  phase2Evm, phase2Solana, phase2Sui, phase2Comet, phase2Lcd, phase2Tron, mapLimit, rank, joinPath, readCommonPin, normalizeFamily: preflight.normalizeFamily, debugTraceShape, parityTrace,
  aggregateCapabilities, phase2Useful, leakScan, preflightOutput: preflight.probeOutputFilesystem, atomicPublish, consumeGate, offlineRecheck, terminal, prenetworkPair, runtimeDisposition, runtimeToken, run, cli };
