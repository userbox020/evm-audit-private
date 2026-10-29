#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const batch = require("../live-execution-batch.js");
const author = require("../live-execution-batch-author-win32.js");

const NOW_MS = Date.parse("2026-09-12T12:00:00.000Z");
const ACCOUNT = "0x1111111111111111111111111111111111111111";
const OTHER_ACCOUNT = "0x9999999999999999999999999999999999999999";
const TARGET = "0x2222222222222222222222222222222222222222";
const OTHER_TARGET = "0x3333333333333333333333333333333333333333";
const DATA = `0xa9059cbb${"0".repeat(64)}`;
const ATTESTATION = `0x${"ab".repeat(32)}`;

function v3Scope(overrides = {}) {
  return {
    schema: batch.SCHEMA_V3,
    batchId: "a1b2c3d4e5f60718",
    mode: "TESTNET",
    chainId: "1",
    accountRef: ACCOUNT,
    actions: [{ from: ACCOUNT, to: TARGET, valueWei: "0", data: DATA, gasLimit: "100000", slippageBps: "50" }],
    gasCeiling: "1000000",
    feeCap: { maxFeePerGasWei: "1000000000", maxPriorityFeePerGasWei: "1000000000" },
    issuedAt: "2026-09-12T00:00:00.000Z",
    notBefore: "2026-09-12T00:00:00.000Z",
    expiresAt: "2026-09-13T00:00:00.000Z",
    nonce: "0123456789abcdef",
    ...overrides,
  };
}
function productionScope(overrides = {}) {
  return v3Scope({ mode: "PRODUCTION", testnetAttestation: ATTESTATION, ...overrides });
}
function v2Scope(overrides = {}) {
  return {
    schema: batch.SCHEMA,
    batchId: "a1b2c3d4e5f60718",
    mode: "FORK_TESTNET",
    chainId: "1",
    accountRef: ACCOUNT,
    actions: [{ from: ACCOUNT, to: TARGET, valueWei: "0", data: DATA, gasLimit: "100000", slippageBps: "50" }],
    gasCeiling: "1000000",
    anvil: { executablePath: path.resolve(os.tmpdir(), "synthetic-anvil.exe"), sha256: `0x${"33".repeat(32)}`, version: "anvil test-version" },
    issuedAt: "2026-09-12T00:00:00.000Z",
    notBefore: "2026-09-12T00:00:00.000Z",
    expiresAt: "2026-09-13T00:00:00.000Z",
    nonce: "0123456789abcdef",
    ...overrides,
  };
}
function makeCustodyDouble(pair) {
  const state = { calls: 0 };
  const publicKeySpkiDerBase64 = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const double = {
    state,
    publicKeySpkiDerBase64,
    signApprovalMessage(message) {
      state.calls += 1;
      return { signature: crypto.sign(null, message, pair.privateKey), publicKeySpkiDerBase64 };
    },
  };
  return double;
}
function tempEnv(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "batch-author-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pair = crypto.generateKeyPairSync("ed25519");
  const registryPath = path.join(dir, "live-execution-approvers.json");
  const publicKeySpkiDerBase64 = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  fs.writeFileSync(registryPath, `${JSON.stringify({ schema: batch.REGISTRY_SCHEMA, approvers: [{ approverId: author.PINNED_APPROVER_ID, algorithm: "Ed25519", publicKeySpkiDerBase64 }] }, null, 2)}\n`, { flag: "wx" });
  const registrySha256 = `0x${crypto.createHash("sha256").update(fs.readFileSync(registryPath)).digest("hex")}`;
  return { dir, pair, registryPath, registrySha256, custody: makeCustodyDouble(pair) };
}
function envOptions(env, extra = {}) {
  return { registryPath: env.registryPath, registrySha256: env.registrySha256, custody: env.custody, ...extra };
}
function writeSpec(env, scope, name = "spec.json") {
  const specPath = path.join(env.dir, name);
  fs.writeFileSync(specPath, JSON.stringify(scope), { flag: "wx" });
  return specPath;
}
function proposeTo(env, scope, name) {
  const outPath = path.join(env.dir, name);
  const result = author.propose({ specPath: writeSpec(env, scope, `${name}.spec.json`), outPath, ...envOptions(env) });
  return { result, outPath, signed: JSON.parse(fs.readFileSync(outPath, "utf8")) };
}

