"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const { parseInventoryText: parsePublicBaseInventory } = require("./run-base-fluid-spell-rpc-fallback");

const ROOT = path.resolve(__dirname, "..");
const SOURCE_ROOT = path.join(ROOT, "targets", "morpho-vault-v2-20260729-10f169717ae6", "lib", "metamorpho-v1.1");
const INVENTORY_FILE = path.join(ROOT, "rpc_endpoints.txt");
const APPROVED_TEMP = "C:\\Users\\MiPC\\AppData\\Local\\Temp\\opencode";
const AUTHORITY = Object.freeze({
  chainId: 8453,
  factory: "0xff62a7c278c62ed665133147129245053bbf5918",
  startBlock: 23928808,
  morpho: "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb",
  sourceCommit: "5a0717b2c863060ff452ca324716083fe6d09374",
  sourceRoot: "targets/morpho-vault-v2-20260729-10f169717ae6/lib/metamorpho-v1.1",
  contract: "MetaMorphoV1_1Factory",
  solc: "0.8.26",
  optimizerRuns: 200,
  viaIR: true,
  evmVersion: "cancun"
});
const SUBMODULES = Object.freeze({
  "lib/erc4626-tests": "8b1d7c2ac248c33c3506b1bff8321758943c5e11",
  "lib/forge-std": "1d9650e951204a0ddce9ff89c32f1997984cef4d",
  "lib/morpho-blue": "4844569ce51f2a01a46e27a5a22f54e9a388adcc",
  "lib/morpho-blue-irm": "a7d9cce3451b4a106bfd40933ac57a785b5228f3",
  "lib/openzeppelin-contracts": "932fddf69a699a9a80fd2396fd1a2ab91cdda123"
});
const MORPHO_SELECTOR = "0x3acb5624";
const METHODS = new Set(["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_call"]);
const STATUS_BOUND = "EXACT_FACTORY_RUNTIME_BOUND";
const STATUS_INCOMPLETE = "INCOMPLETE";
const LIMITS = Object.freeze({ inventoryBytes: 1024 * 1024, candidates: 12, families: 8, requests: 64,
  requestMs: 15_000, wallMs: 120_000, responseBytes: 4 * 1024 * 1024, totalResponseBytes: 32 * 1024 * 1024 });

class BindingError extends Error {
  constructor(code, cleanupComplete = null) {
    super(code);
    this.name = "BindingError";
    this.code = code;
    this.cleanupComplete = cleanupComplete;
  }
}
const stop = (code, cleanupComplete = null) => { throw new BindingError(code, cleanupComplete); };

const FAILURE_PHASES = Object.freeze(["AUTHORITY", "WORKTREE", "SUBMODULE", "COMPILER", "BUILD", "INVENTORY", "QUALIFICATION", "RUNTIME", "TERMINAL"]);
const FAILURE_CODES = Object.freeze({
  AUTHORITY_SOURCE_UNAVAILABLE: "AUTHORITY", AUTHORITY_COMMIT_UNAVAILABLE: "AUTHORITY", AUTHORITY_MISMATCH: "AUTHORITY",
  WORKTREE_ADD_FAILED: "WORKTREE", WORKTREE_STATE_MISMATCH: "WORKTREE", TEMP_ROOT_INVALID: "WORKTREE",
  TEMP_CLEANUP_FAILED: "WORKTREE", CHECKED_OUT_SOURCE_CHANGED: "WORKTREE",
  SUBMODULE_UPDATE_FAILED: "SUBMODULE", SUBMODULE_STATE_MISMATCH: "SUBMODULE",
  COMPILER_UNAVAILABLE: "COMPILER", COMPILER_SETTINGS_MISMATCH: "COMPILER",
  BUILD_FAILED: "BUILD", BUILD_ARTIFACT_INVALID: "BUILD",
  INVENTORY_INVALID: "INVENTORY", INVENTORY_MUTATED: "INVENTORY",
  TWO_FAMILIES_UNAVAILABLE: "QUALIFICATION", WRONG_CHAIN: "QUALIFICATION", FINALIZED_BEFORE_DEPLOYMENT: "QUALIFICATION",
  HEADER_INVALID: "QUALIFICATION", CODE_INVALID: "QUALIFICATION", MORPHO_GETTER_INVALID: "QUALIFICATION",
  MORPHO_GETTER_MISMATCH: "QUALIFICATION", METHOD_FORBIDDEN: "QUALIFICATION", REQUEST_CAP: "QUALIFICATION",
  RESPONSE_CAP: "QUALIFICATION", RPC_HTTP: "QUALIFICATION", RPC_JSON: "QUALIFICATION", RPC_TRANSPORT: "QUALIFICATION",
  RPC_TIMEOUT: "QUALIFICATION", RPC_RESPONSE: "QUALIFICATION", QUANTITY_INVALID: "QUALIFICATION",
  IMMUTABLE_REFERENCES_INVALID: "RUNTIME", RUNTIME_MISMATCH: "RUNTIME",
  TERMINAL_HEADER_CHANGED: "TERMINAL"
});

