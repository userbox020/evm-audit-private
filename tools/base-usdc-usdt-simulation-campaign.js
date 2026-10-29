"use strict";
// Inactive MANUAL campaign. No inventory, scheduler, approval issuer or publisher.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util"), E = require("ethers");
const ROOT = path.resolve(__dirname, ".."), MODE = "LOCAL_DIAGNOSTIC_PARITY_NOT_TRIGGER_PROMOTION";
const FILES = ["tools/run-fork-poc.js", "tools/run-approved-fork-validation.js", "tools/lib/trigger-fork-epoch-execution.js",
  "tools/fork-poc/triggers/base-usdc-usdt-cross-venue.js", "tools/fork-poc/contracts/UsdcUsdtBaseAtomicRoundTrip.sol",
  "tools/fork-poc/contracts/UsdcUsdtBaseAtomicRoundTrip.compiled.json"];
const CORE_SHA = Object.freeze(Object.fromEntries(FILES.map((f, i) => [f, [
  "c577b7a93e1a02afd840617567365af5b7bb2f00ed044310d087d8299e3b2af4", "52d3a05657c0c5408fe6fa768a9f195ff3a1a0644b2eb96aa88257a9edff6179",
  "8a4aef5a26da8616906ab4b698f83ab6ba2cba46b2135f0f72548cf904bc92cb", "58fe2e3f375f9458dba565daa0fb242339d20b673109f0f3113e7dbe2042066d",
  "e48a237678698a057397d2deac97bea3d11572a50ecc0e2251e19e476fb2456e", "10210cb3c5909f9181792846afaec068cbc9d1528396b09c55395cf9b522f447"][i]])));
const COMPILER = "sources/maple-v2-step1-r2/audit-r2/compiler/solc-windows-amd64-v0.8.25+commit.b61c2a91.exe";
const COMPILER_SHA = "5f2947705f3db7c8e267742038f5c7e43009ba1e63a27a0b6fd4bdb1ccc25a5c";
const ANVIL = "C:/Users/MiPC/.foundry/bin/anvil.exe", COST_FILE = "tools/base-usdc-usdt-simulation-costs.js";
const SOURCE_FILES = [...FILES, "tools/base-usdc-usdt-simulation-campaign.js", "tools/scan-cross-dex-arbitrage.js",
  "tools/frax-usdc-cross-venue-economics.js", "tools/lib/common-finalized-rpc-preflight.js", "tools/node_modules/ethers/package.json", COMPILER, COST_FILE];
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const hex = v => typeof v === "string" && /^0x(?:[a-f0-9]{2})*$/i.test(v);
const hash = v => typeof v === "string" && /^0x[a-f0-9]{64}$/i.test(v);
const digest = v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const address = v => typeof v === "string" && /^0x[a-f0-9]{40}$/i.test(v);
const quantity = v => typeof v === "string" && /^0x[0-9a-f]+$/i.test(v);
const decimal = v => typeof v === "string" && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) < 2n ** 256n;
const q = v => "0x" + BigInt(v).toString(16);
const keys = (v, allowed) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).every(k => allowed.includes(k));
const exact = (v, required) => keys(v, required) && Object.keys(v).length === required.length;
const frozen = v => { if (v && typeof v === "object") { Object.values(v).forEach(frozen); Object.freeze(v); } return v; };
class ParityError extends Error { constructor(code, stage = "PREPARATION") { super(code); this.code = code; this.stage = stage; } }
const check = (ok, code, stage) => { if (!ok) throw new ParityError(code, stage); };
const safeFailure = (e, fallback, stage) => e instanceof ParityError ? { code: e.code, stage: e.stage } : { code: fallback, stage };
const PRIMARY_FAMILIES = Object.freeze(["infura", "quicknode", "alchemy", "drpc"]), MAX_UNSIGNED_BYTES = 65536;
const LOCAL_FIXED = frozen({ chainId: 8453, actor: "0x00000000000000000000000000000000000a11cf",
  bindings: { usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", usdt: "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2",
    curve: "0x335be1a364ea7f5da30aaaf062103ab91bf44dd0", uniPool: "0xd56da2b74ba826f19015e6b7dd9dae1903e85da1",
    router: "0x2626664c2603336e57b271c5c0b26f421741e481", morpho: "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb",
    factory: "0x33128a8fc17869897dce68ed026d694621f6fdfd", quoter: "0x3d4e44eb1374240ce5f1b871ab261cd16335b76a", ethUsd: "0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70" },
  direction: "UNIV3_TO_CURVE", principalRaw: "1000000000", minimumFinalUsdcRaw: "1000000001", actorNativeFixtureWei: "100000000000000000000",
  deploymentGasCap: "3000000", executionGasCap: "1000000", aggregateLocalGasCap: "6000000", scenario: FILES[3], scenarioName: "base-usdc-usdt-cross-venue",
  outputPath: "reports/DO-NOT-WRITE-base-simulation-campaign.json", // comparison token only; never opened
  harnessLimits: { totalMs: 180000, requestMs: 10000, relayRequests: 1000, relayBytes: 67108864, localRequests: 512, localBytes: 16777216,
    messageBytes: 1048576, calls: 128, sends: 2, snapshots: 0, observations: 128, asserts: 64, archiveAttempts: 1, candidates: 1 } });
const GPO = "0x420000000000000000000000000000000000000f", GPO_IMPL = "0x4f1db3c6abd250ba86e0928471a8f7db3afd88f1";
const SLOTS = Object.freeze(["0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103", "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50"]);
const ROOT_ADDRESSES = Object.freeze([...Object.values(LOCAL_FIXED.bindings), GPO, GPO_IMPL]);
const ACTIONS = Object.freeze(["PINNED_READS", "LOCAL_DEPLOY_ONCE", "LOCAL_EXECUTE_ONCE", "PINNED_FEE_OBSERVATION"]);
const SPEC_DEFAULTS = frozen({ schema: "base-usdc-usdt-simulation-campaign/v1", chainId: 8453, routeId: "base-usdc-usdt", direction: "UNIV3_TO_CURVE",
  principalRaw: "1000000000", witnessFamily: "publicnode", actions: ACTIONS,
  budget: { totalMs: 180000, requests: 1000, bytes: 67108864, responseBytes: 1048576, requestMs: 10000, simulations: 1, heads: 16, retries: 0 },
  pacing: { concurrency: 1, minSpacingMs: 1000 }, freshness: { candidateAgeMs: 10000, headLagBlocks: 2 } });
