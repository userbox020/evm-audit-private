#!/usr/bin/env node
"use strict";

const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  childProcess = require("node:child_process");
const diagnostic = require("./diagnose-morpho-pt-27aug2026-post-expiry-r1-candidates.js");

const EXPIRY = 1787788800,
  WALL_MS = 120000,
  NOW = (EXPIRY + 120) * 1000,
  IP = "93.184.216.34",
  word = (value) => BigInt(value).toString(16).padStart(64, "0"),
  hash = (value) => `0x${word(value)}`,
  codedError = (code) => Object.assign(new Error(code), { code }),
  header = (value) => ({
    number: `0x${value.toString(16)}`,
    hash: hash(value),
    parentHash: hash(value - 1),
    stateRoot: hash(value + 1000),
    timestamp: `0x${Math.floor(NOW / 1000).toString(16)}`,
  });

function inventory(count = 4) {
  return Buffer.from(
    Array.from(
      { length: count },
      (_, index) =>
        `[EVM chain=1 mainnet role=RPC premium capabilityRank=${100 - index} family=synthetic-${index}]\nhttps://rpc-${index}.invalid/private-${index}?key=secret-${index}`,
    ).join("\n") + "\n",
  );
}

function candidateIndex(config) {
  const match = config.hostname.match(/^rpc-(\d+)\.invalid$/u);
  assert.ok(match);
  return Number(match[1]);
}

function validResult(method) {
  if (method === "eth_chainId") return "0x1";
  if (method === "eth_getBlockByNumber") return header(100);
  if (method === "eth_getCode") return "0x6001";
  if (method === "eth_call") return `0x${word(EXPIRY)}`;
  assert.fail("unexpected method");
}

function response(config, result = validResult(JSON.parse(config.body).method)) {
  const request = JSON.parse(config.body);
  const body = Buffer.from(
    JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
  );
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body,
    redirected: false,
    remoteAddress: IP,
    tlsVersion: "TLSv1.3",
    elapsedMs: 1,
    counters: {
      dns: 0,
      socket: 1,
      connect: 1,
      tls: 1,
      data: 1,
      requestDestroyed: 1,
      socketDestroyed: 1,
      agentDestroyed: 1,
    },
  };
}

function harness(httpPost, overrides = {}) {
  return diagnostic.runSyntheticTestOnly({
    inventoryBytes: overrides.inventoryBytes || inventory(),
    resolve: overrides.resolve || (async () => [IP]),
    httpPost,
    clock: overrides.clock || (() => NOW),
  });
}

function authorityFixture({ mutatedRole = null, metadata = {} } = {}) {
  const root = path.resolve(__dirname),
    scriptPath = path.resolve(root, diagnostic.BASENAME),
    mountPoint = root.replace(/\\/gu, "/"),
    files = new Map(
      diagnostic.PINNED_FILES.map((entry) => [
        path.resolve(root, entry.relative),
        fs.readFileSync(path.resolve(root, entry.relative)),
      ]),
    ),
    rolePaths = Object.fromEntries(
      diagnostic.PINNED_FILES.map((entry) => [
        entry.role,
        path.resolve(root, entry.relative),
      ]),
    ),
    mutatedPath = mutatedRole ? rolePaths[mutatedRole] : null,
    stat = (filename) => {
      const selected = filename === scriptPath ? metadata.script : metadata[filename];
      return {
        isFile: () => selected?.file !== false,
        isSymbolicLink: () => selected?.symlink === true,
        uid: selected?.uid ?? 1000,
        nlink: selected?.nlink ?? 1,
        mode: selected?.mode ?? 0o100600,
        dev: selected?.dev ?? 7n,
      };
    },
    realpath = (filename) => metadata[filename]?.real || filename,
    ops = {
      lstatSync(filename) {
        if (filename !== scriptPath && !files.has(filename)) throw new Error("FILE");
        return stat(filename);
      },
      realpathSync: Object.assign(() => {
        throw new Error("NATIVE_ONLY");
      }, { native: realpath }),
      readFileSync(filename, encoding) {
        if (filename === "/proc/self/mountinfo") {
          const value = `41 30 0:42 / ${mountPoint} rw,relatime - ext4 /dev/test rw\n`;
          return encoding ? value : Buffer.from(value);
        }
        const bytes = files.get(filename);
        if (!bytes) throw new Error("FILE");
        const value =
          filename === mutatedPath ? Buffer.concat([bytes, Buffer.from("\nMUTATED")]) : bytes;
        return encoding ? value.toString(encoding) : Buffer.from(value);
      },
      statfsSync() {
        return { type: 0xef53n };
      },
    };
  return { root, scriptPath, rolePaths, ops };
}

