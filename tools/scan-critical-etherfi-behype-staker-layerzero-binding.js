#!/usr/bin/env node
"use strict";

// Authorized read-only Step 4. Endpoint inventory values, origins, domains,
// credentials and headers are never persisted or printed. No stake/send/retry/
// claim call, eth_send*, signing, impersonation, fork or real funds are used.

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { Interface, AbiCoder, getAddress, id, keccak256, toQuantity, zeroPadValue } = require("ethers");
const { loadRpcUrls, getOrigin } = require("./shared-rpc");

const ROOT = path.resolve(__dirname, "..");
const NAME = "critical-etherfi-behype-staker-layerzero-binding";
const SCANNER = `tools/scan-${NAME}.js`;
const VALIDATOR = `tools/test-${NAME}.js`;
const RAW = `reports/raw/fast/${NAME}.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const REPORT = `reports/${NAME}.md`;
const INBOX = `coordination/inbox/critical/2026-07-22-${NAME}.json`;
const HANDOFF = `coordination/handoffs/2026-07-22-${NAME}-handoff.md`;
const STEP1 = "reports/raw/fast/critical-etherfi-unknown-default-identity-binding.json";
const STEP3 = "reports/raw/fast/critical-etherfi-behype-fee-refund-delivery-invariant.json";
const REVISION = "behype-staker-layerzero-binding-step4-reviewer-r2";
const AGENT = "critical-etherfi-behype-staker-lz-r2-20260722";
const SOURCE_COMMIT = "247faab2206cb651e2e81b2331404eed841145b8";
const OP_CHAIN = 10;
const DEST_CHAIN = 999;
const OP_EID = 30111;
const DEST_EID = 30367;
const SOURCE_HISTORY_FALLBACK = 151285642;
const DEST_HISTORY_FALLBACK = 18593359;
const OP_HISTORY_CHUNK = 10_000;
const DEST_HISTORY_CHUNK = 1_000_000;
const MAX_PROVIDER_CALLS = 1400;
const MAX_RPC_READS = 12000;
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const ADDR = {
  dataProvider: "0xDC515Cb479a64552c5A11a57109C314E40A1A778",
  module: "0xd12efd5067DE109F9D00e1A31a34991d58DbB9F3",
  l2StakerProxy: "0x3f1Bdae959cEd680E434Fe201861E97976eA4A8F",
  l2StakerImplementation: "0x18c814EC6d034a7fc62EEab64939a8b786381383",
  sourceWhype: "0xd83E3d560bA6F05094d9D8B3EB8aaEA571D1864E",
  sourceBehype: "0xA519AfBc91986c0e7501d7e34968FEE51CD901aC",
  sourceEndpoint: "0x1a44076050125825900e736c501f859c50fE728c",
  destinationReceiverProxy: "0xe6a3bcd93e9d56e5252db47ff512629fd3cc9b54",
  destinationReceiverImplementation: "0xa86A273542Cf89B56acdaB454B5cb2B8b3dBC7a3",
  destinationWhypeAdapter: "0x2B7E48511ea616101834f09945c11F7d78D9136d",
  destinationBehypeAdapter: "0x637De4A55cdD37700F9B54451B709b01040D48dF",
  destinationWhype: "0x5555555555555555555555555555555555555555",
  destinationBehype: "0xd8FC8F0b03eBA61F64D08B0bef69d80916E5DdA9",
  stakingCore: "0xCeaD893b162D38e714D82d06a7fe0b0dc3c38E0b",
  destinationEndpoint: "0x3A73033C0b1407574C76BdBAc67f126f6b4a9AA9",
};
const EXPLORER_REQUESTS = [
  { key: "l2Proxy", chainId: OP_CHAIN, address: ADDR.l2StakerProxy, base: "https://explorer.optimism.io/api/v2/smart-contracts/" },
  { key: "l2Implementation", chainId: OP_CHAIN, address: ADDR.l2StakerImplementation, base: "https://explorer.optimism.io/api/v2/smart-contracts/" },
  { key: "sourceWhype", chainId: OP_CHAIN, address: ADDR.sourceWhype, base: "https://explorer.optimism.io/api/v2/smart-contracts/" },
  { key: "sourceBehype", chainId: OP_CHAIN, address: ADDR.sourceBehype, base: "https://explorer.optimism.io/api/v2/smart-contracts/" },
  { key: "destinationProxy", chainId: DEST_CHAIN, address: ADDR.destinationReceiverProxy, base: "https://hyperscan.com/api/v2/smart-contracts/" },
  { key: "destinationImplementation", chainId: DEST_CHAIN, address: ADDR.destinationReceiverImplementation, base: "https://hyperscan.com/api/v2/smart-contracts/" },
  { key: "destinationWhypeAdapter", chainId: DEST_CHAIN, address: ADDR.destinationWhypeAdapter, base: "https://hyperscan.com/api/v2/smart-contracts/" },
  { key: "destinationBehypeAdapter", chainId: DEST_CHAIN, address: ADDR.destinationBehypeAdapter, base: "https://hyperscan.com/api/v2/smart-contracts/" },
];

const DP_IFACE = new Interface([
  "function getDefaultModules() view returns(address[])",
  "function getWhitelistedModules() view returns(address[])",
  "function isDefaultModule(address) view returns(bool)",
  "function isWhitelistedModule(address) view returns(bool)",
]);
const MODULE_IFACE = new Interface([
  "function staker() view returns(address)", "function whype() view returns(address)", "function beHYPE() view returns(address)",
  "function getRefundGasLimit() view returns(uint32)", "event StakeDeposit(address indexed safe,address indexed inputAsset,address indexed outputAsset,uint256 inputAmount)",
]);
const STAKER_IFACE = new Interface([
  "function owner() view returns(address)", "function endpoint() view returns(address)", "function peers(uint32) view returns(bytes32)",
  "function enforceOptions() view returns(uint128)", "function lzReceiveGasLimit() view returns(uint128)",
  "function WHYPE() view returns(address)", "function HYPEREVM_EID() view returns(uint32)",
  "function quoteStake(uint256,address) view returns(uint256)",
]);
const OAPP_IFACE = new Interface([
  "function owner() view returns(address)", "function endpoint() view returns(address)", "function peers(uint32) view returns(bytes32)",
  "function token() view returns(address)",
]);
const ERC20_IFACE = new Interface([
  "function balanceOf(address) view returns(uint256)", "function allowance(address,address) view returns(uint256)", "function totalSupply() view returns(uint256)",
]);
const ENDPOINT_IFACE = new Interface([
  "function delegates(address) view returns(address)",
  "function getSendLibrary(address,uint32) view returns(address)",
  "function getReceiveLibrary(address,uint32) view returns(address,bool)",
  "function getConfig(address,address,uint32,uint32) view returns(bytes)",
  "function outboundNonce(address,uint32,bytes32) view returns(uint64)",
  "function inboundNonce(address,uint32,bytes32) view returns(uint64)",
  "function lazyInboundNonce(address,uint32,bytes32) view returns(uint64)",
  "function composeQueue(address,address,bytes32,uint16) view returns(bytes32)",
  "event ComposeDelivered(address from,address to,bytes32 guid,uint16 index)",
  "event LzComposeAlert(address indexed from,address indexed to,address indexed executor,bytes32 guid,uint16 index,uint256 gas,uint256 value,bytes message,bytes extraData,bytes reason)",
]);
const OFT_IFACE = new Interface([
  "event OFTSent(bytes32 indexed guid,uint32 dstEid,address indexed fromAddress,uint256 amountSentLD,uint256 amountReceivedLD)",
  "event OFTReceived(bytes32 indexed guid,uint32 srcEid,address indexed toAddress,uint256 amountReceivedLD)",
  "function quoteSend((uint32 dstEid,bytes32 to,uint256 amountLD,uint256 minAmountLD,bytes extraOptions,bytes composeMsg,bytes oftCmd),bool) view returns((uint256 nativeFee,uint256 lzTokenFee))",
]);
const SAFE_IFACE = new Interface(["function getThreshold() view returns(uint256)", "function getOwners() view returns(address[])"]);
const CODER = AbiCoder.defaultAbiCoder();

function abs(x) { return path.join(ROOT, x); }
function sha(x) { return crypto.createHash("sha256").update(x).digest("hex"); }
function canonical(v) { if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`; if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`; return JSON.stringify(v); }
function hashFile(rel) { const b = fs.readFileSync(abs(rel)); return { path: rel, bytes: b.length, sha256: sha(b) }; }
function writeOwned(rel, text) { if (![RAW, MANIFEST, REPORT, INBOX, HANDOFF].includes(rel)) throw new Error(`write refused ${rel}`); fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), text, "utf8"); }
function strip0x(x) { return String(x || "").replace(/^0x/i, ""); }
function runtimePresent(x) { const s = strip0x(x); return s.length > 0 && !/^0+$/.test(s); }
function sameAddress(a, b) { return Boolean(a && b && String(a).toLowerCase() === String(b).toLowerCase()); }
function asAddress(x) { try { return getAddress(String(x)); } catch { return null; } }
function slotAddress(x) { const s = strip0x(x); return s.length === 64 && !/^0+$/.test(s) ? asAddress(`0x${s.slice(-40)}`) : null; }
function bytes32Address(x) { const s = strip0x(x); return s.length === 64 && !/^0+$/.test(s) ? asAddress(`0x${s.slice(-40)}`) : null; }
function toNum(x) { return Number(BigInt(x)); }
function rawLogDigest(logs) { return sha(logs.map((x) => canonical({ address: x.address.toLowerCase(), blockHash: x.blockHash.toLowerCase(), transactionHash: x.transactionHash.toLowerCase(), transactionIndex: x.transactionIndex.toLowerCase(), logIndex: x.logIndex.toLowerCase(), topics: x.topics.map((t) => t.toLowerCase()), data: x.data.toLowerCase() })).sort().join("\n")); }
const logOrder = (a, b) => toNum(a.blockNumber) - toNum(b.blockNumber) || toNum(a.transactionIndex) - toNum(b.transactionIndex) || toNum(a.logIndex) - toNum(b.logIndex);

async function rpcFetch(url, origin, method, params, timeout = 20_000, retries = 1) {
  let last;
  for (let i = 0; i <= retries; ++i) {
    try {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(timeout) });
      if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { code: response.status });
      const body = await response.json(); if (body.error) throw new Error("rpc-error"); return body.result;
    } catch (e) { last = e; }
  }
  throw last;
}

class Reader {
  constructor(provider, cap = MAX_RPC_READS) { this.provider = provider; this.cap = cap; this.count = 0; this.transcript = []; }
  async read(method, params, label, timeout = 20_000) {
    if (++this.count > this.cap) throw new Error("rpc read cap");
    try { let result = await rpcFetch(this.provider.url, this.provider.origin, method, params, timeout); if (method === "eth_getBlockByNumber" && result == null) { for (let i = 0; i < 3 && result == null; ++i) result = await rpcFetch(this.provider.url, this.provider.origin, method, params, timeout); } if (method === "eth_getBlockByNumber" && result == null) throw new Error("null-block"); this.transcript.push({ number: this.count, method, label, ok: true }); return { ok: true, result }; }
    catch (e) { this.transcript.push({ number: this.count, method, label, ok: false, code: Number.isInteger(e?.code) ? e.code : null }); return { ok: false }; }
  }
  async call(address, iface, fn, args, block, label) {
    const r = await this.read("eth_call", [{ to: address, data: iface.encodeFunctionData(fn, args) }, toQuantity(block)], label);
    if (!r.ok) return r;
    try { return { ok: true, decoded: iface.decodeFunctionResult(fn, r.result), raw: r.result }; } catch { return { ok: false }; }
  }
}

async function selectProviders(chainId, minimum, archiveProbe = false) {
  let inventory = []; try { inventory = [...new Set(loadRpcUrls())]; } catch { inventory = []; }
  const groups = new Map(); const qualified = []; const rejected = {}; let calls = 0; let endpointsTried = 0;
  const reject = (k) => { rejected[k] = (rejected[k] || 0) + 1; };
  async function probe(url, ordinal) {
    const origin = getOrigin(url);
    try {
      if (++calls > MAX_PROVIDER_CALLS) throw new Error("budget");
      const cid = await rpcFetch(url, origin, "eth_chainId", [], 5_000, 0); if (Number(BigInt(cid)) !== chainId) throw new Error("chain-mismatch");
      if (++calls > MAX_PROVIDER_CALLS) throw new Error("budget");
      const block = await rpcFetch(url, origin, "eth_getBlockByNumber", ["finalized", false], 7_000, 0); if (!block?.hash) throw new Error("no-finalized");
      if (archiveProbe) {
        if (++calls > MAX_PROVIDER_CALLS) throw new Error("budget");
        const code = await rpcFetch(url, origin, "eth_getCode", [ADDR.l2StakerProxy, toQuantity(SOURCE_HISTORY_FALLBACK)], 7_000, 0); if (!runtimePresent(code)) throw new Error("no-archive-code");
        if (++calls > MAX_PROVIDER_CALLS) throw new Error("budget");
        await rpcFetch(url, origin, "eth_getLogs", [{ address: ADDR.sourceWhype, fromBlock: toQuantity(SOURCE_HISTORY_FALLBACK), toBlock: toQuantity(SOURCE_HISTORY_FALLBACK + 999) }], 12_000, 0);
      }
      return { url, origin, ordinal, block, key: `${block.number}:${String(block.hash).toLowerCase()}` };
    } catch (e) { reject(String(e.message || "failure").replace(/HTTP \d+/, "http-failure")); return null; }
  }
  for (let start = 0; start < inventory.length && calls < MAX_PROVIDER_CALLS; start += 20) {
    const rows = await Promise.all(inventory.slice(start, start + 20).map((u, i) => probe(u, start + i))); endpointsTried = Math.min(start + 20, inventory.length);
    for (const row of rows.filter(Boolean)) { const g = groups.get(row.key) || []; g.push(row); groups.set(row.key, g); qualified.push(row); }
    if (archiveProbe && qualified.length >= minimum) {
      const candidates = qualified.slice(0, Math.max(minimum, 5));
      const fixedNumber = Math.min(...candidates.map((x) => toNum(x.block.number)));
      const fixedRows = await Promise.all(candidates.map(async (p) => {
        try { calls++; const block = await rpcFetch(p.url, p.origin, "eth_getBlockByNumber", [toQuantity(fixedNumber), false], 10_000, 0); return block?.hash ? { ...p, block, key: `${block.number}:${block.hash.toLowerCase()}` } : null; } catch { return null; }
      }));
      const fixedGroups = new Map(); for (const row of fixedRows.filter(Boolean)) { const g = fixedGroups.get(row.key) || []; g.push(row); fixedGroups.set(row.key, g); }
      const fixedWinner = [...fixedGroups.values()].sort((a, b) => b.length - a.length)[0] || [];
      if (fixedWinner.length >= minimum) return { providers: fixedWinner.slice(0, minimum), inventoryCount: inventory.length, endpointsTried, calls, rejected, groupCount: groups.size, finalizedSelectionMode: "lowest-common-finalized-height" };
    }
    const winner = [...groups.values()].filter((x) => x.length >= minimum).sort((a, b) => toNum(b[0].block.number) - toNum(a[0].block.number))[0];
    if (winner) return { providers: winner.slice(0, Math.max(minimum, Math.min(3, winner.length))), inventoryCount: inventory.length, endpointsTried, calls, rejected, groupCount: groups.size };
  }
  const best = [...groups.values()].sort((a, b) => b.length - a.length)[0] || [];
  if (best.length < minimum) return { providers: best, inventoryCount: inventory.length, endpointsTried, calls, rejected, groupCount: groups.size };
  return { providers: best.slice(0, minimum), inventoryCount: inventory.length, endpointsTried, calls, rejected, groupCount: groups.size };
}

async function codeBoundary(provider, address, high) {
  let low = 0; let calls = 0;
  while (low < high) { const mid = Math.floor((low + high) / 2); calls++; const code = await rpcFetch(provider.url, provider.origin, "eth_getCode", [address, toQuantity(mid)], 15_000); if (runtimePresent(code)) high = mid; else low = mid + 1; }
  const at = await rpcFetch(provider.url, provider.origin, "eth_getCode", [address, toQuantity(low)], 15_000); calls++;
  const before = low === 0 ? "0x" : await rpcFetch(provider.url, provider.origin, "eth_getCode", [address, toQuantity(low - 1)], 15_000); calls += low === 0 ? 0 : 1;
  return { firstPresentBlock: low, present: runtimePresent(at), absentImmediatelyBefore: !runtimePresent(before), complete: runtimePresent(at) && !runtimePresent(before), calls };
}

async function scanLogs(provider, addresses, firstTopics, fromBlock, toBlock, chunk) {
  const logs = []; const ranges = []; let calls = 0;
  for (let start = fromBlock; start <= toBlock; start += chunk) {
    const end = Math.min(toBlock, start + chunk - 1); calls++;
    try { const rows = await rpcFetch(provider.url, provider.origin, "eth_getLogs", [{ address: addresses, fromBlock: toQuantity(start), toBlock: toQuantity(end), topics: [firstTopics] }], 30_000); logs.push(...rows); ranges.push({ fromBlock: start, toBlock: end, count: rows.length, ok: true }); }
    catch { return { complete: false, logs, ranges: [...ranges, { fromBlock: start, toBlock: end, ok: false }], calls }; }
  }
  logs.sort(logOrder); return { complete: true, logs, ranges, calls, digest: rawLogDigest(logs) };
}

async function terminalRecheck(providers, chainId, blockNumber, blockHash, label) {
  const rows = await Promise.all(providers.map(async (provider) => {
    let matched = false; let attempts = 0;
    for (let i = 0; i < 2 && !matched; ++i) {
      attempts++;
      try {
        const block = await rpcFetch(provider.url, provider.origin, "eth_getBlockByNumber", [toQuantity(blockNumber), false], 15_000, 0);
        matched = Number(BigInt(block?.number || "0x0")) === blockNumber && String(block?.hash || "").toLowerCase() === blockHash;
      } catch {}
    }
    return { ordinal: provider.ordinal, attempts, matched };
  }));
  return { label, chainId, blockNumber, threshold: 2, matchCount: rows.filter((x) => x.matched).length, verified: rows.filter((x) => x.matched).length >= 2, rows };
}

async function fetchExplorerMetadata() {
  const out = {}; let requests = 0;
  async function publicJson(url, label) {
    let lastStatus = null;
    for (let attempt = 0; attempt < 8; ++attempt) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(60_000) }); lastStatus = response.status;
        if (response.ok) { const body = await response.json(); if (body && typeof body === "object" && !Array.isArray(body)) return body; }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)));
    }
    throw new Error(`public-source-${label}-status-${lastStatus ?? "transport"}`);
  }
  for (const row of EXPLORER_REQUESTS) {
    requests++;
    out[row.key] = await publicJson(`${row.base}${row.address}`, row.key);
  }
  const sourceBehypeImpl = out.sourceBehype.implementations?.[0]?.address_hash || out.sourceBehype.implementations?.[0]?.address;
  if (sourceBehypeImpl) {
    requests++;
    try { out.sourceBehypeImplementation = await publicJson(`https://explorer.optimism.io/api/v2/smart-contracts/${sourceBehypeImpl}`, "sourceBehypeImplementation"); } catch {}
  }
  return { metas: out, requestCount: requests };
}

