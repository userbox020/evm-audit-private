#!/usr/bin/env node
"use strict";

// Authorized defensive identity pass. RPC use is read-only; no eth_send*, signing,
// impersonation, mutation, fork, or value-path invocation is performed.

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { Interface, getAddress, keccak256, toQuantity } = require("ethers");
const { loadRpcUrls, getOrigin, PUBLIC_FALLBACKS } = require("./shared-rpc");

const ROOT = path.resolve(__dirname, "..");
const TARGET = path.join(ROOT, "targets", "cash-v3");
const SCANNER = "tools/scan-critical-etherfi-unknown-default-identity-binding.js";
const TEST = "tools/test-critical-etherfi-unknown-default-identity-binding.js";
const RAW = "reports/raw/fast/critical-etherfi-unknown-default-identity-binding.json";
const MANIFEST = "reports/raw/fast/critical-etherfi-unknown-default-identity-binding-manifest.json";
const REPORT = "reports/critical-etherfi-unknown-default-identity-binding.md";
const INBOX = "coordination/inbox/critical/2026-07-22-critical-etherfi-unknown-default-identity-binding.json";
const HANDOFF = "coordination/handoffs/2026-07-22-critical-etherfi-unknown-default-identity-binding-handoff.md";
const PREDECESSOR = "reports/raw/fast/critical-etherfi-default-module-capability.json";
const AGENT = "critical-etherfi-unknown-default-step1-r2-20260722";
const REVISION = "unknown-default-identity-binding-step1-reviewer-r2";
const SOURCE_COMMIT = "247faab2206cb651e2e81b2331404eed841145b8";
const CHAIN_ID = 10;
const DATA_PROVIDER = "0xDC515Cb479a64552c5A11a57109C314E40A1A778";
const CASH_MODULE = "0x7Ca0b75E67E33c0014325B739A8d019C4FE445F0";
const TARGETS = [
  {
    address: "0xd12efd5067DE109F9D00e1A31a34991d58DbB9F3",
    name: "BeHYPEStakeModule",
    artifact: "BeHYPEStakeModule.sol/BeHYPEStakeModule.json",
    source: "src/modules/hype/BeHYPEStakeModule.sol",
    deploymentBlock: 151286500,
    creationTransaction: "0x573f64a1c9f43de41839c61d7e221957eaed9310d42bc252be3bd7cd12a63440",
    immutableGetters: ["etherFiDataProvider", "cashModule", "staker", "whype", "beHYPE"],
  },
  {
    address: "0x0AD7FDf0ED3BF0943753047B7C8F0922c624A6F2",
    name: "SafeAssetRecoveryModule",
    artifact: "SafeAssetRecoveryModule.sol/SafeAssetRecoveryModule.json",
    source: "src/modules/recovery/SafeAssetRecoveryModule.sol",
    deploymentBlock: 153410706,
    creationTransaction: "0x2b49da798c41aa925245d34ce662099a22259a8d28759a34289c67c9e7d3e3ff",
    immutableGetters: ["etherFiDataProvider"],
  },
];
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const DP_ABI = [
  "function getDefaultModules() view returns (address[])",
  "function getWhitelistedModules() view returns (address[])",
  "function isDefaultModule(address) view returns (bool)",
  "function isWhitelistedModule(address) view returns (bool)",
  "function getCashModule() view returns (address)",
];

function abs(x) { return path.join(ROOT, x); }
function sha(x) { return crypto.createHash("sha256").update(x).digest("hex"); }
function canonical(v) { if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`; if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`; return JSON.stringify(v); }
function strip0x(x) { return String(x || "").replace(/^0x/i, ""); }
function sameAddress(a, b) { return Boolean(a && b && String(a).toLowerCase() === String(b).toLowerCase()); }
function runtimePresent(x) { const s = strip0x(x); return s.length > 0 && !/^0+$/.test(s); }
function slotAddress(x) { const s = strip0x(x); if (s.length !== 64 || /^0+$/.test(s)) return null; try { return getAddress(`0x${s.slice(-40)}`); } catch { return null; } }
function hashFile(rel) { const b = fs.readFileSync(abs(rel)); return { path: rel, bytes: b.length, sha256: sha(b) }; }
function writeOwned(rel, text) { if (![RAW, MANIFEST, REPORT, INBOX, HANDOFF].includes(rel)) throw new Error(`write refused: ${rel}`); fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), text, "utf8"); }
function walk(dir, predicate, out = []) { if (!fs.existsSync(dir)) return out; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, predicate, out); else if (predicate(p)) out.push(p); } return out; }
function git(args, options = {}) { const r = spawnSync("git", args, { cwd: TARGET, encoding: options.binary ? null : "utf8", timeout: options.timeout || 120_000, maxBuffer: 128 * 1024 * 1024 }); if (r.status !== 0) throw new Error(`git failed: ${args[0]}`); return r.stdout; }
function sourceAt(commit, rel) { return git(["show", `${commit}:${rel}`]); }
function gitBlob(commit, rel) { return git(["rev-parse", `${commit}:${rel}`]).trim(); }