function inventoryAuthorityFixture(mutation = null) {
  const filename = diagnostic.INVENTORY_WINDOWS_PATH,
    procRoot = "C:\\proc\\self\\fd",
    procPath = path.join(procRoot, "17"),
    source = inventory(),
    events = [];
  let cursor = 0,
    fstats = 0,
    lstats = 0,
    flags = null;
  const fileSize =
      mutation === "oversize" ? diagnostic.INVENTORY_MAX_BYTES + 1 : source.length,
    stat = (stage, held) => ({
      isFile: () =>
        !(
          mutation === "path-type" && !held && stage === 0 ||
          mutation === "held-type" && held && stage === 0
        ),
      isSymbolicLink: () => mutation === "symlink" && !held,
      nlink: mutation === "nlink" ? 2 : 1,
      dev: 11n,
      ino:
        mutation === "held-post" && held && stage === 1 ||
        mutation === "path-post" && !held && stage === 1
          ? 23n
          : 22n,
      size: fileSize,
      mode: 0o100666,
      uid: 1000,
    }),
    ops = {
      constants: { ...fs.constants, O_NOFOLLOW: fs.constants.O_NOFOLLOW ?? 0x20000 },
      lstatSync(target) {
        assert.equal(target, filename);
        const stage = lstats++;
        events.push(stage === 0 ? "PATH_PRE" : "PATH_POST");
        return stat(stage, false);
      },
      realpathSync: Object.assign(() => {
        throw new Error("NATIVE_ONLY");
      }, {
        native(target) {
          events.push(target === filename ? "REAL_PATH" : "REAL_FD");
          if (target === filename)
            return mutation === "canonical" ? `${filename}.other` : filename;
          assert.equal(target, procPath);
          return mutation === "held-canonical" ? `${filename}.other` : filename;
        },
      }),
      openSync(target, value) {
        events.push("OPEN");
        assert.equal(target, filename);
        flags = value;
        if (mutation === "open") throw new Error("OPEN");
        return 17;
      },
      fstatSync(fd) {
        assert.equal(fd, 17);
        const stage = fstats++;
        events.push(stage === 0 ? "HELD_PRE" : "HELD_POST");
        return stat(stage, true);
      },
      readSync(fd, buffer, offset, length) {
        assert.equal(fd, 17);
        if (mutation === "short" && cursor === 0) return 0;
        if (cursor < source.length) {
          const count = Math.min(length, source.length - cursor);
          source.copy(buffer, offset, cursor, cursor + count);
          cursor += count;
          events.push("READ");
          return count;
        }
        events.push("EOF");
        if (mutation === "extra") {
          buffer[offset] = 1;
          return 1;
        }
        return 0;
      },
      closeSync(fd) {
        assert.equal(fd, 17);
        events.push("CLOSE");
        if (mutation === "close") throw new Error("CLOSE");
      },
    };
  return { filename, procPath: procRoot, source, events, ops, get flags() { return flags; } };
}

