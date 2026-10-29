"use strict";

// Offline cross-language fixtures: real producer serializers and the real batch
// verifier, with injected RPCs and temporary output paths. No live collection.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = process.argv[3];
const input = JSON.parse(process.argv[4] || "{}");
const tools = path.resolve(__dirname, "../../tools");
const load = name => require(path.join(tools, name));
global.fetch = () => { throw new Error("NETWORK_NOT_ALLOWED"); };

async function producers() {
  const etherfi = load("run-critical-etherfi-debtmanager-profit-trigger.js");
  const trigger = await etherfi.runTrigger({ candidates: [], rpcCall: async () => { throw new Error("offline"); } });
  assert.equal(etherfi.validateArtifact(trigger), true);
  const sentinel = load("run-official-deployed-delta-sentinel.js");
  const deployed = await sentinel.runSentinel({
    outputPath: path.join(root, "sentinel.json"), baselinePath: path.join(root, "baseline.json"), runsDir: path.join(root, "runs"),
    tokenProvider: () => null, transport: { request: async () => { throw new Error("offline"); } }, randomId: () => "fixture",
  });
  assert.equal(sentinel.validateRunArtifact(deployed), true);
  const dispatcher = load("monitor-alert-dispatcher.js").runDispatcher({ inputs: {}, priorState: null, priorQueue: null }).status;
  load("shared-rpc.js").loadRpcUrls = () => [];
  const euler = load("watch-euler-l.js");
  const monitorOnly = load("monitor-minimal-env.js").forceMonitorOnlyArtifact;
  const statuses = [];
  for (const ok of [false, true]) {
    const transport = {
      count: 0, remaining() { return 60 - this.count; },
      async rpc(_url, method, params) {
        this.count++;
        if (!ok) throw new Error("offline");
        if (method === "eth_chainId") return "0x1";
        if (method === "eth_getCode") return "0x6000";
        if (method === "eth_getBlockByNumber") return { number: params[0].startsWith("0x") ? params[0] : "0x1e8480", hash: "0x" + "ab".repeat(32) };
        if (method === "eth_call") {
          const [calls] = euler.MC.decodeFunctionData("aggregate3", params[0].data);
          const results = calls.map(call => {
            const fn = euler.EV.parseTransaction({ data: call.callData }).name;
            const value = ["asset", "oracle", "unitOfAccount"].includes(fn) ? "0x" + "11".repeat(20) : 1n;
            return [true, euler.EV.encodeFunctionResult(fn, [value])];
          });
          return euler.MC.encodeFunctionResult("aggregate3", [results]);
        }
        throw new Error("unexpected method");
      },
    };
    const result = await euler.runSweep({
      cycle: 1, startedAt: new Date().toISOString(), cursor: 0, transport, factory: euler.FACTORY_FALLBACK,
      config: euler.parseArgs(["--once"]),
      surface: { present: ok, fresh: ok, reason: null, ageMs: ok ? 0 : null, artifact: ok ? {
        scannedAt: new Date().toISOString(), vaults: [{ vault: "0x" + "22".repeat(20), currentTotalBorrowsRaw: "1" }],
      } : null },
    });
    statuses.push(monitorOnly(result.status, { batchPath: path.join(root, "absent-batch.json") }));
  }
  return { etherfi: trigger, sentinel: deployed, dispatcher, eulerFailed: statuses[0], eulerHealthy: statuses[1] };
}

function batches() {
  const batch = load("live-execution-batch.js");
  const approval = load("test/live-execution-batch-fixture.js").createApprovalFixture(root);
  const now = Date.parse("2030-01-01T12:00:00.000Z");
  const scope = {
    schema: batch.SCHEMA, batchId: "a1b2c3d4e5f60718", mode: "FORK_TESTNET", chainId: "1",
    accountRef: "0x" + "11".repeat(20),
    actions: [{ from: "0x" + "11".repeat(20), to: "0x" + "22".repeat(20), valueWei: "0", data: "0xa9059cbb" + "0".repeat(128), gasLimit: "100000", slippageBps: "50" }],
    gasCeiling: "1000000", anvil: { executablePath: path.join(root, "synthetic-anvil.exe"), sha256: "0x" + "33".repeat(32), version: "anvil test-version" },
    issuedAt: "2030-01-01T00:00:00.000Z", notBefore: "2030-01-01T00:00:00.000Z", expiresAt: "2030-01-02T00:00:00.000Z", nonce: "0123456789abcdef",
  };
  const reports = {};
  for (const state of ["ABSENT", "UNSIGNED", "BAD_SIGNATURE", "VALID", "NOT_YET_VALID", "EXPIRED", "CONSUMED", "REVOKED"]) {
    const dir = path.join(root, state);
    fs.mkdirSync(dir);
    const batchPath = path.join(dir, "batch.json");
    const signed = approval.sign({ ...scope, ...(state === "NOT_YET_VALID" ? { notBefore: "2030-01-01T18:00:00.000Z" } : {}) });
    if (state === "BAD_SIGNATURE") signed.approval.signature = Buffer.alloc(64).toString("base64");
    if (state !== "ABSENT") fs.writeFileSync(batchPath, JSON.stringify(state === "UNSIGNED"
      ? { approved: true, expiresAt: "2099-01-01T00:00:00Z", actions: [{}] } : signed));
    if (["CONSUMED", "REVOKED"].includes(state)) {
      const commitment = batch.commitment(signed);
      fs.writeFileSync(batch.terminalPathFor(commitment, batchPath), JSON.stringify({
        schema: batch.TERMINAL_SCHEMA, state, batchId: signed.batchId, batchCommitment: commitment, terminalAt: "2030-01-01T01:00:00.000Z",
        ...(state === "CONSUMED" ? { manifestCommitment: "0x" + "44".repeat(32), runId: "fixture-run" } : { revocationRef: "fixture-revoke" }),
      }));
    }
    reports[state] = { ok: true, ...batch.report(batch.batchState({
      batchPath, registryPath: approval.registryPath, registrySha256: approval.registrySha256,
      now: () => state === "EXPIRED" ? now + 86400000 : now,
    })) };
    assert.equal(reports[state].authorizationState, ["UNSIGNED", "BAD_SIGNATURE"].includes(state) ? "INVALID" : state);
  }
  return reports;
}

async function wallet() {
  const collector = load("watch-wallet-balances.js");
  const { artifact } = await collector.runOnce({
    watchlist: input.watchlist, chainEndpoints: new Map(input.noEvm ? [] : [[1, "https://fixture.invalid"]]),
    call: async (_url, method) => method === "eth_blockNumber" ? "0x1" : input.failEvm ? null : "0xde0b6b3a7640000",
    stablecoins: {}, nativePrices: { ethereum: 5, solana: 7 },
    solanaUrls: ["https://fixture.invalid"], solanaTokens: [],
    solanaCall: async (_url, method) => method === "getBalance" ? { value: 1000000000 } : 1,
  });
  return artifact;
}

(async () => {
  const kind = process.argv[2];
  const result = kind === "producers" ? await producers() : kind === "batches" ? batches()
    : kind === "wallet" ? await wallet() : input.map(address => Boolean(load("watch-wallet-balances.js").normalizeSolanaAddress(address)));
  process.stdout.write(JSON.stringify(result));
})().catch(error => { process.stderr.write(String(error.stack)); process.exitCode = 1; });