function sourceSummary(key, meta, chainId, address) {
  const sources = [{ file_path: meta.file_path, source_code: meta.source_code }, ...(meta.additional_sources || [])].filter((x) => x.file_path && typeof x.source_code === "string");
  const normalized = [...new Map(sources.map((x) => [x.file_path, x.source_code])).entries()].map(([file, source]) => ({ file, bytes: Buffer.byteLength(source), sha256: sha(source) })).sort((a, b) => a.file.localeCompare(b.file));
  return { key, chainId, address: getAddress(address), name: meta.name || null, verified: meta.is_verified === true, fullyVerified: meta.is_fully_verified === true, compilerVersion: meta.compiler_version || null, optimizerEnabled: meta.optimization_enabled ?? meta.compiler_settings?.optimizer?.enabled ?? null, optimizerRuns: meta.optimization_runs ?? meta.compiler_settings?.optimizer?.runs ?? null, viaIR: meta.compiler_settings?.viaIR ?? null, evmVersion: meta.evm_version || meta.compiler_settings?.evmVersion || null, sourceCount: normalized.length, sourcesAggregateSha256: sha(normalized.map((x) => `${x.file}\0${x.bytes}\0${x.sha256}`).join("\n")), abiFunctionNames: (meta.abi || []).filter((x) => x.type === "function").map((x) => x.name).sort(), deployedBytecodeKeccak256: runtimePresent(meta.deployed_bytecode) ? keccak256(meta.deployed_bytecode) : null };
}

function ensureSolc824() {
  const root = path.join(os.tmpdir(), "opencode", "solc824"); const modulePath = path.join(root, "node_modules", "solc");
  fs.mkdirSync(root, { recursive: true });
  if (!fs.existsSync(path.join(modulePath, "package.json"))) {
    const r = spawnSync("npm.cmd", ["install", "--prefix", root, "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", "solc@0.8.24"], { cwd: ROOT, encoding: "utf8", timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
    if (r.status !== 0) throw new Error("exact compiler package unavailable");
  }
  const solc = require(modulePath); const version = solc.version(); if (!version.startsWith("0.8.24+commit.e11b9ed9")) throw new Error("compiler version mismatch");
  const packageJson = fs.readFileSync(path.join(modulePath, "package.json"));
  return { solc, provenance: { requested: "0.8.24", fullVersion: version, exactVersion: true, packageJsonBytes: packageJson.length, packageJsonSha256: sha(packageJson) } };
}

function immutableNames(output) {
  const names = new Map();
  function walk(node, sourcePath) { if (!node || typeof node !== "object") return; if (node.nodeType === "VariableDeclaration" && node.mutability === "immutable") names.set(String(node.id), { name: node.name, sourcePath }); for (const v of Object.values(node)) { if (Array.isArray(v)) v.forEach((x) => walk(x, sourcePath)); else if (v && typeof v === "object") walk(v, sourcePath); } }
  for (const [sourcePath, row] of Object.entries(output.sources || {})) walk(row.ast, sourcePath);
  return names;
}

function compileVerified(meta, solc, deployedCode, bindings, label) {
  const sourceMap = new Map();
  for (const row of [{ file_path: meta.file_path, source_code: meta.source_code }, ...(meta.additional_sources || [])]) if (row.file_path && typeof row.source_code === "string") sourceMap.set(row.file_path, row.source_code);
  const settings = JSON.parse(JSON.stringify(meta.compiler_settings || {}));
  settings.outputSelection = { "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode", "metadata"], "": ["ast"] } };
  const input = { language: "Solidity", sources: Object.fromEntries([...sourceMap.entries()].map(([k, v]) => [k, { content: v }])), settings };
  const output = JSON.parse(solc.compile(JSON.stringify(input))); const errors = (output.errors || []).filter((x) => x.severity === "error"); if (errors.length) throw new Error(`${label} compile: ${errors[0].formattedMessage || errors[0].message}`);
  const artifact = output.contracts?.[meta.file_path]?.[meta.name]; if (!artifact) throw new Error(`${label} artifact missing`);
  const runtime = Buffer.from(strip0x(artifact.evm.deployedBytecode.object), "hex"); const names = immutableNames(output); const rows = [];
  for (const [astId, positions] of Object.entries(artifact.evm.deployedBytecode.immutableReferences || {})) {
    const decl = names.get(String(astId)); const value = bindings[decl?.name]; if (!decl || !value) throw new Error(`${label} immutable unbound ${decl?.name || astId}`);
    const word = Buffer.from(strip0x(value).padStart(64, "0"), "hex");
    for (const p of positions) { word.copy(runtime, Number(p.start)); rows.push({ astId, declarationName: decl.name, sourcePath: decl.sourcePath, start: Number(p.start), length: Number(p.length), value: getAddress(value) }); }
  }
  const deployed = Buffer.from(strip0x(deployedCode), "hex");
  return { label, contractName: meta.name, compilerVersion: meta.compiler_version, standardJsonInputSha256: sha(canonical(input)), sourceCount: sourceMap.size, compiledBytes: runtime.length, deployedBytes: deployed.length, compiledKeccak256: keccak256(runtime), deployedKeccak256: keccak256(deployed), exactRuntime: runtime.equals(deployed), immutableReferences: rows };
}

async function coreOpSnapshot(provider, blockNumber) {
  const r = new Reader(provider); const block = await r.read("eth_getBlockByNumber", [toQuantity(blockNumber), false], "pin.block"); const chain = await r.read("eth_chainId", [], "pin.chainId");
  const defaults = await r.call(ADDR.dataProvider, DP_IFACE, "getDefaultModules", [], blockNumber, "dataProvider.defaults"); const whites = await r.call(ADDR.dataProvider, DP_IFACE, "getWhitelistedModules", [], blockNumber, "dataProvider.whitelist");
  const isDefault = await r.call(ADDR.dataProvider, DP_IFACE, "isDefaultModule", [ADDR.module], blockNumber, "module.default"); const isWhite = await r.call(ADDR.dataProvider, DP_IFACE, "isWhitelistedModule", [ADDR.module], blockNumber, "module.whitelisted");
  const staker = await r.call(ADDR.module, MODULE_IFACE, "staker", [], blockNumber, "module.staker"); const whype = await r.call(ADDR.module, MODULE_IFACE, "whype", [], blockNumber, "module.whype"); const behype = await r.call(ADDR.module, MODULE_IFACE, "beHYPE", [], blockNumber, "module.behype"); const refund = await r.call(ADDR.module, MODULE_IFACE, "getRefundGasLimit", [], blockNumber, "module.refundGas");
  const code = await r.read("eth_getCode", [ADDR.l2StakerProxy, toQuantity(blockNumber)], "staker.proxyCode"); const impl = await r.read("eth_getStorageAt", [ADDR.l2StakerProxy, IMPL_SLOT, toQuantity(blockNumber)], "staker.impl"); const admin = await r.read("eth_getStorageAt", [ADDR.l2StakerProxy, ADMIN_SLOT, toQuantity(blockNumber)], "staker.admin"); const beacon = await r.read("eth_getStorageAt", [ADDR.l2StakerProxy, BEACON_SLOT, toQuantity(blockNumber)], "staker.beacon"); const implCode = await r.read("eth_getCode", [ADDR.l2StakerImplementation, toQuantity(blockNumber)], "staker.implCode");
  const owner = await r.call(ADDR.l2StakerProxy, STAKER_IFACE, "owner", [], blockNumber, "staker.owner"); const endpoint = await r.call(ADDR.l2StakerProxy, STAKER_IFACE, "endpoint", [], blockNumber, "staker.endpoint"); const peer = await r.call(ADDR.l2StakerProxy, STAKER_IFACE, "peers", [DEST_EID], blockNumber, "staker.peer"); const enforce = await r.call(ADDR.l2StakerProxy, STAKER_IFACE, "enforceOptions", [], blockNumber, "staker.enforce"); const receiveGas = await r.call(ADDR.l2StakerProxy, STAKER_IFACE, "lzReceiveGasLimit", [], blockNumber, "staker.receiveGas");
  const whypePeer = await r.call(ADDR.sourceWhype, OAPP_IFACE, "peers", [DEST_EID], blockNumber, "whype.peer"); const behypePeer = await r.call(ADDR.sourceBehype, OAPP_IFACE, "peers", [DEST_EID], blockNumber, "behype.peer"); const stakerDelegate = await r.call(ADDR.sourceEndpoint, ENDPOINT_IFACE, "delegates", [ADDR.l2StakerProxy], blockNumber, "staker.delegate"); const whypeDelegate = await r.call(ADDR.sourceEndpoint, ENDPOINT_IFACE, "delegates", [ADDR.sourceWhype], blockNumber, "whype.delegate");
  const terminal = await r.read("eth_getBlockByNumber", [toQuantity(blockNumber), false], "pin.terminal");
  function addr(x) { return x.ok ? getAddress(x.decoded[0]) : null; }
  return { chainId: chain.ok ? toNum(chain.result) : null, blockHash: block.ok && block.result?.hash ? block.result.hash.toLowerCase() : null, timestamp: block.ok && block.result?.timestamp ? toNum(block.result.timestamp) : null, terminalHash: terminal.ok && terminal.result?.hash ? terminal.result.hash.toLowerCase() : null, defaults: defaults.ok ? Array.from(defaults.decoded[0]).map(getAddress) : null, whitelist: whites.ok ? Array.from(whites.decoded[0]).map(getAddress) : null, module: { isDefault: isDefault.ok ? Boolean(isDefault.decoded[0]) : null, isWhitelisted: isWhite.ok ? Boolean(isWhite.decoded[0]) : null, staker: addr(staker), whype: addr(whype), behype: addr(behype), refundGasLimit: refund.ok ? Number(refund.decoded[0]) : null }, staker: { proxyCode: code.ok ? code.result : null, proxyRuntimeKeccak256: code.ok ? keccak256(code.result) : null, implementation: impl.ok ? slotAddress(impl.result) : null, admin: admin.ok ? slotAddress(admin.result) : null, beacon: beacon.ok ? slotAddress(beacon.result) : null, implementationCode: implCode.ok ? implCode.result : null, implementationRuntimeKeccak256: implCode.ok ? keccak256(implCode.result) : null, owner: addr(owner), endpoint: addr(endpoint), peer: peer.ok ? peer.decoded[0].toLowerCase() : null, enforceOptions: enforce.ok ? enforce.decoded[0].toString() : null, lzReceiveGasLimit: receiveGas.ok ? receiveGas.decoded[0].toString() : null, delegate: addr(stakerDelegate) }, whypePeer: whypePeer.ok ? whypePeer.decoded[0].toLowerCase() : null, behypePeer: behypePeer.ok ? behypePeer.decoded[0].toLowerCase() : null, whypeDelegate: addr(whypeDelegate), transcript: r.transcript };
}

