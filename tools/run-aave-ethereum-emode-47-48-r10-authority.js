#!/usr/bin/env node
"use strict";

const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, ".."), SCHEMA = "aave-ethereum-emode-47-48-r10-authority/v1";
const RUNNER = "tools/run-aave-ethereum-emode-47-48-r10-authority.js";
const TEST = "tools/test-run-aave-ethereum-emode-47-48-r10-authority.js";
const OUTPUT = "reports/raw/fast/aave-ethereum-emode-47-48-r10-authority.json";
const ATTEMPT = "reports/raw/fast/aave-ethereum-emode-47-48-r10-authority-attempt.json";
const SOURCE = "reports/raw/fast/aave-ethereum-emode-47-48-r9-source";
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function pinned(file, hash) {
  const full = path.resolve(ROOT, file), before = fs.lstatSync(full);
  if (!before.isFile() || before.isSymbolicLink() || before.size > 64 * 1024 * 1024
    || path.resolve(fs.realpathSync(full)) !== full) throw Error("SOURCE_PIN_MISMATCH");
  const bytes = fs.readFileSync(full), after = fs.lstatSync(full);
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || sha(bytes) !== hash) throw Error("SOURCE_PIN_MISMATCH");
  return bytes;
}
const PRIOR = Object.freeze({
  "tools/run-aave-ethereum-emode-47-48-r9-authority.js": "9067ad27046bf183e55b72c02271ae13033d9a41e2402dc239dc96d35eb0e033",
  "tools/test-run-aave-ethereum-emode-47-48-r9-authority.js": "b15342b9644122b1f522d8eca154781f5144ae74f401fa2f27fdd95c1be19fcc",
  "reports/raw/fast/aave-ethereum-emode-47-48-r9-authority.json": "9210597410be160f6755d00ee480f019b2631fe9f948a06b5ba4b15e7dbb1fe9",
  "reports/raw/fast/aave-ethereum-emode-47-48-r9-authority-attempt.json": "a0f6d93462cd4eeefa080e18b9a61d89b4e4075eecd9034fb207b18c74cb2c6b"
});
pinned("tools/run-aave-ethereum-emode-47-48-r9-authority.js", PRIOR["tools/run-aave-ethereum-emode-47-48-r9-authority.js"]);
const r9 = require("./run-aave-ethereum-emode-47-48-r9-authority.js");
r9.authority();
const r4 = require("./run-aave-ethereum-emode-47-48-r4.js"), { stable } = r4;
const pf = require("./lib/common-finalized-rpc-preflight.js");
const { A, PIN, BLOCK, ADMIN_SLOT, specs, allow } = r9;
const LIMITS = Object.freeze({ candidates: 8, calls: 112, requestMs: 10000, wallMs: 120000, responseBytes: 262144, totalBytes: 4194304 });
const CODES = new Set(["NONE", "INPUT_INVALID", "RPC_UNAVAILABLE", "REQUEST_FORBIDDEN", "CHAIN_MISMATCH", "FINALITY_UNAVAILABLE",
  "HISTORICAL_HEADER_MISMATCH", "SLOT_INVALID", "CALL_INVALID", "STATE_DISAGREEMENT", "STATE_CONSENSUS_UNAVAILABLE",
  "TERMINAL_RECHECK_FAILED", "NETWORK_CALL_CAP", "BYTE_CAP", "WALL_CAP", "OUTPUT_INVALID", "ATTEMPT_CONSUMED", "INVOCATION_INVALID", "UNEXPECTED"]);
class R10Error extends Error { constructor(code) { super(CODES.has(code) ? code : "UNEXPECTED"); this.code = this.message; } }
const fail = code => { throw new R10Error(code); };
const safe = error => [R10Error, r9.E, r4.R4Error].some(Type => error instanceof Type) && CODES.has(error.code) ? error.code : "UNEXPECTED";
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join() === [...keys].sort().join();
const address = value => typeof value === "string" && /^0x[0-9a-f]{40}$/.test(value);
const gates = success => ({ configEngineExactRuntimeMatch: true, authorityTopologyCorroborated: success, completeRuntimeBinding: false,
  completeAuthorityVerification: false, effectiveRangeSemanticsBound: false, routePositive: "unknown", executableNow: "unknown", signedActionJustified: false, fork: false });

