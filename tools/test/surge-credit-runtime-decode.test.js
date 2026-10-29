"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { ethers } = require("ethers");
const decoder = require("../lib/surge-credit-runtime-decode");
function commitments(runtime) {
  const bytes = Buffer.from(runtime.slice(2), "hex");
  return { codeBytes: bytes.length, codeSha256: crypto.createHash("sha256").update(bytes).digest("hex"), codeKeccak256: ethers.keccak256(bytes) };
}
test("reject malformed hex, absent commitments and incorrect length/hash", () => {
  for (const runtime of ["0x", "0x1", "0xgg", "6000", "0x6000\n"]) assert.throws(() => decoder.validateRuntime(runtime, {}));
  const runtime = "0x5f00", expected = commitments(runtime);
  assert.equal(decoder.validateRuntime(runtime, expected).codeBytes, 2);
  assert.throws(() => decoder.validateRuntime(runtime));
  for (const mismatch of [{ codeBytes: 3 }, { codeSha256: "0".repeat(64) }, { codeKeccak256: `0x${"0".repeat(64)}` }]) {
    assert.throws(() => decoder.validateRuntime(runtime, { ...expected, ...mismatch }), /RUNTIME_COMMITMENT_MISMATCH/);
  }
});
test("PUSH0 and PUSH data boundaries prevent false embedded selectors/jumpdest", () => {
  const embedded = "63deadbeef1460105700".padEnd(64, "0");
  const runtime = `0x7f${embedded}5f00`, instructions = decoder.disassemble(runtime);
  assert.deepEqual(instructions.map(row => row.pc), [0, 33, 34]);
  assert.deepEqual(instructions.map(row => row.name), ["PUSH32", "PUSH0", "STOP"]);
  assert.deepEqual(decoder.dispatchComparisons(instructions), []);
  assert.equal(decoder.disassemble("0x63aabb")[0].truncated, true);
});
test("dispatcher comparison requires real instruction sequence and valid target", () => {
  const runtime = "0x63deadbeef14600a57005b00";
  const facts = decoder.decodeRuntime({ runtime, expected: commitments(runtime) });
  assert.equal(facts.dispatcher[0].selector, "0xdeadbeef");
  assert.equal(facts.dispatcher[0].entryPC, 10); assert.equal(facts.dispatcher[0].validJumpdest, true);
  assert.equal(facts.completeCFG, false); assert.equal(facts.semanticProof, false);
  assert.throws(() => decoder.decodeRuntime({ runtime, expected: commitments(runtime), entries: { deadbeef: [2] } }), /ENTRY_NOT_JUMPDEST/);
});
test("bounded dynamic jumps remain UNRESOLVED and caps truncate rather than imply complete CFG", () => {
  const runtime = "0x5f35565b600356";
  const facts = decoder.decodeRuntime({ runtime, expected: commitments(runtime), entries: { aabbccdd: [3] }, maxBlocks: 1 });
  assert(facts.edges.some(edge => edge.to === null && edge.kind.includes("UNRESOLVED")));
  assert.equal(facts.bounds.truncated, true); assert.equal(facts.completeCFG, false);
  const trace = decoder.decodeRuntime({ runtime: "0x335f54600055fd", expected: commitments("0x335f54600055fd") });
  assert(trace.blocks.flatMap(block => block.annotations).some(row => row.kind === "CALLER" && row.predicate === "UNRESOLVED"));
  assert(trace.blocks.flatMap(block => block.annotations).some(row => row.kind === "SLOAD" && row.slotLiteral.endsWith("00")));
});
test("external call target is only annotated when local abstract stack proves literal", () => {
  const target = "64c911996d3c6ac71f9b455b1e8e7266bcbd848f";
  const runtime = `0x5f5f5f5f73${target}5afa00`;
  const facts = decoder.decodeRuntime({ runtime, expected: commitments(runtime) });
  assert.equal(facts.blocks[0].annotations.find(row => row.kind === "STATICCALL").targetLiteral, `0x${target}`);
});
test("buy(id,bytes) has both offset and length, including empty/non-word-aligned data", () => {
  for (const data of ["0x", "0x123456", `0x${"ab".repeat(33)}`]) {
    const encoded = decoder.encodeBuy(291n, data), decoded = decoder.decodeBuy(encoded);
    assert.equal(decoded.id, "291"); assert.equal(decoded.offsetBytes, 64);
    assert.equal(decoded.lengthBytes, (data.length - 2) / 2); assert.equal(decoded.data, data);
    assert.equal(BigInt(`0x${encoded.slice(74, 138)}`), 64n);
    assert.equal(BigInt(`0x${encoded.slice(138, 202)}`), BigInt(decoded.lengthBytes));
  }
  const encoded = decoder.encodeBuy(1n, "0x1234");
  assert.throws(() => decoder.decodeBuy(encoded.slice(0, 138) + encoded.slice(202)), /BUY_/); // legacy missing dynamic length
  assert.throws(() => decoder.decodeBuy(encoded.slice(0, -2)), /BUY_/);
  assert.throws(() => decoder.decodeBuy(encoded + "00"), /BUY_/);
});
test("decode all five actual historical archives with exact source/code commitments, never fresh proof", t => {
  const workspace = path.resolve(__dirname, "../.."), archive = path.join(workspace, "reports/coverage-unblock-20261018/surge-runtime-archive");
  const manifest = JSON.parse(fs.readFileSync(path.join(archive, "manifest.json"), "utf8"));
  assert.equal(manifest.currentChainBindingVerified, false); assert.equal(manifest.rows.length, 5);
  for (const row of manifest.rows) {
    const runtime = fs.readFileSync(path.join(archive, row.runtimeFile), "utf8").trim();
    const sourceBytes = fs.readFileSync(path.join(workspace, ...row.sourcePath.split(/[\\/]/)));
    const facts = decoder.decodeRuntime({ runtime, expected: row, sourceBytes, role: row.role });
    assert.equal(facts.commitments.codeBytes, row.codeBytes); assert.equal(facts.sourceArtifact.sourceFileCommitmentVerified, true);
    assert.equal(facts.sourceArtifact.verifiedContractSource, false); assert.equal(facts.currentChainBindingVerified, false);
    assert.equal(facts.semanticProof, false); assert.equal(facts.completeCFG, false);
    if (row.role === "vault-manager") {
      assert.equal(row.codeSha256, "e471cc8c94ed353ad2b3f57b1a2e9c4c0f2eb61e9d3ac2dec21efba7978a2fcc");
      assert.equal(facts.explicitEntries.length, 8);
      assert(facts.explicitEntries.some(entry => entry.selector === "0xdfe8f671" && entry.pc === 0x987));
    }
    if (row.role === "auction-house") assert.equal(facts.explicitEntries.length, 8);
    if (row.role === "oracle") {
      assert.equal(facts.oracleReferenceFacts.convergenceIsJumpdest, true);
      assert(facts.oracleReferenceFacts.literalFeedPCs.length > 0);
      assert(facts.oracleReferenceFacts.constant3600PCs.length > 0);
      assert.equal(facts.oracleReferenceFacts.convergenceCallsites.length, 3);
      assert(facts.oracleReferenceFacts.externalCalls.some(call => call.targetLiteral === "0x64c911996d3c6ac71f9b455b1e8e7266bcbd848f"));
      assert.equal(facts.oracleReferenceFacts.scalingAndFreshnessPredicate, "UNRESOLVED");
    }
    t.diagnostic(`${row.role}: bytes=${facts.commitments.codeBytes} instructions=${facts.instructions.length} comparisons=${facts.dispatcher.length} blocks=${facts.blocks.length} unresolved=${facts.unresolvedPredicates.length} capped=${facts.bounds.truncated}`);
  }
});