async function destSnapshot(provider, blockNumber) {
  const r = new Reader(provider); const block = await r.read("eth_getBlockByNumber", [toQuantity(blockNumber), false], "destination.pin"); const chain = await r.read("eth_chainId", [], "destination.chainId");
  const code = await r.read("eth_getCode", [ADDR.destinationReceiverProxy, toQuantity(blockNumber)], "receiver.proxyCode"); const impl = await r.read("eth_getStorageAt", [ADDR.destinationReceiverProxy, IMPL_SLOT, toQuantity(blockNumber)], "receiver.impl"); const admin = await r.read("eth_getStorageAt", [ADDR.destinationReceiverProxy, ADMIN_SLOT, toQuantity(blockNumber)], "receiver.admin"); const beacon = await r.read("eth_getStorageAt", [ADDR.destinationReceiverProxy, BEACON_SLOT, toQuantity(blockNumber)], "receiver.beacon"); const implCode = await r.read("eth_getCode", [ADDR.destinationReceiverImplementation, toQuantity(blockNumber)], "receiver.implCode");
  const owner = await r.call(ADDR.destinationReceiverProxy, OAPP_IFACE, "owner", [], blockNumber, "receiver.owner"); const endpoint = await r.call(ADDR.destinationReceiverProxy, OAPP_IFACE, "endpoint", [], blockNumber, "receiver.endpoint"); const delegate = await r.call(ADDR.destinationEndpoint, ENDPOINT_IFACE, "delegates", [ADDR.destinationReceiverProxy], blockNumber, "receiver.delegate"); const whypePeer = await r.call(ADDR.destinationWhypeAdapter, OAPP_IFACE, "peers", [OP_EID], blockNumber, "destination.whypePeer"); const behypePeer = await r.call(ADDR.destinationBehypeAdapter, OAPP_IFACE, "peers", [OP_EID], blockNumber, "destination.behypePeer");
  const terminal = await r.read("eth_getBlockByNumber", [toQuantity(blockNumber), false], "destination.terminal");
  const addr = (x) => x.ok ? getAddress(x.decoded[0]) : null;
  return { chainId: chain.ok ? toNum(chain.result) : null, blockHash: block.ok && block.result?.hash ? block.result.hash.toLowerCase() : null, timestamp: block.ok && block.result?.timestamp ? toNum(block.result.timestamp) : null, terminalHash: terminal.ok && terminal.result?.hash ? terminal.result.hash.toLowerCase() : null, receiver: { proxyCode: code.ok ? code.result : null, proxyRuntimeKeccak256: code.ok ? keccak256(code.result) : null, implementation: impl.ok ? slotAddress(impl.result) : null, admin: admin.ok ? slotAddress(admin.result) : null, beacon: beacon.ok ? slotAddress(beacon.result) : null, implementationCode: implCode.ok ? implCode.result : null, implementationRuntimeKeccak256: implCode.ok ? keccak256(implCode.result) : null, owner: addr(owner), endpoint: addr(endpoint), delegate: addr(delegate) }, whypePeer: whypePeer.ok ? whypePeer.decoded[0].toLowerCase() : null, behypePeer: behypePeer.ok ? behypePeer.decoded[0].toLowerCase() : null, transcript: r.transcript };
}

function parseSourceHistory(logs) {
  const moduleStakes = []; const sourceWhypeSent = []; const sourceBehypeReceived = [];
  for (const log of logs) {
    try {
      if (sameAddress(log.address, ADDR.module) && log.topics[0].toLowerCase() === MODULE_IFACE.getEvent("StakeDeposit").topicHash.toLowerCase()) { const e = MODULE_IFACE.parseLog(log); moduleStakes.push({ safe: getAddress(e.args.safe), inputAsset: getAddress(e.args.inputAsset), outputAsset: getAddress(e.args.outputAsset), inputAmount: e.args.inputAmount.toString(), blockNumber: toNum(log.blockNumber), transactionHash: log.transactionHash.toLowerCase(), logIndex: toNum(log.logIndex) }); }
      else if (sameAddress(log.address, ADDR.sourceWhype) && log.topics[0].toLowerCase() === OFT_IFACE.getEvent("OFTSent").topicHash.toLowerCase()) { const e = OFT_IFACE.parseLog(log); if (sameAddress(e.args.fromAddress, ADDR.l2StakerProxy) && Number(e.args.dstEid) === DEST_EID) sourceWhypeSent.push({ guid: e.args.guid.toLowerCase(), dstEid: Number(e.args.dstEid), from: getAddress(e.args.fromAddress), amountSentLD: e.args.amountSentLD.toString(), amountReceivedLD: e.args.amountReceivedLD.toString(), blockNumber: toNum(log.blockNumber), transactionHash: log.transactionHash.toLowerCase(), logIndex: toNum(log.logIndex) }); }
      else if (sameAddress(log.address, ADDR.sourceBehype) && log.topics[0].toLowerCase() === OFT_IFACE.getEvent("OFTReceived").topicHash.toLowerCase()) { const e = OFT_IFACE.parseLog(log); if (Number(e.args.srcEid) === DEST_EID) sourceBehypeReceived.push({ guid: e.args.guid.toLowerCase(), srcEid: Number(e.args.srcEid), to: getAddress(e.args.toAddress), amountReceivedLD: e.args.amountReceivedLD.toString(), blockNumber: toNum(log.blockNumber), transactionHash: log.transactionHash.toLowerCase(), logIndex: toNum(log.logIndex) }); }
    } catch {}
  }
  return { moduleStakes, sourceWhypeSent, sourceBehypeReceived };
}

function parseDestinationHistory(logs) {
  const whypeReceived = []; const behypeSent = []; const composeDelivered = []; const composeAlerts = [];
  for (const log of logs) {
    try {
      if (sameAddress(log.address, ADDR.destinationWhypeAdapter) && log.topics[0].toLowerCase() === OFT_IFACE.getEvent("OFTReceived").topicHash.toLowerCase()) { const e = OFT_IFACE.parseLog(log); if (sameAddress(e.args.toAddress, ADDR.destinationReceiverProxy)) whypeReceived.push({ guid: e.args.guid.toLowerCase(), srcEid: Number(e.args.srcEid), to: getAddress(e.args.toAddress), amountReceivedLD: e.args.amountReceivedLD.toString(), blockNumber: toNum(log.blockNumber), transactionHash: log.transactionHash.toLowerCase(), logIndex: toNum(log.logIndex) }); }
      else if (sameAddress(log.address, ADDR.destinationBehypeAdapter) && log.topics[0].toLowerCase() === OFT_IFACE.getEvent("OFTSent").topicHash.toLowerCase()) { const e = OFT_IFACE.parseLog(log); if (sameAddress(e.args.fromAddress, ADDR.destinationReceiverProxy)) behypeSent.push({ guid: e.args.guid.toLowerCase(), dstEid: Number(e.args.dstEid), from: getAddress(e.args.fromAddress), amountSentLD: e.args.amountSentLD.toString(), amountReceivedLD: e.args.amountReceivedLD.toString(), blockNumber: toNum(log.blockNumber), transactionHash: log.transactionHash.toLowerCase(), logIndex: toNum(log.logIndex) }); }
      else if (sameAddress(log.address, ADDR.destinationEndpoint) && log.topics[0].toLowerCase() === ENDPOINT_IFACE.getEvent("ComposeDelivered").topicHash.toLowerCase()) { const e = ENDPOINT_IFACE.parseLog(log); if (sameAddress(e.args.from, ADDR.destinationWhypeAdapter) && sameAddress(e.args.to, ADDR.destinationReceiverProxy)) composeDelivered.push({ guid: e.args.guid.toLowerCase(), index: Number(e.args.index), blockNumber: toNum(log.blockNumber), transactionHash: log.transactionHash.toLowerCase(), logIndex: toNum(log.logIndex) }); }
      else if (sameAddress(log.address, ADDR.destinationEndpoint) && log.topics[0].toLowerCase() === ENDPOINT_IFACE.getEvent("LzComposeAlert").topicHash.toLowerCase()) { const e = ENDPOINT_IFACE.parseLog(log); if (sameAddress(e.args.from, ADDR.destinationWhypeAdapter) && sameAddress(e.args.to, ADDR.destinationReceiverProxy)) composeAlerts.push({ guid: e.args.guid.toLowerCase(), index: Number(e.args.index), blockNumber: toNum(log.blockNumber), transactionHash: log.transactionHash.toLowerCase(), reasonKeccak256: keccak256(e.args.reason) }); }
    } catch {}
  }
  return { whypeReceived, behypeSent, composeDelivered, composeAlerts };
}

async function authority(reader, address, block, label) {
  const code = await reader.read("eth_getCode", [address, toQuantity(block)], `${label}.code`); let threshold = null; let ownerCount = null;
  if (code.ok && runtimePresent(code.result)) { const t = await reader.call(address, SAFE_IFACE, "getThreshold", [], block, `${label}.threshold`); const o = await reader.call(address, SAFE_IFACE, "getOwners", [], block, `${label}.owners`); threshold = t.ok ? Number(t.decoded[0]) : null; ownerCount = o.ok ? o.decoded[0].length : null; }
  return { address: getAddress(address), hasCode: code.ok ? runtimePresent(code.result) : null, codeBytes: code.ok ? strip0x(code.result).length / 2 : null, multisigLikeThreshold: threshold, multisigLikeOwnerCount: ownerCount };
}

async function lzConfig(reader, endpoint, oapp, eid, send, block, label) {
  const library = await reader.call(endpoint, ENDPOINT_IFACE, send ? "getSendLibrary" : "getReceiveLibrary", [oapp, eid], block, `${label}.library`); if (!library.ok) return { readOk: false };
  const lib = getAddress(library.decoded[0]); const isDefault = send ? null : Boolean(library.decoded[1]);
  const executorRaw = await reader.call(endpoint, ENDPOINT_IFACE, "getConfig", [oapp, lib, eid, 1], block, `${label}.executorConfig`); const ulnRaw = await reader.call(endpoint, ENDPOINT_IFACE, "getConfig", [oapp, lib, eid, 2], block, `${label}.ulnConfig`);
  let executor = null; let uln = null;
  if (executorRaw.ok) try { const x = CODER.decode(["tuple(uint32 maxMessageSize,address executor)"], executorRaw.decoded[0])[0]; executor = { maxMessageSize: Number(x.maxMessageSize), executor: getAddress(x.executor) }; } catch {}
  if (ulnRaw.ok) try { const x = CODER.decode(["tuple(uint64 confirmations,uint8 requiredDVNCount,uint8 optionalDVNCount,uint8 optionalDVNThreshold,address[] requiredDVNs,address[] optionalDVNs)"], ulnRaw.decoded[0])[0]; uln = { confirmations: x.confirmations.toString(), requiredDVNCount: Number(x.requiredDVNCount), optionalDVNCount: Number(x.optionalDVNCount), optionalDVNThreshold: Number(x.optionalDVNThreshold), requiredDVNs: Array.from(x.requiredDVNs).map(getAddress), optionalDVNs: Array.from(x.optionalDVNs).map(getAddress) }; } catch {}
  return { readOk: true, library: lib, isDefault, executor, uln };
}