test("module load executes built-ins only", () => {
  for (const entry of diagnostic.PINNED_FILES) {
    const filename = path.resolve(__dirname, entry.relative);
    assert.equal(require.cache[filename], undefined, entry.role);
  }
  assert.equal(diagnostic.PINNED_FILES.length, 9);
  assert.ok(
    diagnostic.PINNED_FILES.every(
      (entry) => path.basename(entry.relative) !== diagnostic.BASENAME,
    ),
  );
});

test("every transitive staged hash rejects before any local loader executes", () => {
  for (const entry of diagnostic.PINNED_FILES) {
    const fixture = authorityFixture({ mutatedRole: entry.role });
    let executions = 0;
    assert.throws(
      () =>
        diagnostic.loadReviewedModulesSyntheticTestOnly({
          ops: fixture.ops,
          root: fixture.root,
          scriptPath: fixture.scriptPath,
          platform: "linux",
          uid: 1000,
          loader: () => {
            executions++;
            throw new Error("LOCAL_EXECUTION");
          },
        }),
      { code: "FAIL_AUTHORITY" },
      entry.role,
    );
    assert.equal(executions, 0, entry.role);
  }
});

test("canonical file and native mount metadata fail before local execution", () => {
  const base = authorityFixture(),
    target = base.rolePaths[diagnostic.PINNED_FILES[0].role],
    mutations = [
      { [target]: { nlink: 2 } },
      { [target]: { mode: 0o100620 } },
      { [target]: { uid: 1001 } },
      { [target]: { dev: 8n } },
      { [target]: { symlink: true } },
      { [target]: { real: `${target}.other` } },
      { script: { nlink: 2 } },
    ];
  for (const metadata of mutations) {
    const fixture = authorityFixture({ metadata });
    let executions = 0;
    assert.throws(
      () =>
        diagnostic.loadReviewedModulesSyntheticTestOnly({
          ops: fixture.ops,
          root: fixture.root,
          scriptPath: fixture.scriptPath,
          platform: "linux",
          uid: 1000,
          loader: () => executions++,
        }),
      { code: "FAIL_AUTHORITY" },
    );
    assert.equal(executions, 0);
  }
});

test("real WSL authority and held inventory selection pass without DNS or RPC", (t) => {
  const probe = childProcess.spawnSync(
    "wsl.exe",
    ["sh", "-lc", `test -d ${path.posix.dirname(diagnostic.FIXED_DIAGNOSTIC_PATH)} && test -x ${diagnostic.STAGED_NODE}`],
    { windowsHide: true, encoding: "utf8" },
  );
  if (probe.error || probe.status !== 0) {
    t.skip("WSL staged package unavailable");
    return;
  }
  const absent = childProcess.spawnSync(
    "wsl.exe",
    ["sh", "-lc", `test ! -e ${diagnostic.FIXED_DIAGNOSTIC_PATH}`],
    { windowsHide: true, encoding: "utf8" },
  );
  assert.equal(absent.status, 0, "temporary target must start absent");
  const source = path
      .resolve(__dirname, diagnostic.BASENAME)
      .replace(/^([A-Za-z]):/u, (_, drive) => `/mnt/${drive.toLowerCase()}`)
      .replace(/\\/gu, "/"),
    install = childProcess.spawnSync(
      "wsl.exe",
      ["sh", "-lc", `install -m 600 ${source} ${diagnostic.FIXED_DIAGNOSTIC_PATH}`],
      { windowsHide: true, encoding: "utf8" },
    );
  assert.equal(install.status, 0);
  try {
    const helper = `"use strict";try{require(${JSON.stringify(diagnostic.FIXED_DIAGNOSTIC_PATH)}).validateActualInventoryAuthorityOnly();process.stdout.write("AUTHORITY_PASS")}catch(_){process.stdout.write("AUTHORITY_FAIL");process.exitCode=2}`,
      result = childProcess.spawnSync(
        "wsl.exe",
        ["--exec", diagnostic.STAGED_NODE, "-e", helper],
        { windowsHide: true, encoding: "utf8" },
      );
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "AUTHORITY_PASS");
    assert.equal(result.stderr, "");
  } finally {
    const remove = childProcess.spawnSync(
      "wsl.exe",
      ["sh", "-lc", `rm -f ${diagnostic.FIXED_DIAGNOSTIC_PATH} && test ! -e ${diagnostic.FIXED_DIAGNOSTIC_PATH}`],
      { windowsHide: true, encoding: "utf8" },
    );
    assert.equal(remove.status, 0);
  }
});

