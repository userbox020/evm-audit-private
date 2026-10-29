'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { parseAndVerify, MAX_RESPONSE_BYTES } = require('../atomic/solana-program-loader-metadata-offline');

const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ids = [
  ['pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', '6naEzKeUuFh1Jeeu51NXQgr5qkXgXtc9WKNct4xynVJc'],
  ['pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ', '75Uu23mqWBb8LM8vDppqC1mQAnCcBuLXhVaDezVMQLRw'],
];
const authority = '7gZufwwAo17y5kg8FMyJy2phgpvv9RSdzWtdXiWHjFr8';
const loader = 'BPFLoaderUpgradeab1e11111111111111111111111';
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
function decode58(input) {
  let num = 0n;
  for (const ch of input) num = num * 58n + BigInt(alphabet.indexOf(ch));
  const bytes = Buffer.alloc(32);
  for (let i = 31; i >= 0; i--) { bytes[i] = Number(num & 255n); num >>= 8n; }
  assert.equal(num, 0n);
  return bytes;
}

function fixture() {
  const details = [], accounts = [], values = [], buffers = {};
  for (let i = 0; i < 2; i++) {
    const [program, programData] = ids[i];
    const full = Buffer.alloc(55 + i, i + 3);
    full.writeUInt32LE(3, 0);
    full.writeBigUInt64LE(BigInt(446462733 + i), 4);
    full[12] = 1;
    decode58(authority).copy(full, 13);
    const prog = Buffer.alloc(36);
    prog.writeUInt32LE(2, 0);
    decode58(programData).copy(prog, 4);
    details.push({ status: 'VERIFIED_PUBLIC_BYTES', program, programData,
      contextSlot: 451087491 + i, lastUpgradeSlot: 446462733 + i,
      upgradeAuthorityPresent: true, upgradeAuthority: authority, bytes: full.length,
      programDataSha256: hash(full), localPublicBytesFile: `approved-temp-${i}.bin` });
    buffers[programData] = full;
    accounts.push({ pubkey: program, owner: loader, executable: true, space: 36, dataSha256: hash(prog) });
    values.push({ owner: loader, lamports: 123456 + i, executable: false, space: full.length,
      data: [full.subarray(0, 45).toString('base64'), 'base64'], rentEpoch: `EPOCH_${i * 2}` });
    values.push({ owner: loader, lamports: 222222 + i, executable: true, space: 36,
      data: [prog.toString('base64'), 'base64'], rentEpoch: `EPOCH_${i * 2 + 1}` });
  }
  const response = { jsonrpc: '2.0', id: 1, result: { context: { slot: 451087494 }, value: values } };
  const epochs = ['18446744073709551615', '1', '0', '9007199254740993'];
  const raw = JSON.stringify(response).replace(/"rentEpoch":"EPOCH_(\d)"/g, (_, n) =>
    `"rentEpoch"  :  ${epochs[Number(n)]}`);
  return { raw, pin: { schema: 'solana-pump-two-public-executables/v2', status: 'PUBLIC_BYTES_PINNED', details },
    preflight: { schema: 'solana-pump-exact-in-public-accounts/v1', commitment: 'finalized',
      slot: 451078748, accounts }, programDataBuffers: buffers, commitment: 'finalized' };
}
const verify = params => parseAndVerify(params.raw, params);

test('one context, ordered four accounts, canonical slices, and four lossless decimal epochs', () => {
  const input = fixture();
  const result = verify(input);
  assert.equal(result.contextSlot, 451087494);
  assert.deepEqual(result.accounts.flatMap(pair => [pair.programDataAccount.rentEpoch, pair.programAccount.rentEpoch]),
    ['18446744073709551615', '1', '0', '9007199254740993']);
  assert.equal(result.accounts[0].programDataAccount.data[0], input.programDataBuffers[ids[0][1]].subarray(0, 45).toString('base64'));
  assert.match(result.caveat, /distinct finalized slots/);
});
test('missing, null, quoted, negative, and overflowing rent epochs fail closed', () => {
  for (const token of ['', 'null', '"1"', '-1', '18446744073709551616']) {
    const input = fixture();
    input.raw = input.raw.replace(/"rentEpoch"  :  18446744073709551615/, token ? `"rentEpoch" : ${token}` : '"other" : 1');
    assert.throws(() => verify(input));
  }
});
test('orphan program pointer, mismatched header, and binary hash fail closed', () => {
  const orphan = fixture();
  const originalProgram = Buffer.alloc(36);
  originalProgram.writeUInt32LE(2, 0);
  decode58(ids[0][1]).copy(originalProgram, 4);
  const replacement = Buffer.from(originalProgram);
  decode58(ids[1][1]).copy(replacement, 4);
  orphan.raw = orphan.raw.replace(originalProgram.toString('base64'), replacement.toString('base64'));
  assert.throws(() => verify(orphan), /PROGRAM_LAYOUT/);
  const badHeader = fixture();
  badHeader.pin.details[0].lastUpgradeSlot++;
  assert.throws(() => verify(badHeader), /PROGRAMDATA_LAYOUT/);
  const badBinary = fixture();
  badBinary.programDataBuffers[ids[0][1]][54] ^= 1;
  assert.throws(() => verify(badBinary), /PIN_BINARY/);
});
test('cap, duplicate fields, and unsafe non-epoch JSON numbers fail closed', () => {
  const oversized = fixture();
  oversized.raw += ' '.repeat(MAX_RESPONSE_BYTES);
  assert.throws(() => verify(oversized), /RESPONSE_CAP/);
  const duplicate = fixture();
  duplicate.raw = duplicate.raw.replace('"rentEpoch"  :  18446744073709551615',
    '"rentEpoch":1,"rentEpoch" : 18446744073709551615');
  assert.throws(() => verify(duplicate), /DUPLICATE_KEY/);
  const unsafe = fixture();
  unsafe.raw = unsafe.raw.replace('"lamports":123456', '"lamports":9007199254740993');
  assert.throws(() => verify(unsafe), /UNSAFE_NUMBER/);
});
test('finalized attestation and pinned context required', () => {
  const absent = fixture(); delete absent.commitment;
  assert.throws(() => verify(absent), /FINALIZED_ATTESTATION_REQUIRED/);
  const stale = fixture(); stale.pin.details[1].contextSlot += 3;
  assert.throws(() => verify(stale), /STALE_CONTEXT/);
});
