"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const ethers = require("ethers");
const { Transaction, encodeRlp, decodeRlp, keccak256, toBeHex } = ethers;
const codec = require("../strategy-study/compound-b-metadata-codec");
const { normalizeMetadataHeader, serializeSignedTransaction } = codec;
const PUBLIC = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../reports/raw/fast/strategy-study-20261020/compound-b-public-raw-transaction.json"), "utf8"));
// Public signature scalars, never a secret/key/signing operation. Synthetic raw
// envelopes are built directly from RLP, then parser recovery supplies their from.
const R = "0x5ec5a50044d1abe8695ff25750decf96ba634da1734866477d17b3abe19d45f8";
const S = "0x5421879d81a818bff99a5185bc80d0d7b041d90179c3a216afaa4835d68320df";
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const H = byte => `0x${byte.repeat(32)}`, A = byte => `0x${byte.repeat(20)}`;
const q = n => `0x${BigInt(n).toString(16)}`, uint = n => BigInt(n) === 0n ? "0x" : toBeHex(BigInt(n));
const CONTEXT = { blockHash: H("55"), blockNumber: "0x18fb3e4", transactionIndex: "0x71" };
const SENTINEL = "CALLER_SECRET_SENTINEL";
const AL = [{ address: A("22"), storageKeys: [H("33"), H("11"), H("33")] }, { address: A("22"), storageKeys: [] }];
const AUTH = [{ chainId: "0x1", address: A("44"), nonce: "0x0", yParity: "0x0", r: R, s: S }];
function fromRaw(raw, context = CONTEXT) {
  const tx = Transaction.from(raw), sig = tx.signature;
  const body = { type: q(tx.type), chainId: q(tx.chainId), nonce: q(tx.nonce), gas: q(tx.gasLimit), to: tx.to?.toLowerCase() ?? null,
    value: q(tx.value), input: tx.data, hash: tx.hash, from: tx.from.toLowerCase(), ...context,
    v: q(tx.type === 0 ? sig.networkV ?? sig.v : sig.yParity), yParity: q(sig.yParity), r: sig.r, s: sig.s };
  if (tx.type < 2) body.gasPrice = q(tx.gasPrice);
  else { body.maxPriorityFeePerGas = q(tx.maxPriorityFeePerGas); body.maxFeePerGas = q(tx.maxFeePerGas); }
  if (tx.type > 0) body.accessList = tx.accessList.map(e => ({ address: e.address.toLowerCase(), storageKeys: e.storageKeys }));
  if (tx.type === 3) { body.maxFeePerBlobGas = q(tx.maxFeePerBlobGas); body.blobVersionedHashes = tx.blobVersionedHashes; }
  if (tx.type === 4) body.authorizationList = tx.authorizationList.map(a => ({ chainId: q(a.chainId), address: a.address.toLowerCase(), nonce: q(a.nonce),
    yParity: q(a.signature.yParity), r: a.signature.r, s: a.signature._s }));
  return body;
}
function fixture(type, opts = {}) {
  const chainId = opts.chainId ?? 1n, nonce = opts.nonce ?? 9n, parity = opts.parity ?? 0n;
  const to = opts.creation ? "0x" : A("11"), access = AL.map(e => [e.address, e.storageKeys]);
  let fields;
  if (type === 0) fields = [uint(nonce), uint(30), uint(100000), to, uint(0), "0x1234"];
  else if (type === 1) fields = [uint(chainId), uint(nonce), uint(30), uint(100000), to, uint(0), "0x1234", access];
  else fields = [uint(chainId), uint(nonce), uint(2), uint(30), uint(100000), to, uint(0), "0x1234", access];
  if (type === 3) fields.push(uint(10), [H("01"), `0x01${"ab".repeat(31)}`]);
  if (type === 4) fields.push((opts.auth ?? AUTH).map(a => [uint(a.chainId), a.address, uint(a.nonce), uint(a.yParity), uint(a.r), uint(a.s)]));
  fields.push(uint(type === 0 ? chainId === 0n ? 27n + parity : 35n + 2n * chainId + parity : parity), uint(R), uint(S));
  const raw = (type ? `0x0${type}` : "0x") + encodeRlp(fields).slice(2);
  return { raw, body: fromRaw(raw), fields };
}
function txReject(body) {
  assert.throws(() => serializeSignedTransaction(body), e => { assert.equal(e.message, "invalid-signed-transaction"); assert.equal(e.cause, undefined); assert.ok(!e.stack.includes(SENTINEL)); return true; });
}
function headerReject(raw) {
  assert.throws(() => normalizeMetadataHeader(raw), e => { assert.equal(e.message, "invalid-metadata-header"); assert.equal(e.cause, undefined); assert.ok(!e.stack.includes(SENTINEL)); return true; });
}
const BASE_KEYS = ["parentHash", "sha3Uncles", "miner", "stateRoot", "transactionsRoot", "receiptsRoot", "logsBloom", "difficulty", "number", "gasLimit", "gasUsed", "timestamp", "extraData", "mixHash", "nonce"];
const OPTIONAL = ["baseFeePerGas", "withdrawalsRoot", "blobGasUsed", "excessBlobGas", "parentBeaconBlockRoot", "requestsHash"];
function headerFixture(count = 6) {
  const header = { parentHash: H("01"), sha3Uncles: keccak256("0xc0"), miner: A("11"), stateRoot: H("22"), transactionsRoot: H("33"),
    receiptsRoot: H("44"), logsBloom: `0x${"00".repeat(256)}`, difficulty: "0x0", number: "0x18fb3e4", gasLimit: "0x3938700",
    gasUsed: "0x123456", timestamp: "0x6abcdef0", extraData: "0x012345", mixHash: H("55"), nonce: "0x0000000000000000" };
  const values = ["0x7", H("66"), "0x60000", "0x0", H("77"), H("88")];
  OPTIONAL.slice(0, count).forEach((key, i) => { header[key] = values[i]; });
  const base = [header.parentHash, header.sha3Uncles, header.miner, header.stateRoot, header.transactionsRoot, header.receiptsRoot, header.logsBloom,
    "0x", uint(header.number), uint(header.gasLimit), uint(header.gasUsed), uint(header.timestamp), header.extraData, header.mixHash, header.nonce];
  const extras = [uint(7), H("66"), uint(393216), "0x", H("77"), H("88")].slice(0, count);
  const headerRlp = encodeRlp([...base, ...extras]);
  return { raw: { hash: keccak256(headerRlp), ...header, transactions: [H("99"), H("aa"), H("bb")] }, headerRlp };
}
function assertFrozen(v) { if (v && typeof v === "object") { assert.ok(Object.isFrozen(v)); Object.values(v).forEach(assertFrozen); } }

