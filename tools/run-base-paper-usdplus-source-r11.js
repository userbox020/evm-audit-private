"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { keccak256, Interface, id } = require("ethers");
const { requestJSON, header, address: addressWord } = require("./run-base-redemption-paper-state-r1");
const { A, SLOT } = require("./run-base-paper-usdplus-preflight-r10");
const { candidatePool } = require("./run-base-paper-cycle-r8");
const ROOT = path.resolve(__dirname, "..");
const DIR = path.join(ROOT, "reports/raw/fast/base-paper-usdplus-r11");
const PROXIES = Object.freeze({ exchange: A.exchange, manager: A.manager, cash: "0x687ac878bc93610366b705c385cd0a0038493dbb", token: A.usdPlus, m2m: A.m2m });
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
class SourceError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = code => { throw new SourceError(code); };
function normalize(raw, address) {
  if (!raw || raw.is_verified !== true || !/^0x[0-9a-f]{40}$/.test(address) || !/^v?0\.8\.\d+\+commit\.[0-9a-f]{8}$/.test(raw.compiler_version || "")) fail("SOURCE_IDENTITY_OR_COMPILER_INVALID");
  if (raw.address_hash && raw.address_hash.toLowerCase() !== address) fail("SOURCE_ADDRESS_MISMATCH");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw.name || "") || !Array.isArray(raw.abi) || !raw.compiler_settings || typeof raw.compiler_settings !== "object") fail("SOURCE_METADATA_INCOMPLETE");
  const entries = [{ file_path: raw.file_path, source_code: raw.source_code }, ...(raw.additional_sources || [])];
  if (entries.length > 150) fail("SOURCE_COUNT_CAP");
  const sources = {};
  for (const { file_path: file, source_code: content } of entries) {
    if (typeof file !== "string" || !file.endsWith(".sol") || file.length > 250 || /\\|:|\0/.test(file) || file.startsWith("/") || file.split("/").some(p => !p || p === "." || p === "..")) fail("SOURCE_PATH_INVALID");
    if (typeof content !== "string" || Buffer.byteLength(content) > 1048576 || Object.hasOwn(sources, file)) fail("SOURCE_CONTENT_INVALID");
    sources[file] = { content };
  }
  if (typeof raw.deployed_bytecode !== "string" || !/^0x(?:[0-9a-f]{2})+$/i.test(raw.deployed_bytecode) || raw.deployed_bytecode.length > 65538) fail("EXPLORER_RUNTIME_INVALID");
  const settings = structuredClone(raw.compiler_settings);
  delete settings.compilationTarget;
  settings.outputSelection = { "*": { "*": ["abi", "evm.deployedBytecode"], "": ["ast"] } };
  const implementations = (raw.implementations || []).map(row => String(row.address_hash || row.address || "").toLowerCase());
  if (implementations.length > 1 || implementations.some(value => !/^0x[0-9a-f]{40}$/.test(value))) fail("IMPLEMENTATION_LOCATOR_INVALID");
  return { address, name: raw.name, file: raw.file_path, compiler: raw.compiler_version.replace(/^v/, ""),
    explorerRuntime: raw.deployed_bytecode.toLowerCase(), implementations, input: { language: "Solidity", sources, settings } };
}
async function acquire(transport = requestJSON) {
  const manifest = { schema: "base-paper-usdplus-source/v11", generatedAt: new Date().toISOString(), mode: "PUBLIC_SOURCE_RECOVERY_ONLY",
    status: "INCOMPLETE", requests: 0, contracts: {}, sourceRuntimeBound: false, quoteEligible: false, signing: false, transactions: 0 };
  const filename = path.join(DIR, "source-manifest.json");
  if (fs.existsSync(filename)) fail("SOURCE_CAPTURE_EXISTS_NO_RETRY");
  fs.mkdirSync(DIR, { recursive: true });
  try {
    for (const [label, proxy] of Object.entries(PROXIES)) {
      const get = async (address, suffix) => {
        if (++manifest.requests > 10) fail("SOURCE_REQUEST_CAP");
        const response = await transport(new URL(`https://base.blockscout.com/api/v2/smart-contracts/${address}`), undefined, 15000);
        const value = normalize(response.value, address), key = `${label}-${suffix}`;
        const encoded = JSON.stringify(value.input, null, 2) + "\n";
        fs.writeFileSync(path.join(DIR, `${key}.input.json`), encoded, { flag: "wx" });
        fs.writeFileSync(path.join(DIR, `${key}.bundle.json`), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
        const sourceDir = path.join(DIR, key);
        for (const [file, source] of Object.entries(value.input.sources)) {
          const destination = path.join(sourceDir, file);
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.writeFileSync(destination, source.content, { flag: "wx" });
        }
        manifest.contracts[key] = { address, name: value.name, file: value.file, compiler: value.compiler, implementations: value.implementations,
          inputSha256: sha(encoded), sourceCount: Object.keys(value.input.sources).length, explorerRuntimeSha256: sha(Buffer.from(value.explorerRuntime.slice(2), "hex")) };
        return value;
      };
      const bundle = await get(proxy, "proxy");
      if (bundle.implementations.length !== 1) fail("PROXY_IMPLEMENTATION_LOCATOR_MISSING");
      await get(bundle.implementations[0], "implementation");
    }
    manifest.status = "SOURCE_BUNDLES_RECOVERED_UNBOUND";
  } catch (error) { manifest.code = error instanceof SourceError ? error.code : "SOURCE_ACQUISITION_FAILED"; }
  manifest.completedAt = new Date().toISOString();
  fs.writeFileSync(filename, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  return manifest;
}
// Checksums from the Solidity team's windows-amd64 release manifest, not explorer input.
const COMPILERS = Object.freeze({
  "0.8.9+commit.e5eed63a": "7990f118fcda426e18fe67766942c29ebe77817d2a59b1a983a69d11bf2d5aa8",
  "0.8.17+commit.8df45f5f": "7615e019666f29c7e77b20f9c506dda839a875fbc9baf3322d21348c88c05c69"
});
async function compiler(version) {
  if (!Object.hasOwn(COMPILERS, version)) fail("COMPILER_NOT_PINNED");
  const name = `solc-windows-amd64-v${version}.exe`, file = path.join("C:/Users/MiPC/AppData/Local/Temp/opencode", name);
  if (!fs.existsSync(file)) {
    const response = await fetch(`https://raw.githubusercontent.com/ethereum/solc-bin/gh-pages/windows-amd64/${name}`, { redirect: "error", signal: AbortSignal.timeout(60000) });
    if (!response.ok) fail("COMPILER_DOWNLOAD_FAILED");
    const chunks = []; let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length; if (length > 32 * 1048576) fail("COMPILER_SIZE_CAP");
      chunks.push(chunk);
    }
    const binary = Buffer.concat(chunks);
    if (sha(binary) !== COMPILERS[version]) fail("COMPILER_CHECKSUM_MISMATCH");
    fs.writeFileSync(file, binary, { flag: "wx" });
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 32 * 1048576 || sha(fs.readFileSync(file)) !== COMPILERS[version]) fail("COMPILER_CHECKSUM_MISMATCH");
  const checked = spawnSync(file, ["--version"], { encoding: "utf8", timeout: 10000, windowsHide: true });
  if (checked.status !== 0 || !checked.stdout.includes(`Version: ${version}.Windows.msvc`)) fail("COMPILER_VERSION_MISMATCH");
  return file;
}
function instantiateRuntime(output, target, address) {
  if (!/^0x[0-9a-f]{40}$/.test(address) || !/^(?:[0-9a-f]{2})+$/i.test(target.object) || Object.values(target.linkReferences || {}).some(libs => Object.values(libs).some(refs => refs.length))) fail("UNRESOLVED_RUNTIME_OR_LINKS");
  const nodes = new Map();
  const visit = node => {
    if (!node || typeof node !== "object") return;
    if (node.nodeType === "VariableDeclaration") nodes.set(String(node.id), node);
    for (const child of Object.values(node)) if (Array.isArray(child)) child.forEach(visit); else if (child && typeof child === "object") visit(child);
  };
  for (const source of Object.values(output.sources || {})) visit(source.ast);
  const bytes = Buffer.from(target.object, "hex"), occupied = new Set(), assignments = [];
  for (const [id, refs] of Object.entries(target.immutableReferences || {})) {
    const node = nodes.get(id), init = node?.value;
    if (node?.mutability !== "immutable" || node.typeName?.name !== "address" || init?.kind !== "typeConversion" || init.expression?.typeName?.name !== "address"
      || init.arguments?.length !== 1 || init.arguments[0]?.nodeType !== "Identifier" || init.arguments[0]?.name !== "this") fail("IMMUTABLE_NOT_SOURCE_PROVEN_SELF_ADDRESS");
    for (const ref of refs) {
      if (!Number.isSafeInteger(ref.start) || ref.start < 0 || ref.length !== 32 || ref.start + 32 > bytes.length) fail("IMMUTABLE_RANGE_INVALID");
      for (let i = ref.start; i < ref.start + 32; i++) {
        if (occupied.has(i) || bytes[i] !== 0) fail("IMMUTABLE_RANGE_INVALID");
        occupied.add(i);
      }
      Buffer.from(address.slice(2).padStart(64, "0"), "hex").copy(bytes, ref.start);
    }
    assignments.push({ astId: id, name: node.name, value: address, rationale: "SOURCE_INITIALIZER_ADDRESS_THIS", ranges: refs });
  }
  return { runtime: "0x" + bytes.toString("hex"), assignments };
}
async function build() {
  const filename = path.join(DIR, "build-manifest.json");
  if (fs.existsSync(filename)) fail("BUILD_EXISTS_NO_RETRY");
  const manifest = JSON.parse(fs.readFileSync(path.join(DIR, "source-manifest.json"), "utf8"));
  const out = { schema: "base-paper-usdplus-build/v11", generatedAt: new Date().toISOString(), status: "INCOMPLETE", contracts: {},
    sourceCaptureStatus: manifest.status, allWithdrawalDependenciesBound: false, quoteEligible: false, signing: false, transactions: 0 };
  try {
    for (const [key, source] of Object.entries(manifest.contracts)) {
      if (!/^(exchange|manager|cash|token|m2m)-(proxy|implementation)$/.test(key)) fail("SOURCE_KEY_INVALID");
      const inputText = fs.readFileSync(path.join(DIR, `${key}.input.json`), "utf8");
      if (sha(inputText) !== source.inputSha256) fail("INPUT_CHANGED");
      const bundle = JSON.parse(fs.readFileSync(path.join(DIR, `${key}.bundle.json`), "utf8"));
      const executable = await compiler(source.compiler);
      const built = spawnSync(executable, ["--standard-json"], { input: inputText, encoding: "utf8", timeout: 60000, maxBuffer: 32 * 1048576, windowsHide: true });
      if (built.status !== 0) fail("NATIVE_COMPILE_FAILED");
      const result = JSON.parse(built.stdout);
      if ((result.errors || []).some(row => row.severity === "error")) fail("STANDARD_JSON_COMPILE_FAILED");
      const contract = result.contracts?.[source.file]?.[source.name];
      if (!contract) fail("COMPILED_TARGET_MISSING");
      const instantiated = instantiateRuntime(result, contract.evm.deployedBytecode, source.address);
      const match = instantiated.runtime === bundle.explorerRuntime;
      const evidence = { ...source, compilerBinarySha256: COMPILERS[source.compiler], runtimeKeccak256: keccak256(instantiated.runtime),
        runtimeLength: (instantiated.runtime.length - 2) / 2, explorerRuntimeExact: match, immutableAssignments: instantiated.assignments };
      out.contracts[key] = evidence;
      fs.writeFileSync(path.join(DIR, `${key}.compiled.json`), JSON.stringify({ ...evidence, abi: contract.abi, runtime: instantiated.runtime }, null, 2) + "\n", { flag: "wx" });
      if (!match) fail("EXPLORER_RUNTIME_MISMATCH");
    }
    out.status = "RECOVERED_CONTRACTS_REBUILT_EXACT_EXPLORER_MATCH";
  } catch (error) { out.code = error instanceof SourceError ? error.code : "BUILD_FAILED"; }
  out.completedAt = new Date().toISOString();
  fs.writeFileSync(filename, JSON.stringify(out, null, 2) + "\n", { flag: "wx" });
  return out;
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
const KEYS = ["exchange-proxy", "exchange-implementation", "manager-proxy", "manager-implementation", "cash-proxy"];
const BIND_CAP = { requests: 140, wallMs: 240000, bytes: 16 * 1048576 };
async function bind(deps = {}) {
  const clock = deps.clock || Date.now, started = clock(), transport = deps.transport || requestJSON;
  const out = { schema: "base-paper-usdplus-runtime/v11", generatedAt: new Date(started).toISOString(), chainId: 8453,
    status: "INCOMPLETE", requests: 0, bytes: 0, qualification: { attempted: 0, qualified: 0, selectedFamilyCount: 0, failures: {} }, observation: null,
    gates: { fullWithdrawalDependenciesBound: false, payoutCapacity: "unknown", quoteEligible: false, profitabilityClaim: false, executableNow: "unknown", signedActionJustified: false },
    safety: { readOnlyRpc: true, inventoryRead: false, endpointMaterialPersisted: false, walletAccess: false, signing: false, transactions: 0, retries: 0 } };
  const safe = e => e instanceof SourceError ? e.code : "UNEXPECTED_FAILURE";
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const budget = () => { if (out.requests >= BIND_CAP.requests || clock() - started >= BIND_CAP.wallMs) fail("REQUEST_OR_TIME_CAP"); };
  const rpc = async (candidate, method, params) => {
    if (!["eth_chainId", "eth_getBlockByNumber", "eth_getStorageAt", "eth_getCode", "eth_call"].includes(method)) fail("METHOD_FORBIDDEN");
    budget();
    if (!deps.transport) await new Promise(resolve => setTimeout(resolve, 200));
    budget(); const requestId = ++out.requests;
    let response;
    try { response = await transport(candidate.url, { jsonrpc: "2.0", id: requestId, method, params }, Math.min(8000, BIND_CAP.wallMs - (clock() - started))); }
    catch { fail("TRANSPORT_UNAVAILABLE"); }
    if (clock() - started >= BIND_CAP.wallMs) fail("REQUEST_OR_TIME_CAP");
    if (!response || !Number.isSafeInteger(response.bytes) || response.bytes < 0 || response.bytes > 1048576) fail("RESPONSE_CAP");
    out.bytes += response.bytes; if (out.bytes > BIND_CAP.bytes) fail("TOTAL_BYTE_CAP");
    const body = response.value;
    if (!body || body.jsonrpc !== "2.0" || body.id !== requestId) fail("RPC_ENVELOPE_INVALID");
    if (Object.hasOwn(body, "error") || !Object.hasOwn(body, "result")) fail("RPC_UNAVAILABLE");
    return body.result;
  };
  const getHeader = async (candidate, tag) => {
    let pin;
    const raw = await rpc(candidate, "eth_getBlockByNumber", [tag, false]);
    try { pin = header(raw); } catch { fail("HEADER_INVALID"); }
    const age = BigInt(Math.floor(clock() / 1000)) - BigInt(pin.timestamp);
    if (age < -60n || age > 3600n) fail("FINALITY_STALE");
    return pin;
  };
  const block = pin => ({ blockHash: pin.hash, requireCanonical: true });
  try {
    if ((deps.candidates || deps.compiled || deps.clock) && !deps.transport) fail("INJECTED_TRANSPORT_REQUIRED");
    const compiled = deps.compiled || Object.fromEntries(KEYS.map(key => [key, JSON.parse(fs.readFileSync(path.join(DIR, `${key}.compiled.json`), "utf8"))]));
    for (const key of KEYS) {
      const row = compiled[key];
      if (!row || !/^0x[0-9a-f]{40}$/.test(row.address) || typeof row.runtime !== "string" || !/^0x(?:[0-9a-f]{2})+$/i.test(row.runtime) || row.runtime.length > 65538
        || keccak256(row.runtime) !== row.runtimeKeccak256 || row.explorerRuntimeExact !== true || !Array.isArray(row.abi)) fail("COMPILED_EVIDENCE_INVALID");
      if (key.endsWith("-proxy") && (row.address !== PROXIES[key.split("-")[0]] || row.implementations?.length !== 1 || !/^0x[0-9a-f]{40}$/.test(row.implementations[0]))) fail("PROXY_IDENTITY_INVALID");
    }
    for (const label of ["exchange", "manager"]) if (compiled[`${label}-proxy`].implementations[0] !== compiled[`${label}-implementation`].address) fail("COMPILED_IMPLEMENTATION_MISMATCH");
    const interfaces = { exchange: new Interface(compiled["exchange-implementation"].abi), manager: new Interface(compiled["manager-implementation"].abi) };
    const call = async (candidate, label, name, args, pin) => {
      const iface = interfaces[label], fragment = iface.getFunction(name);
      if (!fragment || fragment.stateMutability !== "view") fail("NON_VIEW_FORBIDDEN");
      const raw = await rpc(candidate, "eth_call", [{ to: PROXIES[label], data: iface.encodeFunctionData(name, args), gas: "0x1e8480" }, block(pin)]);
      try {
        const values = iface.decodeFunctionResult(name, raw);
        if (iface.encodeFunctionResult(name, values).toLowerCase() !== raw.toLowerCase()) fail("ABI_INVALID");
        return values;
      } catch { fail("ABI_INVALID"); }
    };
    const getImpl = async (candidate, proxy, pin) => {
      const raw = await rpc(candidate, "eth_getStorageAt", [proxy, SLOT, block(pin)]);
      try { return addressWord(raw); } catch { fail("IMPLEMENTATION_WORD_INVALID"); }
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
        await getImpl(candidate, A.manager, pin);
        await call(candidate, "manager", "cashStrategy", [], pin);
        const code = await rpc(candidate, "eth_getCode", [A.exchange, block(pin)]);
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
      const view = { runtimeBound: {}, implementations: {}, exchange: {}, manager: {} };
      for (const key of KEYS) {
        const row = compiled[key], runtime = await rpc(candidate, "eth_getCode", [row.address, block(pin)]);
        if (typeof runtime !== "string" || runtime.toLowerCase() !== row.runtime) fail("CHAIN_RUNTIME_MISMATCH");
        view.runtimeBound[key] = { address: row.address, runtimeKeccak256: row.runtimeKeccak256, fullByteMatch: true, inputSha256: row.inputSha256 };
      }
      for (const label of ["exchange", "manager", "cash"]) {
        const value = await getImpl(candidate, PROXIES[label], pin);
        if (value !== compiled[`${label}-proxy`].implementations[0]) fail("CHAIN_IMPLEMENTATION_CHANGED");
        view.implementations[label] = value;
      }
      for (const name of ["usdPlus", "usdc", "portfolioManager", "roleManager", "blockGetter", "redeemFee", "redeemFeeDenominator", "paused"])
        view.exchange[name] = (await call(candidate, "exchange", name, [], pin))[0].toString().toLowerCase();
      for (const name of ["cashStrategy", "exchanger", "m2m", "navSlippageBp"])
        view.manager[name] = (await call(candidate, "manager", name, [], pin))[0].toString().toLowerCase();
      if (view.exchange.usdPlus !== A.usdPlus || view.exchange.usdc !== A.usdc || view.exchange.portfolioManager !== A.manager || view.manager.cashStrategy !== PROXIES.cash || view.manager.exchanger !== A.exchange) fail("WITHDRAWAL_BINDING_CHANGED");
      view.manager.exchangeHasRole = (await call(candidate, "manager", "hasRole", [id("EXCHANGER"), A.exchange], pin))[0];
      const weights = (await call(candidate, "manager", "getAllStrategyWeights", [], pin))[0];
      if (weights.length > 64) fail("STRATEGY_COUNT_CAP");
      view.manager.strategies = weights.map(row => ({ strategy: row.strategy.toLowerCase(), minWeight: row.minWeight.toString(), targetWeight: row.targetWeight.toString(),
        maxWeight: row.maxWeight.toString(), riskFactor: row.riskFactor.toString(), enabled: row.enabled, enabledReward: row.enabledReward }));
      views.push(view);
    }
    if (!equal(views[0], views[1])) fail("OBSERVATION_DISAGREEMENT");
    for (const { candidate } of selected) {
      if (!equal(await getHeader(candidate, tag), pin)) fail("TERMINAL_PIN_CHANGED");
      if (BigInt((await getHeader(candidate, "finalized")).number) < number) fail("FINALITY_REGRESSED");
    }
    out.observation = { pin, rpcStrength: "corroborated-operator-families", upstreamIndependenceProven: false, ...views[0] };
    out.status = "PARTIAL_RUNTIME_BOUND";
    out.code = "CASH_IMPLEMENTATION_SOURCE_UNRECOVERED_WITHDRAWAL_UNPROVEN";
  } catch (e) { out.code = safe(e); }
  out.completedAt = new Date(clock()).toISOString(); return out;
}
async function bindOnce() {
  const file = path.join(DIR, "runtime-capture.json");
  if (fs.existsSync(file)) fail("RUNTIME_CAPTURE_EXISTS_NO_RETRY");
  const out = await bind(), encoded = JSON.stringify(out, null, 2) + "\n";
  if (/(?:https?|wss?):\/\//i.test(encoded)) fail("RUNTIME_OUTPUT_NOT_SANITIZED");
  fs.writeFileSync(file, encoded, { flag: "wx" }); return out;
}
module.exports = { normalize, acquire, build, instantiateRuntime, bind, PROXIES, DIR, sha, SourceError, KEYS };
if (require.main === module) {
  const mode = process.argv.slice(2).join(" ");
  if (!["--acquire-once", "--build-once", "--bind-once"].includes(mode)) throw new Error("EXPLICIT_SOURCE_BUILD_OR_BIND_REQUIRED");
  (mode === "--acquire-once" ? acquire() : mode === "--build-once" ? build() : bindOnce()).then(out => { console.log(JSON.stringify(out)); if (out.status === "INCOMPLETE") process.exitCode = 1; }).catch(() => { console.error("SOURCE_BUILD_FAILED_CLOSED"); process.exitCode = 1; });
}
