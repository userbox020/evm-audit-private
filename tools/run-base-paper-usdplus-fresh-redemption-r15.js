"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { Interface, id, ZeroAddress } = require("ethers");
const { requestJSON, header: parseHeader } = require("./run-base-redemption-paper-state-r1");
const { readCandidates } = require("./run-base-paper-usdplus-exit-r13");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(ROOT, "reports/raw/fast/base-paper-usdplus-r15");
const OUTPUT_FILE = path.join(OUTPUT_DIR, "fresh-redemption.json");
const SCHEMA = "base-paper-usdplus-fresh-redemption/v15";
const EIP1967 = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const MANAGER_ASSET_SLOT = "0xfc"; // slot 252, derived from the exact 0.8.17 storage layout.
const RAY = 10n ** 27n;
const SIZES = Object.freeze([1n, 1_000_000n, 100_000_000n]);
const A = Object.freeze({
  actor: "0x000000000000000000000000000000000000b0b0", venue: "0x0c1a09d5d0445047da3ab4994262b22404288a3b",
  exchange: "0x7cb1b38591021309c64f451859d79312d8ca2789", exchangeImpl: "0x10a013eb5d9f23dcd4b8f51321d6ea7d462927d4",
  manager: "0x27b12f3282f1d02682d7d1ad30e45e818b78f7b8", managerImpl: "0xb008d09d25f06799e4081877a6bb185d89d893d3",
  cash: "0x687ac878bc93610366b705c385cd0a0038493dbb", cashImpl: "0xebeac3cd336e592defd6b53548fadde22900d3df",
  usdPlus: "0xb79dd08ea68a908a97220c76d19a6aa9cbde4376", usdPlusImpl: "0xe1201f02c02e468c7ff6f61afff505a859673cfd",
  role: "0xa5096260710d135f9c3762fcd07b6b2e2fd127d1", roleImpl: "0x3e1f4163a61113e8a11b72d4cb388f7cb609d3a2",
  usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", aaveProvider: "0xe20fcbdbffc4dd138ce8b2e6fbb6cb49777ad64d",
  pool: "0xa238dd80c259a72e81d7e4664a9801593f98d1c5", poolImpl: "0xa4abc5fcba6d0d7e3d144d6dbf6cb6128599dfdb",
  aToken: "0x4e65fe4dba92790696d040ac24aa414708f5c0ab", supplyLogic: "0x584c7d8c4cb05304fe5ac7fbc97f20a10fb07564",
  poolLogic: "0xd70593841c57cbaa04957cc3eace95708e48853b", m2m: "0x1f4947cd5a5c058dd5ea6fd1ccd5c311ada9e6fb",
});
const CAP = Object.freeze({ candidates: 8, qualificationRequests: 48, captureRequests: 180, relayRequests: 2400, localRequests: 260,
  requestBytes: 8 * 1024 * 1024, totalBytes: 256 * 1024 * 1024, requestMs: 10000, wallMs: 360000, maxAgeSeconds: 3600 });