function reviewPrior() {
  const hashes = { ...PRIOR, ...r9.PINS };
  for (const [file, hash] of Object.entries(hashes)) pinned(file, hash);
  const json = file => JSON.parse(fs.readFileSync(path.join(ROOT, file)));
  const report = json(`${SOURCE}/report.json`);
  for (const [name, hash] of Object.entries(report.files)) {
    if (!/^[A-Za-z0-9.-]+$/.test(name)) fail("INPUT_INVALID");
    hashes[`${SOURCE}/${name}`] = hash; pinned(`${SOURCE}/${name}`, hash);
  }
  const inputPins = json(`${SOURCE}/input-pins.json`);
  for (const [file, hash] of Object.entries(inputPins)) { hashes[file] = hash; pinned(file, hash); }
  const builder = require("./build-aave-ethereum-emode-47-48-r9.js");
  const bundle = { report, input: json(`${SOURCE}/compiler.input.json`), output: json(`${SOURCE}/compiler.output.json`),
    originalText: fs.readFileSync(path.join(ROOT, SOURCE, "published.input.json"), "utf8"),
    editorText: fs.readFileSync(path.join(ROOT, SOURCE, "editor.bundle.json"), "utf8"),
    runtime: json(`${SOURCE}/runtime.json`), sources: json(`${SOURCE}/sources.json`) };
  builder.validateBundle(bundle);
  const metadata = JSON.parse(bundle.output.contracts[builder.TARGET].AaveV3ConfigEngine.metadata);
  for (const [file, source] of Object.entries(metadata.sources)) if (bundle.sources[file]?.keccak256 !== source.keccak256) fail("INPUT_INVALID");
  const r3 = r9.authority().r3, prior = json("reports/raw/fast/aave-ethereum-emode-47-48-r9-authority.json");
  if (stable(report.historicalPin) !== stable(PIN) || stable(r3.report.pin) !== stable(PIN)
    || prior.sha256 !== sha(stable(prior.report)) || r3.sha256 !== sha(stable(r3.report))
    || prior.report.observation !== null || prior.report.callsUsed !== 5 || prior.report.transportRequestAttempts !== 4
    || r3.report.observations.current.code.engine.keccak256 !== report.compiledIdentity.keccak256
    || r3.report.observations.current.code.engine.bytes !== report.compiledIdentity.bytes) fail("INPUT_INVALID");
  const context = specs.find(s => s.key === "agentContext");
  let slotRejected = false, contextRejected = false;
  try { r4.allowRequest("eth_getStorageAt", [A.hub, ADMIN_SLOT, BLOCK]); } catch (error) { slotRejected = safe(error) === "REQUEST_FORBIDDEN"; }
  try { r9.decode(context, context.iface.encodeFunctionResult(context.fn, [`0x${"0".repeat(24)}${A.engine.slice(2)}`])); }
  catch (error) { contextRejected = safe(error) === "CALL_INVALID"; }
  const promoted = structuredClone(prior.report); promoted.gates.routePositive = true;
  if (!slotRejected || !contextRejected || r9.validate(promoted) !== true) fail("INPUT_INVALID");
  return { hashes, review: { sourceBundle: "PASS", files: Object.keys(report.files).length, sources: Object.keys(bundle.sources).length,
    runtimeBytes: report.compiledIdentity.bytes, runtimeKeccak256: report.compiledIdentity.keccak256,
    r9CommitmentVerified: true, rejectedStage: "hubProxyAdmin", r9ContextDecoderDefect: true, r9GateValidatorDefect: true,
    compilationRepeated: false, network: false } };
}

function decode(spec, raw) {
  if (spec.kind !== "context") return r9.decode(spec, raw);
  try {
    const decoded = spec.iface.decodeFunctionResult(spec.fn, raw), value = decoded[0].toLowerCase();
    if (spec.iface.encodeFunctionResult(spec.fn, decoded).toLowerCase() !== raw.toLowerCase() || !/^0x0{24}[0-9a-f]{40}$/.test(value)) fail("CALL_INVALID");
    return `0x${value.slice(-40)}`;
  } catch (error) { if (error instanceof R10Error) throw error; fail("CALL_INVALID"); }
}

