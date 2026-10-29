#!/usr/bin/env node
"use strict";

// RETIRED POST-CORRECTION TOOL — NOT THE RETAINED 84-READ NETWORK RUNNER.
// The exact source used for the network run was not retained. Network execution from
// this mutable post-correction file is disabled. Any future network action requires a
// new minimal runner, immutable pre-run hash, and a new run ID.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  AbiCoder,
  Interface,
  FunctionFragment,
  getAddress,
  id,
  keccak256,
  toUtf8Bytes,
} = require("ethers");

const ROOT = path.resolve(__dirname, "..");
const SCANNER = "tools/scan-critical-aster-bnb-treasury-control.js";
const OUT_RAW = "reports/raw/fast/critical-aster-bnb-treasury-control.json";
const OUT_MANIFEST = "reports/raw/fast/critical-aster-bnb-treasury-control-manifest.json";
const OUT_REPORT = "reports/critical-aster-bnb-treasury-control.md";
const PROXY = getAddress("0x128463A60784c4D3f46c23Af3f65Ed859Ba87974");
const RECORDED_IMPLEMENTATION_HYPOTHESIS = getAddress("0x2CC878ac49C3BF8B0f2B053af7845BA6590eEc4f");
const CHAIN_ID = 56;
const MAX_RPC_READS = 160;
const MAX_PUBLIC_SOURCE_REQUESTS = 30;
// Eight bounded public-source requests preceded the final scanner: two redirected Sourcify
// probes, two redirected-target 503s, one unauthenticated explorer API rejection,
// two BscScan page extractions, and one scanner page request from a full read-only
// attempt that reached offline JSON serialization before failing on a BigInt.
const PRE_SCANNER_PUBLIC_SOURCE_REQUESTS = 8;
const PRIOR_FULL_READ_ATTEMPTS = 1;
const PUBLIC_RPC = ["https://", "bsc-rpc", ".publicnode", ".com"].join("");
const EXPLORER_BASE = ["https://", "bscscan", ".com/address/"].join("");

