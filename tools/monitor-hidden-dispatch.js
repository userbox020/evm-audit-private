#!/usr/bin/env node
"use strict";
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const manifest = require("./monitor-service-manifest");
const { minimalMonitorEnv, assertMinimalEnvironment } = require("./monitor-minimal-env");
const ROOT = path.resolve(__dirname, "..");

function quote(value) {
  return `"${String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}
function servicePayload(id) {
  const service = manifest.services.find(row => row.id === id && row.mode === "read-only");
  if (!service) throw new Error("HIDDEN_SERVICE_REFUSED");
  let executable = process.execPath;
  let args = [quote(path.resolve(ROOT, service.script)), ...service.args.map(quote)].join(" ");
  if (id === "research-watch-build") {
    executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");
    // Retain stdout/stderr redirection and the SUCCESS-ONLY startup marker.
    args = `/d /s /c "${quote(process.execPath)} ${args} > reports\\monitor\\research-watch-startup.log 2>&1 && echo completed> reports\\monitor\\research-watch-startup.done"`;
  }
  return { version: 1, executable, arguments: args, workingDirectory: ROOT, wait: false, environmentNames: null };
}
function launch(id, options = {}) {
  const payload = servicePayload(id);
  const env = minimalMonitorEnv(options.env || process.env, "win32");
  if (!assertMinimalEnvironment(env, "win32")) throw new Error("HIDDEN_ENV_REFUSED");
  payload.environmentNames = Object.keys(env);
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
  return (options.spawnImpl || spawnSync)(path.join(systemRoot, "System32", "wscript.exe"), [
    "//B", "//Nologo", path.join(__dirname, "launch-hidden.vbs"), Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
  ], { cwd: ROOT, env, stdio: "ignore", windowsHide: true, timeout: Math.max(1, Math.min(10000, options.timeoutMs || 10000)) });
}
if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error("HIDDEN_SERVICE_REFUSED");
    const result = launch(process.argv[2]);
    process.exitCode = result.status === 0 && !result.error ? 0 : 1;
  } catch (_) { process.stderr.write("hidden monitor launch refused\n"); process.exitCode = 1; }
}
module.exports = { launch, servicePayload, quote };
