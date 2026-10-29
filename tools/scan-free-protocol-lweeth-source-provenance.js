#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { AbiCoder, Interface, id, keccak256 } = require("ethers");

const ROOT = path.resolve(__dirname, "..");
const SOURCE_REL = "sources/free-protocol-step12-lweeth-source-provenance";
const SOURCE_DIR = path.join(ROOT, SOURCE_REL);
const RAW = path.join(ROOT, "reports/raw/fast/free-protocol-lweeth-source-provenance.json");
const MANIFEST = path.join(ROOT, "reports/raw/fast/free-protocol-lweeth-source-provenance.manifest.json");
const REPORT = path.join(ROOT, "reports/free-protocol-lweeth-source-provenance.md");
const HANDOFF = path.join(ROOT, "coordination/handoffs/2026-07-15-coordinator-free-step12-handoff.md");
const STEP11_RAW = path.join(ROOT, "reports/raw/fast/free-protocol-recursive-liquidation-decoder.json");
const STEP11_MANIFEST = path.join(ROOT, "reports/raw/fast/free-protocol-recursive-liquidation-decoder.manifest.json");

const TARGET = "0xbd9edf764bc1f219c124ad5cfa7084bbed124aa8";
const LETH = "0xe855b8018c22a05f84724e93693caf166912add5";
const LMBTC = "0x59dd441184024a77fd17e68f07e242622806c256";
const FEE_SHARING = "0x8680ceabcb9b56913c519c069add6bc3494b7020";
const CREATION_BLOCK_EXPECTED = 7492451;
const DEPLOYMENT_TX_EXPECTED = "0xefe641edc7b97b720905c990d305ee85ef8215bb223239415a492f2fd68f5c00";
const LIQUIDATION_BLOCK = 27814852;
const FIXED_PIN = 41900000;
const BLOCKS = [CREATION_BLOCK_EXPECTED, LIQUIDATION_BLOCK, FIXED_PIN];
const EXPECTED_RUNTIME_BYTES = 20484;
const EXPECTED_TRAILER_BYTES = 53;
const EXPECTED_IPFS_DIGEST = "9564cc359b75270e1262b752e82fa3873b13f76bd2046683d1e5c2a8406990d2";
const EXPECTED_SOLC = "0.6.12";
const EXPECTED_NFT_ID = "535";
const CLASSIFICATION = "INCOMPLETE/WATCH — LWEETH.MODE DEPLOYMENT, STABLE RUNTIME, SOLC METADATA, AND LToken-FAMILY COMPATIBILITY BOUND; AUTHORITATIVE SOURCE/BUILD EXACTNESS UNRESOLVED";

const PROVIDERS = ["https://mainnet.mode.network", "https://mode.drpc.org"];
const EXPLORER_V1 = "https://explorer.mode.network/api";
const EXPLORER_V2 = "https://explorer.mode.network/api/v2/smart-contracts/";
const IPFS_GATEWAYS = [
  "https://ipfs.io/ipfs/", "https://dweb.link/ipfs/", "https://gateway.pinata.cloud/ipfs/",
  "https://cloudflare-ipfs.com/ipfs/", "https://ipfs.filebase.io/ipfs/", "https://w3s.link/ipfs/",
  "https://nftstorage.link/ipfs/", "https://4everland.io/ipfs/"
];
const SOLJSON_NAME = "soljson-v0.6.12+commit.27d51765.js";
const SOLJSON_URLS = [
  `https://binaries.soliditylang.org/bin/${SOLJSON_NAME}`,
  `https://raw.githubusercontent.com/ethereum/solc-bin/gh-pages/bin/${SOLJSON_NAME}`
];
const SOLJSON_LIST_URLS = [
  "https://binaries.soliditylang.org/bin/list.json",
  "https://raw.githubusercontent.com/ethereum/solc-bin/gh-pages/bin/list.json"
];
const OFFICIAL_CURRENT_COMMIT = "75c2b0bf8342964c2f4d663eb614cf18ff67ba98";
const OFFICIAL_INITIAL_COMMIT = "851403e6fa191430352897ba8059457afaef2dd6";
const COMMUNITY_COMMIT = "93c71fc17ab61b7f7c36380e79502a7bfbac1b39";

const registerIface = new Interface(["function register(address recipient) returns (uint256)"]);
const ownerIface = new Interface(["function owner() view returns (address)"]);
const coder = AbiCoder.defaultAbiCoder();
const TRANSFER_TOPIC = id("Transfer(address,address,uint256)").toLowerCase();
const OWNERSHIP_TOPIC = id("OwnershipTransferred(address,address)").toLowerCase();
const ZERO = "0x0000000000000000000000000000000000000000";
let rpcId = 1;

const lower = (value) => value ? value.toLowerCase() : null;
const hexBlock = (number) => `0x${number.toString(16)}`;
const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
const relative = (file) => path.relative(ROOT, file).replace(/\\/g, "/");
const safeName = (value) => value.replace(/\\/g, "/").split("/").filter((part) => part && part !== "." && part !== "..").join("/");

function record(file) {
  const bytes = fs.readFileSync(file);
  return { file: relative(file), sha256: sha256(bytes), bytes: bytes.length };
}

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" || Buffer.isBuffer(value) ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function atomicWrite(file, value) {
  const next = `${file}.next-${process.pid}`;
  write(next, value);
  fs.rmSync(file, { force: true });
  fs.renameSync(next, file);
}

function cleanStaleNextTrees() {
  const parent = path.dirname(SOURCE_DIR);
  if (fs.existsSync(parent)) {
    for (const name of fs.readdirSync(parent)) {
      if (name.startsWith(`${path.basename(SOURCE_DIR)}.next-`)) fs.rmSync(path.join(parent, name), { recursive: true, force: true });
    }
  }
  for (const file of [RAW, MANIFEST, REPORT, HANDOFF]) {
    const parentDir = path.dirname(file);
    if (!fs.existsSync(parentDir)) continue;
    for (const name of fs.readdirSync(parentDir)) {
      if (name.startsWith(`${path.basename(file)}.next-`)) fs.rmSync(path.join(parentDir, name), { recursive: true, force: true });
    }
  }
}

