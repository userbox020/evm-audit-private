#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const WORKSPACE = path.resolve(__dirname, "..");
const NAMESPACE = "profitable-async-liability-solidity-builder-exact-qualified-reference-two-clean-build-reproducibility-executor-v21-r5";
const STATUS = "SEALED_V21_R5_PRODUCTION_EXECUTOR_REVIEW_REQUIRED_EXECUTION_UNAUTHORIZED";
const EXECUTE_FLAG = "--execute-reviewed-v21-r5-production";
const EXACT_COMMAND = `node tools/run-${NAMESPACE}.js ${EXECUTE_FLAG}`;
const AUTHORIZATION_ID = "58a906e2bd7c4f13912aa87065e4c3d1";
const PACKAGE_REL = `tools/vendor/${NAMESPACE}`;
const PACKAGE_ROOT = path.join(WORKSPACE, ...PACKAGE_REL.split("/"));
const RUNS_ROOT = path.join(PACKAGE_ROOT, "runs");
const AUTHORITY_ROOTS = Object.freeze([
  `${PACKAGE_REL}-execution-authorization`,
  `${PACKAGE_REL}-review-decision`,
  `${PACKAGE_REL}-final-authority`
]);

const V13 = "profitable-async-liability-solidity-builder-host-mount-comparator-v13";
const V15 = "profitable-async-liability-solidity-builder-exit-inspect-comparator-v15";
const CORRECTION = "profitable-async-liability-solidity-builder-image-inspect-correction-v2";
const ENDPOINT = "npipe:////./pipe/docker_engine";
const DOCKER_VERSION = "29.6.1";
const IMAGE = "docker.io/emscripten/emsdk@sha256:47d573d5a86379a06f850de200d69407e6baa2d2f9c19d9e156a67db57f80f2f";
const CONFIG_DIGEST = "sha256:a411b47f58dbac78da4f2ea974e6bdbb4cd0598d6de7d8166903cdb34d6ecc9e";
const ENTRYPOINT = "/emsdk/upstream/emscripten/emcc";
const OUTPUT_NAME = "tree-sitter-solidity.wasm";
const OUTPUT = Object.freeze({ bytes: 508585, sha256: "ac4d44dc54b7a475c2284ae27ab0af932043e2cfd4e200a416b2ac5d40f433d7" });
const QUALIFIED_REFERENCE = Object.freeze({
  terminalReport: "reports/profitable-async-liability-solidity-builder-target-runtime-parser-behavior-qualification-v20-r2-result.md",
  terminalReportBytes: 3284,
  terminalReportSha256: "3ab27c8a13a86f975df550498ba581d54d27cf3f97fc363dbc1f63407250c7dc",
  classification: "QUALIFIED_TARGET_RUNTIME_BEHAVIOR_MATCH",
  output: OUTPUT
});
const ADMIN_TIMEOUT_MS = 30000;
const BUILD_TIMEOUT_MS = 1800000;
const MAX_BUFFER = 2097152;
const ZERO_TIME = "0001-01-01T00:00:00Z";
const LIMITS = Object.freeze({ memory: 4294967296, memorySwap: 4294967296, nanoCpus: 2000000000, pidsLimit: 256 });
const TMPFS = Object.freeze({
  "/tmp": "rw,nosuid,nodev,size=268435456",
  "/home/nonroot": "rw,noexec,nosuid,nodev,size=33554432"
});
const IMAGE_ENV = Object.freeze(["PATH=/emsdk:/emsdk/upstream/emscripten:/emsdk/node/20.18.0_64bit/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "EMSDK=/emsdk"]);
const EXPLICIT_ENV = Object.freeze(["TZ=UTC", "LANG=C.UTF-8", "LC_ALL=C.UTF-8", "HOME=/home/nonroot", "XDG_CACHE_HOME=/cache"]);
const EMCC_ARGV = Object.freeze(["-o", "/out/tree-sitter-solidity.wasm", "-Os", "-s", "WASM=1", "-s", "SIDE_MODULE=2", "-s", "TOTAL_MEMORY=33554432", "-s", "NODEJS_CATCH_EXIT=0", "-s", "EXPORTED_FUNCTIONS=[\"_tree_sitter_solidity\"]", "-fno-exceptions", "-fvisibility=hidden", "-I", ".", "parser.c"]);
const EMPTY_DOCKER_CONFIG_BYTES = Buffer.from('{"auths":{}}\n');
const SOURCE_RECORDS = Object.freeze([
  Object.freeze({ path: "tools/vendor/profitable-async-liability-delta-detector-v1-parser-authority/sources/extracted/tree-sitter-solidity-1.2.13/package/src/parser.c", stage: "parser.c", bytes: 2567063, sha256: "e71971f6ddc0704e81f4af3f43ecc79793742bb5f1d256a5fdd718aa06d74acb" }),
  Object.freeze({ path: "tools/vendor/profitable-async-liability-delta-detector-v1-parser-authority/sources/extracted/tree-sitter-solidity-1.2.13/package/src/tree_sitter/parser.h", stage: "tree_sitter/parser.h", bytes: 7624, sha256: "180b893c8734778fd32f372dfbc27bd6ad1cd2221f26150b31256ff6716320d2" })
]);
const OPERATIONS = Object.freeze(["VERSION", "INFO", "IMAGE_INSPECT", "A_CREATE", "A_CREATED_INSPECT", "A_START_ATTACH", "A_EXITED_INSPECT", "A_RM_FORCE", "B_CREATE", "B_CREATED_INSPECT", "B_START_ATTACH", "B_EXITED_INSPECT", "B_RM_FORCE"]);
const BUDGETS = Object.freeze({ maximumProcessCalls: 15, maximumWrites: 64, successProcessCalls: 13 });
const DEPENDENCY_RECORDS = Object.freeze([
  Object.freeze({ path: "tools/validate-profitable-async-liability-solidity-builder-image-inspect-correction-v2.js", bytes: 12080, sha256: "f86ac15e57ed91fb6e62837f3a7c6b37e7ce7a6b08873fa70aac87ee5bc9acfb" }),
  Object.freeze({ path: `tools/vendor/${CORRECTION}/manifests/package-manifest.json`, bytes: 8955, sha256: "e4462732d077b8cbe45b78c91de573df5a3fe20ad342b6aad0762f24754c08ab" }),
  Object.freeze({ path: `tools/vendor/${CORRECTION}/manifests/authority-manifest.json`, bytes: 910, sha256: "2c263119d81fe8dd6f52dc338b2035670786ed690e1315923bf8a692018d4c85" }),
  Object.freeze({ path: `tools/vendor/${CORRECTION}/manifests/authority-manifest.sha256`, bytes: 100, sha256: "c07379d6645af81c6ff020c7e0b051efee61960e43e198b4324fdd125ea5d01e" }),
  Object.freeze({ path: `tools/run-${V13}.js`, bytes: 15107, sha256: "7fb99ab5fdb1a0179014d15cf31bc1d5fe8543685fecffa1add4317703b1cfd3" }),
  Object.freeze({ path: `tools/test-run-${V13}.js`, bytes: 21824, sha256: "be0dbe114710ed82266174ba2dfda2677752e98fbc1d095b9a427862e4bc89f9" }),
  Object.freeze({ path: `reports/${V13}.md`, bytes: 3605, sha256: "e6e901fb23d6dfa57e7411f949a0a1755d38213e5e03dfb1aae82569d79b60e7" }),
  Object.freeze({ path: `tools/vendor/${V13}/planned-successor-policy.json`, bytes: 831, sha256: "36f3bad5482da38c8424c84d389802717b514347c30d288da500ce877454a197" }),
  Object.freeze({ path: `tools/vendor/${V13}/manifests/package-manifest.json`, bytes: 39302, sha256: "30fec7bf9659bea065ee98dfe7e4933a957ce6662d2c6fa5007dfa2b5c1793fc" }),
  Object.freeze({ path: `tools/vendor/${V13}/manifests/authority-manifest.json`, bytes: 8052, sha256: "f010384ef28c6c5fc89a0eb4fabfe11bf4b90f202047cbb3e11532f3c9626ca1" }),
  Object.freeze({ path: `tools/vendor/${V13}/manifests/authority-manifest.sha256`, bytes: 90, sha256: "33a8ed861c4ca0bb608c2ba8857258528ffdcd04bae96c1714d3b46c44ed3a38" }),
  Object.freeze({ path: `tools/run-${V15}.js`, bytes: 18038, sha256: "60dc2a77233a28c326664d1fc2562b72d2ce8aaf2db7f7d297314eec86d989eb" }),
  Object.freeze({ path: `tools/test-run-${V15}.js`, bytes: 21995, sha256: "4ba651b0f1c1b53ee893cb07e1d1c96821a8b3449ce064ade437cadecb816d74" }),
  Object.freeze({ path: `reports/${V15}.md`, bytes: 2588, sha256: "57a86d1bb8e80a78caf05cd77f3f60ceb1e92be75c50bc8de243230b23cb5fe7" }),
  Object.freeze({ path: `tools/vendor/${V15}/planned-successor-policy.json`, bytes: 1089, sha256: "682539c9413298e5c916ca5259e7e0204d3fe56bb90fd567730acf1cf23ab15b" }),
  Object.freeze({ path: `tools/vendor/${V15}/manifests/package-manifest.json`, bytes: 45207, sha256: "45e2e29fb885d4a5e8b76b2dd19143bbc8c2d2ee7b1a1d6f0f408d55c78b7407" }),
  Object.freeze({ path: `tools/vendor/${V15}/manifests/authority-manifest.json`, bytes: 8253, sha256: "b5e85ac78e9128f976b05f3c41b52b1edd63fd3fd0e9eeab21adc6107ab733c0" }),
  Object.freeze({ path: `tools/vendor/${V15}/manifests/authority-manifest.sha256`, bytes: 90, sha256: "63ba626d2286e2cfd9738a21d357fc76fe48c25d6625d7b0f1a26eab0c57a049" })
]);

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function contained(target, root) { const rel = path.relative(path.resolve(root), path.resolve(target)); return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)); }
function successful(result) { return !!result && result.status === 0 && result.signal == null && !(result.error && result.error.code) && result.stderr === ""; }
function sanitizedResult(result, classification) { return { status: Number.isInteger(result && result.status) ? result.status : null, signal: result && typeof result.signal === "string" ? result.signal.slice(0, 32) : null, spawnErrorCode: result && result.error && typeof result.error.code === "string" ? result.error.code.slice(0, 32) : null, stdoutBytes: Buffer.byteLength(result && typeof result.stdout === "string" ? result.stdout : ""), stderrBytes: Buffer.byteLength(result && typeof result.stderr === "string" ? result.stderr : ""), classification }; }
function exactCreateId(result) { return successful(result) && /^[a-f0-9]{64}\n$/.test(result.stdout || "") ? result.stdout.slice(0, 64) : null; }
function processResult(error) { return { status: null, signal: null, error: { code: error && error.code || "OTHER" }, stdout: "", stderr: "" }; }
function freshState(overrides = {}) { return { executionAuthorized: false, consumed: false, processCalls: 0, writes: 0, buildAttempts: 0, successfulBuilds: 0, cleanupAttempts: 0, cleanupSuccesses: 0, networkCalls: 0, lastProcess: null, terminal: null, terminalEvidenceState: "NOT_CONSUMED", ...overrides }; }
function createBudgetsR5(state, limits = BUDGETS) {
  return Object.freeze({
    beforeProcess() { if (state.processCalls >= limits.maximumProcessCalls) throw new Error("PROCESS_BUDGET_EXCEEDED"); state.processCalls += 1; },
    beforeWrite() { if (state.writes >= limits.maximumWrites) throw new Error("WRITE_BUDGET_EXCEEDED"); state.writes += 1; }
  });
}

