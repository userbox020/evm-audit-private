#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto"),
  fs = require("node:fs"),
  net = require("node:net"),
  path = require("node:path"),
  { TextDecoder } = require("node:util");
const {
  POLICY,
  POLICY_HASH,
  canonical,
} = require("../morpho-pt-27aug2026-post-expiry-r1-production-policy.js");
const PROFILE = require("../morpho-pt-27aug2026-post-expiry-r1-profile.js");
const ENGINE = require("./morpho-pt-27aug2026-post-expiry-r1-gate.js");
const OFFLINE_VALIDATOR = require("../validate-morpho-pt-27aug2026-post-expiry-r1.js");
const BASE = require("./r1-evm-read-gate.js");
const INVENTORY_PARSER = require("../preflight-all-chain-endpoints-v4.js");

class ProductionError extends Error {
  constructor(code) {
    super(code);
    this.name = "ProductionError";
    this.code = code;
  }
}
const fail = (code) => {
    throw new ProductionError(code);
  },
  object = (v) => v !== null && typeof v === "object" && !Array.isArray(v),
  exact = (v, k, c) => {
    if (
      !object(v) ||
      Object.keys(v).length !== k.length ||
      !k.every((key) => Object.hasOwn(v, key))
    )
      fail(c);
  };
const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex"),
  hash = (v) => typeof v === "string" && /^[0-9a-f]{64}$/u.test(v),
  clone = (v) => JSON.parse(JSON.stringify(v));
const q = (n) => `0x${BigInt(n).toString(16)}`,
  block = (h) => ({ blockHash: h, requireCanonical: true }),
  same = (a, b) => canonical(a) === canonical(b);

function parseCanonical(bytes, max, code) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < 1 ||
    bytes.length > max ||
    bytes.includes(0) ||
    bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
  )
    fail(code);
  let text, value;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch (_) {
    fail(code);
  }
  if (JSON.stringify(value) !== text) fail(code);
  return value;
}
function bridgeFifo(ops, fd, code) {
  let stat;
  try {
    stat = ops.fstatSync(fd);
  } catch (_) {
    fail(code);
  }
  if (typeof stat.isFIFO !== "function" || !stat.isFIFO()) fail(`${code}_TYPE`);
}
function readExactFd(ops, fd, buffer, offset, length, code) {
  let used = 0;
  try {
    while (used < length) {
      const n = ops.readSync(fd, buffer, offset + used, length - used, null);
      if (!Number.isSafeInteger(n) || n <= 0) fail(code);
      used += n;
    }
  } catch (error) {
    if (error instanceof ProductionError) throw error;
    fail(code);
  }
}
function parseBridgePrelude(bytes, { nonce, bridge } = {}) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length !== POLICY.input.preludeBytes ||
    bytes.subarray(0, 8).toString("ascii") !== POLICY.input.preludeMagic ||
    bytes.readUInt32LE(8) !== POLICY.input.version ||
    bytes.readUInt32LE(108) < 1 ||
    bytes.readUInt32LE(108) > POLICY.inventory.maxBytes ||
    bytes.subarray(148).toString("ascii") !== POLICY.input.authTerminal
  )
    fail("BRIDGE_AUTH");
  if (bytes.subarray(12, 44).toString("hex") !== nonce) fail("BRIDGE_NONCE");
  const broker = bytes.subarray(44, 76).toString("hex"),
    launcher = bytes.subarray(76, 108).toString("hex");
  if (
    bridge &&
    (broker !== bridge.nativeSupervisorRuntimeSha256 ||
      launcher !== bridge.launcherBinarySha256)
  )
    fail("BRIDGE_SELF_HASH");
  return {
    length: bytes.readUInt32LE(108),
    broker,
    launcher,
    authCommitment: sha256(bytes),
    identity: Buffer.from(bytes.subarray(108, 148)),
  };
}
function readBridgePrelude(ops = fs, fd = POLICY.input.fd) {
  bridgeFifo(ops, fd, "BRIDGE_FD");
  const buffer = Buffer.alloc(POLICY.input.preludeBytes);
  try {
    readExactFd(ops, fd, buffer, 0, buffer.length, "BRIDGE_AUTH_READ");
    return Buffer.from(buffer);
  } finally {
    buffer.fill(0);
  }
}
function buildBridgeGo(preludeFrame) {
  const prelude = parseBridgePrelude(preludeFrame, {
      nonce: preludeFrame.subarray(12, 44).toString("hex"),
    }),
    go = Buffer.alloc(POLICY.input.goBytes);
  go.write(POLICY.input.goMagic, 0, "ascii");
  go.writeUInt32LE(POLICY.input.goVersion, 8);
  go.writeUInt32LE(POLICY.input.goType, 12);
  go.writeUInt32LE(POLICY.input.goSequence, 16);
  preludeFrame.copy(go, 20, 12, 108);
  Buffer.from(prelude.authCommitment, "hex").copy(go, 116);
  go.write(POLICY.input.goTerminal, 148, "ascii");
  return go;
}
function writeBridgeGo(preludeFrame, ops = fs, fd = POLICY.input.goFd) {
  bridgeFifo(ops, fd, "BRIDGE_GO_FD");
  const go = buildBridgeGo(preludeFrame);
  let used = 0;
  try {
    while (used < go.length) {
      const n = ops.writeSync(fd, go, used, go.length - used, null);
      if (!Number.isSafeInteger(n) || n <= 0) fail("BRIDGE_GO_WRITE");
      used += n;
    }
  } catch (error) {
    if (error instanceof ProductionError) throw error;
    fail("BRIDGE_GO_WRITE");
  } finally {
    go.fill(0);
    try {
      ops.closeSync(fd);
    } catch (_) {}
  }
}
function parseBridgeFrame(bytes, { nonce, bridge, expectedLength }) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < POLICY.input.dataOverhead ||
    bytes.length > POLICY.input.dataOverhead + POLICY.inventory.maxBytes
  )
    fail("BRIDGE_FRAME_SIZE");
  const length = bytes.readUInt32LE(148);
  if (
    bytes.subarray(0, 8).toString("ascii") !== POLICY.input.dataMagic ||
    bytes.readUInt32LE(8) !== POLICY.input.dataVersion ||
    bytes.readUInt32LE(12) !== POLICY.input.dataType ||
    bytes.readUInt32LE(16) !== POLICY.input.dataSequence ||
    length < 1 ||
    length > POLICY.inventory.maxBytes ||
    length !== expectedLength.length ||
    bytes.length !== POLICY.input.dataOverhead + length ||
    bytes.subarray(188 + length).toString("ascii") !== POLICY.input.terminal
  )
    fail("BRIDGE_FRAME");
  if (bytes.subarray(20, 52).toString("hex") !== nonce) fail("BRIDGE_NONCE");
  const broker = bytes.subarray(52, 84).toString("hex"),
    launcher = bytes.subarray(84, 116).toString("hex"),
    authCommitment = bytes.subarray(116, 148).toString("hex");
  if (
    broker !== bridge.nativeSupervisorRuntimeSha256 ||
    launcher !== bridge.launcherBinarySha256 ||
    authCommitment !== expectedLength.authCommitment ||
    !bytes.subarray(148, 188).equals(expectedLength.identity)
  )
    fail("BRIDGE_SELF_HASH");
  return Buffer.from(bytes.subarray(188, 188 + length));
}
function readBridgeFd3(ops = fs, fd = POLICY.input.fd) {
  bridgeFifo(ops, fd, "BRIDGE_FD");
  const header = Buffer.alloc(POLICY.input.dataHeaderBytes);
  let frame;
  try {
    readExactFd(ops, fd, header, 0, header.length, "BRIDGE_DATA_READ");
    const length = header.readUInt32LE(148);
    if (length < 1 || length > POLICY.inventory.maxBytes)
      fail("BRIDGE_FRAME_SIZE");
    frame = Buffer.alloc(POLICY.input.dataOverhead + length);
    header.copy(frame);
    readExactFd(ops, fd, frame, POLICY.input.dataHeaderBytes, length + 8, "BRIDGE_DATA_READ");
    const extra = Buffer.alloc(1),
      n = ops.readSync(fd, extra, 0, 1, null);
    extra.fill(0);
    if (n !== 0) fail("BRIDGE_TRAILING");
    return frame;
  } catch (error) {
    if (error instanceof ProductionError) throw error;
    fail("BRIDGE_READ");
  } finally {
    header.fill(0);
  }
}
const DANGEROUS =
  /^(?:HTTPS?_PROXY|ALL_PROXY|NO_PROXY|USE_ENV_PROXY|NODE_USE_ENV_PROXY|NODE_OPTIONS|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|SSLKEYLOGFILE|OPENSSL_CONF|NODE_TLS_REJECT_UNAUTHORIZED|NODE_V8_COVERAGE|JSC_V8_COVERAGE|COVERAGE|NYC_CONFIG|DEBUG|NODE_DEBUG|NODE_DEBUG_NATIVE|NODE_REPORT_DIR|NODE_REPORT_FILENAME|NODE_REPORT_SIGNAL|NODE_REPORT_COMPACT)$/iu;
const SENSITIVE =
  /(?:RPC|ENDPOINT|PROVIDER|INVENTORY|PRIVATE|WALLET|MNEMONIC|SEED|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE|HEADER|_URL|_URI|API_KEY|PRELOAD|DIAGNOSTIC|INSPECT|COVERAGE|TLS|SSL|KEYLOG)/iu;
