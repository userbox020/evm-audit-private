#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");

const WORKSPACE = path.resolve(__dirname, "..");
const HARNESS_PATH = __filename;
const PACKAGE_REL = "tools/vendor/profitable-async-liability-delta-detector-v1-parser-authority";
const PACKAGE_ROOT = path.join(WORKSPACE, PACKAGE_REL);
const MANIFEST_PATH = path.join(PACKAGE_ROOT, "manifests", "builder-manifest.json");
const GRAMMAR_ROOT = path.join(PACKAGE_ROOT, "sources", "extracted", "tree-sitter-solidity-1.2.13", "package");
const RUNS_ROOT = path.join(PACKAGE_ROOT, "toolchain", "gate0-runs");
const EXECUTE_FLAG = "--execute-reviewed-gate0";
const DOCKER_ENDPOINT = "npipe:////./pipe/docker_engine";
const DOCKER_VERSION = "29.6.1";
const IMAGE_REPOSITORY = "emscripten/emsdk";
const MANIFEST_DIGEST = "sha256:47d573d5a86379a06f850de200d69407e6baa2d2f9c19d9e156a67db57f80f2f";
const IMAGE = `docker.io/${IMAGE_REPOSITORY}@${MANIFEST_DIGEST}`;
const CONFIG_DIGEST = "sha256:a411b47f58dbac78da4f2ea974e6bdbb4cd0598d6de7d8166903cdb34d6ecc9e";
const OUTPUT_NAME = "tree-sitter-solidity.wasm";
const OUTPUT_BYTES = 508582;
const OUTPUT_SHA256 = "07420813d7668445152a5d5d2017e0fb84cb27342257e1add3cc7462eec7f811";
const ENTRYPOINT = "/emsdk/upstream/emscripten/emcc";
const EMCC_ARGV = Object.freeze([
  "-o", "/out/tree-sitter-solidity.wasm", "-Os", "-s", "WASM=1", "-s", "SIDE_MODULE=2",
  "-s", "TOTAL_MEMORY=33554432", "-s", "NODEJS_CATCH_EXIT=0", "-s",
  "EXPORTED_FUNCTIONS=[\"_tree_sitter_solidity\"]", "-fno-exceptions", "-fvisibility=hidden",
  "-I", ".", "parser.c",
]);
const IMAGE_ENV = Object.freeze([
  "PATH=/emsdk:/emsdk/upstream/emscripten:/emsdk/node/20.18.0_64bit/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  "EMSDK=/emsdk",
]);
const EXPLICIT_ENV = Object.freeze([
  "TZ=UTC", "LANG=C.UTF-8", "LC_ALL=C.UTF-8", "HOME=/home/nonroot", "XDG_CACHE_HOME=/cache",
]);
const EFFECTIVE_ENV = Object.freeze([...IMAGE_ENV, ...EXPLICIT_ENV]);
const DIFF_IDS = Object.freeze([
  "sha256:270a1170e7e398434ff1b31e17e233f7d7b71aa99a40473615860068e86720af",
  "sha256:d30116381ad2558a6667df513bfe9ea4a40180afe0bb3626831d4d0bb1d49b1d",
  "sha256:5a5c54c275d026a9e596198e599e6b5e81c3a7555f7124e7594f420e3b912db8",
  "sha256:df6909ace99d75c79bed6f1cb666d4338d9db7c4405b94a61085795f009adcec",
  "sha256:3f58502b03477b9d62cb42bc58a7895d632df3d6c426040be20de1417f23de89",
]);
const SOURCE_RECORDS = Object.freeze([
  Object.freeze({ rel: "src/parser.c", stage: "parser.c", bytes: 2567063, sha256: "e71971f6ddc0704e81f4af3f43ecc79793742bb5f1d256a5fdd718aa06d74acb" }),
  Object.freeze({ rel: "src/tree_sitter/parser.h", stage: "tree_sitter/parser.h", bytes: 7624, sha256: "180b893c8734778fd32f372dfbc27bd6ad1cd2221f26150b31256ff6716320d2" }),
]);
const GRAMMAR_RECORD = Object.freeze({ rel: "src/grammar.json", bytes: 171238, sha256: "74a3972bdcd8e08047e911e5beb5f2bad06a5329629bebb8b05a6a883683da40" });
const PUBLISHED_RECORD = Object.freeze({ rel: "tree-sitter-solidity.wasm", bytes: OUTPUT_BYTES, sha256: OUTPUT_SHA256 });
const TMPFS = Object.freeze({
  "/tmp": "rw,nosuid,nodev,size=268435456",
  "/home/nonroot": "rw,noexec,nosuid,nodev,size=33554432",
  "/cache": "rw,size=536870912",
});
const LIMITS = Object.freeze({ memory: 4294967296, memorySwap: 4294967296, nanoCpus: 2000000000, pidsLimit: 256 });
const DEFAULT_COUNTERS = Object.freeze({
  dockerInvocations: 0,
  pullRequests: 0,
  pullSuccess: 0,
  containerCreateRequests: 0,
  containerCreateSuccess: 0,
  startRequests: 0,
  daemonObservedStarts: 0,
  verifiedBuilds: 0,
  cleanupRequests: 0,
  cleanupSuccess: 0,
  cleanupAbsenceVerified: 0,
});

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function fileRecord(file) {
  const bytes = fs.readFileSync(file);
  return { bytes: bytes.length, sha256: sha256Buffer(bytes) };
}

