#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto"),
  fs = require("node:fs"),
  path = require("node:path");
let adapter, capture, r1, policy;

const MODE = "--one-shot-read-only-diagnostic-pool-4-7",
  BASENAME = "diagnose-morpho-pt-27aug2026-post-expiry-r2-pool-4-7.js",
  MAX_REQUESTS = 16,
  STAGED_ROOT = "/home/mruserbox/.local/share/evm-audit/morpho-pt-post-expiry-r1",
  STAGED_TOOLS = `${STAGED_ROOT}/tools`,
  STAGED_NODE = `${STAGED_ROOT}/runtime/bin/node`,
  STAGED_NODE_VERSION = "v24.13.0",
  FIXED_DIAGNOSTIC_PATH = `${STAGED_TOOLS}/${BASENAME}`,
  INVENTORY_LINUX_PATH = "/mnt/c/_Work/__EVM_AUDIT/rpc_endpoints.txt",
  INVENTORY_WINDOWS_PATH = "C:\\_Work\\__EVM_AUDIT\\rpc_endpoints.txt",
  INVENTORY_MAX_BYTES = 2097152,
  MINIMAL_ENV = Object.freeze({
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
  }),
  PINNED_FILES = Object.freeze([
    Object.freeze({
      role: "transport-capture",
      relative: "capture-morpho-pt-27aug2026-post-expiry-r1-production.js",
      sha256: "93eb16d6e5e442cea2d535f6fb6be4208bab5a95b6ad5d2a952b45de02b99e0b",
    }),
    Object.freeze({
      role: "morpho-gate",
      relative: "lib/morpho-pt-27aug2026-post-expiry-r1-gate.js",
      sha256: "7e3865668fcc2be10c2cf93d9ff3798dbcd59d207ec4a7a11e211372405d90f7",
    }),
    Object.freeze({
      role: "production-adapter",
      relative: "lib/morpho-pt-27aug2026-post-expiry-r1-production-adapter.js",
      sha256: "5049f0774e6819f342bab1b06214c7dc830937c039e23146cd426b0d725aaa08",
    }),
    Object.freeze({
      role: "r1-gate",
      relative: "lib/r1-evm-read-gate.js",
      sha256: "c20d290fa053e23e561c5fee54c6e47709f3f812d83d60d7c879932e438bc5fe",
    }),
    Object.freeze({
      role: "production-policy",
      relative: "morpho-pt-27aug2026-post-expiry-r1-production-policy.js",
      sha256: "208e4e57025fe20e5556a0ddaaf6c5bc0493e727524c4d53127622833649b396",
    }),
    Object.freeze({
      role: "profile",
      relative: "morpho-pt-27aug2026-post-expiry-r1-profile.js",
      sha256: "7cd70f0888bc6c93b08a83b749904cf1f79e6f46abdc0d9455ddc8d400aa5db8",
    }),
    Object.freeze({
      role: "inventory-parser",
      relative: "preflight-all-chain-endpoints-v4.js",
      sha256: "171590a0ab5bc204a9a0fa8a750ba8adbe74684bd68e756e99a7e29b29067558",
    }),
    Object.freeze({
      role: "production-validator",
      relative: "validate-morpho-pt-27aug2026-post-expiry-r1-production.js",
      sha256: "b0c2e0702e7921f4305ae8c2bd946640e3745b654734140ae94b0ef19d115f8e",
    }),
    Object.freeze({
      role: "offline-validator",
      relative: "validate-morpho-pt-27aug2026-post-expiry-r1.js",
      sha256: "52b193cc0679dc23048311b62f67380622d33eda5ca01de0d2e4615395825b18",
    }),
  ]),
  ROOT_RELATIVES = Object.freeze([
    "lib/morpho-pt-27aug2026-post-expiry-r1-production-adapter.js",
    "capture-morpho-pt-27aug2026-post-expiry-r1-production.js",
    "lib/r1-evm-read-gate.js",
    "morpho-pt-27aug2026-post-expiry-r1-production-policy.js",
    "morpho-pt-27aug2026-post-expiry-r1-profile.js",
    "lib/morpho-pt-27aug2026-post-expiry-r1-gate.js",
    "validate-morpho-pt-27aug2026-post-expiry-r1.js",
    "preflight-all-chain-endpoints-v4.js",
  ]),
  EXTERNAL_INVOCATION_AUTHORITY = Object.freeze({
    schema: "morpho-pt-candidate-diagnostic-pool-4-7-external-runner/v1",
    executable: STAGED_NODE,
    script: FIXED_DIAGNOSTIC_PATH,
    argv: Object.freeze([MODE]),
    env: MINIMAL_ENV,
    sourceHashAuthority: Object.freeze({
      algorithm: "SHA-256",
      target: FIXED_DIAGNOSTIC_PATH,
      expected: "EXTERNAL_REVIEWED_SHA256_REQUIRED",
      timing: "IMMEDIATELY_BEFORE_STAGED_NODE_INVOCATION",
    }),
    inventoryAuthority: Object.freeze({
      windowsPath: INVENTORY_WINDOWS_PATH,
      linuxPath: INVENTORY_LINUX_PATH,
      windowsDaclPrecheck: Object.freeze({
        protected: true,
        inheritanceDisabled: true,
        exactAllowedPrincipals: Object.freeze([
          "CURRENT_USER",
          "NT AUTHORITY\\SYSTEM",
          "BUILTIN\\Administrators",
        ]),
        rejectUnexpectedAces: true,
      }),
      linuxRead:
        "O_RDONLY|O_NOFOLLOW_HELD_FD_CANONICAL_EXACT_BOUNDED_READ_EOF_PRE_POST_IDENTITY",
      drvfsModeAuthority: false,
    }),
    runnerOrder: Object.freeze([
      "VERIFY_EXTERNAL_SOURCE_SHA256",
      "VERIFY_PROTECTED_WINDOWS_INVENTORY_DACL",
      "INVOKE_FIXED_STAGED_NODE_SCRIPT_FLAG_WITH_MINIMAL_ENV",
    ]),
  }),
  STEPS = Object.freeze({
    eth_chainId: "CHAIN",
    eth_getBlockByNumber: "FINALIZED",
    eth_getCode: "CODE",
    eth_call: "EXPIRY",
  });