function validateInvocation({ args, env, execArgv, stdinBytes, stdinIsPipe }) {
  if (
    !Array.isArray(args) ||
    args.length !== 1 ||
    args[0] !== `--mode=${POLICY.mode}`
  )
    fail("ARGV");
  if (/(?:0x[0-9a-f]{40}|https?:|wss?:)/iu.test(args.join(" ")))
    fail("ARGV_SECRET");
  if (
    !object(env) ||
    Object.entries(env).some(
      ([k, v]) =>
        v !== undefined &&
        v !== null &&
        String(v) !== "" &&
        (DANGEROUS.test(k) ||
          SENSITIVE.test(k) ||
          (typeof v === "string" && /(?:https?|wss):\/\//iu.test(v))),
    )
  )
    fail("ENV");
  if (!Array.isArray(execArgv) || execArgv.length !== 0) fail("EXEC_ARGV");
  if (
    !stdinIsPipe ||
    !Buffer.isBuffer(stdinBytes) ||
    !/^[0-9a-f]{64}$/u.test(stdinBytes.toString("utf8")) ||
    new Set(stdinBytes.toString("utf8").match(/../gu)).size < 8
  )
    fail("NONCE_STDIN");
  return stdinBytes.toString("utf8");
}
function createDeadline(clock = Date.now, total = POLICY.limits.wallMs) {
  const started = clock(),
    end = started + total;
  return {
    started,
    remaining() {
      const n = end - clock();
      if (n <= 0) fail("ABSOLUTE_DEADLINE");
      return n;
    },
    check() {
      this.remaining();
    },
    elapsed() {
      return Math.max(0, clock() - started);
    },
  };
}
function statLink(s) {
  return (
    s.isSymbolicLink() ||
    (typeof s.isReparsePoint === "function" && s.isReparsePoint())
  );
}
function safeReadLinux(
  root,
  relative,
  max,
  ops = fs,
  {
    platform = process.platform,
    uid = typeof process.getuid === "function" ? process.getuid() : null,
    procRoot = "/proc/self/fd",
  } = {},
) {
  if (platform !== "linux" || uid === null) fail("PLATFORM_LINUX");
  const absolute = path.resolve(root, relative),
    realRoot = ops.realpathSync(root),
    real = ops.realpathSync(absolute);
  if (
    real !== absolute ||
    !(real === realRoot || real.startsWith(`${realRoot}${path.sep}`))
  )
    fail("FILE_PATH");
  const leaf = ops.lstatSync(absolute);
  if (
    statLink(leaf) ||
    !leaf.isFile() ||
    leaf.size < 1 ||
    leaf.size > max ||
    leaf.uid !== uid ||
    (leaf.mode & 0o022) !== 0
  )
    fail("FILE_MODE");
  let fd;
  try {
    fd = ops.openSync(
      absolute,
      (ops.constants || fs.constants).O_RDONLY |
        (ops.constants || fs.constants).O_NOFOLLOW,
    );
    const before = ops.fstatSync(fd);
    if (
      !before.isFile() ||
      before.dev !== leaf.dev ||
      before.ino !== leaf.ino ||
      before.size !== leaf.size ||
      before.uid !== uid ||
      (before.mode & 0o022) !== 0
    )
      fail("FILE_IDENTITY");
    const proc = path.join(procRoot, String(fd)),
      handle =
        typeof ops.realpathHandleSync === "function"
          ? ops.realpathHandleSync(fd)
          : ops.realpathSync(proc);
    if (handle !== real || ops.realpathSync(proc) !== real) fail("FILE_PROCFD");
    const bytes = ops.readFileSync(fd),
      after = ops.fstatSync(fd);
    if (
      bytes.length !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    )
      fail("FILE_CHANGED");
    return bytes;
  } catch (e) {
    if (e instanceof ProductionError) throw e;
    fail("FILE_OPEN");
  } finally {
    if (fd !== undefined)
      try {
        ops.closeSync(fd);
      } catch (_) {}
  }
}
function validatePermit(v, { nonce, bindings, now }) {
  exact(
    v,
    [
      "schema",
      "permitId",
      "mode",
      "approvalNonceCommitment",
      "issuedAt",
      "notBefore",
      "expiresAt",
      "policyHash",
      "productionHashes",
      "offlineHashes",
      "runtime",
      "bridge",
      "policy",
      "limits",
      "schemas",
      "output",
      "hardStops",
    ],
    "PERMIT_SCHEMA",
  );
  exact(
    v.productionHashes,
    [
      "policy",
      "adapter",
      "capture",
      "validator",
      "test",
      "nativeSupervisorSource",
      "nativeSupervisorStagedCopy",
      "nativeBuildManifest",
      "launcherSource",
      "launcherBinary",
    ],
    "PERMIT_PRODUCTION_HASHES",
  );
  exact(
    v.offlineHashes,
    [
      "profile",
      "engine",
      "validator",
      "test",
      "disabledCapture",
      "sharedGate",
      "inventoryParser",
    ],
    "PERMIT_OFFLINE_HASHES",
  );
  exact(
    v.runtime,
    ["nodeVersion", "platform", "arch", "toolchain"],
    "PERMIT_RUNTIME_SCHEMA",
  );
  exact(
    v.bridge,
    [
      "inputMode",
      "exclusiveWriterFramedGo",
      "windowsPeerEofRequired",
      "linuxWriterClosedAfterGo",
      "bufferedTrailingBytesRejected",
      "postGoChannelMonitored",
      "inventoryReadAfterPermanentLock",
      "goFrameLayout",
      "nativeSupervisorDeadlineMs",
      "preGoDeadlineMs",
      "postGoDeadlineMs",
      "nativeSupervisorSourceSha256",
      "nativeSupervisorRuntimeSha256",
      "nativeSupervisorStagedCopySha256",
      "nativeBuildManifestSha256",
      "launcherSourceSha256",
      "launcherBinarySha256",
      "nodeExecutableSha256",
      "nodeExecutablePath",
      "nodeVersion",
      "productionCapturePath",
      "productionCaptureSha256",
      "productionCaptureIdentity",
      "runtimeFilePaths",
      "nativeMountPolicy",
      "nativeMountIdentity",
    ],
    "PERMIT_BRIDGE_SCHEMA",
  );
  exact(
    v.bridge.productionCaptureIdentity,
    ["dev", "ino"],
    "PERMIT_CAPTURE_IDENTITY_SCHEMA",
  );
  exact(
    v.bridge.goFrameLayout,
    ["magic", "version", "type", "sequence", "bytes", "terminal", "authCommitment"],
    "PERMIT_GO_LAYOUT_SCHEMA",
  );
  exact(
    v.bridge.nativeMountPolicy,
    [
      "filesystems",
      "requireSameIdentity",
      "uid",
      "regularFileNlink",
      "forbidGroupOtherWrite",
    ],
    "PERMIT_MOUNT_POLICY_SCHEMA",
  );
  exact(
    v.bridge.nativeMountIdentity,
    ["mountId", "majorMinor", "root", "mountPoint", "fsType", "source"],
    "PERMIT_MOUNT_IDENTITY_SCHEMA",
  );
  if (
    v.schema !== POLICY.permit.schema ||
    !hash(v.permitId) ||
    v.mode !== POLICY.mode ||
    v.approvalNonceCommitment !==
      sha256(`morpho-production-nonce/v1\0${nonce}`) ||
    v.policyHash !== POLICY_HASH
  )
    fail("PERMIT_IDENTITY");
  if (
    !Number.isSafeInteger(v.issuedAt) ||
    !Number.isSafeInteger(v.notBefore) ||
    !Number.isSafeInteger(v.expiresAt) ||
    v.notBefore < POLICY.expiryTimestamp * 1000 ||
    now < v.notBefore ||
    v.issuedAt > now ||
    v.expiresAt <= now ||
    v.expiresAt - v.issuedAt > POLICY.permit.maxLifetimeMs
  )
    fail("PERMIT_TIME");
  for (const map of [v.productionHashes, v.offlineHashes])
    if (Object.values(map).some((x) => !hash(x))) fail("PERMIT_HASH_SCHEMA");
  if (
    canonical(v.productionHashes) !== canonical(bindings.productionHashes) ||
    canonical(v.offlineHashes) !== canonical(bindings.offlineHashes) ||
    canonical(v.bridge) !== canonical(bindings.bridge)
  )
    fail("PERMIT_HASH");
  if (
    v.runtime.platform !== "linux" ||
    v.runtime.nodeVersion !== bindings.runtime.nodeVersion ||
    canonical(v.runtime) !== canonical(bindings.runtime)
  )
    fail("PERMIT_RUNTIME");
  if (
    v.bridge.inputMode !== POLICY.input.mode ||
    v.bridge.exclusiveWriterFramedGo !== true ||
    v.bridge.windowsPeerEofRequired !== false ||
    v.bridge.linuxWriterClosedAfterGo !== true ||
    v.bridge.bufferedTrailingBytesRejected !== true ||
    v.bridge.postGoChannelMonitored !== true ||
    v.bridge.inventoryReadAfterPermanentLock !== true ||
    canonical(v.bridge.goFrameLayout) !== canonical({magic:POLICY.input.goMagic,version:POLICY.input.goVersion,type:POLICY.input.goType,sequence:POLICY.input.goSequence,bytes:POLICY.input.goBytes,terminal:POLICY.input.goTerminal,authCommitment:"SHA256_EXACT_PRELUDE"}) ||
    v.bridge.nativeSupervisorDeadlineMs !== POLICY.input.nativeSupervisorDeadlineMs ||
    v.bridge.preGoDeadlineMs !== POLICY.input.preGoDeadlineMs ||
    v.bridge.postGoDeadlineMs !== POLICY.input.postGoDeadlineMs ||
    v.bridge.nativeSupervisorRuntimeSha256 !==
      v.bridge.nativeSupervisorStagedCopySha256 ||
    canonical(v.bridge.nativeMountPolicy) !==
      canonical(POLICY.input.mountPolicy) ||
    !POLICY.input.mountPolicy.filesystems.includes(
      v.bridge.nativeMountIdentity.fsType,
    ) ||
    !Number.isSafeInteger(v.bridge.nativeMountIdentity.mountId) ||
    !/^\d+:\d+$/u.test(v.bridge.nativeMountIdentity.majorMinor) ||
    v.bridge.nodeExecutablePath !== POLICY.input.nodePath ||
    v.bridge.nodeVersion !== POLICY.input.nodeVersion ||
    v.bridge.productionCapturePath !== POLICY.input.capturePath ||
    v.bridge.productionCaptureSha256 !== v.productionHashes.capture ||
    !/^\d+$/u.test(v.bridge.productionCaptureIdentity.dev) ||
    !/^\d+$/u.test(v.bridge.productionCaptureIdentity.ino) ||
    !Array.isArray(v.bridge.runtimeFilePaths) ||
    !v.bridge.runtimeFilePaths.includes(POLICY.input.capturePath) ||
    Object.entries(v.bridge)
      .filter(([key]) => key.endsWith("Sha256"))
      .some(([, value]) => !hash(value))
  )
    fail("PERMIT_BRIDGE");
  if (
    canonical(v.policy) !==
      canonical({
        hash: POLICY_HASH,
        profileHash: POLICY.profileHash,
        chainId: 1,
        expiryTimestamp: POLICY.expiryTimestamp,
        inputMode: POLICY.input.mode,
      }) ||
    canonical(v.limits) !== canonical(POLICY.limits) ||
    canonical(v.schemas) !== canonical(POLICY.schemas) ||
    canonical(v.output) !== canonical(POLICY.output) ||
    canonical(v.hardStops) !== canonical(POLICY.hardStops)
  )
    fail("PERMIT_BINDING");
  return v;
}

const VAULT = new WeakMap();
function endpointHandle(config) {
  const handle = Object.freeze({
    operatorFamily: config.family,
    inventoryOrder: config.inventoryOrder,
    capabilityRank: config.capability,
    premium: config.premium === true,
  });
  VAULT.set(handle, Object.freeze({ ...config }));
  return handle;
}
function privateConfig(handle) {
  const value = VAULT.get(handle);
  if (!value) fail("OPAQUE_HANDLE");
  return value;
}
function parseInventory(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < 2 ||
    bytes.length > POLICY.inventory.maxBytes ||
    bytes.includes(0)
  )
    fail("INVENTORY_SIZE");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (_) {
    fail("INVENTORY_UTF8");
  }
  if (!text.endsWith("\n") || text.includes("\r")) fail("INVENTORY_GRAMMAR");
  let parsed;
  try {
    parsed = INVENTORY_PARSER.parsePrimaryRpcGrammar(text);
  } catch (_) {
    fail("INVENTORY_AUTHORITY");
  }
  const lines = text.split("\n"),
    contexts = [];
  let section = "";
  for (const line of lines) {
    if (/^\s*\[/u.test(line) || /^\s*#{1,6}\s+/u.test(line)) section = line;
    contexts.push(`${section} ${line}`);
  }
  const rows = [];
  for (const row of parsed.records) {
    if (
      row.eligibility !== "PRIMARY_PROBE" ||
      row.protocol !== "EVM" ||
      row.normalizedChain !== "1" ||
      row.networkTier !== "MAINNET" ||
      row.role !== "RPC" ||
      row.requestShape !== "JSON_RPC" ||
      !["PRIMARY_RPC_HTTPS", "RPC_HTTPS_ALIAS"].includes(row.kind)
    )
      continue;
    if (
      !row.explicitFamily ||
      row.family !== row.explicitFamily ||
      !new RegExp(POLICY.candidates.explicitFamily, "u").test(
        row.explicitFamily,
      )
    )
      fail("INVENTORY_EXPLICIT_FAMILY");
    const context = contexts[row.order] || "",
      cap = Number(
        context.match(/\bcapability(?:rank)?\s*[:=]\s*(\d{1,3})\b/iu)?.[1] ?? 0,
      );
    if (!Number.isSafeInteger(cap) || cap < 0 || cap > 100)
      fail("INVENTORY_CAPABILITY");
    const u = new URL(row.normalizedUrl);
    u.hostname = u.hostname.toLowerCase();
    rows.push({
      endpoint: u.href,
      family: row.explicitFamily,
      premium: row.premium === true,
      capability: cap,
      inventoryOrder: row.order,
      transportClass: "DIRECT_HTTPS",
      headers: Object.fromEntries(
        Object.entries(row.headers || {}).sort(([a], [b]) =>
          a.localeCompare(b),
        ),
      ),
      kind: row.kind,
    });
  }
  for (const [order, line] of lines.entries())
    if (/\bkeyless[-_ ]relay\b/iu.test(line)) {
      const raw = line.match(/http:\/\/[^\s\]]+/iu)?.[0],
        family = line.match(/\bfamily\s*[:=]\s*([a-z0-9._-]+)/iu)?.[1],
        cap = Number(
          line.match(/\bcapability(?:rank)?\s*[:=]\s*(\d{1,3})/iu)?.[1] ?? 0,
        );
      if (
        !raw ||
        !family ||
        !new RegExp(POLICY.candidates.explicitFamily, "u").test(family) ||
        !Number.isSafeInteger(cap) ||
        cap < 0 ||
        cap > 100 ||
        /\[\s*header\s*:/iu.test(line)
      )
        fail("INVENTORY_RELAY");
      const u = new URL(raw),
        host = u.hostname.replace(/^\[|\]$/gu, "");
      if (
        u.protocol !== "http:" ||
        !u.port ||
        u.pathname !== "/" ||
        u.search !== "" ||
        u.username ||
        u.password ||
        u.hash ||
        !["127.0.0.1", "::1"].includes(host)
      )
        fail("INVENTORY_RELAY");
      rows.push({
        endpoint: u.href,
        family,
        premium: /\bpremium\b/iu.test(line),
        capability: cap,
        inventoryOrder: order,
        transportClass: "LOCALHOST_KEYLESS_RELAY",
        headers: {},
        kind: "KEYLESS_RELAY",
      });
    }
  if (rows.length > POLICY.inventory.maxRecords) fail("INVENTORY_RECORDS");
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.endpoint)) fail("INVENTORY_DUPLICATE");
    seen.add(row.endpoint);
  }
  return rows;
}
function selectCandidates(rows) {
  const pool = [...rows]
      .sort((a, b) => a.inventoryOrder - b.inventoryOrder)
      .slice(0, POLICY.inventory.eligibleMaximum),
    ranked = pool.sort(
      (a, b) =>
        b.capability - a.capability ||
        Number(b.premium) - Number(a.premium) ||
        a.inventoryOrder - b.inventoryOrder,
    ),
    selected = ranked.slice(0, 4);
  if (selected.length < 3 || new Set(selected.map((x) => x.family)).size < 2)
    fail("INVENTORY_FAMILIES");
  return selected.map(endpointHandle);
}

