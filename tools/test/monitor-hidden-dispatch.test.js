"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { launch, quote, servicePayload } = require("../monitor-hidden-dispatch");
const { splitWindowsCommandLine } = require("../monitor-set-watchdog");
const { assertMinimalEnvironment } = require("../monitor-minimal-env");
const manifest = require("../monitor-service-manifest");

test("every fixed ID transports full producer arguments and cwd without raw WSH arguments", () => {
  for (const service of manifest.services) {
    const calls = [];
    const result = launch(service.id, { env: { SystemRoot: "C:\\Windows", PATH: "fixture-path", NODE_OPTIONS: "do-not-inherit", HIDDEN_FIXTURE_REMOVE: "fixture-only" }, spawnImpl: (...args) => { calls.push(args); return { status: 0 }; } });
    assert.equal(result.status, 0);
    const [exe, args, options] = calls[0];
    assert.equal(exe, path.join("C:\\Windows", "System32", "wscript.exe"));
    assert.equal(args.length, 4);
    assert.match(args[3], /^[A-Za-z0-9+/]+=*$/);
    const payload = JSON.parse(Buffer.from(args[3], "base64").toString("utf8"));
    assert.deepEqual(payload, { ...servicePayload(service.id), environmentNames: ["SystemRoot", "PATH"] });
    assert.equal(payload.workingDirectory, path.resolve(__dirname, "../.."));
    assert.equal(payload.wait, false);
    assert.equal(assertMinimalEnvironment(options.env, "win32"), true);
    assert.equal(options.stdio, "ignore");
    assert.equal(options.windowsHide, true);
    if (service.id !== "research-watch-build") {
      assert.equal(payload.executable, process.execPath);
      assert.deepEqual(splitWindowsCommandLine(payload.arguments), [path.resolve(__dirname, "../..", service.script), ...service.args]);
    } else {
      assert.equal(payload.arguments, `/d /s /c "${quote(process.execPath)} ${quote(path.resolve(__dirname, "../build-monitor-research-watch.js"))} "--once" > reports\\monitor\\research-watch-startup.log 2>&1 && echo completed> reports\\monitor\\research-watch-startup.done"`);
    }
  }
});
test("unknown or command-bearing IDs never launch and spawn failure is preserved", () => {
  for (const id of ["unknown", "novelty-monitor --apply", "novelty-monitor && echo fixture"]) {
    let spawned = false;
    assert.throws(() => launch(id, { spawnImpl: () => { spawned = true; } }), /HIDDEN_SERVICE_REFUSED/);
    assert.equal(spawned, false);
  }
  const failure = { status: null, error: { code: "FIXTURE" } };
  assert.equal(launch("novelty-monitor", { env: {}, spawnImpl: () => failure }), failure);
});
test("Windows argument quoting retains spaces Unicode quotes percent shell tokens and trailing slashes", () => {
  const args = ["hello world", "lambda-\u03bb", 'a"b', "%VALUE%", "%V", ">", "&&", "C:\\space dir\\", ""];
  assert.deepEqual(splitWindowsCommandLine(args.map(quote).join(" ")), args);
});
