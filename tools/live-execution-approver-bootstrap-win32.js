#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const custody = require("./live-execution-custody-win32.js");

const ROOT = custody.ROOT;
const APPROVER_ID = custody.APPROVER_ID;
const CUSTODY_PATH = custody.CUSTODY_PATH;
const CANDIDATE_PATH = "C:\\_Work\\__EVM_AUDIT\\coordination\\live-execution-approvers.p1a-candidate.json";
const ADDON_PATH = custody.ADDON_PATH;
const MANIFEST_PATH = custody.MANIFEST_PATH;
const ACL_HELPER_PATH = custody.ACL_HELPER_PATH;
const ADDON_SHA256 = custody.ADDON_SHA256;
const CUSTODY_MESSAGE = custody.CUSTODY_MESSAGE;
const APPROVAL_DOMAIN_PROBE = custody.APPROVAL_DOMAIN_PROBE;
const TEMP_ROOT = custody.TEMP_ROOT;

const BootstrapError = custody.CustodyError;
const fail = custody.fail;
const sha256 = custody.sha256;
const assertTempDescendant = custody.assertTempDescendant;
const readAndVerifyAddon = custody.readAndVerifyAddon;
const callAcl = custody.callAcl;
const qualifyInMemory = custody.qualifyInMemory;

