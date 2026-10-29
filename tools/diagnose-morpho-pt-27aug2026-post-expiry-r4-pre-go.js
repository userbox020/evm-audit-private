#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { POLICY, POLICY_HASH, canonical } = require("./morpho-pt-27aug2026-post-expiry-r2-production-policy.js");

const SCHEMA = "morpho-pt-27aug2026-post-expiry-r4-pre-go-diagnostic/v2";
const ROOT = path.join(__dirname, "..");
const RUNTIME = path.join(ROOT, ".runtime", "morpho-pt-post-expiry-r3-production");
const TEMP_PARENT = path.join(os.tmpdir(), "opencode");
const WSL = "C:\\Windows\\System32\\wsl.exe";
const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const CONTAINED_HELPER = path.join(__dirname, "run-morpho-pt-27aug2026-post-expiry-r4-contained-child-win32.ps1");
const PHASE_KEYS = Object.freeze(Array.from({ length: 10 }, (_, index) => `P${String(index + 1).padStart(2, "0")}`));
const EXPECTED = Object.freeze({
  conductor: "9719c2951f0e51374cb958f3732d429646d20908dbe46c89a84b8449d26082d8",
  r3Manifest: "36b9a235198d02603653ef25c14e1b101d67a76376846eb071c3175b75a72c41",
  permitScript: "9f221240a8100540bc71028b5a88f496713e693cf2e5b6cd083c88d6b7b0972a",
  supervisor: "d6e09832bf9e01ac7539472fa22ab22bbfc8a54cfd85f432ce20c4467494fa7e",
  launcher: "6d8e7651d21f223e60de3dfbef101f00ff60d3d7f78fe0ef290fdca0e6d3c645",
  node: "53fb205ae78805130177e24bcb459a69a1518c8d98f8965f31d85aae7ea840fc",
  wsl: "4e589e3883229b7a74a4acdb878689dcec94e2539fcad1c194f415b149c337a9",
  powershell: "9785001b0dcf755eddb8af294a373c0b87b2498660f724e76c4d53f9c217c7a3",
  containedHelper: "88b318ef928aa11a6c51f52efff975f7544ed25a6e24a82978833be5a6bda952",
});
const PRODUCTION_FILES = Object.freeze({
  policy: "tools/morpho-pt-27aug2026-post-expiry-r2-production-policy.js",
  adapter: "tools/lib/morpho-pt-27aug2026-post-expiry-r2-production-adapter.js",
  capture: "tools/capture-morpho-pt-27aug2026-post-expiry-r2-production.js",
  validator: "tools/validate-morpho-pt-27aug2026-post-expiry-r2-production.js",
  test: "tools/test-morpho-pt-27aug2026-post-expiry-r2-production.js",
  nativeSupervisorSource: "tools/native/morpho-pt-post-expiry-r2-supervisor-broker-win32.c",
  nativeSupervisorSourceCandidate: "tools/native/morpho-pt-post-expiry-r2-supervisor-broker-win32.exe",
  nativeBuildManifest: "tools/native/morpho-pt-post-expiry-r2-native-build-manifest.json",
  launcherSource: "tools/native/morpho-pt-post-expiry-r2-launcher-linux.c",
  launcherBinary: "tools/native/morpho-pt-post-expiry-r2-launcher-linux",
});
const OFFLINE_FILES = Object.freeze({
  profile: "tools/morpho-pt-27aug2026-post-expiry-r1-profile.js",
  engine: "tools/lib/morpho-pt-27aug2026-post-expiry-r2-gate.js",
  validator: "tools/validate-morpho-pt-27aug2026-post-expiry-r2.js",
  test: "tools/test-morpho-pt-27aug2026-post-expiry-r2.js",
  disabledCapture: "tools/capture-morpho-pt-27aug2026-post-expiry-r2.js",
  sharedGate: "tools/lib/r1-evm-read-gate.js",
  inventoryParser: "tools/preflight-all-chain-endpoints-v4.js",
});
const ZERO_SAFETY = Object.freeze({
  captureExecutions: 0, issuerExecutions: 0, conductorExecutions: 0,
  productionNodeDiagnosticExecutions: 0, productionPermitReads: 0,
  inventoryReads: 0, networkRequests: 0, nonceMutations: 0, productionMutations: 0,
  syntheticMutationOperations: 0, syntheticCleanupOperations: 0,
  wslChildExecutions: 0, powershellChildExecutions: 0,
  containedChildExecutions: 0, childTreeCleanupConfirmations: 0,
});