test("propose emits a signed scope that verifyApproval accepts and writeBatch activates", (t) => {
  const env = tempEnv(t);
  const { result, outPath, signed } = proposeTo(env, v2Scope(), "proposal.json");
  assert.equal(result.ok, true);
  assert.equal(result.status, "PROPOSED");
  const verified = batch.verifyApproval(signed, { batchPath: outPath, registryPath: env.registryPath, registrySha256: env.registrySha256 });
  assert.equal(verified.scopeCommitment, result.scopeCommitment);
  const batchPath = path.join(env.dir, "installed.json");
  batch.writeBatch(signed, { batchPath, registryPath: env.registryPath, registrySha256: env.registrySha256 });
  const state = batch.batchState({ batchPath, registryPath: env.registryPath, registrySha256: env.registrySha256, now: () => NOW_MS });
  assert.equal(state.state, batch.STATES.VALID);
});

test("tampering any signed scope field makes verifyApproval fail", (t) => {
  const env = tempEnv(t);
  const { outPath, signed } = proposeTo(env, v3Scope(), "tamper-base.json");
  assert.equal(batch.verifyApproval(signed, { batchPath: outPath, registryPath: env.registryPath, registrySha256: env.registrySha256 }).scopeCommitment, signed.approval.scopeCommitment);
  const mutations = [
    ["chainId", (b) => { b.chainId = "2"; }],
    ["accountRef", (b) => { b.accountRef = OTHER_ACCOUNT; b.actions[0].from = OTHER_ACCOUNT; }],
    ["action", (b) => { b.actions[0].to = OTHER_TARGET; }],
    ["gasCeiling", (b) => { b.gasCeiling = "1000001"; }],
    ["feeCap", (b) => { b.feeCap.maxFeePerGasWei = "1000000001"; }],
    ["expiresAt", (b) => { b.expiresAt = "2026-09-12T18:00:00.000Z"; }],
    ["nonce", (b) => { b.nonce = "fedcba9876543210"; }],
  ];
  for (const [name, mutate] of mutations) {
    const candidate = JSON.parse(JSON.stringify(signed));
    mutate(candidate);
    assert.throws(
      () => batch.verifyApproval(candidate, { batchPath: outPath, registryPath: env.registryPath, registrySha256: env.registrySha256 }),
      (error) => error instanceof batch.BatchError,
      name,
    );
  }
});

test("v3 TESTNET, v3 PRODUCTION, and v2 proposals all verify with correct domain separation", (t) => {
  const env = tempEnv(t);
  for (const [name, scope] of [["v3-testnet", v3Scope()], ["v3-production", productionScope()], ["v2", v2Scope()]]) {
    const { outPath, signed } = proposeTo(env, scope, `${name}.json`);
    assert.equal(signed.schema, scope.schema, name);
    const verified = batch.verifyApproval(signed, { batchPath: outPath, registryPath: env.registryPath, registrySha256: env.registrySha256 });
    assert.equal(verified.approverId, author.PINNED_APPROVER_ID, name);
  }
  const v3Message = batch.approvalMessage(batch.scopeCommitment(v3Scope()), { scheme: "Ed25519", approverId: author.PINNED_APPROVER_ID }, batch.SCHEMA_V3);
  const v2Message = batch.approvalMessage(batch.scopeCommitment(v2Scope()), { scheme: "Ed25519", approverId: author.PINNED_APPROVER_ID }, batch.SCHEMA);
  assert.equal(v3Message.subarray(0, batch.APPROVAL_DOMAIN_V3.length).toString("utf8"), batch.APPROVAL_DOMAIN_V3);
  assert.equal(v2Message.subarray(0, batch.APPROVAL_DOMAIN.length).toString("utf8"), batch.APPROVAL_DOMAIN);
  assert.notEqual(batch.APPROVAL_DOMAIN_V3, batch.APPROVAL_DOMAIN);
});

test("a custody key differing from the pinned registry key is refused with nothing written", (t) => {
  const env = tempEnv(t);
  const otherPair = crypto.generateKeyPairSync("ed25519");
  const outPath = path.join(env.dir, "mismatch.json");
  assert.throws(
    () => author.propose({ specPath: writeSpec(env, v2Scope(), "mismatch.spec.json"), outPath, ...envOptions(env, { custody: makeCustodyDouble(otherPair) }) }),
    (error) => error.code === "CUSTODY_IDENTITY_MISMATCH",
  );
  assert.equal(fs.existsSync(outPath), false);
});

