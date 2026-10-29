#!/usr/bin/env node
"use strict";

// Authorized defensive, read-only scanner for one CCIP LockRelease authorization boundary.
// It does not read endpoint inventories or env files and never signs, sends, or broadcasts.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  AbiCoder,
  Interface,
  getAddress,
  id,
  keccak256,
  toBeHex,
  zeroPadValue,
} = require("ethers");

const ROOT = path.resolve(__dirname, "..");
const SCANNER = "tools/scan-critical-ccip-syrupusdt-release-auth.js";
const RAW = "reports/raw/fast/critical-ccip-syrupusdt-release-auth.json";
const MANIFEST = "reports/raw/fast/critical-ccip-syrupusdt-release-auth-manifest.json";
const REPORT = "reports/critical-ccip-syrupusdt-release-auth.md";
const INBOX = "coordination/inbox/critical/2026-07-18-critical-ccip-syrupusdt-release-auth.json";
const HANDOFF = "coordination/handoffs/2026-07-18-critical-ccip-syrupusdt-release-auth-handoff.md";
const WRITABLE = new Set([RAW, MANIFEST, REPORT, INBOX, HANDOFF]);

const MAX_RPC_READS = 30;
const MAX_SOURCE_REQUESTS = 10;
const CHAIN_ID = 1;
// The public no-secret preset is assembled only in memory. It is never emitted to an artifact.
const PUBLIC_RPC = ["https://", "ethereum-rpc", ".publicnode", ".com"].join("");
const SOURCIFY_REPO = ["https://", "repo", ".sourcify", ".dev"].join("");

const POOL = getAddress("0xDE76A096C5eadDdf97Af3fE15ee49d32AEDa9822");
const TOKEN = getAddress("0x356B8d89c1e1239Cbbb9dE4815c39A1474d5BA7D");
const OUTSIDER = getAddress("0x000000000000000000000000000000000000dEaD");
const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const POOL_IFACE = new Interface([
  "function typeAndVersion() view returns (string)",
  "function getRouter() view returns (address)",
  "function getToken() view returns (address)",
  "function getRmnProxy() view returns (address)",
  "function getSupportedChains() view returns (uint64[])",
  "function releaseOrMint((bytes originalSender,uint64 remoteChainSelector,address receiver,uint256 amount,address localToken,bytes sourcePoolAddress,bytes sourcePoolData,bytes offchainTokenData) releaseOrMintIn) returns ((uint256 destinationAmount))",
]);
const RMN_IFACE = new Interface(["function isCursed(bytes16 subject) view returns (bool)"]);
const ROUTER_IFACE = new Interface(["function isOffRamp(uint64 sourceChainSelector,address offRamp) view returns (bool)"]);
const ABI = AbiCoder.defaultAbiCoder();

const EXPECTED_RELEASE_SELECTOR = "0x39077537";
const ERRORS = {
  caller: "0x728fe07b",
  chainNotAllowed: id("ChainNotAllowed(uint64)").slice(0, 10).toLowerCase(),
  cursed: id("CursedByRMN()").slice(0, 10).toLowerCase(),
  invalidSourcePool: id("InvalidSourcePoolAddress(bytes)").slice(0, 10).toLowerCase(),
  invalidToken: id("InvalidToken(address)").slice(0, 10).toLowerCase(),
  invalidRemoteDecimals: id("InvalidRemoteChainDecimals(bytes)").slice(0, 10).toLowerCase(),
  overflow: id("OverflowDetected(uint8,uint8,uint256)").slice(0, 10).toLowerCase(),
  tokenRateLimitReached: id("TokenRateLimitReached(uint256,uint256,address)").slice(0, 10).toLowerCase(),
  tokenMaxCapacityExceeded: id("TokenMaxCapacityExceeded(uint256,uint256,address)").slice(0, 10).toLowerCase(),
};

function abs(rel) { return path.join(ROOT, ...rel.split("/")); }
function sha256(data) { return crypto.createHash("sha256").update(data).digest("hex"); }
function fileRecord(rel) {
  const data = fs.readFileSync(abs(rel));
  return { path: rel, bytes: data.length, sha256: sha256(data) };
}
function write(rel, text) {
  if (!WRITABLE.has(rel)) throw new Error(`write outside critical-research artifacts refused: ${rel}`);
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
  fs.writeFileSync(abs(rel), text, "utf8");
}
function safeMessage(value) {
  return String(value == null ? "" : value)
    .replace(/https?:\/\/[^\s"']+/gi, "[endpoint-redacted]")
    .replace(/[?&](?:key|token|api_key|apikey)=[^\s&"']+/gi, "[credential-redacted]")
    .slice(0, 500);
}
function noCode(code) { return typeof code === "string" && (/^0x0*$/i.test(code)); }
function hasCode(code) { return typeof code === "string" && /^0x[0-9a-f]+$/i.test(code) && !noCode(code); }
function codeInfo(code) {
  return {
    exact: code,
    bytes: hasCode(code) ? (code.length - 2) / 2 : 0,
    keccak256: hasCode(code) ? keccak256(code) : null,
    present: hasCode(code),
  };
}
function slotAddress(word) {
  if (typeof word !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(word) || /^0x0{64}$/.test(word)) return null;
  return getAddress(`0x${word.slice(-40)}`);
}
function minimalProxyImplementation(code) {
  if (typeof code !== "string") return null;
  const match = code.toLowerCase().match(/^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/);
  return match ? getAddress(`0x${match[1]}`) : null;
}
function findHex(value, depth = 0) {
  if (depth > 6 || value == null) return null;
  if (typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value)) return value.toLowerCase();
  if (typeof value !== "object") return null;
  for (const key of ["data", "result", "return", "output", "originalError"]) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const found = findHex(value[key], depth + 1);
      if (found != null) return found;
    }
  }
  return null;
}

class RpcReader {
  constructor() { this.count = 0; this.transcript = []; }
  async read(method, params, label) {
    if (this.count >= MAX_RPC_READS) throw new Error(`RPC read cap reached before ${label}`);
    const readNumber = ++this.count;
    let payload;
    try {
      const response = await fetch(PUBLIC_RPC, {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: readNumber, method, params }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`public RPC HTTP ${response.status}`);
      payload = await response.json();
    } catch (error) {
      const failure = { kind: "transport", message: safeMessage(error && error.message ? error.message : error) };
      this.transcript.push({ readNumber, label, method, params, response: { failure } });
      return { ok: false, failure, readNumber };
    }
    if (!payload || payload.id !== readNumber || payload.jsonrpc !== "2.0") {
      const failure = { kind: "malformed-response", message: "JSON-RPC envelope/id mismatch" };
      this.transcript.push({ readNumber, label, method, params, response: { failure } });
      return { ok: false, failure, readNumber };
    }
    if (payload.error) {
      const error = {
        code: Number.isInteger(payload.error.code) ? payload.error.code : null,
        message: safeMessage(payload.error.message),
        data: findHex(payload.error.data),
      };
      this.transcript.push({ readNumber, label, method, params, response: { error } });
      return { ok: false, error, readNumber };
    }
    this.transcript.push({ readNumber, label, method, params, response: { result: payload.result } });
    return { ok: true, result: payload.result, readNumber };
  }
}

class SourceReader {
  constructor() { this.count = 0; this.transcript = []; }
  async get(url, label, asJson = false) {
    if (this.count >= MAX_SOURCE_REQUESTS) throw new Error(`source request cap reached before ${label}`);
    const requestNumber = ++this.count;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      const buffer = Buffer.from(await response.arrayBuffer());
      const row = { requestNumber, label, status: response.status, ok: response.ok, bytes: buffer.length, sha256: sha256(buffer) };
      this.transcript.push(row);
      if (!response.ok) return { ok: false, status: response.status, buffer: null, json: null, text: null };
      const text = buffer.toString("utf8");
      if (!asJson) return { ok: true, status: response.status, buffer, text, json: null };
      try { return { ok: true, status: response.status, buffer, text, json: JSON.parse(text) }; }
      catch { return { ok: false, status: response.status, buffer, text, json: null, parseFailure: true }; }
    } catch (error) {
      this.transcript.push({ requestNumber, label, status: null, ok: false, bytes: 0, sha256: null, failure: safeMessage(error && error.message ? error.message : error) });
      return { ok: false, status: null, buffer: null, json: null, text: null };
    }
  }
}

