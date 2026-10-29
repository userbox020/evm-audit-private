'use strict';

const assert = require('assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { spawnSync } = require('child_process');
const test = require('node:test');

const runnerPath = path.resolve(__dirname, '..', 'solana-readonly-capability-probe.js');
const validatorPath = path.resolve(__dirname, '..', 'validate-solana-readonly-capability-probe.js');
const runner = require(runnerPath);
const validator = require(validatorPath);

let assertionCount = 0;
const a = {
  equal(actual, expected, message) {
    assertionCount += 1;
    assert.equal(actual, expected, message);
  },
  deepEqual(actual, expected, message) {
    assertionCount += 1;
    assert.deepEqual(actual, expected, message);
  },
  ok(value, message) {
    assertionCount += 1;
    assert.ok(value, message);
  },
  match(value, pattern, message) {
    assertionCount += 1;
    assert.match(value, pattern, message);
  },
  doesNotMatch(value, pattern, message) {
    assertionCount += 1;
    assert.doesNotMatch(value, pattern, message);
  },
};

async function rejectsCode(operation, code) {
  assertionCount += 1;
  await assert.rejects(operation, (error) => error && error.code === code);
}

function throwsCode(operation, code) {
  assertionCount += 1;
  assert.throws(operation, (error) => error && error.code === code);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function tempWorkspace() {
  const approvedTemp = path.join(os.tmpdir(), 'opencode');
  fs.mkdirSync(approvedTemp, { recursive: true });
  const root = fs.mkdtempSync(path.join(approvedTemp, 'solana-capability-'));
  const parent = path.join(root, 'reports', 'raw', 'fast', 'solana-readonly-capability-restoration');
  fs.mkdirSync(parent, { recursive: true });
  return { root, parent, output: path.join(root, runner.OUTPUT_RELATIVE_PATH) };
}

function goodAccount(anchor = 123, contextSlot = 124) {
  return {
    context: { slot: contextSlot },
    value: {
      data: [Buffer.alloc(40, 7).toString('base64'), 'base64'],
      executable: false,
      lamports: 1169280,
      owner: runner.SYSVAR_OWNER,
      rentEpoch: 0,
      space: 40,
    },
  };
}

function makeRpcTransport(overrides = {}) {
  const calls = [];
  const transport = async ({ endpoint, payload }) => {
    calls.push({ endpoint, payload: clone(payload) });
    if (overrides.throwAt === payload.method) throw new runner.SafeError(overrides.throwCode || 'NETWORK');
    let result;
    if (payload.method === 'getGenesisHash') result = runner.MAINNET_GENESIS;
    if (payload.method === 'getSlot') result = 123;
    if (payload.method === 'getBlockTime') result = 1700000000;
    if (payload.method === 'getAccountInfo') result = goodAccount();
    if (Object.prototype.hasOwnProperty.call(overrides, payload.method)) result = overrides[payload.method];
    return { jsonrpc: '2.0', id: payload.id, result };
  };
  return { transport, calls };
}

function fakeRequestScenario({
  statusCode = 200,
  headers = { 'content-type': 'application/json' },
  body = '{"jsonrpc":"2.0","id":1,"result":"ok"}',
  chunks,
  timeout = false,
}) {
  return (options, callback) => {
    const request = new EventEmitter();
    request.setTimeout = (milliseconds, handler) => {
      request.timeoutMilliseconds = milliseconds;
      if (timeout) queueMicrotask(handler);
    };
    request.destroy = () => {};
    request.end = () => {
      request.options = options;
      if (timeout) return;
      const response = Readable.from(chunks || [Buffer.from(body, 'utf8')]);
      response.statusCode = statusCode;
      response.headers = headers;
      callback(response);
    };
    return request;
  };
}

function goodArtifact() {
  return runner.buildArtifact({
    anchor: 123,
    blockTime: 1700000000,
    blockTimeUtc: new Date(1700000000 * 1000).toISOString(),
    contextSlot: 124,
  });
}

test('exact success writes one deterministic capability-only artifact', async () => {
  const temp = tempWorkspace();
  const { transport, calls } = makeRpcTransport();
  try {
    const result = await runner.run({
      argv: [],
      execArgv: [],
      env: { NO_PROXY: 'localhost' },
      workspaceRoot: temp.root,
      transport,
    });
    a.equal(result.outputRelativePath, runner.OUTPUT_RELATIVE_PATH);
    a.equal(fs.existsSync(temp.output), true);
    const text = fs.readFileSync(temp.output, 'utf8');
    const artifact = validator.validateSerializedArtifact(text);
    a.equal(artifact.schema, 'solana-readonly-capability-v1');
    a.equal(artifact.status, 'PASS');
    a.equal(artifact.genesis.expected, runner.MAINNET_GENESIS);
    a.equal(artifact.genesis.verified, runner.MAINNET_GENESIS);
    a.equal(artifact.finalized.slot, 123);
    a.equal(artifact.clock.contextSlot, 124);
    a.equal(artifact.clock.minContextSlotSatisfied, true);
    a.deepEqual(artifact.calls.methods, [...runner.METHOD_SEQUENCE]);
    a.equal(artifact.calls.successful, 4);
    a.equal(artifact.calls.retries, 0);
    a.deepEqual(artifact.nonClaims, ['CAPABILITY_ONLY_NO_TARGET_BINDING']);
    a.equal(calls.length, 4);
    a.equal(text, `${JSON.stringify(artifact, null, 2)}\n`);
  } finally {
    fs.rmSync(temp.root, { recursive: true, force: true });
  }
});

test('full genesis is required and truncated or wrong genesis is rejected', async (t) => {
  a.equal(runner.MAINNET_GENESIS, '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');
  await t.test('truncated regression', async () => {
    const { transport } = makeRpcTransport({
      getGenesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    });
    await rejectsCode(() => runner.collectCapability({ transport }), 'GENESIS_MISMATCH');
  });
  await t.test('wrong value', async () => {
    const { transport } = makeRpcTransport({ getGenesisHash: 'not-mainnet' });
    await rejectsCode(() => runner.collectCapability({ transport }), 'GENESIS_MISMATCH');
  });
});

test('method order and exact parameters are fixed', async () => {
  const { transport, calls } = makeRpcTransport();
  await runner.collectCapability({ transport });
  a.deepEqual(calls.map((entry) => entry.payload.method), [...runner.METHOD_SEQUENCE]);
  a.deepEqual(calls.map((entry) => entry.payload.id), [1, 2, 3, 4]);
  a.deepEqual(calls[0].payload.params, []);
  a.deepEqual(calls[1].payload.params, [{ commitment: 'finalized' }]);
  a.deepEqual(calls[2].payload.params, [123]);
  a.deepEqual(calls[3].payload.params, [
    runner.CLOCK_SYSVAR,
    { encoding: 'base64', commitment: 'finalized', minContextSlot: 123 },
  ]);
  a.equal(calls.every((entry) => entry.endpoint === runner.PUBLIC_MAINNET_CANDIDATES[0]), true);
});

test('Clock account owner executable context null and base64 failures are closed', async (t) => {
  const cases = [
    ['null account', { context: { slot: 124 }, value: null }, 'ACCOUNT_MISSING'],
    ['wrong owner', { ...goodAccount(), value: { ...goodAccount().value, owner: 'wrong' } }, 'ACCOUNT_OWNER_INVALID'],
    ['executable', { ...goodAccount(), value: { ...goodAccount().value, executable: true } }, 'ACCOUNT_EXECUTABLE_INVALID'],
    ['context below anchor', goodAccount(123, 122), 'ACCOUNT_CONTEXT_INVALID'],
    ['missing context', { value: goodAccount().value }, 'ACCOUNT_CONTEXT_INVALID'],
    ['noncanonical base64', { ...goodAccount(), value: { ...goodAccount().value, data: ['Zg', 'base64'] } }, 'ACCOUNT_DATA_INVALID'],
    ['wrong encoding', { ...goodAccount(), value: { ...goodAccount().value, data: ['00', 'base58'] } }, 'ACCOUNT_DATA_INVALID'],
  ];
  for (const [name, account, code] of cases) {
    await t.test(name, async () => {
      const { transport } = makeRpcTransport({ getAccountInfo: account });
      await rejectsCode(() => runner.collectCapability({ transport }), code);
    });
  }
});

test('slot and block time enforce safe nonnegative integer bounds', async (t) => {
  const cases = [
    ['negative slot', { getSlot: -1 }, 'SLOT_INVALID'],
    ['fractional slot', { getSlot: 1.5 }, 'SLOT_INVALID'],
    ['unsafe slot', { getSlot: Number.MAX_SAFE_INTEGER + 1 }, 'SLOT_INVALID'],
    ['null time', { getBlockTime: null }, 'BLOCK_TIME_INVALID'],
    ['fractional time', { getBlockTime: 1.5 }, 'BLOCK_TIME_INVALID'],
    ['negative time', { getBlockTime: -1 }, 'BLOCK_TIME_INVALID'],
    ['overflow time', { getBlockTime: Number.MAX_SAFE_INTEGER }, 'BLOCK_TIME_INVALID'],
  ];
  for (const [name, overrides, code] of cases) {
    await t.test(name, async () => {
      const { transport } = makeRpcTransport(overrides);
      await rejectsCode(() => runner.collectCapability({ transport }), code);
    });
  }
});

test('JSON-RPC envelope requires object version exact id no error and result', () => {
  throwsCode(() => runner.validateRpcEnvelope(null, 1), 'RPC_RESPONSE_NOT_OBJECT');
  throwsCode(() => runner.validateRpcEnvelope([], 1), 'RPC_RESPONSE_NOT_OBJECT');
  throwsCode(() => runner.validateRpcEnvelope({ jsonrpc: '1.0', id: 1, result: true }, 1), 'RPC_VERSION_INVALID');
  throwsCode(() => runner.validateRpcEnvelope({ jsonrpc: '2.0', id: '1', result: true }, 1), 'RPC_ID_MISMATCH');
  throwsCode(() => runner.validateRpcEnvelope({ jsonrpc: '2.0', id: 1, error: null }, 1), 'RPC_ERROR');
  throwsCode(() => runner.validateRpcEnvelope({ jsonrpc: '2.0', id: 1 }, 1), 'RPC_RESULT_MISSING');
  a.equal(runner.validateRpcEnvelope({ jsonrpc: '2.0', id: 1, result: 0 }, 1), 0);
});

test('HTTPS transport enforces timeout redirects status content metadata and caps', async (t) => {
  const invoke = (scenario) => runner.httpsJsonTransport({
    endpoint: runner.PUBLIC_MAINNET_CANDIDATES[0],
    payload: { jsonrpc: '2.0', id: 1, method: 'getGenesisHash', params: [] },
    requestImpl: fakeRequestScenario(scenario),
  });
  await t.test('timeout', () => rejectsCode(() => invoke({ timeout: true }), 'TIMEOUT'));
  await t.test('redirect', () => rejectsCode(() => invoke({ statusCode: 302 }), 'REDIRECT'));
  await t.test('status', () => rejectsCode(() => invoke({ statusCode: 503 }), 'HTTP_STATUS'));
  await t.test('content type', () => rejectsCode(() => invoke({ headers: { 'content-type': 'text/plain' } }), 'CONTENT_TYPE'));
  await t.test('content encoding', () => rejectsCode(() => invoke({ headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } }), 'CONTENT_ENCODING'));
  await t.test('declared length', () => rejectsCode(() => invoke({ headers: { 'content-type': 'application/json', 'content-length': String(runner.RESPONSE_MAX_BYTES + 1) } }), 'CONTENT_LENGTH'));
  await t.test('malformed length', () => rejectsCode(() => invoke({ headers: { 'content-type': 'application/json', 'content-length': '1.5' } }), 'CONTENT_LENGTH'));
  await t.test('stream cap', () => rejectsCode(() => invoke({ chunks: [Buffer.alloc(runner.RESPONSE_MAX_BYTES), Buffer.alloc(1)] }), 'RESPONSE_TOO_LARGE'));
  await t.test('invalid json', () => rejectsCode(() => invoke({ body: '{' }), 'JSON_INVALID'));
  const parsed = await invoke({});
  a.deepEqual(parsed, { jsonrpc: '2.0', id: 1, result: 'ok' });
});

test('HTTPS request is fixed POST with bounded timeout and Retry-After is never retried', async () => {
  let observedOptions;
  let observedTimeout;
  let requestCount = 0;
  const requestImpl = (options, callback) => {
    requestCount += 1;
    observedOptions = options;
    const request = new EventEmitter();
    request.on = EventEmitter.prototype.on.bind(request);
    request.setTimeout = (milliseconds) => { observedTimeout = milliseconds; };
    request.destroy = () => {};
    request.end = () => {
      const response = Readable.from([Buffer.from('{}')]);
      response.statusCode = 429;
      response.headers = { 'content-type': 'application/json', 'retry-after': '120' };
      callback(response);
    };
    return request;
  };
  await rejectsCode(() => runner.httpsJsonTransport({
    endpoint: runner.PUBLIC_MAINNET_CANDIDATES[0],
    payload: { jsonrpc: '2.0', id: 1, method: 'getGenesisHash', params: [] },
    requestImpl,
  }), 'HTTP_STATUS');
  a.equal(requestCount, 1);
  a.equal(observedOptions.protocol, 'https:');
  a.equal(observedOptions.method, 'POST');
  a.equal(observedOptions.hostname, 'api.mainnet-beta.solana.com');
  a.equal(observedOptions.path, '/');
  a.equal(observedOptions.agent, false);
  a.equal(observedOptions.headers.accept, 'application/json');
  a.equal(observedOptions.headers['content-type'], 'application/json');
  a.ok(Number.isSafeInteger(observedOptions.headers['content-length']));
  a.equal(observedTimeout, 20_000);
});

test('no retry occurs and one-candidate design stays bounded', async () => {
  let calls = 0;
  const transport = async () => {
    calls += 1;
    throw new runner.SafeError('NETWORK');
  };
  await rejectsCode(() => runner.collectCapability({ transport }), 'NETWORK');
  a.equal(calls, 1);
  a.equal(runner.PUBLIC_MAINNET_CANDIDATES.length, 1);
  a.equal(runner.PUBLIC_MAINNET_CANDIDATES[0], 'https://api.mainnet-beta.solana.com');
});

test('CLI args execArgv and active environment controls are rejected', () => {
  throwsCode(() => runner.validateInvocation({ argv: ['x'], execArgv: [], env: {} }), 'ARGS_FORBIDDEN');
  throwsCode(() => runner.validateInvocation({ argv: [], execArgv: ['--inspect'], env: {} }), 'EXEC_ARGV_FORBIDDEN');
  runner.validateInvocation({ argv: [], execArgv: [], env: { NO_PROXY: 'localhost', PATH: 'x' } });
  assertionCount += 1;
  for (const name of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'no_proxy',
    'NODE_OPTIONS',
    'NODE_DEBUG',
    'SSLKEYLOGFILE',
    'NODE_TLS_REJECT_UNAUTHORIZED',
    'NODE_EXTRA_CA_CERTS',
    'USE_ENV_PROXY',
    'PREFIXED_DEBUG_CONTROL',
    'CUSTOM_TLS_SETTING',
    'CUSTOM_SSL_SETTING',
    'PREFIXED_SOLANA_ENDPOINT',
    'MY_SOLANA_RPC_URL',
    'PREFIX_RPC_SUFFIX',
    'PREFIXED_ENDPOINT_SUFFIX',
    'PREFIX_RPC_ENDPOINT_SUFFIX',
  ]) {
    throwsCode(() => runner.validateInvocation({ argv: [], execArgv: [], env: { [name]: 'active' } }), 'ENV_FORBIDDEN');
  }
  runner.validateInvocation({ argv: [], execArgv: [], env: { HTTP_PROXY: '', NODE_OPTIONS: '' } });
  assertionCount += 1;
});

