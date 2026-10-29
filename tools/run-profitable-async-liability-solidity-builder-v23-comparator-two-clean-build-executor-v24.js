#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const WORKSPACE = path.resolve(__dirname, "..");
const NAMESPACE = "profitable-async-liability-solidity-builder-v23-comparator-two-clean-build-executor-v24";
const STATUS = "V24_TWO_BUILD_EXECUTOR_SEALED_PENDING_REVIEW_NO_AUTHORITY";
const EXECUTE_FLAG = "--execute-reviewed-v24-production";
const EXACT_COMMAND = `node tools/run-${NAMESPACE}.js ${EXECUTE_FLAG}`;
const AUTHORIZATION_ID = "6f20b4c89a1e4735bd62f08c31e759ad";
const PACKAGE_REL = `tools/vendor/${NAMESPACE}`;
const PACKAGE_ROOT = path.join(WORKSPACE, ...PACKAGE_REL.split("/"));
const RUNS_ROOT = path.join(PACKAGE_ROOT, "runs");
const AUTHORITY_ROOTS = Object.freeze([
  `${PACKAGE_REL}-execution-authorization`,
  `${PACKAGE_REL}-review-decision`,
  `${PACKAGE_REL}-final-authority`
]);
const AUTHORITY_FILES = Object.freeze([
  Object.freeze({ root: AUTHORITY_ROOTS[0], payload: "execution-authorization.json" }),
  Object.freeze({ root: AUTHORITY_ROOTS[1], payload: "review-decision.json" }),
  Object.freeze({ root: AUTHORITY_ROOTS[2], payload: "final-execution-authority.json" })
]);
const PRODUCTION_TOKEN = Symbol("V24_GUARDED_PRODUCTION");

const V13 = "profitable-async-liability-solidity-builder-host-mount-comparator-v13";
const V23_CREATED = "profitable-async-liability-solidity-builder-cache-bind-aware-created-inspect-comparator-v23";
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
  Object.freeze({ path: `tools/vendor/${V15}/manifests/authority-manifest.sha256`, bytes: 90, sha256: "63ba626d2286e2cfd9738a21d357fc76fe48c25d6625d7b0f1a26eab0c57a049" }),
  Object.freeze({ path: "tools/run-profitable-async-liability-solidity-builder-image-inspect-diagnostic-v2.js", bytes: 44750, sha256: "fb42fe7a80e4dead18b7e15a0389196195f5e18501cca75054a9c8d2c06cc008" }),
  Object.freeze({ path: "tools/vendor/profitable-async-liability-solidity-builder-image-inspect-diagnostic-v2/manifests/diagnostic-manifest.json", bytes: 3840, sha256: "a322db01673e7721b76f45451a0399157cb340041e49779290a3176d7212f24b" }),
  Object.freeze({ path: "tools/vendor/profitable-async-liability-solidity-builder-image-inspect-diagnostic-v2/manifests/authority-manifest.json", bytes: 1293, sha256: "fd61ce8bcf96773ed7f0b19277aab658fe25d76320104542b3c02df2a296b295" }),
  Object.freeze({ path: "tools/vendor/profitable-async-liability-solidity-builder-image-inspect-diagnostic-v2/manifests/authority-manifest.sha256", bytes: 100, sha256: "1e36432ff15ef0d57d34df862e00420622987b528488b4f6170c93897f9f54cb" }),
  Object.freeze({ path: "tools/run-profitable-async-liability-solidity-builder-semantic-inspect-comparator-v11.js", bytes: 17813, sha256: "935d53310a5636476d3566d6aa1f9024bbb6efc1c913f5774054c105b0f60819" }),
  Object.freeze({ path: "tools/vendor/profitable-async-liability-solidity-builder-semantic-inspect-comparator-v11/manifests/package-manifest.json", bytes: 39839, sha256: "55d5b5420a87e25c1003ef04fe41d47747edcb102d8992ccf678634fafd97e96" }),
  Object.freeze({ path: "tools/vendor/profitable-async-liability-solidity-builder-semantic-inspect-comparator-v11/manifests/authority-manifest.json", bytes: 2026, sha256: "99e116fdf3ca1216131b879946addd63f880f968d62c258aeba0e1c879a624e6" }),
  Object.freeze({ path: "tools/vendor/profitable-async-liability-solidity-builder-semantic-inspect-comparator-v11/manifests/authority-manifest.sha256", bytes: 90, sha256: "7cffa5979058ef315503c28b92fddac9b46cdd73bd6d7d50b155e5c9ddadfc64" })
]);
const V24_BOUND_RECORDS = Object.freeze([
  Object.freeze({ path: `tools/run-${V23_CREATED}.js`, bytes: 18522, sha256: "87c2fb21921a6d2f34b5debdde9e175e39ebef1cdc72a2e249728534b33d1eb7" }),
  Object.freeze({ path: `tools/test-run-${V23_CREATED}.js`, bytes: 7896, sha256: "4ae6504b3f8bbdd6ab867078457032709a8711966f765c373bbe04a21b8554fd" }),
  Object.freeze({ path: "tools/vendor/profitable-async-liability-solidity-builder-cache-bind-aware-created-inspect-diagnostic-v23/manifests/package-manifest.json", bytes: 13137, sha256: "8577b53c56a6f1af258b9e088af16b2563070a51303a4bba380c4c9a51ef04e2" }),
  Object.freeze({ path: "tools/vendor/profitable-async-liability-solidity-builder-cache-bind-aware-created-inspect-diagnostic-v23/manifests/authority-manifest.json", bytes: 3183, sha256: "af7496b5d1695c9bfd3cc82dc37d1a74908c960bc504614c505b1b86787a5108" }),
  Object.freeze({ path: "tools/vendor/profitable-async-liability-solidity-builder-cache-bind-aware-created-inspect-diagnostic-v23/manifests/authority-manifest.sha256", bytes: 90, sha256: "471160b3c89dc85a10b3abe8d0f13199d9abc9aa3a5a8de95a9b2e203ae70853" }),
  Object.freeze({ path: "reports/profitable-async-liability-solidity-builder-cache-bind-aware-created-inspect-diagnostic-v23-result.md", bytes: 978, sha256: "9a1a5ad09e35c08cae8628be78d73ea6f0d4de76891dbdc6f0101739b60b2671" }),
  Object.freeze({ path: "tools/vendor/profitable-async-liability-solidity-builder-cache-bind-aware-created-inspect-diagnostic-v23/runs/8b2147f3c9de46a0b57218f64a30ce95/comparator-evidence.json", bytes: 810, sha256: "20ce8024e3dad55d79f5f03cac1f321e04c74831d19200cdb145ad315914630d" }),
  Object.freeze({ path: "tools/vendor/profitable-async-liability-solidity-builder-cache-bind-aware-created-inspect-diagnostic-v23/runs/8b2147f3c9de46a0b57218f64a30ce95/success.json", bytes: 1615, sha256: "1a08f5cba37d7329030d21bfc89df99635697b70e8cd07e1a4d1058a8a1a6fae" }),
  Object.freeze({ path: QUALIFIED_REFERENCE.terminalReport, bytes: 3284, sha256: "3ab27c8a13a86f975df550498ba581d54d27cf3f97fc363dbc1f63407250c7dc" }),
  Object.freeze({ path: "tools/vendor/profitable-async-liability-solidity-builder-target-runtime-parser-behavior-qualification-v20-r2/manifests/package-manifest.json", bytes: 4862, sha256: "b2fae4a26600380e9ab9c1c0401b32702dff076b3e716b291a19255f642f4a92" }),
  Object.freeze({ path: "tools/vendor/profitable-async-liability-solidity-builder-target-runtime-parser-behavior-qualification-v20-r2/manifests/authority-manifest.json", bytes: 1751, sha256: "0720ab6877d4cc546812e8fe05544458c404bef72cc9ba25f42e1ae5e98b98df" }),
  Object.freeze({ path: "tools/vendor/profitable-async-liability-solidity-builder-target-runtime-parser-behavior-qualification-v20-r2/manifests/authority-manifest.sha256", bytes: 90, sha256: "6b91e7741ac9e0f456f37e5010e7663f61d4d5baa6222fcc57b0ddd33fc01317" })
]);
const ALL_DEPENDENCY_RECORDS = Object.freeze([...DEPENDENCY_RECORDS, ...V24_BOUND_RECORDS]);
const CREATED_MISMATCH_CODES = Object.freeze([
  "CAP_DROP_MISMATCH", "CAUSAL_ID_MISMATCH", "CGROUPNS_MODE_MISMATCH", "COMMAND_MISMATCH", "CONFIG_DIGEST_MISMATCH", "DEVICES_MISMATCH", "ENTRYPOINT_MISMATCH", "ENV_DUPLICATE_KEY", "ENV_MALFORMED", "ENV_MISSING_KEY", "ENV_UNEXPECTED_KEY", "ENV_VALUE_MISMATCH", "EXPECTED_MALFORMED", "EXTRA_PAL_LABEL", "HOST_MOUNTS_MALFORMED", "HOST_MOUNT_EXTRA", "HOST_MOUNT_MISSING", "HOST_MOUNT_READONLY_MISMATCH", "HOST_MOUNT_SOURCE_MISMATCH", "HOST_MOUNT_TYPE_MISMATCH", "IMAGE_REFERENCE_MISMATCH", "IPC_MODE_MISMATCH", "LABELS_MALFORMED", "LABEL_MISSING", "LABEL_VALUE_MISMATCH", "MEMORY_MISMATCH", "MEMORY_SWAP_MISMATCH", "NAME_MISMATCH", "NANO_CPUS_MISMATCH", "NETWORK_MODE_MISMATCH", "PATH_POLICY_MALFORMED", "PIDS_LIMIT_MISMATCH", "PID_MODE_MISMATCH", "PRIVILEGED_MISMATCH", "RAW_MALFORMED", "READ_ONLY_ROOTFS_MISMATCH", "SECURITY_OPT_MISMATCH", "SOURCE_DATE_EPOCH_PRESENT", "STATE_RUNNING_MISMATCH", "STATE_STARTED_AT_MISMATCH", "STATE_STATUS_MISMATCH", "TMPFS_MALFORMED", "TMPFS_OPTIONS_MISMATCH", "TMPFS_TARGET_EXTRA", "TMPFS_TARGET_MISSING", "TOP_MOUNTS_MALFORMED", "TOP_MOUNT_EXTRA", "TOP_MOUNT_MISSING", "TOP_MOUNT_RECONCILIATION_MISMATCH", "TOP_MOUNT_RW_MISMATCH", "TOP_MOUNT_TYPE_MISMATCH", "USER_MISMATCH", "UTS_MODE_MISMATCH", "WORKDIR_MISMATCH"
].sort());
const ALLOWED_CREATED_REPRESENTATION_NOTES = Object.freeze(["ENV_ORDER_ONLY", "EXTRA_NON_PAL_LABELS_PRESENT"].sort());

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function exactKeysV24(value, keys, code) { assert.equal(value && typeof value === "object" && !Array.isArray(value), true, code); assert.deepEqual(Object.keys(value), keys, code); }
function contained(target, root) { const rel = path.relative(path.resolve(root), path.resolve(target)); return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)); }
function successful(result) { return !!result && result.status === 0 && result.signal == null && !(result.error && result.error.code) && result.stderr === ""; }
function sanitizedResult(result, classification) { return { status: Number.isInteger(result && result.status) ? result.status : null, signal: result && typeof result.signal === "string" ? result.signal.slice(0, 32) : null, spawnErrorCode: result && result.error && typeof result.error.code === "string" ? result.error.code.slice(0, 32) : null, stdoutBytes: Buffer.byteLength(result && typeof result.stdout === "string" ? result.stdout : ""), stderrBytes: Buffer.byteLength(result && typeof result.stderr === "string" ? result.stderr : ""), classification }; }
function exactCreateId(result) { return successful(result) && /^[a-f0-9]{64}\n$/.test(result.stdout || "") ? result.stdout.slice(0, 64) : null; }
function validateCreatedComparisonV24(value) { exactKeysV24(value, ["match", "mismatchCodes", "representationNotes"], "CREATED_INSPECT_COMPARATOR_INVALID"); assert.equal(typeof value.match === "boolean" && Array.isArray(value.mismatchCodes) && Array.isArray(value.representationNotes), true, "CREATED_INSPECT_COMPARATOR_INVALID"); assert.equal(new Set(value.mismatchCodes).size === value.mismatchCodes.length && value.mismatchCodes.every((code) => CREATED_MISMATCH_CODES.includes(code)), true, "CREATED_INSPECT_COMPARATOR_INVALID"); assert.equal(new Set(value.representationNotes).size === value.representationNotes.length && value.representationNotes.every((note) => typeof note === "string"), true, "CREATED_INSPECT_COMPARATOR_INVALID"); assert.equal(value.match, value.mismatchCodes.length === 0, "CREATED_INSPECT_COMPARATOR_INVALID"); assert.equal(value.match && value.mismatchCodes.length === 0, true, "CREATED_INSPECT_SEMANTIC_MISMATCH"); assert.equal(value.representationNotes.every((note) => ALLOWED_CREATED_REPRESENTATION_NOTES.includes(note)), true, "CREATED_INSPECT_REPRESENTATION_NOTE_BLOCKED"); return value; }
function processResult(error) { return { status: null, signal: null, error: { code: error && error.code || "OTHER" }, stdout: "", stderr: "" }; }
function freshState(overrides = {}) { return { executionAuthorized: false, consumed: false, processCalls: 0, writes: 0, buildAttempts: 0, successfulBuilds: 0, cleanupAttempts: 0, cleanupSuccesses: 0, networkCalls: 0, lastProcess: null, terminal: null, terminalEvidenceState: "NOT_CONSUMED", ...overrides }; }
function createBudgetsV24(state, limits = BUDGETS) {
  return Object.freeze({
    beforeProcess() { if (state.processCalls >= limits.maximumProcessCalls) throw new Error("PROCESS_BUDGET_EXCEEDED"); state.processCalls += 1; },
    beforeWrite() { if (state.writes >= limits.maximumWrites) throw new Error("WRITE_BUDGET_EXCEEDED"); state.writes += 1; }
  });
}