function decodeCall(iface, fn, response, transform = (x) => x) {
  if (!response.ok) return { ok: false, raw: response.error?.data || null, error: response.error || response.failure || null, decoded: null };
  try {
    const decoded = iface.decodeFunctionResult(fn, response.result);
    return { ok: true, raw: response.result, error: null, decoded: transform(decoded) };
  } catch (error) {
    return { ok: false, raw: response.result, error: { kind: "decode", message: safeMessage(error.message) }, decoded: null };
  }
}
async function view(rpc, to, iface, fn, args, pin, label, transform) {
  const response = await rpc.read("eth_call", [{ to, data: iface.encodeFunctionData(fn, args) }, pin], label);
  return decodeCall(iface, fn, response, transform);
}
function encodeBytes16Selector(selector) { return zeroPadValue(toBeHex(selector), 16); }

function canonicalAddressError(data, selector, expected) {
  if (typeof data !== "string" || data.length !== 74 || data.slice(0, 10).toLowerCase() !== selector) return false;
  const word = data.slice(10).toLowerCase();
  return /^0{24}[0-9a-f]{40}$/.test(word) && getAddress(`0x${word.slice(24)}`) === getAddress(expected);
}
function canonicalUint64Error(data, selector, expected) {
  if (typeof data !== "string" || data.length !== 74 || data.slice(0, 10).toLowerCase() !== selector) return false;
  const word = data.slice(10).toLowerCase();
  if (!/^0{48}[0-9a-f]{16}$/.test(word)) return false;
  return BigInt(`0x${word}`) === BigInt(expected);
}
function classifyRelease(response, selectedSelector, exactSourceAndOrder) {
  if (response.ok) return {
    outcome: "success",
    rawReturnOrRevertBytes: response.result,
    classification: "SUCCESS_ESCALATE_SEPARATE_FIXED_BLOCK_FORK",
    authorizationSubbranchClosed: false,
    escalation: true,
  };
  const data = response.error?.data || null;
  const selector = typeof data === "string" && data.length >= 10 ? data.slice(0, 10).toLowerCase() : null;
  const base = { outcome: response.error ? "revert" : "failure", rawReturnOrRevertBytes: data, providerError: response.error || response.failure || null, revertSelector: selector };
  if (canonicalAddressError(data, ERRORS.caller, OUTSIDER)) return {
    ...base,
    decodedError: { name: "CallerIsNotARampOnRouter", caller: OUTSIDER },
    classification: exactSourceAndOrder ? "EXPECTED_AUTHORIZATION_REVERT_SUBBRANCH_CLOSED" : "EXPECTED_REVERT_BUT_SOURCE_RUNTIME_OR_ORDER_UNPROVEN_WATCH",
    authorizationSubbranchClosed: Boolean(exactSourceAndOrder),
    escalation: false,
  };
  if (canonicalUint64Error(data, ERRORS.chainNotAllowed, selectedSelector)) return {
    ...base, decodedError: { name: "ChainNotAllowed", remoteChainSelector: String(selectedSelector) },
    classification: "SETUP_RETRY_REQUIRED_ACTUAL_SUPPORTED_SELECTOR_REJECTED", authorizationSubbranchClosed: false, escalation: false,
  };
  if (selector === ERRORS.cursed && data.length === 10) return {
    ...base, decodedError: { name: "CursedByRMN" }, classification: "SETUP_RETRY_ONE_OTHER_SUPPORTED_SELECTOR_IF_AVAILABLE", authorizationSubbranchClosed: false, escalation: false,
  };
  if (selector === ERRORS.invalidSourcePool) return {
    ...base, decodedError: { name: "InvalidSourcePoolAddress" }, classification: "POST_AUTHORIZATION_ERROR_ESCALATE", authorizationSubbranchClosed: false, escalation: true,
  };
  const postAuth = new Map([
    [ERRORS.invalidRemoteDecimals, "InvalidRemoteChainDecimals"],
    [ERRORS.overflow, "OverflowDetected"],
    [ERRORS.tokenRateLimitReached, "TokenRateLimitReached"],
    [ERRORS.tokenMaxCapacityExceeded, "TokenMaxCapacityExceeded"],
  ]);
  if (postAuth.has(selector)) return {
    ...base, decodedError: { name: postAuth.get(selector) }, classification: "POST_AUTHORIZATION_ERROR_ESCALATE", authorizationSubbranchClosed: false, escalation: true,
  };
  return { ...base, decodedError: null, classification: "UNKNOWN_INCOMPLETE", authorizationSubbranchClosed: false, escalation: false };
}

