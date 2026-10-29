#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const RAW_REL = "reports/raw/fast/lombard-lbtc-nonevm-resolution.json";
const REPORT_REL = "reports/lombard-lbtc-nonevm-resolution-triage.md";
const HANDOFF_REL = "coordination/handoffs/2026-07-12-coordinator-lombard-step13-handoff.md";
const CLASSIFICATION = "INCOMPLETE/WATCH — NON-EVM SUPPLY PARTIAL, BRIDGE/BACKING RECONCILIATION BLOCKED";
const MAX_BYTES = 1_000_000, MAX_ABI_BYTES = 300_000, TIMEOUT_MS = 10_000, WALL_MS = 150_000, MAX_REQUESTS = 100;
const SOLANA_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", SUI_CHAIN = "35834a8a", STARK_CHAIN = "0x534e5f4d41494e";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const IDS = {
  solana: { mint: "LBTCgU4b3wsFKsPwBn1rRZDx5DoFutM6RPiEt1TPDsY", program: "LomP48F7bLbKyMRHHsDVt7wuHaUQvQnVVspjcbfuAek", config: "5Ls2ezQpvUmthZqqtUftTbfehWaDM7EDqrcTq9esiMr1", oft: "7QkBVz37mjevzKYJDcVy6xKDG1hUewWgj51Dehgcu5sM", bascule: "E1p8P6TTe8QvKmSK7QZ3n7HtQY9hE1p9JrCwLrXnPUfn" },
  sui: { coinObject: "0x3e8e9423d80e1774a7ca128fccd8bf5f1f7753be658c5e645929037f7c819040", package: "0x818430a456ff977f7320f78650d19801f90758d200a01dd3c2c679472c521357", controlTreasury: "0x1adadbca040f368abd554ac55e7c216ea6df2ff891fc647f037d66669661584a", consortiumPackage: "0x2af188f9cc293640ced68e89a4c5773ee84702df3f10bcd080ccb894116398c3", consortiumObject: "0x9f68fe752d0879d615415e39207f0363a6fc8e0b3b335e976f5f18b31f55faf3", basculePackage: "0xff2c46f430582f4ea1842e584e7e6f99719d258c886b704509e65bc95c16e61b", basculeObject: "0x138938cb496cf0900be970dde1407d86497b8c69182cb5aa22dc4767c92bedcc" },
  starknet: { token: "0x036834a40984312f7f7de8d31e3f6305b325389eaeea5b1c0664b2fb936461a4" },
};
const ENDPOINTS = {
  solana: [{ label: "public-fallback-a", url: "https://api.mainnet-beta.solana.com" }, { label: "public-fallback-b", url: "https://solana-rpc.publicnode.com" }],
  sui: [{ label: "public-fallback-a", url: "https://fullnode.mainnet.sui.io:443" }, { label: "public-fallback-b", url: "https://sui-mainnet-endpoint.blockvision.org" }],
  starknet: [{ label: "public-fallback-a", url: "https://starknet-mainnet.public.blastapi.io/rpc/v0_8" }, { label: "public-fallback-b", url: "https://starknet-rpc.publicnode.com" }],
};