test("propose never creates the canonical batch and never creates a terminal marker", (t) => {
  const env = tempEnv(t);
  const coordinationDir = path.dirname(batch.BATCH_PATH);
  proposeTo(env, v3Scope(), "no-activation.json");
  assert.equal(fs.existsSync(batch.BATCH_PATH), false);
  const markers = fs.readdirSync(coordinationDir).filter((name) => name.startsWith("live-execution-batch-terminal-"));
  assert.deepEqual(markers, []);
  assert.equal(batch.batchState().state, batch.STATES.ABSENT);
});

test("verify-scope matches a valid proposal, fails on drift, and never touches custody", (t) => {
  const env = tempEnv(t);
  const { outPath } = proposeTo(env, v3Scope(), "scope.json");
  const spy = makeCustodyDouble(env.pair);
  const valid = author.verifyScope({ batchPath: outPath, custody: spy });
  assert.equal(valid.ok, true);
  assert.equal(valid.matches, true);
  const drift = JSON.parse(fs.readFileSync(outPath, "utf8"));
  drift.chainId = "2";
  const driftPath = path.join(env.dir, "scope-drift.json");
  fs.writeFileSync(driftPath, JSON.stringify(drift));
  const invalid = author.verifyScope({ batchPath: driftPath, custody: spy });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.matches, false);
  assert.equal(spy.state.calls, 0);
});

test("no output or error contains key material and URL/relative/canonical arguments are rejected", (t) => {
  const env = tempEnv(t);
  const specPath = writeSpec(env, v2Scope(), "safe.spec.json");
  const outPath = path.join(env.dir, "safe-out.json");
  const privateDerBase64 = env.pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const result = author.propose({ specPath, outPath, ...envOptions(env) });
  assert.equal(JSON.stringify(result).includes(privateDerBase64), false);
  assert.equal(fs.readFileSync(outPath, "utf8").includes(privateDerBase64), false);
  const otherPair = crypto.generateKeyPairSync("ed25519");
  let thrown;
  try { author.propose({ specPath, outPath: path.join(env.dir, "error-out.json"), ...envOptions(env, { custody: makeCustodyDouble(otherPair) }) }); } catch (error) { thrown = error; }
  assert.ok(thrown);
  assert.equal(String(thrown.message).includes(privateDerBase64), false);
  assert.equal(JSON.stringify(author.publicError(thrown)).includes(privateDerBase64), false);
  assert.equal(author.publicError(thrown).code, "CUSTODY_IDENTITY_MISMATCH");
  assert.throws(() => author.propose({ specPath: "https://evil.invalid/spec.json", outPath: path.join(env.dir, "x.json"), ...envOptions(env) }), /SPEC_PATH_INVALID/u);
  assert.throws(() => author.propose({ specPath, outPath: "https://evil.invalid/out.json", ...envOptions(env) }), /OUT_PATH_INVALID/u);
  assert.throws(() => author.propose({ specPath: "relative-spec.json", outPath: path.join(env.dir, "y.json"), ...envOptions(env) }), /SPEC_PATH_INVALID/u);
  assert.throws(() => author.propose({ specPath, outPath: batch.BATCH_PATH, ...envOptions(env) }), /(?:COORDINATION_PATH_FORBIDDEN|CANONICAL_BATCH_PATH_FORBIDDEN)/u);
});

test("an unsupported schema is refused before any custody access", (t) => {
  const env = tempEnv(t);
  const spy = makeCustodyDouble(env.pair);
  const outPath = path.join(env.dir, "unsupported.json");
  assert.throws(
    () => author.propose({ specPath: writeSpec(env, v3Scope({ schema: "live-execution-batch/v4" }), "unsupported.spec.json"), outPath, ...envOptions(env, { custody: spy }) }),
    (error) => error.code === "SPEC_SCHEMA_UNSUPPORTED",
  );
  assert.equal(spy.state.calls, 0);
  assert.equal(fs.existsSync(outPath), false);
});

test("CLI accepts exactly propose and verify-scope and rejects every other surface", () => {
  assert.throws(() => author.parseCommand([]), /USAGE_ERROR/u);
  assert.throws(() => author.parseCommand(["status"]), /USAGE_ERROR/u);
  assert.throws(() => author.parseCommand(["propose", "--spec"]), /USAGE_ERROR/u);
  assert.throws(() => author.parseCommand(["propose", "--spec", "a", "--out", "b", "--extra", "c"]), /USAGE_ERROR/u);
  assert.throws(() => author.parseCommand(["verify-scope", "--spec", "a"]), /USAGE_ERROR/u);
  const parsed = author.parseCommand(["propose", "--spec", "C:\\audit\\scope.json", "--out", "C:\\audit\\approval.json"]);
  assert.equal(parsed.command, "propose");
  assert.equal(parsed.specPath, "C:\\audit\\scope.json");
  assert.equal(parsed.outPath, "C:\\audit\\approval.json");
  const verify = author.parseCommand(["verify-scope", "--batch", "C:\\audit\\approval.json"]);
  assert.equal(verify.command, "verify-scope");
  assert.equal(verify.batchPath, "C:\\audit\\approval.json");
});

