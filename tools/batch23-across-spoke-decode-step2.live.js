#!/usr/bin/env node
// batch23-across-spoke-decode-step2.live.js
// READ-ONLY Across ETH SpokePool decode step-2 live capture.
// Two-family finalized-pin agreement; code + authority storage capture.
// Endpoints are never printed or persisted. No signing, no broadcast, no state mutation.
"use strict";
const fs = require("fs");
const path = require("path");
const { loadRpcUrls, rpcCall } = require("./shared-rpc");
const { providerFamily, providerCapabilityRank } = require("./lib/rpc-provider-reliability");

const PROXY = "0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5";
const IMPL = "0x456ac26e5ec083ee9889eba0d1a0a582502b8e84";
const SLOT_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const SLOT_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const SLOT_BEACON = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const ZERO32 = "0x" + "0".repeat(64);
const OUT = path.join(__dirname, "across-spoke-decode-step2.live.json");

// --- select two LIVE endpoints from distinct provider families ---
async function pickTwoFamilies() {
  const urls = loadRpcUrls({ maxCandidates: 64 });
  const byFamily = new Map();
  for (const u of urls) {
    const f = providerFamily(u) || "host";
    if (!byFamily.has(f)) byFamily.set(f, []);
    byFamily.get(f).push(u);
  }
  const ranked = [...byFamily.entries()]
    .map(([family, list]) => ({ family, url: list.sort((a, b) => providerCapabilityRank(a) - providerCapabilityRank(b))[0] }))
    .sort((a, b) => providerCapabilityRank(a.url) - providerCapabilityRank(b.url));
  const live = [];
  for (const r of ranked) {
    const cid = await rpcCall(r.url, "eth_chainId", [], 6000);
    const blk = await rpcCall(r.url, "eth_blockNumber", [], 6000);
    if (cid === "0x1" && typeof blk === "string") live.push(r);
    if (live.length >= 2) break;
  }
  return live;
}

function req(url, method, params, ms = 12000) {
  return rpcCall(url, method, params, ms).then(r => ({ ok: r !== null && r !== undefined, r }), () => ({ ok: false, r: null }));
}

async function getPin(ep) {
  for (const tag of ["finalized", "safe"]) {
    const b = await req(ep.url, "eth_getBlockByNumber", [tag, false]);
    if (b.ok && b.r && b.r.number) return { tag, number: b.r.number, hash: b.r.hash, timestamp: b.r.timestamp, parentHash: b.r.parentHash };
  }
  const latest = await req(ep.url, "eth_blockNumber", []);
  if (!latest.ok) return null;
  const n = BigInt(latest.r) - 64n;
  const b = await req(ep.url, "eth_getBlockByNumber", ["0x" + n.toString(16), false]);
  if (b.ok && b.r && b.r.number) return { tag: "latest-64", number: b.r.number, hash: b.r.hash, timestamp: b.r.timestamp, parentHash: b.r.parentHash };
  return null;
}

