#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const REPO = path.join(ROOT, "targets", "lombard-evm-smart-contracts");
const RAW_REL = "reports/raw/fast/lombard-lbtc-reserve-ibc-verification.json";
const REPORT_REL = "reports/lombard-lbtc-reserve-ibc-verification-triage.md";
const HANDOFF_REL = "coordination/handoffs/2026-07-11-coordinator-lombard-step7-handoff.md";
const STEP6_SCANNER_REL = "tools/scan-lombard-lbtc-nonevm-state.js";
const STEP6_RAW_REL = "reports/raw/fast/lombard-lbtc-nonevm-state.json";
const POR_SOURCE_REL = "targets/lombard-evm-smart-contracts/contracts/PoR/PoR.sol";
const ORACLE_SOURCE_REL = "targets/lombard-evm-smart-contracts/contracts/LBTC/StakedLBTCOracle.sol";
const COMMIT = "5ec153c2803991ac2b0240565b1498d85375c7a5";
const POR_BLOB = "6adb6c69dda3e5e49056abee6a4370973dd5a704";
const POR_PROXY = "0xe7ebc588f4ec9297d9867ad75a9b5d86848c8018";
const ORACLE_PROXY = "0x1de9fcfedf3e51266c188ee422fba1c7860da0ef";
const MAX_BYTES = 1_000_000;
const TIMEOUT_MS = 10_000;
const POR_PAGE_SIZE = 25;
const POR_MAX_ENTRIES = 500;

// Hardcoded auth-free public fallbacks. URLs and provider identities must not enter generated output.
const ENDPOINTS = {
  base: [
    { label: "public-fallback-a", url: "https://mainnet.base.org" },
    { label: "public-fallback-b", url: "https://base-rpc.publicnode.com" },
  ],
  ethereum: [
    { label: "public-fallback-a", url: "https://ethereum-rpc.publicnode.com" },
    { label: "public-fallback-b", url: "https://cloudflare-eth.com" },
  ],
  optimism: [
    { label: "public-fallback-a", url: "https://mainnet.optimism.io" },
    { label: "public-fallback-b", url: "https://optimism-rpc.publicnode.com" },
  ],
  cosmos: [
    { label: "public-fallback-a", url: "https://rest.cosmos.directory/cosmoshub" },
    { label: "public-fallback-b", url: "https://cosmos-rest.publicnode.com" },
  ],
  babylon: [
    { label: "public-fallback-a", url: "https://babylon.nodes.guru/api" },
    { label: "public-fallback-b", url: "https://babylon-rest.publicnode.com" },
  ],
};

const IBC = {
  cosmos: { ecosystem: "Cosmos Hub", chainId: "cosmoshub-4", denom: "ibc/DBD9E339E1B093A052D76BECFFDE8435EAC114CF2133346B4D691F3F2068C957" },
  babylon: { ecosystem: "Babylon Genesis", chainId: "bbn-1", denom: "ibc/89EE10FCF78800B572BAAC7080AEFA301B5F3BBC51C5371E907EB129C5B900E7" },
};

const networkMetrics = { requests: 0, successes: 0, failures: 0, responseSizeBlocks: 0 };
const sensitiveObservedAddresses = [];
const capturedRootPubkeyIds = new Set();
let rpcId = 1;
function sha256(data) { return crypto.createHash("sha256").update(data).digest("hex"); }
function stable(v) { if (Array.isArray(v)) return v.map(stable); if (v && typeof v === "object") { const o = {}; for (const k of Object.keys(v).sort()) o[k] = stable(v[k]); return o; } return v; }
function serialize(v) { return JSON.stringify(stable(v), null, 2) + "\n"; }
function normalizeError(e) {
  const s = `${e?.name || ""} ${e?.message || e || ""}`.toLowerCase();
  if (s.includes("abort") || s.includes("timeout")) return "timeout";
  if (s.includes("response-size")) return "response-size-limit";
  if (s.includes("http-status")) return "http-status";
  if (s.includes("rpc-error")) return "rpc-error";
  if (s.includes("network-identity")) return "network-identity-mismatch";
  if (s.includes("abi-")) return "abi-decode-rejected";
  if (s.includes("json")) return "invalid-json";
  return "transport-error";
}
async function requestJson(url, options) {
  networkMetrics.requests++;
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: ctrl.signal });
    if (!response.ok) throw new Error("http-status");
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > MAX_BYTES) { networkMetrics.responseSizeBlocks++; throw new Error("response-size"); }
    if (!response.body) throw new Error("transport-error");
    const reader = response.body.getReader(), chunks = []; let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) { networkMetrics.responseSizeBlocks++; await reader.cancel(); ctrl.abort(); throw new Error("response-size"); }
      chunks.push(Buffer.from(value));
    }
    const parsed = JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
    if (parsed?.error) throw new Error("rpc-error");
    networkMetrics.successes++;
    return parsed;
  } catch (e) {
    networkMetrics.failures++;
    throw Object.assign(new Error(normalizeError(e)), { errorClass: normalizeError(e) });
  } finally { clearTimeout(timer); }
}
async function rpc(endpoint, method, params) {
  const j = await requestJson(endpoint.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }) });
  return j.result;
}
async function rest(endpoint, route) { return requestJson(endpoint.url + route, { method: "GET", headers: { accept: "application/json" } }); }
async function selectEndpoint(group, probe) {
  const failures = [];
  for (const endpoint of ENDPOINTS[group]) {
    try { return { endpoint, probe: await probe(endpoint), candidatesTried: failures.length + 1, failures }; }
    catch (e) { failures.push(e.errorClass || normalizeError(e)); }
  }
  return { endpoint: null, probe: null, candidatesTried: failures.length, failures };
}

