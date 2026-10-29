#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const INVENTORY_REL = 'rpc_endpoints.txt';
const OUTPUT_REL = 'reports/raw/fast/all-chain-endpoint-capability-v1/capability.json';
const SCHEMA = 'all-chain-endpoint-capability-v1';
const MAX_BYTES = 1024 * 1024;
const PROTOCOLS = Object.freeze(['EVM', 'SOLANA', 'SUI', 'COMETBFT', 'COSMOS_LCD', 'MIDGARD', 'TRON']);
const FAILURE_CODES = new Set(['AMBIGUOUS', 'UNCLASSIFIED', 'UNSAFE_URL', 'WSS_COUNT_ONLY', 'DNS_UNSAFE', 'DNS_FAILURE', 'TIMEOUT', 'NETWORK',
  'REDIRECT', 'COMPRESSION', 'HEADERS_TOO_LARGE', 'CONTENT_LENGTH', 'RESPONSE_TOO_LARGE', 'GLOBAL_BYTE_BUDGET', 'HTTP_STATUS', 'JSON_INVALID',
  'SCHEMA_INVALID', 'RPC_ERROR', 'METHOD_UNSUPPORTED', 'IDENTITY_UNKNOWN', 'IDENTITY_MISMATCH', 'STALE', 'FUTURE', 'SPREAD', 'NO_SAMPLE',
  'HISTORICAL_UNAVAILABLE', 'BATCH_INVALID', 'BUDGET', 'WALL_BUDGET', 'ALLOWLIST', 'DEADLINE', 'ENDPOINT_DEADLINE', 'ENDPOINT_CAP', 'INTERNAL_INVARIANT', 'COMMIT_INVALID', 'PIN_DISAGREEMENT']);
const GAP_REASONS = new Set(['NON_PROBEABLE_WSS', 'NON_PROBEABLE_UNSUPPORTED_DIALECT', 'NON_PROBEABLE_APP_SURFACE', 'NON_PROBEABLE_GRAPHQL',
  'NON_PROBEABLE_TEMPLATE_REFERENCE', 'NON_PROBEABLE_ALREADY_SUFFIXED', 'NON_PROBEABLE_UNSUPPORTED_PROTOCOL', 'NON_PROBEABLE_INSECURE_TRANSPORT']);
const INVENTORY_CATEGORIES = new Set(['SUPPORTED_PROBE_ENDPOINT', 'NON_PROBEABLE', 'OUT_OF_SCOPE_NONPROBEABLE', 'ORIGIN_METADATA', 'HEADER_METADATA']);
const CAP_STATUS = new Set(['SUPPORTED', 'PARTIAL_SINGLE_FAMILY', 'UNSUPPORTED', 'FAILED', 'INCONCLUSIVE', 'NOT_ATTEMPTED', 'NOT_ATTEMPTED_CAP', 'NOT_APPLICABLE']);
const TOP_KEYS = ['schema', 'generatedAt', 'status', 'phaseSeparation', 'inventory', 'protocols', 'chains', 'budgets', 'safety', 'leakCheck', 'nonclaims'];
const CAPABILITY_KEYS = Object.freeze({ EVM: ['batch', 'historicalHeader', 'historicalState', 'logs', 'trace'], SOLANA: ['batch', 'historicalBlock', 'historicalTransactionLogs'],
  SUI: ['batch', 'historicalCheckpoint', 'historicalTransactionEvents'], COMETBFT: ['batch', 'historicalBlock', 'historicalResults'],
  COSMOS_LCD: ['batch', 'historicalBlock', 'historicalResults', 'trace'], TRON: ['batch', 'historicalBlock', 'trace', 'transactionInfoLogs'] });
const METHOD_LABELS = new Set([
  'EVM:P1:RPC:eth_chainId', 'EVM:P1:RPC:eth_getBlockByNumber', 'EVM:P2:RPC:eth_getBlockByNumber', 'EVM:P2:RPC:eth_getBalance', 'EVM:P2:RPC:eth_getLogs',
  'EVM:P2:RPC:debug_traceTransaction', 'EVM:P2:RPC:trace_transaction', 'EVM:P2:BATCH:eth_chainId+eth_getBlockByNumber',
  'SOLANA:P1:RPC:getGenesisHash', 'SOLANA:P1:RPC:getSlot', 'SOLANA:P1:RPC:getBlockTime', 'SOLANA:P2:RPC:getBlock', 'SOLANA:P2:RPC:getTransaction', 'SOLANA:P2:BATCH:getGenesisHash+getSlot',
  'SUI:P1:RPC:sui_getChainIdentifier', 'SUI:P1:RPC:sui_getLatestCheckpointSequenceNumber', 'SUI:P1:RPC:sui_getCheckpoint', 'SUI:P2:RPC:sui_getCheckpoint', 'SUI:P2:RPC:sui_getTransactionBlock', 'SUI:P2:BATCH:sui_getChainIdentifier+sui_getCheckpoint',
  'COMETBFT:P1:GET:/status', 'COMETBFT:P1:GET:/block?height=H', 'COMETBFT:P1:GET:/commit?height=H', 'COMETBFT:P2:GET:/block?height=H', 'COMETBFT:P2:GET:/block_results?height=H', 'COMETBFT:P2:BATCH:status+block',
  'COSMOS_LCD:P1:GET:/cosmos/base/tendermint/vHbetaH/node_info', 'COSMOS_LCD:P1:GET:/cosmos/base/tendermint/vHbetaH/syncing', 'COSMOS_LCD:P1:GET:/cosmos/base/tendermint/vHbetaH/blocks/latest',
  'COSMOS_LCD:P2:GET:/cosmos/base/tendermint/vHbetaH/blocks/H', 'COSMOS_LCD:P2:GET:/cosmos/base/tendermint/vHbetaH/block_results/H',
  'MIDGARD:P1:GET:/vH/health', 'MIDGARD:P1:GET:/vH/network',
  'TRON:P1:POST:/wallet/getblockbynum', 'TRON:P1:POST:/wallet/getnowblock', 'TRON:P1:GET:/walletsolidity/getnowblock',
  'TRON:P2:POST:/walletsolidity/getblockbynum', 'TRON:P2:POST:/walletsolidity/gettransactioninfobyid'
  ,'EVM:P1:PIN:RPC:eth_getBlockByNumber', 'SOLANA:P1:PIN:RPC:getBlock', 'SUI:P1:PIN:RPC:sui_getCheckpoint',
  'COMETBFT:P1:PIN:GET:/block?height=H', 'COMETBFT:P1:PIN:GET:/commit?height=H',
  'COSMOS_LCD:P1:PIN:GET:/cosmos/base/tendermint/vHbetaH/blocks/H', 'TRON:P1:PIN:POST:/walletsolidity/getblockbynum',
  'MIDGARD:P1:GET:/health', 'MIDGARD:P1:GET:/network'
]);
const SAFETY_KEYS = ['readOnly', 'graphqlOutOfScope', 'httpsOnlyProbes', 'wssCountOnly', 'redirectsFollowed', 'retries', 'compressionAccepted',
  'environmentProxiesRejected', 'directNodeHttps', 'dnsPublicResolutionEveryRequest', 'dnsAddressPinnedPerRequest', 'dnsToConnectTOCTOUNonclaim', 'keepAlive',
  'backendOperatorIndependenceClaimed', 'secretConnectionMaterialPersisted', 'secretConnectionMaterialHashed', 'rawResponsesPersisted', 'exactChainObjectsPersisted',
  'signedTransactions', 'broadcasts', 'mutation', 'ethCall', 'simulation', 'hypotheticalTrace', 'stateOverrides'];

