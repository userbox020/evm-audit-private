"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const { parseInventoryText: parsePublicBaseInventory } = require("./run-base-fluid-spell-rpc-fallback");

const ROOT = path.resolve(__dirname, "..");
const INVENTORY_FILE = path.join(ROOT, "rpc_endpoints.txt");
const APPROVED_TEMP = "C:\\Users\\MiPC\\AppData\\Local\\Temp\\opencode";
const SOURCE_REMOTE = "https://github.com/curvefi/twocrypto-ng.git";
const AUTHORITY = Object.freeze({
  chainId: 8453,
  factory: "0xc9fe0c63af9a39402e8a5514f9c43af0322b665f",
  sourceRepository: "curvefi/twocrypto-ng",
  sourceCommit: "d6755cb2ac64c1a3823f552911c59dc9a42a21fb",
  sourcePath: "contracts/main/CurveTwocryptoFactory.vy",
  sourceBlobSha1: "6c1f754d9e01a37bfbd013284a27c1a6724582c4",
  compilerVersion: "0.3.10",
  optimize: "gas",
  evmVersion: "paris",
  constructorArgs: ""
});
const METHODS = new Set(["eth_chainId", "eth_getBlockByNumber", "eth_getCode"]);
const STATUS_BOUND = "EXACT_FACTORY_RUNTIME_BOUND";
const STATUS_INCOMPLETE = "INCOMPLETE";
const PHASES = Object.freeze(["AUTHORITY", "SOURCE", "COMPILER", "BUILD", "INVENTORY", "QUALIFICATION", "RUNTIME", "TERMINAL"]);
const CODES = Object.freeze({
  TEMP_ROOT_INVALID: "AUTHORITY", SOURCE_FETCH_FAILED: "AUTHORITY", SOURCE_COMMIT_MISMATCH: "AUTHORITY", AUTHORITY_MISMATCH: "AUTHORITY",
  SOURCE_MANIFEST_INVALID: "SOURCE", SOURCE_FACTORY_INVALID: "SOURCE", SOURCE_COMPILER_PIN_INVALID: "SOURCE",
  SOURCE_DEPENDENCY_INVALID: "SOURCE", SOURCE_CLEANLINESS_INVALID: "SOURCE", TEMP_CLEANUP_FAILED: "SOURCE",
  COMPILER_UNAVAILABLE: "COMPILER", COMPILER_INSTALL_FAILED: "COMPILER", COMPILER_VERSION_MISMATCH: "COMPILER",
  COMPILER_IDENTITY_MISMATCH: "COMPILER",
  BUILD_FAILED: "BUILD", BUILD_ARTIFACT_INVALID: "BUILD", BUILD_AUTHORITY_MISMATCH: "BUILD",
  INVENTORY_INVALID: "INVENTORY", INVENTORY_MUTATED: "INVENTORY",
  TWO_FAMILIES_UNAVAILABLE: "QUALIFICATION", WRONG_CHAIN: "QUALIFICATION", HEADER_INVALID: "QUALIFICATION",
  CODE_INVALID: "QUALIFICATION", METHOD_FORBIDDEN: "QUALIFICATION", REQUEST_CAP: "QUALIFICATION",
  RESPONSE_CAP: "QUALIFICATION", RPC_HTTP: "QUALIFICATION", RPC_JSON: "QUALIFICATION", RPC_TRANSPORT: "QUALIFICATION",
  RPC_TIMEOUT: "QUALIFICATION", RPC_RESPONSE: "QUALIFICATION", QUANTITY_INVALID: "QUALIFICATION",
  RUNTIME_MISMATCH: "RUNTIME", TERMINAL_HEADER_CHANGED: "TERMINAL"
});
const LIMITS = Object.freeze({ inventoryBytes: 1024 * 1024, candidates: 12, families: 8, requests: 48,
  requestMs: 15_000, wallMs: 120_000, responseBytes: 256 * 1024, totalResponseBytes: 4 * 1024 * 1024 });

