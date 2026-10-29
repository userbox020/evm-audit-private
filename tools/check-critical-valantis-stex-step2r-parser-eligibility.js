#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CLAIM = 'critical/valantis-stex-step2r-parser-eligibility';
const SCHEMA = 'critical-valantis-stex-step2r-parser-eligibility-v1';
const WORKSPACE = path.resolve(__dirname, '..');
const RUNNER_RELATIVE = 'tools/check-critical-valantis-stex-step2r-parser-eligibility.js';
const TEST_RELATIVE = 'tools/test-check-critical-valantis-stex-step2r-parser-eligibility.js';
const PACKAGE_RELATIVE = 'reports/raw/fast/critical-valantis-stex-step2r-parser-eligibility-review-package.json';
const OUTPUT_RELATIVE = 'reports/raw/fast/critical-valantis-stex-step2r-parser-eligibility.json';
const LOCK_RELATIVE = 'reports/raw/fast/.critical-valantis-stex-step2r-parser-eligibility.lock';
const INVENTORIES = Object.freeze(['rpc_endpoints.txt', 'hyperevm_archive_endpoints.md']);
const PREDECESSOR = Object.freeze({
  path: 'reports/raw/fast/critical-valantis-stex-khype-deployment-economics-step2-diagnostic.json',
  bytes: 929,
  sha256: '8459231294312344e14220b0979fbaebbaf07db4587b2021e6696efb6acc0ba2',
  status: 'DIAGNOSTIC',
  code: 'FINALITY_UNBOUND'
});
const PREVIOUS_STEP2_HASHES = Object.freeze({
  runner: '9eef34e3a2635ce32c9c91ee6aedd74a9337c8536ead22555ce54f0da3864c90',
  tests: 'f35f85233daed6514dd38a88d572bd80edacfa94c6c6c1cea33c56ed4fdd7ae4',
  authority: '92d8b9ff85e6db7a8c48cc0d28d12cfc98ef0681f0fb590288116d0a97ae78a9',
  reviewPackage: 'ae054a7a75ddd4b2bcc7b6f9f8511511fc9773bc9aa98cd61116001c7da7d541'
});
const GRAMMAR_AUTHORITY = Object.freeze({
  groupA: 'Generic inventory: chain context and endpoint-bearing context are independent requirements; conservative structured records require bounded HyperEVM, Hyper EVM, Hyperliquid EVM, or exact chain-999 context plus an explicit RPC/endpoint/archive-RPC/provider-URL/node-URL/HTTP-URL field or two-line label, while bare URL fields are allowed only below explicit RPC/endpoints/archive/providers sections.',
  groupB: 'Chain-scoped archive inventory: arbitrary standalone values are ineligible; records require an explicit same-line endpoint-bearing field or a bounded nearest RPC/endpoints/archive/providers/node-URLs heading, section, or fence label, where bare Markdown list values may appear; ordinary prose, support, explorer, website, homepage, and documentation references are excluded.',
  common: 'Offline URL syntax only: HTTPS, nonempty public hostname, no userinfo or fragment, no nonpublic IPv4/IPv6 or mapped address, no obvious documentation/explorer/social host or document/media path, bounded text and URL lengths, in-memory deduplication, opaque capped counts only.'
});
const SEMANTICS_AUTHORITY = Object.freeze({
  bothGroupsEligible: 'Parser precondition proof only; network capture remains unauthorized.',
  groupEligibilityFailed: 'The reviewed grammar found no eligible record in at least one opaque group; this is not proof that either inventory lacks endpoints.',
  nonConclusions: Object.freeze(['endpoint health', 'chain identity', 'finality', 'independence', 'state', 'deployment', 'route', 'economics'])
});
const LIMITS = Object.freeze({
  inventoryBytes: 256 * 1024,
  recordsPerGroup: 64,
  urlChars: 2048,
  lineChars: 4096,
  contextLines: 8,
  jsonDepth: 8,
  jsonNodes: 512,
  outputBytes: 64 * 1024
});
const COMPLETED_KEYS = Object.freeze([
  'schema', 'claim', 'status', 'checkedAtUtc', 'predecessorDiagnostic', 'groups', 'aggregateCounts', 'gates', 'safety'
]);
const DIAGNOSTIC_KEYS = Object.freeze([
  'schema', 'claim', 'status', 'checkedAtUtc', 'predecessorDiagnostic', 'stage', 'code', 'aggregateCounts', 'gates', 'safety'
]);
const DIAGNOSTIC_CODES = Object.freeze({
  CLI: ['CHECK_FLAG_REQUIRED'],
  PREFLIGHT: ['PREDECESSOR_CHANGED', 'PREDECESSOR_SCHEMA_INVALID', 'REVIEW_PACKAGE_INVALID', 'RUNNER_CHANGED', 'TEST_CHANGED'],
  LOCK: ['CHECK_ALREADY_RUNNING'],
  INVENTORY: ['EXACT_PATH_REFUSED', 'FILE_IDENTITY_REJECTED', 'REALPATH_MISMATCH', 'SIZE_CAP', 'OPEN_IDENTITY_MISMATCH', 'POST_OPEN_IDENTITY_MISMATCH', 'GROWTH_OR_TRAILING_DATA', 'BOUNDED_READ_FAILURE'],
  PUBLISH: ['OUTPUT_EXISTS', 'OUTPUT_SCHEMA_INVALID', 'OUTPUT_SIZE_CAP', 'PUBLISH_FAILURE'],
  INTERNAL: ['BOUNDED_INTERNAL_FAILURE']
});

