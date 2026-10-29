#!/usr/bin/env node
"use strict";

const assert = require("assert");
const {
  quantity,
  strictQuantity,
  strictHash,
  normalizeAddressWord,
  stableDigest,
  cborTail,
  compareRuntime,
  functionBodies,
  classifyOrdinaryTransfer,
  leakGuard
} = require("./capture-raft-callback-runtime-source-continuity-step3");

let checks = 0;
function ok(value, message) { checks += 1; assert.ok(value, message); }
function rejects(fn, message) { checks += 1; assert.throws(fn, message); }

ok(quantity(16n) === "0x10", "quantity encoding");
ok(strictQuantity("0x10", "fixture") === 16n, "strict quantity");
rejects(() => strictQuantity("0x00", "fixture"), "leading zero rejected");
ok(strictHash(`0x${"ab".repeat(32)}`, "fixture").length === 66, "strict hash");
rejects(() => strictHash(`0x${"AB".repeat(32)}`, "fixture"), "uppercase hash rejected");
ok(normalizeAddressWord(`0x${"0".repeat(24)}${"1".padStart(40, "0")}`) === "0x0000000000000000000000000000000000000001", "storage address");
ok(normalizeAddressWord(`0x${"0".repeat(64)}`) === null, "zero storage address");
ok(stableDigest({ a: 1 }) === stableDigest({ a: 1 }), "stable digest");
ok(stableDigest({ a: 1 }) !== stableDigest({ a: 2 }), "sensitive digest");

const withCbor = "0x6000a101000003";
ok(cborTail(withCbor) === "0xa101000003", "CBOR tail extraction");
const exact = compareRuntime("0x60016002", "0x60016002", {}, {});
ok(exact.exactAfterImmutableMask && exact.unmaskedDifferences === 0, "exact runtime");
const immutable = compareRuntime("0x60000002", "0x60ff0002", { x: [{ start: 1, length: 1 }] }, {});
ok(immutable.exactAfterImmutableMask && immutable.immutableReferenceCount === 1, "immutable masking");
const mismatch = compareRuntime("0x60000002", "0x60ff0003", { x: [{ start: 1, length: 1 }] }, {});
ok(!mismatch.exactAfterImmutableMask && mismatch.unmaskedDifferences === 1, "unmasked mismatch");
const linked = compareRuntime("0x6000", "0x6000", {}, { "A.sol": { L: [{ start: 0, length: 2 }] } });
ok(!linked.exactAfterImmutableMask && linked.unresolvedLinkReferenceCount === 1, "unresolved link rejected");

const plainSources = {
  "ERC20.sol": { content: "contract ERC20 { mapping(address=>uint) b; function transfer(address to,uint amount) public returns(bool){ _transfer(msg.sender,to,amount); return true; } function transferFrom(address from,address to,uint amount) public returns(bool){ _transfer(from,to,amount); return true; } function _transfer(address from,address to,uint amount) internal { b[from]-=amount; b[to]+=amount; } }" }
};
const plain = classifyOrdinaryTransfer({ sources: plainSources });
ok(plain.ordinaryTransferCallback === false && plain.classification.startsWith("PLAIN-ERC20"), "plain ERC20 classified");
const erc223 = classifyOrdinaryTransfer({ sources: { "T.sol": { content: "contract T { function transfer(address to,uint value) public { tokenFallback(to,value,bytes(\"\")); } function tokenFallback(address,uint,bytes memory) internal {} }" } } });
ok(erc223.ordinaryTransferCallback === true && erc223.erc223TokenFallback, "ERC223 callback classified");
const optIn = classifyOrdinaryTransfer({ sources: { "T.sol": { content: "contract T { function transfer(address,uint) public returns(bool){return true;} function transferAndCall(address,uint,bytes memory) public { onTransferReceived(); } function onTransferReceived() internal {} }" } } });
ok(optIn.ordinaryTransferCallback === false && optIn.optInOnlyERC1363, "opt-in callback not confused with ordinary transfer");
ok(functionBodies(plainSources["ERC20.sol"].content, "transfer").length === 1, "function body extraction");

ok(leakGuard({ address: "0x0000000000000000000000000000000000000001" }) === undefined, "sanitized artifact accepted");
rejects(() => leakGuard({ value: "https://example.invalid/secret" }), "URL rejected");
rejects(() => leakGuard({ value: "provider.example.com" }), "domain rejected");
rejects(() => leakGuard({ value: "Bearer secret" }), "header rejected");
rejects(() => leakGuard({ rpcUrl: "redacted" }), "endpoint field rejected");

console.log(`PASS ${checks} offline fixture checks`);
