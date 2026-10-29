"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const anchor = require("./lib/base-paper-usdplus-r16-proof-anchor");
const base = require("./lib/base-paper-usdplus-r16-proof");

const ROOT = path.resolve(__dirname, "..");
const fixturePath = path.join(ROOT, "tools/fixtures/base-paper-usdplus-r16-proof-fixtures.json");
const manifestPath = path.join(ROOT, "tools/manifests/base-paper-usdplus-r16-toolchain.json");
const modulePath = require.resolve("./lib/base-paper-usdplus-r16-proof");
const generatorPath = path.join(ROOT, "tools/generate-base-paper-usdplus-r16-independent-proof-vector.js");
const fixtures = JSON.parse(fs.readFileSync(fixturePath, "utf8")), manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const toolRequire = createRequire(path.join(ROOT, ".audit-tools/node/package.json"));
const { REQUIRED_EXISTING, ALLOW_EXCLUSION } = base._test.POLICIES;
const clone = value => JSON.parse(JSON.stringify(value));
const flip = value => `${value.slice(0, -1)}${value.endsWith("0") ? "1" : "0"}`;
const code = expected => error => error?.code === expected;
function input(name) { const row = clone(fixtures.cases[name]); return { stateRoot: row.stateRoot || fixtures.stateRoot, ...row }; }

test("anchor is the only reviewed identity and requires an externally pinned anchor hash", () => {
  const out = anchor.attestation(); assert.equal(out.reviewedIdentity, true); assert.equal(out.selfVerificationClaimed, false); assert.equal(out.externalAnchorRequired, true);
  assert.equal(out.anchorHashMustBePinnedBeforeRequire, true); assert.equal(out.runtimeGraphFileCount, manifest.runtimeGraph.length); assert.equal(Object.isFrozen(out), true);
});

test("base manifest attestation is self-consistency only", () => {
  const out = base.selfConsistencyAttestation(); assert.equal(out.selfConsistent, true); assert.equal(out.externalAnchorRequired, true); assert.equal(Object.hasOwn(out, "verified"), false);
  assert.equal(manifest.selfConsistentOnly, true); assert.equal(manifest.externalAnchorRequired, true); assert.equal(Object.hasOwn(manifest, "bindings"), false);
  assert.equal(JSON.stringify(manifest).includes("base-paper-usdplus-r16-proof-anchor.js"), false);
});

test("valid contract account plus storage inclusion and exclusion verify", async () => {
  const out = await anchor.verifyAccountProof(input("contract"), REQUIRED_EXISTING); assert.equal(out.accountIncluded, true); assert.equal(out.accountExclusionProven, false);
  assert.equal(out.rpcAccountMatched, true); assert.equal(out.codeHashMatched, true); assert.deepEqual(out.storage.map(row => [row.inclusionProven, row.exclusionProven]), [[true, false], [false, true]]);
});

test("valid EOA zero integers empty code and empty-storage-trie exclusion verify", async () => {
  const out = await anchor.verifyAccountProof(input("eoa"), REQUIRED_EXISTING); assert.equal(out.accountIncluded, true); assert.equal(out.storageProofCount, 1);
  assert.equal(out.storage[0].exclusionProven, true); assert.equal(out.storage[0].reportedZero, true);
});

test("nonempty and empty state-trie account exclusions are distinct", async () => {
  for (const name of ["accountExclusion", "emptyAccountExclusion"]) {
    const out = await anchor.verifyAccountProof(input(name), ALLOW_EXCLUSION); assert.equal(out.accountIncluded, false); assert.equal(out.accountExclusionProven, true);
    await assert.rejects(() => anchor.verifyAccountProof(input(name), REQUIRED_EXISTING), code("REQUIRED_ACCOUNT_ABSENT"));
  }
});

test("empty proof is accepted only for canonical empty trie root", async () => {
  const valid = input("emptyAccountExclusion"); await anchor.verifyAccountProof(valid, ALLOW_EXCLUSION);
  const invalid = input("contract"); invalid.accountProof = []; await assert.rejects(() => anchor.verifyAccountProof(invalid, REQUIRED_EXISTING), code("EMPTY_PROOF_NONEMPTY_ROOT"));
});

