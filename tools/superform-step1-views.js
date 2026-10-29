// Superform step-1 read-only wiring checks (view calls only; never prints endpoints).
// Usage: node tools/superform-step1-views.js
'use strict';
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const ROOT = path.resolve(__dirname, '..');

const TARGETS = {
  1: {
    label: 'ethereum',
    executor: '0x9cC8EDCC41154aaFC74D261aD3D87140D21F6281',
    destExecutor: '0x6ac58e854798D4aae5989B18ad5a1C0fF17817EF',
    destValidator: '0xADEFF5A0684392C4c273a9C638d1dB8c5dfd0098',
    acrossV2: '0xaa90922Bf3cBD191e48385e6F8b8Cd80A2C1f1D9',
    stargate: '0x097481da42446C36718d22B67f0feB6F2A21258F',
  },
  8453: {
    label: 'base',
    executor: '0x9cC8EDCC41154aaFC74D261aD3D87140D21F6281',
    destExecutor: '0x6ac58e854798D4aae5989B18ad5a1C0fF17817EF',
    destValidator: '0xADEFF5A0684392C4c273a9C638d1dB8c5dfd0098',
    acrossV2: '0x04E4aa141335888Aa99B0700A6281f673cE77A2F',
    stargate: '0x865B3f3004B6D253A00F26f48c05e438Caa13534',
  },
};

const IFACES = {
  executor: new ethers.Interface([
    'function LEDGER_CONFIGURATION() view returns (address)',
    'function name() view returns (string)',
    'function isInitialized(address) view returns (bool)',
  ]),
  destExecutor: new ethers.Interface([
    'function SUPER_DESTINATION_VALIDATOR() view returns (address)',
    'function LEDGER_CONFIGURATION() view returns (address)',
  ]),
  destValidator: new ethers.Interface([
    'function namespace() view returns (string)',
    'function getAccountOwner(address) view returns (address)',
  ]),
  acrossV2: new ethers.Interface([
    'function ACROSS_SPOKE_POOL() view returns (address)',
    'function SUPER_DESTINATION_EXECUTOR() view returns (address)',
    'function SUPER_DESTINATION_VALIDATOR() view returns (address)',
  ]),
  stargate: new ethers.Interface([
    'function LZ_ENDPOINT() view returns (address)',
    'function TOKEN_MESSAGING() view returns (address)',
    'function SUPER_DESTINATION_EXECUTOR() view returns (address)',
  ]),
};

function httpEndpoints() {
  const raw = fs.readFileSync(path.join(ROOT, 'rpc_endpoints.txt'), 'utf8');
  const urls = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/https:\/\/\S+/g);
    if (!m) continue;
    for (const u of m) {
      const clean = u.replace(/[),;]+$/, '');
      if (!clean.includes('wss')) urls.push(clean);
    }
  }
  // de-dup keeping order
  return [...new Set(urls)];
}

async function probe(urls) {
  const byChain = new Map(); // chainIdHex -> [url...]
  const results = [];
  await Promise.all(
    urls.map(async (url, i) => {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return;
        const j = await res.json();
        if (!j.result) return;
        if (!byChain.has(j.result)) byChain.set(j.result, []);
        byChain.get(j.result).push(url);
        results.push({ i, chain: j.result });
      } catch {}
    })
  );
  return { byChain, results };
}

async function call(url, to, iface, fn, args) {
  const data = iface.encodeFunctionData(fn, args || []);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;
      const j = await res.json();
      if (!j.result) continue;
      return iface.decodeFunctionResult(fn, j.result);
    } catch {}
  }
  return null;
}

(async () => {
  const urls = httpEndpoints();
  const { byChain } = await probe(urls);
  const pick = {};
  for (const [chainHex, list] of byChain) {
    pick[parseInt(chainHex, 16)] = list[0];
  }
  const out = {};
  for (const chainId of Object.keys(TARGETS)) {
    const t = TARGETS[chainId];
    const url = pick[chainId];
    const row = { chain: t.label, rpc: url ? 'ok' : 'unavailable' };
    if (url) {
      const eName = await call(url, t.executor, IFACES.executor, 'name');
      const eLedger = await call(url, t.executor, IFACES.executor, 'LEDGER_CONFIGURATION');
      const deVal = await call(url, t.destExecutor, IFACES.destExecutor, 'SUPER_DESTINATION_VALIDATOR');
      const deLedger = await call(url, t.destExecutor, IFACES.destExecutor, 'LEDGER_CONFIGURATION');
      const vNs = await call(url, t.destValidator, IFACES.destValidator, 'namespace');
      const aSpoke = await call(url, t.acrossV2, IFACES.acrossV2, 'ACROSS_SPOKE_POOL');
      const aExec = await call(url, t.acrossV2, IFACES.acrossV2, 'SUPER_DESTINATION_EXECUTOR');
      const aVal = await call(url, t.acrossV2, IFACES.acrossV2, 'SUPER_DESTINATION_VALIDATOR');
      const sLz = await call(url, t.stargate, IFACES.stargate, 'LZ_ENDPOINT');
      const sTm = await call(url, t.stargate, IFACES.stargate, 'TOKEN_MESSAGING');
      const sExec = await call(url, t.stargate, IFACES.stargate, 'SUPER_DESTINATION_EXECUTOR');
      row.executor_name = eName ? eName[0] : null;
      row.executor_LEDGER_CONFIGURATION = eLedger ? eLedger[0] : null;
      row.destExecutor_SUPER_DESTINATION_VALIDATOR = deVal ? deVal[0] : null;
      row.destExecutor_LEDGER_CONFIGURATION = deLedger ? deLedger[0] : null;
      row.destValidator_namespace = vNs ? vNs[0] : null;
      row.acrossV2_SPOKE_POOL = aSpoke ? aSpoke[0] : null;
      row.acrossV2_EXECUTOR = aExec ? aExec[0] : null;
      row.acrossV2_VALIDATOR = aVal ? aVal[0] : null;
      row.stargate_LZ_ENDPOINT = sLz ? sLz[0] : null;
      row.stargate_TOKEN_MESSAGING = sTm ? sTm[0] : null;
      row.stargate_EXECUTOR = sExec ? sExec[0] : null;
    }
    out[chainId] = row;
  }
  console.log(JSON.stringify(out, null, 2));
})();