test("held inventory read reaches parser only after exact EOF and stable identity", () => {
  const fixture = inventoryAuthorityFixture();
  let retained;
  const result = diagnostic.validateInventorySelectionSyntheticTestOnly({
    ops: fixture.ops,
    filename: fixture.filename,
    maxBytes: diagnostic.INVENTORY_MAX_BYTES,
    procRoot: fixture.procPath,
    parseInventory(bytes) {
      fixture.events.push("PARSE");
      retained = bytes;
      assert.ok(fixture.events.indexOf("PARSE") > fixture.events.indexOf("EOF"));
      assert.ok(fixture.events.indexOf("PARSE") > fixture.events.indexOf("CLOSE"));
      return ["ROWS"];
    },
    selectCandidates(rows) {
      fixture.events.push("SELECT");
      assert.deepEqual(rows, ["ROWS"]);
      return [{}, {}, {}, {}];
    },
  });
  assert.equal(result, true);
  assert.equal(
    fixture.flags,
    fixture.ops.constants.O_RDONLY | fixture.ops.constants.O_NOFOLLOW,
  );
  assert.ok(retained.every((byte) => byte === 0));
});

test("inventory authority mutations reject before parser selection", () => {
  for (const mutation of [
    "canonical",
    "held-canonical",
    "path-type",
    "held-type",
    "symlink",
    "nlink",
    "oversize",
    "short",
    "extra",
    "held-post",
    "path-post",
    "open",
    "close",
  ]) {
    const fixture = inventoryAuthorityFixture(mutation);
    let parsed = 0,
      selected = 0;
    assert.throws(
      () =>
        diagnostic.validateInventorySelectionSyntheticTestOnly({
          ops: fixture.ops,
          filename: fixture.filename,
          maxBytes: diagnostic.INVENTORY_MAX_BYTES,
          procRoot: fixture.procPath,
          parseInventory() {
            parsed++;
            return [];
          },
          selectCandidates() {
            selected++;
            return [];
          },
        }),
      { code: "FAIL_INVENTORY" },
      mutation,
    );
    assert.equal(parsed, 0, mutation);
    assert.equal(selected, 0, mutation);
  }
});

test("four candidates pass with the exact 16-request sequential schedule", async () => {
  let active = 0,
    maxActive = 0,
    calls = 0;
  const result = await harness(async (config) => {
    calls++;
    active++;
    maxActive = Math.max(maxActive, active);
    await Promise.resolve();
    active--;
    return response(config);
  });
  assert.equal(result.status, "PASS");
  assert.equal(result.slots.length, 4);
  assert.ok(result.slots.every((slot) => slot.outcome === "PASS"));
  assert.deepEqual(result.accounting, {
    requests: 16,
    responseBytes: result.accounting.responseBytes,
    maxConcurrency: 1,
    retries: 0,
  });
  assert.equal(calls, 16);
  assert.equal(maxActive, 1);
});

const steps = [
    ["CHAIN", "eth_chainId"],
    ["FINALIZED", "eth_getBlockByNumber"],
    ["CODE", "eth_getCode"],
    ["EXPIRY", "eth_call"],
  ],
  classes = ["HTTP", "ENVELOPE", "SEMANTIC"];

