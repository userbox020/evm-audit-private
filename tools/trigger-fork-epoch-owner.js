"use strict";

/*
 * tools/trigger-fork-epoch-owner.js — PHASE A owner CLI (production interface,
 * fail-closed).
 *
 * There is NO flag that can activate an owner: "A CLI flag, disk approval/
 * manifest or scheduler cannot activate." Any attempted --apply /
 * --auto-approve / --approval-file style flag is refused with the fixed code
 * OWNER_CLI_ACTIVATION_FLAG_REFUSED before anything runs.
 *
 * Modes:
 *   node tools/trigger-fork-epoch-owner.js --check-platform --probe-dir <dir>
 *     - Explicitly requested REAL native probe run (tools/native/
 *       trigger-fork-epoch-platform.ps1, fixed absolute module path) inside the
 *       caller-supplied directory; the platform library confines probeDir under
 *       os.tmpdir(). Prints the measured per-capability OBSERVED facts and the
 *       unmeasured guarantees. Exit 0 when the probe ran; exit 1 when it did not.
 *   node tools/trigger-fork-epoch-owner.js --manifest <file>
 *     - production epoch run: the platform adapter factory ALWAYS reports
 *       PLATFORM_RUNTIME_UNIMPLEMENTED in phase A (no qualified persistent
 *       owner-aligned native host exists), so the CLI prints the exact fixed
 *       blocker and exits 3 BEFORE any journal/prepare/activation side effect.
 *       This is the truthful unsupported-platform behavior; no fake approval
 *       path can bypass it.
 */

const fs = require("node:fs");
const platformModule = require("./lib/trigger-fork-epoch-platform.js");
const ownerModule = require("./lib/trigger-fork-epoch-owner.js");

const OWNER_CLI_BLOCKERS = Object.freeze({
  OWNER_CLI_ACTIVATION_FLAG_REFUSED: "OWNER_CLI_ACTIVATION_FLAG_REFUSED",
  OWNER_CLI_MANIFEST_UNREADABLE: "OWNER_CLI_MANIFEST_UNREADABLE",
  OWNER_CLI_PROBE_DIR_REQUIRED: "OWNER_CLI_PROBE_DIR_REQUIRED",
  OWNER_CLI_UNKNOWN_FLAG: "OWNER_CLI_UNKNOWN_FLAG",
  OWNER_CLI_PLATFORM_BLOCKED: "OWNER_CLI_PLATFORM_BLOCKED"
});

function printHelp() {
  process.stdout.write(
    "trigger-fork-epoch-owner — PHASE A finite epoch owner CLI (fail-closed)\n" +
    "usage:\n" +
    "  --check-platform --probe-dir <existing temp dir>   run the REAL native probe\n" +
    "  --manifest <file>                                  production run (platform-gated)\n" +
    "No flag can activate an epoch; approval is attended stdin only, and in phase A\n" +
    "the production adapter reports PLATFORM_RUNTIME_UNIMPLEMENTED.\n");
}
function emit(code) { process.stdout.write(`${code}\n`); }

function main(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply" || arg === "--auto-approve" || arg === "--approval-file" ||
        arg === "--scheduler-trigger" || arg === "--auto-activate") {
      emit(OWNER_CLI_BLOCKERS.OWNER_CLI_ACTIVATION_FLAG_REFUSED);
      return 2;
    }
    if (arg === "--help" || arg === "-h") { printHelp(); return 0; }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (key === "check-platform") { args.checkPlatform = true; continue; }
      if (key === "manifest" || key === "journal-path" || key === "probe-dir") {
        args[key] = argv[i + 1]; i += 1; continue;
      }
      emit(OWNER_CLI_BLOCKERS.OWNER_CLI_UNKNOWN_FLAG);
      return 2;
    }
    args._.push(arg);
  }
  if (args._.length !== 0) {
    emit(OWNER_CLI_BLOCKERS.OWNER_CLI_UNKNOWN_FLAG);
    return 2;
  }
  if (args.checkPlatform) {
    return checkPlatform(args);
  }
  if (args.manifest) {
    return productionRun(args);
  }
  printHelp();
  return 0;
}

function checkPlatform(args) {
  if (typeof args["probe-dir"] !== "string" ||
      !fs.existsSync(args["probe-dir"]) ||
      !fs.statSync(args["probe-dir"]).isDirectory()) {
    emit(OWNER_CLI_BLOCKERS.OWNER_CLI_PROBE_DIR_REQUIRED);
    return 2;
  }
  const probe = platformModule.runActualNativeProbe({
    probeDir: args["probe-dir"]
  });
  if (!probe.ok) {
    process.stdout.write(`${probe.code}\n`);
    return 1;
  }
  const evidence = platformModule.buildQualificationEvidence(probe);
  if (!evidence.ok) {
    process.stdout.write(`${evidence.code}\n`);
    return 1;
  }
  process.stdout.write(JSON.stringify({
    platform: probe.platform,
    elevated: probe.elevated,
    scopeNote: "per-call OBSERVED facts; none imply production readiness",
    evidence: evidence.evidence
  }, null, 2) + "\n");
  /* honestly: the production runtime remains blocked in phase A */
  const blocked = platformModule.createProductionPlatformAdapter();
  process.stdout.write(JSON.stringify({
    productionAdapter: blocked.code,
    description: blocked.description
  }) + "\n");
  return 0;
}

function productionRun(args) {
  // Static blocker BEFORE any manifest read, journal creation or activation.
  /* production adapter: ALWAYS the fixed blocker in phase A, no caller input */
  const blocked = platformModule.createProductionPlatformAdapter();
  process.stdout.write(JSON.stringify({
    readiness: "NOT_READY",
    blocker: blocked.code,
    description: blocked.description,
    requiredCapabilities: blocked.requiredCapabilities
  }, null, 2) + "\n");
  return 3;
}

module.exports = Object.freeze({ OWNER_CLI_BLOCKERS, main });

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
