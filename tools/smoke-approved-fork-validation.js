#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const batchTool = require("./live-execution-batch");
const runner = require("./run-approved-fork-validation");
const sharedRpc = require("./shared-rpc");

async function rpcResult(url, id, method, params) {
  const response = await runner.defaultTransport(url, { jsonrpc: "2.0", id, method, params }, runner.LIMITS.requestMs);
  if (!response?.value || response.value.jsonrpc !== "2.0" || response.value.id !== id || response.value.error || !Object.hasOwn(response.value, "result")) throw new runner.ForkError("SMOKE_PIN_READ_FAILED", "SMOKE_PIN");
  return response.value.result;
}

async function main() {
  const authorization = batchTool.batchState();
  if (authorization.state !== batchTool.STATES.VALID) throw new runner.ForkError(`BATCH_NOT_VALID:${authorization.state}`, "AUTHORIZATION");
  const approvedBatch = authorization.batch;
  const tempParent = path.join(os.tmpdir(), "opencode");
  if (!fs.existsSync(tempParent)) throw new runner.ForkError("SMOKE_TEMP_PARENT_ABSENT", "SMOKE_SETUP");
  const upstreamUrl = await sharedRpc.resolveRpc(Number(approvedBatch.chainId), null, { maxCandidates: 16, concurrency: 4, timeoutMs: 4000, capability: "read" });
  if (!upstreamUrl) throw new runner.ForkError("SMOKE_UPSTREAM_UNAVAILABLE", "SMOKE_PIN");
  const chainId = await rpcResult(upstreamUrl, 1, "eth_chainId", []);
  const finalized = await rpcResult(upstreamUrl, 2, "eth_getBlockByNumber", ["finalized", false]);
  if (typeof chainId !== "string" || BigInt(chainId) !== BigInt(approvedBatch.chainId) || !finalized || typeof finalized.number !== "string" || !/^0x[0-9a-f]+$/u.test(finalized.number) || typeof finalized.hash !== "string" || !/^0x[0-9a-f]{64}$/u.test(finalized.hash) || typeof finalized.stateRoot !== "string" || !/^0x[0-9a-f]{64}$/u.test(finalized.stateRoot)) throw new runner.ForkError("SMOKE_PIN_INVALID", "SMOKE_PIN");

  const now = Date.now();
  const manifestId = crypto.createHash("sha256").update(`${finalized.hash}:${now}`).digest("hex").slice(0, 16);
  const tempDir = fs.mkdtempSync(path.join(tempParent, "approved-fork-smoke-"));
  const manifestPath = path.join(tempDir, "manifest.json");
  const outPath = path.join(runner.OUT_DIR, `smoke-${manifestId}.json`);
  try {
    const manifest = {
      schema: runner.MANIFEST_SCHEMA,
      manifestId,
      chainId: approvedBatch.chainId,
      pinBlockNumber: BigInt(finalized.number).toString(),
      pinBlockHash: finalized.hash,
      pinStateRoot: finalized.stateRoot,
      pinFinality: "finalized",
      calls: approvedBatch.actions.map((action, index) => ({ id: `approved-${index + 1}`, actor: action.from, to: action.to, data: action.data, valueWei: action.valueWei, gasLimit: action.gasLimit, slippageBps: action.slippageBps })),
      watch: runner.minimumBalanceWatch(approvedBatch.actions.map((action) => ({ actor: action.from, to: action.to, data: action.data }))).map((entry, index) => ({ id: `watch-${index + 1}`, ...entry, decimals: "18" })),
      pricesUsd: [],
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    const deps = runner.defaultDeps();
    deps.resolveUpstream = async () => upstreamUrl;
    const result = await runner.runForkValidation({ manifestPath, outPath, deps });
    runner.writeOnce(outPath, result.output);
    process.stdout.write(`${JSON.stringify({ status: result.output.status, classification: result.output.classification, chainId: result.output.chainId, pinBlockNumber: result.output.pinBlockNumber, watchedStateRollbackVerified: result.output.watchedStateRollbackVerified, localForkTransactions: result.output.safety.localForkTransactions, artifact: path.relative(runner.ROOT, outPath) })}\n`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ status: "FAIL_CLOSED", stage: error instanceof runner.ForkError ? error.stage : "SMOKE", blocker: error instanceof runner.ForkError ? error.code : "SMOKE_INTERNAL_FAILURE_REDACTED" })}\n`);
  process.exitCode = 1;
});