class EligibilityError extends Error {
  constructor(stage, code) {
    super(code);
    this.name = 'EligibilityError';
    this.stage = stage;
    this.code = code;
  }
}

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && stable(Object.keys(value).sort()) === stable([...keys].sort());
}

function canonicalIso(value) {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function safeCount(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function canonicalGates() {
  return {
    networkCaptureAuthorized: false,
    routePositive: 'unknown',
    executableNow: 'unknown',
    signedActionJustified: false,
    forkJustified: false
  };
}

function canonicalSafety() {
  return {
    networkApisUsed: false,
    protectedContentPersisted: false,
    providerMaterialPersisted: false,
    signing: false,
    transactions: 0,
    broadcast: false,
    fork: false,
    stateMutation: false,
    localEvidenceWrite: true,
    outputNoReplace: true,
    predecessorPreserved: true
  };
}

function createCounters() {
  return { inventoryFilesOpened: 0, authorizationConsumed: false, networkCalls: 0 };
}

function predecessorRecord() { return { ...PREDECESSOR }; }

function aggregateRecord(counters = createCounters()) {
  return {
    inventoryFilesOpened: counters.inventoryFilesOpened,
    authorizationConsumed: counters.authorizationConsumed,
    networkCalls: 0
  };
}

function validateAggregate(value) {
  return exactKeys(value, ['inventoryFilesOpened', 'authorizationConsumed', 'networkCalls'])
    && safeCount(value.inventoryFilesOpened, 2)
    && typeof value.authorizationConsumed === 'boolean'
    && value.networkCalls === 0
    && (value.inventoryFilesOpened === 0 ? value.authorizationConsumed === false : value.authorizationConsumed === true);
}

function validateOutputSchema(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema !== SCHEMA || value.claim !== CLAIM
        || !canonicalIso(value.checkedAtUtc) || stable(value.predecessorDiagnostic) !== stable(PREDECESSOR)
        || stable(value.gates) !== stable(canonicalGates()) || stable(value.safety) !== stable(canonicalSafety())
        || !validateAggregate(value.aggregateCounts)) return false;
    if (value.status === 'DIAGNOSTIC') {
      return exactKeys(value, DIAGNOSTIC_KEYS)
        && Object.prototype.hasOwnProperty.call(DIAGNOSTIC_CODES, value.stage)
        && DIAGNOSTIC_CODES[value.stage].includes(value.code);
    }
    if (!['BOTH_GROUPS_ELIGIBLE', 'GROUP_ELIGIBILITY_FAILED'].includes(value.status)
        || !exactKeys(value, COMPLETED_KEYS) || !exactKeys(value.groups, ['A', 'B'])) return false;
    for (const name of ['A', 'B']) {
      const group = value.groups[name];
      if (!exactKeys(group, ['eligible', 'count']) || typeof group.eligible !== 'boolean'
          || !safeCount(group.count, LIMITS.recordsPerGroup) || group.eligible !== (group.count > 0)) return false;
    }
    const both = value.groups.A.eligible && value.groups.B.eligible;
    return value.status === (both ? 'BOTH_GROUPS_ELIGIBLE' : 'GROUP_ELIGIBILITY_FAILED');
  } catch (_) { return false; }
}

function leakScan(value, forbidden = []) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (/https?:\/\//i.test(text) || /(?:authorization|bearer|api[_-]?key|token|secret|credential)\s*[:=]/i.test(text)) {
    throw new EligibilityError('PUBLISH', 'OUTPUT_SCHEMA_INVALID');
  }
  for (const item of forbidden) {
    if (typeof item === 'string' && item && text.toLowerCase().includes(item.toLowerCase())) {
      throw new EligibilityError('PUBLISH', 'OUTPUT_SCHEMA_INVALID');
    }
  }
  return true;
}

function buildCompleted(countA, countB, counters = createCounters(), now = new Date()) {
  const groups = {
    A: { eligible: countA > 0, count: countA },
    B: { eligible: countB > 0, count: countB }
  };
  return {
    schema: SCHEMA,
    claim: CLAIM,
    status: groups.A.eligible && groups.B.eligible ? 'BOTH_GROUPS_ELIGIBLE' : 'GROUP_ELIGIBILITY_FAILED',
    checkedAtUtc: now.toISOString(),
    predecessorDiagnostic: predecessorRecord(),
    groups,
    aggregateCounts: aggregateRecord(counters),
    gates: canonicalGates(),
    safety: canonicalSafety()
  };
}