test('preflight is before transport and rejects missing parent and existing output', async () => {
  const temp = tempWorkspace();
  let calls = 0;
  const transport = async () => {
    calls += 1;
    throw new Error('must not run');
  };
  try {
    fs.rmSync(temp.parent, { recursive: true, force: true });
    await rejectsCode(() => runner.run({ argv: [], execArgv: [], env: {}, workspaceRoot: temp.root, transport }), 'OUTPUT_PARENT_MISSING');
    a.equal(calls, 0);
    fs.mkdirSync(temp.parent, { recursive: true });
    fs.writeFileSync(temp.output, 'protected', 'utf8');
    await rejectsCode(() => runner.run({ argv: [], execArgv: [], env: {}, workspaceRoot: temp.root, transport }), 'OUTPUT_EXISTS');
    a.equal(calls, 0);
    a.equal(fs.readFileSync(temp.output, 'utf8'), 'protected');
  } finally {
    fs.rmSync(temp.root, { recursive: true, force: true });
  }
});

test('transport failure after preflight leaves no artifact and no partial evidence', async () => {
  const temp = tempWorkspace();
  let calls = 0;
  try {
    await rejectsCode(() => runner.run({
      argv: [],
      execArgv: [],
      env: {},
      workspaceRoot: temp.root,
      transport: async () => {
        calls += 1;
        throw new runner.SafeError('NETWORK');
      },
    }), 'NETWORK');
    a.equal(calls, 1);
    a.equal(fs.existsSync(temp.output), false);
    a.deepEqual(fs.readdirSync(temp.parent), []);
  } finally {
    fs.rmSync(temp.root, { recursive: true, force: true });
  }
});