async function main() {
  const generatedAt = new Date().toISOString(); const scannerSha256 = hashFile(SCANNER).sha256;
  const step1 = JSON.parse(fs.readFileSync(abs(STEP1), "utf8")); const step3 = JSON.parse(fs.readFileSync(abs(STEP3), "utf8"));
  if (step1.revision !== "unknown-default-identity-binding-step1-reviewer-r2" || step1.classification !== "EXACT/IDENTIFIED-DIRECT-MODULES") throw new Error("Step 1 mismatch");
  if (!step3.classification?.startsWith("PASS/BOUNDED-VALID-ADMIN")) throw new Error("Step 3 mismatch");
  const priorModule = step1.modules.find((x) => x.name === "BeHYPEStakeModule"); if (!priorModule?.reconstruction?.exact || !sameAddress(priorModule.immutableValues.staker, ADDR.l2StakerProxy)) throw new Error("prior staker binding missing");

  const sources = await fetchExplorerMetadata();
  const opSelection = await selectProviders(OP_CHAIN, 3, true); if (opSelection.providers.length < 3) throw new Error("ACCESS_BLOCKED: three archive-capable finalized Optimism providers unavailable");
  const opPin0 = opSelection.providers[0].block; const opPin = { chainId: OP_CHAIN, blockNumber: toNum(opPin0.number), blockHash: opPin0.hash.toLowerCase(), timestamp: toNum(opPin0.timestamp), finalizedSelected: true };
  const destSelection = await selectProviders(DEST_CHAIN, 2, false); if (destSelection.providers.length < 1) throw new Error("ACCESS_BLOCKED: destination provider unavailable");
  const destPin0 = destSelection.providers[0].block; const destPin = { chainId: DEST_CHAIN, blockNumber: toNum(destPin0.number), blockHash: destPin0.hash.toLowerCase(), timestamp: toNum(destPin0.timestamp), finalizedSelected: true };

  const opSnapshots = await Promise.all(opSelection.providers.map((p) => coreOpSnapshot(p, opPin.blockNumber)));
  const opDigest = (x) => sha(canonical({ chainId: x.chainId, defaults: x.defaults?.map((a) => a.toLowerCase()), whitelist: x.whitelist?.map((a) => a.toLowerCase()), module: x.module, staker: { proxyRuntimeKeccak256: x.staker.proxyRuntimeKeccak256, implementation: x.staker.implementation?.toLowerCase(), implementationRuntimeKeccak256: x.staker.implementationRuntimeKeccak256, admin: x.staker.admin, beacon: x.staker.beacon, owner: x.staker.owner?.toLowerCase(), endpoint: x.staker.endpoint?.toLowerCase(), peer: x.staker.peer, enforceOptions: x.staker.enforceOptions, lzReceiveGasLimit: x.staker.lzReceiveGasLimit, delegate: x.staker.delegate?.toLowerCase() }, whypePeer: x.whypePeer, behypePeer: x.behypePeer, whypeDelegate: x.whypeDelegate?.toLowerCase() }));
  const opDigests = opSnapshots.map(opDigest); const opGroups = new Map(); for (let i = 0; i < opDigests.length; ++i) { const g = opGroups.get(opDigests[i]) || []; g.push(i); opGroups.set(opDigests[i], g); }
  const opBest = [...opGroups.entries()].sort((a, b) => b[1].length - a[1].length)[0]; const opConsensusIndexes = opBest?.[1] || []; if (opConsensusIndexes.length < 2) throw new Error(`Optimism state consensus unavailable: ${JSON.stringify(opSnapshots.map((x, i) => ({ ordinal: opSelection.providers[i].ordinal, blockHash: x.blockHash, terminalHash: x.terminalHash, module: x.module, staker: { implementation: x.staker.implementation, owner: x.staker.owner, peer: x.staker.peer, delegate: x.staker.delegate }, whypePeer: x.whypePeer, behypePeer: x.behypePeer })) )}`); const op = opSnapshots[opConsensusIndexes[0]];
  const opTerminalRepair = await terminalRecheck(opSelection.providers, OP_CHAIN, opPin.blockNumber, opPin.blockHash, "optimism.same-number-terminal-repair");
  const opTerminalMatchCount = opTerminalRepair.matchCount;
  const opPinVerified = opTerminalRepair.verified;
  const opPinConsensusVerified = opSelection.providers.length >= 3 && opSelection.providers.every((x) => x.block?.hash?.toLowerCase() === opPin.blockHash && toNum(x.block.number) === opPin.blockNumber);
  const destSnapshots = await Promise.all(destSelection.providers.map((p) => destSnapshot(p, destPin.blockNumber)));
  const destDigest = (x) => sha(canonical({ chainId: x.chainId, blockHash: x.blockHash, receiver: { proxyRuntimeKeccak256: x.receiver.proxyRuntimeKeccak256, implementation: x.receiver.implementation?.toLowerCase(), implementationRuntimeKeccak256: x.receiver.implementationRuntimeKeccak256, admin: x.receiver.admin, beacon: x.receiver.beacon, owner: x.receiver.owner?.toLowerCase(), endpoint: x.receiver.endpoint?.toLowerCase(), delegate: x.receiver.delegate?.toLowerCase() }, whypePeer: x.whypePeer, behypePeer: x.behypePeer }));
  const destDigests = destSnapshots.map(destDigest); const destGroups = new Map(); for (let i = 0; i < destDigests.length; ++i) { const g = destGroups.get(destDigests[i]) || []; g.push(i); destGroups.set(destDigests[i], g); }
  const destBest = [...destGroups.entries()].sort((a, b) => b[1].length - a[1].length)[0]; const destConsensusIndexes = destBest?.[1] || []; const dest = destSnapshots[destConsensusIndexes[0] ?? 0];
  const destPinVerified = dest.chainId === DEST_CHAIN && dest.blockHash === destPin.blockHash && dest.terminalHash === destPin.blockHash; if (!destPinVerified) throw new Error("destination terminal pin mismatch");
  const destTerminalRepair = await terminalRecheck(destSelection.providers, DEST_CHAIN, destPin.blockNumber, destPin.blockHash, "destination.same-number-terminal-repair");

  const opHistoryProviders = opConsensusIndexes.slice(0, 2).map((i) => opSelection.providers[i]);
  const opBoundaries = await Promise.all(opHistoryProviders.map((p) => codeBoundary(p, ADDR.l2StakerProxy, opPin.blockNumber))); const opBoundaryConsensus = opBoundaries.every((x) => x.complete && x.firstPresentBlock === opBoundaries[0].firstPresentBlock); const opHistoryStart = opBoundaryConsensus ? opBoundaries[0].firstPresentBlock : SOURCE_HISTORY_FALLBACK;
  const sourceTopics = [MODULE_IFACE.getEvent("StakeDeposit").topicHash, OFT_IFACE.getEvent("OFTSent").topicHash, OFT_IFACE.getEvent("OFTReceived").topicHash];
  const opScans = await Promise.all(opHistoryProviders.map((p) => scanLogs(p, [ADDR.module, ADDR.sourceWhype, ADDR.sourceBehype], sourceTopics, opHistoryStart, opPin.blockNumber, OP_HISTORY_CHUNK)));
  const opHistoryComplete = opScans.every((x) => x.complete) && opScans[0].digest === opScans[1].digest; if (!opHistoryComplete) throw new Error("Optimism history consensus unavailable");
  const sourceHistory = parseSourceHistory(opScans[0].logs);

  const destHistoryProviders = destConsensusIndexes.slice(0, 2).map((i) => destSelection.providers[i]);
  const destBoundaries = await Promise.all(destHistoryProviders.map((p) => codeBoundary(p, ADDR.destinationReceiverProxy, destPin.blockNumber)));
  const destBoundaryConsensus = destBoundaries.length >= 2 && destBoundaries.every((x) => x.complete && x.firstPresentBlock === destBoundaries[0].firstPresentBlock);
  const destBoundary = destBoundaries[0]; const destHistoryStart = destBoundaryConsensus || destBoundaries.length === 1 && destBoundary.complete ? destBoundary.firstPresentBlock : DEST_HISTORY_FALLBACK;
  const destTopics = [OFT_IFACE.getEvent("OFTSent").topicHash, OFT_IFACE.getEvent("OFTReceived").topicHash, ENDPOINT_IFACE.getEvent("ComposeDelivered").topicHash, ENDPOINT_IFACE.getEvent("LzComposeAlert").topicHash];
  const destScans = await Promise.all(destHistoryProviders.map((p) => scanLogs(p, [ADDR.destinationWhypeAdapter, ADDR.destinationBehypeAdapter, ADDR.destinationEndpoint], destTopics, destHistoryStart, destPin.blockNumber, DEST_HISTORY_CHUNK)));
  const destScan = destScans[0]; if (!destScan?.complete) throw new Error("destination history scan incomplete");
  const destHistoryConsensusCount = destScans.filter((x) => x.complete && x.digest === destScan.digest).length;
  const destinationHistory = parseDestinationHistory(destScan.logs);

  const moduleByTx = new Map(sourceHistory.moduleStakes.map((x) => [x.transactionHash, x])); const destReceiveByGuid = new Map(destinationHistory.whypeReceived.map((x) => [x.guid, x])); const deliveredByGuid = new Map(destinationHistory.composeDelivered.map((x) => [x.guid, x])); const destReturnsByTx = new Map(); for (const x of destinationHistory.behypeSent) { const rows = destReturnsByTx.get(x.transactionHash) || []; rows.push(x); destReturnsByTx.set(x.transactionHash, rows); } const sourceReturnByGuid = new Map(sourceHistory.sourceBehypeReceived.map((x) => [x.guid, x]));
  const routeRows = sourceHistory.sourceWhypeSent.map((sent) => { const moduleStake = moduleByTx.get(sent.transactionHash) || null; const received = destReceiveByGuid.get(sent.guid) || null; const delivered = deliveredByGuid.get(sent.guid) || null; const returns = delivered ? (destReturnsByTx.get(delivered.transactionHash) || []).filter((x) => x.dstEid === OP_EID) : []; const returnSend = returns.length === 1 ? returns[0] : null; const sourceReturn = returnSend ? sourceReturnByGuid.get(returnSend.guid) || null : null; return { sourceGuid: sent.guid, sourceTransactionHash: sent.transactionHash, sourceBlockNumber: sent.blockNumber, moduleAuthorized: Boolean(moduleStake), safe: moduleStake?.safe || null, requestedAmount: moduleStake?.inputAmount || null, whypeSentAmount: sent.amountSentLD, whypeDestinationAmount: sent.amountReceivedLD, destinationReceivedAmount: received?.amountReceivedLD || null, destinationReceiveTransactionHash: received?.transactionHash || null, composeDelivered: Boolean(delivered), composeTransactionHash: delivered?.transactionHash || null, returnGuid: returnSend?.guid || null, returnBehypeSentAmount: returnSend?.amountSentLD || null, sourceBehypeReceivedAmount: sourceReturn?.amountReceivedLD || null, sourceRecipient: sourceReturn?.to || null, recipientMatchesModuleSafe: moduleStake && sourceReturn ? sameAddress(moduleStake.safe, sourceReturn.to) : moduleStake ? null : null, complete: Boolean(received && delivered && returnSend && sourceReturn) }; });
  const routeSourceGuidSet = new Set(routeRows.map((x) => x.sourceGuid)); const routeReturnGuidSet = new Set(routeRows.map((x) => x.returnGuid).filter(Boolean));
  const unmatchedDestination = destinationHistory.whypeReceived.filter((x) => !destinationHistory.composeDelivered.some((d) => d.guid === x.guid) || !routeRows.some((r) => r.sourceGuid === x.guid) && !(destReturnsByTx.get(destinationHistory.composeDelivered.find((d) => d.guid === x.guid)?.transactionHash || "") || []).length).map((x) => ({ guid: x.guid, srcEid: x.srcEid, amountReceivedLD: x.amountReceivedLD, blockNumber: x.blockNumber, transactionHash: x.transactionHash, composeDelivered: destinationHistory.composeDelivered.some((d) => d.guid === x.guid), alertCount: destinationHistory.composeAlerts.filter((a) => a.guid === x.guid).length }));

  const opReader = new Reader(opSelection.providers[opConsensusIndexes[0]]); const destReader = new Reader(destSelection.providers[destConsensusIndexes[0] ?? 0]);
  for (const row of unmatchedDestination) { const q = await destReader.call(ADDR.destinationEndpoint, ENDPOINT_IFACE, "composeQueue", [ADDR.destinationWhypeAdapter, ADDR.destinationReceiverProxy, row.guid, 0], destPin.blockNumber, `composeQueue.${row.guid}`); row.composeQueueHash = q.ok ? q.decoded[0].toLowerCase() : null; row.pendingComposeQueue = q.ok ? BigInt(q.decoded[0]) !== 0n : null; }

  async function tokenBalance(reader, token, account, block, label) { const x = await reader.call(token, ERC20_IFACE, "balanceOf", [account], block, label); return x.ok ? x.decoded[0].toString() : null; }
  async function allowance(reader, token, owner, spender, block, label) { const x = await reader.call(token, ERC20_IFACE, "allowance", [owner, spender], block, label); return x.ok ? x.decoded[0].toString() : null; }
  async function nativeBalance(reader, account, block, label) { const x = await reader.read("eth_getBalance", [account, toQuantity(block)], label); return x.ok ? BigInt(x.result).toString() : null; }
  const balances = {
    module: { nativeWei: await nativeBalance(opReader, ADDR.module, opPin.blockNumber, "balance.module.native"), whypeWei: await tokenBalance(opReader, ADDR.sourceWhype, ADDR.module, opPin.blockNumber, "balance.module.whype"), behypeWei: await tokenBalance(opReader, ADDR.sourceBehype, ADDR.module, opPin.blockNumber, "balance.module.behype") },
    l2Staker: { nativeWei: await nativeBalance(opReader, ADDR.l2StakerProxy, opPin.blockNumber, "balance.staker.native"), whypeWei: await tokenBalance(opReader, ADDR.sourceWhype, ADDR.l2StakerProxy, opPin.blockNumber, "balance.staker.whype"), behypeWei: await tokenBalance(opReader, ADDR.sourceBehype, ADDR.l2StakerProxy, opPin.blockNumber, "balance.staker.behype"), whypeAllowanceToWhypeOft: await allowance(opReader, ADDR.sourceWhype, ADDR.l2StakerProxy, ADDR.sourceWhype, opPin.blockNumber, "allowance.staker.whype") },
    destinationReceiver: { nativeWei: await nativeBalance(destReader, ADDR.destinationReceiverProxy, destPin.blockNumber, "balance.receiver.native"), whypeWei: await tokenBalance(destReader, ADDR.destinationWhype, ADDR.destinationReceiverProxy, destPin.blockNumber, "balance.receiver.whype"), behypeWei: await tokenBalance(destReader, ADDR.destinationBehype, ADDR.destinationReceiverProxy, destPin.blockNumber, "balance.receiver.behype"), behypeAllowanceToAdapter: await allowance(destReader, ADDR.destinationBehype, ADDR.destinationReceiverProxy, ADDR.destinationBehypeAdapter, destPin.blockNumber, "allowance.receiver.behype") },
  };

  const sourceWhypePeer = op.whypePeer; const destinationWhypePeer = dest.whypePeer; const destinationBehypePeer = dest.behypePeer; const sourceBehypePeer = op.behypePeer;
  const nonceReads = {
    sourceWhypeOutbound: await opReader.call(ADDR.sourceEndpoint, ENDPOINT_IFACE, "outboundNonce", [ADDR.sourceWhype, DEST_EID, sourceWhypePeer], opPin.blockNumber, "nonce.sourceWhypeOutbound"),
    destinationWhypeInbound: await destReader.call(ADDR.destinationEndpoint, ENDPOINT_IFACE, "inboundNonce", [ADDR.destinationWhypeAdapter, OP_EID, destinationWhypePeer], destPin.blockNumber, "nonce.destinationWhypeInbound"),
    destinationWhypeLazyInbound: await destReader.call(ADDR.destinationEndpoint, ENDPOINT_IFACE, "lazyInboundNonce", [ADDR.destinationWhypeAdapter, OP_EID, destinationWhypePeer], destPin.blockNumber, "nonce.destinationWhypeLazy"),
    destinationBehypeOutbound: await destReader.call(ADDR.destinationEndpoint, ENDPOINT_IFACE, "outboundNonce", [ADDR.destinationBehypeAdapter, OP_EID, destinationBehypePeer], destPin.blockNumber, "nonce.destinationBehypeOutbound"),
    sourceBehypeInbound: await opReader.call(ADDR.sourceEndpoint, ENDPOINT_IFACE, "inboundNonce", [ADDR.sourceBehype, DEST_EID, sourceBehypePeer], opPin.blockNumber, "nonce.sourceBehypeInbound"),
    sourceBehypeLazyInbound: await opReader.call(ADDR.sourceEndpoint, ENDPOINT_IFACE, "lazyInboundNonce", [ADDR.sourceBehype, DEST_EID, sourceBehypePeer], opPin.blockNumber, "nonce.sourceBehypeLazy"),
  };
  const nonces = Object.fromEntries(Object.entries(nonceReads).map(([k, v]) => [k, v.ok ? Number(v.decoded[0]) : null]));
  const lzConfigs = {
    sourceWhypeSend: await lzConfig(opReader, ADDR.sourceEndpoint, ADDR.sourceWhype, DEST_EID, true, opPin.blockNumber, "config.sourceWhypeSend"),
    destinationWhypeReceive: await lzConfig(destReader, ADDR.destinationEndpoint, ADDR.destinationWhypeAdapter, OP_EID, false, destPin.blockNumber, "config.destinationWhypeReceive"),
    destinationBehypeSend: await lzConfig(destReader, ADDR.destinationEndpoint, ADDR.destinationBehypeAdapter, OP_EID, true, destPin.blockNumber, "config.destinationBehypeSend"),
    sourceBehypeReceive: await lzConfig(opReader, ADDR.sourceEndpoint, ADDR.sourceBehype, DEST_EID, false, opPin.blockNumber, "config.sourceBehypeReceive"),
  };

  const sampleAmount = 1_000_000_000_000n; const quoteReceiver = "0x000000000000000000000000000000000000dEaD";
  const sourceQuoteR = await opReader.call(ADDR.l2StakerProxy, STAKER_IFACE, "quoteStake", [sampleAmount, quoteReceiver], opPin.blockNumber, "quote.sourceStake");
  const returnParam = [OP_EID, zeroPadValue(quoteReceiver, 32), sampleAmount, sampleAmount, "0x", "0x", "0x"];
  const destinationQuoteR = await destReader.call(ADDR.destinationBehypeAdapter, OFT_IFACE, "quoteSend", [returnParam, false], destPin.blockNumber, "quote.destinationReturn");
  const currentQuote = { sampleAmountWei: sampleAmount.toString(), sourceNativeFeeWei: sourceQuoteR.ok ? sourceQuoteR.decoded[0].toString() : null, destinationReturnNativeFeeWei: destinationQuoteR.ok ? destinationQuoteR.decoded[0].nativeFee.toString() : null, destinationReturnLzTokenFeeWei: destinationQuoteR.ok ? destinationQuoteR.decoded[0].lzTokenFee.toString() : null, quoteOnlyNoStakeOrSend: true };

  const l2OwnerAuthority = await authority(opReader, op.staker.owner, opPin.blockNumber, "authority.l2Owner"); const destinationOwnerAuthority = await authority(destReader, dest.receiver.owner, destPin.blockNumber, "authority.destinationOwner");

  const metaSummaries = [];
  for (const row of EXPLORER_REQUESTS) metaSummaries.push(sourceSummary(row.key, sources.metas[row.key], row.chainId, row.address));
  if (sources.metas.sourceBehypeImplementation) { const implAddress = sources.metas.sourceBehype.implementations?.[0]?.address_hash || sources.metas.sourceBehype.implementations?.[0]?.address; metaSummaries.push(sourceSummary("sourceBehypeImplementation", sources.metas.sourceBehypeImplementation, OP_CHAIN, implAddress)); }
  const metaByKey = Object.fromEntries(metaSummaries.map((x) => [x.key, x]));
  const runtimeReads = {};
  for (const row of EXPLORER_REQUESTS) { const reader = row.chainId === OP_CHAIN ? opReader : destReader; const block = row.chainId === OP_CHAIN ? opPin.blockNumber : destPin.blockNumber; const code = await reader.read("eth_getCode", [row.address, toQuantity(block)], `sourceRuntime.${row.key}`); runtimeReads[row.key] = code.ok ? code.result : null; const summary = metaByKey[row.key]; summary.onchainRuntimeKeccak256 = code.ok ? keccak256(code.result) : null; summary.explorerRuntimeExact = code.ok && summary.deployedBytecodeKeccak256 === summary.onchainRuntimeKeccak256; }
  const compiler = ensureSolc824();
  const builds = [
    compileVerified(sources.metas.l2Proxy, compiler.solc, runtimeReads.l2Proxy, {}, "L2 staker proxy"),
    compileVerified(sources.metas.l2Implementation, compiler.solc, runtimeReads.l2Implementation, { endpoint: ADDR.sourceEndpoint, __self: ADDR.l2StakerImplementation }, "L2 staker implementation"),
    compileVerified(sources.metas.destinationProxy, compiler.solc, runtimeReads.destinationProxy, {}, "destination receiver proxy"),
    compileVerified(sources.metas.destinationImplementation, compiler.solc, runtimeReads.destinationImplementation, { endpoint: ADDR.destinationEndpoint, __self: ADDR.destinationReceiverImplementation }, "destination receiver implementation"),
  ];
  if (!builds.every((x) => x.exactRuntime)) throw new Error("exact source build/runtime mismatch");

  const l2Source = sources.metas.l2Implementation.source_code; const destinationSource = sources.metas.destinationImplementation.source_code;
  const sourceSemantics = {
    l2: {
      publicStakeNoCallerAllowlist: /function\s+stake\([^)]*\)\s+external\s+payable/.test(l2Source) && !/function\s+stake\([^)]*\)[^{]*(?:onlyOwner|onlyRole|onlyAuthorized)/.test(l2Source),
      dustSilentlyRemoved: l2Source.includes("_removeDust") && l2Source.includes("1e12"),
      fixedDestinationEid: l2Source.includes("HYPEREVM_EID = 30367"),
      receiverInComposeMessage: l2Source.includes("abi.encode(receiver)"),
      whypeTransferFromCaller: l2Source.includes("transferFrom(msg.sender, address(this), params.WHYPEWithoutDust)"),
      sourceWhypeRefundRecipientCaller: l2Source.includes("params.oftFee, msg.sender"),
      noExplicitExcessRefundOrSweep: !/function\s+(?:sweep|rescue|recover|refund)/.test(l2Source),
      ownerOnlyUpgrade: /_authorizeUpgrade\(address\)\s+internal\s+override\s+onlyOwner/.test(l2Source),
    },
    destination: {
      endpointAndWhypeAdapterComposeGuards: destinationSource.includes("OnlyEndpoint") && destinationSource.includes("OnlyWHYPEOFTAdapter") && destinationSource.includes("msg.sender") && destinationSource.includes("WHYPE_OFT_ADAPTER"),
      decodedReceiverBoundOutbound: destinationSource.includes("address receiver = abi.decode") && destinationSource.includes("uint160(receiver)"),
      entireBehypeBalanceNotDelta: destinationSource.includes("BEHYPE.balanceOf(address(this))") && !/balanceBefore|beforeBalance/.test(destinationSource),
      nativeFeePaidFromReceiverBalance: destinationSource.includes("send{value: fee.nativeFee}"),
      outboundRefundRecipientSelf: destinationSource.includes("fee, address(this)"),
      ownerOnlyBehypeSweep: /function\s+sweepDust\(\)\s+external\s+onlyOwner/.test(destinationSource) && destinationSource.includes("safeTransfer(owner()"),
      emptyLzReceive: /function\s+_lzReceive[\s\S]*?\{\s*\}/.test(destinationSource),
      noNativeSweepOrRefund: !/safeTransferETH|sendValue|function\s+(?:sweepNative|rescueNative|refund)/.test(destinationSource),
      ownerOnlyUpgrade: /_authorizeUpgrade\(address\)\s+internal\s+override\s+onlyOwner/.test(destinationSource),
    },
  };
  if (Object.values(sourceSemantics.l2).some((x) => x !== true) || Object.values(sourceSemantics.destination).some((x) => x !== true)) throw new Error(`source semantics incomplete ${JSON.stringify(sourceSemantics)}`);

  const requestedSum = sourceHistory.moduleStakes.reduce((n, x) => n + BigInt(x.inputAmount), 0n); const whypeSentSum = sourceHistory.sourceWhypeSent.reduce((n, x) => n + BigInt(x.amountReceivedLD), 0n); const destinationReceivedSum = routeRows.reduce((n, x) => n + BigInt(x.destinationReceivedAmount || 0), 0n); const returnSentSum = routeRows.reduce((n, x) => n + BigInt(x.returnBehypeSentAmount || 0), 0n); const sourceReturnSum = routeRows.reduce((n, x) => n + BigInt(x.sourceBehypeReceivedAmount || 0), 0n);
  const moduleJoined = routeRows.filter((x) => x.moduleAuthorized).length; const directCalls = routeRows.length - moduleJoined; const completeRoundTrips = routeRows.filter((x) => x.complete).length; const safeRecipientMismatch = routeRows.filter((x) => x.moduleAuthorized && x.recipientMatchesModuleSafe === false).length;
  const sourceUnmatched = routeRows.filter((x) => !x.destinationReceivedAmount).length; const returnUnmatched = routeRows.filter((x) => x.returnGuid && !x.sourceBehypeReceivedAmount).length + routeRows.filter((x) => !x.returnGuid).length;
  const destinationUnmatchedCount = destinationHistory.whypeReceived.length - destinationHistory.behypeSent.length;
  const directHistoryObserved = directCalls > 0;

  const exactCurrentBindings = op.module.isDefault === true && op.module.isWhitelisted === true && sameAddress(op.module.staker, ADDR.l2StakerProxy) && sameAddress(op.staker.implementation, ADDR.l2StakerImplementation) && sameAddress(op.staker.endpoint, ADDR.sourceEndpoint) && bytes32Address(op.staker.peer) && sameAddress(bytes32Address(op.staker.peer), ADDR.destinationReceiverProxy) && sameAddress(dest.receiver.implementation, ADDR.destinationReceiverImplementation) && sameAddress(dest.receiver.endpoint, ADDR.destinationEndpoint) && builds.every((x) => x.exactRuntime);
  const destinationStateConsensusCount = destConsensusIndexes.length;
  const destinationMultiProviderConsensus = destinationStateConsensusCount >= 2 && destHistoryConsensusCount >= 2;
  const destinationSingleProvider = !destinationMultiProviderConsensus;
  const coverageRepaired = opPinVerified && destinationMultiProviderConsensus;
  const classificationParts = ["INCOMPLETE", "WATCH", "EXACT-STAKER-RECEIVER-BINDING"];
  if (coverageRepaired) classificationParts.push("PROVIDER-COVERAGE-REPAIRED", "NO-PROFIT");
  else {
    classificationParts.push("ACCESS-COVERAGE_OPEN");
    if (!opPinVerified) classificationParts.push("OPTIMISM-TERMINAL-RECHECK-GAPPED");
    if (destinationSingleProvider) classificationParts.push("DESTINATION-SINGLE-PROVIDER");
  }
  const classification = classificationParts.join("/");
  const category = "exact-staker-receiver-local-build-with-adapter-runtime-and-provider-coverage-gaps";
  const runId = `etherfi-behype-staker-layerzero-r2-${opPin.blockNumber}-${opPin.blockHash.slice(2, 14)}-${scannerSha256.slice(0, 12)}`;
  const findings = {
    exactCurrentBindings,
    permissionlessDirectStakerCallsObserved: directHistoryObserved,
    directPublicStakerCallCount: directCalls,
    destinationFeeSubsidyPermissionlessReachable: sourceSemantics.l2.publicStakeNoCallerAllowlist && sourceSemantics.destination.nativeFeePaidFromReceiverBalance && BigInt(balances.destinationReceiver.nativeWei || 0) > 0n,
    directNativePayoutToCallerFound: false,
    publicWholeBalanceDeliveryCanIncludePriorBehypeResidue: sourceSemantics.destination.entireBehypeBalanceNotDelta,
    currentBehypeResidueWei: balances.destinationReceiver.behypeWei,
    publicArbitraryRecipientRequiresValidWhypeOftCompose: true,
    permissionlessArbitrarySweepFound: false,
    ownerOnlyExplicitBehypeSweep: true,
    ownerOnlyUupsUpgrade: true,
    sourceRouteNonceAligned: nonces.sourceWhypeOutbound === nonces.destinationWhypeInbound && nonces.destinationBehypeOutbound === nonces.sourceBehypeInbound,
    currentCompleteProfitableRouteEstablished: false,
    unmatchedDestinationComposeClassification: "unresolved/pending-or-failed-observation",
    unmatchedDestinationComposeTreatedAsOrdinaryOperationalState: false,
    permissionlessProtocolLossEstablished: false,
    fullRouteLocalExactBuildRuntimeBound: false,
    destinationDeliveryFinalityProven: false,
    routePositive: 0,
  };
  const blockers = [
    destinationMultiProviderConsensus ? `HyperEVM state and retained event history matched across ${destinationStateConsensusCount}/${destHistoryConsensusCount} independent providers; this is provider agreement on event evidence, not LayerZero delivery-finality proof.` : "ACCESS/COVERAGE_OPEN: HyperEVM destination state and retained destination event history remain single-provider observations because a second independent authorized provider was not available; no multi-provider destination consensus or delivery-finality proof is claimed.",
    opPinVerified ? "Optimism terminal same-number hash recheck met the two-provider threshold." : `Three archive-capable providers agreed on the selected finalized Optimism pin, but only ${opTerminalMatchCount} returned the same-number terminal header during the bounded final recheck; terminal threshold coverage is GAPPED and fail-closed.`,
    `Destination-wide event evidence contains ${destinationUnmatchedCount} more WHYPE receives than beHYPE return sends and ${destinationHistory.composeAlerts.length} compose alerts; the unmatched compose row is an unresolved/pending-or-failed observation, not an ordinary operational state or exploit evidence.`,
    "The public L2 staker lets a caller supply its own WHYPE and source fee while the destination receiver pays the return native fee from its prefunded balance; exact direct native payout or current profitable end-to-end economics is not established.",
    "Destination lzCompose sends the whole rounded beHYPE balance rather than a per-call delta, so a valid compose receiver can include prior residue; current residue is sub-1e12 dust and material profitable extraction is not established.",
    "Only the L2 staker and destination receiver proxy/implementation pairs have local exact 0.8.24 build/runtime evidence. Source/destination WHYPE and beHYPE adapters are explorer/runtime-bound without equal local rebuild; full adapter dependency audits remain outside scope.",
    "History begins at consensus code boundary for the L2 staker proxy and the observed destination receiver proxy boundary; it does not establish history before those address incarnations or activity on other source chains.",
    "No stake, send, message, retry, compose, sweep, claim, fork or signed action was executed.",
  ];
  const nextAction = coverageRepaired
    ? "Under a separate read-only claim, resolve the unmatched destination compose row before any economics; do not retry, compose, stake, send or sweep."
    : "Provision responsive independent authorized Optimism and HyperEVM read-only coverage, then perform one fixed-pin coverage-only rerun; do not proceed to economics or invoke stake/send/compose/retry/sweep.";

  const result = {
    schemaVersion: 1, revision: REVISION, runId, generatedAt, scanner: SCANNER, agentId: AGENT, role: "critical-research", step: 4,
    classification, category, signal: coverageRepaired ? "🟠 WATCH — STAKER/RECEIVER EXACT; PROVIDER COVERAGE REPAIRED; UNRESOLVED COMPOSE; NO PROFIT" : "🟠 WATCH — STAKER/RECEIVER EXACT; ACCESS/COVERAGE_OPEN; NO PROFIT",
    routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false,
    safety: { readOnlyRpc: true, endpointInventoryRead: true, endpointValuesPersisted: false, publicSourceMetadataRead: true, publicSourceValuesPersistedOnlyAsHashesAndSemantics: true, graphqlInventoryRead: false, envFilesRead: false, privateKeysRead: false, ethSendMethodsUsed: false, signingUsed: false, impersonationUsed: false, forkCreated: false, stakeCalled: false, messageSent: false, retryCalled: false, claimCalled: false, fundsUsed: false, stateMutation: false },
    pin: { ...opPin, verified: opPinConsensusVerified, terminalSameNumberHashVerified: opPinVerified, terminalSameNumberHashMatchCount: opTerminalMatchCount, terminalSameNumberHashThreshold: 2 }, destinationPin: { ...destPin, verified: destPinVerified, terminalSameNumberHashVerified: destTerminalRepair.matchCount >= 1, terminalSameNumberHashMatchCount: destTerminalRepair.matchCount, terminalSameNumberHashThreshold: 1, multiProviderConsensus: destinationMultiProviderConsensus },
    addresses: ADDR,
    captureProvenance: { scannerSha256, predecessorStep1RunId: step1.runId, predecessorStep3RunId: step3.runId, predecessorStep1Sha256: hashFile(STEP1).sha256, predecessorStep3Sha256: hashFile(STEP3).sha256 },
    providerCoverage: { repairAttempt: { bounded: true, attemptCount: 1, economicsAttempted: false }, optimism: { inventoryCount: opSelection.inventoryCount, endpointsTried: opSelection.endpointsTried, probeCalls: opSelection.calls, finalizedConsensusCount: opSelection.providers.length, selectedOrdinals: opSelection.providers.map((x) => x.ordinal), stateConsensusCount: opConsensusIndexes.length, stateConsensusOrdinals: opConsensusIndexes.map((i) => opSelection.providers[i].ordinal), stateDigest: opBest[0], stateDigestVariants: opGroups.size, terminalRecheck: opTerminalRepair, rejectionCounts: opSelection.rejected, archiveHistoryConsensusCount: 2, endpointValuesPersisted: false }, destination: { inventoryCount: destSelection.inventoryCount, endpointsTried: destSelection.endpointsTried, probeCalls: destSelection.calls, stateProviderCount: destSelection.providers.length, stateConsensusCount: destinationStateConsensusCount, stateConsensusOrdinals: destConsensusIndexes.map((i) => destSelection.providers[i].ordinal), stateDigest: destBest?.[0] || null, stateDigestVariants: destGroups.size, selectedOrdinals: destSelection.providers.map((x) => x.ordinal), terminalRecheck: destTerminalRepair, historyConsensusCount: destHistoryConsensusCount, multiProviderConsensus: destinationMultiProviderConsensus, rejectionCounts: destSelection.rejected, endpointValuesPersisted: false } },
    sourceEvidence: { publicMetadataRequestCount: sources.requestCount, endpointOrDomainPersisted: false, contracts: metaSummaries },
    sourceBuilds: { compiler: compiler.provenance, contracts: builds },
    evidenceScope: {
      localExactBuildRuntime: ["l2-staker-proxy", "l2-staker-implementation", "destination-receiver-proxy", "destination-receiver-implementation"],
      explorerRuntimeBoundWithoutEqualLocalRebuild: ["source-WHYPE-adapter", "source-beHYPE-adapter", "destination-WHYPE-adapter", "destination-beHYPE-adapter"],
      fullRouteLocalExactBuildRuntimeBound: false,
      destinationRouteHistoryEventProviderCount: destHistoryConsensusCount,
      destinationDeliveryFinalityProven: false,
    },
    sourceSemantics,
    currentBindings: {
      module: { address: ADDR.module, isDefault: op.module.isDefault, isWhitelisted: op.module.isWhitelisted, returnedDefault: op.defaults.some((x) => sameAddress(x, ADDR.module)), returnedWhitelisted: op.whitelist.some((x) => sameAddress(x, ADDR.module)), staker: op.module.staker, whype: op.module.whype, behype: op.module.behype, refundGasLimit: op.module.refundGasLimit, priorStep1StakerEqual: sameAddress(priorModule.immutableValues.staker, op.module.staker) },
      l2Staker: { address: ADDR.l2StakerProxy, structure: { proxyType: "EIP-1967/UUPS", implementation: op.staker.implementation, admin: op.staker.admin, beacon: op.staker.beacon, clone: false }, implementation: op.staker.implementation, proxyRuntimeKeccak256: op.staker.proxyRuntimeKeccak256, implementationRuntimeKeccak256: op.staker.implementationRuntimeKeccak256, owner: op.staker.owner, ownerAuthority: l2OwnerAuthority, delegate: op.staker.delegate, endpoint: op.staker.endpoint, peer: bytes32Address(op.staker.peer), peerBytes32: op.staker.peer, destinationEid: DEST_EID, enforceOptions: op.staker.enforceOptions, lzReceiveGasLimit: op.staker.lzReceiveGasLimit, ownerOnlyUpgrade: sourceSemantics.l2.ownerOnlyUpgrade, sourceRuntimeExact: builds[0].exactRuntime && builds[1].exactRuntime },
      destinationReceiver: { address: ADDR.destinationReceiverProxy, structure: { proxyType: "EIP-1967/UUPS", implementation: dest.receiver.implementation, admin: dest.receiver.admin, beacon: dest.receiver.beacon, clone: false }, implementation: dest.receiver.implementation, proxyRuntimeKeccak256: dest.receiver.proxyRuntimeKeccak256, implementationRuntimeKeccak256: dest.receiver.implementationRuntimeKeccak256, owner: dest.receiver.owner, ownerAuthority: destinationOwnerAuthority, delegate: dest.receiver.delegate, endpoint: dest.receiver.endpoint, sourceRuntimeExact: builds[2].exactRuntime && builds[3].exactRuntime, ownerOnlyUpgrade: sourceSemantics.destination.ownerOnlyUpgrade },
      peers: { l2StakerToDestinationReceiver: { eid: DEST_EID, local: ADDR.l2StakerProxy, peer: bytes32Address(op.staker.peer), reciprocalOappPeerNotRequiredForComposeReceiver: true }, sourceWhypeToDestinationWhype: { eid: DEST_EID, local: ADDR.sourceWhype, peer: bytes32Address(sourceWhypePeer) }, destinationWhypeToSourceWhype: { eid: OP_EID, local: ADDR.destinationWhypeAdapter, peer: bytes32Address(destinationWhypePeer) }, destinationBehypeToSourceBehype: { eid: OP_EID, local: ADDR.destinationBehypeAdapter, peer: bytes32Address(destinationBehypePeer) }, sourceBehypeToDestinationBehype: { eid: DEST_EID, local: ADDR.sourceBehype, peer: bytes32Address(sourceBehypePeer) } },
    },
    flow: {
      source: { permissionlessStakerEntrypoint: sourceSemantics.l2.publicStakeNoCallerAllowlist, whype: ADDR.sourceWhype, destinationEid: DEST_EID, destinationWhypeAdapter: ADDR.destinationWhypeAdapter, destinationComposeReceiver: ADDR.destinationReceiverProxy, amountWithoutDustExpression: "(hypeAmountIn / 1e12) * 1e12", receiverFixedToSafeComposeMessage: true, options: { lzReceiveGas: op.staker.lzReceiveGasLimit, lzComposeGas: op.staker.enforceOptions, composeIndex: 0, receiveValue: "0", composeValue: "0" }, tokenFlow: "transferFrom caller to L2 staker; source WHYPE OFT send/burn", nativeFlow: "caller supplies source quote; source WHYPE send receives exact quote in Cash-module path", sourceWhypeRefundRecipient: "immediate L2 staker caller (Safe in module path)", explicitL2ExcessRefund: false },
      destination: { sourceEid: OP_EID, endpointCallerRequired: true, whypeAdapterFromRequired: ADDR.destinationWhypeAdapter, composeDecodesReceiver: true, whypeWithdrawAmount: "OFT compose amountLD", stakingCore: ADDR.stakingCore, nativeStakeValue: "compose amountLD", wholeBeHypeBalanceUsedNotDelta: true, dustConversionRate: "1000000000000", outboundBehypeAdapter: ADDR.destinationBehypeAdapter, outboundRecipient: "decoded source compose receiver", outboundEid: "OFT compose srcEid", outboundOptions: "empty", nativeFeePaidFromReceiverBalance: true, outboundRefundRecipient: ADDR.destinationReceiverProxy, lzComposeMsgValueValidatedOrRefunded: false, explicitBehypeSweep: { function: "sweepDust", access: "onlyOwner", recipient: dest.receiver.owner }, nativeSweepPresent: false, retryStateOwnedBy: "LayerZero endpoint composeQueue; receiver stores none" },
    },
    layerZero: { endpointIdentities: { source: ADDR.sourceEndpoint, destination: ADDR.destinationEndpoint }, configs: lzConfigs, nonces, nonceAlignment: { sourceWhypeToDestination: nonces.sourceWhypeOutbound === nonces.destinationWhypeInbound, destinationBehypeToSource: nonces.destinationBehypeOutbound === nonces.sourceBehypeInbound, destinationWhypeExecutedThroughLazy: nonces.destinationWhypeInbound === nonces.destinationWhypeLazyInbound, sourceBehypeExecutedThroughLazy: nonces.sourceBehypeInbound === nonces.sourceBehypeLazyInbound } },
    history: {
      optimism: { complete: opHistoryComplete, startBlock: opHistoryStart, endBlock: opPin.blockNumber, boundaryConsensus: opBoundaryConsensus, boundaries: opBoundaries, consensusCount: 2, digest: opScans[0].digest, providerScans: opScans.map((x, i) => ({ ordinal: opHistoryProviders[i].ordinal, complete: x.complete, rangeCount: x.ranges.length, logCount: x.logs.length, calls: x.calls, digest: x.digest })) },
      destination: { complete: destScan.complete, startBlock: destHistoryStart, endBlock: destPin.blockNumber, boundary: destBoundary, boundaries: destBoundaries, boundaryConsensus: destBoundaryConsensus, providerCount: destHistoryConsensusCount, multiProviderConsensus: destinationMultiProviderConsensus, digest: destScan.digest, rangeCount: destScan.ranges.length, rawRelevantAddressEventCount: destScan.logs.length, providerScans: destScans.map((x, i) => ({ ordinal: destHistoryProviders[i].ordinal, complete: x.complete, rangeCount: x.ranges.length, logCount: x.logs.length, calls: x.calls, digest: x.digest })), evidenceQualification: destinationMultiProviderConsensus ? "independent-provider event agreement; not delivery-finality proof" : "single-provider event evidence; not delivery-finality proof" },
      route: { moduleStakeEvents: sourceHistory.moduleStakes.length, sourceWhypeSent: sourceHistory.sourceWhypeSent.length, moduleStakeJoined: moduleJoined, directPublicStakerCalls: directCalls, destinationWhypeReceivedJoined: routeRows.filter((x) => x.destinationReceivedAmount).length, composeDeliveredJoined: routeRows.filter((x) => x.composeDelivered).length, destinationBehypeReturnSentJoined: routeRows.filter((x) => x.returnGuid).length, sourceBehypeReceivedJoined: routeRows.filter((x) => x.sourceBehypeReceivedAmount).length, completeRoundTrips, sourceWhypeUnmatched: sourceUnmatched, returnBehypeUnmatched: returnUnmatched, moduleSafeRecipientMismatch: safeRecipientMismatch, requestedModuleWhypeSum: requestedSum.toString(), sourceWhypeSentSum: whypeSentSum.toString(), destinationWhypeReceivedJoinedSum: destinationReceivedSum.toString(), destinationBehypeReturnSentJoinedSum: returnSentSum.toString(), sourceBehypeReceivedJoinedSum: sourceReturnSum.toString(), exactWhypeCrossChainConservation: whypeSentSum === destinationReceivedSum, exactBehypeCrossChainConservation: returnSentSum === sourceReturnSum, routeRowsSha256: sha(canonical(routeRows)), directRows: routeRows.filter((x) => !x.moduleAuthorized), sampleFirst: routeRows[0] || null, sampleLast: routeRows.at(-1) || null },
      destinationAllSources: { received: destinationHistory.whypeReceived.length, composeDelivered: destinationHistory.composeDelivered.length, composeAlerts: destinationHistory.composeAlerts.length, returnSent: destinationHistory.behypeSent.length, unmatchedMessages: destinationUnmatchedCount, unmatchedRows: unmatchedDestination, unmatchedClassification: "unresolved/pending-or-failed-observation", note: destinationMultiProviderConsensus ? "Independent-provider event agreement from the current observed receiver proxy boundary; not global LayerZero history or delivery-finality proof." : "Single-provider event evidence from the current observed receiver proxy boundary; not global LayerZero history or delivery-finality proof." },
    },
    balances, currentQuote,
    publicValuePaths: { permissionlessL2Stake: true, callerMustSupplyOwnWhypeAndSourceFee: true, destinationReceiverPaysReturnFee: true, destinationNativeBalanceWei: balances.destinationReceiver.nativeWei, currentSampleReturnFeeWei: currentQuote.destinationReturnNativeFeeWei, currentSampleSourceFeeWei: currentQuote.sourceNativeFeeWei, wholeBalanceBehypeDeliveryIncludesPriorResidue: true, currentPriorBehypeResidueWei: balances.destinationReceiver.behypeWei, explicitSweepDustOwnerOnly: true, nativeSweepAbsent: true, endpointComposeRetryPermissionlessButQueueAndMessageHashBound: true, arbitraryCallerDirectNativeTransfer: false, exactCurrentProfitAfterCrossChainFeesAndAssetConversion: null },
    findings, blockers, nextReadOnlyStep: nextAction,
    transcripts: { optimism: op.transcript.concat(opReader.transcript), destination: dest.transcript.concat(destReader.transcript), endpointValuesPersisted: false },
  };
  writeOwned(RAW, JSON.stringify(result, null, 2) + "\n");

  const reportR2 = [
    `# ${result.signal} — EtherFi BeHYPE staker/LayerZero Step 4 reviewer r2`,
    "",
    `**Revision:** \`${REVISION}\`  `,
    `**Classification:** \`${classification}\`  `,
    `**Run:** \`${runId}\`  `,
    `**Optimism pin:** \`${opPin.blockNumber}\` / \`${opPin.blockHash}\` (${opSelection.providers.length} Optimism finalized-pin providers; ${opConsensusIndexes.length} matching retained state providers; terminal same-number recheck ${opPinVerified ? `PASS ${opTerminalMatchCount}/2 threshold met` : `GAPPED ${opTerminalMatchCount}/2 threshold unmet`})  `,
    `**Destination pin:** HyperEVM \`${destPin.blockNumber}\` / \`${destPin.blockHash}\` (${destinationStateConsensusCount} matching state provider(s); ${destHistoryConsensusCount} matching retained-history provider(s); ${destinationMultiProviderConsensus ? "independent-provider event agreement" : "single-provider event evidence"}; not delivery-finality proof)  `,
    "**Gates:** `routePositive=0`, `executableNow=0`, `signedActionJustified=false`, `fork=false`",
    "",
    "> Scope correction: only the L2 staker and destination receiver proxy/implementation pairs have local exact 0.8.24 build/runtime evidence. Source and destination WHYPE/beHYPE adapters are explorer/runtime-bound without equal local rebuild. Destination route/history joins are event evidence, not multi-provider LayerZero delivery-finality proof.",
    "",
    "## Provider-coverage repair result",
    "",
    `- One bounded sanitized read-only repair pass was attempted. Optimism retained ${opSelection.providers.length} finalized-pin providers and ${opConsensusIndexes.length} matching state providers. Terminal same-number recheck is ${opPinVerified ? `PASS ${opTerminalMatchCount}/2 threshold met` : `GAPPED ${opTerminalMatchCount}/2 threshold unmet`}.`,
    `- HyperEVM retained ${destinationStateConsensusCount} matching state provider(s) and ${destHistoryConsensusCount} matching event-history provider(s). Coverage is ${destinationMultiProviderConsensus ? "independently provider-matched, but still not delivery-finality proof" : "ACCESS/COVERAGE_OPEN and single-provider"}.`,
    "- Provider state digests are recorded in the raw artifact without endpoint values. No economics pass was attempted.",
    "",
    "## Exact local build/runtime scope",
    "",
    `- BeHYPE module \`${ADDR.module}\` remains default/whitelisted and its immutable staker remains \`${ADDR.l2StakerProxy}\`.`,
    `- L2 staker proxy/implementation \`${ADDR.l2StakerProxy}\` → \`${ADDR.l2StakerImplementation}\`: exact local build/runtime; owner-only UUPS authority ${l2OwnerAuthority.multisigLikeThreshold}/${l2OwnerAuthority.multisigLikeOwnerCount}.`,
    `- Destination receiver proxy/implementation \`${ADDR.destinationReceiverProxy}\` → \`${ADDR.destinationReceiverImplementation}\`: exact local build/runtime; owner-only UUPS authority ${destinationOwnerAuthority.multisigLikeThreshold}/${destinationOwnerAuthority.multisigLikeOwnerCount}.`,
    "- Source/destination WHYPE and beHYPE adapters: explorer/runtime-bound only; no equal local rebuild claim.",
    "",
    "## Event observations and value paths",
    "",
    `- Optimism source/module/direct/complete rows: \`${routeRows.length}/${moduleJoined}/${directCalls}/${completeRoundTrips}\`; the Optimism retained history digest matches across two providers.`,
    `- Destination receives/returns/compose alerts/unmatched: \`${destinationHistory.whypeReceived.length}/${destinationHistory.behypeSent.length}/${destinationHistory.composeAlerts.length}/${destinationUnmatchedCount}\`. These joins are ${destinationMultiProviderConsensus ? "independent-provider event agreement" : "single-provider event evidence"}, not delivery-finality proof.`,
    "- The unmatched destination compose row is an **unresolved/pending-or-failed observation**, not an ordinary operational state and not exploit evidence.",
    "- The L2 staker is public. The caller supplies WHYPE and the source fee; the destination receiver funds the return native fee.",
    "- Destination delivery uses the whole rounded beHYPE balance, so prior residue can be included. Current residue remains below one 1e12 rounding unit.",
    "- Explicit beHYPE sweep is owner-only. LayerZero queue retry is permissionless but queue/message-hash bound. No direct native caller payout or arbitrary public sweep was found.",
    "",
    "## Defensive conclusion",
    "",
    `- ${blockers.join("\n- ")}`,
    "- No exploit, loss, or profit claim is made. No stake, send, compose, retry, sweep, fork, signing, or mutation occurred.",
    "",
    `**nextReadOnlyStep:** ${nextAction}`,
  ].join("\n") + "\n";

  writeOwned(REPORT, reportR2);
  const inbox = { findingId: NAME, revision: REVISION, runId, agentId: AGENT, role: "critical-research", status: classification, classification, category, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, summary: "L2 staker and destination receiver have local exact build/runtime evidence; adapters have narrower explorer/runtime binding. One bounded provider repair pass was attempted; no exploit or profit is claimed.", pin: result.pin, destinationPin: result.destinationPin, providerCoverage: result.providerCoverage, evidenceScope: result.evidenceScope, counts: { sourceSends: routeRows.length, moduleJoined, directCalls, completeRoundTrips, destinationReceived: destinationHistory.whypeReceived.length, destinationReturns: destinationHistory.behypeSent.length, destinationUnmatched: destinationUnmatchedCount, composeAlerts: destinationHistory.composeAlerts.length }, balances, currentQuote, findings, blockers, artifacts: [SCANNER, VALIDATOR, RAW, MANIFEST, REPORT, INBOX, HANDOFF], nextAction };
  writeOwned(INBOX, JSON.stringify(inbox, null, 2) + "\n");
  const handoffR2 = [
    "# EtherFi BeHYPE staker/LayerZero Step 4 reviewer-r2 handoff",
    "",
    `- Run \`${runId}\`; revision \`${REVISION}\`; classification \`${classification}\`.`,
    `- Fresh finalized Optimism \`${opPin.blockNumber}\` / \`${opPin.blockHash}\`; ${opSelection.providers.length} Optimism finalized-pin providers, ${opConsensusIndexes.length} matching retained state providers, terminal same-number recheck ${opPinVerified ? `PASS ${opTerminalMatchCount}/2 threshold met` : `GAPPED ${opTerminalMatchCount}/2 threshold unmet`}.`,
    `- HyperEVM \`${destPin.blockNumber}\` / \`${destPin.blockHash}\`; ${destinationStateConsensusCount} matching state provider(s), ${destHistoryConsensusCount} matching retained-history provider(s); ${destinationMultiProviderConsensus ? "independent-provider event agreement" : "single-provider event evidence and ACCESS/COVERAGE_OPEN"}; not delivery-finality proof.`,
    "- Local exact build/runtime evidence is limited to the L2 staker and destination receiver proxy/implementation pairs. Source/destination WHYPE and beHYPE adapters are explorer/runtime-bound without equal local rebuild.",
    `- Optimism source/module/direct/complete event joins: \`${routeRows.length}/${moduleJoined}/${directCalls}/${completeRoundTrips}\`. Destination received/return/alerts/unmatched: \`${destinationHistory.whypeReceived.length}/${destinationHistory.behypeSent.length}/${destinationHistory.composeAlerts.length}/${destinationUnmatchedCount}\`.`,
    "- Destination route/history joins are event evidence, not multi-provider LayerZero delivery-finality proof. The unmatched compose row is an unresolved/pending-or-failed observation, not an ordinary operational state.",
    `- Destination receiver native/beHYPE: \`${balances.destinationReceiver.nativeWei}/${balances.destinationReceiver.behypeWei}\` wei. Public staker callers supply WHYPE/source fee while the receiver funds return fees; whole-rounded-balance residue inclusion is observed.`,
    "- Explicit beHYPE sweep is owner-only; queue retry is permissionless but queue/message-hash bound. No exploit, direct native caller payout, arbitrary sweep, or profit is established.",
    "- Gates `0/0/false`; `fork=false`; no stake/send/compose/retry/sweep/fork/signing/mutation and no economics pass.",
    `- Next: ${nextAction}`,
  ].join("\n") + "\n";
  writeOwned(HANDOFF, handoffR2);
  const records = [SCANNER, VALIDATOR, RAW, REPORT, INBOX, HANDOFF, STEP1, STEP3].map(hashFile); const aggregateSha256 = sha(records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n"));
  const manifest = { schemaVersion: 1, revision: REVISION, runId, generatedAt, algorithm: "sha256", classification, category, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, pin: result.pin, destinationPin: result.destinationPin, optimismFinalizedConsensusCount: opSelection.providers.length, optimismStateConsensusCount: opConsensusIndexes.length, optimismTerminalSameNumberHashVerified: opPinVerified, optimismTerminalMatchCount: opTerminalMatchCount, optimismTerminalThreshold: 2, optimismTerminalThresholdMet: opPinVerified, optimismHistoryComplete: opHistoryComplete, optimismHistoryConsensusCount: 2, destinationStateConsensusCount, destinationHistoryConsensusCount: destHistoryConsensusCount, destinationMultiProviderConsensus, localExactBuildRuntimeScope: result.evidenceScope.localExactBuildRuntime, adapterExplorerRuntimeBoundWithoutEqualLocalRebuild: true, fullRouteLocalExactBuildRuntimeBound: false, destinationDeliveryFinalityProven: false, completeRoundTrips, directPublicStakerCalls: directCalls, destinationUnmatchedCount, destinationUnmatchedClassification: "unresolved/pending-or-failed-observation", currentProfitableRouteEstablished: false, records, aggregateSha256 };
  writeOwned(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ runId, classification, pin: result.pin, destinationPin: result.destinationPin, identities: result.currentBindings, config: result.layerZero, history: result.history, balances, currentQuote, findings, blockers, artifacts: [SCANNER, VALIDATOR, RAW, MANIFEST, REPORT, INBOX, HANDOFF], gates: { routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false }, manifestAggregateSha256: aggregateSha256, nextReadOnlyStep: nextAction }) + "\n");
}

