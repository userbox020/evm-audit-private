#!/usr/bin/env node
"use strict";

// Maverick V2 Gate2: bounded public-source/runtime recovery. RPC inventory
// material remains process-only; only public chain/source evidence is emitted.
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Interface, encodeBase58, getAddress, keccak256 } = require("ethers");

const ROOT = path.resolve(__dirname, "..");
const NS = path.join(ROOT, "reports", "raw", "fast", "prefilter-maverick-v2-base-pools");
const OUT = path.join(NS, "gate2");
const CAPTURE = path.join(OUT, "capture.json");
const CHECKPOINT = path.join(OUT, "checkpoint.json");
const GROUPS = path.join(OUT, "runtime-groups.json");
const CREATION = path.join(OUT, "creation-evidence.json");
const SEARCH = path.join(OUT, "source-search.json");
const METADATA = path.join(OUT, "metadata-recovery.json");
const MANIFEST = path.join(OUT, "manifest.json");
const REPORT = path.join(ROOT, "reports", "prefilter-maverick-v2-base-pools-gate2.md");
const TOOL = path.join(ROOT, "tools", "prefilter-maverick-v2-base-pools-gate2.js");
const PRIOR = path.join(NS, "capture.json");
const INVENTORIES = ["rpc_endpoints.txt", "base_full_stack_endpoints.md"];
const FACTORY_ADDRESS = "0x0A7e848Aca42d879EF06507Fca0E7b33A0a63c1e";
const SELECTED_POOL = "0x5Fb33b095c6e739BE19364Ab408CD8f102262bB6";
const BASE = 8453, ETHEREUM = 1;
const LIMITS = Object.freeze({ candidates: 64, sourceAddresses: 36, baseSample: 64, ethereumSample: 24,
  requestCount: 1_200, responseBytes: 32 * 1024 * 1024, sourceBytes: 16 * 1024 * 1024,
  timeoutMs: 18_000, traceBytes: 48 * 1024 * 1024, creationReceipts: 400 });

const factoryAbi = JSON.parse(fs.readFileSync(path.join(ROOT, "targets", "maverick-v2-interfaces-f9f4f3e", "abis", "MaverickV2Factory.json"), "utf8"));
const FACTORY = new Interface(factoryAbi);
let rpcId = 1, requestCount = 0;

const canonical = (value) => value === null || typeof value !== "object" ? typeof value === "bigint" ? value.toString() : value
  : Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
const json = (value) => `${JSON.stringify(canonical(value), null, 2)}\n`;
const sha256 = (bytes) => `0x${crypto.createHash("sha256").update(bytes).digest("hex")}`;
const hex = (value) => `0x${BigInt(value).toString(16)}`;
const bytesOf = (value) => Buffer.from(String(value || "").replace(/^0x/, ""), "hex");
const bytecode = (value) => { const raw = String(value || ""); if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(raw)) fail("BYTECODE_MALFORMED"); return raw.toLowerCase(); };
const summary = (value) => { const normalized = bytecode(value), bytes = bytesOf(normalized); return { bytes: bytes.length, keccak256: keccak256(normalized), sha256: sha256(bytes) }; };
function fail(code) { const error = new Error(code); error.safeCode = code; throw error; }
function addr(value) { try { return getAddress(value); } catch { fail("ADDRESS_MALFORMED"); } }
function rel(file) { return path.relative(ROOT, file).replace(/\\/g, "/"); }
function safePath(value) {
  const normalized = String(value).replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || /^[a-z]:/i.test(normalized) || normalized.split("/").includes("..")) fail("SOURCE_PATH_UNSAFE");
  return normalized;
}
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); }
function writeJson(file, value) { write(file, json(value)); }