class DiagnosticError extends Error {
  constructor(code) {
    super(code);
    this.name = "DiagnosticError";
    this.code = code;
  }
}
const fail = (code) => {
    throw new DiagnosticError(code);
  },
  sameKeys = (value, keys) =>
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key)),
  digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function sourcePaths(root) {
  return Object.fromEntries(
    PINNED_FILES.map((entry) => [entry.role, path.resolve(root, entry.relative)]),
  );
}

function decodeMountPath(value) {
  return value
    .replace(/\\040/gu, " ")
    .replace(/\\011/gu, "\t")
    .replace(/\\012/gu, "\n")
    .replace(/\\134/gu, "\\");
}

function mountFor(filename, text) {
  const target = filename.replace(/\\/gu, "/");
  let best = null;
  for (const line of text.split("\n")) {
    const split = line.indexOf(" - ");
    if (split < 0) continue;
    const left = line.slice(0, split).split(" "),
      right = line.slice(split + 3).split(" "),
      mountPoint = decodeMountPath(left[4] || "").replace(/\\/gu, "/");
    const contained =
      mountPoint === "/"
        ? target.startsWith("/")
        : target === mountPoint || target.startsWith(`${mountPoint}/`);
    if (
      left.length < 6 ||
      right.length < 2 ||
      !contained
    )
      continue;
    if (!best || mountPoint.length > best.mountPoint.length)
      best = {
        mountId: left[0],
        majorMinor: left[2],
        root: decodeMountPath(left[3] || "").replace(/\\/gu, "/"),
        mountPoint,
        fsType: right[0],
        source: right[1],
      };
  }
  return best;
}