const started = Date.now(), network = { requests: 0, successes: 0, failures: 0, retries: 0, responseSizeBlocks: 0, failureClasses: {} }; let rpcId = 1;
function sha256(x) { return crypto.createHash("sha256").update(x).digest("hex"); }
function stable(v) { if (Array.isArray(v)) return v.map(stable); if (v && typeof v === "object") { const o = {}; for (const k of Object.keys(v).sort()) o[k] = stable(v[k]); return o; } return v; }
function serialize(v) { return JSON.stringify(stable(v), null, 2) + "\n"; }
function canonicalHash(v) { return sha256(Buffer.from(JSON.stringify(stable(v)))); }
function normalizeError(e) { const s = `${e?.name || ""} ${e?.message || e || ""}`.toLowerCase(); if (s.includes("wall-limit")) return "wall-time-limit"; if (s.includes("request-limit")) return "request-limit"; if (s.includes("abort") || s.includes("timeout")) return "timeout"; if (s.includes("size-limit")) return "response-size-limit"; if (s.includes("http-status")) return "http-status"; if (s.includes("rpc-error")) return "rpc-error"; if (s.includes("identity")) return "network-identity-mismatch"; if (s.includes("json")) return "invalid-json"; if (s.includes("schema") || s.includes("decode")) return "validation-rejected"; return "transport-error"; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function requestJson(endpoint, body) {
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (network.requests >= MAX_REQUESTS) throw new Error("request-limit"); if (Date.now() - started >= WALL_MS) throw new Error("wall-limit");
    network.requests++; if (attempt) network.retries++;
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), Math.min(TIMEOUT_MS, Math.max(1, WALL_MS - (Date.now() - started))));
    try {
      const response = await fetch(endpoint.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal, redirect: "error" });
      if (!response.ok) throw new Error("http-status"); const declared = Number(response.headers.get("content-length") || 0); if (declared > MAX_BYTES) { network.responseSizeBlocks++; throw new Error("size-limit"); }
      if (!response.body) throw new Error("transport-error"); const reader = response.body.getReader(), chunks = []; let total = 0;
      while (true) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength; if (total > MAX_BYTES) { network.responseSizeBlocks++; await reader.cancel(); ctrl.abort(); throw new Error("size-limit"); } chunks.push(Buffer.from(value)); }
      const json = JSON.parse(Buffer.concat(chunks, total).toString("utf8")); if (json?.error) throw new Error("rpc-error"); network.successes++; return json.result;
    } catch (e) { last = e; network.failures++; const c = normalizeError(e); network.failureClasses[c] = (network.failureClasses[c] || 0) + 1; if (attempt === 0 && ["timeout", "transport-error"].includes(c)) { await sleep(300); continue; } break; }
    finally { clearTimeout(timer); }
  }
  const errorClass = normalizeError(last); throw Object.assign(new Error(errorClass), { errorClass });
}
async function rpc(e, method, params) { return requestJson(e, { jsonrpc: "2.0", id: rpcId++, method, params }); }
async function select(group, probe) { const failures = []; for (const e of ENDPOINTS[group]) { try { return { endpoint: e, value: await probe(e), tried: failures.length + 1, failures }; } catch (x) { failures.push(x.errorClass || normalizeError(x)); } } return { endpoint: null, value: null, tried: ENDPOINTS[group].length, failures }; }

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes) { let n = BigInt("0x" + Buffer.from(bytes).toString("hex")), out = ""; while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; } for (const b of bytes) { if (b) break; out = "1" + out; } return out || "1"; }
function u64le(b, at) { if (!Buffer.isBuffer(b) || at + 8 > b.length) throw new Error("decode-bounds"); return b.readBigUInt64LE(at); }
function authority(option, bytes) { if (![0, 1].includes(option)) throw new Error("decode-authority-option"); return option === 1 ? { present: true, commitmentSha256: sha256(bytes) } : { present: false, commitmentSha256: null }; }
function decodeMint(data) {
  if (!Buffer.isBuffer(data) || data.length !== 82) throw new Error("decode-mint-size"); const mintOption = data.readUInt32LE(0), freezeOption = data.readUInt32LE(46), initialized = data[45]; if (![0, 1].includes(initialized)) throw new Error("decode-mint-initialized");
  return { layout: "spl-token-mint-82", supply: u64le(data, 36).toString(), decimals: data[44], initialized: initialized === 1, mintAuthority: authority(mintOption, data.subarray(4, 36)), freezeAuthority: authority(freezeOption, data.subarray(50, 82)) };
}
function accountData(result) { const value = result?.value, enc = Array.isArray(value?.data) && value.data[1] === "base64" ? value.data[0] : null; return { contextSlot: result?.context?.slot ?? null, value, bytes: typeof enc === "string" ? Buffer.from(enc, "base64") : null }; }
async function accountAt(e, id, slot) { return accountData(await rpc(e, "getAccountInfo", [id, { encoding: "base64", commitment: "finalized", minContextSlot: slot }])); }
async function scanSolana() {
  const selected = await select("solana", async e => { const genesis = await rpc(e, "getGenesisHash", []); if (genesis !== SOLANA_GENESIS) throw new Error("identity"); const slot = await rpc(e, "getSlot", [{ commitment: "finalized" }]); const blockTime = await rpc(e, "getBlockTime", [slot]); return { genesis, slot, blockTime }; });
  const out = { ecosystem: "Solana", providerLabel: selected.endpoint?.label || null, providersTried: selected.tried, failureClasses: selected.failures, identity: { status: selected.endpoint ? "verified-mainnet" : "unverified", expectedGenesis: SOLANA_GENESIS }, fixedPoint: null, accounts: [], mint: { status: "unreadable" }, supply: { status: "unreadable", raw: null, decimals: null, ui: null }, programUpgrade: { status: "unresolved" }, sourceRepresentation: "official-step6-identifiers-plus-live-rpc", bridgeDedupStatus: "blocked-oft-config-peer-and-transit-bindings-not-source-derived", blockers: [] };
  if (!selected.endpoint) { out.blockers.push("solana-mainnet-fixed-point-unresolved"); return out; }
  const e = selected.endpoint, slot = selected.value.slot, contexts = [];
  out.fixedPoint = { slot, blockTime: selected.value.blockTime, timestamp: Number.isInteger(selected.value.blockTime) ? new Date(selected.value.blockTime * 1000).toISOString() : null, commitment: "finalized" };
  let supplyResult = null; try { supplyResult = await rpc(e, "getTokenSupply", [IDS.solana.mint, { commitment: "finalized", minContextSlot: slot }]); contexts.push(supplyResult?.context?.slot); } catch (x) { out.blockers.push(`token-supply:${x.errorClass}`); }
  const accountMap = {};
  for (const [kind, id] of Object.entries(IDS.solana)) {
    try { const a = await accountAt(e, id, slot); contexts.push(a.contextSlot); accountMap[kind] = a; out.accounts.push({ kind, status: a.value && a.bytes ? "observed" : "missing", contextSlot: a.contextSlot, owner: a.value?.owner || null, executable: a.value?.executable === true, dataLength: a.bytes?.length ?? null, dataSha256: a.bytes ? sha256(a.bytes) : null }); }
    catch (x) { out.accounts.push({ kind, status: "unreadable", errorClass: x.errorClass }); }
  }
  try {
    const a = accountMap.mint; if (!a?.bytes || a.value?.owner !== TOKEN_PROGRAM) throw new Error("decode-token-owner"); const decoded = decodeMint(a.bytes); out.mint = { status: "verified-spl-mint", tokenProgramOwnerVerified: true, ...decoded };
    const s = supplyResult?.value, supplyMatches = typeof s?.amount === "string" && s.amount === decoded.supply && Number(s.decimals) === decoded.decimals;
    out.supply = supplyMatches ? { status: "observed-identity-bound-mint-decoded", raw: decoded.supply, decimals: decoded.decimals, ui: s.uiAmountString ?? null, contextSlot: supplyResult.context.slot, mintLayoutMatchesRpc: true } : { status: "rpc-and-mint-layout-mismatch", raw: null, decimals: null, ui: null };
  } catch (x) { out.mint = { status: "unverified-mint-layout-or-owner" }; out.blockers.push("spl-mint-layout-owner-or-rpc-supply-verification-failed"); }
  try {
    const p = accountMap.program; if (!p?.bytes || p.value?.owner !== UPGRADEABLE_LOADER || !p.value.executable || p.bytes.length !== 36 || p.bytes.readUInt32LE(0) !== 2) throw new Error("decode-program");
    const programDataId = base58(p.bytes.subarray(4, 36)), pd = await accountAt(e, programDataId, slot); contexts.push(pd.contextSlot);
    if (!pd.bytes || pd.value?.owner !== UPGRADEABLE_LOADER || pd.bytes.length < 13 || pd.bytes.readUInt32LE(0) !== 3) throw new Error("decode-programdata");
    const option = pd.bytes[12], auth = option === 0 ? { present: false, commitmentSha256: null } : option === 1 && pd.bytes.length >= 45 ? { present: true, commitmentSha256: sha256(pd.bytes.subarray(13, 45)) } : (() => { throw new Error("decode-programdata-authority"); })();
    out.programUpgrade = { status: "programdata-resolved", loaderOwnerVerified: true, programDataAddressCommitmentSha256: sha256(Buffer.from(programDataId)), deployedSlot: u64le(pd.bytes, 4).toString(), upgradeAuthority: auth, contextSlot: pd.contextSlot };
  } catch (_) { out.programUpgrade = { status: "unresolved-or-strict-decode-rejected" }; out.blockers.push("programdata-or-upgrade-authority-unresolved"); }
  out.observationWindow = { requestedMinContextSlot: slot, minContextSlot: contexts.filter(Number.isFinite).length ? Math.min(...contexts.filter(Number.isFinite)) : null, maxContextSlot: contexts.filter(Number.isFinite).length ? Math.max(...contexts.filter(Number.isFinite)) : null, simultaneityClaimed: false };
  out.blockers.push("config-oft-bascule-pda-and-binding-seeds-not-source-derived", "oft-supply-dedup-and-transit-reconciliation-absent"); return out;
}