function inventory() {
  const rpcRows = [], explorerRows = [], secretValues = new Set();
  for (const name of INVENTORIES) {
    const full = path.join(ROOT, name), text = fs.readFileSync(full, "utf8"), lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const context = lines.slice(Math.max(0, index - 3), Math.min(lines.length, index + 4)).join("\n");
      for (const match of lines[index].matchAll(/https?:\/\/[^\s'"<>\[\]`]+/gi)) {
        const url = match[0].replace(/[),.;\]]+$/g, ""); let parsed; try { parsed = new URL(url); } catch { continue; }
        const headers = { accept: "application/json", "content-type": "application/json" };
        const origin = context.match(/\[origin:\s*([^\]\s]+)\]/i)?.[1]; if (origin) headers.origin = origin;
        for (const row of context.matchAll(/\[header:\s*([^=\]\s]+)=([^\]]+)\]/gi)) headers[row[1].trim()] = row[2].trim();
        secretValues.add(url); secretValues.add(parsed.hostname); for (const value of Object.values(headers)) if (value.length >= 6) secretValues.add(value);
        if (/etherscan|basescan/i.test(parsed.hostname)) explorerRows.push({ url, headers, file: name });
        else if (parsed.protocol === "https:") rpcRows.push({ url, headers, family: parsed.hostname.split(".").slice(-2).join("."), file: name });
      }
    }
  }
  const unique = (rows) => { const seen = new Set(); return rows.filter((row) => { if (seen.has(row.url)) return false; seen.add(row.url); return true; }); };
  return { rpcRows: unique(rpcRows).slice(0, LIMITS.candidates), explorerRows: unique(explorerRows).slice(0, 12), secretValues };
}
async function fetchBounded(url, options = {}, cap = LIMITS.responseBytes, timeout = LIMITS.timeoutMs) {
  if (++requestCount > LIMITS.requestCount) fail("REQUEST_BUDGET");
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, redirect: "follow", signal: controller.signal });
    const declared = Number(response.headers.get("content-length") || 0); if (declared > cap) fail("RESPONSE_CAP");
    const chunks = []; let total = 0; const reader = response.body?.getReader();
    if (reader) while (true) { const { done, value } = await reader.read(); if (done) break; total += value.length; if (total > cap) { await reader.cancel(); fail("RESPONSE_CAP"); } chunks.push(Buffer.from(value)); }
    return { ok: response.ok, status: response.status, bytes: Buffer.concat(chunks), contentType: response.headers.get("content-type") || "" };
  } catch (error) { if (error.safeCode) throw error; return { ok: false, status: 0, bytes: Buffer.alloc(0), category: error?.name === "AbortError" ? "timeout" : "transport" }; }
  finally { clearTimeout(timer); }
}
async function rpc(row, method, params = [], cap = LIMITS.responseBytes, timeout = LIMITS.timeoutMs) {
  const response = await fetchBounded(row.url, { method: "POST", headers: row.headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }) }, cap, timeout);
  if (!response.ok) return { ok: false, category: response.category || `http-${response.status}` };
  let body; try { body = JSON.parse(response.bytes.toString("utf8")); } catch { return { ok: false, category: "non-json" }; }
  return body && !body.error && Object.hasOwn(body, "result") ? { ok: true, result: body.result } : { ok: false, category: body?.error ? "rpc-error" : "schema" };
}
async function rpcBatch(row, calls, timeout = LIMITS.timeoutMs) {
  const requests = calls.map(([method, params]) => ({ jsonrpc: "2.0", id: rpcId++, method, params }));
  const response = await fetchBounded(row.url, { method: "POST", headers: row.headers, body: JSON.stringify(requests) }, LIMITS.responseBytes, timeout);
  if (!response.ok) return calls.map(() => ({ ok: false, category: response.category || `http-${response.status}` }));
  let body; try { body = JSON.parse(response.bytes.toString("utf8")); } catch { return calls.map(() => ({ ok: false, category: "non-json" })); }
  if (!Array.isArray(body)) return calls.map(() => ({ ok: false, category: "schema" }));
  const map = new Map(body.map((row) => [row.id, row]));
  return requests.map((request) => { const row = map.get(request.id); return row && !row.error && Object.hasOwn(row, "result") ? { ok: true, result: row.result } : { ok: false, category: row?.error ? "rpc-error" : "schema" }; });
}
async function parallel(items, limit, fn) {
  const out = new Array(items.length); let cursor = 0;
  async function worker() { while (true) { const index = cursor++; if (index >= items.length) return; try { out[index] = await fn(items[index], index); } catch { out[index] = null; } } }
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, worker)); return out;
}
async function qualify(rows, chainId) {
  const results = (await parallel(rows, 8, async (row) => {
    const chain = await rpc(row, "eth_chainId"); if (!chain.ok || Number(BigInt(chain.result)) !== chainId) return null;
    const finalized = await rpc(row, "eth_getBlockByNumber", ["finalized", false]); if (!finalized.ok || !finalized.result?.hash) return null;
    const code = await rpc(row, "eth_getCode", [FACTORY_ADDRESS, finalized.result.number]); if (!code.ok || code.result === "0x") return null;
    const call = await rpc(row, "eth_call", [{ to: FACTORY_ADDRESS, data: FACTORY.encodeFunctionData("poolCount", []) }, finalized.result.number]);
    if (!call.ok) return null; return { row, finalized: finalized.result, factoryCode: code.result };
  })).filter(Boolean);
  if (!results.length) fail(chainId === BASE ? "BASE_PROVIDER_UNAVAILABLE" : "ETHEREUM_PROVIDER_UNAVAILABLE");
  const first = results[0]; return { primary: first.row, alternatives: results.slice(1).map((item) => item.row), pin: first.finalized,
    summary: { chainId, qualifiedProviders: results.length, independentFamilies: new Set(results.map((item) => item.row.family)).size,
      finalizedNumber: Number(BigInt(first.finalized.number)), finalizedHash: first.finalized.hash } };
}
async function call(provider, contract, iface, name, args, block) {
  const result = await rpc(provider, "eth_call", [{ to: contract, data: iface.encodeFunctionData(name, args) }, block]);
  if (!result.ok) return { ok: false };
  try { return { ok: true, value: iface.decodeFunctionResult(name, result.result) }; } catch { return { ok: false }; }
}
async function creationBoundary(provider, contract, pin) {
  let low = 0n, high = BigInt(pin);
  while (low < high) { const mid = (low + high) >> 1n, result = await rpc(provider, "eth_getCode", [contract, hex(mid)]); if (!result.ok) fail("HISTORICAL_CODE_UNAVAILABLE"); if (result.result === "0x") low = mid + 1n; else high = mid; }
  return low;
}
async function factoryPools(provider, block, max) {
  const counts = {};
  for (const [key, fn] of [["permissionless", "poolCount"], ["permissioned", "poolPermissionedCount"]]) {
    const result = await call(provider, FACTORY_ADDRESS, FACTORY, fn, [], block); counts[key] = result.ok ? Number(result.value[0]) : null;
  }
  const pools = [];
  for (const [fn, count] of [["lookup(uint256,uint256)", counts.permissionless], ["lookupPermissioned(uint256,uint256)", counts.permissioned]]) {
    if (!Number.isSafeInteger(count) || count <= 0) continue;
    const indexes = [...new Set([0, Math.max(0, Math.floor(count / 4)), Math.max(0, Math.floor(count / 2)), Math.max(0, Math.floor(3 * count / 4)), Math.max(0, count - 8)])];
    for (const start of indexes) { const end = Math.min(count, start + Math.max(1, Math.min(8, max - pools.length))); if (end <= start || pools.length >= max) break;
      const result = await call(provider, FACTORY_ADDRESS, FACTORY, fn, [start, end], block); if (result.ok) for (const pool of result.value[0]) pools.push(addr(pool)); }
  }
  return { counts, pools: [...new Set(pools)].slice(0, max) };
}

function metadataTail(runtime) {
  const bytes = bytesOf(bytecode(runtime)); if (bytes.length < 4) return { present: false };
  const length = bytes.readUInt16BE(bytes.length - 2); if (length + 2 > bytes.length) return { present: false, malformed: true };
  const cbor = bytes.subarray(bytes.length - 2 - length, bytes.length - 2); let multihash = null, solc = null;
  for (let index = 0; index + 34 <= cbor.length; index++) if (cbor[index] === 0x12 && cbor[index + 1] === 0x20) { multihash = cbor.subarray(index, index + 34); break; }
  for (let index = 0; index + 8 <= cbor.length; index++) if (cbor.subarray(index, index + 4).toString() === "solc" && cbor[index + 4] === 0x43) { solc = `${cbor[index + 5]}.${cbor[index + 6]}.${cbor[index + 7]}`; break; }
  return { present: true, offset: bytes.length - length - 2, bytes: length, cborHex: `0x${cbor.toString("hex")}`, cborSha256: sha256(cbor),
    ipfsCid: multihash ? encodeBase58(multihash) : null, compiler: solc, lengthSuffix: `0x${bytes.subarray(-2).toString("hex")}` };
}
function regions(positions) {
  const sorted = [...new Set(positions)].sort((a, b) => a - b), out = [];
  for (const position of sorted) { const last = out.at(-1); if (!last || position !== last.start + last.length) out.push({ start: position, length: 1 }); else last.length++; }
  return out;
}
function runtimeGroups(rows) {
  const exact = new Map(), lengths = new Map();
  for (const row of rows) { const key = `${row.runtime.bytes}:${row.runtime.keccak256}`; if (!exact.has(key)) exact.set(key, []); exact.get(key).push(row.address);
    if (!lengths.has(row.runtime.bytes)) lengths.set(row.runtime.bytes, []); lengths.get(row.runtime.bytes).push(row); }
  const lengthFamilies = [];
  for (const [length, family] of lengths) {
    const buffers = family.map((row) => bytesOf(row.code)), differing = [];
    for (let index = 0; index < length; index++) if (new Set(buffers.map((buffer) => buffer[index])).size > 1) differing.push(index);
    lengthFamilies.push({ runtimeBytes: length, sampleCount: family.length, exactHashCount: new Set(family.map((row) => row.runtime.keccak256)).size,
      differingByteCount: differing.length, differingRegions: regions(differing), metadata: [...new Map(family.map((row) => [row.metadata.ipfsCid || row.metadata.cborSha256 || "none", row.metadata])).values()] });
  }
  return { exactGroups: [...exact.entries()].map(([key, addresses]) => ({ key, sampleCount: addresses.length, addresses })), lengthFamilies };
}
function push32Constants(code) {
  const bytes = bytesOf(code), rows = [];
  for (let pc = 0; pc < bytes.length;) {
    const opcode = bytes[pc], width = opcode >= 0x60 && opcode <= 0x7f ? opcode - 0x5f : 0;
    if (opcode === 0x7f && pc + 32 < bytes.length) rows.push({ pc, value: `0x${bytes.subarray(pc + 1, pc + 33).toString("hex")}` });
    pc += 1 + width;
  }
  return rows;
}
async function sampleRuntime(provider, addresses, block) {
  const calls = addresses.map((address) => ["eth_getCode", [address, block]]), results = await rpcBatch(provider, calls, 25_000), rows = [];
  for (let index = 0; index < addresses.length; index++) if (results[index]?.ok && results[index].result !== "0x") {
    const code = bytecode(results[index].result); rows.push({ address: addresses[index], code, runtime: summary(code), metadata: metadataTail(code) });
  }
  return rows;
}