function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function exactKeys(value, keys) { return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0"); }
function isReparse(stat) { return typeof stat.isReparsePoint === "function" && stat.isReparsePoint(); }
function regular(file, expected, oneLink = true) {
  const stat = fs.lstatSync(file), real = fs.realpathSync.native(file);
  return stat.isFile() && !stat.isSymbolicLink() && !isReparse(stat) && (!oneLink || stat.nlink === 1) && path.resolve(real).toLowerCase() === path.resolve(file).toLowerCase() && sha256(fs.readFileSync(file)) === expected;
}
function under(root, target) { const relative = path.relative(path.resolve(root), path.resolve(target)); return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative); }
function assertSyntheticTarget(root, target) { if (!under(root, target)) throw new Error("SYNTHETIC_PATH_GUARD"); }

function validateSyntheticNonce(bytes) {
  return Buffer.isBuffer(bytes) && bytes.length === 65 && bytes[64] === 0x0a && /^[0-9a-f]{64}$/u.test(bytes.subarray(0, 64).toString("ascii")) && new Set(bytes.subarray(0, 64).toString("ascii").match(/../gu)).size >= 8;
}
function buildSyntheticPrelude() {
  const frame = Buffer.alloc(156); frame.write(POLICY.input.preludeMagic, 0, "ascii"); frame.writeUInt32LE(1, 8);
  for (let index = 12; index < 148; index++) frame[index] = (index * 17 + 11) & 0xff;
  frame.write(POLICY.input.authTerminal, 148, "ascii"); return frame;
}
function parseSyntheticPrelude(frame) {
  return Buffer.isBuffer(frame) && frame.length === 156 && frame.subarray(0, 8).toString("ascii") === POLICY.input.preludeMagic && frame.readUInt32LE(8) === 1 && frame.subarray(148).toString("ascii") === POLICY.input.authTerminal && frame.equals(buildSyntheticPrelude());
}

function runSyntheticDurability(parent = TEMP_PARENT) {
  let root, mutations = 0, cleanups = 0, ok = false;
  try {
    if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) return { ok, mutationOperations: mutations, cleanupOperations: cleanups };
    root = fs.mkdtempSync(path.join(parent, "morpho-r4-p08-")); mutations++;
    const temporary = path.join(root, "candidate.tmp"), final = path.join(root, "candidate.json"); assertSyntheticTarget(parent, temporary); assertSyntheticTarget(parent, final);
    const fd = fs.openSync(temporary, "wx", 0o600); mutations++; try { fs.writeFileSync(fd, Buffer.from("{\"synthetic\":true}", "utf8")); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.linkSync(temporary, final); mutations++; fs.unlinkSync(temporary); mutations++;
    const verify = fs.openSync(final, "r+"); try { fs.fsyncSync(verify); } finally { fs.closeSync(verify); }
    const stat = fs.lstatSync(final); ok = stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1;
  } catch (_) { ok = false; }
  finally { if (root) { try { fs.rmSync(root, { recursive: true, force: true }); if (!fs.existsSync(root)) cleanups++; } catch (_) { ok = false; } } }
  return Object.freeze({ ok, mutationOperations: mutations, cleanupOperations: cleanups });
}
function runSyntheticLock(parent = TEMP_PARENT) {
  let root, mutations = 0, cleanups = 0, ok = false;
  try {
    if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) return { ok, mutationOperations: mutations, cleanupOperations: cleanups };
    root = fs.mkdtempSync(path.join(parent, "morpho-r4-p09-")); mutations++;
    const lock = path.join(root, ".synthetic.lock"), permit = path.join(root, "synthetic-permit.json"); assertSyntheticTarget(parent, lock); assertSyntheticTarget(parent, permit);
    const permitBytes = canonical({ schema: "synthetic-pre-go-permit/v1", active: false }); fs.writeFileSync(permit, permitBytes, { flag: "wx", mode: 0o600 }); mutations++;
    const fd = fs.openSync(lock, "wx", 0o600); mutations++; fs.closeSync(fd); let rejected = false;
    try { fs.openSync(lock, "wx", 0o600); } catch (error) { rejected = error && error.code === "EEXIST"; }
    ok = rejected && fs.readFileSync(permit, "utf8") === permitBytes;
  } catch (_) { ok = false; }
  finally { if (root) { try { fs.rmSync(root, { recursive: true, force: true }); if (!fs.existsSync(root)) cleanups++; } catch (_) { ok = false; } } }
  return Object.freeze({ ok, mutationOperations: mutations, cleanupOperations: cleanups });
}