function discoverRelativeClosure(root, bytesByPath) {
  const queue = ROOT_RELATIVES.map((relative) => path.resolve(root, relative)),
    seen = new Set();
  while (queue.length) {
    const filename = queue.shift();
    if (seen.has(filename)) continue;
    const bytes = bytesByPath.get(filename);
    if (!bytes) fail("FAIL_AUTHORITY");
    seen.add(filename);
    const source = bytes.toString("utf8");
    for (const match of source.matchAll(
      /require\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/gu,
    )) {
      let dependency = path.resolve(path.dirname(filename), match[1]);
      if (!path.extname(dependency)) dependency += ".js";
      if (!seen.has(dependency)) queue.push(dependency);
    }
  }
  return seen;
}

function qualifySourceTree({
  ops,
  root,
  scriptPath,
  platform,
  uid,
  mountInfoPath = "/proc/self/mountinfo",
}) {
  const paths = sourcePaths(root),
    expectedPaths = new Set(Object.values(paths)),
    bytesByPath = new Map(),
    stats = [];
  let scriptStat, scriptReal;
  try {
    scriptStat = ops.lstatSync(scriptPath);
    scriptReal = ops.realpathSync.native(scriptPath);
  } catch (_) {
    fail("FAIL_AUTHORITY");
  }
  if (
    !scriptStat.isFile() ||
    scriptStat.isSymbolicLink() ||
    scriptReal !== scriptPath
  )
    fail("FAIL_AUTHORITY");
  for (const entry of PINNED_FILES) {
    const filename = paths[entry.role];
    let stat, real, bytes;
    try {
      stat = ops.lstatSync(filename);
      real = ops.realpathSync.native(filename);
      bytes = ops.readFileSync(real);
    } catch (_) {
      fail("FAIL_AUTHORITY");
    }
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      real !== filename ||
      digest(bytes) !== entry.sha256
    )
      fail("FAIL_AUTHORITY");
    bytesByPath.set(filename, Buffer.from(bytes));
    stats.push(stat);
  }
  const discovered = discoverRelativeClosure(root, bytesByPath);
  if (
    discovered.size !== expectedPaths.size ||
    [...discovered].some((filename) => !expectedPaths.has(filename))
  )
    fail("FAIL_AUTHORITY");
  if (platform === "linux") {
    if (
      uid !== 1000 ||
      Number(scriptStat.uid) !== 1000 ||
      Number(scriptStat.nlink) !== 1 ||
      (Number(scriptStat.mode) & 0o022) !== 0 ||
      stats.some(
        (stat) =>
          Number(stat.uid) !== 1000 ||
          Number(stat.nlink) !== 1 ||
          (Number(stat.mode) & 0o022) !== 0 ||
          stat.dev !== scriptStat.dev,
      )
    )
      fail("FAIL_AUTHORITY");
    let mountInfo;
    try {
      mountInfo = ops.readFileSync(mountInfoPath, "utf8");
    } catch (_) {
      fail("FAIL_AUTHORITY");
    }
    const identities = [scriptPath, ...expectedPaths].map((filename) =>
      mountFor(filename, mountInfo),
    );
    if (
      identities.some((identity) => !identity || !["ext4", "xfs"].includes(identity.fsType)) ||
      identities.some(
        (identity) => JSON.stringify(identity) !== JSON.stringify(identities[0]),
      )
    )
      fail("FAIL_AUTHORITY");
    let type;
    try {
      type = BigInt(ops.statfsSync(scriptPath).type);
    } catch (_) {
      fail("FAIL_AUTHORITY");
    }
    const expectedType = identities[0].fsType === "ext4" ? 0xef53n : 0x58465342n;
    if (type !== expectedType) fail("FAIL_AUTHORITY");
  }
  return { count: PINNED_FILES.length, paths };
}