async function transactionEvidence(provider, hash) {
  const [tx, receipt] = await Promise.all([rpc(provider, "eth_getTransactionByHash", [hash]), rpc(provider, "eth_getTransactionReceipt", [hash])]);
  if (!tx.ok || !receipt.ok) return { transactionHash: hash, available: false };
  const row = tx.result, rec = receipt.result;
  return { available: true, transactionHash: hash, blockNumber: Number(BigInt(row.blockNumber)), blockHash: row.blockHash, from: addr(row.from), to: row.to ? addr(row.to) : null,
    nonce: Number(BigInt(row.nonce)), type: row.type, input: row.input, inputSummary: row.input && row.input !== "0x" ? summary(row.input) : { bytes: 0 },
    receipt: { status: Number(BigInt(rec.status)), contractAddress: rec.contractAddress ? addr(rec.contractAddress) : null, gasUsed: BigInt(rec.gasUsed).toString(), logCount: rec.logs?.length ?? null } };
}
async function findCreationTransaction(provider, creationBlock, contract) {
  let receipts = await rpc(provider, "eth_getBlockReceipts", [hex(creationBlock)], LIMITS.responseBytes, 25_000);
  if (!receipts.ok || !Array.isArray(receipts.result)) {
    const block = await rpc(provider, "eth_getBlockByNumber", [hex(creationBlock), false]); if (!block.ok) return null;
    const hashes = (block.result.transactions || []).slice(0, LIMITS.creationReceipts), results = await rpcBatch(provider, hashes.map((hash) => ["eth_getTransactionReceipt", [hash]]), 30_000);
    receipts = { ok: true, result: results.filter((row) => row.ok).map((row) => row.result) };
  }
  const found = receipts.result.find((receipt) => receipt?.contractAddress?.toLowerCase() === contract.toLowerCase());
  return found ? transactionEvidence(provider, found.transactionHash) : null;
}
async function explorerCreationHash(chainId, contract) {
  const host = chainId === BASE ? "basescan.org" : "etherscan.io", response = await publicGet(`https://${host}/address/${contract}`, LIMITS.sourceBytes);
  if (!response.ok) return null; const text = response.bytes.toString("utf8"), index = text.indexOf("Contract Creator");
  if (index < 0) return null; const hash = text.slice(index, index + 8_000).match(/0x[0-9a-fA-F]{64}/)?.[0]; return hash || null;
}
function findCreateTrace(node, target) {
  if (!node || typeof node !== "object") return null;
  if (/^CREATE2?$/.test(String(node.type || "").toUpperCase()) && node.to?.toLowerCase() === target.toLowerCase() && /^0x[0-9a-f]*$/i.test(node.input || "")) return node;
  for (const child of node.calls || []) { const found = findCreateTrace(child, target); if (found) return found; }
  return null;
}
async function traceInitCode(providers, txHash, target) {
  for (const provider of providers) {
    const trace = await rpc(provider, "debug_traceTransaction", [txHash, { tracer: "callTracer", tracerConfig: { withLog: false }, timeout: "15s" }], LIMITS.traceBytes, 35_000);
    if (!trace.ok) continue; const found = findCreateTrace(trace.result, target); if (found) return { available: true, type: found.type, from: found.from ? addr(found.from) : null,
      to: found.to ? addr(found.to) : target, input: found.input, inputSummary: summary(found.input), outputSummary: found.output ? summary(found.output) : null };
  }
  return { available: false, category: "qualified-provider-trace-unavailable-or-create-frame-absent" };
}