// Minimal Keccak-256 used for Ethereum selectors, storage slots, and runtime hashes.
const MASK64 = (1n << 64n) - 1n, ROT = [[0,36,3,41,18],[1,44,10,45,2],[62,6,43,15,61],[28,55,25,21,56],[27,20,39,8,14]];
const RC = [1n,0x8082n,0x800000000000808an,0x8000000080008000n,0x808bn,0x80000001n,0x8000000080008081n,0x8000000000008009n,0x8an,0x88n,0x80008009n,0x8000000an,0x8000808bn,0x800000000000008bn,0x8000000000008089n,0x8000000000008003n,0x8000000000008002n,0x8000000000000080n,0x800an,0x800000008000000an,0x8000000080008081n,0x8000000000008080n,0x80000001n,0x8000000080008008n];
function rol(x,n){n=BigInt(n);return n?((x<<n)|(x>>(64n-n)))&MASK64:x;}
function keccak(data){const bytes=[...Buffer.from(data)],rate=136;bytes.push(1);while(bytes.length%rate!==rate-1)bytes.push(0);bytes.push(128);const a=Array(25).fill(0n);for(let o=0;o<bytes.length;o+=rate){for(let i=0;i<rate;i++)a[i>>3]^=BigInt(bytes[o+i])<<BigInt((i&7)*8);for(const rc of RC){const c=Array(5),d=Array(5),b=Array(25);for(let x=0;x<5;x++)c[x]=a[x]^a[x+5]^a[x+10]^a[x+15]^a[x+20];for(let x=0;x<5;x++)d[x]=c[(x+4)%5]^rol(c[(x+1)%5],1);for(let i=0;i<25;i++)a[i]^=d[i%5];for(let x=0;x<5;x++)for(let y=0;y<5;y++)b[((2*x+3*y)%5)*5+y]=rol(a[x+5*y],ROT[x][y]);for(let x=0;x<5;x++)for(let y=0;y<5;y++)a[x+5*y]=b[x+5*y]^((~b[(x+1)%5+5*y])&b[(x+2)%5+5*y]);a[0]^=rc;}}const out=Buffer.alloc(32);for(let i=0;i<32;i++)out[i]=Number((a[i>>3]>>BigInt((i&7)*8))&255n);return out;}
function selector(signature) { return keccak(Buffer.from(signature)).subarray(0, 4).toString("hex"); }
function slotFor(label) { const n = BigInt("0x" + keccak(Buffer.from(label)).toString("hex")) - 1n; return "0x" + n.toString(16).padStart(64, "0"); }
const IMPLEMENTATION_SLOT = slotFor("eip1967.proxy.implementation");
const ADMIN_SLOT = slotFor("eip1967.proxy.admin");
function strip0x(x) { if (typeof x !== "string" || !/^0x[0-9a-fA-F]*$/.test(x)) throw new Error("abi-invalid-hex"); return x.slice(2); }
function wordHex(n) { return BigInt(n).toString(16).padStart(64, "0"); }
function calldata(signature, words = []) { return "0x" + selector(signature) + words.map(wordHex).join(""); }
function codeSummary(code) { const h = strip0x(code || "0x"); return { codePresent: h.length > 0, byteLength: h.length / 2, keccak256: h.length ? "0x" + keccak(Buffer.from(h, "hex")).toString("hex") : null, sha256: h.length ? sha256(Buffer.from(h, "hex")) : null }; }
function addressFromSlot(value) { const h = strip0x(value || "0x").padStart(64, "0"); const a = h.slice(-40); return /^0{40}$/.test(a) ? null : "0x" + a.toLowerCase(); }
function uintWord(hex, index = 0) { const h = strip0x(hex), at = index * 64; if (at + 64 > h.length) throw new Error("abi-word-bounds"); return BigInt("0x" + h.slice(at, at + 64)); }
function addressWord(hex, index = 0) { return "0x" + uintWord(hex, index).toString(16).padStart(40, "0").slice(-40); }
function signedWord(hex, index = 0) { const x = uintWord(hex, index); return x >= (1n << 255n) ? x - (1n << 256n) : x; }

function decodeDynamicBytesAt(h, byteOffset) {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0 || byteOffset + 32 > h.length / 2) throw new Error("abi-offset-bounds");
  const len = Number(BigInt("0x" + h.slice(byteOffset * 2, byteOffset * 2 + 64)));
  if (!Number.isSafeInteger(len) || byteOffset + 32 + len > h.length / 2) throw new Error("abi-length-bounds");
  return Buffer.from(h.slice((byteOffset + 32) * 2, (byteOffset + 32 + len) * 2), "hex");
}
function rootOffsets(hex, count) {
  const h = strip0x(hex); if (h.length < count * 64) throw new Error("abi-root-short");
  return { h, offsets: Array.from({ length: count }, (_, i) => { const n = Number(BigInt("0x" + h.slice(i * 64, i * 64 + 64))); if (!Number.isSafeInteger(n) || n % 32 || n < count * 32 || n >= h.length / 2) throw new Error("abi-root-offset"); return n; }) };
}
function arrayLength(h, start) { if (start + 32 > h.length / 2) throw new Error("abi-array-short"); const n = Number(BigInt("0x" + h.slice(start * 2, start * 2 + 64))); if (!Number.isSafeInteger(n) || n > POR_PAGE_SIZE) throw new Error("abi-array-length"); return n; }
function decodeStringArray(h, start) {
  const n = arrayLength(h, start), tupleStart = start + 32, out = [];
  if (tupleStart + n * 32 > h.length / 2) throw new Error("abi-array-head");
  for (let i = 0; i < n; i++) { const off = Number(BigInt("0x" + h.slice((tupleStart + i * 32) * 2, (tupleStart + (i + 1) * 32) * 2))); const b = decodeDynamicBytesAt(h, tupleStart + off); const s = b.toString("utf8"); if (!Buffer.from(s, "utf8").equals(b)) throw new Error("abi-string-utf8"); out.push(s); }
  return out;
}
function decodeBytesArray(h, start) {
  const n = arrayLength(h, start), tupleStart = start + 32, out = [];
  if (tupleStart + n * 32 > h.length / 2) throw new Error("abi-array-head");
  for (let i = 0; i < n; i++) { const off = Number(BigInt("0x" + h.slice((tupleStart + i * 32) * 2, (tupleStart + (i + 1) * 32) * 2))); out.push(decodeDynamicBytesAt(h, tupleStart + off)); }
  return out;
}
function decodeBytes32Array(h, start) { const n = arrayLength(h, start), out = []; if (start + 32 + n * 32 > h.length / 2) throw new Error("abi-array-data"); for (let i = 0; i < n; i++) out.push("0x" + h.slice((start + 32 + i * 32) * 2, (start + 64 + i * 32) * 2).toLowerCase()); return out; }
function decodePoRPage(hex) {
  const { h, offsets } = rootOffsets(hex, 4);
  const addresses = decodeStringArray(h, offsets[0]), rootPubkeyIds = decodeBytes32Array(h, offsets[1]), messages = decodeStringArray(h, offsets[2]), signatures = decodeBytesArray(h, offsets[3]);
  if (![rootPubkeyIds.length, messages.length, signatures.length].every(n => n === addresses.length)) throw new Error("abi-parallel-array-length");
  return { addresses, rootPubkeyIds, messages, signatures };
}

