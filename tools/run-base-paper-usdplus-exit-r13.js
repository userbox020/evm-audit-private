"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { keccak256, Interface, id } = require("ethers");
const { instantiateRuntime, sha, normalize: normalizeExplorer } = require("./run-base-paper-usdplus-source-r11");
const { COMMIT } = require("./run-base-paper-usdplus-cash-r12");
const { A: CORE, SLOT } = require("./run-base-paper-usdplus-preflight-r10");
const base = require("./run-base-redemption-paper-state-r1");
const { candidatePool } = require("./run-base-paper-cycle-r8");
const { PROXY: CASH, IMPLEMENTATION: CASH_IMPLEMENTATION } = require("./run-base-paper-usdplus-cash-r12");
const ROOT = path.resolve(__dirname, "..");
const DIR = path.join(ROOT, "reports/raw/fast/base-paper-usdplus-r13");
const VERSION = "0.8.17+commit.8df45f5f";
const COMPILER_SHA = "7615e019666f29c7e77b20f9c506dda839a875fbc9baf3322d21348c88c05c69";
const CONTRACTS = Object.freeze({
  token: { name: "UsdPlusToken", proxy: CORE.usdPlus, implementation: "0x332acfd3febcb57a0ca8260942919d27bc77697b", blob: "01cc6836434d713a1b02e764f88b7a44ee67aa81" },
  role: { name: "RoleManager", proxy: "0xa5096260710d135f9c3762fcd07b6b2e2fd127d1", implementation: "0x3e1f4163a61113e8a11b72d4cb388f7cb609d3a2", blob: "6e8e32eb6785f49dcb6a1f0b194583a8efe6ccae" }
});
class ExitError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = code => { throw new ExitError(code); };
function normalize(deployment, expected) {
  if (deployment?.address?.toLowerCase() !== expected.proxy || deployment?.implementation?.toLowerCase() !== expected.implementation) fail("OFFICIAL_IDENTITY_MISMATCH");
  const metadata = JSON.parse(deployment.metadata);
  const file = `contracts/${expected.name}.sol`;
  if (metadata.language !== "Solidity" || metadata.compiler?.version !== VERSION || JSON.stringify(metadata.settings?.compilationTarget) !== JSON.stringify({ [file]: expected.name })) fail("COMPILATION_IDENTITY_MISMATCH");
  const sources = {}, entries = Object.entries(metadata.sources || {});
  if (entries.length < 1 || entries.length > 100) fail("SOURCE_COUNT_INVALID");
  for (const [name, source] of entries) {
    if (!name.endsWith(".sol") || name.length > 250 || /\\|:|\0/.test(name) || name.startsWith("/") || name.split("/").some(p => !p || p === "." || p === "..")) fail("SOURCE_PATH_INVALID");
    if (typeof source.content !== "string" || Buffer.byteLength(source.content) > 1048576 || keccak256(Buffer.from(source.content)) !== source.keccak256) fail("SOURCE_HASH_MISMATCH");
    sources[name] = { content: source.content };
  }
  if (!sources[file] || !Array.isArray(deployment.abi) || !/^0x(?:[0-9a-f]{2})+$/i.test(deployment.deployedBytecode || "")) fail("DEPLOYMENT_INCOMPLETE");
  const settings = structuredClone(metadata.settings);
  delete settings.compilationTarget;
  settings.outputSelection = { "*": { "*": ["abi", "evm.deployedBytecode"], "": ["ast"] } };
  return { language: "Solidity", sources, settings };
}
async function sources() {
  const filename = path.join(DIR, "source-build.json");
  if (fs.existsSync(filename)) fail("SOURCE_CAPTURE_EXISTS_NO_RETRY");
  fs.mkdirSync(DIR, { recursive: true });
  const out = { schema: "base-paper-usdplus-exit-source/v13", generatedAt: new Date().toISOString(), status: "INCOMPLETE", requests: 0,
    repositoryCommit: COMMIT, contracts: {}, quoteEligible: false, fullExitVerified: false, signing: false, transactions: 0 };
  try {
    const compiler = `C:/Users/MiPC/AppData/Local/Temp/opencode/solc-windows-amd64-v${VERSION}.exe`, stat = fs.lstatSync(compiler);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 32 * 1048576 || sha(fs.readFileSync(compiler)) !== COMPILER_SHA) fail("COMPILER_CHECKSUM_MISMATCH");
    const version = spawnSync(compiler, ["--version"], { encoding: "utf8", timeout: 10000, windowsHide: true });
    if (version.status !== 0 || !version.stdout.includes(`Version: ${VERSION}.Windows.msvc`)) fail("COMPILER_VERSION_MISMATCH");
    for (const [label, expected] of Object.entries(CONTRACTS)) {
      out.requests++;
      const response = await fetch(`https://raw.githubusercontent.com/ovnstable/ovnstable-core-contracts/${COMMIT}/pkg/core/deployments/base/${expected.name}.json`, { redirect: "error", signal: AbortSignal.timeout(20000) });
      if (!response.ok) fail("SOURCE_HTTP_FAILED");
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; if (size > 2 * 1048576) fail("SOURCE_BYTE_CAP"); chunks.push(chunk); }
      const bytes = Buffer.concat(chunks), blob = crypto.createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
      if (blob !== expected.blob) fail("OFFICIAL_BLOB_MISMATCH");
      const deployment = JSON.parse(bytes.toString("utf8")), input = normalize(deployment, expected), inputText = JSON.stringify(input, null, 2) + "\n";
      fs.writeFileSync(path.join(DIR, `${label}.deployment.json`), bytes, { flag: "wx" });
      fs.writeFileSync(path.join(DIR, `${label}.input.json`), inputText, { flag: "wx" });
      for (const [file, source] of Object.entries(input.sources)) {
        const destination = path.join(DIR, label, file);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, source.content, { flag: "wx" });
      }
      const build = spawnSync(compiler, ["--standard-json"], { input: inputText, encoding: "utf8", timeout: 60000, maxBuffer: 32 * 1048576, windowsHide: true });
      if (build.status !== 0) fail("NATIVE_COMPILE_FAILED");
      const output = JSON.parse(build.stdout);
      if ((output.errors || []).some(row => row.severity === "error")) fail("STANDARD_JSON_COMPILE_FAILED");
      const contract = output.contracts?.[`contracts/${expected.name}.sol`]?.[expected.name];
      if (!contract || `0x${contract.evm.deployedBytecode.object}` !== deployment.deployedBytecode.toLowerCase() || JSON.stringify(contract.abi) !== JSON.stringify(deployment.abi)) fail("OFFICIAL_TEMPLATE_OR_ABI_MISMATCH");
      const instantiated = instantiateRuntime(output, contract.evm.deployedBytecode, expected.implementation);
      const evidence = { ...expected, address: expected.implementation, compiler: VERSION, compilerBinarySha256: COMPILER_SHA, sourceCount: Object.keys(input.sources).length,
        inputSha256: sha(inputText), runtimeKeccak256: keccak256(instantiated.runtime), runtimeLength: (instantiated.runtime.length - 2) / 2, immutableAssignments: instantiated.assignments };
      fs.writeFileSync(path.join(DIR, `${label}.compiled.json`), JSON.stringify({ ...evidence, runtime: instantiated.runtime, abi: contract.abi }, null, 2) + "\n", { flag: "wx" });
      out.contracts[label] = evidence;
    }
    out.status = "TOKEN_ROLE_SOURCE_REBUILT_CHAIN_BINDING_REQUIRED";
  } catch (error) { out.code = error instanceof ExitError ? error.code : "SOURCE_BUILD_FAILED"; }
  out.completedAt = new Date().toISOString();
  fs.writeFileSync(filename, JSON.stringify(out, null, 2) + "\n", { flag: "wx" }); return out;
}
const PAPER_ACTOR = "0x000000000000000000000000000000000000b0b0";
const VENUE = "0x0c1a09d5d0445047da3ab4994262b22404288a3b";
const ZERO = "0x" + "00".repeat(20);
const ACTIVE_TOKEN = "0xe1201f02c02e468c7ff6f61afff505a859673cfd";
const ACTIVE_TOKEN_COMMIT = "32f136dfbea3edd7629d5ecdbaaac8471c3b1f08";
const ACTIVE_TOKEN_BLOB = "1701f65ddf3b551768d31a7e9c26903bd817bc0c";
async function historicalTokenSource() {
  const filename = path.join(DIR, "active-token-exact-build.json");
  if (fs.existsSync(filename)) fail("EXACT_TOKEN_SOURCE_EXISTS_NO_RETRY");
  const out = { schema: "base-paper-usdplus-active-token-exact/v13", generatedAt: new Date().toISOString(), status: "INCOMPLETE", requests: 1,
    repositoryCommit: ACTIVE_TOKEN_COMMIT, blob: ACTIVE_TOKEN_BLOB, implementation: ACTIVE_TOKEN, quoteEligible: false, signing: false, transactions: 0 };
  try {
    const response = await fetch(`https://raw.githubusercontent.com/ovnstable/ovnstable-core-contracts/${ACTIVE_TOKEN_COMMIT}/pkg/core/deployments/base/UsdPlusToken.json`, { redirect: "error", signal: AbortSignal.timeout(20000) });
    if (!response.ok) fail("HISTORICAL_TOKEN_HTTP_FAILED");
    const chunks = []; let length = 0;
    for await (const chunk of response.body) { length += chunk.length; if (length > 1048576) fail("HISTORICAL_TOKEN_BYTE_CAP"); chunks.push(chunk); }
    const bytes = Buffer.concat(chunks), blob = crypto.createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (blob !== ACTIVE_TOKEN_BLOB) fail("HISTORICAL_TOKEN_BLOB_MISMATCH");
    const deployment = JSON.parse(bytes.toString("utf8")), input = normalize(deployment, { ...CONTRACTS.token, implementation: ACTIVE_TOKEN });
    const text = JSON.stringify(input, null, 2) + "\n";
    fs.writeFileSync(path.join(DIR, "active-token-exact.deployment.json"), bytes, { flag: "wx" });
    fs.writeFileSync(path.join(DIR, "active-token-exact.input.json"), text, { flag: "wx" });
    for (const [file, source] of Object.entries(input.sources)) {
      const destination = path.join(DIR, "active-token-exact", file);
      fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, source.content, { flag: "wx" });
    }
    const compiler = `C:/Users/MiPC/AppData/Local/Temp/opencode/solc-windows-amd64-v${VERSION}.exe`, stat = fs.lstatSync(compiler);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 32 * 1048576 || sha(fs.readFileSync(compiler)) !== COMPILER_SHA) fail("COMPILER_CHECKSUM_MISMATCH");
    const built = spawnSync(compiler, ["--standard-json"], { input: text, encoding: "utf8", timeout: 60000, maxBuffer: 32 * 1048576, windowsHide: true });
    if (built.status !== 0) fail("HISTORICAL_TOKEN_COMPILE_FAILED");
    const output = JSON.parse(built.stdout), contract = output.contracts?.["contracts/UsdPlusToken.sol"]?.UsdPlusToken;
    if ((output.errors || []).some(row => row.severity === "error") || !contract || `0x${contract.evm.deployedBytecode.object}` !== deployment.deployedBytecode.toLowerCase()
      || JSON.stringify(contract.abi) !== JSON.stringify(deployment.abi)) fail("HISTORICAL_TOKEN_TEMPLATE_MISMATCH");
    const instantiated = instantiateRuntime(output, contract.evm.deployedBytecode, ACTIVE_TOKEN);
    const explorer = JSON.parse(fs.readFileSync(path.join(DIR, "active-token.bundle.json"), "utf8"));
    if (explorer.address !== ACTIVE_TOKEN || explorer.explorerRuntime !== instantiated.runtime) fail("HISTORICAL_TOKEN_EXPLORER_MISMATCH");
    const compiled = { address: ACTIVE_TOKEN, runtime: instantiated.runtime, runtimeKeccak256: keccak256(instantiated.runtime), abi: contract.abi,
      inputSha256: sha(text), compiler: VERSION, compilerBinarySha256: COMPILER_SHA, immutableAssignments: instantiated.assignments };
    fs.writeFileSync(path.join(DIR, "active-token.compiled.json"), JSON.stringify(compiled, null, 2) + "\n", { flag: "wx" });
    out.status = "OFFICIAL_ACTIVE_TOKEN_REBUILT"; out.runtimeKeccak256 = compiled.runtimeKeccak256; out.inputSha256 = compiled.inputSha256;
    out.runtimeLength = (compiled.runtime.length - 2) / 2; out.sourceCount = Object.keys(input.sources).length;
  } catch (e) { out.code = e instanceof ExitError ? e.code : "HISTORICAL_TOKEN_SOURCE_FAILED"; }
  out.completedAt = new Date().toISOString(); fs.writeFileSync(filename, JSON.stringify(out, null, 2) + "\n", { flag: "wx" }); return out;
}
async function activeTokenSource() {
  const filename = path.join(DIR, "active-token-build.json");
  if (fs.existsSync(filename)) fail("ACTIVE_TOKEN_SOURCE_EXISTS_NO_RETRY");
  const out = { schema: "base-paper-usdplus-active-token-source/v13", generatedAt: new Date().toISOString(), status: "INCOMPLETE", requests: 1,
    proxy: CORE.usdPlus, implementation: ACTIVE_TOKEN, sourceRuntimeBound: "unknown", quoteEligible: false, signing: false, transactions: 0 };
  try {
    const response = await base.requestJSON(new URL(`https://base.blockscout.com/api/v2/smart-contracts/${ACTIVE_TOKEN}`), undefined, 20000);
    const bundle = normalizeExplorer(response.value, ACTIVE_TOKEN);
    if (bundle.compiler !== VERSION || bundle.name !== "UsdPlusToken") fail("ACTIVE_TOKEN_SOURCE_IDENTITY_MISMATCH");
    const text = JSON.stringify(bundle.input, null, 2) + "\n";
    fs.writeFileSync(path.join(DIR, "active-token.input.json"), text, { flag: "wx" });
    fs.writeFileSync(path.join(DIR, "active-token.bundle.json"), JSON.stringify(bundle, null, 2) + "\n", { flag: "wx" });
    for (const [file, source] of Object.entries(bundle.input.sources)) {
      const destination = path.join(DIR, "active-token", file);
      fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, source.content, { flag: "wx" });
    }
    const compiler = `C:/Users/MiPC/AppData/Local/Temp/opencode/solc-windows-amd64-v${VERSION}.exe`, stat = fs.lstatSync(compiler);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 32 * 1048576 || sha(fs.readFileSync(compiler)) !== COMPILER_SHA) fail("COMPILER_CHECKSUM_MISMATCH");
    const build = spawnSync(compiler, ["--standard-json"], { input: text, encoding: "utf8", timeout: 60000, maxBuffer: 32 * 1048576, windowsHide: true });
    if (build.status !== 0) fail("ACTIVE_TOKEN_COMPILE_FAILED");
    const output = JSON.parse(build.stdout), contract = output.contracts?.[bundle.file]?.[bundle.name];
    if ((output.errors || []).some(row => row.severity === "error") || !contract) fail("ACTIVE_TOKEN_COMPILE_FAILED");
    const instantiated = instantiateRuntime(output, contract.evm.deployedBytecode, ACTIVE_TOKEN);
    if (instantiated.runtime !== bundle.explorerRuntime) fail("ACTIVE_TOKEN_EXPLORER_RUNTIME_MISMATCH");
    const compiled = { address: ACTIVE_TOKEN, runtime: instantiated.runtime, runtimeKeccak256: keccak256(instantiated.runtime), abi: contract.abi,
      compiler: VERSION, compilerBinarySha256: COMPILER_SHA, inputSha256: sha(text), immutableAssignments: instantiated.assignments };
    fs.writeFileSync(path.join(DIR, "active-token.compiled.json"), JSON.stringify(compiled, null, 2) + "\n", { flag: "wx" });
    out.status = "ACTIVE_TOKEN_SOURCE_REBUILT_CHAIN_BINDING_REQUIRED";
    out.runtimeKeccak256 = compiled.runtimeKeccak256; out.inputSha256 = compiled.inputSha256;
    out.runtimeLength = (compiled.runtime.length - 2) / 2; out.sourceCount = Object.keys(bundle.input.sources).length;
  } catch (e) { out.code = e instanceof ExitError ? e.code : "ACTIVE_TOKEN_SOURCE_BUILD_FAILED"; }
  out.completedAt = new Date().toISOString(); fs.writeFileSync(filename, JSON.stringify(out, null, 2) + "\n", { flag: "wx" }); return out;
}
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
function loadCore(activeToken = false) {
  const read = relative => JSON.parse(fs.readFileSync(path.join(ROOT, relative), "utf8"));
  const previous = label => read(`reports/raw/fast/base-paper-usdplus-r11/${label}.compiled.json`);
  const token = read(`reports/raw/fast/base-paper-usdplus-r13/${activeToken ? "active-token" : "token"}.compiled.json`), role = read("reports/raw/fast/base-paper-usdplus-r13/role.compiled.json");
  const proxy = previous("exchange-proxy");
  return { exchangeProxy: proxy, exchange: previous("exchange-implementation"), managerProxy: previous("manager-proxy"), manager: previous("manager-implementation"),
    cashProxy: previous("cash-proxy"), cash: read("reports/raw/fast/base-paper-usdplus-r12/cash.compiled.json"),
    tokenProxy: { ...proxy, address: CONTRACTS.token.proxy }, token, roleProxy: { ...proxy, address: CONTRACTS.role.proxy }, role };
}
function guardDisposition(view) {
  if (view.exchange.paused || view.token.paused) return "BLOCKED_PAUSED";
  if (view.locks.venue.lockSend || view.locks.actor.lockReceive || view.locks.actor.lockSend || view.locks.burnDestination.lockReceive) return "BLOCKED_TOKEN_TRANSFER_LOCK";
  if (!view.manager.exchangeHasRole || view.token.exchange !== CORE.exchange) return "BLOCKED_BURN_OR_MANAGER_PERMISSION";
  return "TOKEN_CORE_GUARDS_CLEAR_AAVE_BINDING_REQUIRED";
}
async function coreState(deps = {}) {
  const clock = deps.clock || Date.now, started = clock(), transport = deps.transport || base.requestJSON;
  const out = { schema: "base-paper-usdplus-exit-core/v13", generatedAt: new Date(started).toISOString(), chainId: 8453, status: "INCOMPLETE", requests: 0, bytes: 0,
    qualification: { attempted: 0, qualified: 0, selectedFamilyCount: 0, failures: {} }, observation: null,
    gates: { tokenRoleRuntimeBound: "unknown", fullExitVerified: false, quoteEligible: false, profitabilityClaim: false, executableNow: "unknown", signedActionJustified: false },
    safety: { readOnlyRpc: true, inventoryRead: false, endpointMaterialPersisted: false, walletAccess: false, signing: false, transactions: 0, retries: 0 } };
  const safe = e => e instanceof ExitError ? e.code : "UNEXPECTED_FAILURE";
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const budget = () => { if (out.requests >= 180 || clock() - started >= 240000) fail("REQUEST_OR_TIME_CAP"); };
  const rpc = async (candidate, method, params) => {
    if (!["eth_chainId", "eth_getBlockByNumber", "eth_getStorageAt", "eth_getCode", "eth_call"].includes(method)) fail("METHOD_FORBIDDEN");
    budget(); if (!deps.transport) await new Promise(resolve => setTimeout(resolve, 200)); budget();
    const requestId = ++out.requests; let response;
    try { response = await transport(candidate.url, { jsonrpc: "2.0", id: requestId, method, params }, Math.min(8000, 240000 - (clock() - started))); }
    catch { fail("TRANSPORT_UNAVAILABLE"); }
    if (clock() - started >= 240000) fail("REQUEST_OR_TIME_CAP");
    if (!response || !Number.isSafeInteger(response.bytes) || response.bytes < 0 || response.bytes > 1048576) fail("RESPONSE_CAP");
    out.bytes += response.bytes; if (out.bytes > 16 * 1048576) fail("TOTAL_BYTE_CAP");
    if (response.value?.jsonrpc !== "2.0" || response.value.id !== requestId) fail("RPC_ENVELOPE_INVALID");
    if (Object.hasOwn(response.value, "error") || !Object.hasOwn(response.value, "result")) fail("RPC_UNAVAILABLE");
    return response.value.result;
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
    if ((deps.compiled || deps.clock || deps.candidates) && !deps.transport) fail("INJECTED_TRANSPORT_REQUIRED");
    const compiled = deps.compiled || loadCore(deps.activeToken === true);
    if (!deps.compiled && deps.activeToken === true) {
      const build = JSON.parse(fs.readFileSync(path.join(DIR, "active-token-exact-build.json"), "utf8"));
      if (build.status !== "OFFICIAL_ACTIVE_TOKEN_REBUILT" || build.runtimeKeccak256 !== compiled.token.runtimeKeccak256
        || build.inputSha256 !== compiled.token.inputSha256 || sha(fs.readFileSync(path.join(DIR, "active-token-exact.input.json"))) !== build.inputSha256) fail("ACTIVE_TOKEN_SOURCE_BUILD_CHANGED");
    }
    const expected = { exchangeProxy: CORE.exchange, exchange: CORE.implementation, managerProxy: CORE.manager, manager: "0xb008d09d25f06799e4081877a6bb185d89d893d3",
      cashProxy: CASH, cash: CASH_IMPLEMENTATION, tokenProxy: CONTRACTS.token.proxy, token: deps.activeToken === true ? ACTIVE_TOKEN : CONTRACTS.token.implementation, roleProxy: CONTRACTS.role.proxy, role: CONTRACTS.role.implementation };
    for (const [label, address] of Object.entries(expected)) {
      const value = compiled[label];
      if (value?.address !== address || !/^0x(?:[0-9a-f]{2})+$/i.test(value.runtime || "") || value.runtime.length > 65538 || keccak256(value.runtime) !== value.runtimeKeccak256) fail("CORE_BUILD_EVIDENCE_INVALID");
    }
    const interfaces = Object.fromEntries(["exchange", "manager", "cash", "token", "role"].map(label => [label, new Interface(compiled[label].abi)]));
    const targets = { exchange: CORE.exchange, manager: CORE.manager, cash: CASH, token: CORE.usdPlus, role: CONTRACTS.role.proxy };
    const call = async (candidate, label, name, args, pin) => {
      const iface = interfaces[label];
      if (!targets[label] || iface.getFunction(name)?.stateMutability !== "view") fail("NON_VIEW_OR_TARGET_FORBIDDEN");
      const raw = await rpc(candidate, "eth_call", [{ to: targets[label], data: iface.encodeFunctionData(name, args), gas: "0x1e8480" }, block(pin)]);
      try {
        const result = iface.decodeFunctionResult(name, raw);
        if (iface.encodeFunctionResult(name, result).toLowerCase() !== raw.toLowerCase()) fail("ABI_INVALID");
        return result;
      } catch { fail("ABI_INVALID"); }
    };
    const scalar = async (...args) => (await call(...args))[0];
    const getImpl = async (candidate, address, pin) => {
      const raw = await rpc(candidate, "eth_getStorageAt", [address, SLOT, block(pin)]);
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
        await getImpl(candidate, CORE.usdPlus, pin);
        await scalar(candidate, "token", "isPaused", [], pin);
        const code = await rpc(candidate, "eth_getCode", [CORE.usdPlus, block(pin)]);
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
      const view = { runtimeBound: {}, implementations: {}, token: {}, exchange: {}, manager: {}, cash: {}, locks: {}, paperActor: PAPER_ACTOR, paperActorIsWallet: false };
      for (const label of Object.keys(expected)) {
        const value = compiled[label], code = await rpc(candidate, "eth_getCode", [value.address, block(pin)]);
        if (typeof code !== "string" || code.toLowerCase() !== value.runtime) fail("CORE_RUNTIME_MISMATCH");
        view.runtimeBound[label] = { address: value.address, runtimeKeccak256: value.runtimeKeccak256, fullByteMatch: true };
      }
      for (const label of ["exchange", "manager", "cash", "token", "role"]) {
        const implementation = await getImpl(candidate, targets[label], pin);
        if (implementation !== compiled[label].address) {
          out.failureContext = { label, expected: compiled[label].address, observed: implementation, pin, corroborated: false };
          fail("CORE_IMPLEMENTATION_CHANGED");
        }
        view.implementations[label] = implementation;
      }
      view.token.paused = await scalar(candidate, "token", "isPaused", [], pin);
      view.token.decimals = (await scalar(candidate, "token", "decimals", [], pin)).toString();
      for (const name of ["exchange", "roleManager"]) view.token[name] = (await scalar(candidate, "token", name, [], pin)).toLowerCase();
      for (const name of ["usdPlus", "usdc", "portfolioManager", "roleManager", "blockGetter"]) view.exchange[name] = (await scalar(candidate, "exchange", name, [], pin)).toLowerCase();
      view.exchange.paused = await scalar(candidate, "exchange", "paused", [], pin);
      for (const name of ["redeemFee", "redeemFeeDenominator"]) view.exchange[name] = (await scalar(candidate, "exchange", name, [], pin)).toString();
      view.manager.exchanger = (await scalar(candidate, "manager", "exchanger", [], pin)).toLowerCase();
      view.manager.cashStrategy = (await scalar(candidate, "manager", "cashStrategy", [], pin)).toLowerCase();
      view.manager.exchangeHasRole = await scalar(candidate, "manager", "hasRole", [id("EXCHANGER"), CORE.exchange], pin);
      view.cash.manager = (await scalar(candidate, "cash", "portfolioManager", [], pin)).toLowerCase();
      view.cash.inLending = await scalar(candidate, "cash", "inLending", [], pin);
      view.cash.liquidationValue = (await scalar(candidate, "cash", "liquidationValue", [], pin)).toString();
      for (const [label, address] of [["venue", VENUE], ["actor", PAPER_ACTOR], ["burnDestination", ZERO]]) {
        const locks = await call(candidate, "token", "lockOptionsPerAddress", [address], pin);
        view.locks[label] = { address, lockSend: locks[0], lockReceive: locks[1] };
      }
      view.actorFeeExempt = await scalar(candidate, "role", "hasRole", [id("FREE_RIDER_ROLE"), PAPER_ACTOR], pin);
      if (view.token.decimals !== "6" || view.token.roleManager !== CONTRACTS.role.proxy || view.exchange.usdPlus !== CORE.usdPlus || view.exchange.usdc !== CORE.usdc
        || view.exchange.portfolioManager !== CORE.manager || view.exchange.roleManager !== CONTRACTS.role.proxy || view.manager.exchanger !== CORE.exchange || view.manager.cashStrategy !== CASH || view.cash.manager !== CORE.manager) fail("CORE_BINDING_MISMATCH");
      if (BigInt(view.exchange.redeemFeeDenominator) === 0n || BigInt(view.exchange.redeemFee) > BigInt(view.exchange.redeemFeeDenominator)) fail("FEE_INVALID");
      views.push(view);
    }
    if (!equal(views[0], views[1])) fail("OBSERVATION_DISAGREEMENT");
    for (const { candidate } of selected) {
      if (!equal(await getHeader(candidate, tag), pin)) fail("TERMINAL_PIN_CHANGED");
      if (BigInt((await getHeader(candidate, "finalized")).number) < number) fail("FINALITY_REGRESSED");
    }
    out.observation = { pin, rpcStrength: "corroborated-operator-families", upstreamIndependenceProven: false, ...views[0] };
    out.gates.tokenRoleRuntimeBound = "true";
    out.status = guardDisposition(views[0]);
  } catch (e) { out.code = safe(e); }
  out.completedAt = new Date(clock()).toISOString(); return out;
}
async function coreOnce(activeToken = false) {
  const filename = path.join(DIR, activeToken ? "active-core-state.json" : "core-state.json");
  if (fs.existsSync(filename)) fail("CORE_CAPTURE_EXISTS_NO_RETRY");
  const out = await coreState({ activeToken }), encoded = JSON.stringify(out, null, 2) + "\n";
  if (/(?:https?|wss?):\/\//i.test(encoded)) fail("OUTPUT_NOT_SANITIZED");
  fs.writeFileSync(filename, encoded, { flag: "wx" }); return out;
}
module.exports = { normalize, sources, coreState, guardDisposition, readCandidates, CONTRACTS, DIR, PAPER_ACTOR, VENUE, ZERO, ACTIVE_TOKEN };
if (require.main === module) {
  const mode = process.argv.slice(2).join(" ");
  if (!["--sources-once", "--core-once", "--active-token-source-once", "--historical-token-source-once", "--active-core-once"].includes(mode)) throw new Error("EXPLICIT_SOURCE_OR_CORE_CAPTURE_REQUIRED");
  (mode === "--sources-once" ? sources() : mode === "--active-token-source-once" ? activeTokenSource() : mode === "--historical-token-source-once" ? historicalTokenSource() : coreOnce(mode === "--active-core-once")).then(out => { console.log(JSON.stringify(out)); if (out.status === "INCOMPLETE") process.exitCode = 1; }).catch(() => { console.error("R13_FAILED_CLOSED"); process.exitCode = 1; });
}
