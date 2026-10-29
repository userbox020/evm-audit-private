#!/usr/bin/env node

const RPC_URL = process.env.INK_RPC_URL;
if (!RPC_URL) {
  console.error('Set INK_RPC_URL');
  process.exit(1);
}

const POOL = '0x2816cf15F6d2A220E789aA011D5EE4eB6c47FEbA';
const FROM_BLOCK = Number(process.env.FROM_BLOCK || 19954047);
const RANGE = Number(process.env.RANGE || 10000);
const BATCH = Number(process.env.BATCH || 40);
const SLEEP_MS = Number(process.env.SLEEP_MS || 0);
const USER_BATCH = Number(process.env.USER_BATCH || 250);

const BORROW_TOPIC = '0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0';
const GET_USER_ACCOUNT_DATA = '0xbf92857c';
const GET_USER_EMODE = '0xeddf1b79';
const WAD = 10n ** 18n;

let nextId = 1;

function sanitize(message) {
  return String(message).replace(/https?:\/\/\S+/g, '[redacted-url]');
}

function hex(n) {
  return `0x${BigInt(n).toString(16)}`;
}

function padAddress(address) {
  return address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

function word(value) {
  return BigInt(value).toString(16).padStart(64, '0');
}

function padBytes(hexData) {
  const clean = hexData.replace(/^0x/, '');
  const paddedLength = Math.ceil(clean.length / 64) * 64;
  return clean.padEnd(paddedLength, '0');
}

function encodeBytesArray(items) {
  let offset = 32n * BigInt(items.length);
  const heads = [];
  const tails = [];
  for (const item of items) {
    const clean = item.replace(/^0x/, '');
    const tail = `${word(clean.length / 2)}${padBytes(clean)}`;
    heads.push(word(offset));
    tails.push(tail);
    offset += BigInt(tail.length / 2);
  }
  return `${word(32)}${word(items.length)}${heads.join('')}${tails.join('')}`;
}

function bytesAt(data, offsetBytes, lengthBytes) {
  const start = offsetBytes * 2;
  return data.slice(start, start + lengthBytes * 2);
}

function wordAt(data, offsetBytes) {
  return BigInt(`0x${bytesAt(data, offsetBytes, 32)}`);
}

function decodeBytesArray(result) {
  const data = result.replace(/^0x/, '');
  const base = Number(wordAt(data, 0));
  const length = Number(wordAt(data, base));
  const out = [];
  for (let i = 0; i < length; i++) {
    const rel = Number(wordAt(data, base + 32 + i * 32));
    const elementStart = base + 32 + rel;
    const elementLength = Number(wordAt(data, elementStart));
    out.push(`0x${bytesAt(data, elementStart + 32, elementLength)}`);
  }
  return out;
}

function topicToAddress(topic) {
  return `0x${topic.slice(-40)}`;
}

function uintsFromResult(result) {
  if (!result || result === '0x') return [];
  const data = result.slice(2);
  const out = [];
  for (let i = 0; i < data.length; i += 64) {
    out.push(BigInt(`0x${data.slice(i, i + 64)}`));
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function usd8(value) {
  const whole = value / 100000000n;
  const frac = value % 100000000n;
  const fracText = frac.toString().padStart(8, '0').replace(/0+$/, '');
  return fracText ? `${whole}.${fracText}` : whole.toString();
}

function hf(value) {
  if (value > 10n ** 50n) return 'max';
  const whole = value / WAD;
  const frac = value % WAD;
  const fracText = frac.toString().padStart(18, '0').slice(0, 6).replace(/0+$/, '');
  return fracText ? `${whole}.${fracText}` : whole.toString();
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
  if (calls.length === 0) return [];
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
  const borrowers = new Set();
  let logs = 0;
  let chunks = [];
  for (let from = FROM_BLOCK; from <= latest; from += RANGE) {
    chunks.push([from, Math.min(latest, from + RANGE - 1)]);
  }

  for (let i = 0; i < chunks.length; i += BATCH) {
    const slice = chunks.slice(i, i + BATCH);
    const results = await batch(slice.map(([from, to]) => ({
      method: 'eth_getLogs',
      params: [{address: POOL, fromBlock: hex(from), toBlock: hex(to), topics: [BORROW_TOPIC]}]
    })));
    for (const rangeLogs of results) {
      logs += rangeLogs.length;
      for (const log of rangeLogs) {
        if (log.topics.length > 2) borrowers.add(topicToAddress(log.topics[2]));
      }
    }
    if ((i / BATCH) % 10 === 0) {
      console.error(`progress ${Math.min(i + BATCH, chunks.length)}/${chunks.length} chunks, borrowers=${borrowers.size}`);
    }
    if (SLEEP_MS) await sleep(SLEEP_MS);
  }

  const users = [...borrowers].sort();
  const rows = [];
  for (let i = 0; i < users.length; i += USER_BATCH) {
    const slice = users.slice(i, i + USER_BATCH);
    const callDatas = [];
    for (const user of slice) {
      callDatas.push(`${GET_USER_ACCOUNT_DATA}${padAddress(user)}`);
      callDatas.push(`${GET_USER_EMODE}${padAddress(user)}`);
    }
    const results = decodeBytesArray(
      await rpc('eth_call', [{to: POOL, data: `0xac9650d8${encodeBytesArray(callDatas)}`}, 'latest'])
    );
    for (let j = 0; j < slice.length; j++) {
      const account = uintsFromResult(results[j * 2]);
      const eMode = uintsFromResult(results[j * 2 + 1])[0] || 0n;
      if (account.length < 6) continue;
      const [collateral, debt, available, liquidationThreshold, ltv, healthFactor] = account;
      if (debt === 0n) continue;
      rows.push({
        user: slice[j],
        collateral,
        debt,
        available,
        liquidationThreshold,
        ltv,
        healthFactor,
        eMode
      });
    }
    if (SLEEP_MS) await sleep(SLEEP_MS);
  }

  rows.sort((a, b) => (a.healthFactor < b.healthFactor ? -1 : a.healthFactor > b.healthFactor ? 1 : 0));
  const liquidatable = rows.filter((row) => row.healthFactor < WAD);
  console.log(`latestBlock,${latest}`);
  console.log(`borrowLogs,${logs}`);
  console.log(`uniqueBorrowers,${users.length}`);
  console.log(`activeDebtors,${rows.length}`);
  console.log(`liquidatable,${liquidatable.length}`);
  console.log('rank,user,eMode,totalCollateralBase,totalDebtBase,availableBorrowsBase,lt,ltv,healthFactor');
  rows.slice(0, 30).forEach((row, i) => {
    console.log([
      i + 1,
      row.user,
      row.eMode.toString(),
      usd8(row.collateral),
      usd8(row.debt),
      usd8(row.available),
      row.liquidationThreshold.toString(),
      row.ltv.toString(),
      hf(row.healthFactor)
    ].join(','));
  });
  const liquidatableByDebt = [...liquidatable].sort((a, b) => (a.debt > b.debt ? -1 : a.debt < b.debt ? 1 : 0));
  console.log('liquidatableByDebtRank,user,eMode,totalCollateralBase,totalDebtBase,availableBorrowsBase,lt,ltv,healthFactor');
  liquidatableByDebt.slice(0, 30).forEach((row, i) => {
    console.log([
      i + 1,
      row.user,
      row.eMode.toString(),
      usd8(row.collateral),
      usd8(row.debt),
      usd8(row.available),
      row.liquidationThreshold.toString(),
      row.ltv.toString(),
      hf(row.healthFactor)
    ].join(','));
  });
}

main().catch((err) => {
  console.error(sanitize(err.message));
  process.exit(1);
});