function base58Decode(s) { const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"; let n = 0n; for (const c of s) { const i = alphabet.indexOf(c); if (i < 0) return null; n = n * 58n + BigInt(i); } let h = n.toString(16); if (h.length % 2) h = "0" + h; let b = n ? Buffer.from(h, "hex") : Buffer.alloc(0); let zeros = 0; while (zeros < s.length && s[zeros] === "1") zeros++; return Buffer.concat([Buffer.alloc(zeros), b]); }
function validBase58Bitcoin(s) { const b = base58Decode(s); if (!b || b.length !== 25 || ![0,5].includes(b[0])) return false; const check = crypto.createHash("sha256").update(crypto.createHash("sha256").update(b.subarray(0,21)).digest()).digest().subarray(0,4); return check.equals(b.subarray(21)); }
function bech32Polymod(values) { let chk = 1; for (const v of values) { const top = chk >>> 25; chk = ((chk & 0x1ffffff) << 5) ^ v; for (let i=0;i<5;i++) if ((top >>> i) & 1) chk ^= [0x3b6a57b2,0x26508e6d,0x1ea119fa,0x3d4233dd,0x2a1462b3][i]; } return chk >>> 0; }
function convertBits(data, from, to) { let acc=0,bits=0; const out=[],maxv=(1<<to)-1; for(const v of data){if(v<0||(v>>from))return null;acc=(acc<<from)|v;bits+=from;while(bits>=to){bits-=to;out.push((acc>>bits)&maxv);}} if(bits>=from || ((acc<<(to-bits))&maxv)) return null; return out; }
function validBech32Bitcoin(s) { if (s !== s.toLowerCase() && s !== s.toUpperCase()) return false; s=s.toLowerCase(); if (!s.startsWith("bc1") || s.length > 90) return false; const p=s.lastIndexOf("1"), chars="qpzry9x8gf2tvdw0s3jn54khce6mua7l", vals=[]; for(const c of s.slice(p+1)){const i=chars.indexOf(c);if(i<0)return false;vals.push(i);} if(vals.length<7)return false; const pm=bech32Polymod([3,3,0,2,3,...vals]),ver=vals[0],prog=convertBits(vals.slice(1,-6),5,8); if(ver>16||!prog||prog.length<2||prog.length>40)return false; if(ver===0 && ![20,32].includes(prog.length))return false; return ver===0?pm===1:pm===0x2bc830a3; }
function bitcoinAddressSyntax(address) { const base58Valid=typeof address==="string"&&validBase58Bitcoin(address),bech32Valid=typeof address==="string"&&validBech32Bitcoin(address),valid=base58Valid||bech32Valid;let addressType="unknown-or-unsupported";if(base58Valid)addressType=address.startsWith("1")?"p2pkh":"p2sh";else if(bech32Valid){const s=address.toLowerCase();addressType=s.startsWith("bc1p")?"p2tr-or-segwit-v1":s.length===42?"p2wpkh":s.length===62?"p2wsh":"segwit";}return { syntaxStatus: valid ? "valid-mainnet-syntax-and-checksum" : "invalid-or-unsupported", network: valid ? "bitcoin-mainnet" : "unverified", addressType }; }
function lengthPrefix(buffer){const n=Buffer.alloc(4);n.writeUInt32BE(buffer.length);return Buffer.concat([n,buffer]);}
function pageAggregateCommitment(start,page){const chunks=[Buffer.from("lombard-por-page-v1\0","utf8"),Buffer.from(wordHex(start),"hex")];for(let i=0;i<page.addresses.length;i++){chunks.push(lengthPrefix(Buffer.from(page.addresses[i],"utf8")),Buffer.from(page.rootPubkeyIds[i].slice(2),"hex"),lengthPrefix(Buffer.from(page.messages[i],"utf8")),lengthPrefix(page.signatures[i]));}return sha256(Buffer.concat(chunks));}

async function evmFixedPoint(group, expectedChainId) {
  return selectEndpoint(group, async e => { const chainId = Number(BigInt(await rpc(e, "eth_chainId", []))); if (chainId !== expectedChainId) throw new Error("network-identity-mismatch"); const numberHex = await rpc(e, "eth_blockNumber", []), block = await rpc(e, "eth_getBlockByNumber", [numberHex, false]); if (!block?.hash || block.number !== numberHex) throw new Error("rpc-error"); return { chainId, numberHex, block }; });
}
async function proxySummary(endpoint, address, blockHex) {
  const proxyCode = await rpc(endpoint, "eth_getCode", [address, blockHex]);
  const implementationRaw = await rpc(endpoint, "eth_getStorageAt", [address, IMPLEMENTATION_SLOT, blockHex]);
  let adminRaw = null; try { adminRaw = await rpc(endpoint, "eth_getStorageAt", [address, ADMIN_SLOT, blockHex]); } catch (_) {}
  const implementation = addressFromSlot(implementationRaw), admin = adminRaw ? addressFromSlot(adminRaw) : null;
  let implementationCode = "0x"; if (implementation) implementationCode = await rpc(endpoint, "eth_getCode", [implementation, blockHex]);
  const p = codeSummary(proxyCode), i = codeSummary(implementationCode);
  return { address, proxyCode: p, implementationAddress: implementation, implementationCode: i, adminAddress: admin, adminSlotReadable: adminRaw !== null, proxyResolved: p.codePresent && Boolean(implementation) && i.codePresent, sourceMatchStatus: "not-claimed-no-reproducible-compile-runtime-match" };
}

async function scanBasePoR() {
  const selected = await evmFixedPoint("base", 8453);
  const out = { ecosystem: "Base", providerLabel: selected.endpoint?.label || null, candidatesTried: selected.candidatesTried, resolutionFailureClasses: selected.failures, networkIdentity: selected.endpoint ? { status: "verified", expectedChainId: 8453, observedChainId: selected.probe.chainId } : { status: "unverified-no-state-promotion", expectedChainId: 8453 }, fixedBlock: null, proxy: null, list: { status: "unreadable", length: null, captured: 0, truncated: false, pageSize: POR_PAGE_SIZE, maximumEntries: POR_MAX_ENTRIES, pagesSucceeded: 0, pageFailureAt: null, capturedIndexRange: null, remainingEntries: null, statisticsScope: "captured-subset-only-non-representative", pageAggregateCommitments: [], syntaxCounts: { validMainnet: 0, invalidOrUnsupported: 0 }, addressTypeCounts: {}, networkCounts: {}, messageMetrics: { totalBytes: 0, minimumBytes: null, maximumBytes: null }, signatureMetrics: { totalBytes: 0, minimumBytes: null, maximumBytes: null, emptyCount: 0 }, perEntryRowsPersisted: false }, rootPubkeys: { status: "omitted-not-required-for-bounded-membership-scan", fullPubkeysPersisted: false }, bitcoinBalanceQuerySkipped: true, bitcoinBalanceQuerySkipRationale: "No bounded auth-free fixed-height historical UTXO method was available; current-tip address APIs are not a reproducible fixed-height solvency cut.", blockers: ["bitcoin-fixed-height-utxo-balances-not-queried", "address-membership-does-not-prove-custody-ownership-spend-control-liquidity-stake-or-unbonding", "root-pubkeys-not-queried-not-required-for-membership-scan"] };
  if (!selected.endpoint) return out;
  const e=selected.endpoint,b=selected.probe.block,blockHex=selected.probe.numberHex;
  out.fixedBlock={ number:Number(BigInt(blockHex)), numberHex:blockHex, hash:b.hash, timestampSeconds:Number(BigInt(b.timestamp)), timestamp:new Date(Number(BigInt(b.timestamp))*1000).toISOString() };
  try { out.proxy=await proxySummary(e,POR_PROXY,blockHex); } catch(err) { out.blockers.push(`proxy:${err.errorClass}`); return out; }
  if (!out.proxy.proxyResolved) { out.blockers.push("base-por-erc1967-proxy-not-resolved"); return out; }
  try {
    const lengthResult=await rpc(e,"eth_call",[{to:POR_PROXY,data:calldata("getPoRAddressListLength()")},blockHex]);
    const length=uintWord(lengthResult); if(length>BigInt(Number.MAX_SAFE_INTEGER))throw new Error("abi-length-unsafe");
    const total=Number(length),limit=Math.min(total,POR_MAX_ENTRIES); out.list.length=total; out.list.truncated=total>POR_MAX_ENTRIES;
    for(let start=0;start<limit;start+=POR_PAGE_SIZE){const end=Math.min(limit-1,start+POR_PAGE_SIZE-1);let result;try{result=await rpc(e,"eth_call",[{to:POR_PROXY,data:calldata("getPoRAddressSignatureMessages(uint256,uint256)",[start,end])},blockHex]);}catch(err){out.list.pageFailureAt=start;throw err;}const page=decodePoRPage(result);if(page.addresses.length!==end-start+1){out.list.pageFailureAt=start;throw new Error("abi-page-count");}out.list.pageAggregateCommitments.push({indexRange:`${start}-${end}`,entryCount:page.addresses.length,commitmentSha256:pageAggregateCommitment(start,page)});for(let i=0;i<page.addresses.length;i++){const exactAddress=page.addresses[i],rootId=page.rootPubkeyIds[i],syntax=bitcoinAddressSyntax(exactAddress),messageBytes=Buffer.byteLength(page.messages[i],"utf8"),signatureBytes=page.signatures[i].length;sensitiveObservedAddresses.push(exactAddress);if(!/^0x0{64}$/.test(rootId))capturedRootPubkeyIds.add(rootId);if(syntax.syntaxStatus==="valid-mainnet-syntax-and-checksum")out.list.syntaxCounts.validMainnet++;else out.list.syntaxCounts.invalidOrUnsupported++;out.list.addressTypeCounts[syntax.addressType]=(out.list.addressTypeCounts[syntax.addressType]||0)+1;out.list.networkCounts[syntax.network]=(out.list.networkCounts[syntax.network]||0)+1;out.list.messageMetrics.totalBytes+=messageBytes;out.list.messageMetrics.minimumBytes=out.list.messageMetrics.minimumBytes==null?messageBytes:Math.min(out.list.messageMetrics.minimumBytes,messageBytes);out.list.messageMetrics.maximumBytes=out.list.messageMetrics.maximumBytes==null?messageBytes:Math.max(out.list.messageMetrics.maximumBytes,messageBytes);out.list.signatureMetrics.totalBytes+=signatureBytes;out.list.signatureMetrics.minimumBytes=out.list.signatureMetrics.minimumBytes==null?signatureBytes:Math.min(out.list.signatureMetrics.minimumBytes,signatureBytes);out.list.signatureMetrics.maximumBytes=out.list.signatureMetrics.maximumBytes==null?signatureBytes:Math.max(out.list.signatureMetrics.maximumBytes,signatureBytes);if(signatureBytes===0)out.list.signatureMetrics.emptyCount++;}out.list.captured+=page.addresses.length;out.list.pagesSucceeded++;}
    out.list.capturedIndexRange=out.list.captured?`0-${out.list.captured-1}`:null;out.list.remainingEntries=Math.max(0,total-out.list.captured);out.list.status=out.list.truncated?"captured-bounded-truncated":"captured-complete-at-fixed-block";
  } catch(err){out.list.capturedIndexRange=out.list.captured?`0-${out.list.captured-1}`:null;out.list.remainingEntries=out.list.length==null?null:Math.max(0,out.list.length-out.list.captured);out.list.status=out.list.captured?"captured-partial-page-read-failed":"unreadable-or-decode-rejected";out.list.errorClass=err.errorClass||normalizeError(err);out.blockers.push(`por-list:${out.list.errorClass}`);}
  return out;
}

async function scanOracle(group, ecosystem, expectedChainId) {
  const selected=await evmFixedPoint(group,expectedChainId);
  const out={ecosystem,providerLabel:selected.endpoint?.label||null,candidatesTried:selected.candidatesTried,resolutionFailureClasses:selected.failures,networkIdentity:selected.endpoint?{status:"verified",expectedChainId,observedChainId:selected.probe.chainId}:{status:"unverified-no-state-promotion",expectedChainId},fixedBlock:null,proxy:null,classification:"exchange-rate-oracle-not-reserve-attestation",fields:{},blockers:[]};
  if(!selected.endpoint){out.blockers.push("public-fixed-block-fallback-unavailable");return out;}
  const e=selected.endpoint,b=selected.probe.block,blockHex=selected.probe.numberHex;out.fixedBlock={number:Number(BigInt(blockHex)),numberHex:blockHex,hash:b.hash,timestampSeconds:Number(BigInt(b.timestamp)),timestamp:new Date(Number(BigInt(b.timestamp))*1000).toISOString()};
  try{out.proxy=await proxySummary(e,ORACLE_PROXY,blockHex);}catch(err){out.blockers.push(`proxy:${err.errorClass}`);return out;}
  if(!out.proxy.proxyResolved)out.blockers.push("oracle-erc1967-proxy-not-resolved");
  const calls=[
    ["ratio","ratio()",x=>uintWord(x).toString(),"1e18 ratio units"],
    ["getRate","getRate()",x=>uintWord(x).toString(),"1e18 exchange-rate units"],
    ["decimals","decimals()",x=>Number(uintWord(x)),"decimal places"],
    ["token","token()",x=>addressWord(x),"configured token address"],
    ["denomHash","denomHash()",x=>"0x"+strip0x(x).slice(0,64).toLowerCase(),"configured denomination hash"],
    ["nextRatio","nextRatio()",x=>({ratio:uintWord(x,0).toString(),switchTime:uintWord(x,1).toString()}),"scheduled ratio and Unix switch time"],
    ["latestRoundData","latestRoundData()",x=>({roundId:uintWord(x,0).toString(),answer:signedWord(x,1).toString(),startedAt:uintWord(x,2).toString(),updatedAt:uintWord(x,3).toString(),answeredInRound:uintWord(x,4).toString()}),"exchange-rate feed fields; answer is not a reserve amount"],
  ];
  for(const [name,sig,decode,units] of calls){try{const result=await rpc(e,"eth_call",[{to:ORACLE_PROXY,data:calldata(sig)},blockHex]);out.fields[name]={status:"observed-at-fixed-block",value:decode(result),units};}catch(err){out.fields[name]={status:"unreadable",errorClass:err.errorClass};}}
  const round=out.fields.latestRoundData?.value;
  if(round){const updated=Number(round.updatedAt),roundId=BigInt(round.roundId),answered=BigInt(round.answeredInRound),updatedAtZero=updated===0,updatedAtFuture=Number.isFinite(updated)&&updated>out.fixedBlock.timestampSeconds,validAge=Number.isSafeInteger(updated)&&updated>0&&!updatedAtFuture;out.oracleAssessment={observedAgeSeconds:validAge?out.fixedBlock.timestampSeconds-updated:null,updatedAtZero,updatedAtFuture,roundConsistent:roundId>0n&&answered>0n&&answered>=roundId,freshnessStatus:"unknown-no-acceptance-threshold",reserveFreshnessInference:false};}
  else out.oracleAssessment={observedAgeSeconds:null,updatedAtZero:null,updatedAtFuture:null,roundConsistent:null,freshnessStatus:"unknown-no-acceptance-threshold",reserveFreshnessInference:false};
  out.freshnessCaveat="Oracle timestamps describe ratio scheduling/feed context only and are not custody, reserve, or liability attestation timestamps.";
  return out;
}

function denomHash(denom){return denom.startsWith("ibc/")?denom.slice(4).toUpperCase():null;}
function extractTrace(j){return j?.denom_trace||j?.denomTrace||null;}
function traceFromList(j,hash){const rows=j?.denom_traces||j?.denomTraces||[];return Array.isArray(rows)?rows.find(t=>{const base=t?.base_denom||t?.baseDenom;if(!base)return false;const pre=t.path?`${t.path}/${base}`:base;return sha256(Buffer.from(pre)).toUpperCase()===hash;})||null:null;}
function verifyTrace(trace,hash){const base=trace?.base_denom||trace?.baseDenom;if(typeof base!=="string"||typeof trace?.path!=="string")return{status:"trace-schema-rejected",hashMatches:false};const preimage=trace.path?`${trace.path}/${base}`:base,computed=sha256(Buffer.from(preimage)).toUpperCase(),match=computed===hash;return{status:match?"observed-hash-verified":"hash-mismatch-rejected",path:trace.path,baseDenom:base,preimageSha256:computed,expectedIbcHash:hash,hashMatches:match};}
async function scanIbc(group){const cfg=IBC[group],selected=await selectEndpoint(group,async e=>{const latest=await rest(e,"/cosmos/base/tendermint/v1beta1/blocks/latest"),chainId=latest?.block?.header?.chain_id;if(chainId!==cfg.chainId)throw new Error("network-identity-mismatch");return latest;});const out={ecosystem:cfg.ecosystem,providerLabel:selected.endpoint?.label||null,candidatesTried:selected.candidatesTried,resolutionFailureClasses:selected.failures,networkIdentity:selected.endpoint?{status:"verified",expectedChainId:cfg.chainId,observedChainId:selected.probe?.block?.header?.chain_id}:{status:"unverified-no-state-promotion",expectedChainId:cfg.chainId},anchor:null,denom:cfg.denom,supply:{status:"unreadable",identityBoundExactDenom:false,heightPinned:false},denomTrace:{status:"unreadable"},voucherSemantics:"unresolved-source-escrow-burn-transit-mapping",blockers:[]};if(!selected.endpoint)return out;const e=selected.endpoint,h=selected.probe?.block?.header;out.anchor={height:h?.height??null,hash:selected.probe?.block_id?.hash??null,timestamp:h?.time??null};try{const s=await rest(e,`/cosmos/bank/v1beta1/supply/by_denom?denom=${encodeURIComponent(cfg.denom)}`),match=s?.amount?.denom===cfg.denom,observed=s?.amount?.amount!==undefined&&match;out.supply={status:observed?"observed-exact-denom":(s?.amount?.amount!==undefined?"denom-mismatch-rejected":"unreadable"),amount:observed?s.amount.amount:null,denom:s?.amount?.denom??null,expectedDenom:cfg.denom,denomMatches:match,identityBoundExactDenom:observed,heightPinned:false,supplyStateSkewStatus:"unknown-unbounded-by-returned-context"};}catch(err){out.supply={status:"unreadable",errorClass:err.errorClass,expectedDenom:cfg.denom,identityBoundExactDenom:false,heightPinned:false,supplyStateSkewStatus:"unknown-unbounded-by-returned-context"};}const hash=denomHash(cfg.denom),routes=[`/ibc/apps/transfer/v1/denom_traces/${hash}`,`/ibc/apps/transfer/v1beta1/denom_traces/${hash}`];let trace=null;for(const route of routes){try{const j=await rest(e,route);trace=extractTrace(j);if(trace)break;}catch(_){}}if(!trace){for(const route of ["/ibc/apps/transfer/v1/denom_traces?pagination.limit=500","/ibc/apps/transfer/v1beta1/denom_traces?pagination.limit=500"]){try{const j=await rest(e,route);trace=traceFromList(j,hash);if(trace)break;}catch(_){}}}out.denomTrace=trace?verifyTrace(trace,hash):{status:"unreadable",expectedIbcHash:hash,hashMatches:false};if(out.denomTrace.status!=="observed-hash-verified")out.blockers.push("ics20-origin-hash-not-verified");out.blockers.push("voucher-source-escrow-burn-transit-dedup-unresolved");return out;}

function atomicWrite(rel,text){const target=path.join(ROOT,rel),temp=`${target}.tmp-${process.pid}`;fs.writeFileSync(temp,text,"utf8");fs.renameSync(temp,target);}
function git(...args){return execFileSync("git",args,{cwd:REPO,encoding:"utf8",windowsHide:true}).trim();}
function renderReport(raw){const m=raw.metrics,lines=["# Lombard LBTC Step 7 — Reserve Membership and IBC Verification","",`**Classification:** ${raw.classification}`,"","> Public auth-free read-only queries only. Generated output stores no per-entry rows, exact Bitcoin addresses, root-ID linkage, or per-entry deterministic identifiers; only generic provider labels and ordered page-level aggregate commitments are retained.","",`Requests/successes/failures: ${m.requests}/${m.successes}/${m.failures}.`,`Base proxy resolved: ${m.baseProxyResolved}; PoR list length: ${m.porListLength??"unknown"}; captured: ${m.porEntriesCaptured}; captured range: ${m.capturedIndexRange??"none"}; pages succeeded: ${m.pagesSucceeded}; page failure at: ${m.pageFailureAt??"none"}; remaining entries: ${m.remainingEntries??"unknown"}; truncated: ${m.porTruncated}.`,`Captured-subset-only, explicitly non-representative aggregate statistics: syntactically valid=${m.syntacticallyValidBitcoinAddressesCapturedSubsetOnly}; unique root IDs=${m.uniqueRootPubkeyIdsCapturedSubsetOnly}.`,`Bitcoin balance query skipped: ${m.bitcoinBalanceQuerySkipped}. Oracle proxies resolved: ${m.oracleProxyResolved}.`,`Identity-bound exact-denom supplies: ${m.identityBoundExactDenomSupplyRows}; ICS-20 trace verified: ${m.ics20TraceVerifiedRows}; height-pinned supplies: ${m.heightPinnedSupplyRows}; fully reconciled liabilities: ${m.fullyReconciledLiabilityRows}.`,"","## Base PoR",`- Fixed block: ${raw.base.fixedBlock?.number??"unresolved"}; proxy status: ${raw.base.proxy?.proxyResolved?"resolved":"unresolved"}.`,`- No per-entry rows, exact addresses, root-ID linkage, or per-entry commitments are persisted. Page commitments are ordered-page integrity/audit markers only and are not UTXO lookup inputs.`,`- Message/derivation and signature information is retained only as aggregate byte/count metrics.`,`- Any future UTXO reconstruction must re-fetch exact addresses from this fixed Base block.`,`- Membership rows are public registry observations only; they do not prove custody, ownership, spend control, balances, liquidity, stake, or unbonding.`,`- ${raw.base.bitcoinBalanceQuerySkipRationale}`,"","## Exchange-rate oracle probes"];for(const o of raw.oracles)lines.push(`- ${o.ecosystem}: ${o.classification}; fixed block ${o.fixedBlock?.number??"unresolved"}; proxy ${o.proxy?.proxyResolved?"resolved":"unresolved"}; ratio=${o.fields?.ratio?.value??"unknown"}; getRate=${o.fields?.getRate?.value??"unknown"}; latestRoundData.answer=${o.fields?.latestRoundData?.value?.answer??"unknown"} (not reserve amount); observedAgeSeconds=${o.oracleAssessment?.observedAgeSeconds??"unknown"}; updatedAtZero=${o.oracleAssessment?.updatedAtZero??"unknown"}; updatedAtFuture=${o.oracleAssessment?.updatedAtFuture??"unknown"}; roundConsistent=${o.oracleAssessment?.roundConsistent??"unknown"}; freshnessStatus=${o.oracleAssessment?.freshnessStatus??"unknown"}; no reserve freshness inferred.`);lines.push("","## IBC observations");for(const x of raw.ibc)lines.push(`- ${x.ecosystem}: supply=${x.supply.status}${x.supply.amount!=null?` amount=${x.supply.amount}`:""}; trace=${x.denomTrace.status}; path=${x.denomTrace.path??"unknown"}; baseDenom=${x.denomTrace.baseDenom??"unknown"}; heightPinned=${x.supply.heightPinned}; voucher dedup=${x.voucherSemantics}.`);lines.push("","## Blockers",...raw.blockers.map(x=>`- ${x}`),"","## Conclusion",`**${raw.classification}**`,"","No exploit, insolvency, or permissionless invariant violation is proven. No supplies or reserves are aggregated or promoted. All execution gates remain closed.","","## Next bounded step",raw.nextStep,"");return lines.join("\n");}
function renderHandoff(raw){const m=raw.metrics;return["# Coordinator Handoff — Lombard LBTC Step 7 — 2026-07-11","",`- Classification: **${raw.classification}**`,`- Requests/successes/failures: ${m.requests}/${m.successes}/${m.failures}.`,`- Base proxy resolved=${m.baseProxyResolved}; PoR list length=${m.porListLength??"unknown"}; captured=${m.porEntriesCaptured}; captured range=${m.capturedIndexRange??"none"}; pages succeeded=${m.pagesSucceeded}; page failure at=${m.pageFailureAt??"none"}; remaining=${m.remainingEntries??"unknown"}; truncated=${m.porTruncated}.`,`- Captured-subset-only and non-representative aggregate statistics: valid Bitcoin syntax=${m.syntacticallyValidBitcoinAddressesCapturedSubsetOnly}; unique root IDs=${m.uniqueRootPubkeyIdsCapturedSubsetOnly}.`,`- No per-entry rows, exact addresses, root-ID linkage, or per-entry deterministic identifiers are persisted. Ordered page commitments are integrity markers only; message/signature metrics are aggregate-only. Future UTXO work must re-fetch exact addresses from the fixed Base block.`,`- bitcoinBalanceQuerySkipped=${m.bitcoinBalanceQuerySkipped}; no current-tip address balance API was used.`,`- Oracle proxy resolved count=${m.oracleProxyResolved}; all oracle results are exchange-rate-oracle-not-reserve-attestation with freshnessStatus=unknown-no-acceptance-threshold and no reserve freshness inference.`,`- Exact-denom supplies=${m.identityBoundExactDenomSupplyRows}; verified ICS-20 traces=${m.ics20TraceVerifiedRows}; height-pinned supplies=${m.heightPinnedSupplyRows}; fully reconciled liabilities=${m.fullyReconciledLiabilityRows}.`,`- Membership and voucher observations are not custody, ownership, balance, liquidity, escrow, transit, or solvency proof.`,"","## Required next step",raw.nextStep,"","## Closed gates","`routePositive=0`, `routeEvidenceStatus=unknown`, `evidenceComplete=false`, `closureEligible=false`, `executableNow=0`, `signedActionJustified=false`, `forkJustified=false`.",""].join("\n");}

async function main(){
  const sourcePath=path.join(ROOT,POR_SOURCE_REL),oraclePath=path.join(ROOT,ORACLE_SOURCE_REL),step6Scanner=path.join(ROOT,STEP6_SCANNER_REL),step6Raw=path.join(ROOT,STEP6_RAW_REL);
  if(git("rev-parse","HEAD")!==COMMIT||git("rev-parse",`${COMMIT}:contracts/PoR/PoR.sol`)!==POR_BLOB)throw new Error("source-provenance-mismatch");
  const base=await scanBasePoR(),oracles=[await scanOracle("ethereum","Ethereum",1),await scanOracle("optimism","Optimism",10)],ibc=[await scanIbc("cosmos"),await scanIbc("babylon")];
  const metrics={...networkMetrics,baseProxyResolved:base.proxy?.proxyResolved?1:0,porListLength:base.list.length,porEntriesCaptured:base.list.captured,porTruncated:base.list.truncated,capturedIndexRange:base.list.capturedIndexRange,pagesSucceeded:base.list.pagesSucceeded,pageFailureAt:base.list.pageFailureAt,remainingEntries:base.list.remainingEntries,syntacticallyValidBitcoinAddressesCapturedSubsetOnly:base.list.syntaxCounts.validMainnet,uniqueRootPubkeyIdsCapturedSubsetOnly:capturedRootPubkeyIds.size,capturedSubsetStatisticsRepresentative:false,bitcoinBalanceQuerySkipped:base.bitcoinBalanceQuerySkipped,oracleProxyResolved:oracles.filter(x=>x.proxy?.proxyResolved).length,identityBoundExactDenomSupplyRows:ibc.filter(x=>x.supply.identityBoundExactDenom).length,ics20TraceVerifiedRows:ibc.filter(x=>x.denomTrace.status==="observed-hash-verified"&&x.denomTrace.hashMatches===true).length,heightPinnedSupplyRows:ibc.filter(x=>x.supply.heightPinned).length,fullyReconciledLiabilityRows:0};
  const blockers=[...base.blockers,...oracles.flatMap(x=>x.blockers.map(b=>`${x.ecosystem}: ${b}`)),...ibc.flatMap(x=>x.blockers.map(b=>`${x.ecosystem}: ${b}`)),"PoR deployed runtime was not reproducibly compiled and matched to local source.","Bitcoin fixed-height UTXO balances, ownership/spend control, active stake, unbonding, bridge transit, and slashing joins remain absent.","Remaining non-EVM and EVM liability, escrow, burn/mint mode, and in-flight message gaps remain unresolved."];
  const raw={generatedAt:new Date().toISOString(),scanner:"tools/scan-lombard-lbtc-reserve-ibc-verification.js",classification:"INCOMPLETE/WATCH — RESERVE OWNERSHIP/BALANCES AND IBC ORIGINS BLOCKED",provenance:{checkoutCommit:COMMIT,porSource:{path:POR_SOURCE_REL,gitBlobId:POR_BLOB,sha256:sha256(fs.readFileSync(sourcePath))},oracleSource:{path:ORACLE_SOURCE_REL,gitBlobId:git("rev-parse",`${COMMIT}:contracts/LBTC/StakedLBTCOracle.sol`),sha256:sha256(fs.readFileSync(oraclePath))},step6Scanner:{path:STEP6_SCANNER_REL,sha256:sha256(fs.readFileSync(step6Scanner))},step6Artifact:{path:STEP6_RAW_REL,sha256:sha256(fs.readFileSync(step6Raw))}},limits:{timeoutMs:TIMEOUT_MS,responseSizeCapBytes:MAX_BYTES,porPageSize:POR_PAGE_SIZE,porMaximumEntries:POR_MAX_ENTRIES,sequentialCalls:true},dataMinimizationPolicy:{perEntryRowsPersisted:false,exactBitcoinAddressesPersisted:false,rootPubkeyIdLinkagePersisted:false,perEntryDeterministicIdentifiersPersisted:false,pageAggregateCommitmentDomain:"lombard-por-page-v1\\0",commitmentsPurpose:"ordered-page-integrity-and-audit-markers-only",futureUtxoRequirement:"Re-fetch exact Bitcoin addresses from the recorded fixed Base block before any fixed-height UTXO reconstruction.",capturedSubsetStatistics:"captured-subset-only-and-explicitly-non-representative"},base,oracles,ibc,metrics,blockers:[...new Set(blockers)].sort(),bitcoinBalanceQuerySkipped:true,bitcoinBalanceQuerySkipRationale:base.bitcoinBalanceQuerySkipRationale,conclusion:{exploitProven:false,insolvencyProven:false,permissionlessInvariantViolationProven:false,reservesAggregated:false,liabilitiesAggregated:false,aggregatePromotion:false,fullyReconciledLiabilityRows:0},gates:{routePositive:0,routeEvidenceStatus:"unknown",evidenceComplete:false,closureEligible:false,executableNow:0,signedActionJustified:false,forkJustified:false},safety:{privateEndpointInventoryRead:false,envFilesRead:false,secretsRead:false,keysRead:false,transactions:false,signing:false,wallets:false,mutations:false,forks:false,deployments:false,aggregatePromotion:false,endpointUrlsStored:false,endpointDomainsStored:false,requestHeadersStored:false,rawErrorsStored:false,responseBodiesStored:false,perEntryRowsStored:false,exactBitcoinAddressesStored:false,rootPubkeyIdLinkageStored:false,perEntryDeterministicIdentifiersStored:false,generatedOutputLeakCheck:"passed",authFreePublicReadOnlyNetworkOnly:true},nextStep:"Perform a reproducible Bitcoin fixed-height UTXO reconstruction after re-fetching exact addresses from the recorded fixed Base block, then join Babylon active stake/unbonding/transit/slashing state and remaining non-EVM/EVM liability, escrow, burn/mint-mode, and in-flight-message gaps. Explicit authorization is required only if private endpoint inventories are to be used."};
  const text=serialize(raw),report=renderReport(raw),handoff=renderHandoff(raw),outputs=[["raw",text],["report",report],["handoff",handoff]];
  const urls=Object.values(ENDPOINTS).flat().map(x=>x.url),hosts=urls.map(x=>new URL(x).hostname),forbidden=[...urls,...hosts,"publicnode","cloudflare","nodes.guru","cosmos.directory","\"headers\"","\"rawError\"","\"responseBody\""];
  for(const[name,out]of outputs)if(forbidden.some(x=>out.toLowerCase().includes(x.toLowerCase())))throw new Error(`${name}-output-leak`);
  for(const[name,out]of outputs)if(sensitiveObservedAddresses.some(address=>out.includes(address)))throw new Error(`${name}-bitcoin-address-leak`);
  for(const[name,out]of outputs)if(out.includes("addressCommitmentSha256")||out.includes("rootPubkeyIdCommitmentSha256")||out.includes("\"bitcoinAddress\"")||out.includes("\"rootPubkeyId\"")||out.includes("\"entries\""))throw new Error(`${name}-per-entry-linkage-leak`);
  if(base.list.perEntryRowsPersisted!==false||!Array.isArray(base.list.pageAggregateCommitments)||base.list.pageAggregateCommitments.length!==base.list.pagesSucceeded)throw new Error("minimization-self-check");
  if(!raw.bitcoinBalanceQuerySkipped||metrics.fullyReconciledLiabilityRows!==0||ibc.some(x=>x.denomTrace.status==="observed-hash-verified"&&x.denomTrace.hashMatches!==true))throw new Error("fail-closed-self-check");
  if(raw.gates.routePositive!==0||raw.gates.routeEvidenceStatus!=="unknown"||raw.gates.evidenceComplete||raw.gates.closureEligible||raw.gates.executableNow||raw.gates.signedActionJustified||raw.gates.forkJustified)throw new Error("gate-self-check");
  const unboundedReadToken=[".array","Buffer("].join("");if(fs.readFileSync(__filename,"utf8").includes(unboundedReadToken))throw new Error("unbounded-read-self-check");
  atomicWrite(RAW_REL,text);atomicWrite(REPORT_REL,report);atomicWrite(HANDOFF_REL,handoff);
  process.stdout.write(`rawSha256=${sha256(text)} reportSha256=${sha256(report)} handoffSha256=${sha256(handoff)} scannerSha256=${sha256(fs.readFileSync(__filename))} requests=${metrics.requests} successes=${metrics.successes} failures=${metrics.failures} baseProxyResolved=${metrics.baseProxyResolved} porListLength=${metrics.porListLength??"unknown"} porEntriesCaptured=${metrics.porEntriesCaptured} capturedIndexRange=${metrics.capturedIndexRange??"none"} pagesSucceeded=${metrics.pagesSucceeded} pageFailureAt=${metrics.pageFailureAt??"none"} remainingEntries=${metrics.remainingEntries??"unknown"} porTruncated=${metrics.porTruncated} syntacticallyValidBitcoinAddressesCapturedSubsetOnly=${metrics.syntacticallyValidBitcoinAddressesCapturedSubsetOnly} uniqueRootPubkeyIdsCapturedSubsetOnly=${metrics.uniqueRootPubkeyIdsCapturedSubsetOnly} bitcoinBalanceQuerySkipped=${metrics.bitcoinBalanceQuerySkipped} oracleProxyResolved=${metrics.oracleProxyResolved} oracleAges=${oracles.map(x=>`${x.ecosystem}:${x.oracleAssessment?.observedAgeSeconds??"unknown"}`).join(",")} identityBoundExactDenomSupplyRows=${metrics.identityBoundExactDenomSupplyRows} ics20TraceVerifiedRows=${metrics.ics20TraceVerifiedRows} heightPinnedSupplyRows=${metrics.heightPinnedSupplyRows} fullyReconciledLiabilityRows=${metrics.fullyReconciledLiabilityRows} leakCheck=passed minimizationCheck=passed\n`);
}

main().catch(e=>{const safe=/-(?:output|bitcoin-address)-leak$|^(minimization-self-check|fail-closed-self-check|gate-self-check|unbounded-read-self-check|source-provenance-mismatch)$/.test(e?.message||"")?e.message:normalizeError(e);process.stderr.write(`scan-lombard-lbtc-reserve-ibc-verification failed: ${safe}\n`);process.exitCode=1;});