test("exact exports, ethers pin, inert import and no ambient runtime I/O dependencies", () => {
  assert.equal(ethers.version, "6.17.0"); assert.deepEqual(Object.keys(codec), ["normalizeMetadataHeader", "serializeSignedTransaction"]); assert.ok(Object.isFrozen(codec));
  const text = fs.readFileSync(path.resolve(__dirname, "../strategy-study/compound-b-metadata-codec.js"), "utf8");
  const imports = [], module = { exports: {} };
  vm.runInNewContext(text, { module, require(name) { imports.push(name); assert.equal(name, "ethers"); return ethers; } });
  assert.deepEqual(imports, ["ethers"]); assert.deepEqual(Object.keys(module.exports), Object.keys(codec));
  const wrong = { exports: {} }; vm.runInNewContext(text, { module: wrong, require() { return { ...ethers, version: "6.16.0" }; } });
  assert.throws(() => wrong.exports.normalizeMetadataHeader({}), /invalid-metadata-header/);
  assert.throws(() => wrong.exports.serializeSignedTransaction({}), /invalid-signed-transaction/);
});

test("actual B: 629-byte execution envelope, exact hash, sender, calldata and block context roundtrip", () => {
  const raw = PUBLIC.publicSignedTransaction;
  assert.equal((raw.length - 2) / 2, 629);
  assert.equal(keccak256(raw), "0x6c77094b00da6cf33a6afb25739ec89df04f76b09c45d7ce581e1b52a45fcc47");
  const body = fromRaw(raw, { blockHash: PUBLIC.binding.blockHash, blockNumber: q(PUBLIC.binding.blockNumber), transactionIndex: q(PUBLIC.binding.transactionIndex) });
  const before = structuredClone(body), result = serializeSignedTransaction(body);
  assert.equal(result.rawTransaction, raw); assert.deepEqual(result.body, body); assert.deepEqual(body, before); assert.equal(Object.isFrozen(body), false);
  assert.equal(result.body.from, "0xb73bd7e523f89d2b945f4e8c024697acd7d88b02"); assert.equal(result.body.chainId, "0x1");
  assert.equal(result.body.gas, q(1435233)); assert.equal(result.body.nonce, "0x9"); assert.equal(result.body.transactionIndex, "0x71");
  assert.equal((result.body.input.length - 2) / 2, 516); assert.deepEqual(result.body.accessList, []);
  assert.deepEqual(serializeSignedTransaction(result.body), result); assertFrozen(result);
});