function buildDiagnostic(stage, code, counters = createCounters(), now = new Date()) {
  return {
    schema: SCHEMA,
    claim: CLAIM,
    status: 'DIAGNOSTIC',
    checkedAtUtc: now.toISOString(),
    predecessorDiagnostic: predecessorRecord(),
    stage,
    code,
    aggregateCounts: aggregateRecord(counters),
    gates: canonicalGates(),
    safety: canonicalSafety()
  };
}

function parseIPv4(host) {
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some(part => !/^(?:0|[1-9][0-9]{0,2})$/.test(part))) return null;
  const octets = parts.map(Number);
  return octets.every(value => value <= 255) ? octets : null;
}

function nonpublicIPv4(octets) {
  const [a, b, c] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113);
}

function parseIPv6(host) {
  let value = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (!value.includes(':') || value.includes('%')) return null;
  const tailIndex = value.lastIndexOf(':');
  if (value.slice(tailIndex + 1).includes('.')) {
    const tail = parseIPv4(value.slice(tailIndex + 1));
    if (!tail) return null;
    value = `${value.slice(0, tailIndex)}:${((tail[0] << 8) | tail[1]).toString(16)}:${((tail[2] << 8) | tail[3]).toString(16)}`;
  }
  if ((value.match(/::/g) || []).length > 1) return null;
  const sides = value.split('::');
  const left = sides[0] ? sides[0].split(':') : [];
  const right = sides.length === 2 && sides[1] ? sides[1].split(':') : [];
  if ([...left, ...right].some(part => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  const missing = 8 - left.length - right.length;
  if ((sides.length === 1 && missing !== 0) || (sides.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right].map(part => parseInt(part, 16));
  return groups.length === 8 ? groups : null;
}

function nonpublicHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return true;
  const v4 = parseIPv4(host);
  if (v4) return nonpublicIPv4(v4);
  const v6 = parseIPv6(host);
  if (!v6) return false;
  const mapped = v6.slice(0, 5).every(value => value === 0) && v6[5] === 0xffff;
  if (mapped) return nonpublicIPv4([v6[6] >> 8, v6[6] & 255, v6[7] >> 8, v6[7] & 255]);
  if (v6.every(value => value === 0) || (v6.slice(0, 7).every(value => value === 0) && v6[7] === 1)) return true;
  if ((v6[0] & 0xfe00) === 0xfc00 || (v6[0] & 0xffc0) === 0xfe80 || (v6[0] & 0xff00) === 0xff00) return true;
  if ((v6[0] & 0xe000) !== 0x2000
      || (v6[0] === 0x2001 && (v6[1] <= 0x01ff || v6[1] === 0x0db8))
      || v6[0] === 0x2002 || (v6[0] === 0x3fff && (v6[1] & 0xf000) === 0)) return true;
  return false;
}

function obviousNonEndpoint(parsed) {
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const labels = host.split('.');
  const blockedHosts = ['github.com', 'github.io', 'gitlab.com', 'twitter.com', 'x.com', 'discord.com', 'discord.gg', 't.me', 'telegram.me', 'medium.com', 'youtube.com', 'youtu.be', 'linkedin.com', 'facebook.com', 'instagram.com'];
  if (blockedHosts.some(item => host === item || host.endsWith(`.${item}`))
      || labels.some(label => ['docs', 'doc', 'documentation', 'explorer', 'scan', 'social', 'support', 'help'].includes(label))) return true;
  return /\.(?:md|markdown|txt|pdf|html?|xml|json|ya?ml|csv|png|jpe?g|gif|svg|webp|mp4|webm|mov|zip|tar|gz)$/i.test(parsed.pathname)
    || /\/(?:docs?|documentation|guide|support|help)(?:\/|$)/i.test(parsed.pathname);
}

function normalizeEligibleUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > LIMITS.urlChars || /[\u0000-\u001f\u007f]/.test(value)) return null;
  let parsed;
  try { parsed = new URL(value); } catch (_) { return null; }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || !parsed.hostname
      || nonpublicHost(parsed.hostname) || obviousNonEndpoint(parsed)) return null;
  for (const key of parsed.searchParams.keys()) {
    if (/(?:api.?key|token|secret|pass|credential|auth|signature)/i.test(key)) return null;
  }
  const normalized = parsed.toString();
  return normalized.length <= LIMITS.urlChars ? normalized : null;
}

function trimUrlToken(value) {
  let token = value.trim();
  while (/[),.;!?]$/.test(token)) token = token.slice(0, -1);
  return token;
}