function labelsForR5(id, label) { assert.match(id, /^[a-f0-9]{32}$/, "AUTHORIZATION_ID_INVALID"); assert.equal(label === "a" || label === "b", true); return { "pal.authorization": id, "pal.executor": NAMESPACE, "pal.build": label }; }
function buildPlanR5(config, runRoot, id) {
  const base = ["--config", config, "--host", ENDPOINT];
  const builds = ["a", "b"].map((label) => {
    const upper = label.toUpperCase(), name = `pal-v21r5-${id}-${label}`, work = path.join(runRoot, `work-${label}`), cache = path.join(runRoot, `cache-${label}`), output = path.join(runRoot, `out-${label}`), labels = labelsForR5(id, label);
    const create = [...base, "create", "--name", name, "--platform", "linux/amd64", "--pull", "never", "--network", "none", "--read-only", "--user", "65532:65532", "--cap-drop", "ALL", "--security-opt", "no-new-privileges=true", "--memory", String(LIMITS.memory), "--memory-swap", String(LIMITS.memorySwap), "--cpus", "2", "--pids-limit", String(LIMITS.pidsLimit), "--ipc", "private", "--cgroupns", "private", "--workdir", "/src", "--entrypoint", ENTRYPOINT];
    for (const [key, value] of Object.entries(labels)) create.push("--label", `${key}=${value}`);
    for (const value of EXPLICIT_ENV) create.push("--env", value);
    create.push("--mount", `type=bind,src=${work},dst=/src,readonly`, "--mount", `type=bind,src=${cache},dst=/cache`, "--mount", `type=bind,src=${output},dst=/out`);
    for (const [target, value] of Object.entries(TMPFS)) create.push("--tmpfs", `${target}:${value}`);
    create.push(IMAGE, ...EMCC_ARGV);
    return { label, upper, name, work, cache, output, labels, create, inspectName: [...base, "container", "inspect", name], inspectId: (target) => [...base, "container", "inspect", target], start: (target) => [...base, "start", "--attach", target], remove: (target) => [...base, "rm", "--force", target] };
  });
  return { builds, version: [...base, "version", "--format", "{{json .}}"], info: [...base, "info", "--format", "{{json .}}"], image: [...base, "image", "inspect", IMAGE] };
}
function expectedCreatedR5(spec, receipt) { return { id: receipt, name: `/${spec.name}`, configDigest: CONFIG_DIGEST, imageReference: IMAGE, labels: spec.labels, environment: [...IMAGE_ENV, ...EXPLICIT_ENV], entrypoint: [ENTRYPOINT], command: [...EMCC_ARGV], user: "65532:65532", workdir: "/src", state: { status: "created", running: false, startedAt: ZERO_TIME }, pathPolicy: process.platform === "win32" ? "win32" : "exact", host: { networkMode: "none", readOnlyRootfs: true, privileged: false, memory: LIMITS.memory, memorySwap: LIMITS.memorySwap, nanoCpus: LIMITS.nanoCpus, pidsLimit: LIMITS.pidsLimit, ipcMode: "private", cgroupnsMode: "private", pidMode: "", utsMode: "", tmpfs: { ...TMPFS } }, mounts: [{ type: "bind", source: path.resolve(spec.work), target: "/src", readOnly: true }, { type: "bind", source: path.resolve(spec.cache), target: "/cache", readOnly: false }, { type: "bind", source: path.resolve(spec.output), target: "/out", readOnly: false }] }; }