function requireReviewed(paths, loader) {
  policy = loader(paths["production-policy"]);
  adapter = loader(paths["production-adapter"]);
  capture = loader(paths["transport-capture"]);
  r1 = loader(paths["r1-gate"]);
  if (
    !policy?.POLICY ||
    typeof adapter.parseInventory !== "function" ||
    typeof capture.strictRequest !== "function" ||
    typeof r1.parseHeader !== "function"
  )
    fail("FAIL_AUTHORITY");
}

function validateSourceAuthority() {
  if (arguments.length) fail("FAIL_AUTHORITY");
  return qualifySourceTree({
    ops: fs,
    root: STAGED_TOOLS,
    scriptPath: FIXED_DIAGNOSTIC_PATH,
    platform: process.platform,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
  });
}

function loadReviewedModules() {
  if (adapter) return;
  const authority = qualifySourceTree({
    ops: fs,
    root: __dirname,
    scriptPath: __filename,
    platform: process.platform,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
  });
  requireReviewed(authority.paths, require);
}

function loadReviewedModulesSyntheticTestOnly(options) {
  if (
    !sameKeys(options, ["ops", "root", "scriptPath", "platform", "uid", "loader"])
  )
    fail("FAIL_AUTHORITY");
  const authority = qualifySourceTree(options);
  requireReviewed(authority.paths, options.loader);
  return authority.count;
}

function validateActualInvocation({
  argv = process.argv.slice(2),
  env = process.env,
  execArgv = process.execArgv,
  execPath = process.execPath,
  nodeVersion = process.version,
  platform = process.platform,
  scriptPath = process.argv[1],
} = {}) {
  if (!Array.isArray(argv) || argv.length !== 1 || argv[0] !== MODE)
    fail("FAIL_INVOCATION");
  if (!Array.isArray(execArgv) || execArgv.length !== 0)
    fail("FAIL_INVOCATION");
  if (
    !sameKeys(env, Object.keys(MINIMAL_ENV)) ||
    Object.entries(MINIMAL_ENV).some(([key, value]) => env[key] !== value)
  )
    fail("FAIL_INVOCATION");
  if (
    platform !== "linux" ||
    execPath !== STAGED_NODE ||
    nodeVersion !== STAGED_NODE_VERSION ||
    scriptPath !== FIXED_DIAGNOSTIC_PATH
  )
    fail("FAIL_AUTHORITY");
  return true;
}

function sameIdentity(a, b) {
  return !!(
    a &&
    b &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    Number(a.size) === Number(b.size)
  );
}

function readInventoryHeld(
  ops,
  filename,
  maxBytes,
  procRoot = "/proc/self/fd",
) {
  const constants = ops.constants || fs.constants,
    flags = constants.O_RDONLY | constants.O_NOFOLLOW;
  if (
    typeof filename !== "string" ||
    !path.isAbsolute(filename) ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    !Number.isInteger(constants.O_NOFOLLOW)
  )
    fail("FAIL_INVENTORY");
  let fd,
    bytes,
    complete = false;
  try {
    const pathBefore = ops.lstatSync(filename),
      canonicalBefore = ops.realpathSync.native(filename);
    if (
      !pathBefore.isFile() ||
      pathBefore.isSymbolicLink() ||
      Number(pathBefore.nlink) !== 1 ||
      canonicalBefore !== filename
    )
      fail("FAIL_INVENTORY");
    fd = ops.openSync(filename, flags);
    const heldBefore = ops.fstatSync(fd),
      heldPath = ops.realpathSync.native(path.join(procRoot, String(fd))),
      size = Number(heldBefore.size);
    if (
      !heldBefore.isFile() ||
      Number(heldBefore.nlink) !== 1 ||
      !Number.isSafeInteger(size) ||
      size < 1 ||
      size > maxBytes ||
      heldPath !== filename ||
      !sameIdentity(pathBefore, heldBefore)
    )
      fail("FAIL_INVENTORY");
    bytes = Buffer.alloc(size);
    let used = 0;
    while (used < size) {
      const count = ops.readSync(fd, bytes, used, size - used, null);
      if (!Number.isSafeInteger(count) || count <= 0) fail("FAIL_INVENTORY");
      used += count;
    }
    const extra = Buffer.alloc(1),
      eof = ops.readSync(fd, extra, 0, 1, null);
    extra.fill(0);
    const heldAfter = ops.fstatSync(fd),
      pathAfter = ops.lstatSync(filename);
    if (
      eof !== 0 ||
      !pathAfter.isFile() ||
      pathAfter.isSymbolicLink() ||
      Number(pathAfter.nlink) !== 1 ||
      !sameIdentity(heldBefore, heldAfter) ||
      !sameIdentity(heldAfter, pathAfter) ||
      ops.realpathSync.native(filename) !== filename ||
      ops.realpathSync.native(path.join(procRoot, String(fd))) !== filename
    )
      fail("FAIL_INVENTORY");
    complete = true;
    return bytes;
  } catch (error) {
    if (error instanceof DiagnosticError) throw error;
    fail("FAIL_INVENTORY");
  } finally {
    if (fd !== undefined)
      try {
        ops.closeSync(fd);
      } catch (_) {
        if (complete) {
          bytes?.fill(0);
          fail("FAIL_INVENTORY");
        }
      }
    if (!complete) bytes?.fill(0);
  }
}

