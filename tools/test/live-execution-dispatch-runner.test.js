#!/usr/bin/env node
"use strict";

// live-execution-dispatch-runner.test.js
//
// Offline coverage for tools/live-execution-dispatch-runner.js.
//
// No network, no real key, no broadcast: the transport, endpoint resolver, and
// signer loader are all injected. The REAL dispatcher, adapter, and canonical
// batch module run against a temp batch fixture, so a `--check` that accidentally
// consumed or broadcast would be directly observable (a terminal marker and/or a
// send). Every URL used is a synthetic `.invalid` value; no endpoint or key
// material is ever printed, logged, or persisted.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { Wallet, keccak256 } = require("ethers");
const runner = require("../live-execution-dispatch-runner.js");
const dispatch = require("../live-execution-broadcast-dispatch.js");
const batchTool = require("../live-execution-batch.js");
const { createApprovalFixture } = require("./live-execution-batch-fixture.js");

const NOW_MS = Date.parse("2026-09-12T12:00:00.000Z");
const KEY = `0x${"11".repeat(32)}`;
const TARGET = "0x2222222222222222222222222222222222222222";
const DATA = `0xa9059cbb${"0".repeat(64)}`;
const BATCH_ID = "a1b2c3d4e5f60718";
const ENV_ENDPOINT = "https://send.invalid/rpc";
const REJECTED_ENDPOINT = "http://insecure.invalid/rpc";
const LOCALHOST_HTTP = "http://127.0.0.1:8545";

function makeWorld(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-runner-"));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ } });
  const approval = createApprovalFixture(dir);
  const wallet = new Wallet(KEY);
  const raw = {
    schema: batchTool.SCHEMA_V3,
    batchId: BATCH_ID,
    mode: "TESTNET",
    chainId: "1",
    accountRef: wallet.address.toLowerCase(),
    actions: [{ from: wallet.address.toLowerCase(), to: TARGET, valueWei: "0", data: DATA, gasLimit: "100000", slippageBps: "0" }],
    gasCeiling: "1000000",
    feeCap: { maxFeePerGasWei: "1000000000", maxPriorityFeePerGasWei: "1000000000" },
    issuedAt: "2026-09-12T00:00:00.000Z",
    notBefore: "2026-09-12T00:00:00.000Z",
    expiresAt: "2026-09-13T00:00:00.000Z",
    nonce: "0123456789abcdef",
  };
  const signed = approval.sign(raw);
  const batchPath = path.join(dir, "live-execution-batch.json");
  batchTool.writeBatch(signed, {
    batchPath,
    registryPath: approval.registryPath,
    registrySha256: approval.registrySha256,
    requireDurable: false,
  });
  return {
    dir,
    wallet,
    signed,
    keyFile: path.join(dir, "signer.key"),
    commit: batchTool.commitment(signed),
    scope: batchTool.scopeCommitment(signed),
    // The dispatcher's DATA-only `batchOptions` allowlist is exactly these three
    // keys; `requireDurable` is a write-side option and must not be forwarded.
    batchOptions: {
      batchPath,
      registryPath: approval.registryPath,
      registrySha256: approval.registrySha256,
    },
  };
}

function rawState(world) {
  return batchTool.batchState({ ...world.batchOptions, now: () => NOW_MS });
}
function terminalCount(world) {
  return fs.readdirSync(world.dir).filter((name) => name.startsWith("live-execution-batch-terminal-")).length;
}
function runArgs(world, extra = []) {
  return ["run", "--expected-batch-commitment", world.commit, "--confirm", BATCH_ID, "--key-file", world.keyFile, ...extra];
}

