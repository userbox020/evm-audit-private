#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');

const SCHEMA = 'solana-readonly-capability-v1';
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const CLOCK_SYSVAR = 'SysvarC1ock11111111111111111111111111111111';
const SYSVAR_OWNER = 'Sysvar1111111111111111111111111111111111111';
const PUBLIC_MAINNET_CANDIDATES = Object.freeze([
  'https://api.mainnet-beta.solana.com',
]);
const METHOD_SEQUENCE = Object.freeze([
  'getGenesisHash',
  'getSlot',
  'getBlockTime',
  'getAccountInfo',
]);
const OUTPUT_RELATIVE_PATH = 'reports/raw/fast/solana-readonly-capability-restoration/capability.json';
const WORKSPACE_ROOT = path.resolve(__dirname, '..');
const REQUEST_TIMEOUT_MS = 20_000;
const RESPONSE_MAX_BYTES = 1024 * 1024;
const ARTIFACT_MAX_BYTES = 64 * 1024;

const SAFE_CODES = new Set([
  'ARGS_FORBIDDEN',
  'EXEC_ARGV_FORBIDDEN',
  'ENV_FORBIDDEN',
  'OUTPUT_OUTSIDE_WORKSPACE',
  'OUTPUT_PARENT_MISSING',
  'OUTPUT_PARENT_INVALID',
  'OUTPUT_PARENT_NOT_WRITABLE',
  'OUTPUT_EXISTS',
  'PREFLIGHT_ATOMIC_UNAVAILABLE',
  'WRITE_FAILED',
  'TIMEOUT',
  'NETWORK',
  'REDIRECT',
  'HTTP_STATUS',
  'CONTENT_TYPE',
  'CONTENT_ENCODING',
  'CONTENT_LENGTH',
  'RESPONSE_TOO_LARGE',
  'JSON_INVALID',
  'RPC_RESPONSE_NOT_OBJECT',
  'RPC_VERSION_INVALID',
  'RPC_ID_MISMATCH',
  'RPC_ERROR',
  'RPC_RESULT_MISSING',
  'GENESIS_MISMATCH',
  'SLOT_INVALID',
  'BLOCK_TIME_INVALID',
  'ACCOUNT_CONTEXT_INVALID',
  'ACCOUNT_MISSING',
  'ACCOUNT_OWNER_INVALID',
  'ACCOUNT_EXECUTABLE_INVALID',
  'ACCOUNT_DATA_INVALID',
  'ARTIFACT_INVALID',
  'INTERNAL',
]);

class SafeError extends Error {
  constructor(code) {
    super(SAFE_CODES.has(code) ? code : 'INTERNAL');
    this.name = 'SafeError';
    this.code = SAFE_CODES.has(code) ? code : 'INTERNAL';
  }
}

function fail(code) {
  throw new SafeError(code);
}

function isActiveEnvValue(value) {
  return value !== undefined && value !== null && String(value).length > 0;
}