function assertAbsent(file, io = fs) {
  try { io.lstatSync(file); fail("DENIED", "DESTINATION_EXISTS"); }
  catch (error) {
    if (error instanceof BootstrapError) throw error;
    if (error?.code !== "ENOENT") fail("DENIED", "DESTINATION_STATE_UNKNOWN");
  }
}
function candidateBytes(publicSpki) {
  const registry = { schema: "live-execution-approver-registry/v1", approvers: [{ approverId: APPROVER_ID, algorithm: "Ed25519", publicKeySpkiDerBase64: publicSpki.toString("base64") }] };
  return Buffer.from(`${JSON.stringify(registry, null, 2)}\n`, "utf8");
}
function hostPreflight(options = {}) {
  custody.assertHostPlatform();
  if (!options.testOnly) custody.assertLocalAppData();
  const addonFacts = readAndVerifyAddon(options);
  const custodyPath = options.custodyPath || CUSTODY_PATH, candidatePath = options.candidatePath || CANDIDATE_PATH;
  if (options.testOnly) { assertTempDescendant(custodyPath); assertTempDescendant(candidatePath); }
  else if (custodyPath !== CUSTODY_PATH || candidatePath !== CANDIDATE_PATH) fail("DENIED", "PATH_INVALID");
  const preflightRequest = options.testOnly ? { operation: "TEST_PREFLIGHT", path: custodyPath } : { operation: "PREFLIGHT" };
  const acl = (options.callAcl || callAcl)(preflightRequest, options);
  if (!custody.SID_RE.test(acl.sid || "")) fail("DENIED", "SID_INVALID");
  return { ...addonFacts, sid: acl.sid, custodyPath, candidatePath };
}
function check(options = {}) {
  const facts = hostPreflight(options);
  const qualified = qualifyInMemory(facts.addon);
  return { ok: true, status: "CHECK_OK", approverId: APPROVER_ID, publicKeyFingerprint: qualified.publicKeyFingerprint, addonSha256: facts.addonSha256, sourceSha256: facts.sourceSha256, buildSha256: facts.buildSha256 };
}
function writeCandidateExclusive(file, bytes, options = {}) {
  const io = options.fs || fs;
  let handle = null, created = false;
  try {
    handle = io.openSync(file, "wx", 0o600);
    created = true;
    const written = io.writeSync(handle, bytes, 0, bytes.length, null);
    if (written !== bytes.length) fail("PUBLIC_REGISTRY_PENDING", "CANDIDATE_SHORT_WRITE");
    io.fsyncSync(handle); io.closeSync(handle); handle = null;
    if (!io.readFileSync(file).equals(bytes)) fail("PUBLIC_REGISTRY_PENDING", "CANDIDATE_READBACK_MISMATCH");
  } catch (error) {
    if (handle !== null) { try { io.closeSync(handle); } catch (_) { /* sanitized below */ } }
    try { if (created && io.existsSync(file)) io.unlinkSync(file); } catch (_) { /* public artifact only */ }
    if (error instanceof BootstrapError) throw error;
    fail("PUBLIC_REGISTRY_PENDING", "CANDIDATE_WRITE_FAILED");
  }
}
function bootstrap(options = {}) {
  const facts = hostPreflight(options), io = options.fs || fs;
  assertAbsent(facts.custodyPath, io); assertAbsent(facts.candidatePath, io);
  const requestFor = (operation, extra = {}) => options.testOnly ? { operation: `TEST_${operation}`, path: facts.custodyPath, ...extra } : { operation, ...extra };
  (options.callAcl || callAcl)(requestFor("CREATE_EMPTY", { expectedLength: 0 }), options);
  let privateDer = null, decrypted = null, ciphertext = null, committed = false;
  try {
    const pair = (options.generateKeyPairSync || crypto.generateKeyPairSync)("ed25519");
    const publicSpki = pair.publicKey.export({ format: "der", type: "spki" });
    privateDer = pair.privateKey.export({ format: "der", type: "pkcs8" });
    try { ciphertext = facts.addon.protectCurrentUser(privateDer); } finally { privateDer.fill(0); privateDer = null; }
    if (!Buffer.isBuffer(ciphertext) || ciphertext.length === 0) fail("CUSTODY_COMMIT_INDETERMINATE", "CIPHERTEXT_INVALID");
    try {
      (options.callAcl || callAcl)(requestFor("COMMIT_CIPHERTEXT", { expectedLength: ciphertext.length, ciphertextBase64: ciphertext.toString("base64") }), options);
      committed = true;
    } catch (_) { fail("CUSTODY_COMMIT_INDETERMINATE", "CUSTODY_COMMIT_UNCONFIRMED"); }
    (options.callAcl || callAcl)(requestFor("VERIFY", { expectedLength: ciphertext.length }), options);
    const readback = io.readFileSync(facts.custodyPath);
    if (!readback.equals(ciphertext)) fail("PUBLIC_REGISTRY_PENDING", "CUSTODY_READBACK_MISMATCH");
    (options.callAcl || callAcl)(requestFor("VERIFY", { expectedLength: ciphertext.length }), options);
    decrypted = facts.addon.unprotectCurrentUser(readback);
    readback.fill(0);
    let recovered;
    try { recovered = crypto.createPrivateKey({ key: decrypted, format: "der", type: "pkcs8" }); } catch (_) { fail("PUBLIC_REGISTRY_PENDING", "PKCS8_INVALID"); }
    const recoveredPublic = crypto.createPublicKey(recovered).export({ format: "der", type: "spki" });
    if (!Buffer.from(recoveredPublic).equals(publicSpki)) fail("PUBLIC_REGISTRY_PENDING", "PUBLIC_IDENTITY_MISMATCH");
    const signature = crypto.sign(null, CUSTODY_MESSAGE, recovered);
    if (!crypto.verify(null, CUSTODY_MESSAGE, pair.publicKey, signature) || crypto.verify(null, APPROVAL_DOMAIN_PROBE, pair.publicKey, signature)) fail("PUBLIC_REGISTRY_PENDING", "SELF_TEST_DOMAIN_FAILURE");
    if (options.afterCustodyConfirmed) options.afterCustodyConfirmed({ custodyPath: facts.custodyPath });
    (options.callAcl || callAcl)(requestFor("VERIFY", { expectedLength: ciphertext.length }), options);
    const bytes = candidateBytes(publicSpki), registrySha256 = sha256(bytes), publicKeyFingerprint = `0x${sha256(publicSpki)}`;
    writeCandidateExclusive(facts.candidatePath, bytes, options);
    return { ok: true, status: "BOOTSTRAP_OK", approverId: APPROVER_ID, publicKeyFingerprint, registrySha256, addonSha256: facts.addonSha256, sourceSha256: facts.sourceSha256, buildSha256: facts.buildSha256 };
  } catch (error) {
    if (error instanceof BootstrapError) {
      if (committed && error.status !== "PUBLIC_REGISTRY_PENDING") fail("PUBLIC_REGISTRY_PENDING", error.code);
      throw error;
    }
    fail(committed ? "PUBLIC_REGISTRY_PENDING" : "CUSTODY_COMMIT_INDETERMINATE", committed ? "POST_COMMIT_FAILURE" : "CUSTODY_STATE_UNCERTAIN");
  } finally {
    if (privateDer) privateDer.fill(0);
    if (decrypted) decrypted.fill(0);
    if (ciphertext) ciphertext.fill(0);
  }
}
function publicError(error) {
  return { ok: false, status: error instanceof BootstrapError ? error.status : "DENIED", code: error instanceof BootstrapError ? error.code : "BOOTSTRAP_FAILED" };
}
function main(argv) {
  if (argv.length !== 1 || !["--check", "--bootstrap"].includes(argv[0])) fail("DENIED", "ARGUMENT_INVALID");
  return argv[0] === "--check" ? check() : bootstrap();
}
if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)))}\n`); }
  catch (error) { process.stdout.write(`${JSON.stringify(publicError(error))}\n`); process.exitCode = 1; }
}
module.exports = Object.freeze({ check, bootstrap, candidateBytes, qualifyInMemory, publicError, constants: Object.freeze({ APPROVER_ID, CUSTODY_PATH, CANDIDATE_PATH, ADDON_PATH, MANIFEST_PATH, ACL_HELPER_PATH, ADDON_SHA256, CUSTODY_MESSAGE, APPROVAL_DOMAIN_PROBE, TEMP_ROOT }) });
