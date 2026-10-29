"use strict";

const assert = require("assert");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const workspaceRoot = path.resolve(__dirname, "..");
const temporaryWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "eulerswap-v2-authority-r1-"));
const temporaryTools = path.join(temporaryWorkspace, "tools");
const temporaryReports = path.join(temporaryWorkspace, "reports/raw/fast");
const temporarySourceRoot = path.join(temporaryWorkspace, "targets/euler-swap-eulerswap-2.0-81cf6dc98846");
const bundleRelativePath = "reports/raw/fast/eulerswap-v2-compiler-runtime-bundle-r1.json";
const temporaryBundle = path.join(temporaryWorkspace, bundleRelativePath);

const original = {
  module: path.join(workspaceRoot, "tools/eulerswap-v2-production-authority-r1.js"),
  runtimeNormalizerModule: path.join(workspaceRoot, "tools/eulerswap-v2-runtime-normalizer-r1.js"),
  sourceProvenanceModule: path.join(workspaceRoot, "tools/eulerswap-v2-source-provenance-r1.js"),
  sourceManifest: path.join(workspaceRoot, "reports/raw/fast/eulerswap-v2-source-manifest.json"),
  deploymentAuthority: path.join(workspaceRoot, "reports/raw/fast/eulerswap-v2-base-deployment-authority.json"),
  compilerBundle: path.join(workspaceRoot, bundleRelativePath),
  sourceRoot: path.join(workspaceRoot, "targets/euler-swap-eulerswap-2.0-81cf6dc98846"),
};

function copyFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function resetBundle() {
  copyFile(original.compilerBundle, temporaryBundle);
}

function mutateBundle(mutate) {
  const bundle = JSON.parse(fs.readFileSync(temporaryBundle, "utf8"));
  mutate(bundle);
  fs.writeFileSync(temporaryBundle, `${JSON.stringify(bundle, null, 2)}\n`);
}

function expectCode(code, action) {
  assert.throws(action, (error) => (
    error instanceof Error
    && error.message === code
    && error.code === code
    && (!code.startsWith("E_EULERSWAP_SOURCE_PROVENANCE_") || error.stack === code)
  ));
}

const gitExecutable = process.platform === "win32" ? "C:\\Program Files\\Git\\cmd\\git.exe" : "/usr/bin/git";
const systemRoot = process.env.SystemRoot || "C:\\Windows";
const gitEnvironment = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_ALLOW_PROTOCOL: "file",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  LC_ALL: "C",
  LANG: "C",
  HOME: process.platform === "win32" ? path.join(systemRoot, "Temp", "eulerswap-test-neutral-home") : "/tmp/eulerswap-test-neutral-home",
  XDG_CONFIG_HOME: process.platform === "win32" ? path.join(systemRoot, "Temp", "eulerswap-test-neutral-xdg") : "/tmp/eulerswap-test-neutral-xdg",
  PATH: process.platform === "win32"
    ? `${path.dirname(gitExecutable)};C:\\Program Files\\Git\\mingw64\\bin;${path.join(systemRoot, "System32")}`
    : "/usr/bin:/bin",
};
if (process.platform === "win32") {
  gitEnvironment.SystemRoot = systemRoot;
  gitEnvironment.ComSpec = path.join(systemRoot, "System32", "cmd.exe");
}

function fixtureGit(cwd, argumentsList) {
  const result = spawnSync(gitExecutable, [
    "-c", "core.longpaths=true",
    "-c", "protocol.file.allow=always",
    "-c", "init.defaultBranch=main",
    ...argumentsList,
  ], {
    cwd,
    env: gitEnvironment,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 128 * 1024,
    windowsHide: true,
  });
  assert.strictEqual(result.error, undefined, "fixture Git execution failed");
  assert.strictEqual(result.status, 0, "fixture Git command failed");
  return result.stdout.trim();
}

function initializeRepository(repository, fileName, contents) {
  fs.mkdirSync(repository, { recursive: true });
  fixtureGit(repository, ["init"]);
  fs.writeFileSync(path.join(repository, fileName), contents);
  fixtureGit(repository, ["add", "--", fileName]);
  fixtureGit(repository, ["commit", "-m", "fixture"]);
}