for (const [step, method] of steps)
  for (const classification of classes)
    test(`${step} ${classification} failure is classified and later candidates continue`, async () => {
      let failed = false;
      const result = await harness(async (config) => {
        const request = JSON.parse(config.body),
          index = candidateIndex(config);
        if (!failed && index === 0 && request.method === method) {
          failed = true;
          if (classification === "HTTP")
            throw codedError("HTTP_STATUS");
          if (classification === "ENVELOPE") {
            const invalid = response(config);
            invalid.body = Buffer.from("not-json");
            return invalid;
          }
          const bad =
            method === "eth_chainId"
              ? "0x2"
              : method === "eth_getBlockByNumber"
                ? null
                : method === "eth_getCode"
                  ? "0x"
                  : `0x${word(EXPIRY + 1)}`;
          return response(config, bad);
        }
        return response(config);
      });
      assert.equal(result.status, "FAIL");
      assert.deepEqual(result.slots[0], {
        candidateIndex: 0,
        outcome: "FAIL",
        step,
        class: classification,
      });
      assert.ok(result.slots.slice(1).every((slot) => slot.outcome === "PASS"));
    });

test("DNS failure is one sanitized global code with no candidate index", async () => {
  const result = await harness(
    async () => assert.fail("HTTP must not run"),
    {
      resolve: async () => {
        throw new Error("sensitive DNS detail");
      },
    },
  );
  assert.deepEqual(result, { status: "FAIL_DNS" });
  assert.doesNotMatch(JSON.stringify(result), /candidateIndex|sensitive/iu);
});

test("absolute deadline and response-contract invariants stop globally", async () => {
  let ticks = 0;
  const deadline = await harness(async () => assert.fail("HTTP must not run"), {
    clock: () => (ticks++ === 0 ? 0 : WALL_MS + 1),
  });
  assert.deepEqual(deadline, { status: "FAIL_DEADLINE" });

  let calls = 0;
  const contract = await harness(async () => {
    calls++;
    return {};
  });
  assert.deepEqual(contract, { status: "FAIL_RESPONSE_CONTRACT" });
  assert.equal(calls, 1);
});

test("socket multiplicity and diagnostic accounting invariants are global", async () => {
  const socket = await harness(async () => {
    throw codedError("HTTP_SOCKET_MULTIPLE");
  });
  assert.deepEqual(socket, { status: "FAIL_SOCKET_MULTIPLICITY" });

  const accounting = diagnostic.diagnosticAccounting();
  accounting.begin();
  assert.throws(() => accounting.begin(), { code: "FAIL_ACCOUNTING" });
});

test("selection uses the original first four with no fallback or replacement", async () => {
  const seen = new Set();
  const result = await harness(
    async (config) => {
      seen.add(candidateIndex(config));
      return response(config);
    },
    { inventoryBytes: inventory(5) },
  );
  assert.equal(result.status, "PASS");
  assert.deepEqual([...seen], [0, 1, 2, 3]);
  assert.equal(result.accounting.requests, diagnostic.MAX_REQUESTS);
});

test("synthetic mode performs no persistence and output is sanitized", async () => {
  const writes = [
      "writeFileSync",
      "appendFileSync",
      "mkdirSync",
      "renameSync",
      "linkSync",
      "openSync",
    ],
    originals = new Map();
  for (const name of writes) {
    originals.set(name, fs[name]);
    fs[name] = () => assert.fail(`persistence attempted: ${name}`);
  }
  let result;
  try {
    result = await harness(async (config) => response(config));
  } finally {
    for (const [name, fn] of originals) fs[name] = fn;
  }
  const serialized = JSON.stringify(result);
  assert.equal(result.status, "PASS");
  assert.doesNotMatch(serialized, /rpc-|invalid|private-|secret-|https?:|family|headers/iu);
});