// Real dispatcher + real adapter + real batch module; only the three external
// boundaries are mocked. `createSendEndpointResolver` records the resolver
// options (to prove the endpoint came from the injected environment) and returns
// a synthetic TLS URL.
function makeWiring(world, config = {}) {
  const adapter = require("../live-execution-broadcast-adapter.js");
  const sendEndpoint = require("../live-execution-send-endpoint.js");
  const transportCalls = { methods: [], sendRaw: 0, sent: [], chainId: 0, nonce: 0, receipt: 0 };
  const resolverEvents = [];
  const loaderCalls = [];
  const keyBytes = Buffer.from(KEY.slice(2), "hex");
  const transport = async (_url, method, params) => {
    transportCalls.methods.push(method);
    if (method === "eth_chainId") { transportCalls.chainId += 1; return "0x1"; }
    if (method === "eth_getTransactionCount") { transportCalls.nonce += 1; return "0x5"; }
    if (method === "eth_sendRawTransaction") {
      transportCalls.sendRaw += 1;
      const hash = keccak256(params[0]);
      transportCalls.sent.push(hash);
      return hash;
    }
    if (method === "eth_getTransactionReceipt") {
      transportCalls.receipt += 1;
      return { status: "0x1", transactionHash: params[0] };
    }
    throw new Error("unexpected transport method");
  };
  const deps = {
    dispatch,
    adapter,
    sendEndpoint: {
      parseInventoryUrls: sendEndpoint.parseInventoryUrls,
      readAuthorizedInventory: () => (config.inventory || []),
      createSendEndpointResolver: (resolverOptions) => {
        resolverEvents.push(resolverOptions);
        return async () => config.resolverUrl || ENV_ENDPOINT;
      },
    },
    evmKey: {
      load: async (loadOptions) => {
        loaderCalls.push(loadOptions);
        if (config.loaderThrows) throw new Error("synthetic loader failure");
        return { signer: world.wallet, keyBytes };
      },
    },
  };
  const common = {
    deps,
    transport,
    env: config.env === undefined ? { LIVE_EXECUTION_ENDPOINT: ENV_ENDPOINT } : config.env,
    now: () => NOW_MS,
    publishResult: () => ({ written: true, writeOnce: true }),
    batchOptions: world.batchOptions,
  };
  if (config.readEndpoint !== undefined) common.readEndpoint = config.readEndpoint;
  return { deps, transportCalls, resolverEvents, loaderCalls, keyBytes, common };
}
function serialized(value) {
  return JSON.stringify(value);
}

test("--check never consumes the batch and never broadcasts (zero sends)", async (t) => {
  const world = makeWorld(t);
  const wiring = makeWiring(world);
  const result = await runner.execute(runArgs(world, ["--check"]), wiring.common);

  assert.equal(result.status, "READY");
  assert.equal(result.check, true);
  assert.equal(result.batchCommitment, world.commit);
  assert.equal(result.scopeCommitment, world.scope);
  assert.deepEqual(result.sends, []);
  assert.equal(result.counts.sends, 0);
  assert.equal(result.counts.attempts, 0);
  assert.equal(result.counts.confirmations, 0);

  assert.equal(wiring.transportCalls.sendRaw, 0, "no eth_sendRawTransaction");
  assert.equal(terminalCount(world), 0, "zero consumeBatch calls: no terminal marker");
  assert.equal(rawState(world).state, "VALID", "authority is untouched");
  assert.equal(wiring.loaderCalls.length, 1, "preflight loaded the signer exactly once");
  assert.equal(wiring.resolverEvents.length, 1, "preflight resolved the endpoint exactly once");
  assert.equal(wiring.keyBytes.every((byte) => byte === 0), true, "key bytes zeroized after check");
});

test("a full run delegates exactly once, broadcasts, and surfaces the tx hash from the envelope", async (t) => {
  const world = makeWorld(t);
  const wiring = makeWiring(world);
  const result = await runner.execute(runArgs(world), wiring.common);

  assert.equal(result.status, "BROADCASTED");
  assert.equal(result.check, false);
  assert.equal(wiring.transportCalls.sendRaw, 1, "exactly one send");
  assert.equal(terminalCount(world), 1, "exactly one consumeBatch");
  assert.equal(rawState(world).state, "CONSUMED");
  assert.equal(result.sends.length, 1, "the published envelope carries the send");
  assert.deepEqual(result.sends[0], { index: 0, txHash: wiring.transportCalls.sent[0], status: "SUCCESS" });
  assert.equal(result.counts.sends, 1);
  assert.equal(result.counts.confirmations, 1);
  assert.equal(wiring.keyBytes.every((byte) => byte === 0), true, "key bytes zeroized after run");
});

test("the endpoint is taken from the injected environment and is never present in output", async (t) => {
  const world = makeWorld(t);
  const wiring = makeWiring(world);
  const result = await runner.execute(runArgs(world), wiring.common);

  assert.deepEqual(wiring.resolverEvents[0].providerUrls, [ENV_ENDPOINT], "env value is passed as providerUrls");
  const output = serialized(result);
  assert.equal(output.includes(ENV_ENDPOINT), false, "the endpoint URL is never echoed");
  assert.equal(output.includes("send.invalid"), false, "no endpoint host leaks");
  assert.equal(output.includes(KEY), false, "no 0x key leaks");
  assert.equal(output.includes(KEY.slice(2)), false, "no raw key leaks");
  assert.equal(output.includes(world.keyFile), false, "the key path never leaks");
  assert.equal(output.includes(world.dir), false, "no temp path leaks");
});