test('preflight rejects escape and atomic strategy failures cleanly', () => {
  const temp = tempWorkspace();
  try {
    throwsCode(() => runner.preflightOutput({ workspaceRoot: temp.root, outputRelativePath: '..\\outside.json' }), 'OUTPUT_OUTSIDE_WORKSPACE');
    const fsOps = Object.create(fs);
    fsOps.linkSync = () => {
      const error = new Error('blocked');
      error.code = 'EPERM';
      throw error;
    };
    throwsCode(() => runner.preflightOutput({ workspaceRoot: temp.root, fsOps }), 'PREFLIGHT_ATOMIC_UNAVAILABLE');
    const leftovers = fs.readdirSync(temp.parent).filter((name) => name.includes('preflight'));
    a.deepEqual(leftovers, []);
  } finally {
    fs.rmSync(temp.root, { recursive: true, force: true });
  }
});

test('atomic writer never overwrites and cleans failed temp files', () => {
  const temp = tempWorkspace();
  try {
    fs.writeFileSync(temp.output, 'protected', 'utf8');
    throwsCode(() => runner.writeArtifactNoOverwrite({ outputPath: temp.output, text: '{}\n' }), 'OUTPUT_EXISTS');
    a.equal(fs.readFileSync(temp.output, 'utf8'), 'protected');
    const leftovers = fs.readdirSync(temp.parent).filter((name) => name.includes('.write.'));
    a.deepEqual(leftovers, []);
  } finally {
    fs.rmSync(temp.root, { recursive: true, force: true });
  }
});