for (const type of [0, 1, 2, 3, 4]) test(`signed type ${type}: explicit adapter agrees with independent RLP, parser, hash and sender`, () => {
  for (const parity of [0n, 1n]) {
    const f = fixture(type, { parity }), before = structuredClone(f.body), result = serializeSignedTransaction(f.body);
    assert.equal(result.rawTransaction, f.raw); assert.deepEqual(result.body, f.body); assert.deepEqual(f.body, before);
    assert.deepEqual(decodeRlp(type ? `0x${result.rawTransaction.slice(4)}` : result.rawTransaction), f.fields);
    assert.equal(keccak256(result.rawTransaction), result.body.hash); assert.equal(Transaction.from(result.rawTransaction).from.toLowerCase(), result.body.from);
    assert.deepEqual(serializeSignedTransaction(result.body), result); assertFrozen(result);
  }
});

test("legacy protected/unprotected v is reconciled exactly; omitted chainId is derived only from v", () => {
  for (const chainId of [0n, 1n, 11155111n]) for (const parity of [0n, 1n]) {
    const f = fixture(0, { chainId, parity }); delete f.body.chainId; delete f.body.yParity;
    const out = serializeSignedTransaction(f.body); assert.equal(out.rawTransaction, f.raw); assert.equal(out.body.chainId, q(chainId)); assert.equal(out.body.yParity, q(parity));
  }
  for (const v of ["0x0", "0x1", "0x1a", "0x1d", "0x22", "0x23", "0x24"]) txReject({ ...fixture(0).body, v });
  txReject({ ...fixture(0).body, chainId: "0x0" }); txReject({ ...fixture(0, { chainId: 0n }).body, chainId: "0x1" });
  txReject({ ...fixture(0).body, yParity: "0x1" });
});

test("typed v/yParity aliases normalize without changing signed parity; contradictory redundancy fails", () => {
  for (const type of [1, 2, 3, 4]) for (const p of [0n, 1n]) {
    const f = fixture(type, { parity: p });
    for (const mode of ["v-only", "parity-only", "legacy-v"]) {
      const b = structuredClone(f.body);
      if (mode === "v-only") delete b.yParity;
      if (mode === "parity-only") delete b.v;
      if (mode === "legacy-v") b.v = q(27n + p);
      assert.deepEqual(serializeSignedTransaction(b), serializeSignedTransaction(f.body));
    }
    txReject({ ...f.body, v: q(1n - p) }); txReject({ ...f.body, yParity: q(27n + p) }); txReject({ ...f.body, v: "0x25" });
    const missing = { ...f.body }; delete missing.v; delete missing.yParity; txReject(missing);
  }
});