function isContained(target, root) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function checkNoSymlinkComponents(target, stopAt) {
  const absolute = path.resolve(target);
  const stop = path.resolve(stopAt);
  assert.equal(isContained(absolute, stop), true, "PATH_OUTSIDE_APPROVED_ROOT");
  let cursor = stop;
  if (fs.existsSync(stop)) assert.equal(fs.lstatSync(stop).isSymbolicLink(), false, "APPROVED_ROOT_SYMLINK_REJECTED");
  for (const part of path.relative(stop, absolute).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (!fs.existsSync(cursor)) break;
    const stat = fs.lstatSync(cursor);
    assert.equal(stat.isSymbolicLink(), false, "SYMLINK_COMPONENT_REJECTED");
    if (typeof fs.realpathSync.native === "function") assert.equal(isContained(fs.realpathSync.native(cursor), stop), true, "REALPATH_OUTSIDE_APPROVED_ROOT");
  }
}

function checkRegularNoSymlink(file, label) {
  const stat = fs.lstatSync(file);
  assert.equal(stat.isSymbolicLink(), false, `${label}: SYMLINK_REJECTED`);
  assert.equal(stat.isFile(), true, `${label}: REGULAR_FILE_REQUIRED`);
  return stat;
}

function verifyRecord(file, record, label, root = PACKAGE_ROOT) {
  checkNoSymlinkComponents(file, root);
  const stat = checkRegularNoSymlink(file, label);
  assert.equal(stat.size, record.bytes, `${label}: BYTE_COUNT`);
  assert.equal(fileRecord(file).sha256, record.sha256, `${label}: SHA256`);
}

function envMap(values, label = "environment") {
  assert.equal(Array.isArray(values), true, `${label}: ARRAY_REQUIRED`);
  const map = Object.create(null);
  for (const entry of values) {
    const index = entry.indexOf("=");
    assert.equal(index > 0, true, `${label}: INVALID_ENTRY`);
    const key = entry.slice(0, index);
    assert.equal(Object.prototype.hasOwnProperty.call(map, key), false, `${label}: DUPLICATE_KEY`);
    map[key] = entry.slice(index + 1);
  }
  return map;
}

function assertEnvEquivalent(actual, expected, label) {
  assert.deepEqual({ ...envMap(actual, label) }, { ...envMap(expected, `${label} expected`) });
}

function canonicalRepoDigest(value) {
  assert.equal(typeof value, "string");
  let normalized = value.toLowerCase();
  if (normalized.startsWith("docker.io/")) normalized = normalized.slice("docker.io/".length);
  if (normalized.startsWith("index.docker.io/")) normalized = normalized.slice("index.docker.io/".length);
  if (normalized.startsWith("library/")) normalized = normalized.slice("library/".length);
  return normalized;
}

function securityOptIsExact(values) {
  return Array.isArray(values)
    && values.length === 1
    && ["no-new-privileges:true", "no-new-privileges=true"].includes(values[0]);
}