(async () => {
  const eps = await pickTwoFamilies();
  if (eps.length < 2) throw new Error("NEED_TWO_FAMILIES");
  const pinA = await getPin(eps[0]);
  const pinB = await getPin(eps[1]);
  if (!pinA || !pinB) throw new Error("PIN_UNAVAILABLE");
  const pin = pinA; // canonical pin chosen from family A
  const pinBreadback = await req(eps[1].url, "eth_getBlockByNumber", [pin.number, false]);
  const pinAgree = !!(pinBreadback.ok && pinBreadback.r && pinBreadback.r.hash === pin.hash);

  const at = pin.number;
  const reqRetry = async (url, method, params, tries = 3) => {
    for (let i = 0; i < tries; i++) {
      const { ok, r } = await req(url, method, params);
      if (ok) return { ok: true, r };
      await new Promise(res => setTimeout(res, 250));
    }
    return { ok: false, r: null };
  };
  const readBoth = async (method, params) => {
    const [a, b] = await Promise.all([reqRetry(eps[0].url, method, params), reqRetry(eps[1].url, method, params)]);
    return { a: a.r, b: b.r, agree: a.ok && b.ok && a.r === b.r };
  };

  const proxyCode = await readBoth("eth_getCode", [PROXY, at]);
  const implCode = await readBoth("eth_getCode", [IMPL, at]);
  if (!proxyCode.a || !implCode.a) throw new Error("CODE_UNAVAILABLE");
  const slotImpl = await readBoth("eth_getStorageAt", [PROXY, SLOT_IMPL, at]);
  const slotAdmin = await readBoth("eth_getStorageAt", [PROXY, SLOT_ADMIN, at]);
  const slotBeacon = await readBoth("eth_getStorageAt", [PROXY, SLOT_BEACON, at]);

  const codeImpl = implCode.a || "";
  const implBytes = (codeImpl.length - 2) / 2;

  // selector-level view probes (eth_call at pin), empty calldata selectors
  const views = {
    "owner()": "0x8da5cb5b",
    "chainId()": "0x9a8a0592",
    "hubPool()": "0xe1904402",
    "pausedFills()": "0xdda52113",
    "pausedDeposits()": "0x6068d6cb",
    "admin()": "0xf851a440",
    "proxiableUUID()": "0x52d1902d",
    "getCurrentTime()": "0x29cb924d",
    "numberOfDeposits()": "0xa1244c67",
    "crossDomainAdmin()": "0x5285e058",
    "wrappedNativeToken()": "0x17fcb39b",
    "withdrawalRecipient()": "0xb370b7f5",
  };
  const viewResults = {};
  for (const [sig, sel] of Object.entries(views)) {
    const [a, b] = await Promise.all([
      req(eps[0].url, "eth_call", [{ to: PROXY, data: sel }, at]),
      req(eps[1].url, "eth_call", [{ to: PROXY, data: sel }, at]),
    ]);
    viewResults[sig] = { selector: sel, resultA: a.r, resultB: b.r, agree: a.r === b.r };
  }

  const out = {
    schema: "across-spoke-decode-step2-live/live-capture-v1",
    generatedAt: new Date().toISOString(),
    chainId: 1,
    pin: { tag: pin.tag, number: pin.number, hash: pin.hash, timestamp: pin.timestamp, parentHash: pin.parentHash, twoFamilyHashAgree: pinAgree, otherFamilyTag: pinB.tag },
    families: eps.length,
    addresses: { spokeProxy: PROXY, spokeImpl: IMPL },
    proxy: { codeBytes: (proxyCode.a.length - 2) / 2, code: proxyCode.a, twoFamilyCodeAgree: proxyCode.agree },
    impl: { codeBytes: implBytes, codeSha256: require("crypto").createHash("sha256").update(Buffer.from(codeImpl.slice(2), "hex")).digest("hex"), code: codeImpl, twoFamilyCodeAgree: implCode.agree },
    storage: {
      eip1967Impl: { value: slotImpl.a, agree: slotImpl.agree },
      eip1967Admin: { value: slotAdmin.a, agree: slotAdmin.agree },
      eip1967Beacon: { value: slotBeacon.a, agree: slotBeacon.agree },
    },
    views: viewResults,
    safety: { readOnly: true, signing: false, broadcast: false, stateMutation: false, endpointsPersisted: false, environmentFilesRead: false },
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify({
    pin: pin.number, tag: pin.tag, twoFamilyPinAgree: pinAgree,
    proxyBytes: out.proxy.codeBytes, proxyAgree: proxyCode.agree,
    implBytes, implAgree: implCode.agree,
    implSha256: out.impl.codeSha256,
    eip1967Impl: slotImpl.a, admin: slotAdmin.a, beacon: slotBeacon.a,
    views: Object.fromEntries(Object.entries(viewResults).map(([k, v]) => [k, v.agree ? v.resultA : `DISAGREE(${v.resultA}|${v.resultB})`])),
  }, null, 2));
})().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