function extractUrlTokens(line) {
  if (typeof line !== 'string' || line.length > LIMITS.lineChars) return [];
  const matches = line.match(/https:\/\/[^\s<>"'\[\]{}|]+/gi) || [];
  return matches.map(trimUrlToken).filter(token => token.length > 0 && token.length <= LIMITS.urlChars);
}

function normalizedLabel(value) {
  return String(value).toLowerCase().replace(/[_-]+/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}
function blockedFieldLabel(value) {
  return /\b(?:docs?|documentation|support|explorer|website|homepage|help|guide)\b/.test(normalizedLabel(value));
}
function endpointBearingToken(value) {
  const label = normalizedLabel(value);
  return !blockedFieldLabel(label)
    && /\b(?:rpc(?: url)?|endpoint(?: url)?|archive rpc|provider url|node url|http url)\b/.test(label);
}
function explicitEndpointSection(value, allowNodeUrls = false) {
  const label = normalizedLabel(value);
  if (blockedFieldLabel(label)) return false;
  return /\b(?:rpc|endpoints?|archive|providers?)\b/.test(label)
    || (allowNodeUrls && /\bnode urls?\b/.test(label));
}
function bareUrlField(value) {
  return /(?:^|[|,;\s])url\s*[:=|,]/i.test(String(value).replace(/[_-]+/g, ' '));
}
function fieldKeyword(value) {
  return endpointBearingToken(value);
}
function chainContext(value) {
  const normalized = String(value).replace(/[_-]+/g, ' ');
  return /\b(?:hyperevm|hyper\s+evm|hyperliquid\s+evm)\b/i.test(normalized)
    || /\b(?:chain|chainid|network|networkid)\s*[:=|,\-]?\s*999\b/i.test(normalized)
    || /^\s*\[\s*999\s*\]\s*$/.test(normalized);
}
function markdownLink(value) { return /\[[^\]]+\]\(\s*https:\/\//i.test(value); }

function addEligible(tokens, seen) {
  for (let token of tokens) {
    const normalized = normalizeEligibleUrl(token);
    token = '';
    if (normalized && seen.size < LIMITS.recordsPerGroup) seen.add(normalized);
  }
}

function parseArchiveEligibility(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > LIMITS.inventoryBytes) return 0;
  const seen = new Set();
  let inFence = false;
  let eligibleFence = false;
  let sectionRemaining = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.length <= LIMITS.lineChars ? rawLine : '';
    const fence = line.match(/^\s*```\s*([^`]*)$/);
    if (fence) {
      if (inFence) { inFence = false; eligibleFence = false; }
      else { inFence = true; eligibleFence = explicitEndpointSection(fence[1], true) || sectionRemaining > 0; }
      continue;
    }
    if (!line.trim()) continue;
    const tokens = extractUrlTokens(line);
    const withoutUrls = tokens.reduce((value, token) => value.replace(token, ' '), line);
    const heading = !tokens.length && (/^\s*(?:#{1,6}\s+|\[[^\]]+\]\s*$)/.test(line)
      || (line.trim().length <= 120 && /^\s*[A-Za-z0-9 _-]+:?\s*$/.test(line)));
    if (!inFence && heading) sectionRemaining = explicitEndpointSection(withoutUrls, true) ? LIMITS.contextLines : 0;
    if (tokens.length && !markdownLink(line)) {
      const bareList = /^\s*(?:[-*+]|\d+[.)])\s+https:\/\//i.test(line);
      const labeledList = /^\s*(?:[-*+]|\d+[.)])\s+/i.test(line) && endpointBearingToken(withoutUrls);
      const direct = endpointBearingToken(withoutUrls) && (/[:=|,\t]/.test(withoutUrls) || labeledList);
      const nestedUrl = sectionRemaining > 0 && bareUrlField(withoutUrls);
      const standalone = tokens.length === 1 && trimUrlToken(line.trim()) === tokens[0];
      if (inFence
        ? eligibleFence && (direct || bareList || nestedUrl || standalone)
        : (direct || (sectionRemaining > 0 && bareList) || nestedUrl)) addEligible(tokens, seen);
    }
    if (!inFence && !heading && sectionRemaining > 0) sectionRemaining -= 1;
    if (seen.size >= LIMITS.recordsPerGroup) break;
  }
  const count = seen.size;
  seen.clear();
  return count;
}

function jsonChainValue(key, value) {
  const normalizedKey = String(key).toLowerCase();
  if (/^(?:chainid|chain_id|networkid|network_id)$/.test(normalizedKey)) return String(value) === '999';
  if (/^(?:chain|network|name|label)$/.test(normalizedKey)) return chainContext(String(value));
  return chainContext(String(key));
}

function endpointFieldKey(key) {
  return /^(?:rpc|rpc_url|endpoint|endpoint_url|archive_rpc|provider_url|node_url|http_url)$/.test(String(key).toLowerCase().replace(/[ -]+/g, '_'));
}

function endpointSectionKey(key) {
  return /^(?:rpc|endpoints?|archive|providers?)$/.test(String(key).toLowerCase().replace(/[ -]+/g, '_'));
}

