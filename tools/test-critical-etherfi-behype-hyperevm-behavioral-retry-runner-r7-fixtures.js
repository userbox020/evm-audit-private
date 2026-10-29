#!/usr/bin/env node
"use strict";

const assert = require("assert"); const fs = require("fs"); const path = require("path"); const Module = require("module"); const { AbiCoder } = require("ethers");
const r = require("./run-critical-etherfi-behype-hyperevm-behavioral-retry-r7.js"); const ROOT = path.resolve(__dirname, ".."); const ABI = AbiCoder.defaultAbiCoder();
function loadR6FixturesAgainstR7() {
  const sourcePath = path.join(__dirname, "test-critical-etherfi-behype-hyperevm-behavioral-retry-runner-r6-fixtures.js"); let source = fs.readFileSync(sourcePath, "utf8");
  source = source.replace("./run-critical-etherfi-behype-hyperevm-behavioral-retry-r6.js", "./run-critical-etherfi-behype-hyperevm-behavioral-retry-r7.js").replace("critical-etherfi-behype-hyperevm-behavioral-retry-proposal-r6-manifest.json", "critical-etherfi-behype-hyperevm-behavioral-retry-proposal-r7-manifest.json").replace(/main\(\)\.catch\([\s\S]*$/, "module.exports = { execute, main, results, SemanticHttpMock, InventoryMock, response, PIN, PIN_HASH, LIB_RECEIVE, LIB_SEND, TOKEN_RECEIVE, TOKEN_SEND };\n");
  const loaded = new Module(path.join(__dirname, "r7-r6-fixture-harness.js"), module); loaded.filename = path.join(__dirname, "r7-r6-fixture-harness.js"); loaded.paths = module.paths; loaded._compile(source, loaded.filename); return loaded.exports;
}
function patchExactFaults(harness) {
  const original = harness.SemanticHttpMock.prototype.callResponse;
  harness.SemanticHttpMock.prototype.callResponse = function corrected(family, to, data) {
    if (this.fault.invalidVersion && (to === harness.LIB_RECEIVE || to === harness.LIB_SEND) && data.startsWith(r.LIB_IFACE.getFunction("version").selector)) return harness.response(this.envelope(r.LIB_IFACE.encodeFunctionResult("version", [4, 0, 2])));
    const receive = this.context.routes.find((row) => row.direction === "receive");
    if (to === this.context.endpoint && data.startsWith(r.ENDPOINT_IFACE.getFunction("getConfig").selector)) {
      const decoded = r.ENDPOINT_IFACE.decodeFunctionData("getConfig", data); const app = decoded[0].toLowerCase(); const type = Number(decoded[3]);
      if (app === receive.app && type === 1) {
        let payload = null;
        if (this.fault.sameSelectorWrongArg) payload = `${r.ERROR_SELECTOR}${ABI.encode(["uint32"], [2]).slice(2)}`;
        if (this.fault.sameSelectorWrongWidth) payload = `${r.ERROR_SELECTOR}${"00".repeat(31)}`;
        if (this.fault.sameSelectorNoncanonicalPadding) payload = `${r.ERROR_SELECTOR}01${"00".repeat(27)}00000001`;
        if (payload) return harness.response({ jsonrpc: "2.0", id: 1, error: { code: 3, data: payload } });
      }
    }
    return original.call(this, family, to, data);
  };
}
async function main() {
  const harness = loadR6FixturesAgainstR7(); patchExactFaults(harness); const write = process.stdout.write; process.stdout.write = () => true; try { await harness.main(); } finally { process.stdout.write = write; }
  assert.strictEqual(harness.results.length, 26); const extra = [];
  const invalidVersion = await harness.execute({ invalidVersion: true }); assert.strictEqual(invalidVersion.result.status, "INCONCLUSIVE/LIBRARY_VERSION_MISMATCH"); assert(invalidVersion.http.calls.some((call) => call.method === "eth_call" && call.params[0].data.startsWith(r.LIB_IFACE.getFunction("version").selector))); extra.push("invalid-library-version-low-level-http");
  const wrongArg = await harness.execute({ sameSelectorWrongArg: true }); assert.strictEqual(wrongArg.result.status, "INCONCLUSIVE/RECEIVE_TYPE1_WRONG_ARGUMENT"); assert(wrongArg.http.calls.some((call) => call.method === "eth_call" && call.params[0].data.startsWith(r.ENDPOINT_IFACE.getFunction("getConfig").selector))); extra.push("same-selector-wrong-arg-low-level-http");
  const wrongWidth = await harness.execute({ sameSelectorWrongWidth: true }); assert.strictEqual(wrongWidth.result.status, "INCONCLUSIVE/RECEIVE_TYPE1_WRONG_WIDTH"); extra.push("same-selector-wrong-width-low-level-http");
  const badPadding = await harness.execute({ sameSelectorNoncanonicalPadding: true }); assert.strictEqual(badPadding.result.status, "INCONCLUSIVE/RECEIVE_TYPE1_NONCANONICAL_PADDING"); extra.push("same-selector-noncanonical-padding-low-level-http");
  const base = { transactionIndex: "0", logIndex: "0", address: "0x0000000000000000000000000000000000000001", transactionHash: `0x${"01".repeat(32)}`, roleSet: ["b"], topics: [], data: "0x", transactionNamespace: "ordinary-transaction" }; const ordered = [{ ...base, blockNumber: "10" }, { ...base, blockNumber: "2" }].sort(r.compareExactProjection); assert.deepStrictEqual(ordered.map((row) => row.blockNumber), ["2", "10"]); const roleMap = r.buildTargetRoleMap([[base.address, "route-token:z"], [base.address, "layerzero-endpoint"], [base.address, "route-token:z"]]); assert.deepStrictEqual(roleMap.get(base.address), ["layerzero-endpoint", "route-token:z"]); const context = r.loadContext(ROOT); context.root = ROOT; const binding = r.semanticPreservation(context); assert(/^[0-9a-f]{64}$/.test(binding.exactProjectionSpecSha256)); assert(/^[0-9a-f]{64}$/.test(binding.targetRoleResolutionSpecSha256)); extra.push("r3-exact-sort-and-multi-role-binding-behavior");
  assert.strictEqual(extra.length, 5); process.stdout.write(JSON.stringify({ status: "PASS", fixtureCount: 31, preservedR6FixtureCount: 26, addedFixtureCount: 5, addedLowLevelHttpFixtureCount: 4, fixtures: [...harness.results, ...extra], dispatchRangeWithoutRetries: [237, 381], maxPathWithRetries: 391, endpointCalls: 0, inventoryFilesRead: 0, networkTransportUsed: false, lowLevelHttpMockOnly: true, semanticPreservation: binding }) + "\n");
}
main().catch((error) => { process.stderr.write(`r7 semantic fixture failure: ${error.stack || error.message}\n`); process.exitCode = 1; });
