#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const common = require("./polygon-robin-runtime-r2-common");
const pkg = require("./polygon-robin-runtime-r2-package");
const capture = require("./polygon-robin-runtime-r2-capture");
const validator = require("./polygon-robin-runtime-r2-validate");

const PASS = "ROBIN_RUNTIME_R2_EXPORT_PASS";
const FAIL = "ROBIN_RUNTIME_R2_EXPORT_FAIL";
const ALLOWLIST = Object.freeze(["capture.json", "diagnostic.json", "terminal-manifest.json", "validation.json", "validation-seal.json"]);
async function assertMirrorDirectory(out, options = {}) { const parent = path.dirname(out), expectedParent = path.resolve(options.expectedParent || `/mnt/c/_Work/__EVM_AUDIT/${pkg.PACKAGE_REL}`), resolvedParent = path.resolve(parent); if (resolvedParent !== expectedParent) common.fail("PATH_INVALID"); const parentStat = await fsp.lstat(parent), parentReal = await fsp.realpath(parent); if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || path.resolve(parentReal) !== expectedParent) common.fail("PATH_INVALID");
  try { await fsp.mkdir(out, { mode: 0o700 }); } catch (error) { if (error?.code !== "EEXIST") throw error; } const row = await fsp.lstat(out), real = await fsp.realpath(out); if (!row.isDirectory() || row.isSymbolicLink() || path.resolve(real) !== path.resolve(out) || path.dirname(path.resolve(real)) !== expectedParent) common.fail("PATH_INVALID"); return true; }
async function exportMirror(options = {}) {
  const root = options.root || pkg.ROOT; if (!options.skipStartup) common.assertCleanStartup(); await (options.validateAndPublish || validator.validateAndPublish)({ ...options, root }); const p = capture.paths(root), lifecycle = p.lifecycle, sealPath = path.join(lifecycle, "validation-seal.json"), fixed = await capture.verifyRuntimeRoot(root, options);
  if (process.platform !== "linux" || root.startsWith("/mnt/c/") || !fs.existsSync(p.terminal) || !fs.existsSync(sealPath)) common.fail("TERMINAL_DURABILITY_UNPROVEN");
  const validationSealBytes = (await common.secureRead(sealPath, { uid: fixed.user.uid, cap: common.CAPS.outputLifecycleBytes })).bytes, validationSeal = common.parseCanonicalJson(validationSealBytes); if (validationSeal.canonical !== true || validationSeal.executionId !== common.EXECUTION_ID) common.fail("TERMINAL_DURABILITY_UNPROVEN");
  const selected = ALLOWLIST.filter((name) => fs.existsSync(path.join(lifecycle, name))); if (!selected.includes("terminal-manifest.json") || !selected.includes("validation.json") || !selected.includes("validation-seal.json") || selected.includes("capture.json") === selected.includes("diagnostic.json")) common.fail("TERMINAL_DURABILITY_UNPROVEN");
  const out = options.out || `/mnt/c/_Work/__EVM_AUDIT/${pkg.PACKAGE_REL}/mirror`; await assertMirrorDirectory(out, options); const records = [];
  for (const name of selected) { if (!ALLOWLIST.includes(name)) common.fail("RAW_PERSISTENCE"); const bytes = (await common.secureRead(path.join(lifecycle, name), { uid: fixed.user.uid, cap: common.CAPS.outputCaptureBytes })).bytes, parsed = common.parseCanonicalJson(bytes, common.CAPS.outputCaptureBytes); common.scanSanitized(bytes, name === "capture.json" ? { allowedAddresses: capture.allowedAddresses(parsed,fixed.authority) } : {});
    const target = path.join(out, name); common.requireDurable(await common.v9fsCreate(target, bytes, { authenticateExisting: async (file, expected) => (await common.secureRead(file, { cap: common.CAPS.outputCaptureBytes, mode: null })).bytes.equals(expected) })); records.push({ path: name, bytes: bytes.length, sha256: common.sha256(bytes) }); }
  records.sort((a, b) => a.path.localeCompare(b.path)); const manifest = { schemaVersion: "robin-runtime-r2/mirror-manifest-v1", claimId: common.STEM, executionId: common.EXECUTION_ID, canonical: false,
    sourceCanonical: true, canonicalValidationSealSha256: common.sha256(validationSealBytes), fileHashes: records, aggregateSha256: common.sha256(Buffer.from(common.canonical(records))),
    exportChangesCaptureState: false, retryCaptureOnExportFailure: false, publication: { exclusiveFileCreateFsyncReadback: true, resumableAuthenticatedPartial: true, v9fsParentDurabilityClaim: false, ext4DirectoryFsyncClaim: false } };
  const manifestBytes = Buffer.from(`${common.canonical(manifest)}\n`); common.scanSanitized(manifestBytes); common.requireDurable(await common.v9fsCreate(path.join(out, "mirror-manifest.json"), manifestBytes, { authenticateExisting: async (file, expected) => (await common.secureRead(file, { cap: common.CAPS.outputLifecycleBytes, mode: null })).bytes.equals(expected) })); return manifest;
}
async function main(argv = process.argv.slice(2)) { if (argv.length !== 1 || argv[0] !== "--export") common.fail("ARGUMENTS_INVALID"); await exportMirror(); process.stdout.write(`${PASS}\n`); }
module.exports = { PASS, FAIL, ALLOWLIST, assertMirrorDirectory, exportMirror, main };
if (require.main === module) main().catch(() => { process.stdout.write(`${FAIL}\n`); process.exitCode = 1; });