test("fee-market gasPrice is checked within signed caps then omitted; unknown provider metadata is not authority", () => {
  for (const type of [2, 3, 4]) {
    const f = fixture(type), clean = serializeSignedTransaction(f.body);
    for (const gasPrice of ["0x2", "0x17", "0x1e"]) {
      assert.deepEqual(serializeSignedTransaction({ ...f.body, gasPrice, providerAnnotation: SENTINEL, confirmations: 77 }), clean);
    }
    for (const gasPrice of [null, "0x1", "0x1f", "0x00", SENTINEL]) txReject({ ...f.body, gasPrice });
    txReject({ ...f.body, maxPriorityFeePerGas: "0x1f" });
    assert.equal(Object.hasOwn(clean.body, "gasPrice"), false);
  }
});

test("all common/type-dependent signed fields are required before any ethers defaults", () => {
  const common = ["type", "hash", "from", "to", "nonce", "gas", "value", "input", "r", "s", "blockHash", "blockNumber", "transactionIndex"];
  const needed = [["v", "gasPrice"], ["chainId", "accessList", "gasPrice"], ["chainId", "accessList", "maxFeePerGas", "maxPriorityFeePerGas"],
    ["chainId", "accessList", "maxFeePerGas", "maxPriorityFeePerGas", "maxFeePerBlobGas", "blobVersionedHashes"],
    ["chainId", "accessList", "maxFeePerGas", "maxPriorityFeePerGas", "authorizationList"]];
  for (const type of [0, 1, 2, 3, 4]) {
    const f = fixture(type);
    for (const field of [...common, ...needed[type]]) {
      const missing = structuredClone(f.body); delete missing[field]; txReject(missing);
      if (field !== "to") txReject({ ...f.body, [field]: null });
    }
  }
});

test("unsupported types and signed fields from another envelope fail closed", () => {
  const f = fixture(2).body;
  for (const type of ["0x5", "0x7e", "0x7f", null, 2, "0x", "0x02"]) txReject({ ...f, type });
  for (const [type, key, value] of [[0, "accessList", []], [1, "maxFeePerGas", "0x1"], [2, "maxFeePerBlobGas", "0x1"], [3, "authorizationList", []], [4, "blobVersionedHashes", []]]) txReject({ ...fixture(type).body, [key]: value });
  for (const key of ["blobs", "commitments", "proofs", "blobWrapperVersion", "signature", "raw", "rawTransaction"]) txReject({ ...fixture(3).body, [key]: [] });
});

test("sender/hash/signature mutations cannot acquire a valid signed envelope", () => {
  const b = fixture(2).body;
  for (const change of [{ from: A("ff") }, { hash: H("00") }, { r: "0x0" }, { s: "0x0" }, { r: q(N) }, { s: q(N / 2n + 1n) },
    { r: "0x" }, { s: `0x${"ff".repeat(33)}` }, { input: "0x123456" }, { value: "0x1" }, { chainId: "0x2" }, { nonce: "0xa" }, { gas: "0x186a1" }]) txReject({ ...b, ...change });
  const scalarB = { ...b, r: q(BigInt(b.r)), s: q(BigInt(b.s)) };
  assert.deepEqual(serializeSignedTransaction(scalarB), serializeSignedTransaction(b));
});

test("context is mandatory canonical mined metadata, not claimed cryptographically proved by the signed hash", () => {
  const b = fixture(1).body;
  for (const field of ["blockHash", "blockNumber", "transactionIndex"]) for (const value of [null, undefined, "", SENTINEL, -1, "0x00"]) txReject({ ...b, [field]: value });
  txReject({ ...b, blockHash: A("11") }); txReject({ ...b, blockNumber: "0x10000000000000000" });
  const changed = serializeSignedTransaction({ ...b, blockNumber: "0x1", transactionIndex: "0x0", blockHash: H("aa") });
  assert.equal(changed.rawTransaction, serializeSignedTransaction(b).rawTransaction); // collector owns linkage to its block/hash/index list
});

