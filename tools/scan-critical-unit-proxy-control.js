#!/usr/bin/env node
"use strict";

// Authorized defensive Unit/Hyperunit proxy-control scanner.
// Uses one public no-secret HyperEVM preset, never reads endpoint inventories or env files,
// makes at most 74 fixed-block JSON-RPC reads, and never sends/signs/broadcasts transactions.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { AbiCoder, Interface, getAddress, id, keccak256, toUtf8Bytes } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const SCANNER = "tools/scan-critical-unit-proxy-control.js";
const OUT_RAW = "reports/raw/fast/critical-unit-proxy-control.json";
const OUT_MANIFEST = "reports/raw/fast/critical-unit-proxy-control-manifest.json";
const OUT_REPORT = "reports/critical-unit-proxy-control.md";
const MAX_RPC_READS = 74;
const CHAIN_ID_CONTEXT = 999; // Public preset context; not an additional RPC read.
const PUBLIC_RPC = ["https://", "rpc.", "hyperliquid.", "xyz/evm"].join("");

const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const PROXIES = [
  { symbol: "UBTC", address: "0x9fdbda0a5e284c32744d2f17ee5c74b284993463" },
  { symbol: "UETH", address: "0xbe6727b535545c67d5caa73dea54865b92cf7907" },
  { symbol: "USOL", address: "0x068f321fa8fb9f0d135f290ef6a3e2813e1c8a29" },
  { symbol: "UFART", address: "0x3b4575e689ded21caad31d64c4df1f10f3b2cedf" },
  { symbol: "UPUMP", address: "0x27ec642013bcb3d80ca3706599d3cda04f6f4452" },
  { symbol: "UXPL", address: "0x33af3c2540ba72054e044efe504867b39ae421f5" },
];

const VIEW_IFACE = new Interface([
  "function owner() view returns (address)",
  "function complianceAuthority() view returns (address)",
  "function hyperCoreDeployer() view returns (address)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function initialize()",
  "function upgradeToAndCall(address newImplementation, bytes data) payable",
]);

const VIEW_CALLS = [
  { name: "owner", type: "address" },
  { name: "complianceAuthority", type: "address" },
  { name: "hyperCoreDeployer", type: "address" },
  { name: "decimals", type: "uint8" },
  { name: "totalSupply", type: "uint256" },
];

const KNOWN_REVERTS = {
  invalidInitialization: id("InvalidInitialization()").slice(0, 10).toLowerCase(),
  ownableUnauthorized: id("OwnableUnauthorizedAccount(address)").slice(0, 10).toLowerCase(),
  accessControlUnauthorized: id("AccessControlUnauthorizedAccount(address,bytes32)").slice(0, 10).toLowerCase(),
};

const OPEN_UNIT_DOMAINS = [
  "guardian/exactly-once processing",
  "conversion conservation",
  "reserve/liability reconciliation",
  "alternate control interfaces",
  "source semantics",
];

function abs(rel) {
  return path.join(WORKSPACE, rel);
}

function safeMessage(value) {
  return String(value == null ? "" : value)
    .replace(/https?:\/\/[^\s"']+/gi, "[endpoint-redacted]")
    .replace(/[?&](?:key|token|api_key|apikey)=[^\s&"']+/gi, "[credential-redacted]")
    .slice(0, 1000);
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function sha256File(rel) {
  const data = fs.readFileSync(abs(rel));
  return { path: rel, bytes: data.length, sha256: sha256Buffer(data) };
}

function writeFile(rel, content) {
  const allowed = new Set([OUT_RAW, OUT_MANIFEST, OUT_REPORT]);
  if (!allowed.has(rel)) throw new Error(`write outside owned namespace refused: ${rel}`);
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
  fs.writeFileSync(abs(rel), content, "utf8");
}

function normalizeRpcError(error) {
  if (!error || typeof error !== "object") return { code: null, message: safeMessage(error), data: null };
  return {
    code: Number.isInteger(error.code) ? error.code : null,
    message: safeMessage(error.message),
    data: findRevertData(error.data),
  };
}

function findRevertData(value, depth = 0) {
  if (depth > 5 || value == null) return null;
  if (typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value)) return value.toLowerCase();
  if (typeof value !== "object") return null;
  for (const key of ["data", "result", "return", "output", "originalError"]) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const found = findRevertData(value[key], depth + 1);
      if (found != null) return found;
    }
  }
  return null;
}

class RpcReader {
  constructor() {
    this.count = 0;
    this.transcript = [];
  }

  async read(method, params, label) {
    if (this.count >= MAX_RPC_READS) throw new Error(`RPC read cap ${MAX_RPC_READS} reached before ${label}`);
    const readNumber = ++this.count;
    const body = { jsonrpc: "2.0", id: readNumber, method, params };
    let response;
    let payload;
    try {
      response = await fetch(PUBLIC_RPC, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "authorized-defensive-unit-proxy-control/1.0" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`public preset HTTP status ${response.status}`);
      payload = await response.json();
    } catch (error) {
      const failure = { kind: "transport", message: safeMessage(error && error.message ? error.message : error) };
      this.transcript.push({ readNumber, label, method, params, response: { failure } });
      return { ok: false, failure, readNumber };
    }
    if (!payload || payload.jsonrpc !== "2.0" || payload.id !== readNumber) {
      const failure = { kind: "malformed-response", message: "JSON-RPC envelope/id mismatch" };
      this.transcript.push({ readNumber, label, method, params, response: { failure } });
      return { ok: false, failure, readNumber };
    }
    if (payload.error) {
      const error = normalizeRpcError(payload.error);
      this.transcript.push({ readNumber, label, method, params, response: { error } });
      return { ok: false, error, readNumber };
    }
    this.transcript.push({ readNumber, label, method, params, response: { result: payload.result } });
    return { ok: true, result: payload.result, readNumber };
  }
}

function nonEmptyCode(code) {
  return typeof code === "string" && /^0x[0-9a-fA-F]+$/.test(code) && code !== "0x" && !/^0x0*$/.test(code);
}

function codeInfo(code) {
  return {
    exact: code,
    bytes: nonEmptyCode(code) ? (code.length - 2) / 2 : 0,
    keccak256: nonEmptyCode(code) ? keccak256(code) : null,
    present: nonEmptyCode(code),
  };
}

function slotAddress(value) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value) || /^0x0{64}$/.test(value)) return null;
  return getAddress(`0x${value.slice(-40)}`);
}