test('artifact contains no remote identity raw account or transport leakage', () => {
  const text = runner.serializeArtifact(goodArtifact());
  const artifact = JSON.parse(text);
  a.doesNotMatch(text, /https?:\/\//i);
  a.doesNotMatch(text, /api\.mainnet|\.solana\.com/i);
  a.doesNotMatch(text, /provider|hostname|domain|candidateIndex|candidateCount/i);
  a.doesNotMatch(text, /1169280|BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBw==/i);
  a.doesNotMatch(text, /rawError|rawResponse|responseHeaders/i);
  a.match(text, /CAPABILITY_ONLY_NO_TARGET_BINDING/);
  a.equal(artifact.safety.accountDataPersisted, false);
  a.equal(artifact.safety.lamportsPersisted, false);
  a.equal(artifact.safety.rentEpochPersisted, false);
  a.equal(artifact.safety.spacePersisted, false);
  a.equal(validator.validateSerializedArtifact(text).status, 'PASS');
});

test('standalone validator rejects structural semantic and leakage tampering', async (t) => {
  const cases = [
    ['truncated genesis', (x) => { x.genesis.expected = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'; }, 'ARTIFACT_GENESIS'],
    ['wrong status', (x) => { x.status = 'FAIL'; }, 'ARTIFACT_SCHEMA'],
    ['slot type', (x) => { x.finalized.slot = '123'; }, 'ARTIFACT_FINALIZED'],
    ['utc mismatch', (x) => { x.finalized.blockTimeUtc = '2020-01-01T00:00:00.000Z'; }, 'ARTIFACT_FINALIZED'],
    ['context below', (x) => { x.clock.contextSlot = 122; }, 'ARTIFACT_CLOCK'],
    ['method order', (x) => { x.calls.methods.reverse(); }, 'ARTIFACT_CALLS'],
    ['retry', (x) => { x.calls.retries = 1; }, 'ARTIFACT_CALLS'],
    ['safety', (x) => { x.safety.inventoryRead = true; }, 'ARTIFACT_SAFETY'],
    ['nonclaim', (x) => { x.nonClaims[0] = 'target-bound'; }, 'ARTIFACT_NONCLAIMS'],
    ['forbidden key', (x) => { x.safety.providerName = 'public'; }, 'ARTIFACT_FORBIDDEN'],
    ['forbidden value', (x) => { x.note = 'https://example.invalid'; }, 'ARTIFACT_FORBIDDEN'],
  ];
  for (const [name, mutate, code] of cases) {
    await t.test(name, () => {
      const artifact = clone(goodArtifact());
      mutate(artifact);
      throwsCode(() => validator.validateArtifact(artifact), code);
    });
  }
  throwsCode(() => validator.validateSerializedArtifact('x'.repeat(validator.ARTIFACT_MAX_BYTES + 1)), 'ARTIFACT_TOO_LARGE');
  throwsCode(() => validator.validateSerializedArtifact(JSON.stringify(goodArtifact())), 'ARTIFACT_ENCODING');
});

test('source inspection excludes inventories forbidden methods target IDs and command execution', () => {
  const production = `${fs.readFileSync(runnerPath, 'utf8')}\n${fs.readFileSync(validatorPath, 'utf8')}`;
  for (const inventoryName of [
    'rpc_endpoints.txt',
    'graphql_endpoints.txt',
    'base_full_stack_endpoints.md',
    'hyperevm_archive_endpoints.md',
  ]) {
    a.equal(production.includes(inventoryName), false);
  }
  for (const forbiddenMethod of [
    'getProgramAccounts',
    'getProgramData',
    'getBlock',
    'getLogs',
    'getBalance',
    'getTokenAccountsByOwner',
    'getSignaturesForAddress',
    'getTransaction',
    'simulateTransaction',
    'sendTransaction',
  ]) {
    a.equal(production.includes(`'${forbiddenMethod}'`), false);
    a.equal(production.includes(`"${forbiddenMethod}"`), false);
  }
  a.doesNotMatch(production, /require\(['"]child_process['"]\)|\bspawn(?:Sync)?\s*\(|\bexec(?:File|Sync)?\s*\(/);
  a.doesNotMatch(production, /\bwsl(?:\.exe)?\b|solana\s+(?:account|program|config|cluster)/i);
  for (const targetId of [
    'KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd',
    'dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH',
  ]) {
    a.equal(production.includes(targetId), false);
  }
  const base58Literals = [...production.matchAll(/['"]([1-9A-HJ-NP-Za-km-z]{32,50})['"]/g)].map((match) => match[1]);
  const allowed = new Set([runner.MAINNET_GENESIS, runner.CLOCK_SYSVAR, runner.SYSVAR_OWNER]);
  a.equal(base58Literals.every((value) => allowed.has(value)), true);
});

test('standalone validator and runner child CLIs stay fixed-path and offline on rejection', () => {
  const liveArtifact = path.resolve(__dirname, '..', '..', runner.OUTPUT_RELATIVE_PATH);
  a.equal(fs.existsSync(liveArtifact), false);

  const validatorWithArg = spawnSync(process.execPath, [validatorPath, 'arbitrary-fixture.json'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  a.equal(validatorWithArg.status, 1);
  a.equal(validatorWithArg.stdout, '');
  a.equal(validatorWithArg.stderr, 'VALIDATION_FAILED_ARGS_FORBIDDEN\n');

  const validatorFixed = spawnSync(process.execPath, [validatorPath], {
    encoding: 'utf8',
    windowsHide: true,
  });
  a.equal(validatorFixed.status, 1);
  a.equal(validatorFixed.stdout, '');
  a.equal(validatorFixed.stderr, 'VALIDATION_FAILED_ARTIFACT_MISSING\n');

  const runnerWithArg = spawnSync(process.execPath, [runnerPath, 'forbidden'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  a.equal(runnerWithArg.status, 1);
  a.equal(runnerWithArg.stdout, '');
  a.equal(runnerWithArg.stderr, 'CAPABILITY_FAILED_ARGS_FORBIDDEN\n');
  a.equal(fs.existsSync(liveArtifact), false);
});

test.after(() => {
  process.stdout.write(`ASSERTIONS ${assertionCount}\n`);
});
