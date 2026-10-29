#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const STEM = "polygon-robin-markets-staking-vault-v2.0.0-runtime-r2";
const EXECUTION_ID = "robin-runtime-r2-execution-0001";
const EXT4_MAGIC = 0xef53;
const NATIVE_RELATIVE = ".local/share/evm-audit/robin-runtime-r2";
const NATIVE_LAUNCHER_RELATIVE = "tools/vendor/polygon-robin-runtime-r2-launcher-linux-x64";
const NATIVE_NODE_AUTHORITY = Object.freeze({ pathContract: "<verified-passwd-home>/.local/share/evm-audit/toolchains/node/bin/node", passwdHomeRelative: ".local/share/evm-audit/toolchains/node/bin/node", uid: 1000, mode: "0700", bytes: 121158216, sha256: "53fb205ae78805130177e24bcb459a69a1518c8d98f8965f31d85aae7ea840fc", version: "v24.13.0", platform: "linux", arch: "x64", elfClass: "ELF64", elfMachine: "x86-64" });
const INVENTORY_PATHS = Object.freeze([
  "/mnt/c/_Work/__EVM_AUDIT/rpc_endpoints.txt",
  "/mnt/c/_Work/__EVM_AUDIT/graphql_endpoints.txt",
  "/mnt/c/_Work/__EVM_AUDIT/base_full_stack_endpoints.md",
  "/mnt/c/_Work/__EVM_AUDIT/hyperevm_archive_endpoints.md"
]);
const CREATE = Object.freeze({
  DURABLE_CREATED: "DURABLE_CREATED",
  TARGET_EXISTS_AUTHENTICATED: "TARGET_EXISTS_AUTHENTICATED",
  INDETERMINATE_AFTER_LINK: "INDETERMINATE_AFTER_LINK",
  FAILED_BEFORE_PUBLICATION: "FAILED_BEFORE_PUBLICATION",
  CLEANUP_OR_DIR_FSYNC_FAILURE: "CLEANUP_OR_DIR_FSYNC_FAILURE"
});
const CAPS = Object.freeze({ wallMs: 1800000, brokerMs: 30000, requestMs: 15000, fileBytes: 1048576, aggregateInventoryBytes: 4194304, chunkBytes: 65536, fileReadOps: 17, aggregateReadOps: 68,
  responseBytes: 4194304, aggregateResponseBytes: 268435456, logicalCalls: 12000, historyCallsPerFamily: 2000, outputCaptureBytes: 8388608, outputDiagnosticBytes: 131072, outputLifecycleBytes: 262144, reviewBytes: 131072 });
const QUERY_CAPS = Object.freeze({ candidates: 32, pairAttempts: 64, familyConcurrency: 1, globalConcurrency: 2, requestTimeoutMs: CAPS.requestMs, inventoryFileBytes: CAPS.fileBytes, inventoryAggregateBytes: CAPS.aggregateInventoryBytes, inventoryChunkBytes: CAPS.chunkBytes, inventoryReadOpsPerFile: CAPS.fileReadOps, inventoryReadOpsAggregate: CAPS.aggregateReadOps,
  wallMs: CAPS.wallMs, responseBytes: CAPS.responseBytes, aggregateResponseBytes: CAPS.aggregateResponseBytes, logicalCalls: CAPS.logicalCalls, historyCallsPerFamily: CAPS.historyCallsPerFamily, markets: 512, vaults: 8, upgrades: 32, roleSubjects: 128, normalizedLogs: 8192, criticalHistoricalBlocks: 1024, retries: 0, replacements: 0 });
const LIFECYCLE_PHASES = Object.freeze(["LOCK_DURABLE", "BOOTSTRAP_JOURNAL_DURABLE", "LEDGER_CONSUMING_DURABLE", "SIDECAR_A_INTENT", "SIDECAR_A_DURABLE", "LEDGER_PARTIAL_DURABLE", "SIDECAR_B_INTENT", "SIDECAR_B_DURABLE", "LEDGER_CONSUMED_DURABLE",
  "BROKER_INTENT_DURABLE", "BROKER_CAPABILITY_DURABLE", "BROKER_OPEN_SENT_DURABLE", "BROKER_EXPOSURE_DURABLE", "ARTIFACT_INTENT_DURABLE", "ARTIFACT_DURABLE", "TERMINAL_INTENT_DURABLE", "TERMINAL_DURABLE", "TERMINAL_LEDGER_DURABLE", "TERMINAL_LOCK_DURABLE"]);
const RECOVERY_PHASES = Object.freeze(["RECOVERY_OWNER_DURABLE","RECOVERY_LEASE_DURABLE","RECOVERY_CONSUMPTION_RECONCILED","ARTIFACT_INTENT_DURABLE","ARTIFACT_DURABLE","TERMINAL_INTENT_DURABLE","TERMINAL_DURABLE","TERMINAL_LEDGER_DURABLE","RECOVERY_LEASE_CLEANED","TERMINAL_LOCK_DURABLE"]);
const TERMINAL_STATUSES = Object.freeze(["ROBIN_RUNTIME_R2_PASS_EXACT_ACTIVE", "ROBIN_RUNTIME_R2_PASS_EXACT_DORMANT", "ROBIN_RUNTIME_R2_FAIL_SOURCE_OR_PACKAGE", "ROBIN_RUNTIME_R2_FAIL_APPROVAL_OR_CONSUMPTION",
  "ROBIN_RUNTIME_R2_FAIL_CURRENT_TWO_FAMILY", "ROBIN_RUNTIME_R2_FAIL_ARCHIVE_TWO_FAMILY", "ROBIN_RUNTIME_R2_FAIL_COMMON_PIN", "ROBIN_RUNTIME_R2_FAIL_FAMILY_DISAGREEMENT", "ROBIN_RUNTIME_R2_FAIL_RUNTIME_OR_METADATA",
  "ROBIN_RUNTIME_R2_FAIL_ENUMERATION_OR_DEPENDENCY", "ROBIN_RUNTIME_R2_FAIL_BROKER", "ROBIN_RUNTIME_R2_FAIL_RECOVERY", "ROBIN_RUNTIME_R2_FAIL_VALIDATION"]);
