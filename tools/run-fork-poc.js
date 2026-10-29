#!/usr/bin/env node
"use strict";

// run-fork-poc.js — reusable KEYLESS local fork-PoC harness.
//
// Purpose: validate a candidate exploit locally against a forked chain using
// impersonation. No protocol/user key is ever touched and nothing is broadcast:
// the default ctx mutates the local fork via impersonation only.
//
// OPT-IN extension: ctx.setCode (anvil_setCode etch) and
// ctx.sendAuthorization / ctx.send7702 (real EIP-7702). The latter signs a
// single type-0x4 authorizationList transaction with a freshly generated
// IN-MEMORY ephemeral test key (never read from disk, never logged, never
// returned) and submits it to the local anvil (127.0.0.1) via
// eth_sendRawTransaction — never to the read-only relay or any upstream. An
// anvil build without type-4 support yields capability:false instead of
// throwing. With no scenarioInput these primitives are simply never called,
// so the CLI fail-closed path is unchanged.
//
// Security model is INHERITED, not re-implemented: the read-only localhost
// relay, the Anvil argument builder, and the local RPC budget come from
// tools/run-approved-fork-validation.js. The real upstream endpoint is only
// ever held in-process; Anvil forks a localhost relay that forwards an
// allowlisted set of read methods. The endpoint never appears on any
// child-process command line and is never printed or persisted.
//
// Usage:
//   node tools/run-fork-poc.js --chain <id> --block <n|finalized> \
//        --scenario <path.js> --run
//
// Without --run this program refuses and prints usage; it performs no network
// access whatsoever.

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const epochExecution = require("./lib/trigger-fork-epoch-execution.js");

const approved = require("./run-approved-fork-validation");
const sharedRpc = require("./shared-rpc");
const {
  computeExpectedChildBaseFee,
  validateHistoricalChildProfile,
  createHistoricalChildRpc,
  buildHistoricalChildAnvilArgs,
  createHistoricalChildContext,
} = require("./lib/fork-poc-historical-child.js");

const {
  ROOT,
  ForkError,
  leakGuard,
  createReadOnlyRelay,
  buildAnvilArgs,
  createLocalRpc,
  stopAnvil,
  sanitizedChildEnvironment,
  defaultTransport,
} = approved;

const OUT_DIR = path.join(ROOT, "reports", "raw", "fast", "fork-poc");
const SCHEMA = "fork-poc/v1";
const ANVIL_PATH = "C:/Users/MiPC/.foundry/bin/anvil.exe";
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const ARCHIVE_PROBE_ADDRESS = "0x0000000000000000000000000000000000000001";
const USAGE = [
  "usage: node tools/run-fork-poc.js --chain <id> --block <n|finalized> --scenario <path.js> --run",
  "  --run is mandatory: without it this harness refuses and never contacts the network.",
  "  keyless local fork, impersonation only, no signing, no broadcast.",
].join("\n");

const LIMITS = Object.freeze({
  totalMs: 180_000,
  requestMs: 15_000,
  relayRequests: 20_000,
  relayBytes: 256 * 1024 * 1024,
  localRequests: 5_000,
  localBytes: 64 * 1024 * 1024,
  messageBytes: 1024 * 1024,
  calls: 512,
  sends: 128,
  snapshots: 32,
  observations: 512,
  asserts: 256,
  archiveAttempts: 4,
  candidates: 128,
});

const FLAGS = new Set(["--chain", "--block", "--scenario"]);
const ACTIVE = { registered: false, cleanup: null };

// ---------------------------------------------------------------------------
// small validators (no endpoint material may ever pass through these)
// ---------------------------------------------------------------------------
const hexQuantity = (value) => `0x${BigInt(value).toString(16)}`;
const isAddress = (value) => typeof value === "string" && /^0x[0-9a-f]{40}$/iu.test(value) && value.toLowerCase() !== ZERO_ADDRESS;
const isHexData = (value) => typeof value === "string" && /^0x(?:[0-9a-f]{2})*$/iu.test(value);
const isHexQuantity = (value) => typeof value === "string" && /^0x[0-9a-f]+$/iu.test(value);
const isBlockTag = (value) => value === "latest" || value === "finalized" || isHexQuantity(value);
const isUintString = (value) => typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value);
const isLabel = (value) => typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/iu.test(value);

function fail(code, stage = "FORK_POC") {
  throw new ForkError(code, stage);
}

// ---------------------------------------------------------------------------
// argument parsing (pure; never touches the network)
// ---------------------------------------------------------------------------
function parseArgs(args) {
  if (!Array.isArray(args)) fail("USAGE_ERROR", "CLI");
  const options = { run: false, chain: null, block: null, scenario: null };
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === "--run") {
      if (options.run) fail("USAGE_ERROR", "CLI");
      options.run = true;
      continue;
    }
    if (!FLAGS.has(name)) fail("USAGE_ERROR", "CLI");
    const value = args[index + 1];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) fail("USAGE_ERROR", "CLI");
    options[name.slice(2)] = value;
    index += 1;
  }
  return options;
}

function normalizeChain(value) {
  if (!isUintString(value)) fail("CHAIN_INVALID", "CLI");
  const chainId = Number(value);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) fail("CHAIN_INVALID", "CLI");
  return chainId;
}

function normalizeBlock(value) {
  if (value === undefined || value === null) return "finalized";
  if (value === "finalized") return "finalized";
  if (!isUintString(value)) fail("BLOCK_INVALID", "CLI");
  return String(BigInt(value));
}

