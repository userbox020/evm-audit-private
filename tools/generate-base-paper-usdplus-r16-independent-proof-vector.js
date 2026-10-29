"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { getBytes, hexlify, keccak256 } = require("ethers");

const ROOT = path.resolve(__dirname, "..");
const FIXTURE = path.join(ROOT, "tools/fixtures/base-paper-usdplus-r16-proof-fixtures.json");

function concat(parts) { return Uint8Array.from(Buffer.concat(parts.map(value => Buffer.from(value)))); }
function lengthPrefix(length, offset) {
  if (length < 56) return Uint8Array.from([offset + length]);
  let hex = length.toString(16); if (hex.length % 2) hex = `0${hex}`;
  const bytes = getBytes(`0x${hex}`); return concat([Uint8Array.from([offset + 55 + bytes.length]), bytes]);
}
function rlpBytes(value) {
  const bytes = value instanceof Uint8Array ? value : getBytes(value);
  if (bytes.length === 1 && bytes[0] < 128) return bytes;
  return concat([lengthPrefix(bytes.length, 128), bytes]);
}
function rlpList(values) {
  const body = concat(values.map(value => Array.isArray(value) ? rlpList(value) : rlpBytes(value)));
  return concat([lengthPrefix(body.length, 192), body]);
}
function quantityBytes(value) {
  const number = BigInt(value); if (number === 0n) return new Uint8Array();
  let hex = number.toString(16); if (hex.length % 2) hex = `0${hex}`; return getBytes(`0x${hex}`);
}
function secureLeaf(rawKey, value) {
  const hashedKey = getBytes(keccak256(rawKey));
  const compactLeafPath = concat([Uint8Array.from([0x20]), hashedKey]);
  const encoded = rlpList([compactLeafPath, value]);
  return { encoded, root: keccak256(encoded) };
}
function buildVector() {
  const address = getBytes("0x4444444444444444444444444444444444444444");
  const slot = getBytes(`0x${"00".repeat(31)}09`), code = getBytes("0x6002600055"), storageValue = rlpBytes(quantityBytes(77));
  const storageLeaf = secureLeaf(slot, storageValue);
  const accountValue = rlpList([quantityBytes(1), quantityBytes(99), getBytes(storageLeaf.root), getBytes(keccak256(code))]);
  const accountLeaf = secureLeaf(address, accountValue);
  return {
    provenance: { construction: "manual-single-leaf-secure-mpt", secureKeyHashing: "raw-key-keccak256-exactly-once", compactHexPrefix: "explicit-even-terminating-0x20",
      rlp: "self-contained-canonical-encoder", keccak: "ethers-public-keccak256", ethereumjsMptImported: false, verifierImported: false, anchorImported: false },
    stateRoot: accountLeaf.root, account: { address: hexlify(address), accountProof: [hexlify(accountLeaf.encoded)], code: hexlify(code), nonce: "0x1", balance: "0x63",
      storageHash: storageLeaf.root, codeHash: keccak256(code), storageProof: [{ kind: "inclusion", key: hexlify(slot), value: "0x4d", proof: [hexlify(storageLeaf.encoded)] }] }
  };
}
function check() {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8")), actual = JSON.stringify(buildVector()), expected = JSON.stringify(fixture.independentVector);
  if (actual !== expected) throw new Error("INDEPENDENT_VECTOR_MISMATCH");
  return true;
}
function main(argv) {
  if (argv.length !== 1 || argv[0] !== "--check") throw new Error("EXPLICIT_CHECK_REQUIRED");
  check(); process.stdout.write("R16_INDEPENDENT_VECTOR_OK\n");
}

module.exports = Object.freeze({ buildVector, check, _test: Object.freeze({ lengthPrefix, rlpBytes, rlpList, secureLeaf }) });
if (require.main === module) { try { main(process.argv.slice(2)); } catch (_) { process.stderr.write("R16_INDEPENDENT_VECTOR_FAILED\n"); process.exitCode = 1; } }