function validateExecutableAuthority(manifest, harnessRecord = fileRecord(HARNESS_PATH)) {
  assert.equal(manifest.status, "PRE_PULL_DIRECT_RECIPE_SEALED_REVIEW_REQUIRED");
  assert.equal(manifest.metadataOnly, true);
  assert.deepEqual(manifest.executionHarness.record, harnessRecord);
  assert.equal(manifest.executionHarness.path, "tools/run-profitable-async-liability-solidity-builder-gate0.js");
  assert.equal(manifest.executionHarness.defaultMode, "PLAN_VALIDATE_ONLY");
  assert.equal(manifest.executionHarness.reviewedExecutionFlag, EXECUTE_FLAG);
  assert.equal(manifest.executionHarness.reviewedExecutionFlagMustBeSoleArgument, true);
  assert.equal(manifest.executionHarness.shell, false);
  assert.equal(manifest.executionHarness.currentDockerInvocations, 0);
  assert.equal(manifest.buildRecipe.mode, "SOURCE_DERIVED_DIRECT_EMCC");
  assert.equal(manifest.buildRecipe.stockCommand.status, "NOT_EXECUTABLE_UNDER_HARDENED_POLICY");
  assert.equal(manifest.buildRecipe.workdir, "/src");
  assert.equal(manifest.buildRecipe.entrypointOverride, ENTRYPOINT);
  assert.deepEqual(manifest.buildRecipe.argv, EMCC_ARGV);
  assert.equal(manifest.buildRecipe.sourceDateEpoch.requiredAbsent, true);
  const image = manifest.docker.selectedImage;
  assert.equal(image.digestReference, IMAGE);
  assert.equal(image.manifest.digest, MANIFEST_DIGEST);
  assert.equal(image.configDescriptor.digest, CONFIG_DIGEST);
  assert.deepEqual(image.authenticatedConfig.rootfs.diffIds, DIFF_IDS);
  assert.equal(image.authenticatedConfig.os, "linux");
  assert.equal(image.authenticatedConfig.architecture, "amd64");
  assertEnvEquivalent(image.authenticatedConfig.config.Env, IMAGE_ENV, "manifest image env");
  const planned = manifest.plannedPostApprovalTest;
  assert.equal(planned.pullAuthorized, false);
  assert.equal(planned.executionGate.requiredSoleArgument, EXECUTE_FLAG);
  assert.equal(planned.dockerEnvironment.endpoint, DOCKER_ENDPOINT);
  assert.equal(planned.pull.reference, IMAGE);
  assert.equal(planned.pull.platform, "linux/amd64");
  const runtime = planned.runtime;
  assert.equal(runtime.pullPolicy, "never");
  assert.equal(runtime.network, "none");
  assert.equal(runtime.readOnlyRootFilesystem, true);
  assert.equal(runtime.user, "65532:65532");
  assert.deepEqual(runtime.capDrop, ["ALL"]);
  assert.equal(runtime.securityOptions[0], "no-new-privileges=true");
  assert.equal(runtime.memoryBytes, LIMITS.memory);
  assert.equal(runtime.memorySwapBytes, LIMITS.memorySwap);
  assert.equal(runtime.nanoCpus, LIMITS.nanoCpus);
  assert.equal(runtime.pidsLimit, LIMITS.pidsLimit);
  assert.equal(runtime.ipcMode, "private");
  assert.equal(runtime.cgroupnsMode, "private");
  assert.equal(runtime.sourceMount.containerPath, "/src");
  assert.equal(runtime.sourceMount.readOnly, true);
  assert.equal(runtime.outputs.containerPath, "/out");
  assert.equal(runtime.outputs.writable, true);
  assert.deepEqual(runtime.tmpfs, Object.entries(TMPFS).map(([key, value]) => `${key}:${value}`));
  assertEnvEquivalent(runtime.inheritedAuthenticatedImageEnvironment, IMAGE_ENV, "manifest inherited env");
  assertEnvEquivalent(runtime.explicitEnvironment, EXPLICIT_ENV, "manifest explicit env");
  assert.equal(runtime.sourceDateEpochAbsent, true);
  assert.equal(runtime.containerStartsTotal, 2);
  assert.equal(runtime.separateIdentityOrPreflightContainers, 0);
  assert.equal(planned.empiricalEqualityGate.publishedQuarantinedWasmSha256, OUTPUT_SHA256);
  assert.equal(planned.empiricalEqualityGate.satisfied, null);
  assert.equal(manifest.existingPublishedSolidityWasm.record.bytes, OUTPUT_BYTES);
  assert.equal(manifest.existingPublishedSolidityWasm.record.sha256, OUTPUT_SHA256);
  assert.equal(manifest.execution.imagePulled, false);
  assert.deepEqual(manifest.execution.builds, []);
  assert.equal(manifest.execution.doubleBuildBytesMatch, null);
  assert.equal(manifest.execution.verifiedReproducible, false);
  assert.equal(manifest.promotion.outputsQuarantineOnly, true);
  assert.equal(manifest.promotion.separatePromotionReviewRequired, true);
  assert.equal(manifest.promotion.parserPromotionAllowed, false);
  assert.deepEqual(manifest.builds, []);
  assert.equal(manifest.doubleBuildBytesMatch, null);
  assert.equal(manifest.verifiedReproducible, false);
  assert.equal(manifest.daemonQualification.clientVersion, DOCKER_VERSION);
  assert.equal(manifest.daemonQualification.serverVersion, DOCKER_VERSION);
  return manifest;
}