function sourceUrl(matchType, address, sourcePath) {
  const encoded = sourcePath.split("/").map(encodeURIComponent).join("/");
  return `${SOURCIFY_REPO}/contracts/${matchType}/${CHAIN_ID}/${address}/sources/${encoded}`;
}
function metadataUrl(matchType, address) { return `${SOURCIFY_REPO}/contracts/${matchType}/${CHAIN_ID}/${address}/metadata.json`; }
function sourceLines(text, needles) {
  const lines = String(text || "").split(/\r?\n/);
  const hits = {};
  for (const needle of needles) {
    const index = lines.findIndex((line) => line.includes(needle));
    hits[needle] = index < 0 ? null : { line: index + 1, text: lines[index].trim() };
  }
  return hits;
}
function sourceOrder(lockText, tokenText) {
  const release = {
    validate: lockText.indexOf("_validateReleaseOrMint(releaseOrMintIn)"),
    calculate: lockText.indexOf("_calculateLocalAmount(releaseOrMintIn.amount"),
    transfer: lockText.indexOf("safeTransfer(releaseOrMintIn.receiver, localAmount)"),
  };
  const validate = {
    token: tokenText.indexOf("isSupportedToken(releaseOrMintIn.localToken)"),
    curse: tokenText.indexOf("isCursed(bytes16(uint128(releaseOrMintIn.remoteChainSelector)))"),
    offRamp: tokenText.indexOf("_onlyOffRamp(releaseOrMintIn.remoteChainSelector)"),
    sourcePool: tokenText.indexOf("isRemotePool(releaseOrMintIn.remoteChainSelector, releaseOrMintIn.sourcePoolAddress)"),
    rateLimit: tokenText.indexOf("_consumeInboundRateLimit(releaseOrMintIn.remoteChainSelector, releaseOrMintIn.amount)"),
  };
  const onlyOffRampStart = tokenText.indexOf("function _onlyOffRamp(");
  const onlyOffRampEnd = onlyOffRampStart < 0 ? -1 : tokenText.indexOf("// ================================================================", onlyOffRampStart);
  const onlyOffRamp = onlyOffRampStart < 0 ? "" : tokenText.slice(onlyOffRampStart, onlyOffRampEnd < 0 ? undefined : onlyOffRampEnd);
  const offRampOrder = {
    supported: onlyOffRamp.indexOf("isSupportedChain(remoteChainSelector)"),
    router: onlyOffRamp.indexOf("s_router.isOffRamp(remoteChainSelector, msg.sender)"),
  };
  const present = (obj) => Object.values(obj).every((x) => x >= 0);
  const exact = present(release) && release.validate < release.calculate && release.calculate < release.transfer
    && present(validate) && validate.token < validate.curse && validate.curse < validate.offRamp && validate.offRamp < validate.sourcePool && validate.sourcePool < validate.rateLimit
    && present(offRampOrder) && offRampOrder.supported < offRampOrder.router;
  return { exact, release, validate, offRampOrder };
}

async function acquireSource(source, address) {
  let matchType = "full_match";
  let metadataResponse = await source.get(metadataUrl(matchType, address), "sourcify.full-match.metadata", true);
  if (!metadataResponse.ok) {
    matchType = "partial_match";
    metadataResponse = await source.get(metadataUrl(matchType, address), "sourcify.partial-match.metadata", true);
  }
  if (!metadataResponse.ok || !metadataResponse.json) return {
    record: { availability: "unavailable", matchType: null, sourceRuntimeEquivalence: null, localExactBuildEquivalence: null, callOrderExact: false },
    lockText: "", tokenText: "",
  };
  const metadata = metadataResponse.json;
  const paths = Object.keys(metadata.sources || {});
  const compilationTarget = metadata.settings?.compilationTarget || {};
  const targetPath = Object.keys(compilationTarget)[0] || paths.find((x) => /LockReleaseTokenPool\.sol$/i.test(x)) || null;
  const tokenPath = paths.find((x) => /(?:^|\/)TokenPool\.sol$/i.test(x) && !/LockRelease|BurnMint|I?TokenPoolInterface/i.test(x)) || null;
  async function obtain(sourcePath, label) {
    if (!sourcePath) return null;
    const inline = metadata.sources?.[sourcePath]?.content;
    if (typeof inline === "string") return { text: inline, bytes: Buffer.byteLength(inline), sha256: sha256(Buffer.from(inline)), origin: "metadata-inline" };
    const response = await source.get(sourceUrl(matchType, address, sourcePath), label, false);
    return response.ok ? { text: response.text, bytes: response.buffer.length, sha256: sha256(response.buffer), origin: "sourcify-repository" } : null;
  }
  const lock = await obtain(targetPath, "sourcify.source.lock-release");
  const token = await obtain(tokenPath, "sourcify.source.token-pool");
  const order = sourceOrder(lock?.text || "", token?.text || "");
  const equivalence = matchType === "full_match" ? true : null;
  return {
    record: {
      availability: lock && token ? "recovered" : "partial-source-set",
      matchType,
      compilerVersion: metadata.compiler?.version || null,
      compilationTarget,
      metadataBytes: metadataResponse.buffer?.length || 0,
      metadataSha256: metadataResponse.buffer ? sha256(metadataResponse.buffer) : null,
      sourceRuntimeEquivalence: equivalence,
      sourceRuntimeEquivalenceBasis: equivalence ? "Sourcify full_match repository record for the pinned source target plus pinned runtime hash" : "partial match or unavailable; equivalence intentionally null",
      localExactBuildEquivalence: null,
      sourceFiles: {
        lockRelease: lock ? { path: targetPath, bytes: lock.bytes, sha256: lock.sha256, origin: lock.origin } : null,
        tokenPool: token ? { path: tokenPath, bytes: token.bytes, sha256: token.sha256, origin: token.origin } : null,
      },
      callOrderExact: Boolean(equivalence && lock && token && order.exact),
      callOrder: order,
      codeReferences: {
        lockRelease: sourceLines(lock?.text, ["function releaseOrMint(", "_validateReleaseOrMint(releaseOrMintIn);", "getToken().safeTransfer(releaseOrMintIn.receiver, localAmount);"]),
        tokenPool: sourceLines(token?.text, ["function _validateReleaseOrMint(", "_onlyOffRamp(releaseOrMintIn.remoteChainSelector);", "if (!isRemotePool(releaseOrMintIn.remoteChainSelector, releaseOrMintIn.sourcePoolAddress))", "function _onlyOffRamp(", "if (!s_router.isOffRamp(remoteChainSelector, msg.sender))"]),
      },
    },
    lockText: lock?.text || "",
    tokenText: token?.text || "",
  };
}