function moveType(type) { if (typeof type !== "string") return null; const m = type.match(/<(0x[0-9a-fA-F]+::[A-Za-z0-9_]+::[A-Za-z0-9_]+)>/); return m ? m[1] : null; }
function suiObject(kind, r) { const d = r?.data; return d ? { kind, status: "observed", type: d.type ?? null, version: d.version ?? null, digest: d.digest ?? null, contentSha256: d.content ? canonicalHash(d.content) : null } : { kind, status: "missing-or-unreadable" }; }
function treasurySupply(data, exactType) {
  const c = data?.content; if (c?.dataType !== "moveObject") return null;
  if (data.type === `0x2::coin::TreasuryCap<${exactType}>`) { const v = c?.fields?.total_supply?.fields?.value, supplyType = c?.fields?.total_supply?.type; return typeof v === "string" && /^\d+$/.test(v) && supplyType === `0x2::balance::Supply<${exactType}>` ? v : null; }
  const expectedControlled = `${IDS.sui.coinObject}::treasury::ControlledTreasury<${exactType}>`, cap = c?.fields?.treasury_cap;
  if (data.type !== expectedControlled || cap?.type !== `0x2::coin::TreasuryCap<${exactType}>` || cap?.fields?.total_supply?.type !== `0x2::balance::Supply<${exactType}>`) return null;
  const v = cap?.fields?.total_supply?.fields?.value; return typeof v === "string" && /^\d+$/.test(v) ? v : null;
}
async function suiFallback(method, params) {
  const attempts = [];
  for (const e of ENDPOINTS.sui) { try { const id = await rpc(e, "sui_getChainIdentifier", []); if (id !== SUI_CHAIN) throw new Error("identity"); const value = await rpc(e, method, params); attempts.push({ providerLabel: e.label, status: "success" }); return { value, attempts }; } catch (x) { attempts.push({ providerLabel: e.label, status: x.errorClass || normalizeError(x) }); } }
  return { value: null, attempts };
}
async function scanSui() {
  const selected = await select("sui", async e => { const id = await rpc(e, "sui_getChainIdentifier", []); if (id !== SUI_CHAIN) throw new Error("identity"); const sequence = await rpc(e, "sui_getLatestCheckpointSequenceNumber", []), cp = await rpc(e, "sui_getCheckpoint", [sequence]); return { id, sequence, cp }; });
  const out = { ecosystem: "Sui", providerLabel: selected.endpoint?.label || null, providersTried: selected.tried, failureClasses: selected.failures, identity: { status: selected.endpoint ? "verified-mainnet" : "unverified", expectedChainIdentifier: SUI_CHAIN }, fixedPoint: null, objects: [], exactCoinType: null, metadata: { status: "unreadable" }, supply: { status: "unreadable", raw: null, decimals: null, ui: null }, sourceRepresentation: "official-step6-objects-plus-live-rpc", bridgeDedupStatus: "blocked-bridge-mode-and-transit-not-reconciled", blockers: [] };
  if (!selected.endpoint) { out.blockers.push("sui-mainnet-checkpoint-unresolved"); return out; }
  const cp = selected.value.cp; out.fixedPoint = { checkpoint: String(selected.value.sequence), digest: cp?.digest ?? null, timestampMs: cp?.timestampMs ?? null, timestamp: cp?.timestampMs ? new Date(Number(cp.timestampMs)).toISOString() : null };
  const objectData = {};
  for (const [kind, id] of Object.entries(IDS.sui)) { try { const response = await rpc(selected.endpoint, "sui_getObject", [id, { showType: true, showContent: true }]); objectData[kind] = response?.data || null; out.objects.push(suiObject(kind, response)); } catch (x) { out.objects.push({ kind, status: "unreadable", errorClass: x.errorClass }); } }
  const coin = out.objects.find(x => x.kind === "coinObject"), control = out.objects.find(x => x.kind === "controlTreasury"), candidates = [moveType(coin?.type), moveType(control?.type)].filter(Boolean), officialPrefixes = [`${IDS.sui.coinObject.toLowerCase()}::`, `${IDS.sui.package.toLowerCase()}::`];
  const exact = candidates.find(x => officialPrefixes.some(prefix => x.toLowerCase().startsWith(prefix))) || null; out.exactCoinType = exact; out.typeResolution = exact ? { status: "official-object-type-and-package-prefix-verified", sourceObject: moveType(coin?.type) === exact ? "coinObject" : "controlTreasury", packagePrefixVerified: true, acceptedOfficialPackageIds: [IDS.sui.coinObject, IDS.sui.package] } : { status: "unresolved-or-package-prefix-mismatch", packagePrefixVerified: false };
  if (exact) {
    const md = await suiFallback("suix_getCoinMetadata", [exact]); out.metadataAttempts = md.attempts; out.metadata = md.value ? { status: "observed", decimals: Number.isInteger(md.value.decimals) ? md.value.decimals : null, contentSha256: canonicalHash(md.value) } : { status: "unavailable" };
    const ts = await suiFallback("suix_getTotalSupply", [exact]); out.totalSupplyAttempts = ts.attempts;
    if (ts.value && typeof ts.value.value === "string" && /^\d+$/.test(ts.value.value)) out.supply = { status: "observed-legacy-unpinned", raw: ts.value.value, decimals: out.metadata.decimals, ui: null, source: "suix_getTotalSupply" };
    else { const cap = [objectData.coinObject, objectData.controlTreasury].map(x => treasurySupply(x, exact)).find(x => x !== null); out.supply = cap !== undefined ? { status: "observed-exact-treasurycap-schema-unpinned", raw: cap, decimals: out.metadata.decimals, ui: null, source: "type-validated-treasury-cap-content" } : { status: "unavailable-no-exact-supply-schema", raw: null, decimals: out.metadata.decimals, ui: null }; }
  } else out.blockers.push("official-package-prefixed-coin-type-unresolved");
  out.observationWindow = { checkpointAnchor: String(selected.value.sequence), legacyObjectAndCoinCallsCheckpointPinned: false, simultaneityClaimed: false };
  if (!out.supply.raw) out.blockers.push("sui-total-supply-unresolved"); out.blockers.push("sui-legacy-reads-not-checkpoint-pinned", "sui-bridge-dedup-and-transit-reconciliation-absent"); return out;
}