function collectJsonEligibility(value, seen, inherited = false, depth = 0, budget = { nodes: 0 }, inheritedEndpoint = false) {
  if (depth > LIMITS.jsonDepth || budget.nodes >= LIMITS.jsonNodes || seen.size >= LIMITS.recordsPerGroup) return;
  budget.nodes += 1;
  if (Array.isArray(value)) {
    for (const item of value) collectJsonEligibility(item, seen, inherited, depth + 1, budget, inheritedEndpoint);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const entries = Object.entries(value);
  const local = inherited || entries.some(([key, item]) => (typeof item !== 'object' || item === null) && jsonChainValue(key, item));
  for (const [key, item] of entries) {
    const childContext = local || chainContext(key);
    const childEndpoint = inheritedEndpoint || endpointSectionKey(key);
    const bareUrl = /^(?:url|urls)$/.test(String(key).toLowerCase());
    if (typeof item === 'string' && childContext && (endpointFieldKey(key) || (inheritedEndpoint && bareUrl))) {
      addEligible([item], seen);
    } else if (Array.isArray(item) && childContext && (endpointFieldKey(key) || endpointSectionKey(key) || (inheritedEndpoint && bareUrl))) {
      addEligible(item.filter(candidate => typeof candidate === 'string'), seen);
      for (const child of item.filter(candidate => candidate && typeof candidate === 'object')) {
        collectJsonEligibility(child, seen, childContext, depth + 1, budget, childEndpoint);
      }
    } else if (item && typeof item === 'object') {
      collectJsonEligibility(item, seen, childContext, depth + 1, budget, childEndpoint);
    }
  }
}

function parseGenericEligibility(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > LIMITS.inventoryBytes) return 0;
  const seen = new Set();
  try { collectJsonEligibility(JSON.parse(text), seen); } catch (_) {}
  let chainRemaining = 0;
  let endpointSectionRemaining = 0;
  let previousLabel = false;
  for (const rawLine of text.split(/\r?\n/)) {
    if (seen.size >= LIMITS.recordsPerGroup) break;
    const line = rawLine.length <= LIMITS.lineChars ? rawLine : '';
    const tokens = extractUrlTokens(line);
    const withoutUrls = tokens.reduce((value, token) => value.replace(token, ' '), line);
    const trimmed = withoutUrls.trim();
    const header = /^\s*\[[^\]]+\]\s*$/.test(line) || /^\s*#{1,6}\s+/.test(line)
      || (!tokens.length && /^\s*[A-Za-z0-9 _-]+:\s*$/.test(line));
    const sameChain = chainContext(withoutUrls);
    const endpointSection = explicitEndpointSection(withoutUrls, false);
    if (header) {
      if (sameChain) {
        chainRemaining = LIMITS.contextLines;
        endpointSectionRemaining = endpointSection ? LIMITS.contextLines : 0;
      } else if (endpointSection && chainRemaining > 0) {
        endpointSectionRemaining = LIMITS.contextLines;
      } else {
        chainRemaining = 0;
        endpointSectionRemaining = 0;
      }
    } else if (!tokens.length && sameChain && (/[:=|,]/.test(line) || endpointBearingToken(line))) {
      chainRemaining = LIMITS.contextLines;
    }
    if (tokens.length && !markdownLink(line)) {
      const activeChain = sameChain || chainRemaining > 0;
      const directEndpoint = endpointBearingToken(withoutUrls);
      const nestedUrl = endpointSectionRemaining > 0 && bareUrlField(withoutUrls);
      const structured = /[:=|,\t]/.test(withoutUrls) && (directEndpoint || nestedUrl);
      const standalone = tokens.length === 1 && trimUrlToken(line.trim()) === tokens[0];
      if (activeChain && (structured || (previousLabel && standalone))) addEligible(tokens, seen);
    }
    previousLabel = !tokens.length && (sameChain || chainRemaining > 0) && endpointBearingToken(trimmed);
    if (!header && trimmed) {
      if (chainRemaining > 0) chainRemaining -= 1;
      if (endpointSectionRemaining > 0) endpointSectionRemaining -= 1;
    }
  }
  const count = seen.size;
  seen.clear();
  return count;
}

function safeInventoryStat(stat) {
  return stat && stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
    && safeCount(stat.size, LIMITS.inventoryBytes);
}

function sameIdentity(left, right) {
  return safeInventoryStat(left) && safeInventoryStat(right) && left.dev === right.dev && left.ino === right.ino;
}

function exactRealpath(fsImpl, exact) {
  const real = fsImpl.realpathSync.native ? fsImpl.realpathSync.native(exact) : fsImpl.realpathSync(exact);
  if (path.resolve(real) !== exact) throw new EligibilityError('INVENTORY', 'REALPATH_MISMATCH');
}

function exactInventoryPath(root, base) {
  if (!INVENTORIES.includes(base) || path.basename(base) !== base) throw new EligibilityError('INVENTORY', 'EXACT_PATH_REFUSED');
  const exactRoot = path.resolve(root);
  const exact = path.resolve(exactRoot, base);
  if (path.dirname(exact) !== exactRoot) throw new EligibilityError('INVENTORY', 'EXACT_PATH_REFUSED');
  return exact;
}

