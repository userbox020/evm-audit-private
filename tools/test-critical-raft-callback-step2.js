#!/usr/bin/env node
"use strict";

const assert = require("assert");
const {
  strictQuantity,
  strictHash,
  strictAddress,
  normalizeWordAddress,
  digest,
  leakGuard,
  deriveHeadroom,
  classifySupportResult,
  validateCallbackIndicators,
  classifyCallbackIndicators,
  validateAdmissionUniqueness,
  validateEventCurrentTupleIdentity,
  validateFeeRecipientEquality
} = require("./capture-critical-raft-callback-step2");

let checks = 0;
function ok(condition, message) {
  checks += 1;
  assert.ok(condition, message);
}
function rejects(fn, message) {
  checks += 1;
  assert.throws(fn, message);
}

ok(strictQuantity("0x0", "fixture") === 0n, "zero quantity");
ok(strictQuantity("0x123", "fixture") === 0x123n, "positive quantity");
rejects(() => strictQuantity("0x00", "fixture"), "leading zero rejected");
rejects(() => strictQuantity("0xABC", "fixture"), "uppercase rejected");
rejects(() => strictQuantity("123", "fixture"), "decimal rejected");
ok(strictHash(`0x${"ab".repeat(32)}`, "fixture").length === 66, "hash accepted");
rejects(() => strictHash(`0x${"AB".repeat(32)}`, "fixture"), "uppercase hash rejected");
ok(strictAddress("0x0000000000000000000000000000000000000001") === "0x0000000000000000000000000000000000000001", "address accepted");
ok(normalizeWordAddress(`0x${"0".repeat(24)}0000000000000000000000000000000000000001`) === "0x0000000000000000000000000000000000000001", "word address");
ok(normalizeWordAddress(`0x${"0".repeat(64)}`) === null, "zero word");
ok(digest({ a: 1 }) === digest({ a: 1 }), "digest deterministic");
ok(digest({ a: 1 }) !== digest({ a: 2 }), "digest sensitive");
ok(leakGuard({ pin: "123", address: "0x0000000000000000000000000000000000000001" }), "sanitized object accepted");
rejects(() => leakGuard({ value: "https://example.invalid/secret" }), "URL rejected");
rejects(() => leakGuard({ value: "provider.example.com" }), "domain rejected");
rejects(() => leakGuard({ header: "Bearer secret" }), "bearer header rejected");
rejects(() => leakGuard({ rpcUrl: "redacted" }), "endpoint field rejected");

ok(deriveHeadroom(100n, 40n) === 60n, "headroom arithmetic");
ok(deriveHeadroom(null, 40n) === null, "null cap stays null");
ok(deriveHeadroom(100n, null) === null, "null total stays null");
ok(deriveHeadroom(39n, 40n) === null, "over-cap headroom stays null");

const indicators = {
  erc1820Registry: false,
  tokensReceivedSelector: false,
  erc1363ReceiverSelector: false,
  erc223ReceiverSelector: false,
  erc677ReceiverSelector: false,
  transferAndCallSelector: false
};
ok(validateCallbackIndicators({ callbackIndicators: indicators }), "all indicator booleans accepted");
for (const key of Object.keys(indicators)) {
  const invalid = { ...indicators, [key]: null };
  rejects(() => validateCallbackIndicators({ callbackIndicators: invalid }), `${key} non-boolean rejected`);
}
const erc223 = classifyCallbackIndicators({ ...indicators, erc223ReceiverSelector: true });
ok(erc223.ordinaryTransferCallbackCapable === true, "ERC223 ordinary transfer classified callback-capable");
ok(erc223.classification.includes("ERC223-ORDINARY-TRANSFER"), "ERC223 label");
const erc1363Only = classifyCallbackIndicators({ ...indicators, erc1363ReceiverSelector: true });
ok(erc1363Only.ordinaryTransferCallbackCapable === null, "ERC1363 opt-in hook is not ordinary transfer proof");

const unsupportedSelector = "0x90b8ec18";
ok(classifySupportResult({ ok: false, revertSelector: unsupportedSelector }, unsupportedSelector) === "unsupported", "explicit Unsupported classified");
ok(classifySupportResult({ ok: false, revertSelector: null }, unsupportedSelector) === "nonUnsupportedResult", "empty revert remains unknown");
ok(classifySupportResult({ ok: false, revertSelector: "0xdeadbeef" }, unsupportedSelector) === "nonUnsupportedResult", "other revert remains unknown");
ok(classifySupportResult({ ok: true, value: "0x" }, unsupportedSelector) === "nonUnsupportedResult", "success remains nonUnsupported result");

const manager = "0x0000000000000000000000000000000000000010";
const collateral = "0x0000000000000000000000000000000000000020";
const claim = "0x0000000000000000000000000000000000000030";
const debt = "0x0000000000000000000000000000000000000040";
const feed = "0x0000000000000000000000000000000000000050";
const histories = [{ manager, rows: [{ collateralToken: collateral, raftCollateralToken: claim, raftDebtToken: debt, priceFeed: feed }] }];
const state = { managers: [{ manager, feeRecipient: "0x0000000000000000000000000000000000000060", collateral: [{ collateralToken: collateral, info: { collateralClaimToken: claim, debtToken: debt, priceFeed: feed } }] }] };
ok(validateAdmissionUniqueness(histories) === 1, "admission event unique");
rejects(() => validateAdmissionUniqueness([{ manager, rows: [histories[0].rows[0], histories[0].rows[0]] }]), "duplicate admission rejected");
ok(validateEventCurrentTupleIdentity(histories, state) === 1, "event/current tuple identity");
rejects(
  () => validateEventCurrentTupleIdentity(histories, { managers: [{ ...state.managers[0], collateral: [{ collateralToken: collateral, info: { collateralClaimToken: claim, debtToken: debt, priceFeed: manager } }] }] }),
  "event/current tuple mismatch rejected"
);
ok(
  validateFeeRecipientEquality({ managers: [state.managers[0], { ...state.managers[0], manager: collateral }] })
    === "0x0000000000000000000000000000000000000060",
  "fee recipient equality"
);
rejects(
  () => validateFeeRecipientEquality({ managers: [state.managers[0], { ...state.managers[0], feeRecipient: manager }] }),
  "fee recipient mismatch rejected"
);

console.log(`PASS ${checks} offline fixture checks`);