function ipv4(ip) {
  if (net.isIP(ip) !== 4) return null;
  return ip.split(".").reduce((n, x) => (n << 8n) | BigInt(x), 0n);
}
function ipv6(ip) {
  if (typeof ip !== "string" || ip.includes("%")) return null;
  let s = ip.replace(/^\[|\]$/gu, "").toLowerCase(),
    tail = s.match(/(\d{1,3}(?:\.\d{1,3}){3})$/u);
  if (tail) {
    const n = ipv4(tail[1]);
    if (n === null) return null;
    s = `${s.slice(0, -tail[1].length)}${(n >> 16n).toString(16)}:${(n & 65535n).toString(16)}`;
  }
  if (net.isIP(s) !== 6) return null;
  const side = s.split("::"),
    l = side[0] ? side[0].split(":") : [],
    r = side[1] ? side[1].split(":") : [],
    parts = [
      ...l,
      ...Array(side.length === 2 ? 8 - l.length - r.length : 0).fill("0"),
      ...r,
    ];
  if (side.length > 2 || parts.length !== 8) return null;
  return parts.reduce((n, x) => (n << 16n) | BigInt(`0x${x}`), 0n);
}
function format6(v) {
  const words = Array.from({ length: 8 }, (_, i) =>
    Number((v >> BigInt((7 - i) * 16)) & 65535n).toString(16),
  );
  let bestStart = -1,
    bestLen = 0;
  for (let i = 0; i < 8;) {
    if (words[i] !== "0") {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && words[j] === "0") j++;
    if (j - i > bestLen && j - i > 1) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  if (bestStart < 0) return words.join(":");
  const left = words.slice(0, bestStart).join(":"),
    right = words.slice(bestStart + bestLen).join(":");
  return `${left}::${right}`;
}
function normalizeIp(ip) {
  const raw = typeof ip === "string" ? ip.replace(/^\[|\]$/gu, "") : ip,
    v4 = ipv4(raw);
  if (v4 !== null)
    return {
      kind: 4,
      value: v4,
      text: [24n, 16n, 8n, 0n].map((s) => Number((v4 >> s) & 255n)).join("."),
      key: `04${v4.toString(16).padStart(8, "0")}`,
    };
  const v6 = ipv6(raw);
  if (v6 === null) return null;
  if (v6 >> 32n === 0xffffn)
    return normalizeIp(
      [24n, 16n, 8n, 0n]
        .map((s) => Number(((v6 & 0xffffffffn) >> s) & 255n))
        .join("."),
    );
  return {
    kind: 6,
    value: v6,
    text: format6(v6),
    key: `06${v6.toString(16).padStart(32, "0")}`,
  };
}
const in4 = (v, b, bits) =>
    v >> (32n - BigInt(bits)) === ipv4(b) >> (32n - BigInt(bits)),
  in6 = (v, b, bits) =>
    v >> (128n - BigInt(bits)) === ipv6(b) >> (128n - BigInt(bits));
function isGlobalUnicast(ip) {
  const n = normalizeIp(ip);
  if (!n) return false;
  if (n.kind === 4)
    return ![
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.31.196.0", 24],
      ["192.52.193.0", 24],
      ["192.88.99.0", 24],
      ["192.168.0.0", 16],
      ["192.175.48.0", 24],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4],
    ].some(([b, x]) => in4(n.value, b, x));
  return (
    in6(n.value, "2000::", 3) &&
    ![
      ["2001::", 23],
      ["2001:db8::", 32],
      ["2002::", 16],
      ["3fff::", 20],
    ].some(([b, x]) => in6(n.value, b, x))
  );
}
function sameIp(a, b) {
  const x = normalizeIp(a),
    y = normalizeIp(b);
  return !!x && !!y && x.key === y.key;
}
function collectSensitiveStrings(raw) {
  const set = new Set(),
    add = (v) => {
      if (typeof v !== "string" || v.length < 4) return;
      set.add(v.toLowerCase());
      try {
        const u = new URL(v);
        for (const x of [
          u.href,
          u.host,
          u.hostname,
          u.username,
          u.password,
          u.pathname,
          u.search,
          ...u.searchParams.keys(),
          ...u.searchParams.values(),
        ])
          if (x && x.length >= 4) set.add(x.toLowerCase());
      } catch (_) {}
    };
  (function walk(v) {
    if (typeof v === "string") return add(v);
    if (Array.isArray(v)) return v.forEach(walk);
    if (object(v)) Object.values(v).forEach(walk);
  })(raw);
  return set;
}
function assertSanitized(value, secrets) {
  const text = typeof value === "string" ? value : JSON.stringify(value),
    lower = text.toLowerCase();
  if (
    /(?:https?|wss):\/\//iu.test(text) ||
    /"(?:endpoint|headers?|operatorFamily|family|rawInventory|transportConfig)"\s*:/iu.test(
      text,
    )
  )
    fail("OUTPUT_UNSAFE");
  for (const secret of secrets)
    if (lower.includes(secret)) fail("OUTPUT_UNSAFE");
}