test("access lists preserve signed order/duplicates and reject malformed tuples/keys/missing members", () => {
  const b = fixture(1).body, out = serializeSignedTransaction(b);
  assert.deepEqual(out.body.accessList, AL); assert.equal(out.body.accessList[0].storageKeys[0], out.body.accessList[0].storageKeys[2]);
  for (const accessList of [null, {}, { [A("22")]: [] }, [[A("22"), []]], [{ address: A("22") }], [{ storageKeys: [] }],
    [{ address: A("22"), storageKeys: ["0x1"] }], [{ address: H("22"), storageKeys: [] }], [{ address: A("22"), storageKeys: [], extra: true }]]) txReject({ ...b, accessList });
  txReject({ ...b, accessList: [...b.accessList].reverse() });
  const altered = structuredClone(b); altered.accessList[0].storageKeys.reverse(); altered.accessList[0].storageKeys.pop(); txReject(altered);
});

test("type3 uses an execution envelope, not a network sidecar wrapper; requires recipient and versioned hashes", () => {
  const f = fixture(3), out = serializeSignedTransaction(f.body);
  assert.equal(decodeRlp(`0x${out.rawTransaction.slice(4)}`).length, 14);
  for (const blobVersionedHashes of [[], null, [H("02")], ["0x01"], [H("00")]]) txReject({ ...f.body, blobVersionedHashes });
  txReject({ ...f.body, to: null }); txReject({ ...f.body, maxFeePerBlobGas: null });
  txReject({ ...f.body, blobVersionedHashes: [...f.body.blobVersionedHashes].reverse() });
});

test("type4 authorization fields are explicit, ordered and signed, never defaulted or asserted state-valid", () => {
  const f = fixture(4), clean = serializeSignedTransaction(f.body); assert.deepEqual(clean.body.authorizationList, AUTH);
  for (const field of ["chainId", "address", "nonce", "yParity", "r", "s"]) {
    const b = structuredClone(f.body); delete b.authorizationList[0][field]; txReject(b);
  }
  for (const authorizationList of [[], null, {}, [{ ...AUTH[0], address: H("11") }], [{ ...AUTH[0], nonce: "0x10000000000000000" }],
    [{ ...AUTH[0], yParity: "0x2" }], [{ ...AUTH[0], v: "0x1" }], [{ ...AUTH[0], signature: {} }]]) txReject({ ...f.body, authorizationList });
  txReject({ ...f.body, to: null });
  const withV = structuredClone(f.body); withV.authorizationList[0].v = "0x1b";
  assert.deepEqual(serializeSignedTransaction(withV), clean);
  // A skipped/invalid authority signature is legal transaction input. Its raw
  // scalars must survive: checking authority application needs state/execution.
  const auth = [AUTH[0], { ...AUTH[0], chainId: "0x0", nonce: "0xffffffffffffffff", r: "0x0", s: q(N - 1n) }];
  const skipped = fixture(4, { auth }), retained = serializeSignedTransaction(skipped.body);
  assert.equal(retained.rawTransaction, skipped.raw); assert.equal(retained.body.authorizationList[1].s, toBeHex(N - 1n, 32));
  assert.equal(retained.body.authorizationList[1].r, H("00"));
  txReject({ ...skipped.body, authorizationList: [...skipped.body.authorizationList].reverse() });
});

test("creation is explicit null for types0/1/2, while gas/input aliases must exactly agree", () => {
  for (const type of [0, 1, 2]) {
    const f = fixture(type, { creation: true }); assert.equal(serializeSignedTransaction(f.body).rawTransaction, f.raw);
    txReject({ ...f.body, to: "0x" });
  }
  const b = fixture(2).body;
  assert.deepEqual(serializeSignedTransaction({ ...b, data: b.input, gasLimit: b.gas }), serializeSignedTransaction(b));
  txReject({ ...b, data: "0x" }); txReject({ ...b, gasLimit: "0x1" });
});