function createRecursiveFixture(fixtureRoot) {
  const grandSource = path.join(fixtureRoot, "grand-source");
  const childSource = path.join(fixtureRoot, "child-source");
  const rootSource = path.join(fixtureRoot, "root-source");
  initializeRepository(grandSource, "grand.txt", "grand\n");
  initializeRepository(childSource, "child.txt", "child\n");
  fixtureGit(childSource, ["submodule", "add", grandSource, "deps/grand"]);
  fixtureGit(childSource, ["commit", "-m", "add grandchild"]);
  initializeRepository(rootSource, "root.txt", "root\n");
  fixtureGit(rootSource, ["submodule", "add", childSource, "modules/child"]);
  fixtureGit(rootSource, ["commit", "-m", "add child"]);

  return {
    rootSource,
    manifest: {
      schema: "eulerswap-v2-source-manifest/v1",
      source: {
        commit: fixtureGit(rootSource, ["rev-parse", "HEAD"]),
        tree: fixtureGit(rootSource, ["rev-parse", "HEAD^{tree}"]),
      },
      recursive_gitlinks: [
        {
          path: "modules/child",
          commit: fixtureGit(childSource, ["rev-parse", "HEAD"]),
          initialized: true,
          exact_gitlink: true,
        },
        {
          path: "modules/child/deps/grand",
          commit: fixtureGit(grandSource, ["rev-parse", "HEAD"]),
          initialized: true,
          exact_gitlink: true,
        },
      ],
    },
  };
}