function account() {
  const per = new Map();
  let requests = 0,
    bytes = 0,
    active = 0,
    maxConcurrency = 0;
  return {
    begin(h) {
      requests++;
      active++;
      maxConcurrency = Math.max(maxConcurrency, active);
      per.set(h, (per.get(h) || 0) + 1);
      if (
        requests > POLICY.limits.outerRequests ||
        per.get(h) > POLICY.limits.outerEvidenceRequests ||
        active > 1
      )
        fail("OUTER_BUDGET");
    },
    end() {
      active--;
      if (active < 0) fail("OUTER_ACCOUNTING");
    },
    add(n) {
      if (
        !Number.isSafeInteger(n) ||
        n < 0 ||
        n > POLICY.limits.responseBytesPerRequest
      )
        fail("OUTER_BYTES");
      bytes += n;
      if (bytes > POLICY.limits.responseBytes) fail("OUTER_BYTES");
    },
    summary(handles) {
      return {
        requests,
        responseBytes: bytes,
        maxConcurrency,
        maxPerCandidateRequests: Math.max(
          ...handles.map((h) => per.get(h) || 0),
        ),
        perCandidate: handles.map((h, i) => ({
          candidateIndex: i,
          requests: per.get(h) || 0,
        })),
      };
    },
  };
}
async function resolvePins(handles, { resolve, deadline }) {
  const pins = new Map();
  for (const h of handles) {
    const c = privateConfig(h);
    if (c.transportClass !== "DIRECT_HTTPS") continue;
    const u = new URL(c.endpoint),
      origin = u.origin;
    if (pins.has(origin)) continue;
    deadline.check();
    let answers;
    try {
      answers = await resolve(u.hostname, {
        timeoutMs: Math.min(POLICY.limits.dnsMs, deadline.remaining()),
      });
    } catch (_) {
      fail("DNS_FAILURE");
    }
    if (
      !Array.isArray(answers) ||
      answers.length < 1 ||
      answers.length > POLICY.limits.dnsAddresses
    )
      fail("DNS_ANSWERS");
    const normalized = answers.map((x) => {
      const original = typeof x === "string" ? x : x?.address,
        n = normalizeIp(original);
      return n
        ? {
            address: String(original).replace(/^\[|\]$/gu, ""),
            family: n.kind,
            key: n.key,
          }
        : null;
    });
    if (normalized.some((x) => !x || !isGlobalUnicast(x.address)))
      fail("DNS_NOT_GLOBAL");
    const unique = [...new Map(normalized.map((x) => [x.key, x])).values()];
    pins.set(origin, { addresses: unique, chosen: unique[0] });
  }
  return pins;
}
function createTransport(
  httpPost,
  { pins, deadline, accounting, trace, usage },
) {
  let id = 0;
  return async (handle, method, params) => {
    if (
      !POLICY.rpcMethods.includes(method) ||
      !Array.isArray(params) ||
      /(?:trace|pending|override|sign|send)/iu.test(
        `${method}${canonical(params)}`,
      )
    )
      fail("RPC_FORBIDDEN");
    const c = privateConfig(handle),
      u = new URL(c.endpoint),
      pin = c.transportClass === "DIRECT_HTTPS" ? pins.get(u.origin) : null;
    if (c.transportClass === "DIRECT_HTTPS" && !pin) fail("RPC_PIN");
    accounting.begin(handle);
    try {
      deadline.check();
      const body = Buffer.from(
        JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      );
      if (body.length > 131072) fail("RPC_REQUEST_SIZE");
      const r = await httpPost({
        transportClass: c.transportClass,
        hostname: u.hostname.replace(/^\[|\]$/gu, ""),
        port: u.port,
        path: u.pathname + u.search,
        pin,
        approvedHeaders: c.headers,
        body,
        connectMs: Math.min(POLICY.limits.connectMs, deadline.remaining()),
        inactivityMs: Math.min(
          POLICY.limits.inactivityMs,
          deadline.remaining(),
        ),
        totalMs: Math.min(POLICY.limits.requestMs, deadline.remaining()),
      });
      exact(
        r,
        [
          "status",
          "headers",
          "body",
          "redirected",
          "remoteAddress",
          "tlsVersion",
          "elapsedMs",
          "counters",
        ],
        "RPC_RESPONSE_SCHEMA",
      );
      if (
        !object(r.headers) ||
        r.status !== 200 ||
        r.redirected !== false ||
        !Buffer.isBuffer(r.body) ||
        r.body.length > POLICY.limits.responseBytesPerRequest ||
        !/^application\/json(?:;\s*charset=utf-8)?$/iu.test(
          r.headers["content-type"],
        ) ||
        !["identity", undefined].includes(r.headers["content-encoding"]) ||
        Object.keys(r.headers).some((k) =>
          /^(?:location|set-cookie|www-authenticate|proxy-authenticate)$/iu.test(
            k,
          ),
        )
      )
        fail("RPC_HTTP");
      if (c.transportClass === "DIRECT_HTTPS") {
        if (
          !isGlobalUnicast(r.remoteAddress) ||
          !pin.addresses.some(
            (x) => x.key === normalizeIp(r.remoteAddress)?.key,
          ) ||
          !/^TLSv1\.[23]$/u.test(r.tlsVersion)
        )
          fail("RPC_TLS_DNS");
        usage.direct++;
      } else {
        if (
          !["127.0.0.1", "::1"].some((x) => sameIp(x, r.remoteAddress)) ||
          r.tlsVersion !== null
        )
          fail("RPC_RELAY");
        usage.relay++;
      }
      const counterKeys = [
        "dns",
        "socket",
        "connect",
        "tls",
        "data",
        "requestDestroyed",
        "socketDestroyed",
        "agentDestroyed",
      ];
      exact(r.counters, counterKeys, "RPC_COUNTERS");
      for (const k of counterKeys)
        if (!Number.isSafeInteger(r.counters[k]) || r.counters[k] < 0)
          fail("RPC_COUNTERS");
      if (
        r.counters.socket !== 1 ||
        r.counters.connect !== 1 ||
        r.counters.tls !== (c.transportClass === "DIRECT_HTTPS" ? 1 : 0) ||
        r.counters.data < 1 ||
        r.counters.agentDestroyed !== 1
      )
        fail("RPC_COUNTERS");
      if (
        !Number.isSafeInteger(r.elapsedMs) ||
        r.elapsedMs < 0 ||
        r.elapsedMs > POLICY.limits.requestMs
      )
        fail("RPC_ELAPSED");
      let payload;
      try {
        payload = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(r.body),
        );
      } catch (_) {
        fail("RPC_JSON");
      }
      exact(payload, ["jsonrpc", "id", "result"], "RPC_JSON_SCHEMA");
      if (payload.jsonrpc !== "2.0" || payload.id !== id) fail("RPC_JSON_ID");
      accounting.add(r.body.length);
      for (const k of counterKeys) usage.counters[k] += r.counters[k];
      trace.push({
        handle,
        method,
        params,
        result: payload.result,
        bytes: r.body.length,
        transportClass: c.transportClass,
        counters: clone(r.counters),
        elapsedMs: r.elapsedMs,
      });
      return { result: payload.result, bytes: r.body.length };
    } finally {
      accounting.end();
    }
  };
}