const MASK64 = (1n << 64n) - 1n, ROT = [[0,36,3,41,18],[1,44,10,45,2],[62,6,43,15,61],[28,55,25,21,56],[27,20,39,8,14]], RC = [1n,0x8082n,0x800000000000808an,0x8000000080008000n,0x808bn,0x80000001n,0x8000000080008081n,0x8000000000008009n,0x8an,0x88n,0x80008009n,0x8000000an,0x8000808bn,0x800000000000008bn,0x8000000000008089n,0x8000000000008003n,0x8000000000008002n,0x8000000000000080n,0x800an,0x800000008000000an,0x8000000080008081n,0x8000000000008080n,0x80000001n,0x8000000080008008n];
function rol(x,n){n=BigInt(n);return n?((x<<n)|(x>>(64n-n)))&MASK64:x;} function keccak(data){const bytes=[...Buffer.from(data)],rate=136;bytes.push(1);while(bytes.length%rate!==rate-1)bytes.push(0);bytes.push(128);const a=Array(25).fill(0n);for(let o=0;o<bytes.length;o+=rate){for(let i=0;i<rate;i++)a[i>>3]^=BigInt(bytes[o+i])<<BigInt((i&7)*8);for(const rc of RC){const c=Array(5),d=Array(5),b=Array(25);for(let x=0;x<5;x++)c[x]=a[x]^a[x+5]^a[x+10]^a[x+15]^a[x+20];for(let x=0;x<5;x++)d[x]=c[(x+4)%5]^rol(c[(x+1)%5],1);for(let i=0;i<25;i++)a[i]^=d[i%5];for(let x=0;x<5;x++)for(let y=0;y<5;y++)b[((2*x+3*y)%5)*5+y]=rol(a[x+5*y],ROT[x][y]);for(let x=0;x<5;x++)for(let y=0;y<5;y++)a[x+5*y]=b[x+5*y]^((~b[(x+1)%5+5*y])&b[(x+2)%5+5*y]);a[0]^=rc;}}const out=Buffer.alloc(32);for(let i=0;i<32;i++)out[i]=Number((a[i>>3]>>BigInt((i&7)*8))&255n);return out;}
function selector(name) { return "0x" + (BigInt("0x" + keccak(name).toString("hex")) & ((1n << 250n) - 1n)).toString(16); }
function parsedAbi(raw) { if (Array.isArray(raw)) return { abi: raw, representation: "array" }; if (typeof raw === "string" && Buffer.byteLength(raw) <= MAX_ABI_BYTES) { const p = JSON.parse(raw); if (Array.isArray(p)) return { abi: p, representation: "bounded-json-string" }; } throw new Error("schema-abi"); }
function deepItems(items, out = []) { if (!Array.isArray(items)) return out; for (const x of items) { if (!x || typeof x !== "object") continue; out.push(x); if (Array.isArray(x.items)) deepItems(x.items, out); } return out; }
function exactFn(abi, name, outputTypes) { const found = deepItems(abi).filter(x => x.type === "function" && x.name === name); if (found.length !== 1) return null; const f = found[0]; if (!Array.isArray(f.inputs) || f.inputs.length || !Array.isArray(f.outputs) || f.outputs.length !== 1 || !outputTypes.includes(f.outputs[0]?.type)) return null; return f; }
async function scanStarknet() {
  const selected = await select("starknet", async e => { const id = await rpc(e, "starknet_chainId", []); if (id !== STARK_CHAIN) throw new Error("identity"); const n = await rpc(e, "starknet_blockNumber", []), b = await rpc(e, "starknet_getBlockWithTxHashes", [{ block_number: n }]); if (!b?.block_hash) throw new Error("schema-block"); return { id, b }; });
  const out = { ecosystem: "Starknet", providerLabel: selected.endpoint?.label || null, providersTried: selected.tried, failureClasses: selected.failures, identity: { status: selected.endpoint ? "verified-SN_MAIN" : "unverified", expectedChainId: STARK_CHAIN }, fixedPoint: null, class: { status: "unreadable" }, proxy: { status: "unresolved" }, supply: { status: "unreadable", raw: null, decimals: null, ui: null }, sourceRepresentation: "official-step6-token-plus-live-class-abi", bridgeDedupStatus: "blocked-bridge-mode-and-transit-not-reconciled", blockers: [] };
  if (!selected.endpoint) { out.blockers.push("starknet-mainnet-fixed-block-unresolved"); return out; }
  const e = selected.endpoint, b = selected.value.b, blockId = { block_hash: b.block_hash }; out.fixedPoint = { blockNumber: b.block_number, blockHash: b.block_hash, timestampSeconds: b.timestamp, timestamp: Number.isInteger(b.timestamp) ? new Date(b.timestamp * 1000).toISOString() : null };
  try {
    const classHash = await rpc(e, "starknet_getClassHashAt", [blockId, IDS.starknet.token]), klass = await rpc(e, "starknet_getClass", [blockId, classHash]), parsed = parsedAbi(klass?.abi); out.class = { status: "verified-at-fixed-block", classHash, classDefinitionSha256: canonicalHash(klass), abiRepresentation: parsed.representation };
    const proxyNames = new Set(["implementation", "get_implementation", "implementation_hash", "get_implementation_hash"]), proxyFns = deepItems(parsed.abi).filter(x => x.type === "function" && proxyNames.has(x.name));
    out.proxy = proxyFns.length ? { status: "unresolved-abi-indicator-without-confirmed-proxy-mechanism", abiIndicators: proxyFns.map(x => x.name).sort() } : { status: "no-supported-abi-proxy-indicator-direct-class-used" };
    if (proxyFns.length) { out.blockers.push("proxy-indicated-but-source-or-abi-confirmed-resolution-mechanism-absent"); return out; }
    const decimalsFn = exactFn(parsed.abi, "decimals", ["core::integer::u8", "u8", "core::felt252", "felt252"]), supplyFn = exactFn(parsed.abi, "total_supply", ["core::integer::u256", "u256"]);
    if (!decimalsFn || !supplyFn) { out.blockers.push("exact-zero-input-decimals-or-total-supply-abi-schema-missing"); return out; }
    const decimalsResult = await rpc(e, "starknet_call", [{ contract_address: IDS.starknet.token, entry_point_selector: selector("decimals"), calldata: [] }, blockId]), supplyResult = await rpc(e, "starknet_call", [{ contract_address: IDS.starknet.token, entry_point_selector: selector("total_supply"), calldata: [] }, blockId]);
    if (!Array.isArray(decimalsResult) || decimalsResult.length !== 1 || !Array.isArray(supplyResult) || supplyResult.length !== 2) throw new Error("schema-call");
    const decimals = BigInt(decimalsResult[0]), low = BigInt(supplyResult[0]), high = BigInt(supplyResult[1]); if (decimals < 0n || decimals > 255n || low >= (1n << 128n) || high >= (1n << 128n)) throw new Error("schema-range");
    out.supply = { status: "observed-schema-verified-fixed-block", raw: (low + (high << 128n)).toString(), decimals: Number(decimals), ui: null, decimalsSchema: decimalsFn.outputs[0].type, totalSupplySchema: supplyFn.outputs[0].type };
  } catch (x) { out.blockers.push(`starknet-class-abi-or-call:${x.errorClass || normalizeError(x)}`); }
  out.blockers.push("starknet-bridge-dedup-and-transit-reconciliation-absent"); return out;
}

