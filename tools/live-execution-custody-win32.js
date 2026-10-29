#!/usr/bin/env node
"use strict";

// Shared DPAPI custody verification and Ed25519 signing support.
//
// This module owns the canonical addon/manifest verification, the current-user
// ACL qualification, and the in-memory unprotect/sign path. Private key bytes
// never leave the function scope in which they are used: the decrypted PKCS8
// buffer and the DPAPI ciphertext are zeroized in a `finally` block, and no
// caller-visible value ever contains key material.
//
// The module intentionally has no CLI. It is consumed by
// `live-execution-approver-bootstrap-win32.js` and
// `live-execution-batch-author-win32.js`.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const APPROVER_ID = "windows-local-approver-20260912-01";
const CUSTODY_PATH = "C:\\Users\\MiPC\\AppData\\Local\\EVM_AUDIT\\approvers\\windows-local-approver-20260912-01.pk8.dpapi";
const ADDON_PATH = path.join(ROOT, ".runtime", "live-execution-approver-custody-win32", "dpapi-current-user.node");
const MANIFEST_PATH = path.join(path.dirname(ADDON_PATH), "build-manifest.json");
const ACL_HELPER_PATH = path.join(__dirname, "live-execution-approver-acl-win32.ps1");
const ADDON_SHA256 = "11c6ec38975271dbdb876f8d7fca84a1db06cb6c2e3b2a7c8abe4a594910cda7";
const CUSTODY_MESSAGE = Buffer.from("EVM_AUDIT_APPROVER_CUSTODY_SELF_TEST_V1\0", "utf8");
const APPROVAL_DOMAIN_PROBE = Buffer.from("EVM_AUDIT_LIVE_EXECUTION_BATCH_APPROVAL_V2\0{\"scheme\":\"Ed25519\",\"approverId\":\"windows-local-approver-20260912-01\",\"scopeCommitment\":\"0x0000000000000000000000000000000000000000000000000000000000000000\"}", "utf8");
const TEMP_ROOT = "C:\\Users\\MiPC\\AppData\\Local\\Temp\\opencode";
const SID_RE = /^S-1-5-21-(?:[0-9]+-){3}[0-9]+$/u;

