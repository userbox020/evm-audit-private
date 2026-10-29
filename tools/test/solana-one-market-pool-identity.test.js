'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { PublicKey } = require('@solana/web3.js');
const { decodeOneMarket } = require('../atomic/solana-one-market-pool-identity');
const schema = require('../../reports/raw/fast/atomic-solana-pinned-pool-schemas-20260927.json');

const WSOL = 'So11111111111111111111111111111111111111112';
const MINT = 'CbcyNo7m1amFWqEQm2m4PLv1UNvpcL3C1Ujm6AkzpKoU';
const PUMP = '4JAnKFddd5fFTk5PxDj3PpTWJuTEfSWQEjZJcgKQ9KwW';
const DLMM = 'CP1R2bY81LQTbBv3ZzmNiX2NhSJgWuoHfRasUJ7yKVP9';
const TOKEN = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const vault = n => new PublicKey(Buffer.alloc(32, n)).toBase58();
const putKey = (bytes, offset, key) => new PublicKey(key).toBuffer().copy(bytes, offset);

function fixture() {
  const p = Buffer.alloc(301);
  Buffer.from(schema.sources[0].account.discriminator).copy(p);
  putKey(p, 43, MINT);
  putKey(p, 75, WSOL);
  putKey(p, 139, vault(1));
  putKey(p, 171, vault(2));
  p[243] = 1; p[244] = 0;
  p.writeBigInt64LE(987654321n, 245); // signed i128 little-endian, upper 64 bits zero
  p[269] = 1;

  // repr(C): StaticParameters[32], VariableParameters[32], align i32
  // activeId at body +68; reward_infos[2] aligned to 16 (each 144 bytes),
  // oracle at body +544, version at body +874, final body size 896.
  const d = Buffer.alloc(904);
  Buffer.from(schema.sources[1].account.discriminator).copy(d);
  d.writeInt32LE(-123, 8 + 68);
  d.writeUInt16LE(25, 8 + 72);
  d[8 + 74] = 0; // enabled
  putKey(d, 8 + 80, WSOL);
  putKey(d, 8 + 112, MINT);
  putKey(d, 8 + 144, vault(3));
  putKey(d, 8 + 176, vault(4));
  d[8 + 874] = 1;

  const m = Buffer.alloc(389);
  m[44] = 6; m[45] = 1; m[165] = 1; // initialized Token-2022 mint
  m.writeUInt16LE(1, 166); m.writeUInt16LE(4, 168); // extension ID 1; never assume fee-free
  return {
    snapshot: { commitment: 'finalized', slot: 451054076, accounts: [
      { pubkey: PUMP, owner: schema.sources[0].programAddress, executable: false, space: 301, dataBase64: p.toString('base64') },
      { pubkey: DLMM, owner: schema.sources[1].programAddress, executable: false, space: 904, dataBase64: d.toString('base64') },
      { pubkey: MINT, owner: TOKEN, executable: false, space: 389, dataBase64: m.toString('base64') },
    ] }, schema,
  };
}
function mutate(input, index, action) {
  const a = input.snapshot.accounts[index];
  const data = Buffer.from(a.dataBase64, 'base64');
  action(data);
  a.dataBase64 = data.toString('base64');
  return input;
}
function fails(input, code) {
  const result = decodeOneMarket(input);
  assert.equal(result.status, 'INCOMPLETE');
  assert.equal(result.code, code);
  assert.equal(result.dispatchAllowed, false);
  assert.equal(result.quoteReady, false);
  assert.equal(JSON.stringify(result).includes('dataBase64'), false);
}