function assertDeepFrozen(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.strictEqual(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

try {
  fs.mkdirSync(temporaryTools, { recursive: true });
  fs.mkdirSync(temporaryReports, { recursive: true });
  copyFile(original.module, path.join(temporaryTools, "eulerswap-v2-production-authority-r1.js"));
  copyFile(original.runtimeNormalizerModule, path.join(temporaryTools, "eulerswap-v2-runtime-normalizer-r1.js"));
  copyFile(original.sourceProvenanceModule, path.join(temporaryTools, "eulerswap-v2-source-provenance-r1.js"));
  copyFile(original.sourceManifest, path.join(temporaryReports, "eulerswap-v2-source-manifest.json"));
  copyFile(original.deploymentAuthority, path.join(temporaryReports, "eulerswap-v2-base-deployment-authority.json"));
  resetBundle();

  fs.mkdirSync(path.dirname(temporarySourceRoot), { recursive: true });
  fs.symlinkSync(original.sourceRoot, temporarySourceRoot, process.platform === "win32" ? "junction" : "dir");

  const temporaryModule = require(path.join(temporaryTools, "eulerswap-v2-production-authority-r1.js"));
  assert.deepStrictEqual(Object.keys(temporaryModule), ["loadProductionAuthority"]);
  assert.strictEqual(temporaryModule.loadProductionAuthority.length, 0);

  const authority = temporaryModule.loadProductionAuthority();
  assert.strictEqual(authority.schema, "eulerswap-v2-production-authority/r1");
  assert.strictEqual(authority.chainId, 8453);
  assert.strictEqual(authority.source.commit, "81cf6dc988468fd56f690e6bc0e338a5be02d034");
  assert.deepStrictEqual(authority.capabilities, {
    compilerEvidence: true,
    liveRecursiveSourceCleanliness: true,
    runtimeNormalization: true,
    transportAuthority: false,
    fullCaptureGo: false,
  });
  assert.strictEqual(authority.compilerAuthority.status, "PRODUCTION_COMPILER_EVIDENCE_ONLY");
  assert.strictEqual(authority.compilerAuthority.authorityScope, "COMPILER_EVIDENCE");
  assert.strictEqual(authority.compilerAuthority.toolchain.foundry.version, "1.3.6-v1.3.6");
  assert.strictEqual(authority.compilerAuthority.compiler.binarySha256, "b9977d500c17cba6f0032ca939ef98c4decf6363f19f386d05fb02f708115264");
  assert.deepStrictEqual(Object.keys(authority.addresses), [
    "factory",
    "implementation",
    "periphery",
    "protocolFeeConfig",
    "registry",
  ]);
  assertDeepFrozen(authority);

  const compilerTampering = [
    ["status", (bundle) => { bundle.status = "OTHER"; }, "E_EULERSWAP_COMPILER_STATUS_INVALID"],
    ["authority scope", (bundle) => { bundle.authorityScope = "FULL_CAPTURE"; }, "E_EULERSWAP_COMPILER_STATUS_INVALID"],
    ["source commit", (bundle) => { bundle.source.commit = "0".repeat(40); }],
    ["OCI reference", (bundle) => { bundle.toolchain.ociImage.reference += "-tampered"; }],
    ["OCI platform", (bundle) => { bundle.toolchain.ociImage.platform = "linux/arm64"; }],
    ["OCI platform manifest", (bundle) => { bundle.toolchain.ociImage.platformManifestDigest = `sha256:${"0".repeat(64)}`; }],
    ["OCI image ID", (bundle) => { bundle.toolchain.ociImage.imageId = `sha256:${"0".repeat(64)}`; }],
    ["Foundry version", (bundle) => { bundle.toolchain.foundry.version = "1.3.7"; }],
    ["Foundry commit", (bundle) => { bundle.toolchain.foundry.commit = "0".repeat(40); }],
    ["forge SHA-256", (bundle) => { bundle.toolchain.foundry.forgeSha256 = "0".repeat(64); }],
    ["solc version", (bundle) => { bundle.compiler.version = "0.8.28"; }],
    ["solc platform", (bundle) => { bundle.compiler.binaryPlatform = "linux/arm64"; }],
    ["solc SHA-256", (bundle) => { bundle.compiler.binarySha256 = "0".repeat(64); }],
    ["optimizer enabled", (bundle) => { bundle.compiler.settings.optimizer.enabled = false; }],
    ["optimizer runs", (bundle) => { bundle.compiler.settings.optimizer.runs = 2499; }],
    ["EVM version", (bundle) => { bundle.compiler.settings.evmVersion = "cancun"; }],
    ["capture gate", (bundle) => { bundle.captureGates.fullCaptureGo = true; }],
    ["runtime template", (bundle) => {
      const template = bundle.contracts[0].deployedBytecodeTemplate;
      bundle.contracts[0].deployedBytecodeTemplate = `${template.slice(0, -1)}${template.endsWith("0") ? "1" : "0"}`;
    }],
  ];

  for (const [label, mutate, code = "E_EULERSWAP_COMPILER_AUTHORITY_INVALID"] of compilerTampering) {
    resetBundle();
    mutateBundle(mutate);
    expectCode(code, () => temporaryModule.loadProductionAuthority(), label);
  }

  resetBundle();
  const temporaryDeployment = path.join(temporaryReports, "eulerswap-v2-base-deployment-authority.json");
  const deployment = JSON.parse(fs.readFileSync(temporaryDeployment, "utf8"));
  deployment.deployments.factory.codeSize += 1;
  fs.writeFileSync(temporaryDeployment, `${JSON.stringify(deployment, null, 2)}\n`);
  expectCode("E_EULERSWAP_AUTHORITY_SIZE_MISMATCH", () => temporaryModule.loadProductionAuthority());
  copyFile(original.deploymentAuthority, temporaryDeployment);

  const { validateNonAuthorizingSourceProvenance } = require("./eulerswap-v2-source-provenance-r1");
  const recursiveFixture = createRecursiveFixture(path.join(temporaryWorkspace, "git-fixture"));
  const fixtureCheckout = path.join(temporaryWorkspace, "fixture-checkout");
  const freshCheckout = (recursive = true) => {
    fs.rmSync(fixtureCheckout, { recursive: true, force: true });
    const cloneArguments = ["clone"];
    if (recursive) cloneArguments.push("--recurse-submodules");
    cloneArguments.push(recursiveFixture.rootSource, fixtureCheckout);
    fixtureGit(temporaryWorkspace, cloneArguments);
    fixtureGit(fixtureCheckout, ["checkout", "--detach", "HEAD"]);
  };

  freshCheckout();
  assert.strictEqual(validateNonAuthorizingSourceProvenance({
    sourceRoot: fixtureCheckout,
    manifest: recursiveFixture.manifest,
  }), true);

  freshCheckout();
  fixtureGit(fixtureCheckout, ["checkout", "main"]);
  expectCode("E_EULERSWAP_SOURCE_PROVENANCE_HEAD_ATTACHED", () => validateNonAuthorizingSourceProvenance({
    sourceRoot: fixtureCheckout,
    manifest: recursiveFixture.manifest,
  }));

  freshCheckout();
  fixtureGit(path.join(fixtureCheckout, "modules/child"), ["checkout", "-b", "attached-test"]);
  expectCode("E_EULERSWAP_SOURCE_PROVENANCE_HEAD_ATTACHED", () => validateNonAuthorizingSourceProvenance({
    sourceRoot: fixtureCheckout,
    manifest: recursiveFixture.manifest,
  }));

  freshCheckout();
  fixtureGit(fixtureCheckout, ["checkout", "HEAD^"]);
  expectCode("E_EULERSWAP_SOURCE_PROVENANCE_HEAD_MISMATCH", () => validateNonAuthorizingSourceProvenance({
    sourceRoot: fixtureCheckout,
    manifest: recursiveFixture.manifest,
  }));

  freshCheckout();
  fs.appendFileSync(path.join(fixtureCheckout, "root.txt"), "dirty\n");
  expectCode("E_EULERSWAP_SOURCE_PROVENANCE_DIRTY", () => validateNonAuthorizingSourceProvenance({
    sourceRoot: fixtureCheckout,
    manifest: recursiveFixture.manifest,
  }));

  freshCheckout();
  const maliciousRootExcludes = path.join(temporaryWorkspace, "malicious-root-excludes");
  fs.writeFileSync(maliciousRootExcludes, "*.hidden\n");
  fixtureGit(fixtureCheckout, ["config", "status.showUntrackedFiles", "no"]);
  fixtureGit(fixtureCheckout, ["config", "diff.ignoreSubmodules", "all"]);
  fixtureGit(fixtureCheckout, ["config", "core.excludesFile", maliciousRootExcludes]);
  fixtureGit(fixtureCheckout, ["config", "alias.status", "!exit 0"]);
  fs.writeFileSync(path.join(fixtureCheckout, "root.hidden"), "must be detected\n");
  expectCode("E_EULERSWAP_SOURCE_PROVENANCE_DIRTY", () => validateNonAuthorizingSourceProvenance({
    sourceRoot: fixtureCheckout,
    manifest: recursiveFixture.manifest,
  }));

  freshCheckout();
  const childCheckout = path.join(fixtureCheckout, "modules/child");
  const maliciousChildExcludes = path.join(temporaryWorkspace, "malicious-child-excludes");
  fs.writeFileSync(maliciousChildExcludes, "*.hidden\n");
  fixtureGit(childCheckout, ["config", "status.showUntrackedFiles", "no"]);
  fixtureGit(childCheckout, ["config", "diff.ignoreSubmodules", "all"]);
  fixtureGit(childCheckout, ["config", "core.excludesFile", maliciousChildExcludes]);
  fs.writeFileSync(path.join(childCheckout, "child.hidden"), "must be detected\n");
  expectCode("E_EULERSWAP_SOURCE_PROVENANCE_DIRTY", () => validateNonAuthorizingSourceProvenance({
    sourceRoot: fixtureCheckout,
    manifest: recursiveFixture.manifest,
  }));

  freshCheckout();
  const maliciousAmbientConfig = path.join(temporaryWorkspace, "ambient-gitconfig");
  fs.writeFileSync(maliciousAmbientConfig, "[status]\n\tshowUntrackedFiles = no\n[alias]\n\tstatus = !exit 1\n");
  const ambientKeys = [
    "SystemRoot",
    "ComSpec",
    "PATH",
    "Path",
    "HOME",
    "XDG_CONFIG_HOME",
    "TEMP",
    "TMP",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0",
    "GIT_EXEC_PATH",
    "GIT_DIR",
    "GIT_WORK_TREE",
  ];
  const savedAmbient = new Map(ambientKeys.map((key) => [key, process.env[key]]));
  try {
    process.env.SystemRoot = path.join(temporaryWorkspace, "attacker-system-root");
    process.env.ComSpec = path.join(temporaryWorkspace, "attacker-cmd.exe");
    process.env.PATH = path.join(temporaryWorkspace, "malicious-path");
    process.env.Path = path.join(temporaryWorkspace, "malicious-path");
    process.env.HOME = temporaryWorkspace;
    process.env.XDG_CONFIG_HOME = temporaryWorkspace;
    process.env.TEMP = temporaryWorkspace;
    process.env.TMP = temporaryWorkspace;
    process.env.GIT_CONFIG_GLOBAL = maliciousAmbientConfig;
    process.env.GIT_CONFIG_SYSTEM = maliciousAmbientConfig;
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "status.showUntrackedFiles";
    process.env.GIT_CONFIG_VALUE_0 = "no";
    process.env.GIT_EXEC_PATH = path.join(temporaryWorkspace, "malicious-git-exec-path");
    process.env.GIT_DIR = path.join(temporaryWorkspace, "wrong-git-dir");
    process.env.GIT_WORK_TREE = path.join(temporaryWorkspace, "wrong-work-tree");
    assert.strictEqual(validateNonAuthorizingSourceProvenance({
      sourceRoot: fixtureCheckout,
      manifest: recursiveFixture.manifest,
    }), true);
    const poison = {};
    Object.defineProperty(poison, "sourceRoot", {
      get() { throw new Error("caller argument was consulted"); },
    });
    const uninfluenced = temporaryModule.loadProductionAuthority(poison, { fullCaptureGo: true });
    assert.deepStrictEqual(uninfluenced, authority);
    assert.strictEqual(uninfluenced.capabilities.fullCaptureGo, false);
  } finally {
    for (const [key, value] of savedAmbient) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  freshCheckout();
  fs.appendFileSync(path.join(fixtureCheckout, "modules/child/deps/grand/grand.txt"), "dirty\n");
  expectCode("E_EULERSWAP_SOURCE_PROVENANCE_DIRTY", () => validateNonAuthorizingSourceProvenance({
    sourceRoot: fixtureCheckout,
    manifest: recursiveFixture.manifest,
  }));

  freshCheckout(false);
  expectCode("E_EULERSWAP_SOURCE_PROVENANCE_SUBMODULE_MISMATCH", () => validateNonAuthorizingSourceProvenance({
    sourceRoot: fixtureCheckout,
    manifest: recursiveFixture.manifest,
  }));

  freshCheckout();
  fixtureGit(path.join(fixtureCheckout, "modules/child"), ["checkout", "HEAD^"]);
  expectCode("E_EULERSWAP_SOURCE_PROVENANCE_SUBMODULE_MISMATCH", () => validateNonAuthorizingSourceProvenance({
    sourceRoot: fixtureCheckout,
    manifest: recursiveFixture.manifest,
  }));

  freshCheckout();
  const fixtureGitDirectory = path.join(fixtureCheckout, ".git");
  const disabledGitDirectory = path.join(fixtureCheckout, ".git-disabled");
  fs.renameSync(fixtureGitDirectory, disabledGitDirectory);
  expectCode("E_EULERSWAP_SOURCE_PROVENANCE_COMMAND_FAILED", () => validateNonAuthorizingSourceProvenance({
    sourceRoot: fixtureCheckout,
    manifest: recursiveFixture.manifest,
  }));
  fs.renameSync(disabledGitDirectory, fixtureGitDirectory);

  expectCode("E_EULERSWAP_SOURCE_PROVENANCE_COMMAND_TIMEOUT", () => validateNonAuthorizingSourceProvenance({
    sourceRoot: fixtureCheckout,
    manifest: recursiveFixture.manifest,
    timeoutMs: 1,
  }));

  console.log("eulerswap-v2 production authority r1: recursive source provenance ok");
} finally {
  fs.rmSync(temporaryWorkspace, { recursive: true, force: true });
}