// Own transport policy: do not route this request set through the consumed R4 transport.
function createTransport(candidates, options = {}) {
  const request = options.request || require("node:https").request;
  const monotonic = options.monotonic || (() => require("node:perf_hooks").performance.now());
  const deadline = monotonic() + LIMITS.wallMs, handles = new Set(candidates.map(c => c.handle));
  let calls = 0, totalBytes = 0, fatal = null;
  return Object.freeze({
    get stats() { return { calls, responseBytes: totalBytes }; },
    async call(handle, method, params, timeout = LIMITS.requestMs) {
      allow(method, params);
      if (fatal) fail(fatal);
      if (!handles.has(handle)) fail("REQUEST_FORBIDDEN");
      if (calls >= LIMITS.calls) fail("NETWORK_CALL_CAP");
      if (monotonic() >= deadline) fail("WALL_CAP");
      const url = handle.url;
      if (!(url instanceof URL) || url.protocol !== "https:" || url.username || url.password || url.hash) fail("REQUEST_FORBIDDEN");
      const id = ++calls, body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      return new Promise((resolve, reject) => {
        let req, done = false, size = 0; const chunks = [];
        const finish = (error, value) => {
          if (done) return;
          done = true; clearTimeout(timer);
          if (error && ["BYTE_CAP", "WALL_CAP"].includes(safe(error))) fatal = safe(error);
          try { req?.destroy(); } catch (_) {}
          chunks.length = 0; error ? reject(error) : resolve(value);
        };
        const timer = setTimeout(() => finish(new R10Error(monotonic() >= deadline ? "WALL_CAP" : "RPC_UNAVAILABLE")),
          Math.max(1, Math.min(timeout, LIMITS.requestMs, deadline - monotonic())));
        try {
          req = request({ protocol: "https:", hostname: url.hostname, port: url.port || 443, path: `${url.pathname}${url.search}`,
            method: "POST", agent: false, rejectUnauthorized: true,
            headers: { ...(handle.headers || {}), ...(handle.origin ? { origin: handle.origin } : {}), "content-type": "application/json",
              accept: "application/json", "accept-encoding": "identity", "content-length": body.length } }, res => {
            res.on("data", chunk => {
              if (done) return;
              size += chunk.length; totalBytes += chunk.length;
              if (monotonic() >= deadline) finish(new R10Error("WALL_CAP"));
              else if (size > LIMITS.responseBytes || totalBytes > LIMITS.totalBytes) finish(new R10Error("BYTE_CAP"));
              else chunks.push(Buffer.from(chunk));
            });
            res.on("end", () => { if (done) return; try {
              if (monotonic() >= deadline) fail("WALL_CAP");
              const raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              if (res.statusCode !== 200 || !exactKeys(raw, ["jsonrpc", "id", "result"]) || raw.jsonrpc !== "2.0" || raw.id !== id) fail("RPC_UNAVAILABLE");
              finish(null, raw.result);
            } catch (error) { finish(error instanceof R10Error ? error : new R10Error("RPC_UNAVAILABLE")); } });
            res.on("error", () => finish(new R10Error("RPC_UNAVAILABLE")));
            res.on("aborted", () => finish(new R10Error("RPC_UNAVAILABLE")));
          });
          req.on("error", () => finish(new R10Error("RPC_UNAVAILABLE"))); req.end(body);
        } catch (_) { finish(new R10Error("RPC_UNAVAILABLE")); }
      });
    }
  });
}