function openAndReadExact(fsImpl, exact, counters, hooks = {}) {
  const before = fsImpl.lstatSync(exact);
  if (!safeInventoryStat(before)) {
    throw new EligibilityError('INVENTORY', before && before.size > LIMITS.inventoryBytes ? 'SIZE_CAP' : 'FILE_IDENTITY_REJECTED');
  }
  exactRealpath(fsImpl, exact);
  if (typeof hooks.afterBeforeStat === 'function') hooks.afterBeforeStat(exact);
  const constants = fsImpl.constants || fs.constants;
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW || 0);
  let descriptor;
  let bytes;
  const probe = Buffer.alloc(1);
  try {
    descriptor = fsImpl.openSync(exact, flags);
    counters.inventoryFilesOpened += 1;
    counters.authorizationConsumed = true;
    if (typeof hooks.afterOpen === 'function') hooks.afterOpen(exact, descriptor);
    const opened = fsImpl.fstatSync(descriptor);
    if (!sameIdentity(before, opened)) throw new EligibilityError('INVENTORY', 'OPEN_IDENTITY_MISMATCH');
    bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fsImpl.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new EligibilityError('INVENTORY', 'BOUNDED_READ_FAILURE');
      offset += count;
    }
    const trailing = fsImpl.readSync(descriptor, probe, 0, 1, offset);
    if (typeof hooks.beforeAfterStat === 'function') hooks.beforeAfterStat(exact, descriptor);
    const afterDescriptor = fsImpl.fstatSync(descriptor);
    const afterPath = fsImpl.lstatSync(exact);
    exactRealpath(fsImpl, exact);
    if (!sameIdentity(opened, afterDescriptor) || !sameIdentity(opened, afterPath)) {
      throw new EligibilityError('INVENTORY', 'POST_OPEN_IDENTITY_MISMATCH');
    }
    if (trailing !== 0 || afterDescriptor.size !== opened.size || afterPath.size !== opened.size || offset !== opened.size) {
      throw new EligibilityError('INVENTORY', 'GROWTH_OR_TRAILING_DATA');
    }
    return bytes;
  } catch (error) {
    if (bytes) bytes.fill(0);
    if (error instanceof EligibilityError) throw error;
    throw new EligibilityError('INVENTORY', 'BOUNDED_READ_FAILURE');
  } finally {
    probe.fill(0);
    if (descriptor !== undefined) try { fsImpl.closeSync(descriptor); } catch (_) {}
  }
}

function parseExactInventories(fsImpl, root, counters, hooks = {}) {
  const counts = [];
  for (let index = 0; index < INVENTORIES.length; index += 1) {
    const exact = exactInventoryPath(root, INVENTORIES[index]);
    const bytes = openAndReadExact(fsImpl, exact, counters, hooks);
    try {
      let text = bytes.toString('utf8');
      counts.push(index === 0 ? parseGenericEligibility(text) : parseArchiveEligibility(text));
      text = '';
    } finally {
      bytes.fill(0);
    }
  }
  return counts;
}

function readJsonExact(fsImpl, filename, stage, code) {
  try { return JSON.parse(fsImpl.readFileSync(filename, 'utf8')); }
  catch (_) { throw new EligibilityError(stage, code); }
}

function validateReviewPackage(value) {
  const fileKeys = ['path', 'bytes', 'sha256'];
  return exactKeys(value, ['schema', 'claim', 'status', 'files', 'predecessorDiagnostic', 'previousStep2Provenance', 'grammarAuthority', 'semantics', 'limits', 'output', 'authorization', 'safety'])
    && value.schema === 'critical-valantis-stex-step2r-parser-eligibility-review-package-v1'
    && value.claim === CLAIM && value.status === 'READY_FOR_EXPLICIT_CHECK_NOT_EXECUTED'
    && Array.isArray(value.files) && value.files.length === 2 && value.files.every(item => exactKeys(item, fileKeys) && safeCount(item.bytes) && /^[0-9a-f]{64}$/.test(item.sha256))
    && value.files[0].path === RUNNER_RELATIVE && value.files[1].path === TEST_RELATIVE
    && stable(value.predecessorDiagnostic) === stable(PREDECESSOR)
    && stable(value.previousStep2Provenance) === stable(PREVIOUS_STEP2_HASHES)
    && stable(value.grammarAuthority) === stable(GRAMMAR_AUTHORITY)
    && stable(value.semantics) === stable(SEMANTICS_AUTHORITY)
    && stable(value.limits) === stable(LIMITS)
    && exactKeys(value.output, ['path', 'noReplace', 'schema', 'statuses', 'completedExactKeys', 'diagnosticExactKeys', 'groupExactKeys', 'aggregateExactKeys', 'gates', 'safety', 'groupsOpaque', 'networkCaptureAuthorized'])
    && value.output.path === OUTPUT_RELATIVE && value.output.noReplace === true && value.output.schema === SCHEMA
    && stable(value.output.statuses) === stable(['BOTH_GROUPS_ELIGIBLE', 'GROUP_ELIGIBILITY_FAILED', 'DIAGNOSTIC'])
    && stable(value.output.completedExactKeys) === stable(COMPLETED_KEYS)
    && stable(value.output.diagnosticExactKeys) === stable(DIAGNOSTIC_KEYS)
    && stable(value.output.groupExactKeys) === stable(['eligible', 'count'])
    && stable(value.output.aggregateExactKeys) === stable(['inventoryFilesOpened', 'authorizationConsumed', 'networkCalls'])
    && stable(value.output.gates) === stable(canonicalGates()) && stable(value.output.safety) === stable(canonicalSafety())
    && value.output.groupsOpaque === true && value.output.networkCaptureAuthorized === false
    && exactKeys(value.authorization, ['mode', 'consumptionPoint', 'files', 'retryAuthorized'])
    && value.authorization.mode === 'EXPLICIT_ONE_RUN_PARSER_ONLY' && value.authorization.consumptionPoint === 'FIRST_SUCCESSFUL_DESCRIPTOR_OPEN'
    && stable(value.authorization.files) === stable(INVENTORIES) && value.authorization.retryAuthorized === false
    && exactKeys(value.safety, ['captureExecuted', 'network', 'protectedInventoryOpenedDuringPreparation', 'transactions', 'signing', 'fork'])
    && value.safety.captureExecuted === false && value.safety.network === false
    && value.safety.protectedInventoryOpenedDuringPreparation === false && value.safety.transactions === 0
    && value.safety.signing === false && value.safety.fork === false;
}