function sanitizedFailure(error, fallbackCode = "BUILD_FAILED") {
  const candidate = error instanceof BindingError ? error.code : fallbackCode;
  const failureCode = Object.hasOwn(FAILURE_CODES, candidate) ? candidate : fallbackCode;
  const failurePhase = FAILURE_CODES[failureCode] || "BUILD";
  return {
    failurePhase: FAILURE_PHASES.includes(failurePhase) ? failurePhase : "BUILD",
    failureCode,
    temporaryWorktreeCleanupComplete: error instanceof BindingError && typeof error.cleanupComplete === "boolean"
      ? error.cleanupComplete : null
  };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function commitment(namespace, value) {
  return `${namespace}_${crypto.createHash("sha256").update(`${namespace}:${value}`).digest("base64url")}`;
}
function same(left, right) { return canonical(left) === canonical(right); }
function identity(stat) { return { dev: String(stat.dev), ino: String(stat.ino), size: Number(stat.size), mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs }; }

function readStableInventory() {
  let before; let real; let fd; let heldBefore; let bytes; let heldAfter; let after;
  try {
    before = fs.lstatSync(INVENTORY_FILE); real = fs.realpathSync.native(INVENTORY_FILE);
    if (!before.isFile() || before.isSymbolicLink() || real !== INVENTORY_FILE || before.size < 1 || before.size > LIMITS.inventoryBytes) stop("INVENTORY_INVALID");
    fd = fs.openSync(INVENTORY_FILE, "r"); heldBefore = fs.fstatSync(fd); bytes = fs.readFileSync(fd); heldAfter = fs.fstatSync(fd); after = fs.lstatSync(INVENTORY_FILE);
  } catch (error) { if (error instanceof BindingError) throw error; stop("INVENTORY_INVALID"); }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {} }
  if (bytes.length !== before.size || !same(identity(before), identity(after)) || !same(identity(heldBefore), identity(heldAfter))
      || String(before.dev) !== String(heldBefore.dev) || String(before.ino) !== String(heldBefore.ino)) stop("INVENTORY_MUTATED");
  return { text: bytes.toString("utf8"), identity: identity(after) };
}
function inventoryUnchanged(expected) {
  let stat; let real; try { stat = fs.lstatSync(INVENTORY_FILE); real = fs.realpathSync.native(INVENTORY_FILE); } catch (_) { stop("INVENTORY_MUTATED"); }
  if (!stat.isFile() || stat.isSymbolicLink() || real !== INVENTORY_FILE || !same(identity(stat), expected)) stop("INVENTORY_MUTATED");
}