function packageAccessOpenFromR1() {
  const generatedAt = new Date().toISOString(); const scannerSha256 = hashFile(SCANNER).sha256;
  const prior = JSON.parse(fs.readFileSync(abs(RAW), "utf8"));
  if (prior.revision !== "behype-staker-layerzero-binding-step4-r1") throw new Error("r1 seed unavailable");
  const classification = "INCOMPLETE/WATCH/EXACT-STAKER-RECEIVER-BINDING/ACCESS-COVERAGE_OPEN/OPTIMISM-TERMINAL-RECHECK-GAPPED/DESTINATION-SINGLE-PROVIDER";
  const category = "exact-staker-receiver-local-build-with-adapter-runtime-and-provider-coverage-gaps";
  const runId = `etherfi-behype-staker-layerzero-r2-${prior.pin.blockNumber}-${prior.pin.blockHash.slice(2, 14)}-${scannerSha256.slice(0, 12)}`;
  const nextAction = "Provision responsive independent authorized Optimism and HyperEVM read-only coverage, then perform one fixed-pin coverage-only rerun; do not proceed to economics or invoke stake/send/compose/retry/sweep.";
  const blockers = [
    "ACCESS/COVERAGE_OPEN: the single bounded fresh repair pass could not obtain three archive-capable finalized Optimism providers, so no fresh pin replaced the retained r1 evidence.",
    "Retained Optimism evidence has 3 finalized-pin providers and 2 matching state providers, but terminal same-number recheck remains GAPPED 1/2 with threshold unmet.",
    "ACCESS/COVERAGE_OPEN: HyperEVM destination state and retained destination event history remain single-provider observations; no multi-provider destination consensus or delivery-finality proof is claimed.",
    `Destination-wide event evidence contains ${prior.history.destinationAllSources.unmatchedMessages} more WHYPE receives than beHYPE return sends and ${prior.history.destinationAllSources.composeAlerts} compose alerts; the unmatched compose row is an unresolved/pending-or-failed observation, not an ordinary operational state or exploit evidence.`,
    "The public L2 staker lets a caller supply its own WHYPE and source fee while the destination receiver pays the return native fee from its prefunded balance; exact direct native payout or current profitable end-to-end economics is not established.",
    "Destination lzCompose sends the whole rounded beHYPE balance rather than a per-call delta, so a valid compose receiver can include prior residue; current residue is sub-1e12 dust and material profitable extraction is not established.",
    "Only the L2 staker and destination receiver proxy/implementation pairs have local exact 0.8.24 build/runtime evidence. Source/destination WHYPE and beHYPE adapters are explorer/runtime-bound without equal local rebuild.",
    "No stake, send, message, retry, compose, sweep, claim, fork, economics pass or signed action was executed.",
  ];
  const evidenceScope = {
    localExactBuildRuntime: ["l2-staker-proxy", "l2-staker-implementation", "destination-receiver-proxy", "destination-receiver-implementation"],
    explorerRuntimeBoundWithoutEqualLocalRebuild: ["source-WHYPE-adapter", "source-beHYPE-adapter", "destination-WHYPE-adapter", "destination-beHYPE-adapter"],
    fullRouteLocalExactBuildRuntimeBound: false,
    destinationRouteHistoryEventProviderCount: 1,
    destinationDeliveryFinalityProven: false,
  };
  const result = {
    ...prior, revision: REVISION, runId, generatedAt, scanner: SCANNER, agentId: AGENT, classification, category,
    signal: "🟠 WATCH — STAKER/RECEIVER EXACT; ACCESS/COVERAGE_OPEN; NO PROFIT",
    routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false,
    pin: { ...prior.pin, terminalSameNumberHashVerified: false, terminalSameNumberHashMatchCount: 1, terminalSameNumberHashThreshold: 2, retainedFromR1AfterFreshRepairAccessBlocked: true },
    destinationPin: { ...prior.destinationPin, terminalSameNumberHashVerified: true, terminalSameNumberHashMatchCount: 1, terminalSameNumberHashThreshold: 1, multiProviderConsensus: false, retainedFromR1AfterFreshRepairAccessBlocked: true },
    captureProvenance: { ...prior.captureProvenance, scannerSha256, supersedesR1RunId: prior.runId, boundedRepairAttemptedAt: generatedAt, boundedRepairResult: "ACCESS_BLOCKED_THREE_ARCHIVE_CAPABLE_FINALIZED_OPTIMISM_PROVIDERS_UNAVAILABLE", freshPinCaptured: false },
    providerCoverage: {
      repairAttempt: { bounded: true, attemptCount: 1, result: "ACCESS_BLOCKED", failureClass: "OPTIMISM_ARCHIVE_FINALIZED_PROVIDER_THRESHOLD_UNAVAILABLE", economicsAttempted: false },
      optimism: { ...prior.providerCoverage.optimism, finalizedConsensusCount: 3, stateConsensusCount: 2, terminalRecheck: { label: "retained-r1.same-number-terminal", chainId: 10, blockNumber: prior.pin.blockNumber, threshold: 2, matchCount: 1, verified: false, freshRepairReplacementObtained: false }, endpointValuesPersisted: false },
      destination: { ...prior.providerCoverage.destination, stateProviderCount: 1, stateConsensusCount: 1, historyConsensusCount: 1, multiProviderConsensus: false, endpointValuesPersisted: false },
    },
    evidenceScope,
    history: {
      ...prior.history,
      destination: { ...prior.history.destination, providerCount: 1, multiProviderConsensus: false, evidenceQualification: "single-provider event evidence; not delivery-finality proof" },
      destinationAllSources: { ...prior.history.destinationAllSources, unmatchedClassification: "unresolved/pending-or-failed-observation", note: "Single-provider event evidence from the current observed receiver proxy boundary; not global LayerZero history or delivery-finality proof." },
    },
    findings: { ...prior.findings, exactCurrentBindings: true, unmatchedDestinationComposeClassification: "unresolved/pending-or-failed-observation", unmatchedDestinationComposeTreatedAsOrdinaryOperationalState: false, fullRouteLocalExactBuildRuntimeBound: false, destinationDeliveryFinalityProven: false, currentCompleteProfitableRouteEstablished: false, permissionlessProtocolLossEstablished: false, routePositive: 0 },
    blockers, nextReadOnlyStep: nextAction,
  };
  delete result.findings.ordinaryOperationalDelayTreatedAsExploit;
  writeOwned(RAW, JSON.stringify(result, null, 2) + "\n");
  const opTerminal = `GAPPED ${result.pin.terminalSameNumberHashMatchCount}/${result.pin.terminalSameNumberHashThreshold} threshold unmet`;
  const report = [
    `# ${result.signal} — EtherFi BeHYPE staker/LayerZero Step 4 reviewer r2`, "",
    `**Revision:** \`${REVISION}\`  `, `**Classification:** \`${classification}\`  `, `**Run:** \`${runId}\`  `,
    `**Optimism retained pin:** \`${result.pin.blockNumber}\` / \`${result.pin.blockHash}\` (3 Optimism finalized-pin providers; 2 matching retained state providers; terminal same-number recheck ${opTerminal})  `,
    `**Destination retained pin:** HyperEVM \`${result.destinationPin.blockNumber}\` / \`${result.destinationPin.blockHash}\` (1 matching state provider; 1 matching retained-history provider; single-provider event evidence; not delivery-finality proof)  `,
    "**Gates:** `routePositive=0`, `executableNow=0`, `signedActionJustified=false`, `fork=false`", "",
    "> Scope correction: only the L2 staker and destination receiver proxy/implementation pairs have local exact 0.8.24 build/runtime evidence. Source and destination WHYPE/beHYPE adapters are explorer/runtime-bound without equal local rebuild. Destination route/history joins are single-provider event evidence, not multi-provider LayerZero delivery-finality proof.", "",
    "## Bounded provider-coverage repair", "",
    "- Exactly one sanitized read-only repair pass was attempted. It stopped fail-closed because three archive-capable finalized Optimism providers were unavailable; no fresh pin or replacement evidence was emitted.",
    `- Retained evidence remains: 3 finalized-pin providers, 2 matching retained state providers, terminal same-number recheck ${opTerminal}.`,
    "- HyperEVM remains 1 state / 1 retained-history provider: ACCESS/COVERAGE_OPEN. No economics pass was attempted.", "",
    "## Evidence scope and observations", "",
    "- L2 staker and destination receiver proxy/implementation pairs: local exact build/runtime evidence.",
    "- Source/destination WHYPE and beHYPE adapters: explorer/runtime-bound without equal local rebuild.",
    `- Optimism source/module/direct/complete event joins: \`${result.history.route.sourceWhypeSent}/${result.history.route.moduleStakeJoined}/${result.history.route.directPublicStakerCalls}/${result.history.route.completeRoundTrips}\`.`,
    `- Destination receives/returns/compose alerts/unmatched: \`${result.history.destinationAllSources.received}/${result.history.destinationAllSources.returnSent}/${result.history.destinationAllSources.composeAlerts}/${result.history.destinationAllSources.unmatchedMessages}\`; single-provider event evidence, not delivery-finality proof.`,
    "- The unmatched destination compose row is an **unresolved/pending-or-failed observation**, not an ordinary operational state and not exploit evidence.",
    "- The L2 staker is public. The caller supplies WHYPE and the source fee; the destination receiver funds the return native fee.",
    "- Destination delivery uses the whole rounded beHYPE balance, so prior residue can be included. Explicit beHYPE sweep is owner-only; LayerZero queue retry is permissionless but queue/message-hash bound.",
    "- No direct native caller payout, arbitrary public sweep, exploit, loss, or profit is established.", "",
    "## Blockers", "", `- ${blockers.join("\n- ")}`, "",
    `**nextReadOnlyStep:** ${nextAction}`,
  ].join("\n") + "\n";
  writeOwned(REPORT, report);
  const inbox = { findingId: NAME, revision: REVISION, runId, agentId: AGENT, role: "critical-research", status: classification, classification, category, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, summary: "Reviewer-r2 scope correction packaged after one bounded provider repair ended ACCESS_BLOCKED; retained Optimism terminal and HyperEVM provider gaps remain fail-closed.", pin: result.pin, destinationPin: result.destinationPin, providerCoverage: result.providerCoverage, evidenceScope, counts: { sourceSends: result.history.route.sourceWhypeSent, moduleJoined: result.history.route.moduleStakeJoined, directCalls: result.history.route.directPublicStakerCalls, completeRoundTrips: result.history.route.completeRoundTrips, destinationReceived: result.history.destinationAllSources.received, destinationReturns: result.history.destinationAllSources.returnSent, destinationUnmatched: result.history.destinationAllSources.unmatchedMessages, composeAlerts: result.history.destinationAllSources.composeAlerts }, balances: result.balances, currentQuote: result.currentQuote, findings: result.findings, blockers, artifacts: [SCANNER, VALIDATOR, RAW, MANIFEST, REPORT, INBOX, HANDOFF], nextAction };
  writeOwned(INBOX, JSON.stringify(inbox, null, 2) + "\n");
  const handoff = [
    "# EtherFi BeHYPE staker/LayerZero Step 4 reviewer-r2 handoff", "",
    `- Run \`${runId}\`; revision \`${REVISION}\`; classification \`${classification}\`.`,
    `- Fresh repair access was blocked; retained finalized Optimism \`${result.pin.blockNumber}\` / \`${result.pin.blockHash}\`; 3 Optimism finalized-pin providers, 2 matching retained state providers, terminal same-number recheck ${opTerminal}.`,
    `- Retained HyperEVM \`${result.destinationPin.blockNumber}\` / \`${result.destinationPin.blockHash}\`; 1 matching state provider, 1 matching retained-history provider; single-provider event evidence and ACCESS/COVERAGE_OPEN; not delivery-finality proof.`,
    "- Local exact build/runtime evidence is limited to the L2 staker and destination receiver proxy/implementation pairs. Source/destination WHYPE and beHYPE adapters are explorer/runtime-bound without equal local rebuild.",
    `- Optimism source/module/direct/complete event joins: \`${result.history.route.sourceWhypeSent}/${result.history.route.moduleStakeJoined}/${result.history.route.directPublicStakerCalls}/${result.history.route.completeRoundTrips}\`. Destination received/return/alerts/unmatched: \`${result.history.destinationAllSources.received}/${result.history.destinationAllSources.returnSent}/${result.history.destinationAllSources.composeAlerts}/${result.history.destinationAllSources.unmatchedMessages}\`.`,
    "- Destination route/history joins are single-provider event evidence, not multi-provider LayerZero delivery-finality proof. The unmatched compose row is an unresolved/pending-or-failed observation, not an ordinary operational state.",
    `- Destination receiver native/beHYPE: \`${result.balances.destinationReceiver.nativeWei}/${result.balances.destinationReceiver.behypeWei}\` wei. Public callers supply WHYPE/source fee while the receiver funds return fees; whole-rounded-balance residue inclusion remains observed.`,
    "- Explicit beHYPE sweep is owner-only; queue retry is permissionless but queue/message-hash bound. No exploit, direct native caller payout, arbitrary sweep, or profit is established.",
    "- Gates `0/0/false`; `fork=false`; no stake/send/compose/retry/sweep/fork/signing/mutation and no economics pass.",
    `- Next: ${nextAction}`,
  ].join("\n") + "\n";
  writeOwned(HANDOFF, handoff);
  const records = [SCANNER, VALIDATOR, RAW, REPORT, INBOX, HANDOFF, STEP1, STEP3].map(hashFile); const aggregateSha256 = sha(records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n"));
  const manifest = { schemaVersion: 1, revision: REVISION, runId, generatedAt, algorithm: "sha256", classification, category, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, pin: result.pin, destinationPin: result.destinationPin, optimismFinalizedConsensusCount: 3, optimismStateConsensusCount: 2, optimismTerminalSameNumberHashVerified: false, optimismTerminalMatchCount: 1, optimismTerminalThreshold: 2, optimismTerminalThresholdMet: false, optimismHistoryComplete: true, optimismHistoryConsensusCount: 2, destinationStateConsensusCount: 1, destinationHistoryConsensusCount: 1, destinationMultiProviderConsensus: false, localExactBuildRuntimeScope: evidenceScope.localExactBuildRuntime, adapterExplorerRuntimeBoundWithoutEqualLocalRebuild: true, fullRouteLocalExactBuildRuntimeBound: false, destinationDeliveryFinalityProven: false, completeRoundTrips: result.history.route.completeRoundTrips, directPublicStakerCalls: result.history.route.directPublicStakerCalls, destinationUnmatchedCount: result.history.destinationAllSources.unmatchedMessages, destinationUnmatchedClassification: "unresolved/pending-or-failed-observation", currentProfitableRouteEstablished: false, records, aggregateSha256 };
  writeOwned(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ runId, classification, coverageResult: "ACCESS/COVERAGE_OPEN", pin: result.pin, destinationPin: result.destinationPin, artifacts: [SCANNER, VALIDATOR, RAW, MANIFEST, REPORT, INBOX, HANDOFF], gates: { routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false }, manifestAggregateSha256: aggregateSha256, nextReadOnlyStep: nextAction }) + "\n");
}

const runner = process.argv.includes("--package-access-open") ? Promise.resolve().then(packageAccessOpenFromR1) : main();
runner.catch((e) => { process.stderr.write(`scan failed: ${String(e?.message || e).replace(/https?:\/\/\S+/gi, "[redacted]")}\n`); process.exitCode = 1; });