function scenarioNameFrom(file) {
  const base = path.basename(String(file), path.extname(String(file))).toLowerCase();
  const name = base.replace(/[^a-z0-9-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 64);
  if (!name) fail("SCENARIO_NAME_INVALID", "SCENARIO");
  return name;
}

// ---------------------------------------------------------------------------
// structured, sanitized value handling
// ---------------------------------------------------------------------------
function plainValue(value, depth = 0) {
  if (depth > 8) fail("SCENARIO_VALUE_TOO_DEEP", "SCENARIO");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > 4096) fail("SCENARIO_VALUE_TOO_LARGE", "SCENARIO");
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("SCENARIO_VALUE_INVALID", "SCENARIO");
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) {
    if (value.length > 256) fail("SCENARIO_VALUE_TOO_LARGE", "SCENARIO");
    return value.map((child) => plainValue(child, depth + 1));
  }
  if (typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (!/^[a-z0-9._-]{1,64}$/iu.test(key)) fail("SCENARIO_VALUE_KEY_INVALID", "SCENARIO");
      out[key] = plainValue(child, depth + 1);
    }
    return out;
  }
  fail("SCENARIO_VALUE_INVALID", "SCENARIO");
}

// Tolerant impersonation teardown: a snapshot revert also drops impersonation,
// so an "account not impersonated" response is a benign no-op, never a failure.
async function stopImpersonatingAccount(localRpc, address) {
  try {
    const result = await localRpc.call("anvil_stopImpersonatingAccount", [address]);
    return result === undefined ? true : result;
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// scenario API
// ---------------------------------------------------------------------------
function createScenarioContext({ chainId, block, localRpc, ethers, scenarioInput = null, limits = LIMITS, now = Date.now, deadline = Infinity, historicalChild = null }) {
  const historicalProfile = historicalChild ? validateHistoricalChildProfile(historicalChild, chainId) : null;
  if (historicalProfile) localRpc = createHistoricalChildRpc(localRpc);
  const state = { calls: 0, sends: 0, deployments: 0, snapshots: 0, observations: [], asserts: [], impersonated: new Set(), fatal: false, authCapability: null, authCapabilityReason: null };

  const guardBudget = () => {
    if (now() > deadline) fail("FORK_POC_WALL_CLOCK_EXCEEDED", "BOUNDS");
  };
  const rpc = async (method, params, stage) => {
    try {
      return await localRpc.call(method, params);
    } catch (error) {
      if (error instanceof ForkError) throw error;
      fail("LOCAL_RPC_FAILED", stage || "SCENARIO");
    }
  };
  const toTag = (value, stage) => {
    if (value === undefined) return "latest";
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return hexQuantity(value);
    if (isBlockTag(value)) return value;
    fail(stage, "SCENARIO");
  };

  // Anvil may answer a receipt query before the just-submitted transaction is
  // included, and an explicit revert must never be silently treated as success.
  // Poll the local node with a bounded budget, then fail closed with a distinct
  // code so a reverted execution is diagnosable rather than masked by a later
  // assertion.
  const waitForReceipt = async (hash) => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      guardBudget();
      const receipt = await rpc("eth_getTransactionReceipt", [hash], "SCENARIO_RECEIPT");
      if (receipt && typeof receipt === "object" && !Array.isArray(receipt)) return receipt;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    fail("SCENARIO_RECEIPT_PENDING", "SCENARIO");
  };

  const extractRevertReason = (node, depth = 0) => {
    if (!node || typeof node !== "object" || Array.isArray(node) || depth > 64) return null;
    for (const key of ["revertReason", "error"]) {
      const value = node[key];
      if (typeof value === "string" && value) return value;
    }
    const calls = Array.isArray(node.calls) ? node.calls : [];
    for (const child of calls) {
      const found = extractRevertReason(child, depth + 1);
      if (found) return found;
    }
    return null;
  };

  const receiptFailureDetail = async (receipt, hash) => {
    const base = `status=${receipt.status} gasUsed=${typeof receipt.gasUsed === "string" && isHexQuantity(receipt.gasUsed) ? BigInt(receipt.gasUsed).toString() : "unknown"}`;
    try {
      const trace = await rpc("debug_traceTransaction", [hash, { tracer: "callTracer" }], "SCENARIO_TRACE");
      const reason = extractRevertReason(trace);
      const sanitized = reason ? approved.sanitizeRpcDetail({ message: reason }) : null;
      return sanitized ? `${base} reason=${sanitized}` : base;
    } catch (_) {
      return base;
    }
  };

  // -------------------------------------------------------------------------
  // EIP-7702 primitives (additive; LOCAL anvil only — the relay/upstream path
  // is untouched). ctx.setCode is the etch-approximation. ctx.sendAuthorization
  // (alias ctx.send7702) is real type-4 delegation signed with an in-memory
  // ephemeral key; it is capability-detected and fails closed, never throwing
  // on an anvil build that lacks type-4 support.
  // -------------------------------------------------------------------------
  const AUTH_UNSUPPORTED_CODES = new Set(["LOCAL_RPC_METHOD_FAILED", "LOCAL_RPC_UNAVAILABLE", "LOCAL_RPC_FAILED"]);
  const isPrivateKey = (value) => typeof value === "string" && /^0x[0-9a-f]{64}$/iu.test(value);
  const firstString = (...values) => {
    for (const value of values) if (typeof value === "string" && value) return value;
    return null;
  };

  const sendAuthorization = async (input = {}) => {
    guardBudget();
    const options = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    const delegate = firstString(options.delegate, options.address);
    if (!isAddress(delegate)) fail("SCENARIO_AUTH_INVALID", "SCENARIO");
    if (state.authCapability === false) {
      return { capability: false, applied: false, reason: state.authCapabilityReason || "AUTHORIZATION_LIST_UNSUPPORTED" };
    }
    const hexKey = firstString(options.privateKeyEphemeral, options.privateKey);
    if (hexKey !== null && !isPrivateKey(hexKey)) fail("SCENARIO_AUTH_INVALID", "SCENARIO");
    let wallet;
    try {
      wallet = hexKey === null ? ethers.Wallet.createRandom() : new ethers.Wallet(hexKey);
    } catch (_) {
      fail("SCENARIO_AUTH_INVALID", "SCENARIO");
    }
    if (typeof wallet.authorize !== "function" || typeof wallet.signTransaction !== "function") fail("SCENARIO_AUTH_UNAVAILABLE", "SCENARIO");
    const account = wallet.address;
    const requested = firstString(options.eoa, options.account, options.owner);
    if (requested && requested.toLowerCase() !== account.toLowerCase()) fail("SCENARIO_AUTH_KEY_MISMATCH", "SCENARIO");
    state.sends += 1;
    if (state.sends > limits.sends) fail("SCENARIO_SEND_BUDGET_EXHAUSTED", "SCENARIO");
    try {
      const nonce = BigInt(await rpc("eth_getTransactionCount", [account, "pending"], "SCENARIO_AUTH_NONCE"));
      const authorization = await wallet.authorize({ address: delegate, nonce, chainId });
      // Fund the ephemeral account locally so the type-4 tx can pay gas.
      await rpc("anvil_setBalance", [account, hexQuantity(10n ** 18n)], "SCENARIO_AUTH_FUND");
      const gasPrice = BigInt(await rpc("eth_gasPrice", [], "SCENARIO_AUTH_GAS"));
      const raw = await wallet.signTransaction({
        type: 4,
        chainId: BigInt(chainId),
        nonce,
        to: account,
        value: 0n,
        data: "0x",
        gasLimit: 100000n,
        maxFeePerGas: gasPrice,
        maxPriorityFeePerGas: gasPrice,
        authorizationList: [authorization],
      });
      const hash = await rpc("eth_sendRawTransaction", [raw], "SCENARIO_AUTH_SEND");
      if (typeof hash !== "string" || !/^0x[0-9a-f]{64}$/iu.test(hash)) fail("SCENARIO_AUTH_SEND_FAILED", "SCENARIO");
      const receipt = await waitForReceipt(hash);
      if (typeof receipt.status === "string" && receipt.status !== "0x1") {
        const failure = new ForkError("SCENARIO_AUTH_REVERTED", "SCENARIO");
        failure.detail = await receiptFailureDetail(receipt, hash);
        throw failure;
      }
      state.authCapability = true;
      state.authCapabilityReason = null;
      return { capability: true, applied: true, account, delegate, hash, receipt };
    } catch (error) {
      if (error instanceof ForkError && AUTH_UNSUPPORTED_CODES.has(error.code)) {
        state.authCapability = false;
        state.authCapabilityReason = error.code;
        return { capability: false, applied: false, reason: error.code, account };
      }
      throw error;
    }
  };

  const ctx = {
    chainId,
    blockNumber: block.number,
    blockHash: block.hash,
    chain: String(chainId),
    ethers,
    input: plainValue(scenarioInput),

    async call({ to, data, from, block: atBlock } = {}) {
      guardBudget();
      state.calls += 1;
      if (state.calls > limits.calls) fail("SCENARIO_CALL_BUDGET_EXHAUSTED", "SCENARIO");
      if (!isAddress(to) || !isHexData(data)) fail("SCENARIO_CALL_INVALID", "SCENARIO");
      const tx = { to, data };
      if (from !== undefined) {
        if (!isAddress(from)) fail("SCENARIO_CALL_INVALID", "SCENARIO");
        tx.from = from;
      }
      return rpc("eth_call", [tx, toTag(atBlock, "SCENARIO_CALL_INVALID")], "SCENARIO_CALL");
    },

    async send({ from, to, data, value, gas } = {}) {
      guardBudget();
      state.sends += 1;
      if (state.sends > limits.sends) fail("SCENARIO_SEND_BUDGET_EXHAUSTED", "SCENARIO");
      if (!isAddress(from) || !isAddress(to) || !isHexData(data)) fail("SCENARIO_SEND_INVALID", "SCENARIO");
      const tx = { from, to, data };
      if (value !== undefined) {
        if (!isHexQuantity(value)) fail("SCENARIO_SEND_INVALID", "SCENARIO");
        tx.value = value;
      }
      // Anvil's implicit estimate can under-shoot the gas for a subsequent
      // transaction in a stateful fork. Bounded explicit gas is LOCAL-ONLY.
      if (gas !== undefined) {
        if (!isHexQuantity(gas) || BigInt(gas) < 1n || BigInt(gas) > 1_000_000n) fail("SCENARIO_SEND_INVALID", "SCENARIO");
        tx.gas = gas;
      }
      await rpc("anvil_impersonateAccount", [from], "SCENARIO_IMPERSONATE");
      state.impersonated.add(from);
      const hash = await rpc("eth_sendTransaction", [tx], "SCENARIO_SEND");
      if (typeof hash !== "string" || !/^0x[0-9a-f]{64}$/iu.test(hash)) fail("SCENARIO_SEND_FAILED", "SCENARIO");
      const receipt = await waitForReceipt(hash);
      if (typeof receipt.status === "string" && receipt.status !== "0x1") {
        const failure = new ForkError("SCENARIO_TX_REVERTED", "SCENARIO");
        failure.detail = await receiptFailureDetail(receipt, hash);
        throw failure;
      }
      return { hash, receipt };
    },

    async deploy({ from, data, value } = {}) {
      guardBudget();
      state.sends += 1;
      state.deployments += 1;
      if (state.sends > limits.sends) fail("SCENARIO_SEND_BUDGET_EXHAUSTED", "SCENARIO");
      if (!isAddress(from) || !isHexData(data) || data === "0x") fail("SCENARIO_DEPLOY_INVALID", "SCENARIO");
      const tx = { from, data };
      if (value !== undefined) {
        if (!isHexQuantity(value)) fail("SCENARIO_DEPLOY_INVALID", "SCENARIO");
        tx.value = value;
      }
      await rpc("anvil_impersonateAccount", [from], "SCENARIO_IMPERSONATE");
      state.impersonated.add(from);
      const hash = await rpc("eth_sendTransaction", [tx], "SCENARIO_DEPLOY");
      if (typeof hash !== "string" || !/^0x[0-9a-f]{64}$/iu.test(hash)) fail("SCENARIO_DEPLOY_FAILED", "SCENARIO");
      const receipt = await waitForReceipt(hash);
      if (typeof receipt.status === "string" && receipt.status !== "0x1") {
        const failure = new ForkError("SCENARIO_TX_REVERTED", "SCENARIO");
        failure.detail = await receiptFailureDetail(receipt, hash);
        throw failure;
      }
      if (!isAddress(receipt.contractAddress)) fail("SCENARIO_DEPLOY_FAILED", "SCENARIO");
      return { hash, receipt, address: receipt.contractAddress.toLowerCase() };
    },

    async impersonate(address) {
      guardBudget();
      if (!isAddress(address)) fail("SCENARIO_IMPERSONATE_INVALID", "SCENARIO");
      await rpc("anvil_impersonateAccount", [address], "SCENARIO_IMPERSONATE");
      state.impersonated.add(address);
      return true;
    },

    async stopImpersonating(address) {
      guardBudget();
      if (!isAddress(address)) fail("SCENARIO_IMPERSONATE_INVALID", "SCENARIO");
      const result = await stopImpersonatingAccount(localRpc, address);
      state.impersonated.delete(address);
      return result;
    },

    async setBalance(address, weiHex) {
      guardBudget();
      if (!isAddress(address) || !isHexQuantity(weiHex)) fail("SCENARIO_SETBALANCE_INVALID", "SCENARIO");
      return rpc("anvil_setBalance", [address, weiHex], "SCENARIO_SETBALANCE");
    },

    // etch-approximation on the LOCAL fork: write exactly the code supplied
    // (including the 23-byte EIP-7702 designator 0xef0100||delegate). Permissive
    // by design — no code-shape / contract-ness validation. Returns anvil's
    // acknowledgement (or true when the node returns nothing).
    async setCode(address, code) {
      guardBudget();
      if (!isAddress(address) || !isHexData(code)) fail("SCENARIO_SETCODE_INVALID", "SCENARIO");
      const result = await rpc("anvil_setCode", [address, code], "SCENARIO_SETCODE");
      return result === undefined ? true : result;
    },

    async getBalance(address, atBlock) {
      guardBudget();
      if (!isAddress(address)) fail("SCENARIO_GETBALANCE_INVALID", "SCENARIO");
      return rpc("eth_getBalance", [address, toTag(atBlock, "SCENARIO_GETBALANCE_INVALID")], "SCENARIO_GETBALANCE");
    },

    async getStorageAt(address, slot, atBlock) {
      guardBudget();
      if (!isAddress(address) || !isHexQuantity(slot)) fail("SCENARIO_STORAGE_INVALID", "SCENARIO");
      return rpc("eth_getStorageAt", [address, slot, toTag(atBlock, "SCENARIO_STORAGE_INVALID")], "SCENARIO_STORAGE");
    },

    async getCode(address, atBlock) {
      guardBudget();
      if (!isAddress(address)) fail("SCENARIO_CODE_INVALID", "SCENARIO");
      return rpc("eth_getCode", [address, toTag(atBlock, "SCENARIO_CODE_INVALID")], "SCENARIO_CODE");
    },

    // Real EIP-7702 delegation (type-0x4 authorizationList). Signs and submits
    // to the LOCAL anvil only; an unsupported node returns capability:false.
    sendAuthorization,
    send7702: sendAuthorization,

    // Reports which injection primitives this harness exposes. authorizationList
    // is "unknown" until a send is attempted, then true/false per the node.
    capabilities() {
      return {
        setCode: true,
        sendAuthorization: true,
        authorizationList: state.authCapability === true ? true : state.authCapability === false ? false : "unknown",
        authorizationListReason: state.authCapabilityReason || null,
      };
    },

    async snapshot() {
      guardBudget();
      state.snapshots += 1;
      if (state.snapshots > limits.snapshots) fail("SCENARIO_SNAPSHOT_BUDGET_EXHAUSTED", "SCENARIO");
      const id = await rpc("evm_snapshot", [], "SCENARIO_SNAPSHOT");
      if (id === null || id === undefined) fail("SCENARIO_SNAPSHOT_FAILED", "SCENARIO");
      return id;
    },

    async revert(id) {
      guardBudget();
      return rpc("evm_revert", [id], "SCENARIO_REVERT");
    },

    log(label, value) {
      if (state.observations.length >= limits.observations) fail("SCENARIO_OBSERVATION_BUDGET_EXHAUSTED", "SCENARIO");
      if (!isLabel(label)) fail("SCENARIO_LOG_LABEL_INVALID", "SCENARIO");
      const entry = { label, value: plainValue(value) };
      leakGuard(entry);
      state.observations.push(entry);
      return entry.value;
    },

    assert(condition, label = "assert") {
      if (state.asserts.length >= limits.asserts) fail("SCENARIO_ASSERT_BUDGET_EXHAUSTED", "SCENARIO");
      if (!isLabel(label)) fail("SCENARIO_ASSERT_LABEL_INVALID", "SCENARIO");
      const pass = condition === true || (condition !== false && condition !== null && condition !== undefined && condition !== 0 && condition !== "");
      const entry = { label, pass: Boolean(pass) };
      state.asserts.push(entry);
      if (!entry.pass && state.fatal) fail("SCENARIO_ASSERT_FAILED", "SCENARIO");
      return entry.pass;
    },

    get fatal() {
      return state.fatal;
    },
    set fatal(value) {
      state.fatal = Boolean(value);
    },
  };

  Object.defineProperty(ctx, "_state", { value: state, enumerable: false });
  if (historicalProfile) return createHistoricalChildContext(ctx, { profile: historicalProfile, localRpc, ethers, guardBudget });
  return ctx;
}

// ---------------------------------------------------------------------------
// upstream resolution (archive-capable), block pinning, relay/anvil lifecycle
// ---------------------------------------------------------------------------
async function fetchBlock(url, blockRef, transport) {
  const tag = blockRef === "finalized" ? "finalized" : hexQuantity(blockRef);
  let response;
  try {
    response = await transport(url, { jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: [tag, false] }, LIMITS.requestMs, LIMITS.messageBytes);
  } catch (_) {
    return null;
  }
  if (!response || !response.value || response.value.error || typeof response.value.result !== "object" || response.value.result === null) return null;
  const header = response.value.result;
  if (!isHexQuantity(header.number) || typeof header.hash !== "string" || typeof header.stateRoot !== "string") return null;
  return { number: BigInt(header.number).toString(), numberHex: header.number, hash: header.hash.toLowerCase(), stateRoot: header.stateRoot.toLowerCase() };
}

async function probeArchive(url, blockNumberHex, transport) {
  let response;
  try {
    response = await transport(url, { jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [ARCHIVE_PROBE_ADDRESS, blockNumberHex] }, LIMITS.requestMs, LIMITS.messageBytes);
  } catch (_) {
    return false;
  }
  return Boolean(response && response.value && !response.value.error && typeof response.value.result === "string" && /^0x[0-9a-f]*$/iu.test(response.value.result));
}

async function resolveArchiveUpstream(chainId, blockRef, deps) {
  let pool;
  try {
    pool = await deps.loadRpcUrls({ maxCandidates: LIMITS.candidates });
  } catch (_) {
    pool = [];
  }
  let remaining = Array.isArray(pool) ? pool.slice() : [];
  for (let attempt = 0; attempt < LIMITS.archiveAttempts; attempt += 1) {
    const url = remaining.length ? await deps.resolveUpstream(chainId, remaining) : await deps.resolveUpstream(chainId, null);
    if (!url) fail("UPSTREAM_UNAVAILABLE", "UPSTREAM");
    const block = await fetchBlock(url, blockRef, deps.transport);
    if (block && (await probeArchive(url, block.numberHex, deps.transport))) return { url, block };
    remaining = remaining.filter((candidate) => candidate !== url);
  }
  fail("ARCHIVE_UPSTREAM_UNAVAILABLE", "UPSTREAM");
}

function startAnvilProcess(args) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = childProcess.spawn(ANVIL_PATH, args, {
        stdio: ["ignore", "ignore", "ignore"],
        windowsHide: true,
        shell: false,
        env: sanitizedChildEnvironment(),
      });
    } catch (_) {
      reject(new ForkError("ANVIL_START_FAILED", "ANVIL_START"));
      return;
    }
    child.once("spawn", () => resolve(child));
    child.once("error", () => reject(new ForkError("ANVIL_START_FAILED", "ANVIL_START")));
  });
}

