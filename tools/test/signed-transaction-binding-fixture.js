"use strict";

// TEST-ONLY adapter for legacy orchestration fixtures returning 0x010203.
// This does NOT validate signatures and must never be imported by production or
// crypto-boundary tests. Node's per-test mock tracker restores the real parser.
const assert = require("node:assert/strict");
const { Transaction, accessListify } = require("../node_modules/ethers");
const contexts = new WeakMap();
function mockSignedTransactionBinding(t) {
  if (contexts.has(t)) return contexts.get(t);
  const fixtures = new Map(), original = Transaction.from;
  t.mock.method(Transaction, "from", function (value) {
    if (typeof value === "string" && fixtures.has(value)) {
      const row = structuredClone(fixtures.get(value));
      return { ...row, isSigned: () => true, serialized: value };
    }
    return original.call(this, value);
  });
  const mock = {
    register(signed, transaction, account) {
      assert.equal(signed, "0x010203", "Only the explicit legacy fake bytes may bypass the test parser");
      assert.match(account, /^0x[0-9a-f]{40}$/i);
      fixtures.set(signed, { type: transaction.type, chainId: BigInt(transaction.chainId), nonce: transaction.nonce,
        from: account, to: transaction.to, data: transaction.data, value: BigInt(transaction.value), gasLimit: BigInt(transaction.gasLimit),
        maxFeePerGas: BigInt(transaction.maxFeePerGas), maxPriorityFeePerGas: BigInt(transaction.maxPriorityFeePerGas),
        accessList: structuredClone(accessListify(transaction.accessList ?? [])) });
      return signed;
    },
    wrapSigner(signer, account) {
      return async transaction => {
        const snapshot = structuredClone(transaction), signed = await signer(transaction);
        return mock.register(signed, snapshot, account);
      };
    }
  };
  contexts.set(t, mock); return mock;
}
module.exports = { mockSignedTransactionBinding };