function template(now) {
  return { schema: SCHEMA, status: "INCOMPLETE", code: "STATE_CONSENSUS_UNAVAILABLE", startedAt: new Date(now()).toISOString(), completedAt: null,
    pin: PIN, callsUsed: 0, selectedCandidateOrdinals: [], failures: [], observation: null, gates: gates(false) };
}
async function collect({ candidates, transport, now = Date.now }) {
  if (!Array.isArray(candidates) || candidates.length < 2 || candidates.length > LIMITS.candidates
    || candidates.some(c => !c || pf.reviewedOperatorFamily(c.operatorFamily) !== c.operatorFamily)
    || new Set(candidates.map(c => c.handle)).size !== candidates.length) fail("INPUT_INVALID");
  const report = template(now), rows = []; let stage = "chain";
  const call = async (handle, method, params, timeout) => {
    allow(method, params); if (report.callsUsed >= LIMITS.calls) fail("NETWORK_CALL_CAP");
    report.callsUsed++; return transport.call(handle, method, params, timeout);
  };
  const header = raw => { if (stable(pf.normalizeHeader(raw)) !== stable(PIN)) fail("HISTORICAL_HEADER_MISMATCH"); };
  const observe = async handle => {
    stage = "chain"; if (await call(handle, "eth_chainId", [], 3500) !== "0x1") fail("CHAIN_MISMATCH");
    stage = "finality"; const final = pf.normalizeHeader(await call(handle, "eth_getBlockByNumber", ["finalized", false], 6000));
    if (!final || final.number < PIN.number || final.number === PIN.number && stable(final) !== stable(PIN)) fail("FINALITY_UNAVAILABLE");
    stage = "header"; header(await call(handle, "eth_getBlockByNumber", [`0x${PIN.number.toString(16)}`, false], 6000));
    stage = "hubProxyAdmin"; const observation = { hubProxyAdmin: r4.decodeSlot(await call(handle, "eth_getStorageAt", [A.hub, ADMIN_SLOT, BLOCK], 8000)) };
    for (const spec of specs) { stage = spec.key; observation[spec.key] = decode(spec, await call(handle, "eth_call", [{ to: spec.target, data: spec.data }, BLOCK], 8000)); }
    stage = "header"; header(await call(handle, "eth_getBlockByNumber", [`0x${PIN.number.toString(16)}`, false], 6000));
    return observation;
  };
  const failure = (ordinal, phase, error) => { const code = safe(error); report.failures.push({ ordinal, phase, stage, code }); return code; };
  const finish = () => { report.completedAt = new Date(now()).toISOString(); return report; };
  for (let ordinal = 0; ordinal < candidates.length; ordinal++) {
    try {
      const observation = await observe(candidates[ordinal].handle);
      if (rows.length && stable(observation) !== stable(rows[0].observation)) { report.code = "STATE_DISAGREEMENT"; return finish(); }
      if (!rows.some(row => row.family === candidates[ordinal].operatorFamily)) rows.push({ ordinal, family: candidates[ordinal].operatorFamily, observation });
      if (rows.length === 2) break;
    } catch (error) {
      const code = failure(ordinal, "qualification", error);
      if (["BYTE_CAP", "WALL_CAP", "NETWORK_CALL_CAP", "REQUEST_FORBIDDEN", "UNEXPECTED"].includes(code)) { report.code = code; return finish(); }
    }
  }
  if (rows.length !== 2) return finish();
  for (const row of rows) try {
    if (stable(await observe(candidates[row.ordinal].handle)) !== stable(row.observation)) fail("TERMINAL_RECHECK_FAILED");
  } catch (error) { report.code = failure(row.ordinal, "terminal", error); return finish(); }
  report.status = "CORROBORATED_AUTHORITY_TOPOLOGY"; report.code = "NONE";
  report.selectedCandidateOrdinals = rows.map(row => row.ordinal); report.observation = rows[0].observation; report.gates = gates(true);
  return finish();
}

