#!/usr/bin/env node
"use strict";

// Offline suite for the bounded Balancer V3 flash-liquidity/fee (F) producer.
// All RPC interactions are injected doubles; no network, no endpoint material.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");

const scanner = require("./scan-balancer-v3-coverage.js");
const audit = require("./audit-trigger-coverage-universe.js");

const UNIVERSE = JSON.parse(fs.readFileSync(path.join(__dirname, "trigger-coverage-universe.json"), "utf8"));

const IFACE = new ethers.Interface([
  "function getVault() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
]);
const SEL = {
  getVault: IFACE.getFunction("getVault").selector,
  balanceOf: IFACE.getFunction("balanceOf").selector,
};
const resolveRpc = async () => "http://127.0.0.1:8545";

function makeRpc(options = {}) {
  const block = {
    number: "0x100", hash: `0x${"ab".repeat(32)}`, timestamp: "0x100000",
    baseFeePerGas: "0x3b9aca00", stateRoot: `0x${"cd".repeat(32)}`,
  };
  const handleCall = (to, data) => {
    const target = String(to).toLowerCase();
    const selector = data.slice(0, 10);
    if (selector === SEL.getVault) {
      const vault = options.wrongVault ? "0x1111111111111111111111111111111111111111" : scanner.VAULT;
      return IFACE.encodeFunctionResult("getVault", [vault]);
    }
    if (selector === SEL.balanceOf) {
      if (options.failToken && target === String(options.failToken).toLowerCase()) throw new Error("MOCK_TOKEN_FAILURE");
      return IFACE.encodeFunctionResult("balanceOf", [1_000_000n]);
    }
    throw new Error(`UNROUTED_CALL ${target} ${selector}`);
  };
  const rpcCallImpl = async (_url, method, params) => {
    if (method === "eth_getCode") return "0x6000";
    if (method === "eth_getBlockByNumber") return block;
    if (method === "eth_getBlockByHash") return block;
    if (method === "eth_call") return handleCall(params[0].to, params[0].data);
    throw new Error(`UNROUTED_METHOD ${method}`);
  };
  return { rpcCallImpl };
}

test("binds the V3 Vault on-chain and reads every declared flash token", async () => {
  const { rpcCallImpl } = makeRpc();
  const chain = await scanner.scanChain(1, { rpcCall: rpcCallImpl, resolveRpc });
  assert.equal(chain.chainId, 1);
  assert.equal(chain.vault, scanner.VAULT);
  assert.equal(chain.provenanceVault.toLowerCase(), scanner.VAULT.toLowerCase());
  assert.equal(chain.reads.attempted, 1 + scanner.CHAINS[1].tokens.length);
  assert.equal(chain.reads.failed, 0);
  assert.equal(chain.reads.succeeded, chain.reads.attempted);
  assert.equal(chain.complete, true);
  assert.equal(chain.flashLoanFeeBps, 0);
  assert.equal(chain.balances.length, scanner.CHAINS[1].tokens.length);
});

test("rejects a provenance mismatch instead of trusting a Vault address", async () => {
  const { rpcCallImpl } = makeRpc({ wrongVault: true });
  await assert.rejects(
    () => scanner.scanChain(1, { rpcCall: rpcCallImpl, resolveRpc }),
    /VAULT_PROVENANCE_MISMATCH/,
  );
});

test("fails the chain closed when a declared token read fails", async () => {
  const token = scanner.CHAINS[8453].tokens[0].address;
  const { rpcCallImpl } = makeRpc({ failToken: token });
  const chain = await scanner.scanChain(8453, { rpcCall: rpcCallImpl, resolveRpc });
  assert.equal(chain.complete, false);
  assert.ok(chain.reads.failed >= 1);
  assert.ok(chain.errors.length >= 1);
});

test("coverage evidence maps exactly the enabled V3 F universe rows", async () => {
  const { rpcCallImpl } = makeRpc();
  const artifact = await scanner.scan({ rpcCall: rpcCallImpl, resolveRpc, now: Date.parse("2026-09-20T18:32:18.000Z") });
  assert.equal(artifact.chains.length, 2);
  for (const chain of artifact.chains) {
    const row = UNIVERSE.rows.find((entry) => entry.id === `${chain.chainId === 1 ? "ethereum" : "base"}-balancer-v3-f`);
    assert.ok(row, "missing V3 F universe row");
    assert.equal(row.onFire.enabled, true);
    const evidence = scanner.coverageEvidence(chain, artifact);
    assert.equal(evidence.observedAt, artifact.scannedAt);
    assert.equal(evidence.enumeration.ref, scanner.FLASH_COVERAGE_REF);
    const shape = audit.genericEvidenceShape(evidence, row);
    assert.equal(shape.identity && shape.enumerationBound && shape.readsClean && shape.semanticsExact
      && shape.stagesWired && shape.complete && shape.dispatchEnabled, true);
  }
});

test("publish writes the raw artifact and one F binder per chain", () => {
  const writes = [];
  const fsImpl = { mkdirSync() {}, writeFileSync(file) { writes.push(String(file)); } };
  const originalAtomic = audit.atomicWriteJson;
  audit.atomicWriteJson = (file, value) => writes.push({ file: String(file), value });
  try {
    scanner.publish({
      schema: scanner.RAW_SCHEMA,
      scanner: scanner.SCANNER,
      scannedAt: new Date().toISOString(),
      chains: [{
        chainId: 1, complete: true, vault: scanner.VAULT, provenancePool: scanner.CHAINS[1].provenancePool,
        flashLoanFeeBps: 0, flashLoanFeeNote: "x", balances: [], errors: [],
        reads: { attempted: 5, succeeded: 5, failed: 0, unclassifiedFailures: 0 },
        pin: { number: 1, hash: `0x${"1".repeat(64)}`, timestamp: new Date().toISOString(), finality: "finalized" },
      }],
    }, { fsImpl, rawPath: path.join(scanner.WORKSPACE, "reports", "raw", "fast", "unused.json") });
  } finally {
    audit.atomicWriteJson = originalAtomic;
  }
  const binderWrite = writes.find((entry) => typeof entry === "object");
  assert.ok(binderWrite, "binder write expected");
  assert.ok(binderWrite.file.endsWith("balancer-v3-ethereum-f.json"));
  assert.equal(binderWrite.value.coverage.complete, true);
  assert.equal(binderWrite.value.triggerClass, "F");
});

test("CLI check mode validates the declared chains without network", () => {
  assert.equal(scanner.CHAINS[1].tokens.length > 0, true);
  assert.equal(scanner.CHAINS[8453].tokens.length > 0, true);
  assert.equal(scanner.VAULT, "0xbA1333333333a1BA1108E8412f11850A5C319bA9");
  assert.doesNotMatch(JSON.stringify(scanner.CHAINS), /https?:\/\//i);
});