function labelsForV24(id, label) { assert.match(id, /^[a-f0-9]{32}$/, "AUTHORIZATION_ID_INVALID"); assert.equal(label === "a" || label === "b", true); return { "pal.authorization": id, "pal.executor": NAMESPACE, "pal.build": label }; }
function buildPlanV24(config, runRoot, id) {
  const base = ["--config", config, "--host", ENDPOINT];
  const builds = ["a", "b"].map((label) => {
    const upper = label.toUpperCase(), name = `pal-v24-${id}-${label}`, work = path.join(runRoot, `work-${label}`), cache = path.join(runRoot, `cache-${label}`), output = path.join(runRoot, `out-${label}`), labels = labelsForV24(id, label);
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
function expectedCreatedV24(spec, receipt) { return { id: receipt, name: `/${spec.name}`, configDigest: CONFIG_DIGEST, imageReference: IMAGE, labels: spec.labels, environment: [...IMAGE_ENV, ...EXPLICIT_ENV], entrypoint: [ENTRYPOINT], command: [...EMCC_ARGV], user: "65532:65532", workdir: "/src", state: { status: "created", running: false, startedAt: ZERO_TIME }, pathPolicy: process.platform === "win32" ? "win32" : "exact", host: { networkMode: "none", readOnlyRootfs: true, privileged: false, memory: LIMITS.memory, memorySwap: LIMITS.memorySwap, nanoCpus: LIMITS.nanoCpus, pidsLimit: LIMITS.pidsLimit, ipcMode: "private", cgroupnsMode: "private", pidMode: "", utsMode: "", tmpfs: { ...TMPFS } }, mounts: [{ type: "bind", source: path.resolve(spec.work), target: "/src", readOnly: true }, { type: "bind", source: path.resolve(spec.cache), target: "/cache", readOnly: false }, { type: "bind", source: path.resolve(spec.output), target: "/out", readOnly: false }] }; }

function validateQualificationV24(operation, result, id, deps) {
  assert.equal(successful(result), true, `${operation}_QUALIFICATION_FAILED`);
  const value = JSON.parse(result.stdout);
  if (operation === "VERSION") { assert.equal(value.Client.Version, DOCKER_VERSION); assert.equal(value.Server.Version, DOCKER_VERSION); return; }
  if (operation === "INFO") { assert.equal(value.ServerVersion, DOCKER_VERSION); assert.equal(value.OSType, "linux"); assert.equal(["amd64", "x86_64"].includes(String(value.Architecture).toLowerCase()), true); assert.equal(Array.isArray(value.SecurityOptions) && value.SecurityOptions.some((x) => /seccomp|no-new-privileges/i.test(String(x))), true); assert.equal(Number(value.NCPU) >= 2, true); assert.equal(Number(value.MemTotal) >= LIMITS.memory, true); return; }
  assert.equal(Array.isArray(value) && value.length === 1, true);
  const diagnosis = deps.correction.compareCorrectedInspect(value[0], { source: "DOCKER_IMAGE_INSPECT_MEMORY_ONLY", runId: id });
  assert.equal(diagnosis.status, "IMAGE_INSPECT_DIAGNOSIS_MATCH"); assert.equal(diagnosis.summary.fieldsCompared, 9); assert.equal(diagnosis.summary.fieldsMismatched, 0);
}

function executeWorkflowV24(io, id) {
  assert.equal(io && typeof io === "object", true, "IO_REQUIRED");
  assert.equal(io.testMode === true || io.productionToken === PRODUCTION_TOKEN, true, "WORKFLOW_MODE_REJECTED");
  assert.equal(io.adapter && typeof io.adapter.call === "function", true, "INJECTED_ADAPTER_REQUIRED");
  const state = io.state || freshState(), budgets = io.budgets || createBudgetsV24(state), plan = buildPlanV24(io.config, io.runRoot, id), calls = [], records = {}, expectedOutput = io.expectedOutput || OUTPUT;
  let cursor = 0, activeSpec = null;
  const journal = (phase, op, result) => io.journal(phase, op, result);
  function assertSlot(op, cleanup) { const slot = OPERATIONS.indexOf(op); assert.notEqual(slot, -1, "OPERATION_NOT_ALLOWED"); if (cleanup) assert.equal(op, `${activeSpec.upper}_RM_FORCE`, "CLEANUP_OPERATION_NOT_ALLOWED"); else assert.equal(slot, cursor, "OPERATION_ORDER_INVALID"); return slot; }
  function invokeNormal(op, argv, timeout, immediatelyBeforeCall = null) {
    const slot = assertSlot(op, false); io.validateIdentities(op); journal("before", op, null); budgets.beforeProcess();
    if (op.endsWith("_START_ATTACH")) state.buildAttempts += 1;
    if (immediatelyBeforeCall) immediatelyBeforeCall();
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
  const qualification = io.validateQualification || ((op, result) => validateQualificationV24(op, result, id, io.dependencies));
  for (const [op, argv] of [["VERSION", plan.version], ["INFO", plan.info], ["IMAGE_INSPECT", plan.image]]) { const result = invokeNormal(op, argv, ADMIN_TIMEOUT_MS); qualification(op, result, id); }
  for (const spec of plan.builds) {
    activeSpec = spec;
    let cleanupTarget = null, receipt = null, primary = null;
    try {
      io.assertFreshSlot(spec.label, "BEFORE_CREATE");
      let created;
      try { created = invokeNormal(`${spec.upper}_CREATE`, spec.create, ADMIN_TIMEOUT_MS, () => { cleanupTarget = spec.name; }); } catch (error) { receipt = exactCreateId(error.result); throw error; }
      receipt = exactCreateId(created);
      const inspected = invokeNormal(`${spec.upper}_CREATED_INSPECT`, receipt ? spec.inspectId(receipt) : spec.inspectName, ADMIN_TIMEOUT_MS);
      assert.equal(successful(inspected), true, "CREATED_INSPECT_FAILED");
      const rows = JSON.parse(inspected.stdout); assert.equal(Array.isArray(rows) && rows.length === 1, true, "CREATED_INSPECT_FAILED");
      const row = rows[0];
      if (!receipt) { assert.match(row.Id, /^[a-f0-9]{64}$/, "CREATE_RECEIPT_INVALID"); receipt = row.Id; }
      assert.equal(receipt === row.Id, true, "CREATE_AMBIGUOUS_FOREIGN"); const createdComparison = validateCreatedComparisonV24(io.compareCreated(row, expectedCreatedV24(spec, receipt)));
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
  assert.equal(Buffer.isBuffer(records.a.content), true, "OUTPUT_A_BYTES_REQUIRED"); assert.equal(Buffer.isBuffer(records.b.content), true, "OUTPUT_B_BYTES_REQUIRED");
  assert.equal(records.a.content.equals(records.b.content), true, "OUTPUT_BYTES_DIFFER");
  return { schema: `${NAMESPACE}/workflow-result-v1`, status: "PARSER_AUTHORITY_CANDIDATE_REPRODUCIBLE_EXACT_QUALIFIED_REFERENCE", automaticPromotion: false, detectorRun: false, calls, processCalls: state.processCalls, buildAttempts: state.buildAttempts, successfulBuilds: state.successfulBuilds, cleanupAttempts: state.cleanupAttempts, cleanupSuccesses: state.cleanupSuccesses, networkCalls: state.networkCalls, records: { a: { bytes: records.a.bytes, sha256: records.a.sha256 }, b: { bytes: records.b.bytes, sha256: records.b.sha256 } } };
}

function strictPath(target, root, fsImpl, kind = null) {
  const absolute = path.resolve(target), base = path.resolve(root); assert.equal(contained(absolute, base), true, "PATH_OUTSIDE_ROOT");
  let cursor = base; const rel = path.relative(base, absolute);
  for (const part of rel.split(path.sep).filter(Boolean)) { cursor = path.join(cursor, part); assert.equal(fsImpl.existsSync(cursor), true, "PATH_MISSING"); const stat = fsImpl.lstatSync(cursor); assert.equal(stat.isSymbolicLink(), false, "PATH_SYMLINK_OR_REPARSE"); const real = fsImpl.realpathSync.native ? fsImpl.realpathSync.native(cursor) : fsImpl.realpathSync(cursor); assert.equal(path.resolve(real), path.resolve(cursor), "PATH_SYMLINK_OR_REPARSE"); }
  const stat = fsImpl.lstatSync(absolute); assert.equal(stat.isSymbolicLink(), false, "PATH_SYMLINK_OR_REPARSE"); if (kind) assert.equal(kind === "file" ? stat.isFile() : stat.isDirectory(), true, "PATH_KIND_INVALID"); return absolute;
}
function identityV24(target, root, fsImpl, kind) { const checked = strictPath(target, root, fsImpl, kind), stat = fsImpl.lstatSync(checked), real = fsImpl.realpathSync.native ? fsImpl.realpathSync.native(checked) : fsImpl.realpathSync(checked); return { path: checked, real: path.resolve(real), dev: stat.dev == null ? null : stat.dev, ino: stat.ino == null ? null : stat.ino, kind }; }
function sameIdentityV24(expected, root, fsImpl) { assert.deepEqual(identityV24(expected.path, root, fsImpl, expected.kind), expected, "IDENTITY_CHANGED"); }
function fileBindingV24(target, root, fsImpl) { const metadata = identityV24(target, root, fsImpl, "file"), bytes = fsImpl.readFileSync(metadata.path); return { metadata, bytes: bytes.length, sha256: sha256(bytes) }; }
function sameBindingV24(expected, root, fsImpl, code) { try { sameIdentityV24(expected.metadata, root, fsImpl); const bytes = fsImpl.readFileSync(expected.metadata.path); assert.deepEqual({ bytes: bytes.length, sha256: sha256(bytes) }, { bytes: expected.bytes, sha256: expected.sha256 }); } catch { throw new Error(code); } }
function reliableStatV24(stat) { const dev = typeof stat.dev === "bigint" ? stat.dev !== 0n : Number.isFinite(stat.dev) && stat.dev !== 0, ino = typeof stat.ino === "bigint" ? stat.ino !== 0n : Number.isFinite(stat.ino) && stat.ino !== 0; return dev && ino; }
function fsyncDirectoryV24(dir, fsImpl) { let fd; try { fd = fsImpl.openSync(dir, "r"); fsImpl.fsyncSync(fd); } catch (error) { if (!(process.platform === "win32" && error && ["EPERM", "EACCES", "EINVAL"].includes(error.code))) throw error; } finally { if (fd !== undefined) fsImpl.closeSync(fd); } }
function writeAllV24(fd, bytes, fsImpl) { let offset = 0; while (offset < bytes.length) { const written = fsImpl.writeSync(fd, bytes, offset, bytes.length - offset, null); assert.equal(written > 0, true, "WRITE_FAILED"); offset += written; } }
function writeExclusiveDurableV24(file, value, fsImpl, budgets) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`), temp = `${file}.pending-write`; budgets.beforeWrite(); const fd = fsImpl.openSync(temp, "wx", 0o600);
  try { writeAllV24(fd, bytes, fsImpl); fsImpl.fsyncSync(fd); } finally { fsImpl.closeSync(fd); }
  assert.equal(fsImpl.existsSync(file), false, "EXCLUSIVE_COMMIT_TARGET_EXISTS"); budgets.beforeWrite(); fsImpl.renameSync(temp, file); fsyncDirectoryV24(path.dirname(file), fsImpl);
  assert.equal(fsImpl.readFileSync(file).equals(bytes), true, "DURABLE_READBACK_FAILED"); return { path: path.basename(file), bytes: bytes.length, sha256: sha256(bytes) };
}
function openJournalV24(runRoot, fsImpl, budgets) {
  const file = path.join(runRoot, "journal.jsonl"); budgets.beforeWrite(); const fd = fsImpl.openSync(file, "wx", 0o600), expected = []; let sequence = 0, closed = false, degraded = false;
  return {
    append(phase, operation, result) { if (degraded) throw new Error("JOURNAL_DEGRADED"); const line = `${JSON.stringify({ sequence, phase, operation, result })}\n`, bytes = Buffer.from(line); try { budgets.beforeWrite(); writeAllV24(fd, bytes, fsImpl); fsImpl.fsyncSync(fd); expected.push(line); sequence += 1; } catch (error) { degraded = true; throw error; } },
    closeAndVerify() { if (!closed) { try { fsImpl.fsyncSync(fd); } finally { fsImpl.closeSync(fd); closed = true; } } if (degraded) return { status: "JOURNAL_DEGRADED", records: sequence }; const bytes = fsImpl.readFileSync(file), canonical = Buffer.from(expected.join("")); assert.equal(bytes.equals(canonical), true, "JOURNAL_READBACK_MISMATCH"); return { status: "JOURNAL_VERIFIED", path: "journal.jsonl", bytes: bytes.length, sha256: sha256(bytes), records: sequence }; }
  };
}
function readTerminalV24(runRoot, fsImpl = fs) {
  const successPath = path.join(runRoot, "success.json"), failurePath = path.join(runRoot, "failure.json"), success = fsImpl.existsSync(successPath), failure = fsImpl.existsSync(failurePath);
  assert.equal(Number(success) + Number(failure), 1, "TERMINAL_CARDINALITY_INVALID"); const file = success ? successPath : failurePath, bytes = fsImpl.readFileSync(file), value = JSON.parse(bytes); assert.equal(value.status, success ? "PASS" : "FAIL", "TERMINAL_STATUS_INVALID"); return { authoritative: path.basename(file), value, record: { path: path.basename(file), bytes: bytes.length, sha256: sha256(bytes) } };
}
function outputDescriptorV24(dir, workspace, fsImpl, expected = OUTPUT) {
  const chain = identityV24(dir, workspace, fsImpl, "directory"); sameIdentityV24(chain, workspace, fsImpl); assert.deepEqual(fsImpl.readdirSync(dir).sort(), [OUTPUT_NAME], "OUTPUT_INVALID");
  const target = path.join(dir, OUTPUT_NAME), lexicalStat = fsImpl.lstatSync(target); assert.equal(lexicalStat.isFile() && !lexicalStat.isSymbolicLink(), true, "OUTPUT_REPARSE_UNSAFE"); assert.equal(reliableStatV24(lexicalStat), true, "OUTPUT_IDENTITY_UNRELIABLE");
  const lexical = identityV24(target, workspace, fsImpl, "file"), noFollow = typeof fsImpl.constants.O_NOFOLLOW === "number" ? fsImpl.constants.O_NOFOLLOW : 0, fd = fsImpl.openSync(target, fsImpl.constants.O_RDONLY | noFollow); let before, after, bytes;
  try { before = fsImpl.fstatSync(fd); assert.equal(before.isFile(), true, "OUTPUT_INVALID"); assert.equal(reliableStatV24(before), true, "OUTPUT_IDENTITY_UNRELIABLE"); assert.deepEqual({ dev: before.dev, ino: before.ino, type: before.isFile() }, { dev: lexicalStat.dev, ino: lexicalStat.ino, type: lexicalStat.isFile() }, "OUTPUT_DESCRIPTOR_MISMATCH"); assert.equal(before.size <= MAX_BUFFER, true, "OUTPUT_INVALID"); bytes = Buffer.alloc(before.size); let offset = 0; while (offset < bytes.length) { const count = fsImpl.readSync(fd, bytes, offset, bytes.length - offset, offset); assert.equal(count > 0, true, "OUTPUT_INVALID"); offset += count; } after = fsImpl.fstatSync(fd); assert.deepEqual({ dev: after.dev, ino: after.ino, size: after.size, mtimeMs: after.mtimeMs, type: after.isFile() }, { dev: before.dev, ino: before.ino, size: before.size, mtimeMs: before.mtimeMs, type: before.isFile() }, "OUTPUT_CHANGED"); } finally { fsImpl.closeSync(fd); }
  sameIdentityV24(chain, workspace, fsImpl); sameIdentityV24(lexical, workspace, fsImpl); assert.deepEqual(fsImpl.readdirSync(dir).sort(), [OUTPUT_NAME], "OUTPUT_CHANGED"); assert.deepEqual({ bytes: bytes.length, sha256: sha256(bytes) }, expected, "OUTPUT_INVALID"); return { ...expected, content: bytes };
}

function createLifecycleV24(id, state, options = {}) {
  assert.match(id, /^[a-f0-9]{32}$/, "AUTHORIZATION_ID_INVALID");
  assert.equal(options.testMode === true || options.productionToken === PRODUCTION_TOKEN, true, "LIFECYCLE_MODE_REJECTED");
  if (options.testMode === true) for (const key of ["fs", "workspace", "packageRoot", "sourceRecords", "expectedOutput"]) assert.notEqual(options[key], undefined, `TEST_INJECTION_REQUIRED:${key}`);
  const fsImpl = options.fs || fs, workspace = path.resolve(options.workspace || WORKSPACE), packageRoot = path.resolve(options.packageRoot || PACKAGE_ROOT), runsRoot = path.join(packageRoot, "runs"), sourceRecords = options.sourceRecords || SOURCE_RECORDS, expectedOutput = options.expectedOutput || OUTPUT, budgets = options.budgets || createBudgetsV24(state, options.limits || BUDGETS);
  strictPath(packageRoot, workspace, fsImpl, "directory");
  if (fsImpl.existsSync(runsRoot)) strictPath(runsRoot, packageRoot, fsImpl, "directory");
  else { budgets.beforeWrite(); fsImpl.mkdirSync(runsRoot, { recursive: false }); fsyncDirectoryV24(packageRoot, fsImpl); fsyncDirectoryV24(runsRoot, fsImpl); }
  const runRoot = path.join(runsRoot, id);
  if (fsImpl.existsSync(runRoot)) { try { strictPath(runRoot, runsRoot, fsImpl, "directory"); } catch { throw new Error("RUN_ROOT_UNSAFE"); } throw new Error("AUTHORIZATION_ALREADY_CONSUMED"); }
  budgets.beforeWrite(); try { fsImpl.mkdirSync(runRoot, { recursive: false }); } catch { throw new Error("RUN_ROOT_EXCLUSIVE_CREATE_FAILED"); }
  state.executionAuthorized = true; state.consumed = true; state.runRoot = runRoot; state.terminalEvidenceState = "CONSUMED_ROOT_CREATED_NO_MARKER";
  const config = path.join(runRoot, "docker-config"), plan = buildPlanV24(config, runRoot, id); let journal = null, consumption = null, terminalClosed = false;
  function terminalPayload(success, value, journalRecord) { return { schema: `${NAMESPACE}/${success ? "success" : "failure"}-v1`, status: success ? "PASS" : "FAIL", authorizationId: id, executionAuthorized: true, consumed: true, processCalls: state.processCalls, writesBeforeTerminalCommit: state.writes, buildAttempts: state.buildAttempts, successfulBuilds: state.successfulBuilds, cleanupAttempts: state.cleanupAttempts, cleanupSuccesses: state.cleanupSuccesses, networkCalls: state.networkCalls, terminalEvidenceState: success ? "PERSISTED_SUCCESS_JOURNAL_VERIFIED" : journalRecord && journalRecord.status === "JOURNAL_VERIFIED" ? "PERSISTED_FAILURE_JOURNAL_VERIFIED" : "PERSISTED_FAILURE_JOURNAL_DEGRADED", consumption, journal: journalRecord, value }; }
  function invalidateSuccess() { for (const name of ["success.pending.json", "success.json"]) { const target = path.join(runRoot, name); if (fsImpl.existsSync(target)) { const invalid = path.join(runRoot, `${name}.invalid`); if (fsImpl.existsSync(invalid)) { budgets.beforeWrite(); fsImpl.unlinkSync(invalid); } budgets.beforeWrite(); fsImpl.renameSync(target, invalid); } } fsyncDirectoryV24(runRoot, fsImpl); }
  function exclusiveTerminalLink(pendingPath, finalPath) { assert.equal(fsImpl.existsSync(finalPath), false, "TERMINAL_TARGET_EXISTS"); budgets.beforeWrite(); fsImpl.linkSync(pendingPath, finalPath); budgets.beforeWrite(); fsImpl.unlinkSync(pendingPath); fsyncDirectoryV24(runRoot, fsImpl); }
  function commitFailure(value, journalRecord) { invalidateSuccess(); const failurePath = path.join(runRoot, "failure.json"), pendingPath = path.join(runRoot, "failure.pending.json"); if (fsImpl.existsSync(failurePath)) return readTerminalV24(runRoot, fsImpl); writeExclusiveDurableV24(pendingPath, terminalPayload(false, value, journalRecord), fsImpl, budgets); exclusiveTerminalLink(pendingPath, failurePath); const terminal = readTerminalV24(runRoot, fsImpl); state.terminal = terminal; state.terminalEvidenceState = terminal.value.terminalEvidenceState; terminalClosed = true; return terminal; }
  function terminal(success, value) {
    if (terminalClosed) throw new Error("TERMINAL_ALREADY_COMMITTED");
    let journalRecord = null; try { journalRecord = journal ? journal.closeAndVerify() : null; } catch (error) { return commitFailure({ phase: "JOURNAL_FINALIZATION", rootCauseCode: error.message, noRetry: true }, null); }
    if (!success) return commitFailure(value, journalRecord);
    if (!journalRecord || journalRecord.status !== "JOURNAL_VERIFIED") return commitFailure({ phase: "SUCCESS_FINALIZATION", rootCauseCode: "SUCCESS_JOURNAL_NOT_VERIFIED", noRetry: true }, journalRecord);
    const pendingPath = path.join(runRoot, "success.pending.json"), successPath = path.join(runRoot, "success.json");
    try {
      writeExclusiveDurableV24(pendingPath, terminalPayload(true, value, journalRecord), fsImpl, budgets);
      if (options.beforeSuccessCommit) options.beforeSuccessCommit({ runRoot, state });
      assert.equal(fsImpl.existsSync(path.join(runRoot, "failure.json")), false, "TERMINAL_TARGET_EXISTS"); exclusiveTerminalLink(pendingPath, successPath);
      const committed = readTerminalV24(runRoot, fsImpl); state.terminal = committed; state.terminalEvidenceState = committed.value.terminalEvidenceState; terminalClosed = true; return committed;
    } catch (error) { return commitFailure({ phase: "SUCCESS_COMMIT", rootCauseCode: error.message, noRetry: true }, journalRecord); }
  }
  try {
    fsyncDirectoryV24(runsRoot, fsImpl); fsyncDirectoryV24(runRoot, fsImpl);
    consumption = writeExclusiveDurableV24(path.join(runRoot, "authorization-consumed.json"), { schema: `${NAMESPACE}/authorization-consumed-v1`, status: "CONSUMED", authorizationId: id, oneShot: true, exactCommand: EXACT_COMMAND }, fsImpl, budgets);
    for (const dir of [config, ...plan.builds.flatMap((spec) => [spec.work, path.join(spec.work, "tree_sitter"), spec.cache, spec.output])]) { budgets.beforeWrite(); fsImpl.mkdirSync(dir, { recursive: false }); fsyncDirectoryV24(path.dirname(dir), fsImpl); }
    for (const spec of plan.builds) for (const record of sourceRecords) { const source = strictPath(path.join(workspace, ...record.path.split("/")), workspace, fsImpl, "file"), sourceBytes = fsImpl.readFileSync(source); assert.deepEqual({ bytes: sourceBytes.length, sha256: sha256(sourceBytes) }, { bytes: record.bytes, sha256: record.sha256 }, "SOURCE_SEAL_INVALID"); const target = path.join(spec.work, ...record.stage.split("/")); budgets.beforeWrite(); fsImpl.copyFileSync(source, target, fsImpl.constants.COPYFILE_EXCL); fsyncDirectoryV24(path.dirname(target), fsImpl); }
    const configRecord = writeExclusiveDurableV24(path.join(config, "config.json"), { auths: {} }, fsImpl, budgets); assert.deepEqual({ bytes: configRecord.bytes, sha256: configRecord.sha256 }, { bytes: EMPTY_DOCKER_CONFIG_BYTES.length, sha256: sha256(EMPTY_DOCKER_CONFIG_BYTES) }, "DOCKER_CONFIG_INVALID");
    const identities = { runRoot: identityV24(runRoot, workspace, fsImpl, "directory"), config: identityV24(config, workspace, fsImpl, "directory"), configFile: fileBindingV24(path.join(config, "config.json"), workspace, fsImpl), builds: plan.builds.map((spec) => ({ label: spec.label, work: identityV24(spec.work, workspace, fsImpl, "directory"), tree: identityV24(path.join(spec.work, "tree_sitter"), workspace, fsImpl, "directory"), cache: identityV24(spec.cache, workspace, fsImpl, "directory"), output: identityV24(spec.output, workspace, fsImpl, "directory"), staged: sourceRecords.map((record) => ({ record, binding: fileBindingV24(path.join(spec.work, ...record.stage.split("/")), workspace, fsImpl) })) })) };
    journal = openJournalV24(runRoot, fsImpl, budgets); state.terminalEvidenceState = "CONSUMED_SETUP_COMPLETE_NO_PROCESS";
    function validateIdentities() { sameIdentityV24(identities.runRoot, workspace, fsImpl); sameIdentityV24(identities.config, workspace, fsImpl); sameBindingV24(identities.configFile, workspace, fsImpl, "CONFIG_IDENTITY_UNSAFE"); for (const build of identities.builds) { sameIdentityV24(build.work, workspace, fsImpl); sameIdentityV24(build.tree, workspace, fsImpl); sameIdentityV24(build.cache, workspace, fsImpl); sameIdentityV24(build.output, workspace, fsImpl); for (const staged of build.staged) sameBindingV24(staged.binding, workspace, fsImpl, "STAGED_SOURCE_CONTENT_CHANGED"); } }
    function assertFreshSlot(label) {
      validateIdentities(); const active = identities.builds[label === "a" ? 0 : 1];
      for (const build of identities.builds) { assert.deepEqual(fsImpl.readdirSync(build.work.path).sort(), ["parser.c", "tree_sitter"], "STAGED_SOURCE_LISTING_CHANGED"); assert.deepEqual(fsImpl.readdirSync(build.tree.path).sort(), ["parser.h"], "STAGED_SOURCE_LISTING_CHANGED"); }
      assert.deepEqual(fsImpl.readdirSync(active.cache.path), [], "CACHE_NOT_EMPTY"); assert.deepEqual(fsImpl.readdirSync(active.output.path), [], "OUTPUT_NOT_EMPTY");
    }
    function validateCleanup(operation, target, causal) { assert.equal(["A_RM_FORCE", "B_RM_FORCE"].includes(operation), true, "CLEANUP_OPERATION_NOT_ALLOWED"); assert.equal(target === causal.receipt || target === causal.deterministicName, true, "CLEANUP_TARGET_NOT_CAUSAL"); sameIdentityV24(identities.config, workspace, fsImpl); sameBindingV24(identities.configFile, workspace, fsImpl, "CONFIG_IDENTITY_UNSAFE"); }
    return { runRoot, config, state, budgets, plan, journal: journal.append, validateIdentities, validateCleanup, assertFreshSlot, verifyOutput(label) { return outputDescriptorV24(plan.builds.find((spec) => spec.label === label).output, workspace, fsImpl, expectedOutput); }, terminal };
  } catch (error) { try { error.lifecycleTerminal = terminal(false, { phase: "SETUP", rootCauseCode: error.message, noRetry: true }); } catch (terminalError) { error.terminalFailure = terminalError.message; } error.executionState = state; throw error; }
}

function sanitizedDockerEnvV24(config, env = process.env) { const forbidden = ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_AUTH_CONFIG", "REGISTRY_AUTH_FILE", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY"]; for (const key of Object.keys(env)) if (forbidden.includes(key.toUpperCase())) throw new Error("DOCKER_ENV_REJECTED"); return { DOCKER_CONFIG: config, PATH: env.PATH, SystemRoot: env.SystemRoot }; }
function productionAdapterV24(config) { const env = sanitizedDockerEnvV24(config); return { call(_operation, argv, timeout) { const result = childProcess.spawnSync("docker", argv, { shell: false, windowsHide: true, encoding: "utf8", env, timeout, maxBuffer: MAX_BUFFER }); return { status: Number.isInteger(result.status) ? result.status : null, signal: result.signal || null, error: result.error || null, stdout: typeof result.stdout === "string" ? result.stdout : "", stderr: typeof result.stderr === "string" ? result.stderr : "" }; } }; }
function recordV24(relative, workspace = WORKSPACE, fsImpl = fs) { const file = strictPath(path.join(workspace, ...relative.split("/")), workspace, fsImpl, "file"), bytes = fsImpl.readFileSync(file); return { path: relative, bytes: bytes.length, sha256: sha256(bytes) }; }
const CLAIMS = Object.freeze({ execution: false, reproducibilityResult: false, parserPromotion: false, detectorRun: false, invocationAuthority: false });
const STANDING_USER_RESPONSE_TEXT = "authorization granted, no need to ask in future for authorizations update state instructions and proceed without interruptions";
const SCOPE_EXCLUSIONS = Object.freeze(["SIGNING", "BROADCAST", "WALLET_OR_KEY_OPERATION", "PRODUCTION_MUTATION", "FUND_MOVEMENT", "PROJECT_INSTRUCTION_CURRENT_TURN_ONLY_CATEGORIES"]);
const EXPORTED_TEST_HOOKS = Object.freeze(["executeWorkflowV24", "createTestLifecycleV24", "validateAuthorityV24", "validateProductionPrerequisitesV24", "loadDependenciesV24"]);
function authorityContractV24() { return AUTHORITY_FILES.map((spec) => ({ root: spec.root, files: [spec.payload, "authority-manifest.json", "authority-manifest.sha256"] })); }
function transcriptPolicyV24() { return { assistantRequest: "EXACT_TEXT_BYTES_SHA256_WITH_ID_COMMAND_ONE_SHOT_NO_RETRY", userResponse: "EXACT_STANDING_GRANT_TEXT_BYTES_SHA256", standingAuthorization: "DEFENSIVE_OFFLINE_READ_ONLY_BUILD_WORKFLOW_UNTIL_REVOKED", exclusions: [...SCOPE_EXCLUSIONS] }; }
function authorityScopeV24() { return { exactCommand: EXACT_COMMAND, executorNamespace: NAMESPACE, authorizationId: AUTHORIZATION_ID, containerPrefix: "pal-v24-", operationOrder: [...OPERATIONS], expectedOutput: OUTPUT, limits: BUDGETS, standingAuthorization: "DEFENSIVE_OFFLINE_READ_ONLY_BUILD_WORKFLOW_UNTIL_REVOKED", exclusions: [...SCOPE_EXCLUSIONS], oneShot: true, noRetry: true, networkCalls: 0, claims: CLAIMS }; }
function validatePackageV24(workspace = WORKSPACE, fsImpl = fs) {
  const root = strictPath(path.join(workspace, ...PACKAGE_REL.split("/")), workspace, fsImpl, "directory"), rootChildren = fsImpl.readdirSync(root).sort(); assert.deepEqual(rootChildren.filter((name) => name !== "runs"), ["executor-policy.json", "manifests"], "PACKAGE_CARDINALITY_INVALID"); if (rootChildren.includes("runs")) strictPath(path.join(root, "runs"), root, fsImpl, "directory");
  const manifests = strictPath(path.join(root, "manifests"), root, fsImpl, "directory"); assert.deepEqual(fsImpl.readdirSync(manifests).sort(), ["authority-manifest.json", "authority-manifest.sha256", "package-manifest.json"], "PACKAGE_CARDINALITY_INVALID");
  const manifestRel = `${PACKAGE_REL}/manifests/package-manifest.json`, manifest = JSON.parse(fsImpl.readFileSync(strictPath(path.join(workspace, ...manifestRel.split("/")), workspace, fsImpl, "file")));
  exactKeysV24(manifest, ["schema", "namespace", "status", "authorizationId", "executeFlag", "exactCommand", "expectedOutput", "limits", "containerPrefix", "exports", "authorityContract", "transcriptPolicy", "successorRecords", "dependencyRecords", "claims"], "PACKAGE_MANIFEST_INVALID");
  assert.equal(manifest.schema, `${NAMESPACE}/package-manifest-v1`); assert.equal(manifest.namespace, NAMESPACE); assert.equal(manifest.status, STATUS); assert.equal(manifest.authorizationId, AUTHORIZATION_ID); assert.equal(manifest.executeFlag, EXECUTE_FLAG); assert.equal(manifest.exactCommand, EXACT_COMMAND); assert.deepEqual(manifest.expectedOutput, OUTPUT); assert.deepEqual(manifest.limits, BUDGETS); assert.equal(manifest.containerPrefix, "pal-v24-"); assert.deepEqual(manifest.exports, EXPORTED_TEST_HOOKS); assert.deepEqual(manifest.authorityContract, authorityContractV24()); assert.deepEqual(manifest.transcriptPolicy, transcriptPolicyV24()); assert.deepEqual(manifest.claims, CLAIMS); assert.equal(manifest.successorRecords.length, 4); assert.equal(manifest.dependencyRecords.length, 38);
  const expectedRolePaths = [`tools/run-${NAMESPACE}.js`, `tools/test-run-${NAMESPACE}.js`, `reports/${NAMESPACE}.md`, `${PACKAGE_REL}/executor-policy.json`]; assert.deepEqual(manifest.successorRecords.map((record) => record.path), expectedRolePaths); assert.deepEqual(manifest.dependencyRecords, ALL_DEPENDENCY_RECORDS);
  for (const record of [...manifest.successorRecords, ...manifest.dependencyRecords]) assert.deepEqual(recordV24(record.path, workspace, fsImpl), record, `SEAL:${record.path}`);
  const policy = JSON.parse(fsImpl.readFileSync(strictPath(path.join(workspace, ...`${PACKAGE_REL}/executor-policy.json`.split("/")), workspace, fsImpl, "file"))); exactKeysV24(policy, ["schema", "namespace", "status", "authorizationId", "executeFlag", "exactCommand", "expectedOutput", "containerPrefix", "tmpfs", "cache", "limits", "successCounters", "exports", "authorityContract", "terminalProtocol", "dependencyPolicy", "outputPolicy", "transcriptPolicy", "claims"], "POLICY_INVALID"); assert.equal(policy.schema, `${NAMESPACE}/policy-v1`); assert.equal(policy.namespace, NAMESPACE); assert.equal(policy.status, STATUS); assert.equal(policy.authorizationId, AUTHORIZATION_ID); assert.equal(policy.executeFlag, EXECUTE_FLAG); assert.equal(policy.exactCommand, EXACT_COMMAND); assert.deepEqual(policy.expectedOutput, OUTPUT); assert.equal(policy.containerPrefix, "pal-v24-"); assert.deepEqual(policy.tmpfs, TMPFS); assert.equal(policy.cache, "SEPARATE_HOST_DIRECTORY_PER_BUILD"); assert.deepEqual(policy.limits, BUDGETS); assert.deepEqual(policy.successCounters, { buildAttempts: 2, successfulBuilds: 2, cleanupAttempts: 2, cleanupSuccesses: 2, networkCalls: 0 }); assert.deepEqual(policy.exports, EXPORTED_TEST_HOOKS); assert.deepEqual(policy.authorityContract, authorityContractV24()); assert.equal(policy.terminalProtocol, "ONE_AUTHORITATIVE_EXCLUSIVE_SUCCESS_OR_FAILURE_FAILURE_WINS_ON_SUCCESS_COMMIT_ERROR"); assert.equal(policy.dependencyPolicy, "VERIFY_38_RECORD_V23_V20_AND_TRANSITIVE_CLOSURE_BEFORE_FIRST_DEFERRED_REQUIRE"); assert.equal(policy.outputPolicy, "RELIABLE_LEXICAL_TO_DESCRIPTOR_IDENTITY_BOUNDED_BYTES_AND_UNCONDITIONAL_EQUALITY"); assert.deepEqual(policy.transcriptPolicy, transcriptPolicyV24()); assert.deepEqual(policy.claims, CLAIMS);
  const authorityRel = `${PACKAGE_REL}/manifests/authority-manifest.json`, detachedRel = `${PACKAGE_REL}/manifests/authority-manifest.sha256`, authorityBytes = fsImpl.readFileSync(strictPath(path.join(workspace, ...authorityRel.split("/")), workspace, fsImpl, "file")), authority = JSON.parse(authorityBytes), detachedBytes = fsImpl.readFileSync(strictPath(path.join(workspace, ...detachedRel.split("/")), workspace, fsImpl, "file")); assert.equal(detachedBytes.toString("utf8"), `${sha256(authorityBytes)}  authority-manifest.json\n`, "AUTHORITY_DETACHED_INVALID");
  exactKeysV24(authority, ["schema", "namespace", "status", "authorizationId", "executionAuthorized", "runner", "tests", "report", "policy", "packageManifest", "dependencyRecordCount", "exports", "containerPrefix", "authorityContract", "transcriptPolicy", "claims", "detachedChecksumRole"], "PACKAGE_AUTHORITY_INVALID"); assert.equal(authority.schema, `${NAMESPACE}/authority-v1`); assert.equal(authority.namespace, NAMESPACE); assert.equal(authority.status, STATUS); assert.equal(authority.authorizationId, AUTHORIZATION_ID); assert.equal(authority.executionAuthorized, false); for (const [index, role] of ["runner", "tests", "report", "policy"].entries()) assert.deepEqual(authority[role], manifest.successorRecords[index]); assert.deepEqual(authority.packageManifest, recordV24(manifestRel, workspace, fsImpl)); assert.equal(authority.dependencyRecordCount, 38); assert.deepEqual(authority.exports, EXPORTED_TEST_HOOKS); assert.equal(authority.containerPrefix, "pal-v24-"); assert.deepEqual(authority.authorityContract, authorityContractV24()); assert.deepEqual(authority.transcriptPolicy, transcriptPolicyV24()); assert.deepEqual(authority.claims, CLAIMS); assert.equal(authority.detachedChecksumRole, "INTEGRITY_ONLY_NOT_INVOCATION_OR_EXECUTION_AUTHORITY");
  const sealedBindings = { runner: authority.runner, tests: authority.tests, report: authority.report, policy: authority.policy, packageManifest: authority.packageManifest, packageAuthority: recordV24(authorityRel, workspace, fsImpl), packageDetached: recordV24(detachedRel, workspace, fsImpl) }; return { manifest, authority, policy, sealedBindings };
}
function loadDependenciesV24(workspace = WORKSPACE, fsImpl = fs, loader = require) { for (const record of ALL_DEPENDENCY_RECORDS) assert.deepEqual(recordV24(record.path, workspace, fsImpl), record, `DEPENDENCY_SEAL:${record.path}`); const correction = loader("./validate-profitable-async-liability-solidity-builder-image-inspect-correction-v2.js"), created = loader("./run-profitable-async-liability-solidity-builder-cache-bind-aware-created-inspect-comparator-v23.js"), exited = loader("./run-profitable-async-liability-solidity-builder-exit-inspect-comparator-v15.js"); assert.equal(created.NAMESPACE, V23_CREATED); assert.equal(exited.NAMESPACE, V15); return { correction, created, exited }; }
function authorityRecordV24(file, display, fsImpl) { const bytes = fsImpl.readFileSync(file); return { path: display, bytes: bytes.length, sha256: sha256(bytes) }; }
function loadAuthorityContractPackageV24(spec, workspace, fsImpl) { const root = strictPath(path.join(workspace, ...spec.root.split("/")), workspace, fsImpl, "directory"), expected = [spec.payload, "authority-manifest.json", "authority-manifest.sha256"].sort(); assert.deepEqual(fsImpl.readdirSync(root).sort(), expected, "AUTHORITY_CARDINALITY_INVALID"); const payloadPath = strictPath(path.join(root, spec.payload), root, fsImpl, "file"), wrapperPath = strictPath(path.join(root, "authority-manifest.json"), root, fsImpl, "file"), detachedPath = strictPath(path.join(root, "authority-manifest.sha256"), root, fsImpl, "file"), payloadBytes = fsImpl.readFileSync(payloadPath), wrapperBytes = fsImpl.readFileSync(wrapperPath), detachedBytes = fsImpl.readFileSync(detachedPath); assert.equal(detachedBytes.toString("utf8"), `${sha256(wrapperBytes)}  authority-manifest.json\n`, "AUTHORITY_DETACHED_INVALID"); return { payload: JSON.parse(payloadBytes), wrapper: JSON.parse(wrapperBytes), records: { payload: authorityRecordV24(payloadPath, spec.payload, fsImpl), wrapper: authorityRecordV24(wrapperPath, "authority-manifest.json", fsImpl), detached: authorityRecordV24(detachedPath, "authority-manifest.sha256", fsImpl) } }; }
function validateAuthorityV24(base, workspace = WORKSPACE, fsImpl = fs, nowMs = Date.now()) {
  for (const spec of AUTHORITY_FILES) if (!fsImpl.existsSync(path.join(workspace, ...spec.root.split("/")))) throw new Error("AUTHORITY_REQUIRED");
  assert.equal(base && typeof base.sealedBindings === "object", true, "SEALED_BINDINGS_REQUIRED"); const auth = loadAuthorityContractPackageV24(AUTHORITY_FILES[0], workspace, fsImpl), review = loadAuthorityContractPackageV24(AUTHORITY_FILES[1], workspace, fsImpl), final = loadAuthorityContractPackageV24(AUTHORITY_FILES[2], workspace, fsImpl), scope = authorityScopeV24(), bindings = base.sealedBindings;
  exactKeysV24(auth.payload, ["schema", "status", "authorizationId", "executorNamespace", "authorizedAtUtc", "currentTurn", "exactCommand", "assistantRequestText", "assistantRequestBytes", "assistantRequestSha256", "userResponseText", "userResponseBytes", "userResponseSha256", "standingAuthorization", "oneShot", "noRetry", "scope", "bindings"], "AUTHORIZATION_INVALID"); assert.equal(auth.payload.schema, `${NAMESPACE}/execution-authorization-transcript-pair-v1`); assert.equal(auth.payload.status, "EXACT_TRANSCRIPT_PAIR_ONE_SHOT_EXECUTION_AUTHORIZATION"); assert.equal(auth.payload.authorizationId, AUTHORIZATION_ID); assert.equal(auth.payload.executorNamespace, NAMESPACE); const authorized = Date.parse(auth.payload.authorizedAtUtc); assert.equal(Number.isFinite(authorized) && authorized <= nowMs + 300000 && authorized >= nowMs - 86400000, true, "AUTHORIZATION_TIMESTAMP_INVALID"); assert.equal(auth.payload.currentTurn, true); assert.equal(auth.payload.exactCommand, EXACT_COMMAND); assert.equal(typeof auth.payload.assistantRequestText === "string" && auth.payload.assistantRequestText.includes(EXACT_COMMAND) && auth.payload.assistantRequestText.includes(AUTHORIZATION_ID) && /one[- ]shot/i.test(auth.payload.assistantRequestText) && /no[- ]retry/i.test(auth.payload.assistantRequestText), true, "ASSISTANT_REQUEST_TEXT_INVALID"); const requestBytes = Buffer.from(auth.payload.assistantRequestText); assert.equal(auth.payload.assistantRequestBytes, requestBytes.length); assert.equal(auth.payload.assistantRequestSha256, sha256(requestBytes)); assert.equal(auth.payload.userResponseText, STANDING_USER_RESPONSE_TEXT, "USER_RESPONSE_TEXT_INVALID"); const responseBytes = Buffer.from(auth.payload.userResponseText); assert.equal(auth.payload.userResponseBytes, responseBytes.length); assert.equal(auth.payload.userResponseSha256, sha256(responseBytes)); assert.equal(auth.payload.standingAuthorization, true); assert.equal(auth.payload.oneShot, true); assert.equal(auth.payload.noRetry, true); assert.deepEqual(auth.payload.scope, scope); assert.deepEqual(auth.payload.bindings, bindings);
  exactKeysV24(auth.wrapper, ["schema", "status", "payload", "bindings"], "AUTHORIZATION_WRAPPER_INVALID"); assert.equal(auth.wrapper.schema, `${NAMESPACE}/execution-authorization-authority-v1`); assert.equal(auth.wrapper.status, "EXACT_FIXED_PACKAGE_AUTHORIZATION"); assert.deepEqual(auth.wrapper.payload, auth.records.payload); assert.deepEqual(auth.wrapper.bindings, bindings);
  exactKeysV24(review.payload, ["schema", "status", "authorizationId", "executorNamespace", "executionPayload", "executionWrapper", "executionDetached", "assistantRequestBytes", "assistantRequestSha256", "userResponseBytes", "userResponseSha256", "reviewer", "verdict", "scope", "bindings"], "REVIEW_INVALID"); assert.equal(review.payload.schema, `${NAMESPACE}/review-decision-v1`); assert.equal(review.payload.status, "INDEPENDENT_ORACLE_REVIEW"); assert.equal(review.payload.authorizationId, AUTHORIZATION_ID); assert.equal(review.payload.executorNamespace, NAMESPACE); assert.deepEqual([review.payload.executionPayload, review.payload.executionWrapper, review.payload.executionDetached], [auth.records.payload, auth.records.wrapper, auth.records.detached]); assert.equal(review.payload.assistantRequestBytes, auth.payload.assistantRequestBytes); assert.equal(review.payload.assistantRequestSha256, auth.payload.assistantRequestSha256); assert.equal(review.payload.userResponseBytes, auth.payload.userResponseBytes); assert.equal(review.payload.userResponseSha256, auth.payload.userResponseSha256); assert.equal(review.payload.reviewer, "ORACLE"); assert.equal(review.payload.verdict, "APPROVE_UNCHANGED_TRANSCRIPT_PAIR_ONE_SHOT_NO_RETRY"); assert.deepEqual(review.payload.scope, scope); assert.deepEqual(review.payload.bindings, bindings);
  exactKeysV24(review.wrapper, ["schema", "status", "payload", "executionPayload", "executionWrapper", "executionDetached", "reviewer", "bindings"], "REVIEW_WRAPPER_INVALID"); assert.equal(review.wrapper.schema, `${NAMESPACE}/review-decision-authority-v1`); assert.equal(review.wrapper.status, "INDEPENDENT_ORACLE_REVIEW_PACKAGE"); assert.deepEqual(review.wrapper.payload, review.records.payload); assert.deepEqual([review.wrapper.executionPayload, review.wrapper.executionWrapper, review.wrapper.executionDetached], [auth.records.payload, auth.records.wrapper, auth.records.detached]); assert.equal(review.wrapper.reviewer, "ORACLE"); assert.deepEqual(review.wrapper.bindings, bindings);
  exactKeysV24(final.payload, ["schema", "status", "authorizationId", "executorNamespace", "executionPayload", "executionWrapper", "executionDetached", "reviewPayload", "reviewWrapper", "reviewDetached", "assistantRequestSha256", "userResponseSha256", "currentTurn", "oneShot", "noRetry", "reviewer", "verdict", "scope", "bindings"], "FINAL_AUTHORITY_INVALID"); assert.equal(final.payload.schema, `${NAMESPACE}/final-execution-authority-v1`); assert.equal(final.payload.status, "FINAL_INDEPENDENT_TRANSCRIPT_PAIR_ONE_SHOT_EXECUTION_AUTHORITY"); assert.equal(final.payload.authorizationId, AUTHORIZATION_ID); assert.equal(final.payload.executorNamespace, NAMESPACE); assert.deepEqual([final.payload.executionPayload, final.payload.executionWrapper, final.payload.executionDetached], [auth.records.payload, auth.records.wrapper, auth.records.detached]); assert.deepEqual([final.payload.reviewPayload, final.payload.reviewWrapper, final.payload.reviewDetached], [review.records.payload, review.records.wrapper, review.records.detached]); assert.equal(final.payload.assistantRequestSha256, auth.payload.assistantRequestSha256); assert.equal(final.payload.userResponseSha256, auth.payload.userResponseSha256); assert.equal(final.payload.currentTurn, true); assert.equal(final.payload.oneShot, true); assert.equal(final.payload.noRetry, true); assert.equal(final.payload.reviewer, "ORACLE"); assert.equal(final.payload.verdict, "AUTHORIZE_EXACT_TRANSCRIPT_PAIR_COMMAND_ONCE_NO_RETRY"); assert.deepEqual(final.payload.scope, scope); assert.deepEqual(final.payload.bindings, bindings);
  exactKeysV24(final.wrapper, ["schema", "status", "payload", "executionPayload", "executionWrapper", "executionDetached", "reviewPayload", "reviewWrapper", "reviewDetached", "reviewer", "bindings"], "FINAL_WRAPPER_INVALID"); assert.equal(final.wrapper.schema, `${NAMESPACE}/final-authority-package-v1`); assert.equal(final.wrapper.status, "FINAL_INDEPENDENT_ORACLE_AUTHORITY_PACKAGE"); assert.deepEqual(final.wrapper.payload, final.records.payload); assert.deepEqual([final.wrapper.executionPayload, final.wrapper.executionWrapper, final.wrapper.executionDetached], [auth.records.payload, auth.records.wrapper, auth.records.detached]); assert.deepEqual([final.wrapper.reviewPayload, final.wrapper.reviewWrapper, final.wrapper.reviewDetached], [review.records.payload, review.records.wrapper, review.records.detached]); assert.equal(final.wrapper.reviewer, "ORACLE"); assert.deepEqual(final.wrapper.bindings, bindings);
  const runsRoot = path.join(workspace, ...PACKAGE_REL.split("/"), "runs"); if (fsImpl.existsSync(runsRoot)) { strictPath(runsRoot, path.join(workspace, ...PACKAGE_REL.split("/")), fsImpl, "directory"); if (fsImpl.existsSync(path.join(runsRoot, AUTHORIZATION_ID))) throw new Error("AUTHORIZATION_ALREADY_CONSUMED"); }
  return { authorization: auth, review, final, scope };
}
function validateProductionPrerequisitesV24(workspace = WORKSPACE, fsImpl = fs, loader = require, nowMs = Date.now()) { const base = validatePackageV24(workspace, fsImpl), authority = validateAuthorityV24(base, workspace, fsImpl, nowMs), dependencies = loadDependenciesV24(workspace, fsImpl, loader); return { base, authority, dependencies }; }
function createTestLifecycleV24(id, state, options) { assert.equal(options && options.testMode === true, true, "EXPLICIT_TEST_MODE_REQUIRED"); return createLifecycleV24(id, state, options); }
function executeProductionV24() { const context = validateProductionPrerequisitesV24(WORKSPACE, fs, require, Date.now()), state = freshState({ executionAuthorized: true }); let lifecycle; try { lifecycle = createLifecycleV24(AUTHORIZATION_ID, state, { productionToken: PRODUCTION_TOKEN }); const result = executeWorkflowV24({ productionToken: PRODUCTION_TOKEN, state, budgets: lifecycle.budgets, runRoot: lifecycle.runRoot, config: lifecycle.config, adapter: productionAdapterV24(lifecycle.config), journal: lifecycle.journal, validateIdentities: lifecycle.validateIdentities, validateCleanup: lifecycle.validateCleanup, assertFreshSlot: lifecycle.assertFreshSlot, verifyOutput: lifecycle.verifyOutput, validateQualification: (op, value) => validateQualificationV24(op, value, AUTHORIZATION_ID, context.dependencies), compareCreated: (raw, expected) => context.dependencies.created.compareInspect(raw, expected), compareExited: (raw, expected) => context.dependencies.exited.compareExitInspectRows(raw, expected) }, AUTHORIZATION_ID); const terminal = lifecycle.terminal(true, result); return { schema: `${NAMESPACE}/execution-result-v1`, status: "PASS", ...state, terminal }; } catch (error) { if (lifecycle && !error.lifecycleTerminal) try { error.lifecycleTerminal = lifecycle.terminal(false, { phase: "WORKFLOW", rootCauseCode: error.message, cleanupFailure: error.cleanupFailure || null, noRetry: true }); } catch (terminalError) { error.terminalFailure = terminalError.message; } error.executionState = state; throw error; } }
function orchestrateV24(argv) { if (argv.length === 0) return { schema: `${NAMESPACE}/offline-summary-v1`, status: "PASS", packageStatus: STATUS, ...freshState() }; if (argv.length !== 1 || argv[0] !== EXECUTE_FLAG) throw new Error("ARGUMENTS_REJECTED"); return executeProductionV24(); }
function main(argv) { if (arguments.length !== 1) throw new Error("CALLER_DEPENDENCIES_REJECTED"); return orchestrateV24(argv); }
if (require.main === module) { try { process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)))}\n`); } catch (error) { const state = error.executionState || freshState(); process.stderr.write(`${JSON.stringify({ status: "FAIL", errorCode: error.message, executionAuthorized: state.executionAuthorized, consumed: state.consumed, processCalls: state.processCalls, writes: state.writes, terminalEvidenceState: state.terminalEvidenceState })}\n`); process.exitCode = 1; } }

module.exports = Object.freeze({ NAMESPACE, STATUS, EXECUTE_FLAG, EXACT_COMMAND, AUTHORIZATION_ID, AUTHORITY_FILES, V13, V23_CREATED, V15, IMAGE, CONFIG_DIGEST, OUTPUT, OUTPUT_NAME, QUALIFIED_REFERENCE, SOURCE_RECORDS, OPERATIONS, BUDGETS, DEPENDENCY_RECORDS, V24_BOUND_RECORDS, ALL_DEPENDENCY_RECORDS, CREATED_MISMATCH_CODES, ALLOWED_CREATED_REPRESENTATION_NOTES, CLAIMS, STANDING_USER_RESPONSE_TEXT, SCOPE_EXCLUSIONS, EXPORTED_TEST_HOOKS, freshState, createBudgetsV24, buildPlanV24, expectedCreatedV24, validateCreatedComparisonV24, authorityContractV24, transcriptPolicyV24, authorityScopeV24, executeWorkflowV24, createTestLifecycleV24, readTerminalV24, outputDescriptorV24, validatePackageV24, validateAuthorityV24, validateProductionPrerequisitesV24, loadDependenciesV24, main });