function anchorWindow(results) { const points = results.map(x => ({ ecosystem: x.ecosystem, timestamp: x.fixedPoint?.timestamp, ms: Date.parse(x.fixedPoint?.timestamp || "") })).filter(x => Number.isFinite(x.ms)); if (!points.length) return { count: 0, minimum: null, maximum: null, skewMilliseconds: null, simultaneityClaimed: false }; const min = Math.min(...points.map(x => x.ms)), max = Math.max(...points.map(x => x.ms)); return { count: points.length, minimum: new Date(min).toISOString(), maximum: new Date(max).toISOString(), skewMilliseconds: max - min, points: points.map(({ ecosystem, timestamp }) => ({ ecosystem, timestamp })), simultaneityClaimed: false }; }
function metricsFor(results) { return { identitiesBound: results.filter(x => x.identity.status.startsWith("verified")).length, accountsObjectsClassesVerified: (results[0].accounts?.filter(x => x.status === "observed").length || 0) + (results[1].objects?.filter(x => x.status === "observed").length || 0) + (results[2].class.status === "verified-at-fixed-block" ? 1 : 0), supplyRowsObserved: results.filter(x => x.supply.raw !== null).length, solanaAuthorityStatus: results[0].mint?.status || "unresolved", solanaUpgradeStatus: results[0].programUpgrade?.status || "unresolved", suiTypeStatus: results[1].typeResolution?.status || "unresolved", starknetClassStatus: results[2].class.status, bridgeDedupVerifiedRows: 0, fullyReconciledLiabilityRows: 0 }; }
function renderReport(raw) { const lines = ["# Lombard LBTC Step 13 — Non-EVM Resolution", "", `**Classification:** ${raw.classification}`, "", "> Hardcoded public read-only fallbacks only. Generic labels are retained; no endpoint URLs/domains, raw responses/errors, private inventories, environment files, secrets, authority keys, transactions, signing, wallets, forks, deployments, or mutations are persisted.", "", `Requests/successes/failures=${raw.network.requests}/${raw.network.successes}/${raw.network.failures}; identities=${raw.metrics.identitiesBound}/3; verified accounts/objects/classes=${raw.metrics.accountsObjectsClassesVerified}; supplies=${raw.metrics.supplyRowsObserved}/3; fully reconciled liabilities=0.`, ""]; for (const x of raw.results) lines.push(`## ${x.ecosystem}`, `- Identity=${x.identity.status}; fixed point=${x.ecosystem === "Solana" ? `slot ${x.fixedPoint?.slot ?? "unknown"}` : x.ecosystem === "Sui" ? `checkpoint ${x.fixedPoint?.checkpoint ?? "unknown"}` : `block ${x.fixedPoint?.blockNumber ?? "unknown"}`}; timestamp=${x.fixedPoint?.timestamp ?? "unknown"}.`, `- Supply=${x.supply.status}; raw=${x.supply.raw ?? "null"}; decimals=${x.supply.decimals ?? "unknown"}; UI=${x.supply.ui ?? "unknown"}.`, `- Source representation=${x.sourceRepresentation}; bridge/dedup=${x.bridgeDedupStatus}.`, ...x.blockers.map(b => `- Blocker: ${b}`), ""); lines.push("## Anchor window", `- ${raw.anchorWindow.count} timestamps; minimum=${raw.anchorWindow.minimum}; maximum=${raw.anchorWindow.maximum}; skew=${raw.anchorWindow.skewMilliseconds} ms. This is an observation window, not a simultaneity claim.`, "", "No exploit, insolvency, or permissionless invariant violation is proven. No supply aggregation or reconciliation promotion was performed.", "", "## Closed gates", "`routePositive=0`, `routeEvidenceStatus=unknown`, `evidenceComplete=false`, `closureEligible=false`, `executableNow=0`, `signedActionJustified=false`, `forkJustified=false`.", ""); return lines.join("\n"); }
function renderHandoff(raw) { return ["# Coordinator Handoff — Lombard LBTC Step 13 — 2026-07-12", "", `- Classification: **${raw.classification}**`, ...raw.results.map(x => `- ${x.ecosystem}: identity=${x.identity.status}; fixed=${(x.ecosystem === "Solana" ? x.fixedPoint?.slot : x.ecosystem === "Sui" ? x.fixedPoint?.checkpoint : x.fixedPoint?.blockNumber) ?? "null"}; supply=${x.supply.status}/${x.supply.raw ?? "null"}; decimals=${x.supply.decimals ?? "unknown"}; bridge/dedup=${x.bridgeDedupStatus}.`), `- Supplies observed=${raw.metrics.supplyRowsObserved}/3; fullyReconciledLiabilityRows=0; anchor skew=${raw.anchorWindow.skewMilliseconds} ms with no simultaneity claim.`, "", "## Step 14", "Close EVM supply, proxy/runtime, bridge-mode, escrow/burn/transit, and deduplication gaps at reproducible fixed blocks. Do not aggregate until all identity and mode joins reconcile.", "", "## Closed gates", "`routePositive=0`, `routeEvidenceStatus=unknown`, `evidenceComplete=false`, `closureEligible=false`, `executableNow=0`, `signedActionJustified=false`, `forkJustified=false`.", ""].join("\n"); }
function atomic(rel, text) { const target = path.join(ROOT, rel), tmp = `${target}.tmp-${process.pid}`; fs.writeFileSync(tmp, text, "utf8"); fs.renameSync(tmp, target); }