// ---------------------------------------------------------------------------
// --registry override
// ---------------------------------------------------------------------------
// Deterministically simulate the platform condition that makes the canonical
// registry unreadable: the batch module's secure-descriptor gate only activates
// when process.platform === "linux" is false. Redefining the property keeps the
// suite independent of the host OS.
function withPlatform(value, fn) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value, configurable: true, enumerable: true, writable: false });
  try { return fn(); } finally { Object.defineProperty(process, "platform", descriptor); }
}
function canonicalRegistryPublicKey() {
  const registry = JSON.parse(fs.readFileSync(batch.REGISTRY_PATH, "utf8"));
  const row = registry.approvers.find((entry) => entry.approverId === author.PINNED_APPROVER_ID);
  assert.ok(row, "pinned approver must exist in the canonical registry");
  return row.publicKeySpkiDerBase64;
}
// Returns the canonical public key with an arbitrary well-formed signature; it
// satisfies identity binding so the run reaches the registry read without any
// real custody access.
function identityOnlyCustodyDouble(publicKeySpkiDerBase64) {
  const state = { calls: 0 };
  return {
    state,
    signApprovalMessage() {
      state.calls += 1;
      return { signature: Buffer.alloc(64, 7), publicKeySpkiDerBase64 };
    },
  };
}
function writeRegistryCopy(env, name) {
  const copyPath = path.join(env.dir, name);
  fs.writeFileSync(copyPath, fs.readFileSync(env.registryPath), { flag: "wx" });
  return copyPath;
}

test("propose --registry uses a byte-identical pinned registry copy for both reads and succeeds", (t) => {
  const env = tempEnv(t);
  const copyPath = writeRegistryCopy(env, "registry-copy.json");
  const specPath = writeSpec(env, v2Scope(), "copy.spec.json");
  const outPath = path.join(env.dir, "copy-out.json");
  const result = withPlatform("win32", () => author.runCli(
    ["propose", "--spec", specPath, "--out", outPath, "--registry", copyPath],
    { custody: env.custody, registrySha256: env.registrySha256 },
  ));
  assert.equal(result.ok, true);
  assert.equal(result.status, "PROPOSED");
  assert.equal(env.custody.state.calls, 1);
  const signed = JSON.parse(fs.readFileSync(outPath, "utf8"));
  const verified = batch.verifyApproval(signed, { batchPath: outPath, registryPath: copyPath, registrySha256: env.registrySha256 });
  assert.equal(verified.scopeCommitment, result.scopeCommitment);
  assert.equal(verified.approverId, author.PINNED_APPROVER_ID);
});

test("propose --registry refuses a registry copy whose bytes differ and writes nothing", (t) => {
  const env = tempEnv(t);
  const mutations = [
    ["approver-id", (bytes) => {
      const tampered = JSON.parse(bytes.toString("utf8"));
      tampered.approvers[0].approverId = "windows-local-approver-20260912-02";
      return Buffer.from(`${JSON.stringify(tampered, null, 2)}\n`, "utf8");
    }],
    ["single-byte", (bytes) => {
      const tampered = Buffer.from(bytes);
      tampered[tampered.length - 1] ^= 0x01;
      return tampered;
    }],
  ];
  for (const [name, mutate] of mutations) {
    const tamperedPath = path.join(env.dir, `registry-tampered-${name}.json`);
    fs.writeFileSync(tamperedPath, mutate(fs.readFileSync(env.registryPath)), { flag: "wx" });
    const outPath = path.join(env.dir, `tampered-out-${name}.json`);
    assert.throws(
      () => author.runCli(
        ["propose", "--spec", writeSpec(env, v2Scope(), `tampered-${name}.spec.json`), "--out", outPath, "--registry", tamperedPath],
        { custody: env.custody, registrySha256: env.registrySha256 },
      ),
      (error) => error.code === "APPROVER_REGISTRY_TRUST_ANCHOR_MISMATCH",
      name,
    );
    assert.equal(fs.existsSync(outPath), false, name);
  }
});

