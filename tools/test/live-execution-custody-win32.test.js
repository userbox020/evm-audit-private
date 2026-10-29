#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const custody = require("../live-execution-custody-win32.js");

const SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";
const MAGIC = Buffer.from("DPAPI-INTERNAL-DOUBLE\0", "utf8");
const roots = new Set();

function tempDir(name) {
  const dir = fs.mkdtempSync(path.join(custody.TEMP_ROOT, `custody-${name}-`));
  roots.add(dir);
  return dir;
}
function writeAddon(dir, bytes = Buffer.from("synthetic-addon-binary", "utf8")) {
  const addonPath = path.join(dir, "dpapi-current-user.node");
  fs.writeFileSync(addonPath, bytes, { flag: "wx" });
  return { addonPath, addonBytes: bytes };
}
function writeManifest(dir, addonBytes, overrides = {}) {
  const manifest = {
    schema: "live-execution-dpapi-win32-build/v1",
    node: { version: "v24.13.0", napi: 10, arch: "x64" },
    sourceSha256: "a".repeat(64),
    buildSha256: "b".repeat(64),
    sources: ["dpapi_current_user.c"],
    toolchain: { compiler: "synthetic" },
    artifact: { sha256: custody.sha256(addonBytes), bytes: addonBytes.length },
    ...overrides,
  };
  const manifestPath = path.join(dir, "build-manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  return manifestPath;
}
function addonDouble() {
  const state = { decrypted: null };
  const api = {
    protectCurrentUser(der) {
      if (!Buffer.isBuffer(der)) throw new Error("DPAPI_ARGUMENT_INVALID");
      return Buffer.concat([MAGIC, der]);
    },
    unprotectCurrentUser(cipher) {
      if (!Buffer.isBuffer(cipher) || cipher.length < MAGIC.length || !cipher.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("DPAPI_UNPROTECT_FAILED");
      const clear = Buffer.from(cipher.subarray(MAGIC.length));
      state.decrypted = clear;
      return clear;
    },
  };
  return { api, state };
}
function aclDouble(request) {
  const operation = request.operation.replace(/^TEST_/u, "");
  if (operation === "PREFLIGHT") return { ok: true, status: "PREFLIGHT_OK", sid: SID };
  return { ok: true, status: "FILE_VERIFIED", sid: SID, length: request.expectedLength };
}
function verifiedOptions(dir, addonBytes, manifestPath, double, extra = {}) {
  return {
    testOnly: true,
    addonPath: path.join(dir, "dpapi-current-user.node"),
    manifestPath,
    addonSha256: custody.sha256(addonBytes),
    loadAddon: () => double.api,
    callAcl: aclDouble,
    ...extra,
  };
}
test.after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

test("verified in-memory addon double passes hash, manifest, and API checks", () => {
  const dir = tempDir("addon-ok");
  const { addonBytes } = writeAddon(dir);
  const manifestPath = writeManifest(dir, addonBytes);
  const double = addonDouble();
  const facts = custody.readAndVerifyAddon(verifiedOptions(dir, addonBytes, manifestPath, double));
  assert.equal(facts.addon, double.api);
  assert.equal(facts.addonSha256, custody.sha256(addonBytes));
  assert.match(facts.sourceSha256, /^[0-9a-f]{64}$/u);
  assert.match(facts.buildSha256, /^[0-9a-f]{64}$/u);
});

test("addon hash mismatch is refused before the addon is loaded", () => {
  const dir = tempDir("addon-hash");
  const { addonBytes } = writeAddon(dir);
  const manifestPath = writeManifest(dir, addonBytes);
  let loaded = 0;
  assert.throws(
    () => custody.readAndVerifyAddon({ ...verifiedOptions(dir, addonBytes, manifestPath, addonDouble()), addonSha256: "0".repeat(64), loadAddon: () => { loaded += 1; return addonDouble().api; } }),
    /ADDON_HASH_MISMATCH/u,
  );
  assert.equal(loaded, 0);
});

test("addon API-shape mismatch is refused", () => {
  const dir = tempDir("addon-api");
  const { addonBytes } = writeAddon(dir);
  const manifestPath = writeManifest(dir, addonBytes);
  assert.throws(() => custody.readAndVerifyAddon({ ...verifiedOptions(dir, addonBytes, manifestPath, addonDouble()), loadAddon: () => ({ protectCurrentUser() {}, unprotectCurrentUser: 1, extra() {} }) }), /ADDON_API_INVALID/u);
});

test("build manifest tamper is refused", () => {
  const dir = tempDir("addon-manifest");
  const { addonBytes } = writeAddon(dir);
  const manifestPath = writeManifest(dir, addonBytes, { artifact: { sha256: custody.sha256(addonBytes), bytes: addonBytes.length + 1 } });
  assert.throws(() => custody.readAndVerifyAddon(verifiedOptions(dir, addonBytes, manifestPath, addonDouble())), /BUILD_MANIFEST_INVALID/u);
});

test("custody signing round-trips Ed25519 identity and zeroizes the decrypted buffer", () => {
  const dir = tempDir("sign");
  const { addonBytes } = writeAddon(dir);
  const manifestPath = writeManifest(dir, addonBytes);
  const double = addonDouble();
  const pair = crypto.generateKeyPairSync("ed25519");
  const privateDer = pair.privateKey.export({ format: "der", type: "pkcs8" });
  const cipher = double.api.protectCurrentUser(privateDer);
  privateDer.fill(0);
  const custodyPath = path.join(dir, "custody.pk8.dpapi");
  fs.writeFileSync(custodyPath, cipher, { flag: "wx" });
  const publicKeySpkiDerBase64 = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const message = Buffer.from("canonical approval message bytes", "utf8");
  const result = custody.signApprovalMessage(message, verifiedOptions(dir, addonBytes, manifestPath, double, { custodyPath, expectedPublicKeySpkiDerBase64: publicKeySpkiDerBase64 }));
  assert.equal(result.publicKeySpkiDerBase64, publicKeySpkiDerBase64);
  assert.equal(crypto.verify(null, message, pair.publicKey, result.signature), true);
  assert.equal(result.publicKeyFingerprint, `0x${custody.sha256(pair.publicKey.export({ format: "der", type: "spki" }))}`);
  assert.ok(Buffer.isBuffer(double.state.decrypted));
  assert.ok(double.state.decrypted.every((byte) => byte === 0));
});

test("custody identity mismatch is refused before signing and the key buffer still zeroizes", () => {
  const dir = tempDir("identity");
  const { addonBytes } = writeAddon(dir);
  const manifestPath = writeManifest(dir, addonBytes);
  const double = addonDouble();
  const pair = crypto.generateKeyPairSync("ed25519");
  const other = crypto.generateKeyPairSync("ed25519");
  const privateDer = pair.privateKey.export({ format: "der", type: "pkcs8" });
  const cipher = double.api.protectCurrentUser(privateDer);
  privateDer.fill(0);
  const custodyPath = path.join(dir, "custody.pk8.dpapi");
  fs.writeFileSync(custodyPath, cipher, { flag: "wx" });
  const wrongPublic = other.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  assert.throws(
    () => custody.signApprovalMessage(Buffer.from("message", "utf8"), verifiedOptions(dir, addonBytes, manifestPath, double, { custodyPath, expectedPublicKeySpkiDerBase64: wrongPublic })),
    /CUSTODY_IDENTITY_MISMATCH/u,
  );
  assert.ok(Buffer.isBuffer(double.state.decrypted));
  assert.ok(double.state.decrypted.every((byte) => byte === 0));
});

test("invalid injected SID fails closed during custody context resolution", () => {
  const dir = tempDir("sid");
  const { addonBytes } = writeAddon(dir);
  const manifestPath = writeManifest(dir, addonBytes);
  const double = addonDouble();
  const custodyPath = path.join(dir, "custody.pk8.dpapi");
  fs.writeFileSync(custodyPath, Buffer.from("opaque", "utf8"), { flag: "wx" });
  assert.throws(
    () => custody.resolveCustodyContext({ ...verifiedOptions(dir, addonBytes, manifestPath, double, { custodyPath }), callAcl: () => ({ ok: true, status: "PREFLIGHT_OK", sid: "S-1-5-18" }) }),
    /SID_INVALID/u,
  );
});
