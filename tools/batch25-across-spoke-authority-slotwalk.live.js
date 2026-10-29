#!/usr/bin/env node
// batch25-across-spoke-authority-slotwalk.live.js
// READ-ONLY authority-surface storage + extra-selector return probe at the finalized pin.
// Two-family agreement on every read. No signing, no broadcast, no state mutation.
"use strict";
const fs = require("fs"), path = require("path");
const { loadRpcUrls, rpcCall } = require("./shared-rpc");
const { providerFamily, providerCapabilityRank } = require("./lib/rpc-provider-reliability");
const { keccak256, toBeHex, zeroPadValue, getAddress } = require("./node_modules/ethers");

const PROXY = "0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5";
const IMPL = "0x456ac26e5ec083ee9889eba0d1a0a582502b8e84";
const CAP = path.join(__dirname, "across-spoke-decode-step2.live.json");
const ART = path.join(__dirname, "..", "reports/raw/fast/across-spoke-decode-r2.json");

async function pickFamilies(n) {
  const urls = loadRpcUrls({ maxCandidates: 64 });
  const byFam = new Map();
  for (const u of urls) { const f = providerFamily(u) || "host"; if (!byFam.has(f)) byFam.set(f, []); byFam.get(f).push(u); }
  const order = [...byFam.entries()].map(([f, l]) => ({ f, url: l[0] })).sort((a, b) => providerCapabilityRank(a.url) - providerCapabilityRank(b.url));
  const live = [];
  for (const e of order) { if (await rpcCall(e.url, "eth_chainId", [], 6000) === "0x1") live.push(e); if (live.length >= n) break; }
  return live;
}

// ERC-7201 namespaced storage slots (OZ v5 upgradeable)
function erc7201(label) {
  const inner = BigInt(keccak256(Buffer.from(label)));
  const base = BigInt(keccak256(toBeHex(inner - 1n, 32)));
  return zeroPadValue(toBeHex(base & ~0xffn), 32);
}
const SLOTS = {
  "slot0": "0x" + "0".repeat(64),
  "eip1967.impl": "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  "eip1967.admin": "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  "eip1967.beacon": "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
  "oz.Ownable": erc7201("openzeppelin.storage.Ownable"),
  "oz.Initializable": erc7201("openzeppelin.storage.Initializable"),
};

(async () => {
  const cap = JSON.parse(fs.readFileSync(CAP, "utf8"));
  const art = JSON.parse(fs.readFileSync(ART, "utf8"));
  const at = cap.pin.number;
  const fams = await pickFamilies(2);
  if (fams.length < 2) throw new Error("NEED_TWO_FAMILIES");

  const readBoth = async (method, params) => {
    const [a, b] = await Promise.all([rpcCall(fams[0].url, method, params, 12000), rpcCall(fams[1].url, method, params, 12000)]);
    return { a, b, agree: a !== null && a === b };
  };

  const storage = {};
  for (const [name, slot] of Object.entries(SLOTS)) {
    const r = await readBoth("eth_getStorageAt", [PROXY, slot, at]);
    storage[name] = { slot, value: r.a, agree: r.agree, decodedAddress: r.a && /^0x0{24}[0-9a-f]{40}$/i.test(r.a) ? getAddress("0x" + r.a.slice(26)) : null };
    await new Promise(res => setTimeout(res, 60));
  }

  // extra selectors + authority-relevant functions: capture exact return data
  const probes = {
    "0x116191b6": "extra-A (v-return)",
    "0x339ac427": "extra-B (v-return)",
    "0x55448bc2": "extra-C (revert)",
    "0xb6934805": "extra-D (revert)",
    "0x8da5cb5b": "owner()",
    "0x5285e058": "crossDomainAdmin()",
    "0xb370b7f5": "withdrawalRecipient()",
    "0x52d1902d": "proxiableUUID()",
    "0xf851a440": "admin()",
    "0x4f1ef286": "upgradeToAndCall(address,bytes)",
    "0x3659cfe6": "upgradeTo(address)",
  };
  const calls = {};
  for (const [sel, label] of Object.entries(probes)) {
    const [a, b] = await Promise.all([
      rpcCall(fams[0].url, "eth_call", [{ to: PROXY, data: sel }, at], 10000),
      rpcCall(fams[1].url, "eth_call", [{ to: PROXY, data: sel }, at], 10000),
    ]);
    const decode = (h) => (h && /^0x0{24}[0-9a-f]{40}$/i.test(h)) ? { address: getAddress("0x" + h.slice(26)) } : (h && h !== "0x" ? { hex32: h } : null);
    calls[sel] = { label, resultA: a, resultB: b, agree: a === b, decoded: decode(a) };
    await new Promise(res => setTimeout(res, 60));
  }

  art.authoritySurface = {
    generatedAt: new Date().toISOString(),
    proxy: PROXY, impl: IMPL, pin: at,
    note: "read-only eth_getStorageAt/eth_call at the finalized pin; two independent provider families must agree",
    storage,
    probes: calls,
    eip1967AdminIsZero: storage["eip1967.admin"].value === "0x" + "0".repeat(64),
    eip1967BeaconIsZero: storage["eip1967.beacon"].value === "0x" + "0".repeat(64),
  };
  fs.writeFileSync(ART, JSON.stringify(art, null, 2) + "\n");
  console.log(JSON.stringify({
    pin: at,
    storage: Object.fromEntries(Object.entries(storage).map(([k, v]) => [k, { value: v.value, agree: v.agree, decodedAddress: v.decodedAddress }])),
    probes: Object.fromEntries(Object.entries(calls).map(([k, v]) => [k, { label: v.label, agree: v.agree, decoded: v.decoded, resultA: v.resultA }])),
  }, null, 2));
})().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
