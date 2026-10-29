#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");

const SUPERVISOR = "C:\\Users\\MiPC\\AppData\\Local\\Temp\\opencode\\morpho-pt-post-expiry-r2\\morpho-pt-post-expiry-r2-supervisor-broker-win32.exe";
const SUPERVISOR_SHA256 = "d6e09832bf9e01ac7539472fa22ab22bbfc8a54cfd85f432ce20c4467494fa7e";
const TIMEOUT_MS = 285000;
const MAX_BUFFER = 65536;
const ENV = Object.freeze({ SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" });

function nonceLine(value) {
  if (!Buffer.isBuffer(value) || value.length !== 65 || value[64] !== 0x0a) return false;
  const nonce = value.subarray(0, 64).toString("ascii");
  return /^[0-9a-f]{64}$/u.test(nonce) && new Set(nonce.match(/../gu)).size >= 8;
}
function same(left, right) { return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs; }
function defaultAclCheck(file) {
  const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const command = "$p=$args[0];$i=Get-Item -LiteralPath $p -Force;$a=Get-Acl -LiteralPath $p;$u=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$ok=@($u,'S-1-5-18','S-1-5-32-544');$ids=@($a.Access|%{$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value}|sort -Unique);$owner=(New-Object Security.Principal.NTAccount($a.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value;if((($i.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) -or (-not $a.AreAccessRulesProtected) -or ($owner -ne $u) -or (@($a.Access|?{$_.IsInherited}).Count -ne 0) -or (@($ids|?{$_ -notin $ok}).Count -ne 0) -or (@($ok|?{$_ -notin $ids}).Count -ne 0)){exit 2}";
  const result = childProcess.spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", command, file], { shell: false, windowsHide: true, timeout: 10000, stdio: "ignore", env: { SystemRoot: ENV.SystemRoot, WINDIR: ENV.WINDIR } });
  return Boolean(result) && !result.error && result.status === 0;
}
function verifySupervisor(fsImpl, file, expectedSha256, aclCheck) {
  const before = fsImpl.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || fsImpl.realpathSync(file) !== file) return false;
  const bytes = fsImpl.readFileSync(file), after = fsImpl.lstatSync(file);
  return same(before, after) && crypto.createHash("sha256").update(bytes).digest("hex") === expectedSha256 && aclCheck(file);
}
function bytes(value) { if (value === null || value === undefined) return Buffer.alloc(0); if (Buffer.isBuffer(value)) return value; if (value instanceof Uint8Array) return Buffer.from(value); throw new TypeError("OUTPUT"); }
function writeAll(writeSync, fd, value) { const body = bytes(value); let offset = 0; while (offset < body.length) { let count; try { count = writeSync(fd, body, offset, body.length - offset, null); } catch (error) { if (error && error.code === "EINTR") continue; throw error; } if (!Number.isInteger(count) || count <= 0 || count > body.length - offset) throw new Error("WRITE"); offset += count; } }
function status(result) { if (!result || typeof result !== "object") return 125; if (result.error) return result.error.code === "ETIMEDOUT" ? 124 : 125; return Number.isInteger(result.status) && result.status >= 0 && result.status <= 255 ? result.status : 125; }

function runOnce(dependencies = {}) {
  const argv = dependencies.argv || process.argv, input = dependencies.input, fsImpl = dependencies.fs || fs, spawnSync = dependencies.spawnSync || childProcess.spawnSync, writeSync = dependencies.writeSync || fs.writeSync, file = dependencies.supervisor || SUPERVISOR, expected = dependencies.expectedSha256 || SUPERVISOR_SHA256, aclCheck = dependencies.aclCheck || defaultAclCheck;
  if (!Array.isArray(argv) || argv.length !== 2 || !nonceLine(input)) return 125;
  try { if (!verifySupervisor(fsImpl, file, expected, aclCheck)) return 125; } catch (_) { return 125; }
  let result;
  try { result = spawnSync(file, [], { shell: false, input: Buffer.from(input), encoding: null, windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, env: { SystemRoot: ENV.SystemRoot, WINDIR: ENV.WINDIR } }); } catch (_) { return 125; }
  try { writeAll(writeSync, 1, result && result.stdout); writeAll(writeSync, 2, result && result.stderr); } catch (_) { return 125; }
  return status(result);
}
function readNonceFd(fsImpl = fs, fd = 0) { const output = Buffer.alloc(66); let used = 0; while (used < output.length) { const count = fsImpl.readSync(fd, output, used, output.length - used, null); if (count === 0) break; used += count; } return output.subarray(0, used); }
function main() { let input; try { input = readNonceFd(fs); } catch (_) { process.exitCode = 125; return; } process.exitCode = runOnce({ argv: process.argv, input, fs, spawnSync: childProcess.spawnSync, writeSync: fs.writeSync, supervisor: SUPERVISOR, expectedSha256: SUPERVISOR_SHA256, aclCheck: defaultAclCheck }); }
if (require.main === module) main();
module.exports = Object.freeze({ SUPERVISOR, SUPERVISOR_SHA256, TIMEOUT_MS, MAX_BUFFER, ENV, nonceLine, defaultAclCheck, verifySupervisor, writeAll, status, runOnce, readNonceFd });