async function adapterProbes(handles, transport, clock) {
  const raw = async (...args) => {
    const value = await transport(...args);
    return object(value) && Object.hasOwn(value, "result")
      ? value.result
      : value;
  };
  for (const h of handles) {
    if ((await raw(h, "eth_chainId", [])) !== "0x1") fail("PROBE_CHAIN");
    const finalized = BASE.parseHeader(
      await raw(h, "eth_getBlockByNumber", ["finalized", false]),
    );
    if (
      finalized.timestamp < POLICY.expiryTimestamp ||
      finalized.timestamp < Math.floor(clock() / 1000) - 3600 ||
      finalized.timestamp > Math.floor(clock() / 1000) + 60
    )
      fail("PROBE_FINALIZED");
    const code = await raw(h, "eth_getCode", [
      PROFILE.ADDRESSES.morpho,
      block(finalized.hash),
    ]);
    if (typeof code !== "string" || !/^0x(?:[0-9a-f]{2})+$/u.test(code))
      fail("PROBE_CODE");
    const expiry = await raw(h, "eth_call", [
      { to: PROFILE.ADDRESSES.apxPt, data: `0x${PROFILE.SELECTORS.expiry}` },
      block(finalized.hash),
    ]);
    if (
      typeof expiry !== "string" ||
      !/^0x[0-9a-f]{64}$/u.test(expiry) ||
      BigInt(expiry) !== BigInt(POLICY.expiryTimestamp)
    )
      fail("PROBE_EXPIRY");
  }
}
function rankRows(rows) {
  return [...rows].sort(
    (a, b) =>
      b.handle.capabilityRank - a.handle.capabilityRank ||
      Number(b.handle.premium) - Number(a.handle.premium) ||
      a.handle.inventoryOrder - b.handle.inventoryOrder,
  );
}
function replayTrace(trace, artifact, handles, adapterCount) {
  let cursor = 0;
  const take = (handle, method, params, stage) => {
      const row = trace[cursor++];
      if (
        !row ||
        row.handle !== handle ||
        row.method !== method ||
        !same(row.params, params)
      )
        fail("TRACE_SCHEDULE");
      row.stageId = stage;
      return row;
    },
    header = (row, n = null) => {
      let h;
      try {
        h = BASE.parseHeader(row.result, n);
      } catch (_) {
        fail("TRACE_HEADER");
      }
      row.header = h;
      return h;
    },
    multi = (h, p, stage) => {
      const r = take(
        h,
        "eth_call",
        [{ to: BASE.MULTICALL3, data: BASE.GET_BLOCK_NUMBER }, block(p.hash)],
        stage,
      );
      if (
        typeof r.result !== "string" ||
        !/^0x[0-9a-f]{64}$/u.test(r.result) ||
        Number(BigInt(r.result)) !== p.number
      )
        fail("TRACE_MULTICALL");
    };
  for (let i = 0; i < handles.length; i++) {
    const h = handles[i],
      chain = take(h, "eth_chainId", [], "ADAPTER_CHAIN_ID");
    if (chain.result !== "0x1") fail("TRACE_ADAPTER");
    const f = header(
      take(
        h,
        "eth_getBlockByNumber",
        ["finalized", false],
        "ADAPTER_FINALIZED",
      ),
    );
    const code = take(
      h,
      "eth_getCode",
      [PROFILE.ADDRESSES.morpho, block(f.hash)],
      "ADAPTER_CODE",
    );
    if (typeof code.result !== "string" || code.result === "0x")
      fail("TRACE_ADAPTER");
    take(
      h,
      "eth_call",
      [
        { to: PROFILE.ADDRESSES.apxPt, data: `0x${PROFILE.SELECTORS.expiry}` },
        block(f.hash),
      ],
      "ADAPTER_EXPIRY",
    );
  }
  if (cursor !== adapterCount) fail("TRACE_ADAPTER_COUNT");
  const qualified = [];
  for (let i = 0; i < handles.length; i++) {
    const h = handles[i],
      chain = take(h, "eth_chainId", [], "ENGINE_QUAL_CHAIN_ID");
    if (chain.result !== "0x1") fail("TRACE_QUALIFICATION");
    const finalized = header(
        take(
          h,
          "eth_getBlockByNumber",
          ["finalized", false],
          "ENGINE_QUAL_FINALIZED",
        ),
      ),
      exactHeader = header(
        take(
          h,
          "eth_getBlockByNumber",
          [q(finalized.number), false],
          "ENGINE_QUAL_EXACT",
        ),
        finalized.number,
      );
    if (!same(finalized, exactHeader)) fail("TRACE_QUALIFICATION");
    multi(h, exactHeader, "ENGINE_QUAL_MULTICALL");
    qualified.push({ handle: h, index: i, finalized: exactHeader });
  }
  const heights = [...new Set(qualified.map((x) => x.finalized.number))].sort(
      (a, b) => b - a,
    ),
    commonPinSchedule = [];
  let common = null;
  for (const height of heights) {
    const eligible = qualified.filter((x) => x.finalized.number >= height),
      observed = [];
    for (const row of eligible) {
      const pin = header(
        take(
          row.handle,
          "eth_getBlockByNumber",
          [q(height), false],
          `ENGINE_COMMON_${height}`,
        ),
        height,
      );
      observed.push({ ...row, pin });
    }
    const groups = new Map();
    for (const row of observed) {
      const k = canonical(row.pin),
        g = groups.get(k) || [];
      g.push(row);
      groups.set(k, g);
    }
    const viable = [...groups.values()]
      .filter((g) => new Set(g.map((x) => x.handle.operatorFamily)).size >= 2)
      .sort(
        (a, b) =>
          b.length - a.length ||
          Math.min(...a.map((x) => x.handle.inventoryOrder)) -
            Math.min(...b.map((x) => x.handle.inventoryOrder)),
      )[0];
    commonPinSchedule.push({
      height,
      eligibleCandidateIndices: eligible.map((x) => x.index),
      observedCandidateIndices: observed.map((x) => x.index),
      agreementCandidateIndices: viable ? viable.map((x) => x.index) : [],
    });
    if (viable) {
      common = { pin: viable[0].pin, rows: viable };
      break;
    }
  }
  if (!common || !same(common.pin, artifact.pin)) fail("TRACE_COMMON_PIN");
  const evidence = (() => {
      const ranked = rankRows(common.rows),
        first = ranked[0],
        second = ranked.find(
          (x) => x.handle.operatorFamily !== first?.handle.operatorFamily,
        );
      if (!first || !second) fail("TRACE_EVIDENCE");
      return [first, second];
    })(),
    evidenceSet = new Set(evidence.map((x) => x.handle)),
    locator = rankRows(qualified).find((x) => !evidenceSet.has(x.handle));
  if (!locator) fail("TRACE_LOCATOR");
  const evidenceIndices = evidence.map((x) => x.index),
    locatorIndex = locator.index;
  if (
    new Set([...evidenceIndices, locatorIndex]).size !== 3 ||
    evidence[0].handle.operatorFamily === evidence[1].handle.operatorFamily
  )
    fail("TRACE_SELECTION");
  const binarySearch = [];
  let low = 1,
    high = artifact.pin.number;
  while (low < high) {
    const middle = Math.floor((low + high) / 2),
      h = header(
        take(
          locator.handle,
          "eth_getBlockByNumber",
          [q(middle), false],
          `ENGINE_LOCATOR_${middle}`,
        ),
        middle,
      );
    binarySearch.push({ candidateIndex: locatorIndex, height: middle });
    if (h.timestamp >= POLICY.expiryTimestamp) high = middle;
    else low = middle + 1;
  }
  if (low !== artifact.boundary.postBlock.number) fail("TRACE_LOCATOR_RESULT");
  for (const selected of evidence) {
    const idx = selected.index,
      pre = header(
        take(
          selected.handle,
          "eth_getBlockByNumber",
          [q(artifact.boundary.preBlock.number), false],
          `ENGINE_EVIDENCE_${idx}_PRE_HEADER`,
        ),
        artifact.boundary.preBlock.number,
      ),
      post = header(
        take(
          selected.handle,
          "eth_getBlockByNumber",
          [q(artifact.boundary.postBlock.number), false],
          `ENGINE_EVIDENCE_${idx}_POST_HEADER`,
        ),
        artifact.boundary.postBlock.number,
      );
    if (
      !same(pre, artifact.boundary.preBlock) ||
      !same(post, artifact.boundary.postBlock)
    )
      fail("TRACE_BOUNDARY");
    multi(selected.handle, pre, `ENGINE_EVIDENCE_${idx}_PRE_MULTICALL`);
    multi(selected.handle, post, `ENGINE_EVIDENCE_${idx}_POST_MULTICALL`);
    for (const op of PROFILE.profile.operations) {
      take(
        selected.handle,
        op.kind === "call" ? "eth_call" : "eth_getCode",
        op.kind === "call"
          ? [{ to: op.address, data: op.data }, block(pre.hash)]
          : [op.address, block(pre.hash)],
        `ENGINE_EVIDENCE_${idx}_OP_${op.id}_PRE`,
      );
      take(
        selected.handle,
        op.kind === "call" ? "eth_call" : "eth_getCode",
        op.kind === "call"
          ? [{ to: op.address, data: op.data }, block(post.hash)]
          : [op.address, block(post.hash)],
        `ENGINE_EVIDENCE_${idx}_OP_${op.id}_POST`,
      );
    }
  }
  for (const selected of evidence)
    multi(
      selected.handle,
      artifact.pin,
      `ENGINE_POST_COMMON_${selected.index}`,
    );
  for (const selected of evidence) {
    const idx = selected.index,
      f = header(
        take(
          selected.handle,
          "eth_getBlockByNumber",
          ["finalized", false],
          `ENGINE_TERMINAL_${idx}_FINALIZED`,
        ),
      );
    if (f.number < artifact.pin.number) fail("TRACE_TERMINAL");
    const pin = header(
      take(
        selected.handle,
        "eth_getBlockByNumber",
        [q(artifact.pin.number), false],
        `ENGINE_TERMINAL_${idx}_PIN_HEADER`,
      ),
      artifact.pin.number,
    );
    if (!same(pin, artifact.pin)) fail("TRACE_TERMINAL");
    multi(selected.handle, pin, `ENGINE_TERMINAL_${idx}_PIN_MULTICALL`);
    for (const [side, h] of [
      ["PRE", artifact.boundary.preBlock],
      ["POST", artifact.boundary.postBlock],
    ]) {
      const exactHeader = header(
        take(
          selected.handle,
          "eth_getBlockByNumber",
          [q(h.number), false],
          `ENGINE_TERMINAL_${idx}_${side}_HEADER`,
        ),
        h.number,
      );
      if (!same(exactHeader, h)) fail("TRACE_TERMINAL");
      multi(selected.handle, h, `ENGINE_TERMINAL_${idx}_${side}_MULTICALL`);
    }
  }
  if (cursor !== trace.length) fail("TRACE_TRAILING");
  return {
    locatorIndex,
    evidenceIndices,
    commonPinSchedule,
    binarySearch,
    adapterRequests: adapterCount,
    engineRequests: trace.length - adapterCount,
  };
}
function sanitizedTranscript(trace, handles) {
  return trace.map((row, sequence) => {
    const candidateIndex = handles.indexOf(row.handle);
    if (candidateIndex < 0 || typeof row.stageId !== "string")
      fail("TRANSCRIPT_CANDIDATE");
    const isHeader = row.method === "eth_getBlockByNumber",
      headerValue = isHeader ? row.header : null,
      tag = isHeader
        ? row.params[0] === "finalized"
          ? "finalized"
          : Number(BigInt(row.params[0]))
        : null,
      blockHash =
        !isHeader && object(row.params.at(-1))
          ? row.params.at(-1).blockHash
          : null;
    return {
      sequence: sequence + 1,
      candidateIndex,
      stageId: row.stageId,
      methodKind:
        row.method === "eth_chainId"
          ? "CHAIN_ID"
          : isHeader
            ? "HEADER"
            : row.method === "eth_call"
              ? "CALL"
              : "CODE",
      blockTag: tag,
      blockHash: blockHash || null,
      header: headerValue ? clone(headerValue) : null,
      outcome: "SUCCESS",
      bytes: row.bytes,
      elapsedMs: row.elapsedMs,
      transportClass: row.transportClass,
      counters: clone(row.counters),
    };
  });
}

