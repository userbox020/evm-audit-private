// Read-only: distinguish StargateAdapter (V1) from StargateAdapterV2 on live addresses.
// V2 exposes getAllowedOFTs(); V1 does not. Never prints endpoints.
'use strict';
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const ROOT = path.resolve(__dirname, '..');
const ADDRS = {
  ethereum: '0x097481da42446C36718d22B67f0feB6F2A21258F',
  base: '0x865B3f3004B6D253A00F26f48c05e438Caa13534',
};
const CHAIN = { ethereum: 1, base: 8453 };

function urls() {
  const raw = fs.readFileSync(path.join(ROOT, 'rpc_endpoints.txt'), 'utf8');
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/https:\/\/\S+/g);
    if (!m) continue;
    for (const u of m) out.push(u.replace(/[),;]+$/, ''));
  }
  return [...new Set(out)];
}

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error('http');
  const j = await res.json();
  if (!j.result) throw new Error('no result');
  return j.result;
}

const iface = new ethers.Interface(['function getAllowedOFTs() view returns (address[])']);

(async () => {
  const all = urls();
  const chains = {};
  await Promise.all(all.map(async (u) => {
    try { chains[await rpc(u, 'eth_chainId', [])] = chains[await rpc(u, 'eth_chainId', [])] || u; } catch {}
  }));
  const out = {};
  for (const name of Object.keys(ADDRS)) {
    const idHex = '0x' + CHAIN[name].toString(16);
    const url = chains[idHex];
    if (!url) { out[name] = 'no rpc'; continue; }
    const data = iface.encodeFunctionData('getAllowedOFTs');
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: ADDRS[name], data }, 'latest'] }),
        signal: AbortSignal.timeout(10000),
      });
      const j = await res.json();
      out[name] = j.result ? { getAllowedOFTs: 'callable' } : { getAllowedOFTs: 'revert (not V2)' };
    } catch { out[name] = 'callable-error'; }
  }
  console.log(JSON.stringify(out, null, 2));
})();