function decodeErrorString(data) {
  if (typeof data !== "string" || !data.toLowerCase().startsWith("0x08c379a0") || data.length < 10) return null;
  try {
    return AbiCoder.defaultAbiCoder().decode(["string"], `0x${data.slice(10)}`)[0];
  } catch {
    return null;
  }
}

function decodeCustomError(data) {
  if (typeof data !== "string" || !/^0x[0-9a-fA-F]*$/.test(data)) return null;
  const hex = data.slice(2).toLowerCase();
  if (hex.length < 8) return null;
  const selector = `0x${hex.slice(0, 8)}`;
  const decodeAddressWord = (word) => {
    if (word.length !== 64 || !/^0{24}[0-9a-f]{40}$/.test(word)) return null;
    try {
      return getAddress(`0x${word.slice(24)}`);
    } catch {
      return null;
    }
  };
  if (selector === KNOWN_REVERTS.invalidInitialization) {
    return hex.length === 8 ? { name: "InvalidInitialization", selector, arguments: {} } : { malformedKnownError: true, selector };
  }
  if (selector === KNOWN_REVERTS.ownableUnauthorized) {
    if (hex.length !== 72) return { malformedKnownError: true, selector };
    const account = decodeAddressWord(hex.slice(8, 72));
    return account ? { name: "OwnableUnauthorizedAccount", selector, arguments: { account } } : { malformedKnownError: true, selector };
  }
  if (selector === KNOWN_REVERTS.accessControlUnauthorized) {
    if (hex.length !== 136) return { malformedKnownError: true, selector };
    const account = decodeAddressWord(hex.slice(8, 72));
    const neededRole = `0x${hex.slice(72, 136)}`;
    return account ? { name: "AccessControlUnauthorizedAccount", selector, arguments: { account, neededRole } } : { malformedKnownError: true, selector };
  }
  return { name: "UnknownCustomError", selector, arguments: null };
}

function classifyControlResponse(response, expectedProbeSender) {
  if (response.ok) return { outcome: "success", classification: "permissionless-call-succeeded", exactData: response.result };
  const error = response.error || response.failure || {};
  const data = typeof error.data === "string" ? error.data.toLowerCase() : null;
  const customError = decodeCustomError(data);
  const reason = decodeErrorString(data);
  const combined = `${error.message || ""} ${reason || ""}`.toLowerCase();
  let expected = null;
  try {
    expected = expectedProbeSender ? getAddress(expectedProbeSender) : null;
  } catch {
    expected = null;
  }
  const base = { outcome: response.error ? "revert" : "failure", exactData: data, errorCode: error.code ?? null, sanitizedMessage: error.message || null, decodedReason: reason, decodedError: customError };
  if (customError && customError.malformedKnownError) return { ...base, classification: "unknown" };
  if (customError && customError.name === "InvalidInitialization") return { ...base, classification: "already-initialized" };
  if (customError && customError.name === "OwnableUnauthorizedAccount") {
    return { ...base, classification: expected && customError.arguments.account === expected ? "authorization" : "unknown" };
  }
  if (customError && customError.name === "AccessControlUnauthorizedAccount") {
    return { ...base, classification: expected && customError.arguments.account === expected ? "authorization" : "unknown" };
  }
  if ((!customError || customError.name === "UnknownCustomError") && reason && /already initialized|initialized contract|invalidinitialization/.test(combined)) {
    return { ...base, classification: "already-initialized" };
  }
  if ((!customError || customError.name === "UnknownCustomError") && reason && /unauthori[sz]ed|caller is not the owner|not owner|accesscontrol|missing role|only owner/.test(combined)) {
    return { ...base, classification: "authorization" };
  }
  return { ...base, classification: "unknown" };
}