function md(value) { return String(value == null ? "null" : value).replace(/\|/g, "\\|").replace(/\r?\n/g, " "); }
function renderReport(raw) {
  const s = raw.selectedChain;
  const c = raw.releaseOrMintProbe;
  const src = raw.source;
  return `# CCIP Ethereum syrupUSDT LockRelease Authorization Boundary\n\nSignal: ${raw.signal} — **${raw.classification}**.\n\n## Result\n\n- Run ID: \`${raw.runId}\`\n- Pin: finalized-selected Ethereum block \`${raw.pin.blockNumberDecimal}\` / \`${raw.pin.blockHash}\`; terminal same-number hash recheck: \`${raw.pin.terminalSameHash}\`.\n- Global route/executable/signing remains \`0/0/false\`. No transaction, signing, broadcast, fork, state override, history scan, or real-fund action occurred.\n- Pool: \`${raw.pool.address}\`; runtime hash: \`${raw.pool.runtime.keccak256}\`; proxy kind: \`${raw.pool.proxy.kind}\`.\n- Token getter: \`${raw.pool.getters.token.decoded}\` (expected syrupUSDT \`${TOKEN}\`, match=${raw.pool.tokenMatch}).\n- Type/version: \`${md(raw.pool.getters.typeAndVersion.decoded)}\`. Router: \`${raw.pool.getters.router.decoded}\`.\n- Outsider \`${OUTSIDER}\` pinned code: \`${raw.outsider.codeExact}\` (noCodeAtPin=${raw.outsider.noCodeAtPin}).\n\n## Selected supported chain and router state\n\n- Actually returned supported selectors: ${raw.pool.getters.supportedChains.decoded.map((x) => `\`${x}\``).join(", ") || "none"}.\n- Selected selector: \`${s.selector}\`; RMN subject: \`${s.rmnSubject}\`; cursed: \`${s.cursed}\`.\n- Router \`isOffRamp(${s.selector}, ${OUTSIDER})\`: \`${s.outsiderIsOffRamp}\` (interface supported=${s.routerInterfaceSupported}).\n\n## Exact outsider releaseOrMint call\n\n- ABI: \`releaseOrMint((bytes,uint64,address,uint256,address,bytes,bytes,bytes))\`; selector: \`${c.selector}\`.\n- Tuple: originalSender=\`abi.encode(outsider)\`, remoteChainSelector=\`${s.selector}\`, receiver=outsider, amount=\`1\` raw, localToken=\`${TOKEN}\`, sourcePoolAddress=\`0x\`, sourcePoolData=\`abi.encode(uint256(6))\`, offchainTokenData=\`0x\`.\n- Exact calldata: \`${c.calldata}\`\n- Outcome/classification: \`${c.outcome}\` / **\`${c.classification}\`**.\n- Exact return/revert bytes: \`${c.rawReturnOrRevertBytes}\`.\n- Decoded error: \`${c.decodedError ? c.decodedError.name : "null"}\`. Authorization subbranch closed: \`${c.authorizationSubbranchClosed}\`.\n\n## Source/runtime and call order\n\n- Source availability: \`${src.availability}\`; match: \`${src.matchType}\`; source/runtime equivalence: \`${src.sourceRuntimeEquivalence}\`; local exact-build equivalence: \`${src.localExactBuildEquivalence}\`.\n- Exact deployed-equivalent call-order binding: \`${src.callOrderExact}\`. The retained source order is \`releaseOrMint -> _validateReleaseOrMint -> token check -> RMN curse -> _onlyOffRamp -> source-pool validation -> inbound rate limit -> amount conversion -> token transfer\`; inside \`_onlyOffRamp\`, supported-chain validation precedes router off-ramp authorization.\n- Therefore \`CallerIsNotARampOnRouter(outsider)\` closes only the outsider authorization subbranch when both source/runtime equivalence and call-order binding are exact. It does not prove every CCIP/router/RMN authorization path safe.\n\n## Decision matrix applied\n\n- Exact \`CallerIsNotARampOnRouter(outsider)\` (\`0x728fe07b\`): close only this authorization subbranch if source/runtime and call order are exact; otherwise WATCH.\n- \`ChainNotAllowed\`: setup retry with an actually returned supported selector. \`CursedByRMN\`: at most one other returned selector may be tried within budget.\n- \`InvalidSourcePoolAddress\` or another recognized post-authorization error: escalate. Success: escalate to a separate fixed-block fork only. Unknown: incomplete.\n\n## Legacy artifact supersession\n\n\`reports/raw/fast/full-attack-test-ccip.json\` is explicitly superseded, not deleted. Its \`releaseOrMint(bytes)\` ABI is wrong, and its null/error-swallowing RPC probe treats successful no-return/reverting calls unsafely. It cannot support \`POTENTIAL_DRAIN\`, \`pause\`, or \`unpause\` claims.\n\n## Evidence, limits, and mitigation\n\n- Reads: \`${raw.requestCounts.jsonRpc}/${MAX_RPC_READS}\` JSON-RPC and \`${raw.requestCounts.sourceMetadata}/${MAX_SOURCE_REQUESTS}\` source/metadata requests. Exact RPC transcript and sanitized source-request transcript are retained in the raw artifact; endpoint values, tokens, and headers are not.\n- Preconditions tested: a no-code outsider, one returned supported uncursed selector, exact token/router/RMN getters, exact router off-ramp result, and one correctly encoded outsider call at one fixed block.\n- Impact if the call had reached a post-auth error or succeeded: outsider authorization could be bypassed, potentially exposing LockRelease custody; this did not occur in this run.\n- Defensive test: preserve the exact fixed-block call as a regression asserting the canonical caller error and add unit tests that authorization precedes source-pool validation, rate-limit consumption, conversion, and transfer.\n- Mitigation: retain router-only off-ramp authorization before source-pool checks/value motion, monitor pool/router/runtime drift, and rerun on implementation or router changes.\n\n## Blockers and next action\n\n${raw.blockers.length ? raw.blockers.map((x) => `- ${x}`).join("\n") : "- None for this narrowly scoped authorization subbranch."}\n- ${raw.nextAction}\n`;
}

