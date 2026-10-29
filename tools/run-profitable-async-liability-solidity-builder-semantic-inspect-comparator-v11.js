#!/usr/bin/env node
"use strict";

const NAMESPACE = "profitable-async-liability-solidity-builder-semantic-inspect-comparator-v11";
const STATUS = "SEALED_OFFLINE_COMPARATOR_REVIEW_REQUIRED_NO_EXECUTION_AUTHORITY";
const RESERVED_FLAG = "--execute-v11";

const MISMATCH_CODES = Object.freeze([
  "CAP_DROP_MISMATCH", "CAUSAL_ID_MISMATCH", "CGROUPNS_MODE_MISMATCH", "COMMAND_MISMATCH",
  "CONFIG_DIGEST_MISMATCH", "DEVICES_MISMATCH", "ENTRYPOINT_MISMATCH", "ENV_DUPLICATE_KEY",
  "ENV_MALFORMED", "ENV_MISSING_KEY", "ENV_UNEXPECTED_KEY", "ENV_VALUE_MISMATCH", "EXPECTED_MALFORMED",
  "EXTRA_PAL_LABEL", "HOST_MOUNTS_MALFORMED", "HOST_MOUNT_EXTRA", "HOST_MOUNT_MISSING",
  "HOST_MOUNT_READONLY_MISMATCH", "HOST_MOUNT_SOURCE_MISMATCH", "HOST_MOUNT_TYPE_MISMATCH",
  "IMAGE_REFERENCE_MISMATCH", "IPC_MODE_MISMATCH", "LABELS_MALFORMED", "LABEL_MISSING",
  "LABEL_VALUE_MISMATCH", "MEMORY_MISMATCH", "MEMORY_SWAP_MISMATCH", "NAME_MISMATCH",
  "NANO_CPUS_MISMATCH", "NETWORK_MODE_MISMATCH", "PATH_POLICY_MALFORMED", "PIDS_LIMIT_MISMATCH",
  "PID_MODE_MISMATCH", "PRIVILEGED_MISMATCH", "RAW_MALFORMED", "READ_ONLY_ROOTFS_MISMATCH",
  "SECURITY_OPT_MISMATCH", "SOURCE_DATE_EPOCH_PRESENT", "STATE_RUNNING_MISMATCH",
  "STATE_STARTED_AT_MISMATCH", "STATE_STATUS_MISMATCH", "TMPFS_MALFORMED", "TMPFS_OPTIONS_MISMATCH",
  "TMPFS_TARGET_EXTRA", "TMPFS_TARGET_MISSING", "TOP_MOUNTS_MALFORMED", "TOP_MOUNT_EXTRA",
  "TOP_MOUNT_MISSING", "TOP_MOUNT_RECONCILIATION_MISMATCH", "TOP_MOUNT_RW_MISMATCH",
  "TOP_MOUNT_TYPE_MISMATCH", "USER_MISMATCH", "UTS_MODE_MISMATCH", "WORKDIR_MISMATCH"
].sort());
const REPRESENTATION_NOTES = Object.freeze([
  "ENV_ORDER_ONLY", "EXTRA_NON_PAL_LABELS_PRESENT", "TOP_MOUNT_SOURCE_IGNORED_VM_TRANSLATION"
].sort());
const CODE_SET = new Set(MISMATCH_CODES);
const NOTE_SET = new Set(REPRESENTATION_NOTES);