function validateQualificationR5(operation, result, id, deps) {
  assert.equal(successful(result), true, `${operation}_QUALIFICATION_FAILED`);
  const value = JSON.parse(result.stdout);
  if (operation === "VERSION") { assert.equal(value.Client.Version, DOCKER_VERSION); assert.equal(value.Server.Version, DOCKER_VERSION); return; }
  if (operation === "INFO") { assert.equal(value.ServerVersion, DOCKER_VERSION); assert.equal(value.OSType, "linux"); assert.equal(["amd64", "x86_64"].includes(String(value.Architecture).toLowerCase()), true); assert.equal(Array.isArray(value.SecurityOptions) && value.SecurityOptions.some((x) => /seccomp|no-new-privileges/i.test(String(x))), true); assert.equal(Number(value.NCPU) >= 2, true); assert.equal(Number(value.MemTotal) >= LIMITS.memory, true); return; }
  assert.equal(Array.isArray(value) && value.length === 1, true);
  const diagnosis = deps.correction.compareCorrectedInspect(value[0], { source: "DOCKER_IMAGE_INSPECT_MEMORY_ONLY", runId: id });
  assert.equal(diagnosis.status, "IMAGE_INSPECT_DIAGNOSIS_MATCH"); assert.equal(diagnosis.summary.fieldsCompared, 9); assert.equal(diagnosis.summary.fieldsMismatched, 0);
}