function preflightAuthority(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const root = options.root || WORKSPACE;
  const predecessorPath = path.join(root, PREDECESSOR.path);
  const predecessorBytes = fsImpl.readFileSync(predecessorPath);
  if (predecessorBytes.length !== PREDECESSOR.bytes || sha256(predecessorBytes) !== PREDECESSOR.sha256) {
    throw new EligibilityError('PREFLIGHT', 'PREDECESSOR_CHANGED');
  }
  let predecessor;
  try { predecessor = JSON.parse(predecessorBytes.toString('utf8')); }
  catch (_) { throw new EligibilityError('PREFLIGHT', 'PREDECESSOR_SCHEMA_INVALID'); }
  if (predecessor.status !== PREDECESSOR.status || predecessor.code !== PREDECESSOR.code) {
    throw new EligibilityError('PREFLIGHT', 'PREDECESSOR_SCHEMA_INVALID');
  }
  const review = readJsonExact(fsImpl, path.join(root, PACKAGE_RELATIVE), 'PREFLIGHT', 'REVIEW_PACKAGE_INVALID');
  if (!validateReviewPackage(review)) throw new EligibilityError('PREFLIGHT', 'REVIEW_PACKAGE_INVALID');
  for (const [index, relative] of [RUNNER_RELATIVE, TEST_RELATIVE].entries()) {
    const bytes = fsImpl.readFileSync(path.join(root, relative));
    const record = review.files[index];
    if (bytes.length !== record.bytes || sha256(bytes) !== record.sha256) {
      throw new EligibilityError('PREFLIGHT', index === 0 ? 'RUNNER_CHANGED' : 'TEST_CHANGED');
    }
  }
  return review;
}

function assertOutputAbsent(fsImpl, root) {
  if (fsImpl.existsSync(path.join(root, OUTPUT_RELATIVE))) throw new EligibilityError('PUBLISH', 'OUTPUT_EXISTS');
  return true;
}

function acquireLock(fsImpl, root) {
  const lockPath = path.join(root, LOCK_RELATIVE);
  const token = crypto.randomBytes(16).toString('hex');
  let descriptor;
  try {
    descriptor = fsImpl.openSync(lockPath, 'wx', 0o600);
    fsImpl.writeFileSync(descriptor, token, 'utf8');
    fsImpl.fsyncSync(descriptor);
    fsImpl.closeSync(descriptor);
    return { path: lockPath, token };
  } catch (error) {
    if (descriptor !== undefined) try { fsImpl.closeSync(descriptor); } catch (_) {}
    if (error && error.code === 'EEXIST') throw new EligibilityError('LOCK', 'CHECK_ALREADY_RUNNING');
    throw new EligibilityError('LOCK', 'CHECK_ALREADY_RUNNING');
  }
}

function releaseLock(fsImpl, lock) {
  if (!lock) return;
  try {
    if (fsImpl.readFileSync(lock.path, 'utf8') === lock.token) fsImpl.unlinkSync(lock.path);
  } catch (_) {}
}