test("an endpoint supplied via argv is refused and never reaches dispatch", async (t) => {
  const world = makeWorld(t);
  const wiring = makeWiring(world);
  let dispatchCalls = 0;
  wiring.deps.dispatch = {
    dispatchOnce: async () => { dispatchCalls += 1; return { status: "BROADCASTED" }; },
    preflightOnce: async () => { dispatchCalls += 1; return { status: "READY" }; },
  };
  const result = await runner.execute([...runArgs(world), "--endpoint", ENV_ENDPOINT], wiring.common);
  assert.equal(result.status, "FAIL_CLOSED");
  assert.equal(result.blocker, "RUNNER_ARGUMENTS_INVALID");
  assert.equal(dispatchCalls, 0, "no dispatch on an argv endpoint");
  assert.equal(serialized(result).includes(ENV_ENDPOINT), false);
});

test("a relative or missing key file is refused before any dependency work", async (t) => {
  const world = makeWorld(t);
  for (const keyFile of ["relative-key.txt", ".\\also-relative", "sub/dir/key"]) {
    const wiring = makeWiring(world);
    const result = await runner.execute(["run", "--expected-batch-commitment", world.commit, "--confirm", BATCH_ID, "--key-file", keyFile], wiring.common);
    assert.equal(result.status, "FAIL_CLOSED", keyFile);
    assert.equal(result.blocker, "RUNNER_KEY_FILE_INVALID", keyFile);
  }
  const missing = await runner.execute(["run", "--expected-batch-commitment", world.commit, "--confirm", BATCH_ID], makeWiring(world).common);
  assert.equal(missing.blocker, "RUNNER_ARGUMENTS_INVALID");
  assert.equal(terminalCount(world), 0);
});

test("unknown, duplicated, missing, and malformed flags are refused", async (t) => {
  const world = makeWorld(t);
  const cases = [
    ["unknown flag", ["run", "--expected-batch-commitment", world.commit, "--confirm", BATCH_ID, "--key-file", world.keyFile, "--wat", "x"]],
    ["duplicate flag", ["run", "--expected-batch-commitment", world.commit, "--confirm", BATCH_ID, "--confirm", BATCH_ID, "--key-file", world.keyFile]],
    ["duplicate boolean", ["run", "--expected-batch-commitment", world.commit, "--confirm", BATCH_ID, "--key-file", world.keyFile, "--check", "--check"]],
    ["missing confirm", ["run", "--expected-batch-commitment", world.commit, "--key-file", world.keyFile]],
    ["missing commitment", ["run", "--confirm", BATCH_ID, "--key-file", world.keyFile]],
    ["bad commitment", ["run", "--expected-batch-commitment", "not-a-hash", "--confirm", BATCH_ID, "--key-file", world.keyFile]],
    ["empty argv", []],
    ["unknown command", ["dispatch-once"]],
  ];
  for (const [name, argv] of cases) {
    const wiring = makeWiring(world);
    const result = await runner.execute(argv, wiring.common);
    assert.equal(result.status, "FAIL_CLOSED", name);
    assert.equal(result.blocker, "RUNNER_ARGUMENTS_INVALID", name);
    assert.equal(terminalCount(world), 0, `${name}: never consumes`);
    assert.equal(wiring.transportCalls.sendRaw, 0, `${name}: never sends`);
  }
});

test("a non-TLS endpoint is refused, including an explicit localhost relay", async (t) => {
  const world = makeWorld(t);
  for (const endpoint of [REJECTED_ENDPOINT, LOCALHOST_HTTP]) {
    const wiring = makeWiring(world, { env: { LIVE_EXECUTION_ENDPOINT: endpoint } });
    const result = await runner.execute(runArgs(world, ["--check"]), wiring.common);
    assert.equal(result.status, "FAIL_CLOSED", endpoint);
    assert.equal(result.blocker, "RUNNER_ENDPOINT_INSECURE", endpoint);
    assert.equal(wiring.transportCalls.sendRaw, 0, endpoint);
    assert.equal(serialized(result).includes(endpoint), false, endpoint);
  }
  // The same policy applies to inventory candidates.
  const wiring = makeWiring(world, { env: {}, readEndpoint: () => [REJECTED_ENDPOINT] });
  const result = await runner.execute(runArgs(world, ["--check"]), wiring.common);
  assert.equal(result.blocker, "RUNNER_ENDPOINT_INSECURE");
});

test("a missing endpoint is refused when neither the environment nor the inventory yields one", async (t) => {
  const world = makeWorld(t);
  for (const readEndpoint of [() => [], () => null, () => "no urls here"]) {
    const wiring = makeWiring(world, { env: {}, readEndpoint });
    const result = await runner.execute(runArgs(world, ["--check"]), wiring.common);
    assert.equal(result.status, "FAIL_CLOSED");
    assert.equal(result.blocker, "RUNNER_ENDPOINT_UNAVAILABLE");
    assert.equal(wiring.transportCalls.sendRaw, 0);
    assert.equal(terminalCount(world), 0);
  }
});

