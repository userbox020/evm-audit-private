#!/usr/bin/env node

const RPC_URL = process.env.INK_RPC_URL;
if (!RPC_URL) {
  console.error('Set INK_RPC_URL');
  process.exit(1);
}

const ACL = '0x86E2938daE289763D4e09a7e42c5cCcA62Cf9809';
const FROM_BLOCK = Number(process.env.FROM_BLOCK || 19954047);
const RANGE = Number(process.env.RANGE || 10000);
const BATCH = Number(process.env.BATCH || 10);
const SLEEP_MS = Number(process.env.SLEEP_MS || 1100);

const GRANTED = '0x2f8788117e7eff1d82e926ec794901d17c78024a50270940304540a733656f0d';
const REVOKED = '0xf6391f5c32d9c69d2a47ea670b442974b53935d1edc7fd64eb21e047a839171b';

const ROLE_NAMES = new Map([
  ['0x0000000000000000000000000000000000000000000000000000000000000000', 'DEFAULT_ADMIN'],
  ['0x12ad05bde78c5ab75238ce885307f96ecd482bb402ef831f99e7018a0f169b7b', 'POOL_ADMIN'],
  ['0x5c91514091af31f62f596a314af7d5be40146b2f2355969392f055e12e0982fb', 'EMERGENCY_ADMIN'],
  ['0x8aa855a911518ecfbe5bc3088c8f3dda7badf130faaf8ace33fdc33828e18167', 'RISK_ADMIN'],
  ['0x939b8dfb57ecef2aea54a93a15e86768b9d4089f1ba61c245e6ec980695f4ca4', 'FLASH_BORROWER'],
  ['0x08fb31c3e81624356c3314088aa971b73bcc82d22bc3e3b184b4593077ae3278', 'BRIDGE'],
  ['0x19c860a63258efbd0ecb7d55c626237bf5c2044c26c073390b74f0c13c857433', 'ASSET_LISTING_ADMIN']
]);

let nextId = 1;

function sanitize(message) {
  return String(message).replace(/https?:\/\/\S+/g, '[redacted-url]');
}

function hex(n) {
  return `0x${BigInt(n).toString(16)}`;
}

function topicToAddress(topic) {
  return `0x${topic.slice(-40)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rpc(method, params) {
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({jsonrpc: '2.0', id: nextId++, method, params})
  });
  const payload = await response.json();
  if (payload.error) throw new Error(`${method}: ${sanitize(payload.error.message || payload.error.code)}`);
  return payload.result;
}

async function batch(calls) {
  const req = calls.map((call) => ({jsonrpc: '2.0', id: nextId++, method: call.method, params: call.params}));
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(req)
  });
  const payload = await response.json();
  if (!Array.isArray(payload)) {
    const out = [];
    for (const call of calls) out.push(await rpc(call.method, call.params));
    return out;
  }
  const byId = new Map(payload.map((item) => [item.id, item]));
  return req.map((item) => {
    const result = byId.get(item.id);
    if (!result) throw new Error(`missing batch result ${item.id}`);
    if (result.error) throw new Error(`${item.method}: ${sanitize(result.error.message || result.error.code)}`);
    return result.result;
  });
}

async function main() {
  const latest = Number(BigInt(await rpc('eth_blockNumber', [])));
  const active = new Map();
  let logs = 0;
  const chunks = [];
  for (let from = FROM_BLOCK; from <= latest; from += RANGE) {
    chunks.push([from, Math.min(latest, from + RANGE - 1)]);
  }
  for (let i = 0; i < chunks.length; i += BATCH) {
    const slice = chunks.slice(i, i + BATCH);
    const results = await batch(slice.map(([from, to]) => ({
      method: 'eth_getLogs',
      params: [{address: ACL, fromBlock: hex(from), toBlock: hex(to), topics: [[GRANTED, REVOKED]]}]
    })));
    for (const rangeLogs of results) {
      logs += rangeLogs.length;
      for (const log of rangeLogs) {
        const role = log.topics[1].toLowerCase();
        const account = topicToAddress(log.topics[2]).toLowerCase();
        if (!active.has(role)) active.set(role, new Set());
        if (log.topics[0].toLowerCase() === GRANTED) active.get(role).add(account);
        if (log.topics[0].toLowerCase() === REVOKED) active.get(role).delete(account);
      }
    }
    if ((i / BATCH) % 25 === 0) console.error(`progress ${Math.min(i + BATCH, chunks.length)}/${chunks.length} chunks`);
    if (SLEEP_MS) await sleep(SLEEP_MS);
  }
  console.log(`latestBlock,${latest}`);
  console.log(`roleLogs,${logs}`);
  console.log('role,hash,count,accounts');
  for (const [hash, name] of ROLE_NAMES.entries()) {
    const accounts = [...(active.get(hash) || new Set())].sort();
    console.log(`${name},${hash},${accounts.length},${accounts.join('|')}`);
  }
}

main().catch((err) => {
  console.error(sanitize(err.message));
  process.exit(1);
});
