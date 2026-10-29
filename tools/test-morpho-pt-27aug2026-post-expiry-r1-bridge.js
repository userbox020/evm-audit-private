#!/usr/bin/env node
"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  crypto = require("node:crypto"),
  path = require("node:path");
const adapter = require("./lib/morpho-pt-27aug2026-post-expiry-r1-production-adapter.js"),
  supervisor = require("./invoke-morpho-pt-27aug2026-post-expiry-r1-production.js"),
  {
    POLICY,
  } = require("./morpho-pt-27aug2026-post-expiry-r1-production-policy.js");
let tests = 0,
  assertions = 0,
  mutations = 0;
const run = (...args) => {
    tests++;
    return test(...args);
  },
  a = new Proxy(assert, {
    get(target, key) {
      return typeof target[key] === "function"
        ? (...args) => {
            assertions++;
            return target[key](...args);
          }
        : target[key];
    },
  }),
  throws = (fn, code) => {
    assertions++;
    assert.throws(fn, (error) => error?.code === code);
  },
  rejects = async (fn, code) => {
    assertions++;
    await assert.rejects(fn, (error) => error?.code === code);
  };
const nonce = "0123456789abcdef".repeat(4),
  bridge = {
    nativeSupervisorRuntimeSha256: "07".repeat(32),
    launcherBinarySha256: "22".repeat(32),
  },
  payload = Buffer.from(
    "[keyless-relay family=test-family capabilityRank=1] http://127.0.0.1:8545/\n",
  );