function readActualInventory() {
  if (arguments.length) fail("FAIL_INVENTORY");
  return readInventoryHeld(
    fs,
    INVENTORY_LINUX_PATH,
    INVENTORY_MAX_BYTES,
  );
}

function validateInventorySelectionSyntheticTestOnly(options) {
  if (
    !sameKeys(options, [
      "ops",
      "filename",
      "maxBytes",
      "procRoot",
      "parseInventory",
      "selectCandidates",
    ]) ||
    typeof options.parseInventory !== "function" ||
    typeof options.selectCandidates !== "function"
  )
    fail("FAIL_INVENTORY");
  const bytes = readInventoryHeld(
    options.ops,
    options.filename,
    options.maxBytes,
    options.procRoot,
  );
  try {
    const rows = options.parseInventory(bytes),
      selected = options.selectCandidates(rows);
    if (!Array.isArray(selected) || selected.length !== 4)
      fail("FAIL_INVENTORY");
    return true;
  } finally {
    bytes.fill(0);
  }
}

function selectTargetHandles(rows) {
  if (
    !Array.isArray(rows) ||
    rows.length < 8 ||
    new Set(rows.map((row) => row.family)).size !== 9
  )
    fail("FAIL_INVENTORY");
  const eligiblePool = [...rows]
      .sort((a, b) => a.inventoryOrder - b.inventoryOrder)
      .slice(0, 8),
    rankedPool = [...eligiblePool].sort(
      (a, b) =>
        b.capability - a.capability ||
        Number(b.premium) - Number(a.premium) ||
        a.inventoryOrder - b.inventoryOrder,
    );
  if (
    eligiblePool.length !== 8 ||
    rankedPool.length !== 8 ||
    new Set(eligiblePool.map((row) => row.inventoryOrder)).size !== 8
  )
    fail("FAIL_INVENTORY");
  const excluded = rankedPool.slice(0, 4),
    targets = rankedPool.slice(4, 8),
    excludedOrders = new Set(excluded.map((row) => row.inventoryOrder));
  if (
    targets.length !== 4 ||
    targets.some((row) => excludedOrders.has(row.inventoryOrder))
  )
    fail("FAIL_INVENTORY");
  const handles = adapter.selectCandidates(targets);
  if (
    handles.length !== 4 ||
    handles.some(
      (handle, index) =>
        handle.inventoryOrder !== targets[index].inventoryOrder ||
        handle.operatorFamily !== targets[index].family ||
        handle.capabilityRank !== targets[index].capability ||
        handle.premium !== (targets[index].premium === true),
    )
  )
    fail("FAIL_INVENTORY");
  return handles;
}