function defaultDeps() {
  return {
    loadRpcUrls: (options) => sharedRpc.loadRpcUrls(options),
    resolveUpstream: (chainId, urls) => sharedRpc.resolveRpc(Number(chainId), urls === undefined ? null : urls),
    transport: defaultTransport,
    freePort: approved.freePort,
    createRelay: (options) => createReadOnlyRelay(options),
    startAnvil: (args) => startAnvilProcess(args),
    stopAnvil: (child) => stopAnvil(child),
    createLocalRpc: (port) => createLocalRpc(port),
    waitReady: (child, localRpc, manifest) => approved.waitReady(child, localRpc, manifest),
    loadScenario: (file) => require(file),
    ethers: () => require("ethers"),
    now: () => Date.now(),
    write: (text) => process.stdout.write(text),
    outDir: OUT_DIR,
  };
}

function registerSignals() {
  if (ACTIVE.registered) return;
  ACTIVE.registered = true;
  const handler = async () => {
    try {
      if (ACTIVE.cleanup) await ACTIVE.cleanup();
    } catch (_) {
      /* best effort on signal path */
    } finally {
      process.exit(130);
    }
  };
  process.once("SIGINT", handler);
  process.once("SIGTERM", handler);
}

async function runBounded(scenario, ctx, deadline, now) {
  const remaining = deadline - now();
  if (remaining <= 0) fail("FORK_POC_WALL_CLOCK_EXCEEDED", "BOUNDS");
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(() => scenario(ctx)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ForkError("FORK_POC_SCENARIO_TIMEOUT", "BOUNDS")), remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function writeEvidence(outPath, output) {
  leakGuard(output);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const bytes = Buffer.from(`${JSON.stringify(output, null, 2)}\n`);
  fs.writeFileSync(outPath, bytes);
  return bytes;
}

async function runForkPoc(options = {}, depsInput = {}) {
  const held = epochExecution.asyncBlock(options);
  if (held) return held; // before scenario/endpoint/child work, regardless of JSON flags
  const diagnosticContext = epochExecution.diagnostic(options);
  try { return await runManualForkPoc(options, depsInput, diagnosticContext); }
  catch (_) { return { status: "FAIL_CLOSED", blocker: "FORK_SETUP_FAILED", ...epochExecution.metadata(diagnosticContext), output: null, outPath: null }; }
}

async function runManualForkPoc(options, depsInput, diagnosticContext) {
  const deps = { ...defaultDeps(), ...depsInput };
  const limits = { ...LIMITS, ...(options.limits || {}) };
  const started = deps.now();
  const deadline = started + limits.totalMs;
  let chainId = null, blockRef = null, scenarioName = null, scenario = null;
  const generatedAt = new Date(deps.now()).toISOString();

  let relay = null;
  let child = null;
  let localRpc = null;
  let resolved = null;
  let ctx = null;
  let blocker = null;
  let blockerDetail = null;
  let relayStats = null;
  let result = "FAIL_CLOSED";
  const cleanup = { child: "NOT_STARTED", relay: "NOT_STARTED" };
  const cleanupFailures = [];

  const guard = () => {
    if (deps.now() > deadline) fail("FORK_POC_WALL_CLOCK_EXCEEDED", "BOUNDS");
  };

  const activeCleanup = async () => {
    // Tolerantly release any scenario impersonation before killing Anvil. A
    // prior evm_revert can already have dropped impersonation, which must not
    // turn cleanup into a failure.
    if (ctx && localRpc) {
      for (const address of [...ctx._state.impersonated]) {
        await stopImpersonatingAccount(localRpc, address);
        ctx._state.impersonated.delete(address);
      }
    }
    if (child) {
      try {
        await deps.stopAnvil(child);
        cleanup.child = "STOPPED";
      } catch (error) {
        cleanup.child = "FAILED";
        cleanupFailures.push(error instanceof ForkError ? error.code : "CHILD_CLEANUP_FAILED");
      }
      child = null;
    }
    if (relay) {
      try { relayStats = typeof relay.stats === "function" ? relay.stats() : null; } catch (_) { relayStats = null; }
      try {
        await relay.close();
        cleanup.relay = "CLOSED";
      } catch (error) {
        cleanup.relay = "FAILED";
        cleanupFailures.push(error instanceof ForkError ? error.code : "RELAY_CLEANUP_FAILED");
      }
      relay = null;
    }
  };

  registerSignals();
  try {
    const historicalProfile = options.historicalChild ? validateHistoricalChildProfile(options.historicalChild, options.chain) : null;
    chainId = normalizeChain(options.chain);
    blockRef = normalizeBlock(options.block);
    if (historicalProfile) {
      if (blockRef !== "finalized" && blockRef !== historicalProfile.parentNumber) fail("HISTORICAL_CHILD_PARENT_MISMATCH", "HISTORICAL_CHILD");
      blockRef = historicalProfile.parentNumber;
    }
    const scenarioFile = path.resolve(String(options.scenario || ""));
    const scenarioModule = deps.loadScenario(scenarioFile);
    scenario = scenarioModule && (scenarioModule.run || (scenarioModule.default && scenarioModule.default.run));
    if (typeof scenario !== "function") fail("SCENARIO_INVALID", "SCENARIO");
    scenarioName = options.scenarioName || scenarioNameFrom(scenarioFile);
    resolved = await resolveArchiveUpstream(chainId, blockRef, deps);
    if (historicalProfile && (resolved.block.number !== historicalProfile.parentNumber || resolved.block.hash !== historicalProfile.parentHash || resolved.block.stateRoot !== historicalProfile.parentStateRoot)) fail("HISTORICAL_CHILD_PARENT_MISMATCH", "HISTORICAL_CHILD");
    guard();
    relay = await deps.createRelay({ upstreamUrl: resolved.url, transport: deps.transport, limits });
    guard();
    ACTIVE.cleanup = activeCleanup;
    const localPort = await deps.freePort();
    const args = (historicalProfile ? buildHistoricalChildAnvilArgs : buildAnvilArgs)(relay.port, localPort, chainId, resolved.block.number);
    if (args.some((value) => /https?:\/\//iu.test(value) && !/^http:\/\/127\.0\.0\.1:\d+$/u.test(value))) fail("CHILD_ARGV_UNSANITIZED", "ANVIL_START");
    child = await deps.startAnvil(args);
    guard();
    localRpc = deps.createLocalRpc(localPort);
    if (historicalProfile) localRpc = createHistoricalChildRpc(localRpc);
    await deps.waitReady(child, localRpc, {
      chainId: String(chainId),
      pinBlockNumber: resolved.block.number,
      pinBlockHash: resolved.block.hash,
      pinStateRoot: resolved.block.stateRoot,
    });
    guard();
    const ethers = await deps.ethers();
    ctx = createScenarioContext({ chainId, block: resolved.block, localRpc, ethers, scenarioInput: options.scenarioInput || null, limits, now: deps.now, deadline, historicalChild: historicalProfile });
    await runBounded(scenario, ctx, deadline, deps.now);
    const failed = ctx._state.asserts.some((entry) => !entry.pass);
    result = failed ? "FAIL" : "PASS";
  } catch (error) {
    const forkError = error instanceof ForkError ? error : new ForkError("UNEXPECTED_SCENARIO_FAILURE", "SCENARIO");
    blocker = forkError.code;
    blockerDetail = typeof forkError.detail === "string" && forkError.detail ? forkError.detail : null;
    result = "FAIL_CLOSED";
  } finally {
    try {
      await activeCleanup();
    } catch (error) {
      cleanupFailures.push(error instanceof ForkError ? error.code : "TEARDOWN_FAILED");
    } finally {
      ACTIVE.cleanup = null;
    }
    if (cleanupFailures.length && !blocker) {
      blocker = cleanupFailures[0];
      result = "FAIL_CLOSED";
    }
  }

  // A fork was started, so an audit artifact is produced on every path —
  // success, failed assertion, scenario throw, timeout, or teardown failure.
  const output = {
    schema: SCHEMA,
    ...epochExecution.metadata(diagnosticContext),
    status: result,
    generatedAt,
    chainId,
    block: resolved ? resolved.block.number : blockRef === "finalized" ? null : blockRef,
    blockHash: resolved ? resolved.block.hash : null,
    scenarioName,
    observations: ctx ? ctx._state.observations : [],
    asserts: ctx ? ctx._state.asserts : [],
    result,
    blocker: blocker || null,
    blockerDetail,
    relay: relayStats && Array.isArray(relayStats.deniedMethods)
      ? { deniedMethods: relayStats.deniedMethods.slice(0, 8).filter((name) => typeof name === "string" && /^[A-Za-z0-9_]{1,64}$/u.test(name)) }
      : null,
    safety: {
      localOnly: true,
      impersonationOnly: true,
      noSigning: true,
      noBroadcast: true,
      endpointInventoryPrinted: false,
    },
    stats: ctx ? { calls: ctx._state.calls, sends: ctx._state.sends, deployments: ctx._state.deployments, snapshots: ctx._state.snapshots } : null,
    cleanup,
  };
  const outPath = options.outPath || path.join(deps.outDir || OUT_DIR, `${scenarioName}.json`);
  try {
    leakGuard(output);
  } catch (_) {
    return { status: "FAIL_CLOSED", blocker: "OUTPUT_REDACTED", ...epochExecution.metadata(diagnosticContext), output: null, outPath: null };
  }
  try {
    (depsInput.writeEvidence || writeEvidence)(outPath, output);
  } catch (error) {
    // An artifact write failure must itself fail closed and never surface as
    // an uncaught exception.
    if (!blocker) {
      blocker = error instanceof ForkError ? error.code : "ARTIFACT_WRITE_FAILED";
      result = "FAIL_CLOSED";
      output.status = result;
      output.result = result;
      output.blocker = blocker;
    }
  }
  return { status: result, blocker: blocker || null, output, outPath, ...epochExecution.metadata(diagnosticContext) };
}

// Synchronous INERT MODEL only. No defaults invoke require, fs, RPC or a child.
function runEpochHarnessModel(request, deps = {}) {
  const env = epochExecution.envelope(request);
  if (!env.ok) return { status: "FAIL_CLOSED", blocker: env.blocker, ...epochExecution.metadata(env) };
  let snapshot;
  try { snapshot = epochExecution.snapshotRequest(request); }
  catch (_) { return epochExecution.result(env, "MODEL_BLOCKED", "MODEL_SOURCE_INVALID", false); }
  let code = null, passed = false, cleaned = false;
  const workEnvelope = Object.freeze({ ...epochExecution.metadata(env), eventText: snapshot.eventText });
  const gate = epochExecution.guard(env, deps.clock);
  const check = () => { const s = gate("work"); const b = epochExecution.normalized(env, snapshot, s); if (b) throw new Error(b); };
  try {
    for (const key of ["loadScenario", "qualify", "start", "runScenario", "cleanup", "writeResult"]) if (typeof deps[key] !== "function") throw new Error("MODEL_DEPENDENCY_INVALID");
    check();
    const scenario = epochExecution.rejectPromise(deps.loadScenario(workEnvelope));
    if (!epochExecution.scenarioDescriptor(scenario, env, snapshot.eventText)) throw new Error("MODEL_SCENARIO_INVALID");
    check();
    if (!epochExecution.synchronousProof(epochExecution.rejectPromise(deps.qualify(workEnvelope)), "trigger-fork-inert-qualification/v1", "pinsVerified")) throw new Error("MODEL_QUALIFICATION_FAILED");
    check();
    if (!epochExecution.synchronousProof(epochExecution.rejectPromise(deps.start(workEnvelope)), "trigger-fork-inert-start/v1", "contained")) throw new Error("MODEL_START_FAILED");
    check();
    const answer = epochExecution.rejectPromise(deps.runScenario(workEnvelope));
    if (!epochExecution.assertion(answer, env)) throw new Error("MODEL_ASSERTION_FAILED");
    check(); passed = true;
  } catch (error) { code = epochExecution.failureCode(error, "MODEL_SCENARIO_FAILED"); }
  // Clock eligibility classifies evidence; it must never suppress shutdown.
  // Startup may have begun even if its callback threw/returned uncertain data.
  let cleanupTimely = true;
  try { gate("cleanup"); } catch (_) { cleanupTimely = false; }
  try {
    cleaned = epochExecution.synchronousProof(deps.cleanup(epochExecution.metadata(env)), "trigger-fork-inert-teardown/v1", "teardownVerified");
  } catch (_) { cleaned = false; }
  try { gate("cleanup"); } catch (_) { cleanupTimely = false; }
  cleaned = cleaned && cleanupTimely;
  if (!cleaned) code = "MODEL_TEARDOWN_UNCONFIRMED";
  let answer = epochExecution.result(env, passed && cleaned ? "MODEL_PASS" : cleaned && code !== "MODEL_ASYNC_UNSUPPORTED" ? "MODEL_BLOCKED" : "MODEL_UNCERTAIN", code, cleaned);
  try {
    gate(answer.status === "MODEL_PASS" ? "work" : "cleanup");
    if (!epochExecution.synchronousProof(deps.writeResult(answer), "trigger-fork-inert-write/v1", "written")) throw new Error("MODEL_WRITE_FAILED");
    gate(answer.status === "MODEL_PASS" ? "work" : "cleanup");
  } catch (_) { answer = epochExecution.result(env, "MODEL_UNCERTAIN", "MODEL_WRITE_FAILED", cleaned); }
  return answer;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
async function main(argv = process.argv, depsInput = {}) {
  const deps = { ...defaultDeps(), ...depsInput };
  const write = deps.write || ((text) => process.stdout.write(text));
  let parsed;
  try {
    parsed = parseArgs(argv.slice(2));
  } catch (error) {
    write(`${USAGE}\n`);
    return { status: "USAGE_ERROR", blocker: error instanceof ForkError ? error.code : "USAGE_ERROR" };
  }
  if (!parsed.run) {
    write(`${USAGE}\n`);
    return { status: "USAGE_ERROR", blocker: "EXPLICIT_RUN_REQUIRED" };
  }
  if (!parsed.chain || !parsed.scenario) {
    write(`${USAGE}\n`);
    return { status: "USAGE_ERROR", blocker: "USAGE_ERROR" };
  }
  try {
    return await runForkPoc({ ...parsed, block: parsed.block || "finalized" }, depsInput);
  } catch (error) {
    // Defensive last resort. runForkPoc writes an artifact for any failure that
    // occurs after the fork started; if it threw earlier there is nothing to
    // persist, but we still emit a sanitized summary instead of a stack trace.
    if (error && error.output && error.outPath) {
      try {
        writeEvidence(error.outPath, error.output);
      } catch (_) {
        /* retain the original failure */
      }
    }
    const blocker = error instanceof ForkError ? error.code : "INTERNAL_FAILURE_REDACTED";
    write(`${JSON.stringify({ status: "FAIL_CLOSED", blocker })}\n`);
    return { status: "FAIL_CLOSED", blocker };
  }
}

async function runCli(argv = process.argv, depsInput = {}) {
  try {
    const deps = { ...defaultDeps(), ...depsInput };
    const outcome = await main(argv, deps);
    if (outcome && outcome.output && outcome.outPath) {
      deps.write(`${JSON.stringify({
        status: outcome.status,
        scenario: outcome.output.scenarioName,
        chainId: outcome.output.chainId,
        block: outcome.output.block,
        result: outcome.output.result,
        blocker: outcome.output.blocker,
        observations: outcome.output.observations.length,
        asserts: outcome.output.asserts.length,
        artifact: path.relative(ROOT, outcome.outPath),
      })}\n`);
    }
    process.exitCode = outcome && outcome.status === "PASS" ? 0 : 1;
    return outcome;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: "FAIL_CLOSED", blocker: error instanceof ForkError ? error.code : "INTERNAL_FAILURE_REDACTED" })}\n`);
    process.exitCode = 1;
    return { status: "FAIL_CLOSED", blocker: error instanceof ForkError ? error.code : "INTERNAL_FAILURE_REDACTED" };
  }
}

if (require.main === module) runCli();

module.exports = {
  runEpochHarnessModel,
  ROOT,
  OUT_DIR,
  SCHEMA,
  LIMITS,
  ANVIL_PATH,
  USAGE,
  ForkError,
  leakGuard,
  parseArgs,
  normalizeChain,
  normalizeBlock,
  scenarioNameFrom,
  plainValue,
  computeExpectedChildBaseFee,
  validateHistoricalChildProfile,
  createHistoricalChildRpc,
  buildHistoricalChildAnvilArgs,
  createScenarioContext,
  stopImpersonatingAccount,
  fetchBlock,
  probeArchive,
  resolveArchiveUpstream,
  startAnvilProcess,
  defaultDeps,
  registerSignals,
  runBounded,
  writeEvidence,
  runForkPoc,
  main,
  runCli,
};