function validateInvocation({ argv, execArgv, env }) {
  if (!Array.isArray(argv) || argv.length !== 0) fail('ARGS_FORBIDDEN');
  if (!Array.isArray(execArgv) || execArgv.length !== 0) fail('EXEC_ARGV_FORBIDDEN');
  if (!env || typeof env !== 'object') fail('ENV_FORBIDDEN');

  const exactForbidden = new Set([
    'NODE_OPTIONS',
    'NODE_DEBUG',
    'NODE_DEBUG_NATIVE',
    'SSLKEYLOGFILE',
    'NODE_TLS_REJECT_UNAUTHORIZED',
    'NODE_EXTRA_CA_CERTS',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'OPENSSL_CONF',
    'USE_ENV_PROXY',
  ]);

  for (const [name, value] of Object.entries(env)) {
    if (!isActiveEnvValue(value)) continue;
    if (name === 'NO_PROXY') continue;

    const upper = name.toUpperCase();
    if (exactForbidden.has(upper)) fail('ENV_FORBIDDEN');
    if (upper.includes('PROXY')) fail('ENV_FORBIDDEN');
    if (upper.includes('DEBUG') || upper.includes('KEYLOG') || upper.includes('TLS') || upper.includes('SSL')) {
      fail('ENV_FORBIDDEN');
    }
    if (upper.includes('SOLANA')) fail('ENV_FORBIDDEN');
    if (upper.includes('RPC') || upper.includes('ENDPOINT')) fail('ENV_FORBIDDEN');
  }
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function safeUnlink(filePath, fsOps = fs) {
  try {
    fsOps.unlinkSync(filePath);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') return false;
  }
  return true;
}

function uniqueSibling(parent, base, kind) {
  const token = crypto.randomBytes(12).toString('hex');
  return path.join(parent, `.${base}.${kind}.${process.pid}.${token}`);
}

function preflightOutput({
  workspaceRoot = WORKSPACE_ROOT,
  outputRelativePath = OUTPUT_RELATIVE_PATH,
  fsOps = fs,
} = {}) {
  const resolvedRoot = path.resolve(workspaceRoot);
  const outputPath = path.resolve(resolvedRoot, outputRelativePath);
  if (!isInside(resolvedRoot, outputPath)) fail('OUTPUT_OUTSIDE_WORKSPACE');

  const parent = path.dirname(outputPath);
  let rootReal;
  let parentReal;
  try {
    rootReal = fsOps.realpathSync(resolvedRoot);
  } catch (_) {
    fail('OUTPUT_OUTSIDE_WORKSPACE');
  }
  try {
    const parentStat = fsOps.lstatSync(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) fail('OUTPUT_PARENT_INVALID');
    parentReal = fsOps.realpathSync(parent);
  } catch (error) {
    if (error instanceof SafeError) throw error;
    if (error && error.code === 'ENOENT') fail('OUTPUT_PARENT_MISSING');
    fail('OUTPUT_PARENT_INVALID');
  }
  if (!isInside(rootReal, parentReal)) fail('OUTPUT_OUTSIDE_WORKSPACE');

  try {
    fsOps.accessSync(parent, fs.constants.W_OK);
  } catch (_) {
    fail('OUTPUT_PARENT_NOT_WRITABLE');
  }

  try {
    fsOps.lstatSync(outputPath);
    fail('OUTPUT_EXISTS');
  } catch (error) {
    if (error instanceof SafeError) throw error;
    if (!error || error.code !== 'ENOENT') fail('OUTPUT_EXISTS');
  }

  const base = path.basename(outputPath);
  const probeSource = uniqueSibling(parent, base, 'preflight-source');
  const probeLink = uniqueSibling(parent, base, 'preflight-link');
  let fd;
  try {
    fd = fsOps.openSync(probeSource, 'wx', 0o600);
    fsOps.writeFileSync(fd, Buffer.from('capability-preflight\n', 'utf8'));
    fsOps.fsyncSync(fd);
    fsOps.closeSync(fd);
    fd = undefined;
    fsOps.linkSync(probeSource, probeLink);
    const sourceStat = fsOps.lstatSync(probeSource);
    const linkStat = fsOps.lstatSync(probeLink);
    if (!sourceStat.isFile() || !linkStat.isFile() || sourceStat.ino !== linkStat.ino) {
      fail('PREFLIGHT_ATOMIC_UNAVAILABLE');
    }
  } catch (error) {
    if (fd !== undefined) {
      try { fsOps.closeSync(fd); } catch (_) { /* fixed cleanup */ }
    }
    safeUnlink(probeLink, fsOps);
    safeUnlink(probeSource, fsOps);
    if (error instanceof SafeError) throw error;
    fail('PREFLIGHT_ATOMIC_UNAVAILABLE');
  }
  const linkClean = safeUnlink(probeLink, fsOps);
  const sourceClean = safeUnlink(probeSource, fsOps);
  if (!linkClean || !sourceClean) fail('PREFLIGHT_ATOMIC_UNAVAILABLE');

  return Object.freeze({ outputPath, parent, outputRelativePath: OUTPUT_RELATIVE_PATH });
}

function parseContentLength(value) {
  if (value === undefined) return null;
  if (Array.isArray(value) || !/^(0|[1-9][0-9]*)$/.test(String(value))) fail('CONTENT_LENGTH');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > RESPONSE_MAX_BYTES) fail('CONTENT_LENGTH');
  return parsed;
}