test("account policy is mandatory and closed", async () => {
  await assert.rejects(() => anchor.verifyAccountProof(input("contract")), code("ACCOUNT_POLICY_INVALID"));
  await assert.rejects(() => anchor.verifyAccountProof(input("contract"), "OPTIONAL"), code("ACCOUNT_POLICY_INVALID"));
});

test("wrong state root and raw address fail", async () => {
  const root = input("contract"); root.stateRoot = flip(root.stateRoot); await assert.rejects(() => anchor.verifyAccountProof(root, REQUIRED_EXISTING));
  const address = input("contract"); address.address = flip(address.address); await assert.rejects(() => anchor.verifyAccountProof(address, REQUIRED_EXISTING), code("REQUIRED_ACCOUNT_ABSENT"));
});

test("wrong code and every reported account field fail", async () => {
  const cases = [[x => x.code = "0x6000", "ACCOUNT_CODE_BYTES_MISMATCH"], [x => x.codeHash = flip(x.codeHash), "ACCOUNT_CODE_HASH_MISMATCH"],
    [x => x.storageHash = flip(x.storageHash), "ACCOUNT_STORAGE_ROOT_MISMATCH"], [x => x.nonce = "0x4", "ACCOUNT_NONCE_MISMATCH"], [x => x.balance = "0x1235", "ACCOUNT_BALANCE_MISMATCH"]];
  for (const [mutate, expected] of cases) { const value = input("contract"); mutate(value); await assert.rejects(() => anchor.verifyAccountProof(value, REQUIRED_EXISTING), code(expected)); }
});

test("wrong storage value root and key fail only through proven account root", async () => {
  const value = input("contract"); value.storageProof[0].value = "0x2b"; await assert.rejects(() => anchor.verifyAccountProof(value, REQUIRED_EXISTING), code("STORAGE_VALUE_MISMATCH"));
  const key = input("contract"); key.storageProof[0].key = flip(key.storageProof[0].key); await assert.rejects(() => anchor.verifyAccountProof(key, REQUIRED_EXISTING), code("STORAGE_EXCLUSION_NONZERO_MISMATCH"));
  assert.equal(Object.hasOwn(anchor, "verifyStorageEntry"), false); assert.equal(Object.hasOwn(anchor, "parseData"), false); assert.equal(Object.hasOwn(anchor, "verifyManifestSelfConsistency"), false);
});

test("mutated root node and truncated or missing descendants reject", async () => {
  const mutated = input("contract"); mutated.accountProof[0] = flip(mutated.accountProof[0]); await assert.rejects(() => anchor.verifyAccountProof(mutated, REQUIRED_EXISTING), code("PROOF_ROOT_NODE_NOT_FIRST"));
  const truncated = input("contract"); truncated.accountProof.pop(); await assert.rejects(() => anchor.verifyAccountProof(truncated, REQUIRED_EXISTING), code("MERKLE_PROOF_INVALID"));
  const missing = input("contract"); missing.accountProof.splice(1, 1); await assert.rejects(() => anchor.verifyAccountProof(missing, REQUIRED_EXISTING), code("MERKLE_PROOF_INVALID"));
});

test("malformed empty odd and oversized nodes reject before decode", async () => {
  for (const node of ["", "0x", "0x1", "0xzz"]) { const value = input("contract"); value.accountProof = [node]; await assert.rejects(() => anchor.verifyAccountProof(value, REQUIRED_EXISTING)); }
  const oversized = input("contract"); oversized.accountProof = [`0x${"g".repeat(base._test.LIMITS.maxNodeBytes * 2 + 2)}`];
  await assert.rejects(() => anchor.verifyAccountProof(oversized, REQUIRED_EXISTING), code("PROOF_NODE_BYTES_EXCEEDED"));
});