for (const [name, count, length] of [["legacy", 0, 15], ["London", 1, 16], ["Shanghai", 2, 17], ["Cancun", 5, 20], ["Prague", 6, 21]]) test(`${name} header: exact ordered ${length}-field RLP, hash, numeric zero and optional presence`, () => {
  const f = headerFixture(count), before = structuredClone(f.raw), result = normalizeMetadataHeader(f.raw);
  assert.equal(result.headerRlp, f.headerRlp); assert.equal(keccak256(result.headerRlp), result.header.hash);
  const fields = decodeRlp(result.headerRlp); assert.equal(fields.length, length); assert.equal(fields[7], "0x"); assert.equal(fields[14], "0x0000000000000000");
  assert.deepEqual(Object.keys(result.header), ["hash", ...BASE_KEYS, ...OPTIONAL.slice(0, count)]);
  assert.deepEqual(result.transactionHashes, f.raw.transactions); assert.deepEqual(f.raw, before); assert.equal(Object.isFrozen(f.raw), false); assertFrozen(result);
  assert.deepEqual(normalizeMetadataHeader({ ...result.header, transactions: result.transactionHashes }), result);
});

test("header hash mismatch, missing fixed fields and every unsupported partial/future optional layout fail", () => {
  const f = headerFixture(); headerReject({ ...f.raw, hash: H("00") }); headerReject({ ...f.raw, number: "0x1" });
  for (const key of ["hash", ...BASE_KEYS, "transactions"]) { const b = { ...f.raw }; delete b[key]; headerReject(b); }
  for (const key of OPTIONAL) { const b = { ...f.raw }; delete b[key]; headerReject(b); headerReject({ ...f.raw, [key]: null }); }
  headerReject(headerFixture(3).raw); headerReject(headerFixture(4).raw);
  headerReject({ ...f.raw, futureConsensusRoot: H("99") }); headerReject({ ...f.raw, parentBeaconRoot: H("77") });
  const legacy = headerFixture(0).raw; headerReject({ ...legacy, withdrawalsRoot: H("66") }); headerReject({ ...legacy, requestsHash: H("88") });
});

test("header fixed widths, canonical quantities, gas consistency and extraData bounds are enforced", () => {
  const b = headerFixture().raw;
  for (const [key, value] of [["miner", H("11")], ["parentHash", A("11")], ["nonce", "0x0"], ["logsBloom", H("00")], ["extraData", `0x${"00".repeat(33)}`],
    ["number", "0x00"], ["timestamp", -1], ["difficulty", "0x"], ["gasUsed", "0xffffffffffffffff"], ["stateRoot", null], ["baseFeePerGas", "0x"], ["excessBlobGas", `0x1${"0".repeat(64)}`]]) headerReject({ ...b, [key]: value });
});

test("complete ordered hashes are retained from hash-list or body-list blocks, without projecting bodies as verified", () => {
  const f = headerFixture(), expected = normalizeMetadataHeader(f.raw);
  const bodies = f.raw.transactions.map((hash, i) => ({ hash, transactionIndex: q(i), providerAnnotation: SENTINEL }));
  assert.deepEqual(normalizeMetadataHeader({ ...f.raw, transactions: bodies }), expected);
  assert.deepEqual(normalizeMetadataHeader({ ...f.raw, transactions: [] }).transactionHashes, []);
  assert.deepEqual(normalizeMetadataHeader({ ...f.raw, transactions: [...f.raw.transactions].reverse() }).transactionHashes, [...f.raw.transactions].reverse());
  for (const transactions of [null, [f.raw.transactions[0], bodies[1]], [bodies[0], f.raw.transactions[1]], [{}], [null], ["0x1234"]]) headerReject({ ...f.raw, transactions });
  assert.ok(!JSON.stringify(expected).includes(SENTINEL));
});