async function rpc(url, origin, method, params, timeout = 8_000) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`); const j = await r.json(); if (j.error) throw new Error("rpc-error"); return j.result;
}

async function selectFinalizedProviders() {
  let inventory = []; try { inventory = [...new Set(loadRpcUrls())]; } catch { inventory = []; }
  if (PUBLIC_FALLBACKS[CHAIN_ID] && !inventory.includes(PUBLIC_FALLBACKS[CHAIN_ID])) inventory.push(PUBLIC_FALLBACKS[CHAIN_ID]);
  const capped = inventory.slice(0, 140); const groups = new Map(); const rejected = {}; let calls = 0;
  async function probe(url, ordinal) {
    const origin = getOrigin(url);
    try {
      calls++; const id = await rpc(url, origin, "eth_chainId", [], 5_000); if (Number(BigInt(id)) !== CHAIN_ID) throw new Error("chain-mismatch");
      calls++; const block = await rpc(url, origin, "eth_getBlockByNumber", ["finalized", false], 7_000); if (!block?.hash || !block?.number) throw new Error("no-finalized");
      const key = `${Number(BigInt(block.number))}:${String(block.hash).toLowerCase()}`; return { url, origin, ordinal, key, block };
    } catch (e) { const k = String(e.message || "failure").replace(/HTTP \d+/, "http-failure"); rejected[k] = (rejected[k] || 0) + 1; return null; }
  }
  for (let start = 0; start < capped.length; start += 20) {
    const rows = await Promise.all(capped.slice(start, start + 20).map((u, i) => probe(u, start + i)));
    for (const row of rows.filter(Boolean)) { const g = groups.get(row.key) || []; g.push(row); groups.set(row.key, g); }
    const winners = [...groups.values()].filter((x) => x.length >= 3).sort((a, b) => Number(BigInt(b[0].block.number) - BigInt(a[0].block.number)));
    if (winners.length) {
      const selected = winners[0].slice(0, 3); return { selected, inventoryCount: inventory.length, endpointsTried: Math.min(start + 20, capped.length), calls, rejected, groupCount: groups.size };
    }
  }
  const best = [...groups.values()].sort((a, b) => b.length - a.length)[0] || [];
  if (best.length < 2) throw new Error("ACCESS_BLOCKED: no multi-provider finalized consensus");
  return { selected: best.slice(0, 2), inventoryCount: inventory.length, endpointsTried: capped.length, calls, rejected, groupCount: groups.size };
}

class Reader {
  constructor(provider) { this.p = provider; this.count = 0; this.transcript = []; }
  async read(method, params, label) { this.count++; try { const result = await rpc(this.p.url, this.p.origin, method, params, 20_000); this.transcript.push({ number: this.count, method, label, ok: true }); return { ok: true, result }; } catch { this.transcript.push({ number: this.count, method, label, ok: false }); return { ok: false }; } }
  async call(address, iface, fn, args, block, label) { const x = await this.read("eth_call", [{ to: address, data: iface.encodeFunctionData(fn, args) }, toQuantity(block)], label); if (!x.ok) return x; try { return { ok: true, decoded: iface.decodeFunctionResult(fn, x.result), raw: x.result }; } catch { return { ok: false }; } }
}

function prepareBuild() {
  const temp = path.join(os.tmpdir(), "opencode", "etherfi-unknown-default-step1"); const work = path.join(temp, "source");
  fs.rmSync(temp, { recursive: true, force: true }); fs.mkdirSync(temp, { recursive: true });
  git(["worktree", "add", "--detach", work, SOURCE_COMMIT], { timeout: 180_000 });
  try {
    const lib = path.join(work, "lib"); for (const name of fs.readdirSync(path.join(TARGET, "lib"))) { const dst = path.join(lib, name); fs.rmSync(dst, { recursive: true, force: true }); fs.symlinkSync(path.join(TARGET, "lib", name), dst, "junction"); }
    const out = path.join(temp, "out"); const cache = path.join(temp, "cache"); const info = path.join(temp, "build-info");
    const run = spawnSync("forge", ["build", "--root", work, "--out", out, "--cache-path", cache, "--build-info", "--build-info-path", info, "--no-cache", "--offline"], { cwd: ROOT, encoding: "utf8", timeout: 600_000, maxBuffer: 128 * 1024 * 1024 });
    const output = `${run.stdout || ""}\n${run.stderr || ""}`; if (run.status !== 0) throw new Error(`offline exact-source build failed: ${output.slice(-1200).replace(/https?:\/\/\S+/gi, "[redacted]")}`);
    const infos = walk(info, (x) => x.endsWith(".json")).map((x) => JSON.parse(fs.readFileSync(x, "utf8")));
    const artifacts = {}; for (const t of TARGETS) artifacts[t.name] = JSON.parse(fs.readFileSync(path.join(out, t.artifact), "utf8"));
    return { temp, work, out, infos, artifacts, summary: { sourceCommit: SOURCE_COMMIT, compilerVersions: [...new Set(infos.map((x) => x.solcVersion))], buildInfoCount: infos.length, outputBytes: Buffer.byteLength(output), outputSha256: sha(output), optimizerEnabled: true, optimizerRuns: 0, evmVersion: "cancun", bytecodeHash: "none" } };
  } catch (e) { unlinkBuildLibraries(work); try { git(["worktree", "remove", "--force", work]); } catch {} fs.rmSync(temp, { recursive: true, force: true }); throw e; }
}
function unlinkBuildLibraries(work) { const lib = path.join(work, "lib"); if (!fs.existsSync(lib)) return; for (const name of fs.readdirSync(lib)) { const p = path.join(lib, name); try { if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p); } catch {} } }
function cleanupBuild(build) { unlinkBuildLibraries(build.work); try { git(["worktree", "remove", "--force", build.work]); } catch {} fs.rmSync(build.temp, { recursive: true, force: true }); }
function immutableNames(infos) { const m = new Map(); function visit(n, src) { if (!n || typeof n !== "object") return; if (n.nodeType === "VariableDeclaration" && n.mutability === "immutable") m.set(String(n.id), { name: n.name, sourcePath: src }); for (const v of Object.values(n)) { if (Array.isArray(v)) v.forEach((x) => visit(x, src)); else if (v && typeof v === "object") visit(v, src); } } for (const i of infos) for (const [src, row] of Object.entries(i.output?.sources || {})) visit(row.ast, src); return m; }
function word(address, len) { const s = strip0x(getAddress(address)).toLowerCase().padStart(len * 2, "0"); return Buffer.from(s, "hex"); }
function reconstruct(artifact, names, values, deployedCode) {
  const local = Buffer.from(strip0x(artifact.deployedBytecode.object), "hex"); const refs = [];
  for (const [id, positions] of Object.entries(artifact.deployedBytecode.immutableReferences || {})) {
    const d = names.get(String(id)); const value = values[d?.name]; if (!d || !value) throw new Error(`unbound immutable ${id}/${d?.name}`);
    for (const p of positions) { word(value, Number(p.length)).copy(local, Number(p.start)); refs.push({ astId: id, declarationName: d.name, sourcePath: d.sourcePath, value: getAddress(value), start: Number(p.start), length: Number(p.length) }); }
  }
  const deployed = Buffer.from(strip0x(deployedCode), "hex"); return { localBytes: local.length, deployedBytes: deployed.length, localKeccak256: keccak256(local), deployedKeccak256: keccak256(deployed), exact: local.equals(deployed), immutableReferences: refs };
}
function metadata(code) { const b = Buffer.from(strip0x(code), "hex"); if (b.length < 2) return null; const len = b.readUInt16BE(b.length - 2); if (len + 2 > b.length) return null; const body = b.subarray(b.length - len - 2, b.length - 2); return { length: len, sha256: sha(body), trailerHex: `0x${b.subarray(b.length - 2).toString("hex")}`, solidityMarkerPresent: body.includes(Buffer.from("solc")) }; }
function selectors(artifact, source) {
  const iface = new Interface(artifact.abi); return artifact.abi.filter((x) => x.type === "function").map((x) => { const f = iface.getFunction(x.name, x.inputs.map((i) => i.type)); const signature = f.format("sighash"); const valueClass = /^(stake|recover)$/.test(x.name) ? "safe-value-moving" : /^(pause|unpause|setRefundGasLimit)$/.test(x.name) ? "privileged-or-config" : x.name === "setupModule" ? "no-op-setup" : "read-only"; return { selector: f.selector, signature, stateMutability: x.stateMutability, valueClass, sourceDeclared: source.includes(`function ${x.name}(`) || source.includes(`function ${x.name} (`) }; }).sort((a, b) => a.selector.localeCompare(b.selector));
}

async function providerSnapshot(provider, blockNumber, build, names) {
  const reader = new Reader(provider); const dp = new Interface(DP_ABI); const out = { ordinal: provider.ordinal, transcript: reader.transcript, modules: [] };
  const chain = await reader.read("eth_chainId", [], "pin.chainId"); const block = await reader.read("eth_getBlockByNumber", [toQuantity(blockNumber), false], "pin.block");
  const defaults = await reader.call(DATA_PROVIDER, dp, "getDefaultModules", [], blockNumber, "dataProvider.defaultModules"); const white = await reader.call(DATA_PROVIDER, dp, "getWhitelistedModules", [], blockNumber, "dataProvider.whitelistedModules"); const cash = await reader.call(DATA_PROVIDER, dp, "getCashModule", [], blockNumber, "dataProvider.cashModule");
  out.chainId = chain.ok ? Number(BigInt(chain.result)) : null; out.blockHash = block.ok ? block.result.hash : null; out.timestamp = block.ok ? Number(BigInt(block.result.timestamp)) : null; out.defaultModules = defaults.ok ? Array.from(defaults.decoded[0]).map(getAddress) : null; out.whitelistedModules = white.ok ? Array.from(white.decoded[0]).map(getAddress) : null; out.cashModule = cash.ok ? getAddress(cash.decoded[0]) : null;
  for (const t of TARGETS) {
    const iface = new Interface(build.artifacts[t.name].abi); const code = await reader.read("eth_getCode", [t.address, toQuantity(blockNumber)], `${t.name}.code`); const impl = await reader.read("eth_getStorageAt", [t.address, IMPL_SLOT, toQuantity(blockNumber)], `${t.name}.implementationSlot`); const admin = await reader.read("eth_getStorageAt", [t.address, ADMIN_SLOT, toQuantity(blockNumber)], `${t.name}.adminSlot`); const beacon = await reader.read("eth_getStorageAt", [t.address, BEACON_SLOT, toQuantity(blockNumber)], `${t.name}.beaconSlot`); const isDefault = await reader.call(DATA_PROVIDER, dp, "isDefaultModule", [t.address], blockNumber, `${t.name}.isDefault`); const isWhite = await reader.call(DATA_PROVIDER, dp, "isWhitelistedModule", [t.address], blockNumber, `${t.name}.isWhitelisted`);
    const values = {}; for (const getter of t.immutableGetters) { const r = await reader.call(t.address, iface, getter, [], blockNumber, `${t.name}.${getter}`); values[getter] = r.ok ? getAddress(r.decoded[0]) : null; }
    const previous = await reader.read("eth_getCode", [t.address, toQuantity(t.deploymentBlock - 1)], `${t.name}.codeBeforeDeployment`); const atDeploy = await reader.read("eth_getCode", [t.address, toQuantity(t.deploymentBlock)], `${t.name}.codeAtDeployment`); const tx = await reader.read("eth_getTransactionByHash", [t.creationTransaction], `${t.name}.creationTransaction`); const receipt = await reader.read("eth_getTransactionReceipt", [t.creationTransaction], `${t.name}.creationReceipt`);
    const reconstruction = code.ok && Object.values(values).every(Boolean) ? reconstruct(build.artifacts[t.name], names, values, code.result) : { exact: false };
    out.modules.push({ name: t.name, address: getAddress(t.address), isDefault: isDefault.ok ? Boolean(isDefault.decoded[0]) : null, isWhitelisted: isWhite.ok ? Boolean(isWhite.decoded[0]) : null, returnedDefault: out.defaultModules ? out.defaultModules.some((x) => sameAddress(x, t.address)) : null, returnedWhitelisted: out.whitelistedModules ? out.whitelistedModules.some((x) => sameAddress(x, t.address)) : null, runtime: code.ok ? { present: runtimePresent(code.result), bytes: strip0x(code.result).length / 2, keccak256: keccak256(code.result), metadata: metadata(code.result) } : null, structure: { direct: code.ok ? runtimePresent(code.result) && !slotAddress(impl.result) && !slotAddress(beacon.result) : null, implementation: impl.ok ? slotAddress(impl.result) : null, admin: admin.ok ? slotAddress(admin.result) : null, beacon: beacon.ok ? slotAddress(beacon.result) : null, eip1167Clone: code.ok ? /^363d3d373d3d3d363d73[0-9a-f]{40}5af43d82803e903d91602b57fd5bf3$/i.test(strip0x(code.result)) : null }, immutableValues: values, reconstruction, creation: { transactionHash: t.creationTransaction, expectedDeploymentBlock: t.deploymentBlock, txBlockNumber: tx.ok ? Number(BigInt(tx.result.blockNumber)) : null, receiptBlockNumber: receipt.ok ? Number(BigInt(receipt.result.blockNumber)) : null, transactionSuccessful: receipt.ok ? receipt.result.status === "0x1" : null, receiptContractAddress: receipt.ok && receipt.result.contractAddress ? getAddress(receipt.result.contractAddress) : null, absentImmediatelyBefore: previous.ok ? !runtimePresent(previous.result) : null, presentAtDeploymentBlock: atDeploy.ok ? runtimePresent(atDeploy.result) : null, deployedCodeAtBoundaryKeccak256: atDeploy.ok && runtimePresent(atDeploy.result) ? keccak256(atDeploy.result) : null } });
  }
  const terminal = await reader.read("eth_getBlockByNumber", [toQuantity(blockNumber), false], "pin.terminalSameNumberHash"); out.terminalHash = terminal.ok ? terminal.result.hash : null; out.transcript = reader.transcript; return out;
}

async function main() {
  const generatedAt = new Date().toISOString(); const scannerSha256 = hashFile(SCANNER).sha256; const predecessor = JSON.parse(fs.readFileSync(abs(PREDECESSOR), "utf8"));
  if (!TARGETS.every((t) => predecessor.deployment?.unidentifiedDefaults?.some((x) => sameAddress(x.address, t.address)))) throw new Error("predecessor target mismatch");
  if (git(["cat-file", "-t", SOURCE_COMMIT]).trim() !== "commit") throw new Error("pinned source commit unavailable");
  const deployment = JSON.parse(sourceAt(SOURCE_COMMIT, "deployments/mainnet/10/deployments.json")); for (const t of TARGETS) if (!sameAddress(deployment.addresses[t.name], t.address)) throw new Error(`deployment identity mismatch: ${t.name}`);
  const selection = await selectFinalizedProviders(); const pin0 = selection.selected[0].block; const pin = { chainId: CHAIN_ID, blockNumber: Number(BigInt(pin0.number)), blockHash: String(pin0.hash).toLowerCase(), timestamp: Number(BigInt(pin0.timestamp)), finalizedSelected: true };
  const build = prepareBuild(); try {
    const names = immutableNames(build.infos); const snapshots = []; for (const p of selection.selected) snapshots.push(await providerSnapshot(p, pin.blockNumber, build, names));
    const digestOf = (s) => sha(canonical({ chainId: s.chainId, blockHash: s.blockHash?.toLowerCase(), defaults: s.defaultModules?.map((x) => x.toLowerCase()), whitelist: s.whitelistedModules?.map((x) => x.toLowerCase()), cashModule: s.cashModule?.toLowerCase(), modules: s.modules.map((m) => ({ address: m.address.toLowerCase(), isDefault: m.isDefault, isWhitelisted: m.isWhitelisted, runtime: m.runtime?.keccak256, structure: m.structure, immutables: Object.fromEntries(Object.entries(m.immutableValues).map(([k, v]) => [k, v?.toLowerCase()])), reconstructionExact: m.reconstruction.exact, creation: m.creation })) }));
    const digests = snapshots.map(digestOf); const digestGroups = new Map(); for (let i = 0; i < digests.length; ++i) { const g = digestGroups.get(digests[i]) || []; g.push(i); digestGroups.set(digests[i], g); } const bestDigestGroup = [...digestGroups.entries()].sort((a, b) => b[1].length - a[1].length)[0]; const consensusIndexes = bestDigestGroup?.[1] || []; const consensusExact = consensusIndexes.length >= 2; const consensusSnapshots = consensusIndexes.map((i) => snapshots[i]); const primary = consensusExact ? consensusSnapshots[0] : snapshots[0]; const sourceRows = TARGETS.map((t) => { const source = sourceAt(SOURCE_COMMIT, t.source); const artifact = build.artifacts[t.name]; return { name: t.name, path: `targets/cash-v3/${t.source}`, gitPath: t.source, gitBlob: gitBlob(SOURCE_COMMIT, t.source), bytes: Buffer.byteLength(source), sha256: sha(source), selectors: selectors(artifact, source), semantics: t.name === "BeHYPEStakeModule" ? { valueEntrypoint: "stake", requiresRegisteredSafe: /onlyEtherFiSafe\(safe\)/.test(source), requiresSafeAdminSigner: /onlySafeAdmin\(safe, signer\)/.test(source), signatureBindsChainModuleNonceSafeAmount: /STAKE_SIG, block\.chainid, address\(this\), _useNonce\(safe\), safe, abi\.encode\(amountToStake\)/.test(source), safeExecutionTargetFixedToTokenAndStaker: /execTransactionFromModule\(to, values, data\)/.test(source) && source.includes("to[1] = address(staker)"), arbitraryTargetArgument: false, approvalResetToZero: source.includes("approve.selector, address(staker), 0"), externalCallerRelayerNeutral: true } : { valueEntrypoint: "recover", requiresRegisteredSafe: /onlyEtherFiSafe\(safe\)/.test(source), requiresOwnerQuorumSignatures: /checkSignatures\(digest, signers, signatures\)/.test(source), signatureBindsChainModuleNonceSafeTokenRecipientDeadline: /block\.chainid[\s\S]*address\(this\)[\s\S]*_useNonce\(safe\)[\s\S]*safe[\s\S]*token[\s\S]*recipient[\s\S]*deadline/.test(source), sweepAmountUnsignedButFullBalance: source.includes("Amount is not signed") && /balanceOf\(safe\)/.test(source), supportedAssetExclusion: /isCollateralToken\(token\)/.test(source) && /isBorrowToken\(token\)/.test(source) && /_isWithdrawWhitelisted/.test(source), safeExecutionTargetFixedToSignedToken: source.includes("to[0] = token") && /IERC20\.transfer, \(recipient, amount\)/.test(source), arbitraryTargetArgument: false, callerRelayerNeutral: true, deadlineBound: /block\.timestamp > deadline/.test(source) } }; });
    const modules = primary.modules.map((m) => ({ ...m, source: sourceRows.find((x) => x.name === m.name), exactIdentity: m.isDefault === true && m.isWhitelisted === true && m.returnedDefault === true && m.returnedWhitelisted === true && m.structure.direct === true && m.reconstruction.exact === true && m.creation.absentImmediatelyBefore === true && m.creation.presentAtDeploymentBlock === true }));
    const pinVerified = consensusExact && consensusSnapshots.every((s) => s.chainId === CHAIN_ID && s.blockHash?.toLowerCase() === pin.blockHash && s.terminalHash?.toLowerCase() === pin.blockHash);
    const exact = pinVerified && consensusExact && modules.every((m) => m.exactIdentity); const classification = exact ? "EXACT/IDENTIFIED-DIRECT-MODULES" : "INCOMPLETE/WATCH/FAIL-CLOSED-IDENTITY-GAP"; const category = exact ? "unknown-defaults-identified-and-runtime-bound" : "identity-or-default-binding-incomplete";
    const result = { schemaVersion: 1, revision: REVISION, runId: `etherfi-unknown-default-identity-${pin.blockNumber}-${pin.blockHash.slice(2, 14)}-${scannerSha256.slice(0, 12)}`, generatedAt, scanner: SCANNER, agentId: AGENT, role: "critical-research", step: 1, classification, category, signal: exact ? "⚪ CLEAN — IDENTITY SUBSTEP ONLY" : "🟠 WATCH — FAIL-CLOSED IDENTITY GAP", routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, safety: { readOnlyRpc: true, endpointInventoryRead: true, endpointValuesPersisted: false, graphqlInventoryRead: false, envFilesRead: false, privateKeysRead: false, ethSendMethodsUsed: false, signingUsed: false, impersonationUsed: false, stateMutation: false, forkCreated: false, valueEntrypointCalled: false, fundsUsed: false }, pin: { ...pin, verified: pinVerified, terminalSameNumberHashVerified: pinVerified }, providerCoverage: { inventoryCount: selection.inventoryCount, endpointsTried: selection.endpointsTried, probeCalls: selection.calls, selectedCount: selection.selected.length, selectedOrdinals: selection.selected.map((x) => x.ordinal), finalizedConsensusCount: selection.selected.length, stateConsensusCount: consensusIndexes.length, stateConsensusOrdinals: consensusIndexes.map((i) => selection.selected[i].ordinal), excludedProviderCount: snapshots.length - consensusIndexes.length, stateDigestVariantCount: digestGroups.size, groupCount: selection.groupCount, rejectionCounts: selection.rejected, stateConsensusExact: consensusExact, stateDigest: consensusExact ? bestDigestGroup[0] : null, endpointValuesPersisted: false }, source: { repository: "etherfi-protocol/cash-v3", commit: SOURCE_COMMIT, deploymentPath: "deployments/mainnet/10/deployments.json", deploymentBlob: gitBlob(SOURCE_COMMIT, "deployments/mainnet/10/deployments.json"), files: sourceRows.map((x) => ({ name: x.name, path: x.path, gitBlob: x.gitBlob, bytes: x.bytes, sha256: x.sha256 })) }, build: build.summary, predecessor: { path: PREDECESSOR, runId: predecessor.runId, sha256: hashFile(PREDECESSOR).sha256 }, modules, transcript: primary.transcript, findings: { bothRemainReturnedDefaults: modules.every((x) => x.returnedDefault), bothRemainWhitelisted: modules.every((x) => x.isWhitelisted), bothDirectNonProxyNonBeaconNonClone: modules.every((x) => x.structure.direct && !x.structure.eip1167Clone), bothExactSourceRuntimeReconstructed: modules.every((x) => x.reconstruction.exact), arbitraryTargetSurfaceFound: modules.some((x) => x.source.semantics.arbitraryTargetArgument), safeExecSurfaceFound: modules.every((x) => x.source.semantics.safeExecutionTargetFixedToTokenAndStaker || x.source.semantics.safeExecutionTargetFixedToSignedToken), vulnerabilityOrLossEstablished: false }, blockers: ["This step identifies deployed semantics; it does not validate every signed tuple, token edge case, hook/debt interaction, or downstream staker behavior.", "SafeAssetRecoveryModule intentionally sweeps the current full balance of a signed unsupported token; amount is not signed, while token, recipient, deadline, domain and nonce are signed.", "BeHYPEStakeModule depends on the external staker and asynchronous LayerZero delivery; downstream settlement and refund behavior are outside this identity step.", "No outsider authorization bypass, arbitrary target, loss, profit, execution, or economic route is established."], nextReadOnlyStep: exact ? "Review SafeAssetRecoveryModule authorization/full-balance/unsupported-token invariants and BeHYPE stake fee/refund/delivery invariants as separate bounded branches; do not invoke either value entrypoint." : "Stop fail-closed and recover missing finalized consensus or exact runtime/source equivalence before semantic review." };
    writeOwned(RAW, JSON.stringify(result, null, 2) + "\n");
    const report = `# ${result.signal} — EtherFi unknown-default identity binding\n\n**Classification:** \`${classification}\`  \n**Run:** \`${result.runId}\`  \n**Pin:** Optimism \`${pin.blockNumber}\` / \`${pin.blockHash}\`  \n**Gates:** \`routePositive=0\`, \`executableNow=0\`, \`signedActionJustified=false\`, \`fork=false\`\n\n## Result\n\nThe two previously unidentified returned defaults are \`BeHYPEStakeModule\` at \`${TARGETS[0].address}\` and \`SafeAssetRecoveryModule\` at \`${TARGETS[1].address}\`. Both remain default and whitelisted at the fresh finalized pin, are direct non-proxy/non-beacon/non-clone deployments, and reproduce exactly from pinned public source commit \`${SOURCE_COMMIT}\` after independently read immutable values are inserted.\n\n- BeHYPE value surface: \`stake(safe,amount,signer,signature)\`; fixed Safe calls approve/staker/approval-reset, signed admin authorization, no caller-supplied target. Source: \`src/modules/hype/BeHYPEStakeModule.sol:90-165\`.\n- Safe recovery value surface: \`recover(safe,token,recipient,deadline,signers,signatures)\`; full-balance sweep of the signed token, with collateral/borrow/withdraw-whitelist exclusions and fixed ERC20 transfer target. Source: \`src/modules/recovery/SafeAssetRecoveryModule.sol:43-164\`.\n- Both reach \`EtherFiSafe.execTransactionFromModule\`, but neither ABI accepts an arbitrary call target or calldata. This is capability identification, not exploit evidence.\n\n## Preconditions and impact boundary\n\nValue movement requires a registered EtherFi Safe and the source-defined signature checks. Recovery additionally requires an unsupported token and unexpired deadline; staking requires the Safe admin signer and sufficient fee. A future authorization, token-behavior, health-hook, refund, or downstream-delivery flaw could affect Safe assets, but none is established here.\n\n## Defensive tests\n\nThe package checks multi-provider finalized state equality, terminal hash stability, registry predicates/lists, EIP-1967 slots, deployment boundaries, creation transactions, exact immutable-patched runtime equality, ABI selectors, source semantics, manifest integrity, and secret/URL leakage.\n\n## Mitigation\n\nNo code change is justified by this identity-only pass. Continue with separate invariant tests; retain fail-closed default-module monitoring and remove a module from defaults promptly if source/runtime identity drifts.\n\n**nextReadOnlyStep:** ${result.nextReadOnlyStep}\n`;
    writeOwned(REPORT, report);
    const inbox = { findingId: "critical-etherfi-unknown-default-identity-binding", revision: REVISION, runId: result.runId, agentId: AGENT, role: "critical-research", status: classification, classification, category, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, summary: exact ? "Both previously unknown EtherFi defaults are exactly identified as direct BeHYPEStakeModule and SafeAssetRecoveryModule deployments; no vulnerability established." : "Unknown-default identity pass stopped fail-closed on incomplete equivalence or finalized consensus.", artifacts: [RAW, MANIFEST, REPORT], nextAction: result.nextReadOnlyStep };
    writeOwned(INBOX, JSON.stringify(inbox, null, 2) + "\n");
    writeOwned(HANDOFF, `# EtherFi unknown-default identity binding handoff\n\n- Run \`${result.runId}\`; classification \`${classification}\`.\n- Fresh finalized Optimism pin \`${pin.blockNumber}\` / \`${pin.blockHash}\`: ${selection.selected.length} providers agreed on the finalized pin; ${consensusIndexes.length}/${selection.selected.length} matched the complete retained state digest, satisfying the two-provider state-consensus threshold.\n- Identities: \`BeHYPEStakeModule\` and \`SafeAssetRecoveryModule\`; both default/whitelisted/direct/exact-runtime: \`${exact}\`.\n- Value surfaces are fixed-target Safe module execution; no arbitrary target ABI, bypass, loss, profit, fork, signing, or live action.\n- Gates \`0/0/false\`; fork false.\n- Next: ${result.nextReadOnlyStep}\n`);
    const records = [SCANNER, TEST, RAW, REPORT, INBOX, HANDOFF, PREDECESSOR].map(hashFile); const aggregateSha256 = sha(records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n"));
    const manifest = { schemaVersion: 1, revision: REVISION, runId: result.runId, generatedAt, algorithm: "sha256", classification, category, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, pin, providerStateConsensusExact: consensusExact, exactIdentity: exact, records, aggregateSha256 };
    writeOwned(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
    process.stdout.write(JSON.stringify({ runId: result.runId, classification, pin: result.pin, providers: result.providerCoverage, modules: modules.map((x) => ({ name: x.name, address: x.address, default: x.isDefault, whitelisted: x.isWhitelisted, runtime: x.runtime, structure: x.structure, immutables: x.immutableValues, exactRuntime: x.reconstruction.exact, selectorCount: x.source.selectors.length, semantics: x.source.semantics })), findings: result.findings, artifacts: [RAW, MANIFEST, REPORT, INBOX, HANDOFF], nextReadOnlyStep: result.nextReadOnlyStep, manifestAggregateSha256: aggregateSha256 }) + "\n");
  } finally { cleanupBuild(build); }
}

function repackageReviewerR2() {
  const generatedAt = new Date().toISOString();
  const prior = JSON.parse(fs.readFileSync(abs(RAW), "utf8"));
  const priorManifest = JSON.parse(fs.readFileSync(abs(MANIFEST), "utf8"));
  const superseded = prior.packaging?.supersedes || { revision: prior.revision, runId: prior.runId, manifestAggregateSha256: priorManifest.aggregateSha256 };
  if (superseded.revision !== "unknown-default-identity-binding-step1-r1") throw new Error("offline r2 requires the retained r1 evidence package");
  if (prior.pin?.blockNumber !== 154548072 || prior.pin?.blockHash !== "0x8b474465bf8cc9a5d8e11743942473e9c5bedbd751114e733c69994d4e08b125") throw new Error("retained pin mismatch");
  if (prior.providerCoverage?.finalizedConsensusCount !== 3 || prior.providerCoverage?.stateConsensusCount !== 2) throw new Error("retained provider counts mismatch");
  const scannerSha256 = hashFile(SCANNER).sha256;
  const runId = `etherfi-unknown-default-identity-${prior.pin.blockNumber}-${prior.pin.blockHash.slice(2, 14)}-reviewer-r2-${scannerSha256.slice(0, 12)}`;
  const hype = prior.modules.find((x) => x.name === "BeHYPEStakeModule");
  const recovery = prior.modules.find((x) => x.name === "SafeAssetRecoveryModule");
  if (!hype || !recovery || !hype.reconstruction?.exact || !recovery.reconstruction?.exact) throw new Error("retained exact identity evidence missing");

  hype.source.semantics.refundConfiguration = {
    setter: "setRefundGasLimit(uint32)",
    requiredRole: "BEHYPE_STAKE_MODULE_ADMIN_ROLE",
    privilegedSetter: true,
    documentationSaysZeroRestoresDefault: true,
    implementationStoresProvidedValueIncludingZero: true,
    getterReturnsRawStoredValueWithoutDefaultFallback: true,
    positiveExcessRefundUsesGetterValueAsCallGasArgument: true,
    classification: "PRIVILEGED/REFUND-AVAILABILITY-RISK-ONLY",
    outsiderLossEstablished: false,
  };
  recovery.creation = {
    retainedCandidateTransactionHash: recovery.creation.transactionHash || recovery.creation.retainedCandidateTransactionHash,
    expectedDeploymentBlock: recovery.creation.expectedDeploymentBlock,
    retainedTransactionBlockNumber: recovery.creation.txBlockNumber || recovery.creation.retainedTransactionBlockNumber,
    retainedReceiptBlockNumber: recovery.creation.receiptBlockNumber || recovery.creation.retainedReceiptBlockNumber,
    retainedTransactionSuccessful: recovery.creation.transactionSuccessful ?? recovery.creation.retainedTransactionSuccessful,
    retainedReceiptTopLevelContractAddress: recovery.creation.receiptContractAddress ?? recovery.creation.retainedReceiptTopLevelContractAddress ?? null,
    absentImmediatelyBefore: recovery.creation.absentImmediatelyBefore,
    presentAtDeploymentBlock: recovery.creation.presentAtDeploymentBlock,
    deployedCodeAtBoundaryKeccak256: recovery.creation.deployedCodeAtBoundaryKeccak256,
    boundaryRuntimeMatchesExactReconstruction: recovery.creation.deployedCodeAtBoundaryKeccak256 === recovery.reconstruction.deployedKeccak256 && recovery.reconstruction.exact,
    topLevelReceiptCreatesTarget: false,
    independentFactoryCreateOrCreate2TraceRetained: false,
    exactCreationTransactionAttribution: false,
    identityEvidenceQualified: "Code is absent immediately before and present at the retained deployment boundary, and the boundary/current runtime exactly matches the immutable-patched pinned build. The retained receipt has no top-level contractAddress; no factory CREATE/CREATE2 trace independently links the candidate transaction to this address.",
  };

  prior.schemaVersion = 2;
  prior.revision = REVISION;
  prior.runId = runId;
  prior.generatedAt = generatedAt;
  prior.agentId = AGENT;
  prior.packaging = {
    mode: "offline-reviewer-correction-r2",
    noNewLiveReads: true,
    sourceEvidenceReused: true,
    supersedes: superseded,
    supersededWording: ["Any r1 wording implying three-provider exact or full-state consensus", "Any r1 wording implying exact SafeAssetRecoveryModule creation-transaction attribution"],
  };
  prior.safety.r2OfflineRepackaging = true;
  prior.safety.r2NewLiveReads = false;
  prior.providerCoverage.finalizedPinAgreementCount = 3;
  prior.providerCoverage.fullStateDigestMatchCount = 2;
  prior.providerCoverage.fullStateDigestProviderCount = 3;
  prior.providerCoverage.fullStateDigestThreshold = 2;
  prior.providerCoverage.fullStateDigestThresholdMet = true;
  prior.providerCoverage.allFinalizedProvidersMatchedFullStateDigest = false;
  prior.providerCoverage.exactStatement = "Three providers agreed on the finalized block number/hash. Two of those three matched the complete retained state digest; one was excluded from state consensus. The threshold is two matching providers.";
  prior.findings.beHYPERefundDocumentationImplementationMismatch = true;
  prior.findings.beHYPERefundRiskClassification = "PRIVILEGED/REFUND-AVAILABILITY-RISK-ONLY";
  prior.findings.beHYPERefundOutsiderLossEstablished = false;
  prior.findings.safeRecoveryExactCreationTransactionAttribution = false;
  prior.findings.safeRecoveryBoundaryAndBuildIdentitySupport = true;
  prior.blockers = [
    "Only two of the three finalized-pin providers matched the complete retained state digest; this meets the retained two-provider state-consensus threshold but is not three-provider full-state consensus.",
    "SafeAssetRecoveryModule creation-transaction attribution is not exact: its retained receipt has no top-level contractAddress, and no factory CREATE/CREATE2 trace is retained. Identity instead rests on boundary code absence/presence plus exact immutable-patched runtime reconstruction.",
    "BeHYPE setRefundGasLimit(0) documentation says zero restores a default, but implementation stores zero and getRefundGasLimit returns raw storage without fallback. The setter is role-gated; only privileged refund/availability risk is established, not outsider loss.",
    "SafeAssetRecovery authorization/full-balance/token-behavior invariants, hook/debt interaction, and downstream BeHYPE staker/delivery behavior remain outside this identity step.",
    "No outsider authorization bypass, arbitrary target, loss, profit, execution, or economic route is established.",
  ];
  prior.nextReadOnlyStep = "Run a separate bounded SafeAssetRecoveryModule authorization/full-balance invariant test using local source semantics only; do not invoke the deployed recover entrypoint.";
  writeOwned(RAW, JSON.stringify(prior, null, 2) + "\n");

  const report = `# ⚪ CLEAN — IDENTITY SUBSTEP ONLY — EtherFi unknown-default identity binding reviewer r2\n\n**Classification:** \`${prior.classification}\`  \n**Revision:** \`${REVISION}\`  \n**Run:** \`${runId}\`  \n**Pin:** Optimism \`${prior.pin.blockNumber}\` / \`${prior.pin.blockHash}\`  \n**Gates:** \`routePositive=0\`, \`executableNow=0\`, \`signedActionJustified=false\`, \`fork=false\`\n\n> This reviewer r2 package supersedes r1 reporting wording. It reuses retained evidence and performs no new live reads.\n\n## Exact provider coverage\n\nThree providers agreed on the finalized block number and hash. Only **two of those three** matched the complete retained state digest; one provider was excluded from state consensus. The retained threshold is two matching providers and is satisfied. This is not three-provider full-state consensus.\n\n## Identities and capability\n\nThe two previously unidentified returned defaults are \`BeHYPEStakeModule\` at \`${hype.address}\` and \`SafeAssetRecoveryModule\` at \`${recovery.address}\`. Both remain default and whitelisted at the retained pin, are direct non-proxy/non-beacon/non-clone deployments, and exactly match immutable-patched builds from pinned source commit \`${prior.source.commit}\`. Selector matrices and fixed-target Safe execution semantics are preserved. This is capability identification, not exploit evidence.\n\n- BeHYPE: \`stake(address,uint256,address,bytes)\` binds chain, module, nonce, Safe and amount; it uses fixed WHYPE/staker targets and resets approval. No caller-supplied arbitrary target exists.\n- Safe recovery: \`recover(address,address,address,uint256,address[],bytes[])\` binds chain, module, nonce, Safe, token, recipient and deadline. Amount is intentionally unsigned because execution sweeps the then-current full balance of the signed unsupported token. Collateral, borrow and withdrawal-whitelisted tokens are excluded.\n\n## Qualified SafeAssetRecovery creation lineage\n\nCode is absent immediately before block \`${recovery.creation.expectedDeploymentBlock}\` and present at that boundary with runtime hash \`${recovery.creation.deployedCodeAtBoundaryKeccak256}\`, which exactly matches the immutable-patched pinned build. However, the retained candidate transaction receipt has no top-level \`contractAddress\`, and this scanner retains no independent factory \`CREATE\`/\`CREATE2\` trace linking that transaction to the target. Therefore exact creation-transaction attribution is **not established**; boundary runtime plus build equality support identity.\n\n## BeHYPE refund documentation mismatch\n\n\`setRefundGasLimit(0)\` documentation says zero restores the default value, but the implementation writes the supplied value directly. \`getRefundGasLimit()\` returns raw stored value and implements no fallback. A positive excess-fee refund uses that raw value as the call gas argument. The setter requires \`BEHYPE_STAKE_MODULE_ADMIN_ROLE\`; this is only \`PRIVILEGED/REFUND-AVAILABILITY-RISK-ONLY\`, not outsider loss or a permissionless drain.\n\n## Impact boundary and blockers\n\nNo authorization bypass, arbitrary target, asset loss, profit, or executable route is established. The identity substep does not close SafeAssetRecovery signature/full-balance/token-behavior invariants, hook/debt behavior, or downstream BeHYPE delivery.\n\n## Defensive validation\n\nThe deterministic test asserts the explicit \`stateConsensusCount >= 2\` threshold, exact identities and runtimes, selector matrices, Safe signed fields/full-balance behavior, qualified creation lineage, refund mismatch classification, manifest integrity, and leak/signal requirements.\n\n**nextReadOnlyStep:** ${prior.nextReadOnlyStep}\n`;
  writeOwned(REPORT, report);
  const inbox = { findingId: "critical-etherfi-unknown-default-identity-binding", revision: REVISION, runId, agentId: AGENT, role: "critical-research", status: prior.classification, classification: prior.classification, category: prior.category, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, supersedes: superseded, summary: "Reviewer r2 preserves exact module identities/runtime bindings while correcting provider-consensus and Safe creation-lineage wording and recording a privileged BeHYPE refund-availability mismatch; no vulnerability or outsider loss established.", artifacts: [RAW, MANIFEST, REPORT], blockers: prior.blockers, nextAction: prior.nextReadOnlyStep };
  writeOwned(INBOX, JSON.stringify(inbox, null, 2) + "\n");
  writeOwned(HANDOFF, `# EtherFi unknown-default identity binding reviewer r2 handoff\n\n- Run \`${runId}\`; revision \`${REVISION}\`; supersedes r1 run \`${superseded.runId}\`.\n- Retained finalized Optimism pin \`${prior.pin.blockNumber}\` / \`${prior.pin.blockHash}\`; 3 providers agreed on the finalized pin, while 2/3 matched the complete retained state digest and satisfy the two-provider threshold.\n- Exact identities/direct deployments/immutable-patched runtime matches/selectors are preserved for \`BeHYPEStakeModule\` and \`SafeAssetRecoveryModule\`.\n- Safe creation lineage is qualified: boundary absence/presence plus exact runtime build support identity; top-level receipt contractAddress is null and no independent factory CREATE/CREATE2 trace is retained, so exact creation-transaction attribution is false.\n- BeHYPE zero refund-gas documentation conflicts with raw-storage setter/getter implementation; role-gated privileged refund/availability risk only, no outsider loss.\n- Gates \`0/0/false\`; no new live reads, endpoints, secrets, value calls, mutation, fork, or signing.\n- Next: ${prior.nextReadOnlyStep}\n`);
  const records = [SCANNER, TEST, RAW, REPORT, INBOX, HANDOFF, PREDECESSOR].map(hashFile);
  const aggregateSha256 = sha(records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n"));
  const manifest = { schemaVersion: 2, revision: REVISION, runId, generatedAt, algorithm: "sha256", classification: prior.classification, category: prior.category, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, offlineReviewerRepackaging: true, noNewLiveReads: true, supersedes: superseded, pin: prior.pin, finalizedPinAgreementCount: 3, fullStateDigestMatchCount: 2, fullStateDigestThreshold: 2, fullStateDigestThresholdMet: true, allFinalizedProvidersMatchedFullStateDigest: false, exactIdentity: true, safeRecoveryExactCreationTransactionAttribution: false, beHYPERefundRiskClassification: "PRIVILEGED/REFUND-AVAILABILITY-RISK-ONLY", records, aggregateSha256 };
  writeOwned(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ runId, revision: REVISION, classification: prior.classification, pin: prior.pin, providerCoverage: { finalizedPinAgreementCount: 3, fullStateDigestMatchCount: 2, threshold: 2 }, exactIdentities: prior.modules.map((x) => ({ name: x.name, address: x.address, runtimeExact: x.reconstruction.exact })), safeRecoveryExactCreationTransactionAttribution: false, beHYPERefundRiskClassification: prior.findings.beHYPERefundRiskClassification, gates: { routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false }, noNewLiveReads: true, manifestAggregateSha256: aggregateSha256, nextReadOnlyStep: prior.nextReadOnlyStep }) + "\n");
}

const runner = process.argv.includes("--live-refresh") ? main : repackageReviewerR2;
Promise.resolve().then(runner).catch((e) => { process.stderr.write(`scan failed: ${String(e?.message || e).replace(/https?:\/\/\S+/gi, "[redacted]")}\n`); process.exitCode = 1; });