function httpsJsonTransport({ endpoint, payload, requestImpl = https.request }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let request;
    let wallTimer;
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const finishReject = (code) => {
      if (settled) return;
      settled = true;
      if (wallTimer) clearTimeout(wallTimer);
      reject(new SafeError(code));
    };
    const finishResolve = (value) => {
      if (settled) return;
      settled = true;
      if (wallTimer) clearTimeout(wallTimer);
      resolve(value);
    };

    let parsed;
    try {
      parsed = new URL(endpoint);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) fail('NETWORK');
      request = requestImpl({
        protocol: 'https:',
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'content-length': body.length,
        },
        agent: false,
      }, (response) => {
        const status = response.statusCode;
        if (Number.isInteger(status) && status >= 300 && status < 400) {
          if (typeof response.resume === 'function') response.resume();
          finishReject('REDIRECT');
          return;
        }
        if (status !== 200) {
          if (typeof response.resume === 'function') response.resume();
          finishReject('HTTP_STATUS');
          return;
        }

        const contentType = response.headers && response.headers['content-type'];
        if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
          if (typeof response.resume === 'function') response.resume();
          finishReject('CONTENT_TYPE');
          return;
        }
        const contentEncoding = response.headers && response.headers['content-encoding'];
        if (contentEncoding !== undefined && String(contentEncoding).toLowerCase() !== 'identity') {
          if (typeof response.resume === 'function') response.resume();
          finishReject('CONTENT_ENCODING');
          return;
        }
        try {
          parseContentLength(response.headers && response.headers['content-length']);
        } catch (error) {
          if (typeof response.resume === 'function') response.resume();
          finishReject(error instanceof SafeError ? error.code : 'CONTENT_LENGTH');
          return;
        }

        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          if (settled) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.length;
          if (size > RESPONSE_MAX_BYTES) {
            if (typeof response.destroy === 'function') response.destroy();
            finishReject('RESPONSE_TOO_LARGE');
            return;
          }
          chunks.push(buffer);
        });
        response.on('error', () => finishReject('NETWORK'));
        response.on('end', () => {
          if (settled) return;
          try {
            finishResolve(JSON.parse(Buffer.concat(chunks, size).toString('utf8')));
          } catch (_) {
            finishReject('JSON_INVALID');
          }
        });
      });
    } catch (error) {
      finishReject(error instanceof SafeError ? error.code : 'NETWORK');
      return;
    }

    request.on('error', () => finishReject('NETWORK'));
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      finishReject('TIMEOUT');
      if (request && typeof request.destroy === 'function') request.destroy();
    });
    wallTimer = setTimeout(() => {
      finishReject('TIMEOUT');
      if (request && typeof request.destroy === 'function') request.destroy();
    }, REQUEST_TIMEOUT_MS);
    if (typeof wallTimer.unref === 'function') wallTimer.unref();
    request.end(body);
  });
}

function validateRpcEnvelope(envelope, id) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) fail('RPC_RESPONSE_NOT_OBJECT');
  if (envelope.jsonrpc !== '2.0') fail('RPC_VERSION_INVALID');
  if (envelope.id !== id) fail('RPC_ID_MISMATCH');
  if (Object.prototype.hasOwnProperty.call(envelope, 'error')) fail('RPC_ERROR');
  if (!Object.prototype.hasOwnProperty.call(envelope, 'result')) fail('RPC_RESULT_MISSING');
  return envelope.result;
}

async function rpcCall(transport, endpoint, method, params, id) {
  let envelope;
  try {
    envelope = await transport({
      endpoint,
      payload: { jsonrpc: '2.0', id, method, params },
    });
  } catch (error) {
    if (error instanceof SafeError) throw error;
    fail('NETWORK');
  }
  return validateRpcEnvelope(envelope, id);
}

function requireSafeNonnegativeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function canonicalUtcFromSeconds(value) {
  requireSafeNonnegativeInteger(value, 'BLOCK_TIME_INVALID');
  const milliseconds = value * 1000;
  if (!Number.isSafeInteger(milliseconds)) fail('BLOCK_TIME_INVALID');
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime())) fail('BLOCK_TIME_INVALID');
  return date.toISOString();
}

function isCanonicalBase64(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) return false;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  return Buffer.from(value, 'base64').toString('base64') === value;
}