const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const TOKENS = [
  { symbol: "USDT", address: "0x55d398326f99059fF775485246999027B3197955" },
  { symbol: "USDC", address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d" },
  { symbol: "WBNB", address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c" },
  { symbol: "BTCB", address: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c" },
  { symbol: "ETH", address: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8" },
  { symbol: "USD1", address: "0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d" },
  { symbol: "asBTC", address: "0x184b72289c0992BDf96751354680985a7C4825d6" },
  { symbol: "asBNB", address: "0x77734e70b6E88b4d82fE632a168EDf6e700912b6" },
  { symbol: "USDF", address: "0x5A110fC00474038f6c02E89C707D638602EA44B5" },
  { symbol: "asUSDF", address: "0x917AF46B3C3c6e1Bb7286B9F59637Fb7C65851Fb" },
].map((x) => ({ ...x, address: getAddress(x.address) }));

const ERC20 = new Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);
const BEACON = new Interface(["function implementation() view returns (address)"]);

const ROLE_CONSTANT_NAMES = [
  "DEFAULT_ADMIN_ROLE", "ADMIN_ROLE", "PAUSE_ROLE", "VERIFIED_ROLE",
  "DEPOSIT_ROLE", "TOKEN_ROLE", "OPERATE_ROLE", "UNPAUSE_ROLE",
];

function abs(rel) { return path.join(ROOT, rel); }
function safeMessage(value) {
  return String(value == null ? "" : value)
    .replace(/https?:\/\/[^\s"']+/gi, "[endpoint-redacted]")
    .replace(/[?&](?:key|token|api_key|apikey)=[^\s&"']+/gi, "[credential-redacted]")
    .replace(/(authorization|cookie|set-cookie)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .slice(0, 1200);
}
function sha256Buffer(data) { return crypto.createHash("sha256").update(data).digest("hex"); }
function sha256File(rel) {
  const data = fs.readFileSync(abs(rel));
  return { path: rel, bytes: data.length, sha256: sha256Buffer(data) };
}
function writeOwned(rel, content) {
  if (![OUT_RAW, OUT_MANIFEST, OUT_REPORT].includes(rel)) throw new Error(`write refused outside branch namespace: ${rel}`);
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
  fs.writeFileSync(abs(rel), content, "utf8");
}
function nonEmptyCode(code) { return typeof code === "string" && /^0x[0-9a-fA-F]+$/.test(code) && !/^0x0*$/.test(code); }
function codeInfo(code, retainExact = true) {
  return {
    exact: retainExact ? code : undefined,
    bytes: nonEmptyCode(code) ? (code.length - 2) / 2 : 0,
    keccak256: nonEmptyCode(code) ? keccak256(code) : null,
    present: nonEmptyCode(code),
  };
}
function slotAddress(value) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value) || /^0x0{64}$/.test(value)) return null;
  return getAddress(`0x${value.slice(-40)}`);
}
function decodeHtml(text) {
  return String(text || "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
function stripTags(text) { return decodeHtml(String(text || "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim(); }
function exactPreById(html, idValue) {
  const re = new RegExp(`<pre[^>]*id=["']${idValue}["'][^>]*>([\\s\\S]*?)<\\/pre>`, "i");
  const match = html.match(re);
  return match ? decodeHtml(match[1]).trim() : null;
}
function formatUnitsExact(raw, decimals) {
  const negative = raw < 0n;
  let digits = (negative ? -raw : raw).toString();
  if (decimals === 0) return `${negative ? "-" : ""}${digits}`;
  digits = digits.padStart(decimals + 1, "0");
  const whole = digits.slice(0, -decimals);
  const fraction = digits.slice(-decimals);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}
function jsonSafe(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonSafe(v)]));
  return value;
}

function findRevertData(value, depth = 0) {
  if (depth > 6 || value == null) return null;
  if (typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value)) return value.toLowerCase();
  if (typeof value !== "object") return null;
  for (const key of ["data", "result", "return", "output", "originalError", "error"]) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const result = findRevertData(value[key], depth + 1);
      if (result != null) return result;
    }
  }
  return null;
}
function normalizeRpcError(error) {
  return {
    code: error && Number.isInteger(error.code) ? error.code : null,
    message: safeMessage(error && error.message != null ? error.message : error),
    data: findRevertData(error && error.data != null ? error.data : error),
  };
}

class RpcReader {
  constructor() { this.count = 0; this.transcript = []; }
  async read(method, params, label) {
    if (this.count >= MAX_RPC_READS) throw new Error(`RPC read cap ${MAX_RPC_READS} reached before ${label}`);
    const readNumber = ++this.count;
    const body = { jsonrpc: "2.0", id: readNumber, method, params };
    try {
      const response = await fetch(PUBLIC_RPC, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "authorized-defensive-aster-treasury-control/1.0" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(25_000),
      });
      if (!response.ok) throw new Error(`public preset HTTP status ${response.status}`);
      const payload = await response.json();
      if (!payload || payload.jsonrpc !== "2.0" || payload.id !== readNumber) throw new Error("JSON-RPC envelope/id mismatch");
      if (payload.error) {
        const error = normalizeRpcError(payload.error);
        this.transcript.push({ readNumber, label, method, params, response: { error } });
        return { ok: false, error, readNumber };
      }
      this.transcript.push({ readNumber, label, method, params, response: { result: payload.result } });
      return { ok: true, result: payload.result, readNumber };
    } catch (error) {
      const failure = { kind: "transport", message: safeMessage(error && error.message ? error.message : error) };
      this.transcript.push({ readNumber, label, method, params, response: { failure } });
      return { ok: false, failure, readNumber };
    }
  }
}

class SourceReader {
  constructor() { this.count = 0; this.transcript = []; }
  async explorerPage(address) {
    if (PRE_SCANNER_PUBLIC_SOURCE_REQUESTS + this.count >= MAX_PUBLIC_SOURCE_REQUESTS) throw new Error("public source request cap reached");
    const requestNumber = ++this.count;
    const label = "explorer.verifiedSourcePage";
    try {
      const response = await fetch(`${EXPLORER_BASE}${address}#code`, {
        headers: { "user-agent": "authorized-defensive-aster-source-resolution/1.0" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`public explorer HTTP status ${response.status}`);
      const html = await response.text();
      this.transcript.push({ requestNumber, label, ok: true, status: response.status, bytes: Buffer.byteLength(html) });
      return { ok: true, html };
    } catch (error) {
      const failure = safeMessage(error && error.message ? error.message : error);
      this.transcript.push({ requestNumber, label, ok: false, failure });
      return { ok: false, failure, html: null };
    }
  }
}

function parseExplorer(html, runtime) {
  if (!html) return {
    explorerVerified: false, contractName: null, compilerVersion: null,
    optimization: null, abi: null, abiSha256: null, sourceFiles: [],
    sourceAggregateSha256: null, displayedRuntime: null,
    displayedRuntimeMatch: null, parseLimitations: ["explorer page unavailable"],
  };
  const abiText = exactPreById(html, "js-copytextarea2");
  let abi = null;
  let abiParseError = null;
  if (abiText) {
    try { abi = JSON.parse(abiText); } catch (error) { abiParseError = safeMessage(error.message); }
  }
  const sourceFiles = [];
  const editorRe = /<pre[^>]*id=["']editor(\d*)["'][^>]*>([\s\S]*?)<\/pre>/gi;
  let match;
  while ((match = editorRe.exec(html)) != null) {
    const source = decodeHtml(match[2]);
    if (!source.trim()) continue;
    const preceding = html.slice(Math.max(0, match.index - 2000), match.index);
    const labels = [...preceding.matchAll(/File\s+\d+\s+of\s+\d+\s*:\s*([^<\r\n]+)/gi)];
    const fallback = source.match(/(?:contract|library|interface)\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
    const name = labels.length ? decodeHtml(labels[labels.length - 1][1]).trim() : (fallback ? `${fallback[1]}.sol` : `editor${match[1] || "1"}.sol`);
    sourceFiles.push({ name, bytes: Buffer.byteLength(source), sha256: sha256Buffer(source), retained: false });
  }
  const contractNameMatch = html.match(/Contract\s+Name\s*:<\/div>[\s\S]{0,600}?<div[^>]*>([\s\S]*?)<\/div>/i)
    || html.match(/Contract\s+Name[\s\S]{0,300}?AstherusVault/i);
  const compilerMatch = html.match(/v0\.8\.25\+commit\.[0-9a-f]+/i) || html.match(/Compiler\s+Version[\s\S]{0,300}?(v?0\.\d+\.\d+[^<\s]*)/i);
  const optimizerMatch = html.match(/Optimization\s+Enabled[\s\S]{0,400}?(Yes|No)[\s\S]{0,200}?(\d+)\s+runs/i);
  const displayedRuntime = exactPreById(html, "verifiedbytecode2");
  const runtimeNormalized = typeof runtime === "string" ? runtime.toLowerCase() : null;
  const displayedNormalized = displayedRuntime && /^0x[0-9a-f]+$/i.test(displayedRuntime) ? displayedRuntime.toLowerCase() : null;
  const explorerVerified = /Contract:\s*Verified/i.test(html) || /Contract Source Code Verified/i.test(html) || sourceFiles.length > 0;
  const sourceAggregateSha256 = sourceFiles.length
    ? sha256Buffer(sourceFiles.map((x) => `${x.name}\0${x.bytes}\0${x.sha256}`).join("\n")) : null;
  return {
    explorerVerified,
    verificationAuthority: "public-explorer-assertion-not-local-recompilation",
    contractName: contractNameMatch ? (contractNameMatch[1] ? stripTags(contractNameMatch[1]) : "AstherusVault") : null,
    compilerVersion: compilerMatch ? compilerMatch[0] : null,
    optimization: optimizerMatch ? { enabled: optimizerMatch[1].toLowerCase() === "yes", runs: Number(optimizerMatch[2]) } : null,
    abi,
    abiSha256: abiText ? sha256Buffer(abiText) : null,
    abiParseError,
    sourceFiles,
    sourceAggregateSha256,
    sourceTextRetained: false,
    displayedRuntime: displayedNormalized ? codeInfo(displayedNormalized, false) : null,
    displayedRuntimeMatch: displayedNormalized && runtimeNormalized ? displayedNormalized === runtimeNormalized : null,
    parseLimitations: [
      "Explorer verification is third-party evidence; exact compiler input, dependency paths, and a local reproducible build were not retained/recompiled.",
      "Source bodies are reduced to file name/byte-count/SHA-256 records; no dynamic explorer HTML, URL, headers, or cookies are retained.",
    ],
  };
}

function disassemblePush4(runtime) {
  if (!nonEmptyCode(runtime)) return [];
  const bytes = Buffer.from(runtime.slice(2), "hex");
  const instructions = [];
  for (let pc = 0; pc < bytes.length;) {
    const offset = pc;
    const opcode = bytes[pc++];
    const pushLength = opcode >= 0x60 && opcode <= 0x7f ? opcode - 0x5f : 0;
    const immediate = pushLength ? bytes.subarray(pc, Math.min(bytes.length, pc + pushLength)) : null;
    pc += pushLength;
    instructions.push({ offset, opcode, immediate: immediate ? `0x${immediate.toString("hex")}` : null });
  }
  const rows = [];
  for (let i = 0; i < instructions.length; i++) {
    const item = instructions[i];
    if (item.opcode !== 0x63 || !item.immediate || item.immediate.length !== 10) continue;
    const prev = instructions[i - 1] || null;
    const next = instructions[i + 1] || null;
    const comparator = next && next.opcode === 0x14 ? "EQ" : (next && next.opcode === 0x11 ? "GT" : null);
    const dispatcherLike = Boolean(comparator && prev && [0x80, 0x81, 0x82].includes(prev.opcode));
    rows.push({ selector: item.immediate.toLowerCase(), offset: item.offset, comparator, dispatcherLike });
  }
  return rows;
}

function canonicalSignature(fragment) { return fragment.format("sighash"); }
function functionInventory(abi, runtime) {
  const iface = new Interface(abi || []);
  const bySelector = new Map();
  for (const fragment of iface.fragments.filter((x) => x.type === "function")) {
    const signature = canonicalSignature(fragment);
    const selector = iface.getFunction(signature).selector.toLowerCase();
    if (!bySelector.has(selector)) bySelector.set(selector, []);
    bySelector.get(selector).push({
      signature, name: fragment.name, stateMutability: fragment.stateMutability,
      inputs: fragment.inputs.map((x) => x.format("full")),
      outputs: fragment.outputs.map((x) => x.format("full")),
    });
  }
  const push4 = disassemblePush4(runtime);
  const dispatcher = new Map();
  for (const row of push4.filter((x) => x.dispatcherLike)) {
    if (!dispatcher.has(row.selector)) dispatcher.set(row.selector, []);
    dispatcher.get(row.selector).push(row.offset);
  }
  const completeDispatcherMap = [...dispatcher.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([selector, offsets]) => ({
    selector,
    offsets,
    abiFunctions: bySelector.get(selector) || [],
    mappedByExplorerAbi: bySelector.has(selector),
  }));
  const abiFunctions = [...bySelector.entries()].sort(([a], [b]) => a.localeCompare(b)).flatMap(([selector, functions]) => functions.map((x) => ({
    selector, ...x, observedInDispatcherComparators: dispatcher.has(selector),
  })));
  return {
    iface,
    abiFunctions,
    push4Occurrences: push4,
    completeDispatcherMap,
    unmappedDispatcherSelectors: completeDispatcherMap.filter((x) => !x.mappedByExplorerAbi).map((x) => x.selector),
    abiSelectorsNotObservedInDispatcherComparators: abiFunctions.filter((x) => !x.observedInDispatcherComparators).map((x) => x.selector),
    limitations: [
      "Map is exhaustive for disassembled PUSH4 instructions participating in local DUP/PUSH4/EQ-or-GT dispatcher comparisons.",
      "It is not formal reachability proof: computed/assembly dispatch, selectors materialized without PUSH4, dead branches, and nonstandard fallback parsing can evade this heuristic.",
      "Non-dispatch PUSH4 constants/custom-error selectors are retained separately in push4Occurrences and are not mislabeled as callable functions.",
    ],
  };
}

function focusedCategory(fn) {
  const name = fn.name.toLowerCase();
  const sig = fn.signature.toLowerCase();
  if (/^(initialize|reinitialize|upgrade|upgradeto|upgradetoandcall|proxiableuuid)/.test(name)) return "initializer-reinitializer-uups";
  if (/^(grantrole|revokerole|renouncerole|transferownership|acceptownership|addvalidator|removevalidator|addtoken|removetoken|settokenhash|updatehourlylimit|pause|unpause)/.test(name)) return "owner-role-module-mutation";
  if (/(arbitrary|execute|multicall|approve|sweep|withdraw|release|transfernative|transfererc20)/.test(name)
      || /(^|\W)call\(/.test(sig)) return "call-approve-sweep-withdraw-release-transfer";
  return null;
}

function decodeErrorString(data) {
  if (typeof data !== "string" || !data.startsWith("0x08c379a0")) return null;
  try { return AbiCoder.defaultAbiCoder().decode(["string"], `0x${data.slice(10)}`)[0]; } catch { return null; }
}
function decodedError(iface, data) {
  if (!data || data === "0x") return null;
  try {
    const parsed = iface.parseError(data);
    return parsed ? { name: parsed.name, signature: parsed.signature, selector: parsed.selector, arguments: [...parsed.args].map((x) => typeof x === "bigint" ? x.toString() : String(x)) } : null;
  } catch {
    const reason = decodeErrorString(data);
    return reason ? { name: "Error", signature: "Error(string)", selector: "0x08c379a0", arguments: [reason] } : { name: "UnknownCustomError", selector: data.slice(0, 10), arguments: null };
  }
}
function classifyCall(response, iface, candidate, caller) {
  if (response.ok) {
    const benign = candidate.signature.startsWith("renounceRole(");
    return {
      outcome: "success", classification: benign ? "benign-self-renounce-no-control-gain" : "control-or-outflow-call-succeeded",
      exactData: response.result, errorCode: null, sanitizedMessage: null, decodedError: null,
    };
  }
  const error = response.error || response.failure || {};
  const data = typeof error.data === "string" ? error.data.toLowerCase() : null;
  const decoded = decodedError(iface, data);
  const text = `${error.message || ""} ${decoded?.name || ""} ${decoded?.signature || ""} ${(decoded && decoded.arguments ? decoded.arguments.join(" ") : "")}`.toLowerCase();
  let classification = "unresolved-rejection";
  if (/invalidinitialization|already initialized|initialized contract/.test(text)) classification = "already-initialized";
  else if (/accesscontrolunauthorizedaccount|ownableunauthorizedaccount|missing role|not.*role|unauthori[sz]ed|caller is not|only admin|only owner/.test(text)) classification = "authorization-rejection";
  else if (/signature|validator|proof|withdraw.*hash|not verified|invalid.*order|nonce|expired/.test(text)) classification = "proof-or-validator-rejection";
  else if (/zero amount|amount.*zero|invalid amount/.test(text)) classification = "zero-amount-rejection";
  else if (/unsupported token|token.*not support|module.*not|validator.*not found|missing module/.test(text)) classification = "missing-role-or-module-rejection";
  else if (/safeerc20|erc20.*failed|transfer failed|insufficient balance|allowance/.test(text)) classification = "downstream-token-rejection";
  else if (/calldata|abi decode|out of bounds|buffer overrun|invalid tuple/.test(text)) classification = "malformed-calldata-rejection";
  return {
    outcome: response.error ? "revert" : "failure", classification, exactData: data,
    errorCode: error.code ?? null, sanitizedMessage: error.message || null, decodedError: decoded,
    callerBindingObserved: Boolean(decoded && decoded.arguments && decoded.arguments.some((x) => String(x).toLowerCase() === caller.toLowerCase())),
  };
}

function minimalValue(param, context, depth = 0) {
  if (depth > 4) throw new Error(`minimal calldata recursion exceeded for ${param.type}`);
  const name = String(param.name || "").toLowerCase();
  if (param.baseType === "array") {
    if (name.includes("signature") || name.includes("proof")) return [];
    return [minimalValue(param.arrayChildren, context, depth + 1)];
  }
  if (param.baseType === "tuple") return param.components.map((x) => minimalValue(x, context, depth + 1));
  if (param.type === "address") {
    if (name.includes("implementation")) return context.implementation;
    if (name.includes("token") || name.includes("asset")) return context.token;
    return context.caller;
  }
  if (/^uint|^int/.test(param.type)) return 1n;
  if (param.type === "bool") return false;
  if (param.type === "string") return "probe";
  if (param.type === "bytes") return "0x";
  if (/^bytes\d+$/.test(param.type)) return `0x${"00".repeat(Number(param.type.slice(5)))}`;
  throw new Error(`unsupported minimal calldata type ${param.type}`);
}
function candidateArgs(fragment, context) {
  const signature = canonicalSignature(fragment);
  const explicit = {
    "initialize(address)": [context.caller],
    "upgradeTo(address)": [context.implementation],
    "upgradeToAndCall(address,bytes)": [context.implementation, "0x"],
    "grantRole(bytes32,address)": [context.defaultAdminRole, context.caller],
    "revokeRole(bytes32,address)": [context.defaultAdminRole, context.caller],
    "renounceRole(bytes32,address)": [context.defaultAdminRole, context.caller],
    "pause()": [], "unpause()": [],
    "addValidator((address,uint256)[])": [[[context.caller, 1n]]],
    "removeValidator((address,uint256)[])": [[[context.caller, 1n]]],
    "addToken(address,address,uint256,bool,uint8,uint8)": [context.token, context.caller, 1n, false, 18, 18],
    "addToken(address,address,uint256,bool,uint8,uint8,string)": [context.token, context.caller, 1n, false, 18, 18, "probe"],
    "removeToken(address)": [context.token],
    "setTokenHash(address,string)": [context.token, "probe"],
    "withdrawFee(address[],uint256[],address)": [[context.token], [1n], context.caller],
    "withdraw(uint256,(address,uint256)[],(address,uint256,uint256,address),bytes[])": [1n, [[context.token, 1n]], [context.caller, 1n, 1n, context.caller], []],
  };
  return Object.prototype.hasOwnProperty.call(explicit, signature)
    ? explicit[signature] : fragment.inputs.map((x) => minimalValue(x, context));
}

async function ethCall(rpc, pinTag, from, to, data, label) {
  return rpc.read("eth_call", [{ from, to, data }, pinTag], label);
}
function decodeFunctionResult(iface, signature, response) {
  if (!response.ok) {
    const error = response.error || response.failure || {};
    return { outcome: response.error ? "revert" : "failure", exactData: error.data || null, sanitizedMessage: error.message || null, decoded: null };
  }
  try {
    const decoded = iface.decodeFunctionResult(signature, response.result);
    return { outcome: "success", exactData: response.result, decoded: [...decoded].map((x) => typeof x === "bigint" ? x.toString() : (Array.isArray(x) ? x.map(String) : String(x))) };
  } catch (error) {
    return { outcome: "malformed-success", exactData: response.result, decoded: null, sanitizedMessage: safeMessage(error.message) };
  }
}

function roleGetter(iface, name) {
  try {
    const fragment = iface.getFunction(`${name}()`);
    return fragment && fragment.outputs.length === 1 && fragment.outputs[0].type === "bytes32" ? fragment : null;
  } catch { return null; }
}
function firstFunction(iface, signatures) {
  for (const signature of signatures) {
    try { const fragment = iface.getFunction(signature); if (fragment) return fragment; } catch { /* continue */ }
  }
  return null;
}
function md(value) { return String(value == null ? "null" : value).replace(/\|/g, "\\|").replace(/\n/g, " "); }
function short(value, n = 14) { return value && value.length > n + 4 ? `${value.slice(0, n)}…${value.slice(-4)}` : (value || "null"); }

function deriveClassification(raw) {
  const seriousSuccess = raw.callMatrix.some((x) => x.result.outcome === "success" && x.result.classification === "control-or-outflow-call-succeeded");
  if (seriousSuccess) return { signal: "🟡 VULNERABLE", classification: "VULNERABLE/CONTROL-OR-OUTFLOW-ETH_CALL-SUCCEEDED/NEEDS-SEPARATE-SAME-PIN-LOCAL-FORK", closeSubbranch: false, escalationTriggered: true };
  const allCallsResolved = raw.callMatrix.length === raw.focusedSelectors.filter((x) => x.stateMutability !== "view" && x.stateMutability !== "pure").length
    && raw.callMatrix.every((x) => !["failure", "malformed-success"].includes(x.result.outcome) && x.result.classification !== "malformed-calldata-rejection");
  const runtimeBound = raw.proxy.code.present && raw.implementation.code.present && raw.terminalPinConsistency.consistent;
  const sourceEquivalent = raw.sourceRuntime.localExactBuildEquivalence === true;
  if (runtimeBound && allCallsResolved && sourceEquivalent) return { signal: "⚪ CLEAN", classification: "CLOSED/SOURCE-RUNTIME-EQUIVALENT/CONTROL-AND-OUTFLOW-GATED", closeSubbranch: true, escalationTriggered: false };
  return { signal: "🟠 WATCH", classification: "INCOMPLETE/WATCH/SOURCE-RUNTIME-EQUIVALENCE-AND-SEMANTIC-CLOSURE-OPEN", closeSubbranch: false, escalationTriggered: false };
}

function renderReport(raw) {
  const lines = [];
  lines.push("# Aster Bridge BNB Treasury Control / Direct-Release Review", "", `Signal: ${raw.signal} — **${raw.classification}**.`, "");
  lines.push("## Scope and fixed pin", "");
  lines.push(`- Run ID: \`${raw.runId}\`.`);
  lines.push(`- BNB finalized pin: block \`${raw.pin.blockNumberDecimal}\` / \`${raw.pin.blockHash}\`; terminal same-number hash recheck: **${raw.terminalPinConsistency.consistent ? "PASS" : "FAIL"}**.`);
  lines.push(`- Proxy \`${raw.proxy.address}\`: ${raw.proxy.code.bytes} bytes, runtime \`${raw.proxy.code.keccak256}\`.`);
  lines.push(`- EIP-1967 implementation: \`${raw.implementation.address}\` (recorded hypothesis match=${raw.implementation.recordedHypothesisMatch}); admin=${raw.proxy.adminAddress || "zero"}; beacon=${raw.proxy.beaconAddress || "zero"}.`);
  lines.push(`- Implementation: ${raw.implementation.code.bytes} bytes, runtime \`${raw.implementation.code.keccak256}\`.`);
  lines.push(`- Deterministic caller: \`${raw.caller.address}\`; code at pin \`${raw.caller.codeExact}\` (noCodeAtPin=${raw.caller.noCodeAtPin}).`);
  lines.push(`- Requests: JSON-RPC final scanner **${raw.requestBudget.rpcReads}**, task-total including one serialization-failed read-only attempt **${raw.requestBudget.rpcReadsTaskTotal}/${raw.requestBudget.rpcCap}**; public source/metadata scanner **${raw.requestBudget.publicSourceRequestsScanner}**, task-total **${raw.requestBudget.publicSourceRequestsTaskTotal}/${raw.requestBudget.publicSourceRequestCap}**.`);
  lines.push("- No endpoint inventories, `.env`, raw URLs, credentials, history scan, trace, transaction, signature, broadcast, fork, state override, mutation, or real funds.", "");
  lines.push("## Source/runtime and dispatcher", "");
  lines.push(`- Explorer status: verified=${raw.sourceRuntime.explorer.explorerVerified}; contract=${raw.sourceRuntime.explorer.contractName}; compiler=${raw.sourceRuntime.explorer.compilerVersion}; ABI functions=${raw.sourceRuntime.dispatcher.abiFunctions.length}; source files hashed=${raw.sourceRuntime.explorer.sourceFiles.length}.`);
  lines.push(`- Explorer displayed-runtime match=${raw.sourceRuntime.explorer.displayedRuntimeMatch}; local exact-build source/runtime equivalence=${raw.sourceRuntime.localExactBuildEquivalence}.`);
  lines.push(`- Runtime dispatcher comparator selectors=${raw.sourceRuntime.dispatcher.completeDispatcherMap.length}; unmapped=${raw.sourceRuntime.dispatcher.unmappedDispatcherSelectors.length}; ABI selectors absent from comparator heuristic=${raw.sourceRuntime.dispatcher.abiSelectorsNotObservedInDispatcherComparators.length}.`);
  lines.push("- The raw JSON contains the complete observed dispatcher comparator map and all PUSH4 occurrences. This is bounded bytecode evidence, not formal reachability proof for computed/nonstandard dispatch.", "");
  lines.push("## Roles and module state", "");
  lines.push(`- Initialized probe: ${raw.initializedState}. AccessControl role constants resolved: ${raw.roles.length}; role-member resolution gaps: ${raw.roles.filter((x) => x.membersOutcome !== "success").length}.`);
  for (const role of raw.roles) lines.push(`- ${role.name} \`${short(role.role)}\`: ${role.members.length ? role.members.join(", ") : role.membersOutcome}.`);
  lines.push(`- One-hop state getters: ${Object.entries(raw.moduleState).map(([k, v]) => `${k}=${v.outcome}${v.decoded ? `(${md(JSON.stringify(v.decoded))})` : ""}`).join("; ") || "none"}.`, "");
  lines.push("## Same-pin balances", "");
  lines.push(`- Native BNB: \`${raw.balances.native.rawWei}\` wei = \`${raw.balances.native.formatted}\` BNB.`);
  lines.push("| Token | Address | Raw | Exact units |", "|---|---|---:|---:|");
  for (const token of raw.balances.tokens) lines.push(`| ${token.symbol} | ${token.address} | ${token.balanceRaw == null ? "null" : token.balanceRaw} | ${token.formatted == null ? "null" : token.formatted} |`);
  lines.push("", "## Selector / call matrix", "");
  lines.push("| Category | Selector | Signature | Outcome | Classification | Exact return/revert |", "|---|---|---|---|---|---|");
  for (const row of raw.callMatrix) lines.push(`| ${md(row.category)} | ${row.selector} | ${md(row.signature)} | ${row.result.outcome} | ${md(row.result.classification)} | ${short(row.result.exactData, 22)} |`);
  lines.push("", "## Finding and blockers", "");
  if (raw.escalationTriggered) {
    lines.push("- A control/outflow simulation succeeded sufficiently to gate a separate same-pin local-fork balance-delta proof. No fork was run in this task.");
  } else {
    lines.push("- No executed outsider call in the scoped matrix demonstrated initialization, role/control acquisition, upgrade, approval/arbitrary call, or direct native/ERC20 value release.");
  }
  if (!raw.requestBudget.rpcCompliant) lines.push(`- **Read-budget check FAIL:** task-total JSON-RPC reads were \`${raw.requestBudget.rpcReadsTaskTotal}/${raw.requestBudget.rpcCap}\` after a full read-only attempt reached terminal recheck but failed during offline BigInt serialization; no further RPC reads are permitted in this task.`);
  for (const gap of raw.coverageGaps || []) lines.push(`- Coverage gap: ${gap}`);
  lines.push("- The subbranch is not closed: exact local source compilation/runtime equivalence was not established, so source-level ordering, every inherited/assembly selector, and exact withdrawal validator semantics remain coverage-open.");
  lines.push(`- Route/executable/signing remain \`${raw.routePositive}/${raw.executableNow}/${raw.signedActionJustified}\`.`);
  lines.push("", "## Defensive next action", "", `- ${raw.nextAction}`, "");
  return `${lines.join("\n")}\n`;
}

async function scan() {
  const rpc = new RpcReader();
  const sources = new SourceReader();
  const finalized = await rpc.read("eth_getBlockByNumber", ["finalized", false], "pin.selectFinalized");
  if (!finalized.ok || !finalized.result?.number || !finalized.result?.hash || !finalized.result?.timestamp) throw new Error("finalized block selection failed");
  const pin = {
    selection: "eth_getBlockByNumber(finalized,false)",
    blockNumberHex: finalized.result.number.toLowerCase(),
    blockNumberDecimal: Number(BigInt(finalized.result.number)),
    blockHash: finalized.result.hash.toLowerCase(),
    blockTimestampHex: finalized.result.timestamp.toLowerCase(),
    blockTimestampDecimal: Number(BigInt(finalized.result.timestamp)),
    postPinReadTag: "block-number",
    terminalNumberHashRecheckRequired: true,
  };
  const generatedAt = new Date(pin.blockTimestampDecimal * 1000).toISOString();
  const runId = `aster-bnb-treasury-control-${pin.blockNumberDecimal}-${pin.blockHash.slice(2, 14)}`;
  const callerDigest = keccak256(toUtf8Bytes(`authorized-defensive:${runId}:no-code-caller`));
  const caller = getAddress(`0x${callerDigest.slice(-40)}`);

  const [proxyCodeR, implSlotR, adminSlotR, beaconSlotR, callerCodeR] = await Promise.all([
    rpc.read("eth_getCode", [PROXY, pin.blockNumberHex], "proxy.getCode"),
    rpc.read("eth_getStorageAt", [PROXY, IMPLEMENTATION_SLOT, pin.blockNumberHex], "proxy.slot.implementation"),
    rpc.read("eth_getStorageAt", [PROXY, ADMIN_SLOT, pin.blockNumberHex], "proxy.slot.admin"),
    rpc.read("eth_getStorageAt", [PROXY, BEACON_SLOT, pin.blockNumberHex], "proxy.slot.beacon"),
    rpc.read("eth_getCode", [caller, pin.blockNumberHex], "caller.getCode"),
  ]);
  if (![proxyCodeR, implSlotR, adminSlotR, beaconSlotR, callerCodeR].every((x) => x.ok)) throw new Error("fixed-pin proxy/caller binding read failed");
  const slotImpl = slotAddress(implSlotR.result);
  const adminAddress = slotAddress(adminSlotR.result);
  const beaconAddress = slotAddress(beaconSlotR.result);
  if (!slotImpl && !beaconAddress) throw new Error("implementation and beacon slots are both zero");
  if (nonEmptyCode(callerCodeR.result)) throw new Error("derived caller has code at fixed pin");
  let actualImplementation = slotImpl;
  let beaconHop = null;
  if (!actualImplementation && beaconAddress) {
    const beaconCodeR = await rpc.read("eth_getCode", [beaconAddress, pin.blockNumberHex], "beacon.getCode");
    const beaconImplR = await ethCall(rpc, pin.blockNumberHex, caller, beaconAddress, BEACON.encodeFunctionData("implementation"), "beacon.implementation");
    if (!beaconCodeR.ok || !nonEmptyCode(beaconCodeR.result) || !beaconImplR.ok) throw new Error("beacon implementation hop unresolved");
    actualImplementation = getAddress(BEACON.decodeFunctionResult("implementation", beaconImplR.result)[0]);
    beaconHop = { address: beaconAddress, code: codeInfo(beaconCodeR.result), exactImplementationReturn: beaconImplR.result };
  }
  const implCodeR = await rpc.read("eth_getCode", [actualImplementation, pin.blockNumberHex], "implementation.getCode");
  if (!implCodeR.ok || !nonEmptyCode(proxyCodeR.result) || !nonEmptyCode(implCodeR.result)) throw new Error("proxy or actual implementation runtime absent");

  const sourcePage = await sources.explorerPage(actualImplementation);
  const explorer = parseExplorer(sourcePage.html, implCodeR.result);
  if (!explorer.abi) throw new Error(`verified ABI resolution failed: ${explorer.abiParseError || sourcePage.failure || "ABI block absent"}`);
  const inventory = functionInventory(explorer.abi, implCodeR.result);
  const iface = inventory.iface;

  const balances = { native: null, tokens: [] };
  const nativeR = await rpc.read("eth_getBalance", [PROXY, pin.blockNumberHex], "balance.native");
  if (!nativeR.ok) throw new Error("native balance read failed");
  balances.native = { rawWei: BigInt(nativeR.result).toString(), formatted: formatUnitsExact(BigInt(nativeR.result), 18) };
  for (const token of TOKENS) {
    const balanceR = await ethCall(rpc, pin.blockNumberHex, caller, token.address, ERC20.encodeFunctionData("balanceOf", [PROXY]), `balance.${token.symbol}`);
    const decimalsR = await ethCall(rpc, pin.blockNumberHex, caller, token.address, ERC20.encodeFunctionData("decimals"), `decimals.${token.symbol}`);
    let balanceRaw = null; let decimals = null; let formatted = null;
    try { if (balanceR.ok) balanceRaw = ERC20.decodeFunctionResult("balanceOf", balanceR.result)[0].toString(); } catch { /* retained null */ }
    try { if (decimalsR.ok) decimals = Number(ERC20.decodeFunctionResult("decimals", decimalsR.result)[0]); } catch { /* retained null */ }
    if (balanceRaw != null && decimals != null) formatted = formatUnitsExact(BigInt(balanceRaw), decimals);
    balances.tokens.push({ ...token, balanceRaw, decimals, formatted, balanceExactReturn: balanceR.ok ? balanceR.result : (balanceR.error?.data || null), decimalsExactReturn: decimalsR.ok ? decimalsR.result : (decimalsR.error?.data || null) });
  }
  const heldToken = balances.tokens.find((x) => x.symbol === "USDT" && x.balanceRaw != null && BigInt(x.balanceRaw) > 0n)
    || balances.tokens.find((x) => x.balanceRaw != null && BigInt(x.balanceRaw) > 0n);
  if (!heldToken) throw new Error("no same-pin scoped held token available for one-base-unit probes");

  const roles = [];
  const roleValues = new Map();
  for (const name of ROLE_CONSTANT_NAMES) {
    const getter = roleGetter(iface, name);
    if (!getter) continue;
    const signature = canonicalSignature(getter);
    const response = await ethCall(rpc, pin.blockNumberHex, caller, PROXY, iface.encodeFunctionData(signature), `role.${name}.constant`);
    const decoded = decodeFunctionResult(iface, signature, response);
    const role = decoded.outcome === "success" ? String(decoded.decoded[0]).toLowerCase() : null;
    if (role) roleValues.set(name, role);
    roles.push({ name, selector: iface.getFunction(signature).selector, role, constantOutcome: decoded.outcome, constantExactData: decoded.exactData, members: [], membersOutcome: "not-probed" });
  }
  const membersFn = firstFunction(iface, ["getRoleMembers(bytes32)"]);
  const countFn = firstFunction(iface, ["getRoleMemberCount(bytes32)"]);
  const memberFn = firstFunction(iface, ["getRoleMember(bytes32,uint256)"]);
  for (const row of roles) {
    if (!row.role) { row.membersOutcome = "role-constant-unresolved"; continue; }
    if (membersFn) {
      const sig = canonicalSignature(membersFn);
      const response = await ethCall(rpc, pin.blockNumberHex, caller, PROXY, iface.encodeFunctionData(sig, [row.role]), `role.${row.name}.members`);
      const decoded = decodeFunctionResult(iface, sig, response);
      row.membersOutcome = decoded.outcome;
      row.membersExactData = decoded.exactData;
      if (decoded.outcome === "success") row.members = decoded.decoded[0].map((x) => getAddress(x));
    } else if (countFn && memberFn) {
      const countSig = canonicalSignature(countFn);
      const countR = await ethCall(rpc, pin.blockNumberHex, caller, PROXY, iface.encodeFunctionData(countSig, [row.role]), `role.${row.name}.count`);
      const countDecoded = decodeFunctionResult(iface, countSig, countR);
      if (countDecoded.outcome !== "success") { row.membersOutcome = countDecoded.outcome; continue; }
      const count = Number(countDecoded.decoded[0]);
      row.memberCount = count;
      if (count > 8) { row.membersOutcome = "bounded-count-over-8"; continue; }
      const memberSig = canonicalSignature(memberFn);
      for (let i = 0; i < count; i++) {
        const memberR = await ethCall(rpc, pin.blockNumberHex, caller, PROXY, iface.encodeFunctionData(memberSig, [row.role, i]), `role.${row.name}.member.${i}`);
        const memberDecoded = decodeFunctionResult(iface, memberSig, memberR);
        if (memberDecoded.outcome !== "success") { row.membersOutcome = memberDecoded.outcome; break; }
        row.members.push(getAddress(memberDecoded.decoded[0]));
      }
      if (row.members.length === count) row.membersOutcome = "success";
    } else row.membersOutcome = "enumerator-absent";
  }

  const authorityAddresses = [...new Set(roles.flatMap((x) => x.members).map((x) => x.toLowerCase()))].slice(0, 24);
  const authorityCode = [];
  for (const addressLower of authorityAddresses) {
    const address = getAddress(addressLower);
    const response = await rpc.read("eth_getCode", [address, pin.blockNumberHex], `authority.getCode.${address.slice(2, 10)}`);
    authorityCode.push({ address, code: response.ok ? codeInfo(response.result, false) : { present: null }, outcome: response.ok ? "success" : "failure" });
  }

  const moduleState = {};
  const moduleQueries = [
    ["supportToken(address)", [heldToken.address]], ["tokenHashMap(address)", [heldToken.address]],
    ["fees(address)", [heldToken.address]], ["balance(address)", [heldToken.address]],
    ["hourlyLimit()", []], ["withdrawPerHours(uint256)", [BigInt(Math.floor(pin.blockTimestampDecimal / 3600))]],
    ["TIMELOCK_ADDRESS()", []], ["WITHDRAW_VALIDATOR()", []], ["USDF_EARN()", []], ["NATIVE()", []],
    ["paused()", []],
  ];
  for (const [signature, args] of moduleQueries) {
    let fragment;
    try { fragment = iface.getFunction(signature); } catch { fragment = null; }
    if (!fragment) continue;
    const response = await ethCall(rpc, pin.blockNumberHex, caller, PROXY, iface.encodeFunctionData(signature, args), `module.${fragment.name}`);
    moduleState[signature] = decodeFunctionResult(iface, signature, response);
  }

  const focusedSelectors = inventory.abiFunctions.map((x) => ({ ...x, category: focusedCategory(x) })).filter((x) => x.category);
  const callMatrix = [];
  const defaultAdminRole = roleValues.get("DEFAULT_ADMIN_ROLE") || `0x${"00".repeat(32)}`;
  const bySelector = new Map();
  for (const fn of focusedSelectors) {
    if (fn.stateMutability === "view" || fn.stateMutability === "pure") continue;
    if (!bySelector.has(fn.selector)) bySelector.set(fn.selector, fn);
  }
  for (const fn of bySelector.values()) {
    const fragment = iface.getFunction(fn.signature);
    let data; let args;
    try {
      args = candidateArgs(fragment, { caller, implementation: actualImplementation, token: heldToken.address, defaultAdminRole });
      data = iface.encodeFunctionData(fn.signature, args);
    } catch (error) {
      callMatrix.push({ ...fn, minimalCalldataStatus: "builder-failed", builderError: safeMessage(error.message), calldata: null, result: { outcome: "failure", classification: "malformed-calldata-builder-failure", exactData: null } });
      continue;
    }
    const response = await ethCall(rpc, pin.blockNumberHex, caller, PROXY, data, `candidate.${fn.selector}`);
    callMatrix.push({ ...fn, minimalCalldataStatus: "structurally-encoded", calldata: data, calldataArgumentsSanitized: jsonSafe(args), heldTokenBaseUnitsUsed: fn.signature.includes("withdraw") ? "1" : null, result: classifyCall(response, iface, fn, caller) });
  }

  const terminal = await rpc.read("eth_getBlockByNumber", [pin.blockNumberHex, false], "pin.terminalNumberHashRecheck");
  const terminalPinConsistency = {
    responseOk: terminal.ok,
    number: terminal.ok ? terminal.result?.number?.toLowerCase() || null : null,
    hash: terminal.ok ? terminal.result?.hash?.toLowerCase() || null : null,
    consistent: Boolean(terminal.ok && terminal.result?.number?.toLowerCase() === pin.blockNumberHex && terminal.result?.hash?.toLowerCase() === pin.blockHash),
  };

  const initializedCall = callMatrix.find((x) => x.name.toLowerCase() === "initialize");
  const raw = {
    generatedAt, runId, scanner: SCANNER,
    scope: "Authorized Aster Bridge BNB treasury proxy control/direct-release finalized-pin read-only review",
    signal: null, classification: null, closeSubbranch: false, escalationTriggered: false,
    chain: { name: "BNB Smart Chain", chainId: CHAIN_ID, endpointPreset: "public-no-secret-preset", endpointValueStored: false },
    pin,
    terminalPinConsistency,
    caller: { derivation: "last20(keccak256(utf8('authorized-defensive:' + runId + ':no-code-caller')))", address: caller, codeExact: callerCodeR.result, noCodeAtPin: !nonEmptyCode(callerCodeR.result) },
    proxy: {
      address: PROXY, code: codeInfo(proxyCodeR.result),
      slots: { implementation: implSlotR.result, admin: adminSlotR.result, beacon: beaconSlotR.result },
      implementationAddress: slotImpl, adminAddress, beaconAddress, beaconHop,
    },
    implementation: { address: actualImplementation, code: codeInfo(implCodeR.result), recordedHypothesis: RECORDED_IMPLEMENTATION_HYPOTHESIS, recordedHypothesisMatch: actualImplementation.toLowerCase() === RECORDED_IMPLEMENTATION_HYPOTHESIS.toLowerCase() },
    sourceRuntime: {
      status: "EXPLORER-VERIFIED-SOURCE-AND-ABI/LOCAL-EXACT-BUILD-EQUIVALENCE-NOT-PROVEN",
      explorer,
      localExactBuildEquivalence: false,
      dispatcher: {
        abiFunctions: inventory.abiFunctions,
        push4Occurrences: inventory.push4Occurrences,
        completeDispatcherMap: inventory.completeDispatcherMap,
        unmappedDispatcherSelectors: inventory.unmappedDispatcherSelectors,
        abiSelectorsNotObservedInDispatcherComparators: inventory.abiSelectorsNotObservedInDispatcherComparators,
        limitations: inventory.limitations,
      },
    },
    focusedSelectors,
    initializedState: initializedCall?.result.classification === "already-initialized" ? "initialized-probe-rejected-as-already-initialized" : "unresolved",
    roles,
    authorityCode,
    moduleState,
    oneHopBoundary: { roleMemberCodeClassificationOnly: true, moduleStateDirectTreasuryGettersOnly: true, outflowRecipientDirectCallerOnly: true, recursiveModuleTraversal: false },
    balances,
    heldTokenProbe: { symbol: heldToken.symbol, address: heldToken.address, oneBaseUnit: "1", samePinTreasuryBalanceRaw: heldToken.balanceRaw },
    callMatrix,
    safety: {
      authorizedDefensive: true, readOnly: true, endpointInventoriesRead: false, envFilesRead: false,
      graphqlEndpointInventoryRead: false, endpointValuesStored: false, credentialsStored: false,
      transactions: false, signing: false, broadcasts: false, forkPerformed: false,
      stateOverrides: false, debugTraceCall: false, historyScan: false, liveMutation: false, realFunds: false,
      aggregateCoordinatorFilesEdited: false,
    },
    requestBudget: {
      rpcReads: rpc.count,
      priorFullReadAttempts: PRIOR_FULL_READ_ATTEMPTS,
      priorAttemptReadCountBasis: "same deterministic execution path reached terminal recheck before offline serialization failure",
      rpcReadsTaskTotal: rpc.count * (PRIOR_FULL_READ_ATTEMPTS + 1),
      rpcCap: MAX_RPC_READS, rpcCompliant: rpc.count * (PRIOR_FULL_READ_ATTEMPTS + 1) <= MAX_RPC_READS,
      publicSourceRequestsScanner: sources.count,
      preScannerExploratoryPublicRequests: PRE_SCANNER_PUBLIC_SOURCE_REQUESTS,
      publicSourceRequestsTaskTotal: PRE_SCANNER_PUBLIC_SOURCE_REQUESTS + sources.count,
      publicSourceRequestCap: MAX_PUBLIC_SOURCE_REQUESTS,
      publicSourceCompliant: PRE_SCANNER_PUBLIC_SOURCE_REQUESTS + sources.count <= MAX_PUBLIC_SOURCE_REQUESTS,
    },
    rpcTranscript: rpc.transcript,
    publicSourceTranscript: sources.transcript,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    manifestPath: OUT_MANIFEST,
    nextAction: "Reproduce the explorer's exact standard-json compiler input and locally compile with the pinned compiler/settings; compare normalized runtime and then review the unresolved withdrawal validator/signature ordering. Re-run only on code/role/module drift. Fork only if a same-pin control/outflow eth_call succeeds.",
  };
  const derived = deriveClassification(raw);
  Object.assign(raw, derived);
  writeOwned(OUT_RAW, `${JSON.stringify(raw, null, 2)}\n`);
  writeOwned(OUT_REPORT, renderReport(raw));
  const records = [SCANNER, OUT_RAW, OUT_REPORT].map(sha256File);
  const aggregateSha256 = sha256Buffer(Buffer.from(records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n")));
  const manifest = {
    generatedAt, runId, manifestVersion: 1, hashAlgorithm: "sha256", records, aggregateSha256,
    classification: raw.classification, signal: raw.signal, closeSubbranch: raw.closeSubbranch,
    pin: { blockNumberDecimal: pin.blockNumberDecimal, blockHash: pin.blockHash, terminalConsistent: terminalPinConsistency.consistent },
    rpcReadCountFinalScanner: rpc.count, rpcReadCountTaskTotal: rpc.count * (PRIOR_FULL_READ_ATTEMPTS + 1), rpcReadCap: MAX_RPC_READS,
    publicSourceRequestsTaskTotal: PRE_SCANNER_PUBLIC_SOURCE_REQUESTS + sources.count,
    publicSourceRequestCap: MAX_PUBLIC_SOURCE_REQUESTS,
    endpointValuesStored: false, routePositive: 0, executableNow: 0, signedActionJustified: false,
  };
  writeOwned(OUT_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`runId=${runId} classification=${raw.classification} reads=${rpc.count}/${MAX_RPC_READS} sourceRequests=${PRE_SCANNER_PUBLIC_SOURCE_REQUESTS + sources.count}/${MAX_PUBLIC_SOURCE_REQUESTS}`);
  console.log(`wrote ${OUT_RAW}, ${OUT_MANIFEST}, ${OUT_REPORT}`);
}

function selfTest() {
  const fakeRuntime = "0x8063123456781460005763deadbeef60005200";
  const rows = disassemblePush4(fakeRuntime);
  if (rows.length !== 2 || rows[0].selector !== "0x12345678" || !rows[0].dispatcherLike || rows[1].dispatcherLike) throw new Error("dispatcher disassembly test failed");
  const caller = getAddress(`0x${"11".repeat(20)}`);
  const authData = `${id("AccessControlUnauthorizedAccount(address,bytes32)").slice(0, 10)}${"0".repeat(24)}${caller.slice(2)}${"0".repeat(64)}`;
  const iface = new Interface(["error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)"]);
  const classified = classifyCall({ ok: false, error: { code: 3, message: "execution reverted", data: authData } }, iface, { signature: "grantRole(bytes32,address)" }, caller);
  if (classified.classification !== "authorization-rejection" || !classified.callerBindingObserved) throw new Error("authorization classification test failed");
  const benign = classifyCall({ ok: true, result: "0x" }, iface, { signature: "renounceRole(bytes32,address)" }, caller);
  if (benign.classification !== "benign-self-renounce-no-control-gain") throw new Error("benign renounce test failed");
  const fragment = FunctionFragment.from("withdrawFee(address[],uint256[],address)");
  const args = candidateArgs(fragment, { caller, implementation: caller, token: caller, defaultAdminRole: `0x${"00".repeat(32)}` });
  new Interface([fragment]).encodeFunctionData(fragment, args);
  if (TOKENS.length !== 10 || new Set(TOKENS.map((x) => x.address.toLowerCase())).size !== 10) throw new Error("token inventory invariant failed");
  console.log("self-test PASS: dispatcher, authorization, benign mutation, calldata, and inventory invariants");
}

function writeDerived(raw, label) {
  writeOwned(OUT_RAW, `${JSON.stringify(raw, null, 2)}\n`);
  writeOwned(OUT_REPORT, renderReport(raw));
  const records = [SCANNER, OUT_RAW, OUT_REPORT].map(sha256File);
  const aggregateSha256 = sha256Buffer(Buffer.from(records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n")));
  const manifest = {
    generatedAt: raw.generatedAt, runId: raw.runId, manifestVersion: 1, hashAlgorithm: "sha256", records, aggregateSha256,
    classification: raw.classification, signal: raw.signal, closeSubbranch: raw.closeSubbranch,
    pin: { blockNumberDecimal: raw.pin.blockNumberDecimal, blockHash: raw.pin.blockHash, terminalConsistent: raw.terminalPinConsistency.consistent },
    rpcReadCountFinalScanner: raw.requestBudget.rpcReads, rpcReadCountTaskTotal: raw.requestBudget.rpcReadsTaskTotal, rpcReadCap: raw.requestBudget.rpcCap,
    rpcBudgetCompliant: raw.requestBudget.rpcCompliant,
    publicSourceRequestsTaskTotal: raw.requestBudget.publicSourceRequestsTaskTotal,
    publicSourceRequestCap: raw.requestBudget.publicSourceRequestCap,
    endpointValuesStored: false, routePositive: 0, executableNow: 0, signedActionJustified: false,
  };
  writeOwned(OUT_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${label}: runId=${raw.runId} (offline; zero network requests)`);
}

function applyOfflineCorrections() {
  const raw = JSON.parse(fs.readFileSync(abs(OUT_RAW), "utf8"));
  const upgrade = raw.callMatrix.find((x) => x.signature === "upgradeToAndCall(address,bytes)");
  if (upgrade?.result?.decodedError?.name === "Error" && upgrade.result.decodedError.arguments?.[0] === "only timelock") {
    upgrade.result.classification = "authorization-rejection";
  }
  const updateFn = raw.sourceRuntime.dispatcher.abiFunctions.find((x) => x.signature === "updateHourlyLimit(uint256)");
  if (updateFn && !raw.focusedSelectors.some((x) => x.selector === updateFn.selector)) {
    raw.focusedSelectors.push({ ...updateFn, category: "owner-role-module-mutation" });
    raw.focusedSelectors.sort((a, b) => a.selector.localeCompare(b.selector));
  }
  if (updateFn && !raw.callMatrix.some((x) => x.selector === updateFn.selector)) {
    raw.callMatrix.push({
      ...updateFn,
      category: "owner-role-module-mutation",
      minimalCalldataStatus: "not-encoded-budget-stop",
      calldata: null,
      calldataArgumentsSanitized: ["1"],
      heldTokenBaseUnitsUsed: null,
      result: { outcome: "skipped", classification: "not-called-task-rpc-budget-exhausted", exactData: null, errorCode: null, sanitizedMessage: null, decodedError: null },
    });
    raw.callMatrix.sort((a, b) => a.selector.localeCompare(b.selector));
  }
  raw.sourceRuntime.status = "EXPLORER-VERIFIED-METADATA-AND-ABI/SOURCE-BODIES-AND-LOCAL-EXACT-BUILD-EQUIVALENCE-UNRESOLVED";
  raw.coverageGaps = [
    "updateHourlyLimit(uint256) selector 0x413bcb44 was identified only after the final read-only run; it was not called because the task JSON-RPC cap was already exceeded and is explicitly budget-blocked.",
    "Explorer source bodies/standard-json compiler input were not recovered; exact source/runtime equivalence and source-level withdrawal ordering remain unresolved.",
    "The recorded implementation hypothesis drifted: the fixed EIP-1967 slot resolves to 0xc01AEFDaa49416FC8f68c6513EC5E6131D45c019, not 0x2CC878ac49C3BF8B0f2B053af7845BA6590eEc4f.",
  ];
  raw.signal = "🟠 WATCH";
  raw.classification = "INCOMPLETE/WATCH/RPC-BUDGET-BREACH/SOURCE-RUNTIME-AND-ONE-MUTATION-PROBE-OPEN";
  raw.closeSubbranch = false;
  raw.escalationTriggered = false;
  raw.nextAction = "Stop network work for this task. In a separately authorized bounded run, first recover the exact standard-json compiler input and prove local runtime equivalence, then issue only the omitted updateHourlyLimit(1) eth_call at a new finalized pin and re-evaluate source-level withdrawal validator ordering. Fork only if a control/outflow call succeeds.";
  writeDerived(raw, "offline corrections PASS");
}

function verify() {
  const raw = JSON.parse(fs.readFileSync(abs(OUT_RAW), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(abs(OUT_MANIFEST), "utf8"));
  const checks = [];
  const check = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail });
  let recordsPass = true;
  for (const record of manifest.records) {
    const actual = sha256File(record.path);
    if (actual.bytes !== record.bytes || actual.sha256 !== record.sha256) recordsPass = false;
  }
  const aggregate = sha256Buffer(Buffer.from(manifest.records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n")));
  check("manifest-records", recordsPass, `${manifest.records.length} records`);
  check("manifest-aggregate", aggregate === manifest.aggregateSha256, manifest.aggregateSha256);
  check("terminal-pin", raw.terminalPinConsistency.consistent, `${raw.pin.blockNumberDecimal}/${raw.pin.blockHash}`);
  check("rpc-transcript", raw.rpcTranscript.length === raw.requestBudget.rpcReads, `${raw.rpcTranscript.length}/${raw.requestBudget.rpcReads}`);
  check("read-budget", raw.requestBudget.rpcReadsTaskTotal <= MAX_RPC_READS, `${raw.requestBudget.rpcReadsTaskTotal}/${MAX_RPC_READS}`);
  check("source-budget", raw.requestBudget.publicSourceRequestsTaskTotal <= MAX_PUBLIC_SOURCE_REQUESTS && raw.publicSourceTranscript.length === raw.requestBudget.publicSourceRequestsScanner, `${raw.requestBudget.publicSourceRequestsTaskTotal}/${MAX_PUBLIC_SOURCE_REQUESTS}`);
  const leakText = [JSON.stringify(raw), fs.readFileSync(abs(OUT_REPORT), "utf8"), JSON.stringify(manifest)].join("\n");
  check("leak-scan", !/https?:\/\//i.test(leakText) && !/(?:api[_-]?key|authorization|cookie)\s*[:=]\s*(?!false|null|0)[^\s,}]+/i.test(leakText), "URL/credential regex");
  check("global-gates", raw.routePositive === 0 && raw.executableNow === 0 && raw.signedActionJustified === false, `${raw.routePositive}/${raw.executableNow}/${raw.signedActionJustified}`);
  const expected = raw.focusedSelectors.filter((x) => x.stateMutability !== "view" && x.stateMutability !== "pure").map((x) => x.selector);
  check("candidate-coverage", new Set(expected).size === raw.callMatrix.length && raw.callMatrix.every((x) => x.minimalCalldataStatus === "structurally-encoded"), `${raw.callMatrix.filter((x) => x.minimalCalldataStatus === "structurally-encoded").length}/${new Set(expected).size}`);
  const report = fs.readFileSync(abs(OUT_REPORT), "utf8");
  check("report-signal", report.includes(raw.signal) && report.includes(raw.classification), raw.signal);
  check("closure-rule", !raw.closeSubbranch || raw.sourceRuntime.localExactBuildEquivalence === true, `closeSubbranch=${raw.closeSubbranch}`);
  for (const row of checks) console.log(`${row.pass ? "PASS" : "FAIL"} ${row.name}: ${row.detail}`);
  const failures = checks.filter((x) => !x.pass);
  if (failures.length) throw new Error(`verify completed with ${failures.length} failure(s): ${failures.map((x) => x.name).join(",")}`);
  console.log(`verify PASS: runId=${raw.runId}`);
}

const mode = process.argv[2];
if (mode === "--self-test") selfTest();
else if (mode === "--apply-offline-corrections") applyOfflineCorrections();
else if (mode === "--verify") verify();
else {
  console.error("network execution disabled: exact network-runner source was not retained; use a new immutable pre-hashed minimal runner and new run ID");
  process.exitCode = 1;
}