function run(executable, args, cwd, code) {
  const result = childProcess.spawnSync(executable, args, { cwd, encoding: "utf8", windowsHide: true, shell: false,
    timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0 || result.signal !== null) stop(code);
  return String(result.stdout || "").trim();
}

function exactBuild() {
  const approved = path.resolve(APPROVED_TEMP);
  let approvedReal; let approvedStat;
  try { approvedReal = fs.realpathSync.native(approved); approvedStat = fs.lstatSync(approved); } catch (_) { stop("TEMP_ROOT_INVALID", true); }
  if (approvedReal !== approved || !approvedStat.isDirectory() || approvedStat.isSymbolicLink()) stop("TEMP_ROOT_INVALID", true);
  const checkedOutHead = run("git", ["rev-parse", "HEAD"], SOURCE_ROOT, "AUTHORITY_SOURCE_UNAVAILABLE").toLowerCase();
  run("git", ["cat-file", "-e", `${AUTHORITY.sourceCommit}^{commit}`], SOURCE_ROOT, "AUTHORITY_COMMIT_UNAVAILABLE");
  const worktree = path.join(approved, `base-metamorpho-binding-${process.pid}-${crypto.randomBytes(8).toString("hex")}`);
  let added = false; let output; let cleanupFailed = false; let failure = null;
  try {
    run("git", ["worktree", "add", "--detach", worktree, AUTHORITY.sourceCommit], SOURCE_ROOT, "WORKTREE_ADD_FAILED"); added = true;
    const detachedHead = run("git", ["rev-parse", "HEAD"], worktree, "WORKTREE_STATE_MISMATCH").toLowerCase();
    if (detachedHead !== AUTHORITY.sourceCommit) stop("WORKTREE_STATE_MISMATCH");
    run("git", ["submodule", "update", "--init", "--recursive", "--checkout", "--no-fetch"], worktree, "SUBMODULE_UPDATE_FAILED");
    const status = run("git", ["submodule", "status", "--recursive"], worktree, "SUBMODULE_STATE_MISMATCH").split(/\r?\n/u).filter(Boolean);
    const direct = new Map();
    for (const line of status) {
      if (line[0] !== " ") stop("SUBMODULE_STATE_MISMATCH");
      const match = /^ ([0-9a-f]{40})\s+(\S+)/u.exec(line);
      if (!match) stop("SUBMODULE_STATE_MISMATCH");
      if (Object.hasOwn(SUBMODULES, match[2])) direct.set(match[2], match[1]);
    }
    if (direct.size !== Object.keys(SUBMODULES).length || Object.entries(SUBMODULES).some(([name, commit]) => direct.get(name) !== commit)) stop("SUBMODULE_STATE_MISMATCH");
    run("forge", ["--version"], worktree, "COMPILER_UNAVAILABLE");
    const buildResult = childProcess.spawnSync("forge", ["build", "--offline", "--root", worktree, "--use", AUTHORITY.solc,
      "--evm-version", AUTHORITY.evmVersion, "--via-ir", "--optimize", "--optimizer-runs", String(AUTHORITY.optimizerRuns), "--force"],
    { cwd: worktree, encoding: "utf8", windowsHide: true, shell: false, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    if (buildResult.error || buildResult.status !== 0 || buildResult.signal !== null) {
      const diagnostic = `${buildResult.error?.code || ""} ${buildResult.stderr || ""}`;
      stop(/(?:compiler|solc|svm).*(?:unavailable|not found|missing|offline|install)|offline.*(?:compiler|solc)/iu.test(diagnostic)
        ? "COMPILER_UNAVAILABLE" : "BUILD_FAILED");
    }
    const artifactPath = path.join(worktree, "out", "MetaMorphoV1_1Factory.sol", "MetaMorphoV1_1Factory.json");
    let artifact; try { artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8")); } catch (_) { stop("BUILD_ARTIFACT_INVALID"); }
    const object = artifact?.deployedBytecode?.object;
    const refs = artifact?.deployedBytecode?.immutableReferences;
    let metadata; try { metadata = JSON.parse(artifact.metadata); } catch (_) { stop("BUILD_ARTIFACT_INVALID"); }
    if (typeof object !== "string" || !/^0x[0-9a-f]+$/u.test(object) || !refs || typeof refs !== "object"
        || metadata?.compiler?.version?.split("+")[0] !== AUTHORITY.solc || metadata?.settings?.optimizer?.enabled !== true
        || metadata?.settings?.optimizer?.runs !== AUTHORITY.optimizerRuns || metadata?.settings?.viaIR !== true
        || metadata?.settings?.evmVersion !== AUTHORITY.evmVersion) stop("COMPILER_SETTINGS_MISMATCH");
    const immutableReferences = Object.values(refs).flat().map((row) => ({ start: row.start, length: row.length }));
    output = { authority: { ...AUTHORITY }, checkedOutHead, detachedHead, checkedOutUnchanged: true, detached: true,
      submodulesExact: true, submoduleCount: Object.keys(SUBMODULES).length, lockStateExact: true,
      runtime: Buffer.from(object.slice(2), "hex"), immutableReferences };
  } catch (error) {
    failure = error instanceof BindingError ? error : new BindingError("BUILD_FAILED");
  } finally {
    if (added) {
      const removed = childProcess.spawnSync("git", ["worktree", "remove", "--force", worktree], { cwd: SOURCE_ROOT, encoding: "utf8",
        windowsHide: true, shell: false, timeout: 60_000, maxBuffer: 1024 * 1024 });
      if (removed.error || removed.status !== 0) cleanupFailed = true;
    }
    if (fs.existsSync(worktree)) {
      try { fs.rmSync(worktree, { recursive: true, force: true }); } catch (_) { cleanupFailed = true; }
    }
  }
  if (cleanupFailed || fs.existsSync(worktree)) stop("TEMP_CLEANUP_FAILED", false);
  if (failure) { failure.cleanupComplete = true; throw failure; }
  const finalHead = run("git", ["rev-parse", "HEAD"], SOURCE_ROOT, "CHECKED_OUT_SOURCE_CHANGED").toLowerCase();
  if (!output || finalHead !== checkedOutHead) stop("CHECKED_OUT_SOURCE_CHANGED", true);
  output.cleanupComplete = true;
  return output;
}

function validateBuild(build) {
  if (!build || !same(build.authority, AUTHORITY)) stop("AUTHORITY_MISMATCH");
  if (build.detachedHead !== AUTHORITY.sourceCommit || build.detached !== true || build.checkedOutUnchanged !== true) stop("WORKTREE_STATE_MISMATCH");
  if (build.cleanupComplete !== true) stop("TEMP_CLEANUP_FAILED", false);
  if (build.submodulesExact !== true || build.submoduleCount !== Object.keys(SUBMODULES).length || build.lockStateExact !== true) {
    stop("SUBMODULE_STATE_MISMATCH", true);
  }
  if (!Buffer.isBuffer(build.runtime) || build.runtime.length === 0
      || !Array.isArray(build.immutableReferences) || build.immutableReferences.length === 0) stop("BUILD_ARTIFACT_INVALID", true);
  const ranges = build.immutableReferences.map((row) => {
    if (!row || !Number.isSafeInteger(row.start) || !Number.isSafeInteger(row.length) || row.start < 0 || row.length !== 32
        || row.start + row.length > build.runtime.length) stop("IMMUTABLE_REFERENCES_INVALID", true);
    return { start: row.start, length: row.length };
  }).sort((a, b) => a.start - b.start);
  for (let index = 1; index < ranges.length; index += 1) if (ranges[index].start < ranges[index - 1].start + 32) stop("IMMUTABLE_REFERENCES_INVALID", true);
  const expected = Buffer.from(build.runtime);
  const word = Buffer.from(`${"0".repeat(24)}${AUTHORITY.morpho.slice(2)}`, "hex");
  for (const range of ranges) word.copy(expected, range.start);
  return expected;
}

function quantity(value, code = "QUANTITY_INVALID") {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/u.test(value)) stop(code);
  return BigInt(value);
}
function exactHex(value, bytes, code) {
  if (typeof value !== "string" || !new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`, "u").test(value)) stop(code);
  return value;
}
function parseHeader(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) stop("HEADER_INVALID");
  const projection = { number: value.number, hash: exactHex(value.hash, 32, "HEADER_INVALID"), parentHash: exactHex(value.parentHash, 32, "HEADER_INVALID"),
    stateRoot: exactHex(value.stateRoot, 32, "HEADER_INVALID"), timestamp: value.timestamp };
  const number = quantity(value.number, "HEADER_INVALID"); quantity(value.timestamp, "HEADER_INVALID");
  return { number, hash: projection.hash, projection: canonical(projection) };
}
function code(value) {
  if (typeof value !== "string" || !/^0x(?:[0-9a-f]{2})+$/u.test(value)) stop("CODE_INVALID");
  const bytes = Buffer.from(value.slice(2), "hex"); if (bytes.length > 128 * 1024) stop("CODE_INVALID"); return bytes;
}

class Budget {
  constructor(options = {}) { this.started = Date.now(); this.requests = 0; this.bytes = 0; this.requestMs = options.requestMs ?? LIMITS.requestMs; }
  use() { if (++this.requests > LIMITS.requests || Date.now() - this.started > LIMITS.wallMs) stop("REQUEST_CAP"); }
  add(bytes) { if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > LIMITS.responseBytes) stop("RESPONSE_CAP"); this.bytes += bytes; if (this.bytes > LIMITS.totalResponseBytes) stop("RESPONSE_CAP"); }
}

async function fetchTransport({ candidate, envelope, timeoutMs }) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(candidate.url.href, { method: "POST", redirect: "error", signal: controller.signal,
      headers: { "content-type": "application/json", accept: "application/json", "accept-encoding": "identity" }, body: JSON.stringify(envelope) });
    if (response.status !== 200) stop("RPC_HTTP"); const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > LIMITS.responseBytes) stop("RESPONSE_CAP");
    let value; try { value = JSON.parse(text); } catch (_) { stop("RPC_JSON"); }
    return { value, bytes: Buffer.byteLength(text, "utf8") };
  } catch (error) { if (error instanceof BindingError) throw error; stop("RPC_TRANSPORT"); }
  finally { clearTimeout(timer); }
}

async function rpc(candidate, method, params, budget, transport) {
  if (!METHODS.has(method)) stop("METHOD_FORBIDDEN"); budget.use();
  const envelope = { jsonrpc: "2.0", id: budget.requests, method, params }; let timeout;
  let row;
  try { row = await Promise.race([transport({ candidate, envelope, timeoutMs: budget.requestMs }),
    new Promise((_, reject) => { timeout = setTimeout(() => reject(new BindingError("RPC_TIMEOUT")), budget.requestMs); })]); }
  catch (error) { if (error instanceof BindingError) throw error; stop("RPC_TRANSPORT"); }
  finally { clearTimeout(timeout); }
  if (!row || !Object.hasOwn(row, "value") || !Number.isSafeInteger(row.bytes)) stop("RPC_RESPONSE"); budget.add(row.bytes);
  const value = row.value;
  if (!value || value.jsonrpc !== "2.0" || value.id !== envelope.id || Object.hasOwn(value, "error") || !Object.hasOwn(value, "result")) stop("RPC_RESPONSE");
  return value.result;
}

function decodeAddressWord(value) {
  if (typeof value !== "string" || !/^0x0{24}[0-9a-f]{40}$/u.test(value)) stop("MORPHO_GETTER_INVALID");
  return `0x${value.slice(-40)}`;
}

async function qualify(candidate, budget, transport) {
  if (quantity(await rpc(candidate, "eth_chainId", [], budget, transport)) !== BigInt(AUTHORITY.chainId)) stop("WRONG_CHAIN");
  const header = parseHeader(await rpc(candidate, "eth_getBlockByNumber", ["finalized", false], budget, transport));
  if (header.number < BigInt(AUTHORITY.startBlock)) stop("FINALIZED_BEFORE_DEPLOYMENT");
  const pin = { blockHash: header.hash, requireCanonical: true };
  const factoryCode = code(await rpc(candidate, "eth_getCode", [AUTHORITY.factory, pin], budget, transport));
  const morphoCode = code(await rpc(candidate, "eth_getCode", [AUTHORITY.morpho, pin], budget, transport));
  const getter = decodeAddressWord(await rpc(candidate, "eth_call", [{ to: AUTHORITY.factory, data: MORPHO_SELECTOR }, pin], budget, transport));
  if (getter !== AUTHORITY.morpho) stop("MORPHO_GETTER_MISMATCH");
  return { candidate, header, factoryCode, morphoCode, getter };
}

function observationEqual(left, right) {
  return left.header.projection === right.header.projection && left.getter === right.getter
    && left.factoryCode.equals(right.factoryCode) && left.morphoCode.equals(right.morphoCode);
}

async function selectPair(candidates, budget, transport) {
  const rows = []; const families = new Set(); let qualifiedCount = 0;
  for (const candidate of candidates) {
    if (families.size >= LIMITS.families) break; if (families.has(candidate.family)) continue; families.add(candidate.family);
    let row; try { row = await qualify(candidate, budget, transport); } catch (_) { continue; }
    qualifiedCount += 1;
    for (const prior of rows) if (prior.candidate.family !== row.candidate.family && observationEqual(prior, row)) return { selected: [prior, row], qualifiedCount };
    rows.push(row);
  }
  stop("TWO_FAMILIES_UNAVAILABLE");
}

async function terminalRecheck(selected, budget, transport) {
  for (const row of selected) {
    const current = parseHeader(await rpc(row.candidate, "eth_getBlockByNumber", [`0x${row.header.number.toString(16)}`, false], budget, transport));
    if (current.projection !== row.header.projection) stop("TERMINAL_HEADER_CHANGED");
  }
}

function flags() { return { authorityExact: false, detachedWorktreeExact: false, dependenciesExact: false, buildExact: false,
  twoIndependentFamilies: false, finalizedAgreement: false, factoryCodeAgreement: false, morphoCodeAgreement: false,
  terminalHeaderStable: false, directTopology: false, boundMorpho: false, exactRuntime: false, inventoryStable: false }; }

function output(status, candidateCount, qualifiedCount, selected, budget, state, failure = null) {
  const core = { status, authorityCommitment: commitment("authority", canonical(AUTHORITY)), anonymousCandidateCount: candidateCount,
    anonymousQualifiedCount: qualifiedCount, anonymousFamilyCount: selected.length, readCount: budget.requests,
    selectedFamilyOrdinalCommitments: selected.map((row) => commitment("family-ordinal", String(row.candidate.ordinal))),
    failurePhase: failure?.failurePhase ?? null, failureCode: failure?.failureCode ?? null,
    temporaryWorktreeCleanupComplete: failure?.temporaryWorktreeCleanupComplete ?? (status === STATUS_BOUND ? true : null),
    binding: state, bindingCommitment: commitment("binding", canonical(state)), forkEligible: false, routePositive: false,
    execution: false, signed: false };
  return { ...core, derivedHash: commitment("derived", canonical(core)) };
}

async function runBinding(options = {}) {
  const state = flags(); const budget = new Budget(options); let candidates = []; let selected = []; let qualifiedCount = 0; let inventory = null;
  const checkInventory = options.assertInventoryUnchangedFn ?? inventoryUnchanged;
  try {
    const build = await (options.buildAdapter ?? exactBuild)();
    const expectedRuntime = validateBuild(build);
    state.authorityExact = true; state.detachedWorktreeExact = true; state.dependenciesExact = true; state.buildExact = true;
    try {
      inventory = options.inventoryText !== undefined ? { text: options.inventoryText, identity: options.inventoryIdentity ?? "injected" }
        : (options.readInventoryFn ? options.readInventoryFn() : readStableInventory());
      if (!inventory || typeof inventory.text !== "string" || !Object.hasOwn(inventory, "identity")) stop("INVENTORY_INVALID");
      candidates = parsePublicBaseInventory(inventory.text).slice(0, LIMITS.candidates);
    } catch (error) {
      if (error instanceof BindingError && FAILURE_CODES[error.code] === "INVENTORY") throw error;
      stop("INVENTORY_INVALID", true);
    }
    const transport = options.transport ?? fetchTransport;
    const pair = await selectPair(candidates, budget, transport); selected = pair.selected; qualifiedCount = pair.qualifiedCount;
    state.twoIndependentFamilies = true; state.finalizedAgreement = true; state.factoryCodeAgreement = true; state.morphoCodeAgreement = true;
    if (!selected[0].factoryCode.equals(expectedRuntime)) stop("RUNTIME_MISMATCH");
    state.directTopology = true; state.boundMorpho = true; state.exactRuntime = true;
    await terminalRecheck(selected, budget, transport); state.terminalHeaderStable = true;
    try { checkInventory(inventory.identity); } catch (_) { stop("INVENTORY_MUTATED", true); }
    state.inventoryStable = true;
    return output(STATUS_BOUND, candidates.length, qualifiedCount, selected, budget, state);
  } catch (error) {
    if (inventory) try { checkInventory(inventory.identity); state.inventoryStable = true; } catch (_) { state.inventoryStable = false; }
    const failure = sanitizedFailure(error);
    if (failure.temporaryWorktreeCleanupComplete === null && state.buildExact) failure.temporaryWorktreeCleanupComplete = true;
    return output(STATUS_INCOMPLETE, candidates.length, qualifiedCount, selected, budget, state, failure);
  }
}

async function runBuildOnly(options = {}) {
  const core = { status: "BUILD_READY", failurePhase: null, failureCode: null, temporaryWorktreeCleanupComplete: null,
    authorityExact: false, detachedWorktreeExact: false, dependenciesExact: false, compilerExact: false, buildExact: false };
  try {
    const build = await (options.buildAdapter ?? exactBuild)();
    validateBuild(build);
    core.temporaryWorktreeCleanupComplete = true;
    core.authorityExact = true;
    core.detachedWorktreeExact = true;
    core.dependenciesExact = true;
    core.compilerExact = true;
    core.buildExact = true;
  } catch (error) {
    const failure = sanitizedFailure(error);
    core.status = STATUS_INCOMPLETE;
    core.failurePhase = failure.failurePhase;
    core.failureCode = failure.failureCode;
    core.temporaryWorktreeCleanupComplete = failure.temporaryWorktreeCleanupComplete;
  }
  return { ...core, derivedHash: commitment("derived", canonical(core)) };
}

async function main() {
  const result = await runBinding(); process.stdout.write(`${JSON.stringify(result)}\n`); if (result.status !== STATUS_BOUND) process.exitCode = 1;
}

module.exports = { APPROVED_TEMP, AUTHORITY, BindingError, FAILURE_PHASES, MORPHO_SELECTOR, STATUS_BOUND, STATUS_INCOMPLETE,
  SUBMODULES, parsePublicBaseInventory, runBinding, runBuildOnly };
if (require.main === module) main();