async function collectCapability({ transport = httpsJsonTransport, endpoint = PUBLIC_MAINNET_CANDIDATES[0] } = {}) {
  const genesis = await rpcCall(transport, endpoint, METHOD_SEQUENCE[0], [], 1);
  if (genesis !== MAINNET_GENESIS) fail('GENESIS_MISMATCH');

  const anchor = requireSafeNonnegativeInteger(
    await rpcCall(transport, endpoint, METHOD_SEQUENCE[1], [{ commitment: 'finalized' }], 2),
    'SLOT_INVALID',
  );

  const blockTime = await rpcCall(transport, endpoint, METHOD_SEQUENCE[2], [anchor], 3);
  const blockTimeUtc = canonicalUtcFromSeconds(blockTime);

  const accountResult = await rpcCall(
    transport,
    endpoint,
    METHOD_SEQUENCE[3],
    [CLOCK_SYSVAR, { encoding: 'base64', commitment: 'finalized', minContextSlot: anchor }],
    4,
  );
  if (!accountResult || typeof accountResult !== 'object' || Array.isArray(accountResult)) {
    fail('ACCOUNT_CONTEXT_INVALID');
  }
  if (!accountResult.context || typeof accountResult.context !== 'object' || Array.isArray(accountResult.context)) {
    fail('ACCOUNT_CONTEXT_INVALID');
  }
  const contextSlot = requireSafeNonnegativeInteger(accountResult.context.slot, 'ACCOUNT_CONTEXT_INVALID');
  if (contextSlot < anchor) fail('ACCOUNT_CONTEXT_INVALID');
  if (!accountResult.value || typeof accountResult.value !== 'object' || Array.isArray(accountResult.value)) {
    fail('ACCOUNT_MISSING');
  }
  if (accountResult.value.owner !== SYSVAR_OWNER) fail('ACCOUNT_OWNER_INVALID');
  if (accountResult.value.executable !== false) fail('ACCOUNT_EXECUTABLE_INVALID');
  if (!Array.isArray(accountResult.value.data) || accountResult.value.data.length !== 2) {
    fail('ACCOUNT_DATA_INVALID');
  }
  if (accountResult.value.data[1] !== 'base64' || !isCanonicalBase64(accountResult.value.data[0])) {
    fail('ACCOUNT_DATA_INVALID');
  }

  return Object.freeze({ anchor, blockTime, blockTimeUtc, contextSlot });
}

function buildArtifact(observation) {
  return {
    schema: SCHEMA,
    status: 'PASS',
    chain: 'mainnet',
    genesis: {
      expected: MAINNET_GENESIS,
      verified: MAINNET_GENESIS,
    },
    finalized: {
      slot: observation.anchor,
      blockTime: observation.blockTime,
      blockTimeUtc: observation.blockTimeUtc,
    },
    clock: {
      class: 'Clock',
      exists: true,
      ownerVerified: true,
      executable: false,
      contextSlot: observation.contextSlot,
      minContextSlot: observation.anchor,
      minContextSlotSatisfied: true,
      dataEncoding: 'base64',
      dataCanonical: true,
    },
    calls: {
      methods: [...METHOD_SEQUENCE],
      successful: 4,
      retries: 0,
    },
    safety: {
      capabilityOnly: true,
      targetBinding: false,
      targetProgramDataQueried: false,
      targetCensusPerformed: false,
      inventoryRead: false,
      configRead: false,
      externalInputAccepted: false,
      remoteIdentityPersisted: false,
      selectionMetadataPersisted: false,
      failureMetadataPersisted: false,
      transportMetadataPersisted: false,
      accountDataPersisted: false,
      lamportsPersisted: false,
      rentEpochPersisted: false,
      spacePersisted: false,
      redirectsFollowed: false,
      wslInvoked: false,
      solanaCliInvoked: false,
      secretsAccessed: false,
      keysAccessed: false,
      walletsAccessed: false,
      signing: false,
      simulation: false,
      transactions: false,
      fork: false,
      productionMutation: false,
      fundsMoved: false,
    },
    nonClaims: ['CAPABILITY_ONLY_NO_TARGET_BINDING'],
  };
}