function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function sameArray(a, b) { return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]); }
function own(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
function exactKeys(value, keys) { return object(value) && sameArray(Object.keys(value), keys); }
function stringArray(value, nonempty = false) { return Array.isArray(value) && (!nonempty || value.length > 0) && value.every((x) => typeof x === "string"); }
function emit(set, value, allowed) { if (allowed.has(value)) set.add(value); }
function optionSet(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const parts = value.split(",");
  if (parts.some((x) => !x || x.trim() !== x)) return null;
  const identities = parts.map((x) => x.includes("=") ? x.slice(0, x.indexOf("=")) : x);
  if (new Set(identities).size !== identities.length || parts.some((x) => x.includes("=") && (!/^[a-z]+=[A-Za-z0-9]+$/.test(x)))) return null;
  return [...parts].sort();
}
function normalizedWindowsPath(value) {
  if (typeof value !== "string" || value.length < 3 || value.includes("\0")) return null;
  const canonical = value.replace(/\//g, "\\"), parts = canonical.split("\\");
  if (!/^[A-Za-z]:$/.test(parts[0])) return null;
  const tail = [];
  for (const part of parts.slice(1)) {
    if (part === "" || part === ".") continue;
    if (part === "..") return null;
    if (part.includes(":")) return null;
    tail.push(part.toLowerCase());
  }
  return `${parts[0].toLowerCase()}\\${tail.join("\\")}`;
}
function normalizeHostPath(value, policy) {
  if (policy === "win32") return normalizedWindowsPath(value);
  if (policy !== "exact" || typeof value !== "string" || value.includes("\0") || !value.startsWith("/") || value.split("/").includes("..")) return null;
  return value;
}
function parseEnvironment(value) {
  if (!Array.isArray(value)) return { malformed: true, duplicate: false, map: new Map() };
  const map = new Map(); let malformed = false, duplicate = false;
  for (const entry of value) {
    if (typeof entry !== "string") { malformed = true; continue; }
    const index = entry.indexOf("=");
    if (index < 1) { malformed = true; continue; }
    const key = entry.slice(0, index), item = entry.slice(index + 1);
    if (map.has(key)) duplicate = true;
    else map.set(key, item);
  }
  return { malformed, duplicate, map };
}
function compareEnvironment(raw, expected, codes, notes) {
  const before = codes.size;
  const actual = parseEnvironment(raw), wanted = parseEnvironment(expected);
  if (actual.malformed) emit(codes, "ENV_MALFORMED", CODE_SET);
  if (actual.duplicate) emit(codes, "ENV_DUPLICATE_KEY", CODE_SET);
  if (wanted.malformed || wanted.duplicate) { emit(codes, "EXPECTED_MALFORMED", CODE_SET); return; }
  if (actual.map.has("SOURCE_DATE_EPOCH")) emit(codes, "SOURCE_DATE_EPOCH_PRESENT", CODE_SET);
  for (const [key, value] of wanted.map) {
    if (!actual.map.has(key)) emit(codes, "ENV_MISSING_KEY", CODE_SET);
    else if (actual.map.get(key) !== value) emit(codes, "ENV_VALUE_MISMATCH", CODE_SET);
  }
  for (const key of actual.map.keys()) if (!wanted.map.has(key) && key !== "SOURCE_DATE_EPOCH") emit(codes, "ENV_UNEXPECTED_KEY", CODE_SET);
  if (!actual.malformed && !actual.duplicate && codes.size === before && !sameArray(raw, expected)) emit(notes, "ENV_ORDER_ONLY", NOTE_SET);
}
function compareLabels(raw, expected, codes, notes) {
  if (!object(raw)) { emit(codes, "LABELS_MALFORMED", CODE_SET); return; }
  if (!object(expected)) { emit(codes, "EXPECTED_MALFORMED", CODE_SET); return; }
  for (const [key, value] of Object.entries(expected)) {
    if (!own(raw, key)) emit(codes, "LABEL_MISSING", CODE_SET);
    else if (raw[key] !== value) emit(codes, "LABEL_VALUE_MISMATCH", CODE_SET);
  }
  let extraNonPal = false;
  for (const key of Object.keys(raw)) if (!own(expected, key)) {
    if (key.startsWith("pal.")) emit(codes, "EXTRA_PAL_LABEL", CODE_SET);
    else extraNonPal = true;
  }
  if (extraNonPal) emit(notes, "EXTRA_NON_PAL_LABELS_PRESENT", NOTE_SET);
}
function compareSecurity(value, codes) {
  if (!Array.isArray(value) || value.length !== 1 || typeof value[0] !== "string") return emit(codes, "SECURITY_OPT_MISMATCH", CODE_SET);
  if (!["no-new-privileges:true", "no-new-privileges=true"].includes(value[0])) emit(codes, "SECURITY_OPT_MISMATCH", CODE_SET);
}
function compareTmpfs(raw, expected, codes) {
  if (!object(raw)) { emit(codes, "TMPFS_MALFORMED", CODE_SET); return; }
  if (!object(expected)) { emit(codes, "EXPECTED_MALFORMED", CODE_SET); return; }
  for (const target of Object.keys(expected)) {
    if (!own(raw, target)) emit(codes, "TMPFS_TARGET_MISSING", CODE_SET);
    else {
      const actualOptions = optionSet(raw[target]), wantedOptions = optionSet(expected[target]);
      if (!actualOptions || !wantedOptions) emit(codes, actualOptions ? "EXPECTED_MALFORMED" : "TMPFS_MALFORMED", CODE_SET);
      else if (!sameArray(actualOptions, wantedOptions)) emit(codes, "TMPFS_OPTIONS_MISMATCH", CODE_SET);
    }
  }
  for (const target of Object.keys(raw)) if (!own(expected, target)) emit(codes, "TMPFS_TARGET_EXTRA", CODE_SET);
}
function indexMounts(value, targetKey, kind) {
  if (!Array.isArray(value)) return null;
  const map = new Map();
  for (const item of value) {
    const keys = kind === "expected" ? ["type", "source", "target", "readOnly"] : kind === "host" ? ["Type", "Source", "Target", "ReadOnly"] : ["Type", "Source", "Destination", "RW"];
    if (!object(item) || kind === "expected" && !exactKeys(item, keys) || typeof item[targetKey] !== "string" || typeof item.Source === "undefined" && kind !== "expected" || map.has(item[targetKey])) return null;
    if (kind === "expected" && (typeof item.type !== "string" || typeof item.source !== "string" || typeof item.readOnly !== "boolean")) return null;
    if (kind === "host" && (typeof item.Type !== "string" || typeof item.Source !== "string" || typeof item.ReadOnly !== "boolean")) return null;
    if (kind === "top" && (typeof item.Type !== "string" || typeof item.Source !== "string" || typeof item.RW !== "boolean")) return null;
    map.set(item[targetKey], item);
  }
  return map;
}
function compareMounts(rawHost, rawTop, expected, policy, codes, notes) {
  const expectedMap = indexMounts(expected, "target", "expected"), hostMap = indexMounts(rawHost, "Target", "host"), topMap = indexMounts(rawTop, "Destination", "top");
  if (!hostMap) emit(codes, "HOST_MOUNTS_MALFORMED", CODE_SET);
  if (!topMap) emit(codes, "TOP_MOUNTS_MALFORMED", CODE_SET);
  if (!hostMap || !topMap) return;
  for (const [target, wanted] of expectedMap) {
    const host = hostMap.get(target), top = topMap.get(target);
    if (!host) emit(codes, "HOST_MOUNT_MISSING", CODE_SET);
    else {
      if (host.Type !== wanted.type) emit(codes, "HOST_MOUNT_TYPE_MISMATCH", CODE_SET);
      if (host.ReadOnly !== wanted.readOnly) emit(codes, "HOST_MOUNT_READONLY_MISMATCH", CODE_SET);
      const actualSource = normalizeHostPath(host.Source, policy), wantedSource = normalizeHostPath(wanted.source, policy);
      if (!actualSource || !wantedSource) emit(codes, "PATH_POLICY_MALFORMED", CODE_SET);
      else if (actualSource !== wantedSource) emit(codes, "HOST_MOUNT_SOURCE_MISMATCH", CODE_SET);
    }
    if (!top) emit(codes, "TOP_MOUNT_MISSING", CODE_SET);
    else {
      if (top.Type !== wanted.type) emit(codes, "TOP_MOUNT_TYPE_MISMATCH", CODE_SET);
      if (top.RW !== !wanted.readOnly) emit(codes, "TOP_MOUNT_RW_MISMATCH", CODE_SET);
      if (host && (top.Type !== host.Type || top.RW !== !host.ReadOnly)) emit(codes, "TOP_MOUNT_RECONCILIATION_MISMATCH", CODE_SET);
      if (typeof top.Source === "string" && host && top.Source !== host.Source) emit(notes, "TOP_MOUNT_SOURCE_IGNORED_VM_TRANSLATION", NOTE_SET);
    }
  }
  for (const target of hostMap.keys()) if (!expectedMap.has(target)) emit(codes, "HOST_MOUNT_EXTRA", CODE_SET);
  for (const target of topMap.keys()) if (!expectedMap.has(target)) emit(codes, "TOP_MOUNT_EXTRA", CODE_SET);
}
function compareScalar(actual, expected, code, codes) { if (actual !== expected) emit(codes, code, CODE_SET); }

const EXPECTED_KEYS = ["id", "name", "configDigest", "imageReference", "labels", "environment", "entrypoint", "command", "user", "workdir", "state", "pathPolicy", "host", "mounts"];
const STATE_KEYS = ["status", "running", "startedAt"];
const HOST_KEYS = ["networkMode", "readOnlyRootfs", "privileged", "memory", "memorySwap", "nanoCpus", "pidsLimit", "ipcMode", "cgroupnsMode", "pidMode", "utsMode", "tmpfs"];
const LABEL_KEYS = ["pal.authorization", "pal.executor", "pal.build"];
const ENV_KEYS = ["PATH", "EMSDK", "TZ", "LANG", "LC_ALL", "HOME", "XDG_CACHE_HOME"];
const TMPFS_KEYS = ["/tmp", "/home/nonroot", "/cache"];
function validExpected(value) {
  if (!exactKeys(value, EXPECTED_KEYS) || !exactKeys(value.state, STATE_KEYS) || !exactKeys(value.host, HOST_KEYS)) return false;
  if (typeof value.id !== "string" || !/^[a-f0-9]{64}$/.test(value.id) || typeof value.name !== "string" || !/^\/[A-Za-z0-9._-]+$/.test(value.name)) return false;
  if (typeof value.configDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.configDigest) || typeof value.imageReference !== "string" || !value.imageReference.includes("@sha256:")) return false;
  if (!exactKeys(value.labels, LABEL_KEYS) || !Object.values(value.labels).every((x) => typeof x === "string") || !/^[a-f0-9]{32}$/.test(value.labels["pal.authorization"]) || !["a", "b"].includes(value.labels["pal.build"])) return false;
  const environment = parseEnvironment(value.environment);
  if (environment.malformed || environment.duplicate || !sameArray([...environment.map.keys()].sort(), [...ENV_KEYS].sort()) || environment.map.has("SOURCE_DATE_EPOCH")) return false;
  if (!stringArray(value.entrypoint, true) || !stringArray(value.command, true) || typeof value.user !== "string" || typeof value.workdir !== "string" || !value.workdir.startsWith("/")) return false;
  if (value.state.status !== "created" || value.state.running !== false || value.state.startedAt !== "0001-01-01T00:00:00Z" || !["win32", "exact"].includes(value.pathPolicy)) return false;
  const h = value.host;
  if (h.networkMode !== "none" || h.readOnlyRootfs !== true || h.privileged !== false || ![h.memory, h.memorySwap, h.nanoCpus, h.pidsLimit].every(Number.isSafeInteger) || h.memory <= 0 || h.memorySwap !== h.memory || h.nanoCpus <= 0 || h.pidsLimit <= 0 || h.ipcMode !== "private" || h.cgroupnsMode !== "private" || h.pidMode !== "" || h.utsMode !== "") return false;
  if (!exactKeys(h.tmpfs, TMPFS_KEYS)) return false;
  const requiredOptions = { "/tmp": ["rw", "nosuid", "nodev", "size"], "/home/nonroot": ["rw", "noexec", "nosuid", "nodev", "size"], "/cache": ["rw", "size"] };
  for (const target of TMPFS_KEYS) {
    const options = optionSet(h.tmpfs[target]);
    if (!options || !sameArray(options.map((x) => x.includes("=") ? x.slice(0, x.indexOf("=")) : x).sort(), requiredOptions[target].sort())) return false;
  }
  const mounts = indexMounts(value.mounts, "target", "expected");
  if (!mounts || mounts.size !== 2 || !mounts.has("/src") || !mounts.has("/out")) return false;
  for (const [target, mount] of mounts) if (mount.type !== "bind" || mount.readOnly !== (target === "/src") || !normalizeHostPath(mount.source, value.pathPolicy)) return false;
  return true;
}

function compareInspect(raw, expected) {
  const codes = new Set(), notes = new Set();
  try {
    if (!validExpected(expected)) return { match: false, mismatchCodes: ["EXPECTED_MALFORMED"], representationNotes: [] };
    if (!object(raw)) { emit(codes, "RAW_MALFORMED", CODE_SET); return finish(codes, notes); }
    const config = object(raw.Config) ? raw.Config : {}, state = object(raw.State) ? raw.State : {}, host = object(raw.HostConfig) ? raw.HostConfig : {};
    if (!object(raw.Config) || !object(raw.State) || !object(raw.HostConfig)) emit(codes, "RAW_MALFORMED", CODE_SET);
    compareScalar(raw.Id, expected.id, "CAUSAL_ID_MISMATCH", codes);
    compareScalar(raw.Name, expected.name, "NAME_MISMATCH", codes);
    compareScalar(raw.Image, expected.configDigest, "CONFIG_DIGEST_MISMATCH", codes);
    compareScalar(config.Image, expected.imageReference, "IMAGE_REFERENCE_MISMATCH", codes);
    compareLabels(config.Labels, expected.labels, codes, notes);
    compareEnvironment(config.Env, expected.environment, codes, notes);
    if (!sameArray(config.Entrypoint, expected.entrypoint)) emit(codes, "ENTRYPOINT_MISMATCH", CODE_SET);
    if (!sameArray(config.Cmd, expected.command)) emit(codes, "COMMAND_MISMATCH", CODE_SET);
    compareScalar(config.User, expected.user, "USER_MISMATCH", codes);
    compareScalar(config.WorkingDir, expected.workdir, "WORKDIR_MISMATCH", codes);
    compareScalar(state.Status, expected.state.status, "STATE_STATUS_MISMATCH", codes);
    compareScalar(state.Running, expected.state.running, "STATE_RUNNING_MISMATCH", codes);
    compareScalar(state.StartedAt, expected.state.startedAt, "STATE_STARTED_AT_MISMATCH", codes);
    compareScalar(host.NetworkMode, expected.host.networkMode, "NETWORK_MODE_MISMATCH", codes);
    compareScalar(host.ReadonlyRootfs, expected.host.readOnlyRootfs, "READ_ONLY_ROOTFS_MISMATCH", codes);
    compareScalar(host.Privileged, expected.host.privileged, "PRIVILEGED_MISMATCH", codes);
    if (!(host.Devices === null || Array.isArray(host.Devices) && host.Devices.length === 0)) emit(codes, "DEVICES_MISMATCH", CODE_SET);
    compareScalar(host.Memory, expected.host.memory, "MEMORY_MISMATCH", codes);
    compareScalar(host.MemorySwap, expected.host.memorySwap, "MEMORY_SWAP_MISMATCH", codes);
    compareScalar(host.NanoCpus, expected.host.nanoCpus, "NANO_CPUS_MISMATCH", codes);
    compareScalar(host.PidsLimit, expected.host.pidsLimit, "PIDS_LIMIT_MISMATCH", codes);
    compareScalar(host.IpcMode, expected.host.ipcMode, "IPC_MODE_MISMATCH", codes);
    compareScalar(host.CgroupnsMode, expected.host.cgroupnsMode, "CGROUPNS_MODE_MISMATCH", codes);
    compareScalar(host.PidMode, expected.host.pidMode, "PID_MODE_MISMATCH", codes);
    compareScalar(host.UTSMode, expected.host.utsMode, "UTS_MODE_MISMATCH", codes);
    const cap = Array.isArray(host.CapDrop) && host.CapDrop.every((x) => typeof x === "string") ? [...new Set(host.CapDrop.map((x) => x.toUpperCase()))].sort() : null;
    if (!cap || !sameArray(cap, ["ALL"])) emit(codes, "CAP_DROP_MISMATCH", CODE_SET);
    compareSecurity(host.SecurityOpt, codes);
    compareTmpfs(host.Tmpfs, expected.host.tmpfs, codes);
    if (!["win32", "exact"].includes(expected.pathPolicy)) emit(codes, "PATH_POLICY_MALFORMED", CODE_SET);
    else compareMounts(host.Mounts, raw.Mounts, expected.mounts, expected.pathPolicy, codes, notes);
  } catch {
    emit(codes, "RAW_MALFORMED", CODE_SET);
  }
  return finish(codes, notes);
}
function finish(codes, notes) {
  const mismatchCodes = [...codes].sort(), representationNotes = [...notes].sort();
  return { match: mismatchCodes.length === 0, mismatchCodes, representationNotes };
}
function main(argv) {
  if (!Array.isArray(argv)) throw new Error("ARGUMENTS_REJECTED");
  if (argv.length === 0) return { schema: `${NAMESPACE}/offline-summary-v1`, status: "PASS", packageStatus: STATUS, executionAuthorized: false, processCalls: 0, writes: 0 };
  if (argv.length === 1 && argv[0] === RESERVED_FLAG) throw new Error("V11_NO_EXECUTION_AUTHORITY");
  throw new Error("ARGUMENTS_REJECTED");
}
if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)))}\n`); }
  catch (error) { process.stderr.write(`${JSON.stringify({ status: "FAIL", errorCode: error.message, executionAuthorized: false, processCalls: 0, writes: 0 })}\n`); process.exitCode = 1; }
}
module.exports = Object.freeze({ NAMESPACE, STATUS, RESERVED_FLAG, MISMATCH_CODES, REPRESENTATION_NOTES, compareInspect, main });