async function publicGet(url, cap = LIMITS.sourceBytes) { return fetchBounded(url, { headers: { accept: "application/json,text/html", "user-agent": "maverick-gate2-source-recovery" } }, cap, 25_000); }
async function explorerProbe(chainId, address, explorerRows) {
  const host = chainId === BASE ? "basescan.org" : "etherscan.io", outputs = [];
  const page = await publicGet(`https://${host}/address/${address}#code`, LIMITS.sourceBytes), text = page.bytes.toString("utf8");
  outputs.push({ authority: host, transport: "public-html", status: page.status, bytes: page.bytes.length, responseSha256: page.ok ? sha256(page.bytes) : null,
    verifiedMarker: /Contract Source Code Verified|js-sourcecopyarea|verifiedbytecode2/i.test(text), similarMarker: /Similar Match|Similar Contracts/i.test(text),
    compilerMarker: text.match(/v0\.\d+\.\d+\+commit\.[0-9a-f]+/i)?.[0] || null });
  const sourcify = await publicGet(`https://sourcify.dev/server/v2/contract/${chainId}/${address}?fields=all`);
  let bundle = null; if (sourcify.ok) try { bundle = JSON.parse(sourcify.bytes.toString("utf8")); } catch {}
  outputs.push({ authority: "Sourcify", transport: "v2-api", status: sourcify.status, bytes: sourcify.bytes.length,
    responseSha256: sourcify.ok ? sha256(sourcify.bytes) : null, match: bundle?.match || null, runtimeMatch: bundle?.runtimeMatch || null, creationMatch: bundle?.creationMatch || null });
  for (const row of explorerRows.slice(0, 3)) {
    let url; try { url = new URL(row.url); } catch { continue; }
    url.searchParams.set("module", "contract"); url.searchParams.set("action", "getsourcecode"); url.searchParams.set("address", address);
    if (/api\.etherscan\.io/i.test(url.hostname)) url.searchParams.set("chainid", String(chainId));
    const response = await fetchBounded(url.href, { headers: row.headers }, LIMITS.sourceBytes, 25_000);
    let parsed = null; if (response.ok) try { parsed = JSON.parse(response.bytes.toString("utf8")); } catch {}
    const sourceRows = Array.isArray(parsed?.result) ? parsed.result : [];
    outputs.push({ authority: chainId === BASE ? "authorized-BaseScan-compatible-api" : "authorized-Etherscan-compatible-api", transport: "inventory-api-process-only",
      status: response.status, bytes: response.bytes.length, responseSha256: response.ok ? sha256(response.bytes) : null,
      verifiedSourceReturned: sourceRows.some((item) => typeof item.SourceCode === "string" && item.SourceCode.length > 0),
      contractName: sourceRows.find((item) => item.ContractName)?.ContractName || null, compilerVersion: sourceRows.find((item) => item.CompilerVersion)?.CompilerVersion || null } );
    if (sourceRows.some((item) => typeof item.SourceCode === "string" && item.SourceCode.length > 0)) return { outputs, bundle: { authority: "explorer-api", raw: parsed, row: sourceRows[0] } };
  }
  return { outputs, bundle: bundle ? { authority: "sourcify", raw: bundle, response: sourcify.bytes } : null };
}

async function fetchIpfs(cid) {
  if (!cid) return { ok: false, attempts: [] }; const attempts = [];
  for (const gateway of ["https://ipfs.io/ipfs/", "https://cloudflare-ipfs.com/ipfs/", "https://dweb.link/ipfs/", "https://nftstorage.link/ipfs/"]) {
    const response = await publicGet(`${gateway}${cid}`); attempts.push({ authority: new URL(gateway).hostname, status: response.status, bytes: response.bytes.length });
    if (response.ok) return { ok: true, bytes: response.bytes, sha256: sha256(response.bytes), gatewayClass: "public-ipfs", attempts };
  }
  return { ok: false, attempts };
}
function cidFromUrl(value) {
  const match = String(value || "").match(/(?:dweb:\/ipfs\/|ipfs:\/\/)([A-Za-z0-9]+)/); return match?.[1] || null;
}
async function metadataBundle(runtime, label) {
  const tail = metadataTail(runtime); if (!tail.ipfsCid) return { label, tail, status: "METADATA_CID_ABSENT" };
  const metadataRaw = await fetchIpfs(tail.ipfsCid); if (!metadataRaw) return { label, tail, status: "METADATA_FETCH_FAILED" };
  if (!metadataRaw.ok) return { label, tail, status: "METADATA_FETCH_FAILED", fetchAttempts: metadataRaw.attempts };
  let metadata; try { metadata = JSON.parse(metadataRaw.bytes.toString("utf8")); } catch { return { label, tail, status: "METADATA_JSON_INVALID", metadataSha256: metadataRaw.sha256 }; }
  const sources = {}; const sourceRows = [];
  for (const [nameRaw, row] of Object.entries(metadata.sources || {})) {
    const name = safePath(nameRaw), cid = (row.urls || []).map(cidFromUrl).find(Boolean); let acquired = cid ? await fetchIpfs(cid) : { ok: false, attempts: [] };
    if (!acquired.ok) { sourceRows.push({ path: name, acquired: false, metadataKeccak256: row.keccak256 || null, fetchAttempts: acquired.attempts }); continue; }
    const content = acquired.bytes.toString("utf8"), contentKeccak = keccak256(Buffer.from(content));
    sources[name] = { content }; sourceRows.push({ path: name, acquired: true, bytes: acquired.bytes.length, sha256: acquired.sha256,
      keccak256: contentKeccak, metadataKeccak256: row.keccak256 || null, metadataHashMatch: !row.keccak256 || row.keccak256.toLowerCase() === contentKeccak.toLowerCase() });
  }
  return { label, tail, status: Object.keys(sources).length === Object.keys(metadata.sources || {}).length ? "SOURCE_CLOSURE_ACQUIRED" : "SOURCE_CLOSURE_INCOMPLETE",
    metadata, metadataBytes: metadataRaw.bytes.length, metadataSha256: metadataRaw.sha256, sources, sourceRows };
}
function flattenReferences(refs) { const rows = []; for (const [id, positions] of Object.entries(refs || {})) for (const row of positions) rows.push({ id, start: row.start, length: row.length }); return rows; }
function compareCompiled(compiled, onchain, immutableReferences) {
  const template = bytesOf(`0x${compiled}`), chain = bytesOf(onchain), refs = flattenReferences(immutableReferences), mask = new Set();
  for (const ref of refs) for (let index = ref.start; index < ref.start + ref.length; index++) mask.add(index);
  let masked = 0, unmasked = 0; for (let index = 0; index < Math.max(template.length, chain.length); index++) if (template[index] !== chain[index]) mask.has(index) ? masked++ : unmasked++;
  return { sameLength: template.length === chain.length, directExact: template.equals(chain), immutableReferenceCount: refs.length,
    immutableByteCount: mask.size, maskedDifferingBytes: masked, unmaskedDifferingBytes: unmasked,
    immutableNormalizedExact: template.length === chain.length && unmasked === 0, differingRegions: regions([...Array(Math.max(template.length, chain.length)).keys()].filter((index) => template[index] !== chain[index])) };
}
function compileBundle(bundle, onchainRuntime) {
  if (bundle.status !== "SOURCE_CLOSURE_ACQUIRED") return { attempted: false, status: bundle.status };
  const compiler = bundle.metadata?.compiler?.version; if (!String(compiler).startsWith("0.8.25+commit.")) return { attempted: false, status: "EXACT_COMPILER_NOT_INSTALLED", compiler };
  let solc; try { solc = require("solc"); } catch { return { attempted: false, status: "SOLC_MODULE_ABSENT", compiler }; }
  if (!solc.version().startsWith(compiler)) return { attempted: false, status: "SOLC_VERSION_MISMATCH", compiler, installed: solc.version() };
  const settings = structuredClone(bundle.metadata.settings); settings.outputSelection = { "*": { "*": ["abi", "metadata", "evm.bytecode.object", "evm.deployedBytecode.object", "evm.deployedBytecode.immutableReferences", "evm.deployedBytecode.linkReferences"] } };
  const input = { language: bundle.metadata.language || "Solidity", sources: bundle.sources, settings }, inputText = JSON.stringify(input), outputText = solc.compile(inputText);
  let output; try { output = JSON.parse(outputText); } catch { return { attempted: true, status: "SOLC_OUTPUT_INVALID" }; }
  const errors = (output.errors || []).filter((row) => row.severity === "error"); if (errors.length) return { attempted: true, status: "COMPILE_ERRORS", errorCount: errors.length,
    errorDigests: errors.map((row) => sha256(Buffer.from(row.formattedMessage || row.message || ""))) };
  const target = bundle.metadata.settings?.compilationTarget || {}; const targetFile = Object.keys(target)[0], targetName = target[targetFile];
  const artifact = output.contracts?.[targetFile]?.[targetName]; if (!artifact) return { attempted: true, status: "TARGET_ARTIFACT_ABSENT", targetFile, targetName };
  const runtime = artifact.evm.deployedBytecode.object, comparison = compareCompiled(runtime, onchainRuntime, artifact.evm.deployedBytecode.immutableReferences);
  return { attempted: true, status: comparison.directExact || comparison.immutableNormalizedExact ? "RUNTIME_EXACT" : "RUNTIME_MISMATCH", compiler: solc.version(),
    target: `${targetFile}:${targetName}`, settings, standardInputSha256: sha256(Buffer.from(inputText)), standardOutputSha256: sha256(Buffer.from(outputText)),
    sourceCount: Object.keys(bundle.sources).length, compiledRuntime: `0x${runtime}`, compiledCreation: `0x${artifact.evm.bytecode.object}`,
    compiledRuntimeSummary: summary(`0x${runtime}`), compiledCreationSummary: summary(`0x${artifact.evm.bytecode.object}`), immutableReferences: artifact.evm.deployedBytecode.immutableReferences,
    linkReferences: artifact.evm.deployedBytecode.linkReferences, comparison, metadata: JSON.parse(artifact.metadata), abi: artifact.abi, input };
}
function acquireTarget(bundle, compiled, onchainRuntime, sourceAuthority) {
  if (compiled.status !== "RUNTIME_EXACT") return null;
  const destination = path.join(ROOT, "targets", `maverick-v2-deployed-${SELECTED_POOL.slice(2).toLowerCase()}`);
  if (fs.existsSync(destination)) fail("RECOVERY_TARGET_ALREADY_EXISTS"); fs.mkdirSync(destination, { recursive: false });
  for (const [name, row] of Object.entries(bundle.sources)) write(path.join(destination, "sources", ...safePath(name).split("/")), row.content);
  writeJson(path.join(destination, "metadata.json"), bundle.metadata); writeJson(path.join(destination, "standard-json-input.json"), compiled.input);
  writeJson(path.join(destination, "artifact.json"), { target: compiled.target, compiler: compiled.compiler, settings: compiled.settings, abi: compiled.abi,
    compiledRuntime: compiled.compiledRuntime, compiledCreation: compiled.compiledCreation, onchainRuntime, comparison: compiled.comparison,
    immutableReferences: compiled.immutableReferences, linkReferences: compiled.linkReferences });
  const files = listFiles(destination).map((file) => ({ path: path.relative(destination, file).replace(/\\/g, "/"), bytes: fs.statSync(file).size, sha256: sha256(fs.readFileSync(file)) }));
  const manifest = { schema: "maverick-v2-deployed-source/v1", chainId: BASE, address: SELECTED_POOL, immutableSnapshot: true,
    authority: sourceAuthority, compiler: compiled.compiler, target: compiled.target, runtimeExact: true, immutableNormalized: compiled.comparison.immutableNormalizedExact,
    onchainRuntime: summary(onchainRuntime), files };
  writeJson(path.join(destination, "manifest.json"), manifest);
  return { path: rel(destination), manifestSha256: sha256(fs.readFileSync(path.join(destination, "manifest.json"))), files: files.length,
    runtimeExact: true, immutableNormalized: compiled.comparison.immutableNormalizedExact };
}
function listFiles(directory, output = []) { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const full = path.join(directory, entry.name); if (entry.isDirectory()) listFiles(full, output); else if (entry.isFile()) output.push(full); } return output; }