const ALLOWANCE_KEYS = Object.freeze(["quoteHaircutBps", "slippageUsdcRaw", "financingUsdcRaw", "latencyUsdcRaw", "competitionUsdcRaw", "otherUsdcRaw", "ethConversionHaircutBps", "networkFeeMarginBps"]);
const preparedObjects = new WeakSet(), states = new WeakMap(), usedApprovals = new Set();
function seam(deps) {
  check(!Object.keys(deps).length || deps.fixture === "OFFLINE_FIXTURE", "EXPLICIT_OFFLINE_FIXTURE_REQUIRED");
  return deps.fixture === "OFFLINE_FIXTURE";
}
function pinCheck(pin) {
  check(exact(pin, ["chainId", "number", "hash", "stateRoot", "timestamp"]) && pin.chainId === 8453 && Number.isSafeInteger(pin.number) && pin.number > 256
    && hash(pin.hash) && hash(pin.stateRoot) && decimal(pin.timestamp) && Number(pin.timestamp) > 0 && Number.isSafeInteger(Number(pin.timestamp) * 1000), "PIN_REJECTED", "PIN");
}
function snapshot(read) {
  const values = Object.fromEntries(SOURCE_FILES.map(f => [f, sha(read(path.join(ROOT, f)))]));
  values[ANVIL] = sha(read(ANVIL)); return values;
}
function prepareOffline(input, deps = {}) {
  const offline = seam(deps), read = deps.readFile || fs.readFileSync;
  try {
    const spec = structuredClone(input);
    check(exact(spec, [...Object.keys(SPEC_DEFAULTS), "primaryFamily", "qualificationPin", "runtime", "pointers", "allowances", "anvilSha256", "costModuleSha256"]), "SPEC_REJECTED");
    for (const k of ["schema", "chainId", "routeId", "direction", "principalRaw", "witnessFamily", "actions"]) check(isDeepStrictEqual(spec[k], SPEC_DEFAULTS[k]), "SPEC_REJECTED");
    pinCheck(spec.qualificationPin);
    check(PRIMARY_FAMILIES.includes(spec.primaryFamily) && digest(spec.anvilSha256) && digest(spec.costModuleSha256), "SPEC_REJECTED");
    check(exact(spec.budget, Object.keys(SPEC_DEFAULTS.budget)) && Object.entries(spec.budget).every(([k, v]) => Number.isSafeInteger(v)
      && (k === "retries" ? v === 0 : v > 0 && v <= SPEC_DEFAULTS.budget[k])), "BUDGET_REJECTED");
    check(exact(spec.pacing, ["concurrency", "minSpacingMs"]) && spec.pacing.concurrency === 1 && Number.isSafeInteger(spec.pacing.minSpacingMs)
      && spec.pacing.minSpacingMs >= 0 && spec.pacing.minSpacingMs <= spec.budget.totalMs, "PACING_REJECTED");
    check(exact(spec.freshness, ["candidateAgeMs", "headLagBlocks"]) && Number.isSafeInteger(spec.freshness.candidateAgeMs) && spec.freshness.candidateAgeMs > 0
      && spec.freshness.candidateAgeMs <= 10000 && Number.isSafeInteger(spec.freshness.headLagBlocks) && spec.freshness.headLagBlocks >= 0 && spec.freshness.headLagBlocks <= 2, "FRESHNESS_REJECTED");
    check(spec.runtime && Object.keys(spec.runtime).length <= 64 && ROOT_ADDRESSES.every(a => hash(spec.runtime[a]))
      && Object.entries(spec.runtime).every(([a, h]) => address(a) && a === a.toLowerCase() && hash(h)), "RUNTIME_SCOPE_REJECTED");
    check(Array.isArray(spec.pointers) && spec.pointers.length > 0 && spec.pointers.length <= 64 && spec.pointers.every(p => exact(p, ["address", "slot", "value"])
      && Object.hasOwn(spec.runtime, p.address) && SLOTS.includes(p.slot) && hash(p.value) && /^0x0{24}/.test(p.value))
      && new Set(spec.pointers.map(p => `${p.address}:${p.slot}`)).size === spec.pointers.length
      && spec.pointers.some(p => p.address === GPO && p.slot === SLOTS[0] && p.value === "0x" + "0".repeat(24) + GPO_IMPL.slice(2)), "POINTER_SCOPE_REJECTED");
    check(exact(spec.allowances, ALLOWANCE_KEYS) && ALLOWANCE_KEYS.every(k => k.endsWith("Bps") ? Number.isSafeInteger(spec.allowances[k]) && spec.allowances[k] >= (k === "quoteHaircutBps" ? 60 : 0)
      : decimal(spec.allowances[k])), "ALLOWANCES_REQUIRED");
    const sourceSha256 = snapshot(read);
    check(FILES.every(f => sourceSha256[f] === CORE_SHA[f]) && sourceSha256[COMPILER] === COMPILER_SHA && sourceSha256[ANVIL] === spec.anvilSha256, "SOURCE_HASH_MISMATCH");
    check(sourceSha256[COST_FILE] === spec.costModuleSha256, "COST_SOURCE_CHANGED");
    const artifact = JSON.parse(read(path.join(ROOT, FILES[5])));
    check(artifact.chainId === 8453 && artifact.sourcePath === FILES[4] && artifact.sourceSha256 === CORE_SHA[FILES[4]]
      && artifact.compiler?.version === "0.8.25+commit.b61c2a91" && artifact.compiler.path === COMPILER && artifact.compiler.sha256 === COMPILER_SHA
      && hex(artifact.creationBytecode) && hex(artifact.runtimeBytecode)
      && sha(Buffer.from(artifact.creationBytecode.slice(2), "hex")) === artifact.creationBytecodeSha256
      && sha(Buffer.from(artifact.runtimeBytecode.slice(2), "hex")) === artifact.runtimeBytecodeSha256, "COMPILED_HASH_MISMATCH");
    const executor = new E.Interface(artifact.abi), specSha256 = sha(JSON.stringify(spec));
    const p = frozen({ spec, specSha256, sourceSha256, artifact, offlineFixture: offline,
      preparedSha256: sha(JSON.stringify({ specSha256, sourceSha256, costModuleSha256: spec.costModuleSha256 })),
      creationData: artifact.creationBytecode + executor.encodeDeploy([LOCAL_FIXED.actor]).slice(2),
      executeData: executor.encodeFunctionData("execute", [1, 1000000000n, 1000000001n]), compiledSourceIndependentlyRebuilt: false });
    preparedObjects.add(p); return p;
  } catch (e) { const f = safeFailure(e, "PREPARATION_FAILED", "PREPARATION"); throw new ParityError(f.code, f.stage); }
}