function qualifyPlatform(root, ops = fs, { platform = process.platform } = {}) {
  if (platform !== "linux") fail("PLATFORM_LINUX");
  const real = ops.realpathSync(path.resolve(root));
  if (
    POLICY.platform.forbiddenPathPrefixes.some((x) => `${real}/`.startsWith(x))
  )
    fail("PLATFORM_PATH");
  return real;
}
function decodeMountInfoField(value) {
  return value.replace(/\\(040|011|012|134)/gu, (_m, code) =>
    ({ "040": " ", "011": "\t", "012": "\n", "134": "\\" })[code],
  );
}
function parseMountInfo(text, target) {
  const rows = [];
  for (const line of String(text).split("\n")) {
    if (!line) continue;
    const fields = line.split(" "),
      dash = fields.indexOf("-");
    if (
      dash < 6 ||
      fields.length < dash + 3 ||
      !/^\d+$/u.test(fields[0]) ||
      !/^\d+:\d+$/u.test(fields[2])
    )
      fail("MOUNTINFO_INVALID");
    rows.push({
      mountId: Number(fields[0]),
      majorMinor: fields[2],
      root: decodeMountInfoField(fields[3]),
      mountPoint: decodeMountInfoField(fields[4]),
      fsType: fields[dash + 1],
      source: decodeMountInfoField(fields[dash + 2]),
    });
  }
  const normalized = path.posix.resolve(
      String(target).replaceAll("\\", "/").replace(/^[A-Za-z]:/u, ""),
    ),
    matches = rows
      .filter(
        (row) =>
          normalized === row.mountPoint ||
          normalized.startsWith(`${row.mountPoint.replace(/\/$/u, "")}/`),
      )
      .sort((a, b) => b.mountPoint.length - a.mountPoint.length);
  if (!matches.length || matches[1]?.mountPoint.length === matches[0].mountPoint.length)
    fail("MOUNTINFO_AMBIGUOUS");
  const row = matches[0];
  if (
    !POLICY.input.mountPolicy.filesystems.includes(row.fsType) ||
    /^(?:overlay|ext2|ext3|9p|v9fs|drvfs|fuse(?:\..*)?|nfs\d*|cifs|smb\d*)$/iu.test(
      row.fsType,
    )
  )
    fail("MOUNTINFO_FILESYSTEM");
  return Object.freeze(row);
}
function mountIdentityFor(target, ops = fs) {
  const text =
    typeof ops.mountInfoText === "string"
      ? ops.mountInfoText
      : ops.readFileSync("/proc/self/mountinfo", "utf8");
  return parseMountInfo(text, target);
}
function linuxDeviceMajorMinor(device) {
  const value = BigInt(device),
    major = ((value >> 8n) & 0xfffn) | ((value >> 32n) & ~0xfffn),
    minor = (value & 0xffn) | ((value >> 12n) & ~0xffn);
  return `${major}:${minor}`;
}
function qualifyRuntimeFile(
  target,
  ops = fs,
  { platform = process.platform, procRoot = "/proc/self/fd" } = {},
) {
  if (platform !== "linux" || !path.posix.isAbsolute(target))
    fail("RUNTIME_FILE_PLATFORM");
  let fd;
  try {
    const real = ops.realpathSync(target),
      leaf = ops.lstatSync(target);
    if (
      real !== target ||
      leaf.isSymbolicLink() ||
      !leaf.isFile() ||
      leaf.uid !== POLICY.input.mountPolicy.uid ||
      leaf.nlink !== POLICY.input.mountPolicy.regularFileNlink ||
      (leaf.mode & 0o022) !== 0
    )
      fail("RUNTIME_FILE_AUTHORITY");
    fd = ops.openSync(
      target,
      (ops.constants || fs.constants).O_RDONLY |
        (ops.constants || fs.constants).O_NOFOLLOW,
    );
    const held = ops.fstatSync(fd),
      proc = path.posix.join(procRoot, String(fd)),
      procReal = ops.realpathSync(proc),
      mount = mountIdentityFor(target, ops);
    if (
      !held.isFile() ||
      held.dev !== leaf.dev ||
      held.ino !== leaf.ino ||
      held.uid !== POLICY.input.mountPolicy.uid ||
      held.nlink !== POLICY.input.mountPolicy.regularFileNlink ||
      (held.mode & 0o022) !== 0 ||
      procReal !== target ||
      linuxDeviceMajorMinor(held.dev) !== mount.majorMinor
    )
      fail("RUNTIME_FILE_IDENTITY");
    return Object.freeze({ path: target, dev: held.dev, ino: held.ino, mount });
  } catch (e) {
    if (e instanceof ProductionError) throw e;
    fail("RUNTIME_FILE_AUTHORITY");
  } finally {
    if (fd !== undefined)
      try {
        ops.closeSync(fd);
      } catch (_) {}
  }
}
function assertExecutedCapture(
  bridge,
  ops = fs,
  { platform = process.platform, argv1 = process.argv[1], procRoot = "/proc/self/fd" } = {},
) {
  if (
    argv1 !== POLICY.input.capturePath ||
    bridge.productionCapturePath !== POLICY.input.capturePath ||
    !Array.isArray(bridge.runtimeFilePaths) ||
    !bridge.runtimeFilePaths.includes(POLICY.input.capturePath)
  )
    fail("EXECUTED_CAPTURE_PATH");
  const authority = qualifyRuntimeFile(argv1, ops, { platform, procRoot });
  if (
    String(authority.dev) !== bridge.productionCaptureIdentity.dev ||
    String(authority.ino) !== bridge.productionCaptureIdentity.ino ||
    canonical(authority.mount) !== canonical(bridge.nativeMountIdentity)
  )
    fail("EXECUTED_CAPTURE_IDENTITY");
  let fd;
  try {
    fd = ops.openSync(
      argv1,
      (ops.constants || fs.constants).O_RDONLY |
        (ops.constants || fs.constants).O_NOFOLLOW,
    );
    const before = ops.fstatSync(fd),
      bytes = ops.readFileSync(fd),
      after = ops.fstatSync(fd);
    if (
      before.dev !== authority.dev ||
      before.ino !== authority.ino ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      sha256(bytes) !== bridge.productionCaptureSha256
    )
      fail("EXECUTED_CAPTURE_HASH");
    return Object.freeze({
      path: argv1,
      sha256: bridge.productionCaptureSha256,
      dev: String(before.dev),
      ino: String(before.ino),
    });
  } catch (error) {
    if (error instanceof ProductionError) throw error;
    fail("EXECUTED_CAPTURE_HASH");
  } finally {
    if (fd !== undefined)
      try {
        ops.closeSync(fd);
      } catch (_) {}
  }
}
function assertOutputAnchor(
  anchor,
  ops = fs,
  { procRoot = "/proc/self/fd", stage = "OUTPUT" } = {},
) {
  if (!object(anchor) || !Number.isSafeInteger(anchor.fd) || anchor.closed)
    fail(`${stage}_ANCHOR`);
  let s, real, mount;
  try {
    s = ops.fstatSync(anchor.fd);
    real = ops.realpathSync(path.join(procRoot, String(anchor.fd)));
    mount = mountIdentityFor(real, ops);
  } catch (_) {
    fail(`${stage}_ANCHOR`);
  }
  if (
    !s.isDirectory() ||
    s.dev !== anchor.dev ||
    s.ino !== anchor.ino ||
    real !== anchor.realPath ||
    canonical(mount) !== canonical(anchor.mount)
  )
    fail(`${stage}_ANCHOR_CHANGED`);
  return path.join(procRoot, String(anchor.fd));
}
function acquireLock(anchor, nonce, ops = fs, options = {}) {
  const proc = assertOutputAnchor(anchor, ops, { ...options, stage: "LOCK" });
  let fd;
  try {
    fd = ops.openSync(path.join(proc, POLICY.output.lock), "wx", 0o600);
    ops.writeFileSync(fd, `${nonce}\n`);
    ops.fsyncSync(fd);
    ops.closeSync(fd);
    fd = undefined;
    assertOutputAnchor(anchor, ops, { ...options, stage: "LOCK" });
    ops.fsyncSync(anchor.fd);
    return { committed: true };
  } catch (e) {
    if (e instanceof ProductionError) throw e;
    if (e?.code === "EEXIST") fail("ONE_SHOT_USED");
    fail("LOCK_FAILURE");
  } finally {
    if (fd !== undefined)
      try {
        ops.closeSync(fd);
      } catch (_) {}
  }
}
function publishBundle(anchor, bundle, runId, ops = fs, options = {}) {
  const proc = assertOutputAnchor(anchor, ops, {
      ...options,
      stage: "PUBLISH",
    }),
    name = `${POLICY.output.runPrefix}${runId}`;
  let runFd,
    fileFd,
    committed = false;
  const close = (fd) => {
    if (fd !== undefined)
      try {
        ops.closeSync(fd);
      } catch (_) {
        if (committed) fail("COMMITTED_DURABILITY_UNCERTAIN");
      }
  };
  try {
    ops.mkdirSync(path.join(proc, name), { mode: 0o700 });
    assertOutputAnchor(anchor, ops, { ...options, stage: "PUBLISH" });
    runFd = ops.openSync(
      path.join(proc, name),
      (ops.constants || fs.constants).O_RDONLY |
        (ops.constants || fs.constants).O_DIRECTORY |
        (ops.constants || fs.constants).O_NOFOLLOW,
    );
    const runProc = path.join(
        options.procRoot || "/proc/self/fd",
        String(runFd),
      ),
      runStat = ops.fstatSync(runFd),
      verifyRun = () => {
        assertOutputAnchor(anchor, ops, { ...options, stage: "PUBLISH" });
        const s = ops.fstatSync(runFd);
        if (!s.isDirectory() || s.dev !== runStat.dev || s.ino !== runStat.ino)
          fail("PUBLISH_RUN_CHANGED");
      };
    verifyRun();
    for (const [key, file] of [
      ["capture", "capture.json"],
      ["validation", "validation.json"],
      ["manifest", "manifest.json"],
    ]) {
      verifyRun();
      const tmp = path.join(runProc, `${file}.tmp`),
        final = path.join(runProc, file);
      fileFd = ops.openSync(tmp, "wx", 0o600);
      ops.writeFileSync(fileFd, `${JSON.stringify(bundle[key], null, 2)}\n`);
      ops.fsyncSync(fileFd);
      ops.closeSync(fileFd);
      fileFd = undefined;
      verifyRun();
      ops.linkSync(tmp, final);
      const a = ops.lstatSync(tmp),
        b = ops.lstatSync(final);
      if (a.dev !== b.dev || a.ino !== b.ino) fail("PUBLISH_INODE");
      ops.unlinkSync(tmp);
      ops.fsyncSync(runFd);
    }
    verifyRun();
    fileFd = ops.openSync(path.join(runProc, "COMMITTED.tmp"), "wx", 0o600);
    ops.writeFileSync(fileFd, "COMMITTED\n");
    ops.fsyncSync(fileFd);
    ops.closeSync(fileFd);
    fileFd = undefined;
    verifyRun();
    ops.linkSync(
      path.join(runProc, "COMMITTED.tmp"),
      path.join(runProc, "COMMITTED"),
    );
    committed = true;
    ops.unlinkSync(path.join(runProc, "COMMITTED.tmp"));
    ops.fsyncSync(runFd);
    ops.fsyncSync(anchor.fd);
    return { name };
  } catch (e) {
    if (
      committed &&
      !(
        e instanceof ProductionError &&
        e.code === "COMMITTED_DURABILITY_UNCERTAIN"
      )
    )
      fail("COMMITTED_DURABILITY_UNCERTAIN");
    if (e instanceof ProductionError) throw e;
    fail("PUBLISH_FAILURE");
  } finally {
    close(fileFd);
    close(runFd);
  }
}