test('both synthetic 301/904 pool layouts decode identity only and expose required vault reads', () => {
  const result = decodeOneMarket(fixture());
  assert.equal(result.status, 'POOL_IDENTITIES_DECODED_ONLY');
  assert.equal(result.snapshotSlot, 451054076);
  assert.equal(result.pump.virtualQuoteReserves, '987654321');
  assert.equal(result.meteora.activeId, -123);
  assert.equal(result.meteora.version, 1);
  assert.deepEqual(result.requiredNextAccountKeys, [vault(1), vault(2), vault(3), vault(4)]);
  assert.deepEqual(result.mint.extensionIds, [1]);
  assert.equal(result.mint.transferFeeFree, 'UNKNOWN');
  for (const field of ['quoteReady', 'liquidityKnown', 'routeProfitProven', 'dispatchAllowed']) assert.equal(result[field], false);
});
test('schema is pinned by content, not self-declared source hash or discriminator', () => {
  const input = fixture();
  input.schema = structuredClone(schema);
  input.schema.sources[1].types[0].type.fields[0].name = 'counterfeit';
  fails(input, 'SCHEMA_UNTRUSTED');
  const altered = fixture();
  altered.schema = structuredClone(schema);
  altered.schema.sources[0].sourceSha256 = '0'.repeat(64);
  fails(altered, 'SCHEMA_UNTRUSTED');
});
test('account discriminator, trailing allocation, bool, and byte count are fail closed', () => {
  fails(mutate(fixture(), 0, b => { b[0] ^= 1; }), 'POOL_DISCRIMINATOR');
  fails(mutate(fixture(), 1, b => { b[0] ^= 1; }), 'POOL_DISCRIMINATOR');
  fails(mutate(fixture(), 0, b => { b[300] = 1; }), 'POOL_LAYOUT');
  fails(mutate(fixture(), 0, b => { b[243] = 2; }), 'POOL_BOOLEAN');
  const input = fixture(); input.snapshot.accounts[1].space = 903; fails(input, 'ACCOUNT_SIZE');
});
test('repr:C fields respect alignment and array/struct tail padding, not naive Borsh offsets', () => {
  const good = fixture();
  assert.equal(decodeOneMarket(good).meteora.reserveX, vault(3));
  // Naive packed size would put the version earlier than body +874.
  fails(mutate(fixture(), 1, b => { b[8 + 874] = 255; }), 'POOL_LAYOUT');
  fails(mutate(fixture(), 1, b => { b.fill(0, 8 + 80, 8 + 112); }), 'POOL_MINTS');
});
test('wrong pool mint, status, vault and owner are not decoded as a matching active market', () => {
  fails(mutate(fixture(), 0, b => putKey(b, 43, vault(5))), 'POOL_MINTS');
  fails(mutate(fixture(), 1, b => putKey(b, 8 + 112, vault(5))), 'POOL_MINTS');
  fails(mutate(fixture(), 1, b => { b[8 + 74] = 254; }), 'POOL_STATUS');
  fails(mutate(fixture(), 1, b => { b[8 + 74] = 1; }), 'POOL_STATUS');
  fails(mutate(fixture(), 0, b => b.fill(0, 139, 171)), 'POOL_VAULT');
  const input = fixture(); input.snapshot.accounts[1].owner = TOKEN; fails(input, 'ACCOUNT_OWNER');
});
test('malformed Token-2022 mint base, account type and TLV bounds fail closed', () => {
  fails(mutate(fixture(), 2, b => { b[45] = 0; }), 'MINT_LAYOUT');
  fails(mutate(fixture(), 2, b => { b[165] = 2; }), 'MINT_LAYOUT');
  fails(mutate(fixture(), 2, b => { b[100] = 1; }), 'MINT_LAYOUT');
  fails(mutate(fixture(), 2, b => { b.writeUInt16LE(65535, 168); }), 'MINT_TLV');
  fails(mutate(fixture(), 2, b => { b.writeUInt16LE(1, 174); b.writeUInt16LE(1, 176); }), 'MINT_TLV');
});
test('nonmatching account slots and unfinalized snapshots fail closed', () => {
  const input = fixture(); input.snapshot.accounts[0].slot = input.snapshot.slot - 1; fails(input, 'SLOT_MISMATCH');
  const other = fixture(); other.snapshot.commitment = 'confirmed'; fails(other, 'SNAPSHOT_INVALID');
});