function readAndValidateManifest() {
  return validateExecutableAuthority(JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")));
}

function validateLocalInputs() {
  checkNoSymlinkComponents(PACKAGE_ROOT, WORKSPACE);
  for (const record of SOURCE_RECORDS) verifyRecord(path.join(GRAMMAR_ROOT, record.rel), record, record.rel);
  const grammarPath = path.join(GRAMMAR_ROOT, GRAMMAR_RECORD.rel);
  verifyRecord(grammarPath, GRAMMAR_RECORD, GRAMMAR_RECORD.rel);
  const grammar = JSON.parse(fs.readFileSync(grammarPath, "utf8"));
  assert.equal(grammar.name, "solidity");
  assert.deepEqual(grammar.externals, []);
  for (const scanner of ["scanner.c", "scanner.cc", "scanner.cpp"]) assert.equal(fs.existsSync(path.join(GRAMMAR_ROOT, "src", scanner)), false);
  verifyRecord(path.join(GRAMMAR_ROOT, PUBLISHED_RECORD.rel), PUBLISHED_RECORD, "published comparison WASM");
}

function dockerBaseArgs(dockerConfig) {
  return ["--config", dockerConfig, "--host", DOCKER_ENDPOINT];
}

function buildCreateArgs(spec) {
  const args = [
    ...dockerBaseArgs(spec.dockerConfig), "create", "--name", spec.name,
    "--platform", "linux/amd64", "--pull", "never", "--network", "none", "--read-only",
    "--user", "65532:65532", "--cap-drop", "ALL", "--security-opt", "no-new-privileges=true",
    "--memory", String(LIMITS.memory), "--memory-swap", String(LIMITS.memorySwap), "--cpus", "2",
    "--pids-limit", String(LIMITS.pidsLimit), "--ipc", "private", "--cgroupns", "private",
    "--workdir", "/src", "--entrypoint", ENTRYPOINT,
  ];
  for (const value of EXPLICIT_ENV) args.push("--env", value);
  args.push(
    "--mount", `type=bind,src=${spec.sourceDir},dst=/src,readonly`,
    "--mount", `type=bind,src=${spec.outputDir},dst=/out`,
    "--tmpfs", `/tmp:${TMPFS["/tmp"]}`,
    "--tmpfs", `/home/nonroot:${TMPFS["/home/nonroot"]}`,
    "--tmpfs", `/cache:${TMPFS["/cache"]}`,
    IMAGE, ...EMCC_ARGV,
  );
  return args;
}

function buildPlan(runId = "plan000000000000") {
  const runRoot = path.join(RUNS_ROOT, runId);
  const dockerConfig = path.join(runRoot, "docker-config");
  const sourceDir = path.join(runRoot, "source");
  return {
    mode: "PLAN_VALIDATE_ONLY",
    dockerInvocations: 0,
    runId,
    runRoot,
    relativeEvidencePath: `${PACKAGE_REL}/toolchain/gate0-runs/${runId}`,
    dockerConfig,
    sourceDir,
    versionArgs: [...dockerBaseArgs(dockerConfig), "version", "--format", "{{json .}}"],
    infoArgs: [...dockerBaseArgs(dockerConfig), "info", "--format", "{{json .}}"],
    pullArgs: [...dockerBaseArgs(dockerConfig), "pull", "--platform", "linux/amd64", IMAGE],
    imageInspectArgs: [...dockerBaseArgs(dockerConfig), "image", "inspect", IMAGE],
    runs: ["a", "b"].map((label) => {
      const run = { label, name: `pal-solidity-gate0-${runId}-${label}`, outputDir: path.join(runRoot, `out-${label}`) };
      return { ...run, createArgs: buildCreateArgs({ ...run, dockerConfig, sourceDir }) };
    }),
  };
}

function validatePlan(plan) {
  assert.match(plan.runId, /^[a-z0-9]{16}$/);
  assert.equal(plan.runs.length, 2);
  assert.notEqual(plan.runs[0].outputDir, plan.runs[1].outputDir);
  for (const run of plan.runs) {
    assert.equal(run.createArgs.includes("--rm"), false);
    assert.deepEqual(run.createArgs.slice(-EMCC_ARGV.length), EMCC_ARGV);
    assert.equal(run.createArgs.includes("SOURCE_DATE_EPOCH"), false);
    assert.equal(run.createArgs.filter((x) => x === "--mount").length, 2);
    assert.equal(run.createArgs.filter((x) => x === "--tmpfs").length, 3);
  }
  return plan;
}

function sanitizedDockerEnv(dockerConfig, hostEnv = process.env) {
  for (const key of Object.keys(hostEnv)) {
    const upper = key.toUpperCase();
    if (["DOCKER_HOST", "DOCKER_CONTEXT"].includes(upper)) throw new Error(`${upper}_OVERRIDE_REJECTED`);
    if (["DOCKER_AUTH_CONFIG", "REGISTRY_AUTH_FILE", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY"].includes(upper)) throw new Error(`${upper}_CREDENTIAL_OR_AUTH_ENV_REJECTED`);
  }
  const env = { DOCKER_CONFIG: dockerConfig };
  for (const key of ["PATH", "SystemRoot", "WINDIR", "PATHEXT"]) if (hostEnv[key]) env[key] = hostEnv[key];
  return env;
}

function parseJson(text, label) {
  try { return JSON.parse(text); } catch { throw new Error(`${label}_JSON_INVALID`); }
}

function parseSingleInspect(text, label) {
  const rows = parseJson(text, label);
  assert.equal(Array.isArray(rows), true);
  assert.equal(rows.length, 1);
  return rows[0];
}

function normalizeArch(value) {
  return value === "x86_64" ? "amd64" : value;
}

function validateDaemonQualification(version, info) {
  assert.equal(version.Client.Version, DOCKER_VERSION, "DOCKER_CLIENT_VERSION");
  assert.equal(version.Server.Version, DOCKER_VERSION, "DOCKER_SERVER_VERSION");
  assert.equal(info.ServerVersion, DOCKER_VERSION, "DOCKER_INFO_SERVER_VERSION");
  assert.equal(String(info.OSType).toLowerCase(), "linux", "DOCKER_SERVER_OS");
  assert.equal(normalizeArch(String(info.Architecture).toLowerCase()), "amd64", "DOCKER_SERVER_ARCH");
  assert.equal(Array.isArray(info.SecurityOptions), true, "DOCKER_SECURITY_OPTIONS_CAPABILITY");
  assert.equal(typeof info.CgroupVersion, "string", "DOCKER_CGROUP_CAPABILITY");
  assert.equal(typeof info.NCPU, "number", "DOCKER_CPU_CAPABILITY");
  assert.equal(typeof info.MemTotal, "number", "DOCKER_MEMORY_CAPABILITY");
}

function validateImageInspect(image) {
  assert.equal(image.Id, CONFIG_DIGEST);
  assert.equal(image.RepoDigests.some((x) => canonicalRepoDigest(x) === canonicalRepoDigest(IMAGE)), true, "REPO_DIGEST_EQUIVALENCE");
  assert.equal(image.Os, "linux");
  assert.equal(normalizeArch(image.Architecture), "amd64");
  assert.deepEqual(image.RootFS.Layers, DIFF_IDS);
  assert.equal(image.Config.User || "", "");
  assert.deepEqual(image.Config.Entrypoint, ["/emsdk/docker/entrypoint.sh"]);
  assert.equal(image.Config.Cmd, null);
  assertEnvEquivalent(image.Config.Env, IMAGE_ENV, "image inspect env");
}

function normalizedHostPath(value) {
  return path.resolve(value).toLowerCase();
}

function validateContainerInspect(container, spec) {
  assert.equal(container.Image, CONFIG_DIGEST);
  assert.equal(canonicalRepoDigest(container.Config.Image), canonicalRepoDigest(IMAGE));
  assert.deepEqual(container.Config.Entrypoint, [ENTRYPOINT]);
  assert.deepEqual(container.Config.Cmd, EMCC_ARGV);
  assert.equal(container.Config.User, "65532:65532");
  assert.equal(container.Config.WorkingDir, "/src");
  assertEnvEquivalent(container.Config.Env, EFFECTIVE_ENV, "container inspect env");
  assert.equal(envMap(container.Config.Env).SOURCE_DATE_EPOCH, undefined);
  const host = container.HostConfig;
  assert.equal(host.ReadonlyRootfs, true);
  assert.equal(host.NetworkMode, "none");
  assert.deepEqual(host.CapDrop, ["ALL"]);
  assert.equal(securityOptIsExact(host.SecurityOpt), true, "NO_NEW_PRIVILEGES_REQUIRED");
  assert.equal(host.Memory, LIMITS.memory);
  assert.equal(host.MemorySwap, LIMITS.memorySwap);
  assert.equal(host.NanoCpus, LIMITS.nanoCpus);
  assert.equal(host.PidsLimit, LIMITS.pidsLimit);
  assert.equal(host.IpcMode, "private");
  assert.equal(host.CgroupnsMode, "private");
  assert.equal(host.Privileged, false);
  assert.deepEqual(host.Devices || [], []);
  assert.equal(host.PidMode, "");
  assert.equal(host.UTSMode, "");
  assert.deepEqual(host.Binds || [], []);
  assert.deepEqual(host.Tmpfs, TMPFS);
  assert.equal(host.Mounts.length, 2);
  assert.deepEqual(host.Mounts.map((m) => ({
    Type: m.Type,
    Source: normalizedHostPath(m.Source),
    Target: m.Target,
    ReadOnly: m.ReadOnly === true,
  })), [
    { Type: "bind", Source: normalizedHostPath(spec.sourceDir), Target: "/src", ReadOnly: true },
    { Type: "bind", Source: normalizedHostPath(spec.outputDir), Target: "/out", ReadOnly: false },
  ]);
  assert.deepEqual(container.Mounts.map((m) => ({ Destination: m.Destination, RW: m.RW === true })), [
    { Destination: "/src", RW: false },
    { Destination: "/out", RW: true },
  ]);
}

function sanitizeJournalRecord(record) {
  assert.equal(record && Object.getPrototypeOf(record) === Object.prototype, true, "JOURNAL_OBJECT_REQUIRED");
  const forbiddenKeys = /(?:env|argv|stdout|stderr|absolute|hostpath|dockerconfig|sourcedir|outputdir)/i;
  function visit(value, key = "") {
    assert.equal(forbiddenKeys.test(key), false, "JOURNAL_FORBIDDEN_KEY");
    if (typeof value === "string") {
      assert.equal(/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\") || value.startsWith("/"), false, "JOURNAL_ABSOLUTE_PATH_REJECTED");
      return value;
    }
    if (value === null || ["boolean", "number"].includes(typeof value)) return value;
    if (Array.isArray(value)) return value.map((x) => visit(x, key));
    assert.equal(value && Object.getPrototypeOf(value) === Object.prototype, true, "JOURNAL_VALUE_REJECTED");
    const clean = {};
    for (const [childKey, childValue] of Object.entries(value)) clean[childKey] = visit(childValue, childKey);
    return clean;
  }
  return visit(record);
}

function openJournal(runRoot) {
  const journalPath = path.join(runRoot, "journal.jsonl");
  const fd = fs.openSync(journalPath, "ax", 0o600);
  return {
    append(record) {
      const clean = sanitizeJournalRecord(record);
      fs.writeSync(fd, `${JSON.stringify(clean)}\n`, null, "utf8");
      fs.fsyncSync(fd);
    },
    close() { fs.closeSync(fd); },
  };
}

function durableMarker(runRoot, filename, record) {
  const clean = sanitizeJournalRecord(record);
  const target = path.join(runRoot, filename);
  const temp = path.join(runRoot, `.${filename}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(clean)}\n`, null, "utf8");
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(temp, target);
  try {
    const parent = fs.openSync(runRoot, "r");
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  } catch {
    // Windows directory fsync is not uniformly available; journal and marker file are already fsynced.
  }
}

function countersSnapshot(context) {
  const clean = {};
  for (const key of Object.keys(DEFAULT_COUNTERS)) clean[key] = context[key];
  return clean;
}

function journalEvent(context, phase, operation, fields = {}) {
  context.journal.append({ phase, operation, runId: context.runId, counters: countersSnapshot(context), ...fields });
}

function safeErrorCode(error) {
  const value = error && typeof error.message === "string" ? error.message : "";
  return /^[A-Z0-9_]{1,96}$/.test(value) ? value : "GATE0_VALIDATION_FAILED";
}

function dockerCall(operation, args, context, timeout = 30 * 60 * 1000) {
  const result = childProcess.spawnSync("docker", args, {
    env: context.env,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    timeout,
  });
  context.dockerInvocations += 1;
  if (result.error || result.status !== 0) {
    try { journalEvent(context, "failure", operation, { errorCode: `${operation}_FAILED` }); } catch {}
    throw new Error(`${operation}_FAILED`);
  }
  return result.stdout;
}

function ensureEmptyNewDirectory(dir, approvedRoot) {
  checkNoSymlinkComponents(path.dirname(dir), approvedRoot);
  assert.equal(fs.existsSync(dir), false, "DIRECTORY_MUST_BE_NEW");
  fs.mkdirSync(dir);
  checkNoSymlinkComponents(dir, approvedRoot);
  assert.deepEqual(fs.readdirSync(dir), []);
}

function stageExecution(plan) {
  checkNoSymlinkComponents(PACKAGE_ROOT, WORKSPACE);
  if (!fs.existsSync(RUNS_ROOT)) {
    checkNoSymlinkComponents(path.dirname(RUNS_ROOT), PACKAGE_ROOT);
    fs.mkdirSync(RUNS_ROOT);
  }
  checkNoSymlinkComponents(RUNS_ROOT, PACKAGE_ROOT);
  ensureEmptyNewDirectory(plan.runRoot, RUNS_ROOT);
  fs.mkdirSync(plan.dockerConfig);
  fs.writeFileSync(path.join(plan.dockerConfig, "config.json"), '{"auths":{}}', { encoding: "utf8", flag: "wx", mode: 0o600 });
  assert.equal(fs.readFileSync(path.join(plan.dockerConfig, "config.json"), "utf8"), '{"auths":{}}');
  fs.mkdirSync(plan.sourceDir);
  fs.mkdirSync(path.join(plan.sourceDir, "tree_sitter"));
  for (const record of SOURCE_RECORDS) {
    const source = path.join(GRAMMAR_ROOT, record.rel);
    const destination = path.join(plan.sourceDir, record.stage);
    verifyRecord(source, record, record.rel);
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    verifyRecord(destination, record, record.stage, plan.sourceDir);
  }
  assert.deepEqual(fs.readdirSync(plan.sourceDir).sort(), ["parser.c", "tree_sitter"]);
  assert.deepEqual(fs.readdirSync(path.join(plan.sourceDir, "tree_sitter")), ["parser.h"]);
  for (const run of plan.runs) ensureEmptyNewDirectory(run.outputDir, plan.runRoot);
}

function immediatePreMountRevalidate(plan, run) {
  checkNoSymlinkComponents(plan.sourceDir, plan.runRoot);
  checkNoSymlinkComponents(run.outputDir, plan.runRoot);
  assert.deepEqual(fs.readdirSync(run.outputDir), []);
  for (const record of SOURCE_RECORDS) verifyRecord(path.join(plan.sourceDir, record.stage), record, record.stage, plan.sourceDir);
}

function containerAbsent(name, context, operation, required) {
  journalEvent(context, "before", operation, { container: name });
  try {
    const stdout = dockerCall(operation, [
      ...dockerBaseArgs(context.dockerConfig), "container", "ls", "--all",
      "--filter", `name=^/${name}$`, "--format", "{{.Names}}",
    ], context, 30000);
    const absent = stdout.trim() === "";
    journalEvent(context, "after", operation, { container: name, absent });
    if (required) assert.equal(absent, true, "CONTAINER_NAME_NOT_ABSENT");
    return absent;
  } catch (error) {
    journalEvent(context, "failure", operation, { container: name, errorCode: safeErrorCode(error) });
    if (required) throw error;
    return false;
  }
}

function cleanupContainer(name, context) {
  context.cleanupRequests += 1;
  journalEvent(context, "before", "CLEANUP", { container: name });
  try {
    dockerCall("CLEANUP", [...dockerBaseArgs(context.dockerConfig), "container", "rm", "--force", name], context, 30000);
    context.cleanupSuccess += 1;
    journalEvent(context, "after", "CLEANUP", { container: name });
  } catch (error) {
    journalEvent(context, "failure", "CLEANUP", { container: name, errorCode: safeErrorCode(error) });
  }
  if (containerAbsent(name, context, "CLEANUP_ABSENCE_CHECK", false)) context.cleanupAbsenceVerified += 1;
}

function verifyOutput(run, plan, context) {
  const output = path.join(run.outputDir, OUTPUT_NAME);
  journalEvent(context, "before", "OUTPUT_VERIFY", { run: run.label });
  checkNoSymlinkComponents(output, run.outputDir);
  const stat = checkRegularNoSymlink(output, `${run.label} output`);
  assert.equal(stat.size, OUTPUT_BYTES, "OUTPUT_BYTES");
  const sha256 = fileRecord(output).sha256;
  context.verifiedBuilds += 1;
  journalEvent(context, "after", "OUTPUT_VERIFY", { run: run.label, bytes: stat.size, sha256, quarantined: true });
  return { bytes: stat.size, sha256 };
}

function executeContainer(run, plan, context) {
  immediatePreMountRevalidate(plan, run);
  assert.equal(fs.existsSync(path.join(run.outputDir, OUTPUT_NAME)), false, "OUTPUT_PRESENT_BEFORE_START");
  containerAbsent(run.name, context, "ABSENCE_CHECK", true);
  let createRequested = false;
  try {
    context.containerCreateRequests += 1;
    createRequested = true;
    journalEvent(context, "before", "CREATE", { run: run.label, container: run.name });
    dockerCall("CREATE", run.createArgs, context);
    context.containerCreateSuccess += 1;
    journalEvent(context, "after", "CREATE", { run: run.label, container: run.name });

    journalEvent(context, "before", "CREATE_INSPECT", { run: run.label, container: run.name });
    const created = parseSingleInspect(dockerCall("CREATE_INSPECT", [...dockerBaseArgs(plan.dockerConfig), "container", "inspect", run.name], context), "CREATE_INSPECT");
    validateContainerInspect(created, { sourceDir: plan.sourceDir, outputDir: run.outputDir });
    journalEvent(context, "after", "CREATE_INSPECT", { run: run.label, validated: true });

    context.startRequests += 1;
    journalEvent(context, "before", "START", { run: run.label, container: run.name });
    dockerCall("START", [...dockerBaseArgs(plan.dockerConfig), "start", "--attach", run.name], context);
    journalEvent(context, "after", "START", { run: run.label });

    journalEvent(context, "before", "EXIT_INSPECT", { run: run.label, container: run.name });
    const exited = parseSingleInspect(dockerCall("EXIT_INSPECT", [...dockerBaseArgs(plan.dockerConfig), "container", "inspect", run.name], context), "EXIT_INSPECT");
    assert.equal(exited.State.Running, false);
    assert.equal(exited.State.ExitCode, 0);
    assert.equal(typeof exited.State.StartedAt, "string");
    assert.notEqual(exited.State.StartedAt, "0001-01-01T00:00:00Z");
    context.daemonObservedStarts += 1;
    journalEvent(context, "after", "EXIT_INSPECT", { run: run.label, exitCode: 0, daemonObservedStart: true });
    return verifyOutput(run, plan, context);
  } catch (error) {
    journalEvent(context, "failure", "RUN", { run: run.label, errorCode: safeErrorCode(error), partialOutputQuarantined: fs.existsSync(path.join(run.outputDir, OUTPUT_NAME)) });
    throw error;
  } finally {
    if (createRequested) cleanupContainer(run.name, context);
  }
}

function sanitizedResult(status, context, outputs = []) {
  return {
    status,
    counters: countersSnapshot(context),
    imageDigest: MANIFEST_DIGEST,
    configDigest: CONFIG_DIGEST,
    evidencePath: `${PACKAGE_REL}/toolchain/gate0-runs/${context.runId}`,
    outputs: outputs.map((output, index) => ({ run: index === 0 ? "a" : "b", bytes: output.bytes, sha256: output.sha256 })),
  };
}

function validateSuccessCounters(context) {
  const required = {
    pullRequests: 1,
    pullSuccess: 1,
    containerCreateRequests: 2,
    containerCreateSuccess: 2,
    startRequests: 2,
    daemonObservedStarts: 2,
    verifiedBuilds: 2,
    cleanupRequests: 2,
    cleanupSuccess: 2,
    cleanupAbsenceVerified: 2,
  };
  for (const [key, value] of Object.entries(required)) assert.equal(context[key], value, `SUCCESS_COUNTER_${key}`);
  return true;
}

function executeReviewed(plan, manifest) {
  stageExecution(plan);
  const builderRecord = fileRecord(MANIFEST_PATH);
  const harnessRecord = fileRecord(HARNESS_PATH);
  const context = {
    ...DEFAULT_COUNTERS,
    runId: plan.runId,
    dockerConfig: plan.dockerConfig,
    env: sanitizedDockerEnv(plan.dockerConfig),
    journal: openJournal(plan.runRoot),
  };
  let outputs = [];
  try {
    context.journal.append({
      phase: "plan", operation: "RUN_OPEN", runId: plan.runId,
      harness: harnessRecord, builder: builderRecord,
      imageDigest: MANIFEST_DIGEST, configDigest: CONFIG_DIGEST, counters: countersSnapshot(context),
    });

    journalEvent(context, "before", "DAEMON_VERSION");
    const version = parseJson(dockerCall("DAEMON_VERSION", plan.versionArgs, context, 30000), "DAEMON_VERSION");
    journalEvent(context, "after", "DAEMON_VERSION", { clientVersion: version.Client && version.Client.Version, serverVersion: version.Server && version.Server.Version });
    journalEvent(context, "before", "DAEMON_INFO");
    const info = parseJson(dockerCall("DAEMON_INFO", plan.infoArgs, context, 30000), "DAEMON_INFO");
    validateDaemonQualification(version, info);
    journalEvent(context, "after", "DAEMON_INFO", { qualified: true, serverVersion: info.ServerVersion, os: info.OSType, architecture: normalizeArch(info.Architecture) });

    context.pullRequests += 1;
    journalEvent(context, "before", "PULL", { imageDigest: MANIFEST_DIGEST, platform: "linux/amd64" });
    dockerCall("PULL", plan.pullArgs, context);
    context.pullSuccess += 1;
    journalEvent(context, "after", "PULL", { imageDigest: MANIFEST_DIGEST });

    journalEvent(context, "before", "IMAGE_INSPECT");
    const image = parseSingleInspect(dockerCall("IMAGE_INSPECT", plan.imageInspectArgs, context), "IMAGE_INSPECT");
    validateImageInspect(image);
    journalEvent(context, "after", "IMAGE_INSPECT", { imageDigest: MANIFEST_DIGEST, configDigest: CONFIG_DIGEST, validated: true });

    outputs = plan.runs.map((run) => executeContainer(run, plan, context));
    validateSuccessCounters(context);
    assert.deepEqual(outputs.map((x) => x.sha256), [OUTPUT_SHA256, OUTPUT_SHA256]);
    journalEvent(context, "final", "EQUALITY", { satisfied: true, outputBytes: OUTPUT_BYTES, hashes: outputs.map((x) => x.sha256) });
    const result = sanitizedResult("QUARANTINED_GATE0_EQUALITY_OBSERVED_PROMOTION_REVIEW_REQUIRED", context, outputs);
    durableMarker(plan.runRoot, "success.json", result);
    return result;
  } catch (error) {
    const errorCode = safeErrorCode(error);
    try { journalEvent(context, "final", "FAILURE", { errorCode, equalityClaimed: false, partialOutputsQuarantined: true }); } catch {}
    const failure = sanitizedResult("QUARANTINED_GATE0_FAILED_NO_EQUALITY_CLAIM", context, outputs);
    failure.errorCode = errorCode;
    try { durableMarker(plan.runRoot, "failure.json", failure); } catch {}
    throw error;
  } finally {
    context.journal.close();
  }
}

function runPlan() {
  readAndValidateManifest();
  validateLocalInputs();
  return validatePlan(buildPlan());
}

function main(argv = process.argv.slice(2)) {
  if (argv.length === 0) {
    const plan = runPlan();
    process.stdout.write(`${JSON.stringify({ status: "PLAN_VALIDATED_NO_DOCKER", counters: { ...DEFAULT_COUNTERS }, plannedContainerStarts: 2 })}\n`);
    return;
  }
  if (argv.length !== 1 || argv[0] !== EXECUTE_FLAG) throw new Error("ARGUMENTS_REJECTED");
  const manifest = readAndValidateManifest();
  validateLocalInputs();
  const plan = validatePlan(buildPlan(crypto.randomBytes(8).toString("hex")));
  process.stdout.write(`${JSON.stringify(executeReviewed(plan, manifest))}\n`);
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    process.stderr.write(`${JSON.stringify({ status: "FAIL", errorCode: safeErrorCode(error) })}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  CONFIG_DIGEST,
  DEFAULT_COUNTERS,
  DIFF_IDS,
  DOCKER_ENDPOINT,
  DOCKER_VERSION,
  EFFECTIVE_ENV,
  EMCC_ARGV,
  ENTRYPOINT,
  EXECUTE_FLAG,
  EXPLICIT_ENV,
  IMAGE,
  IMAGE_ENV,
  LIMITS,
  MANIFEST_DIGEST,
  TMPFS,
  buildCreateArgs,
  buildPlan,
  canonicalRepoDigest,
  envMap,
  fileRecord,
  main,
  readAndValidateManifest,
  runPlan,
  safeErrorCode,
  sanitizeJournalRecord,
  sanitizedDockerEnv,
  sanitizedResult,
  securityOptIsExact,
  validateContainerInspect,
  validateDaemonQualification,
  validateExecutableAuthority,
  validateImageInspect,
  validateLocalInputs,
  validatePlan,
  validateSuccessCounters,
};
