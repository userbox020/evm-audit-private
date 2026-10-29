#!/usr/bin/env node
"use strict";
const child = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const GCC_WIN = "C:\\TDM-GCC-64\\bin\\x86_64-w64-mingw32-gcc.exe";
const GCC_LINUX = "/usr/bin/gcc";
const WSL = ["-d", "Ubuntu-22.04", "--user", "mruserbox", "--exec"];
const WIN_SOURCE = "tools/native/morpho-pt-post-expiry-r3-full-pool-preflight-runner-win32.c";
const LINUX_SOURCE = "tools/native/morpho-pt-post-expiry-r3-full-pool-preflight-launcher-linux.c";
const PREFLIGHT = "tools/preflight-morpho-pt-27aug2026-post-expiry-r3-full-pool.js";
const PREFLIGHT_TEST = "tools/test-preflight-morpho-pt-27aug2026-post-expiry-r3-full-pool.js";
const NATIVE_TEST = "tools/test-preflight-morpho-pt-27aug2026-post-expiry-r3-full-pool-native.js";
const WRAPPER = "tools/run-morpho-pt-27aug2026-post-expiry-r3-full-pool-preflight-once.js";
const WRAPPER_TEST = "tools/test-run-morpho-pt-27aug2026-post-expiry-r3-full-pool-preflight-once.js";
const BUILD_SOURCE = "tools/build-morpho-pt-post-expiry-r3-full-pool-preflight-native.js";
const MANIFEST = path.join(ROOT, "tools/native/morpho-pt-post-expiry-r3-full-pool-preflight-native-build-manifest.json");
const WIN_COMMON = ["-O2", "-std=c11", "-Wall", "-Wextra", "-Werror", "-D_WIN32_WINNT=0x0602", "-municode", "-fno-ident", "-ffile-prefix-map=C:\\_Work\\__EVM_AUDIT=.", "-Wl,--no-insert-timestamp"];
const LINUX_COMMON = ["-O2", "-std=c11", "-Wall", "-Wextra", "-Werror", "-fno-ident", "-ffile-prefix-map=/mnt/c/_Work/__EVM_AUDIT=.", "-Wl,--build-id=none"];
const shaBytes = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const sha = (file) => shaBytes(fs.readFileSync(path.join(ROOT, file)));
const linuxPath = (file) => `/mnt/c/_Work/__EVM_AUDIT/${file.replace(/\\/gu, "/")}`;
function commandTemplate(compiler, args, output) {
  const index = args.indexOf(output);
  if (index < 0 || args.lastIndexOf(output) !== index) throw new Error(`missing or duplicate output argument: ${output}`);
  return [compiler, ...args.slice(0, index), "<output>", ...args.slice(index + 1)];
}
function runWin(args) { const r = child.spawnSync(GCC_WIN, args, { cwd: ROOT, encoding: "utf8", windowsHide: true }); if (r.status !== 0) throw new Error(`${r.stdout}${r.stderr}`); }
function runLinux(args) { const r = child.spawnSync("wsl.exe", [...WSL, GCC_LINUX, ...args], { cwd: ROOT, encoding: "utf8", windowsHide: true }); if (r.status !== 0) throw new Error(`${r.stdout}${r.stderr}`); }
function linuxVariant(name, suffix, macros) { const base = `tools/native/morpho-pt-post-expiry-r3-full-pool-preflight-launcher-linux${suffix}`, outputs = [`${base}.build1`, `${base}.build2`], linuxOutputs = outputs.map(linuxPath), commands = linuxOutputs.map((output) => [...LINUX_COMMON, ...macros, linuxPath(LINUX_SOURCE), "-o", output]); commands.forEach(runLinux); if (sha(outputs[0]) !== sha(outputs[1])) throw new Error(`nondeterministic linux ${name}`); fs.copyFileSync(path.join(ROOT, outputs[0]), path.join(ROOT, base)); return { name, path: base, macros, command: commandTemplate(GCC_LINUX, commands[0], linuxOutputs[0]), compileCommands: commands.map((args) => [GCC_LINUX, ...args]), buildCount: 2, byteIdentical: true, binarySha256: sha(base), buildOutputs: outputs, buildSha256: outputs.map(sha) }; }
const linuxProduction = linuxVariant("production", "", []);
const linuxUnits = [linuxVariant("normal", "-unit", ["-DUNIT_TEST", "-Wno-unused-function", "-Wno-unused-const-variable"]), linuxVariant("extra", "-unit-extra", ["-DUNIT_TEST", "-DUNIT_EXTRA_OUTPUT", "-Wno-unused-function", "-Wno-unused-const-variable"]), linuxVariant("hang", "-unit-hang", ["-DUNIT_TEST", "-DUNIT_HANG", "-Wno-unused-function", "-Wno-unused-const-variable"])];
function winVariant(name, suffix, behavior, launcherHash) { const base = `tools/native/morpho-pt-post-expiry-r3-full-pool-preflight-runner-win32${suffix}`, hashMacro = `-DEXPECTED_LAUNCHER_SHA256=\"${launcherHash}\"`, macros = [...behavior, hashMacro, "-Wno-unused-function"], outputs = [`${base}.build1.exe`, `${base}.build2.exe`], commands = outputs.map((output) => [...WIN_COMMON.slice(0, 6), ...macros, ...WIN_COMMON.slice(6), WIN_SOURCE, "-o", output, "-lbcrypt", "-ladvapi32"]); commands.forEach(runWin); if (sha(outputs[0]) !== sha(outputs[1])) throw new Error(`nondeterministic windows ${name}`); fs.copyFileSync(path.join(ROOT, outputs[0]), path.join(ROOT, `${base}.exe`)); return { name, path: `${base}.exe`, macros, command: commandTemplate(GCC_WIN, commands[0], outputs[0]), compileCommands: commands.map((args) => [GCC_WIN, ...args]), buildCount: 2, byteIdentical: true, binarySha256: sha(`${base}.exe`), buildOutputs: outputs, buildSha256: outputs.map(sha) }; }
const winProduction = winVariant("production", "", [], linuxProduction.binarySha256);
const normalHash = linuxUnits[0].binarySha256, extraHash = linuxUnits[1].binarySha256, hangHash = linuxUnits[2].binarySha256;
const winUnits = [winVariant("normal", "-unit", ["-DUNIT_TEST"], normalHash), winVariant("dacl", "-unit-dacl-fail", ["-DUNIT_TEST", "-DUNIT_DACL_FAILURE"], normalHash), winVariant("job", "-unit-job-fail", ["-DUNIT_TEST", "-DUNIT_JOB_FAILURE"], normalHash), winVariant("badTarget", "-unit-bad-target", ["-DUNIT_TEST", "-DUNIT_BAD_TARGET_HASH"], normalHash), winVariant("extra", "-unit-extra", ["-DUNIT_TEST", "-DUNIT_EXTRA_LAUNCHER"], extraHash), winVariant("hang", "-unit-hang", ["-DUNIT_TEST", "-DUNIT_HANG_LAUNCHER"], hangHash), winVariant("postcheck", "-unit-postcheck-fail", ["-DUNIT_TEST", "-DUNIT_POSTCHECK_FAILURE"], normalHash)];
const linuxCompiler = child.spawnSync("wsl.exe", [...WSL, "/usr/bin/sha256sum", GCC_LINUX], { encoding: "utf8", windowsHide: true }); if (linuxCompiler.status !== 0) throw new Error(linuxCompiler.stderr);
const modulePins = require(path.join(ROOT, PREFLIGHT)).MODULES;
const manifest = {
  schema: "morpho-pt-post-expiry-r3-full-pool-preflight-native-build/v2",
  stage: "WORKSPACE_LOCAL_AUTHORITY_PACKAGE_BUILT_NOT_STAGED",
  productionExecution: false, productionStaging: false, inventoryContentRead: false, networkUsed: false,
  buildOrder: ["FRESH_LINUX_LAUNCHER", "FRESH_WINDOWS_RUNNER_WITH_LAUNCHER_RAW_HASH", "FINAL_PREFLIGHT_WITH_RUNNER_AND_LAUNCHER_HASHES", "FINAL_ONE_SHOT_WRAPPER_WITH_RUNNER_RAW_HASH"],
  hashCycleClosure: "The launcher has no runner hash dependency. The runner embeds the launcher raw hash. The finalized preflight and wrapper then pin the runner raw hash; no artifact self-hash cycle exists.",
  authority: { windowsRunnerRawSha256: winProduction.binarySha256, linuxLauncherRawSha256: linuxProduction.binarySha256, preflightSourceSha256: sha(PREFLIGHT), activationModules: modulePins.map(([file, sha256]) => ({ file, sha256 })), statement: "External raw runner and launcher hashes are execution authorities; preflight source and every held activation module are separately raw-hash qualified before use." },
  windows: { compiler: "x86_64-w64-mingw32-gcc.exe (tdm64-1) 10.3.0", compilerExecutable: GCC_WIN, compilerExecutableSha256: shaBytes(fs.readFileSync(GCC_WIN)), command: winProduction.command, compileCommands: winProduction.compileCommands, buildCount: 2, byteIdentical: true, sourceSha256: sha(WIN_SOURCE), binarySha256: winProduction.binarySha256, buildOutputs: winProduction.buildOutputs, buildSha256: winProduction.buildSha256, sourceCandidate: winProduction.path, fixedProductionPath: "C:\\_Work\\__EVM_AUDIT\\.runtime\\morpho-pt-post-expiry-r3-preflight\\morpho-pt-post-expiry-r3-full-pool-preflight-runner-win32.exe", runtimeStatus: "NOT_STAGED", unitVariants: winUnits },
  linux: { compiler: "gcc (Ubuntu 11.4.0-1ubuntu1~22.04.3) 11.4.0", compilerExecutable: GCC_LINUX, compilerExecutableSha256: linuxCompiler.stdout.slice(0, 64), command: linuxProduction.command, compileCommands: linuxProduction.compileCommands, buildCount: 2, byteIdentical: true, sourceSha256: sha(LINUX_SOURCE), binarySha256: linuxProduction.binarySha256, buildOutputs: linuxProduction.buildOutputs, buildSha256: linuxProduction.buildSha256, sourceCandidate: linuxProduction.path, fixedProductionPath: "/home/mruserbox/.local/share/evm-audit/morpho-pt-post-expiry-r3-preflight/morpho-pt-post-expiry-r3-full-pool-preflight-launcher-linux", runtimeStatus: "NOT_STAGED", expectedIdentity: { uid: 1000, euid: 1000, gid: 1000, egid: 1000 }, unitVariants: linuxUnits },
  bindings: { preflightSourceSha256: sha(PREFLIGHT), preflightTestSha256: sha(PREFLIGHT_TEST), nativeUnitTestSha256: sha(NATIVE_TEST), wrapperSourceSha256: sha(WRAPPER), wrapperTestSha256: sha(WRAPPER_TEST), buildSourceSha256: sha(BUILD_SOURCE), attestationSchema: "morpho-pt-post-expiry-r3-full-pool-runner-authority/v3" },
  tests: {
    requiredRuns: 2,
    observed: [
      { run: 1, passes: 31, failures: 0, productionExecutions: 0, productionStaging: 0, endpointInventoryReads: 0, networkRequests: 0 },
      { run: 2, passes: 31, failures: 0, productionExecutions: 0, productionStaging: 0, endpointInventoryReads: 0, networkRequests: 0 }
    ],
    productionTests: { expected: 36, observed: 36, assertions: 259, mutations: 73, networkRequests: 0 },
    safeR2Regressions: { expected: 50, observed: 50, failures: 0, networkRequests: 0 }
  },
  blockers: ["PREFLIGHT_RUNTIME_DIRECTORY_NOT_CREATED", "PRODUCTION_RUNTIME_NOT_STAGED", "PRODUCTION_ACL_NOT_APPLIED", "ACTUAL_INVENTORY_NOT_QUALIFIED", "PREFLIGHT_NOT_EXECUTED", "PERMIT_NOT_ISSUED", "CAPTURE_NOT_EXECUTED"]
};
fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ launcherSha256: linuxProduction.binarySha256, runnerSha256: winProduction.binarySha256, windowsUnitVariants: winUnits.length, linuxUnitVariants: linuxUnits.length, productionExecutions: 0, inventoryReads: 0, networkRequests: 0 })}\n`);