function validate(report, expectedHashes) {
  const success = report?.status === "CORROBORATED_AUTHORITY_TOPOLOGY";
  if (!exactKeys(report, ["schema", "status", "code", "startedAt", "completedAt", "pin", "callsUsed", "selectedCandidateOrdinals", "failures", "observation", "gates",
    "executionMode", "inventoryReadAttempts", "inventoryReads", "transportRequestAttempts", "responseBytes", "sourceHashes"])
    || report.schema !== SCHEMA || !["INCOMPLETE", "CORROBORATED_AUTHORITY_TOPOLOGY"].includes(report.status)
    || !CODES.has(report.code) || success !== (report.code === "NONE") || stable(report.pin) !== stable(PIN)
    || !Number.isSafeInteger(report.callsUsed) || report.callsUsed < 0 || report.callsUsed > LIMITS.calls
    || !Number.isSafeInteger(report.transportRequestAttempts) || report.transportRequestAttempts < 0 || report.transportRequestAttempts > report.callsUsed
    || !Number.isSafeInteger(report.responseBytes) || report.responseBytes < 0 || report.responseBytes > LIMITS.totalBytes + LIMITS.responseBytes
    || !Number.isFinite(Date.parse(report.startedAt)) || !Number.isFinite(Date.parse(report.completedAt)) || Date.parse(report.completedAt) < Date.parse(report.startedAt)
    || stable(report.gates) !== stable(gates(success)) || stable(report.sourceHashes) !== stable(expectedHashes)
    || !["production", "injected"].includes(report.executionMode)
    || ![0, 1].includes(report.inventoryReadAttempts) || ![0, 1].includes(report.inventoryReads) || report.inventoryReads > report.inventoryReadAttempts
    || report.executionMode === "injected" && report.inventoryReadAttempts !== 0
    || success && (report.callsUsed < 52 || report.callsUsed !== report.transportRequestAttempts || report.executionMode === "production" && report.inventoryReads !== 1)
    || !Array.isArray(report.selectedCandidateOrdinals) || report.selectedCandidateOrdinals.length !== (success ? 2 : 0)
    || new Set(report.selectedCandidateOrdinals).size !== report.selectedCandidateOrdinals.length
    || report.selectedCandidateOrdinals.some(n => !Number.isInteger(n) || n < 0 || n >= LIMITS.candidates)
    || !Array.isArray(report.failures) || report.failures.length > LIMITS.candidates + 1) fail("OUTPUT_INVALID");
  for (const row of report.failures) if (!exactKeys(row, ["ordinal", "phase", "stage", "code"]) || !Number.isInteger(row.ordinal) || row.ordinal < 0 || row.ordinal >= LIMITS.candidates
    || !["qualification", "terminal"].includes(row.phase) || !["chain", "finality", "header", "hubProxyAdmin", ...specs.map(s => s.key)].includes(row.stage)
    || !CODES.has(row.code) || row.code === "NONE") fail("OUTPUT_INVALID");
  if (success) {
    const o = report.observation;
    if (!exactKeys(o, ["hubProxyAdmin", ...specs.map(s => s.key)])
      || ["hubProxyAdmin", "hubOwner", "agentAdmin", "agentContext", "aclAdmin", "riskOracleOwner"].some(key => !address(o[key]))
      || ["agentRiskAdmin", "forwarderAuthorized", "routerAuthorized"].some(key => typeof o[key] !== "boolean")) fail("OUTPUT_INVALID");
  } else if (report.observation !== null) fail("OUTPUT_INVALID");
  if (/https?:\/\/|authorization|bearer\s|api[_-]?key/i.test(stable(report))) fail("OUTPUT_INVALID");
  return true;
}

function invocationGuard(env = process.env, execArgv = process.execArgv) {
  if (execArgv.length || ["NODE_OPTIONS", "NODE_DEBUG", "NODE_DEBUG_NATIVE", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED",
    "NODE_USE_ENV_PROXY", "SSLKEYLOGFILE"].some(name => env[name])) fail("INVOCATION_INVALID");
}
async function runOnce(options = {}) {
  invocationGuard();
  const injected = Object.keys(options).length > 0;
  if (injected && (!exactKeys(options, ["root", "candidates", "request"]) || typeof options.request !== "function" || !Array.isArray(options.candidates)
    || typeof options.root !== "string" || path.resolve(fs.realpathSync(options.root)) !== path.resolve(options.root)
    || path.resolve(options.root) === ROOT || path.resolve(options.root).startsWith(`${ROOT}${path.sep}`))) fail("INPUT_INVALID");
  if (!injected && require.main !== module) fail("INVOCATION_INVALID");
  const root = injected ? path.resolve(options.root) : ROOT, authority = reviewPrior();
  const hashes = { ...authority.hashes, [RUNNER]: sha(fs.readFileSync(__filename)), [TEST]: sha(fs.readFileSync(path.join(ROOT, TEST))) };
  const inventory = require("./preflight-all-chain-endpoints-v4.js");
  inventory.safeParent(root, OUTPUT, { create: false }); inventory.safeParent(root, ATTEMPT, { create: false });
  const output = path.join(root, OUTPUT), attempt = path.join(root, ATTEMPT);
  if (fs.existsSync(output) || fs.existsSync(attempt)) fail("ATTEMPT_CONSUMED");
  const executionMode = injected ? "injected" : "production";
  r4.writeExclusive(attempt, { schema: `${SCHEMA}/attempt`, startedAt: new Date().toISOString(), executionMode, allowedRuns: 1, retries: 0, sourceHashes: hashes });
  let report = template(Date.now), transport, inventoryReadAttempts = 0, inventoryReads = 0;
  try {
    let candidates = options.candidates;
    if (!injected) {
      inventoryReadAttempts++;
      const source = inventory.readSource("rpc_endpoints.txt", { root }); inventoryReads++;
      candidates = require("./run-aave-ethereum-emode-47-48-r3.js").selectCandidates(inventory.parsePrimaryRpcGrammar(source.text).records);
    }
    transport = createTransport(candidates, injected ? { request: options.request } : {});
    report = await collect({ candidates, transport });
  } catch (error) { report.code = safe(error); report.completedAt = new Date().toISOString(); report.callsUsed = transport?.stats.calls || 0; }
  Object.assign(report, { executionMode, inventoryReadAttempts, inventoryReads, transportRequestAttempts: transport?.stats.calls || 0,
    responseBytes: transport?.stats.responseBytes || 0, sourceHashes: hashes });
  for (const [file, hash] of Object.entries(hashes)) pinned(file, hash);
  validate(report, hashes);
  const envelope = { sha256: sha(stable(report)), report }; r4.writeExclusive(output, envelope); return envelope;
}

