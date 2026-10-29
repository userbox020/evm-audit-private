#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const test = require("node:test");
const adapter = require("./lib/morpho-pt-27aug2026-post-expiry-r2-production-adapter.js");
const base = require("./lib/r1-evm-read-gate.js");
const preflight = require("./preflight-morpho-pt-27aug2026-post-expiry-r3-full-pool.js");
const PRODUCTION_RUNNER = "C:\\_Work\\__EVM_AUDIT\\.runtime\\morpho-pt-post-expiry-r3-preflight\\morpho-pt-post-expiry-r3-full-pool-preflight-runner-win32.exe";
const OLD_PRODUCTION_RUNNER = "C:\\_Work\\__EVM_AUDIT\\.runtime\\morpho-pt-post-expiry-r2\\morpho-pt-post-expiry-r2-full-pool-preflight-runner-win32.exe";

const EXPIRY = 1787788800;
const NOW = (EXPIRY + 80) * 1000;
const word = (value) => BigInt(value).toString(16).padStart(64, "0");
const hash = (value) => `0x${word(value)}`;
const header = (value = 100) => ({
  number: `0x${BigInt(value).toString(16)}`,
  hash: hash(value),
  parentHash: hash(value - 1),
  stateRoot: hash(value + 1000),
  timestamp: `0x${BigInt(EXPIRY + 40).toString(16)}`,
});
const inventory = (families = Array.from({ length: 9 }, (_, index) => `authority-op-${index}`)) => Buffer.from(`${families.map((family, index) => `[EVM chain=1 mainnet role=RPC keyless-relay ${index < 2 ? "premium " : ""}capabilityRank=${100 - index * 5} family=${family} http://127.0.0.1:${18000 + index}/]`).join("\n")}\n`);
function counters() { return { dns: 0, socket: 1, connect: 1, tls: 0, data: 1, requestDestroyed: 1, socketDestroyed: 1, agentDestroyed: 1 }; }
function syntheticHttp({ chain = () => "0x1", transportFailure = null } = {}) {
  let calls = 0;
  return async (config) => {
    const request = JSON.parse(config.body.toString("utf8"));
    const candidate = Number(config.port) - 18000;
    calls++;
    if (transportFailure) throw new adapter.ProductionError(transportFailure);
    let result;
    if (request.method === "eth_chainId") result = chain(candidate);
    else if (request.method === "eth_getBlockByNumber") result = header();
    else if (request.method === "eth_getCode") result = "0x6001600055";
    else if (request.method === "eth_call") result = `0x${word(EXPIRY)}`;
    else throw new Error("unexpected synthetic method");
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
    return { status: 200, headers: { "content-type": "application/json", "content-encoding": "identity" }, body, redirected: false, remoteAddress: "127.0.0.1", tlsVersion: null, elapsedMs: 1, counters: counters() };
  };
}
async function run(httpPost, inventoryBytes = inventory()) {
  return preflight.runPool({ inventoryBytes, adapter, base, resolveDns: async () => { throw new Error("DNS_FORBIDDEN_IN_RELAY_TEST"); }, httpPost, clock: () => NOW });
}

test("fixed invocation accepts only staged node, one-shot flag, and exact environment", () => {
  assert.equal(preflight.RUNNER, PRODUCTION_RUNNER);
  assert.notEqual(preflight.RUNNER, OLD_PRODUCTION_RUNNER);
  const valid = { argv: [preflight.NODE, preflight.SELF, preflight.FLAG], execArgv: [], env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC" }, execPath: preflight.NODE };
  assert.equal(preflight.validateInvocation(valid), true);
  for (const mutation of [
    { ...valid, execPath: "/usr/bin/node" },
    { ...valid, argv: [...valid.argv, "extra"] },
    { ...valid, argv: [preflight.NODE, preflight.SELF, "--other"] },
    { ...valid, execArgv: ["--inspect"] },
    { ...valid, env: { ...valid.env, EXTRA: "1" } },
    { ...valid, env: { ...valid.env, TZ: "Etc/UTC" } },
  ]) assert.throws(() => preflight.validateInvocation(mutation), (error) => error.code === "AUTHORITY");
});

test("external Windows runner attests its own hash plus source and inventory ACL authority", () => {
  const sourceSha256 = "ab".repeat(32);
  const valid = { schema: preflight.RUNNER_SCHEMA, runnerPath: preflight.RUNNER, runnerSelfSha256: preflight.RUNNER_SHA256, runnerSelfHashVerified: true, launcherPath: preflight.LAUNCHER, launcherSha256: preflight.LAUNCHER_SHA256, launcherHashVerified: true, targetPath: preflight.SELF, targetSha256: sourceSha256, targetAclQualified: true, inventoryPath: preflight.INVENTORY, inventoryAclQualified: true };
  assert.equal(preflight.validateRunnerAttestation(valid, sourceSha256), true);
  for (const key of Object.keys(valid)) {
    const mutated = { ...valid };
    mutated[key] = typeof valid[key] === "boolean" ? false : `${valid[key]}-mutated`;
    assert.throws(() => preflight.validateRunnerAttestation(mutated, sourceSha256), (error) => error.code === "AUTHORITY", key);
  }
  assert.throws(() => preflight.validateRunnerAttestation({ ...valid, extra: true }, sourceSha256), (error) => error.code === "AUTHORITY");
  assert.throws(() => preflight.validateRunnerAttestation({ ...valid, runnerSelfSha256: "cd".repeat(32) }, sourceSha256), (error) => error.code === "AUTHORITY");
  assert.throws(() => preflight.validateRunnerAttestation({ ...valid, launcherSha256: "ef".repeat(32) }, sourceSha256), (error) => error.code === "AUTHORITY");
  assert.throws(() => preflight.validateRunnerAttestation({ ...valid, schema: "morpho-pt-post-expiry-r2-full-pool-runner-authority/v2", runnerPath: OLD_PRODUCTION_RUNNER }, sourceSha256), (error) => error.code === "AUTHORITY");
});

test("full eight-candidate pool is sequential, bounded to 32 attempts, and selects indices only", async () => {
  const result = await run(syntheticHttp());
  assert.equal(result.output.status, "POOL_READY");
  assert.equal(result.output.slots.length, 8);
  assert.deepEqual(result.output.slots.map((slot) => slot.outcome), Array(8).fill("PASS"));
  assert.deepEqual(result.output.slots.map((slot) => slot.attempted), Array(8).fill(4));
  assert.deepEqual(result.output.selectedPoolIndices, [0, 1, 2, 3]);
  assert.deepEqual(result.output.aggregate, { requests: 32, responseBytes: result.output.aggregate.responseBytes, maxConcurrency: 1, retries: 0 });
  assert.match(result.serialized, /"status":"POOL_READY"/u);
  assert.doesNotMatch(result.serialized, /(?:https?|wss):\/\/|authority-op|127\.0\.0\.1|operatorFamily|"family"|"endpoint"|"headers"|stack|rawError|sha256/iu);
});

test("semantic local failures exhaust the pool without quorum and preserve exact attempts", async () => {
  const result = await run(syntheticHttp({ chain: (candidate) => candidate < 6 ? "0x2" : "0x1" }));
  assert.equal(result.output.status, "POOL_NO_QUORUM");
  assert.deepEqual(result.output.selectedPoolIndices, []);
  assert.deepEqual(result.output.slots.slice(0, 6).map((slot) => [slot.outcome, slot.failureClass, slot.reason, slot.attempted]), Array.from({ length: 6 }, () => ["FAIL", "LOCAL", "CHAIN_ID_MISMATCH", 1]));
  assert.deepEqual(result.output.slots.slice(6).map((slot) => [slot.outcome, slot.attempted]), [["PASS", 4], ["PASS", 4]]);
  assert.equal(result.output.aggregate.requests, 14);
  assert.equal(result.output.aggregate.maxConcurrency, 1);
});

test("three passing candidates satisfy quorum and selection prefers family diversity", async () => {
  const quorum = await run(syntheticHttp({ chain: (candidate) => candidate < 3 ? "0x1" : "0x2" }));
  assert.equal(quorum.output.status, "POOL_READY");
  assert.deepEqual(quorum.output.selectedPoolIndices, [0, 1, 2]);
  assert.equal(quorum.output.aggregate.requests, 17);
  const families = ["shared-authority", "shared-authority", ...Array.from({ length: 8 }, (_, index) => `distinct-${index}`)];
  const diversity = await run(syntheticHttp(), inventory(families));
  assert.equal(diversity.output.status, "POOL_READY");
  assert.deepEqual(diversity.output.selectedPoolIndices, [0, 2, 3, 4]);
});

test("local transport failures produce eight fixed slots and no retries", async () => {
  const result = await run(syntheticHttp({ transportFailure: "HTTP_STATUS" }));
  assert.equal(result.output.status, "POOL_NO_QUORUM");
  assert.equal(result.output.aggregate.requests, 8);
  assert.equal(result.output.aggregate.retries, 0);
  for (const slot of result.output.slots) assert.deepEqual([slot.outcome, slot.failureClass, slot.reason, slot.attempted], ["FAIL", "LOCAL", "HTTP_STATUS", 1]);
});

test("every exact local failure class is candidate-terminal", async () => {
  for (const code of preflight.LOCAL) {
    const result = await run(syntheticHttp({ transportFailure: code }));
    assert.equal(result.output.status, "POOL_NO_QUORUM", code);
    assert.equal(result.output.aggregate.requests, 8, code);
    assert.equal(result.output.slots.every((slot) => slot.failureClass === "LOCAL" && slot.reason === code && slot.attempted === 1), true, code);
  }
});

test("a global transport failure stops immediately with fixed sanitized output", async () => {
  const result = await run(syntheticHttp({ transportFailure: "SOCKET" }));
  assert.equal(result.output.status, "SOCKET");
  assert.equal(result.output.aggregate.requests, 1);
  assert.deepEqual(result.output.selectedPoolIndices, []);
  assert.deepEqual([result.output.slots[0].failureClass, result.output.slots[0].reason, result.output.slots[0].attempted], ["GLOBAL", "SOCKET", 1]);
  assert.equal(result.output.slots.slice(1).every((slot) => slot.attempted === 0 && slot.failureClass === "GLOBAL" && slot.reason === "SOCKET"), true);
});

test("every exact global failure class stops the whole pool after one attempt", async () => {
  for (const code of preflight.GLOBAL) {
    const result = await run(syntheticHttp({ transportFailure: code }));
    assert.equal(result.output.status, code);
    assert.equal(result.output.aggregate.requests, 1, code);
    assert.equal(result.output.slots.every((slot) => slot.failureClass === "GLOBAL" && slot.reason === code), true, code);
    assert.equal(result.output.slots[0].attempted, 1, code);
    assert.equal(result.output.slots.slice(1).every((slot) => slot.attempted === 0), true, code);
  }
});

test("module authority manifest covers every final Stage C transitive local module", () => {
  assert.deepEqual(preflight.MODULES.map(([name]) => name), [
    "tools/morpho-pt-27aug2026-post-expiry-r2-production-policy.js",
    "tools/morpho-pt-27aug2026-post-expiry-r1-profile.js",
    "tools/lib/r1-evm-read-gate.js",
    "tools/lib/morpho-pt-27aug2026-post-expiry-r2-gate.js",
    "tools/validate-morpho-pt-27aug2026-post-expiry-r2.js",
    "tools/preflight-all-chain-endpoints-v4.js",
    "tools/lib/morpho-pt-27aug2026-post-expiry-r2-production-adapter.js",
    "tools/capture-morpho-pt-27aug2026-post-expiry-r2-production.js",
    "tools/validate-morpho-pt-27aug2026-post-expiry-r2-production.js",
    "tools/test-morpho-pt-27aug2026-post-expiry-r2-production.js",
  ]);
  for (const [, digest] of preflight.MODULES) assert.match(digest, /^[0-9a-f]{64}$/u);
  const pins = new Map(preflight.MODULES);
  assert.equal(pins.get("tools/morpho-pt-27aug2026-post-expiry-r2-production-policy.js"), "ff1234accc2bf62e9d696ac58abe943228718835cdbd215f2f44c78b68b37fb7");
  assert.equal(pins.get("tools/lib/morpho-pt-27aug2026-post-expiry-r2-production-adapter.js"), "784d32dffe15ee5381f33c97ca2ba58fdd5faf9863cec89abe20729c7188d82d");
  assert.equal(pins.get("tools/capture-morpho-pt-27aug2026-post-expiry-r2-production.js"), "827cf47fd41df6d7a13d9595c82fd5ca256438d1ba290d422dba30a16cfda055");
  assert.equal(pins.get("tools/validate-morpho-pt-27aug2026-post-expiry-r2-production.js"), "790fce8e212782d438d9f7c47b81d4c91b2e8795d91dcd674251dd73dd0fe3b7");
  assert.equal(pins.get("tools/test-morpho-pt-27aug2026-post-expiry-r2-production.js"), "9d2d63f16ce9671e88747e8c0beaa7bc537c78d447251163a7352112796aea2c");
  for (const stale of ["94b7f65cefa537639d4e172ada67365d290a54f8853254e4317e1718bad5c53f", "86c81e2c812a382785e935ab82d878f3cd707896131c037b22fa8dd83c4a1610", "da578cceb8484597f173bb6e7a6bb36a56df1c865b17567ee00ada138b9ce56a"]) assert.equal(preflight.MODULES.some(([, digest]) => digest === stale), false);
});

test("real WSL staged authority can hold a synthetic /mnt/c inventory through EOF and select eight without DNS/RPC", { skip: process.platform !== "win32" }, () => {
  const parent = path.join(os.tmpdir(), "opencode");
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, "r2-preflight-wsl-"));
  const fixture = path.join(dir, "synthetic-inventory.txt");
  fs.writeFileSync(fixture, inventory(), { flag: "wx", mode: 0o600 });
  const linuxFixture = `/mnt/${fixture[0].toLowerCase()}${fixture.slice(2).replace(/\\/gu, "/")}`;
  const script = String.raw`
const fs=require('node:fs'),crypto=require('node:crypto');
const root=${JSON.stringify(preflight.ROOT)}, manifest=JSON.parse(process.argv[1]), inventory=process.argv[2];
const tuple=s=>[String(s.dev),String(s.ino),String(s.size),String(s.mtimeNs)];
for(const [rel,want] of manifest){const file=root+'/'+rel,before=fs.lstatSync(file,{bigint:true});if(!before.isFile()||before.isSymbolicLink()||before.uid!==1000n||before.nlink!==1n||(before.mode&0o22n)!==0n||Number(fs.statfsSync(file).type)!==0xef53)throw Error('AUTHORITY');const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const bytes=fs.readFileSync(fd),opened=fs.fstatSync(fd,{bigint:true});if(JSON.stringify(tuple(before))!==JSON.stringify(tuple(opened))||crypto.createHash('sha256').update(bytes).digest('hex')!==want)throw Error('AUTHORITY');fs.closeSync(fd);}
const before=fs.lstatSync(inventory,{bigint:true}),fd=fs.openSync(inventory,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),bytes=fs.readFileSync(fd),opened=fs.fstatSync(fd,{bigint:true}),eof=Buffer.alloc(1),after=fs.lstatSync(inventory,{bigint:true});
if(fs.readSync(fd,eof,0,1,null)!==0)throw Error('INVENTORY_EOF');
if(JSON.stringify(tuple(before))!==JSON.stringify(tuple(opened)))throw Error('INVENTORY_OPEN_IDENTITY');
if(JSON.stringify(tuple(opened))!==JSON.stringify(tuple(after)))throw Error('INVENTORY_STABLE_IDENTITY');
fs.closeSync(fd);
const adapter=require(root+'/tools/lib/morpho-pt-27aug2026-post-expiry-r2-production-adapter.js'),rows=adapter.parseInventory(bytes),handles=adapter.selectCandidates(rows);process.stdout.write(JSON.stringify({modules:manifest.length,records:rows.length,handles:handles.length,dns:0,rpc:0}));`;
  try {
    const result = childProcess.spawnSync("wsl.exe", ["--exec", preflight.NODE, "-e", script, JSON.stringify(preflight.MODULES), linuxFixture], { encoding: "utf8", env: { SystemRoot: process.env.SystemRoot, WSLENV: "" }, timeout: 30000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr.replace(/https?:\/\/\S+/gu, "[REDACTED]"));
    assert.deepEqual(JSON.parse(result.stdout), { modules: 10, records: 9, handles: 8, dns: 0, rpc: 0 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