class ValidationError extends Error { constructor(code) { super(code); this.code = code; } }
function check(value, code) { if (!value) throw new ValidationError(code); }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value, keys, code) { check(object(value) && JSON.stringify(Object.keys(value)) === JSON.stringify(keys), code); }
function uint(value, max = Number.MAX_SAFE_INTEGER) { return Number.isSafeInteger(value) && value >= 0 && value <= max; }
function sortedKeys(value) { return JSON.stringify(Object.keys(value)) === JSON.stringify(Object.keys(value).sort()); }
function validateInvocation(env = process.env) {
  for (const [name, value] of Object.entries(env || {})) if (value !== undefined && value !== null && String(value) !== '') {
    const upper = name.toUpperCase(); if (upper.includes('PROXY') || ['NODE_OPTIONS', 'NODE_DEBUG', 'NODE_DEBUG_NATIVE', 'SSLKEYLOGFILE', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'OPENSSL_CONF'].includes(upper) ||
      upper.includes('KEYLOG') || upper.includes('ENDPOINT') || upper.includes('RPC') || upper.includes('SOLANA') || upper.includes('SUI') || upper.includes('TLS') ||
      upper.includes('SSL') || upper.includes('TOKEN') || upper.includes('PRIVATE_KEY') || upper.includes('WALLET') || upper.includes('DEBUG')) throw new ValidationError('ENV');
  }
}
function validChainKey(protocol, key) {
  if (protocol === 'EVM') return /^(?:0|[1-9]\d{0,18})$/.test(key);
  if (protocol === 'SOLANA') return key === 'solana:mainnet-beta';
  if (protocol === 'SUI') return /^sui:(?:mainnet|testnet|devnet)$/.test(key);
  if (protocol === 'COMETBFT') return /^(?:thorchain-mainnet-v1|thorchain-stagenet-v2)$/.test(key);
  if (protocol === 'COSMOS_LCD') return /^cosmos:[a-z][a-z0-9-]{1,47}-[a-z0-9][a-z0-9.-]{0,31}$/i.test(key);
  if (protocol === 'TRON') return key === 'tron:mainnet';
  return false;
}
function genericLeak(text, value, corpus = []) {
  check(!/(?:https?|wss):\/\//i.test(text), 'LEAK_URL');
  check(!/\b(?:authorization|bearer|x-api-key|api[_-]?key|credential)\b\s*[:=]/i.test(text), 'LEAK_AUTH');
  check(!/(?:^|["\s])(?:[a-z0-9-]+\.)+[a-z]{2,63}(?:["\s]|$)/i.test(text), 'LEAK_DOMAIN');
  const lower = text.toLowerCase(); for (const item of corpus) if (String(item).length >= 3) check(!lower.includes(String(item).toLowerCase()), 'LEAK_CORPUS');
  const forbidden = /(?:url|uri|host|hostname|domain|provider|endpoint|family|header|credential|authorization|bearer|token|api.?key)/i;
  const permitted = new Set(['schema', 'chainKey', 'historicalHeader', 'backendOperatorIndependenceClaimed', 'familyPassCount', 'maxFamilyConcurrencyObserved', 'SUPPORTED_PROBE_ENDPOINT', 'HEADER_METADATA']);
  (function walk(node) { if (Array.isArray(node)) return node.forEach(walk); if (!object(node)) return;
    for (const [key, item] of Object.entries(node)) { check(permitted.has(key) || !forbidden.test(key), 'LEAK_KEY'); walk(item); } })(value);
}

/* Independent, aggregate-only inventory classifier. Values never leave process memory. */
function classifyInventory(text) {
  const normalizeFamily = (value) => String(value).normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
  let section = '', occurrenceCount = 0, endpointOccurrences = 0, origins = 0, approvedFields = 0; const records = new Map(), declarations = new Map(), corpus = new Set(), categoryCounts = {};
  const countCategory = (value) => { categoryCounts[value] = (categoryCounts[value] || 0) + 1; };
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(?:#{1,6}\s+|[^|]{1,100}:\s*$)/.test(line) || /^\s*\[/.test(line) && /\b(?:evm|ethereum|solana|sui|thorchain|cosmos|midgard|tron|origin|header|family|network|chain)\b/i.test(line)) section = line.slice(0, 1024);
    const urls = line.match(/(?:https?|wss?):\/\/[^\s"'`<>\[\]]+/gi) || [];
    for (let raw of urls) {
      raw = raw.replace(/[),.;]+$/, ''); occurrenceCount += 1; corpus.add(raw);
      if (new RegExp(`\\[origin:\\s*${raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(line)) { countCategory('ORIGIN_METADATA'); continue; }
      if (new RegExp(`\\[header:[^\\]]*=${raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(line)) { countCategory('HEADER_METADATA'); continue; }
      endpointOccurrences += 1;
      let parsed; try { parsed = new URL(raw); if (!['https:', 'wss:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash || /[{}<>]|\$\{|%\w+%|YOUR[_-]|REPLACE/i.test(raw)) parsed = null; } catch (_) { parsed = null; }
      if (parsed) for (const value of [parsed.href, parsed.hostname, parsed.pathname, parsed.search]) if (value) corpus.add(value);
      const context = `${section}\n${line.replace(/(?:https?|wss?):\/\/[^\s"'`<>\[\]]+/gi, ' ')}`;
      const protocols = []; if (/\bevm\b|\bethereum\b|\beip[- ]?155\b/i.test(context)) protocols.push('EVM'); if (/\bsolana\b/i.test(context)) protocols.push('SOLANA');
      if (/\bsui\b/i.test(context)) protocols.push('SUI'); if (/\bthorchain\b/i.test(context) && /\b(?:cometbft|tendermint|consensus gateway|legacy gateway|rpc)\b/i.test(context)) protocols.push('COMETBFT');
      if (/\bcosmos\b/i.test(context) && /\b(?:lcd|rest)\b/i.test(context)) protocols.push('COSMOS_LCD'); if (/\bmidgard\b/i.test(context)) protocols.push('MIDGARD'); if (/\btron\b/i.test(context)) protocols.push('TRON');
      let protocol = protocols.length === 1 ? protocols[0] : null; if (parsed && /\/v2(?:\/|$)/i.test(parsed.pathname) && /\bthorchain\b/i.test(context)) protocol = 'MIDGARD';
      const originRaw = context.match(/\[origin:\s*([^\]\r\n]+)/i)?.[1]?.trim() || ''; let origin = originRaw;
      try { const originUrl = new URL(originRaw); origin = originUrl.origin === 'null' ? originRaw : originUrl.origin; } catch (_) {}
      const headers = [...context.matchAll(/\[header:\s*([a-z0-9-]+)=([^\]\r\n]+)\]/gi)].map((x) => [x[1].toLowerCase(), x[2].trim()]).sort();
      origins += originRaw ? 1 : 0; approvedFields += headers.length;
      const familyRaw = context.match(/\bfamily\s*[:=]\s*(?:"([^"]{1,64})"|'([^']{1,64})'|([^\]\r\n]{1,64}?))(?=\s+(?:(?:chain|network|eip155|family)\s*[:=]|archive\b|historical\b|trace\b|premium\b|credentialed\b|paid\b|native\b)|\s*\]|\s*$)/i);
      const explicitFamily = familyRaw ? normalizeFamily(familyRaw[1] || familyRaw[2] || familyRaw[3]) : '';
      const chain = context.match(/\b(?:chain(?:id)?|network|eip155)\s*[:=]\s*([a-z0-9._-]{1,64})\b/i)?.[1] || null; let network = chain;
      if (protocol === 'TRON') { if (/\bmainnet\b/i.test(context)) network = 'mainnet'; else if (/\bnile\b/i.test(context)) network = 'nile'; else if (/\bshasta\b/i.test(context)) network = 'shasta'; }
      const nativeTronDeclared = protocol === 'TRON' && /\bnative\b/i.test(context) && /\/wallet(?:solidity)?\b/i.test(context);
      const providerLabel = context.match(/\b(?:provider|label)\s*[:=]\s*([a-z0-9._ -]{2,80})\b/i)?.[1]?.trim() || '';
      const hostParts = parsed ? parsed.hostname.toLowerCase().split('.').filter(Boolean) : []; const hostFamily = hostParts.length < 3 ? parsed && parsed.hostname.toLowerCase() : hostParts.slice(-2).join('.');
      for (const item of [originRaw, origin, explicitFamily, hostFamily, providerLabel, ...headers.flat()]) if (item) corpus.add(item);
      let category = 'SUPPORTED_PROBE_ENDPOINT', reason = null;
      if (/[{}<>]|\$\{|%\w+%|YOUR[_-]|REPLACE/i.test(raw) || /\b(?:template|placeholder|example|documentation|docs?|reference)\b/i.test(context)) { category = 'NON_PROBEABLE'; reason = 'NON_PROBEABLE_TEMPLATE_REFERENCE'; }
      else if (!parsed) { category = 'NON_PROBEABLE'; reason = 'NON_PROBEABLE_INSECURE_TRANSPORT'; }
      else if (/\bgraphql\b/i.test(context) || parsed && (/(?:^|\/)graphql(?:\/|$)/i.test(parsed.pathname) || /(?:^|[?&])(?:api|type|protocol)=graphql(?:&|$)/i.test(parsed.search))) { category = 'OUT_OF_SCOPE_NONPROBEABLE'; reason = 'NON_PROBEABLE_GRAPHQL'; }
      else if (parsed.protocol === 'wss:') { category = 'NON_PROBEABLE'; reason = 'NON_PROBEABLE_WSS'; }
      else if (protocol === 'TRON' && !nativeTronDeclared) { category = 'NON_PROBEABLE'; reason = 'NON_PROBEABLE_UNSUPPORTED_DIALECT'; }
      else if (((protocol === 'COMETBFT' || protocol === 'COSMOS_LCD') && /\/thorchain\//i.test(parsed.pathname)) || /\b(?:thornode|thorchain app|app\s+\/thorchain)\b/i.test(context)) { category = 'NON_PROBEABLE'; reason = 'NON_PROBEABLE_APP_SURFACE'; }
      else if (protocol !== 'MIDGARD' && /\/v2\//i.test(parsed.pathname)) { category = 'NON_PROBEABLE'; reason = 'NON_PROBEABLE_APP_SURFACE'; }
      else if (/(?:\/status|\/block|\/commit|\/block_results|\/syncing|\/node_info|\/blocks\/latest|\/wallet(?:solidity)?\/[a-z0-9_]+|\/v2\/(?:health|network))\/?$/i.test(parsed.pathname)) { category = 'NON_PROBEABLE'; reason = 'NON_PROBEABLE_ALREADY_SUFFIXED'; }
      else if (!protocol) { category = 'NON_PROBEABLE'; reason = 'NON_PROBEABLE_UNSUPPORTED_PROTOCOL'; }
      countCategory(category); const endpointIdentity = `${parsed ? parsed.href : raw}\0${origin}\0${JSON.stringify(headers)}`;
      const declaredBoolean = (name, fallback) => new RegExp(`\\b${name}\\s*[:=]\\s*false\\b`, 'i').test(context) ? false : fallback ? true : null;
      const declaration = { protocol, chain, network, transport: parsed && parsed.protocol || null, nativeTronDeclared: declaredBoolean('native', nativeTronDeclared),
        phase2Declared: declaredBoolean('(?:archive|historical|trace)', /\b(?:archive|historical|trace)\b/i.test(context)),
        premium: declaredBoolean('(?:premium|credentialed|paid)', /\b(?:premium|credentialed|paid)\b/i.test(context)), family: explicitFamily || null, category, reason };
      if (declarations.has(endpointIdentity)) { const prior = declarations.get(endpointIdentity); for (const field of Object.keys(declaration)) { if (prior[field] !== null && declaration[field] !== null && prior[field] !== declaration[field]) throw new ValidationError('AMBIGUOUS'); if (prior[field] === null && declaration[field] !== null) prior[field] = declaration[field]; } }
      else declarations.set(endpointIdentity, declaration);
      const behavior = JSON.stringify(declaration);
      const key = `${endpointIdentity}\0${behavior}`;
      if (!records.has(key)) records.set(key, { protocol, category, reason });
    }
  }
  const gapReasonCounts = {}, protocolCounts = {}; for (const protocol of PROTOCOLS) protocolCounts[protocol] = { classifiedRecords: 0, probeableCandidates: 0, nonprobeableRecords: 0, wssGaps: 0 };
  for (const row of records.values()) { if (row.reason) gapReasonCounts[row.reason] = (gapReasonCounts[row.reason] || 0) + 1; if (row.protocol) { const p = protocolCounts[row.protocol]; p.classifiedRecords += 1; if (row.category === 'SUPPORTED_PROBE_ENDPOINT') p.probeableCandidates += 1; else p.nonprobeableRecords += 1; if (row.reason === 'NON_PROBEABLE_WSS') p.wssGaps += 1; } }
  return { occurrenceCount, uniqueNormalizedRecords: records.size, classifiedRecords: records.size,
    probeableCandidates: [...records.values()].filter((x) => x.category === 'SUPPORTED_PROBE_ENDPOINT').length,
    nonprobeableRecords: [...records.values()].filter((x) => x.category !== 'SUPPORTED_PROBE_ENDPOINT').length,
    duplicateOccurrences: endpointOccurrences - records.size, categoryCounts: Object.fromEntries(Object.entries(categoryCounts).sort()), annotationCounts: { origins, approvedFields },
    protocolCounts, nonprobeableGapCounts: Object.fromEntries(Object.entries(gapReasonCounts).sort()), corpus };
}
function readProtectedInventory({ root = ROOT, fsOps = fs } = {}) {
  const rootStat = fsOps.lstatSync(root); check(rootStat.isDirectory() && !rootStat.isSymbolicLink(), 'ROOT'); const rootReal = fsOps.realpathSync(root);
  const file = path.join(root, INVENTORY_REL), stat = fsOps.lstatSync(file); check(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 2 * 1024 * 1024, 'INVENTORY');
  const fileReal = fsOps.realpathSync(file); check(path.dirname(fileReal) === rootReal, 'INVENTORY_REALPATH'); const bytes = fsOps.readFileSync(file); check(bytes.length === stat.size, 'INVENTORY_SIZE');
  let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (_) { throw new ValidationError('INVENTORY_UTF8'); } return { text, structure: classifyInventory(text) };
}
function checkParents(root, relative, fsOps) {
  let current = root; const parts = path.dirname(relative).split(/[\\/]/).filter(Boolean);
  for (const part of parts) { current = path.join(current, part); const stat = fsOps.lstatSync(current); check(stat.isDirectory() && !stat.isSymbolicLink(), 'PARENT_REALPATH'); }
}

function validateArtifact(a, { now = Date.now(), inventoryStructure = null } = {}) {
  exactKeys(a, TOP_KEYS, 'TOP_SCHEMA'); check(a.schema === SCHEMA, 'SCHEMA');
  const generated = Date.parse(a.generatedAt); check(Number.isFinite(generated) && new Date(generated).toISOString() === a.generatedAt && generated <= now + 60_000 && generated >= now - 24 * 60 * 60_000, 'GENERATED_AT');
  check(['COMPLETE', 'COMPLETE_WITH_GAPS'].includes(a.status), 'STATUS');
  exactKeys(a.phaseSeparation, ['phase1CompletedBeforeSelection', 'everyProbeableCandidateEvaluated', 'everyClassifiedRecordEvaluated', 'phase2AuthoritativePassingChainsOnly'], 'PHASE');
  check(a.phaseSeparation.phase1CompletedBeforeSelection === true && a.phaseSeparation.everyProbeableCandidateEvaluated === true && a.phaseSeparation.phase2AuthoritativePassingChainsOnly === true, 'PHASE');
  exactKeys(a.inventory, ['occurrenceCount', 'uniqueNormalizedRecords', 'classifiedRecords', 'probeableCandidates', 'nonprobeableRecords', 'duplicateOccurrences', 'categoryCounts', 'annotationCounts', 'protocolCounts', 'nonprobeableGapCounts'], 'INVENTORY_SCHEMA');
  for (const key of ['occurrenceCount', 'uniqueNormalizedRecords', 'classifiedRecords', 'probeableCandidates', 'nonprobeableRecords', 'duplicateOccurrences']) check(uint(a.inventory[key]), 'INVENTORY_RANGE');
  check(a.inventory.uniqueNormalizedRecords <= 320 && a.inventory.classifiedRecords === a.inventory.uniqueNormalizedRecords && a.inventory.probeableCandidates + a.inventory.nonprobeableRecords === a.inventory.classifiedRecords, 'INVENTORY_COUNTS');
  check(object(a.inventory.nonprobeableGapCounts) && sortedKeys(a.inventory.nonprobeableGapCounts), 'GAPS'); let gaps = 0;
  for (const [reason, count] of Object.entries(a.inventory.nonprobeableGapCounts)) { check(GAP_REASONS.has(reason) && uint(count) && count > 0, 'GAP_REASON'); gaps += count; }
  check(gaps === a.inventory.nonprobeableRecords && a.phaseSeparation.everyClassifiedRecordEvaluated === (gaps === 0), 'GAP_TOTAL');
  check(object(a.inventory.categoryCounts) && sortedKeys(a.inventory.categoryCounts) && Object.entries(a.inventory.categoryCounts).every(([key, x]) => INVENTORY_CATEGORIES.has(key) && uint(x) && x > 0), 'CATEGORY_COUNTS');
  check(Object.values(a.inventory.categoryCounts).reduce((n, x) => n + x, 0) === a.inventory.occurrenceCount &&
    (a.inventory.categoryCounts.SUPPORTED_PROBE_ENDPOINT || 0) + (a.inventory.categoryCounts.NON_PROBEABLE || 0) + (a.inventory.categoryCounts.OUT_OF_SCOPE_NONPROBEABLE || 0) - a.inventory.classifiedRecords === a.inventory.duplicateOccurrences, 'CATEGORY_TOTAL');
  exactKeys(a.inventory.annotationCounts, ['origins', 'approvedFields'], 'ANNOTATIONS'); check(uint(a.inventory.annotationCounts.origins) && uint(a.inventory.annotationCounts.approvedFields), 'ANNOTATIONS');
  check(object(a.inventory.protocolCounts) && JSON.stringify(Object.keys(a.inventory.protocolCounts)) === JSON.stringify(PROTOCOLS), 'INVENTORY_PROTOCOLS');
  if (inventoryStructure) {
    const sanitized = { ...inventoryStructure }; delete sanitized.corpus;
    check(JSON.stringify(a.inventory) === JSON.stringify(sanitized), 'INVENTORY_DIRECT_CLASSIFICATION');
  }

  check(Array.isArray(a.protocols) && JSON.stringify(a.protocols.map((x) => x.protocol)) === JSON.stringify(PROTOCOLS), 'PROTOCOL_ORDER'); let attemptedTotal = 0;
  for (const p of a.protocols) {
    exactKeys(p, ['protocol', 'classifiedRecords', 'probeableCandidates', 'nonprobeableRecords', 'wssGaps', 'phase1', 'passingChains', 'pairingGaps', 'phase2Ran', 'authoritativeFinality'], 'PROTOCOL_SCHEMA');
    exactKeys(p.phase1, ['attempted', 'qualified', 'failures'], 'P1_SCHEMA'); check(PROTOCOLS.includes(p.protocol), 'PROTOCOL');
    for (const key of ['classifiedRecords', 'probeableCandidates', 'nonprobeableRecords', 'wssGaps', 'passingChains', 'pairingGaps']) check(uint(p[key], 320), 'PROTOCOL_RANGE');
    check(p.classifiedRecords === p.probeableCandidates + p.nonprobeableRecords && p.wssGaps <= p.nonprobeableRecords && (p.wssGaps === 0 || p.probeableCandidates > 0) && p.phase1.attempted === p.probeableCandidates && p.phase1.qualified <= p.phase1.attempted, 'PROTOCOL_COUNTS');
    check(JSON.stringify(a.inventory.protocolCounts[p.protocol]) === JSON.stringify({ classifiedRecords: p.classifiedRecords, probeableCandidates: p.probeableCandidates, nonprobeableRecords: p.nonprobeableRecords, wssGaps: p.wssGaps }), 'PROTOCOL_DIRECT_COUNTS');
    let failures = 0; check(object(p.phase1.failures) && sortedKeys(p.phase1.failures), 'FAILURES'); for (const [code, count] of Object.entries(p.phase1.failures)) { check(FAILURE_CODES.has(code) && uint(count) && count > 0, 'FAILURE'); failures += count; }
    check(failures === p.phase1.attempted - p.phase1.qualified && p.authoritativeFinality === (p.protocol !== 'MIDGARD') && p.phase2Ran === (p.passingChains > 0), 'PROTOCOL_TOPOLOGY');
    if (p.protocol === 'MIDGARD') check(!p.phase2Ran && p.passingChains === 0, 'MIDGARD'); attemptedTotal += p.phase1.attempted;
  }
  check(a.protocols.reduce((n, p) => n + p.classifiedRecords, 0) <= a.inventory.classifiedRecords && attemptedTotal === a.inventory.probeableCandidates, 'PROTOCOL_TOTAL');

  check(Array.isArray(a.chains) && a.chains.length <= 96, 'CHAINS'); const sorted = [...a.chains].sort((x, y) => x.protocol.localeCompare(y.protocol) || x.chainKey.localeCompare(y.chainKey));
  check(JSON.stringify(a.chains.map((x) => `${x.protocol}\0${x.chainKey}`)) === JSON.stringify(sorted.map((x) => `${x.protocol}\0${x.chainKey}`)) && new Set(a.chains.map((x) => `${x.protocol}\0${x.chainKey}`)).size === a.chains.length, 'CHAIN_ORDER');
  for (const c of a.chains) {
    exactKeys(c, ['chainKey', 'protocol', 'status', 'phase1', 'phase2', 'backendOperatorIndependenceClaimed'], 'CHAIN_SCHEMA');
    exactKeys(c.phase1, ['qualifyingCandidates', 'distinctGroupCount', 'retainedCandidates', 'validPair', 'commonPinAgreement', 'commonPinReadVerified', 'commonPinFailures', 'protocolSpreadWithinLimit', 'wssGap'], 'CHAIN_P1');
    exactKeys(c.phase2, ['ran', 'attemptedCandidates', 'spareCandidateAvailable', 'replacementUsed', 'candidateSuccesses', 'candidateFailures', 'completion', 'attemptAccountingValid', 'capabilities'], 'CHAIN_P2');
    check(validChainKey(c.protocol, c.chainKey) && c.backendOperatorIndependenceClaimed === false && ['PASS', 'PHASE1_PASS_PHASE2_FAILED'].includes(c.status), 'CHAIN_STATUS');
    check(c.phase1.qualifyingCandidates >= 2 && c.phase1.distinctGroupCount >= 2 && c.phase1.retainedCandidates === 2 && c.phase1.validPair === true && c.phase1.commonPinAgreement === true && c.phase1.commonPinReadVerified === true && uint(c.phase1.commonPinFailures, 1) && c.phase1.protocolSpreadWithinLimit === true && typeof c.phase1.wssGap === 'boolean', 'CHAIN_PAIR');
    if (c.phase1.wssGap) check(a.protocols.find((p) => p.protocol === c.protocol).wssGaps > 0, 'CHAIN_WSS');
    check(c.phase2.ran === true && [2, 3].includes(c.phase2.attemptedCandidates) && c.phase2.attemptedCandidates === 2 + (c.phase2.replacementUsed ? 1 : 0), 'CHAIN_ATTEMPTS');
    check(!c.phase2.replacementUsed || c.phase2.spareCandidateAvailable, 'CHAIN_SPARE');
    check(uint(c.phase2.candidateSuccesses, 3) && uint(c.phase2.candidateFailures, 3) && c.phase2.attemptedCandidates === c.phase2.candidateSuccesses + c.phase2.candidateFailures && c.phase2.attemptAccountingValid === true, 'CHAIN_ACCOUNTING');
    check(['COMPLETE', 'PARTIAL', 'FAILED'].includes(c.phase2.completion) && (c.phase2.completion === 'FAILED') === (c.phase2.candidateSuccesses === 0) && (c.status === 'PHASE1_PASS_PHASE2_FAILED') === (c.phase2.completion === 'FAILED'), 'CHAIN_COMPLETION');
    exactKeys(c.phase2.capabilities, CAPABILITY_KEYS[c.protocol], 'CAP_KEYS');
    for (const cap of Object.values(c.phase2.capabilities)) {
      exactKeys(cap, ['status', 'familyPassCount', 'attempted', 'success', 'failed', 'inconclusive', 'unsupported', 'notAttempted', 'notAttemptedCap'], 'CAP_SCHEMA'); check(CAP_STATUS.has(cap.status), 'CAP_STATUS');
      for (const key of ['familyPassCount', 'attempted', 'success', 'failed', 'inconclusive', 'unsupported', 'notAttempted', 'notAttemptedCap']) check(uint(cap[key], 3), 'CAP_COUNTS');
      check(cap.attempted === cap.success + cap.failed + cap.inconclusive + cap.unsupported && cap.familyPassCount <= cap.success, 'CAP_COUNTS');
      if (cap.status !== 'NOT_APPLICABLE') check(cap.attempted + cap.notAttempted + cap.notAttemptedCap === c.phase2.attemptedCandidates, 'CAP_OBSERVATION_TOTAL');
      check((cap.status === 'SUPPORTED') === (cap.familyPassCount === 2) && (cap.status === 'PARTIAL_SINGLE_FAMILY') === (cap.familyPassCount === 1), 'CAP_SEMANTICS');
      if (['NOT_APPLICABLE', 'NOT_ATTEMPTED', 'NOT_ATTEMPTED_CAP'].includes(cap.status)) check(cap.attempted === 0, 'CAP_NA');
      if (cap.status === 'NOT_ATTEMPTED_CAP') check(cap.notAttemptedCap > 0, 'CAP_LIMIT');
      if (cap.status === 'FAILED') check(cap.familyPassCount === 0 && cap.failed > 0, 'CAP_FAILED');
      if (cap.status === 'UNSUPPORTED') check(cap.familyPassCount === 0 && cap.unsupported === cap.attempted && cap.attempted > 0, 'CAP_UNSUPPORTED');
      if (cap.status === 'INCONCLUSIVE') check(cap.familyPassCount === 0 && cap.inconclusive > 0 && cap.failed === 0, 'CAP_INCONCLUSIVE');
    }
    if (['COSMOS_LCD', 'TRON'].includes(c.protocol)) for (const key of ['batch', 'trace']) check(c.phase2.capabilities[key].status === 'NOT_APPLICABLE', 'CAP_NOT_APPLICABLE');
    if (c.phase1.commonPinFailures > 0 || Object.values(c.phase2.capabilities).some((cap) => cap.failed > 0 || cap.notAttemptedCap > 0)) check(c.phase2.completion !== 'COMPLETE', 'FAILED_OBSERVATION_HIDDEN');
  }
  for (const p of a.protocols) check(p.passingChains === a.chains.filter((c) => c.protocol === p.protocol).length, 'CHAIN_PROTOCOL_TOTAL');

  exactKeys(a.budgets, ['limits', 'used'], 'BUDGET'); exactKeys(a.budgets.limits, ['phase1Requests', 'phase2Requests', 'totalRequests', 'logicalOps', 'perCandidateRequests', 'perCandidateLogicalOps', 'globalResponseBytes'], 'LIMITS');
  check(JSON.stringify(Object.values(a.budgets.limits)) === JSON.stringify([1280, 1728, 3072, 3328, 9, 10, 268435456]), 'LIMIT_VALUES');
  exactKeys(a.budgets.used, ['phase1Requests', 'phase2Requests', 'totalRequests', 'logicalOps', 'responseBytes', 'maxConcurrencyObserved', 'maxFamilyConcurrencyObserved', 'maxRollingStarts', 'maxCandidateRequests', 'maxCandidateLogicalOps', 'maxCandidateResponseBytes', 'maxCandidatePhase1ActiveMs', 'maxCandidateActiveMs', 'globalWallMs', 'fatalExhaustion', 'methodCounts'], 'USED');
  const u = a.budgets.used; for (const key of Object.keys(u).filter((x) => !['fatalExhaustion', 'methodCounts'].includes(x))) check(uint(u[key]), 'USED_RANGE');
  check(u.fatalExhaustion === false && u.totalRequests === u.phase1Requests + u.phase2Requests && u.phase1Requests <= 1280 && u.phase2Requests <= 1728 && u.totalRequests <= 3072 && u.logicalOps <= 3328 && u.responseBytes <= 268435456, 'USED_CAP');
  check(u.maxConcurrencyObserved <= 8 && u.maxFamilyConcurrencyObserved <= 1 && u.maxRollingStarts <= 8 && u.maxCandidateRequests <= 9 && u.maxCandidateLogicalOps <= 10 && u.maxCandidateResponseBytes <= 8 * 1024 * 1024 && u.maxCandidatePhase1ActiveMs <= 20000 && u.maxCandidateActiveMs <= 90000 && u.globalWallMs <= 2700000, 'OBSERVED_CAP');
  check(object(u.methodCounts) && sortedKeys(u.methodCounts), 'METHOD_MATRIX'); let methodTotal = 0; for (const [name, count] of Object.entries(u.methodCounts)) { check(METHOD_LABELS.has(name) && uint(count) && count > 0, 'METHOD'); methodTotal += count; }
  check(methodTotal === u.totalRequests, 'METHOD_TOTAL');
  const mc = (name) => u.methodCounts[name] || 0, protocol = (name) => a.protocols.find((x) => x.protocol === name);
  check(mc('EVM:P1:RPC:eth_chainId') === protocol('EVM').phase1.attempted && mc('EVM:P1:RPC:eth_getBlockByNumber') >= protocol('EVM').phase1.qualified * 2, 'EVM_MATRIX');
  check(mc('SOLANA:P1:RPC:getGenesisHash') === protocol('SOLANA').phase1.attempted && mc('SOLANA:P1:RPC:getSlot') >= protocol('SOLANA').phase1.qualified * 2 && mc('SOLANA:P1:RPC:getBlockTime') >= protocol('SOLANA').phase1.qualified, 'SOL_MATRIX');
  check(mc('SUI:P1:RPC:sui_getChainIdentifier') === protocol('SUI').phase1.attempted && mc('SUI:P1:RPC:sui_getCheckpoint') >= protocol('SUI').phase1.qualified, 'SUI_MATRIX');
  check(mc('COMETBFT:P1:GET:/status') === protocol('COMETBFT').phase1.attempted && mc('COMETBFT:P1:GET:/block?height=H') >= protocol('COMETBFT').phase1.qualified && mc('COMETBFT:P1:GET:/commit?height=H') >= protocol('COMETBFT').phase1.qualified, 'COMET_MATRIX');
  check(mc('COSMOS_LCD:P1:GET:/cosmos/base/tendermint/vHbetaH/node_info') === protocol('COSMOS_LCD').phase1.attempted && mc('COSMOS_LCD:P1:GET:/cosmos/base/tendermint/vHbetaH/blocks/latest') >= protocol('COSMOS_LCD').phase1.qualified, 'LCD_MATRIX');
  check(mc('MIDGARD:P1:GET:/vH/health') + mc('MIDGARD:P1:GET:/health') === protocol('MIDGARD').phase1.attempted && mc('MIDGARD:P1:GET:/vH/network') + mc('MIDGARD:P1:GET:/network') >= protocol('MIDGARD').phase1.qualified, 'MIDGARD_MATRIX');
  check(mc('TRON:P1:POST:/wallet/getblockbynum') === protocol('TRON').phase1.attempted && mc('TRON:P1:GET:/walletsolidity/getnowblock') >= protocol('TRON').phase1.qualified, 'TRON_MATRIX');
  check(mc('EVM:P1:PIN:RPC:eth_getBlockByNumber') >= protocol('EVM').passingChains * 2 && mc('SOLANA:P1:PIN:RPC:getBlock') >= protocol('SOLANA').passingChains * 2 &&
    mc('SUI:P1:PIN:RPC:sui_getCheckpoint') >= protocol('SUI').passingChains * 2 && mc('COMETBFT:P1:PIN:GET:/block?height=H') >= protocol('COMETBFT').passingChains * 2 &&
    mc('COMETBFT:P1:PIN:GET:/commit?height=H') >= protocol('COMETBFT').passingChains * 2 && mc('COSMOS_LCD:P1:PIN:GET:/cosmos/base/tendermint/vHbetaH/blocks/H') >= protocol('COSMOS_LCD').passingChains * 2 &&
    mc('TRON:P1:PIN:POST:/walletsolidity/getblockbynum') >= protocol('TRON').passingChains * 2, 'PIN_MATRIX');
  const capabilityMethods = {
    EVM: { batch: ['EVM:P2:BATCH:eth_chainId+eth_getBlockByNumber'], historicalHeader: ['EVM:P2:RPC:eth_getBlockByNumber'], historicalState: ['EVM:P2:RPC:eth_getBalance'], logs: ['EVM:P2:RPC:eth_getLogs'], trace: ['EVM:P2:RPC:debug_traceTransaction', 'EVM:P2:RPC:trace_transaction'] },
    SOLANA: { batch: ['SOLANA:P2:BATCH:getGenesisHash+getSlot'], historicalBlock: ['SOLANA:P2:RPC:getBlock'], historicalTransactionLogs: ['SOLANA:P2:RPC:getTransaction'] },
    SUI: { batch: ['SUI:P2:BATCH:sui_getChainIdentifier+sui_getCheckpoint'], historicalCheckpoint: ['SUI:P2:RPC:sui_getCheckpoint'], historicalTransactionEvents: ['SUI:P2:RPC:sui_getTransactionBlock'] },
    COMETBFT: { batch: ['COMETBFT:P2:BATCH:status+block'], historicalBlock: ['COMETBFT:P2:GET:/block?height=H'], historicalResults: ['COMETBFT:P2:GET:/block_results?height=H'] },
    COSMOS_LCD: { batch: [], historicalBlock: ['COSMOS_LCD:P2:GET:/cosmos/base/tendermint/vHbetaH/blocks/H'], historicalResults: ['COSMOS_LCD:P2:GET:/cosmos/base/tendermint/vHbetaH/block_results/H'], trace: [] },
    TRON: { batch: [], historicalBlock: ['TRON:P2:POST:/walletsolidity/getblockbynum'], trace: [], transactionInfoLogs: ['TRON:P2:POST:/walletsolidity/gettransactioninfobyid'] }
  };
  for (const [protocolName, capabilities] of Object.entries(capabilityMethods)) for (const [capability, methods] of Object.entries(capabilities)) {
    const observations = a.chains.filter((chain) => chain.protocol === protocolName).map((chain) => chain.phase2.capabilities[capability]);
    const attempted = observations.reduce((n, cap) => n + cap.attempted, 0), successfulFamilies = observations.reduce((n, cap) => n + cap.familyPassCount, 0);
    const calls = methods.reduce((n, method) => n + mc(method), 0), variable = protocolName === 'SOLANA' && capability === 'historicalBlock' || protocolName === 'EVM' && capability === 'trace';
    check(calls >= attempted && calls >= successfulFamilies && (variable || calls === attempted), `CAPABILITY_METHOD_BINDING_${protocolName}_${capability}`);
  }

  exactKeys(a.safety, SAFETY_KEYS, 'SAFETY'); const trueFlags = ['readOnly', 'graphqlOutOfScope', 'httpsOnlyProbes', 'wssCountOnly', 'environmentProxiesRejected', 'directNodeHttps', 'dnsPublicResolutionEveryRequest', 'dnsAddressPinnedPerRequest'];
  const falseFlags = ['compressionAccepted', 'dnsToConnectTOCTOUNonclaim', 'keepAlive', 'backendOperatorIndependenceClaimed', 'secretConnectionMaterialPersisted', 'secretConnectionMaterialHashed', 'rawResponsesPersisted', 'exactChainObjectsPersisted', 'signedTransactions', 'broadcasts', 'mutation', 'ethCall', 'simulation', 'hypotheticalTrace', 'stateOverrides'];
  for (const key of trueFlags) check(a.safety[key] === true, 'SAFETY_TRUE'); for (const key of falseFlags) check(a.safety[key] === false, 'SAFETY_FALSE'); check(a.safety.redirectsFollowed === 0 && a.safety.retries === 0, 'SAFETY_ZERO');
  exactKeys(a.leakCheck, ['status', 'directCorpusScan', 'genericPatternScan'], 'LEAK'); check(a.leakCheck.status === 'PASS' && a.leakCheck.directCorpusScan && a.leakCheck.genericPatternScan, 'LEAK');
  check(JSON.stringify(a.nonclaims) === JSON.stringify(['BACKEND_OPERATOR_INDEPENDENCE_NOT_ESTABLISHED', 'CAPABILITY_OBSERVATION_NOT_AVAILABILITY_GUARANTEE', 'COMMIT_SIGNATURES_STRUCTURAL_NOT_CRYPTOGRAPHIC_VOTING_POWER', 'WINDOWS_DIRECTORY_FSYNC_DURABILITY_NOT_GUARANTEED']), 'NONCLAIMS');
  const gapsExpected = gaps > 0 || a.protocols.some((p) => Object.keys(p.phase1.failures).length || p.pairingGaps > 0) || a.chains.some((c) => c.phase2.completion !== 'COMPLETE' || c.phase1.commonPinFailures > 0 || Object.values(c.phase2.capabilities).some((cap) => cap.failed > 0));
  check((a.status === 'COMPLETE_WITH_GAPS') === gapsExpected, 'STATUS_GAPS'); return a;
}

function validateSerializedArtifact(text, options = {}) {
  check(typeof text === 'string' && Buffer.byteLength(text) <= MAX_BYTES, 'SIZE'); let value; try { value = JSON.parse(text); } catch (_) { throw new ValidationError('JSON'); }
  check(text === `${JSON.stringify(value, null, 2)}\n`, 'CANONICAL'); genericLeak(text, value, options.corpus || []); return validateArtifact(value, options);
}
function validateSerializedAgainstFixedInventory(text, { root = ROOT, fsOps = fs, now = Date.now() } = {}) {
  const inventory = readProtectedInventory({ root, fsOps }); return validateSerializedArtifact(text, { now, inventoryStructure: inventory.structure, corpus: inventory.structure.corpus });
}
function validateFixedPath({ root = ROOT, fsOps = fs, now = Date.now() } = {}) {
  const rootStat = fsOps.lstatSync(root); check(rootStat.isDirectory() && !rootStat.isSymbolicLink(), 'ROOT'); const rootReal = fsOps.realpathSync(root);
  checkParents(root, OUTPUT_REL, fsOps);
  const file = path.join(root, OUTPUT_REL), stat = fsOps.lstatSync(file); check(stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_BYTES, 'FILE');
  const fileReal = fsOps.realpathSync(file); check(fileReal.startsWith(`${rootReal}${path.sep}`), 'FILE_REALPATH'); const body = fsOps.readFileSync(file); check(body.length === stat.size, 'FILE_SIZE');
  let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(body); } catch (_) { throw new ValidationError('UTF8'); }
  return validateSerializedAgainstFixedInventory(text, { root, fsOps, now });
}
if (require.main === module) {
  try { check(process.argv.slice(2).length === 0 && process.execArgv.length === 0, 'INVOCATION'); validateInvocation(); validateFixedPath(); process.stdout.write('ALL_CHAIN_ENDPOINT_CAPABILITY_V1_VALID\n'); }
  catch (_) { process.stderr.write('ALL_CHAIN_ENDPOINT_CAPABILITY_V1_INVALID\n'); process.exitCode = 1; }
}
module.exports = { ROOT, INVENTORY_REL, OUTPUT_REL, SCHEMA, PROTOCOLS, ValidationError, validateInvocation, validChainKey, genericLeak,
  classifyInventory, readProtectedInventory, validateArtifact, validateSerializedArtifact, validateSerializedAgainstFixedInventory, validateFixedPath };