test("actual invocation is exact, minimal, staged, and has no injection surface", () => {
  assert.deepEqual(diagnostic.EXTERNAL_INVOCATION_AUTHORITY, {
    schema: "morpho-pt-candidate-diagnostic-external-runner/v1",
    executable: diagnostic.STAGED_NODE,
    script: diagnostic.FIXED_DIAGNOSTIC_PATH,
    argv: [diagnostic.MODE],
    env: diagnostic.MINIMAL_ENV,
    sourceHashAuthority: {
      algorithm: "SHA-256",
      target: diagnostic.FIXED_DIAGNOSTIC_PATH,
      expected: "EXTERNAL_REVIEWED_SHA256_REQUIRED",
      timing: "IMMEDIATELY_BEFORE_STAGED_NODE_INVOCATION",
    },
    inventoryAuthority: {
      windowsPath: diagnostic.INVENTORY_WINDOWS_PATH,
      linuxPath: diagnostic.INVENTORY_LINUX_PATH,
      windowsDaclPrecheck: {
        protected: true,
        inheritanceDisabled: true,
        exactAllowedPrincipals: [
          "CURRENT_USER",
          "NT AUTHORITY\\SYSTEM",
          "BUILTIN\\Administrators",
        ],
        rejectUnexpectedAces: true,
      },
      linuxRead:
        "O_RDONLY|O_NOFOLLOW_HELD_FD_CANONICAL_EXACT_BOUNDED_READ_EOF_PRE_POST_IDENTITY",
      drvfsModeAuthority: false,
    },
    runnerOrder: [
      "VERIFY_EXTERNAL_SOURCE_SHA256",
      "VERIFY_PROTECTED_WINDOWS_INVENTORY_DACL",
      "INVOKE_FIXED_STAGED_NODE_SCRIPT_FLAG_WITH_MINIMAL_ENV",
    ],
  });
  const valid = {
    argv: [diagnostic.MODE],
    env: { ...diagnostic.MINIMAL_ENV },
    execArgv: [],
    execPath: diagnostic.STAGED_NODE,
    nodeVersion: diagnostic.STAGED_NODE_VERSION,
    platform: "linux",
    scriptPath: diagnostic.FIXED_DIAGNOSTIC_PATH,
  };
  assert.equal(diagnostic.validateActualInvocation(valid), true);
  for (const mutation of [
    { argv: [] },
    { argv: [diagnostic.MODE, "extra"] },
    { env: { ...valid.env, PATH: "/tmp" } },
    { execArgv: ["--inspect"] },
    { execPath: process.execPath },
    { platform: "win32" },
  ])
    assert.throws(
      () => diagnostic.validateActualInvocation({ ...valid, ...mutation }),
      diagnostic.DiagnosticError,
    );
  assert.throws(() => diagnostic.runActual({}), diagnostic.DiagnosticError);
});

test("main catches synchronous preflight failures as fixed stdout JSON", () => {
  const child = childProcess.spawnSync(
    process.execPath,
    [path.resolve(__dirname, diagnostic.BASENAME)],
    { env: {}, windowsHide: true, encoding: "utf8" },
  );
  assert.equal(child.status, 2);
  assert.equal(child.stdout, `${JSON.stringify({ status: "FAIL_INVOCATION" })}\n`);
  assert.equal(child.stderr, "");
  assert.doesNotMatch(child.stdout, /stack|at |\\|\//iu);
});

test("production capture neither imports nor invokes the diagnostic", () => {
  const capturePath = path.resolve(
      __dirname,
      "capture-morpho-pt-27aug2026-post-expiry-r1-production.js",
    ),
    diagnosticPath = path.resolve(
      __dirname,
      "diagnose-morpho-pt-27aug2026-post-expiry-r1-candidates.js",
    ),
    source = fs.readFileSync(capturePath, "utf8");
  assert.doesNotMatch(source, /diagnose-morpho|one-shot-read-only-diagnostic/u);
  const program = `require(${JSON.stringify(capturePath)});if(require.cache[${JSON.stringify(diagnosticPath)}])process.exit(9)`;
  const child = childProcess.spawnSync(process.execPath, ["-e", program], {
    env: {},
    windowsHide: true,
    encoding: "utf8",
  });
  assert.equal(child.status, 0);
  assert.equal(child.stdout, "");
  assert.equal(child.stderr, "");
});