function makeInbox(raw) {
  return {
    findingId: "ccip-ethereum-syrupusdt-release-auth-boundary",
    agentId: "critical-ccip-syrupusdt-auth-20260718",
    role: "critical-research",
    status: raw.releaseOrMintProbe.authorizationSubbranchClosed ? "route-negative" : "watch-only",
    runId: raw.runId,
    classification: raw.classification,
    signal: raw.signal,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    summary: `At fixed Ethereum block ${raw.pin.blockNumberDecimal}, the one correctly encoded outsider releaseOrMint call classified ${raw.releaseOrMintProbe.classification}; source/runtime=${raw.source.sourceRuntimeEquivalence}, callOrderExact=${raw.source.callOrderExact}.`,
    fixedBlock: { number: raw.pin.blockNumberDecimal, hash: raw.pin.blockHash, finalizedSelected: true, terminalSameHash: raw.pin.terminalSameHash },
    selectedSelector: raw.selectedChain,
    exactCallClassification: raw.releaseOrMintProbe.classification,
    sourceRuntimeEquivalence: raw.source.sourceRuntimeEquivalence,
    callOrderExact: raw.source.callOrderExact,
    requestCounts: raw.requestCounts,
    supersedesWithoutDeletion: ["reports/raw/fast/full-attack-test-ccip.json"],
    artifacts: [SCANNER, RAW, MANIFEST, REPORT, INBOX, HANDOFF],
    blockers: raw.blockers,
    nextAction: raw.nextAction,
  };
}

function renderHandoff(raw) {
  return `# CCIP syrupUSDT release authorization handoff\n\n- Agent/role: \`critical-ccip-syrupusdt-auth-20260718\` / \`critical-research\`\n- Run: \`${raw.runId}\`\n- Classification: **${raw.classification}** (${raw.signal})\n- Pin: Ethereum finalized-selected block \`${raw.pin.blockNumberDecimal}\` / \`${raw.pin.blockHash}\`; terminal same-number hash recheck \`${raw.pin.terminalSameHash}\`\n- Gates: route/executable/signing \`0/0/false\`\n- Selected supported uncursed selector: \`${raw.selectedChain.selector}\`; router: \`${raw.pool.getters.router.decoded}\`; \`isOffRamp(selector, outsider)=${raw.selectedChain.outsiderIsOffRamp}\`\n- Exact call: \`${raw.releaseOrMintProbe.classification}\`; bytes \`${raw.releaseOrMintProbe.rawReturnOrRevertBytes}\`\n- Source/runtime equivalence: \`${raw.source.sourceRuntimeEquivalence}\`; exact call order: \`${raw.source.callOrderExact}\`\n- Requests: \`${raw.requestCounts.jsonRpc}/${MAX_RPC_READS}\` RPC; \`${raw.requestCounts.sourceMetadata}/${MAX_SOURCE_REQUESTS}\` source/metadata\n\n## Artifacts\n\n- \`${SCANNER}\`\n- \`${RAW}\`\n- \`${MANIFEST}\`\n- \`${REPORT}\`\n- \`${INBOX}\`\n- \`${HANDOFF}\`\n\n## Legacy supersession\n\n\`reports/raw/fast/full-attack-test-ccip.json\` remains on disk but is superseded: it used the wrong \`releaseOrMint(bytes)\` ABI and swallowed RPC null/errors, so it cannot support POTENTIAL_DRAIN/pause/unpause claims.\n\n## Next action\n\n${raw.nextAction}\n\nThe coordinator-held target claim was not released, and no coordinator-owned aggregate file was edited.\n`;
}

function classificationFor(raw) {
  const p = raw.releaseOrMintProbe;
  if (p.escalation) return { signal: "🟡 VULNERABLE", classification: "ESCALATE/AUTHORIZATION-BOUNDARY-CONTRADICTION-NEEDS-SEPARATE-FIXED-BLOCK-FORK" };
  if (p.authorizationSubbranchClosed && raw.pin.terminalSameHash && raw.pool.bindingComplete && raw.selectedChain.cursed === false) {
    return { signal: "⚪ CLEAN", classification: "CLEAN/AUTHORIZATION-SUBBRANCH-CLOSED" };
  }
  return { signal: "🟠 WATCH", classification: "INCOMPLETE/WATCH/AUTHORIZATION-SUBBRANCH-NOT-CLOSEABLE" };
}

