#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const MARKER_REL = 'reports/raw/fast/all-chain-endpoint-preflight-v4/preflight.json';
const CONSUMED_REL = 'reports/raw/fast/all-chain-endpoint-preflight-v4/preflight.consumed.json';
const CAPABILITY_REL = 'reports/raw/fast/all-chain-endpoint-capability-v4/capability.json';
const SCHEMA = 'all-chain-endpoint-preflight-v4';
const PACKAGE = 'all-chain-endpoint-capability-v4-reviewed';
const MAX_BYTES = 4096;
const EXPIRY_MS = 3_600_000;
const TEMP_PATTERNS = Object.freeze([/^\.preflight\.json\.\d+\.[0-9a-f]{16}\.tmp$/, /^\.capability\.json\.\d+\.[0-9a-f]{16}\.(?:probe\.(?:tmp|link)|tmp)$/]);
const STAGE_SUBCODES = Object.freeze({
  INVOCATION: Object.freeze(['ARGS_FORBIDDEN', 'EXEC_ARGV_FORBIDDEN', 'ENV_FORBIDDEN']),
  SOURCE_SET: Object.freeze(['ROOT_INVALID', 'SOURCE_MISSING', 'SOURCE_PATH_INVALID', 'SOURCE_FILE_INVALID', 'SOURCE_SIZE_INVALID', 'SOURCE_READ_INCONSISTENT', 'SOURCE_UTF8_INVALID', 'TOTAL_SIZE_OVERFLOW']),
  CLASSIFICATION: Object.freeze(['EMPTY', 'OCCURRENCE_OVERFLOW', 'RECORD_OVERFLOW', 'IDENTITY_OVERFLOW', 'AMBIGUOUS', 'UNCLASSIFIED', 'CHAIN_ALIAS_UNRESOLVED', 'CONFLICT', 'ROLE_INVALID', 'REQUEST_SHAPE_INVALID']),
  COUNTERPART_GATE: Object.freeze(['PRIMARY_HTTPS_MISSING', 'WSS_IDENTITY_UNRESOLVED', 'WSS_HTTPS_COUNTERPART_MISSING', 'RPC_ALIAS_CONFLICT']),
  POLICY_GATE: Object.freeze(['GRAPHQL_PRIMARY_FORBIDDEN', 'GRAPHQL_IDENTITY_FORBIDDEN', 'HISTORICAL_PROMOTION_FORBIDDEN', 'ENGINE_AUTH_FORBIDDEN']),
  OUTPUT_PREFLIGHT: Object.freeze(['PARENT_UNSAFE', 'FINAL_EXISTS', 'TEMP_EXISTS', 'PROBE_OPEN', 'PROBE_WRITE', 'PROBE_FILE_FSYNC', 'PROBE_HARDLINK', 'PROBE_FINAL_VERIFY', 'PROBE_TEMP_UNLINK', 'PROBE_LINK_UNLINK', 'DIRECTORY_FSYNC', 'CLEANUP']),
  DIAGNOSTIC_PUBLICATION: Object.freeze(['TEMP_OPEN', 'TEMP_WRITE', 'TEMP_FILE_FSYNC', 'HARDLINK', 'FINAL_VERIFY', 'TEMP_UNLINK', 'DIRECTORY_FSYNC', 'FINAL_INVALIDATION_FAILED', 'CLEANUP']), INTERNAL: Object.freeze(['UNEXPECTED']), READY: Object.freeze(['READY']),
});
const TOKENS = Object.freeze({ VALID: 'ALL_CHAIN_ENDPOINT_PREFLIGHT_V4_VALID', NOT_READY: 'ALL_CHAIN_ENDPOINT_PREFLIGHT_V4_NOT_READY', INVALID: 'ALL_CHAIN_ENDPOINT_PREFLIGHT_V4_INVALID' });
const FORBIDDEN_ENV_EXACT = new Set(['NODE_OPTIONS', 'NODE_DEBUG', 'NODE_DEBUG_NATIVE', 'SSLKEYLOGFILE', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'OPENSSL_CONF', 'USE_ENV_PROXY']);
class ValidationError extends Error { constructor(code) { super(code); this.name = 'ValidationError'; this.code = code; } }
function check(value, code) { if (!value) throw new ValidationError(code); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exact(value, keys, code) { check(object(value) && JSON.stringify(Object.keys(value)) === JSON.stringify(keys), code); }
function validateInvocation({ argv = process.argv.slice(2), execArgv = process.execArgv, env = process.env } = {}) {
  check(Array.isArray(argv) && argv.length === 0, 'ARGS_FORBIDDEN'); check(Array.isArray(execArgv) && execArgv.length === 0, 'EXEC_ARGV_FORBIDDEN');
  for (const [name, raw] of Object.entries(env || {})) { if (raw === undefined || raw === null || String(raw) === '') continue; const upper = name.toUpperCase();
    check(!upper.includes('PROXY') && !FORBIDDEN_ENV_EXACT.has(upper) && !upper.includes('KEYLOG') && !upper.includes('ENDPOINT') && !upper.includes('RPC') && !upper.includes('SOLANA') && !upper.includes('SUI') && !upper.includes('DEBUG') && !upper.includes('TOKEN') && !upper.includes('PRIVATE_KEY') && !upper.includes('WALLET') && !upper.includes('TLS') && !upper.includes('SSL'), 'ENV_FORBIDDEN'); }
  return true;
}
function validateSerialized(text, { now = Date.now(), mode = 'live' } = {}) {
  check(mode === 'live' || mode === 'structural', 'MODE');
  check(typeof text === 'string' && Buffer.byteLength(text) <= MAX_BYTES, 'SIZE'); let value; try { value = JSON.parse(text); } catch (_) { throw new ValidationError('JSON'); }
  check(text === `${JSON.stringify(value, null, 2)}\n`, 'CANONICAL'); exact(value, ['schema', 'package', 'generatedAt', 'expiresAt', 'status', 'stage', 'subcode', 'safety'], 'TOP');
  check(value.schema === SCHEMA && value.package === PACKAGE, 'IDENTITY'); const generated = Date.parse(value.generatedAt), expires = Date.parse(value.expiresAt);
  check(Number.isFinite(generated) && Number.isFinite(expires) && new Date(generated).toISOString() === value.generatedAt && new Date(expires).toISOString() === value.expiresAt && expires - generated === EXPIRY_MS, 'TIME');
  if (mode === 'live') check(generated <= now + 60_000, 'FUTURE'); check(value.status === 'PASS' || value.status === 'FAIL', 'STATUS'); check(STAGE_SUBCODES[value.stage] && STAGE_SUBCODES[value.stage].includes(value.subcode), 'ENUM');
  if (value.status === 'PASS') check(value.stage === 'READY' && value.subcode === 'READY' && (mode === 'structural' || generated <= now && now < expires), 'READINESS'); else check(!(value.stage === 'READY' && value.subcode === 'READY'), 'FAIL_ENUM');
  exact(value.safety, ['offlineOnly', 'dnsAttempted', 'networkAttempted', 'rawErrorsPersisted', 'inventoryMaterialPersisted', 'inventoryDerivedHashesPersisted'], 'SAFETY');
  check(value.safety.offlineOnly === true && value.safety.dnsAttempted === false && value.safety.networkAttempted === false && value.safety.rawErrorsPersisted === false && value.safety.inventoryMaterialPersisted === false && value.safety.inventoryDerivedHashesPersisted === false, 'SAFETY_VALUES');
  check(!/(?:https?|wss):\/\/|authorization|bearer|api.?key|provider|hostname/i.test(text), 'LEAK'); return value;
}
function safeRootAndParent(root, relative, fsOps = fs) {
  let stat, rootReal; try { stat = fsOps.lstatSync(root); rootReal = fsOps.realpathSync(root); } catch (_) { throw new ValidationError('ROOT'); }
  check(stat.isDirectory() && !stat.isSymbolicLink() && path.resolve(rootReal) === path.resolve(root), 'ROOT'); let current = root;
  for (const part of path.dirname(relative).split(/[\\/]+/).filter(Boolean)) { current = path.join(current, part); try { stat = fsOps.lstatSync(current); const real = fsOps.realpathSync(current); check(stat.isDirectory() && !stat.isSymbolicLink() && (real === rootReal || real.startsWith(`${rootReal}${path.sep}`)), 'PARENT'); } catch (error) { if (error instanceof ValidationError) throw error; throw new ValidationError('PARENT'); } }
  return current;
}
function absent(file, fsOps, code) { try { fsOps.lstatSync(file); throw new ValidationError(code); } catch (error) { if (error instanceof ValidationError) throw error; check(error && error.code === 'ENOENT', code); } }
function validateFixedPath({ root = ROOT, fsOps = fs, now = Date.now(), argv = process.argv.slice(2), execArgv = process.execArgv, env = process.env } = {}) {
  validateInvocation({ argv, execArgv, env }); const markerParent = safeRootAndParent(root, MARKER_REL, fsOps), capabilityParent = safeRootAndParent(root, CAPABILITY_REL, fsOps);
  absent(path.join(root, CONSUMED_REL), fsOps, 'CONSUMED_EXISTS'); absent(path.join(root, CAPABILITY_REL), fsOps, 'CAPABILITY_EXISTS');
  for (const parent of new Set([markerParent, capabilityParent])) { let names; try { names = fsOps.readdirSync(parent); } catch (_) { throw new ValidationError('TEMP_READ'); } check(!names.some((name) => TEMP_PATTERNS.some((pattern) => pattern.test(name))), 'TEMP_EXISTS'); }
  const file = path.join(root, MARKER_REL); let before, body, after, fileReal; try { before = fsOps.lstatSync(file); fileReal = fsOps.realpathSync(file); body = fsOps.readFileSync(file); after = fsOps.lstatSync(file); } catch (_) { throw new ValidationError('FILE'); }
  let rootReal; try { rootReal = fsOps.realpathSync(root); } catch (_) { throw new ValidationError('ROOT'); } check(fileReal.startsWith(`${rootReal}${path.sep}`), 'FILE_REALPATH');
  check(before.isFile() && !before.isSymbolicLink() && before.size <= MAX_BYTES && Buffer.isBuffer(body) && body.length === before.size && after.size === before.size && after.dev === before.dev && after.ino === before.ino && after.mtimeMs === before.mtimeMs, 'FILE');
  let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(body); } catch (_) { throw new ValidationError('UTF8'); } const marker = validateSerialized(text, { now, mode: 'live' }); return { disposition: marker.status === 'PASS' ? 'VALID' : 'NOT_READY', marker };
}
function cli(options = {}, io = process) { try { const result = validateFixedPath(options); io.stdout.write(`${TOKENS[result.disposition]}\n`); return result.disposition === 'VALID' ? 0 : 1; } catch (_) { io.stdout.write(`${TOKENS.INVALID}\n`); return 1; } }
if (require.main === module) process.exitCode = cli();
module.exports = { ROOT, MARKER_REL, CONSUMED_REL, CAPABILITY_REL, SCHEMA, PACKAGE, MAX_BYTES, EXPIRY_MS, TEMP_PATTERNS, STAGE_SUBCODES, TOKENS, ValidationError,
  validateInvocation, validateSerialized, safeRootAndParent, validateFixedPath, cli };