function validateActualInventoryAuthorityOnly() {
  if (arguments.length) fail("FAIL_INVENTORY");
  const authority = validateSourceAuthority();
  requireReviewed(authority.paths, require);
  const bytes = readActualInventory();
  try {
    const rows = adapter.parseInventory(bytes),
      selected = selectTargetHandles(rows);
    if (selected.length !== 4) fail("FAIL_INVENTORY");
    return true;
  } finally {
    bytes.fill(0);
  }
}

function diagnosticAccounting() {
  let requests = 0,
    active = 0,
    maxConcurrency = 0,
    responseBytes = 0;
  return {
    begin() {
      if (active !== 0 || requests >= MAX_REQUESTS) fail("FAIL_ACCOUNTING");
      requests++;
      active++;
      maxConcurrency = Math.max(maxConcurrency, active);
    },
    add(bytes) {
      if (!Number.isSafeInteger(bytes) || bytes < 0) fail("FAIL_ACCOUNTING");
      responseBytes += bytes;
      if (!Number.isSafeInteger(responseBytes)) fail("FAIL_ACCOUNTING");
    },
    end() {
      active--;
      if (active !== 0) fail("FAIL_ACCOUNTING");
    },
    summary() {
      if (active !== 0 || requests > MAX_REQUESTS) fail("FAIL_ACCOUNTING");
      return { requests, responseBytes, maxConcurrency, retries: 0 };
    },
  };
}

function globalCode(error) {
  const code = error?.code;
  if (/^DNS_/u.test(code || "")) return "FAIL_DNS";
  if (code === "ABSOLUTE_DEADLINE") return "FAIL_DEADLINE";
  if (
    code === "FAIL_ACCOUNTING" ||
    /^(?:OUTER_(?:BUDGET|ACCOUNTING|BYTES)|RPC_REQUEST_SIZE)$/u.test(code || "")
  )
    return "FAIL_ACCOUNTING";
  if (code === "HTTP_SOCKET_MULTIPLE") return "FAIL_SOCKET_MULTIPLICITY";
  if (/^(?:RPC_RESPONSE_SCHEMA|RPC_COUNTERS|RPC_ELAPSED)$/u.test(code || ""))
    return "FAIL_RESPONSE_CONTRACT";
  if (/^FAIL_(?:INVOCATION|AUTHORITY|INVENTORY|SANITIZATION)$/u.test(code || ""))
    return code;
  return null;
}

function failureClass(error) {
  const code = error?.code || "";
  if (/^(?:HTTP_.+|RPC_HTTP|RPC_TLS_DNS|RPC_RELAY)$/u.test(code)) return "HTTP";
  if (/^RPC_JSON(?:_SCHEMA|_ID)?$/u.test(code)) return "ENVELOPE";
  if (/^PROBE_/u.test(code) || error?.name === "GateError") return "SEMANTIC";
  return null;
}

function safeResult(result, secrets) {
  let serialized;
  try {
    serialized = JSON.stringify(result);
    adapter.assertSanitized(serialized, secrets);
  } catch (_) {
    return { status: "FAIL_SANITIZATION" };
  }
  return result;
}