test("propose --registry with no injected digest is pinned to the canonical digest (refuses a non-canonical copy)", (t) => {
  const env = tempEnv(t);
  const outPath = path.join(env.dir, "canonical-pin-out.json");
  assert.throws(
    () => author.runCli(
      ["propose", "--spec", writeSpec(env, v2Scope(), "canonical-pin.spec.json"), "--out", outPath, "--registry", env.registryPath],
      { custody: env.custody },
    ),
    (error) => error.code === "APPROVER_REGISTRY_TRUST_ANCHOR_MISMATCH",
  );
  assert.equal(fs.existsSync(outPath), false);
});

test("propose --registry rejects relative, URL-like, and control-character values", (t) => {
  const env = tempEnv(t);
  const specPath = writeSpec(env, v2Scope(), "registry-invalid.spec.json");
  const outPath = path.join(env.dir, "registry-invalid-out.json");
  const rejected = [
    "relative/registry.json",
    "https://evil.invalid/registry.json",
    path.join(env.dir, "bad\u0001registry.json"),
  ];
  for (const value of rejected) {
    assert.throws(
      () => author.runCli(
        ["propose", "--spec", specPath, "--out", outPath, "--registry", value],
        { custody: env.custody, registrySha256: env.registrySha256 },
      ),
      (error) => error.code === "REGISTRY_PATH_INVALID",
      JSON.stringify(value),
    );
    assert.equal(fs.existsSync(outPath), false, JSON.stringify(value));
  }
});

test("--registry is rejected on verify-scope and unknown flags remain refused", () => {
  assert.throws(() => author.parseCommand(["verify-scope", "--batch", "C:\\x.json", "--registry", "C:\\r.json"]), /USAGE_ERROR/u);
  assert.throws(() => author.parseCommand(["verify-scope", "--registry", "C:\\r.json", "--batch", "C:\\x.json"]), /USAGE_ERROR/u);
  assert.throws(() => author.parseCommand(["propose", "--spec", "C:\\s.json", "--out", "C:\\o.json", "--registry", "C:\\r.json", "--extra", "x"]), /USAGE_ERROR/u);
  assert.throws(() => author.parseCommand(["propose", "--spec", "C:\\s.json", "--out", "C:\\o.json", "--registry"]), /USAGE_ERROR/u);
  const withRegistry = author.parseCommand(["propose", "--spec", "C:\\s.json", "--out", "C:\\o.json", "--registry", "C:\\r.json"]);
  assert.equal(withRegistry.registryPath, "C:\\r.json");
  const withoutRegistry = author.parseCommand(["propose", "--spec", "C:\\s.json", "--out", "C:\\o.json"]);
  assert.equal(withoutRegistry.registryPath, undefined);
});

test("omitting --registry keeps the canonical path and still fails closed on the secure-descriptor gate", (t) => {
  const env = tempEnv(t);
  assert.equal(author.parseCommand(["propose", "--spec", "C:\\s.json", "--out", "C:\\o.json"]).registryPath, undefined);
  const own = author.readPinnedApprover({});
  assert.equal(own.registryPath, batch.REGISTRY_PATH);
  const custody = identityOnlyCustodyDouble(canonicalRegistryPublicKey());
  const specPath = writeSpec(env, v2Scope(), "default-registry.spec.json");
  const outPath = path.join(env.dir, "default-registry-out.json");
  let thrown;
  try { withPlatform("win32", () => author.runCli(["propose", "--spec", specPath, "--out", outPath], { custody })); }
  catch (error) { thrown = error; }
  assert.ok(thrown, "canonical registry read must fail closed under the Linux-only secure-descriptor gate");
  assert.equal(thrown.code, "FILESYSTEM_SECURE_IDENTITY_UNSUPPORTED");
  assert.equal(custody.state.calls, 1);
  assert.equal(fs.existsSync(outPath), false);
});

test("--registry output never contains key material and the custody double still binds identity", (t) => {
  const env = tempEnv(t);
  const copyPath = writeRegistryCopy(env, "registry-no-keys.json");
  const specPath = writeSpec(env, v2Scope(), "no-keys.spec.json");
  const outPath = path.join(env.dir, "no-keys-out.json");
  const privateDerBase64 = env.pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const result = author.propose({ specPath, outPath, registryPath: copyPath, registrySha256: env.registrySha256, custody: env.custody });
  assert.equal(env.custody.state.calls, 1);
  assert.equal(JSON.stringify(result).includes(privateDerBase64), false);
  assert.equal(fs.readFileSync(outPath, "utf8").includes(privateDerBase64), false);
});