// Ported local boundary from the reviewed 34-regression Temp adapter. Private:
// only qualify/evaluate can reach it; no independent execution authority.
function makeHarnessDeps(p, campaign, deps = {}) {
  const offline = seam(deps), now = campaign.now, { approval, candidates } = campaign;
  const m = p.manifest, E = require(path.join(ROOT, "tools/node_modules/ethers"));
  const harness = deps.harness || require(path.join(ROOT, FILES[0]));
  const approved = deps.approved || require(path.join(ROOT, FILES[1]));
  const { ForkError } = require(path.join(ROOT, FILES[1])); // actual waitReady class identity
  const base = { ...harness.defaultDeps(), transport: campaign.transport }, started = now(), deadline = campaign.deadline;
  const erc20 = new E.Interface(["function balanceOf(address) view returns(uint256)"]), executor = new E.Interface(p.artifact.abi);
  const pending = new Set(), methods = {}, dependencies = new Map(Object.values(m.bindings).map(a => [a, "FROZEN_BINDING"]));
  dependencies.set(m.actor, "LOCAL_ACTOR"); dependencies.set("0x0000000000000000000000000000000000000001", "HARNESS_ARCHIVE_PROBE");
  const headers = new Set([m.pin.hash]), receipts = [], unsignedTransactions = [], codeObservations = [];
  let requests = 0, bytes = 0, reservedBytes = 0, local = null, primaryResolved = false, relayCreated = false, deployments = 0, executions = 0;
  let submittedGas = 0n, seeded = false, deployed = null, executorZero = false, executorInitial = null, capacity = null, actorBefore = null, actorAfter = null;
  let constructorActor = null, deployedRuntime = null, capacityAfter = null, fault = null, captured = null, preHeaders = false, postHeaders = false, localClosed = false;
  let readinessPhase = "NOT_STARTED", localFacade = null;
  const scenarioObservations = {}, hashes = new Map(), capturedHashes = new Set();
  const guard = () => {
    check(now() < deadline && now() < approval.expiresAtMs && approval.status === "CURRENT_IN_PROGRESS" && approval.attemptStarted === true,
      "RUN_TIME_OR_AUTHORITY_EXHAUSTED", "BOUNDS"); campaign.guard();
  };
  const track = operation => {
    const job = Promise.resolve().then(operation); pending.add(job);
    job.then(() => pending.delete(job), () => pending.delete(job)); return job;
  };
  const drain = async () => { while (pending.size) await Promise.allSettled([...pending]); };
  const add = (a, origin) => {
    if (!address(a) || /^0x(?:0{40}|f{40})$/i.test(a)) return;
    a = a.toLowerCase(); check(dependencies.has(a) || dependencies.size < 64, "DEPENDENCY_CAP", "UPSTREAM"); dependencies.set(a, dependencies.get(a) || origin);
  };
  const target = a => check(address(a) && dependencies.has(a.toLowerCase()), "UPSTREAM_TARGET_REJECTED", "UPSTREAM");
  const pinned = tag => tag === q(m.pin.number) || keys(tag, ["blockHash", "requireCanonical"])
    && Object.keys(tag).length === 2 && tag.blockHash === m.pin.hash && tag.requireCanonical === true;
  function headerCheck(h, ref) {
    check(h && quantity(h.number) && hash(h.hash) && hash(h.stateRoot) && hash(h.parentHash) && quantity(h.timestamp)
      && BigInt(h.number) >= BigInt(m.pin.number - 256) && BigInt(h.number) <= BigInt(m.pin.number)
      && (hash(ref) ? h.hash === ref : h.number === ref), "UPSTREAM_HEADER_REJECTED", "PIN");
    if (BigInt(h.number) === BigInt(m.pin.number)) check(h.hash === m.pin.hash && h.stateRoot === m.pin.stateRoot
      && BigInt(h.timestamp) === BigInt(m.pin.timestamp), "FIXED_PIN_MISMATCH", "PIN");
    headers.add(h.parentHash); return h;
  }
  function upstreamScope(handle, payload) {
    check(handle === candidates[0].handle || handle === candidates[1].handle, "UPSTREAM_HANDLE_REJECTED", "UPSTREAM");
    check(keys(payload, ["jsonrpc", "id", "method", "params"]) && payload.jsonrpc === "2.0" && Array.isArray(payload.params), "UPSTREAM_REQUEST_REJECTED", "UPSTREAM");
    const a = payload.params, name = payload.method;
    if (handle === candidates[1].handle) check(["eth_chainId", "eth_getBlockByNumber"].includes(name), "WITNESS_STATE_REJECTED", "UPSTREAM");
    if (["eth_chainId", "net_version"].includes(name)) check(a.length === 0, "UPSTREAM_REQUEST_REJECTED", "UPSTREAM");
    else if (name === "eth_getBlockByNumber") check(a.length === 2 && a[1] === false && quantity(a[0])
      && BigInt(a[0]) >= BigInt(m.pin.number - 256) && BigInt(a[0]) <= BigInt(m.pin.number), "UPSTREAM_HEADER_REJECTED", "PIN");
    else if (name === "eth_getBlockByHash") check(a.length === 2 && a[1] === false && headers.has(a[0]), "UPSTREAM_HEADER_REJECTED", "PIN");
    else if (["eth_getCode", "eth_getBalance", "eth_getTransactionCount"].includes(name)) { check(a.length === 2 && pinned(a[1]), "UPSTREAM_PIN_REJECTED", "UPSTREAM"); target(a[0]); }
    else if (name === "eth_getStorageAt") { check(a.length === 3 && hash(a[1]) && pinned(a[2]), "UPSTREAM_PIN_REJECTED", "UPSTREAM"); target(a[0]); }
    else if (name === "eth_getProof") { check(a.length === 3 && Array.isArray(a[1]) && a[1].length <= 128 && a[1].every(hash) && pinned(a[2]), "UPSTREAM_PIN_REJECTED", "UPSTREAM"); target(a[0]); }
    else if (name === "eth_call") { check(a.length === 2 && keys(a[0], ["to", "data"]) && hex(a[0].data) && pinned(a[1]), "UPSTREAM_PIN_REJECTED", "UPSTREAM"); target(a[0].to); }
    else check(false, "UPSTREAM_METHOD_DENIED", "UPSTREAM"); // no new relay exceptions
  }
  const transport = (handle, payload, timeout = 10000, maxBytes = 1048576) => track(async () => {
    let reserved = 0;
    try {
      guard(); upstreamScope(handle, payload); check(requests < 1000, "UPSTREAM_REQUEST_CAP", "BOUNDS");
      const allowance = Math.min(maxBytes, 1048576, 67108864 - bytes - reservedBytes);
      check(Number.isSafeInteger(allowance) && allowance > 0 && Number.isFinite(timeout) && timeout > 0, "UPSTREAM_BYTE_CAP", "BOUNDS");
      reserved = allowance; reservedBytes += reserved; requests++;
      methods[payload.method] = (methods[payload.method] || 0) + 1;
      const r = await base.transport(handle, payload, Math.min(timeout, 10000, deadline - now(), approval.expiresAtMs - now()), reserved);
      check(r && Number.isSafeInteger(r.bytes) && r.bytes >= 0 && r.bytes <= reserved
        && r.value?.jsonrpc === "2.0" && r.value.id === payload.id && !r.value.error && Object.hasOwn(r.value, "result"), "UPSTREAM_RESPONSE_REJECTED", "UPSTREAM");
      bytes += r.bytes;
      const value = r.value.result, a = payload.params;
      if (payload.method.startsWith("eth_getBlockBy")) headerCheck(value, a[0]);
      if (payload.method === "eth_chainId") check(quantity(value) && BigInt(value) === 8453n, "UPSTREAM_CHAIN_MISMATCH", "PIN");
      if (payload.method === "net_version") check(value === "8453", "UPSTREAM_CHAIN_MISMATCH", "PIN");
      if (payload.method === "eth_getCode" && hex(value)) {
        const code = Buffer.from(value.slice(2), "hex");
        for (let i = 0; i < code.length; i++) { const op = code[i]; if (op === 0x73 && i + 20 < code.length) add("0x" + code.subarray(i + 1, i + 21).toString("hex"), "SCOPED_CODE_PUSH20"); if (op >= 0x60 && op <= 0x7f) i += op - 0x5f; }
      }
      if (payload.method === "eth_getStorageAt" && ["0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
        "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103", "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50"].includes(a[1])
        && hash(value) && /^0x0{24}/.test(value)) add("0x" + value.slice(-40), "SCOPED_EIP1967_POINTER");
      return r;
    } catch (e) { const f = safeFailure(e, "UPSTREAM_READ_FAILED", "UPSTREAM"); fault ||= f; throw new ParityError(f.code, f.stage); }
    finally { reservedBytes -= reserved; }
  });
  async function corroborate() {
    for (const c of candidates) {
      await transport(c.handle, { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] });
      await transport(c.handle, { jsonrpc: "2.0", id: 2, method: "eth_getBlockByNumber", params: [q(m.pin.number), false] });
    }
  }
  const balanceData = a => erc20.encodeFunctionData("balanceOf", [a]).toLowerCase();
  function callScope(tx) {
    check(keys(tx, ["to", "data"]) && address(tx.to) && hex(tx.data), "LOCAL_CALL_REJECTED", "LOCAL");
    check(tx.to.toLowerCase() === m.bindings.usdc && [m.actor, m.bindings.morpho, deployed].filter(Boolean).some(a => balanceData(a) === tx.data.toLowerCase())
      || deployed && tx.to.toLowerCase() === deployed && ["actor", "callbackComplete", "bothSwapsComplete"].some(name => executor.encodeFunctionData(name).toLowerCase() === tx.data.toLowerCase()), "LOCAL_CALL_REJECTED", "LOCAL");
  }
  function cleanReceipt(r, txHash) {
    check(r && r.transactionHash === txHash && ["0x0", "0x1"].includes(r.status) && quantity(r.gasUsed) && quantity(r.effectiveGasPrice)
      && address(r.from) && r.from.toLowerCase() === m.actor && (r.to === null || address(r.to) && r.to.toLowerCase() === deployed), "LOCAL_RECEIPT_INVALID", "LOCAL");
    const out = {};
    for (const k of ["transactionHash", "blockHash", "logsBloom"]) if (r[k] !== undefined) { check(k === "logsBloom" ? hex(r[k]) && r[k].length === 514 : hash(r[k]), "LOCAL_RECEIPT_INVALID", "LOCAL"); out[k] = r[k]; }
    for (const k of ["status", "gasUsed", "effectiveGasPrice", "gasPrice", "cumulativeGasUsed", "blockNumber", "transactionIndex", "type"]) if (r[k] !== undefined) { check(quantity(r[k]), "LOCAL_RECEIPT_INVALID", "LOCAL"); out[k] = r[k]; }
    for (const k of ["from", "to", "contractAddress"]) { check(r[k] === null || address(r[k]), "LOCAL_RECEIPT_INVALID", "LOCAL"); out[k] = r[k]; }
    check(Array.isArray(r.logs) && r.logs.length <= 256, "LOCAL_RECEIPT_INVALID", "LOCAL");
    out.logs = r.logs.map(l => { check(address(l.address) && Array.isArray(l.topics) && l.topics.length <= 4 && l.topics.every(hash) && hex(l.data), "LOCAL_RECEIPT_INVALID", "LOCAL");
      const row = { address: l.address, topics: l.topics, data: l.data };
      for (const k of ["blockHash", "transactionHash"]) if (l[k] !== undefined) { check(hash(l[k]), "LOCAL_RECEIPT_INVALID", "LOCAL"); row[k] = l[k]; }
      for (const k of ["blockNumber", "transactionIndex", "logIndex"]) if (l[k] !== undefined) { check(quantity(l[k]), "LOCAL_RECEIPT_INVALID", "LOCAL"); row[k] = l[k]; }
      if (typeof l.removed === "boolean") row.removed = l.removed; return row; });
    return out;
  }
  async function captureUnsigned(receipt) {
    const txHash = receipt.transactionHash, owned = hashes.get(txHash);
    if (capturedHashes.has(txHash)) return;
    guard(); check(!localClosed && owned && receipt.status === "0x1" && capturedHashes.size < 2, "LOCAL_TRANSACTION_REJECTED", "LOCAL");
    capturedHashes.add(txHash); // one read per successful owned hash, even if it fails
    const r = await local.call("eth_getTransactionByHash", [txHash]); // private seam, NOT exposed to scenario RPC
    const valid = ok => check(ok, "LOCAL_TRANSACTION_INVALID", owned.stage);
    const numeric = v => quantity(v) && v.length <= 66 && BigInt(v) < 2n ** 256n;
    valid(r && r.hash === txHash && address(r.from) && r.from.toLowerCase() === m.actor
      && ["chainId", "type", "nonce", "gas", "value"].every(k => numeric(r[k])));
    const type = Number(BigInt(r.type)), deploy = owned.stage === "DEPLOY";
    valid([0, 1, 2].includes(type) && BigInt(r.chainId) === 8453n && BigInt(r.value) === 0n
      && BigInt(r.nonce) <= BigInt(Number.MAX_SAFE_INTEGER) && BigInt(r.gas) === owned.gas && BigInt(receipt.gasUsed) <= owned.gas
      && (receipt.type === undefined || BigInt(receipt.type) === BigInt(type))
      && (deploy ? r.to === null : address(r.to) && r.to.toLowerCase() === deployed)
      && hex(r.input) && r.input.toLowerCase() === (deploy ? p.creationData : p.executeData).toLowerCase());
    const out = { hash: txHash, from: m.actor, chainId: r.chainId, type: r.type, nonce: r.nonce, gas: r.gas, to: r.to?.toLowerCase() ?? null, value: r.value, input: r.input };
    for (const k of ["gasPrice", "maxFeePerGas", "maxPriorityFeePerGas"]) if (r[k] !== undefined && r[k] !== null) { valid(numeric(r[k])); out[k] = r[k]; }
    valid(type === 2 ? numeric(out.maxFeePerGas) && numeric(out.maxPriorityFeePerGas) && BigInt(out.maxFeePerGas) >= BigInt(out.maxPriorityFeePerGas)
      : numeric(out.gasPrice) && out.maxFeePerGas === undefined && out.maxPriorityFeePerGas === undefined);
    const accessList = r.accessList ?? (type === 0 ? [] : null);
    valid(Array.isArray(accessList) && accessList.length <= 64 && (type !== 0 || accessList.length === 0));
    let slots = 0;
    out.accessList = accessList.map(entry => {
      valid(exact(entry, ["address", "storageKeys"]) && address(entry.address) && Array.isArray(entry.storageKeys)
        && entry.storageKeys.length <= 256 && entry.storageKeys.every(hash));
      slots += entry.storageKeys.length; valid(slots <= 256);
      return { address: entry.address.toLowerCase(), storageKeys: [...entry.storageKeys] };
    });
    const tx = E.Transaction.from({ chainId: 8453n, type, nonce: Number(BigInt(out.nonce)), gasLimit: BigInt(out.gas), to: out.to, value: 0n, data: out.input,
      ...(type === 2 ? { maxFeePerGas: BigInt(out.maxFeePerGas), maxPriorityFeePerGas: BigInt(out.maxPriorityFeePerGas) } : { gasPrice: BigInt(out.gasPrice) }),
      ...(type === 0 ? {} : { accessList: out.accessList }) });
    out.unsignedSerialized = tx.unsignedSerialized; out.serializedByteLength = E.getBytes(out.unsignedSerialized).length;
    valid(out.serializedByteLength <= MAX_UNSIGNED_BYTES); unsignedTransactions.push(frozen(out));
  }
  const localCall = (method, params, startupProbe = false) => track(async () => {
    let stage = "LOCAL", readinessRequest = false;
    try {
      if (method !== "anvil_stopImpersonatingAccount") { guard(); check(!localClosed, "LOCAL_CLOSED", "LOCAL"); }
      if (method === "eth_sendTransaction") {
        const tx = params?.[0];
        check(params.length === 1 && keys(tx, ["from", "to", "data", "value", "gas"]) && tx.from?.toLowerCase() === m.actor
          && hex(tx.data) && BigInt(tx.value || 0) === 0n, "LOCAL_SEND_REJECTED", "LOCAL");
        const deploy = tx.to === undefined || tx.to === null; stage = deploy ? "DEPLOY" : "EXECUTE";
        const cap = BigInt(deploy ? m.deploymentGasCap : m.executionGasCap), gas = tx.gas === undefined ? cap : quantity(tx.gas) ? BigInt(tx.gas) : 0n;
        check(gas > 0n && gas <= cap && submittedGas + gas <= BigInt(m.aggregateLocalGasCap), "LOCAL_GAS_CAP", stage);
        check(seeded && (deploy ? deployments === 0 && tx.data.toLowerCase() === p.creationData.toLowerCase()
          : deployments === 1 && executions === 0 && deployed && tx.to.toLowerCase() === deployed && executorZero
            && tx.data.toLowerCase() === p.executeData.toLowerCase()), "LOCAL_SEND_REJECTED", stage);
        submittedGas += gas; deploy ? deployments++ : executions++;
        const txHash = await local.call(method, [{ ...tx, gas: q(gas), value: "0x0" }]);
        check(hash(txHash) && !hashes.has(txHash), "LOCAL_TX_HASH_INVALID", stage); hashes.set(txHash, { stage, gas }); return txHash;
      }
      if (method === "anvil_setBalance") { check(params.length === 2 && params[0]?.toLowerCase() === m.actor && !seeded && deployments === 0
        && quantity(params[1]) && BigInt(params[1]) === BigInt(m.actorNativeFixtureWei), "LOCAL_FUNDING_REJECTED", "LOCAL"); seeded = true; }
      else if (["anvil_impersonateAccount", "anvil_stopImpersonatingAccount"].includes(method)) check(params.length === 1 && params[0]?.toLowerCase() === m.actor, "LOCAL_ACTOR_REJECTED", "LOCAL");
      else if (method === "eth_call") { check(params.length === 2 && params[1] === "latest", "LOCAL_CALL_REJECTED", "LOCAL"); callScope(params[0]); }
      else if (method === "eth_getCode") check(params.length === 2 && params[1] === "latest" && (Object.values(m.bindings).includes(params[0]?.toLowerCase()) || params[0]?.toLowerCase() === deployed), "LOCAL_CODE_REJECTED", "LOCAL");
      else if (method === "eth_getTransactionReceipt") check(params.length === 1 && hashes.has(params[0]), "LOCAL_RECEIPT_REJECTED", "LOCAL");
      else if (method === "eth_getBlockByNumber") check(params.length === 2 && params[0] === q(m.pin.number) && params[1] === false, "LOCAL_HEADER_REJECTED", "LOCAL");
      else check(method === "eth_chainId" && params.length === 0, "LOCAL_METHOD_DENIED", "LOCAL");
      readinessRequest = startupProbe && readinessPhase === "STARTING" && ["eth_chainId", "eth_getBlockByNumber"].includes(method);
      const r = await local.call(method, params);
      if (method === "eth_getTransactionReceipt" && r) {
        stage = hashes.get(params[0]).stage;
        if (stage === "DEPLOY" && r.status === "0x1") { check(address(r.contractAddress), "LOCAL_DEPLOYMENT_INVALID", "DEPLOY"); deployed = r.contractAddress.toLowerCase(); add(deployed, "LOCAL_EXECUTOR"); campaign.executorObserved(deployed); }
        const clean = cleanReceipt(r, params[0]);
        if (!receipts.some(x => x.transactionHash === clean.transactionHash)) receipts.push(clean);
        if (r.status === "0x0") fault ||= { code: "LOCAL_TX_REVERTED", stage };
        else await captureUnsigned(clean);
        return clean;
      }
      return r;
    } catch (e) {
      if (readinessRequest && e instanceof ForkError && e.code === "LOCAL_RPC_UNAVAILABLE") {
        throw new ForkError("LOCAL_RPC_UNAVAILABLE", "STARTUP"); // no raw detail/cause, no sticky fault
      }
      const f = safeFailure(e, "LOCAL_RPC_FAILED", stage); fault ||= f;
      if (startupProbe && readinessPhase === "STARTING") throw new ForkError(f.code, f.stage);
      throw new ParityError(f.code, f.stage);
    }
  });
  const balance = async (ctx, holder) => BigInt(erc20.decodeFunctionResult("balanceOf", await ctx.call({ to: m.bindings.usdc, data: balanceData(holder) }))[0]);
  const scenarioDeps = {
    loadRpcUrls: () => [candidates[0].handle],
    resolveUpstream: chain => { check(Number(chain) === 8453, "CHAIN_REJECTED"); if (primaryResolved) return null; primaryResolved = true; return candidates[0].handle; },
    transport,
    createRelay: opts => { check(!relayCreated && opts.upstreamUrl === candidates[0].handle && opts.transport === transport, "RELAY_REJECTED"); relayCreated = true; return base.createRelay(opts); },
    createLocalRpc: port => { check(!local, "LOCAL_RPC_ALREADY_CREATED"); const raw = approved.createLocalRpc(port, { limits: m.harnessLimits });
      local = { call: (method, params) => campaign.localRead(method, () => raw.call(method, params)), stats: () => raw.stats() };
      localFacade = { call: (method, params) => localCall(method, params), stats: () => local.stats() }; return localFacade; },
    waitReady: async (child, rpc, pin) => {
      try {
        check(readinessPhase === "NOT_STARTED" && localFacade && rpc === localFacade, "READINESS_ALREADY_USED", "STARTUP");
        guard(); readinessPhase = "STARTING";
        check(String(pin.chainId) === "8453" && String(pin.pinBlockNumber) === String(m.pin.number)
          && pin.pinBlockHash === m.pin.hash && pin.pinStateRoot === m.pin.stateRoot, "READINESS_PIN_REJECTED", "STARTUP");
        await base.waitReady(child, { call: (method, params) => localCall(method, params, true) }, pin);
        guard(); readinessPhase = "READY";
      } catch (e) {
        const f = e instanceof ForkError && ["LOCAL_FORK_CHAIN_MISMATCH", "LOCAL_FORK_PIN_MISMATCH", "ANVIL_EXITED_DURING_STARTUP", "ANVIL_STARTUP_TIMEOUT"].includes(e.code)
          ? { code: e.code, stage: "STARTUP" } : safeFailure(e, "STARTUP_READINESS_FAILED", "STARTUP");
        fault ||= f; throw new ForkError(f.code, f.stage);
      } finally { if (["NOT_STARTED", "STARTING"].includes(readinessPhase)) readinessPhase = "FAILED"; }
    },
    now, write: () => {},
    loadScenario: file => {
      check(file === path.join(ROOT, m.scenario), "SCENARIO_PATH_REJECTED");
      const scenario = base.loadScenario(file);
      return { run: async ctx => {
        try {
          for (const [role, a] of Object.entries(m.bindings)) {
             const code = await localCall("eth_getCode", [a, "latest"]); check(hex(code) && code !== "0x", "LOCAL_CODE_MISSING", "PRE_DEPLOY");
             check(E.keccak256(code) === campaign.spec.runtime[a], "LOCAL_RUNTIME_CHANGED", "PRE_DEPLOY");
            codeObservations.push({ role, address: a, runtimeKeccak256: E.keccak256(code), evidence: "FORK_RUNTIME_OBSERVATION_NOT_INDEPENDENT_BUILD" });
          }
          actorBefore = await balance(ctx, m.actor); check(actorBefore === 0n, "ACTOR_INITIAL_USDC_NONZERO", "PRE_DEPLOY");
          capacity = await balance(ctx, m.bindings.morpho); check(capacity >= BigInt(m.principalRaw), "MORPHO_CAPACITY_INSUFFICIENT", "PRE_DEPLOY");
          const restricted = {
            chainId: ctx.chainId, blockNumber: ctx.blockNumber, blockHash: ctx.blockHash, ethers: ctx.ethers, input: ctx.input,
            assert: ctx.assert,
            log: (label, value) => {
              if (["actorUsdcBeforeRaw", "actorUsdcAfterRaw"].includes(label)) {
                check(/^[0-9]+$/.test(String(value)), "SCENARIO_LOG_REJECTED"); scenarioObservations[label] = String(value);
              } else if (["callbackComplete", "bothSwapsComplete", "exactPin"].includes(label)) {
                check(typeof value === "boolean", "SCENARIO_LOG_REJECTED"); scenarioObservations[label] = value;
              } else if (label === "net") {
                const out = {};
                for (const key of ["raw", "actorGainRaw", "nativeGasWei", "gasUsdcRaw", "bpsPrincipal"]) {
                  check(typeof value?.[key] === "string" && /^-?[0-9]+$/.test(value[key]), "SCENARIO_LOG_REJECTED"); out[key] = value[key];
                }
                check(typeof value.routePositive === "boolean" && typeof value.exactPin === "boolean", "SCENARIO_LOG_REJECTED");
                scenarioObservations.net = { ...out, routePositive: value.routePositive, exactPin: value.exactPin };
              } else check(label === "eventId" && value === p.candidate.eventId || label === "routeKey" && value === p.candidate.routeKey, "SCENARIO_LOG_REJECTED");
            },
            call: tx => { callScope(tx); return ctx.call(tx); },
            setBalance: (a, amount) => ctx.setBalance(a, amount),
            deploy: async tx => {
              check(keys(tx, ["from", "data", "value"]), "LOCAL_DEPLOYMENT_INVALID", "DEPLOY");
              const result = await ctx.deploy(tx);
              check(result.address === deployed, "LOCAL_DEPLOYMENT_INVALID", "DEPLOY");
              // Observe, NEVER clear/seed, executor USDC BEFORE execute.
              const initial = await balance(ctx, deployed); executorInitial = initial; check(initial === 0n, "EXECUTOR_INITIAL_USDC_NONZERO", "DEPLOY"); executorZero = true;
              const code = await localCall("eth_getCode", [deployed, "latest"]); check(hex(code) && code !== "0x", "LOCAL_CODE_MISSING", "DEPLOY");
              deployedRuntime = E.keccak256(code);
              constructorActor = executor.decodeFunctionResult("actor", await ctx.call({ to: deployed, data: executor.encodeFunctionData("actor") }))[0].toLowerCase();
              check(constructorActor === m.actor, "EXECUTOR_CONSTRUCTOR_MISMATCH", "DEPLOY"); return result;
            },
            send: tx => ctx.send({ ...tx, gas: tx.gas === undefined ? q(m.executionGasCap) : tx.gas }),
            get fatal() { return ctx.fatal; }, set fatal(v) { check(v === true, "FATAL_ASSERTIONS_REQUIRED"); ctx.fatal = true; },
          };
          await scenario.run(Object.freeze(restricted)); actorAfter = await balance(ctx, m.actor);
          capacityAfter = await balance(ctx, m.bindings.morpho);
          check(capacityAfter >= capacity, "MORPHO_REPAYMENT_UNPROVEN", "SETTLEMENT");
        } catch (e) { const f = safeFailure(e, "SCENARIO_FAILED", "SCENARIO"); fault ||= f; throw new ParityError(f.code, f.stage); }
      } };
    },
    writeEvidence: (file, output) => {
      check(file === path.join(ROOT, m.outputPath), "OUTPUT_PATH_REJECTED"); localClosed = true;
      captured = { passed: output.status === "PASS" && Array.isArray(output.asserts) && output.asserts.every(a => a.pass === true),
        cleanup: { child: output.cleanup?.child === "STOPPED" ? "STOPPED" : "UNCONFIRMED", relay: output.cleanup?.relay === "CLOSED" ? "CLOSED" : "UNCONFIRMED" },
        denied: Array.isArray(output.relay?.deniedMethods) && output.relay.deniedMethods.length > 0 };
    },
  };
  return { harness, harnessDeps: scenarioDeps, drain,
    before: async () => { await corroborate(); preHeaders = true; },
    after: async () => { await drain(); if (preHeaders) { await corroborate(); postHeaders = true; } await drain(); },
    receipt: failure => {
      const native = receipts.reduce((sum, r) => sum + BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice), 0n);
      const gasUsdc = (native * BigInt(m.ethUsdRaw) * 1000000n + 10n ** 26n - 1n) / 10n ** 26n;
      const gain = actorAfter === null || actorBefore === null ? null : actorAfter - actorBefore;
      const pass = !failure && !fault && captured?.passed && captured.cleanup.child === "STOPPED" && captured.cleanup.relay === "CLOSED" && !captured.denied
        && postHeaders && executorZero && capacityAfter !== null && capacityAfter >= capacity && executions === 1 && receipts.length === 2 && unsignedTransactions.length === 2 && receipts.every(r => r.status === "0x1") && gain !== null && gain - gasUsdc > 0n
        && scenarioObservations.actorUsdcBeforeRaw === actorBefore.toString() && scenarioObservations.actorUsdcAfterRaw === actorAfter.toString()
        && scenarioObservations.net?.raw === (gain - gasUsdc).toString() && scenarioObservations.net.nativeGasWei === native.toString()
        && scenarioObservations.net.actorGainRaw === gain.toString() && scenarioObservations.net.gasUsdcRaw === gasUsdc.toString()
        && scenarioObservations.callbackComplete === true && scenarioObservations.bothSwapsComplete === true;
      return { schema: "base-usdc-usdt-local-parity/v1", mode: MODE, status: offline ? "OFFLINE_FIXTURE" : pass ? "PASS" : "FAIL_CLOSED",
        evidenceOrigin: offline ? "OFFLINE_FIXTURE" : "LOCAL_FORK", localDiagnosticParityPassed: Boolean(pass && !offline), fixtureAssertionsPassed: offline ? Boolean(pass) : null,
        failure: failure || fault || (pass ? null : { code: "DIAGNOSTIC_INCOMPLETE", stage: "FINAL" }), manifestSha256: p.manifestSha256,
        bootstrapSha256: p.bootstrapSha256, pin: m.pin, preHeadersMatched: preHeaders, postHeadersMatched: postHeaders, cleanup: captured?.cleanup || { child: "UNCONFIRMED", relay: "UNCONFIRMED" },
        manualInput: p.candidate, codeObservations, executor: { address: deployed, initialUsdcBalanceRaw: executorInitial?.toString() ?? null, zeroObservedBeforeExecute: executorZero,
          constructorActor, actualRuntimeKeccak256: deployedRuntime, templateRuntimeSha256: p.artifact.runtimeBytecodeSha256, templateContainsUnsubstitutedImmutables: true, independentlySourceProven: false },
        actor: { beforeRaw: actorBefore?.toString() ?? null, afterRaw: actorAfter?.toString() ?? null, gainRaw: gain?.toString() ?? null },
        morphoUsdcCapacityRaw: capacity?.toString() ?? null, morphoUsdcAfterRaw: capacityAfter?.toString() ?? null,
        principalRepaidRaw: pass ? m.principalRaw : null, transactions: receipts, unsignedTransactions, scenarioObservations,
        costs: { basis: "RECEIPT_NATIVE_EXECUTION_GAS_ONLY", nativeGasWei: native.toString(), gasUsdcRaw: gasUsdc.toString(),
          netUsdcRaw: gain === null ? null : (gain - gasUsdc).toString(), baseL1DataFees: "UNKNOWN", operatorFees: "UNKNOWN", fullyCostedNet: null },
        upstream: { primaryFamily: m.primaryFamily, witnessFamily: m.witnessFamily, requests, bytes, methods, active: pending.size, dependencies: [...dependencies].map(([a, origin]) => ({ address: a, origin })) },
        local: { deployments, executions, submittedGasLimits: submittedGas.toString(), readinessPhase }, compiledSourceIndependentlyRebuilt: false,
        productionQuoteInflationBpsUnchanged: 60, productionScreenStatus: p.productionScreenStatus, liveReady: false, liveAdmission: false, dispatchEnabled: false,
        sourceScenarioRoutePositiveIsLocalOnly: true, triggerOrCoveragePromotion: false, fullyCostedNet: null, economicOutcome: "UNKNOWN" };
    } };
}