function publishNoReplace(value, fsImpl, root, lock, hooks = {}) {
  if (!validateOutputSchema(value)) throw new EligibilityError('PUBLISH', 'OUTPUT_SCHEMA_INVALID');
  leakScan(value);
  const destination = path.join(root, OUTPUT_RELATIVE);
  if (fsImpl.existsSync(destination)) throw new EligibilityError('PUBLISH', 'OUTPUT_EXISTS');
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  if (bytes.length > LIMITS.outputBytes) throw new EligibilityError('PUBLISH', 'OUTPUT_SIZE_CAP');
  const token = lock ? lock.token : crypto.randomBytes(16).toString('hex');
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.tmp-${token}`);
  let temporaryPresent = false;
  try {
    const descriptor = fsImpl.openSync(temporary, 'wx', 0o600);
    temporaryPresent = true;
    try { fsImpl.writeFileSync(descriptor, bytes); fsImpl.fsyncSync(descriptor); }
    finally { fsImpl.closeSync(descriptor); }
    if (typeof hooks.beforeRename === 'function') hooks.beforeRename(temporary, destination);
    if (fsImpl.existsSync(destination)) throw new EligibilityError('PUBLISH', 'OUTPUT_EXISTS');
    fsImpl.renameSync(temporary, destination);
    temporaryPresent = false;
    const directoryDescriptor = fsImpl.openSync(path.dirname(destination), 'r');
    try {
      try { fsImpl.fsyncSync(directoryDescriptor); }
      catch (error) { if (!['EINVAL', 'EPERM', 'EBADF'].includes(error.code)) throw error; }
    } finally { fsImpl.closeSync(directoryDescriptor); }
    return destination;
  } catch (error) {
    if (error instanceof EligibilityError) throw error;
    throw new EligibilityError('PUBLISH', 'PUBLISH_FAILURE');
  } finally {
    bytes.fill(0);
    if (temporaryPresent) try { fsImpl.unlinkSync(temporary); } catch (_) {}
  }
}

async function runEligibilityCheck(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const root = options.root || WORKSPACE;
  const counters = options.counters || createCounters();
  preflightAuthority({ fsImpl, root });
  assertOutputAbsent(fsImpl, root);
  if (typeof options.afterInitialOutputCheck === 'function') options.afterInitialOutputCheck(root);
  const lock = acquireLock(fsImpl, root);
  try {
    assertOutputAbsent(fsImpl, root);
    let output;
    try {
      const [countA, countB] = parseExactInventories(fsImpl, root, counters, options.inventoryHooks || {});
      output = buildCompleted(countA, countB, counters, options.now ? options.now() : new Date());
    } catch (error) {
      output = buildDiagnostic(
        error instanceof EligibilityError ? error.stage : 'INTERNAL',
        error instanceof EligibilityError ? error.code : 'BOUNDED_INTERNAL_FAILURE',
        counters,
        options.now ? options.now() : new Date()
      );
    }
    publishNoReplace(output, fsImpl, root, lock, options.publishHooks || {});
    return output;
  } finally {
    releaseLock(fsImpl, lock);
  }
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length === 0) {
    preflightAuthority();
    process.stdout.write(`${JSON.stringify({
      mode: 'offline-immutable-preflight', claim: CLAIM, status: 'PASS', protectedInventoryReads: 0,
      networkCalls: 0, childProcesses: 0, signing: false, transactions: 0, fork: false, checkExecuted: false
    })}\n`);
    return;
  }
  if (argv.length !== 1 || argv[0] !== '--check') throw new EligibilityError('CLI', 'CHECK_FLAG_REQUIRED');
  const output = await runEligibilityCheck();
  process.stdout.write(`${JSON.stringify({
    status: output.status,
    stage: output.status === 'DIAGNOSTIC' ? output.stage : undefined,
    code: output.status === 'DIAGNOSTIC' ? output.code : undefined,
    aggregateCounts: output.aggregateCounts
  })}\n`);
}

if (require.main === module) {
  main().catch(error => {
    const diagnostic = buildDiagnostic(
      error instanceof EligibilityError ? error.stage : 'INTERNAL',
      error instanceof EligibilityError ? error.code : 'BOUNDED_INTERNAL_FAILURE'
    );
    process.stderr.write(`${JSON.stringify({
      status: diagnostic.status, stage: diagnostic.stage, code: diagnostic.code,
      aggregateCounts: diagnostic.aggregateCounts
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({
  CLAIM, SCHEMA, WORKSPACE, RUNNER_RELATIVE, TEST_RELATIVE, PACKAGE_RELATIVE, OUTPUT_RELATIVE, LOCK_RELATIVE,
  INVENTORIES, PREDECESSOR, PREVIOUS_STEP2_HASHES, GRAMMAR_AUTHORITY, SEMANTICS_AUTHORITY, LIMITS, COMPLETED_KEYS, DIAGNOSTIC_KEYS, DIAGNOSTIC_CODES,
  EligibilityError, sha256, stable, exactKeys, canonicalIso, safeCount, canonicalGates, canonicalSafety,
  createCounters, predecessorRecord, aggregateRecord, validateAggregate, validateOutputSchema, leakScan,
  buildCompleted, buildDiagnostic, parseIPv4, nonpublicIPv4, parseIPv6, nonpublicHost, obviousNonEndpoint,
  normalizeEligibleUrl, trimUrlToken, extractUrlTokens, normalizedLabel, blockedFieldLabel, endpointBearingToken,
  explicitEndpointSection, bareUrlField, fieldKeyword, chainContext, markdownLink, addEligible,
  parseArchiveEligibility, jsonChainValue, endpointFieldKey, endpointSectionKey, collectJsonEligibility, parseGenericEligibility,
  safeInventoryStat, sameIdentity, exactRealpath, exactInventoryPath, openAndReadExact, parseExactInventories,
  readJsonExact, validateReviewPackage, preflightAuthority, assertOutputAbsent, acquireLock, releaseLock,
  publishNoReplace, runEligibilityCheck, main
});