test("one invocation enforces exact total node and decoded-byte boundaries", () => {
  const limits = base._test.LIMITS, one = "0x01", max = `0x${"01".repeat(limits.maxNodeBytes)}`;
  let budget = base._test.newBudget(); base._test.parseProofNodes(Array(64).fill(one), budget); base._test.parseProofNodes(Array(64).fill(one), budget); assert.equal(budget.nodes, 128);
  assert.throws(() => base._test.parseProofNodes([one], budget), code("PROOF_TOTAL_NODE_COUNT_EXCEEDED"));
  budget = base._test.newBudget(); base._test.parseProofNodes(Array(8).fill(max), budget); base._test.parseProofNodes(Array(8).fill(max), budget); assert.equal(budget.bytes, limits.maxTotalProofBytes);
  assert.throws(() => base._test.parseProofNodes([one], budget), code("PROOF_TOTAL_BYTES_EXCEEDED"));
});

test("aggregate proof overflow is enforced across separate storage-entry parses", () => {
  const budget = base._test.newBudget(), max = `0x${"01".repeat(base._test.LIMITS.maxNodeBytes)}`;
  base._test.parseProofNodes(Array(15).fill(max), budget); base._test.parseProofNodes([max], budget); assert.equal(budget.bytes, 1024 * 1024);
  assert.throws(() => base._test.parseProofNodes(["0x01"], budget), code("PROOF_TOTAL_BYTES_EXCEEDED"));
});

test("storage entry and code bounds reject before unbounded work", async () => {
  const entries = input("contract"); entries.storageProof = Array(base._test.LIMITS.maxStorageEntries + 1).fill(entries.storageProof[0]);
  await assert.rejects(() => anchor.verifyAccountProof(entries, REQUIRED_EXISTING), code("STORAGE_ENTRY_COUNT_EXCEEDED"));
  const oversized = input("contract"); oversized.code = `0x${"g".repeat(base._test.LIMITS.maxCodeBytes * 2 + 2)}`;
  await assert.rejects(() => anchor.verifyAccountProof(oversized, REQUIRED_EXISTING), code("CODE_SIZE_EXCEEDED"));
  assert.equal(base._test.parseData(`0x${"00".repeat(base._test.LIMITS.maxCodeBytes)}`, null, base._test.LIMITS.maxCodeBytes).length, base._test.LIMITS.maxCodeBytes);
  assert.throws(() => base._test.parseData(`0x${"00".repeat(base._test.LIMITS.maxCodeBytes + 1)}`, null, base._test.LIMITS.maxCodeBytes), code("DATA_SIZE_EXCEEDED"));
});

test("root index is strict while descendant order and duplicate extras are content-addressed", async () => {
  const moved = input("contract"); [moved.accountProof[0], moved.accountProof[1]] = [moved.accountProof[1], moved.accountProof[0]]; await assert.rejects(() => anchor.verifyAccountProof(moved, REQUIRED_EXISTING), code("PROOF_ROOT_NODE_NOT_FIRST"));
  const reordered = input("contract"); [reordered.accountProof[1], reordered.accountProof[2]] = [reordered.accountProof[2], reordered.accountProof[1]]; assert.equal((await anchor.verifyAccountProof(reordered, REQUIRED_EXISTING)).wireOrderConformanceChecked, false);
  const duplicate = input("contract"); duplicate.accountProof.push(duplicate.accountProof.at(-1)); assert.equal((await anchor.verifyAccountProof(duplicate, REQUIRED_EXISTING)).wireOrderConformanceChecked, false);
});

test("strict DATA parser boundaries and negatives", () => {
  assert.equal(base._test.parseData("0x").length, 0); assert.equal(base._test.parseData("0x00ff").length, 2); assert.equal(base._test.parseData(`0x${"11".repeat(20)}`, 20).length, 20);
  for (const value of [null, "", "00", "0x0", "0xgg", "0X00"]) assert.throws(() => base._test.parseData(value), code("DATA_INVALID")); assert.throws(() => base._test.parseData("0x00", 20), code("DATA_LENGTH_INVALID"));
});

test("strict quantity parser rejects decimal empty and leading zero", () => {
  assert.equal(base._test.parseQuantity("0x0"), 0n); assert.equal(base._test.parseQuantity("0xFf"), 255n);
  for (const value of [null, "", "0x", "1", "0x00", "0x01", "0X1", "0xg"]) assert.throws(() => base._test.parseQuantity(value), code("QUANTITY_INVALID"));
});