function reviewCapture(root = ROOT) {
  const prior = reviewPrior(), hashes = { ...prior.hashes, [RUNNER]: sha(fs.readFileSync(__filename)), [TEST]: sha(fs.readFileSync(path.join(ROOT, TEST))) };
  const read = relative => {
    const file = path.resolve(root, relative), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 131072 || path.resolve(fs.realpathSync(file)) !== file) fail("OUTPUT_INVALID");
    return fs.readFileSync(file);
  };
  const bytes = read(OUTPUT), attemptBytes = read(ATTEMPT), envelope = JSON.parse(bytes), attempt = JSON.parse(attemptBytes);
  if (!exactKeys(envelope, ["sha256", "report"]) || envelope.sha256 !== sha(stable(envelope.report))
    || !exactKeys(attempt, ["schema", "startedAt", "executionMode", "allowedRuns", "retries", "sourceHashes"])
    || attempt.schema !== `${SCHEMA}/attempt` || attempt.allowedRuns !== 1 || attempt.retries !== 0
    || attempt.executionMode !== envelope.report.executionMode || stable(attempt.sourceHashes) !== stable(hashes)
    || !Number.isFinite(Date.parse(attempt.startedAt)) || Date.parse(attempt.startedAt) > Date.parse(envelope.report.startedAt)
    || path.resolve(root) === ROOT && envelope.report.executionMode !== "production") fail("OUTPUT_INVALID");
  validate(envelope.report, hashes);
  const report = envelope.report, views = r9.authority().r3.report.observations.current.views, o = report.observation;
  return { status: report.status, code: report.code, artifactCommitmentVerified: true, sourcePinsVerified: Object.keys(hashes).length,
    reportCommitment: envelope.sha256, resultFileSha256: sha(bytes), attemptFileSha256: sha(attemptBytes),
    callsUsed: report.callsUsed, transportRequestAttempts: report.transportRequestAttempts, inventoryReads: report.inventoryReads,
    selectedCandidateOrdinals: report.selectedCandidateOrdinals, failures: report.failures, observation: o,
    priorStateConsistency: o ? { agentAdmin: o.agentAdmin === views["hub.getAgentAdmin"], agentContext: o.agentContext === views["hub.getAgentContext"],
      agentRiskAdmin: o.agentRiskAdmin === views["agent.isRiskAdmin"] } : null,
    completeAuthorityVerified: false, currentStateRefreshed: false, network: false };
}

async function main(argv = process.argv.slice(2)) {
  try {
    invocationGuard();
    if (argv.length !== 1 || !["--check", "--review", "--run-once"].includes(argv[0])) fail("INVOCATION_INVALID");
    if (argv[0] === "--check") { console.log(JSON.stringify(reviewPrior().review)); return; }
    if (argv[0] === "--review") { console.log(JSON.stringify(reviewCapture())); return; }
    const { sha256, report } = await runOnce();
    console.log(JSON.stringify({ status: report.status, code: report.code, callsUsed: report.callsUsed, transportRequestAttempts: report.transportRequestAttempts, output: OUTPUT, sha256 }));
    if (report.status === "INCOMPLETE") process.exitCode = 2;
  } catch (error) { console.log(JSON.stringify({ status: "REFUSED_OR_FAILED", code: safe(error) })); process.exitCode = 2; }
}
if (require.main === module) main();
module.exports = { ROOT, SCHEMA, RUNNER, TEST, OUTPUT, ATTEMPT, PRIOR, A, PIN, BLOCK, ADMIN_SLOT, specs, LIMITS,
  R10Error, sha, stable, safe, gates, reviewPrior, decode, createTransport, collect, validate, invocationGuard, runOnce, reviewCapture };
