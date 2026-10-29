'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateExactInPreflight, encodeExactInForLocalOnly } = require('../atomic/solana-pump-exact-in-offline');

// A pinned public-account fixture is cloned in memory only; no RPC, signer, or writes.
const fixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../reports/raw/fast/solana-pump-exact-in-public-accounts-20260927.json'), 'utf8'));
const clone = () => structuredClone(fixture);
const encode = (snapshot = clone(), overrides = {}) => encodeExactInForLocalOnly({
  snapshot, spendableQuoteInRaw: '1000000', minBaseOutRaw: '0', trackVolume: false, ...overrides,
});

test('pinned one-slot preflight is historical only; absent creator PDA account requires present ATA', () => {
  assert.deepEqual(validateExactInPreflight(clone()), {
    status: 'HISTORICAL_PREFLIGHT_ONLY', snapshotSlot: 451078748,
    localOnly: true, simulationOnly: true, quoteReady: false,
    routeProfitProven: false, dispatchAllowed: false,
  });
  const missingAta = clone();
  missingAta.accounts[17].exists = false;
  missingAta.accountRoles[17].exists = false;
  assert.throws(() => validateExactInPreflight(missingAta), /ACCOUNT_OWNER_OR_MISSING/);
  const fakeCreator = clone();
  fakeCreator.accounts[18].exists = true;
  fakeCreator.accountRoles[18].exists = true;
  assert.throws(() => validateExactInPreflight(fakeCreator), /ACCOUNT_OWNER_OR_MISSING/);
});

test('IDL discriminator, LE u64 order and one-byte OptionBool struct (no presence tag)', () => {
  const out = encode(clone(), { spendableQuoteInRaw: '4328719365', trackVolume: true });
  assert.equal(out.data.length, 25);
  assert.equal(out.data.toString('hex'), 'c62e1552b4d9e8700504030201000000000000000000000001');
  assert.equal(out.accountMetas.length, 23);
  assert.deepEqual(out.accountMetas[0], {
    pubkey: fixture.accountRoles[0].pubkey, isWritable: true, isSigner: false,
  });
  assert.deepEqual(out.accountMetas[1], {
    pubkey: fixture.accountRoles[1].pubkey, isWritable: true, isSigner: true,
  });
  assert.deepEqual(out.accountMetas[18], {
    pubkey: fixture.accountRoles[18].pubkey, isWritable: false, isSigner: false,
  });
  assert.deepEqual(Object.keys(out).sort(), ['accountMetas', 'data', 'dispatchAllowed', 'localOnly', 'quoteReady', 'routeProfitProven', 'simulationOnly'].sort());
  assert.equal(out.dispatchAllowed, false);
  assert.equal(encode().data[24], 0);
});

test('rejects mutations to fixed slot, owner, pool, recipient, mint and mixed account bytes', () => {
  for (const mutate of [
    s => { s.slot++; },
    s => { s.accounts[7].slot = s.slot - 1; },
    s => { s.accountRoles[0].pubkey = s.accountRoles[7].pubkey; },
    s => { s.accounts[0].owner = s.accountRoles[7].owner; },
    s => { s.accountRoles[6].owner = s.accountRoles[7].owner; },
    s => { s.selectedRecipientIndex = 1; },
    s => { s.selectedRecipient = s.accountRoles[1].pubkey; },
    s => { s.sourcePoolFlags.isCashback = true; },
    s => { s.sourcePoolFlags.isMayhem = true; },
    s => { s.accounts[0].dataBase64 = s.accounts[3].dataBase64; },
    s => { s.accounts[3].dataBase64 = s.accounts[4].dataBase64; },
    s => { s.accounts[21].dataSha256 = s.accounts[0].dataSha256; },
    s => { s.accounts[21].lamports += 1; },
    s => {
      const bytes = Buffer.from(s.accounts[21].dataBase64, 'base64');
      bytes[bytes.length - 1] ^= 1;
      s.accounts[21].dataBase64 = bytes.toString('base64');
      s.accounts[21].dataSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    },
    s => { s.accounts[10].exists = false; s.accountRoles[10].exists = false; },
  ]) {
    const snapshot = clone();
    mutate(snapshot);
    assert.throws(() => validateExactInPreflight(snapshot));
  }
});

test('rejects signer and writable drift, wrong ordering and incorrect missing-account list', () => {
  for (const mutate of [
    s => { s.accountRoles[1].isSigner = false; },
    s => { s.accountRoles[0].isWritable = false; },
    s => { [s.accountRoles[1], s.accountRoles[2]] = [s.accountRoles[2], s.accountRoles[1]]; },
    s => { [s.accounts[6], s.accounts[7]] = [s.accounts[7], s.accounts[6]]; },
    s => { s.missingRoles = []; },
  ]) {
    const snapshot = clone();
    mutate(snapshot);
    assert.throws(() => validateExactInPreflight(snapshot));
  }
});

test('no unsafe amounts, impossible historical funding, positive min-out price assertion or non-bool', () => {
  for (const options of [
    { spendableQuoteInRaw: 1 }, { spendableQuoteInRaw: '0' },
    { spendableQuoteInRaw: '18446744073709551616' },
    { spendableQuoteInRaw: '18446744073709551615' },
    { spendableQuoteInRaw: '01' }, { spendableQuoteInRaw: '-1' },
    { minBaseOutRaw: 1 }, { minBaseOutRaw: '18446744073709551616' },
    { minBaseOutRaw: '1' }, { trackVolume: 'false' }, { trackVolume: 1 },
  ]) assert.throws(() => encode(clone(), options));
});