test("an inventory-sourced HTTPS endpoint is accepted and never echoed", async (t) => {
  const world = makeWorld(t);
  const wiring = makeWiring(world, { env: {}, readEndpoint: () => [ENV_ENDPOINT] });
  const result = await runner.execute(runArgs(world, ["--check"]), wiring.common);
  assert.equal(result.status, "READY");
  assert.deepEqual(wiring.resolverEvents[0].providerUrls, [ENV_ENDPOINT]);
  assert.equal(serialized(result).includes(ENV_ENDPOINT), false);
});

test("a failing signer loader fails closed and still zeroizes nothing it never received", async (t) => {
  const world = makeWorld(t);
  const wiring = makeWiring(world, { loaderThrows: true });
  const result = await runner.execute(runArgs(world, ["--check"]), wiring.common);
  assert.equal(result.status, "FAIL_CLOSED");
  assert.equal(result.blocker, "DISPATCH_BROADCAST_SIGNER_UNAVAILABLE");
  assert.equal(terminalCount(world), 0, "a failed preflight never consumes");
  assert.equal(wiring.transportCalls.sendRaw, 0);
});

test("a dispatcher throw is reported as a sanitized runner failure", async (t) => {
  const world = makeWorld(t);
  const wiring = makeWiring(world);
  wiring.deps.dispatch = {
    dispatchOnce: async () => { throw new Error("synthetic dispatcher failure"); },
    preflightOnce: async () => { throw new Error("synthetic dispatcher failure"); },
  };
  const result = await runner.execute(runArgs(world), wiring.common);
  assert.equal(result.status, "FAIL_CLOSED");
  assert.equal(result.blocker, "RUNNER_DISPATCH_FAILED");
  assert.equal(serialized(result).includes("synthetic dispatcher failure"), false);
});

test("parseCli enforces the exact flag contract", () => {
  const world = { commit: `0x${"ab".repeat(32)}`, keyFile: path.join(os.tmpdir(), "key") };
  const parsed = runner.parseCli(["run", "--expected-batch-commitment", world.commit, "--confirm", BATCH_ID, "--key-file", world.keyFile, "--check"]);
  assert.equal(parsed.command, "run");
  assert.equal(parsed.options.check, true);
  assert.equal(parsed.options.keyFile, world.keyFile);
  assert.throws(() => runner.parseCli(["run", "--check", "--expected-batch-commitment", world.commit, "--confirm", BATCH_ID, "--key-file", world.keyFile, "--check"]), /RUNNER_ARGUMENTS_INVALID/u);
});

test("the CLI entrypoint slices argv correctly and refuses an absent canonical batch", () => {
  const script = path.join(__dirname, "..", "live-execution-dispatch-runner.js");
  const commit = `0x${"1".repeat(64)}`;
  const run = spawnSync(process.execPath, [
    script, "run",
    "--expected-batch-commitment", commit,
    "--confirm", "a1b2c3d4e5f60718",
    "--key-file", path.join(os.tmpdir(), "unused-signer.key"),
    "--check",
  ], {
    encoding: "utf8",
    env: { ...process.env, LIVE_EXECUTION_ENDPOINT: ENV_ENDPOINT },
  });
  assert.notEqual(run.status, 0, "a non-READY check exits non-zero");
  const payload = JSON.parse(run.stdout.trim());
  // A correct argv slice reaches the dispatcher and refuses the absent batch. A
  // broken slice would fail earlier with RUNNER_ARGUMENTS_INVALID.
  assert.equal(payload.blocker, "DISPATCH_BATCH_STATE_ABSENT");
  assert.equal(run.stdout.includes(ENV_ENDPOINT), false, "the endpoint URL is never printed");
  assert.doesNotMatch(run.stdout, /[A-Za-z]:\\/u, "no absolute path is printed");
});

test("sanitizeSends applies the exact publish rule and omits malformed entries", () => {
  const good = { index: 0, txHash: `0x${"ab".repeat(32)}`, status: "SUCCESS" };
  assert.deepEqual(runner.sanitizeSends([good, { index: -1, txHash: good.txHash, status: "SUCCESS" }]), [good]);
  assert.deepEqual(runner.sanitizeSends([{ index: 0, txHash: `0x${"AB".repeat(32)}`, status: "SUCCESS" }]), []);
  assert.deepEqual(runner.sanitizeSends([{ index: 0, txHash: good.txHash, status: "HASH_MISMATCH" }]), []);
  assert.deepEqual(runner.sanitizeSends("nope"), []);
});