function frame(data = payload) {
  const value = Buffer.alloc(POLICY.input.dataOverhead + data.length),
    auth = prelude(data.length),
    authCommitment = crypto.createHash("sha256").update(auth).digest();
  value.write(POLICY.input.dataMagic, 0, "ascii");
  value.writeUInt32LE(POLICY.input.dataVersion, 8);
  value.writeUInt32LE(POLICY.input.dataType, 12);
  value.writeUInt32LE(POLICY.input.dataSequence, 16);
  Buffer.from(nonce, "hex").copy(value, 20);
  Buffer.from(bridge.nativeSupervisorRuntimeSha256, "hex").copy(value, 52);
  Buffer.from(bridge.launcherBinarySha256, "hex").copy(value, 84);
  authCommitment.copy(value, 116);
  auth.copy(value, 148, 108, 148);
  data.copy(value, 188);
  value.write(POLICY.input.terminal, 188 + data.length, "ascii");
  return value;
}
function prelude(length = payload.length) {
  const value = Buffer.alloc(POLICY.input.preludeBytes);
  value.write(POLICY.input.preludeMagic, 0, "ascii");
  value.writeUInt32LE(POLICY.input.version, 8);
  Buffer.from(nonce, "hex").copy(value, 12);
  Buffer.from(bridge.nativeSupervisorRuntimeSha256, "hex").copy(value, 44);
  Buffer.from(bridge.launcherBinarySha256, "hex").copy(value, 76);
  value.writeUInt32LE(length, 108);
  value.write(POLICY.input.authTerminal, 148, "ascii");
  return value;
}
run(
  "policy fixes broker FD3 input mode and removes production inventory fallback",
  () => {
    a.equal(
      POLICY.input.mode,
      "NATIVE_WINDOWS_SUPERVISOR_BROKER_FD3_FD4_GO_AUTH_DATA_V4",
    );
    a.equal(POLICY.input.fd, 3);
    a.equal(POLICY.input.goFd, 4);
    a.equal(POLICY.input.exclusiveWriterFramedGo, true);
    a.equal(POLICY.input.windowsPeerEofRequired, false);
    a.equal(POLICY.inventory.path, "TEST_ONLY_NO_PRODUCTION_FALLBACK");
  },
);
run("adapter accepts exact launcher frame without hashing inventory", () => {
  const value = frame(),
    original = require("node:crypto").createHash;
  let updates = [];
  require("node:crypto").createHash = function (...args) {
    const h = original.apply(this, args),
      update = h.update;
    h.update = function (v, ...rest) {
      updates.push(Buffer.isBuffer(v) ? v.toString() : String(v));
      return update.call(this, v, ...rest);
    };
    return h;
  };
  try {
    a.deepEqual(
      adapter.parseBridgeFrame(value, {
        nonce,
        bridge,
        expectedLength: adapter.parseBridgePrelude(prelude(), { nonce, bridge }),
      }),
      payload,
    );
    a.equal(
      adapter.parseBridgePrelude(prelude(), { nonce, bridge }).length,
      payload.length,
    );
  } finally {
    require("node:crypto").createHash = original;
  }
  a.equal(
    updates.some((x) => x.includes("test-family")),
    false,
  );
});
run(
  "adapter rejects frame truncation extra marker nonce and selfhash mutations",
  () => {
    const reject = (value) => {
      assertions++;
      assert.throws(
        () =>
          adapter.parseBridgeFrame(value, {
            nonce,
            bridge,
            expectedLength: adapter.parseBridgePrelude(prelude(), { nonce, bridge }),
          }),
        (error) => /^BRIDGE_/u.test(error?.code || ""),
      );
    };
    let value = frame();
    mutations++;
    reject(value.subarray(0, value.length - 1));
    value = Buffer.concat([frame(), Buffer.from([0])]);
    mutations++;
    reject(value);
    value = frame();
    value[value.length - 1] ^= 1;
    mutations++;
    reject(value);
    value = frame();
    value[12] ^= 1;
    mutations++;
    reject(value);
    value = frame();
    value[44] ^= 1;
    mutations++;
    reject(value);
    for (const offset of [16, 84, 116]) {
      value = frame();
      value[offset] ^= 1;
      mutations++;
      reject(value);
    }
    value = frame();
    value.writeUInt32LE(POLICY.inventory.maxBytes + 1, 148);
    mutations++;
    reject(value);
  },
);
run("FD3 reader requires FIFO and exact EOF-bounded bytes", () => {
  const value = frame();
  let offset = 0;
  const ops = {
    fstatSync: () => ({ isFIFO: () => true }),
    readSync(_fd, target, start, length) {
      const count = Math.min(length, value.length - offset);
      if (!count) return 0;
      value.copy(target, start, offset, offset + count);
      offset += count;
      return count;
    },
  };
  a.deepEqual(adapter.readBridgeFd3(ops, 3), value);
  let go = Buffer.alloc(0);
  adapter.writeBridgeGo(
    prelude(),
    {
      fstatSync: () => ({ isFIFO: () => true }),
      writeSync(_fd, bytes, start, length) {
        go = Buffer.concat([go, bytes.subarray(start, start + length)]);
        return length;
      },
      closeSync() {},
    },
    4,
  );
  a.deepEqual(go, adapter.buildBridgeGo(prelude()));
  mutations++;
  throws(
    () =>
      adapter.readBridgeFd3({ fstatSync: () => ({ isFIFO: () => false }) }, 3),
    "BRIDGE_FD_TYPE",
  );
  mutations++;
  throws(
    () =>
      adapter.writeBridgeGo(
        prelude(),
        { fstatSync: () => ({ isFIFO: () => false }), closeSync() {} },
        4,
      ),
    "BRIDGE_GO_FD_TYPE",
  );
});
run("existing permanent lock closes before GO or inventory DATA", async () => {
  const productionHashes = Object.fromEntries(
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
      ].map((key, i) => [key, (i + 1).toString(16).padStart(2, "0").repeat(32)]),
    ),
    offlineHashes = Object.fromEntries(
      [
        "profile",
        "engine",
        "validator",
        "test",
        "disabledCapture",
        "sharedGate",
        "inventoryParser",
      ].map((key, i) => [key, (i + 20).toString(16).repeat(32)]),
    ),
    bindings = {
      productionHashes,
      offlineHashes,
      runtime: {
        nodeVersion: process.versions.node,
        platform: "linux",
        arch: process.arch,
        toolchain: `node-${process.versions.modules}`,
      },
      bridge: {
        inputMode: POLICY.input.mode,
        exclusiveWriterFramedGo: true,
        windowsPeerEofRequired: false,
        linuxWriterClosedAfterGo: true,
        bufferedTrailingBytesRejected: true,
        postGoChannelMonitored: true,
        inventoryReadAfterPermanentLock: true,
        goFrameLayout: {
          magic: POLICY.input.goMagic,
          version: POLICY.input.goVersion,
          type: POLICY.input.goType,
          sequence: POLICY.input.goSequence,
          bytes: POLICY.input.goBytes,
          terminal: POLICY.input.goTerminal,
          authCommitment: "SHA256_EXACT_PRELUDE",
        },
        nativeSupervisorDeadlineMs: POLICY.input.nativeSupervisorDeadlineMs,
        preGoDeadlineMs: POLICY.input.preGoDeadlineMs,
        postGoDeadlineMs: POLICY.input.postGoDeadlineMs,
        nativeSupervisorSourceSha256: productionHashes.nativeSupervisorSource,
        nativeSupervisorRuntimeSha256:
          productionHashes.nativeSupervisorStagedCopy,
        nativeSupervisorStagedCopySha256:
          productionHashes.nativeSupervisorStagedCopy,
        nativeBuildManifestSha256: productionHashes.nativeBuildManifest,
        launcherSourceSha256: productionHashes.launcherSource,
        launcherBinarySha256: bridge.launcherBinarySha256,
        nodeExecutableSha256: "33".repeat(32),
        nodeExecutablePath: POLICY.input.nodePath,
        nodeVersion: POLICY.input.nodeVersion,
        productionCapturePath: POLICY.input.capturePath,
        productionCaptureSha256: productionHashes.capture,
        productionCaptureIdentity: { dev: "1", ino: "2" },
        runtimeFilePaths: [POLICY.input.capturePath],
        nativeMountPolicy: POLICY.input.mountPolicy,
        nativeMountIdentity: {
          mountId: 1,
          majorMinor: "1:1",
          root: "/",
          mountPoint: "/",
          fsType: "ext4",
          source: "/dev/test",
        },
      },
    },
    now = POLICY.expiryTimestamp * 1000 + 1000,
    permit = {
      schema: POLICY.permit.schema,
      permitId: "aa".repeat(32),
      mode: POLICY.mode,
      approvalNonceCommitment: adapter.sha256(
        `morpho-production-nonce/v1\0${nonce}`,
      ),
      issuedAt: now - 100,
      notBefore: POLICY.expiryTimestamp * 1000,
      expiresAt: now + 1000,
      policyHash: adapter.POLICY_HASH,
      productionHashes,
      offlineHashes,
      runtime: bindings.runtime,
      bridge: bindings.bridge,
      policy: {
        hash: adapter.POLICY_HASH,
        profileHash: POLICY.profileHash,
        chainId: 1,
        expiryTimestamp: POLICY.expiryTimestamp,
        inputMode: POLICY.input.mode,
      },
      limits: POLICY.limits,
      schemas: POLICY.schemas,
      output: POLICY.output,
      hardStops: POLICY.hardStops,
    };
  const auth = prelude();
  let offset = 0,
    reads = 0,
    goWrites = 0,
    dns = 0,
    http = 0;
  const ops = {
    mountInfoText: "1 0 1:1 / / rw - ext4 /dev/test rw\n",
    fstatSync(fd) {
      if (fd === 3) return { isFIFO: () => true };
      if (fd === 10)
        return { isDirectory: () => true, dev: 1, ino: 2 };
      throw new Error("FD");
    },
    readSync(fd, target, start, length) {
      a.equal(fd, 3);
      reads++;
      const count = Math.min(length, auth.length - offset);
      auth.copy(target, start, offset, offset + count);
      offset += count;
      return count;
    },
    writeSync() {
      goWrites++;
      return 3;
    },
    closeSync() {},
    realpathSync(value) {
      if (String(value).replaceAll("\\", "/").endsWith("/proc/self/fd/10"))
        return "/safe/output";
      return value;
    },
    statfsSync: () => ({ type: 1, fsid: 2 }),
    openSync() {
      throw Object.assign(new Error("used"), { code: "EEXIST" });
    },
  };
  await rejects(
    () =>
      adapter.runBridgeProduction({
        args: [`--mode=${POLICY.mode}`],
        env: {},
        execArgv: [],
        stdinBytes: Buffer.from(nonce),
        stdinIsPipe: true,
        workspaceRoot: "/safe",
        fsOps: ops,
        platform: "linux",
        testOnlyBridge: true,
        runtimeExecPath: POLICY.input.nodePath,
        bindings,
        clock: () => now,
        readFixed: () => Buffer.from(JSON.stringify(permit)),
        qualifyOutput: () => ({
          fd: 10,
          dev: 1,
          ino: 2,
          realPath: "/safe/output",
          mount: bindings.bridge.nativeMountIdentity,
          closed: false,
        }),
        durability() {},
        resolveDns: async () => {
          dns++;
        },
        httpPost: async () => {
          http++;
        },
      }),
    "ONE_SHOT_USED",
  );
  a.equal(offset, POLICY.input.preludeBytes);
  a.equal(reads, 1);
  a.equal(goWrites, 0);
  a.equal(dns, 0);
  a.equal(http, 0);
});
run("mountinfo uses decoded longest native mount identity", () => {
  const text =
      "1 0 1:1 / / rw - ext4 /dev/root rw\n" +
      "2 1 2:2 /native\\040root /native\\040root rw - xfs /dev/native\\040disk rw\n",
    row = adapter.parseMountInfo(text, "/native root/output");
  a.equal(row.mountId, 2);
  a.equal(row.mountPoint, "/native root");
  a.equal(row.source, "/dev/native disk");
  mutations++;
  throws(
    () =>
      adapter.parseMountInfo(
        "3 0 3:3 / / rw - overlay overlay rw\n",
        "/output",
      ),
    "MOUNTINFO_FILESYSTEM",
  );
  const target = "/native root/file",
    fileStat = {
      dev: 2050,
      ino: 7,
      uid: 1000,
      nlink: 1,
      mode: 0o100700,
      isFile: () => true,
      isSymbolicLink: () => false,
    },
    fileOps = {
      constants: { O_RDONLY: 0, O_NOFOLLOW: 0 },
      mountInfoText:
        "1 0 8:1 / / rw - ext4 /dev/root rw\n" +
        "2 1 8:2 / /native\\040root rw - ext4 /dev/native\\040disk rw\n",
      realpathSync: (value) =>
        String(value).startsWith("/proc/self/fd/") ? target : value,
      lstatSync: () => fileStat,
      openSync: () => 9,
      fstatSync: () => fileStat,
      closeSync() {},
    };
  a.equal(adapter.qualifyRuntimeFile(target, fileOps, { platform: "linux" }).mount.mountId, 2);
  mutations++;
  throws(
    () =>
      adapter.qualifyRuntimeFile(target, {
        ...fileOps,
        realpathSync: (value) =>
          String(value).startsWith("/proc/self/fd/")
            ? "/other-mount/file"
            : value === target
              ? "/other-mount/file"
              : value,
      }, { platform: "linux" }),
    "RUNTIME_FILE_AUTHORITY",
  );
  mutations++;
  throws(
    () =>
      adapter.qualifyRuntimeFile(target, {
        ...fileOps,
        mountInfoText:
          "1 0 8:1 / / rw - ext4 /dev/root rw\n" +
          "2 1 8:3 / /native\\040root rw - ext4 /dev/native\\040disk rw\n",
      }, { platform: "linux" }),
    "RUNTIME_FILE_IDENTITY",
  );
  for (const changed of [{ mode: 0o100722 }, { nlink: 2 }]) {
    mutations++;
    const bad = { ...fileStat, ...changed };
    throws(
      () =>
        adapter.qualifyRuntimeFile(
          target,
          { ...fileOps, lstatSync: () => bad, fstatSync: () => bad },
          { platform: "linux" },
        ),
      "RUNTIME_FILE_AUTHORITY",
    );
  }
  const scriptBytes = Buffer.from("bound capture\n"),
    captureBridge = {
      productionCapturePath: POLICY.input.capturePath,
      productionCaptureSha256: crypto
        .createHash("sha256")
        .update(scriptBytes)
        .digest("hex"),
      productionCaptureIdentity: { dev: "2050", ino: "7" },
      runtimeFilePaths: [POLICY.input.capturePath],
      nativeMountIdentity: {
        mountId: 2,
        majorMinor: "8:2",
        root: "/",
        mountPoint:
          "/home/mruserbox/.local/share/evm-audit/morpho-pt-post-expiry-r1",
        fsType: "ext4",
        source: "/dev/native",
      },
    },
    captureOps = {
      ...fileOps,
      mountInfoText:
        "1 0 8:1 / / rw - ext4 /dev/root rw\n" +
        "2 1 8:2 / /home/mruserbox/.local/share/evm-audit/morpho-pt-post-expiry-r1 rw - ext4 /dev/native rw\n",
      realpathSync: (value) =>
        String(value).startsWith("/proc/self/fd/")
          ? POLICY.input.capturePath
          : value,
      readFileSync: () => scriptBytes,
    };
  a.equal(
    adapter.assertExecutedCapture(captureBridge, captureOps, {
      platform: "linux",
      argv1: POLICY.input.capturePath,
    }).path,
    POLICY.input.capturePath,
  );
  mutations++;
  throws(
    () =>
      adapter.assertExecutedCapture(captureBridge, captureOps, {
        platform: "linux",
        argv1:
          "/home/mruserbox/.local/share/evm-audit/morpho-pt-post-expiry-r1/capture-morpho-pt-27aug2026-post-expiry-r1-production.js",
      }),
    "EXECUTED_CAPTURE_PATH",
  );
});
run(
  "Windows supervisor is fixed-path noninjectable and validates nonce-only stdin",
  async () => {
    a.equal(
      supervisor.validateSupervisorInvocation({
        args: [],
        env: { SystemRoot: "C:\\Windows" },
        stdinBytes: Buffer.from(`${nonce}\n`),
        stdinIsPipe: true,
      }),
      true,
    );
    a.equal(supervisor.TEST_ONLY, true);
    await rejects(
      () => supervisor.runNativeSupervisor(),
      "S_DISABLED_TEST_ONLY",
    );
    for (const input of [Buffer.from(nonce), Buffer.from(`${nonce}x\n`)]) {
      mutations++;
      throws(
        () =>
          supervisor.validateSupervisorInvocation({
            args: [],
            env: {},
            stdinBytes: input,
            stdinIsPipe: true,
          }),
        "S03",
      );
    }
  },
);
run(
  "native production sources and broker binary are present and production paths are literal",
  () => {
    const root = __dirname,
      broker = fs.readFileSync(
        path.join(
          root,
          "native/morpho-pt-post-expiry-r1-supervisor-broker-win32.c",
        ),
        "utf8",
      ),
      launcher = fs.readFileSync(
        path.join(root, "native/morpho-pt-post-expiry-r1-launcher-linux.c"),
        "utf8",
      ),
      invoke = fs.readFileSync(
        path.join(
          root,
          "invoke-morpho-pt-27aug2026-post-expiry-r1-production.js",
        ),
        "utf8",
      ),
      build = JSON.parse(
        fs.readFileSync(
          path.join(
            root,
            "native/morpho-pt-post-expiry-r1-native-build-manifest.json",
          ),
          "utf8",
        ),
      );
    a.match(broker, /C:\\\\_Work\\\\__EVM_AUDIT\\\\rpc_endpoints\.txt/u);
    a.match(broker, /CreateProcessW\(WSL_PATH/u);
    a.match(broker, /GetModuleFileNameW/u);
    a.match(broker, /QueryFullProcessImageNameW/u);
    a.match(broker, /SE_DACL_PROTECTED/u);
    a.match(broker, /CancelSynchronousIo/u);
    a.match(broker, /timed_require_eof/u);
    a.match(broker, /monitor_thread/u);
    a.match(broker, /EXPECTED_LAUNCHER_HASH/u);
    a.match(broker, /PeekNamedPipe\(childOutR/u);
    a.match(launcher, /GO_MAGIC/u);
    a.match(launcher, /dup2\(nullfd,2\)/u);
    a.match(broker, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/u);
    a.match(broker, /HANDLE handles\[3\]=\{childInR,childOutW,nul\}/u);
    a.match(broker, /PROC_THREAD_ATTRIBUTE_HANDLE_LIST/u);
    a.match(launcher, /\/proc\/self\/exe/u);
    a.match(launcher, /dup2\(childInventory,3\)/u);
    a.match(launcher, /dup2\(childGo,4\)/u);
    a.match(launcher, /runtime\/bin\/node/u);
    a.match(launcher, /post-expiry-r1\/tools\/capture-morpho/u);
    a.doesNotMatch(
      launcher,
      /post-expiry-r1\/capture-morpho-pt-27aug2026-post-expiry-r1-production\.js/u,
    );
    a.match(launcher, /PR_SET_PDEATHSIG/u);
    a.match(launcher, /PR_SET_NO_NEW_PRIVS/u);
    a.match(launcher, /#ifdef UNIT_TEST/u);
    a.match(broker, /#ifdef UNIT_TEST/u);
    a.match(broker, /fatal_worker/u);
    a.match(broker, /if\(WaitForSingleObject\(thread,1000\)!=WAIT_OBJECT_0\)fatal_worker/u);
    a.doesNotMatch(invoke, /node:child_process|spawn\(/u);
    a.equal(
      build.windows.sourceSha256,
      crypto.createHash("sha256").update(broker).digest("hex"),
    );
    a.equal(
      build.windows.binarySha256,
      crypto
        .createHash("sha256")
        .update(
          fs.readFileSync(
            path.join(
              root,
              "native/morpho-pt-post-expiry-r1-supervisor-broker-win32.exe",
            ),
          ),
        )
        .digest("hex"),
    );
    a.equal(
      build.linux.sourceSha256,
      crypto.createHash("sha256").update(launcher).digest("hex"),
    );
    a.equal(build.windows.byteIdentical, true);
    a.equal(build.linux.byteIdentical, true);
    a.equal(
      build.windows.compilerExecutableSha256,
      crypto
        .createHash("sha256")
        .update(
          fs.readFileSync("C:\\TDM-GCC-64\\bin\\x86_64-w64-mingw32-gcc.exe"),
        )
        .digest("hex"),
    );
    a.equal(build.linux.compilerExecutable, "/usr/bin/gcc");
    a.match(launcher, /getrlimit\(RLIMIT_NOFILE/u);
    a.match(launcher, /waitpid\(child,status,WNOHANG\)/u);
    a.equal(
      fs
        .statSync(
          path.join(
            root,
            "native/morpho-pt-post-expiry-r1-supervisor-broker-win32.exe",
          ),
        )
        .isFile(),
      true,
    );
  },
);
test.after(() =>
  process.stdout.write(
    `MORPHO_PT_POST_EXPIRY_R1_BRIDGE_SUMMARY ${JSON.stringify({ tests, assertions, mutations, networkRequests: 0, productionBrokerExecutions: 0 })}\n`,
  ),
);