function decodeViewResponse(name, type, response) {
  if (!response.ok) {
    const error = response.error || response.failure || {};
    return { outcome: response.error ? "revert" : "failure", exactData: error.data || null, errorCode: error.code ?? null, sanitizedMessage: error.message || null, decoded: null };
  }
  try {
    const decoded = VIEW_IFACE.decodeFunctionResult(name, response.result)[0];
    return { outcome: "success", exactData: response.result, decoded: type === "address" ? getAddress(decoded) : decoded.toString() };
  } catch (error) {
    return { outcome: "malformed-success", exactData: response.result, decoded: null, sanitizedMessage: safeMessage(error.message) };
  }
}

function implementationHashComparison(rows) {
  const groups = new Map();
  for (const row of rows) {
    const hash = row.implementationRuntime && row.implementationRuntime.keccak256;
    if (!hash) continue;
    if (!groups.has(hash)) groups.set(hash, []);
    groups.get(hash).push(row.symbol);
  }
  return {
    uniqueImplementationHashes: groups.size,
    groups: [...groups.entries()].map(([runtimeHash, symbols]) => ({ runtimeHash, symbols })),
    allCoveredImplementationsRuntimeIdentical: groups.size === 1 && rows.length > 0,
    caveat: groups.size > 1
      ? "Implementation runtime hashes differ. Hash differences are exact; semantic/interface differences beyond retained calls remain unresolved without source/build equivalence."
      : "Matching runtime hashes establish byte equality only at the pinned block, not storage-state or governance equivalence.",
  };
}

function deriveClassification(rows, stopReason) {
  const success = rows.some((row) => [row.controls?.initialize, row.controls?.upgradeToAndCall].some((x) => x && x.outcome === "success"));
  if (success) return { classification: "VULNERABLE/CONTROL-CALL-SUCCEEDED/NEEDS-PINNED-LOCAL-FORK", signal: "🟡 VULNERABLE", closeSubbranch: false };
  if (stopReason) return { classification: "INCOMPLETE/COVERAGE-STOP", signal: "🟠 WATCH", closeSubbranch: false };
  const codeBound = rows.length === PROXIES.length && rows.every((row) => row.codeBound === true);
  const controlsGated = rows.length === PROXIES.length && rows.every((row) => {
    const values = [row.controls?.initialize, row.controls?.upgradeToAndCall];
    return values.every((x) => x && x.outcome === "revert" && ["authorization", "already-initialized"].includes(x.classification));
  });
  if (codeBound && controlsGated) return {
    classification: "SUBBRANCH-ONLY CLEAN; OVERALL UNIT INCOMPLETE/WATCH",
    subbranchClassification: "CLOSED/CODE-BOUND/CONTROL-PROBES-GATED",
    overallUnitClassification: "INCOMPLETE/WATCH",
    signal: "🟠 WATCH",
    subbranchSignal: "⚪ CLEAN",
    closeSubbranch: true,
  };
  return { classification: "INCOMPLETE/CONTROL-CLOSE-RULE-NOT-MET", signal: "🟠 WATCH", closeSubbranch: false };
}