async function runCore({ inventoryBytes, resolve, httpPost, clock = Date.now }) {
  loadReviewedModules();
  if (
    !Buffer.isBuffer(inventoryBytes) ||
    typeof resolve !== "function" ||
    typeof httpPost !== "function" ||
    typeof clock !== "function"
  )
    fail("FAIL_INTERNAL");
  let rows, handles, secrets;
  try {
    rows = adapter.parseInventory(inventoryBytes);
    handles = selectTargetHandles(rows);
    if (handles.length !== 4) fail("FAIL_INVENTORY");
    secrets = adapter.collectSensitiveStrings(rows);
  } catch (error) {
    const code = globalCode(error) || "FAIL_INVENTORY";
    return safeResult({ status: code }, secrets || new Set());
  }
  const deadline = adapter.createDeadline(clock),
    outerAccounting = adapter.account(),
    diagnostic = diagnosticAccounting(),
    trace = [],
    usage = {
      direct: 0,
      relay: 0,
      counters: {
        dns: 0,
        socket: 0,
        connect: 0,
        tls: 0,
        data: 0,
        requestDestroyed: 0,
        socketDestroyed: 0,
        agentDestroyed: 0,
      },
    };
  let pins;
  try {
    pins = await adapter.resolvePins(handles, { resolve, deadline });
  } catch (error) {
    return safeResult(
      { status: globalCode(error) || "FAIL_INTERNAL" },
      secrets,
    );
  }
  const baseTransport = adapter.createTransport(httpPost, {
      pins,
      deadline,
      accounting: outerAccounting,
      trace,
      usage,
    }),
    slots = [];
  let step = "CHAIN";
  const transport = async (handle, method, params) => {
    if (!Object.hasOwn(STEPS, method)) fail("FAIL_INTERNAL");
    step = STEPS[method];
    diagnostic.begin();
    try {
      const response = await baseTransport(handle, method, params);
      diagnostic.add(response.bytes);
      return response;
    } finally {
      diagnostic.end();
    }
  };
  for (let offset = 0; offset < handles.length; offset++) {
    const candidateIndex = offset + 4;
    step = "CHAIN";
    try {
      await adapter.adapterProbes([handles[offset]], transport, clock);
      slots.push({
        candidateIndex,
        outcome: "PASS",
        step: "EXPIRY",
        class: "SEMANTIC",
      });
    } catch (error) {
      const global = globalCode(error);
      if (global) return safeResult({ status: global }, secrets);
      const classification = failureClass(error);
      if (!classification)
        return safeResult({ status: "FAIL_INTERNAL" }, secrets);
      slots.push({
        candidateIndex,
        outcome: "FAIL",
        step,
        class: classification,
      });
    }
  }
  const accounting = diagnostic.summary(),
    result = {
      status: slots.every((slot) => slot.outcome === "PASS") ? "PASS" : "FAIL",
      slots,
      accounting,
    };
  if (
    slots.length !== 4 ||
    slots.some((slot, index) => slot.candidateIndex !== index + 4) ||
    accounting.requests > MAX_REQUESTS ||
    accounting.maxConcurrency !== 1 ||
    accounting.retries !== 0
  )
    return safeResult({ status: "FAIL_ACCOUNTING" }, secrets);
  return safeResult(result, secrets);
}

async function runSyntheticTestOnly(options = {}) {
  if (
    !sameKeys(options, ["inventoryBytes", "resolve", "httpPost", "clock"])
  )
    fail("FAIL_INTERNAL");
  return runCore(options);
}

function runActual() {
  if (arguments.length) fail("FAIL_INVOCATION");
  validateActualInvocation();
  const authority = validateSourceAuthority();
  requireReviewed(authority.paths, require);
  const inventoryBytes = readActualInventory();
  try {
    return runCore({
      inventoryBytes,
      resolve: capture.resolveDns,
      httpPost: capture.strictRequest,
      clock: Date.now,
    });
  } finally {
    inventoryBytes.fill(0);
  }
}

if (require.main === module)
  Promise.resolve()
    .then(() => runActual())
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      const status = globalCode(error) || "FAIL_INTERNAL";
      process.stdout.write(`${JSON.stringify({ status })}\n`);
      process.exitCode = 2;
    });

module.exports = {
  BASENAME,
  EXTERNAL_INVOCATION_AUTHORITY,
  FIXED_DIAGNOSTIC_PATH,
  INVENTORY_LINUX_PATH,
  INVENTORY_MAX_BYTES,
  INVENTORY_WINDOWS_PATH,
  MAX_REQUESTS,
  MINIMAL_ENV,
  MODE,
  PINNED_FILES,
  STAGED_NODE,
  STAGED_NODE_VERSION,
  DiagnosticError,
  diagnosticAccounting,
  failureClass,
  globalCode,
  loadReviewedModulesSyntheticTestOnly,
  runActual,
  runSyntheticTestOnly,
  validateActualInvocation,
  validateActualInventoryAuthorityOnly,
  validateInventorySelectionSyntheticTestOnly,
  validateSourceAuthority,
};