function executeWorkflowR5(io, id) {
  assert.equal(io && typeof io === "object", true, "IO_REQUIRED");
  const state = io.state || freshState(), budgets = io.budgets || createBudgetsR5(state), plan = buildPlanR5(io.config, io.runRoot, id), calls = [], records = {}, expectedOutput = io.expectedOutput || OUTPUT;
  let cursor = 0, activeSpec = null;
  const journal = (phase, op, result) => io.journal(phase, op, result);
  function assertSlot(op, cleanup) { const slot = OPERATIONS.indexOf(op); assert.notEqual(slot, -1, "OPERATION_NOT_ALLOWED"); if (cleanup) assert.equal(op, `${activeSpec.upper}_RM_FORCE`, "CLEANUP_OPERATION_NOT_ALLOWED"); else assert.equal(slot, cursor, "OPERATION_ORDER_INVALID"); return slot; }
  function invokeNormal(op, argv, timeout) {
    const slot = assertSlot(op, false); io.validateIdentities(op); journal("before", op, null); budgets.beforeProcess();
    if (op.endsWith("_START_ATTACH")) state.buildAttempts += 1;
    let result; try { result = io.adapter.call(op, argv, timeout); } catch (error) { result = processResult(error); }
    state.lastProcess = Object.freeze({ op, result }); calls.push(op); cursor = slot + 1;
    try { journal("after", op, sanitizedResult(result, successful(result) ? "SUCCESS" : "FAILURE")); } catch (error) { error.op = op; error.result = result; error.afterJournal = true; throw error; }
    return result;
  }
  function invokeCleanup(op, argv, timeout, target, receipt, deterministicName) {
    const slot = assertSlot(op, true);
    assert.equal(target === receipt || target === deterministicName, true, "CLEANUP_TARGET_NOT_CAUSAL");
    io.validateCleanup(op, target, { receipt, deterministicName });
    let journalError = null; try { journal("before", op, null); } catch (error) { journalError = error; }
    state.cleanupAttempts += 1; budgets.beforeProcess();
    let result; try { result = io.adapter.call(op, argv, timeout); } catch (error) { result = processResult(error); }
    state.lastProcess = Object.freeze({ op, result }); calls.push(op); cursor = slot + 1;
    if (successful(result)) state.cleanupSuccesses += 1;
    try { journal("after", op, sanitizedResult(result, successful(result) ? "SUCCESS" : "FAILURE")); } catch (error) { journalError = journalError || error; }
    return { result, journalError };
  }
  const qualification = io.validateQualification || ((op, result) => validateQualificationR5(op, result, id, io.dependencies));
  for (const [op, argv] of [["VERSION", plan.version], ["INFO", plan.info], ["IMAGE_INSPECT", plan.image]]) { const result = invokeNormal(op, argv, ADMIN_TIMEOUT_MS); qualification(op, result, id); }
  for (const spec of plan.builds) {
    activeSpec = spec;
    let cleanupTarget = null, receipt = null, primary = null;
    try {
      io.assertFreshSlot(spec.label, "BEFORE_CREATE");
      cleanupTarget = spec.name;
      let created;
      try { created = invokeNormal(`${spec.upper}_CREATE`, spec.create, ADMIN_TIMEOUT_MS); } catch (error) { receipt = exactCreateId(error.result); throw error; }
      receipt = exactCreateId(created);
      const inspected = invokeNormal(`${spec.upper}_CREATED_INSPECT`, receipt ? spec.inspectId(receipt) : spec.inspectName, ADMIN_TIMEOUT_MS);
      assert.equal(successful(inspected), true, "CREATED_INSPECT_FAILED");
      const rows = JSON.parse(inspected.stdout); assert.equal(Array.isArray(rows) && rows.length === 1, true, "CREATED_INSPECT_FAILED");
      const row = rows[0];
      if (!receipt) { assert.match(row.Id, /^[a-f0-9]{64}$/, "CREATE_RECEIPT_INVALID"); receipt = row.Id; }
      const createdComparison = io.compareCreated(row, expectedCreatedR5(spec, receipt)); assert.equal(createdComparison.match, true, receipt === row.Id ? "CREATED_INSPECT_SEMANTIC_MISMATCH" : "CREATE_AMBIGUOUS_FOREIGN");
      io.assertFreshSlot(spec.label, "BEFORE_START");
      const started = invokeNormal(`${spec.upper}_START_ATTACH`, spec.start(receipt), BUILD_TIMEOUT_MS); assert.equal(successful(started), true, "START_FAILED");
      const exited = invokeNormal(`${spec.upper}_EXITED_INSPECT`, spec.inspectId(receipt), ADMIN_TIMEOUT_MS); assert.equal(successful(exited), true, "EXIT_INSPECT_FAILED");
      const exitComparison = io.compareExited(exited.stdout, { id: receipt, name: `/${spec.name}`, labels: { ...spec.labels } }); assert.equal(exitComparison.match, true, "EXITED_INSPECT_SEMANTIC_MISMATCH");
      const verified = io.verifyOutput(spec.label); assert.deepEqual({ bytes: verified.bytes, sha256: verified.sha256 }, expectedOutput, "OUTPUT_INVALID"); records[spec.label] = verified; state.successfulBuilds += 1;
    } catch (error) { primary = error; }
    finally {
      if (cleanupTarget) {
        const target = receipt || cleanupTarget;
        try {
          const cleanup = invokeCleanup(`${spec.upper}_RM_FORCE`, spec.remove(target), ADMIN_TIMEOUT_MS, target, receipt, cleanupTarget);
          if (!successful(cleanup.result)) { const error = new Error("REMOVE_FAILED"); error.cleanupFailure = "REMOVE_FAILED"; throw error; }
          if (cleanup.journalError && !primary) throw cleanup.journalError;
          if (cleanup.journalError && primary) primary.cleanupJournalFailure = cleanup.journalError.message;
        } catch (cleanupError) { if (primary) primary.cleanupFailure = cleanupError.message; else primary = cleanupError; }
      }
    }
    if (primary) throw primary;
  }
  assert.deepEqual(calls, OPERATIONS, "SUCCESS_OPERATION_SEQUENCE_INVALID");
  assert.equal(state.processCalls, BUDGETS.successProcessCalls, "SUCCESS_PROCESS_COUNT_INVALID");
  assert.equal(state.buildAttempts, 2, "SUCCESS_BUILD_ATTEMPTS_INVALID"); assert.equal(state.successfulBuilds, 2, "SUCCESSFUL_BUILDS_INVALID");
  assert.equal(state.cleanupAttempts, 2, "SUCCESS_CLEANUP_ATTEMPTS_INVALID"); assert.equal(state.cleanupSuccesses, 2, "SUCCESS_CLEANUP_SUCCESSES_INVALID");
  assert.equal(state.writes <= BUDGETS.maximumWrites, true, "SUCCESS_WRITE_COUNT_INVALID"); assert.equal(state.networkCalls, 0, "NETWORK_CALLS_INVALID");
  if (records.a.content && records.b.content) assert.equal(Buffer.from(records.a.content).equals(Buffer.from(records.b.content)), true, "OUTPUT_BYTES_DIFFER");
  return { schema: `${NAMESPACE}/workflow-result-v1`, status: "REPRODUCIBLE_EXACT_QUALIFIED_REFERENCE", calls, processCalls: state.processCalls, buildAttempts: state.buildAttempts, successfulBuilds: state.successfulBuilds, cleanupAttempts: state.cleanupAttempts, cleanupSuccesses: state.cleanupSuccesses, networkCalls: state.networkCalls, records: { a: { bytes: records.a.bytes, sha256: records.a.sha256 }, b: { bytes: records.b.bytes, sha256: records.b.sha256 } } };
}