function md(value) {
  return String(value == null ? "" : value).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function short(value, n = 14) {
  if (!value) return "null";
  return value.length > n + 4 ? `${value.slice(0, n)}…${value.slice(-4)}` : value;
}

function renderReport(raw) {
  const lines = [];
  lines.push("# Unit / Hyperunit Proxy Control — Fixed-Block Read-Only Review", "");
  if (raw.closeSubbranch) {
    lines.push(`Signal: ${raw.signal} — **SUBBRANCH-ONLY CLEAN; overall Unit remains INCOMPLETE/WATCH**.`, "");
    lines.push(`Proxy-control subbranch: ${raw.subbranchSignal || "⚪ CLEAN"} — ${raw.subbranchClassification || "CLOSED/CODE-BOUND/CONTROL-PROBES-GATED"}.`, "");
  } else {
    lines.push(`Signal: ${raw.signal} — ${raw.classification}.`, "");
  }
  lines.push("## Scope and safety", "");
  lines.push(`- Run ID: \`${raw.runId}\`; finalized block-number-bound to the initially reported hash: block \`${raw.pin.blockNumberDecimal}\` / \`${raw.pin.blockHash}\`.`);
  lines.push(`- JSON-RPC reads: **${raw.rpcReadCount}/${raw.rpcReadCap}**. The first read selected \`finalized\`; all ${raw.rpcReadCount - 1} post-pin state/code/call reads used block-number tag \`${raw.pin.blockNumberHex}\`.`);
  lines.push("- This run did **not** use EIP-1898 hash-tagged state reads and did **not** perform a terminal block-hash recheck. The retained hash is the hash initially returned for the finalized selection.");
  lines.push(`- Probe sender: \`${raw.probeSender.address}\`; pinned runtime \`${raw.probeSender.codeExact}\` (${raw.probeSender.noCodeAtPin ? "no code proven" : "code/unresolved"}).`);
  lines.push("- Public no-secret preset only. Endpoint values are neither emitted nor stored. No endpoint inventories, `.env`, keys, signing, transactions, deployment, mutation, fork, or real funds.");
  lines.push(`- Route/executable/signing: \`${raw.routePositive}/${raw.executableNow}/${raw.signedActionJustified}\`; closeSubbranch=${raw.closeSubbranch}.`, "");
  lines.push("## Overall Unit coverage remains open", "");
  lines.push("The clean result applies only to the six-proxy initializer/UUPS control probes. Overall Unit remains `INCOMPLETE/WATCH` because these domains remain open:", "");
  for (const domain of raw.openUnitDomains || OPEN_UNIT_DOMAINS) lines.push(`- ${domain}`);
  lines.push("");
  lines.push("## Exact per-proxy result summary", "");
  lines.push("| Token | Proxy | Code-bound | Impl | Admin slot | Beacon slot | owner | compliance | deployer | decimals | supply | initialize | upgrade current impl |", "|---|---|---|---|---|---|---|---|---|---:|---:|---|---|");
  for (const row of raw.proxies) {
    lines.push(`| ${row.symbol} | ${md(row.proxyAddress)} | ${row.codeBound === true} | ${md(row.implementationAddress || "null")} | ${md(row.adminAddress || "zero")} | ${md(row.beaconAddress || "zero")} | ${md(row.views.owner?.decoded || row.views.owner?.outcome)} | ${md(row.views.complianceAuthority?.decoded || row.views.complianceAuthority?.outcome)} | ${md(row.views.hyperCoreDeployer?.decoded || row.views.hyperCoreDeployer?.outcome)} | ${md(row.views.decimals?.decoded || row.views.decimals?.outcome)} | ${md(row.views.totalSupply?.decoded || row.views.totalSupply?.outcome)} | ${md(row.controls.initialize ? `${row.controls.initialize.outcome}/${row.controls.initialize.classification}` : "skipped")} | ${md(row.controls.upgradeToAndCall ? `${row.controls.upgradeToAndCall.outcome}/${row.controls.upgradeToAndCall.classification}` : "skipped")} |`);
  }
  lines.push("");
  lines.push("## Runtime and interface comparison", "");
  lines.push(`- Proxy runtime hashes: ${raw.runtimeComparison.proxyGroups.map((x) => `${x.symbols.join("+")}=\`${short(x.runtimeHash)}\``).join("; ") || "none"}.`);
  lines.push(`- Implementation runtime hashes: ${raw.runtimeComparison.implementation.groups.map((x) => `${x.symbols.join("+")}=\`${short(x.runtimeHash)}\``).join("; ") || "none"}.`);
  lines.push(`- ${raw.runtimeComparison.implementation.caveat}`);
  lines.push(`- Unresolved interfaces/runtime differences: ${raw.unresolvedInterfaces.length ? raw.unresolvedInterfaces.join("; ") : "none in the five retained getter probes; differing implementation bytecode still requires source/build review for full semantic equivalence"}.`);
  lines.push("- A zero EIP-1967 admin slot is expected for UUPS-style proxies and is not itself anomalous.", "");
  lines.push("## Control evidence and conclusion", "");
  lines.push("- `initialize()` and `upgradeToAndCall(currentImplementation, bytes(\"\"))` were simulated with `eth_call` from the deterministic no-code sender. Exact success/revert bytes and sanitized provider errors are retained in the raw JSON transcript.");
  lines.push("- Custom errors were structurally decoded. `OwnableUnauthorizedAccount(address)` counts as authorization evidence only when its canonical ABI address argument exactly equals the deterministic probe sender; malformed/truncated selector-prefixed payloads classify as unknown.");
  if (raw.closeSubbranch) lines.push("- Close rule met: all six proxies and implementations are code-bound, and both control probes on every proxy reverted for authorization/already-initialized reasons.");
  if (raw.escalationTriggered) lines.push("- Escalation triggered by a successful control call. Additional proxies were not probed; perform only a pinned local-fork control proof next.");
  if (raw.coverageStopReason) lines.push(`- Coverage stop: ${raw.coverageStopReason}`);
  lines.push("- No asset-loss route or economic execution is established by these read-only control probes.", "");
  lines.push("## Defensive next action", "");
  lines.push(`- ${raw.nextAction}`, "");
  return `${lines.join("\n")}\n`;
}

async function scan() {
  const rpc = new RpcReader();
  let coverageStopReason = null;
  let escalationTriggered = false;
  const finalized = await rpc.read("eth_getBlockByNumber", ["finalized", false], "pin.finalizedBlock");
  if (!finalized.ok || !finalized.result || !finalized.result.number || !finalized.result.hash || !finalized.result.timestamp) {
    coverageStopReason = "finalized block/hash read failed or returned an incomplete block";
  }
  if (coverageStopReason) throw new Error(coverageStopReason);
  const pin = {
    selection: "eth_getBlockByNumber(finalized,false)",
    bindingDescription: "finalized block-number-bound to the initially reported hash",
    postPinReadTag: "block-number",
    eip1898HashTaggedReads: false,
    terminalHashRechecked: false,
    blockNumberHex: finalized.result.number.toLowerCase(),
    blockNumberDecimal: Number(BigInt(finalized.result.number)),
    blockHash: finalized.result.hash.toLowerCase(),
    blockTimestampHex: finalized.result.timestamp.toLowerCase(),
    blockTimestampDecimal: Number(BigInt(finalized.result.timestamp)),
  };
  const generatedAt = new Date(pin.blockTimestampDecimal * 1000).toISOString();
  const runId = `unit-proxy-control-${pin.blockNumberDecimal}-${pin.blockHash.slice(2, 14)}`;
  const probeDigest = keccak256(toUtf8Bytes(`authorized-defensive:${runId}:no-code-probe`));
  const probeAddress = getAddress(`0x${probeDigest.slice(-40)}`);
  const probeCodeResponse = await rpc.read("eth_getCode", [probeAddress, pin.blockNumberHex], "probe.getCode");
  const probeCode = probeCodeResponse.ok ? probeCodeResponse.result : null;
  if (!probeCodeResponse.ok) coverageStopReason = "fixed-head probe-sender code read failed";
  if (nonEmptyCode(probeCode)) coverageStopReason = "deterministic probe sender has code at the pinned block";

  const rows = [];
  const implementationCodeCache = new Map();
  for (const proxy of PROXIES) {
    if (coverageStopReason || escalationTriggered) break;
    const row = { symbol: proxy.symbol, proxyAddress: getAddress(proxy.address), views: {}, controls: {} };
    const proxyCodeResponse = await rpc.read("eth_getCode", [row.proxyAddress, pin.blockNumberHex], `${proxy.symbol}.proxy.getCode`);
    const implSlotResponse = await rpc.read("eth_getStorageAt", [row.proxyAddress, IMPLEMENTATION_SLOT, pin.blockNumberHex], `${proxy.symbol}.slot.implementation`);
    const adminSlotResponse = await rpc.read("eth_getStorageAt", [row.proxyAddress, ADMIN_SLOT, pin.blockNumberHex], `${proxy.symbol}.slot.admin`);
    const beaconSlotResponse = await rpc.read("eth_getStorageAt", [row.proxyAddress, BEACON_SLOT, pin.blockNumberHex], `${proxy.symbol}.slot.beacon`);
    row.proxyRuntime = codeInfo(proxyCodeResponse.ok ? proxyCodeResponse.result : null);
    row.slots = {
      implementation: implSlotResponse.ok ? implSlotResponse.result : null,
      admin: adminSlotResponse.ok ? adminSlotResponse.result : null,
      beacon: beaconSlotResponse.ok ? beaconSlotResponse.result : null,
    };
    row.implementationAddress = slotAddress(row.slots.implementation);
    row.adminAddress = slotAddress(row.slots.admin);
    row.beaconAddress = slotAddress(row.slots.beacon);
    if (![proxyCodeResponse, implSlotResponse, adminSlotResponse, beaconSlotResponse].every((x) => x.ok)) {
      coverageStopReason = `${proxy.symbol}: fixed-head proxy runtime/slot read failed`;
      rows.push(row);
      break;
    }
    if (!row.proxyRuntime.present || !row.implementationAddress || row.beaconAddress) {
      coverageStopReason = `${proxy.symbol}: proxy runtime or direct implementation binding materially unresolved`;
      rows.push(row);
      break;
    }
    let implRuntime;
    if (implementationCodeCache.has(row.implementationAddress.toLowerCase())) {
      implRuntime = implementationCodeCache.get(row.implementationAddress.toLowerCase());
      row.implementationRuntimeRead = { reusedPinnedRead: true, sourceSymbol: implRuntime.sourceSymbol };
    } else {
      const implCodeResponse = await rpc.read("eth_getCode", [row.implementationAddress, pin.blockNumberHex], `${proxy.symbol}.implementation.getCode`);
      if (!implCodeResponse.ok) {
        coverageStopReason = `${proxy.symbol}: fixed-head implementation runtime read failed`;
        rows.push(row);
        break;
      }
      implRuntime = { ...codeInfo(implCodeResponse.result), sourceSymbol: proxy.symbol };
      implementationCodeCache.set(row.implementationAddress.toLowerCase(), implRuntime);
      row.implementationRuntimeRead = { reusedPinnedRead: false, sourceSymbol: proxy.symbol };
    }
    row.implementationRuntime = { exact: implRuntime.exact, bytes: implRuntime.bytes, keccak256: implRuntime.keccak256, present: implRuntime.present };
    row.codeBound = row.proxyRuntime.present && row.implementationRuntime.present;
    if (!row.codeBound) {
      coverageStopReason = `${proxy.symbol}: proxy or implementation has no runtime at the pinned block`;
      rows.push(row);
      break;
    }
    for (const call of VIEW_CALLS) {
      const response = await rpc.read("eth_call", [{ from: probeAddress, to: row.proxyAddress, data: VIEW_IFACE.encodeFunctionData(call.name) }, pin.blockNumberHex], `${proxy.symbol}.view.${call.name}`);
      row.views[call.name] = decodeViewResponse(call.name, call.type, response);
    }
    const initializeResponse = await rpc.read("eth_call", [{ from: probeAddress, to: row.proxyAddress, data: VIEW_IFACE.encodeFunctionData("initialize") }, pin.blockNumberHex], `${proxy.symbol}.control.initialize`);
    row.controls.initialize = classifyControlResponse(initializeResponse, probeAddress);
    if (row.controls.initialize.outcome === "success") {
      escalationTriggered = true;
      row.controls.upgradeToAndCall = { outcome: "skipped", classification: "escalation-stop-after-initialize-success", exactData: null };
      rows.push(row);
      break;
    }
    if (row.controls.initialize.classification === "unknown") {
      coverageStopReason = `${proxy.symbol}: initialize() control response is materially unresolved`;
      row.controls.upgradeToAndCall = { outcome: "skipped", classification: "coverage-stop", exactData: null };
      rows.push(row);
      break;
    }
    const upgradeData = VIEW_IFACE.encodeFunctionData("upgradeToAndCall", [row.implementationAddress, "0x"]);
    const upgradeResponse = await rpc.read("eth_call", [{ from: probeAddress, to: row.proxyAddress, data: upgradeData }, pin.blockNumberHex], `${proxy.symbol}.control.upgradeToAndCallCurrent`);
    row.controls.upgradeToAndCall = classifyControlResponse(upgradeResponse, probeAddress);
    rows.push(row);
    if (row.controls.upgradeToAndCall.outcome === "success") {
      escalationTriggered = true;
      break;
    }
    if (row.controls.upgradeToAndCall.classification === "unknown") {
      coverageStopReason = `${proxy.symbol}: upgradeToAndCall() control response is materially unresolved`;
      break;
    }
  }

  const derived = deriveClassification(rows, coverageStopReason);
  const proxyHashGroups = new Map();
  for (const row of rows) {
    const hash = row.proxyRuntime && row.proxyRuntime.keccak256;
    if (!hash) continue;
    if (!proxyHashGroups.has(hash)) proxyHashGroups.set(hash, []);
    proxyHashGroups.get(hash).push(row.symbol);
  }
  const unresolvedInterfaces = [];
  for (const row of rows) {
    for (const [name, result] of Object.entries(row.views || {})) {
      if (result.outcome !== "success") unresolvedInterfaces.push(`${row.symbol}.${name}:${result.outcome}`);
    }
  }
  const runtimeComparison = {
    proxyGroups: [...proxyHashGroups.entries()].map(([runtimeHash, symbols]) => ({ runtimeHash, symbols })),
    implementation: implementationHashComparison(rows),
  };
  const anyControlSuccess = rows.some((row) => [row.controls?.initialize, row.controls?.upgradeToAndCall].some((x) => x && x.outcome === "success"));
  const nextAction = anyControlSuccess
    ? "Run a pinned local-fork control proof with an ephemeral account; do not sign or broadcast on live HyperEVM."
    : (coverageStopReason
      ? "Resolve the recorded fixed-head/runtime/control blocker, then rerun this bounded read-only scanner at one finalized pin."
      : "No control fork is justified by this closeout; reopen only on implementation/control changes or contradictory source/build evidence.");
  const raw = {
    generatedAt,
    runId,
    scanner: SCANNER,
    scope: "Authorized Unit/Hyperunit six-proxy finalized-selected, block-number-bound read-only runtime, EIP-1967, getter, initializer, and UUPS authorization probe",
    signal: derived.signal,
    classification: derived.classification,
    subbranchSignal: derived.subbranchSignal || null,
    subbranchClassification: derived.subbranchClassification || null,
    overallUnitClassification: derived.overallUnitClassification || (derived.closeSubbranch ? "INCOMPLETE/WATCH" : derived.classification),
    openUnitDomains: OPEN_UNIT_DOMAINS,
    closeSubbranch: derived.closeSubbranch,
    coverageStopReason,
    escalationTriggered,
    pin,
    chain: { name: "HyperEVM", chainIdContext: CHAIN_ID_CONTEXT, chainIdQueried: false, endpointPreset: "public-no-secret-preset", endpointValueStored: false },
    probeSender: { derivation: "last20(keccak256(utf8('authorized-defensive:' + runId + ':no-code-probe')))", address: probeAddress, codeExact: probeCode, noCodeAtPin: probeCodeResponse.ok && !nonEmptyCode(probeCode) },
    safety: {
      authorizedDefensive: true,
      readOnly: true,
      initialBlockSelectedViaFinalizedTag: true,
      postPinReadsBlockNumberBound: true,
      eip1898HashTaggedReads: false,
      terminalHashRechecked: false,
      endpointInventoriesRead: false,
      envFilesRead: false,
      endpointValuesStored: false,
      privateKeysRead: false,
      transactions: false,
      signing: false,
      broadcasts: false,
      deployments: false,
      liveMutation: false,
      forkPerformed: false,
      realFunds: false,
      aggregateGatesEdited: false,
    },
    slots: { implementation: IMPLEMENTATION_SLOT, admin: ADMIN_SLOT, beacon: BEACON_SLOT, zeroUupsAdminSlotAnomalousByItself: false },
    proxies: rows,
    runtimeComparison,
    unresolvedInterfaces,
    rpcReadCount: rpc.count,
    rpcReadCap: MAX_RPC_READS,
    rpcBudgetCompliant: rpc.count <= MAX_RPC_READS,
    rpcTranscript: rpc.transcript,
    manifestPath: OUT_MANIFEST,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    nextAction,
  };
  writeFile(OUT_RAW, `${JSON.stringify(raw, null, 2)}\n`);
  writeFile(OUT_REPORT, renderReport(raw));
  const records = [SCANNER, OUT_RAW, OUT_REPORT].map(sha256File);
  const aggregateSha256 = sha256Buffer(Buffer.from(records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n"), "utf8"));
  const manifest = {
    generatedAt,
    runId,
    manifestVersion: 1,
    hashAlgorithm: "sha256",
    records,
    aggregateSha256,
    rpcReadCount: rpc.count,
    rpcReadCap: MAX_RPC_READS,
    endpointValuesStored: false,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
  };
  writeFile(OUT_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`runId=${runId} classification=${derived.classification} proxies=${rows.length}/6 reads=${rpc.count}/${MAX_RPC_READS}`);
  console.log(`wrote ${OUT_RAW}, ${OUT_MANIFEST}, ${OUT_REPORT}`);
}

function selfTest() {
  const probe = getAddress(`0x${"11".repeat(20)}`);
  const other = getAddress(`0x${"22".repeat(20)}`);
  const invalid = classifyControlResponse({ ok: false, error: { code: 3, message: "execution reverted", data: KNOWN_REVERTS.invalidInitialization } }, probe);
  const authData = `${KNOWN_REVERTS.ownableUnauthorized}${"0".repeat(24)}${probe.slice(2).toLowerCase()}`;
  const auth = classifyControlResponse({ ok: false, error: { code: 3, message: "execution reverted", data: authData } }, probe);
  const mismatch = classifyControlResponse({ ok: false, error: { code: 3, message: "execution reverted", data: authData } }, other);
  const truncated = classifyControlResponse({ ok: false, error: { code: 3, message: "execution reverted", data: KNOWN_REVERTS.ownableUnauthorized } }, probe);
  const invalidTrailing = classifyControlResponse({ ok: false, error: { code: 3, message: "execution reverted", data: `${KNOWN_REVERTS.invalidInitialization}${"0".repeat(64)}` } }, probe);
  const nonCanonical = classifyControlResponse({ ok: false, error: { code: 3, message: "execution reverted", data: `${KNOWN_REVERTS.ownableUnauthorized}${"1".repeat(64)}` } }, probe);
  const success = classifyControlResponse({ ok: true, result: "0x" });
  if (invalid.classification !== "already-initialized") throw new Error("InvalidInitialization classification failed");
  if (auth.classification !== "authorization") throw new Error("OwnableUnauthorizedAccount classification failed");
  if (auth.decodedError?.arguments?.account !== probe) throw new Error("OwnableUnauthorizedAccount structural decode failed");
  if (mismatch.classification !== "unknown") throw new Error("mismatched OwnableUnauthorizedAccount was accepted");
  if (truncated.classification !== "unknown" || truncated.decodedError?.malformedKnownError !== true) throw new Error("truncated custom error was accepted");
  if (invalidTrailing.classification !== "unknown") throw new Error("trailing InvalidInitialization payload was accepted");
  if (nonCanonical.classification !== "unknown") throw new Error("non-canonical address word was accepted");
  if (success.outcome !== "success") throw new Error("success classification failed");
  if (PROXIES.length !== 6 || new Set(PROXIES.map((x) => x.symbol)).size !== 6) throw new Error("proxy inventory invariant failed");
  console.log("self-test PASS: structural custom errors, sender binding, malformed rejection, inventory, and success classification");
}

function verify() {
  const manifest = JSON.parse(fs.readFileSync(abs(OUT_MANIFEST), "utf8"));
  for (const record of manifest.records) {
    const actual = sha256File(record.path);
    if (actual.sha256 !== record.sha256 || actual.bytes !== record.bytes) throw new Error(`manifest mismatch: ${record.path}`);
  }
  const aggregate = sha256Buffer(Buffer.from(manifest.records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n"), "utf8"));
  if (aggregate !== manifest.aggregateSha256) throw new Error("manifest aggregate mismatch");
  const raw = JSON.parse(fs.readFileSync(abs(OUT_RAW), "utf8"));
  if (raw.rpcReadCount > MAX_RPC_READS || raw.rpcTranscript.length !== raw.rpcReadCount) throw new Error("RPC budget/transcript invariant failed");
  if (JSON.stringify(raw).match(/https?:\/\//i)) throw new Error("endpoint/URL leakage in raw artifact");
  if (raw.pin.eip1898HashTaggedReads !== false || raw.pin.terminalHashRechecked !== false || raw.pin.postPinReadTag !== "block-number") throw new Error("pin-boundary wording invariant failed");
  if (raw.closeSubbranch && (raw.overallUnitClassification !== "INCOMPLETE/WATCH" || raw.signal !== "🟠 WATCH")) throw new Error("subbranch-only/overall classification invariant failed");
  for (const row of raw.proxies) {
    const upgrade = row.controls && row.controls.upgradeToAndCall;
    if (upgrade?.classification === "authorization" && upgrade.decodedError?.name === "OwnableUnauthorizedAccount" && upgrade.decodedError.arguments.account !== raw.probeSender.address) {
      throw new Error(`authorization sender mismatch: ${row.symbol}`);
    }
    if (raw.closeSubbranch && (upgrade?.decodedError?.name !== "OwnableUnauthorizedAccount" || upgrade.decodedError.arguments.account !== raw.probeSender.address)) {
      throw new Error(`close-subbranch lacks structurally sender-bound Ownable error: ${row.symbol}`);
    }
    if (raw.closeSubbranch && row.controls?.initialize?.decodedError?.name !== "InvalidInitialization") {
      throw new Error(`close-subbranch lacks structurally decoded InvalidInitialization: ${row.symbol}`);
    }
  }
  console.log(`verify PASS: runId=${raw.runId} records=${manifest.records.length} reads=${raw.rpcReadCount}/${MAX_RPC_READS}`);
}

function writeDerived(raw, label) {
  writeFile(OUT_REPORT, renderReport(raw));
  const records = [SCANNER, OUT_RAW, OUT_REPORT].map(sha256File);
  const aggregateSha256 = sha256Buffer(Buffer.from(records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n"), "utf8"));
  const manifest = {
    generatedAt: raw.generatedAt,
    runId: raw.runId,
    manifestVersion: 1,
    hashAlgorithm: "sha256",
    records,
    aggregateSha256,
    rpcReadCount: raw.rpcReadCount,
    rpcReadCap: raw.rpcReadCap,
    endpointValuesStored: false,
    classification: raw.classification,
    overallUnitClassification: raw.overallUnitClassification,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
  };
  writeFile(OUT_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${label}: runId=${raw.runId} (offline; zero RPC reads)`);
}

function refreshDerived() {
  const raw = JSON.parse(fs.readFileSync(abs(OUT_RAW), "utf8"));
  writeDerived(raw, "refresh-derived PASS");
}

function applyCorrections() {
  const raw = JSON.parse(fs.readFileSync(abs(OUT_RAW), "utf8"));
  for (const row of raw.proxies) {
    for (const key of ["initialize", "upgradeToAndCall"]) {
      const prior = row.controls && row.controls[key];
      if (!prior || prior.outcome === "success" || prior.outcome === "skipped") continue;
      row.controls[key] = classifyControlResponse({
        ok: false,
        error: { code: prior.errorCode, message: prior.sanitizedMessage, data: prior.exactData },
      }, raw.probeSender.address);
    }
  }
  const derived = deriveClassification(raw.proxies, raw.coverageStopReason);
  raw.signal = derived.signal;
  raw.classification = derived.classification;
  raw.subbranchSignal = derived.subbranchSignal || null;
  raw.subbranchClassification = derived.subbranchClassification || null;
  raw.overallUnitClassification = derived.overallUnitClassification || (derived.closeSubbranch ? "INCOMPLETE/WATCH" : derived.classification);
  raw.closeSubbranch = derived.closeSubbranch;
  raw.openUnitDomains = OPEN_UNIT_DOMAINS;
  raw.scope = "Authorized Unit/Hyperunit six-proxy finalized-selected, block-number-bound read-only runtime, EIP-1967, getter, initializer, and UUPS authorization probe";
  raw.pin.bindingDescription = "finalized block-number-bound to the initially reported hash";
  raw.pin.postPinReadTag = "block-number";
  raw.pin.eip1898HashTaggedReads = false;
  raw.pin.terminalHashRechecked = false;
  delete raw.safety.finalizedFixedBlock;
  raw.safety.initialBlockSelectedViaFinalizedTag = true;
  raw.safety.postPinReadsBlockNumberBound = true;
  raw.safety.eip1898HashTaggedReads = false;
  raw.safety.terminalHashRechecked = false;
  raw.controlClassifier = {
    customErrorsStructurallyDecoded: true,
    ownableUnauthorizedAccountMustEqualProbeSender: true,
    malformedOrTruncatedKnownSelectorPayloadsRejected: true,
  };
  raw.nextAction = "Proxy-control subbranch is closed; overall Unit remains INCOMPLETE/WATCH. Continue only read-only work on guardian/exactly-once processing, conversion conservation, reserve/liability reconciliation, alternate control interfaces, and source semantics; reopen control probing on implementation drift.";
  writeFile(OUT_RAW, `${JSON.stringify(raw, null, 2)}\n`);
  writeDerived(raw, "apply-corrections PASS");
}

const mode = process.argv[2];
if (mode === "--self-test") {
  selfTest();
} else if (mode === "--verify") {
  verify();
} else if (mode === "--refresh-derived") {
  refreshDerived();
} else if (mode === "--apply-corrections") {
  applyCorrections();
} else {
  scan().catch((error) => {
    console.error(`scanner failed: ${safeMessage(error && error.message ? error.message : error)}`);
    process.exitCode = 1;
  });
}
