#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");

const RELEASE_NODE = "/home/mruserbox/.local/share/evm-audit/morpho-pt-post-expiry-r4-pre-go-diagnostic/runtime/bin/node";
const RELEASE_CHILD = "/home/mruserbox/.local/share/evm-audit/morpho-pt-post-expiry-r4-pre-go-diagnostic/tools/morpho-pt-27aug2026-post-expiry-r4-pre-go-diagnostic-child.js";
const UNIT_NODE = "/tmp/morpho-pt-post-expiry-r4-pre-go-diagnostic-unit/runtime/bin/node";
const UNIT_CHILD = "/tmp/morpho-pt-post-expiry-r4-pre-go-diagnostic-unit/tools/morpho-pt-27aug2026-post-expiry-r4-pre-go-diagnostic-child.js";
const NONCE_HEX = "9f89d722f2d38f89449999133b57d7061c5816fddea8344eaba0646f1832eac1";
const NODE_VERSION = "v24.13.0";
const NONCE = Buffer.from(NONCE_HEX, "hex");
const METADATA = Buffer.from("89ed26306cbe952880df8e234c060655f575564e80c78e399ee9f34803d501eb", "hex");
const PRELUDE_MAGIC = Buffer.from("R4DGPL01", "ascii"), PRELUDE_END = Buffer.from("R4DGPEND", "ascii");
const GO_MAGIC = Buffer.from("R4DGGO01", "ascii"), GO_END = Buffer.from("R4DGGEND", "ascii");
const DIAG_MAGIC = Buffer.from("R4DGCH01", "ascii"), DIAG_END = Buffer.from("R4DGCEND", "ascii");
const PRELUDE_DOMAIN = Buffer.from("morpho-r4-step2/prelude-commitment/v1\0", "ascii");

function hash(domain, bytes) { return crypto.createHash("sha256").update(domain).update(bytes).digest(); }
function readFrame(fd, size) {
  const bytes = Buffer.alloc(size + 1); let used = 0;
  while (used < bytes.length) { const count = fs.readSync(fd, bytes, used, bytes.length - used, null); if (count === 0) break; used += count; }
  return { exact: used === size, frame: used >= size ? bytes.subarray(0, size) : null };
}
function readExactEof(fd, size) { const received = readFrame(fd, size); if (!received.exact) throw new Error("FRAME"); return received.frame; }
function writeAll(fd, bytes) { let offset = 0; while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset); }
function exactInvocation() {
  const release = process.execPath === RELEASE_NODE && __filename === RELEASE_CHILD, unit = process.execPath === UNIT_NODE && __filename === UNIT_CHILD;
  if ((!release && !unit) || process.version !== NODE_VERSION || process.argv.length !== 3 || process.argv[0] !== process.execPath || process.argv[1] !== __filename || process.argv[2] !== "--mode=synthetic-pre-go-v1" || process.execArgv.length !== 0) return false;
  const expected = { LANG: "C", LC_ALL: "C", PATH: "", TZ: "UTC" }, keys = Object.keys(process.env).sort();
  if (JSON.stringify(keys) !== JSON.stringify(Object.keys(expected).sort())) return false; for (const key of keys) if (process.env[key] !== expected[key]) return false;
  try { const s0 = fs.fstatSync(0), s1 = fs.fstatSync(1), s2 = fs.fstatSync(2), s3 = fs.fstatSync(3), s4 = fs.fstatSync(4), s5 = fs.fstatSync(5), dn = fs.statSync("/dev/null"); return s0.isFIFO() && s3.isFIFO() && s4.isFIFO() && s5.isFIFO() && s1.isCharacterDevice() && s2.isCharacterDevice() && s1.dev === dn.dev && s1.ino === dn.ino && s1.rdev === dn.rdev && s2.dev === dn.dev && s2.ino === dn.ino && s2.rdev === dn.rdev && new Set([`${s0.dev}:${s0.ino}`, `${s3.dev}:${s3.ino}`, `${s4.dev}:${s4.ino}`, `${s5.dev}:${s5.ino}`]).size === 4; } catch (_) { return false; }
}
function validPrelude(frame) {
  return frame.length === 192 && frame.subarray(0, 8).equals(PRELUDE_MAGIC) && frame.readUInt32LE(8) === 1 && frame.readUInt32LE(12) === 2 && frame.readUInt32LE(16) === 1 && frame.readUInt32LE(20) === 0 && frame.subarray(24, 56).equals(NONCE) && !frame.subarray(56, 88).equals(Buffer.alloc(32)) && !frame.subarray(88, 120).equals(Buffer.alloc(32)) && frame.subarray(120, 152).equals(METADATA) && !frame.subarray(152, 184).equals(Buffer.alloc(32)) && frame.subarray(184, 192).equals(PRELUDE_END);
}
function diagnostic(code, commitment) { const frame = Buffer.alloc(64); DIAG_MAGIC.copy(frame, 0); frame.writeUInt32LE(1, 8); frame.writeUInt32LE(5, 12); frame.writeUInt32LE(code, 16); commitment.copy(frame, 24); DIAG_END.copy(frame, 56); return frame; }
function fail(code, commitment = Buffer.alloc(32)) { try { writeAll(5, diagnostic(code, commitment)); } catch (_) {} try { fs.closeSync(4); } catch (_) {} try { fs.closeSync(5); } catch (_) {} process.exitCode = 2; }
function main() {
  let prelude, commitment;
  try {
    if (!exactInvocation()) return fail(0x00030007);
    const nonce = readExactEof(0, 64); if (nonce.toString("ascii") !== NONCE_HEX) return fail(0x00030007);
    const received = readFrame(3, 192); prelude = received.frame; if (prelude) commitment = hash(PRELUDE_DOMAIN, prelude); if (!received.exact || !validPrelude(prelude)) return fail(0x00030007, commitment || Buffer.alloc(32));
    const go = Buffer.alloc(192); GO_MAGIC.copy(go, 0); go.writeUInt32LE(1, 8); go.writeUInt32LE(3, 12); go.writeUInt32LE(1, 16); NONCE.copy(go, 24); prelude.copy(go, 56, 56, 152); commitment.copy(go, 152); GO_END.copy(go, 184);
    try { writeAll(4, go); fs.closeSync(4); fs.closeSync(5); process.exitCode = 0; } catch (_) { fail(0x00030008, commitment); }
  } catch (_) { fail(commitment ? 0x00030008 : 0x00030007, commitment || Buffer.alloc(32)); }
}
main();
