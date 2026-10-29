"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const GIT_EXECUTABLE = "C:\\Program Files\\Git\\cmd\\git.exe";
const SYSTEM_ROOT = "C:\\Windows";
const COMSPEC = "C:\\Windows\\System32\\cmd.exe";
const NEUTRAL_HOME = "C:\\Windows\\Temp\\eulerswap-git-neutral-home";
const NEUTRAL_XDG_CONFIG_HOME = "C:\\Windows\\Temp\\eulerswap-git-neutral-xdg";
const FIXED_PATH = "C:\\Program Files\\Git\\cmd;C:\\Windows\\System32";
const NULL_DEVICE = "NUL";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 128 * 1024;
const MAX_SUBMODULES = 128;

const ERROR = Object.freeze({
  manifest: "E_EULERSWAP_SOURCE_PROVENANCE_MANIFEST_INVALID",
  platform: "E_EULERSWAP_SOURCE_PROVENANCE_PLATFORM_UNSUPPORTED",
  executable: "E_EULERSWAP_SOURCE_PROVENANCE_FIXED_EXECUTABLE_MISSING",
  command: "E_EULERSWAP_SOURCE_PROVENANCE_COMMAND_FAILED",
  timeout: "E_EULERSWAP_SOURCE_PROVENANCE_COMMAND_TIMEOUT",
  head: "E_EULERSWAP_SOURCE_PROVENANCE_HEAD_MISMATCH",
  attached: "E_EULERSWAP_SOURCE_PROVENANCE_HEAD_ATTACHED",
  tree: "E_EULERSWAP_SOURCE_PROVENANCE_TREE_MISMATCH",
  submodule: "E_EULERSWAP_SOURCE_PROVENANCE_SUBMODULE_MISMATCH",
  dirty: "E_EULERSWAP_SOURCE_PROVENANCE_DIRTY",
});

const FIXED_CONFIG = Object.freeze([
  "-c", "core.longpaths=true",
  "-c", "core.bare=false",
  "-c", "core.fsmonitor=false",
  "-c", "core.untrackedCache=false",
  "-c", `core.excludesFile=${NULL_DEVICE}`,
  "-c", `core.attributesFile=${NULL_DEVICE}`,
  "-c", "status.showUntrackedFiles=all",
  "-c", "status.submoduleSummary=false",
  "-c", "diff.ignoreSubmodules=none",
]);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  error.stack = code;
  throw error;
}

function gitEnvironment() {
  return {
    SystemRoot: SYSTEM_ROOT,
    ComSpec: COMSPEC,
    PATH: FIXED_PATH,
    HOME: NEUTRAL_HOME,
    XDG_CONFIG_HOME: NEUTRAL_XDG_CONFIG_HOME,
    TEMP: "C:\\Windows\\Temp",
    TMP: "C:\\Windows\\Temp",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: NULL_DEVICE,
    GIT_CONFIG_SYSTEM: NULL_DEVICE,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C",
    LANG: "C",
  };
}

function validateFixedPlatform() {
  if (process.platform !== "win32") fail(ERROR.platform);
  try {
    if (!fs.statSync(GIT_EXECUTABLE).isFile() || !fs.statSync(COMSPEC).isFile()) fail(ERROR.executable);
  } catch (error) {
    if (error && error.code === ERROR.executable) throw error;
    fail(ERROR.executable);
  }
}

function executeGit(checkout, argumentsList, timeoutMs) {
  const commandArguments = [
    "--no-optional-locks",
    `--git-dir=${checkout.gitDir}`,
    `--work-tree=${checkout.workTree}`,
    ...FIXED_CONFIG,
    "-c", `core.worktree=${checkout.workTree}`,
    ...argumentsList,
  ];
  const result = spawnSync(GIT_EXECUTABLE, commandArguments, {
    cwd: checkout.workTree,
    env: gitEnvironment(),
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: MAX_OUTPUT_BYTES,
    windowsHide: true,
    shell: false,
  });
  if (result.error && result.error.code === "ETIMEDOUT") fail(ERROR.timeout);
  if (
    result.error
    || typeof result.status !== "number"
    || typeof result.stdout !== "string"
    || Buffer.byteLength(result.stdout, "utf8") > MAX_OUTPUT_BYTES
    || Buffer.byteLength(result.stderr || "", "utf8") > MAX_OUTPUT_BYTES
  ) {
    fail(ERROR.command);
  }
  return { status: result.status, stdout: result.stdout };
}

function runGit(checkout, argumentsList, timeoutMs) {
  const result = executeGit(checkout, argumentsList, timeoutMs);
  if (result.status !== 0) fail(ERROR.command);
  return result.stdout;
}