const STOP_CODES = Object.freeze([
  "AMBIGUOUS_EXT4_MOUNT", "PACKAGE_NODE_SEAL_MISMATCH", "RUNTIME_AUTHORITY_MNT_C",
  "CLEANUP_OR_DIR_FSYNC_FAILURE", "INVALID_REVIEWS", "ROOT_STATE_INVALID",
  "INDETERMINATE_AFTER_LINK", "BROKER_PREMATURE_OPEN", "BROKER_IDENTITY_UNPROVEN",
  "BROKER_FRAMING_CAP_DEADLINE_EXIT_SECRECY", "BROKER_AUTHORIZATION", "RAW_PERSISTENCE", "TERMINAL_DURABILITY_UNPROVEN", "NATIVE_NODE_AUTHORITY_MISMATCH"
]);
const ALLOWED_RPC_METHODS = Object.freeze(["eth_chainId", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getCode", "eth_getStorageAt", "eth_call", "eth_getLogs"]);
const IANA_SPECIAL_PURPOSE_SNAPSHOT = Object.freeze({ date: "2026-08-25", source: "IANA IPv4 and IPv6 Special-Purpose Address Registries", policy: "REJECT_ANY_NOT_GLOBALLY_REACHABLE_PLUS_TRANSITION_RANGES" });
const REVIEW_SCOPE = Object.freeze({ schemaVersion: "robin-runtime-r2/review-scope-v1", chain: { name: "Polygon", chainId: 137 }, target: STEM, allowedRpcMethods: ALLOWED_RPC_METHODS,
  inventoryException: { count: 4, paths: INVENTORY_PATHS, brokerOnly: true }, readOnly: true, signing: false, broadcast: false, mutation: false, funds: false,
  outputBoundary: "CANONICAL_EXT4_ONLY", oneRun: true, noRetry: true });
const STAGING_ANCESTOR_POLICY=Object.freeze({schemaVersion:"robin-runtime-r2/staging-ancestor-policy-v1",precondition:{rootMustBeAbsent:true,failedAttemptPackageStateAssumed:false},passwdHome:{existingRequired:true,directory:true,ownerUidRequired:true,symlinkAliasRejected:true,groupOtherWritableRejected:true,exactModeRequired:false},sharedAncestors:[".local",".local/share",".local/share/evm-audit"],existingSharedMode:"OWNER_CONTROLLED_NO_GROUP_OR_OTHER_WRITE",absentSharedCreationMode:"0700",missingSharedParentFsyncRequired:true,chmodExistingSharedAncestors:false,dedicatedTreeRelative:".local/share/evm-audit/robin-runtime-r2",dedicatedTreeMode:"0700",descendantDirectoryMode:"0700",fileMode:"0600",nativeLauncherMode:"0700"});
const CAPTURE_ADDRESS_POLICY=Object.freeze({schemaVersion:"robin-runtime-r2/capture-address-policy-v1",semanticValidationBeforeSanitization:true,allowlistSource:"EXACT_INDEPENDENTLY_VALIDATED_PUBLIC_ADDRESS_FIELDS_ONLY",immutableReturnedAllowlist:true,recursiveArtifactSelfAuthorization:false,exhaustivePersistedAddressPathCoverage:true,zeroAddressSentinelPaths:["evidence.topology.vaultProxy.admin","evidence.topology.vaultProxy.beacon","evidence.topology.twapProxy.admin","evidence.topology.twapProxy.beacon","evidence.current.controls.getPolymarketOnramp","evidence.current.controls.getPolymarketOfframp"],rederivedBy:["capture","validator","export"]});
const BROKER_CONTRACT = Object.freeze({ schemaVersion: "robin-runtime-r2/broker-contract-v6", message: "AUTH_NONCE_THEN_GO", paths: 4, framing: "INDEX_UINT8_LENGTH_UINT32BE_PAYLOAD_EOF",
  operationCaps: { deadlineMs: CAPS.brokerMs, maxFileBytes: CAPS.fileBytes, maxAggregateBytes: CAPS.aggregateInventoryBytes, chunkBytes: CAPS.chunkBytes, readOpsPerFile: CAPS.fileReadOps, readOpsAggregate: CAPS.aggregateReadOps },
  identity: { numericNonzeroDevIno: true, modeSizeNlinkTimestampsFiniteSafe: true, birthtimePolicy: "FINITE_OR_NULL_STABLE", nlink: 1, lstatRealpathNofollowFstatPostIdentity: true },
  authorization: { actualPpidEqualsCapabilityParent: true, parentProcStartIdentity: true, fixedVerifiedNativeRoot: true, packageNodeMountAuthority: true, consumedLedgerAndTwoSidecars: true, exclusiveOneUseCapability: true, exclusiveConsumedMarkerBeforeAck: true, capabilityPathInArgvOrEnv: false, nonceViaAnonymousStdin: true, zeroInventoryOpsBeforeAuthorization: true },
  startup: { staticNativeLauncher: true, initialLauncherCreatesSealedBundleMemfd: true, inheritedBundleChildFd:3, sameVerifiedNodeImage:true, rawCodePathReopen:false, memfdRequiredSeals: ["F_SEAL_WRITE","F_SEAL_GROW","F_SEAL_SHRINK","F_SEAL_SEAL"], clearenvBeforeDynamicCode: true, childEnvironment:["LANG=C","LC_ALL=C"], coreSoftHardZero: true, disableSigusr1: true, fixedCwd: true, structuredArgv: true }, childExit: { stdinClosedOnFailure: true, killThenConfirmedClose: true, parentPidAndStartIdentity: true },
  globalDeadline: { singleCaptureMonotonic: true, brokerBound: "MIN_30000_REMAINING", dnsRpcSameObject: true }, zeroizationClaim: false });
const THIRD_REMEDIATION = Object.freeze({ schemaVersion: "robin-runtime-r2/third-remediation-v1", stagedRecordModes: { nativeLauncher: "0700", allOtherRecords: "0600", centralValidator: "recordExpectedMode" }, ledgerRecovery: { existingSnapshotInstalledBeforeRewrite: true, terminalNeverDowngraded: true, exactPreviousHashVersionHistory: true, independentPrefixValidation: true }, recoveryAuthentication: { allExistingObjectsBeforeMutation: true, lockOnlyPrimaryReconstruction: "LOCK_DURABLE", journalMonotonicSuccessorOnly: true, malformedResidueStopsBeforeTerminal: true }, brokerAuthority: { fixedVerifiedNativeRoot: true, exactPackageNodeMount: true, parentPpidStartIdentity: true, exclusiveConsumedClaimBeforeAck: true, concurrentWinnerCount: 1 }, sanitizer: { callerValidatedShortcut: false, exactCurrentStateAddressSchema: true, returnsAllowedAddressSet: true }, scriptToctou: { launcherActionScriptFd: 3, brokerScriptFd: 3, sameAuthenticatedDescriptorExecuted: true }, productionV9fsCapabilityRequired: true });
const FOURTH_REMEDIATION = Object.freeze({ schemaVersion:"robin-runtime-r2/fourth-remediation-v1", capabilitySeal:{rootField:"nativeRoot",productionSanitizerPath:true}, ledger:{schemaVersion:"robin-runtime-r2/consumption-ledger-v4",immutableHistoryDirectory:"lifecycle/ledger-history",maxVersions:32,version1Previous:null,currentEqualsLatest:true,terminalBindsPreterminalAndTerminal:true}, recovery:{authenticateCompletePrefixBeforeMutation:true,exactResidueIntent:true}, broker:{mountBeforeAuthorityRead:true,launcherAction:"broker",sealedMemfd:true}, launcher:{memfdChildFd:3,requiredSeals:["F_SEAL_WRITE","F_SEAL_GROW","F_SEAL_SHRINK","F_SEAL_SEAL"],hashSnapshotDescriptor:true} });
const FIFTH_REMEDIATION = Object.freeze({schemaVersion:"robin-runtime-r2/fifth-remediation-v1",bundle:{schemaVersion:"robin-runtime-r2/action-bundle-authority-v1",resolver:"INTERNAL_REGISTRY_ONLY_R2_PREFIX",allLocalModules:true,noExternalDependency:true,rawSourcesNeverExecuted:true},broker:{sameVerifiedNodeImage:true,inheritedSealedBundleFd:3,localCodeReopen:false},recovery:{phaseAllowlist:RECOVERY_PHASES,strictOrder:true,sidecarLedgerReviewBindingBeforeMutation:true,artifactFullSemanticBeforeMutation:true,tempTargetFullValidation:true}});
const SIXTH_REMEDIATION=Object.freeze({schemaVersion:"robin-runtime-r2/sixth-remediation-v1",reviewLookup:{module:"polygon-robin-runtime-r2-review",signature:"readPair(root,{fixed,uid,nowMs,requireFresh})"},durablePrefixes:{sidecarBeforeLedgerExact:true,brokerClaimBeforeCapabilityConsumedExact:true,exposureNeverDowngrades:true},recoveryOwner:{path:"lifecycle/recovery-owner.claim",exclusiveCreate:true,acquiredBeforeMutation:true,preexistingStaleStop:true,concurrentWinners:1},successors:{centralPureDerivation:true,exactCanonicalBytes:true,authenticateAfterEachInstall:true}});
const SECURE_READ_OPERATIONS = Object.freeze({ lstat: (file) => fsp.lstat(file, { bigint: true }), realpath: fsp.realpath, open: async (...args) => { const handle = await fsp.open(...args); return { stat: () => handle.stat({ bigint: true }), read: (...x) => handle.read(...x), close: () => handle.close() }; } });
const CAPABILITY_KEYS = Object.freeze(["schemaVersion", "claimId", "status", "nativeRoot", "rootAuthority", "node", "nativeLauncher", "packageManifestSha256", "packageAggregateSha256", "stagingSealSha256", "durability", "v9fsFixture", "brokerFixture", "runtimeAuthorityOnExt4Only", "stopCodes"]);
function recordExpectedMode(relative) { safeRelative(relative); return relative === NATIVE_LAUNCHER_RELATIVE ? 0o700 : 0o600; }
function readStagedRecord(file, row, options = {}) { if (!row || !Number.isSafeInteger(row.bytes) || row.bytes < 1) fail("PACKAGE_NODE_SEAL_MISMATCH"); return secureRead(file, { ...options, cap: row.bytes, mode: recordExpectedMode(row.path || row.stagedLogicalPath) }); }

class R2Error extends Error {
  constructor(code) { super(code); this.name = "R2Error"; this.code = code; }
}
function fail(code) { throw new R2Error(code); }
function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") { if (!Number.isSafeInteger(value)) fail("CANONICAL_NUMBER"); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!value || typeof value !== "object") fail("CANONICAL_VALUE");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && canonical(Object.keys(value).sort()) === canonical([...keys].sort());
}
function parseJson(bytes, cap = 1024 * 1024) {
  const data = Buffer.from(bytes); if (data.length < 2 || data.length > cap) fail("JSON_SIZE");
  try { return JSON.parse(data); } catch (_) { fail("JSON_INVALID"); }
}
function parseCanonicalJson(bytes, cap = 1024 * 1024) { const data = Buffer.from(bytes), value = parseJson(data, cap), expected = Buffer.from(`${canonical(value)}\n`); if (!data.equals(expected)) fail("JSON_NONCANONICAL"); return value; }
function safeRelative(value) {
  if (typeof value !== "string" || value.includes("\\") || path.posix.isAbsolute(value)
    || value.split("/").some((part) => !part || part === "." || part === "..")) fail("PATH_INVALID");
  return value;
}
function verifiedUser(options = {}) {
  if (process.platform !== "linux" && !options.allowSynthetic) fail("LINUX_REQUIRED");
  const info = options.userInfo || os.userInfo(), passwd = String(options.passwd === undefined ? fs.readFileSync("/etc/passwd", "utf8") : options.passwd);
  if (!Number.isSafeInteger(info.uid) || info.uid < 0 || !path.posix.isAbsolute(info.homedir)) fail("USERINFO_INVALID");
  const rows = passwd.split(/\r?\n/).filter(Boolean).map((line) => line.split(":"));
  const row = rows.find((parts) => parts.length >= 7 && Number(parts[2]) === info.uid && parts[0] === info.username);
  if (!row || Number(row[3]) !== info.gid || path.posix.normalize(row[5]) !== path.posix.normalize(info.homedir) || /\s/.test(row[5])) fail("PASSWD_USERINFO_MISMATCH");
  return Object.freeze({ uid: info.uid, gid: info.gid, username: info.username, home: path.posix.normalize(row[5]), root: path.posix.join(path.posix.normalize(row[5]), NATIVE_RELATIVE) });
}
function decodeMount(value) { return value.replace(/\\(040|011|012|134)/g, (_m, code) => ({ "040": " ", "011": "\t", "012": "\n", "134": "\\" })[code]); }
function parseMountInfo(text) {
  const rows = [];
  for (const line of String(text).split("\n")) {
    if (!line) continue; const fields = line.split(" "), dash = fields.indexOf("-");
    if (dash < 6 || fields.length < dash + 3 || !/^\d+$/.test(fields[0])) fail("MOUNTINFO_INVALID");
    rows.push(Object.freeze({ mountId: Number(fields[0]), parentId: Number(fields[1]), dev: fields[2], root: decodeMount(fields[3]), mountPoint: decodeMount(fields[4]), options: fields[5].split(","), fsType: fields[dash + 1], source: decodeMount(fields[dash + 2]) }));
  }
  return rows;
}
function mountFor(target, rows) {
  const resolved = path.posix.resolve(target), matches = rows.filter((row) => resolved === row.mountPoint || resolved.startsWith(`${row.mountPoint.replace(/\/$/, "")}/`));
  matches.sort((a, b) => b.mountPoint.length - a.mountPoint.length);
  if (!matches.length || matches.length > 1 && matches[0].mountPoint.length === matches[1].mountPoint.length) fail("AMBIGUOUS_EXT4_MOUNT");
  return matches[0];
}
function assertNativeMount(root, testDir, options = {}) {
  const statfs = options.statfs || ((file) => fs.statfsSync(file, { bigint: true })), stat = options.stat || ((file) => fs.statSync(file, { bigint: true }));
  const rows = parseMountInfo(options.mountInfo === undefined ? fs.readFileSync("/proc/self/mountinfo", "utf8") : options.mountInfo), a = mountFor(root, rows), b = mountFor(testDir, rows), sa = stat(root), sb = stat(testDir), fa = statfs(root), fb = statfs(testDir);
  const typeA = Number(fa.type), typeB = Number(fb.type), forbidden = /^(?:9p|v9fs|drvfs|overlay|fuse(?:\..*)?|tmpfs|nfs\d*|cifs|smb\d*)$/i;
  if (typeA !== EXT4_MAGIC || typeB !== EXT4_MAGIC || a.fsType !== "ext4" || b.fsType !== "ext4" || forbidden.test(a.fsType) || forbidden.test(b.fsType)
    || a.mountId !== b.mountId || String(sa.dev) !== String(sb.dev)) fail("AMBIGUOUS_EXT4_MOUNT");
  return Object.freeze({ filesystem: "ext4", statfsMagic: "0xEF53", mountId: a.mountId, stDev: String(sa.dev), mountPoint: a.mountPoint });
}
function assertRuntimeMount(root, lifecycle, nodePath, uid, options = {}) {
  if (uid === 0) fail("ROOT_STATE_INVALID"); const mountInfo = options.mountInfo === undefined ? fs.readFileSync("/proc/self/mountinfo", "utf8") : options.mountInfo, rows = parseMountInfo(mountInfo), stat = options.stat || ((file) => fs.statSync(file, { bigint: true })), statfs = options.statfs || ((file) => fs.statfsSync(file, { bigint: true }));
  const targets = [root, lifecycle, nodePath, ...(options.launcherPath ? [options.launcherPath] : [])], mounts = targets.map((target) => mountFor(target, rows)), stats = targets.map(stat), filesystems = targets.map(statfs), first = mounts[0], dev = String(stats[0].dev);
  if (mounts.some((row) => row.fsType !== "ext4" || row.mountId !== first.mountId) || stats.some((row) => String(row.dev) !== dev) || filesystems.some((row) => Number(row.type) !== EXT4_MAGIC)) fail("AMBIGUOUS_EXT4_MOUNT");
  const mode = (row) => Number(row.mode) & 0o777; if (!stats[0].isDirectory() || !stats[1].isDirectory() || Number(stats[0].uid) !== uid || Number(stats[1].uid) !== uid || mode(stats[0]) !== 0o700 || mode(stats[1]) !== 0o700 || !stats[2].isFile() || Number(stats[2].uid) !== uid || mode(stats[2]) !== 0o700 || Number(stats[2].nlink) !== 1 || options.launcherPath && (!stats[3].isFile() || Number(stats[3].uid) !== uid || mode(stats[3]) !== 0o700 || Number(stats[3].nlink) !== 1)) fail("ROOT_STATE_INVALID"); assertPathComponents(nodePath, uid, { base: options.home, lstat: options.lstat, finalFile: true }); if (options.launcherPath) assertPathComponents(options.launcherPath,uid,{base:options.home,lstat:options.lstat,finalFile:true}); return { filesystem: "ext4", mountId: first.mountId, stDev: dev, statfsMagic: "0xEF53" };
}
function assertPathComponents(target, uid, options = {}) {
  const lstat = options.lstat || fs.lstatSync, resolved = path.posix.resolve(target), base = path.posix.resolve(options.base || resolved);
  if (resolved !== base && !resolved.startsWith(`${base}/`)) fail("ROOT_STATE_INVALID"); const parts = path.posix.relative(base, resolved).split("/").filter(Boolean); let current = base;
  const baseRow = lstat(current, { bigint: true }); if (baseRow.isSymbolicLink() || !baseRow.isDirectory() || Number(baseRow.uid) !== uid) fail("ROOT_STATE_INVALID");
  for (let i = 0; i < parts.length; i += 1) { current = path.posix.join(current, parts[i]); const row = lstat(current, { bigint: true }), finalFile = options.finalFile && i === parts.length - 1; if (row.isSymbolicLink() || (finalFile ? !row.isFile() : !row.isDirectory())) fail("ROOT_STATE_INVALID"); if (Number(row.uid) !== uid) fail("ROOT_STATE_INVALID"); }
  return true;
}
async function secureRead(file, options = {}) {
  const operations = options.operations || SECURE_READ_OPERATIONS, cap = options.cap || CAPS.outputCaptureBytes, uid = options.uid, expectedMode = options.mode === undefined ? 0o600 : options.mode, expectedNlink = options.nlink === undefined ? 1 : options.nlink, unavailableNoFollow = fs.constants.O_NOFOLLOW === undefined && options.allowNoFollowUnavailable === true, noFollow = options.noFollow ?? fs.constants.O_NOFOLLOW ?? 0;
  if ((!unavailableNoFollow && (typeof noFollow !== "number" || noFollow === 0)) || unavailableNoFollow && process.platform !== "win32") fail("SECURE_READ_IDENTITY"); const beforeStat = await operations.lstat(file), real = await operations.realpath(file), identity = (row) => { const positiveIdentity = (value) => typeof value === "bigint" ? value > 0n : Number.isSafeInteger(value) && value > 0, size = Number(row?.size), mode = Number(row?.mode); if (!positiveIdentity(row?.dev) || !positiveIdentity(row?.ino)) fail("SECURE_READ_IDENTITY"); const dev = row.dev, ino = row.ino;
    if (!row.isFile() || row.isSymbolicLink?.() || !Number.isSafeInteger(mode) || !Number.isSafeInteger(size) || size < 0 || size > cap || !Number.isSafeInteger(expectedNlink) || expectedNlink < 1 || Number(row.nlink) !== expectedNlink
      || uid !== undefined && Number(row.uid) !== uid || expectedMode !== null && (mode & 0o777) !== expectedMode) fail("SECURE_READ_IDENTITY"); return { dev: String(dev), ino: String(ino), mode, size, nlink: Number(row.nlink), uid: Number.isFinite(Number(row.uid)) ? Number(row.uid) : null, mtimeMs: Number.isFinite(Number(row.mtimeMs)) ? String(row.mtimeMs) : null, ctimeMs: Number.isFinite(Number(row.ctimeMs)) ? String(row.ctimeMs) : null, birthtimeMs: Number.isFinite(Number(row.birthtimeMs)) ? String(row.birthtimeMs) : null }; };
  const before = identity(beforeStat); if (path.resolve(real) !== path.resolve(file)) fail("SECURE_READ_IDENTITY"); const handle = await operations.open(file, fs.constants.O_RDONLY | noFollow); try { const opened = identity(await handle.stat()); if (canonical(opened) !== canonical(before)) fail("SECURE_READ_IDENTITY"); const buffer = Buffer.alloc(before.size); let at = 0, ops = 0;
    while (at < buffer.length) { if (++ops > Math.ceil(cap / CAPS.chunkBytes) + 1) fail("SECURE_READ_IDENTITY"); const row = await handle.read(buffer, at, Math.min(CAPS.chunkBytes, buffer.length - at), at); if (!row?.bytesRead) fail("SECURE_READ_IDENTITY"); at += row.bytesRead; }
    const eof = Buffer.alloc(1), end = await handle.read(eof, 0, 1, at); if (end.bytesRead !== 0) fail("SECURE_READ_IDENTITY"); const after = identity(await operations.lstat(file)), afterReal = await operations.realpath(file); if (path.resolve(afterReal) !== path.resolve(file) || canonical(after) !== canonical(before)) fail("SECURE_READ_IDENTITY"); return Object.freeze({ bytes: buffer, identity: before });
  } finally { await handle.close().catch(() => {}); }
}
async function syncDirectory(file, operations = fsp) { const handle = await operations.open(path.dirname(file), "r"); try { await handle.sync(); } catch (error) { if (process.platform !== "win32" || !["EINVAL", "ENOTSUP", "EBADF", "EPERM"].includes(error?.code)) throw error; } finally { await handle.close(); } }
async function durableCreate(target, bytes, options = {}) {
  const operations = options.operations || fsp, payload = Buffer.from(bytes), parentSync = options.syncDirectory || ((file) => syncDirectory(file, operations));
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${options.token || crypto.randomBytes(12).toString("hex")}.r2tmp`);
  let handle = null, linked = false, targetAbsent = false;
  try {
    await options.fault?.("BEFORE_TARGET_LSTAT"); try { await operations.lstat(target); await options.fault?.("AFTER_TARGET_LSTAT_EXISTS"); return options.authenticateExisting && await options.authenticateExisting(target, payload) ? { status: CREATE.TARGET_EXISTS_AUTHENTICATED } : { status: CREATE.CLEANUP_OR_DIR_FSYNC_FAILURE }; }
    catch (error) { if (error?.code !== "ENOENT") return { status: CREATE.CLEANUP_OR_DIR_FSYNC_FAILURE }; targetAbsent = true; }
    await options.fault?.("BEFORE_TEMP_OPEN"); handle = await operations.open(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    await options.fault?.("AFTER_TEMP_OPEN"); await handle.writeFile(payload); await options.fault?.("AFTER_WRITE"); await handle.sync(); await options.fault?.("AFTER_FILE_FSYNC"); await handle.close(); handle = null;
    await options.fault?.("BEFORE_LINK"); await operations.link(temp, target); linked = true; await options.fault?.("AFTER_LINK");
    await options.fault?.("BEFORE_READBACK"); const readback = await operations.readFile(target); if (!readback.equals(payload)) throw new Error("READBACK"); await options.fault?.("AFTER_READBACK");
    await options.fault?.("BEFORE_TARGET_DIR_FSYNC"); await parentSync(target); await options.fault?.("AFTER_TARGET_DIR_FSYNC"); await options.fault?.("BEFORE_TEMP_UNLINK"); await operations.unlink(temp); await options.fault?.("AFTER_TEMP_UNLINK"); await options.fault?.("BEFORE_CLEANUP_DIR_FSYNC"); await parentSync(target); await options.fault?.("AFTER_CLEANUP_DIR_FSYNC");
    try { await operations.lstat(temp); throw new Error("TEMP_RESIDUE"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    return { status: CREATE.DURABLE_CREATED };
  } catch (cause) {
    if (cause?.code === "PROCESS_CRASH") throw cause;
    try { if (handle) await handle.close(); } catch (_) { /* static status only */ }
    if (!linked) { try { await operations.unlink(temp); } catch (error) { if (error?.code !== "ENOENT") return { status: CREATE.CLEANUP_OR_DIR_FSYNC_FAILURE }; } try { await parentSync(target); try { await operations.lstat(temp); return { status: CREATE.CLEANUP_OR_DIR_FSYNC_FAILURE }; } catch (error) { if (error?.code !== "ENOENT") return { status: CREATE.CLEANUP_OR_DIR_FSYNC_FAILURE }; } } catch (_) { return { status: CREATE.CLEANUP_OR_DIR_FSYNC_FAILURE }; } return { status: CREATE.FAILED_BEFORE_PUBLICATION }; }
    return { status: CREATE.INDETERMINATE_AFTER_LINK, targetPublishedByCurrentOperation: targetAbsent };
  }
}
async function durableReplace(target, bytes, options = {}) { const operations = options.operations || fsp, payload = Buffer.from(bytes), parentSync = options.syncDirectory || ((file) => syncDirectory(file, operations)), temp = path.join(path.dirname(target), `.${path.basename(target)}.${options.token || crypto.randomBytes(12).toString("hex")}.r2next`); let handle, renamed = false;
  try { await options.fault?.("BEFORE_TEMP_OPEN"); handle = await operations.open(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600); await options.fault?.("AFTER_TEMP_OPEN"); await handle.writeFile(payload); await options.fault?.("AFTER_WRITE"); await handle.sync(); await options.fault?.("AFTER_FILE_FSYNC"); await handle.close(); handle = null; await options.fault?.("BEFORE_RENAME"); await operations.rename(temp, target); renamed = true; await options.fault?.("AFTER_RENAME"); await options.fault?.("BEFORE_TARGET_DIR_FSYNC"); await parentSync(target); await options.fault?.("AFTER_TARGET_DIR_FSYNC"); await options.fault?.("BEFORE_READBACK"); const readback = await operations.readFile(target); if (!Buffer.from(readback).equals(payload)) throw new Error("READBACK"); await options.fault?.("AFTER_READBACK"); return { status: CREATE.DURABLE_CREATED }; }
  catch (cause) { if (cause?.code === "PROCESS_CRASH") throw cause; if (handle) await handle.close().catch(() => {}); if (renamed) return { status: CREATE.INDETERMINATE_AFTER_LINK, targetPublishedByCurrentOperation: true }; try { await operations.unlink(temp); } catch (error) { if (error?.code !== "ENOENT") return { status: CREATE.CLEANUP_OR_DIR_FSYNC_FAILURE }; } try { await parentSync(target); try { await operations.lstat(temp); return { status: CREATE.CLEANUP_OR_DIR_FSYNC_FAILURE }; } catch (error) { if (error?.code !== "ENOENT") return { status: CREATE.CLEANUP_OR_DIR_FSYNC_FAILURE }; } return { status: CREATE.FAILED_BEFORE_PUBLICATION }; } catch (_) { return { status: CREATE.CLEANUP_OR_DIR_FSYNC_FAILURE }; } }
}
async function v9fsCreate(target, bytes, options = {}) { const operations = options.operations || fsp, payload = Buffer.from(bytes); let handle; try { handle = await operations.open(target, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600); await handle.writeFile(payload); await handle.sync(); await handle.close(); handle = null; const readback = await operations.readFile(target); if (!Buffer.from(readback).equals(payload)) fail("V9FS_READBACK"); return { status: CREATE.DURABLE_CREATED, parentDurabilityClaim: false }; }
  catch (error) { if (handle) await handle.close().catch(() => {}); if (error?.code === "EEXIST" && options.authenticateExisting && await options.authenticateExisting(target, payload)) return { status: CREATE.TARGET_EXISTS_AUTHENTICATED, parentDurabilityClaim: false }; fail("V9FS_PUBLICATION_FAILED"); } }
function requireDurable(result) { if (result?.status !== CREATE.DURABLE_CREATED && result?.status !== CREATE.TARGET_EXISTS_AUTHENTICATED) fail(result?.status === CREATE.INDETERMINATE_AFTER_LINK ? "INDETERMINATE_AFTER_LINK" : result?.status === CREATE.CLEANUP_OR_DIR_FSYNC_FAILURE ? "CLEANUP_OR_DIR_FSYNC_FAILURE" : "TERMINAL_DURABILITY_UNPROVEN"); return result; }
function nodeAuthority(execPath = process.execPath, reader = fs.readFileSync) {
  const absolute = path.posix.resolve(execPath); if (!path.posix.isAbsolute(absolute) || absolute.startsWith("/mnt/c/")) fail("PACKAGE_NODE_SEAL_MISMATCH");
  return Object.freeze({ processExecPath: absolute, sha256: sha256(reader(absolute)), version: process.version, platform: process.platform, arch: process.arch });
}
function processIdentity(pid = process.pid, options = {}) { if (!Number.isSafeInteger(pid) || pid <= 0) fail("ROOT_STATE_INVALID"); const reader = options.readFile || fs.readFileSync, stat = String(reader(`/proc/${pid}/stat`, "utf8")), close = stat.lastIndexOf(")"); if (close < 2) fail("ROOT_STATE_INVALID"); const fields = stat.slice(close + 2).trim().split(/\s+/), startTicks = fields[19], bootId = String(reader("/proc/sys/kernel/random/boot_id", "utf8")).trim(); if (!/^\d+$/.test(startTicks || "") || !/^[0-9a-f-]{36}$/.test(bootId)) fail("ROOT_STATE_INVALID"); return Object.freeze({ pid, startTicks, bootId }); }
function processIdentityAlive(identity, options = {}) { try { return canonical(processIdentity(identity.pid, options)) === canonical(identity); } catch (_) { return false; } }
function assertCleanStartup(options = {}) { const env = options.env || process.env, keys = Object.keys(env).sort(); if (canonical(keys) !== canonical(["LANG", "LC_ALL"]) || env.LANG !== "C" || env.LC_ALL !== "C") fail("STARTUP_CONTRACT");
  if (!(options.execArgv || process.execArgv).includes("--disable-sigusr1")) fail("STARTUP_CONTRACT"); const limits = String((options.readFile || fs.readFileSync)("/proc/self/limits", "utf8")), row = limits.split("\n").find((line) => /^Max core file size\s/.test(line)); if (!row || !/^Max core file size\s+0\s+0\s/.test(row)) fail("STARTUP_CONTRACT"); return true; }
function commands(root, executionId = EXECUTION_ID) {
  if (!path.posix.isAbsolute(root) || !/^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$/.test(executionId)) fail("COMMAND_INVALID");
  const launcher = path.posix.join(root, NATIVE_LAUNCHER_RELATIVE);
  return Object.freeze({ launcher, primary: `${launcher} capture ${executionId}`, recovery: `${launcher} recover ${executionId}`, validate: `${launcher} validate`, export: `${launcher} export`, capability: `${launcher} capability`, review: `${launcher} review` });
}
class RuntimeDeadline { constructor(options = {}) { this.now = options.now || performance.now; this.started = this.now(); this.deadlineAt = this.started + (options.wallMs || CAPS.wallMs); this.controllers = new Set(); }
  remaining() { return Math.max(0, this.deadlineAt - this.now()); }
  async run(factory, perMs = CAPS.requestMs) { const ms = Math.min(perMs, this.remaining()); if (ms <= 0) fail("GLOBAL_DEADLINE"); let timer, cancel; try { let operation = factory(); if (operation?.promise) { cancel = operation.cancel; operation = operation.promise; }
      const result = await Promise.race([Promise.resolve(operation), new Promise((_, reject) => { timer = setTimeout(() => { cancel?.(); reject(new R2Error("GLOBAL_DEADLINE")); }, ms); timer.unref?.(); })]); if (this.remaining() <= 0) { cancel?.(); fail("GLOBAL_DEADLINE"); } return result; } finally { clearTimeout(timer); } }
  close() { this.controllers.clear(); }
}
function scanSanitized(value, options = {}) {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : canonical(value);
  if (/(?:https?|wss?):\/\/|authorization|bearer\s|api[_-]?key|private[_-]?key|seed phrase|endpoint|hostname|familykey|resolved|rpc envelope|raw log|raw error|"calldata"\s*:|"selector"\s*:|return(?:ed)?payload|responsebody|provider(?:id|name|identity)/i.test(text)
    || /\b(?:alchemy|quicknode|quiknode|infura|blastapi|ankr|chainstack|drpc)\b/i.test(text) || /\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(text)
    || /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|co|uk|pro|dev|cloud|app|xyz)\b/i.test(text)) fail("RAW_PERSISTENCE");
  if (options.allowedAddresses) { const allowed = new Set([...options.allowedAddresses].map((x) => String(x).toLowerCase())); for (const match of text.matchAll(/0x[0-9a-f]{40}\b/gi)) if (!allowed.has(match[0].toLowerCase())) fail("RAW_PERSISTENCE"); }
  return true;
}
function validateCapabilitySeal(seal, expected) {
  const durability = { exclusiveCreate: true, fileFsync: true, hardlinkReadback: true, targetParentFsync: true, renameParentFsync: true, unlinkParentFsync: true, cleanupAbsence: true, injectedAfterLinkStatus: CREATE.INDETERMINATE_AFTER_LINK };
  const fixture = { exactPathNofollow: true, symlinkRejected: true, aliasRejected: true, hardlinkRejected: true, preOpenPostIdentity: true, cleaned: true, parentDurabilityClaim: false };
  const brokerFixture = { status: "PASS_DISPOSABLE_FOUR_FILES", files: 4, normalRead: true, eofProven: true, symlinkRejected: true, hardlinkRejected: true, aliasRejected: true, identityDriftRejected: true, fileCapRejected: true, aggregateCapRejected: true, deadlineRejected: true, actualInventoriesOpened: false, cleaned: true, parentDurabilityClaim: false };
  if (!exactKeys(seal, CAPABILITY_KEYS) || seal.schemaVersion !== "robin-runtime-r2/capability-seal-v4" || seal.claimId !== STEM || seal.status !== (expected.synthetic === true ? "SYNTHETIC_BRANCH_COVERAGE_STOP_PRODUCTION_V9FS_REQUIRED" : "PASS_EXT4_V9FS_BROKER_FIXTURE")
    || seal.nativeRoot !== expected.root || seal.packageManifestSha256 !== expected.packageManifestSha256 || seal.packageAggregateSha256 !== expected.packageAggregateSha256 || seal.stagingSealSha256 !== expected.stagingSealSha256
    || canonical(seal.node) !== canonical(expected.node) || canonical(seal.nativeLauncher) !== canonical(expected.nativeLauncher) || canonical(seal.durability) !== canonical(durability)
    || canonical(seal.v9fsFixture) !== canonical(fixture) || canonical(seal.brokerFixture) !== canonical(brokerFixture)
    || seal.runtimeAuthorityOnExt4Only !== true || canonical(seal.stopCodes) !== canonical(STOP_CODES) || !exactKeys(seal.rootAuthority, ["uid", "gid", "mode", "mountId", "stDev", "filesystem", "statfsMagic"]) || canonical(seal.rootAuthority) !== canonical(expected.rootAuthority)) fail("PACKAGE_NODE_SEAL_MISMATCH");
  return true;
}
function scanCapabilitySeal(seal, expected) { validateCapabilitySeal(seal,expected); const local = { ...seal }; delete local.stopCodes; scanSanitized(local); return true; }
function validateStagingSeal(seal, expected) { const keys = ["schemaVersion", "claimId", "status", "nativeRoot", "verifiedUser", "packageManifestSha256", "packageAggregateSha256", "node", "records", "recordAggregateSha256", "nativeLauncher", "modes","ancestorPolicy", "runtimeAuthorityOnExt4OnlyCandidate", "inventoryException"];
  if (!exactKeys(seal, keys) || seal.schemaVersion !== "robin-runtime-r2/staging-seal-v4" || seal.claimId !== STEM || seal.status !== "NATIVE_CANDIDATE_PENDING_EXT4_CAPABILITY" || seal.nativeRoot !== expected.root || seal.packageManifestSha256 !== expected.packageManifestSha256 || seal.packageAggregateSha256 !== expected.packageAggregateSha256
    || !exactKeys(seal.verifiedUser, ["uid", "gid", "home"]) || canonical(seal.verifiedUser) !== canonical(expected.verifiedUser) || canonical(seal.node) !== canonical(expected.node) || !Array.isArray(seal.records) || canonical(seal.records) !== canonical(expected.records) || seal.records.some((row) => !exactKeys(row, ["originLogicalPath", "stagedLogicalPath", "bytes", "sha256", "mode"]) || row.originLogicalPath !== row.stagedLogicalPath || row.mode !== (recordExpectedMode(row.stagedLogicalPath) === 0o700 ? "0700" : "0600") || !Number.isSafeInteger(row.bytes) || row.bytes < 1 || !/^[0-9a-f]{64}$/.test(row.sha256)) || seal.recordAggregateSha256 !== sha256(Buffer.from(canonical(seal.records))) || canonical(seal.nativeLauncher) !== canonical(expected.nativeLauncher) || canonical(seal.modes) !== canonical({ umask:"077",sharedAncestors:"OWNER_CONTROLLED_NO_GROUP_OR_OTHER_WRITE",dedicatedDirectories:"0700",files:"0600",nativeLauncher:"0700" }) || canonical(seal.ancestorPolicy)!==canonical(STAGING_ANCESTOR_POLICY) || seal.runtimeAuthorityOnExt4OnlyCandidate !== true || seal.inventoryException !== "BROKER_EXACT_FOUR_COMPILED_PATHS_ONLY") fail("PACKAGE_NODE_SEAL_MISMATCH"); return true; }

module.exports = { STEM, EXECUTION_ID, EXT4_MAGIC, NATIVE_RELATIVE, NATIVE_LAUNCHER_RELATIVE, NATIVE_NODE_AUTHORITY, INVENTORY_PATHS, CREATE, CAPS, QUERY_CAPS, LIFECYCLE_PHASES, RECOVERY_PHASES, TERMINAL_STATUSES, STOP_CODES, ALLOWED_RPC_METHODS, IANA_SPECIAL_PURPOSE_SNAPSHOT, REVIEW_SCOPE, STAGING_ANCESTOR_POLICY,CAPTURE_ADDRESS_POLICY,BROKER_CONTRACT, THIRD_REMEDIATION, FOURTH_REMEDIATION, FIFTH_REMEDIATION, SIXTH_REMEDIATION, CAPABILITY_KEYS, SECURE_READ_OPERATIONS, R2Error, fail, sha256, canonical, exactKeys, parseJson, parseCanonicalJson, safeRelative, recordExpectedMode, readStagedRecord,
  verifiedUser, decodeMount, parseMountInfo, mountFor, assertNativeMount, assertRuntimeMount, assertPathComponents, secureRead, syncDirectory, durableCreate, durableReplace, v9fsCreate, requireDurable, nodeAuthority, processIdentity, processIdentityAlive, assertCleanStartup, commands, RuntimeDeadline, scanSanitized, scanCapabilitySeal, validateCapabilitySeal, validateStagingSeal };