class CurveBindingError extends Error {
  constructor(code, cleanupComplete = null, compilerVersion = null) {
    super(code); this.name = "CurveBindingError"; this.code = code; this.cleanupComplete = cleanupComplete; this.compilerVersion = compilerVersion;
  }
}
const stop = (code, cleanupComplete = null, compilerVersion = null) => { throw new CurveBindingError(code, cleanupComplete, compilerVersion); };

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function commitment(namespace, value) { return `${namespace}_${crypto.createHash("sha256").update(`${namespace}:${value}`).digest("base64url")}`; }
function same(left, right) { return canonical(left) === canonical(right); }
function identity(stat) { return { dev: String(stat.dev), ino: String(stat.ino), size: Number(stat.size), mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs }; }
function failureFor(error, fallback = "BUILD_FAILED") {
  const candidate = error instanceof CurveBindingError ? error.code : fallback;
  const failureCode = Object.hasOwn(CODES, candidate) ? candidate : fallback;
  return { failurePhase: PHASES.includes(CODES[failureCode]) ? CODES[failureCode] : "BUILD", failureCode,
    temporaryMaterialCleanupComplete: error instanceof CurveBindingError && typeof error.cleanupComplete === "boolean" ? error.cleanupComplete : null };
}

function readStableInventory() {
  let before; let real; let fd; let heldBefore; let bytes; let heldAfter; let after;
  try {
    before = fs.lstatSync(INVENTORY_FILE); real = fs.realpathSync.native(INVENTORY_FILE);
    if (!before.isFile() || before.isSymbolicLink() || real !== INVENTORY_FILE || before.size < 1 || before.size > LIMITS.inventoryBytes) stop("INVENTORY_INVALID");
    fd = fs.openSync(INVENTORY_FILE, "r"); heldBefore = fs.fstatSync(fd); bytes = fs.readFileSync(fd); heldAfter = fs.fstatSync(fd); after = fs.lstatSync(INVENTORY_FILE);
  } catch (error) { if (error instanceof CurveBindingError) throw error; stop("INVENTORY_INVALID"); }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {} }
  if (bytes.length !== before.size || !same(identity(before), identity(after)) || !same(identity(heldBefore), identity(heldAfter))
      || String(before.dev) !== String(heldBefore.dev) || String(before.ino) !== String(heldBefore.ino)) stop("INVENTORY_MUTATED");
  return { text: bytes.toString("utf8"), identity: identity(after) };
}
function inventoryUnchanged(expected) {
  let stat; let real; try { stat = fs.lstatSync(INVENTORY_FILE); real = fs.realpathSync.native(INVENTORY_FILE); } catch (_) { stop("INVENTORY_MUTATED"); }
  if (!stat.isFile() || stat.isSymbolicLink() || real !== INVENTORY_FILE || !same(identity(stat), expected)) stop("INVENTORY_MUTATED");
}

