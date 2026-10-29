"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { keccak256, Interface } = require("ethers");
const { instantiateRuntime, sha } = require("./run-base-paper-usdplus-source-r11");
const base = require("./run-base-redemption-paper-state-r1");
const { candidatePool } = require("./run-base-paper-cycle-r8");
const { A: CORE, SLOT } = require("./run-base-paper-usdplus-preflight-r10");
const ROOT = path.resolve(__dirname, "..");
const DIR = path.join(ROOT, "reports/raw/fast/base-paper-usdplus-r12");
const COMMIT = "24c2c1082cf9404efbaa1174d1df0ba4ffd5ba12";
const PROXY = "0x687ac878bc93610366b705c385cd0a0038493dbb";
const IMPLEMENTATION = "0xebeac3cd336e592defd6b53548fadde22900d3df";
const VERSION_KEY = "951be35bfb925f743b2709e94829aa6ffc689a2f2fbf04df20008fa6eaf7eccd";
const COMPILER_VERSION = "0.8.17+commit.8df45f5f";
const COMPILER_SHA = "7615e019666f29c7e77b20f9c506dda839a875fbc9baf3322d21348c88c05c69";
const FILES = Object.freeze({
  registry: { path: "pkg/strategies/base/.openzeppelin/base.json", blob: "7415c5513b9274e4bcf3445999e672066d761139" },
  deployment: { path: "pkg/strategies/base/deployments/base/StrategyAave.json", blob: "9ff2b5661a3fd63ba7fa21dc4588e3bfdfdb5de5" }
});
class CashError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = code => { throw new CashError(code); };
function inputFromDeployment(deployment, registry) {
  if (deployment?.address?.toLowerCase() !== PROXY || deployment?.implementation?.toLowerCase() !== IMPLEMENTATION
    || registry?.impls?.[VERSION_KEY]?.address?.toLowerCase() !== IMPLEMENTATION) fail("OFFICIAL_DEPLOYMENT_IDENTITY_MISMATCH");
  if (!Array.isArray(deployment.abi) || !/^0x(?:[0-9a-f]{2})+$/i.test(deployment.deployedBytecode || "")) fail("DEPLOYMENT_ARTIFACT_INVALID");
  let metadata;
  try { metadata = JSON.parse(deployment.metadata); } catch { fail("METADATA_INVALID"); }
  if (metadata.language !== "Solidity" || metadata.compiler?.version !== COMPILER_VERSION
    || JSON.stringify(metadata.settings?.compilationTarget) !== JSON.stringify({ "contracts/StrategyAave.sol": "StrategyAave" })) fail("COMPILATION_IDENTITY_MISMATCH");
  const entries = Object.entries(metadata.sources || {});
  if (!entries.length || entries.length > 100) fail("SOURCE_COUNT_INVALID");
  const sources = {};
  for (const [file, source] of entries) {
    if (!file.endsWith(".sol") || file.length > 250 || /\\|:|\0/.test(file) || file.startsWith("/") || file.split("/").some(p => !p || p === "." || p === "..")) fail("SOURCE_PATH_INVALID");
    if (typeof source.content !== "string" || Buffer.byteLength(source.content) > 1048576 || keccak256(Buffer.from(source.content)) !== source.keccak256) fail("SOURCE_CONTENT_HASH_MISMATCH");
    sources[file] = { content: source.content };
  }
  if (!sources["contracts/StrategyAave.sol"]) fail("PRIMARY_SOURCE_MISSING");
  const settings = structuredClone(metadata.settings);
  delete settings.compilationTarget;
  settings.outputSelection = { "*": { "*": ["abi", "evm.deployedBytecode"], "": ["ast"] } };
  return { language: "Solidity", sources, settings };
}
async function recover() {
  const filename = path.join(DIR, "source-build.json");
  if (fs.existsSync(filename)) fail("RECOVERY_EXISTS_NO_RETRY");
  fs.mkdirSync(DIR, { recursive: true });
  const out = { schema: "base-paper-usdplus-cash-source/v12", generatedAt: new Date().toISOString(), status: "INCOMPLETE", requests: 0,
    repositoryCommit: COMMIT, proxy: PROXY, implementation: IMPLEMENTATION, versionKey: VERSION_KEY, sourceRecords: {},
    cashSourceRuntimeBound: "unknown", quoteEligible: false, withdrawalCapacity: "unknown", signing: false, transactions: 0 };
  try {
    const records = {};
    for (const [name, entry] of Object.entries(FILES)) {
      out.requests++;
      const response = await fetch(`https://raw.githubusercontent.com/ovnstable/ovnstable-core-contracts/${COMMIT}/${entry.path}`, { redirect: "error", signal: AbortSignal.timeout(20000) });
      if (!response.ok) fail("OFFICIAL_SOURCE_HTTP_FAILED");
      const chunks = []; let length = 0;
      for await (const chunk of response.body) {
        length += chunk.length; if (length > 2 * 1048576) fail("OFFICIAL_SOURCE_BYTE_CAP");
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks), blob = crypto.createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
      if (blob !== entry.blob) fail("OFFICIAL_GIT_BLOB_MISMATCH");
      records[name] = JSON.parse(bytes.toString("utf8"));
      fs.writeFileSync(path.join(DIR, `${name}.json`), bytes, { flag: "wx" });
      out.sourceRecords[name] = { ...entry, bytes: bytes.length, sha256: sha(bytes) };
    }
    const input = inputFromDeployment(records.deployment, records.registry), inputText = JSON.stringify(input, null, 2) + "\n";
    fs.writeFileSync(path.join(DIR, "cash.input.json"), inputText, { flag: "wx" });
    for (const [file, source] of Object.entries(input.sources)) {
      const destination = path.join(DIR, "sources", file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, source.content, { flag: "wx" });
    }
    out.sourceCount = Object.keys(input.sources).length;
    out.inputSha256 = sha(inputText);
    const compiler = `C:/Users/MiPC/AppData/Local/Temp/opencode/solc-windows-amd64-v${COMPILER_VERSION}.exe`;
    const stat = fs.lstatSync(compiler);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 32 * 1048576 || sha(fs.readFileSync(compiler)) !== COMPILER_SHA) fail("COMPILER_CHECKSUM_MISMATCH");
    const version = spawnSync(compiler, ["--version"], { encoding: "utf8", timeout: 10000, windowsHide: true });
    if (version.status !== 0 || !version.stdout.includes(`Version: ${COMPILER_VERSION}.Windows.msvc`)) fail("COMPILER_VERSION_MISMATCH");
    const build = spawnSync(compiler, ["--standard-json"], { input: inputText, encoding: "utf8", timeout: 60000, maxBuffer: 32 * 1048576, windowsHide: true });
    if (build.status !== 0) fail("NATIVE_COMPILE_FAILED");
    const result = JSON.parse(build.stdout);
    if ((result.errors || []).some(row => row.severity === "error")) fail("STANDARD_JSON_COMPILE_FAILED");
    const contract = result.contracts?.["contracts/StrategyAave.sol"]?.StrategyAave;
    if (!contract || `0x${contract.evm.deployedBytecode.object}` !== records.deployment.deployedBytecode.toLowerCase()) fail("OFFICIAL_RUNTIME_TEMPLATE_MISMATCH");
    if (JSON.stringify(contract.abi) !== JSON.stringify(records.deployment.abi)) fail("OFFICIAL_ABI_MISMATCH");
    const instantiated = instantiateRuntime(result, contract.evm.deployedBytecode, IMPLEMENTATION);
    out.compiler = COMPILER_VERSION; out.compilerBinarySha256 = COMPILER_SHA;
    out.runtimeLength = (instantiated.runtime.length - 2) / 2;
    out.runtimeKeccak256 = keccak256(instantiated.runtime);
    out.immutableAssignments = instantiated.assignments;
    out.status = "OFFICIAL_CASH_SOURCE_REBUILT_CHAIN_BINDING_REQUIRED";
    fs.writeFileSync(path.join(DIR, "cash.compiled.json"), JSON.stringify({ address: IMPLEMENTATION, inputSha256: out.inputSha256, runtime: instantiated.runtime,
      runtimeKeccak256: out.runtimeKeccak256, abi: contract.abi, immutableAssignments: instantiated.assignments }, null, 2) + "\n", { flag: "wx" });
  } catch (error) { out.code = error instanceof CashError ? error.code : "SOURCE_RECOVERY_FAILED"; }
  out.completedAt = new Date().toISOString();
  fs.writeFileSync(filename, JSON.stringify(out, null, 2) + "\n", { flag: "wx" });
  return out;
}
const AAVE = Object.freeze({ provider: "0xe20fcbdbffc4dd138ce8b2e6fbb6cb49777ad64d", pool: "0xa238dd80c259a72e81d7e4664a9801593f98d1c5", aToken: "0x4e65fe4dba92790696d040ac24aa414708f5c0ab" });
const I = Object.freeze({
  token: new Interface(["function decimals() view returns(uint8)", "function balanceOf(address) view returns(uint256)"]),
  aToken: new Interface(["function UNDERLYING_ASSET_ADDRESS() view returns(address)", "function POOL() view returns(address)"]),
  provider: new Interface(["function getPool() view returns(address)"]),
  pool: new Interface(["function getConfiguration(address) view returns(uint256)", "function getUserAccountData(address) view returns(uint256,uint256,uint256,uint256,uint256,uint256)"])
});
function readCandidates() {
  const file = path.join(ROOT, "rpc_endpoints.txt"), before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 1048576) fail("INVENTORY_UNSAFE");
  const bytes = fs.readFileSync(file);
  try {
    const after = fs.lstatSync(file);
    if (before.size !== bytes.length || ["dev", "ino", "size", "mtimeMs", "ctimeMs"].some(k => before[k] !== after[k])) fail("INVENTORY_CHANGED");
    return candidatePool(bytes.toString("utf8"));
  } finally { bytes.fill(0); }
}
async function state(deps = {}) {
  const clock = deps.clock || Date.now, started = clock(), transport = deps.transport || base.requestJSON;
  const out = { schema: "base-paper-usdplus-cash-state/v12", chainId: 8453, generatedAt: new Date(started).toISOString(), status: "INCOMPLETE", requests: 0, bytes: 0,
    qualification: { attempted: 0, qualified: 0, selectedFamilyCount: 0, failures: {} }, observation: null,
    gates: { cashSourceRuntimeBound: "unknown", withdrawalCapacity: "unknown", fullWithdrawalDependenciesBound: false, quoteEligible: false, profitabilityClaim: false, executableNow: "unknown", signedActionJustified: false },
    safety: { readOnlyRpc: true, inventoryRead: false, endpointMaterialPersisted: false, walletAccess: false, signing: false, transactions: 0, retries: 0 } };
  const safe = e => e instanceof CashError ? e.code : "UNEXPECTED_FAILURE";
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const budget = () => { if (out.requests >= 140 || clock() - started >= 240000) fail("REQUEST_OR_TIME_CAP"); };
  const rpc = async (candidate, method, params) => {
    if (!["eth_chainId", "eth_getBlockByNumber", "eth_getStorageAt", "eth_getCode", "eth_call"].includes(method)) fail("METHOD_FORBIDDEN");
    budget(); if (!deps.transport) await new Promise(resolve => setTimeout(resolve, 200)); budget();
    const id = ++out.requests; let response;
    try { response = await transport(candidate.url, { jsonrpc: "2.0", id, method, params }, Math.min(8000, 240000 - (clock() - started))); }
    catch { fail("TRANSPORT_UNAVAILABLE"); }
    if (clock() - started >= 240000) fail("REQUEST_OR_TIME_CAP");
    if (!response || !Number.isSafeInteger(response.bytes) || response.bytes < 0 || response.bytes > 1048576) fail("RESPONSE_CAP");
    out.bytes += response.bytes; if (out.bytes > 16 * 1048576) fail("TOTAL_BYTE_CAP");
    const body = response.value;
    if (!body || body.jsonrpc !== "2.0" || body.id !== id) fail("RPC_ENVELOPE_INVALID");
    if (Object.hasOwn(body, "error") || !Object.hasOwn(body, "result")) fail("RPC_UNAVAILABLE");
    return body.result;
  };
  const block = pin => ({ blockHash: pin.hash, requireCanonical: true });
  const getHeader = async (candidate, tag) => {
    const raw = await rpc(candidate, "eth_getBlockByNumber", [tag, false]); let pin;
    try { pin = base.header(raw); } catch { fail("HEADER_INVALID"); }
    const age = BigInt(Math.floor(clock() / 1000)) - BigInt(pin.timestamp);
    if (age < -60n || age > 3600n) fail("FINALITY_STALE");
    return pin;
  };
  try {
    if ((deps.compiled || deps.proxyCompiled || deps.candidates || deps.clock) && !deps.transport) fail("INJECTED_TRANSPORT_REQUIRED");
    const compiled = deps.compiled || JSON.parse(fs.readFileSync(path.join(DIR, "cash.compiled.json"), "utf8"));
    const proxyCompiled = deps.proxyCompiled || JSON.parse(fs.readFileSync(path.join(ROOT, "reports/raw/fast/base-paper-usdplus-r11/cash-proxy.compiled.json"), "utf8"));
    for (const [value, address] of [[compiled, IMPLEMENTATION], [proxyCompiled, PROXY]]) {
      if (value.address !== address || !/^0x(?:[0-9a-f]{2})+$/i.test(value.runtime || "") || value.runtime.length > 65538 || keccak256(value.runtime) !== value.runtimeKeccak256) fail("BUILD_EVIDENCE_INVALID");
    }
    if (!deps.compiled) {
      const build = JSON.parse(fs.readFileSync(path.join(DIR, "source-build.json"), "utf8"));
      if (build.status !== "OFFICIAL_CASH_SOURCE_REBUILT_CHAIN_BINDING_REQUIRED" || build.runtimeKeccak256 !== compiled.runtimeKeccak256
        || sha(fs.readFileSync(path.join(DIR, "cash.input.json"))) !== compiled.inputSha256 || build.inputSha256 !== compiled.inputSha256) fail("SOURCE_BUILD_CHANGED");
    }
    const interfaces = { ...I, cash: new Interface(compiled.abi) };
    const allowedTargets = new Set([PROXY, CORE.usdc, ...Object.values(AAVE)]);
    const call = async (candidate, to, type, name, args, pin) => {
      const iface = interfaces[type];
      if (!allowedTargets.has(to) || iface.getFunction(name)?.stateMutability !== "view") fail("NON_VIEW_OR_TARGET_FORBIDDEN");
      const raw = await rpc(candidate, "eth_call", [{ to, data: iface.encodeFunctionData(name, args), gas: "0x1e8480" }, block(pin)]);
      try {
        const values = iface.decodeFunctionResult(name, raw);
        if (iface.encodeFunctionResult(name, values).toLowerCase() !== raw.toLowerCase()) fail("ABI_INVALID");
        return values;
      } catch { fail("ABI_INVALID"); }
    };
    const scalar = async (...args) => (await call(...args))[0];
    const getImpl = async (candidate, pin) => {
      const raw = await rpc(candidate, "eth_getStorageAt", [PROXY, SLOT, block(pin)]);
      try { return base.address(raw); } catch { fail("IMPLEMENTATION_WORD_INVALID"); }
    };
    if (!deps.candidates) out.safety.inventoryRead = true;
    const candidates = deps.candidates || readCandidates();
    if (!Array.isArray(candidates) || candidates.length > 8) fail("CANDIDATE_CAP");
    const qualified = [];
    for (const candidate of candidates) {
      out.qualification.attempted++;
      try {
        if (await rpc(candidate, "eth_chainId", []) !== "0x2105") fail("CHAIN_MISMATCH");
        const pin = await getHeader(candidate, "finalized");
        await getImpl(candidate, pin);
        await scalar(candidate, PROXY, "cash", "usdcToken", [], pin);
        const code = await rpc(candidate, "eth_getCode", [IMPLEMENTATION, block(pin)]);
        if (typeof code !== "string" || !/^0x(?:[0-9a-f]{2})+$/i.test(code)) fail("CODE_INVALID_OR_ABSENT");
        qualified.push({ candidate, pin }); out.qualification.qualified = qualified.length;
      } catch (e) {
        const code = safe(e); out.qualification.failures[code] = (out.qualification.failures[code] || 0) + 1;
        if (["REQUEST_OR_TIME_CAP", "TOTAL_BYTE_CAP"].includes(code)) throw e;
      }
    }
    const selected = [];
    for (const row of qualified) if (row.candidate.family && !selected.some(other => other.candidate.family === row.candidate.family)) selected.push(row);
    if (selected.length < 2) fail("TWO_STATE_CAPABLE_FAMILIES_UNAVAILABLE");
    selected.length = 2; out.qualification.selectedFamilyCount = 2;
    const number = selected.reduce((n, row) => BigInt(row.pin.number) < n ? BigInt(row.pin.number) : n, BigInt(selected[0].pin.number));
    const tag = `0x${number.toString(16)}`, pins = [], views = [];
    for (const { candidate } of selected) pins.push(await getHeader(candidate, tag));
    if (!equal(pins[0], pins[1]) || BigInt(pins[0].number) !== number) fail("PIN_DISAGREEMENT");
    const pin = pins[0];
    for (const { candidate } of selected) {
      for (const value of [compiled, proxyCompiled]) {
        const runtime = await rpc(candidate, "eth_getCode", [value.address, block(pin)]);
        if (typeof runtime !== "string" || runtime.toLowerCase() !== value.runtime) fail("CASH_RUNTIME_MISMATCH");
      }
      if (await getImpl(candidate, pin) !== IMPLEMENTATION) fail("CASH_IMPLEMENTATION_CHANGED");
      const view = { implementation: IMPLEMENTATION, runtimeKeccak256: compiled.runtimeKeccak256, proxyRuntimeKeccak256: proxyCompiled.runtimeKeccak256, fullByteMatch: true, cash: {}, lending: {}, balances: {} };
      for (const name of ["usdcToken", "aUsdcToken", "aaveProvider", "portfolioManager"])
        view.cash[name] = (await scalar(candidate, PROXY, "cash", name, [], pin)).toLowerCase();
      if (view.cash.usdcToken !== CORE.usdc || view.cash.aUsdcToken !== AAVE.aToken || view.cash.aaveProvider !== AAVE.provider || view.cash.portfolioManager !== CORE.manager) fail("CASH_DEPENDENCY_BINDING_MISMATCH");
      view.cash.inLending = await scalar(candidate, PROXY, "cash", "inLending", [], pin);
      for (const name of ["netAssetValue", "liquidationValue", "navSlippageBP"]) view.cash[name] = (await scalar(candidate, PROXY, "cash", name, [], pin)).toString();
      for (const [to, type, getter, expected] of [[AAVE.provider, "provider", "getPool", AAVE.pool], [AAVE.aToken, "aToken", "POOL", AAVE.pool], [AAVE.aToken, "aToken", "UNDERLYING_ASSET_ADDRESS", CORE.usdc]])
        if ((await scalar(candidate, to, type, getter, [], pin)).toLowerCase() !== expected) fail("LENDING_DEPENDENCY_BINDING_MISMATCH");
      for (const token of [CORE.usdc, AAVE.aToken]) if (await scalar(candidate, token, "token", "decimals", [], pin) !== 6n) fail("DECIMALS_MISMATCH");
      view.balances.idleUsdcRaw = (await scalar(candidate, CORE.usdc, "token", "balanceOf", [PROXY], pin)).toString();
      view.balances.aTokenRaw = (await scalar(candidate, AAVE.aToken, "token", "balanceOf", [PROXY], pin)).toString();
      view.balances.usdcAtATokenRaw = (await scalar(candidate, CORE.usdc, "token", "balanceOf", [AAVE.aToken], pin)).toString();
      if (BigInt(view.cash.netAssetValue) !== BigInt(view.balances.idleUsdcRaw) + BigInt(view.balances.aTokenRaw) || view.cash.netAssetValue !== view.cash.liquidationValue) fail("SOURCE_VALUATION_MISMATCH");
      const configuration = await scalar(candidate, AAVE.pool, "pool", "getConfiguration", [CORE.usdc], pin);
      const account = await call(candidate, AAVE.pool, "pool", "getUserAccountData", [PROXY], pin);
      view.lending = { ...AAVE, configurationRaw: configuration.toString(), activeBit56: Boolean(configuration & (1n << 56n)), pausedBit60: Boolean(configuration & (1n << 60n)),
        totalCollateralBase: account[0].toString(), totalDebtBase: account[1].toString(), healthFactorRaw: account[5].toString(), sourceRuntimeBound: "unknown" };
      view.balancesAreWithdrawalProof = false;
      views.push(view);
    }
    if (!equal(views[0], views[1])) fail("OBSERVATION_DISAGREEMENT");
    for (const { candidate } of selected) {
      if (!equal(await getHeader(candidate, tag), pin)) fail("TERMINAL_PIN_CHANGED");
      if (BigInt((await getHeader(candidate, "finalized")).number) < number) fail("FINALITY_REGRESSED");
    }
    out.observation = { pin, rpcStrength: "corroborated-operator-families", upstreamIndependenceProven: false, ...views[0] };
    out.gates.cashSourceRuntimeBound = "true";
    out.status = "CASH_RUNTIME_BOUND_LIQUIDITY_DIAGNOSTIC_ONLY";
    out.code = "WITHDRAWAL_DEPENDENCIES_AND_TRANSFER_SUCCESS_UNPROVEN";
  } catch (e) { out.code = safe(e); }
  out.completedAt = new Date(clock()).toISOString(); return out;
}
async function stateOnce() {
  const filename = path.join(DIR, "cash-state.json");
  if (fs.existsSync(filename)) fail("STATE_CAPTURE_EXISTS_NO_RETRY");
  const out = await state(), encoded = JSON.stringify(out, null, 2) + "\n";
  if (/(?:https?|wss?):\/\//i.test(encoded)) fail("OUTPUT_NOT_SANITIZED");
  fs.writeFileSync(filename, encoded, { flag: "wx" }); return out;
}
module.exports = { inputFromDeployment, recover, state, DIR, COMMIT, PROXY, IMPLEMENTATION, VERSION_KEY, COMPILER_VERSION, AAVE, I };
if (require.main === module) {
  const mode = process.argv.slice(2).join(" ");
  if (!["--recover-once", "--state-once"].includes(mode)) throw new Error("EXPLICIT_RECOVERY_OR_STATE_REQUIRED");
  (mode === "--recover-once" ? recover() : stateOnce()).then(out => { console.log(JSON.stringify(out)); if (out.status === "INCOMPLETE") process.exitCode = 1; }).catch(() => { console.error("R12_FAILED_CLOSED"); process.exitCode = 1; });
}