const BASELINES = Object.freeze({
  "reports/raw/fast/base-paper-usdplus-r11/build-manifest.json": "84bc2eb07fb48bb703c9316a27a71c4b5bb4cd52e2db3fd67cd6300b0e75a4e5",
  "reports/raw/fast/base-paper-usdplus-r11/exchange-proxy.compiled.json": "984b9e89e4300255fe64d8bfed84f90baba24265c7a2ada3e7ac0f9508fdfa00",
  "reports/raw/fast/base-paper-usdplus-r11/exchange-implementation.compiled.json": "360989e356dd09b1aa43bf6091ab84743fb50f05de33917bb3d9759a2c43aa01",
  "reports/raw/fast/base-paper-usdplus-r11/manager-proxy.compiled.json": "511c86232ccf15fc4d6c3a919b5e2538ab19d7c133334a08bc9effce3d2a9f0d",
  "reports/raw/fast/base-paper-usdplus-r11/manager-implementation.compiled.json": "668e55e486eac52cb49dc72b1c1110ff69a7d69bae3ea1389f4ed59bd74099a2",
  "reports/raw/fast/base-paper-usdplus-r11/manager-implementation.input.json": "6bed366ac6dc5259db11de56990b54ef17a3e6473a1be55e11aa3ce47a9c6b72",
  "reports/raw/fast/base-paper-usdplus-r11/cash-proxy.compiled.json": "6113171151c66fb7314b68d2062935cd53cf09ba023e3001ae1562856483bcc3",
  "reports/raw/fast/base-paper-usdplus-r12/source-build.json": "4205b78a2e67d462e32564f426ff9a57c7e7427b8b44f546b4f32f03b316fb1a",
  "reports/raw/fast/base-paper-usdplus-r12/cash.compiled.json": "d978644070d862779b7e2beae22a9b7baa30c6af37622564569c42713c50b7c8",
  "reports/raw/fast/base-paper-usdplus-r13/active-token-exact-build.json": "7b782f931221f1ac4441cbb95c4727ef05abb7e77b475bd33e595407419f9a6a",
  "reports/raw/fast/base-paper-usdplus-r13/active-token.compiled.json": "6e4b94fafb553cd9095d7c31979628270896688a13902f65e86867e32b67165d",
  "reports/raw/fast/base-paper-usdplus-r13/role.compiled.json": "3b6e0b5fe94882b1e3bcf59d9423cb389ec0180e8be4f155cc4ffe6a96b9b4dc",
  "reports/raw/fast/base-paper-usdplus-r13/aave/active/linked-build.json": "8a540bf5f8bca304cd0d5065fa80b081c067b2e71d1d2d852c1ee21a7e92c7fa",
  "reports/raw/fast/base-paper-usdplus-r13/aave/active/withdrawal-compiled.json": "fe573d41693023d75ca86b408f037caabb6ce2e77e0be230d3e7759af6012d4a",
  "reports/raw/fast/base-paper-usdplus-r14/redemption-fork.json": "e6beb48c6634d57f5a166cb5c9950b3ae151d1e82f10e9027820daaf30c1b962",
  "reports/raw/fast/base-paper-usdplus-r14/redemption-fork-correction.json": "144321dc1812c9ac7b552e754c79ffe0c7331eabe1f8b5f182150d48470c069e",
  "reports/raw/fast/base-paper-usdplus-r14/redemption-fork-correction-v2.json": "b27bd176f4d7b595d6039d54cd4f5b74e4708b19de8a5ce9af4dafa0791964c4",
});
const UPSTREAM = new Set(["eth_chainId", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getBalance", "eth_getCode", "eth_getStorageAt", "eth_getProof", "eth_call", "eth_getTransactionCount", "eth_gasPrice", "eth_getBlockReceipts", "eth_getTransactionByHash", "eth_getTransactionReceipt"]);

class R15Error extends Error { constructor(stage, code) { super(code); this.stage = stage; this.code = code; } }
const fail = (stage, code) => { throw new R15Error(stage, code); };
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);
const lower = value => String(value || "").toLowerCase();
const wordAddress = value => /^0x[0-9a-f]{64}$/i.test(value || "") ? `0x${value.slice(-40)}`.toLowerCase() : fail("DECODE", "ADDRESS_WORD_INVALID");
const blockRef = pin => ({ blockHash: pin.hash, requireCanonical: true });

function parseCli(argv) { if (!Array.isArray(argv) || argv.length !== 1 || argv[0] !== "--run-once") fail("CLI", "EXPLICIT_RUN_ONCE_REQUIRED"); return true; }
function provenance(readFile = fs.readFileSync) { return { runner: "tools/run-base-paper-usdplus-fresh-redemption-r15.js", runnerSha256: sha(readFile(__filename)), schema: SCHEMA, version: 15 }; }
function sanitized(value) { return !/(?:https?|wss?):\/\/|authorization|bearer\s|api[-_]?key|token=|rpc_endpoints\.txt/i.test(typeof value === "string" ? value : JSON.stringify(value)); }

function preflight(options = {}) {
  const root = options.root || ROOT, specs = options.specs || BASELINES, read = options.readFile || fs.readFileSync, lstat = options.lstat || fs.lstatSync, bindings = {}, immutable = {};
  for (const [relative, expected] of Object.entries(specs)) {
    let bytes, stat; try { bytes = read(path.join(root, relative)); stat = lstat(path.join(root, relative)); } catch (_) { fail("BASELINE_PREFLIGHT", "BASELINE_MISSING"); }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== bytes.length || stat.size > 64 * 1024 * 1024 || sha(bytes) !== expected) fail("BASELINE_PREFLIGHT", "BASELINE_HASH_MISMATCH");
    immutable[relative] = { sha256: expected, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
  }
  const json = relative => JSON.parse(read(path.join(root, relative), "utf8"));
  const original = json("reports/raw/fast/base-paper-usdplus-r14/redemption-fork.json"), correction1 = json("reports/raw/fast/base-paper-usdplus-r14/redemption-fork-correction.json"), correction2 = json("reports/raw/fast/base-paper-usdplus-r14/redemption-fork-correction-v2.json");
  if (original.safety?.syntheticUsdPlusMintedLocally !== true || correction1.canonicalEvidence !== true || correction2.canonicalEvidence !== true
    || correction2.schema !== "base-paper-usdplus-redemption-fork-correction-v2/v14" || !Array.isArray(correction2.supersedes)
    || !correction2.supersedes.some(x => x.artifact === "redemption-fork.json" && x.canonicalEvidence === false)
    || !correction2.supersedes.some(x => x.artifact === "redemption-fork-correction.json" && x.canonicalEvidence === false)) fail("BASELINE_PREFLIGHT", "R14_CANONICAL_CORRECTION_INVALID");
  bindings.exchangeProxy = json("reports/raw/fast/base-paper-usdplus-r11/exchange-proxy.compiled.json");
  bindings.exchange = json("reports/raw/fast/base-paper-usdplus-r11/exchange-implementation.compiled.json");
  bindings.managerProxy = json("reports/raw/fast/base-paper-usdplus-r11/manager-proxy.compiled.json");
  bindings.manager = json("reports/raw/fast/base-paper-usdplus-r11/manager-implementation.compiled.json");
  bindings.cashProxy = json("reports/raw/fast/base-paper-usdplus-r11/cash-proxy.compiled.json");
  bindings.cash = json("reports/raw/fast/base-paper-usdplus-r12/cash.compiled.json");
  bindings.token = json("reports/raw/fast/base-paper-usdplus-r13/active-token.compiled.json");
  bindings.role = json("reports/raw/fast/base-paper-usdplus-r13/role.compiled.json");
  bindings.aave = json("reports/raw/fast/base-paper-usdplus-r13/aave/active/withdrawal-compiled.json");
  return { root, specs, immutable, bindings, baselineHashes: { ...specs }, r14Canonical: "redemption-fork-correction-v2.json" };
}
function assertPreflightUnchanged(p, options = {}) {
  const read = options.readFile || fs.readFileSync, lstat = options.lstat || fs.lstatSync;
  for (const [relative, before] of Object.entries(p.immutable)) { const file = path.join(p.root, relative), stat = lstat(file), bytes = read(file);
    if (sha(bytes) !== before.sha256 || stat.size !== before.size || stat.mtimeMs !== before.mtimeMs || stat.ctimeMs !== before.ctimeMs) fail("BASELINE_IMMUTABILITY", "BASELINE_CHANGED"); }
}

function deriveManagerAssetSlot(inputText, options = {}) {
  let input; try { input = JSON.parse(inputText); } catch (_) { fail("STORAGE_LAYOUT", "MANAGER_INPUT_INVALID"); }
  input.settings.outputSelection = { "*": { "*": ["storageLayout"] } };
  const compile = options.compile || (text => {
    const compiler = "C:/Users/MiPC/AppData/Local/Temp/opencode/solc-windows-amd64-v0.8.17+commit.8df45f5f.exe", stat = fs.lstatSync(compiler);
    if (!stat.isFile() || stat.isSymbolicLink() || sha(fs.readFileSync(compiler)) !== "7615e019666f29c7e77b20f9c506dda839a875fbc9baf3322d21348c88c05c69") fail("STORAGE_LAYOUT", "COMPILER_IDENTITY_INVALID");
    const out = childProcess.spawnSync(compiler, ["--standard-json"], { input: text, encoding: "utf8", timeout: 60000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
    if (out.status !== 0) fail("STORAGE_LAYOUT", "LAYOUT_COMPILE_FAILED"); return out.stdout;
  });
  let output; try { output = JSON.parse(compile(JSON.stringify(input))); } catch (error) { if (error instanceof R15Error) throw error; fail("STORAGE_LAYOUT", "LAYOUT_COMPILE_FAILED"); }
  const rows = output.contracts?.["contracts/PortfolioManager.sol"]?.PortfolioManager?.storageLayout?.storage || [], asset = rows.filter(row => row.label === "asset");
  if (asset.length !== 1 || asset[0].slot !== "252" || asset[0].offset !== 0 || !String(asset[0].type).startsWith("t_contract(IERC20)")) fail("STORAGE_LAYOUT", "PRIVATE_ASSET_SLOT_DERIVATION_MISSING");
  return { slotDecimal: "252", slotHex: MANAGER_ASSET_SLOT, label: "asset", source: "EXACT_SOLC_STORAGE_LAYOUT" };
}

function payoutFor(x, inputs) {
  const amount = BigInt(x), assetDecimals = BigInt(inputs.assetDecimals), usdPlusDecimals = BigInt(inputs.usdPlusDecimals);
  let assetAmount = assetDecimals > usdPlusDecimals ? amount * 10n ** (assetDecimals - usdPlusDecimals) : amount / 10n ** (usdPlusDecimals - assetDecimals);
  if (assetAmount <= 0n || BigInt(inputs.feeDenominator) <= 0n || BigInt(inputs.feeRate) > BigInt(inputs.feeDenominator)) fail("PAYOUT", "PAYOUT_INPUT_INVALID");
  const fee = inputs.freeRider ? 0n : assetAmount * BigInt(inputs.feeRate) / BigInt(inputs.feeDenominator);
  return { x: amount.toString(), assetAmount: assetAmount.toString(), fee: fee.toString(), payout: (assetAmount - fee).toString() };
}
function capacityRows(view) {
  return SIZES.map(size => { const amounts = payoutFor(size, view.payoutInputs), p = BigInt(amounts.payout), scaledP = (p * RAY + BigInt(view.aave.nextLiquidityIndex) - 1n) / BigInt(view.aave.nextLiquidityIndex);
    return { ...amounts, scaledP: scaledP.toString(), liquidationStrict: BigInt(view.cash.liquidationValue) > p, scaledSufficient: BigInt(view.aave.scaledBalance) >= scaledP,
      virtualSufficient: BigInt(view.aave.virtualUnderlying) >= p, actualSufficient: BigInt(view.aave.actualUnderlying) >= p }; });
}

function evaluateGates(view) {
  const gates = {
    G1: { pass: view.runtime?.tier1Exact === true, code: "TIER1_RUNTIME_OR_TOPOLOGY_UNBOUND" },
    G2: { pass: view.core?.bindingsExact === true && view.core.paused === false && view.core.locksClear === true, code: "CORE_CONFIG_OR_GUARD_BLOCKED" },
    G3: { pass: view.manager?.bindingsExact === true && view.manager.privateAssetDerived === true && view.manager.privateAsset === A.usdc && view.cash?.bindingsExact === true, code: "MANAGER_STRATEGY_BINDING_BLOCKED" },
    G4: { pass: Array.isArray(view.capacity) && view.capacity.length === 3 && view.capacity.every(row => row.liquidationStrict && row.scaledSufficient && row.virtualSufficient && row.actualSufficient), code: "CASH_ONLY_CAPACITY_BLOCKED" },
    G5: { pass: view.aave?.bindingsExact === true && view.aave?.incentivesControllerBound === true && view.archiveCapable === true, code: "AAVE_DEPENDENCY_OR_ARCHIVE_BLOCKED" },
  };
  const first = Object.entries(gates).find(([, gate]) => !gate.pass);
  return { gates, allPass: !first, firstFailure: first ? { stage: `PREFORK_${first[0]}`, code: first[1].code } : null };
}

function makeBudget(transport, now = Date.now) {
  const state = { requests: 0, bytes: 0, started: now(), eip1898Reads: 0 };
  const rpc = async (candidate, method, params, phase) => {
    if (!UPSTREAM.has(method) || ++state.requests > CAP.captureRequests || now() - state.started > CAP.wallMs) fail(phase, "RPC_BUDGET_EXHAUSTED");
    if (["eth_call", "eth_getCode", "eth_getStorageAt", "eth_getBalance", "eth_getProof"].includes(method)) {
      const ref = params[params.length - 1]; if (!ref || typeof ref !== "object" || ref.requireCanonical !== true || !/^0x[0-9a-f]{64}$/.test(ref.blockHash || "")) fail(phase, "EIP1898_REQUIRED"); state.eip1898Reads++;
    }
    let response; try { response = await transport(candidate.url, { jsonrpc: "2.0", id: state.requests, method, params }, CAP.requestMs); } catch (_) { fail(phase, "TRANSPORT_UNAVAILABLE"); }
    if (!response || !Number.isSafeInteger(response.bytes) || response.bytes < 0 || response.bytes > CAP.requestBytes || (state.bytes += response.bytes) > CAP.totalBytes) fail(phase, "RPC_BYTE_CAP");
    if (response.value?.jsonrpc !== "2.0" || response.value.id !== state.requests || response.value.error || !Object.hasOwn(response.value, "result")) fail(phase, "RPC_UNAVAILABLE"); return response.value.result;
  };
  return { state, rpc };
}

async function freshPinAndPair(options = {}) {
  const now = options.now || Date.now, candidates = options.candidates || (() => { fail("QUALIFICATION", "INJECTED_CANDIDATES_REQUIRED"); })(), budget = options.budget || makeBudget(options.transport, now);
  if (!Array.isArray(candidates) || candidates.length < 2 || candidates.length > CAP.candidates) fail("QUALIFICATION", "CANDIDATE_POOL_INVALID");
  const rows = [], failures = {};
  for (const candidate of candidates) {
    try {
      if (await budget.rpc(candidate, "eth_chainId", [], "QUALIFICATION") !== "0x2105") fail("QUALIFICATION", "CHAIN_MISMATCH");
      const raw = await budget.rpc(candidate, "eth_getBlockByNumber", ["finalized", false], "QUALIFICATION"), pin = parseHeader(raw), age = BigInt(Math.floor(now() / 1000)) - BigInt(pin.timestamp);
      if (age < -60n || age > BigInt(CAP.maxAgeSeconds)) fail("QUALIFICATION", "FINALIZED_HEADER_STALE");
      const ref = blockRef(pin), code = await budget.rpc(candidate, "eth_getCode", [A.exchange, ref], "QUALIFICATION");
      if (!/^0x[0-9a-f]+$/i.test(code || "") || code === "0x") fail("QUALIFICATION", "ARCHIVE_CODE_UNAVAILABLE");
      await budget.rpc(candidate, "eth_getProof", [A.usdPlus, [], ref], "QUALIFICATION"); rows.push({ candidate, pin });
    } catch (error) { const code = error instanceof R15Error ? error.code : "QUALIFICATION_FAILED"; failures[code] = (failures[code] || 0) + 1; }
  }
  const coherent = [];
  for (const row of rows) if (row.candidate.family && !coherent.some(other => other.candidate.family === row.candidate.family) && (!coherent.length || eq(row.pin, coherent[0].pin))) coherent.push(row);
  if (coherent.length < 2) { const error = new R15Error("QUALIFICATION", rows.length ? "TWO_FAMILY_COHERENT_PIN_UNAVAILABLE" : "ARCHIVE_FRESH_STATE_UNAVAILABLE"); error.stats = { attempted: candidates.length, qualified: rows.length, selectedFamilyCount: 0, failures }; throw error; }
  coherent.length = 2; return { pair: coherent, pin: coherent[0].pin, stats: { attempted: candidates.length, qualified: rows.length, selectedFamilyCount: 2, failures }, budget };
}

function interfaces(bindings) {
  return { exchange: new Interface(bindings.exchange.abi), manager: new Interface(bindings.manager.abi), cash: new Interface(bindings.cash.abi), token: new Interface(bindings.token.abi), role: new Interface(bindings.role.abi), pool: new Interface(bindings.aave.pool.abi),
    erc20: new Interface(["function decimals() view returns(uint8)", "function balanceOf(address) view returns(uint256)", "function totalSupply() view returns(uint256)"]),
    provider: new Interface(["function getPool() view returns(address)"]),
    aToken: new Interface(["function POOL() view returns(address)", "function UNDERLYING_ASSET_ADDRESS() view returns(address)", "function getIncentivesController() view returns(address)", "function scaledBalanceOf(address) view returns(uint256)", "function balanceOf(address) view returns(uint256)"]),
    debt: new Interface(["function scaledBalanceOf(address) view returns(uint256)"]), blockGetter: new Interface(["function getNumber() view returns(uint256)"]) };
}
async function freshView(candidate, pin, budget, bindings, layout) {
  const I = interfaces(bindings), ref = blockRef(pin);
  const call = async (to, iface, name, args = []) => { const raw = await budget.rpc(candidate, "eth_call", [{ to, data: iface.encodeFunctionData(name, args), gas: "0x4c4b40" }, ref], "FRESH_BINDING"); try { return iface.decodeFunctionResult(name, raw); } catch (_) { fail("FRESH_BINDING", "ABI_DECODE_FAILED"); } };
  const scalar = async (...args) => (await call(...args))[0];
  const code = async address => lower(await budget.rpc(candidate, "eth_getCode", [address, ref], "FRESH_BINDING"));
  const impl = async address => wordAddress(await budget.rpc(candidate, "eth_getStorageAt", [address, EIP1967, ref], "FRESH_BINDING"));
  const expectedRuntime = { [A.exchange]: bindings.exchangeProxy.runtime, [A.exchangeImpl]: bindings.exchange.runtime, [A.manager]: bindings.managerProxy.runtime, [A.managerImpl]: bindings.manager.runtime,
    [A.cash]: bindings.cashProxy.runtime, [A.cashImpl]: bindings.cash.runtime, [A.usdPlus]: bindings.exchangeProxy.runtime, [A.usdPlusImpl]: bindings.token.runtime, [A.role]: bindings.exchangeProxy.runtime,
    [A.roleImpl]: bindings.role.runtime, [A.poolImpl]: bindings.aave.pool.runtime, [A.supplyLogic]: bindings.aave.SupplyLogic.runtime };
  let tier1Exact = true; for (const [address, runtime] of Object.entries(expectedRuntime)) if (await code(address) !== lower(runtime)) tier1Exact = false;
  const poolProxyRuntime = await code(A.pool); // Captured, but no exact local proxy build exists in the admitted baseline.
  if (!poolProxyRuntime || poolProxyRuntime === "0x") tier1Exact = false; else tier1Exact = false;
  const pointers = { exchange: await impl(A.exchange), manager: await impl(A.manager), cash: await impl(A.cash), token: await impl(A.usdPlus), role: await impl(A.role), pool: await impl(A.pool) };
  if (!eq(pointers, { exchange: A.exchangeImpl, manager: A.managerImpl, cash: A.cashImpl, token: A.usdPlusImpl, role: A.roleImpl, pool: A.poolImpl })) tier1Exact = false;
  const reserve = (await call(A.pool, I.pool, "getReserveData", [A.usdc]))[0], configuration = BigInt((await call(A.pool, I.pool, "getConfiguration", [A.usdc]))[0][0]), userConfiguration = BigInt((await call(A.pool, I.pool, "getUserConfiguration", [A.cash]))[0][0]);
  const aToken = lower(reserve.aTokenAddress), variableDebt = lower(reserve.variableDebtTokenAddress), rateStrategy = lower(await scalar(A.pool, I.pool, "RESERVE_INTEREST_RATE_STRATEGY"));
  const incentives = lower(await scalar(aToken, I.aToken, "getIncentivesController"));
  const blockGetter = lower(await scalar(A.exchange, I.exchange, "blockGetter"));
  const freeRider = await scalar(A.role, I.role, "hasRole", [id("FREE_RIDER_ROLE"), A.actor]);
  const locks = []; for (const address of [A.actor, A.venue, ZeroAddress]) { const row = await call(A.usdPlus, I.token, "lockOptionsPerAddress", [address]); locks.push([row[0], row[1]]); }
  const privateAsset = wordAddress(await budget.rpc(candidate, "eth_getStorageAt", [A.manager, layout.slotHex, ref], "FRESH_BINDING"));
  const usdcImplWord = await budget.rpc(candidate, "eth_getStorageAt", [A.usdc, EIP1967, ref], "FRESH_BINDING"), usdcImpl = wordAddress(usdcImplWord);
  const aTokenImpl = await impl(aToken), providerPool = lower(await scalar(A.aaveProvider, I.provider, "getPool"));
  const payoutInputs = { assetDecimals: (await scalar(A.usdc, I.erc20, "decimals")).toString(), usdPlusDecimals: (await scalar(A.usdPlus, I.token, "decimals")).toString(),
    feeRate: (await scalar(A.exchange, I.exchange, "redeemFee")).toString(), feeDenominator: (await scalar(A.exchange, I.exchange, "redeemFeeDenominator")).toString(), freeRider };
  const view = { runtime: { tier1Exact, poolProxyRuntimeHash: sha(Buffer.from(poolProxyRuntime)), tier1Blocker: "AAVE_POOL_PROXY_EXACT_LOCAL_BUILD_MISSING" }, pointers, payoutInputs, archiveCapable: true,
    core: { bindingsExact: lower(await scalar(A.exchange, I.exchange, "usdPlus")) === A.usdPlus && lower(await scalar(A.exchange, I.exchange, "usdc")) === A.usdc && lower(await scalar(A.exchange, I.exchange, "portfolioManager")) === A.manager
      && lower(await scalar(A.usdPlus, I.token, "exchange")) === A.exchange && lower(await scalar(A.usdPlus, I.token, "roleManager")) === A.role,
      paused: Boolean(await scalar(A.exchange, I.exchange, "paused")) || Boolean(await scalar(A.usdPlus, I.token, "isPaused")), locksClear: locks.every(x => !x[0] && !x[1]), blockGetter, freeRider },
    manager: { bindingsExact: lower(await scalar(A.manager, I.manager, "exchanger")) === A.exchange && lower(await scalar(A.manager, I.manager, "cashStrategy")) === A.cash
      && await scalar(A.manager, I.manager, "hasRole", [id("EXCHANGER"), A.exchange]), privateAssetDerived: layout.slotHex === MANAGER_ASSET_SLOT, privateAsset },
    cash: { bindingsExact: lower(await scalar(A.cash, I.cash, "portfolioManager")) === A.manager && lower(await scalar(A.cash, I.cash, "usdcToken")) === A.usdc && lower(await scalar(A.cash, I.cash, "aUsdcToken")) === aToken
      && lower(await scalar(A.cash, I.cash, "aaveProvider")) === A.aaveProvider && Boolean(await scalar(A.cash, I.cash, "inLending")), liquidationValue: (await scalar(A.cash, I.cash, "liquidationValue")).toString(), navSlippageBP: (await scalar(A.cash, I.cash, "navSlippageBP")).toString() },
    aave: { bindingsExact: providerPool === A.pool && pointers.pool === A.poolImpl && aToken === A.aToken && lower(await scalar(aToken, I.aToken, "POOL")) === A.pool && lower(await scalar(aToken, I.aToken, "UNDERLYING_ASSET_ADDRESS")) === A.usdc
      && lower(await scalar(A.pool, I.pool, "ADDRESSES_PROVIDER")) === A.aaveProvider && Boolean(configuration & (1n << 56n)) && !Boolean(configuration & (1n << 60n)),
      incentivesControllerBound: incentives !== ZeroAddress && (await code(incentives)) !== "0x", incentivesController: incentives, aToken, variableDebt, rateStrategy, usdcImpl, aTokenImpl,
      tier2RuntimeHashes: { provider: sha(Buffer.from(await code(A.aaveProvider))), variableDebt: sha(Buffer.from(await code(variableDebt))), rateStrategy: sha(Buffer.from(await code(rateStrategy))), usdcImpl: sha(Buffer.from(await code(usdcImpl))), aTokenImpl: sha(Buffer.from(await code(aTokenImpl))), incentives: sha(Buffer.from(await code(incentives))) },
      noBorrowingBits: (userConfiguration & BigInt(`0x${"55".repeat(32)}`)) === 0n, nextLiquidityIndex: (await scalar(A.pool, I.pool, "getReserveNormalizedIncome", [A.usdc])).toString(),
      scaledBalance: (await scalar(aToken, I.aToken, "scaledBalanceOf", [A.cash])).toString(), virtualUnderlying: (await scalar(A.pool, I.pool, "getVirtualUnderlyingBalance", [A.usdc])).toString(), actualUnderlying: (await scalar(A.usdc, I.erc20, "balanceOf", [aToken])).toString() },
  };
  view.aave.bindingsExact = Boolean(view.aave.bindingsExact && view.aave.noBorrowingBits && variableDebt !== ZeroAddress && rateStrategy !== ZeroAddress && usdcImpl !== ZeroAddress && aTokenImpl !== ZeroAddress);
  view.capacity = capacityRows(view); return view;
}

async function terminalPinRecheck(pair, pin, budget) {
  const tag = `0x${BigInt(pin.number).toString(16)}`;
  for (const row of pair) { const terminal = parseHeader(await budget.rpc(row.candidate, "eth_getBlockByNumber", [tag, false], "TERMINAL_PIN_RECHECK")); if (!eq(terminal, pin)) fail("TERMINAL_PIN_RECHECK", "HEADER_CHANGED"); }
  return true;
}
async function establishPreFork(options) {
  const pinResult = await freshPinAndPair(options), views = [];
  for (const row of pinResult.pair) views.push(await freshView(row.candidate, pinResult.pin, pinResult.budget, options.bindings, options.layout));
  if (!eq(views[0], views[1])) fail("FRESH_BINDING", "TWO_FAMILY_STATE_DISAGREEMENT");
  await terminalPinRecheck(pinResult.pair, pinResult.pin, pinResult.budget);
  const observedAt = new Date((options.now || Date.now)()).toISOString(), freshnessExpiresAt = new Date((Number(pinResult.pin.timestamp) + CAP.maxAgeSeconds) * 1000).toISOString();
  const evaluation = evaluateGates(views[0]);
  return { ...pinResult, view: views[0], evaluation, pinEvidence: { ...pinResult.pin, observedAt, freshnessExpiresAt, rpcStrength: "corroborated-operator-families", stateRootProof: false }, requests: pinResult.budget.state };
}

function orderedCalls(trace) { const rows = []; let order = 0; const visit = (node, parent = null) => { if (!node || typeof node !== "object") return; const current = rows.length; rows.push({ order: order++, parent, caller: lower(node.from), callee: lower(node.to), callType: String(node.type || "CALL").toUpperCase(), selector: typeof node.input === "string" ? node.input.slice(0, 10).toLowerCase() : "0x", success: !node.error }); for (const child of node.calls || []) visit(child, current); }; visit(trace); return rows; }
function validateOrderedCashPath(calls, addresses = A) {
  const needed = [[addresses.actor, addresses.exchange], [addresses.exchange, addresses.manager], [addresses.manager, addresses.cash], [addresses.cash, addresses.pool], [addresses.pool, addresses.aToken], [addresses.aToken, addresses.usdc]];
  let cursor = -1; for (const [from, to] of needed) { const index = calls.findIndex(row => row.order > cursor && row.caller === from && row.callee === to && row.success); if (index < 0) return { pass: false, code: "ORDERED_CASH_PATH_MISSING" }; cursor = calls[index].order; }
  if (calls.some(row => [addresses.m2m].includes(row.callee))) return { pass: false, code: "PATH_EXPANDED_TO_PORTFOLIO_BALANCING" };
  return { pass: true, code: null };
}
function validateConservation(row) {
  const x = BigInt(row.x), p = BigInt(row.payout), scaledP = (p * RAY + BigInt(row.nextLiquidityIndex) - 1n) / BigInt(row.nextLiquidityIndex), before = row.before, after = row.after, pristine = row.pristine;
  const transfer = (from, to, amount) => row.transfers.some(t => t.token === A.usdc && t.from === from && t.to === to && BigInt(t.value) === amount);
  const pass = BigInt(before.usdPlusActor) - BigInt(after.usdPlusActor) === x && BigInt(before.usdPlusSupply) - BigInt(after.usdPlusSupply) === x && row.burnTransfer === true
    && BigInt(pristine.usdPlusSupply) + x - x === BigInt(row.rolledBack.usdPlusSupply) && transfer(A.aToken, A.cash, p) && transfer(A.cash, A.manager, p) && transfer(A.manager, A.exchange, p) && transfer(A.exchange, A.actor, p)
    && BigInt(after.usdcActor) - BigInt(before.usdcActor) === p && BigInt(before.usdcAToken) - BigInt(after.usdcAToken) === p
    && ["usdcCash", "usdcManager", "usdcExchange"].every(key => BigInt(after[key]) === BigInt(before[key])) && BigInt(before.usdcSupply) === BigInt(after.usdcSupply)
    && BigInt(before.scaledCash) - BigInt(after.scaledCash) === scaledP && BigInt(before.virtualUnderlying) - BigInt(after.virtualUnderlying) === p
    && BigInt(before.actualUnderlying) - BigInt(after.actualUnderlying) === p && row.poolWithdraw && row.strategyUnstake && row.reserveUpdated && row.isBalanced === false && row.balanceEvent === false && row.rollbackComplete === true;
  return { pass, scaledP: scaledP.toString(), code: pass ? null : "CONSERVATION_OR_ROLLBACK_MISMATCH" };
}

function localhost(value) { let url; try { url = new URL(value); } catch (_) { fail("LOCALHOST", "LOCALHOST_REQUIRED"); } if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname.toLowerCase()) || url.username || url.password) fail("LOCALHOST", "LOCALHOST_REQUIRED"); return url; }
function buildAnvilArgs(relayPort, localPort, pin) { const relay = `http://127.0.0.1:${relayPort}`; localhost(relay); return ["--host", "127.0.0.1", "--port", String(localPort), "--chain-id", "8453", "--accounts", "0", "--auto-impersonate", "--fork-url", relay, "--fork-block-number", String(pin.number), "--no-storage-caching", "--quiet", "--color", "never"]; }
function childEnv(env = process.env) { const out = {}; for (const key of ["Path", "PATH", "SystemRoot", "WINDIR"]) if (env[key] && !/:\/\//.test(env[key])) out[key] = env[key]; out.TEMP = path.join(os.tmpdir(), "opencode"); out.TMP = out.TEMP; return out; }
function freePort() { return new Promise((resolve, reject) => { const s = net.createServer(); s.once("error", reject); s.listen(0, "127.0.0.1", () => { const port = s.address().port; s.close(() => resolve(port)); }); }); }
async function createRelay(candidate, transport) {
  let forwarded = 0, denied = 0, bytes = 0, closed = false; const forbidden = method => /^(?:eth_send|eth_sign|eth_accounts|personal_|wallet_|account|admin_|anvil_|evm_|debug_|trace_|engine_|miner_|txpool_)/i.test(method);
  const server = http.createServer((req, res) => { let size = 0, chunks = []; req.on("data", c => { size += c.length; if (size <= 1024 * 1024) chunks.push(c); else req.destroy(); }); req.on("end", async () => { try { const row = JSON.parse(Buffer.concat(chunks)); if (forbidden(row.method) || !UPSTREAM.has(row.method)) { denied++; res.end(JSON.stringify({ jsonrpc: "2.0", id: row.id, error: { code: -32601, message: "method-not-allowed" } })); return; } if (++forwarded > CAP.relayRequests) throw new Error(); const response = await transport(candidate.url, row, CAP.requestMs); bytes += response.bytes; if (bytes > CAP.totalBytes) throw new Error(); res.end(JSON.stringify(response.value)); } catch (_) { res.end('{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"upstream-read-failure"}}'); } }); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { port: server.address().port, stats: () => ({ forwarded, denied, bytes }), close: () => new Promise((resolve, reject) => { const timer = setTimeout(() => { server.closeAllConnections?.(); reject(new R15Error("RELAY_CLEANUP", "RELAY_CLOSE_UNCONFIRMED")); }, 1500); server.close(error => { clearTimeout(timer); if (error) reject(new R15Error("RELAY_CLEANUP", "RELAY_CLOSE_FAILED")); else { closed = true; resolve(); } }); }), closed: () => closed };
}
async function stopChild(child, waitMs = 1500) { if (!child || child.exitCode != null || child.signalCode != null) return; const wait = () => new Promise(resolve => { const timer = setTimeout(() => resolve(false), waitMs); child.once("exit", () => { clearTimeout(timer); resolve(true); }); }); child.kill(); if (await wait()) return; child.kill("SIGKILL"); if (!await wait()) fail("CHILD_CLEANUP", "ANVIL_EXIT_UNCONFIRMED"); }

async function defaultForkExecution() { fail("LOCAL_EXECUTION", "LOCAL_EXECUTION_IMPLEMENTATION_NOT_REACHED_WITH_UNBOUND_TIER1_PROXY"); }
function baseOutput() { return { schema: SCHEMA, generatedAt: new Date().toISOString(), provenance: provenance(), classification: "INCOMPLETE", firstFailure: null, stageProgression: [], baselineHashes: null, pin: null,
  qualification: null, budgets: CAP, preForkGates: null, progress: { relayReached: false, anvilReached: false, mintReached: false, redemptionReached: false }, cleanup: { child: "NOT_STARTED", relay: "NOT_STARTED" }, cleanupFailures: [], rows: [],
  fullExitVerified: false, localSemantic: { status: "UNKNOWN", result: "inconclusive" }, reproducibility: "UNKNOWN", quoteEligible: false, routePositive: "unknown", executableNow: "unknown", profitabilityClaim: false, signedActionJustified: false, signing: false, broadcast: false,
  safety: { inventoryReads: 0, retries: 0, endpointMaterialPersisted: false, endpointMaterialInChildArgv: false, walletFilesRead: false, envFilesRead: false, upstreamTransactions: 0, nativeUsdcInjected: false, storageEdited: false, victimImpersonated: false } }; }
function classify(error) { return error.stage === "PREFORK_G1" ? `INCOMPLETE / ${error.code}` : `INCOMPLETE / ${error.stage} / ${error.code}`; }

async function runOnce(options = {}) {
  const output = baseOutput(), exists = options.exists || fs.existsSync; if (exists(options.outputFile || OUTPUT_FILE)) fail("OUTPUT", "OUTPUT_EXISTS_NO_OVERWRITE");
  let authority, relay, child, primary = null;
  try {
    authority = options.preflight || preflight(options.preflightOptions); output.baselineHashes = authority.baselineHashes; output.stageProgression.push("BASELINE_PREFLIGHT_PASS");
    const inputText = (options.readFile || fs.readFileSync)(path.join(ROOT, "reports/raw/fast/base-paper-usdplus-r11/manager-implementation.input.json"), "utf8"), layout = options.layout || deriveManagerAssetSlot(inputText, options.layoutOptions); output.stageProgression.push("STORAGE_LAYOUT_PASS");
    let candidates;
    if (options.candidates) candidates = options.candidates; else { output.safety.inventoryReads++; candidates = (options.readCandidates || readCandidates)(); }
    const budget = options.budget || makeBudget(options.transport || requestJSON, options.now || Date.now);
    const pre = options.establish ? await options.establish({ candidates, budget, bindings: authority.bindings, layout }) : await establishPreFork({ candidates, budget, bindings: authority.bindings, layout, transport: options.transport || requestJSON, now: options.now || Date.now });
    output.qualification = pre.stats; output.pin = pre.pinEvidence; output.preForkGates = pre.evaluation; output.stageProgression.push("FRESH_COHERENT_PIN_AND_GATES_EVALUATED");
    if (!pre.evaluation.allPass) throw new R15Error(pre.evaluation.firstFailure.stage, pre.evaluation.firstFailure.code);
    if ((options.now || Date.now)() >= Number(pre.pin.timestamp) * 1000 + CAP.maxAgeSeconds * 1000) fail("FORK_START", "PIN_FRESHNESS_EXPIRED");
    relay = options.relayFactory ? await options.relayFactory(pre.pair[0].candidate) : await createRelay(pre.pair[0].candidate, options.transport || requestJSON); output.progress.relayReached = true; output.stageProgression.push("RELAY_STARTED");
    const port = await (options.freePort || freePort)(), args = buildAnvilArgs(relay.port, port, pre.pin); if (args.some(x => /https|wss|authorization|bearer/i.test(x))) fail("FORK_START", "CHILD_ARGV_NOT_SANITIZED");
    child = options.startChild ? await options.startChild(args) : await new Promise((resolve, reject) => { const c = childProcess.spawn("anvil", args, { stdio: "ignore", shell: false, windowsHide: true, env: childEnv() }); c.once("spawn", () => resolve(c)); c.once("error", () => reject(new R15Error("FORK_START", "ANVIL_START_FAILED"))); });
    output.progress.anvilReached = true; output.stageProgression.push("ANVIL_STARTED_AT_FRESH_R15_PIN");
    const result = await (options.executeFork || defaultForkExecution)({ child, port, pre, progress: output.progress }); output.rows = result.rows;
    output.fullExitVerified = true; output.localSemantic = { status: "PASS", result: "supports" }; output.reproducibility = "PASS"; output.quoteEligible = true; output.classification = "LOCAL_FORK_FULL_REDEMPTION_VERIFIED_AT_FRESH_R15_PIN";
  } catch (error) { primary = error instanceof R15Error ? error : new R15Error("UNCLASSIFIED", "UNEXPECTED_FAILURE"); output.firstFailure = { stage: primary.stage, code: primary.code }; if (primary.stats) output.qualification = primary.stats; output.classification = classify(primary); }
  finally {
    if (child) try { await (options.stopChild || stopChild)(child); output.cleanup.child = "CONFIRMED"; } catch (error) { output.cleanup.child = "FAILED"; output.cleanupFailures.push({ stage: error.stage || "CHILD_CLEANUP", code: error.code || "ANVIL_CLEANUP_FAILED" }); }
    if (relay) try { await relay.close(); output.cleanup.relay = relay.closed && !relay.closed() ? "FAILED" : "CONFIRMED"; if (output.cleanup.relay === "FAILED") throw new R15Error("RELAY_CLEANUP", "RELAY_CLOSE_UNCONFIRMED"); } catch (error) { output.cleanup.relay = "FAILED"; output.cleanupFailures.push({ stage: error.stage || "RELAY_CLEANUP", code: error.code || "RELAY_CLEANUP_FAILED" }); }
    if (output.cleanupFailures.length) { output.fullExitVerified = false; output.quoteEligible = false; output.localSemantic = { status: "UNKNOWN", result: "inconclusive" }; output.reproducibility = "UNKNOWN"; if (!primary) { output.firstFailure = output.cleanupFailures[0]; output.classification = classify(output.firstFailure); } }
  }
  if (authority) assertPreflightUnchanged(authority, options.preflightOptions); output.completedAt = new Date().toISOString(); if (!sanitized(output)) fail("OUTPUT", "OUTPUT_NOT_SANITIZED"); return output;
}
function writeOnce(output, options = {}) { const file = options.outputFile || OUTPUT_FILE, dir = path.dirname(file); if (fs.existsSync(file)) fail("OUTPUT", "OUTPUT_EXISTS_NO_OVERWRITE"); fs.mkdirSync(dir, { recursive: true }); const bytes = JSON.stringify(output, null, 2) + "\n"; if (!sanitized(bytes)) fail("OUTPUT", "OUTPUT_NOT_SANITIZED"); fs.writeFileSync(file, bytes, { flag: "wx" }); return file; }
async function runCli(argv) { try { parseCli(argv); const output = await runOnce(); writeOnce(output); process.stdout.write(JSON.stringify({ classification: output.classification, firstFailure: output.firstFailure, stages: output.stageProgression, requests: output.qualification ? { ...output.qualification, failures: output.qualification.failures } : null, progress: output.progress, cleanup: output.cleanup }) + "\n"); if (!output.fullExitVerified) process.exitCode = 2; } catch (_) { process.stderr.write("R15_FAILED_CLOSED\n"); process.exitCode = 1; } }

module.exports = { A, BASELINES, CAP, EIP1967, MANAGER_ASSET_SLOT, OUTPUT_FILE, R15Error, SCHEMA, SIZES, assertPreflightUnchanged, baseOutput, blockRef, buildAnvilArgs, capacityRows, childEnv,
  createRelay, deriveManagerAssetSlot, establishPreFork, evaluateGates, freshPinAndPair, localhost, makeBudget, orderedCalls, parseCli, payoutFor, preflight, provenance, runOnce, sanitized, stopChild, terminalPinRecheck,
  validateConservation, validateOrderedCashPath, writeOnce };
if (require.main === module) runCli(process.argv.slice(2));