async function rpc(method, params) {
  let lastError;
  for (const provider of PROVIDERS) {
    try {
      const response = await fetch(provider, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
        signal: AbortSignal.timeout(45000)
      });
      const payload = await response.json();
      if (payload.error) throw new Error(payload.error.message);
      return payload.result;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function fetchJson(url, timeout = 45000) {
  const response = await fetch(url, { headers: { accept: "application/json", "user-agent": "defensive-readonly-audit" }, signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  return response.json();
}

async function fetchText(url, timeout = 45000) {
  const response = await fetch(url, { headers: { accept: "text/plain,application/json", "user-agent": "defensive-readonly-audit" }, signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  return response.text();
}

async function fetchBufferCandidates(urls, timeout = 90000) {
  for (let index = 0; index < urls.length; index++) {
    try {
      const response = await fetch(urls[index], { headers: { "user-agent": "defensive-readonly-audit" }, signal: AbortSignal.timeout(timeout) });
      if (!response.ok) continue;
      return { bytes: Buffer.from(await response.arrayBuffer()), successfulCandidateIndex: index };
    } catch {}
  }
  return null;
}

function readCborLength(buffer, offset, ai) {
  if (ai < 24) return { value: ai, offset };
  if (ai === 24) return { value: buffer[offset], offset: offset + 1 };
  if (ai === 25) return { value: buffer.readUInt16BE(offset), offset: offset + 2 };
  if (ai === 26) return { value: buffer.readUInt32BE(offset), offset: offset + 4 };
  throw new Error(`Unsupported CBOR additional information ${ai}`);
}

function decodeCborItem(buffer, start = 0) {
  const head = buffer[start];
  const major = head >> 5;
  const ai = head & 31;
  const length = readCborLength(buffer, start + 1, ai);
  let offset = length.offset;
  if (major === 0) return { value: length.value, offset };
  if (major === 2) return { value: buffer.subarray(offset, offset + length.value), offset: offset + length.value };
  if (major === 3) return { value: buffer.subarray(offset, offset + length.value).toString("utf8"), offset: offset + length.value };
  if (major === 4) {
    const value = [];
    for (let index = 0; index < length.value; index++) {
      const decoded = decodeCborItem(buffer, offset);
      value.push(decoded.value);
      offset = decoded.offset;
    }
    return { value, offset };
  }
  if (major === 5) {
    const value = {};
    for (let index = 0; index < length.value; index++) {
      const key = decodeCborItem(buffer, offset);
      offset = key.offset;
      const decoded = decodeCborItem(buffer, offset);
      offset = decoded.offset;
      value[String(key.value)] = decoded.value;
    }
    return { value, offset };
  }
  throw new Error(`Unsupported CBOR major type ${major}`);
}

function base58Encode(buffer) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let number = BigInt(`0x${buffer.toString("hex") || "0"}`);
  let output = "";
  while (number > 0n) {
    output = alphabet[Number(number % 58n)] + output;
    number /= 58n;
  }
  for (const byte of buffer) {
    if (byte !== 0) break;
    output = `1${output}`;
  }
  return output;
}

function parseSolidityMetadata(hex) {
  const full = Buffer.from(hex.replace(/^0x/, ""), "hex");
  if (full.length < 2) throw new Error("Bytecode too short for Solidity metadata");
  const cborLength = full.readUInt16BE(full.length - 2);
  const metadataStart = full.length - 2 - cborLength;
  if (metadataStart < 0) throw new Error("Invalid Solidity metadata length");
  const metadata = full.subarray(metadataStart, full.length - 2);
  const decoded = decodeCborItem(metadata, 0);
  if (decoded.offset !== metadata.length) throw new Error("CBOR metadata has trailing bytes");
  const ipfs = decoded.value.ipfs;
  const solc = decoded.value.solc;
  const ipfsBuffer = Buffer.isBuffer(ipfs) ? ipfs : null;
  const solcBuffer = Buffer.isBuffer(solc) ? solc : null;
  return {
    full,
    executable: full.subarray(0, metadataStart),
    metadata,
    evidence: {
      finalTwoByteLengthHex: full.subarray(full.length - 2).toString("hex"),
      cborLengthBytes: cborLength,
      trailerLengthBytes: cborLength + 2,
      metadataStartOffset: metadataStart,
      metadataEndOffset: full.length,
      keys: Object.keys(decoded.value).sort(),
      metadataHex: metadata.toString("hex"),
      metadataSha256: sha256(metadata),
      metadataKeccak256: keccak256(`0x${metadata.toString("hex")}`),
      ipfsMultihashHex: ipfsBuffer ? ipfsBuffer.toString("hex") : null,
      ipfsHashFunctionCodeHex: ipfsBuffer ? ipfsBuffer.subarray(0, 1).toString("hex") : null,
      ipfsDigestLengthHex: ipfsBuffer ? ipfsBuffer.subarray(1, 2).toString("hex") : null,
      ipfsDigestHex: ipfsBuffer ? ipfsBuffer.subarray(2).toString("hex") : null,
      ipfsCidV0: ipfsBuffer ? base58Encode(ipfsBuffer) : null,
      solcBytesHex: solcBuffer ? solcBuffer.toString("hex") : null,
      solcVersion: solcBuffer && solcBuffer.length === 3 ? `${solcBuffer[0]}.${solcBuffer[1]}.${solcBuffer[2]}` : null
    }
  };
}

function bytecodeRecord(hex, rawFile) {
  const bytes = Buffer.from(hex.replace(/^0x/, ""), "hex");
  const parsed = parseSolidityMetadata(hex);
  return {
    rawFile,
    byteLength: bytes.length,
    sha256: sha256(bytes),
    keccak256: keccak256(hex),
    executableByteLength: parsed.executable.length,
    executableSha256: sha256(parsed.executable),
    executableKeccak256: keccak256(`0x${parsed.executable.toString("hex")}`),
    metadata: parsed.evidence
  };
}

function extractPushSet(buffer, width) {
  const values = new Set();
  for (let index = 0; index < buffer.length; index++) {
    const opcode = buffer[index];
    if (opcode >= 0x60 && opcode <= 0x7f) {
      const length = opcode - 0x5f;
      if (length === width && index + length < buffer.length) values.add(`0x${buffer.subarray(index + 1, index + 1 + length).toString("hex")}`);
      index += length;
    }
  }
  return [...values].sort();
}

function compareBytes(target, sibling) {
  const minimum = Math.min(target.length, sibling.length);
  let prefix = 0;
  while (prefix < minimum && target[prefix] === sibling[prefix]) prefix++;
  let suffix = 0;
  while (suffix < minimum - prefix && target[target.length - 1 - suffix] === sibling[sibling.length - 1 - suffix]) suffix++;
  let positionalMatches = 0;
  let firstDiff = null;
  let lastDiff = null;
  for (let index = 0; index < minimum; index++) {
    if (target[index] === sibling[index]) positionalMatches++;
    else {
      if (firstDiff === null) firstDiff = index;
      lastDiff = index;
    }
  }
  if (target.length !== sibling.length) lastDiff = Math.max(target.length, sibling.length) - 1;
  let bestAlignment = { offset: 0, matches: positionalMatches, overlap: minimum };
  for (let offset = -128; offset <= 128; offset++) {
    let matches = 0;
    let overlap = 0;
    for (let targetIndex = Math.max(0, offset); targetIndex < Math.min(target.length, sibling.length + offset); targetIndex++) {
      const siblingIndex = targetIndex - offset;
      overlap++;
      if (target[targetIndex] === sibling[siblingIndex]) matches++;
    }
    if (matches > bestAlignment.matches) bestAlignment = { offset, matches, overlap };
  }
  return {
    targetBytes: target.length,
    siblingBytes: sibling.length,
    lengthDeltaBytes: target.length - sibling.length,
    exact: target.equals(sibling),
    firstDiffByteIndex: firstDiff,
    lastDiffByteIndex: lastDiff,
    commonPrefixBytes: prefix,
    commonSuffixBytes: suffix,
    positionalByteMatchCount: positionalMatches,
    positionalByteMatchRatio: Number((positionalMatches / Math.max(target.length, sibling.length)).toFixed(12)),
    singleContiguousInsertionOrDeletionExplainsDifference: prefix + suffix === minimum,
    boundedBestOffsetAlignment: { ...bestAlignment, ratioOverOverlap: bestAlignment.overlap ? Number((bestAlignment.matches / bestAlignment.overlap).toFixed(12)) : null }
  };
}

function canonicalType(input) {
  if (!input.type.startsWith("tuple")) return input.type;
  const suffix = input.type.slice("tuple".length);
  return `(${(input.components || []).map(canonicalType).join(",")})${suffix}`;
}

function abiSurface(abi) {
  const functions = [];
  const events = [];
  for (const item of abi || []) {
    if (item.type === "function") {
      const signature = `${item.name}(${(item.inputs || []).map(canonicalType).join(",")})`;
      functions.push({ signature, selector: id(signature).slice(0, 10) });
    }
    if (item.type === "event") {
      const signature = `${item.name}(${(item.inputs || []).map(canonicalType).join(",")})`;
      events.push({ signature, topic0: id(signature) });
    }
  }
  return {
    functions: functions.sort((a, b) => a.signature.localeCompare(b.signature)),
    events: events.sort((a, b) => a.signature.localeCompare(b.signature))
  };
}

async function firstCodeBlock(address, high) {
  let low = 0;
  let upper = high;
  while (low < upper) {
    const mid = Math.floor((low + upper) / 2);
    const code = await rpc("eth_getCode", [address, hexBlock(mid)]);
    if (code === "0x") low = mid + 1;
    else upper = mid;
  }
  const [atFirst, beforeFirst] = await Promise.all([
    rpc("eth_getCode", [address, hexBlock(low)]),
    low > 0 ? rpc("eth_getCode", [address, hexBlock(low - 1)]) : Promise.resolve("0x")
  ]);
  return { firstCodeBlock: low, codePresentAtFirst: atFirst !== "0x", codeAbsentImmediatelyBefore: beforeFirst === "0x" };
}

async function explorerRecord(address) {
  const [v1, v2] = await Promise.all([
    fetchJson(`${EXPLORER_V1}?module=contract&action=getsourcecode&address=${address}`),
    fetchJson(`${EXPLORER_V2}${address}`)
  ]);
  const row = Array.isArray(v1.result) ? v1.result[0] || {} : {};
  const sourceCode = row.SourceCode || v2.source_code || "";
  let abi = [];
  try { abi = typeof row.ABI === "string" && row.ABI.startsWith("[") ? JSON.parse(row.ABI) : (v2.abi || []); } catch {}
  const additionalSources = (v2.additional_sources || []).map((source) => ({
    fileName: source.file_path || source.file_name || source.fileName || source.name || null,
    content: source.source_code || source.sourceCode || source.content || ""
  })).filter((source) => source.fileName && source.content);
  const compilerSettings = v2.compiler_settings || row.CompilerSettings || null;
  return {
    sourceCode,
    abi,
    additionalSources,
    compilerSettings,
    sanitized: {
      address,
      verified: Boolean(sourceCode),
      contractName: row.ContractName || v2.name || null,
      sourceFile: row.FileName || v2.file_path || null,
      compilerVersion: row.CompilerVersion || v2.compiler_version || null,
      optimizationUsed: row.OptimizationUsed ?? v2.optimization_enabled ?? null,
      optimizationRuns: row.OptimizationRuns ?? v2.optimization_runs ?? null,
      sourceCodeSha256: sourceCode ? sha256(Buffer.from(sourceCode)) : null,
      sourceCodeBytes: Buffer.byteLength(sourceCode),
      abiSha256: abi.length ? sha256(Buffer.from(JSON.stringify(abi))) : null,
      abiEntries: abi.length,
      compilerSettingsSha256: compilerSettings ? sha256(Buffer.from(JSON.stringify(compilerSettings))) : null,
      additionalSourceCount: additionalSources.length,
      additionalSources: additionalSources.map((source) => ({ fileName: source.fileName, sha256: sha256(Buffer.from(source.content)), bytes: Buffer.byteLength(source.content) }))
    }
  };
}

function readVarint(buffer, start = 0) {
  let value = 0n;
  let shift = 0n;
  let offset = start;
  while (offset < buffer.length && offset - start < 10) {
    const byte = buffer[offset++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Varint exceeds safe integer range");
      return { value: Number(value), offset };
    }
    shift += 7n;
  }
  throw new Error("Invalid or truncated varint");
}

function parseProtoFields(buffer) {
  const fields = [];
  let offset = 0;
  while (offset < buffer.length) {
    const key = readVarint(buffer, offset);
    offset = key.offset;
    const number = key.value >>> 3;
    const wire = key.value & 7;
    if (wire === 0) {
      const decoded = readVarint(buffer, offset);
      fields.push({ number, wire, value: decoded.value });
      offset = decoded.offset;
    } else if (wire === 1) {
      if (offset + 8 > buffer.length) throw new Error("Truncated fixed64 field");
      fields.push({ number, wire, value: buffer.subarray(offset, offset + 8) });
      offset += 8;
    } else if (wire === 2) {
      const length = readVarint(buffer, offset);
      offset = length.offset;
      if (offset + length.value > buffer.length) throw new Error("Truncated length-delimited field");
      fields.push({ number, wire, value: buffer.subarray(offset, offset + length.value) });
      offset += length.value;
    } else if (wire === 5) {
      if (offset + 4 > buffer.length) throw new Error("Truncated fixed32 field");
      fields.push({ number, wire, value: buffer.subarray(offset, offset + 4) });
      offset += 4;
    } else throw new Error(`Unsupported protobuf wire type ${wire}`);
  }
  return fields;
}

function parseCidBytes(buffer, start = 0) {
  const first = readVarint(buffer, start);
  let version;
  let codec;
  let multihashCode;
  let digestLength;
  let offset;
  if (first.value === 1) {
    version = 1;
    const codecDecoded = readVarint(buffer, first.offset);
    codec = codecDecoded.value;
    const hashCode = readVarint(buffer, codecDecoded.offset);
    multihashCode = hashCode.value;
    const hashLength = readVarint(buffer, hashCode.offset);
    digestLength = hashLength.value;
    offset = hashLength.offset;
  } else {
    version = 0;
    codec = 0x70;
    multihashCode = first.value;
    const hashLength = readVarint(buffer, first.offset);
    digestLength = hashLength.value;
    offset = hashLength.offset;
  }
  if (offset + digestLength > buffer.length) throw new Error("Truncated CID multihash digest");
  const end = offset + digestLength;
  return { version, codec, multihashCode, digestLength, digest: buffer.subarray(offset, end), bytes: buffer.subarray(start, end), offset: end };
}

function base32Encode(buffer) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

function cidBytesToString(bytes) {
  const parsed = parseCidBytes(bytes);
  return parsed.version === 0 ? base58Encode(parsed.bytes) : `b${base32Encode(parsed.bytes)}`;
}

function parsePbNode(block) {
  const fields = parseProtoFields(block);
  const data = fields.find((field) => field.number === 1 && field.wire === 2)?.value || null;
  const links = fields.filter((field) => field.number === 2 && field.wire === 2).map((field) => {
    const linkFields = parseProtoFields(field.value);
    return {
      hash: linkFields.find((item) => item.number === 1 && item.wire === 2)?.value || null,
      name: linkFields.find((item) => item.number === 2 && item.wire === 2)?.value?.toString("utf8") || "",
      totalSize: linkFields.find((item) => item.number === 3 && item.wire === 0)?.value ?? null
    };
  });
  return { data, links };
}

function parseUnixFsData(data) {
  if (!data) throw new Error("DAG-PB node lacks UnixFS Data");
  const fields = parseProtoFields(data);
  const type = fields.find((field) => field.number === 1 && field.wire === 0)?.value;
  const inlineData = fields.find((field) => field.number === 2 && field.wire === 2)?.value || Buffer.alloc(0);
  const fileSize = fields.find((field) => field.number === 3 && field.wire === 0)?.value ?? null;
  return { type, inlineData, fileSize };
}

function parseCar(bytes) {
  const headerLength = readVarint(bytes, 0);
  let offset = headerLength.offset + headerLength.value;
  if (offset > bytes.length) throw new Error("Truncated CAR header");
  const blocks = new Map();
  while (offset < bytes.length) {
    const sectionLength = readVarint(bytes, offset);
    offset = sectionLength.offset;
    if (sectionLength.value === 0) continue;
    const sectionEnd = offset + sectionLength.value;
    if (sectionEnd > bytes.length) throw new Error("Truncated CAR block section");
    const cid = parseCidBytes(bytes, offset);
    const block = bytes.subarray(cid.offset, sectionEnd);
    blocks.set(cid.digest.toString("hex"), { cid, block });
    offset = sectionEnd;
  }
  return blocks;
}

async function fetchIpfsClass(cid, suffix, accept, timeout = 25000) {
  const responses = await Promise.all(IPFS_GATEWAYS.map(async (gateway) => {
    try {
      const response = await fetch(`${gateway}${cid}${suffix}`, { headers: { accept, "user-agent": "defensive-readonly-audit" }, signal: AbortSignal.timeout(timeout) });
      if (!response.ok) return null;
      const bytes = Buffer.from(await response.arrayBuffer());
      return bytes.length ? bytes : null;
    } catch { return null; }
  }));
  return responses.filter(Boolean);
}

function attemptSummary(attempted, responses, extra = {}) {
  const hashes = [...new Set(responses.map((bytes) => sha256(bytes)))].sort();
  return { attempted, successfulResponses: responses.length, uniqueResponseSha256: hashes, ...extra };
}

async function boundedIpfsFetch(cid, expectedDigest, expectedPayloadKeccak = null) {
  const [rawResponses, carResponses, decodedResponses] = await Promise.all([
    fetchIpfsClass(cid, "?format=raw", "application/vnd.ipld.raw"),
    fetchIpfsClass(cid, "?format=car&dag-scope=all", "application/vnd.ipld.car"),
    fetchIpfsClass(cid, "", "application/octet-stream")
  ]);
  const verifiedRawBlocks = expectedDigest ? rawResponses.filter((bytes) => sha256(bytes) === expectedDigest) : [];
  const verifiedCars = [];
  let parsableCarCount = 0;
  for (const bytes of carResponses) {
    try {
      const blocks = parseCar(bytes);
      parsableCarCount++;
      const root = expectedDigest ? blocks.get(expectedDigest) : null;
      if (root && root.cid.multihashCode === 0x12 && sha256(root.block) === expectedDigest) verifiedCars.push({ bytes, blocks, root });
    } catch {}
  }
  const chosenCar = verifiedCars[0] || null;
  const rootBlock = verifiedRawBlocks[0] || chosenCar?.root.block || null;
  const rootCodec = chosenCar?.root.cid.codec ?? 0x70;
  const blockMap = chosenCar?.blocks || new Map();
  const linkedAttempts = [];
  let unixfsPayload = null;
  let unixfs = null;
  const walk = async (block, codec, depth = 0) => {
    if (depth > 4) throw new Error("UnixFS depth bound exceeded");
    if (codec === 0x55) return block;
    if (codec !== 0x70) throw new Error(`Unsupported IPLD codec ${codec}`);
    const node = parsePbNode(block);
    const data = parseUnixFsData(node.data);
    if (![0, 2].includes(data.type)) throw new Error(`Unsupported UnixFS node type ${data.type}`);
    if (node.links.length > 32) throw new Error("UnixFS link bound exceeded");
    const parts = [data.inlineData];
    for (const link of node.links) {
      if (!link.hash) throw new Error("UnixFS link lacks CID");
      const childCid = parseCidBytes(link.hash);
      const digest = childCid.digest.toString("hex");
      let child = blockMap.get(digest)?.block || null;
      if (!child) {
        const childResponses = await fetchIpfsClass(cidBytesToString(link.hash), "?format=raw", "application/vnd.ipld.raw");
        const verified = childCid.multihashCode === 0x12 ? childResponses.find((bytes) => sha256(bytes) === digest) || null : null;
        linkedAttempts.push(attemptSummary(IPFS_GATEWAYS.length, childResponses, { cidDigest: digest, verifiedSerializedBlock: Boolean(verified) }));
        child = verified;
      }
      if (!child) throw new Error("Linked UnixFS block unavailable or unverified");
      parts.push(await walk(child, childCid.codec, depth + 1));
    }
    const payload = Buffer.concat(parts);
    if (payload.length > 5_000_000) throw new Error("UnixFS payload bound exceeded");
    return payload;
  };
  if (rootBlock) {
    try {
      unixfsPayload = await walk(rootBlock, rootCodec);
      const rootNode = parsePbNode(rootBlock);
      const rootData = parseUnixFsData(rootNode.data);
      unixfs = { rootCodec, rootUnixFsType: rootData.type, rootInlineBytes: rootData.inlineData.length, rootLinkCount: rootNode.links.length, declaredFileSize: rootData.fileSize, extractedBytes: unixfsPayload.length, extractedSha256: sha256(unixfsPayload), extractedKeccak256: keccak256(`0x${unixfsPayload.toString("hex")}`) };
    } catch {}
  }
  const decodedComparisons = unixfsPayload ? decodedResponses.map((bytes) => bytes.equals(unixfsPayload)) : [];
  const matchingDecoded = decodedResponses.filter((bytes) => unixfsPayload && bytes.equals(unixfsPayload));
  const expectedKeccakDecoded = expectedPayloadKeccak ? decodedResponses.find((bytes) => lower(keccak256(`0x${bytes.toString("hex")}`)) === lower(expectedPayloadKeccak)) || null : null;
  const payload = unixfsPayload || expectedKeccakDecoded;
  const rootBlockVerified = Boolean(rootBlock);
  return {
    attemptedGatewayCount: IPFS_GATEWAYS.length,
    recovered: Boolean(payload),
    status: unixfsPayload ? "raw-dag-pb-verified-and-unixfs-extracted" : (expectedKeccakDecoded ? "decoded-payload-recovered-and-metadata-keccak-verified" : "not-recovered-after-bounded-public-attempts"),
    bytes: payload,
    rootBlockBytes: rootBlock,
    rootBlockVerified,
    unixfsExtracted: Boolean(unixfsPayload),
    rootSerializedBlockSha256: rootBlock ? sha256(rootBlock) : null,
    unixfs,
    attempts: {
      rawDagPbBlock: attemptSummary(IPFS_GATEWAYS.length, rawResponses, { serializedBlockDigestMatches: verifiedRawBlocks.length, status: verifiedRawBlocks.length ? "verified" : "no-verified-root-block" }),
      car: attemptSummary(IPFS_GATEWAYS.length, carResponses, { parsableCars: parsableCarCount, rootBlockDigestMatches: verifiedCars.length, status: verifiedCars.length ? "verified-root-in-car" : "no-verified-root-in-car" }),
      decodedGatewayFile: attemptSummary(IPFS_GATEWAYS.length, decodedResponses, { matchingExtractedUnixFsPayloads: matchingDecoded.length, mismatchingExtractedUnixFsPayloads: decodedComparisons.filter((match) => !match).length, expectedPayloadKeccakMatches: expectedPayloadKeccak ? (expectedKeccakDecoded ? 1 : 0) : null, status: decodedResponses.length ? (unixfsPayload ? "cross-checked-against-extracted-unixfs" : "received-but-not-cid-root-verified") : "no-decoded-payload" }),
      linkedRawDagPbBlocks: linkedAttempts
    },
    qualification: "CIDv0 SHA-256 is checked only against the serialized DAG-PB root block (direct raw block or CAR member), never against decoded gateway file bytes. Decoded payloads are cross-checked against extracted UnixFS bytes when both exist."
  };
}

function ipfsCidFromUrl(url) {
  const value = String(url || "");
  const match = value.match(/^(?:ipfs:\/\/(?:ipfs\/)?|dweb:\/?ipfs\/)([^/?#]+)/i);
  return match ? match[1] : null;
}

function compileRecoveredTarget(compilerFile, metadata, sourceContents, targetExecutable, matrix, targetFull = null, targetCreationInput = null) {
  const attempts = [];
  let anyCompiled = false;
  let anyExact = false;
  let anyFullExact = false;
  let anyCreationExact = false;
  try {
    delete require.cache[require.resolve(compilerFile)];
    const soljson = require(compilerFile);
    const compile = soljson.cwrap("solidity_compile", "string", ["string", "number"]);
    const compilationTarget = metadata.settings?.compilationTarget || {};
    const targetEntry = Object.entries(compilationTarget)[0] || [];
    for (const row of matrix) {
      const settings = JSON.parse(JSON.stringify(metadata.settings || {}));
      delete settings.compilationTarget;
      if (!row.useMetadataSettings) settings.optimizer = { enabled: row.optimizerEnabled, runs: row.runs };
      settings.outputSelection = { "*": { "*": ["evm.bytecode.object", "evm.deployedBytecode.object"] } };
      const input = { language: metadata.language || "Solidity", sources: Object.fromEntries(Object.entries(sourceContents).map(([name, content]) => [name, { content }])), settings };
      try {
        const output = JSON.parse(compile(JSON.stringify(input), 0));
        const fatalErrors = (output.errors || []).filter((error) => error.severity === "error").map((error) => error.type || "CompilerError");
        const contractOutput = targetEntry.length === 2 ? output.contracts?.[targetEntry[0]]?.[targetEntry[1]] : null;
        const object = contractOutput?.evm?.deployedBytecode?.object || null;
        const creationObject = contractOutput?.evm?.bytecode?.object || null;
        let executableExact = null;
        let fullRuntimeExact = null;
        let creationArtifactExact = null;
        let creationArtifactPrefixOfInput = null;
        let constructorSuffixBytes = null;
        let outputBytes = 0;
        let creationOutputBytes = 0;
        if (object) {
          anyCompiled = true;
          const parsed = parseSolidityMetadata(`0x${object}`);
          outputBytes = parsed.full.length;
          executableExact = parsed.executable.equals(targetExecutable);
          fullRuntimeExact = targetFull ? parsed.full.equals(targetFull) : null;
          if (executableExact) anyExact = true;
          if (fullRuntimeExact) anyFullExact = true;
        }
        if (creationObject && targetCreationInput) {
          const compiledCreation = Buffer.from(creationObject, "hex");
          creationOutputBytes = compiledCreation.length;
          creationArtifactExact = compiledCreation.equals(targetCreationInput);
          creationArtifactPrefixOfInput = targetCreationInput.subarray(0, compiledCreation.length).equals(compiledCreation);
          constructorSuffixBytes = creationArtifactPrefixOfInput ? targetCreationInput.length - compiledCreation.length : null;
          if (creationArtifactExact) anyCreationExact = true;
        }
        attempts.push({ useMetadataSettings: Boolean(row.useMetadataSettings), optimizerEnabled: settings.optimizer?.enabled ?? null, runs: settings.optimizer?.runs ?? null, compiled: Boolean(object), outputBytes, creationOutputBytes, executableExact, fullRuntimeExact, creationArtifactExact, creationArtifactPrefixOfInput, constructorSuffixBytes, fatalErrorTypes: [...new Set(fatalErrors)].sort() });
      } catch (error) {
        attempts.push({ optimizerEnabled: row.optimizerEnabled, runs: row.runs, compiled: false, outputBytes: 0, executableExact: null, fatalErrorTypes: [error.name || "CompileInvocationError"] });
      }
    }
  } catch (error) {
    attempts.push({ compilerLoadFailed: true, errorClass: error.name || "CompilerLoadError" });
  }
  return { attempts, localBuildReproduced: anyCompiled, executableRuntimeExact: anyCompiled ? anyExact : false, fullRuntimeExact: targetFull && anyCompiled ? anyFullExact : null, creationArtifactExact: targetCreationInput && anyCompiled ? anyCreationExact : null };
}

async function sourcifyProbe(address) {
  const paths = [
    `https://sourcify.dev/server/v2/contract/34443/${address}`,
    `https://sourcify.dev/server/repository/contracts/full_match/34443/${address}/metadata.json`,
    `https://sourcify.dev/server/repository/contracts/partial_match/34443/${address}/metadata.json`
  ];
  const attempts = await Promise.all(paths.map(async (url) => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
      return response.ok;
    } catch { return false; }
  }));
  return { attempts: paths.length, anySourceRecordRecovered: attempts.some(Boolean), status: attempts.some(Boolean) ? "public-record-recovered" : "no-public-record-after-bounded-probes" };
}

async function acquireCompiler(nextSourceDir) {
  const compilerFile = path.join(nextSourceDir, "compiler", SOLJSON_NAME);
  let bytes = null;
  const cached = path.join(SOURCE_DIR, "compiler", SOLJSON_NAME);
  if (fs.existsSync(cached)) bytes = fs.readFileSync(cached);
  if (!bytes) {
    const fetched = await fetchBufferCandidates(SOLJSON_URLS);
    bytes = fetched?.bytes || null;
  }
  let list = null;
  for (const url of SOLJSON_LIST_URLS) {
    try { list = await fetchJson(url, 60000); break; } catch {}
  }
  const build = (list?.builds || []).find((entry) => entry.path === SOLJSON_NAME || entry.longVersion === "0.6.12+commit.27d51765") || null;
  const actualKeccak = bytes ? keccak256(`0x${bytes.toString("hex")}`) : null;
  const expectedKeccak = build?.keccak256 || null;
  if (bytes) write(compilerFile, bytes);
  return {
    acquired: Boolean(bytes),
    file: bytes ? relative(compilerFile).replace(`${path.basename(nextSourceDir)}/`, `${path.basename(SOURCE_DIR)}/`) : null,
    byteLength: bytes?.length || 0,
    sha256: bytes ? sha256(bytes) : null,
    keccak256: actualKeccak,
    releaseListEntryRecovered: Boolean(build),
    expectedKeccak256: expectedKeccak,
    releaseListHashMatches: Boolean(bytes && expectedKeccak && lower(actualKeccak) === lower(expectedKeccak)),
    version: "0.6.12+commit.27d51765"
  };
}

async function fetchPublicCandidates(nextSourceDir) {
  const officialSources = [];
  for (const commit of [OFFICIAL_INITIAL_COMMIT, OFFICIAL_CURRENT_COMMIT]) {
    const content = await fetchText(`https://raw.githubusercontent.com/layerbank-foundation/v2-contracts/${commit}/markets/LToken.sol`);
    const file = path.join(nextSourceDir, "candidate-sources", `official-${commit.slice(0, 12)}`, "markets", "LToken.sol");
    write(file, content);
    officialSources.push({ commit, file: relative(file).replace(`${path.basename(nextSourceDir)}/`, `${path.basename(SOURCE_DIR)}/`), sha256: sha256(Buffer.from(content)), bytes: Buffer.byteLength(content), containsRegister: content.includes("register("), constructorEmpty: /constructor\s*\(\s*\)\s*public\s*\{\s*\}/s.test(content) });
  }
  const [communityAbiText, communityManifest] = await Promise.all([
    fetchText(`https://raw.githubusercontent.com/layerbankgoldsky/layerbank-subgraph/${COMMUNITY_COMMIT}/abis/LToken.json`),
    fetchText(`https://raw.githubusercontent.com/layerbankgoldsky/layerbank-subgraph/${COMMUNITY_COMMIT}/subgraph.yaml`)
  ]);
  const communityAbiFile = path.join(nextSourceDir, "candidate-sources", "community-subgraph", "LToken.json");
  const communityManifestFile = path.join(nextSourceDir, "candidate-sources", "community-subgraph", "subgraph.yaml");
  write(communityAbiFile, communityAbiText);
  write(communityManifestFile, communityManifest);
  return {
    stablePublicReferences: {
      officialDocsGitHubPage: "https://docs.layerbank.finance/other-information/github",
      officialRepositoryCurrentCommit: `https://github.com/layerbank-foundation/v2-contracts/commit/${OFFICIAL_CURRENT_COMMIT}`,
      officialRepositoryInitialCommit: `https://github.com/layerbank-foundation/v2-contracts/commit/${OFFICIAL_INITIAL_COMMIT}`,
      communityInfrastructureCommit: `https://github.com/layerbankgoldsky/layerbank-subgraph/commit/${COMMUNITY_COMMIT}`
    },
    official: {
      docsIdentifiesRepository: true,
      repository: "layerbank-foundation/v2-contracts",
      sources: officialSources,
      qualification: "Official LayerBank docs identify this public repository. The two pinned LToken candidates have empty constructors and no FeeSharing register call, so neither is promoted as exact target source."
    },
    communityInfrastructure: {
      repository: "layerbankgoldsky/layerbank-subgraph",
      commit: COMMUNITY_COMMIT,
      classification: "community/infrastructure attribution only; not official core-source provenance",
      lTokenAbi: { file: relative(communityAbiFile).replace(`${path.basename(nextSourceDir)}/`, `${path.basename(SOURCE_DIR)}/`), sha256: sha256(Buffer.from(communityAbiText)), bytes: Buffer.byteLength(communityAbiText) },
      manifest: { file: relative(communityManifestFile).replace(`${path.basename(nextSourceDir)}/`, `${path.basename(SOURCE_DIR)}/`), sha256: sha256(Buffer.from(communityManifest)), bytes: Buffer.byteLength(communityManifest) }
    }
  };
}

function recursiveFileRecords(directory) {
  const output = [];
  const visit = (current) => {
    for (const name of fs.readdirSync(current).sort()) {
      const file = path.join(current, name);
      const stat = fs.statSync(file);
      if (stat.isDirectory()) visit(file);
      else output.push(record(file));
    }
  };
  visit(directory);
  return output;
}

async function main() {
  cleanStaleNextTrees();
  const predecessor = { raw: record(STEP11_RAW), manifest: record(STEP11_MANIFEST), runId: require(STEP11_RAW).runId };
  if (predecessor.runId !== "free-step11-4c7c42eff9c375e5b508") throw new Error("Step11 predecessor mismatch");
  const nextSourceDir = `${SOURCE_DIR}.next-${process.pid}`;
  fs.rmSync(nextSourceDir, { recursive: true, force: true });
  fs.mkdirSync(nextSourceDir, { recursive: true });

  const [tx, receipt, trace, block, firstCode, targetExplorer, targetSourcify, compiler, publicCandidates] = await Promise.all([
    rpc("eth_getTransactionByHash", [DEPLOYMENT_TX_EXPECTED]),
    rpc("eth_getTransactionReceipt", [DEPLOYMENT_TX_EXPECTED]),
    rpc("debug_traceTransaction", [DEPLOYMENT_TX_EXPECTED, { tracer: "callTracer", timeout: "30s" }]),
    rpc("eth_getBlockByNumber", [hexBlock(CREATION_BLOCK_EXPECTED), false]),
    firstCodeBlock(TARGET, CREATION_BLOCK_EXPECTED),
    explorerRecord(TARGET),
    sourcifyProbe(TARGET),
    acquireCompiler(nextSourceDir),
    fetchPublicCandidates(nextSourceDir)
  ]);

  if (!tx || !receipt || !block) throw new Error("Deployment evidence unavailable");
  const targetRuntimeHex = {};
  const siblingRuntimeHex = { [LETH]: {}, [LMBTC]: {} };
  for (const blockNumber of BLOCKS) {
    targetRuntimeHex[blockNumber] = await rpc("eth_getCode", [TARGET, hexBlock(blockNumber)]);
    for (const sibling of [LETH, LMBTC]) siblingRuntimeHex[sibling][blockNumber] = await rpc("eth_getCode", [sibling, hexBlock(blockNumber)]);
  }
  const [ownerCallCreationRaw, ownerCallPinRaw] = await Promise.all([
    rpc("eth_call", [{ to: TARGET, data: ownerIface.encodeFunctionData("owner") }, hexBlock(CREATION_BLOCK_EXPECTED)]),
    rpc("eth_call", [{ to: TARGET, data: ownerIface.encodeFunctionData("owner") }, hexBlock(FIXED_PIN)])
  ]);
  const ownerCallCreation = lower(ownerIface.decodeFunctionResult("owner", ownerCallCreationRaw)[0]);
  const ownerCallPin = lower(ownerIface.decodeFunctionResult("owner", ownerCallPinRaw)[0]);

  const creationInputFile = path.join(nextSourceDir, "raw", "target-creation-input.hex");
  write(creationInputFile, `${tx.input}\n`);
  const targetRuntimeRecords = {};
  for (const blockNumber of BLOCKS) {
    const file = path.join(nextSourceDir, "raw", `target-runtime-${blockNumber}.hex`);
    write(file, `${targetRuntimeHex[blockNumber]}\n`);
    targetRuntimeRecords[blockNumber] = bytecodeRecord(targetRuntimeHex[blockNumber], `${SOURCE_REL}/raw/${path.basename(file)}`);
  }
  const siblingRuntimeRecords = {};
  for (const sibling of [LETH, LMBTC]) {
    siblingRuntimeRecords[sibling] = {};
    const label = sibling === LETH ? "leth" : "lmbtc";
    for (const blockNumber of BLOCKS) {
      const file = path.join(nextSourceDir, "raw", `${label}-runtime-${blockNumber}.hex`);
      write(file, `${siblingRuntimeHex[sibling][blockNumber]}\n`);
      siblingRuntimeRecords[sibling][blockNumber] = bytecodeRecord(siblingRuntimeHex[sibling][blockNumber], `${SOURCE_REL}/raw/${path.basename(file)}`);
    }
  }

  const creationParsed = parseSolidityMetadata(tx.input);
  const creationRecord = bytecodeRecord(tx.input, `${SOURCE_REL}/raw/${path.basename(creationInputFile)}`);
  const targetCreationRuntime = targetRuntimeRecords[CREATION_BLOCK_EXPECTED];
  const targetMetadata = targetCreationRuntime.metadata;
  const ipfsFetch = await boundedIpfsFetch(targetMetadata.ipfsCidV0, targetMetadata.ipfsDigestHex);
  let recoveredMetadata = null;
  let recoveredSources = [];
  const recoveredSourceContents = {};
  if (ipfsFetch.rootBlockVerified && ipfsFetch.unixfsExtracted && ipfsFetch.bytes) {
    if (ipfsFetch.rootBlockBytes) write(path.join(nextSourceDir, "ipfs", "metadata-root.dag-pb"), ipfsFetch.rootBlockBytes);
    const metadataFile = path.join(nextSourceDir, "ipfs", "metadata.json");
    write(metadataFile, ipfsFetch.bytes);
    try {
      const candidate = JSON.parse(ipfsFetch.bytes.toString("utf8"));
      if (candidate && candidate.language === "Solidity" && candidate.settings && candidate.sources && typeof candidate.sources === "object") recoveredMetadata = candidate;
    } catch {}
    if (recoveredMetadata?.sources) {
      write(path.join(nextSourceDir, "ipfs", "standard-json-settings.json"), recoveredMetadata.settings);
      for (const [sourceName, sourceRef] of Object.entries(recoveredMetadata.sources)) {
        const expected = (sourceRef.keccak256 || "").toLowerCase();
        const declaredUrls = sourceRef.urls || [];
        const cids = [...new Set(declaredUrls.map(ipfsCidFromUrl).filter(Boolean))];
        let fetched = null;
        let selectedCid = null;
        for (const cid of cids) {
          const candidate = await boundedIpfsFetch(cid, null, expected);
          if (candidate.bytes && lower(keccak256(`0x${candidate.bytes.toString("hex")}`)) === lower(expected)) {
            fetched = candidate;
            selectedCid = cid;
            break;
          }
        }
        if (!fetched?.bytes) {
          recoveredSources.push({ sourceName, recovered: false, declaredUrlCount: declaredUrls.length, supportedIpfsUrlCount: cids.length, expectedKeccak256: expected || null, status: cids.length ? "not-recovered-or-keccak-mismatch" : "no-supported-ipfs-url" });
          continue;
        }
        const actualKeccak = keccak256(`0x${fetched.bytes.toString("hex")}`);
        const file = path.join(nextSourceDir, "ipfs", "sources", safeName(sourceName));
        write(file, fetched.bytes);
        recoveredSourceContents[sourceName] = fetched.bytes.toString("utf8");
        recoveredSources.push({ sourceName, recovered: true, file: relative(file).replace(`${path.basename(nextSourceDir)}/`, `${path.basename(SOURCE_DIR)}/`), sha256: sha256(fetched.bytes), keccak256: actualKeccak, expectedKeccak256: expected || null, keccakMatches: Boolean(expected && lower(actualKeccak) === lower(expected)), bytes: fetched.bytes.length, declaredUrlCount: declaredUrls.length, supportedIpfsUrlCount: cids.length, selectedCidSha256: sha256(Buffer.from(selectedCid)), retrieval: { status: fetched.status, rootBlockVerified: fetched.rootBlockVerified, unixfsExtracted: fetched.unixfsExtracted, attempts: fetched.attempts } });
      }
    }
  }

  const [lethExplorer, lmbtcExplorer] = await Promise.all([explorerRecord(LETH), explorerRecord(LMBTC)]);
  const siblingExplorers = { [LETH]: lethExplorer, [LMBTC]: lmbtcExplorer };
  const siblingSourceSummaries = {};
  for (const sibling of [LETH, LMBTC]) {
    const label = sibling === LETH ? "leth" : "lmbtc";
    const explorer = siblingExplorers[sibling];
    const mainFile = path.join(nextSourceDir, "siblings", label, "contracts", "markets", "LToken.sol");
    const abiFile = path.join(nextSourceDir, "siblings", label, "abi.json");
    const compilerSettingsFile = path.join(nextSourceDir, "siblings", label, "compiler-settings.json");
    write(mainFile, explorer.sourceCode);
    write(abiFile, explorer.abi);
    if (explorer.compilerSettings) write(compilerSettingsFile, explorer.compilerSettings);
    for (const additional of explorer.additionalSources) write(path.join(nextSourceDir, "siblings", label, "additional-sources", safeName(additional.fileName)), additional.content);
    const imports = [...explorer.sourceCode.matchAll(/import\s+["']([^"']+)["'];/g)].map((match) => match[1]);
    const availableNames = new Set(explorer.additionalSources.map((source) => source.fileName));
    const mainSourcePath = explorer.sanitized.sourceFile || "contracts/markets/LToken.sol";
    const resolvedImports = imports.map((importName) => importName.startsWith("@") ? importName : path.posix.normalize(path.posix.join(path.posix.dirname(mainSourcePath), importName)));
    const unresolvedImports = resolvedImports.filter((importName) => !availableNames.has(importName));
    siblingSourceSummaries[sibling] = {
      ...explorer.sanitized,
      mainSourceFile: `${SOURCE_REL}/siblings/${label}/contracts/markets/LToken.sol`,
      abiFile: `${SOURCE_REL}/siblings/${label}/abi.json`,
      compilerSettingsFile: explorer.compilerSettings ? `${SOURCE_REL}/siblings/${label}/compiler-settings.json` : null,
      importCount: imports.length,
      imports,
      resolvedImports,
      unresolvedImports,
      explorerReturnedSourceSetCompleteForLocalBuild: unresolvedImports.length === 0,
      explorerQualification: "Explorer-returned verified source/ABI and compiler settings are authoritative for this sibling address; no local build reproduction is inferred."
    };
  }

  const targetExecutable = parseSolidityMetadata(targetRuntimeHex[FIXED_PIN]).executable;
  const lethExecutable = parseSolidityMetadata(siblingRuntimeHex[LETH][FIXED_PIN]).executable;
  const lmbtcExecutable = parseSolidityMetadata(siblingRuntimeHex[LMBTC][FIXED_PIN]).executable;
  const targetPush4 = extractPushSet(targetExecutable, 4);
  const targetPush32 = extractPushSet(targetExecutable, 32);
  const lethPush4 = extractPushSet(lethExecutable, 4);
  const lmbtcPush4 = extractPushSet(lmbtcExecutable, 4);
  const lethPush32 = extractPushSet(lethExecutable, 32);
  const lmbtcPush32 = extractPushSet(lmbtcExecutable, 32);
  const lethSurface = abiSurface(lethExplorer.abi);
  const lmbtcSurface = abiSurface(lmbtcExplorer.abi);
  const abiFunctionsInTarget = lethSurface.functions.every((entry) => targetPush4.includes(entry.selector));
  const abiEventsInTarget = lethSurface.events.every((entry) => targetPush32.includes(entry.topic0));
  const abiEventPresence = lethSurface.events.map((entry) => ({ signature: entry.signature, topic0: entry.topic0, targetDirectPush32: targetPush32.includes(entry.topic0), lethDirectPush32: lethPush32.includes(entry.topic0), lmbtcDirectPush32: lmbtcPush32.includes(entry.topic0) }));
  const comparison = {
    fixedComparisonBlock: FIXED_PIN,
    targetVsLethFull: compareBytes(Buffer.from(targetRuntimeHex[FIXED_PIN].slice(2), "hex"), Buffer.from(siblingRuntimeHex[LETH][FIXED_PIN].slice(2), "hex")),
    targetVsLethExecutable: compareBytes(targetExecutable, lethExecutable),
    targetVsLmbtcFull: compareBytes(Buffer.from(targetRuntimeHex[FIXED_PIN].slice(2), "hex"), Buffer.from(siblingRuntimeHex[LMBTC][FIXED_PIN].slice(2), "hex")),
    targetVsLmbtcExecutable: compareBytes(targetExecutable, lmbtcExecutable),
    siblingExecutableEquality: { exact: lethExecutable.equals(lmbtcExecutable), lethKeccak256: keccak256(`0x${lethExecutable.toString("hex")}`), lmbtcKeccak256: keccak256(`0x${lmbtcExecutable.toString("hex")}`) },
    runtimeImmediateSurface: {
      push4: { targetCount: targetPush4.length, lethCount: lethPush4.length, lmbtcCount: lmbtcPush4.length, targetEqualsLeth: JSON.stringify(targetPush4) === JSON.stringify(lethPush4), targetEqualsLmbtc: JSON.stringify(targetPush4) === JSON.stringify(lmbtcPush4) },
      push32: { targetCount: targetPush32.length, lethCount: lethPush32.length, lmbtcCount: lmbtcPush32.length, targetEqualsLeth: JSON.stringify(targetPush32) === JSON.stringify(lethPush32), targetEqualsLmbtc: JSON.stringify(targetPush32) === JSON.stringify(lmbtcPush32) }
    },
    verifiedSiblingAbiSurface: {
      siblingAbisEqual: JSON.stringify(lethSurface) === JSON.stringify(lmbtcSurface),
      functionCount: lethSurface.functions.length,
      eventCount: lethSurface.events.length,
      everySiblingAbiFunctionSelectorPresentInTargetRuntime: abiFunctionsInTarget,
      everySiblingAbiEventTopicDirectlyPresentInTargetRuntime: abiEventsInTarget,
      directlyPresentAbiEventTopicCount: abiEventPresence.filter((entry) => entry.targetDirectPush32).length,
      abiEventDirectPush32PresenceParityWithBothSiblings: abiEventPresence.every((entry) => entry.targetDirectPush32 === entry.lethDirectPush32 && entry.targetDirectPush32 === entry.lmbtcDirectPush32),
      abiEventPresence
    },
    qualification: "Identical selector/event surfaces and substantial executable similarity establish LToken-family compatibility only. They do not establish exact target source semantics."
  };

  const ownerStorageRaw = await rpc("eth_getStorageAt", [TARGET, "0x0", hexBlock(CREATION_BLOCK_EXPECTED)]);
  const initializedStorageRaw = await rpc("eth_getStorageAt", [TARGET, "0x1", hexBlock(CREATION_BLOCK_EXPECTED)]);
  const registerCalls = (trace?.calls || []).filter((call) => lower(call.to) === FEE_SHARING && call.input?.slice(0, 10).toLowerCase() === registerIface.getFunction("register").selector);
  const registerCall = registerCalls.length === 1 ? registerCalls[0] : null;
  const registerArg = registerCall ? lower(registerIface.decodeFunctionData("register", registerCall.input)[0]) : null;
  const registerNftId = registerCall ? registerIface.decodeFunctionResult("register", registerCall.output)[0].toString() : null;
  const nftTransferLogs = receipt.logs.filter((log) => lower(log.address) === FEE_SHARING && lower(log.topics[0]) === TRANSFER_TOPIC && log.topics.length === 4);
  const nftTransfer = nftTransferLogs.find((log) => lower(`0x${log.topics[1].slice(-40)}`) === ZERO && lower(`0x${log.topics[2].slice(-40)}`) === lower(tx.from) && BigInt(log.topics[3]).toString() === EXPECTED_NFT_ID) || null;
  const ownershipLogs = receipt.logs.filter((log) => lower(log.address) === TARGET && lower(log.topics[0]) === OWNERSHIP_TOPIC);
  const ownershipLog = ownershipLogs.find((log) => log.topics.length === 3 && lower(`0x${log.topics[1].slice(-40)}`) === ZERO && lower(`0x${log.topics[2].slice(-40)}`) === lower(tx.from) && (log.data === "0x" || log.data === "0x0")) || null;
  const registrationDataLog = receipt.logs.find((log) => lower(log.address) === FEE_SHARING && log.data?.length === 194) || null;
  const registrationData = registrationDataLog ? coder.decode(["address", "address", "uint256"], registrationDataLog.data) : null;
  const slot0Decoded = lower(`0x${ownerStorageRaw.slice(-40)}`);
  const slot0EqualsDeployer = slot0Decoded === lower(tx.from);
  const ownershipEvent = ownershipLog ? {
    emitter: lower(ownershipLog.address),
    topic0: lower(ownershipLog.topics[0]),
    previousOwner: lower(`0x${ownershipLog.topics[1].slice(-40)}`),
    newOwner: lower(`0x${ownershipLog.topics[2].slice(-40)}`),
    previousOwnerIsZero: lower(`0x${ownershipLog.topics[1].slice(-40)}`) === ZERO,
    newOwnerEqualsDeployer: lower(`0x${ownershipLog.topics[2].slice(-40)}`) === lower(tx.from),
    dataEmpty: ownershipLog.data === "0x" || ownershipLog.data === "0x0"
  } : null;
  const ownerInitializedToDeployer = slot0EqualsDeployer && ownerCallCreation === lower(tx.from) && Boolean(ownershipEvent?.previousOwnerIsZero && ownershipEvent?.newOwnerEqualsDeployer && ownershipEvent?.dataEmpty);
  const deployment = {
    expectedAssertions: { creationBlock: CREATION_BLOCK_EXPECTED, deploymentTx: DEPLOYMENT_TX_EXPECTED, targetAddress: TARGET },
    transaction: {
      hash: tx.hash,
      blockNumber: Number.parseInt(tx.blockNumber, 16),
      transactionIndex: Number.parseInt(tx.transactionIndex, 16),
      deployer: lower(tx.from),
      to: tx.to,
      creationInput: creationRecord
    },
    block: { hash: block.hash, timestamp: Number.parseInt(block.timestamp, 16), transactionAtIndexMatches: lower(block.transactions[Number.parseInt(tx.transactionIndex, 16)]) === lower(tx.hash) },
    receipt: { status: receipt.status === "0x1", contractAddress: lower(receipt.contractAddress), transactionIndex: Number.parseInt(receipt.transactionIndex, 16), ownershipTransferredLogIndex: ownershipLog ? Number.parseInt(ownershipLog.logIndex, 16) : null, feeSharingNftTransferLogIndex: nftTransfer ? Number.parseInt(nftTransfer.logIndex, 16) : null, registrationDataLogIndex: registrationDataLog ? Number.parseInt(registrationDataLog.logIndex, 16) : null },
    firstCode,
    callTrace: trace ? {
      available: true,
      rootType: trace.type,
      from: lower(trace.from),
      createdAddress: lower(trace.to),
      creationInputMatchesTransaction: lower(trace.input) === lower(tx.input),
      returnedRuntimeMatchesCreationBlockCode: lower(trace.output) === lower(targetRuntimeHex[CREATION_BLOCK_EXPECTED]),
      childCallCount: (trace.calls || []).length,
      registerCall: registerCall ? { type: registerCall.type, from: lower(registerCall.from), to: lower(registerCall.to), selector: registerCall.input.slice(0, 10).toLowerCase(), signature: "register(address)", recipient: registerArg, returnNftId: registerNftId, valueRaw: BigInt(registerCall.value || "0x0").toString(), error: registerCall.error || null } : null
    } : { available: false },
    constructorArgumentSuffix: {
      suffixBytes: null,
      constructorArgumentsAbsentProven: null,
      terminalMetadataCandidateValid: creationParsed.evidence.metadataEndOffset === creationParsed.full.length,
      basis: "Creation input ends in a valid Solidity metadata candidate; the compiled creation-artifact boundary and constructor arguments remain unresolved without an exact target creation build."
    },
    constructorStateAndReceiptFacts: {
      ownerSlot0Raw: ownerStorageRaw,
      ownerSlot0Decoded: slot0Decoded,
      slot0EqualsDeployer,
      ownerGetter: {
        selector: ownerIface.getFunction("owner").selector,
        creationBlock: { blockNumber: CREATION_BLOCK_EXPECTED, raw: ownerCallCreationRaw, decoded: ownerCallCreation, equalsDeployer: ownerCallCreation === lower(tx.from) },
        fixedPin: { blockNumber: FIXED_PIN, raw: ownerCallPinRaw, decoded: ownerCallPin, equalsDeployer: ownerCallPin === lower(tx.from) }
      },
      ownershipTransferredReceipt: {
        matchingLogCount: ownershipLogs.length,
        exactInitializationLogFound: Boolean(ownershipLog),
        event: ownershipEvent,
        qualification: "The owner() selector and OwnershipTransferred(address,address) topic are conventional selector/topic semantics and are not claimed as exact target-source semantics; return bytes, emitter, indexed values, and log placement are RPC/receipt-bound facts."
      },
      ownerInitializedToDeployer,
      slot1Raw: initializedStorageRaw,
      slot1Uint: BigInt(initializedStorageRaw).toString(),
      slot1EqualsOne: BigInt(initializedStorageRaw) === 1n,
      feeSharingAddressEmbeddedInCreationInput: tx.input.toLowerCase().includes(FEE_SHARING.slice(2)),
      registerSelectorEmbeddedInCreationInput: tx.input.toLowerCase().includes(registerIface.getFunction("register").selector.slice(2)),
      registerTraceCallBound: Boolean(registerCall && registerArg === lower(tx.from) && registerNftId === EXPECTED_NFT_ID),
      feeSharingNftTransferToDeployerBound: Boolean(nftTransfer),
      feeSharingNftId: nftTransfer ? BigInt(nftTransfer.topics[3]).toString() : null,
      registrationDataReceiptFact: registrationData ? { target: lower(registrationData[0]), recipient: lower(registrationData[1]), nftId: registrationData[2].toString(), matchesTrace: lower(registrationData[0]) === TARGET && lower(registrationData[1]) === lower(tx.from) && registrationData[2].toString() === EXPECTED_NFT_ID } : null,
      qualification: "slot0EqualsDeployer is a historical storage fact. ownerInitializedToDeployer requires agreement among the historical owner() call, exact receipt topic values, and slot 0. FeeSharing registration is independently visible in creation bytecode, CREATE call trace, return value, and receipt logs. No unavailable target source body is inferred."
    }
  };

  const targetStable = BLOCKS.every((blockNumber) => targetRuntimeHex[blockNumber] === targetRuntimeHex[CREATION_BLOCK_EXPECTED]);
  const siblingStable = [LETH, LMBTC].every((sibling) => BLOCKS.every((blockNumber) => siblingRuntimeHex[sibling][blockNumber] === siblingRuntimeHex[sibling][CREATION_BLOCK_EXPECTED]));
  const runtimeEvidence = {
    blocks: BLOCKS,
    target: { address: TARGET, stableAcrossBlocks: targetStable, records: targetRuntimeRecords },
    siblings: {
      [LETH]: { label: "lETH", stableAcrossBlocks: BLOCKS.every((blockNumber) => siblingRuntimeHex[LETH][blockNumber] === siblingRuntimeHex[LETH][CREATION_BLOCK_EXPECTED]), records: siblingRuntimeRecords[LETH] },
      [LMBTC]: { label: "lMBTC", stableAcrossBlocks: BLOCKS.every((blockNumber) => siblingRuntimeHex[LMBTC][blockNumber] === siblingRuntimeHex[LMBTC][CREATION_BLOCK_EXPECTED]), records: siblingRuntimeRecords[LMBTC] }
    },
    assertions: {
      targetRuntimeByteLengthExpected: { expected: EXPECTED_RUNTIME_BYTES, observed: targetCreationRuntime.byteLength, matches: targetCreationRuntime.byteLength === EXPECTED_RUNTIME_BYTES },
      targetTrailerLengthExpected: { expected: EXPECTED_TRAILER_BYTES, observed: targetMetadata.trailerLengthBytes, matches: targetMetadata.trailerLengthBytes === EXPECTED_TRAILER_BYTES },
      targetIpfsDigestExpected: { expected: EXPECTED_IPFS_DIGEST, observed: targetMetadata.ipfsDigestHex, matches: targetMetadata.ipfsDigestHex === EXPECTED_IPFS_DIGEST }
    }
  };

  const metadataEvidence = {
    targetCreationInput: creationRecord.metadata,
    targetRuntimes: Object.fromEntries(BLOCKS.map((blockNumber) => [blockNumber, targetRuntimeRecords[blockNumber].metadata])),
    siblingRuntimes: Object.fromEntries([LETH, LMBTC].map((sibling) => [sibling, Object.fromEntries(BLOCKS.map((blockNumber) => [blockNumber, siblingRuntimeRecords[sibling][blockNumber].metadata]))])),
    ipfsMetadataRetrieval: { attemptedGatewayCountPerRootAttemptClass: ipfsFetch.attemptedGatewayCount, recovered: Boolean(recoveredMetadata), payloadRecovered: ipfsFetch.recovered, status: ipfsFetch.status, cidV0: targetMetadata.ipfsCidV0, expectedSerializedDagPbRootSha256FromMultihash: targetMetadata.ipfsDigestHex, rootBlockVerified: ipfsFetch.rootBlockVerified, rootSerializedBlockSha256: ipfsFetch.rootSerializedBlockSha256, unixfsExtracted: ipfsFetch.unixfsExtracted, unixfs: ipfsFetch.unixfs, recoveredMetadataJson: Boolean(recoveredMetadata), metadataPayloadSha256: ipfsFetch.bytes ? sha256(ipfsFetch.bytes) : null, metadataPayloadKeccak256: ipfsFetch.bytes ? keccak256(`0x${ipfsFetch.bytes.toString("hex")}`) : null, attempts: ipfsFetch.attempts, recoveredSourceCount: recoveredSources.filter((source) => source.recovered).length, declaredSourceCount: recoveredMetadata ? Object.keys(recoveredMetadata.sources || {}).length : null, recoveredSources },
    qualification: "The CIDv0 multihash digest is a hash of the serialized DAG-PB root block, not decoded gateway file bytes. Recovery requires a digest-verified raw block or CAR root plus bounded UnixFS extraction. Normal gateway payloads are only cross-checked against extracted UnixFS bytes. Bounded retrieval failure is not a claim of universal IPFS absence. Gateway identities and endpoint URLs are not persisted."
  };

  const declaredTargetSourceCount = recoveredMetadata ? Object.keys(recoveredMetadata.sources || {}).length : null;
  const recoveredTargetSourceCount = recoveredSources.filter((source) => source.recovered && source.keccakMatches).length;
  const completeSourceSetRecovered = recoveredMetadata ? Boolean(declaredTargetSourceCount > 0 && recoveredTargetSourceCount === declaredTargetSourceCount) : null;
  const settingsMatrix = recoveredMetadata ? [{ useMetadataSettings: true, priority: 1 }] : [];
  if (completeSourceSetRecovered === true) write(path.join(nextSourceDir, "ipfs", "standard-json-input.json"), { language: recoveredMetadata.language || "Solidity", sources: Object.fromEntries(Object.entries(recoveredSourceContents).map(([name, content]) => [name, { content }])), settings: recoveredMetadata.settings });
  const compilerFile = path.join(nextSourceDir, "compiler", SOLJSON_NAME);
  const compileResult = completeSourceSetRecovered === true && compiler.acquired ? compileRecoveredTarget(compilerFile, recoveredMetadata, recoveredSourceContents, targetExecutable, settingsMatrix, parseSolidityMetadata(targetRuntimeHex[FIXED_PIN]).full, Buffer.from(tx.input.slice(2), "hex")) : null;
  const siblingBuilds = {};
  if (compiler.acquired) {
    for (const sibling of [LETH, LMBTC]) {
      const explorer = siblingExplorers[sibling];
      const sourcePath = explorer.sanitized.sourceFile || "contracts/markets/LToken.sol";
      const sourceContents = { [sourcePath]: explorer.sourceCode };
      for (const source of explorer.additionalSources) sourceContents[source.fileName] = source.content;
      const metadataLike = { language: "Solidity", settings: { ...(explorer.compilerSettings || {}), compilationTarget: { [sourcePath]: explorer.sanitized.contractName || "LToken" } } };
      const parsedSibling = parseSolidityMetadata(siblingRuntimeHex[sibling][FIXED_PIN]);
      siblingBuilds[sibling] = compileRecoveredTarget(compilerFile, metadataLike, sourceContents, parsedSibling.executable, [{ optimizerEnabled: true, runs: 200, priority: 1 }], parsedSibling.full);
    }
  }
  if (compileResult?.creationArtifactExact === true) {
    deployment.constructorArgumentSuffix.suffixBytes = 0;
    deployment.constructorArgumentSuffix.constructorArgumentsAbsentProven = true;
    deployment.constructorArgumentSuffix.basis = "The hash-bound target source set and exact metadata settings produced creation bytecode exactly equal to the transaction creation input; no appended constructor bytes remain.";
  }
  const buildEvidence = {
    compiler,
    targetMetadataRecovered: Boolean(recoveredMetadata),
    completeTargetSourceSetRecovered: completeSourceSetRecovered,
    compilationAttempted: Boolean(compileResult),
    boundedSettingsMatrix: settingsMatrix,
    compilationAttempts: compileResult?.attempts || [],
    siblingBuilds,
    localBuildReproduced: compileResult ? compileResult.localBuildReproduced : null,
    executableRuntimeExact: compileResult ? compileResult.executableRuntimeExact : null,
    fullRuntimeExact: compileResult ? compileResult.fullRuntimeExact : null,
    creationArtifactExact: compileResult ? compileResult.creationArtifactExact : null,
    blockers: completeSourceSetRecovered === true ? (compileResult?.fullRuntimeExact ? [] : ["Complete recovered source set compiled with exact metadata settings, but exact target runtime reproduction was not achieved."]) : (completeSourceSetRecovered === null ? ["Digest-verified target DAG-PB metadata/UnixFS payload was not recovered from bounded public methods.", "Target source-set completeness is dependency-unavailable (null), not disproven, while target metadata is unavailable.", "Explorer and Sourcify expose no verified target source.", "Sibling/official candidate sources are not substituted for missing target source."] : ["Valid target metadata was recovered, but one or more declared source contents were unavailable or failed metadata keccak256 validation.", "Target compile remains blocked until every declared source is recovered and validated."]),
    qualification: completeSourceSetRecovered === true ? "Compilation used only metadata-keccak-validated target sources, exact metadata settings, and the hash-bound compiler; creation/full/executable comparisons are independent." : "No target compile is attempted without valid digest-verified metadata and a complete metadata-keccak-validated target source set. Null target build results are not evidence of source inequality."
  };

  const publicSourceEvidence = {
    targetAvailability: {
      explorerVerifiedSource: targetExplorer.sanitized.verified,
      explorerReturnedSourceBytes: targetExplorer.sanitized.sourceCodeBytes,
      sourcify: targetSourcify,
      ipfsMetadataRecovered: Boolean(recoveredMetadata)
    },
    siblings: siblingSourceSummaries,
    candidates: publicCandidates
  };

  const gates = {
    creationLineageBound: firstCode.firstCodeBlock === CREATION_BLOCK_EXPECTED && firstCode.codePresentAtFirst && firstCode.codeAbsentImmediatelyBefore && Number.parseInt(tx.blockNumber, 16) === CREATION_BLOCK_EXPECTED && lower(tx.hash) === DEPLOYMENT_TX_EXPECTED && lower(receipt.contractAddress) === TARGET && deployment.block.transactionAtIndexMatches && deployment.callTrace.available && deployment.callTrace.creationInputMatchesTransaction && deployment.callTrace.returnedRuntimeMatchesCreationBlockCode && deployment.constructorArgumentSuffix.terminalMetadataCandidateValid && deployment.constructorStateAndReceiptFacts.slot1EqualsOne && deployment.constructorStateAndReceiptFacts.registerTraceCallBound && deployment.constructorStateAndReceiptFacts.feeSharingNftTransferToDeployerBound,
    constructorArgumentsAbsentProven: deployment.constructorArgumentSuffix.constructorArgumentsAbsentProven,
    ownerInitializedToDeployer: deployment.constructorStateAndReceiptFacts.ownerInitializedToDeployer,
    runtimeStableCreationToPin: targetStable,
    cborMetadataParsed: targetMetadata.keys.includes("ipfs") && targetMetadata.keys.includes("solc") && targetMetadata.trailerLengthBytes === EXPECTED_TRAILER_BYTES,
    solcVersionBound: targetMetadata.solcVersion === EXPECTED_SOLC && creationRecord.metadata.solcVersion === EXPECTED_SOLC,
    ipfsMetadataRecovered: Boolean(recoveredMetadata),
    completeSourceSetRecovered,
    localBuildReproduced: buildEvidence.localBuildReproduced,
    executableRuntimeExact: buildEvidence.executableRuntimeExact,
    fullRuntimeExact: buildEvidence.fullRuntimeExact,
    creationArtifactExact: buildEvidence.creationArtifactExact,
    siblingVerifiedSourceBound: lethExplorer.sanitized.verified && lmbtcExplorer.sanitized.verified && lethExplorer.sanitized.compilerVersion.includes("0.6.12") && lmbtcExplorer.sanitized.compilerVersion.includes("0.6.12") && String(lethExplorer.sanitized.optimizationRuns) === "200" && String(lmbtcExplorer.sanitized.optimizationRuns) === "200" && siblingBuilds[LETH]?.executableRuntimeExact === true && siblingBuilds[LMBTC]?.executableRuntimeExact === true && siblingBuilds[LETH]?.fullRuntimeExact === true && siblingBuilds[LMBTC]?.fullRuntimeExact === true,
    siblingExecutableRuntimeExactToTarget: comparison.targetVsLethExecutable.exact && comparison.targetVsLmbtcExecutable.exact,
    targetSourceSemanticsBound: buildEvidence.fullRuntimeExact === true ? true : null,
    allSixDebtMarketSourceExact: null,
    beneficialOwnershipProven: null,
    legalDamagesProven: null,
    ultimateUncompensatedLossProven: null,
    abuseProven: null,
    routePositive: false,
    signedAction: false,
    promotion: false
  };
  if (!gates.creationLineageBound || !gates.ownerInitializedToDeployer || !gates.runtimeStableCreationToPin || !gates.cborMetadataParsed || !gates.solcVersionBound || !gates.siblingVerifiedSourceBound) throw new Error(`Required Step12 evidence gate failed: ${JSON.stringify(gates)}`);
  if (gates.siblingExecutableRuntimeExactToTarget !== false) throw new Error(`Sibling executable comparison unexpectedly exact: ${JSON.stringify(gates)}`);
  if (completeSourceSetRecovered !== true && (gates.localBuildReproduced !== null || gates.executableRuntimeExact !== null || gates.fullRuntimeExact !== null || gates.creationArtifactExact !== null || gates.targetSourceSemanticsBound !== null || gates.allSixDebtMarketSourceExact !== null || gates.constructorArgumentsAbsentProven !== null)) throw new Error(`Incomplete-source gates must remain null: ${JSON.stringify(gates)}`);
  if (!Object.values(runtimeEvidence.assertions).every((assertion) => assertion.matches)) throw new Error(`Runtime assertion mismatch: ${JSON.stringify(runtimeEvidence.assertions)}`);
  if (!compiler.acquired || !compiler.releaseListHashMatches) throw new Error("Hash-bound soljson acquisition failed");
  if (!siblingStable) throw new Error("Sibling runtime drift blocks deterministic comparison");

  write(path.join(nextSourceDir, "deployment-evidence.json"), deployment);
  write(path.join(nextSourceDir, "runtime-evidence.json"), runtimeEvidence);
  write(path.join(nextSourceDir, "metadata-evidence.json"), metadataEvidence);
  write(path.join(nextSourceDir, "public-source-provenance.json"), publicSourceEvidence);
  write(path.join(nextSourceDir, "sibling-comparison.json"), comparison);
  write(path.join(nextSourceDir, "build-attempt.json"), buildEvidence);

  fs.rmSync(SOURCE_DIR, { recursive: true, force: true });
  fs.renameSync(nextSourceDir, SOURCE_DIR);

  const evidence = { deployment, runtimeEvidence, metadataEvidence, publicSourceEvidence, comparison, buildEvidence };
  const runId = `free-step12-${sha256(Buffer.from(JSON.stringify({ predecessorRunId: predecessor.runId, evidence, gates, classification: CLASSIFICATION }))).slice(0, 20)}`;
  const raw = {
    schemaVersion: 2,
    runId,
    classification: CLASSIFICATION,
    predecessor,
    target: TARGET,
    evidence,
    gates,
    safety: { publicReadOnly: true, endpointInventoryRead: false, providerUrlsEmitted: false, sourceApiUrlsEmitted: false, privateMaterialRead: false, signing: false, transactions: false, forks: false, stateMutation: false, localNoKeyCompilationOnly: true }
  };
  atomicWrite(RAW, raw);

  /* Legacy pre-correction output templates retained only as inert review history.
  const execCmp = comparison.targetVsLethExecutable;
  const report = `# Free Protocol Step12 — lweETH.mode source provenance\n\nSignal: 🟠 WATCH — deployment/runtime family compatibility bound; exact target source/build remains unresolved.\n\n**Classification:** ${CLASSIFICATION}\n\n## Deployment and runtime\n\nTarget \`${TARGET}\` first acquires code at Mode block ${firstCode.firstCodeBlock}. Deployment transaction \`${tx.hash}\`, index ${Number.parseInt(tx.transactionIndex, 16)}, block hash \`${block.hash}\`, timestamp ${Number.parseInt(block.timestamp, 16)}, deployer \`${lower(tx.from)}\`, successful creation receipt, created address, transaction placement, CREATE trace input/output, and first-code binary search all agree. Creation input is ${creationRecord.byteLength} bytes and ends at a valid Solidity metadata trailer, so the bytecode-derived constructor suffix is zero bytes.\n\nHistorical slot 0 equals the deployer and slot 1 equals 1. Creation bytecode and trace bind a call to FeeSharing \`${FEE_SHARING}\` using \`register(address)\`; the call returns NFT ID ${registerNftId}. Receipt logs independently show token/NFT ID ${EXPECTED_NFT_ID} minted to the deployer and a registration data row. These are bytecode/trace/state/receipt facts, not recovered target-source semantics.\n\nTarget runtime is ${targetCreationRuntime.byteLength} bytes at creation, Step11 block ${LIQUIDATION_BLOCK}, and fixed pin ${FIXED_PIN}; all three byte strings are exact-equal. The executable portion is ${targetCreationRuntime.executableByteLength} bytes.\n\n## Metadata\n\nThe runtime's final two-byte CBOR length is \`0x${targetMetadata.finalTwoByteLengthHex}\`: ${targetMetadata.cborLengthBytes} metadata bytes and a ${targetMetadata.trailerLengthBytes}-byte trailer. Keys are ${targetMetadata.keys.join(", ")}; decoded compiler is ${targetMetadata.solcVersion}. IPFS multihash \`${targetMetadata.ipfsMultihashHex}\` gives CID \`${targetMetadata.ipfsCidV0}\` and SHA-256 content digest \`${targetMetadata.ipfsDigestHex}\`. The asserted 20,484-byte runtime, 53-byte trailer, and digest all reproduce from fetched bytes.\n\n${ipfsFetch.attemptedGatewayCount} sanitized public IPFS gateway attempts did not recover hash-valid metadata. Explorer and ${targetSourcify.attempts} Sourcify probes also expose no verified target source. Gateway, RPC, explorer-API, and Sourcify endpoint URLs are not persisted.\n\n## Sibling comparison\n\nVerified siblings lETH and lMBTC each remain stable at the same three blocks and have exact-equal ${lethExecutable.length}-byte metadata-stripped executables. Their complete explorer-returned source sets identify \`contracts/markets/LToken.sol\`, solc 0.6.12, optimizer 200; local no-key compilation with the hash-bound compiler reproduces each sibling's full and metadata-stripped runtime exactly. Target versus either sibling executable: exact=${execCmp.exact}, length delta=${execCmp.lengthDeltaBytes}, first diff=${execCmp.firstDiffByteIndex}, last diff=${execCmp.lastDiffByteIndex}, positional matches=${execCmp.positionalByteMatchCount}/${execCmp.targetBytes}, ratio=${execCmp.positionalByteMatchRatio}, common prefix=${execCmp.commonPrefixBytes}, common suffix=${execCmp.commonSuffixBytes}. A single contiguous insertion/deletion does not explain the difference.\n\nAll ${comparison.runtimeImmediateSurface.push4.targetCount} disassembled PUSH4 values and all ${comparison.runtimeImmediateSurface.push32.targetCount} PUSH32 values equal both siblings. Every verified sibling ABI function selector (${comparison.verifiedSiblingAbiSurface.functionCount}) is directly present in target runtime. Direct PUSH32 presence is ${comparison.verifiedSiblingAbiSurface.directlyPresentAbiEventTopicCount}/${comparison.verifiedSiblingAbiSurface.eventCount} ABI event topics in target and has exact parity with both siblings; the complete PUSH32 sets are equal. This supports LToken-family compatibility, not exact target source.\n\n## Source and build boundary\n\nOfficial LayerBank docs identify the public \`layerbank-foundation/v2-contracts\` repository. Pinned initial/current LToken candidates were retained, but both have empty constructors and lack the Mode FeeSharing registration, so neither is promoted as target source. The pinned \`layerbankgoldsky/layerbank-subgraph\` evidence is classified only as community/infrastructure attribution, not official core provenance. Stable references:\n\n- ${publicCandidates.stablePublicReferences.officialDocsGitHubPage}\n- ${publicCandidates.stablePublicReferences.officialRepositoryInitialCommit}\n- ${publicCandidates.stablePublicReferences.officialRepositoryCurrentCommit}\n- ${publicCandidates.stablePublicReferences.communityInfrastructureCommit}\n\nHash-bound \`${SOLJSON_NAME}\` was acquired and verified against the public release-list keccak. Target compilation was not attempted because target metadata and a complete hash-bound target source set were unavailable. This null target-build result is not source inequality.\n\n## Gates and next branch\n\nGates: \`${JSON.stringify(gates)}\`\n\nNext branch: obtain the target IPFS metadata/source objects or an authoritative Mode deployment source bundle/standard input, then compile exact settings before reconsidering target-source semantics or all-six source exactness. Ownership, damages, abuse, route, signing, and promotion remain fail-closed.\n`;
  const handoff = `# Step12 lweETH.mode source-provenance handoff\n\n- ${CLASSIFICATION}\n- Run ${runId}; predecessor ${predecessor.runId}.\n- Creation block/tx/index=${firstCode.firstCodeBlock}/${tx.hash}/${Number.parseInt(tx.transactionIndex, 16)}; deployer=${lower(tx.from)}; runtime stable at ${BLOCKS.join(",")}.\n- Runtime/executable/trailer bytes=${targetCreationRuntime.byteLength}/${targetCreationRuntime.executableByteLength}/${targetMetadata.trailerLengthBytes}; solc=${targetMetadata.solcVersion}; IPFS digest=${targetMetadata.ipfsDigestHex}; CID=${targetMetadata.ipfsCidV0}.\n- Constructor suffix=0; owner=deployer; slot1=1; FeeSharing register(address) returned NFT ${registerNftId}; receipt mint to deployer bound. These are bytecode/trace/state/receipt facts.\n- Target-vs-sibling executable exact=${execCmp.exact}; delta=${execCmp.lengthDeltaBytes}; first/last diff=${execCmp.firstDiffByteIndex}/${execCmp.lastDiffByteIndex}; positional match=${execCmp.positionalByteMatchCount}/${execCmp.targetBytes} (${execCmp.positionalByteMatchRatio}); PUSH4/PUSH32 surfaces equal=true.\n- Complete explorer-returned source sets for lETH/lMBTC locally compile to exact full and executable sibling runtimes with optimizer 200. This does not make either source exact for the target.\n- Public IPFS metadata unavailable after ${ipfsFetch.attemptedGatewayCount} sanitized attempts; target explorer/Sourcify source unavailable; complete target source set=false. Hash-bound soljson acquired, but target compilation correctly not attempted; target build/executable exactness remain null.\n- Community subgraph commit is infrastructure attribution only. No exact target source is inferred from siblings or official candidates.\n- Gates=${JSON.stringify(gates)}.\n- No endpoint inventory, secrets, signing, transactions, forks, mutation, or coordinator-state edits.\n`;
  */
  const retrievalSummary = `raw DAG-PB ${ipfsFetch.attempts.rawDagPbBlock.status} (${ipfsFetch.attempts.rawDagPbBlock.attempted} attempts), CAR ${ipfsFetch.attempts.car.status} (${ipfsFetch.attempts.car.attempted} attempts), decoded-file ${ipfsFetch.attempts.decodedGatewayFile.status} (${ipfsFetch.attempts.decodedGatewayFile.attempted} attempts)`;
  const finalReport = `# Free Protocol Step12 — lweETH.mode source provenance

Signal: 🟠 WATCH — deployment/runtime family compatibility bound; exact target source/build remains unresolved.

**Classification:** ${CLASSIFICATION}

## Deployment, constructor boundary, and owner initialization

Target \`${TARGET}\` first acquires code at Mode block ${firstCode.firstCodeBlock}. Transaction \`${tx.hash}\`, index ${Number.parseInt(tx.transactionIndex, 16)}, deployer \`${lower(tx.from)}\`, receipt, block placement, CREATE trace, and first-code search agree. The ${creationRecord.byteLength}-byte creation input ends in a valid Solidity metadata candidate. That terminal candidate does not independently locate the compiled creation-artifact boundary: constructor suffix length and argument absence remain \`null\` unless an exact target creation build is recovered.

Slot 0 decodes to the deployer (storage fact). Historical \`owner()\` at block ${CREATION_BLOCK_EXPECTED} returns the deployer; the target-emitted \`OwnershipTransferred(address,address)\` receipt topic has previous owner zero and new owner deployer. Getter, receipt, and slot therefore agree, so \`ownerInitializedToDeployer=true\`. Selector/topic names are conventional semantics rather than exact target-source attribution; returned bytes and indexed values are call/receipt-bound.

Creation bytecode and trace bind FeeSharing \`${FEE_SHARING}\` \`register(address)\` for the deployer and return NFT ID ${registerNftId}; receipt logs independently bind NFT ${EXPECTED_NFT_ID}. Runtime is ${targetCreationRuntime.byteLength} bytes and exact-stable at blocks ${BLOCKS.join(", ")}; executable length is ${targetCreationRuntime.executableByteLength} bytes.

## CIDv0/IPFS verification

The runtime trailer is ${targetMetadata.trailerLengthBytes} bytes, reports solc ${targetMetadata.solcVersion}, and carries CID \`${targetMetadata.ipfsCidV0}\` with SHA-256 digest \`${targetMetadata.ipfsDigestHex}\`. That digest is verified only against a serialized DAG-PB root block, never against decoded gateway file bytes. Retrieval result: ${retrievalSummary}. Root block verified=${ipfsFetch.rootBlockVerified}; UnixFS extracted=${ipfsFetch.unixfsExtracted}; valid metadata JSON recovered=${Boolean(recoveredMetadata)}.

Normal gateway payloads, when returned, are compared with extracted UnixFS bytes. Attempt classes, counts, statuses, and response hashes are persisted without endpoint identities. \`ipfsMetadataRecovered=false\` means only that bounded public attempts did not recover a digest-verified DAG-PB/UnixFS metadata object; it does not assert universal absence. Accordingly, source-set completeness is ${completeSourceSetRecovered === null ? "`null` because metadata is dependency-unavailable" : `\`${completeSourceSetRecovered}\``}.

## Source/build boundary and sibling evidence

Metadata sources newly recovered=${recoveredTargetSourceCount}/${declaredTargetSourceCount ?? "unknown"}. Target compilation attempted=${Boolean(compileResult)}; executable/full/creation exact=${buildEvidence.executableRuntimeExact}/${buildEvidence.fullRuntimeExact}/${buildEvidence.creationArtifactExact}. No target compile is attempted without valid root-verified metadata and every declared source passing metadata \`keccak256\` validation.

Verified lETH and lMBTC source sets still compile with the hash-bound solc 0.6.12 compiler to exact sibling full and executable runtimes. Target versus sibling executable remains exact=${comparison.targetVsLethExecutable.exact}, length delta=${comparison.targetVsLethExecutable.lengthDeltaBytes}, positional matches=${comparison.targetVsLethExecutable.positionalByteMatchCount}/${comparison.targetVsLethExecutable.targetBytes}. This proves family compatibility only.

Official repository candidates have empty constructors and no Mode FeeSharing registration; community subgraph material remains infrastructure attribution only. No sibling/candidate is substituted for target source.

## Gates and blockers

Gates: \`${JSON.stringify(gates)}\`

Blockers: ${buildEvidence.blockers.join(" ")}
`;
  const finalHandoff = `# Step12 lweETH.mode source-provenance handoff

- ${CLASSIFICATION}
- Run ${runId}; predecessor ${predecessor.runId}.
- Deployment block/tx/index=${firstCode.firstCodeBlock}/${tx.hash}/${Number.parseInt(tx.transactionIndex, 16)}; runtime stable at ${BLOCKS.join(",")}.
- Creation input ends in a valid metadata candidate; constructor suffix/argument absence remain ${gates.constructorArgumentsAbsentProven} because no exact target creation build exists.
- slot0EqualsDeployer=${slot0EqualsDeployer}; owner() creation-block getter=${ownerCallCreation}; exact zero-to-deployer ownership receipt event=${Boolean(ownershipLog)}; ownerInitializedToDeployer=${gates.ownerInitializedToDeployer}.
- CIDv0 digest is checked against serialized DAG-PB root bytes, not decoded file bytes. ${retrievalSummary}; root verified=${ipfsFetch.rootBlockVerified}; UnixFS extracted=${ipfsFetch.unixfsExtracted}; metadata recovered=${gates.ipfsMetadataRecovered}.
- Complete target source set=${gates.completeSourceSetRecovered}; target compile attempted=${Boolean(compileResult)}; executable/full/creation exact=${gates.executableRuntimeExact}/${gates.fullRuntimeExact}/${gates.creationArtifactExact}.
- Bounded retrieval failure is not universal absence. With metadata unavailable, source completeness remains null.
- lETH/lMBTC complete explorer source sets still reproduce exact sibling full/executable runtimes; target sibling executable exact=${gates.siblingExecutableRuntimeExactToTarget}.
- Gates=${JSON.stringify(gates)}.
- Blockers=${buildEvidence.blockers.join(" ")}
- No endpoint inventory, secrets, signing, transactions, forks, mutation, or coordinator-state edits.
`;
  atomicWrite(REPORT, finalReport);
  atomicWrite(HANDOFF, finalHandoff);

  const manifest = {
    schemaVersion: 2,
    runId,
    generationId: runId,
    detachedManifest: true,
    manifestSelfHashIncluded: false,
    predecessor,
    files: { scanner: record(__filename), sources: recursiveFileRecords(SOURCE_DIR), raw: record(RAW), report: record(REPORT), handoff: record(HANDOFF) },
    safety: raw.safety
  };
  atomicWrite(MANIFEST, manifest);
  console.log(JSON.stringify({ status: "complete", runId, classification: CLASSIFICATION, deployment: { block: firstCode.firstCodeBlock, transactionIndex: Number.parseInt(tx.transactionIndex, 16), deployer: lower(tx.from), createdAddress: lower(receipt.contractAddress) }, runtime: { bytes: targetCreationRuntime.byteLength, executableBytes: targetCreationRuntime.executableByteLength, stable: targetStable }, metadata: { trailerBytes: targetMetadata.trailerLengthBytes, solc: targetMetadata.solcVersion, digest: targetMetadata.ipfsDigestHex, cid: targetMetadata.ipfsCidV0 }, comparison: comparison.targetVsLethExecutable, gates, hashes: { raw: record(RAW).sha256, report: record(REPORT).sha256, handoff: record(HANDOFF).sha256, manifest: record(MANIFEST).sha256 } }, null, 2));
}

main().catch((error) => { console.error(error); process.exit(1); });