function publishBundleSafe(anchor, bundle, runId, ops = fs, options = {}) {
  const proc = assertOutputAnchor(anchor, ops, {
      ...options,
      stage: "PUBLISH",
    }),
    name = `${POLICY.output.runPrefix}${runId}`;
  let runFd,
    fileFd,
    committed = false,
    result,
    pending;
  try {
    ops.mkdirSync(path.join(proc, name), { mode: 0o700 });
    assertOutputAnchor(anchor, ops, { ...options, stage: "PUBLISH" });
    runFd = ops.openSync(
      path.join(proc, name),
      (ops.constants || fs.constants).O_RDONLY |
        (ops.constants || fs.constants).O_DIRECTORY |
        (ops.constants || fs.constants).O_NOFOLLOW,
    );
    const runProc = path.join(
        options.procRoot || "/proc/self/fd",
        String(runFd),
      ),
      runStat = ops.fstatSync(runFd),
      verify = () => {
        assertOutputAnchor(anchor, ops, { ...options, stage: "PUBLISH" });
        const current = ops.fstatSync(runFd);
        if (
          !current.isDirectory() ||
          current.dev !== runStat.dev ||
          current.ino !== runStat.ino
        )
          fail("PUBLISH_RUN_CHANGED");
      };
    verify();
    for (const [key, file] of [
      ["capture", "capture.json"],
      ["validation", "validation.json"],
      ["manifest", "manifest.json"],
    ]) {
      verify();
      const tmp = path.join(runProc, `${file}.tmp`),
        final = path.join(runProc, file);
      fileFd = ops.openSync(tmp, "wx", 0o600);
      ops.writeFileSync(fileFd, `${JSON.stringify(bundle[key], null, 2)}\n`);
      ops.fsyncSync(fileFd);
      ops.closeSync(fileFd);
      fileFd = undefined;
      verify();
      ops.linkSync(tmp, final);
      const a = ops.lstatSync(tmp),
        b = ops.lstatSync(final);
      if (a.dev !== b.dev || a.ino !== b.ino) fail("PUBLISH_INODE");
      ops.unlinkSync(tmp);
      ops.fsyncSync(runFd);
    }
    verify();
    fileFd = ops.openSync(path.join(runProc, "COMMITTED.tmp"), "wx", 0o600);
    ops.writeFileSync(fileFd, "COMMITTED\n");
    ops.fsyncSync(fileFd);
    ops.closeSync(fileFd);
    fileFd = undefined;
    verify();
    ops.linkSync(
      path.join(runProc, "COMMITTED.tmp"),
      path.join(runProc, "COMMITTED"),
    );
    committed = true;
    ops.unlinkSync(path.join(runProc, "COMMITTED.tmp"));
    ops.fsyncSync(runFd);
    ops.fsyncSync(anchor.fd);
    result = { name };
  } catch (error) {
    pending = committed
      ? new ProductionError("COMMITTED_DURABILITY_UNCERTAIN")
      : error instanceof ProductionError
        ? error
        : new ProductionError("PUBLISH_FAILURE");
  } finally {
    const closeFailures = [];
    for (const fd of [fileFd, runFd])
      if (fd !== undefined)
        try {
          ops.closeSync(fd);
        } catch (error) {
          closeFailures.push(error);
        }
    if (closeFailures.length)
      pending = committed
        ? new ProductionError("COMMITTED_DURABILITY_UNCERTAIN")
        : pending || new ProductionError("PUBLISH_DESCRIPTOR_CLOSE");
  }
  if (pending) throw pending;
  return result;
}
publishBundle = publishBundleSafe;

async function runBridgeProduction(o) {
  const clock = o.clock || Date.now,
    deadline = createDeadline(clock),
    nonce = validateInvocation(o),
    acquiredAt = clock();
  let anchor, preludeFrame, prelude, frame, inventoryBytes, executedCapture,
    goClosed = false;
  try {
    preludeFrame = readBridgePrelude(o.fsOps, POLICY.input.fd);
    prelude = parseBridgePrelude(preludeFrame, { nonce });
    const permit = parseCanonical(
      o.readFixed(
        o.workspaceRoot,
        POLICY.permit.path,
        POLICY.permit.maxBytes,
        o.fsOps,
      ),
      POLICY.permit.maxBytes,
      "PERMIT_JSON",
    );
    validatePermit(permit, { nonce, bindings: o.bindings, now: acquiredAt });
    if (
      prelude.broker !== permit.bridge.nativeSupervisorRuntimeSha256 ||
      prelude.launcher !== permit.bridge.launcherBinarySha256
    )
      fail("BRIDGE_SELF_HASH");
    if (process.version !== POLICY.input.nodeVersion)
      fail("BRIDGE_NODE_VERSION");
    if (o.testOnlyBridge !== true || o.executedCapturePath)
      executedCapture = assertExecutedCapture(permit.bridge, o.fsOps, {
        platform: o.platform,
        argv1: o.executedCapturePath || process.argv[1],
        procRoot: o.captureProcRoot || "/proc/self/fd",
      });
    const runtimeExecPath =
      o.testOnlyBridge === true ? o.runtimeExecPath : process.execPath;
    if (
      runtimeExecPath !== POLICY.input.nodePath ||
      canonical(mountIdentityFor(runtimeExecPath, o.fsOps)) !==
        canonical(permit.bridge.nativeMountIdentity)
    )
      fail("BRIDGE_NATIVE_MOUNT");
    const root = qualifyPlatform(o.workspaceRoot, o.fsOps, {
      platform: o.platform,
    });
    anchor = o.qualifyOutput(root, o.fsOps, { platform: o.platform });
    if (!object(anchor) || !Number.isSafeInteger(anchor.fd))
      fail("OUTPUT_ANCHOR");
    if (canonical(anchor.mount) !== canonical(permit.bridge.nativeMountIdentity))
      fail("OUTPUT_NATIVE_MOUNT");
    o.durability(anchor, o.fsOps, nonce);
    deadline.check();
    acquireLock(anchor, nonce, o.fsOps, o.lockOptions);
    const goFrame = buildBridgeGo(preludeFrame),
      goFrameCommitment = sha256(goFrame);
    writeBridgeGo(preludeFrame, o.fsOps, POLICY.input.goFd);
    goFrame.fill(0);
    goClosed = true;
    frame = readBridgeFd3(o.fsOps, POLICY.input.fd);
    inventoryBytes = parseBridgeFrame(frame, {
      nonce,
      bridge: permit.bridge,
      expectedLength: prelude,
    });
    const rawRows = parseInventory(inventoryBytes),
      handles = selectCandidates(rawRows);
    deadline.check();
    const pins = await resolvePins(handles, {
        resolve: o.resolveDns,
        deadline,
      }),
      trace = [],
      accounting = account(),
      usage = {
        direct: 0,
        relay: 0,
        dnsQualifications: pins.size,
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
      },
      transport = createTransport(o.httpPost, {
        pins,
        deadline,
        accounting,
        trace,
        usage,
      }),
      secretCorpus = collectSensitiveStrings(rawRows);
    await adapterProbes(handles, transport, clock);
    const adapterCount = trace.length,
      result = await ENGINE.runGate({
        profile: PROFILE.profile,
        candidates: handles,
        transport,
        clock,
      }),
      selection = replayTrace(trace, result.artifact, handles, adapterCount);
    OFFLINE_VALIDATOR.validateArtifact(result.artifact, { now: clock() });
    assertSanitized(result.serialized, secretCorpus);
    const outer = accounting.summary(handles),
      transcript = sanitizedTranscript(trace, handles),
      completedAt = clock(),
      engineContext = {
        candidateCount: handles.length,
        familyTokens: handles.map((handle) => handle.operatorFamily),
        ranking: handles.map((handle, candidateIndex) => ({
          candidateIndex,
          capabilityRank: handle.capabilityRank,
          premium: handle.premium,
          inventoryOrder: handle.inventoryOrder,
        })),
      },
      acquisition = {
        permitId: permit.permitId,
        approvalNonceCommitment: permit.approvalNonceCommitment,
        issuedAt: permit.issuedAt,
        notBefore: permit.notBefore,
        expiresAt: permit.expiresAt,
        acquiredAt,
        completedAt,
        inputMode: POLICY.input.mode,
        nativeSupervisorPipeFifo: true,
        hashesVerified: true,
        inventoryFallbackUsed: false,
        exclusiveWriterFramedGo: true,
        windowsPeerEofRequired: false,
        linuxWriterClosedAfterGo: true,
        bufferedTrailingBytesRejected: true,
        postGoChannelMonitored: true,
        inventoryReadAfterPermanentLock: true,
        goFrameCommitment,
        executedCapture:
          executedCapture || {
            path: permit.bridge.productionCapturePath,
            sha256: permit.bridge.productionCaptureSha256,
            dev: permit.bridge.productionCaptureIdentity.dev,
            ino: permit.bridge.productionCaptureIdentity.ino,
          },
      };
    usage.elapsedMs = deadline.elapsed();
    usage.retries = 0;
    const validation = o.productionValidator.validateProduction(
        result.artifact,
        {
          permit,
          bindings: o.bindings,
          outer,
          transcript,
          usage,
          selection,
          engineContext,
          acquisition,
          now: completedAt,
        },
      ),
      manifest = o.productionValidator.buildManifest(
        result.artifact,
        validation,
        permit,
      ),
      bundle = { capture: result.artifact, validation, manifest };
    assertSanitized(bundle, secretCorpus);
    const runId = sha256(
      canonical({
        permitId: permit.permitId,
        acquiredAt,
        selection,
        artifact: result.artifact.integrity.payloadHash,
      }),
    ).slice(0, 24);
    publishBundle(anchor, bundle, runId, o.fsOps, o.publishOptions);
    return { capture: result.artifact, validation, manifest, outer, selection };
  } finally {
    if (inventoryBytes) inventoryBytes.fill(0);
    if (frame) frame.fill(0);
    if (preludeFrame) preludeFrame.fill(0);
    if (!goClosed)
      try {
        o.fsOps.closeSync(POLICY.input.goFd);
      } catch (_) {}
    try {
      o.fsOps.closeSync(POLICY.input.fd);
    } catch (_) {}
    if (anchor && Number.isSafeInteger(anchor.fd) && !anchor.closed) {
      try {
        o.fsOps.closeSync(anchor.fd);
        anchor.closed = true;
      } catch (_) {}
    }
  }
}