const AUTHORITY_FIELDS = Object.freeze(["schema", "status", "attemptStarted", "issuedAtMs", "expiresAtMs", "chainId", "routeId", "direction", "principalRaw",
  "actions", "budget", "pacing", "freshness", "primaryFamily", "witnessFamily", "candidateCount", "maximumForkRuns", "preparedSha256", "specSha256", "sourceSha256", "allowDiagnosticParity"]);
function canonicalAuthority(value) {
  if (Array.isArray(value)) return value.map(canonicalAuthority);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonicalAuthority(value[k])]));
  return value;
}
function authority(p, a, candidates, deps, now) {
  check(preparedObjects.has(p) && p.offlineFixture === seam(deps), "PREPARATION_REQUIRED");
  const spec = p.spec;
  check(exact(a, AUTHORITY_FIELDS) && a.schema === "base-usdc-usdt-campaign-approval/v1" && a.status === "CURRENT_IN_PROGRESS" && a.attemptStarted === true
    && a.preparedSha256 === p.preparedSha256 && a.specSha256 === p.specSha256 && isDeepStrictEqual(a.sourceSha256, p.sourceSha256)
    && typeof a.allowDiagnosticParity === "boolean" && a.candidateCount === 2 && a.maximumForkRuns === 1
    && ["chainId", "routeId", "direction", "principalRaw", "actions", "budget", "pacing", "freshness", "primaryFamily", "witnessFamily"].every(k => isDeepStrictEqual(a[k], spec[k])), "APPROVAL_REQUIRED");
  check(Number.isSafeInteger(a.issuedAtMs) && Number.isSafeInteger(a.expiresAtMs) && a.issuedAtMs <= now && now < a.expiresAtMs
    && a.expiresAtMs - a.issuedAtMs <= spec.budget.totalMs, "APPROVAL_EXPIRED");
  const { classifyOperatorFamily } = require("./lib/common-finalized-rpc-preflight");
  check(Array.isArray(candidates) && candidates.length === 2 && candidates.every((c, i) => exact(c, ["handle", "operatorFamily", "inventoryOrder"])
    && typeof c.handle === "string" && c.handle.length > 0 && c.inventoryOrder === i && c.operatorFamily === [spec.primaryFamily, "publicnode"][i]
    && classifyOperatorFamily(c.handle)?.operatorFamily === c.operatorFamily) && candidates[0].handle !== candidates[1].handle, "CANDIDATES_REJECTED");
  frozen(a); frozen(candidates);
}
function makeState(p, approval, candidates, deps) {
  const now = deps.now || Date.now, started = now(), spec = p.spec, readFile = deps.readFile || fs.readFileSync;
  const raw = deps.transport || require("./run-fork-poc").defaultDeps().transport;
  const sleep = deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const s = { p, spec, approval, candidates, deps, now, started, deadline: Math.min(started + spec.budget.totalMs, approval.expiresAtMs),
    requests: 0, bytes: 0, reserved: 0, lastStart: -Infinity, active: 0, maxActive: 0, pending: new Set(), tail: Promise.resolve(),
    heads: 0, simulations: 0, failure: null, currentPin: spec.qualificationPin, candidate: null, latest: null, phase: "QUALIFICATION",
    pendingHead: null, running: false, inflight: null, completed: false, executor: null, timings: {}, methods: {}, cleanupReads: 0 };
  const invalidate = (code, stage = "CAMPAIGN") => { s.failure ||= { code, stage }; throw new ParityError(s.failure.code, s.failure.stage); };
  s.invalidate = invalidate;
  s.guard = () => {
    if (s.failure) throw new ParityError(s.failure.code, s.failure.stage);
    if (now() >= s.deadline || approval.status !== "CURRENT_IN_PROGRESS" || !approval.attemptStarted) invalidate("CAMPAIGN_EXPIRED", "BOUNDS");
    if (s.candidate && (now() < Number(s.candidate.timestamp) * 1000 || now() - Number(s.candidate.timestamp) * 1000 > spec.freshness.candidateAgeMs
      || s.latest.number - s.candidate.number > spec.freshness.headLagBlocks)) invalidate("CANDIDATE_STALE", "FRESHNESS");
  };
  s.checkSources = () => {
    s.guard();
    try { if (!isDeepStrictEqual(snapshot(readFile), p.sourceSha256)) invalidate("SOURCE_CHANGED", "SOURCE"); }
    catch (e) { if (e instanceof ParityError) throw e; invalidate("SOURCE_CHANGED", "SOURCE"); }
    s.guard();
  };
  const reserve = (limit, cleanup = false) => {
    if (!cleanup) s.guard();
    // Reserve one request for the sole actor's teardown, even after invalidation.
    if (s.requests >= spec.budget.requests - (cleanup ? 0 : 1)) invalidate("CAMPAIGN_REQUEST_CAP", "BOUNDS");
    const allowance = Math.min(limit, spec.budget.responseBytes, spec.budget.bytes - s.bytes - s.reserved);
    if (!Number.isSafeInteger(allowance) || allowance <= 0) invalidate("CAMPAIGN_BYTE_CAP", "BOUNDS");
    s.requests++; s.reserved += allowance; return allowance;
  };
  const responseBytes = (length, reserved) => {
    if (!Number.isSafeInteger(length) || length < 0 || length > reserved) invalidate("CAMPAIGN_RESPONSE_CAP", "BOUNDS");
    s.bytes += length;
  };
  s.localRead = (method, operation) => {
    const job = (async () => {
      const cleanup = method === "anvil_stopImpersonatingAccount";
      if (cleanup && ++s.cleanupReads > 1) invalidate("LOCAL_CLEANUP_CAP", "CLEANUP");
      const allowance = reserve(spec.budget.responseBytes, cleanup);
      try {
        const result = await operation(); responseBytes(Buffer.byteLength(JSON.stringify(result) ?? "null"), allowance);
        if (!cleanup) s.guard(); return result;
      } finally { s.reserved -= allowance; }
    })();
    s.pending.add(job);
    job.then(() => s.pending.delete(job), () => s.pending.delete(job)); return job;
  };
  s.executorObserved = a => { check(!s.executor || s.executor === a, "LOCAL_EXECUTOR_CHANGED"); s.executor = a; };
  function scope(handle, payload) {
    check(candidates.some(c => c.handle === handle) && exact(payload, ["jsonrpc", "id", "method", "params"]) && payload.jsonrpc === "2.0" && Array.isArray(payload.params), "READ_SCOPE_REJECTED");
    const { method, params: a } = payload, pin = s.currentPin, witness = handle === candidates[1].handle;
    if (witness) check(["eth_chainId", "eth_getBlockByNumber"].includes(method), "WITNESS_STATE_REJECTED");
    if (["eth_chainId", "net_version"].includes(method)) return check(a.length === 0 && (!witness || method === "eth_chainId"), "READ_SCOPE_REJECTED");
    if (method === "eth_getBlockByNumber") return check(a.length === 2 && a[1] === false && quantity(a[0]) && BigInt(a[0]) <= BigInt(pin.number)
      && BigInt(a[0]) >= BigInt(pin.number - (s.phase === "SIMULATION" && !witness ? 256 : 0)), "READ_SCOPE_REJECTED");
    if (method === "eth_getBlockByHash") return check(s.phase === "SIMULATION" && a.length === 2 && a[1] === false && hash(a[0]), "READ_SCOPE_REJECTED"); // inner port checks ancestry
    check(["eth_getCode", "eth_getStorageAt", "eth_getBalance", "eth_getTransactionCount", "eth_getProof", "eth_call"].includes(method), "UPSTREAM_METHOD_DENIED");
    const tag = a[a.length - 1], canonical = exact(tag, ["blockHash", "requireCanonical"]) && tag.blockHash === pin.hash && tag.requireCanonical === true;
    check(canonical || s.phase === "SIMULATION" && tag === q(pin.number), "READ_PIN_REJECTED");
    const target = method === "eth_call" ? a[0]?.to : a[0], lower = typeof target === "string" ? target.toLowerCase() : "";
    check(address(target) && (Object.hasOwn(spec.runtime, lower) || s.phase === "SIMULATION" && [LOCAL_FIXED.actor, "0x0000000000000000000000000000000000000001", s.executor].includes(lower)), "READ_TARGET_REJECTED");
    if (method === "eth_call") check(a.length === 2 && exact(a[0], ["to", "data"]) && hex(a[0].data) && a[0].data.length <= 262144, "READ_SCOPE_REJECTED");
    else if (method === "eth_getStorageAt") check(a.length === 3 && hash(a[1]) && (s.phase === "SIMULATION" || spec.pointers.some(p => p.address === lower && p.slot === a[1])), "READ_SCOPE_REJECTED");
    else if (method === "eth_getProof") check(s.phase === "SIMULATION" && a.length === 3 && Array.isArray(a[1]) && a[1].length <= 128 && a[1].every(hash), "READ_SCOPE_REJECTED");
    else check(a.length === 2, "READ_SCOPE_REJECTED");
  }
  s.transport = (handle, payload, timeout = spec.budget.requestMs, maximum = spec.budget.responseBytes) => {
    const job = s.tail.then(async () => {
      let allowance = 0;
      try {
        s.guard(); scope(handle, payload);
        check(Number.isFinite(timeout) && timeout > 0, "READ_SCOPE_REJECTED");
        const wait = Math.max(0, s.lastStart + spec.pacing.minSpacingMs - now());
        if (wait) await sleep(wait); s.guard();
        allowance = reserve(maximum); s.lastStart = now(); s.active++; s.maxActive = Math.max(s.maxActive, s.active);
        s.methods[payload.method] = (s.methods[payload.method] || 0) + 1;
        const r = await raw(handle, payload, Math.min(timeout, spec.budget.requestMs, s.deadline - now()), allowance);
        responseBytes(r?.bytes, allowance);
        check(r?.value?.jsonrpc === "2.0" && r.value.id === payload.id && !r.value.error && Object.hasOwn(r.value, "result"), "READ_RESPONSE_REJECTED");
        const v = r.value.result, a = payload.params;
        if (payload.method === "eth_chainId") check(quantity(v) && BigInt(v) === 8453n, "PROVIDER_CHAIN_CHANGED");
        if (payload.method === "net_version") check(v === "8453", "PROVIDER_CHAIN_CHANGED");
        if (payload.method === "eth_getCode" && Object.hasOwn(spec.runtime, a[0].toLowerCase()))
          check(hex(v) && v !== "0x" && E.keccak256(v) === spec.runtime[a[0].toLowerCase()], "RUNTIME_CHANGED");
        if (payload.method === "eth_getStorageAt" && SLOTS.includes(a[1])) {
          const expected = spec.pointers.find(p => p.address === a[0].toLowerCase() && p.slot === a[1]);
          check(hash(v) && v === (expected?.value || "0x" + "0".repeat(64)), "POINTER_CHANGED");
        }
        s.guard(); return r;
      } catch (e) { const f = safeFailure(e, "PROVIDER_READ_FAILED", "READ"); return invalidate(f.code, f.stage); }
      finally { if (allowance) { s.active--; s.reserved -= allowance; } }
    });
    s.tail = job.catch(() => {}); s.pending.add(job);
    job.then(() => s.pending.delete(job), () => s.pending.delete(job)); return job;
  };
  s.drain = async () => { while (s.pending.size) await Promise.allSettled([...s.pending]); };
  let id = 0;
  s.read = async (method, params, witness = false) => (await s.transport(candidates[witness ? 1 : 0].handle, { jsonrpc: "2.0", id: ++id, method, params })).value.result;
  s.headers = async () => {
    const pin = s.currentPin;
    for (const witness of [false, true]) {
      await s.read("eth_chainId", [], witness);
      const h = await s.read("eth_getBlockByNumber", [q(pin.number), false], witness);
      check(h && quantity(h.number) && BigInt(h.number) === BigInt(pin.number) && h.hash === pin.hash && h.stateRoot === pin.stateRoot
        && quantity(h.timestamp) && BigInt(h.timestamp) === BigInt(pin.timestamp), "CANONICAL_HEADER_CHANGED", "PIN");
    }
  };
  s.runtime = async () => {
    const allowed = new Set(ROOT_ADDRESSES), seen = new Set(), ref = { blockHash: s.currentPin.hash, requireCanonical: true };
    for (const a of allowed) {
      const code = await s.read("eth_getCode", [a, ref]); seen.add(a);
      const bytes = Buffer.from(code.slice(2), "hex");
      for (let i = 0; i < bytes.length; i++) {
        const op = bytes[i];
        if (op === 0x73 && i + 20 < bytes.length) { const child = "0x" + bytes.subarray(i + 1, i + 21).toString("hex"); if (Object.hasOwn(spec.runtime, child)) allowed.add(child); }
        if (op >= 0x60 && op <= 0x7f) i += op - 0x5f;
      }
      for (const pointer of spec.pointers.filter(p => p.address === a)) {
        const value = await s.read("eth_getStorageAt", [a, pointer.slot, ref]);
        const child = "0x" + value.slice(-40); if (Object.hasOwn(spec.runtime, child)) allowed.add(child);
      }
    }
    check(Object.keys(spec.runtime).every(a => seen.has(a)), "UNREACHABLE_RUNTIME_SCOPE");
  };
  s.quote = () => require("./scan-cross-dex-arbitrage").quoteBase1000AtPin({ pin: s.currentPin, rpc: candidates[0].handle, now,
    rpcCall: (handle, method, params) => { check(handle === candidates[0].handle, "READ_SCOPE_REJECTED"); return s.read(method, params); } });
  s.costModule = () => {
    check(sha(readFile(path.join(ROOT, COST_FILE))) === spec.costModuleSha256, "COST_SOURCE_CHANGED");
    return require("./base-usdc-usdt-simulation-costs"); // same real module in offline fixtures
  };
  return s;
}
function publicResult(s, status, extra = {}) {
  return frozen({ schema: "base-usdc-usdt-campaign-result/v1", status: s.p.offlineFixture ? "OFFLINE_FIXTURE" : status, outcome: status,
    evidenceOrigin: s.p.offlineFixture ? "OFFLINE_FIXTURE" : "MANUAL_LOCAL_CAMPAIGN", failure: s.failure, ...extra,
    preparedSha256: s.p.preparedSha256, specSha256: s.p.specSha256,
    budget: { requests: s.requests, bytes: s.bytes, pending: s.pending.size, active: s.active, maximumUpstreamConcurrency: s.maxActive, heads: s.heads, simulations: s.simulations },
    elapsedMs: s.now() - s.started, timings: { ...s.timings }, productionQuoteInflationBpsUnchanged: 60,
    routePositive: "unknown", liveReady: false, liveAdmission: false, dispatchEnabled: false, triggerOrCoveragePromotion: false, compiledSourceIndependentlyRebuilt: false });
}
async function qualifyCampaign(prepared, authorization, opaqueHandles, deps = {}) {
  const now = deps.now || Date.now; authority(prepared, authorization, opaqueHandles, deps, now());
  const attempt = sha(JSON.stringify(canonicalAuthority(authorization))); // validated public authority ONLY; never handles
  check(!usedApprovals.has(attempt), "ATTEMPT_ALREADY_USED"); usedApprovals.add(attempt);
  const s = makeState(prepared, authorization, opaqueHandles, deps);
  try {
    s.checkSources(); s.costModule(); await s.headers(); await s.runtime();
    const quote = await s.quote(); check(quote.status === "OBSERVED", "QUALIFICATION_QUOTE_UNKNOWN");
    await s.headers(); s.checkSources();
    const ready = frozen({ schema: "base-usdc-usdt-campaign-ready/v1", status: "READY", evidenceOrigin: prepared.offlineFixture ? "OFFLINE_FIXTURE" : "MANUAL_LOCAL_CAMPAIGN",
      preparedSha256: prepared.preparedSha256, primaryFamily: prepared.spec.primaryFamily, witnessFamily: "publicnode", liveReady: false });
    s.timings.qualificationMs = now() - s.started; s.phase = "READY"; states.set(ready, s); return ready;
  } catch (e) {
    s.failure ||= safeFailure(e, "QUALIFICATION_FAILED", "QUALIFICATION"); await s.drain(); return publicResult(s, "UNKNOWN");
  }
}
async function simulate(s, pin, quote) {
  const m = frozen({ ...LOCAL_FIXED, pin, ethUsdRaw: quote.oracle.ethUsdRaw, primaryFamily: s.spec.primaryFamily, witnessFamily: "publicnode" });
  const routeKey = "manual:base-usdc-usdt:univ3-to-curve:1000000000";
  const p = { manifest: m, artifact: s.p.artifact, creationData: s.p.creationData, executeData: s.p.executeData,
    manifestSha256: s.p.specSha256, bootstrapSha256: s.p.preparedSha256, productionScreenStatus: quote.economics.status,
    candidate: frozen({ eventId: sha(JSON.stringify([s.p.preparedSha256, pin.hash, quote.row.amountOutRaw])), routeKey,
      curvePool: m.bindings.curve, uniPool: m.bindings.uniPool, direction: m.direction, amountInRaw: m.principalRaw,
      expectedOutRaw: m.minimumFinalUsdcRaw, ethUsdRaw: m.ethUsdRaw, rawQuotedOutRaw: quote.row.amountOutRaw, manualDiagnostic: MODE }) };
  const b = makeHarnessDeps(p, s, s.deps); let failure = null;
  try {
    await b.before();
    await b.harness.runForkPoc({ callerClass: "MANUAL", chain: "8453", block: String(pin.number), scenario: path.join(ROOT, m.scenario),
      scenarioName: m.scenarioName, scenarioInput: { blockHash: pin.hash, candidate: p.candidate }, outPath: path.join(ROOT, m.outputPath),
      limits: { ...m.harnessLimits, totalMs: Math.max(1, s.deadline - s.now()) } }, b.harnessDeps);
  } catch (e) { failure = safeFailure(e, "HARNESS_FAILED", "HARNESS"); }
  finally { await b.drain(); try { await b.after(); } catch (e) { failure ||= safeFailure(e, "POST_HEADER_FAILED", "PIN"); } await b.drain(); }
  return frozen(b.receipt(failure));
}
async function processHead(s, pin) {
  const started = s.now(); let quote = null, simulation = null, diagnostic = false;
  s.currentPin = pin; s.candidate = pin; s.phase = "QUOTE";
  try {
    s.guard(); s.checkSources(); await s.headers(); await s.runtime();
    const beforeQuote = s.now(); quote = await s.quote(); s.timings.quoteMs = s.now() - beforeQuote;
    s.guard(); s.checkSources(); await s.headers();
    if (quote.status !== "OBSERVED" || quote.pricing.baseFeeWei === null) return publicResult(s, "UNKNOWN", { pin, quote });
    if (BigInt(quote.row.amountOutRaw) <= 1000000000n) return publicResult(s, "WATCH", { pin, quote, reason: "RAW_NONPOSITIVE" });
    if (quote.economics.status !== "ATOMIC_FORK_REQUIRED") {
      if (!s.approval.allowDiagnosticParity) return publicResult(s, "WATCH", { pin, quote, reason: "PRODUCER_GUARD_SUPPRESSED" });
      diagnostic = true;
    }
    s.guard(); check(s.simulations < s.spec.budget.simulations, "SIMULATION_CAP"); s.simulations++; s.phase = "SIMULATION";
    const beforeSimulation = s.now(); simulation = await simulate(s, pin, quote); s.timings.simulationMs = s.now() - beforeSimulation;
    s.guard(); s.checkSources(); await s.headers(); await s.runtime();
    check(s.p.offlineFixture ? simulation.fixtureAssertionsPassed : simulation.localDiagnosticParityPassed, "SETTLEMENT_UNPROVEN");
    const transactions = simulation.transactions.map(r => {
      const unsigned = simulation.unsignedTransactions.find(t => t.hash === r.transactionHash);
      check(unsigned, "UNSIGNED_TRANSACTION_MISSING");
      return { hash: r.transactionHash, gasUsedRaw: BigInt(r.gasUsed).toString(), effectiveGasPriceWei: BigInt(r.effectiveGasPrice).toString(), gasLimitRaw: BigInt(unsigned.gas).toString(), unsignedSerialized: unsigned.unsignedSerialized };
    });
    const settlement = { status: "PASS", callbackComplete: simulation.scenarioObservations.callbackComplete, bothSwapsComplete: simulation.scenarioObservations.bothSwapsComplete,
      principalRepaidRaw: simulation.principalRepaidRaw, actorBeforeRaw: simulation.actor.beforeRaw, actorAfterRaw: simulation.actor.afterRaw, executorInitialUsdcRaw: simulation.executor.initialUsdcBalanceRaw };
    s.phase = "COST"; s.guard(); const beforeCosts = s.now(), costs = s.costModule();
    const feeObservation = await costs.observeFeeCosts({ pin, read: s.read, unsignedTransactions: transactions.map(({ hash, gasLimitRaw, unsignedSerialized }) => ({ hash, gasLimitRaw, unsignedSerialized })) });
    s.guard();
    const verdict = costs.evaluateCosts({ pin, settlement, transactions, feeObservation, pricing: quote.pricing, allowances: s.spec.allowances });
    s.timings.costMs = s.now() - beforeCosts; s.guard(); s.checkSources(); s.costModule(); await s.headers(); await s.runtime(); s.guard();
    const status = feeObservation?.status === "OBSERVED" && ["UNKNOWN", "NONPOSITIVE", "POSITIVE_AT_PIN"].includes(verdict?.status) ? verdict.status : "UNKNOWN";
    s.completed = true;
    return publicResult(s, diagnostic ? "DIAGNOSTIC_ONLY" : status, { pin, quote, simulation, diagnosticOnly: diagnostic,
      costs: { ...verdict, status, qualifiedAtPin: !diagnostic && status === "POSITIVE_AT_PIN" && verdict.qualifiedAtPin === true, liveReady: false } });
  } catch (e) {
    s.failure ||= safeFailure(e, "CANDIDATE_FAILED", "CANDIDATE"); await s.drain();
    return publicResult(s, "UNKNOWN", { pin, quote, simulation });
  } finally { s.timings.candidateMs = s.now() - started; s.candidate = null; s.phase = "READY"; }
}
// Only external/superseded head waiters join the pipeline; the pipeline itself
// drains owned RPC work without awaiting itself. Retain actual cleanup evidence.
async function settledHeadResult(s, status, extra = {}) {
  let inflight, result;
  do {
    inflight = s.inflight;
    if (inflight) {
      try { result = await inflight; }
      catch (e) { s.failure ||= safeFailure(e, "CANDIDATE_FAILED", "CANDIDATE"); }
    }
    await s.drain();
  } while (inflight !== s.inflight);
  return publicResult(s, s.failure ? "UNKNOWN" : status, { ...extra,
    ...(s.failure && result?.simulation ? { simulation: result.simulation } : {}) });
}
function evaluateHead(ready, head) {
  const s = states.get(ready); check(s, "READY_CAMPAIGN_REQUIRED");
  try {
    pinCheck(head); head = frozen({ ...head }); s.guard();
    check(!s.completed, "CAMPAIGN_CONSUMED");
    if (++s.heads > s.spec.budget.heads) s.invalidate("HEAD_CAP", "BOUNDS");
    if (s.latest && head.number === s.latest.number && head.hash !== s.latest.hash) s.invalidate("HEAD_REORG", "PIN");
    if (s.latest && head.number <= s.latest.number) return settledHeadResult(s, "COALESCED", { pin: head });
    s.latest = head;
    if (s.running) {
      if (s.pendingHead) {
        const superseded = s.pendingHead;
        settledHeadResult(s, "COALESCED", { pin: superseded.head }).then(superseded.resolve);
      }
      return new Promise(resolve => { s.pendingHead = { head, resolve }; });
    }
    s.running = true;
    const work = pin => {
      const inflight = Promise.resolve().then(() => processHead(s, pin)).then(result => {
        const pending = s.pendingHead; s.pendingHead = null;
        if (pending) {
          if (s.failure || s.completed) {
            pending.resolve(publicResult(s, "UNKNOWN", { pin: pending.head,
              ...(s.failure && result.simulation ? { simulation: result.simulation } : {}) })); s.running = false;
          } else work(pending.head).then(pending.resolve);
        } else s.running = false;
        return result;
      });
      s.inflight = inflight; return inflight;
    };
    return work(head);
  } catch (e) { s.failure ||= safeFailure(e, "HEAD_REJECTED", "HEAD"); return settledHeadResult(s, "UNKNOWN"); }
}
function main(argv = process.argv.slice(2)) {
  check(argv.length === 0 || argv.length === 1 && argv[0] === "--check", "CAMPAIGN_CLI_REFUSED");
  return { status: "OFFLINE_CHECK_ONLY", specDefaults: SPEC_DEFAULTS, requiredInputs: ["qualificationPin", "primaryFamily", "runtime", "pointers", "allowances", "anvilSha256", "costModuleSha256"],
    authorityRequired: true, campaignStarted: false, transportCalls: 0, liveReady: false };
}
if (require.main === module) { try { process.stdout.write(JSON.stringify(main()) + "\n"); } catch (_) { process.stderr.write("CAMPAIGN_CLI_REFUSED\n"); process.exitCode = 1; } }
module.exports = Object.freeze({ prepareOffline, qualifyCampaign, evaluateHead, main, SPEC_DEFAULTS, AUTHORITY_FIELDS, ALLOWANCE_KEYS,
  PRIMARY_FAMILIES, LOCAL_FIXED, ROOT_ADDRESSES, GPO, GPO_IMPL, SLOTS, ANVIL, SOURCE_FILES, CORE_SHA });