function providerFamily(hostname) {
  const labels = hostname.toLowerCase().split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const finalTwo = labels.slice(-2).join(".");
  return /^(?:co|com|net|org)\.[a-z]{2}$/u.test(finalTwo) ? labels.slice(-3).join(".") : finalTwo;
}
function placeholderEndpoint(url, context) {
  const host = url.hostname.toLowerCase();
  if (/(?:^|\.)(?:example|placeholder|invalid)(?:\.|$)/u.test(host)) return true;
  let material; try { material = decodeURIComponent(`${url.pathname} ${url.search}`); } catch (_) { return true; }
  return /(?:\{|\}|<|>|\$\{|your[-_ ]?(?:api[-_ ]?)?key|replace[-_ ]?(?:me|this)|insert[-_ ]?(?:key|token)|placeholder|changeme|api[-_ ]?key[-_ ]?here)/iu.test(`${context} ${material}`);
}
function parseAuthorizedBaseInventory(text) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") < 1 || Buffer.byteLength(text, "utf8") > LIMITS.inventoryBytes) stop("INVENTORY_INVALID");
  const candidates = []; const seen = new Set(); let section = ""; let ordinal = 0;
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed && trimmed.length <= 512 && !/https?:\/\//iu.test(trimmed)) section = trimmed;
    for (const match of line.matchAll(/https?:\/\/[^\s<'"`\])}]+/giu)) {
      const localOrdinal = ordinal++; let url;
      try { url = new URL(match[0].replace(/[>,.;]+$/u, "")); } catch (_) { continue; }
      const context = `${section} ${line}`; const lower = context.toLowerCase(); const rowLower = line.toLowerCase();
      const baseDeclared = /\bbase(?:[- _]?mainnet)?\b|\b(?:chain(?:id)?|eip155)\s*[:=]?\s*8453\b/u.test(lower);
      const baseOnRow = /\bbase(?:[- _]?mainnet)?\b|\b(?:chain(?:id)?|eip155)\s*[:=]?\s*8453\b/u.test(rowLower);
      const otherChainOnRow = /\b(?:ethereum|eth[- _]?mainnet|arbitrum|optimism|polygon|bnb|bsc|avalanche|linea|scroll|zksync|solana)\b/u.test(rowLower);
      const forbiddenContext = /\b(?:restricted|unavailable|disabled|retired|deprecated|unsupported|failed|dead|app[- _]?scoped|private|internal)\b|\bdo[- ]?not[- ]?use\b/iu.test(lower)
        || /\b(?:origin[- _]?required|browser[- _]?only|session[- _]?auth|session|cookie|referer|cors)\b|\brequires?\b[^\r\n]{0,40}\borigin\b/iu.test(lower)
        || /\b(?:custom[- _]?headers?|authorization|bearer|x[- _]?api[- _]?key)\b|\brequires?\b[^\r\n]{0,40}\bheaders?\b/iu.test(lower);
      const forbiddenUrl = url.protocol !== "https:" || Boolean(url.username || url.password || url.hash)
        || (url.port !== "" && url.port !== "443") || /(?:localhost|\.local|\.internal|\.invalid)$/u.test(url.hostname.toLowerCase())
        || /^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/u.test(url.hostname);
      if (!baseDeclared || (otherChainOnRow && !baseOnRow) || forbiddenContext || forbiddenUrl || placeholderEndpoint(url, context)) continue;
      const key = url.href; if (seen.has(key)) continue; seen.add(key);
      candidates.push({ url, family: providerFamily(url.hostname), ordinal: localOrdinal });
      if (candidates.length >= LIMITS.candidates) return candidates;
    }
  }
  return candidates;
}

function spawn(executable, args, cwd, env = process.env) {
  return childProcess.spawnSync(executable, args, { cwd, encoding: "utf8", windowsHide: true, shell: false,
    timeout: 180_000, maxBuffer: 8 * 1024 * 1024, env });
}
function command(executable, args, cwd, code, env = process.env) {
  const result = spawn(executable, args, cwd, env);
  if (result.error || result.status !== 0 || result.signal !== null) stop(code);
  return String(result.stdout || "").trim();
}
function sourceFiles(root) {
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute); else if (entry.isFile()) files.push(absolute);
      if (files.length > 10_000) stop("SOURCE_DEPENDENCY_INVALID");
    }
  }
  visit(root); return files;
}
function readBounded(file, max = 1024 * 1024) {
  const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) stop("SOURCE_DEPENDENCY_INVALID");
  return fs.readFileSync(file, "utf8");
}
function derivePinnedSource(root) {
  const files = sourceFiles(root);
  const factoryFile = path.join(root, ...AUTHORITY.sourcePath.split("/")); let stat; let realFactory;
  try { stat = fs.lstatSync(factoryFile); realFactory = fs.realpathSync.native(factoryFile); }
  catch (_) { stop("SOURCE_FACTORY_INVALID"); }
  if (!stat.isFile() || stat.isSymbolicLink() || !isWithin(fs.realpathSync.native(root), realFactory)) stop("SOURCE_FACTORY_INVALID");
  const factoryText = readBounded(factoryFile);
  const pragma = /#\s*(?:pragma\s+version|@version)\s+([^\r\n]+)/iu.exec(factoryText);
  const pragmaVersion = pragma && /(?:^|[^0-9])(\d+\.\d+\.\d+)(?=$|[^0-9])/u.exec(pragma[1])?.[1];
  if (!pragmaVersion || pragmaVersion !== AUTHORITY.compilerVersion) stop("SOURCE_COMPILER_PIN_INVALID");
  const controlFiles = files.filter((file) => /^(?:pyproject\.toml|requirements[^/]*\.txt|setup\.cfg|ape-config\.ya?ml)$/iu.test(path.basename(file)));
  const pins = [];
  for (const file of controlFiles) {
    const text = readBounded(file); for (const match of text.matchAll(/\bvyper\s*(?:==|=)\s*["']?(\d+\.\d+\.\d+)/giu)) pins.push(match[1]);
  }
  if (pins.length > 0 && !pins.includes(pragmaVersion)) stop("SOURCE_COMPILER_PIN_INVALID");
  return { factoryFile, compilerVersion: pragmaVersion, sourceFileCount: files.length };
}

function exactVersion(text) {
  if (typeof text !== "string") return null;
  const matches = [...text.matchAll(/(?:^|[^0-9])(\d+\.\d+\.\d+)(?=$|[^0-9])/gu)].map((match) => match[1]);
  return matches.length === 1 ? matches[0] : null;
}
function assertCompilerAgreement(declaredVersion, installed) {
  if (!/^\d+\.\d+\.\d+$/u.test(declaredVersion) || !installed || typeof installed !== "object"
      || installed.distributionVersion !== declaredVersion || installed.moduleVersion !== declaredVersion
      || exactVersion(installed.cliIdentity) !== declaredVersion) stop("COMPILER_VERSION_MISMATCH", null, declaredVersion);
  return declaredVersion;
}
function isWithin(root, file) {
  const relative = path.relative(root, file); return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}
function probeCompiler(python, venv, cwd, env, declaredVersion) {
  const probe = [
    "import importlib.metadata,json,os,sys,vyper",
    "print(json.dumps({'distributionVersion':importlib.metadata.version('vyper'),'moduleVersion':vyper.__version__,'pythonExecutable':os.path.realpath(sys.executable),'moduleFile':os.path.realpath(vyper.__file__)}))"
  ].join(";");
  let installed;
  try { installed = JSON.parse(command(python, ["-I", "-c", probe], cwd, "COMPILER_IDENTITY_MISMATCH", env)); }
  catch (error) { if (error instanceof CurveBindingError) throw error; stop("COMPILER_IDENTITY_MISMATCH"); }
  const expectedPython = fs.realpathSync.native(python); let actualPython; let moduleFile; let realVenv;
  try { actualPython = fs.realpathSync.native(installed.pythonExecutable); moduleFile = fs.realpathSync.native(installed.moduleFile); realVenv = fs.realpathSync.native(venv); }
  catch (_) { stop("COMPILER_IDENTITY_MISMATCH"); }
  if (actualPython !== expectedPython || !isWithin(realVenv, moduleFile)) stop("COMPILER_IDENTITY_MISMATCH");
  installed.cliIdentity = command(python, ["-I", "-m", "vyper", "--version"], cwd, "COMPILER_IDENTITY_MISMATCH", env);
  assertCompilerAgreement(declaredVersion, installed); return installed;
}

function exactBuild(options = {}) {
  const approved = path.resolve(APPROVED_TEMP); let stat; let real;
  try { stat = fs.lstatSync(approved); real = fs.realpathSync.native(approved); } catch (_) { stop("TEMP_ROOT_INVALID", true); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || real !== approved) stop("TEMP_ROOT_INVALID", true);
  const temporary = path.join(approved, `base-curve-binding-${process.pid}-${crypto.randomBytes(8).toString("hex")}`);
  let output = null; let failure = null; let cleanupFailed = false; let declaredVersion = null;
  try {
    fs.mkdirSync(temporary);
    if (options.temporaryBuildAdapter) {
      output = options.temporaryBuildAdapter({ temporary, assertCompilerAgreement });
      declaredVersion = output?.compilerVersion ?? null;
      if (!output || typeof output !== "object") stop("BUILD_FAILED");
    } else {
      const source = path.join(temporary, "source"); const venv = path.join(temporary, "venv");
    const pipCache = path.join(temporary, "pip-cache"); const processTemp = path.join(temporary, "process-temp");
    fs.mkdirSync(source); fs.mkdirSync(pipCache); fs.mkdirSync(processTemp);
    const isolatedEnv = { ...process.env, PIP_CACHE_DIR: pipCache, PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1",
      TEMP: processTemp, TMP: processTemp, TMPDIR: processTemp, XDG_CACHE_HOME: pipCache };
    command("git", ["init", "--quiet"], source, "SOURCE_FETCH_FAILED", isolatedEnv);
    command("git", ["config", "core.autocrlf", "false"], source, "SOURCE_FETCH_FAILED", isolatedEnv);
    command("git", ["config", "core.eol", "lf"], source, "SOURCE_FETCH_FAILED", isolatedEnv);
    command("git", ["remote", "add", "origin", SOURCE_REMOTE], source, "SOURCE_FETCH_FAILED", isolatedEnv);
    command("git", ["fetch", "--quiet", "--depth=1", "origin", AUTHORITY.sourceCommit], source, "SOURCE_FETCH_FAILED", isolatedEnv);
    command("git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], source, "SOURCE_FETCH_FAILED", isolatedEnv);
    const head = command("git", ["rev-parse", "HEAD"], source, "SOURCE_COMMIT_MISMATCH", isolatedEnv).toLowerCase();
    if (head !== AUTHORITY.sourceCommit) stop("SOURCE_COMMIT_MISMATCH");
    const gitmodules = path.join(source, ".gitmodules");
    if (fs.existsSync(gitmodules)) command("git", ["submodule", "update", "--init", "--recursive", "--checkout", "--depth=1"], source, "SOURCE_DEPENDENCY_INVALID", isolatedEnv);
    const derived = derivePinnedSource(source); declaredVersion = derived.compilerVersion;
    const treeBlob = command("git", ["rev-parse", `HEAD:${AUTHORITY.sourcePath}`], source, "SOURCE_FACTORY_INVALID", isolatedEnv).toLowerCase();
    const worktreeBlob = command("git", ["hash-object", "--no-filters", AUTHORITY.sourcePath], source, "SOURCE_FACTORY_INVALID", isolatedEnv).toLowerCase();
    if (treeBlob !== AUTHORITY.sourceBlobSha1 || worktreeBlob !== AUTHORITY.sourceBlobSha1) stop("SOURCE_FACTORY_INVALID");
    command("python", ["-I", "-m", "venv", venv], temporary, "COMPILER_UNAVAILABLE", isolatedEnv);
    const python = path.join(venv, process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python");
    if (!fs.existsSync(python)) stop("COMPILER_UNAVAILABLE");
    command(python, ["-I", "-m", "pip", "--isolated", "install", "--disable-pip-version-check", "--no-input", "--no-warn-script-location",
      "--cache-dir", pipCache, `vyper==${derived.compilerVersion}`], temporary, "COMPILER_INSTALL_FAILED", isolatedEnv);
    probeCompiler(python, venv, temporary, isolatedEnv, derived.compilerVersion);
    const relativeFactory = path.relative(source, derived.factoryFile);
    const compiled = spawn(python, ["-I", "-m", "vyper", "-p", source, "--optimize", AUTHORITY.optimize,
      "--evm-version", AUTHORITY.evmVersion, "-f", "bytecode_runtime", relativeFactory], source, isolatedEnv);
    if (compiled.error || compiled.status !== 0 || compiled.signal !== null) stop("BUILD_FAILED");
    const artifact = String(compiled.stdout || "").trim().toLowerCase();
    if (!/^0x(?:[0-9a-f]{2})+$/u.test(artifact) || artifact.length > 256 * 1024) stop("BUILD_ARTIFACT_INVALID");
    if (command("git", ["status", "--porcelain", "--untracked-files=no"], source, "SOURCE_CLEANLINESS_INVALID", isolatedEnv) !== "") stop("SOURCE_CLEANLINESS_INVALID");
    output = { authority: { ...AUTHORITY }, sourceCommitExact: true, manifestExact: true, sourceClosureExact: true,
      sourcePath: AUTHORITY.sourcePath, sourceBlobSha1: treeBlob, sourceBlobExact: true, compilerPragma: derived.compilerVersion,
      compilerVersion: derived.compilerVersion, compilerExact: true, optimizer: AUTHORITY.optimize, evmVersion: AUTHORITY.evmVersion,
      constructorArgsEmpty: true, buildExact: true, runtime: Buffer.from(artifact.slice(2), "hex") };
    }
  } catch (error) {
    failure = error instanceof CurveBindingError ? error : new CurveBindingError("BUILD_FAILED");
    if (failure.compilerVersion === null && declaredVersion !== null) failure.compilerVersion = declaredVersion;
  }
  finally { try { fs.rmSync(temporary, { recursive: true, force: true }); } catch (_) { cleanupFailed = true; } }
  if (cleanupFailed || fs.existsSync(temporary)) stop("TEMP_CLEANUP_FAILED", false, declaredVersion);
  if (failure) { failure.cleanupComplete = true; throw failure; }
  output.cleanupComplete = true; return output;
}

function validateBuild(build) {
  if (!build || !same(build.authority, AUTHORITY) || build.sourceCommitExact !== true) stop("AUTHORITY_MISMATCH", build?.cleanupComplete === true);
  if (build.manifestExact !== true || build.sourceClosureExact !== true || build.sourcePath !== AUTHORITY.sourcePath
      || build.sourceBlobSha1 !== AUTHORITY.sourceBlobSha1 || build.sourceBlobExact !== true) stop("SOURCE_DEPENDENCY_INVALID", build.cleanupComplete === true);
  if (build.compilerVersion !== AUTHORITY.compilerVersion || build.compilerPragma !== AUTHORITY.compilerVersion
      || build.compilerExact !== true) stop("COMPILER_VERSION_MISMATCH", build.cleanupComplete === true);
  if (build.optimizer !== AUTHORITY.optimize || build.evmVersion !== AUTHORITY.evmVersion || build.constructorArgsEmpty !== true) stop("BUILD_AUTHORITY_MISMATCH", build.cleanupComplete === true);
  if (build.buildExact !== true || !Buffer.isBuffer(build.runtime) || build.runtime.length === 0) stop("BUILD_ARTIFACT_INVALID", build.cleanupComplete === true);
  if (build.cleanupComplete !== true) stop("TEMP_CLEANUP_FAILED", false);
  return build.runtime;
}

function quantity(value, error = "QUANTITY_INVALID") { if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/u.test(value)) stop(error); return BigInt(value); }
function fixedHex(value, bytes, error) { if (typeof value !== "string" || !new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`, "u").test(value)) stop(error); return value; }
function parseHeader(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) stop("HEADER_INVALID");
  const projection = { number: value.number, hash: fixedHex(value.hash, 32, "HEADER_INVALID"), parentHash: fixedHex(value.parentHash, 32, "HEADER_INVALID"),
    stateRoot: fixedHex(value.stateRoot, 32, "HEADER_INVALID"), timestamp: value.timestamp };
  const number = quantity(value.number, "HEADER_INVALID"); quantity(value.timestamp, "HEADER_INVALID");
  return { number, hash: projection.hash, projection: canonical(projection) };
}
function parseCode(value) {
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
    if (response.status !== 200) stop("RPC_HTTP"); const text = await response.text(); const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > LIMITS.responseBytes) stop("RESPONSE_CAP"); let value; try { value = JSON.parse(text); } catch (_) { stop("RPC_JSON"); }
    return { value, bytes };
  } catch (error) { if (error instanceof CurveBindingError) throw error; stop("RPC_TRANSPORT"); } finally { clearTimeout(timer); }
}
async function rpc(candidate, method, params, budget, transport) {
  if (!METHODS.has(method)) stop("METHOD_FORBIDDEN"); budget.use(); const envelope = { jsonrpc: "2.0", id: budget.requests, method, params }; let timer;
  let row; try { row = await Promise.race([transport({ candidate, envelope, timeoutMs: budget.requestMs }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new CurveBindingError("RPC_TIMEOUT")), budget.requestMs); })]); }
  catch (error) { if (error instanceof CurveBindingError) throw error; stop("RPC_TRANSPORT"); } finally { clearTimeout(timer); }
  if (!row || !Object.hasOwn(row, "value") || !Number.isSafeInteger(row.bytes)) stop("RPC_RESPONSE"); budget.add(row.bytes);
  if (!row.value || row.value.jsonrpc !== "2.0" || row.value.id !== envelope.id || Object.hasOwn(row.value, "error") || !Object.hasOwn(row.value, "result")) stop("RPC_RESPONSE");
  return row.value.result;
}
async function qualify(candidate, budget, transport) {
  if (quantity(await rpc(candidate, "eth_chainId", [], budget, transport)) !== BigInt(AUTHORITY.chainId)) stop("WRONG_CHAIN");
  const header = parseHeader(await rpc(candidate, "eth_getBlockByNumber", ["finalized", false], budget, transport));
  const runtime = parseCode(await rpc(candidate, "eth_getCode", [AUTHORITY.factory, { blockHash: header.hash, requireCanonical: true }], budget, transport));
  return { candidate, header, runtime };
}
function observationsEqual(left, right) { return left.header.projection === right.header.projection && left.runtime.equals(right.runtime); }
async function selectPair(candidates, budget, transport) {
  const rows = []; const families = new Set(); let qualifiedCount = 0;
  for (const candidate of candidates) {
    if (families.size >= LIMITS.families) break; if (families.has(candidate.family)) continue; families.add(candidate.family);
    let row; try { row = await qualify(candidate, budget, transport); } catch (_) { continue; }
    qualifiedCount += 1; for (const prior of rows) if (prior.candidate.family !== row.candidate.family && observationsEqual(prior, row)) return { selected: [prior, row], qualifiedCount };
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
function flags() { return { authorityExact: false, sourceExact: false, compilerExact: false, buildExact: false, twoIndependentFamilies: false,
  finalizedAgreement: false, factoryCodeAgreement: false, terminalHeaderStable: false, directTopology: false, exactRuntime: false, inventoryStable: false }; }
function result(status, state, budget, candidates, qualifiedCount, selected, failure = null) {
  const core = { status, authorityCommitment: commitment("authority", canonical(AUTHORITY)), anonymousCandidateCount: candidates.length,
    anonymousQualifiedCount: qualifiedCount, anonymousFamilyCount: selected.length, readCount: budget.requests,
    selectedFamilyOrdinalCommitments: selected.map((row) => commitment("family-ordinal", String(row.candidate.ordinal))),
    failurePhase: failure?.failurePhase ?? null, failureCode: failure?.failureCode ?? null,
    temporaryMaterialCleanupComplete: failure?.temporaryMaterialCleanupComplete ?? (status === STATUS_BOUND ? true : null),
    binding: state, bindingCommitment: commitment("binding", canonical(state)), forkEligible: false, routePositive: false,
    fork: false, trace: false, transaction: false, execution: false, signed: false, broadcast: false, wallet: false, funds: false };
  return { ...core, derivedCommitment: commitment("derived", canonical(core)) };
}
async function runBinding(options = {}) {
  const state = flags(); const budget = new Budget(options); let candidates = []; let qualifiedCount = 0; let selected = []; let inventory = null;
  const checkInventory = options.assertInventoryUnchangedFn ?? inventoryUnchanged;
  try {
    const expected = validateBuild(await (options.buildAdapter ?? exactBuild)());
    state.authorityExact = true; state.sourceExact = true; state.compilerExact = true; state.buildExact = true;
    try {
      inventory = options.inventoryText !== undefined ? { text: options.inventoryText, identity: options.inventoryIdentity ?? "injected" }
        : (options.readInventoryFn ? options.readInventoryFn() : readStableInventory());
      if (!inventory || typeof inventory.text !== "string" || !Object.hasOwn(inventory, "identity")) stop("INVENTORY_INVALID");
      const parseInventory = options.inventoryAuthorizedMode === false ? parsePublicBaseInventory : parseAuthorizedBaseInventory;
      candidates = parseInventory(inventory.text).slice(0, LIMITS.candidates);
    } catch (error) { if (error instanceof CurveBindingError && CODES[error.code] === "INVENTORY") throw error; stop("INVENTORY_INVALID", true); }
    const pair = await selectPair(candidates, budget, options.transport ?? fetchTransport); selected = pair.selected; qualifiedCount = pair.qualifiedCount;
    state.twoIndependentFamilies = true; state.finalizedAgreement = true; state.factoryCodeAgreement = true;
    if (!selected[0].runtime.equals(expected)) stop("RUNTIME_MISMATCH", true);
    await terminalRecheck(selected, budget, options.transport ?? fetchTransport); state.terminalHeaderStable = true;
    try { checkInventory(inventory.identity); } catch (_) { stop("INVENTORY_MUTATED", true); }
    state.inventoryStable = true; state.directTopology = true; state.exactRuntime = true;
    return result(STATUS_BOUND, state, budget, candidates, qualifiedCount, selected);
  } catch (error) {
    if (inventory) try { checkInventory(inventory.identity); state.inventoryStable = true; } catch (_) { state.inventoryStable = false; }
    const failure = failureFor(error); if (failure.temporaryMaterialCleanupComplete === null && state.buildExact) failure.temporaryMaterialCleanupComplete = true;
    return result(STATUS_INCOMPLETE, state, budget, candidates, qualifiedCount, selected, failure);
  }
}
async function runBuildOnly(options = {}) {
  const core = { status: "BUILD_READY", failurePhase: null, failureCode: null, temporaryMaterialCleanupComplete: null,
    compilerVersion: null, authorityExact: false, sourceExact: false, compilerExact: false, buildExact: false };
  try { const build = await (options.buildAdapter ?? exactBuild)(); validateBuild(build); core.temporaryMaterialCleanupComplete = true;
    core.compilerVersion = build.compilerVersion;
    core.authorityExact = true; core.sourceExact = true; core.compilerExact = true; core.buildExact = true;
  } catch (error) { const failure = failureFor(error); core.status = STATUS_INCOMPLETE; Object.assign(core, failure);
    core.compilerVersion = error instanceof CurveBindingError ? error.compilerVersion : null; }
  return { ...core, derivedCommitment: commitment("derived", canonical(core)) };
}
async function main() {
  if (process.argv.length === 3 && process.argv[2] === "--build-only") {
    const output = await runBuildOnly(); const sanitized = { phase: output.failurePhase, code: output.failureCode,
      compilerVersion: output.compilerVersion, cleanupComplete: output.temporaryMaterialCleanupComplete };
    process.stdout.write(`${JSON.stringify(sanitized)}\n`); if (output.status !== "BUILD_READY") process.exitCode = 1; return;
  }
  if (process.argv.length !== 2) stop("AUTHORITY_MISMATCH");
  const output = await runBinding(); process.stdout.write(`${JSON.stringify(output)}\n`); if (output.status !== STATUS_BOUND) process.exitCode = 1;
}

module.exports = { APPROVED_TEMP, AUTHORITY, CODES, CurveBindingError, PHASES, STATUS_BOUND, STATUS_INCOMPLETE,
  assertCompilerAgreement, exactBuild, inventoryUnchanged, parseAuthorizedBaseInventory, parsePublicBaseInventory,
  readStableInventory, runBinding, runBuildOnly };
if (require.main === module) main();