function strictPath(target, root, fsImpl, kind = null) {
  const absolute = path.resolve(target), base = path.resolve(root); assert.equal(contained(absolute, base), true, "PATH_OUTSIDE_ROOT");
  let cursor = base; const rel = path.relative(base, absolute);
  for (const part of rel.split(path.sep).filter(Boolean)) { cursor = path.join(cursor, part); assert.equal(fsImpl.existsSync(cursor), true, "PATH_MISSING"); const stat = fsImpl.lstatSync(cursor); assert.equal(stat.isSymbolicLink(), false, "PATH_SYMLINK_OR_REPARSE"); const real = fsImpl.realpathSync.native ? fsImpl.realpathSync.native(cursor) : fsImpl.realpathSync(cursor); assert.equal(path.resolve(real), path.resolve(cursor), "PATH_SYMLINK_OR_REPARSE"); }
  const stat = fsImpl.lstatSync(absolute); assert.equal(stat.isSymbolicLink(), false, "PATH_SYMLINK_OR_REPARSE"); if (kind) assert.equal(kind === "file" ? stat.isFile() : stat.isDirectory(), true, "PATH_KIND_INVALID"); return absolute;
}
function identityR5(target, root, fsImpl, kind) { const checked = strictPath(target, root, fsImpl, kind), stat = fsImpl.lstatSync(checked), real = fsImpl.realpathSync.native ? fsImpl.realpathSync.native(checked) : fsImpl.realpathSync(checked); return { path: checked, real: path.resolve(real), dev: stat.dev == null ? null : stat.dev, ino: stat.ino == null ? null : stat.ino, kind }; }
function sameIdentityR5(expected, root, fsImpl) { assert.deepEqual(identityR5(expected.path, root, fsImpl, expected.kind), expected, "IDENTITY_CHANGED"); }
function fileBindingR5(target, root, fsImpl) { const metadata = identityR5(target, root, fsImpl, "file"), bytes = fsImpl.readFileSync(metadata.path); return { metadata, bytes: bytes.length, sha256: sha256(bytes) }; }
function sameBindingR5(expected, root, fsImpl, code) { try { sameIdentityR5(expected.metadata, root, fsImpl); const bytes = fsImpl.readFileSync(expected.metadata.path); assert.deepEqual({ bytes: bytes.length, sha256: sha256(bytes) }, { bytes: expected.bytes, sha256: expected.sha256 }); } catch { throw new Error(code); } }
function fsyncDirectoryR5(dir, fsImpl) { let fd; try { fd = fsImpl.openSync(dir, "r"); fsImpl.fsyncSync(fd); } catch (error) { if (!(process.platform === "win32" && error && ["EPERM", "EACCES", "EINVAL"].includes(error.code))) throw error; } finally { if (fd !== undefined) fsImpl.closeSync(fd); } }
function writeAllR5(fd, bytes, fsImpl) { let offset = 0; while (offset < bytes.length) { const written = fsImpl.writeSync(fd, bytes, offset, bytes.length - offset, null); assert.equal(written > 0, true, "WRITE_FAILED"); offset += written; } }
function writeExclusiveDurableR5(file, value, fsImpl, budgets) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`), temp = `${file}.pending-write`; budgets.beforeWrite(); const fd = fsImpl.openSync(temp, "wx", 0o600);
  try { writeAllR5(fd, bytes, fsImpl); fsImpl.fsyncSync(fd); } finally { fsImpl.closeSync(fd); }
  assert.equal(fsImpl.existsSync(file), false, "EXCLUSIVE_COMMIT_TARGET_EXISTS"); budgets.beforeWrite(); fsImpl.renameSync(temp, file); fsyncDirectoryR5(path.dirname(file), fsImpl);
  assert.equal(fsImpl.readFileSync(file).equals(bytes), true, "DURABLE_READBACK_FAILED"); return { path: path.basename(file), bytes: bytes.length, sha256: sha256(bytes) };
}
function openJournalR5(runRoot, fsImpl, budgets) {
  const file = path.join(runRoot, "journal.jsonl"); budgets.beforeWrite(); const fd = fsImpl.openSync(file, "wx", 0o600), expected = []; let sequence = 0, closed = false, degraded = false;
  return {
    append(phase, operation, result) { if (degraded) throw new Error("JOURNAL_DEGRADED"); const line = `${JSON.stringify({ sequence, phase, operation, result })}\n`, bytes = Buffer.from(line); try { budgets.beforeWrite(); writeAllR5(fd, bytes, fsImpl); fsImpl.fsyncSync(fd); expected.push(line); sequence += 1; } catch (error) { degraded = true; throw error; } },
    closeAndVerify() { if (!closed) { try { fsImpl.fsyncSync(fd); } finally { fsImpl.closeSync(fd); closed = true; } } if (degraded) return { status: "JOURNAL_DEGRADED", records: sequence }; const bytes = fsImpl.readFileSync(file), canonical = Buffer.from(expected.join("")); assert.equal(bytes.equals(canonical), true, "JOURNAL_READBACK_MISMATCH"); return { status: "JOURNAL_VERIFIED", path: "journal.jsonl", bytes: bytes.length, sha256: sha256(bytes), records: sequence }; }
  };
}
function readTerminalR5(runRoot, fsImpl = fs) {
  const successPath = path.join(runRoot, "success.json"), failurePath = path.join(runRoot, "failure.json"), success = fsImpl.existsSync(successPath), failure = fsImpl.existsSync(failurePath);
  assert.equal(Number(success) + Number(failure), 1, "TERMINAL_CARDINALITY_INVALID"); const file = success ? successPath : failurePath, bytes = fsImpl.readFileSync(file), value = JSON.parse(bytes); assert.equal(value.status, success ? "PASS" : "FAIL", "TERMINAL_STATUS_INVALID"); return { authoritative: path.basename(file), value, record: { path: path.basename(file), bytes: bytes.length, sha256: sha256(bytes) } };
}
function outputDescriptorR5(dir, workspace, fsImpl, expected = OUTPUT) {
  const chain = identityR5(dir, workspace, fsImpl, "directory"); sameIdentityR5(chain, workspace, fsImpl); assert.deepEqual(fsImpl.readdirSync(dir).sort(), [OUTPUT_NAME], "OUTPUT_INVALID");
  const target = path.join(dir, OUTPUT_NAME), lexical = identityR5(target, workspace, fsImpl, "file"), noFollow = typeof fsImpl.constants.O_NOFOLLOW === "number" ? fsImpl.constants.O_NOFOLLOW : 0, fd = fsImpl.openSync(target, fsImpl.constants.O_RDONLY | noFollow); let before, after, bytes;
  try { before = fsImpl.fstatSync(fd); assert.equal(before.isFile(), true, "OUTPUT_INVALID"); assert.equal(before.size <= MAX_BUFFER, true, "OUTPUT_INVALID"); bytes = Buffer.alloc(before.size); let offset = 0; while (offset < bytes.length) { const count = fsImpl.readSync(fd, bytes, offset, bytes.length - offset, offset); assert.equal(count > 0, true, "OUTPUT_INVALID"); offset += count; } after = fsImpl.fstatSync(fd); assert.deepEqual({ dev: after.dev, ino: after.ino, size: after.size, mtimeMs: after.mtimeMs }, { dev: before.dev, ino: before.ino, size: before.size, mtimeMs: before.mtimeMs }, "OUTPUT_CHANGED"); } finally { fsImpl.closeSync(fd); }
  sameIdentityR5(chain, workspace, fsImpl); sameIdentityR5(lexical, workspace, fsImpl); assert.deepEqual(fsImpl.readdirSync(dir).sort(), [OUTPUT_NAME], "OUTPUT_CHANGED"); assert.deepEqual({ bytes: bytes.length, sha256: sha256(bytes) }, expected, "OUTPUT_INVALID"); return { ...expected, content: bytes };
}

function createLifecycleR5(id, state, options = {}) {
  assert.match(id, /^[a-f0-9]{32}$/, "AUTHORIZATION_ID_INVALID");
  const fsImpl = options.fs || fs, workspace = path.resolve(options.workspace || WORKSPACE), packageRoot = path.resolve(options.packageRoot || PACKAGE_ROOT), runsRoot = path.join(packageRoot, "runs"), sourceRecords = options.sourceRecords || SOURCE_RECORDS, expectedOutput = options.expectedOutput || OUTPUT, budgets = options.budgets || createBudgetsR5(state, options.limits || BUDGETS);
  strictPath(packageRoot, workspace, fsImpl, "directory");
  if (fsImpl.existsSync(runsRoot)) strictPath(runsRoot, packageRoot, fsImpl, "directory");
  else { budgets.beforeWrite(); fsImpl.mkdirSync(runsRoot, { recursive: false }); fsyncDirectoryR5(packageRoot, fsImpl); fsyncDirectoryR5(runsRoot, fsImpl); }
  const runRoot = path.join(runsRoot, id);
  if (fsImpl.existsSync(runRoot)) { try { strictPath(runRoot, runsRoot, fsImpl, "directory"); } catch { throw new Error("RUN_ROOT_UNSAFE"); } throw new Error("AUTHORIZATION_ALREADY_CONSUMED"); }
  budgets.beforeWrite(); try { fsImpl.mkdirSync(runRoot, { recursive: false }); } catch { throw new Error("RUN_ROOT_EXCLUSIVE_CREATE_FAILED"); }
  fsyncDirectoryR5(runsRoot, fsImpl); fsyncDirectoryR5(runRoot, fsImpl); state.executionAuthorized = true; state.consumed = true; state.runRoot = runRoot; state.terminalEvidenceState = "CONSUMED_ROOT_CREATED_NO_MARKER";
  const config = path.join(runRoot, "docker-config"), plan = buildPlanR5(config, runRoot, id); let journal = null, consumption = null, terminalClosed = false;
  function terminalPayload(success, value, journalRecord) { return { schema: `${NAMESPACE}/${success ? "success" : "failure"}-v1`, status: success ? "PASS" : "FAIL", authorizationId: id, executionAuthorized: true, consumed: true, processCalls: state.processCalls, writesBeforeTerminalCommit: state.writes, buildAttempts: state.buildAttempts, successfulBuilds: state.successfulBuilds, cleanupAttempts: state.cleanupAttempts, cleanupSuccesses: state.cleanupSuccesses, networkCalls: state.networkCalls, terminalEvidenceState: success ? "PERSISTED_SUCCESS_JOURNAL_VERIFIED" : journalRecord && journalRecord.status === "JOURNAL_VERIFIED" ? "PERSISTED_FAILURE_JOURNAL_VERIFIED" : "PERSISTED_FAILURE_JOURNAL_DEGRADED", consumption, journal: journalRecord, value }; }
  function invalidateSuccess() { for (const name of ["success.pending.json", "success.json"]) { const target = path.join(runRoot, name); if (fsImpl.existsSync(target)) { const invalid = path.join(runRoot, `${name}.invalid`); if (fsImpl.existsSync(invalid)) { budgets.beforeWrite(); fsImpl.unlinkSync(invalid); } budgets.beforeWrite(); fsImpl.renameSync(target, invalid); } } fsyncDirectoryR5(runRoot, fsImpl); }
  function exclusiveTerminalLink(pendingPath, finalPath) { assert.equal(fsImpl.existsSync(finalPath), false, "TERMINAL_TARGET_EXISTS"); budgets.beforeWrite(); fsImpl.linkSync(pendingPath, finalPath); budgets.beforeWrite(); fsImpl.unlinkSync(pendingPath); fsyncDirectoryR5(runRoot, fsImpl); }
  function commitFailure(value, journalRecord) { invalidateSuccess(); const failurePath = path.join(runRoot, "failure.json"), pendingPath = path.join(runRoot, "failure.pending.json"); if (fsImpl.existsSync(failurePath)) return readTerminalR5(runRoot, fsImpl); writeExclusiveDurableR5(pendingPath, terminalPayload(false, value, journalRecord), fsImpl, budgets); exclusiveTerminalLink(pendingPath, failurePath); const terminal = readTerminalR5(runRoot, fsImpl); state.terminal = terminal; state.terminalEvidenceState = terminal.value.terminalEvidenceState; terminalClosed = true; return terminal; }
  function terminal(success, value) {
    if (terminalClosed) throw new Error("TERMINAL_ALREADY_COMMITTED");
    let journalRecord = null; try { journalRecord = journal ? journal.closeAndVerify() : null; } catch (error) { return commitFailure({ phase: "JOURNAL_FINALIZATION", rootCauseCode: error.message, noRetry: true }, null); }
    if (!success) return commitFailure(value, journalRecord);
    if (!journalRecord || journalRecord.status !== "JOURNAL_VERIFIED") return commitFailure({ phase: "SUCCESS_FINALIZATION", rootCauseCode: "SUCCESS_JOURNAL_NOT_VERIFIED", noRetry: true }, journalRecord);
    const pendingPath = path.join(runRoot, "success.pending.json"), successPath = path.join(runRoot, "success.json");
    try {
      writeExclusiveDurableR5(pendingPath, terminalPayload(true, value, journalRecord), fsImpl, budgets);
      if (options.beforeSuccessCommit) options.beforeSuccessCommit({ runRoot, state });
      assert.equal(fsImpl.existsSync(path.join(runRoot, "failure.json")), false, "TERMINAL_TARGET_EXISTS"); exclusiveTerminalLink(pendingPath, successPath);
      const committed = readTerminalR5(runRoot, fsImpl); state.terminal = committed; state.terminalEvidenceState = committed.value.terminalEvidenceState; terminalClosed = true; return committed;
    } catch (error) { return commitFailure({ phase: "SUCCESS_COMMIT", rootCauseCode: error.message, noRetry: true }, journalRecord); }
  }
  try {
    consumption = writeExclusiveDurableR5(path.join(runRoot, "authorization-consumed.json"), { schema: `${NAMESPACE}/authorization-consumed-v1`, status: "CONSUMED", authorizationId: id, oneShot: true, exactCommand: EXACT_COMMAND }, fsImpl, budgets);
    for (const dir of [config, ...plan.builds.flatMap((spec) => [spec.work, path.join(spec.work, "tree_sitter"), spec.cache, spec.output])]) { budgets.beforeWrite(); fsImpl.mkdirSync(dir, { recursive: false }); fsyncDirectoryR5(path.dirname(dir), fsImpl); }
    for (const spec of plan.builds) for (const record of sourceRecords) { const source = strictPath(path.join(workspace, ...record.path.split("/")), workspace, fsImpl, "file"), sourceBytes = fsImpl.readFileSync(source); assert.deepEqual({ bytes: sourceBytes.length, sha256: sha256(sourceBytes) }, { bytes: record.bytes, sha256: record.sha256 }, "SOURCE_SEAL_INVALID"); const target = path.join(spec.work, ...record.stage.split("/")); budgets.beforeWrite(); fsImpl.copyFileSync(source, target, fsImpl.constants.COPYFILE_EXCL); fsyncDirectoryR5(path.dirname(target), fsImpl); }
    const configRecord = writeExclusiveDurableR5(path.join(config, "config.json"), { auths: {} }, fsImpl, budgets); assert.deepEqual({ bytes: configRecord.bytes, sha256: configRecord.sha256 }, { bytes: EMPTY_DOCKER_CONFIG_BYTES.length, sha256: sha256(EMPTY_DOCKER_CONFIG_BYTES) }, "DOCKER_CONFIG_INVALID");
    const identities = { runRoot: identityR5(runRoot, workspace, fsImpl, "directory"), config: identityR5(config, workspace, fsImpl, "directory"), configFile: fileBindingR5(path.join(config, "config.json"), workspace, fsImpl), builds: plan.builds.map((spec) => ({ label: spec.label, work: identityR5(spec.work, workspace, fsImpl, "directory"), tree: identityR5(path.join(spec.work, "tree_sitter"), workspace, fsImpl, "directory"), cache: identityR5(spec.cache, workspace, fsImpl, "directory"), output: identityR5(spec.output, workspace, fsImpl, "directory"), staged: sourceRecords.map((record) => ({ record, binding: fileBindingR5(path.join(spec.work, ...record.stage.split("/")), workspace, fsImpl) })) })) };
    journal = openJournalR5(runRoot, fsImpl, budgets); state.terminalEvidenceState = "CONSUMED_SETUP_COMPLETE_NO_PROCESS";
    function validateIdentities() { sameIdentityR5(identities.runRoot, workspace, fsImpl); sameIdentityR5(identities.config, workspace, fsImpl); sameBindingR5(identities.configFile, workspace, fsImpl, "CONFIG_IDENTITY_UNSAFE"); for (const build of identities.builds) { sameIdentityR5(build.work, workspace, fsImpl); sameIdentityR5(build.tree, workspace, fsImpl); sameIdentityR5(build.cache, workspace, fsImpl); sameIdentityR5(build.output, workspace, fsImpl); for (const staged of build.staged) sameBindingR5(staged.binding, workspace, fsImpl, "STAGED_SOURCE_CONTENT_CHANGED"); } }
    function assertFreshSlot(label) {
      validateIdentities(); const activeIndex = label === "a" ? 0 : 1;
      for (const build of identities.builds) { assert.deepEqual(fsImpl.readdirSync(build.work.path).sort(), ["parser.c", "tree_sitter"], "STAGED_SOURCE_LISTING_CHANGED"); assert.deepEqual(fsImpl.readdirSync(build.tree.path).sort(), ["parser.h"], "STAGED_SOURCE_LISTING_CHANGED"); assert.deepEqual(fsImpl.readdirSync(build.cache.path), [], "CACHE_NOT_EMPTY"); }
      for (let index = activeIndex; index < identities.builds.length; index += 1) assert.deepEqual(fsImpl.readdirSync(identities.builds[index].output.path), [], "OUTPUT_NOT_EMPTY");
    }
    function validateCleanup(operation, target, causal) { assert.equal(["A_RM_FORCE", "B_RM_FORCE"].includes(operation), true, "CLEANUP_OPERATION_NOT_ALLOWED"); assert.equal(target === causal.receipt || target === causal.deterministicName, true, "CLEANUP_TARGET_NOT_CAUSAL"); sameIdentityR5(identities.config, workspace, fsImpl); sameBindingR5(identities.configFile, workspace, fsImpl, "CONFIG_IDENTITY_UNSAFE"); }
    return { runRoot, config, state, budgets, plan, journal: journal.append, validateIdentities, validateCleanup, assertFreshSlot, verifyOutput(label) { return outputDescriptorR5(plan.builds.find((spec) => spec.label === label).output, workspace, fsImpl, expectedOutput); }, terminal };
  } catch (error) { try { error.lifecycleTerminal = terminal(false, { phase: "SETUP", rootCauseCode: error.message, noRetry: true }); } catch (terminalError) { error.terminalFailure = terminalError.message; } error.executionState = state; throw error; }
}

function sanitizedDockerEnvR5(config, env = process.env) { const forbidden = ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_AUTH_CONFIG", "REGISTRY_AUTH_FILE", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY"]; for (const key of Object.keys(env)) if (forbidden.includes(key.toUpperCase())) throw new Error("DOCKER_ENV_REJECTED"); return { DOCKER_CONFIG: config, PATH: env.PATH, SystemRoot: env.SystemRoot }; }
function productionAdapterR5(config) { const env = sanitizedDockerEnvR5(config); return { call(_operation, argv, timeout) { const result = childProcess.spawnSync("docker", argv, { shell: false, windowsHide: true, encoding: "utf8", env, timeout, maxBuffer: MAX_BUFFER }); return { status: Number.isInteger(result.status) ? result.status : null, signal: result.signal || null, error: result.error || null, stdout: typeof result.stdout === "string" ? result.stdout : "", stderr: typeof result.stderr === "string" ? result.stderr : "" }; } }; }
function recordR5(relative, workspace = WORKSPACE, fsImpl = fs) { const file = strictPath(path.join(workspace, ...relative.split("/")), workspace, fsImpl, "file"), bytes = fsImpl.readFileSync(file); return { path: relative, bytes: bytes.length, sha256: sha256(bytes) }; }
function validatePackageR5(workspace = WORKSPACE, fsImpl = fs) {
  const manifestRel = `${PACKAGE_REL}/manifests/package-manifest.json`, manifest = JSON.parse(fsImpl.readFileSync(strictPath(path.join(workspace, ...manifestRel.split("/")), workspace, fsImpl, "file")));
  assert.equal(manifest.schema, `${NAMESPACE}/package-manifest-v1`); assert.equal(manifest.namespace, NAMESPACE); assert.equal(manifest.status, STATUS); assert.equal(manifest.authorizationId, AUTHORIZATION_ID); assert.deepEqual(manifest.expectedOutput, OUTPUT); assert.deepEqual(manifest.limits, BUDGETS);
  for (const record of [...manifest.successorRecords, ...manifest.dependencyRecords]) assert.deepEqual(recordR5(record.path, workspace, fsImpl), record, `SEAL:${record.path}`);
  assert.deepEqual(manifest.dependencyRecords, DEPENDENCY_RECORDS); const authorityRel = `${PACKAGE_REL}/manifests/authority-manifest.json`, authorityBytes = fsImpl.readFileSync(strictPath(path.join(workspace, ...authorityRel.split("/")), workspace, fsImpl, "file")), authority = JSON.parse(authorityBytes), detached = fsImpl.readFileSync(strictPath(path.join(workspace, ...`${PACKAGE_REL}/manifests/authority-manifest.sha256`.split("/")), workspace, fsImpl, "file"), "utf8");
  assert.equal(detached, `${sha256(authorityBytes)}  authority-manifest.json\n`, "AUTHORITY_DETACHED_INVALID"); assert.equal(authority.schema, `${NAMESPACE}/authority-v1`); assert.equal(authority.namespace, NAMESPACE); assert.equal(authority.status, STATUS); assert.deepEqual(authority.packageManifest, recordR5(manifestRel, workspace, fsImpl)); return { manifest, authority };
}
function loadDependenciesR5(workspace = WORKSPACE, fsImpl = fs, loader = require) { for (const record of DEPENDENCY_RECORDS) assert.deepEqual(recordR5(record.path, workspace, fsImpl), record, `DEPENDENCY_SEAL:${record.path}`); const correction = loader("./validate-profitable-async-liability-solidity-builder-image-inspect-correction-v2.js"), created = loader("./run-profitable-async-liability-solidity-builder-host-mount-comparator-v13.js"), exited = loader("./run-profitable-async-liability-solidity-builder-exit-inspect-comparator-v15.js"); assert.equal(created.NAMESPACE, V13); assert.equal(exited.NAMESPACE, V15); return { correction, created, exited }; }
function requireAuthorityR5(workspace = WORKSPACE, fsImpl = fs) { for (const relative of AUTHORITY_ROOTS) if (!fsImpl.existsSync(path.join(workspace, ...relative.split("/")))) throw new Error("PRODUCTION_EXECUTION_AUTHORITY_REQUIRED"); throw new Error("PRODUCTION_AUTHORITY_VALIDATOR_NOT_INSTALLED"); }
function executeProductionR5(state, dependencies, options = {}) { let lifecycle; try { lifecycle = createLifecycleR5(AUTHORIZATION_ID, state, options); const result = executeWorkflowR5({ state, budgets: lifecycle.budgets, runRoot: lifecycle.runRoot, config: lifecycle.config, adapter: productionAdapterR5(lifecycle.config), journal: lifecycle.journal, validateIdentities: lifecycle.validateIdentities, validateCleanup: lifecycle.validateCleanup, assertFreshSlot: lifecycle.assertFreshSlot, verifyOutput: lifecycle.verifyOutput, validateQualification: (op, value) => validateQualificationR5(op, value, AUTHORIZATION_ID, dependencies), compareCreated: (raw, expected) => dependencies.created.compareInspect(raw, expected), compareExited: (raw, expected) => dependencies.exited.compareExitInspectRows(raw, expected) }, AUTHORIZATION_ID); const terminal = lifecycle.terminal(true, result); return { schema: `${NAMESPACE}/execution-result-v1`, status: "PASS", ...state, terminal }; } catch (error) { if (lifecycle && !error.lifecycleTerminal) try { error.lifecycleTerminal = lifecycle.terminal(false, { phase: "WORKFLOW", rootCauseCode: error.message, cleanupFailure: error.cleanupFailure || null, noRetry: true }); } catch (terminalError) { error.terminalFailure = terminalError.message; } error.executionState = state; throw error; } }
function orchestrateR5(argv, injected = {}) { if (argv.length === 0) return { schema: `${NAMESPACE}/offline-summary-v1`, status: "PASS", packageStatus: STATUS, ...freshState() }; if (argv.length !== 1 || argv[0] !== EXECUTE_FLAG) throw new Error("ARGUMENTS_REJECTED"); const workspace = injected.workspace || WORKSPACE, fsImpl = injected.fs || fs; (injected.requireAuthority || requireAuthorityR5)(workspace, fsImpl); (injected.validatePackage || validatePackageR5)(workspace, fsImpl); const dependencies = (injected.loadDependencies || loadDependenciesR5)(workspace, fsImpl); const state = freshState({ executionAuthorized: true }); return (injected.executeProduction || executeProductionR5)(state, dependencies, injected.lifecycleOptions || {}); }
function main(argv) { if (arguments.length !== 1) throw new Error("CALLER_DEPENDENCIES_REJECTED"); return orchestrateR5(argv); }
if (require.main === module) { try { process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)))}\n`); } catch (error) { const state = error.executionState || freshState(); process.stderr.write(`${JSON.stringify({ status: "FAIL", errorCode: error.message, executionAuthorized: state.executionAuthorized, consumed: state.consumed, processCalls: state.processCalls, writes: state.writes, terminalEvidenceState: state.terminalEvidenceState })}\n`); process.exitCode = 1; } }

module.exports = Object.freeze({ NAMESPACE, STATUS, EXECUTE_FLAG, EXACT_COMMAND, AUTHORIZATION_ID, V13, V15, IMAGE, CONFIG_DIGEST, OUTPUT, OUTPUT_NAME, QUALIFIED_REFERENCE, SOURCE_RECORDS, OPERATIONS, BUDGETS, DEPENDENCY_RECORDS, freshState, createBudgetsR5, buildPlanR5, expectedCreatedR5, executeWorkflowR5, createLifecycleR5, readTerminalR5, outputDescriptorR5, validatePackageR5, loadDependenciesR5, executeProductionR5, orchestrateR5, main });