function qualifyLinuxFileSet(fsOps, paths, expectedCount, uid = 1000, fsMagic = 0xef53) {
  if (!Array.isArray(paths) || paths.length !== expectedCount || new Set(paths).size !== expectedCount) return false;
  let device;
  try {
    for (const file of paths) {
      if (typeof file !== "string" || !file.startsWith("/")) return false;
      const leaf = fsOps.lstatSync(file); if (fsOps.realpathSync(file) !== file || !leaf.isFile() || leaf.isSymbolicLink() || leaf.uid !== uid || leaf.nlink !== 1 || (leaf.mode & 0o022) !== 0 || Number(fsOps.statfsSync(file).type) !== fsMagic) return false;
      const fd = fsOps.openSync(file, (fsOps.constants.O_RDONLY || 0) | (fsOps.constants.O_NOFOLLOW || 0));
      try { const held = fsOps.fstatSync(fd), proc = fsOps.realpathSync(`/proc/self/fd/${fd}`); if (!held.isFile() || held.dev !== leaf.dev || held.ino !== leaf.ino || held.uid !== uid || held.nlink !== 1 || (held.mode & 0o022) !== 0 || proc !== file || (device !== undefined && held.dev !== device)) return false; device = held.dev; }
      finally { fsOps.closeSync(fd); }
    }
    return true;
  } catch (_) { return false; }
}
function checkPermitDocument(value, raw, expected, now, canonicalize, digest) {
  const top = ["schema", "permitId", "mode", "approvalNonceCommitment", "issuedAt", "notBefore", "expiresAt", "policyHash", "productionHashes", "offlineHashes", "runtime", "bridge", "policy", "limits", "schemas", "output", "hardStops"];
  const exact = value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join("|") === top.sort().join("|");
  const body = exact ? { schema: value.schema, mode: value.mode, approvalNonceCommitment: value.approvalNonceCommitment, issuedAt: value.issuedAt, notBefore: value.notBefore, expiresAt: value.expiresAt, policyHash: value.policyHash, productionHashes: value.productionHashes, offlineHashes: value.offlineHashes, runtime: value.runtime, bridge: value.bridge, policy: value.policy, limits: value.limits, schemas: value.schemas, output: value.output, hardStops: value.hardStops } : null;
  const permitId = body ? digest(canonicalize({ domain: "morpho-pt-27aug2026-post-expiry-r2-production-permit-id/v1", permit: body })) : "";
  const structure = exact && canonicalize(value) === raw && !raw.includes("\n") && value.schema === expected.schema && value.mode === expected.mode && /^[0-9a-f]{64}$/u.test(value.approvalNonceCommitment || "") && value.permitId === permitId;
  const policyTools = canonicalize(value.productionHashes) === canonicalize(expected.productionHashes) && canonicalize(value.offlineHashes) === canonicalize(expected.offlineHashes) && value.policyHash === expected.policyHash && canonicalize(value.policy) === canonicalize(expected.policy) && canonicalize(value.limits) === canonicalize(expected.limits) && canonicalize(value.schemas) === canonicalize(expected.schemas) && canonicalize(value.output) === canonicalize(expected.output) && canonicalize(value.hardStops) === canonicalize(expected.hardStops);
  const runtimeBridge = canonicalize(value.runtime) === canonicalize(expected.runtime) && canonicalize(value.bridge) === canonicalize(expected.bridge);
  const issued = value.issuedAt, notBefore = value.notBefore, expires = value.expiresAt, time = Number.isSafeInteger(issued) && notBefore === issued && Number.isSafeInteger(expires) && expires - issued === 600000 && expires - issued <= expected.maxLifetimeMs && issued >= expected.expiryMs;
  return { structure, policyTools, runtimeBridge, time, state: time ? (now < notBefore ? "not-yet-valid" : now >= expires ? "expired" : "current") : "invalid" };
}
function linuxProbeSource() {
  const childExpected = { node: EXPECTED.node, launcher: EXPECTED.launcher, supervisor: EXPECTED.supervisor };
  return `"use strict";
const fs=require("node:fs"),crypto=require("node:crypto"),path=require("node:path");
const P=${JSON.stringify(POLICY)},PH=${JSON.stringify(POLICY_HASH)},PROD=${JSON.stringify(PRODUCTION_FILES)},OFF=${JSON.stringify(OFFLINE_FILES)},E=${JSON.stringify(childExpected)},QUALIFY=${qualifyLinuxFileSet.toString()},CHECK=${checkPermitDocument.toString()};
const R="/home/mruserbox/.local/share/evm-audit/morpho-pt-post-expiry-r2",ACTIVE=R+"/permits/morpho-pt-27aug2026-post-expiry-r2-production.json",OUT=R+"/"+P.output.root;
const result={p01:false,p02:false,p05Structure:false,p05PolicyTools:false,p05RuntimeBridge:false,p05Time:false,p06:false,p07:false,permitState:"absent",permitReads:0};
const C=v=>v===null||typeof v==="boolean"||typeof v==="number"||typeof v==="string"?JSON.stringify(v):Array.isArray(v)?"["+v.map(C).join(",")+"]":"{"+Object.keys(v).sort().map(k=>JSON.stringify(k)+":"+C(v[k])).join(",")+"}",D=v=>crypto.createHash("sha256").update(v).digest("hex"),H=p=>D(fs.readFileSync(p)),M=o=>Object.fromEntries(Object.entries(o).map(([k,p])=>[k,H(R+"/"+p)]));
const mountFor=target=>{const dec=x=>x.replace(/\\\\(040|011|012|134)/g,(_m,c)=>({"040":" ","011":"\\t","012":"\\n","134":"\\\\"})[c]),rows=[];for(const line of fs.readFileSync("/proc/self/mountinfo","utf8").split("\\n")){if(!line)continue;const f=line.split(" "),d=f.indexOf("-");if(d<6||f.length<d+3)throw Error("MOUNT");rows.push({mountId:Number(f[0]),majorMinor:f[2],root:dec(f[3]),mountPoint:dec(f[4]),fsType:f[d+1],source:dec(f[d+2])});}const n=path.posix.resolve(target),m=rows.filter(x=>n===x.mountPoint||n.startsWith(x.mountPoint.replace(/\\/$/,"")+"/")).sort((a,b)=>b.mountPoint.length-a.mountPoint.length);if(!m.length||!P.input.mountPolicy.filesystems.includes(m[0].fsType))throw Error("MOUNT");return m[0];};
try{
 const pm=M(PROD),om=M(OFF),node=P.input.nodePath,launcher=P.input.launcherPath,cap=R+"/"+PROD.capture,allFiles=[node,launcher,...Object.values(PROD).map(x=>R+"/"+x),...Object.values(OFF).map(x=>R+"/"+x)],runtimeFiles=[node,launcher,...Object.values(PROD).filter(x=>x.endsWith(".js")).map(x=>R+"/"+x),...Object.values(OFF).filter(x=>x.endsWith(".js")).map(x=>R+"/"+x)].sort();
 const qualified=QUALIFY(fs,allFiles,2+Object.keys(PROD).length+Object.keys(OFF).length,1000,0xef53); result.p01=qualified&&H(node)===E.node&&H(launcher)===E.launcher&&pm.nativeSupervisorSourceCandidate===E.supervisor; result.p02=qualified; result.p06=QUALIFY(fs,[cap],1,1000,0xef53); result.p07=fs.readdirSync(OUT).length===0;
 if(fs.existsSync(ACTIVE)){
  result.permitReads=1; const b=fs.readFileSync(ACTIVE); if(b.length>P.permit.maxBytes||!QUALIFY(fs,[ACTIVE],1,1000,0xef53)||(fs.lstatSync(ACTIVE).mode&511)!==292)throw Error("PERMIT"); const v=JSON.parse(b.toString("utf8")),cs=fs.lstatSync(cap),mount=mountFor(node);
  const bridge={inputMode:P.input.mode,exclusiveWriterFramedGo:true,windowsPeerEofRequired:false,linuxWriterClosedAfterGo:true,bufferedTrailingBytesRejected:true,postGoChannelMonitored:true,inventoryReadAfterPermanentLock:true,goFrameLayout:{magic:P.input.goMagic,version:P.input.goVersion,type:P.input.goType,sequence:P.input.goSequence,bytes:P.input.goBytes,terminal:P.input.goTerminal,authCommitment:"SHA256_EXACT_PRELUDE"},nativeSupervisorDeadlineMs:P.input.nativeSupervisorDeadlineMs,preGoDeadlineMs:P.input.preGoDeadlineMs,postGoDeadlineMs:P.input.postGoDeadlineMs,nativeSupervisorSourceSha256:pm.nativeSupervisorSource,nativeSupervisorRuntimeSha256:pm.nativeSupervisorSourceCandidate,nativeSupervisorSourceCandidateSha256:pm.nativeSupervisorSourceCandidate,nativeBuildManifestSha256:pm.nativeBuildManifest,launcherSourceSha256:pm.launcherSource,launcherBinarySha256:pm.launcherBinary,nodeExecutableSha256:P.input.nodeExecutableSha256,nodeExecutablePath:node,nodeVersion:process.version,productionCapturePath:cap,productionCaptureSha256:pm.capture,productionCaptureIdentity:{dev:String(cs.dev),ino:String(cs.ino)},runtimeFilePaths:runtimeFiles,nativeMountPolicy:P.input.mountPolicy,nativeMountIdentity:mount};
  const expected={schema:P.permit.schema,mode:P.mode,productionHashes:pm,offlineHashes:om,policyHash:PH,policy:{hash:PH,profileHash:P.profileHash,chainId:P.chainId,expiryTimestamp:P.expiryTimestamp,inputMode:P.input.mode},limits:P.limits,schemas:P.schemas,output:P.output,hardStops:P.hardStops,runtime:{nodeVersion:process.versions.node,platform:process.platform,arch:process.arch,toolchain:"node-"+process.versions.modules},bridge,maxLifetimeMs:P.permit.maxLifetimeMs,expiryMs:P.expiryTimestamp*1000},checks=CHECK(v,b.toString("utf8"),expected,Date.now(),C,D);
  result.p05Structure=checks.structure;result.p05PolicyTools=checks.policyTools;result.p05RuntimeBridge=checks.runtimeBridge;result.p05Time=checks.time;result.permitState=checks.state;
 }
}catch(_){if(result.permitReads===1)result.permitState="invalid";}
process.stdout.write(C(result));`;
}