class CustodyError extends Error {
  constructor(status, code) { super(code); this.name = "CustodyError"; this.status = status; this.code = code; }
}
function fail(status, code) { throw new CustodyError(status, code); }
function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function isLowerHash(value) { return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value); }
function exactKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join("|") === [...expected].sort().join("|");
}
function assertTempDescendant(value) {
  const full = path.resolve(value), prefix = `${path.resolve(TEMP_ROOT)}${path.sep}`;
  if (!full.toLowerCase().startsWith(prefix.toLowerCase())) fail("DENIED", "TEST_PATH_FORBIDDEN");
}
function assertHostPlatform() {
  if (process.platform !== "win32" || process.arch !== "x64" || process.version !== "v24.13.0" || process.versions.napi !== "10") fail("DENIED", "HOST_INVALID");
}
function assertLocalAppData() {
  if ((process.env.LOCALAPPDATA || "").toLowerCase() !== "c:\\users\\mipc\\appdata\\local") fail("DENIED", "LOCAL_APP_DATA_INVALID");
}
function readAndVerifyAddon(options = {}) {
  const addonPath = options.addonPath || ADDON_PATH, manifestPath = options.manifestPath || MANIFEST_PATH;
  let addonBytes, manifestBytes, manifest;
  try { addonBytes = fs.readFileSync(addonPath); manifestBytes = fs.readFileSync(manifestPath); manifest = JSON.parse(manifestBytes.toString("utf8")); } catch (_) { fail("DENIED", "ADDON_UNAVAILABLE"); }
  const digest = sha256(addonBytes), expected = options.testOnly ? options.addonSha256 : ADDON_SHA256;
  if (!isLowerHash(expected) || digest !== expected) fail("DENIED", "ADDON_HASH_MISMATCH");
  if (!exactKeys(manifest, ["schema", "node", "sourceSha256", "buildSha256", "sources", "toolchain", "artifact"]) || manifest.schema !== "live-execution-dpapi-win32-build/v1" || manifest.node?.version !== "v24.13.0" || manifest.node?.napi !== 10 || manifest.node?.arch !== "x64" || !isLowerHash(manifest.sourceSha256) || !isLowerHash(manifest.buildSha256) || manifest.artifact?.sha256 !== digest || manifest.artifact?.bytes !== addonBytes.length) fail("DENIED", "BUILD_MANIFEST_INVALID");
  let addon;
  try { addon = options.loadAddon ? options.loadAddon(addonPath) : require(addonPath); } catch (_) { fail("DENIED", "ADDON_LOAD_FAILED"); }
  if (Object.getOwnPropertyNames(addon).sort().join("|") !== "protectCurrentUser|unprotectCurrentUser" || typeof addon.protectCurrentUser !== "function" || typeof addon.unprotectCurrentUser !== "function") fail("DENIED", "ADDON_API_INVALID");
  return { addon, addonSha256: digest, sourceSha256: manifest.sourceSha256, buildSha256: manifest.buildSha256 };
}
function callAcl(request, options = {}) {
  const helperPath = options.aclHelperPath || ACL_HELPER_PATH;
  const run = options.spawnSync || childProcess.spawnSync;
  const result = run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helperPath], { input: JSON.stringify(request), encoding: "utf8", windowsHide: true, env: { SystemRoot: process.env.SystemRoot, LOCALAPPDATA: process.env.LOCALAPPDATA } });
  let row;
  try { row = JSON.parse((result.stdout || "").trim()); } catch (_) { fail("DENIED", "ACL_HELPER_PROTOCOL_INVALID"); }
  const operation = request.operation.replace(/^TEST_/u, ""), statuses = { PREFLIGHT: "PREFLIGHT_OK", CREATE_EMPTY: "EMPTY_FILE_READY", VERIFY: "FILE_VERIFIED", COMMIT_CIPHERTEXT: "CUSTODY_COMMITTED" };
  if (result.status !== 0 || result.stderr || !row?.ok) {
    const safeCodes = new Set(["PLATFORM_INVALID", "REQUEST_INVALID", "OPERATION_INVALID", "LOCAL_APP_DATA_INVALID", "PATH_INVALID", "TEST_PATH_FORBIDDEN", "DRIVE_INVALID", "BASE_INVALID", "REPARSE_POINT", "SID_INVALID", "DIRECTORY_ACL_INVALID", "DESTINATION_EXISTS", "LENGTH_INVALID", "CIPHERTEXT_INVALID", "FILE_ACL_INVALID", "FILE_IDENTITY_INVALID", "ACL_HELPER_FAILED"]);
    fail("DENIED", safeCodes.has(row?.code) ? row.code : "ACL_HELPER_FAILED");
  }
  const expectedKeys = operation === "PREFLIGHT" ? ["ok", "status", "sid"] : ["ok", "status", "sid", "length"];
  if (!exactKeys(row, expectedKeys) || row.status !== statuses[operation] || !SID_RE.test(row.sid || "") || (operation !== "PREFLIGHT" && row.length !== request.expectedLength)) fail("DENIED", "ACL_HELPER_PROTOCOL_INVALID");
  return row;
}
function qualifyInMemory(addon) {
  let privateDer = null, decrypted = null, cipher = null;
  try {
    const pair = crypto.generateKeyPairSync("ed25519");
    const publicSpki = pair.publicKey.export({ format: "der", type: "spki" });
    privateDer = pair.privateKey.export({ format: "der", type: "pkcs8" });
    cipher = addon.protectCurrentUser(privateDer);
    decrypted = addon.unprotectCurrentUser(cipher);
    const recovered = crypto.createPrivateKey({ key: decrypted, format: "der", type: "pkcs8" });
    const recoveredPublic = crypto.createPublicKey(recovered).export({ format: "der", type: "spki" });
    if (!Buffer.from(recoveredPublic).equals(publicSpki)) fail("DENIED", "DPAPI_IDENTITY_MISMATCH");
    const signature = crypto.sign(null, CUSTODY_MESSAGE, recovered);
    if (!crypto.verify(null, CUSTODY_MESSAGE, pair.publicKey, signature) || crypto.verify(null, APPROVAL_DOMAIN_PROBE, pair.publicKey, signature)) fail("DENIED", "SELF_TEST_DOMAIN_FAILURE");
    return { publicKeyFingerprint: `0x${sha256(publicSpki)}` };
  } finally {
    if (privateDer) privateDer.fill(0);
    if (decrypted) decrypted.fill(0);
    if (cipher) cipher.fill(0);
  }
}
// Resolve host + verified addon + qualified custody path for a real signing
// request. `testOnly` swaps in injected addon/paths/ACL for offline tests.
function resolveCustodyContext(options = {}) {
  assertHostPlatform();
  if (!options.testOnly) assertLocalAppData();
  const addonFacts = readAndVerifyAddon(options);
  const custodyPath = options.custodyPath || CUSTODY_PATH;
  if (options.testOnly) assertTempDescendant(custodyPath);
  else if (custodyPath !== CUSTODY_PATH) fail("DENIED", "PATH_INVALID");
  const preflightRequest = options.testOnly ? { operation: "TEST_PREFLIGHT", path: custodyPath } : { operation: "PREFLIGHT" };
  const acl = (options.callAcl || callAcl)(preflightRequest, options);
  if (!SID_RE.test(acl.sid || "")) fail("DENIED", "SID_INVALID");
  return { ...addonFacts, sid: acl.sid, custodyPath };
}
// Sign `message` (a Buffer) with the custody key. The private key only exists
// inside this function scope. When `expectedPublicKeySpkiDerBase64` is given,
// the derived public key must match it before any signature is produced.
function signApprovalMessage(message, options = {}) {
  if (!Buffer.isBuffer(message) || message.length === 0) fail("DENIED", "MESSAGE_INVALID");
  const context = resolveCustodyContext(options);
  let cipher = null, decrypted = null, privateKey = null;
  try {
    const verifyRequest = (expectedLength) => options.testOnly
      ? { operation: "TEST_VERIFY", path: context.custodyPath, expectedLength }
      : { operation: "VERIFY", expectedLength };
    let sizeBefore;
    try { sizeBefore = fs.statSync(context.custodyPath).size; } catch (_) { fail("DENIED", "CUSTODY_UNAVAILABLE"); }
    (options.callAcl || callAcl)(verifyRequest(sizeBefore), options);
    try { cipher = fs.readFileSync(context.custodyPath); } catch (_) { fail("DENIED", "CUSTODY_UNAVAILABLE"); }
    (options.callAcl || callAcl)(verifyRequest(cipher.length), options);
    decrypted = context.addon.unprotectCurrentUser(cipher);
    if (!Buffer.isBuffer(decrypted) || decrypted.length === 0) fail("DENIED", "CUSTODY_UNPROTECT_FAILED");
    privateKey = crypto.createPrivateKey({ key: decrypted, format: "der", type: "pkcs8" });
    const publicSpki = crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" });
    const publicKeySpkiDerBase64 = publicSpki.toString("base64");
    if (typeof options.expectedPublicKeySpkiDerBase64 === "string" && publicKeySpkiDerBase64 !== options.expectedPublicKeySpkiDerBase64) fail("DENIED", "CUSTODY_IDENTITY_MISMATCH");
    const signature = crypto.sign(null, message, privateKey);
    if (signature.length !== 64) fail("DENIED", "SIGNATURE_INVALID");
    return { signature, publicKeySpkiDerBase64, publicKeyFingerprint: `0x${sha256(publicSpki)}`, addonSha256: context.addonSha256 };
  } catch (error) {
    if (error instanceof CustodyError) throw error;
    fail("DENIED", "CUSTODY_SIGNING_FAILED");
  } finally {
    if (decrypted && Buffer.isBuffer(decrypted)) decrypted.fill(0);
    if (cipher && Buffer.isBuffer(cipher)) cipher.fill(0);
    privateKey = null;
  }
}
function publicError(error) {
  return { ok: false, status: error instanceof CustodyError ? error.status : "DENIED", code: error instanceof CustodyError ? error.code : "CUSTODY_FAILED" };
}

module.exports = Object.freeze({
  ROOT, APPROVER_ID, CUSTODY_PATH, ADDON_PATH, MANIFEST_PATH, ACL_HELPER_PATH, ADDON_SHA256,
  CUSTODY_MESSAGE, APPROVAL_DOMAIN_PROBE, TEMP_ROOT, SID_RE,
  CustodyError, fail, sha256, isLowerHash, exactKeys, assertTempDescendant, assertHostPlatform, assertLocalAppData,
  readAndVerifyAddon, callAcl, qualifyInMemory, resolveCustodyContext, signApprovalMessage, publicError,
});
