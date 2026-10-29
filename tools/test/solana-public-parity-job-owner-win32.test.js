"use strict";

// Fixture-only containment checks. Never execute a validator, relay or RPC.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const source = path.resolve(__dirname, "../native/solana-public-parity-job-owner-win32.c");
const root = "C:\\Users\\MiPC\\AppData\\Local\\Temp\\opencode";
const buildDir = fs.mkdtempSync(path.join(root, "solana-job-fixture-build-"));
const executable = path.join(buildDir, "fixture-owner.exe");
const compile = spawnSync("gcc", ["-std=c11", "-Wall", "-Wextra", "-Werror", "-municode",
  "-DSOLANA_PARITY_FIXTURE", source, "-o", executable], { encoding: "utf8", timeout: 30000 });

function run(fault) {
  const result = spawnSync(executable, ["--fixture", "--fault", fault], {
    encoding: "utf8", timeout: 15000, windowsHide: true,
  });
  assert.equal(result.error, undefined, "fixture owner timed out or could not launch");
  assert.match(result.stdout, /RESULT (NO_GO|FIXTURE_ONLY) ACTIVE_ZERO_1/);
  const marker = result.stdout.match(/^MARKER (.+)$/m)?.[1]?.trim();
  const markerContents = marker ? fs.readFileSync(marker, "utf8") : "";
  if (marker) fs.rmSync(marker, { force: true });
  return { ...result, markerContents };
}

function exists(pid) {
  try { process.kill(pid, 0); return true; } catch (err) {
    if (err.code === "ESRCH") return false;
    throw err;
  }
}

async function gone(pid) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    if (!exists(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.equal(exists(pid), false, `fixture process still exists: ${pid}`);
}

test("compile fixture; production build stays explicitly NO_GO", () => {
  assert.equal(process.platform, "win32");
  assert.equal(compile.status, 0, compile.stderr || compile.error?.message);
  const prod = path.join(buildDir, "production-blocked.exe");
  const result = spawnSync("gcc", ["-std=c11", "-Wall", "-Wextra", "-Werror", "-municode",
    source, "-o", prod], { encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  const blocked = spawnSync(prod, ["--fixture", "--fault", "NONE"], {
    encoding: "utf8", timeout: 3000, windowsHide: true,
  });
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /NO_GO_PRODUCTION_RELAY_AND_REVIEW_REQUIRED/);
});

test("fixture rejects extra/unknown arguments and direct child execution", () => {
  for (const args of [["--fixture", "--fault", "NONE", "extra"],
    ["--fixture", "--fault", "OTHER"], ["--relay-child", path.join(root, "absent-fixture.txt")]]) {
    const result = spawnSync(executable, args, { encoding: "utf8", timeout: 3000, windowsHide: true });
    assert.equal(result.status, args[0] === "--relay-child" ? 3 : 2);
    assert.doesNotMatch(result.stdout, /READY|MARKER/);
  }
});

for (const fault of ["JOB_CREATE", "JOB_SET", "ATTR_PROBE", "ATTR_INIT", "ATTR_UPDATE",
  "CHILD1_CREATE", "CHILD1_RESUME", "CHILD2_CREATE", "ATTEST2"]) {
  test(`fault ${fault} fails closed with zero job processes`, () => {
    assert.equal(compile.status, 0, compile.stderr);
    const result = run(fault);
    assert.equal(result.status, 2);
    assert.doesNotMatch(result.stdout, /OBSERVED /);
    assert.equal(result.markerContents, "", "neither child may execute before BOTH attestations");
    if (fault === "ATTEST2") assert.match(result.stdout, /UNATTESTED_TERMINATED_1/);
  });
}

test("second resume fault terminates any already-running first child and descendants", async () => {
  const result = run("CHILD2_RESUME");
  assert.equal(result.status, 2);
  assert.doesNotMatch(result.stdout, /OBSERVED /);
  const started = [...result.markerContents.matchAll(/^(?:relay|validator|grandson) (\d+)$/gm)];
  await Promise.all(started.map((match) => gone(Number(match[1]))));
});

test("deadline terminates both children and grandson; job ActiveProcesses zero", async () => {
  const result = run("TIMEOUT");
  assert.equal(result.status, 2);
  const ids = result.stdout.match(/^OBSERVED (\d+) (\d+) (\d+) LINEAGE_HINT_ONLY$/m);
  assert.ok(ids, result.stdout);
  await Promise.all(ids.slice(1).map((id) => gone(Number(id))));
});

test("normal fixture ends with verified empty job and no child survivors", async () => {
  const result = run("NONE");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /RESULT FIXTURE_ONLY ACTIVE_ZERO_1/);
  const ids = result.stdout.match(/^OBSERVED (\d+) (\d+) (\d+) LINEAGE_HINT_ONLY$/m);
  assert.ok(ids, result.stdout);
  await Promise.all(ids.slice(1).map((id) => gone(Number(id))));
});

for (const fault of ["LATE_READY", "CLEANUP_DELAY", "CLEANUP_WAIT_FAIL"]) {
  test(`${fault} remains NO_GO even with ACTIVE_ZERO`, async () => {
    const result = run(fault);
    assert.equal(result.status, 2);
    const ids = result.stdout.match(/^OBSERVED (\d+) (\d+) (\d+) LINEAGE_HINT_ONLY$/m);
    assert.ok(ids, result.stdout);
    await Promise.all(ids.slice(1).map((id) => gone(Number(id))));
  });
}

test("externally killing owner closes private job and kills identified descendants", async () => {
  assert.equal(compile.status, 0, compile.stderr);
  const owner = spawn(executable, ["--fixture", "--fault", "TIMEOUT"], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let marker;
  try {
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("fixture observation timeout")), 1800);
      owner.once("error", (error) => { clearTimeout(timer); reject(error); });
      owner.stdout.on("data", (chunk) => {
        output += chunk.toString();
        marker = output.match(/^MARKER (.+)$/m)?.[1]?.trim();
        const ids = output.match(/^OBSERVED (\d+) (\d+) (\d+) LINEAGE_HINT_ONLY$/m);
        if (ids) { clearTimeout(timer); resolve(ids.slice(1).map(Number)); }
      });
    });
    for (const pid of ready) assert.ok(exists(pid), `fixture exited before kill: ${pid}`);
    assert.ok(owner.kill("SIGKILL"));
    await Promise.all(ready.map(gone));
  } finally {
    if (exists(owner.pid)) owner.kill("SIGKILL");
    if (marker) fs.rmSync(marker, { force: true });
  }
});

test.after(() => {
  fs.rmSync(buildDir, { recursive: true, force: true });
});