function decodeBase64(value) {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) throw new Error("CHILD_BASE64");
  const bytes = Buffer.from(value, "base64"); if (bytes.toString("base64") !== value) throw new Error("CHILD_BASE64"); return bytes;
}
function runContainedChild(mode, payloadBase64, spawnSync = childProcess.spawnSync, timeout = 35000) {
  if (!["WSL_PROBE", "ACL_PROBE", "SELFTEST_TIMEOUT", "SELFTEST_JOB_CREATE", "SELFTEST_JOB_SET", "SELFTEST_JOB_ASSIGN", "SELFTEST_RESUME"].includes(mode) || typeof payloadBase64 !== "string" || !/^[A-Za-z0-9+/=]*$/u.test(payloadBase64)) throw new Error("CHILD_REQUEST");
  if (!regular(POWERSHELL, EXPECTED.powershell, false) || !regular(CONTAINED_HELPER, EXPECTED.containedHelper)) throw new Error("CHILD_AUTHORITY");
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", CONTAINED_HELPER, "-Mode", mode]; if (mode === "WSL_PROBE") args.push("-PayloadBase64", payloadBase64);
  const raw = spawnSync(POWERSHELL, args, { shell: false, windowsHide: true, encoding: "utf8", timeout, maxBuffer: 4096, env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" } });
  if (!raw || raw.error || raw.status !== 0 || raw.signal !== null || typeof raw.stdout !== "string" || typeof raw.stderr !== "string" || raw.stderr !== "" || Buffer.byteLength(raw.stdout) > 4096) throw new Error("CONTAINMENT_WRAPPER");
  let value; try { value = JSON.parse(raw.stdout); } catch (_) { throw new Error("CHILD_PROTOCOL"); }
  if (!exactKeys(value, ["kind", "exitCode", "stdoutBase64", "stderrBase64", "treeTerminated", "childPid", "sideEffectPathBase64", "processExited", "jobActiveProcesses"]) || !["EXIT", "TIMEOUT", "OUTPUT_LIMIT", "START_ERROR", "CHILD_ERROR", "JOB_CREATE_ERROR", "JOB_SET_ERROR", "JOB_ASSIGN_ERROR", "RESUME_ERROR"].includes(value.kind) || !(value.exitCode === null || Number.isInteger(value.exitCode)) || typeof value.treeTerminated !== "boolean" || typeof value.processExited !== "boolean" || !Number.isSafeInteger(value.childPid) || value.childPid < 0 || !Number.isSafeInteger(value.jobActiveProcesses) || value.jobActiveProcesses < 0) throw new Error("CHILD_PROTOCOL");
  const stdout = decodeBase64(value.stdoutBase64), stderr = decodeBase64(value.stderrBase64), sideEffectPath = decodeBase64(value.sideEffectPathBase64).toString("utf8");
  if (stdout.length + stderr.length > 8192 || value.treeTerminated !== true || value.processExited !== true || value.jobActiveProcesses !== 0) throw new Error("CHILD_PROTOCOL");
  return Object.freeze({ kind: value.kind, exitCode: value.exitCode, stdout, stderr, treeTerminated: true, childPid: value.childPid, sideEffectPath, processExited: true, jobActiveProcesses: 0 });
}
function failedLinux() { return { p01: false, p02: false, p05Structure: false, p05PolicyTools: false, p05RuntimeBridge: false, p05Time: false, p06: false, p07: false, permitState: "invalid", permitReads: 0 }; }
function validLinuxResult(value) {
  const keys = ["p01", "p02", "p05Structure", "p05PolicyTools", "p05RuntimeBridge", "p05Time", "p06", "p07", "permitState", "permitReads"];
  return exactKeys(value, keys) && keys.slice(0, 8).every((key) => typeof value[key] === "boolean") && ["absent", "current", "expired", "not-yet-valid", "invalid"].includes(value.permitState) && (value.permitReads === 0 || value.permitReads === 1) && ((value.permitState === "absent") === (value.permitReads === 0));
}
function probeLinux(options = {}) {
  const spawnSync = options.spawnSync || childProcess.spawnSync, counters = { powershellChildExecutions: 0, wslChildExecutions: 0, containedChildExecutions: 0, childTreeCleanupConfirmations: 0, productionNodeDiagnosticExecutions: 0 };
  try {
    if (!regular(WSL, EXPECTED.wsl, false)) return { data: failedLinux(), counters };
    counters.powershellChildExecutions++; counters.wslChildExecutions++; counters.containedChildExecutions++; counters.productionNodeDiagnosticExecutions++;
    const result = runContainedChild("WSL_PROBE", Buffer.from(linuxProbeSource(), "utf8").toString("base64"), spawnSync);
    if (result.treeTerminated) counters.childTreeCleanupConfirmations++;
    if (result.kind !== "EXIT" || result.exitCode !== 0 || result.stderr.length !== 0 || result.stdout.length > 4096) return { data: failedLinux(), counters };
    const value = JSON.parse(result.stdout.toString("utf8")); return { data: validLinuxResult(value) ? value : failedLinux(), counters };
  } catch (_) { return { data: failedLinux(), counters }; }
}
function probeWindowsAcl(options = {}) {
  const spawnSync = options.spawnSync || childProcess.spawnSync, counters = { powershellChildExecutions: 0, containedChildExecutions: 0, childTreeCleanupConfirmations: 0 };
  try {
    counters.powershellChildExecutions++;
    const result = runContainedChild("ACL_PROBE", "", spawnSync, 20000);
    if (result.kind !== "EXIT" || result.exitCode !== 0 || result.stderr.length !== 0) return { ok: false, counters };
    const value = JSON.parse(result.stdout.toString("utf8")); return { ok: exactKeys(value, ["ok"]) && value.ok === true, counters };
  } catch (_) { return { ok: false, counters }; }
}

function defaultSnapshot(options = {}) {
  let runtimeFiles = false;
  try {
    const names = fs.readdirSync(RUNTIME).sort(), expectedNames = ["issue-morpho-pt-27aug2026-post-expiry-r3-production-permit-once.ps1", "morpho-pt-post-expiry-r3-capture-conductor-win32.exe", "morpho-pt-post-expiry-r3-native-build-manifest.json"].sort();
    const manifestFile = path.join(RUNTIME, expectedNames[2]), manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    runtimeFiles = names.join("|") === expectedNames.join("|") && regular(path.join(RUNTIME, expectedNames[0]), EXPECTED.permitScript) && regular(path.join(RUNTIME, expectedNames[1]), EXPECTED.conductor) && regular(manifestFile, EXPECTED.r3Manifest) && manifest.authority.externalConductorRawSha256 === EXPECTED.conductor && manifest.authority.externalSupervisorRawSha256 === EXPECTED.supervisor && manifest.windows.production.binarySha256 === EXPECTED.conductor;
  } catch (_) { runtimeFiles = false; }
  let supervisorSource = "", launcherSource = "", conductorSource = "";
  try { supervisorSource = fs.readFileSync(path.join(ROOT, "tools", "native", "morpho-pt-post-expiry-r2-supervisor-broker-win32.c"), "utf8"); launcherSource = fs.readFileSync(path.join(ROOT, "tools", "native", "morpho-pt-post-expiry-r2-launcher-linux.c"), "utf8"); conductorSource = fs.readFileSync(path.join(ROOT, "tools", "native", "morpho-pt-post-expiry-r3-capture-conductor-win32.c"), "utf8"); } catch (_) {}
  const linuxProbe = probeLinux(options), aclProbe = probeWindowsAcl(options), linux = linuxProbe.data;
  const invocation = conductorSource.includes("SystemRoot=C:\\\\Windows\\0WINDIR=C:\\\\Windows") && launcherSource.includes("LANG=C") && launcherSource.includes("PATH=") && validateSyntheticNonce(Buffer.from("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff\n"));
  const ordering = supervisorSource.indexOf('die("N10")') >= 0 && supervisorSource.indexOf('die("N10")') < supervisorSource.indexOf("ReadFile(inventory,content") && launcherSource.indexOf("goPipe") < launcherSource.indexOf("write_all(inventoryPipe[1],data,cap)") && conductorSource.includes(EXPECTED.supervisor);
  const safety = { ...ZERO_SAFETY, ...linuxProbe.counters };
  for (const [key, value] of Object.entries(aclProbe.counters)) safety[key] += value;
  safety.productionPermitReads = linux.permitReads;
  return { p01: runtimeFiles && linux.p01, p02: runtimeFiles && aclProbe.ok && linux.p02, p03: invocation, p04: parseSyntheticPrelude(buildSyntheticPrelude()), p05Structure: linux.p05Structure, p05PolicyTools: linux.p05PolicyTools, p05RuntimeBridge: linux.p05RuntimeBridge, p05Time: linux.p05Time, permitState: linux.permitState, p06: linux.p06, p07: linux.p07, p10: ordering, safety };
}

function normalizeSynthetic(value) { return value && typeof value === "object" && typeof value.ok === "boolean" && Number.isInteger(value.mutationOperations) && value.mutationOperations >= 0 && Number.isInteger(value.cleanupOperations) && value.cleanupOperations >= 0 ? value : { ok: false, mutationOperations: 0, cleanupOperations: 0 }; }
function classify(options = {}) {
  const snapshot = options.snapshot || defaultSnapshot(options), synthetic = options.synthetic || { durability: () => runSyntheticDurability(options.tempParent), lock: () => runSyntheticLock(options.tempParent) };
  const durability = normalizeSynthetic(synthetic.durability()), lock = normalizeSynthetic(synthetic.lock());
  const phases = {
    P01: snapshot.p01 ? "P01_PASS" : "P01_FAIL", P02: snapshot.p02 ? "P02_PASS" : "P02_FAIL",
    P03: snapshot.p03 ? "P03_PASS_SYNTHETIC_ONLY" : "P03_FAIL", P04: snapshot.p04 ? "P04_PASS_SYNTHETIC_ONLY" : "P04_FAIL",
    P05: snapshot.permitState === "absent" ? "P05_ACTIVE_PERMIT_ABSENT" : snapshot.p05Structure && snapshot.p05PolicyTools && snapshot.p05RuntimeBridge && snapshot.p05Time ? (snapshot.permitState === "current" ? "P05_PASS_CURRENT_NONCE_UNAVAILABLE" : snapshot.permitState === "expired" ? "P05_PASS_EXPIRED_NONCE_UNAVAILABLE" : "P05_FAIL") : "P05_FAIL",
    P06: snapshot.p06 ? "P06_PASS" : "P06_FAIL", P07: snapshot.p07 ? "P07_PASS_CLEAN" : "P07_FAIL",
    P08: durability.ok ? "P08_PASS_SYNTHETIC_ONLY" : "P08_FAIL", P09: lock.ok ? "P09_PASS_SYNTHETIC_ONLY" : "P09_FAIL", P10: snapshot.p10 ? "P10_PASS" : "P10_FAIL",
  };
  const safety = { ...ZERO_SAFETY, ...(snapshot.safety || {}) };
  safety.syntheticMutationOperations = durability.mutationOperations + lock.mutationOperations; safety.syntheticCleanupOperations = durability.cleanupOperations + lock.cleanupOperations;
  const failed = PHASE_KEYS.some((key) => phases[key].endsWith("_FAIL"));
  const overall = failed ? "FAIL" : phases.P05 === "P05_ACTIVE_PERMIT_ABSENT" ? "BLOCKED_ACTIVE_PERMIT_ABSENT" : phases.P05.includes("EXPIRED") ? "BLOCKED_EXPIRED" : "PASS_LIMITED";
  return Object.freeze({ schema: SCHEMA, overall, phases: Object.freeze(phases), safety: Object.freeze(safety) });
}

if (require.main === module) {
  try { process.stdout.write(`${canonical(classify())}\n`); }
  catch (_) { process.stdout.write(`${canonical({ schema: SCHEMA, overall: "FAIL", phases: Object.fromEntries(PHASE_KEYS.map((key) => [key, `${key}_FAIL`])), safety: ZERO_SAFETY })}\n`); process.exitCode = 1; }
}
module.exports = Object.freeze({ SCHEMA, ZERO_SAFETY, PHASE_KEYS, EXPECTED, WSL, POWERSHELL, CONTAINED_HELPER, canonical, sha256, exactKeys, regular, validateSyntheticNonce, buildSyntheticPrelude, parseSyntheticPrelude, assertSyntheticTarget, runSyntheticDurability, runSyntheticLock, qualifyLinuxFileSet, checkPermitDocument, linuxProbeSource, runContainedChild, validLinuxResult, probeLinux, probeWindowsAcl, defaultSnapshot, classify });