test("known block metadata is omitted; miner/randao aliases must exactly agree rather than invent missing fields", () => {
  const b = headerFixture().raw, expected = normalizeMetadataHeader(b);
  assert.deepEqual(normalizeMetadataHeader({ ...b, size: "0xabc", totalDifficulty: "0x0", uncles: [], withdrawals: [], author: b.miner, feeRecipient: b.miner, prevRandao: b.mixHash }), expected);
  headerReject({ ...b, author: A("22") }); headerReject({ ...b, feeRecipient: A("22") }); headerReject({ ...b, prevRandao: H("44") });
  const missing = { ...b, author: b.miner }; delete missing.miner; headerReject(missing);
});

test("hex data case canonicalizes; numeric precision is never silently narrowed", () => {
  const b = fixture(2).body, upper = structuredClone(b);
  for (const key of ["hash", "from", "input", "r", "s", "blockHash", "gas"]) upper[key] = `0x${upper[key].slice(2).toUpperCase()}`;
  assert.deepEqual(serializeSignedTransaction(upper), serializeSignedTransaction(b));
  const h = headerFixture().raw; assert.deepEqual(normalizeMetadataHeader({ ...h, timestamp: `0x${h.timestamp.slice(2).toUpperCase()}` }), normalizeMetadataHeader(h));
  for (const nonce of ["0x20000000000000", "0x10000000000000000", 9, "9", "0x09"]) txReject({ ...b, nonce });
  txReject({ ...b, gas: "0x10000000000000000" }); txReject({ ...b, value: `0x1${"0".repeat(64)}` });
});

test("bounded arrays/strings/depth and non-JSON shapes fail without partial output or caller error text", () => {
  const b = fixture(2).body, h = headerFixture().raw;
  txReject({ ...b, input: `0x${"aa".repeat(4 * 1024 * 1024)}` });
  headerReject({ ...h, transactions: Array(131073).fill(H("11")) });
  txReject({ ...b, accessList: Array(131073).fill(AL[0]) });
  let deep = {}; for (let i = 0; i < 21; i++) deep = { deep }; txReject({ ...b, metadata: deep });
  const cycle = { ...b }; cycle.loop = cycle; txReject(cycle);
  for (const value of [null, undefined, [], SENTINEL, new Date(), Object.assign(Object.create({}), b)]) txReject(value);
  const sparse = { ...h, transactions: Array(1) }; headerReject(sparse);
  const symbol = { ...b, [Symbol(SENTINEL)]: 1 }; txReject(symbol);
});

test("getters/toJSON/custom arrays are not executed and thrown caller data is sanitized", () => {
  let called = 0; const b = fixture(2).body, h = headerFixture().raw;
  const getter = { ...b }; Object.defineProperty(getter, "hash", { enumerable: true, get() { called++; throw new Error(SENTINEL); } }); txReject(getter);
  const hiddenGetter = { ...b }; Object.defineProperty(hiddenGetter, "provider", { get() { called++; throw new Error(SENTINEL); } }); txReject(hiddenGetter);
  txReject({ ...b, toJSON() { called++; throw new Error(SENTINEL); } });
  const arr = [H("11")]; arr.map = () => { called++; throw new Error(SENTINEL); }; headerReject({ ...h, transactions: arr });
  const badHeader = { ...h }; Object.defineProperty(badHeader, "miner", { enumerable: true, get() { called++; throw new Error(SENTINEL); } }); headerReject(badHeader);
  assert.equal(called, 0);
  txReject(new Proxy(b, { ownKeys() { throw new Error(SENTINEL); } }));
  assert.throws(() => serializeSignedTransaction(b, {}), /^Error: invalid-signed-transaction$/);
  assert.throws(() => normalizeMetadataHeader(h, {}), /^Error: invalid-metadata-header$/);
});