test("fixed-width DATA rejects wrong length before invalid syntax", async () => {
  for (const bytes of [20, 32]) assert.throws(() => base._test.parseData(`0x${"g".repeat(bytes * 2 + 2)}`, bytes), code("DATA_LENGTH_INVALID"));
  const fields = [
    value => value.address = `0x${"g".repeat(42)}`,
    value => value.stateRoot = `0x${"g".repeat(66)}`,
    value => value.storageHash = `0x${"g".repeat(66)}`,
    value => value.codeHash = `0x${"g".repeat(66)}`,
    value => value.storageProof[0].key = `0x${"g".repeat(66)}`,
  ];
  for (const mutate of fields) { const value = input("contract"); mutate(value); await assert.rejects(() => anchor.verifyAccountProof(value, REQUIRED_EXISTING), code("DATA_LENGTH_INVALID")); }
});

test("quantities are capped at 256 bits before regex or BigInt", async () => {
  const maximum = `0x1${"0".repeat(63)}`, oversized = `0x1${"g".repeat(64)}`; assert.equal(base._test.parseQuantity(maximum), 1n << 252n);
  assert.throws(() => base._test.parseQuantity(oversized), code("QUANTITY_SIZE_EXCEEDED"));
  for (const mutate of [value => value.nonce = oversized, value => value.balance = oversized, value => value.storageProof[0].value = oversized]) {
    const value = input("contract"); mutate(value); await assert.rejects(() => anchor.verifyAccountProof(value, REQUIRED_EXISTING), code("QUANTITY_SIZE_EXCEEDED"));
  }
});

test("account RLP requires four flat fields and exact hash lengths", () => {
  const { encode } = toolRequire("@ethereumjs/rlp"), empty = new Uint8Array(), h = new Uint8Array(32), bad = [encode([empty, empty, h]), encode([empty, empty, h, h, empty]), encode([[empty], empty, h, h]), encode([empty, empty, new Uint8Array(31), h]), encode([empty, empty, h, new Uint8Array(31)])];
  for (const value of bad) assert.throws(() => base._test.decodeAccountRlp(value));
});

test("account RLP rejects encoded zero leading zero trailing and nonminimal forms", () => {
  const { encode } = toolRequire("@ethereumjs/rlp"), empty = new Uint8Array(), h = new Uint8Array(32);
  assert.throws(() => base._test.decodeAccountRlp(encode([Uint8Array.from([0]), empty, h, h])), code("RLP_INTEGER_NONCANONICAL"));
  assert.throws(() => base._test.decodeAccountRlp(encode([Uint8Array.from([0, 1]), empty, h, h])), code("RLP_INTEGER_NONCANONICAL"));
  const valid = encode([empty, empty, h, h]); assert.throws(() => base._test.decodeAccountRlp(Uint8Array.from([...valid, 0x80])), code("RLP_TRAILING_BYTES"));
  assert.throws(() => base._test.decodeAccountRlp(Uint8Array.from([0xf8, 0x46, ...valid.slice(2)])));
});

test("storage RLP rejects lists nested leading-zero nonminimal and trailing forms", () => {
  const { encode } = toolRequire("@ethereumjs/rlp"); assert.throws(() => base._test.decodeStorageScalar(encode([Uint8Array.from([1])])), code("RLP_TYPE_INVALID"));
  assert.throws(() => base._test.decodeStorageScalar(encode(Uint8Array.from([0, 1]))), code("RLP_INTEGER_NONCANONICAL")); assert.throws(() => base._test.decodeStorageScalar(Uint8Array.from([0x81, 0x01])), code("RLP_INVALID"));
  assert.throws(() => base._test.decodeStorageScalar(Uint8Array.from([0x01, 0x80])), code("RLP_TRAILING_BYTES"));
});