function assertBuiltArtifact(artifact) {
  if (!artifact || artifact.schema !== SCHEMA || artifact.status !== 'PASS') fail('ARTIFACT_INVALID');
  if (artifact.genesis.expected !== MAINNET_GENESIS || artifact.genesis.verified !== MAINNET_GENESIS) {
    fail('ARTIFACT_INVALID');
  }
  if (artifact.clock.contextSlot < artifact.clock.minContextSlot) fail('ARTIFACT_INVALID');
  if (JSON.stringify(artifact.calls.methods) !== JSON.stringify(METHOD_SEQUENCE)) fail('ARTIFACT_INVALID');
  if (artifact.calls.successful !== 4 || artifact.calls.retries !== 0) fail('ARTIFACT_INVALID');
  if (artifact.nonClaims.length !== 1 || artifact.nonClaims[0] !== 'CAPABILITY_ONLY_NO_TARGET_BINDING') {
    fail('ARTIFACT_INVALID');
  }
}

function serializeArtifact(artifact) {
  assertBuiltArtifact(artifact);
  const text = `${JSON.stringify(artifact, null, 2)}\n`;
  if (Buffer.byteLength(text, 'utf8') > ARTIFACT_MAX_BYTES) fail('ARTIFACT_INVALID');
  return text;
}

function writeArtifactNoOverwrite({ outputPath, text, fsOps = fs }) {
  const parent = path.dirname(outputPath);
  const tempPath = uniqueSibling(parent, path.basename(outputPath), 'write');
  let fd;
  try {
    fd = fsOps.openSync(tempPath, 'wx', 0o600);
    fsOps.writeFileSync(fd, Buffer.from(text, 'utf8'));
    fsOps.fsyncSync(fd);
    fsOps.closeSync(fd);
    fd = undefined;
    fsOps.linkSync(tempPath, outputPath);
  } catch (error) {
    if (fd !== undefined) {
      try { fsOps.closeSync(fd); } catch (_) { /* fixed cleanup */ }
    }
    safeUnlink(tempPath, fsOps);
    if (error && error.code === 'EEXIST') fail('OUTPUT_EXISTS');
    fail('WRITE_FAILED');
  }
  if (!safeUnlink(tempPath, fsOps)) {
    safeUnlink(outputPath, fsOps);
    safeUnlink(tempPath, fsOps);
    fail('WRITE_FAILED');
  }
}

async function run(options = {}) {
  const argv = options.argv === undefined ? process.argv.slice(2) : options.argv;
  const execArgv = options.execArgv === undefined ? process.execArgv : options.execArgv;
  const env = options.env === undefined ? process.env : options.env;
  validateInvocation({ argv, execArgv, env });

  const preflight = preflightOutput({
    workspaceRoot: options.workspaceRoot || WORKSPACE_ROOT,
    outputRelativePath: options.outputRelativePath || OUTPUT_RELATIVE_PATH,
    fsOps: options.fsOps || fs,
  });
  const observation = await collectCapability({
    transport: options.transport || httpsJsonTransport,
    endpoint: PUBLIC_MAINNET_CANDIDATES[0],
  });
  const artifact = buildArtifact(observation);
  const text = serializeArtifact(artifact);
  writeArtifactNoOverwrite({ outputPath: preflight.outputPath, text, fsOps: options.fsOps || fs });
  return Object.freeze({ outputRelativePath: OUTPUT_RELATIVE_PATH, artifact });
}

async function main() {
  try {
    const result = await run();
    process.stdout.write(`CAPABILITY_OK ${result.outputRelativePath}\n`);
  } catch (error) {
    const code = error instanceof SafeError ? error.code : 'INTERNAL';
    process.stderr.write(`CAPABILITY_FAILED_${code}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  ARTIFACT_MAX_BYTES,
  CLOCK_SYSVAR,
  MAINNET_GENESIS,
  METHOD_SEQUENCE,
  OUTPUT_RELATIVE_PATH,
  PUBLIC_MAINNET_CANDIDATES,
  REQUEST_TIMEOUT_MS,
  RESPONSE_MAX_BYTES,
  SAFE_CODES,
  SCHEMA,
  SYSVAR_OWNER,
  SafeError,
  assertBuiltArtifact,
  buildArtifact,
  canonicalUtcFromSeconds,
  collectCapability,
  httpsJsonTransport,
  isCanonicalBase64,
  preflightOutput,
  rpcCall,
  run,
  serializeArtifact,
  validateInvocation,
  validateRpcEnvelope,
  writeArtifactNoOverwrite,
};