function writePackage(raw) {
  write(RAW, `${JSON.stringify(raw, null, 2)}\n`);
  let report = renderReport(raw);
  if (!raw.source.callOrderExact) {
    report = report.replace(
      "The retained source order is",
      "The expected 1.5.1 reference order, not proven deployed-equivalent in this run, is",
    );
  }
  write(REPORT, report);
  write(INBOX, `${JSON.stringify(makeInbox(raw), null, 2)}\n`);
  write(HANDOFF, renderHandoff(raw));
  const records = [SCANNER, RAW, REPORT, INBOX, HANDOFF].map(fileRecord);
  const aggregateSha256 = sha256(Buffer.from(records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n"), "utf8"));
  const manifest = {
    generatedAt: raw.generatedAt,
    runId: raw.runId,
    manifestVersion: 1,
    hashAlgorithm: "sha256",
    records,
    aggregateSha256,
    rpcReadCount: raw.requestCounts.jsonRpc,
    rpcReadCap: MAX_RPC_READS,
    sourceMetadataRequestCount: raw.requestCounts.sourceMetadata,
    sourceMetadataRequestCap: MAX_SOURCE_REQUESTS,
    terminalSameNumberHashRecheck: raw.pin.terminalSameHash,
    endpointValuesTokensHeadersStored: false,
    classification: raw.classification,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
  };
  write(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function scan() {
  if (POOL_IFACE.getFunction("releaseOrMint").selector.toLowerCase() !== EXPECTED_RELEASE_SELECTOR) throw new Error("releaseOrMint selector invariant failed");
  if (id("CallerIsNotARampOnRouter(address)").slice(0, 10).toLowerCase() !== ERRORS.caller) throw new Error("caller error selector invariant failed");
  const rpc = new RpcReader();
  const sourceReader = new SourceReader();
  const finalized = await rpc.read("eth_getBlockByNumber", ["finalized", false], "pin.finalized");
  if (!finalized.ok || !finalized.result?.number || !finalized.result?.hash || !finalized.result?.timestamp) throw new Error("finalized pin selection failed");
  const pinTag = finalized.result.number.toLowerCase();
  const initialHash = finalized.result.hash.toLowerCase();
  const blockNumber = Number(BigInt(pinTag));
  const timestamp = Number(BigInt(finalized.result.timestamp));

  const poolCodeR = await rpc.read("eth_getCode", [POOL, pinTag], "pool.code");
  const outsiderCodeR = await rpc.read("eth_getCode", [OUTSIDER, pinTag], "outsider.code");
  const implSlotR = await rpc.read("eth_getStorageAt", [POOL, IMPLEMENTATION_SLOT, pinTag], "pool.slot.implementation");
  const adminSlotR = await rpc.read("eth_getStorageAt", [POOL, ADMIN_SLOT, pinTag], "pool.slot.admin");
  const beaconSlotR = await rpc.read("eth_getStorageAt", [POOL, BEACON_SLOT, pinTag], "pool.slot.beacon");
  if (![poolCodeR, outsiderCodeR, implSlotR, adminSlotR, beaconSlotR].every((x) => x.ok)) throw new Error("pool/outsider code or proxy-slot binding failed");
  const runtime = codeInfo(poolCodeR.result);
  if (!runtime.present) throw new Error("target pool has no code at pin");
  if (!noCode(outsiderCodeR.result)) throw new Error("outsider has code at pin");
  const slotImpl = slotAddress(implSlotR.result);
  const cloneImpl = minimalProxyImplementation(poolCodeR.result);
  const implementation = slotImpl || cloneImpl;
  let implementationRuntime = null;
  if (implementation) {
    const implCodeR = await rpc.read("eth_getCode", [implementation, pinTag], "pool.implementation.code");
    if (!implCodeR.ok || !hasCode(implCodeR.result)) throw new Error("proxy implementation code binding failed");
    implementationRuntime = codeInfo(implCodeR.result);
  }
  const sourceTarget = implementation || POOL;

  const typeAndVersion = await view(rpc, POOL, POOL_IFACE, "typeAndVersion", [], pinTag, "pool.typeAndVersion", (x) => String(x[0]));
  const router = await view(rpc, POOL, POOL_IFACE, "getRouter", [], pinTag, "pool.getRouter", (x) => getAddress(x[0]));
  const token = await view(rpc, POOL, POOL_IFACE, "getToken", [], pinTag, "pool.getToken", (x) => getAddress(x[0]));
  const rmn = await view(rpc, POOL, POOL_IFACE, "getRmnProxy", [], pinTag, "pool.getRmnProxy", (x) => getAddress(x[0]));
  const supported = await view(rpc, POOL, POOL_IFACE, "getSupportedChains", [], pinTag, "pool.getSupportedChains", (x) => [...x[0]].map((v) => v.toString()));
  if (![typeAndVersion, router, token, rmn, supported].every((x) => x.ok)) throw new Error("required pool getter failed");
  if (token.decoded !== TOKEN) throw new Error("pool token getter mismatch");
  if (!supported.decoded.length) throw new Error("pool returned no supported selectors");

  const [routerCodeR, tokenCodeR, rmnCodeR] = await Promise.all([
    rpc.read("eth_getCode", [router.decoded, pinTag], "router.code"),
    rpc.read("eth_getCode", [token.decoded, pinTag], "token.code"),
    rpc.read("eth_getCode", [rmn.decoded, pinTag], "rmn.code"),
  ]);
  if (![routerCodeR, tokenCodeR, rmnCodeR].every((x) => x.ok && hasCode(x.result))) throw new Error("router/token/RMN code binding failed");

  const candidates = [...new Set(supported.decoded)].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0).slice(0, 2);
  const curseChecks = [];
  let selected = null;
  for (const selector of candidates) {
    const subject = encodeBytes16Selector(BigInt(selector));
    const check = await view(rpc, rmn.decoded, RMN_IFACE, "isCursed", [subject], pinTag, `rmn.isCursed.${selector}`, (x) => Boolean(x[0]));
    curseChecks.push({ selector, subject, ...check });
    if (check.ok && check.decoded === false) { selected = { selector, subject }; break; }
    if (!check.ok) break;
  }
  if (!selected) throw new Error("no actually returned supported uncursed selector established within one retry");
  const offRamp = await view(rpc, router.decoded, ROUTER_IFACE, "isOffRamp", [selected.selector, OUTSIDER], pinTag, "router.isOffRamp.selected.outsider", (x) => Boolean(x[0]));

  const sourceAcquisition = await acquireSource(sourceReader, sourceTarget);
  const exactSourceAndOrder = sourceAcquisition.record.sourceRuntimeEquivalence === true && sourceAcquisition.record.callOrderExact === true;
  const tuple = {
    originalSender: ABI.encode(["address"], [OUTSIDER]),
    remoteChainSelector: selected.selector,
    receiver: OUTSIDER,
    amount: "1",
    localToken: TOKEN,
    sourcePoolAddress: "0x",
    sourcePoolData: ABI.encode(["uint256"], [6]),
    offchainTokenData: "0x",
  };
  const calldata = POOL_IFACE.encodeFunctionData("releaseOrMint", [tuple]);
  if (calldata.slice(0, 10).toLowerCase() !== EXPECTED_RELEASE_SELECTOR) throw new Error("encoded calldata selector mismatch");
  // Exactly one eth_call carries `from: outsider` in the entire run.
  const releaseResponse = await rpc.read("eth_call", [{ from: OUTSIDER, to: POOL, data: calldata }, pinTag], "pool.releaseOrMint.outsider.single");
  const releaseClassification = classifyRelease(releaseResponse, selected.selector, exactSourceAndOrder);

  const terminal = await rpc.read("eth_getBlockByNumber", [pinTag, false], "pin.terminalSameNumber");
  const terminalSameHash = Boolean(terminal.ok && terminal.result?.number?.toLowerCase() === pinTag && terminal.result?.hash?.toLowerCase() === initialHash);
  const proxyKind = implementation ? (slotImpl ? "eip1967" : "eip1167") : "direct";
  const bindingComplete = runtime.present && (!implementation || implementationRuntime?.present) && hasCode(routerCodeR.result) && hasCode(tokenCodeR.result) && hasCode(rmnCodeR.result);
  const raw = {
    generatedAt: new Date(timestamp * 1000).toISOString(),
    runId: `ccip-syrupusdt-release-auth-${blockNumber}-${initialHash.slice(2, 14)}`,
    scanner: SCANNER,
    scope: "Authorized defensive CCIP Ethereum syrupUSDT LockRelease releaseOrMint outsider authorization subbranch at one finalized-selected fixed block",
    signal: null,
    classification: null,
    pin: {
      selection: "eth_getBlockByNumber(finalized,false)", blockNumberHex: pinTag, blockNumberDecimal: blockNumber,
      blockHash: initialHash, blockTimestampHex: finalized.result.timestamp.toLowerCase(), blockTimestampDecimal: timestamp,
      postPinReadTag: "block-number", terminalRecheck: "eth_getBlockByNumber(same-number,false)",
      terminalHash: terminal.ok ? terminal.result?.hash?.toLowerCase() || null : null, terminalSameHash,
    },
    pool: {
      address: POOL, runtime,
      proxy: {
        kind: proxyKind, implementationSlot: implSlotR.result, adminSlot: adminSlotR.result, beaconSlot: beaconSlotR.result,
        implementationAddress: implementation, implementationRuntime, adminAddress: slotAddress(adminSlotR.result), beaconAddress: slotAddress(beaconSlotR.result),
      },
      getters: { typeAndVersion, router, token, rmnProxy: rmn, supportedChains: supported },
      tokenMatch: token.decoded === TOKEN,
      dependencyCode: { router: codeInfo(routerCodeR.result), token: codeInfo(tokenCodeR.result), rmnProxy: codeInfo(rmnCodeR.result) },
      bindingComplete,
    },
    outsider: { address: OUTSIDER, codeExact: outsiderCodeR.result, noCodeAtPin: noCode(outsiderCodeR.result) },
    selectedChain: {
      selector: selected.selector, actuallyReturnedSupported: supported.decoded.includes(selected.selector),
      rmnSubject: selected.subject, cursed: false, curseChecks,
      routerAddress: router.decoded, outsiderIsOffRamp: offRamp.ok ? offRamp.decoded : null, routerInterfaceSupported: offRamp.ok,
      routerRawReturnOrRevertBytes: offRamp.raw,
    },
    releaseOrMintProbe: {
      abi: "releaseOrMint((bytes,uint64,address,uint256,address,bytes,bytes,bytes))",
      selector: EXPECTED_RELEASE_SELECTOR, tuple, calldata,
      ...releaseClassification,
      outsiderEthCallCount: 1,
    },
    source: sourceAcquisition.record,
    legacySupersession: {
      artifact: "reports/raw/fast/full-attack-test-ccip.json", deleted: false, superseded: true,
      reasons: ["wrong releaseOrMint(bytes) ABI", "null/error-swallowing RPC logic", "cannot support POTENTIAL_DRAIN/pause/unpause claims"],
    },
    safety: {
      authorizedDefensive: true, readOnly: true, endpointInventoriesRead: false, envFilesRead: false,
      endpointValuesTokensHeadersStored: false, privateKeysRead: false, transactions: false, signing: false,
      broadcasts: false, forkPerformed: false, stateOverride: false, historyScan: false, realFunds: false,
      aggregateGatesEdited: false, targetClaimReleased: false,
    },
    requestCounts: { jsonRpc: rpc.count, jsonRpcCap: MAX_RPC_READS, sourceMetadata: sourceReader.count, sourceMetadataCap: MAX_SOURCE_REQUESTS },
    rpcTranscript: rpc.transcript,
    sourceRequestTranscript: sourceReader.transcript,
    blockers: [],
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    nextAction: null,
  };
  if (!terminalSameHash) raw.blockers.push("Terminal same-number block hash did not match the finalized-selected pin.");
  if (sourceAcquisition.record.sourceRuntimeEquivalence !== true) raw.blockers.push("Exact source/runtime equivalence was not proven; keep WATCH even if the expected caller revert was returned.");
  if (!sourceAcquisition.record.callOrderExact) raw.blockers.push("Exact deployed-equivalent authorization-before-source-validation/transfer order was not proven.");
  if (!offRamp.ok) raw.blockers.push("Router isOffRamp(uint64,address) interface result was unavailable.");
  if (releaseClassification.escalation) raw.nextAction = "Stop read-only closure and request a separately authorized fixed-block local fork proving whether outsider value motion is possible; do not use live funds or broadcast.";
  else if (releaseClassification.authorizationSubbranchClosed && terminalSameHash) raw.nextAction = "Close only this outsider release authorization subbranch; monitor pool/router/runtime drift and rerun on change. No fork or live action is justified.";
  else raw.nextAction = "Resolve the recorded source/runtime, call-order, pin, or interface blocker and rerun this bounded read-only scanner; do not fork or execute live.";
  Object.assign(raw, classificationFor(raw));

  writePackage(raw);
  console.log(`runId=${raw.runId} classification=${raw.classification} pin=${blockNumber}/${initialHash} selector=${selected.selector} offRamp=${offRamp.decoded} call=${releaseClassification.classification} sourceRuntime=${raw.source.sourceRuntimeEquivalence} reads=${rpc.count}/${MAX_RPC_READS} sources=${sourceReader.count}/${MAX_SOURCE_REQUESTS}`);
}

function selfTest() {
  if (POOL_IFACE.getFunction("releaseOrMint").selector.toLowerCase() !== EXPECTED_RELEASE_SELECTOR) throw new Error("release selector mismatch");
  if (id("CallerIsNotARampOnRouter(address)").slice(0, 10).toLowerCase() !== ERRORS.caller) throw new Error("caller selector mismatch");
  const callerData = `${ERRORS.caller}${"0".repeat(24)}${OUTSIDER.slice(2).toLowerCase()}`;
  const expected = classifyRelease({ ok: false, error: { code: 3, message: "execution reverted", data: callerData } }, "1", true);
  const watch = classifyRelease({ ok: false, error: { code: 3, message: "execution reverted", data: callerData } }, "1", false);
  const malformed = classifyRelease({ ok: false, error: { code: 3, message: "execution reverted", data: ERRORS.caller } }, "1", true);
  const sourcePool = classifyRelease({ ok: false, error: { code: 3, message: "execution reverted", data: `${ERRORS.invalidSourcePool}${"0".repeat(128)}` } }, "1", true);
  const success = classifyRelease({ ok: true, result: ABI.encode(["uint256"], [1]) }, "1", true);
  if (!expected.authorizationSubbranchClosed || expected.classification !== "EXPECTED_AUTHORIZATION_REVERT_SUBBRANCH_CLOSED") throw new Error("expected caller classification failed");
  if (watch.authorizationSubbranchClosed || !watch.classification.includes("WATCH")) throw new Error("source-unproven caller classification failed");
  if (malformed.classification !== "UNKNOWN_INCOMPLETE") throw new Error("malformed caller payload accepted");
  if (!sourcePool.escalation || !success.escalation) throw new Error("escalation classification failed");
  const order = sourceOrder("_validateReleaseOrMint(releaseOrMintIn) _calculateLocalAmount(releaseOrMintIn.amount safeTransfer(releaseOrMintIn.receiver, localAmount)", "isSupportedToken(releaseOrMintIn.localToken) isCursed(bytes16(uint128(releaseOrMintIn.remoteChainSelector))) _onlyOffRamp(releaseOrMintIn.remoteChainSelector) isRemotePool(releaseOrMintIn.remoteChainSelector, releaseOrMintIn.sourcePoolAddress) _consumeInboundRateLimit(releaseOrMintIn.remoteChainSelector, releaseOrMintIn.amount) function _onlyOffRamp( isSupportedChain(remoteChainSelector) s_router.isOffRamp(remoteChainSelector, msg.sender)");
  if (!order.exact) throw new Error("source order classifier failed");
  console.log("self-test PASS: ABI/selectors, canonical caller binding, fail-closed source gate, escalation, and source order");
}

function verify() {
  const manifest = JSON.parse(fs.readFileSync(abs(MANIFEST), "utf8"));
  for (const expected of manifest.records) {
    const actual = fileRecord(expected.path);
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) throw new Error(`manifest mismatch: ${expected.path}`);
  }
  const aggregate = sha256(Buffer.from(manifest.records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n"), "utf8"));
  if (aggregate !== manifest.aggregateSha256) throw new Error("manifest aggregate mismatch");
  const raw = JSON.parse(fs.readFileSync(abs(RAW), "utf8"));
  if (raw.requestCounts.jsonRpc > MAX_RPC_READS || raw.rpcTranscript.length !== raw.requestCounts.jsonRpc) throw new Error("RPC transcript/budget mismatch");
  if (raw.requestCounts.sourceMetadata > MAX_SOURCE_REQUESTS || raw.sourceRequestTranscript.length !== raw.requestCounts.sourceMetadata) throw new Error("source transcript/budget mismatch");
  if (!raw.pin.terminalSameHash) throw new Error("terminal same-number hash recheck failed");
  if (!raw.outsider.noCodeAtPin || raw.outsider.codeExact !== "0x") throw new Error("outsider no-code proof missing");
  if (raw.releaseOrMintProbe.selector !== EXPECTED_RELEASE_SELECTOR || !raw.releaseOrMintProbe.calldata.startsWith(EXPECTED_RELEASE_SELECTOR)) throw new Error("release calldata mismatch");
  if (raw.releaseOrMintProbe.outsiderEthCallCount !== 1) throw new Error("outsider eth_call count mismatch");
  const outsiderCalls = raw.rpcTranscript.filter((x) => x.method === "eth_call" && x.params?.[0]?.from?.toLowerCase() === OUTSIDER.toLowerCase());
  if (outsiderCalls.length !== 1 || outsiderCalls[0].label !== "pool.releaseOrMint.outsider.single") throw new Error("exactly-one outsider eth_call invariant failed");
  if (raw.selectedChain.cursed !== false || !raw.selectedChain.actuallyReturnedSupported) throw new Error("selected selector support/curse invariant failed");
  const serializedArtifacts = [RAW, MANIFEST, REPORT, INBOX, HANDOFF].map((x) => fs.readFileSync(abs(x), "utf8")).join("\n");
  if (/https?:\/\//i.test(serializedArtifacts)) throw new Error("endpoint/URL leakage in generated artifacts");
  if (/(?:api[_-]?key|bearer|authorization)\s*[:=]/i.test(serializedArtifacts)) throw new Error("credential/header leakage in generated artifacts");
  if (!fs.readFileSync(abs(REPORT), "utf8").match(/Signal: (?:⚪ CLEAN|🟠 WATCH|🟡 VULNERABLE)/)) throw new Error("report signal tag missing");
  if (raw.routePositive !== 0 || raw.executableNow !== 0 || raw.signedActionJustified !== false) throw new Error("global gate invariant failed");
  console.log(`verify PASS: runId=${raw.runId} records=${manifest.records.length} rpc=${raw.requestCounts.jsonRpc}/${MAX_RPC_READS} source=${raw.requestCounts.sourceMetadata}/${MAX_SOURCE_REQUESTS} terminalHash=true leak=false signal=true gates=0/0/false`);
}

function repairDerived() {
  const raw = JSON.parse(fs.readFileSync(abs(RAW), "utf8"));
  if (raw.releaseOrMintProbe.selector !== EXPECTED_RELEASE_SELECTOR) {
    raw.releaseOrMintProbe.revertSelector = raw.releaseOrMintProbe.selector;
    raw.releaseOrMintProbe.selector = EXPECTED_RELEASE_SELECTOR;
  }
  writePackage(raw);
  console.log(`repair-derived PASS: runId=${raw.runId} (offline; zero requests)`);
}

const mode = process.argv[2];
if (mode === "--self-test") selfTest();
else if (mode === "--verify") verify();
else if (mode === "--repair-derived") repairDerived();
else scan().catch((error) => { console.error(`scanner failed: ${safeMessage(error && error.message ? error.message : error)}`); process.exitCode = 1; });