test("Ethereum Keccak empty known answer is exact", () => {
  const { keccak256 } = toolRequire("ethereum-cryptography/keccak.js"); assert.equal(Buffer.from(keccak256(new Uint8Array())).toString("hex"), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
});

function alteredReader(targetSet) {
  return (file, encoding) => { let bytes = fs.readFileSync(file); if (targetSet.has(path.resolve(file))) bytes = Buffer.concat([bytes, Buffer.from([0])]); return encoding ? bytes.toString(encoding) : bytes; };
}
function fakeStat(real, changes = {}) { const value = Object.create(Object.getPrototypeOf(real)); Object.assign(value, real, changes); return value; }

test("independent anchor rejects coordinated self-consistent substitution", () => {
  const changed = new Set(anchor._test.PINS.filter(row => ["proof-module", "fixtures", "manifest", "mpt-entry", "util-entry", "rlp-entry", "keccak-entry"].includes(row.id)).map(row => path.resolve(ROOT, ...row.path.split("/"))));
  assert.throws(() => anchor._test.validatePinnedSet({ readFile: alteredReader(changed) }), error => ["ANCHOR_FILE_CHANGED_DURING_READ", "ANCHOR_FILE_HASH_MISMATCH"].includes(error.code));
  const selfOnly = clone(manifest); selfOnly.generatedAt = "substituted-but-self-consistent"; assert.equal(base._test.verifyManifestSelfConsistency({ manifest: selfOnly }).selfConsistent, true);
});

test("anchor file guard rejects symlink nonregular multilink and realpath escape seams", () => {
  const pin = anchor._test.PINS[0], file = path.resolve(ROOT, ...pin.path.split("/")), real = fs.lstatSync(file);
  assert.throws(() => anchor._test.secureIdentity(pin, { lstat: () => ({ ...fakeStat(real), isFile: () => true, isSymbolicLink: () => true }) }), code("ANCHOR_FILE_TYPE_INVALID"));
  assert.throws(() => anchor._test.secureIdentity(pin, { lstat: () => ({ ...fakeStat(real), isFile: () => false, isSymbolicLink: () => false }) }), code("ANCHOR_FILE_TYPE_INVALID"));
  assert.throws(() => anchor._test.secureIdentity(pin, { lstat: () => fakeStat(real, { nlink: 2 }) }), code("ANCHOR_FILE_TYPE_INVALID"));
  assert.throws(() => anchor._test.secureIdentity(pin, { realpath: () => path.resolve(ROOT, "..", "escaped.js") }), code("ANCHOR_REALPATH_ESCAPE"));
});

test("anchor detects pre/post stat swap and byte swap", () => {
  const pin = anchor._test.PINS[0], file = path.resolve(ROOT, ...pin.path.split("/")), real = fs.lstatSync(file); let calls = 0;
  assert.throws(() => anchor._test.secureIdentity(pin, { lstat: () => ++calls === 1 ? real : fakeStat(real, { mtimeMs: real.mtimeMs + 1 }) }), code("ANCHOR_FILE_CHANGED_DURING_READ"));
  assert.throws(() => anchor._test.secureIdentity(pin, { readFile: alteredReader(new Set([file])) }), error => ["ANCHOR_FILE_CHANGED_DURING_READ", "ANCHOR_FILE_HASH_MISMATCH"].includes(error.code));
});

test("preloaded proof or direct public export cache entries reject", () => {
  const proofCache = { [modulePath]: {} }; assert.throws(() => anchor._test.validateInitialState({ cache: proofCache }), code("ANCHOR_PRELOADED_MODULE_REJECTED"));
  const entryPath = toolRequire.resolve("@ethereumjs/mpt"), directCache = { [entryPath]: {} }; assert.throws(() => anchor._test.validateInitialState({ cache: directCache }), code("ANCHOR_PRELOADED_MODULE_REJECTED"));
});

test("cached export mutation is detected by immutable identity snapshot", () => {
  assert.throws(() => anchor._test.validateConsumedExports([]), code("ANCHOR_CACHED_EXPORT_CHANGED")); assert.equal(Object.isFrozen(anchor), true); assert.equal(Object.isFrozen(base), true);
});

test("every manifest graph cache path and arbitrary tool-root cache path reject", () => {
  for (const row of manifest.runtimeGraph) {
    const file = path.resolve(ROOT, ...row.path.split("/")); assert.throws(() => anchor._test.validateCleanCache(manifest, { cache: { [file]: {} } }), code("ANCHOR_PRELOADED_MODULE_REJECTED"));
  }
  const unlisted = path.resolve(ROOT, ...manifest.packageMetadata[0].path.split("/")); assert.equal(manifest.runtimeGraph.some(row => path.resolve(ROOT, ...row.path.split("/")) === unlisted), false);
  assert.throws(() => anchor._test.validateCleanCache(manifest, { cache: { [unlisted]: {} } }), code("ANCHOR_PRELOADED_MODULE_REJECTED"));
});

function runChild(source) { return spawnSync(process.execPath, ["-e", source], { cwd: ROOT, encoding: "utf8", timeout: 30000 }); }
test("fresh child preloading a transitive graph module prevents anchor load", () => {
  const direct = new Set(manifest.directPackages.map(row => path.resolve(ROOT, ...row.resolvedEntry.path.split("/")))), transitive = manifest.runtimeGraph.map(row => path.resolve(ROOT, ...row.path.split("/"))).find(file => !direct.has(file));
  const result = runChild(`require(${JSON.stringify(transitive)});try{require('./tools/lib/base-paper-usdplus-r16-proof-anchor')}catch(e){process.stdout.write(e.code||'bad')}`);
  assert.equal(result.status, 0); assert.equal(result.stdout, "ANCHOR_PRELOADED_MODULE_REJECTED");
});

test("fresh child preloading and mutating RLP encode prevents anchor load", () => {
  const result = runChild(`const{createRequire}=require('node:module'),p=require('node:path'),r=createRequire(p.resolve('.audit-tools/node/package.json')),x=r('@ethereumjs/rlp');x.encode=()=>new Uint8Array();try{require('./tools/lib/base-paper-usdplus-r16-proof-anchor')}catch(e){process.stdout.write(e.code||'bad')}`);
  assert.equal(result.status, 0); assert.equal(result.stdout, "ANCHOR_PRELOADED_MODULE_REJECTED");
});

test("clean child detects actual RLP consumed-export mutation on next guard", () => {
  const result = runChild(`const a=require('./tools/lib/base-paper-usdplus-r16-proof-anchor'),{createRequire}=require('node:module'),p=require('node:path'),r=createRequire(p.resolve('.audit-tools/node/package.json')),x=r('@ethereumjs/rlp');x.encode=()=>new Uint8Array();try{a._test.guard()}catch(e){process.stdout.write(e.code||'bad')}`);
  assert.equal(result.status, 0); assert.equal(result.stdout, "ANCHOR_CACHED_EXPORT_CHANGED");
});

test("clean child detects another consumed function mutation", () => {
  const result = runChild(`const a=require('./tools/lib/base-paper-usdplus-r16-proof-anchor'),{createRequire}=require('node:module'),p=require('node:path'),r=createRequire(p.resolve('.audit-tools/node/package.json')),m=r.resolve('@ethereumjs/mpt'),x=require.cache[m];x.exports={...x.exports,verifyMerkleProof:async()=>null};try{a._test.guard()}catch(e){process.stdout.write(e.code||'bad')}`);
  assert.equal(result.status, 0); assert.equal(result.stdout, "ANCHOR_CACHED_EXPORT_CHANGED");
});

test("add delete redefine and replace consumed property classes reject", () => {
  const module = require.cache[toolRequire.resolve("@ethereumjs/rlp")], exportsObject = module.exports, original = Object.getOwnPropertyDescriptor(exportsObject, "encode");
  const exercise = mutate => { try { mutate(); assert.throws(() => anchor._test.guard(), code("ANCHOR_CACHED_EXPORT_CHANGED")); } finally { Object.defineProperty(exportsObject, "encode", original); } assert.equal(anchor._test.guard(), true); };
  exercise(() => { delete exportsObject.encode; exportsObject.encode = () => new Uint8Array(); });
  exercise(() => { delete exportsObject.encode; });
  exercise(() => Object.defineProperty(exportsObject, "encode", { ...original, enumerable: !original.enumerable }));
  exercise(() => Object.defineProperty(exportsObject, "encode", { ...original, value: () => new Uint8Array() }));
});

test("out-of-root or lazy require-cache child rejects complete graph", () => {
  const rootModule = require.cache[modulePath], fake = { filename: path.resolve(ROOT, "outside-lazy.js"), children: [] }; rootModule.children.push(fake);
  try { assert.throws(() => anchor._test.guard(), code("ANCHOR_RUNTIME_GRAPH_MISMATCH")); } finally { rootModule.children.pop(); }
  assert.equal(anchor._test.guard(), true);
});

test("manifest resolution version closure and package hashes fail self-consistency", () => {
  const resolution = clone(manifest); resolution.directPackages[0].resolvedEntry.path = resolution.directPackages[1].resolvedEntry.path; assert.throws(() => base._test.verifyManifestSelfConsistency({ manifest: resolution }), code("TOOLCHAIN_RESOLUTION_MISMATCH"));
  const version = clone(manifest); version.directPackages[0].version = "10.1.0"; assert.throws(() => base._test.verifyManifestSelfConsistency({ manifest: version }), code("TOOLCHAIN_VERSION_MISMATCH"));
  const closure = clone(manifest); closure.runtimeGraph[0].sha256 = "00".repeat(32); assert.throws(() => base._test.verifyManifestSelfConsistency({ manifest: closure }), code("TOOLCHAIN_FILE_HASH_MISMATCH"));
  const packageFile = path.resolve(ROOT, ...manifest.directPackages[0].packageJson.path.split("/")); assert.throws(() => base._test.verifyManifestSelfConsistency({ manifest, readFile: alteredReader(new Set([packageFile])) }), code("TOOLCHAIN_FILE_HASH_MISMATCH"));
});

test("independent manual secure account/storage vector verifies", async () => {
  const vector = clone(fixtures.independentVector), out = await anchor.verifyAccountProof({ stateRoot: vector.stateRoot, ...vector.account }, REQUIRED_EXISTING);
  assert.equal(out.accountIncluded, true); assert.equal(out.storage[0].inclusionProven, true); assert.equal(vector.provenance.ethereumjsMptImported, false); assert.equal(vector.provenance.verifierImported, false);
});

test("independent generator check recreates frozen vector without writes", () => {
  const before = fs.statSync(fixturePath), result = spawnSync(process.execPath, [generatorPath, "--check"], { cwd: ROOT, encoding: "utf8", timeout: 30000 }), after = fs.statSync(fixturePath);
  assert.equal(result.status, 0); assert.equal(result.stdout.trim(), "R16_INDEPENDENT_VECTOR_OK"); assert.equal(before.size, after.size); assert.equal(before.mtimeMs, after.mtimeMs);
  const source = fs.readFileSync(generatorPath, "utf8"); assert.equal(/@ethereumjs\/(?:mpt|util)|require\([^\n]*base-paper-usdplus-r16-proof(?:-anchor)?/.test(source), false);
});

test("production surface and attestations expose no promotion or injection fields", async () => {
  const out = await anchor.verifyAccountProof(input("contract"), REQUIRED_EXISTING), forbidden = /(?:production|fork|route|executable|quote|profit|signing|broadcast|endpoint|\bPASS\b|readFile|manifest)/i;
  assert.deepEqual(Object.keys(anchor).sort(), ["_test", "attestation", "verifyAccountProof"]); assert.equal(forbidden.test(JSON.stringify(Object.keys(anchor).filter(key => key !== "_test"))), false);
  assert.equal(forbidden.test(JSON.stringify(out)), false); assert.equal(out.wireOrderConformanceChecked, false);
  assert.deepEqual(fixtures.metadata.caseCounts, { accountInclusion: 3, accountExclusion: 2, storageInclusion: 2, storageExclusion: 2 });
});

test("attestation states the bounded claims and active-writer threat nonclaims", () => {
  const out = anchor.attestation(); assert.deepEqual(out.claims, { cleanInitialPinnedGraphLoad: true, consumedExportMutationChecks: true, boundedHostileProofInputs: true, persistentOrdinaryMutationDetection: true });
  assert.deepEqual(out.nonclaims, { raceFreeHashToRequireLoading: false, activeConcurrentAuthorizedFilesystemWriterResistance: false,
    transientAsyncSameProcessMutationRestoredBeforeGuardDetection: false, adminKernelCompromiseResistance: false });
  assert.equal(out.selfVerificationClaimed, false); assert.equal(out.anchorHashMustBePinnedBeforeRequire, true);
});