function requireDetached(checkout, timeoutMs) {
  const result = executeGit(checkout, ["symbolic-ref", "-q", "HEAD"], timeoutMs);
  if (result.status === 0) fail(ERROR.attached);
  if (result.status !== 1 || result.stdout !== "") fail(ERROR.command);
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function rootCheckout(sourceRoot) {
  let workTree;
  try {
    workTree = fs.realpathSync.native(path.resolve(sourceRoot));
  } catch (_error) {
    fail(ERROR.command);
  }
  const gitDir = path.join(workTree, ".git");
  try {
    if (!fs.statSync(gitDir).isDirectory()) fail(ERROR.command);
  } catch (error) {
    if (error && error.code === ERROR.command) throw error;
    fail(ERROR.command);
  }
  return { workTree, gitDir };
}

function submoduleCheckout(root, relativePath) {
  const workTree = path.resolve(root.workTree, relativePath);
  if (!isInside(root.workTree, workTree)) fail(ERROR.submodule);
  const dotGit = path.join(workTree, ".git");
  let gitFile;
  try {
    if (!fs.statSync(dotGit).isFile()) fail(ERROR.submodule);
    gitFile = fs.readFileSync(dotGit, "utf8");
  } catch (error) {
    if (error && error.code === ERROR.submodule) throw error;
    fail(ERROR.submodule);
  }
  const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(gitFile);
  if (!match) fail(ERROR.submodule);
  const gitDir = path.resolve(workTree, match[1]);
  if (!isInside(root.gitDir, gitDir)) fail(ERROR.submodule);
  try {
    if (!fs.statSync(gitDir).isDirectory()) fail(ERROR.submodule);
  } catch (error) {
    if (error && error.code === ERROR.submodule) throw error;
    fail(ERROR.submodule);
  }
  return { workTree, gitDir };
}

function validateManifestBinding(manifest) {
  if (
    !manifest
    || manifest.schema !== "eulerswap-v2-source-manifest/v1"
    || !manifest.source
    || !/^[0-9a-f]{40}$/.test(manifest.source.commit || "")
    || !/^[0-9a-f]{40}$/.test(manifest.source.tree || "")
    || !Array.isArray(manifest.recursive_gitlinks)
    || manifest.recursive_gitlinks.length === 0
    || manifest.recursive_gitlinks.length > MAX_SUBMODULES
  ) {
    fail(ERROR.manifest);
  }

  const expected = new Map();
  for (const entry of manifest.recursive_gitlinks) {
    const normalizedPath = typeof entry?.path === "string" ? entry.path.replace(/\\/g, "/") : "";
    if (
      normalizedPath.length === 0
      || normalizedPath.startsWith("/")
      || normalizedPath.split("/").includes("..")
      || !/^[0-9a-f]{40}$/.test(entry.commit || "")
      || entry.initialized !== true
      || entry.exact_gitlink !== true
      || expected.has(normalizedPath)
    ) {
      fail(ERROR.manifest);
    }
    expected.set(normalizedPath, entry.commit);
  }
  return expected;
}

function immediateParentPath(submodulePath, allPaths) {
  let parent = "";
  for (const candidate of allPaths) {
    if (submodulePath.startsWith(`${candidate}/`) && candidate.length > parent.length) parent = candidate;
  }
  return parent;
}

function validateNonAuthorizingSourceProvenance({ sourceRoot, manifest, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  validateFixedPlatform();
  if (typeof sourceRoot !== "string" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_TIMEOUT_MS) {
    fail(ERROR.manifest);
  }
  const expectedSubmodules = validateManifestBinding(manifest);
  const root = rootCheckout(sourceRoot);
  const checkouts = new Map([["", root]]);

  const head = runGit(root, ["rev-parse", "--verify", "HEAD"], timeoutMs).trim();
  if (head !== manifest.source.commit) fail(ERROR.head);
  const tree = runGit(root, ["rev-parse", "--verify", "HEAD^{tree}"], timeoutMs).trim();
  if (tree !== manifest.source.tree) fail(ERROR.tree);
  requireDetached(root, timeoutMs);

  const paths = [...expectedSubmodules.keys()].sort((left, right) => left.split("/").length - right.split("/").length);
  for (const submodulePath of paths) {
    const parentPath = immediateParentPath(submodulePath, paths);
    const parent = checkouts.get(parentPath);
    if (!parent) fail(ERROR.submodule);
    const pathWithinParent = parentPath === "" ? submodulePath : submodulePath.slice(parentPath.length + 1);
    const treeEntry = runGit(parent, ["ls-tree", "HEAD", "--", pathWithinParent], timeoutMs).trim();
    const match = /^160000 commit ([0-9a-f]{40})\t(.+)$/.exec(treeEntry);
    if (!match || match[1] !== expectedSubmodules.get(submodulePath) || match[2].replace(/\\/g, "/") !== pathWithinParent) {
      fail(ERROR.submodule);
    }

    const checkout = submoduleCheckout(root, submodulePath);
    const submoduleHead = runGit(checkout, ["rev-parse", "--verify", "HEAD"], timeoutMs).trim();
    if (submoduleHead !== expectedSubmodules.get(submodulePath)) fail(ERROR.submodule);
    requireDetached(checkout, timeoutMs);
    checkouts.set(submodulePath, checkout);
  }

  for (const submodulePath of [...paths].reverse()) {
    const status = runGit(checkouts.get(submodulePath), [
      "status", "--porcelain=v1", "--untracked-files=all", "--ignored=no", "--ignore-submodules=none",
    ], timeoutMs);
    if (status !== "") fail(ERROR.dirty);
  }
  const rootStatus = runGit(root, [
    "status", "--porcelain=v1", "--untracked-files=all", "--ignored=no", "--ignore-submodules=none",
  ], timeoutMs);
  if (rootStatus !== "") fail(ERROR.dirty);
  return true;
}

module.exports = Object.freeze({ validateNonAuthorizingSourceProvenance });