async function runCore(o, { testOnly = false } = {}) {
  const clock = o.clock || Date.now,
    deadline = createDeadline(clock),
    nonce = validateInvocation(o),
    acquiredAt = clock();
  let anchor;
  try {
    const permitBytes = o.readFixed(
        o.workspaceRoot,
        testOnly ? "synthetic-permit.json" : POLICY.permit.path,
        POLICY.permit.maxBytes,
        o.fsOps,
      ),
      permit = parseCanonical(
        permitBytes,
        POLICY.permit.maxBytes,
        "PERMIT_JSON",
      );
    if (testOnly) {
      if (
        permit.schema === POLICY.permit.schema ||
        path.resolve(o.output || "") ===
          path.resolve(o.workspaceRoot, POLICY.output.root)
      )
        fail("TEST_ONLY_PRODUCTION_FORBIDDEN");
    } else
      validatePermit(permit, { nonce, bindings: o.bindings, now: acquiredAt });
    const root = qualifyPlatform(o.workspaceRoot, o.fsOps, {
      platform: o.platform,
    });
    anchor = o.qualifyOutput(root, o.fsOps, {
      platform: o.platform,
      output: testOnly ? o.output : undefined,
    });
    if (!object(anchor) || !Number.isSafeInteger(anchor.fd))
      fail("OUTPUT_ANCHOR");
    o.durability(anchor, o.fsOps, nonce);
    const inventoryBytes = o.readFixed(
        root,
        POLICY.inventory.path,
        POLICY.inventory.maxBytes,
        o.fsOps,
      ),
      rawRows = parseInventory(inventoryBytes),
      handles = selectCandidates(rawRows);
    deadline.check();
    if (!testOnly) acquireLock(anchor, nonce, o.fsOps, o.lockOptions);
    const pins = await resolvePins(handles, {
        resolve: o.resolveDns,
        deadline,
      }),
      trace = [],
      accounting = account(),
      usage = {
        direct: 0,
        relay: 0,
        dnsQualifications: pins.size,
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
      },
      transport = createTransport(o.httpPost, {
        pins,
        deadline,
        accounting,
        trace,
        usage,
      }),
      secretCorpus = collectSensitiveStrings(rawRows);
    await adapterProbes(handles, transport, clock);
    const adapterCount = trace.length,
      result = await ENGINE.runGate({
        profile: PROFILE.profile,
        candidates: handles,
        transport,
        clock,
      });
    const selection = replayTrace(
      trace,
      result.artifact,
      handles,
      adapterCount,
    );
    OFFLINE_VALIDATOR.validateArtifact(result.artifact, { now: clock() });
    assertSanitized(result.serialized, secretCorpus);
    const outer = accounting.summary(handles),
      transcript = sanitizedTranscript(trace, handles),
      completedAt = clock(),
      engineContext = {
        candidateCount: handles.length,
        familyTokens: handles.map((h) => h.operatorFamily),
        ranking: handles.map((h, i) => ({
          candidateIndex: i,
          capabilityRank: h.capabilityRank,
          premium: h.premium,
          inventoryOrder: h.inventoryOrder,
        })),
      },
      acquisition = {
        permitId: testOnly ? null : permit.permitId,
        approvalNonceCommitment: testOnly
          ? null
          : permit.approvalNonceCommitment,
        issuedAt: testOnly ? null : permit.issuedAt,
        notBefore: testOnly ? null : permit.notBefore,
        expiresAt: testOnly ? null : permit.expiresAt,
        acquiredAt,
        completedAt,
      };
    usage.elapsedMs = deadline.elapsed();
    usage.retries = 0;
    if (testOnly) {
      if (o.observeTest !== undefined && typeof o.observeTest !== "function")
        fail("TEST_OBSERVER");
      if (o.observeTest)
        o.observeTest({
          capture: result.artifact,
          outer,
          transcript,
          usage,
          selection,
          engineContext,
          acquisition,
        });
      return {
        schema: "morpho-pt-27aug2026-post-expiry-r1-production-test-only/v1",
        status: "TEST_ONLY",
        publishable: false,
        operations: PROFILE.profile.operations.length,
        candidateCount: handles.length,
        outer,
        transcript,
        selection,
        usage,
      };
    }
    const validation = o.productionValidator.validateProduction(
        result.artifact,
        {
          permit,
          bindings: o.bindings,
          outer,
          transcript,
          usage,
          selection,
          engineContext,
          acquisition,
          now: completedAt,
        },
      ),
      manifest = o.productionValidator.buildManifest(
        result.artifact,
        validation,
        permit,
      ),
      bundle = { capture: result.artifact, validation, manifest };
    assertSanitized(bundle, secretCorpus);
    const runId = sha256(
      canonical({
        permitId: permit.permitId,
        acquiredAt,
        selection,
        artifact: result.artifact.integrity.payloadHash,
      }),
    ).slice(0, 24);
    o.publisher
      ? o.publisher(anchor, bundle, runId, o.fsOps)
      : publishBundle(anchor, bundle, runId, o.fsOps, o.publishOptions);
    return { capture: result.artifact, validation, manifest, outer, selection };
  } finally {
    if (anchor && Number.isSafeInteger(anchor.fd) && !anchor.closed) {
      try {
        o.fsOps.closeSync(anchor.fd);
        anchor.closed = true;
      } catch (_) {}
    }
  }
}
function createEpochClock() {
  const wall = Date.now(),
    mono = process.hrtime.bigint();
  let last = wall;
  return () => {
    const next = wall + Number((process.hrtime.bigint() - mono) / 1000000n);
    if (next < last) fail("CLOCK_REGRESSION");
    last = next;
    return next;
  };
}
async function runNativeProduction() {
  if (arguments.length) fail("NATIVE_INJECTION_FORBIDDEN");
  const capture = require("../capture-morpho-pt-27aug2026-post-expiry-r1-production.js"),
    validator = require("../validate-morpho-pt-27aug2026-post-expiry-r1-production.js"),
    root = path.resolve(__dirname, "../.."),
    ops = capture.fsOps(),
    platform = process.platform,
    stdinBytes = await capture.readStdin(process.stdin);
  return runBridgeProduction({
    args: process.argv.slice(2),
    env: { ...process.env },
    execArgv: process.execArgv.slice(),
    stdinBytes,
    stdinIsPipe: !process.stdin.isTTY,
    workspaceRoot: root,
    fsOps: ops,
    platform,
    bindings: capture.bindings(root),
    clock: createEpochClock(),
    readFixed: (r, p, m, o) => safeReadLinux(r, p, m, o, { platform }),
    qualifyOutput: capture.qualifyOutput,
    durability: capture.durability,
    resolveDns: capture.resolveDns,
    httpPost: capture.strictRequest,
    productionValidator: validator,
  });
}
async function runLockedSyntheticTestOnly(o) {
  const nonce = validateInvocation(o);
  let anchor;
  try {
    const permit = parseCanonical(
      o.readFixed(
        o.workspaceRoot,
        "synthetic-permit.json",
        POLICY.permit.maxBytes,
        o.fsOps,
      ),
      POLICY.permit.maxBytes,
      "PERMIT_JSON",
    );
    if (
      permit.schema === POLICY.permit.schema ||
      path.resolve(o.output || "") ===
        path.resolve(o.workspaceRoot, POLICY.output.root)
    )
      fail("TEST_ONLY_PRODUCTION_FORBIDDEN");
    const root = qualifyPlatform(o.workspaceRoot, o.fsOps, {
      platform: o.platform,
    });
    anchor = o.qualifyOutput(root, o.fsOps, {
      platform: o.platform,
      output: o.output,
    });
    o.durability(anchor, o.fsOps, nonce);
    selectCandidates(
      parseInventory(
        o.readFixed(
          root,
          POLICY.inventory.path,
          POLICY.inventory.maxBytes,
          o.fsOps,
        ),
      ),
    );
    try {
      acquireLock(anchor, nonce, o.fsOps, o.lockOptions);
      fail("TEST_EXPECTED_PERMANENT_LOCK");
    } catch (error) {
      if (!(error instanceof ProductionError) || error.code !== "ONE_SHOT_USED")
        throw error;
      return {
        schema: "morpho-pt-27aug2026-post-expiry-r1-production-test-only/v1",
        status: "TEST_ONLY_LOCKED",
        publishable: false,
      };
    }
  } finally {
    if (anchor && Number.isSafeInteger(anchor.fd) && !anchor.closed) {
      try {
        o.fsOps.closeSync(anchor.fd);
        anchor.closed = true;
      } catch (_) {}
    }
  }
}
async function runSyntheticTestOnly(o = {}) {
  return o.assertExistingPermanentLock === true
    ? runLockedSyntheticTestOnly(o)
    : runCore(o, { testOnly: true });
}
module.exports = {
  POLICY,
  POLICY_HASH,
  ProductionError,
  canonical,
  sha256,
  parseCanonical,
  parseBridgePrelude,
  readBridgePrelude,
  buildBridgeGo,
  writeBridgeGo,
  parseBridgeFrame,
  readBridgeFd3,
  validateInvocation,
  createDeadline,
  safeReadLinux,
  validatePermit,
  parseInventory,
  selectCandidates,
  normalizeIp,
  sameIp,
  isGlobalUnicast,
  collectSensitiveStrings,
  assertSanitized,
  account,
  resolvePins,
  createTransport,
  adapterProbes,
  replayTrace,
  validateEngineTrace: replayTrace,
  sanitizedTranscript,
  qualifyPlatform,
  parseMountInfo,
  mountIdentityFor,
  linuxDeviceMajorMinor,
  qualifyRuntimeFile,
  assertExecutedCapture,
  assertOutputAnchor,
  acquireLock,
  publishBundle,
  runBridgeProduction,
  runNativeProduction,
  runSyntheticTestOnly,
};