async function packageSearch() {
  const githubNames = ["v2-amm", "maverick-v2-amm", "v2-core", "v2-supplemental", "v2-common", "v2-interfaces"], npmNames = ["@maverick/v2-amm", "@maverick/v2-common", "@maverick/v2-interfaces"];
  const github = [];
  for (const name of githubNames) { const response = await publicGet(`https://api.github.com/repos/MaverickProtocol/${name}`); let parsed = null; if (response.ok) try { parsed = JSON.parse(response.bytes.toString("utf8")); } catch {}
    github.push({ repository: `MaverickProtocol/${name}`, status: response.status, available: response.ok, defaultBranch: parsed?.default_branch || null,
      archived: parsed?.archived ?? null, pushedAt: parsed?.pushed_at || null }); }
  const npm = [];
  for (const name of npmNames) { const response = await publicGet(`https://registry.npmjs.org/${encodeURIComponent(name)}`); let parsed = null; if (response.ok) try { parsed = JSON.parse(response.bytes.toString("utf8")); } catch {}
    npm.push({ package: name, status: response.status, available: response.ok, latest: parsed?.["dist-tags"]?.latest || null, repository: parsed?.repository?.url || null }); }
  return { github, npm };
}
function gitClean(target) {
  try { const head = childProcess.execFileSync("git", ["-C", target, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const status = childProcess.execFileSync("git", ["-C", target, "status", "--porcelain=v2"], { encoding: "utf8" }).trim(); return { path: rel(target), head, clean: status === "" }; }
  catch { return { path: rel(target), clean: false, category: "git-validation-failed" }; }
}
function leakCheck(texts, secrets) {
  const combined = texts.join("\n").toLowerCase(); for (const value of secrets) if (String(value).length >= 6 && combined.includes(String(value).toLowerCase())) fail("ENDPOINT_MATERIAL_LEAK");
  return { status: "PASS", inventoryValuesPersisted: false, providerMaterialPersisted: false, credentialsPersisted: false };
}
function report(capture) {
  const baseGroups = capture.runtimeSampling.base.groups.lengthFamilies.map((row) => `| ${row.sampleCount} | ${row.runtimeBytes} | ${row.exactHashCount} | ${row.differingByteCount} | ${row.differingRegions.length} | ${row.metadata.map((item) => item.ipfsCid || "none").join(", ")} |`).join("\n");
  return `# Maverick V2 Base factory/pool source-runtime recovery — Gate 2\n\n**Classification:** public-source/runtime provenance only; no exploit tests or route claim. \`routePositive\` and executable status remain unknown.\n\n## Scope and pins\n\n- Base finalized pin: **${capture.pins.base.number}** (\`${capture.pins.base.hash}\`).\n- Ethereum finalized pin: **${capture.pins.ethereum.number}** (\`${capture.pins.ethereum.hash}\`).\n- Official factory: \`${FACTORY_ADDRESS}\`; selected Base DAI/USDC pool: \`${SELECTED_POOL}\`.\n\n## Creation/runtime capture\n\nFactory Base creation boundary: block **${capture.creation.factoryBase.creationBlock}**; creation transaction ${capture.creation.factoryBase.transaction?.available ? "recovered" : "not recovered"}. Selected pool factory-call transaction and receipt were recovered; internal CREATE2 init code ${capture.creation.selectedPool.trace.available ? "was recovered from a read-only trace" : "was not available from qualified providers"}. Raw runtime and available public creation inputs are retained under \`reports/raw/fast/prefilter-maverick-v2-base-pools/gate2/\`.\n\nFactory runtime metadata compiler=${capture.runtime.factoryBase.metadata.compiler || "unknown"}, CID=${capture.runtime.factoryBase.metadata.ipfsCid || "absent"}; selected pool compiler=${capture.runtime.selectedPool.metadata.compiler || "unknown"}, CID=${capture.runtime.selectedPool.metadata.ipfsCid || "absent"}. Selected CREATE2 init-code hash: \`${capture.runtime.selectedPool.create2InitCodeHash || "unavailable"}\`; exact occurrence in factory runtime/PUSH32 constants=${capture.runtime.factoryBase.containsSelectedInitCodeHash}/${capture.runtime.factoryBase.push32ContainsSelectedInitCodeHash}. Absence is reported without inferring how deployment code is sourced.\n\n## Base pool runtime families and immutable candidates\n\n| Sample | Runtime bytes | Exact hashes | Differing bytes | Diff regions | Metadata CID |\n|---:|---:|---:|---:|---:|---|\n${baseGroups || "| 0 | - | - | - | - | - |"}\n\nSample=${capture.runtimeSampling.base.sampleCount}; equal-length families=${capture.runtimeSampling.base.groups.lengthFamilies.length}. Repeated 20/32-byte and scalar diff regions are retained as immutable candidates; without a verified source AST they are not declared immutables. Ethereum same-address factory and bounded pool samples were queried separately.\n\n## Public source recovery\n\n- Explorer/Sourcify addresses probed: ${capture.sourceSearch.addressesProbed}.\n- Runtime-embedded metadata source closure: **${capture.sourceRecovery.pool.bundleStatus}**.\n- Exact compiler/runtime result: **${capture.sourceRecovery.pool.compileStatus}**.\n- Recovered target: ${capture.sourceRecovery.acquiredTarget ? `\`${capture.sourceRecovery.acquiredTarget.path}\`` : "none"}.\n- Public Git/npm inspection found implementation package candidates: **${capture.packageSearch.implementationCandidates}**.\n\n## Gates\n\n| Gate | Status |\n|---|---|\n| Creation/runtime evidence | ${capture.gates.runtime.status} |\n| Runtime-family sampling | ${capture.gates.runtimeFamily.status} |\n| Public source authority | ${capture.gates.sourceAuthority.status} |\n| Exact compiler/runtime | ${capture.gates.source.status} |\n| Secret safety | ${capture.gates.secretSafety.status} |\n| Source target cleanliness | ${capture.gates.cleanTargets.status} |\n\n## Conclusion\n\n**SOURCE ${capture.gates.source.status}.** ${capture.conclusion} No signing, state change, fork, deployment, or live swap was performed. No exploit claim is made.\n`;
}

async function main() {
  for (const file of [PRIOR, TOOL, ...INVENTORIES.map((name) => path.join(ROOT, name))]) if (!fs.existsSync(file)) fail("REQUIRED_INPUT_MISSING");
  fs.mkdirSync(OUT, { recursive: true });
  const prior = JSON.parse(fs.readFileSync(PRIOR, "utf8")); if (prior.chainId !== BASE || !prior.gates?.provenance || prior.selection?.topActiveMaterialPool?.address?.toLowerCase() !== SELECTED_POOL.toLowerCase()) fail("PRIOR_GATE1_MISMATCH");
  const inventoryRows = inventory(); const [baseQ, ethQ] = await Promise.all([qualify(inventoryRows.rpcRows, BASE), qualify(inventoryRows.rpcRows, ETHEREUM)]);
  writeJson(CHECKPOINT, { schema: "maverick-gate2/checkpoint-v1", stage: "qualified", base: baseQ.summary, ethereum: ethQ.summary, complete: false });

  const basePin = baseQ.pin.number, ethPin = ethQ.pin.number;
  const [baseFactoryCodeResult, basePoolCodeResult, ethFactoryCodeResult] = await Promise.all([
    rpc(baseQ.primary, "eth_getCode", [FACTORY_ADDRESS, basePin]), rpc(baseQ.primary, "eth_getCode", [SELECTED_POOL, basePin]), rpc(ethQ.primary, "eth_getCode", [FACTORY_ADDRESS, ethPin])]);
  if (!baseFactoryCodeResult.ok || !basePoolCodeResult.ok || !ethFactoryCodeResult.ok) fail("RUNTIME_CAPTURE_FAILED");
  const baseFactoryCode = bytecode(baseFactoryCodeResult.result), basePoolCode = bytecode(basePoolCodeResult.result), ethFactoryCode = bytecode(ethFactoryCodeResult.result);
  write(path.join(OUT, "factory-base-runtime.hex"), `${baseFactoryCode}\n`); write(path.join(OUT, "selected-pool-base-runtime.hex"), `${basePoolCode}\n`); write(path.join(OUT, "factory-ethereum-runtime.hex"), `${ethFactoryCode}\n`);
  const baseBoundary = await creationBoundary(baseQ.primary, FACTORY_ADDRESS, basePin), ethBoundary = await creationBoundary(ethQ.primary, FACTORY_ADDRESS, ethPin);
  let factoryBaseTx = await findCreationTransaction(baseQ.primary, baseBoundary, FACTORY_ADDRESS), factoryEthTx = await findCreationTransaction(ethQ.primary, ethBoundary, FACTORY_ADDRESS);
  const factoryBaseExplorerHash = factoryBaseTx ? null : await explorerCreationHash(BASE, FACTORY_ADDRESS);
  const factoryEthExplorerHash = factoryEthTx ? null : await explorerCreationHash(ETHEREUM, FACTORY_ADDRESS);
  if (!factoryBaseTx && factoryBaseExplorerHash) factoryBaseTx = await transactionEvidence(baseQ.primary, factoryBaseExplorerHash);
  if (!factoryEthTx && factoryEthExplorerHash) factoryEthTx = await transactionEvidence(ethQ.primary, factoryEthExplorerHash);
  const selectedEvent = prior.poolCreatedEvents.find((row) => row.pool.toLowerCase() === SELECTED_POOL.toLowerCase()); if (!selectedEvent) fail("SELECTED_POOL_EVENT_MISSING");
  const poolTx = await transactionEvidence(baseQ.primary, selectedEvent.transactionHash);
  const poolTrace = await traceInitCode([baseQ.primary, ...baseQ.alternatives], selectedEvent.transactionHash, SELECTED_POOL);
  const factoryBaseTrace = factoryBaseTx?.available ? await traceInitCode([baseQ.primary, ...baseQ.alternatives], factoryBaseTx.transactionHash, FACTORY_ADDRESS) : { available: false };
  const factoryEthTrace = factoryEthTx?.available ? await traceInitCode([ethQ.primary, ...ethQ.alternatives], factoryEthTx.transactionHash, FACTORY_ADDRESS) : { available: false };
  if (factoryBaseTx?.input) write(path.join(OUT, "factory-base-creation-input.hex"), `${factoryBaseTx.input}\n`);
  if (factoryBaseTrace.available) write(path.join(OUT, "factory-base-init-code.hex"), `${factoryBaseTrace.input}\n`);
  if (poolTx?.input) write(path.join(OUT, "selected-pool-factory-call-input.hex"), `${poolTx.input}\n`);
  if (poolTrace.available) write(path.join(OUT, "selected-pool-create2-init-code.hex"), `${poolTrace.input}\n`);
  const creation = { factoryBase: { creationBlock: Number(baseBoundary), explorerCreationHashRecovered: Boolean(factoryBaseExplorerHash), transaction: factoryBaseTx, trace: factoryBaseTrace },
    factoryEthereum: { creationBlock: Number(ethBoundary), explorerCreationHashRecovered: Boolean(factoryEthExplorerHash), transaction: factoryEthTx, trace: factoryEthTrace },
    selectedPool: { creationEvent: selectedEvent, transaction: poolTx, trace: poolTrace } }; writeJson(CREATION, creation);

  const baseEnumeration = await factoryPools(baseQ.primary, basePin, LIMITS.baseSample), ethEnumeration = await factoryPools(ethQ.primary, ethPin, LIMITS.ethereumSample);
  if (!baseEnumeration.pools.some((pool) => pool.toLowerCase() === SELECTED_POOL.toLowerCase())) baseEnumeration.pools.unshift(SELECTED_POOL);
  const [baseRows, ethRows] = await Promise.all([sampleRuntime(baseQ.primary, baseEnumeration.pools.slice(0, LIMITS.baseSample), basePin), sampleRuntime(ethQ.primary, ethEnumeration.pools, ethPin)]);
  const groupCapture = { schema: "maverick-gate2/runtime-groups-v1", base: { counts: baseEnumeration.counts, sample: baseRows.map((row) => ({ ...row, code: undefined })), groups: runtimeGroups(baseRows) },
    ethereum: { counts: ethEnumeration.counts, sample: ethRows.map((row) => ({ ...row, code: undefined })), groups: runtimeGroups(ethRows) } }; writeJson(GROUPS, groupCapture);

  const factoryTail = metadataTail(baseFactoryCode), poolTail = metadataTail(basePoolCode), ethFactoryTail = metadataTail(ethFactoryCode);
  const push32 = push32Constants(baseFactoryCode);
  const poolBundle = await metadataBundle(basePoolCode, "selected-base-pool"), factoryBundle = await metadataBundle(baseFactoryCode, "base-factory");
  const poolCompiled = compileBundle(poolBundle, basePoolCode), factoryCompiled = compileBundle(factoryBundle, baseFactoryCode);
  const metadataCapture = { schema: "maverick-gate2/metadata-recovery-v1", factory: { tail: factoryTail, bundleStatus: factoryBundle.status,
    metadataSha256: factoryBundle.metadataSha256 || null, fetchAttempts: factoryBundle.fetchAttempts || [], sourceRows: factoryBundle.sourceRows || [], compile: withoutLarge(factoryCompiled) },
    pool: { tail: poolTail, bundleStatus: poolBundle.status, metadataSha256: poolBundle.metadataSha256 || null, fetchAttempts: poolBundle.fetchAttempts || [], sourceRows: poolBundle.sourceRows || [], compile: withoutLarge(poolCompiled) },
    ethereumFactory: { tail: ethFactoryTail }, factoryPush32Candidates: push32 }; writeJson(METADATA, metadataCapture);

  const sourceAddresses = [{ chainId: BASE, address: FACTORY_ADDRESS, role: "factory" }, { chainId: BASE, address: SELECTED_POOL, role: "selected-pool" },
    { chainId: ETHEREUM, address: FACTORY_ADDRESS, role: "factory" }];
  const selectedRuntime = summary(basePoolCode);
  for (const row of baseRows) if (sourceAddresses.filter((item) => item.role === "same-runtime-family").length < 8
    && sourceAddresses.length < LIMITS.sourceAddresses && row.runtime.bytes === selectedRuntime.bytes
    && row.metadata.ipfsCid === poolTail.ipfsCid && row.address.toLowerCase() !== SELECTED_POOL.toLowerCase()) {
    sourceAddresses.push({ chainId: BASE, address: row.address, role: "same-runtime-family" });
  }
  for (const row of ethRows) if (sourceAddresses.length < LIMITS.sourceAddresses) sourceAddresses.push({ chainId: ETHEREUM, address: row.address, role: "ethereum-factory-pool" });
  const probes = [];
  for (const row of sourceAddresses) { const probe = await explorerProbe(row.chainId, row.address, inventoryRows.explorerRows); probes.push({ ...row, authorities: probe.outputs, bundleAvailable: Boolean(probe.bundle) }); }
  const packages = await packageSearch(); const implementationCandidates = [...packages.github, ...packages.npm].filter((row) => row.available && /amm|core|supplemental/i.test(row.repository || row.package || "")).length;
  const searchCapture = { schema: "maverick-gate2/source-search-v1", probes, packages }; writeJson(SEARCH, searchCapture);

  let acquiredTarget = null;
  if (poolCompiled.status === "RUNTIME_EXACT") acquiredTarget = acquireTarget(poolBundle, poolCompiled, basePoolCode,
    { service: "runtime-embedded-IPFS-metadata", metadataCid: poolTail.ipfsCid, compiler: poolBundle.metadata?.compiler?.version });
  const cleanTargets = [path.join(ROOT, "targets", "maverick-v2-common-d91e871"), path.join(ROOT, "targets", "maverick-v2-interfaces-f9f4f3e")].map(gitClean);
  let acquiredClean = null;
  if (acquiredTarget) { const destination = path.join(ROOT, acquiredTarget.path), manifest = JSON.parse(fs.readFileSync(path.join(destination, "manifest.json"), "utf8"));
    acquiredClean = manifest.files.every((row) => { const file = path.join(destination, row.path); return fs.existsSync(file) && fs.statSync(file).size === row.bytes && sha256(fs.readFileSync(file)) === row.sha256; }); }

  const verifiedAuthorityFound = probes.some((probe) => probe.bundleAvailable || probe.authorities.some((row) => row.verifiedMarker || row.verifiedSourceReturned || /match/i.test(String(row.runtimeMatch || row.match || ""))));
  const sourceStatus = poolCompiled.status === "RUNTIME_EXACT" ? "PASS" : poolBundle.status === "SOURCE_CLOSURE_ACQUIRED" && poolCompiled.status === "RUNTIME_MISMATCH" ? "FAIL" : "UNKNOWN";
  const selectedInitHash = poolTrace.available ? poolTrace.inputSummary.keccak256 : null;
  const runtime = { factoryBase: { address: FACTORY_ADDRESS, runtime: summary(baseFactoryCode), metadata: factoryTail,
      containsSelectedInitCodeHash: selectedInitHash ? baseFactoryCode.includes(selectedInitHash.slice(2).toLowerCase()) : null,
      push32ContainsSelectedInitCodeHash: selectedInitHash ? push32.some((row) => row.value === selectedInitHash.toLowerCase()) : null },
    selectedPool: { address: SELECTED_POOL, runtime: summary(basePoolCode), metadata: poolTail, create2InitCodeHash: selectedInitHash },
    factoryEthereum: { address: FACTORY_ADDRESS, runtime: summary(ethFactoryCode), metadata: ethFactoryTail }, factoryPush32CandidateCount: push32.length };
  const capture = canonical({ schema: "maverick-gate2/capture-v1", generatedAt: new Date().toISOString(), classification: "PUBLIC_SOURCE_RUNTIME_RECOVERY/NO_EXPLOIT_TESTS/ROUTE_UNKNOWN",
    pins: { base: { number: Number(BigInt(basePin)), hash: baseQ.pin.hash }, ethereum: { number: Number(BigInt(ethPin)), hash: ethQ.pin.hash } },
    endpointQualification: { base: baseQ.summary, ethereum: ethQ.summary }, runtime, creation,
    runtimeSampling: { base: { sampleCount: baseRows.length, counts: baseEnumeration.counts, groups: groupCapture.base.groups }, ethereum: { sampleCount: ethRows.length, counts: ethEnumeration.counts, groups: groupCapture.ethereum.groups } },
    sourceSearch: { addressesProbed: probes.length, verifiedAuthorityFound }, sourceRecovery: { pool: { bundleStatus: poolBundle.status, compileStatus: poolCompiled.status,
      compiler: poolBundle.metadata?.compiler?.version || null, target: poolCompiled.target || null, comparison: poolCompiled.comparison || null }, factory: { bundleStatus: factoryBundle.status,
      compileStatus: factoryCompiled.status, compiler: factoryBundle.metadata?.compiler?.version || null, target: factoryCompiled.target || null, comparison: factoryCompiled.comparison || null }, acquiredTarget },
    packageSearch: { github: packages.github, npm: packages.npm, implementationCandidates }, cleanTargets: { existing: cleanTargets, acquired: acquiredClean },
    gates: { runtime: { status: factoryBaseTx?.available && factoryBaseTrace.available && poolTx?.available && poolTrace.available ? "PASS" : "PARTIAL" }, runtimeFamily: { status: baseRows.length >= 16 ? "PASS" : "PARTIAL" },
      sourceAuthority: { status: verifiedAuthorityFound || poolBundle.status === "SOURCE_CLOSURE_ACQUIRED" ? "PASS" : "UNKNOWN" }, source: { status: sourceStatus },
      secretSafety: { status: "PENDING" }, cleanTargets: { status: cleanTargets.every((row) => row.clean) && (acquiredClean === null || acquiredClean) ? "PASS" : "FAIL" } },
    conclusion: sourceStatus === "PASS" ? "The selected pool source closure and exact compiler reproduce its runtime, with differences confined to declared immutable references if normalization was required."
      : sourceStatus === "FAIL" ? "A complete authoritative source closure compiled but did not match the selected pool runtime outside declared immutable regions."
      : "No complete authoritative source closure plus exact compiler/runtime match was recovered; absence of proof is not proof of mismatch.",
    routePositive: "unknown", executable: "unknown", exploitClaim: false });
  const captureText0 = json(capture), reportText0 = report(capture), otherTexts = [json(groupCapture), json(creation), json(metadataCapture), json(searchCapture)];
  const leak = leakCheck([captureText0, reportText0, ...otherTexts], inventoryRows.secretValues); capture.gates.secretSafety = leak; const captureText = json(capture), reportText = report(capture);
  write(CAPTURE, captureText); write(REPORT, reportText); writeJson(CHECKPOINT, { schema: "maverick-gate2/checkpoint-v1", stage: "complete", base: baseQ.summary,
    ethereum: ethQ.summary, sourceStatus, acquiredTarget: acquiredTarget?.path || null, complete: true });
  const records = [TOOL, CAPTURE, CHECKPOINT, GROUPS, CREATION, SEARCH, METADATA, REPORT,
    ...["factory-base-runtime.hex", "selected-pool-base-runtime.hex", "factory-ethereum-runtime.hex", "factory-base-creation-input.hex", "factory-base-init-code.hex", "selected-pool-factory-call-input.hex", "selected-pool-create2-init-code.hex"]
      .map((name) => path.join(OUT, name)).filter(fs.existsSync)].map((file) => { const bytes = fs.readFileSync(file); return { path: rel(file), bytes: bytes.length, sha256: sha256(bytes) }; });
  const manifest = { schema: "maverick-gate2/manifest-v1", generatedAt: capture.generatedAt, records,
    aggregateSha256: sha256(Buffer.from(records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n"))), secretSafety: leak,
    acquiredTarget: acquiredTarget || null }; writeJson(MANIFEST, manifest);
  console.log(JSON.stringify({ status: "ok", source: sourceStatus, baseSample: baseRows.length, ethereumSample: ethRows.length, sourceAddresses: probes.length,
    metadata: poolBundle.status, compile: poolCompiled.status, acquiredTarget: acquiredTarget?.path || null }));
}

function withoutLarge(value) {
  if (!value || typeof value !== "object") return value;
  const copy = { ...value }; for (const key of ["input", "abi", "metadata", "compiledRuntime", "compiledCreation", "settings"]) delete copy[key]; return canonical(copy);
}

main().catch((error) => { console.error(JSON.stringify({ status: "failed", category: error?.safeCode || "BOUNDED_GATE2_FAILURE" })); process.exitCode = 1; });
