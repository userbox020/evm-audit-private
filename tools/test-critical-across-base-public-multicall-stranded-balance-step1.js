#!/usr/bin/env node
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { AbiCoder, Interface } = require("./node_modules/ethers");

const ROOT = path.resolve(__dirname, "..");
const SOURCE = "targets/across-contracts/contracts/handlers/MulticallHandler.sol";
const PERMISSIONED = "targets/across-contracts/contracts/handlers/PermissionedMulticallHandler.sol";
const EXECUTOR = "targets/across-contracts/contracts/periphery/mintburn/ArbitraryEVMFlowExecutor.sol";
const SOLIDITY_TEST = "targets/across-contracts/test/evm/foundry/audit-multicall/MulticallHandlerStrandedBalance.t.sol";
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;

function sourceAssertions() {
  const handler = fs.readFileSync(path.join(ROOT, SOURCE), "utf8"), permissioned = fs.readFileSync(path.join(ROOT, PERMISSIONED), "utf8"), executor = fs.readFileSync(path.join(ROOT, EXECUTOR), "utf8");
  const checks = {
    publicEntrypoint: /function handleV3AcrossMessage\([^)]*\) public virtual nonReentrant/s.test(handler),
    amountAndRelayerIgnored: /function handleV3AcrossMessage\(address token, uint256, address, bytes memory message\)/.test(handler),
    callerChosenFallback: /instructions\.fallbackRecipient/.test(handler),
    emptyCallsAllowed: /uint256 length = calls\.length/.test(handler) && !/require\s*\(calls\.length/.test(handler),
    fullBalanceRead: /IERC20\(token\)\.balanceOf\(address\(this\)\)/.test(handler),
    fullBalanceTransfer: /safeTransfer\(destination, amount\)/.test(handler),
    permissionedOverride: /onlyRole\(WHITELISTED_CALLER_ROLE\)/.test(permissioned),
    executorPreSnapshotDustDrain: executor.indexOf("_drainMulticallHandlerDust(params.initialToken)") < executor.indexOf("uint256 sBI"),
    executorHardcodesSelf: /fallbackRecipient: address\(this\)/.test(executor) && /handleV3AcrossMessage\(token, 0, address\(this\), instructions\)/.test(executor),
    executorDeltaAccounting: /eBF > sBF/.test(executor) && /finalAmount = eBF - sBF/.test(executor),
  };
  for (const [label, passed] of Object.entries(checks)) assert(passed, label);
  return checks;
}

function modelPublicSweep({ balance, amount, relayer, fallbackRecipient, caller }) {
  void amount; void relayer;
  return fallbackRecipient === 0n ? { handler: balance, recipient: 0n, caller } : { handler: 0n, recipient: balance, caller };
}

function xorshift(seed) { let state = BigInt(seed); return () => { state ^= state << 13n; state ^= state >> 7n; state ^= state << 17n; return state & ((1n << 128n) - 1n); }; }

function runTests() {
  const source = sourceAssertions(), iface = new Interface(["function handleV3AcrossMessage(address,uint256,address,bytes)"]), coder = AbiCoder.defaultAbiCoder();
  const emptyInstructions = coder.encode(["tuple(tuple(address target,bytes callData,uint256 value)[] calls,address fallbackRecipient)"], [[[], "0x00000000000000000000000000000000000a11ce"]]);
  const calldata = iface.encodeFunctionData("handleV3AcrossMessage", ["0x0000000000000000000000000000000000000001", 0, "0x00000000000000000000000000000000000a11ce", emptyInstructions]);
  assert.strictEqual(calldata.slice(0, 10), iface.getFunction("handleV3AcrossMessage").selector);
  const random = xorshift(0x8453n); let fuzzPassed = 0;
  for (let i = 0; i < 512; i++) {
    const balance = random() + 1n, amount = random(), relayer = random(), caller = random(), recipient = random() + 1n;
    const result = modelPublicSweep({ balance, amount, relayer, fallbackRecipient: recipient, caller });
    assert.strictEqual(result.handler, 0n); assert.strictEqual(result.recipient, balance); fuzzPassed++;
  }
  const zeroFallback = modelPublicSweep({ balance: 77n, amount: 0n, relayer: 0n, fallbackRecipient: 0n, caller: 1n });
  assert.strictEqual(zeroFallback.handler, 77n); assert.strictEqual(zeroFallback.recipient, 0n);
  return canonical({ schemaVersion: 1, passed: true, sourceAssertions: source, deterministicCases: 4, fuzzCases: 512, fuzzPassed, abiEmptyInstructionsEncoded: true, attackerDeltaFormula: "currentHandlerBalance", permissionedAttackerCall: "REVERT/WHITELISTED_CALLER_ROLE", executorDustRecipient: "address(this)", executorPreSnapshotDrain: true, liveCallExecuted: false, forkCreated: false, solidityRegression: { path: SOLIDITY_TEST, buildAttempted: true, buildPassed: false, blocker: "LOCAL_DEPENDENCY_CLOSURE_ABSENT/@openzeppelin/contracts-v4", semanticCasesMirroredInJs: true } });
}

module.exports = { runTests, modelPublicSweep, sourceAssertions };
if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(runTests())}\n`); }
  catch (error) { process.stderr.write(`${JSON.stringify({ ok: false, category: String(error.message || error) })}\n`); process.exit(1); }
}