async function run() {
  const results = [await scanSolana(), await scanSui(), await scanStarknet()], metrics = metricsFor(results), window = anchorWindow(results), blockers = [...new Set(results.flatMap(x => x.blockers.map(b => `${x.ecosystem}: ${b}`)).concat(["cross-chain-bridge-mode-escrow-burn-transit-and-dedup-reconciliation-absent", "bitcoin-backing-and-liability-join-absent"]))].sort();
  const raw = { generatedAt: new Date().toISOString(), scanner: "tools/scan-lombard-lbtc-nonevm-resolution.js", classification: CLASSIFICATION, officialTargets: IDS, limits: { responseSizeCapBytes: MAX_BYTES, abiJsonStringCapBytes: MAX_ABI_BYTES, timeoutMs: TIMEOUT_MS, wallTimeoutMs: WALL_MS, requestCeiling: MAX_REQUESTS, retryMaximum: 1, streamingReads: true, atomicWrites: true }, network, results, anchorWindow: window, metrics, blockers, assertions: { exactOfficialIdentifiersUsed: true, identityRequiredForPromotion: true, solanaMintLayoutStrict: true, authorityKeysPersisted: false, suiOfficialPackagePrefixRequired: true, suiLegacyCallsCheckpointPinned: false, starknetAbiRequiredBeforeSelectorAndCall: true, noSupplyDoubleCounting: true, noSimultaneityClaim: true, noAggregatePromotion: true, noExploitClaim: true, noInsolvencyClaim: true }, conclusion: { exploitProven: false, insolvencyProven: false, permissionlessInvariantViolationProven: false, aggregatePromotion: false, fullyReconciledLiabilityRows: 0 }, gates: { routePositive: 0, routeEvidenceStatus: "unknown", evidenceComplete: false, closureEligible: false, executableNow: 0, signedActionJustified: false, forkJustified: false }, safety: { privateInventoryRead: false, envRead: false, secretsRead: false, mutation: false, transactions: false, signing: false, wallets: false, forks: false, deployments: false } };
  const rawText = serialize(raw), report = renderReport(raw), handoff = renderHandoff(raw), outputs = [["raw", rawText], ["report", report], ["handoff", handoff]], urls = Object.values(ENDPOINTS).flat().map(x => x.url), forbidden = [...urls, ...urls.map(x => new URL(x).hostname), "publicnode", "blastapi", "blockvision", "rawError", "responseBody", "requestHeaders"];
  for (const [name, text] of outputs) if (forbidden.some(x => text.toLowerCase().includes(x.toLowerCase()))) throw new Error(`${name}-output-leak`);
  if (raw.metrics.fullyReconciledLiabilityRows !== 0 || raw.conclusion.aggregatePromotion || raw.anchorWindow.simultaneityClaimed) throw new Error("gate-self-check");
  if (raw.results[0].mint?.mintAuthority?.publicKey || raw.results[0].mint?.freezeAuthority?.publicKey || raw.results[0].programUpgrade?.upgradeAuthority?.publicKey) throw new Error("authority-leak-check");
  atomic(RAW_REL, rawText); atomic(REPORT_REL, report); atomic(HANDOFF_REL, handoff);
  const per = results.map(x => `${x.ecosystem}{identity=${x.identity.status},fixed=${x.ecosystem === "Solana" ? x.fixedPoint?.slot ?? "null" : x.ecosystem === "Sui" ? x.fixedPoint?.checkpoint ?? "null" : x.fixedPoint?.blockNumber ?? "null"},supply=${x.supply.status}:${x.supply.raw ?? "null"},decimals=${x.supply.decimals ?? "null"},source=${x.sourceRepresentation},bridgeDedup=${x.bridgeDedupStatus},blockers=${x.blockers.length}}`).join(" ");
  process.stdout.write(`rawSha256=${sha256(rawText)} reportSha256=${sha256(report)} handoffSha256=${sha256(handoff)} scannerSha256=${sha256(fs.readFileSync(__filename))} ${per} identities=${metrics.identitiesBound} verifiedRepresentations=${metrics.accountsObjectsClassesVerified} supplies=${metrics.supplyRowsObserved} anchorSkewMs=${window.skewMilliseconds ?? "null"} fullyReconciledLiabilityRows=0 blockers=${blockers.length} assertions=passed leakCheck=passed\n`);
}
run().catch(e => { const safe = /^(?:raw|report|handoff)-output-leak$|^(?:gate-self-check|authority-leak-check)$/.test(e?.message || "") ? e.message : normalizeError(e); process.stderr.write(`scan-lombard-lbtc-nonevm-resolution failed: ${safe}\n`); process.exitCode = 1; });
