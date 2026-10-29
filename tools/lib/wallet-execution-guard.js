"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { keccak256, id, Transaction, accessListify } = require("../node_modules/ethers");
const MAIN_ACCOUNT = "0x24e46e91dfaad1fa3d49c48aa85ca9306885ce0a";
const ROOT = path.resolve(__dirname, "../..");
const DEFAULT_LOCK_ROOT = path.join(ROOT, "coordination", "wallet-execution-locks");
const DEFAULT_JOURNAL_DIR = path.join(ROOT, "reports/raw/fast/aave-v4-v3-morpho-liquidator-execution");
const PENDING = new Set(["PREPARED", "SENT", "UNCERTAIN"]);
const FINAL = new Set(["RECEIPT_VERIFIED", "REVERTED", "ABORTED_UNSIGNED"]);
const TIP_PROFIT_SHARE_BPS = 5000n;
const LEGACY_PRIORITY_FEE_WEI = 50_000_000n;
const M1_POSITION = "1:0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb:0xa3609cf7872faa7804281c7c5edb8b2d33001089:0xc581c5f70bd1afa283eed57d1418c6432cbff1d862f94eaf58fdd4e46afbb67f";
const M1_EVENT_KEY = id(M1_POSITION);
const isM1 = intent => intent?.targetId === "targetM1_Morpho_USDe_DAI" || intent?.canonicalPosition === M1_POSITION || intent?.m1TriggerEventKey === M1_EVENT_KEY;
class ExecutionError extends Error { constructor(code) { super(code); this.code = code; } }
function requireThat(ok, code) { if (!ok) throw new ExecutionError(code); }
function safeError(error) { return error instanceof ExecutionError ? error.code : "EXECUTION_FAILED"; }
const TIMING_PHASES = new Set(["poolQualification", "pairQualification", "futureQualification", "pinAcquisition", "m1Collection",
  "preparation", "source", "runtime", "state", "feeds", "variants", "lockWait", "finalValidation", "sign", "send", "sendAck", "receipt", "wsArrival"]);
// Capture only while execution is active. Even a synchronous observer can spend
// the remaining authorization/child window, so callers flush only after exit.
function createTiming(onTiming, now = Date.now) {
  const events = []; let closed = false;
  const capture = event => {
    if (closed || typeof onTiming !== "function" || events.length >= 256) return;
    try {
      const { phase, edge, atMonoMs, atWallMs, durationMs } = event;
      if (!TIMING_PHASES.has(phase) || !["start", "end", "point"].includes(edge) ||
        !Number.isFinite(atMonoMs) || !Number.isFinite(atWallMs) ||
        edge === "end" && (!Number.isFinite(durationMs) || durationMs < 0)) return;
      events.push(Object.freeze({ phase, edge, atMonoMs, atWallMs, ...(edge === "end" ? { durationMs } : {}) }));
    } catch (_) { /* metrics cannot fail execution */ }
  };
  const emit = (phase, edge, started, clock) => {
    if (closed || typeof onTiming !== "function" || !TIMING_PHASES.has(phase)) return;
    try {
      const atMonoMs = clock ?? performance.now(), atWallMs = now();
      capture({ phase, edge, atMonoMs, atWallMs,
        ...(started === undefined ? {} : { durationMs: Math.max(0, atMonoMs - started) }) });
    } catch (_) { /* metrics cannot fail execution */ }
  };
  return { capture, flush: () => {
    if (closed) return;
    closed = true;
    // Nested M1/lock captures arrive at exit; restore their original clock order.
    for (const event of events.splice(0).sort((a, b) => a.atMonoMs - b.atMonoMs)) {
      try { Promise.resolve(onTiming(event)).catch(() => {}); } catch (_) { /* observation only */ }
    }
  }, point: phase => emit(phase, "point"), start: phase => {
    if (typeof onTiming !== "function") return () => {};
    const started = performance.now(); emit(phase, "start", undefined, started); let ended = false;
    return () => { if (!ended) { ended = true; emit(phase, "end", started); } };
  } };
}
const address = value => typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value);
const hash = value => typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);
const reasonCode = value => typeof value === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) && value === value.trim();
function uint(value, code = "INVALID_INTEGER") {
  requireThat((typeof value === "bigint" && value >= 0n) || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) ||
    (typeof value === "string" && /^(?:0|[1-9][0-9]*|0x[0-9a-f]+)$/i.test(value)), code);
  return BigInt(value);
}
function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + "." + crypto.randomUUID() + ".tmp";
  const fd = fs.openSync(temporary, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v, 2) + "\n"); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
}
function acquireWalletLock({ chainId = 1, account = MAIN_ACCOUNT, lockRoot = DEFAULT_LOCK_ROOT } = {}) {
  requireThat((chainId === 1 || chainId === 8453 || chainId === 42161) && address(account), "LOCK_SCOPE_INVALID");
  fs.mkdirSync(lockRoot, { recursive: true });
  const directory = path.join(lockRoot, `chain-${chainId}-${account.toLowerCase()}`), token = crypto.randomUUID();
  try { fs.mkdirSync(directory); } catch (e) { throw new ExecutionError(e.code === "EEXIST" ? "WALLET_LOCK_HELD" : "WALLET_LOCK_IO_ERROR"); }
  // If metadata creation fails, retain the lock for attended recovery. No stale-lock reclamation.
  atomicJson(path.join(directory, "owner.json"), { token, chainId, account: account.toLowerCase(), pid: process.pid, createdAt: new Date().toISOString() });
  let released = false;
  return { token, directory, release() {
    requireThat(!released, "LOCK_ALREADY_RELEASED");
    let owner; try { owner = JSON.parse(fs.readFileSync(path.join(directory, "owner.json"), "utf8")); } catch (_) { throw new ExecutionError("LOCK_OWNER_UNVERIFIABLE"); }
    requireThat(owner.token === token, "LOCK_OWNER_MISMATCH");
    fs.unlinkSync(path.join(directory, "owner.json")); fs.rmdirSync(directory); released = true;
  } };
}
async function withWalletLock(options, fn) {
  const timing = createTiming(options?.onTiming, options?.now), endWait = timing.start("lockWait");
  try {
  let lock;
  try { lock = acquireWalletLock(options); } finally { endWait(); }
  try { return await fn(lock); } finally { lock.release(); }
  } finally { timing.flush(); }
}
function readJournals(directory = DEFAULT_JOURNAL_DIR, account = MAIN_ACCOUNT, expectedChainId = 1) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(name => name.endsWith(".json")).map(name => {
    const file = path.join(directory, name); let record;
    try { requireThat(fs.lstatSync(file).isFile(), "JOURNAL_MALFORMED"); record = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (_) { throw new ExecutionError("JOURNAL_MALFORMED"); }
    requireThat(record && (PENDING.has(record.stage) || FINAL.has(record.stage)), "JOURNAL_MALFORMED");
    // Old untyped SENT records belong to this shared-wallet directory; never ignore by age.
    requireThat(record.chainId === undefined || record.chainId === expectedChainId, "JOURNAL_SCOPE_MISMATCH");
    requireThat(record.owner === undefined || record.owner.toLowerCase() === account.toLowerCase(), "JOURNAL_SCOPE_MISMATCH");
    if (record.stage === "ABORTED_UNSIGNED") {
      requireThat(record.schema === "wallet-execution-journal/v1" && record.chainId === expectedChainId && record.owner === account.toLowerCase() &&
        record.txHash === null && record.signerInvoked === false && record.abortPhase === "PRE_SIGN_VALIDATION" && reasonCode(record.reason) &&
        Number.isFinite(Date.parse(record.abortedAt)), "JOURNAL_MALFORMED");
    } else requireThat(record.txHash === null && record.stage === "PREPARED" || hash(record.txHash), "JOURNAL_MALFORMED");
    requireThat(Number.isFinite(Date.parse(record.executedAt)), "JOURNAL_MALFORMED");
    return { file, record };
  });
}
function receiptSummary(record, receipt) {
  requireThat(receipt && hash(receipt.transactionHash) && receipt.transactionHash.toLowerCase() === record.txHash.toLowerCase() &&
    hash(receipt.blockHash) && ["0x0", "0x1"].includes(receipt.status), "RECEIPT_INVALID");
  requireThat(receipt.from?.toLowerCase() === (record.owner || MAIN_ACCOUNT), "RECEIPT_SCOPE_MISMATCH");
  if (record.intent) requireThat(receipt.to?.toLowerCase() === record.intent.to, "RECEIPT_SCOPE_MISMATCH");
  const gasUsed = uint(receipt.gasUsed, "RECEIPT_INVALID"), gasPrice = uint(receipt.effectiveGasPrice, "RECEIPT_INVALID");
  requireThat(gasUsed > 0n && Array.isArray(receipt.logs), "RECEIPT_INVALID");
  if (record.intent) requireThat(gasUsed <= uint(record.intent.gasLimit) && gasPrice <= uint(record.intent.maxFeePerGasWei), "RECEIPT_CAP_MISMATCH");
  let actualTokenGainRaw = null, tokenGainEvidence = "UNKNOWN";
  // Only canonical transfers by the approved standard token, from this executor to its owner.
  if (receipt.status === "0x1" && record.intent?.profitToken) {
    let amount = 0n, found = false; const indices = new Set();
    const transfer = id("Transfer(address,address,uint256)");
    for (const log of receipt.logs) {
      requireThat(log && log.removed !== true && log.transactionHash?.toLowerCase() === record.txHash.toLowerCase() &&
        log.blockHash?.toLowerCase() === receipt.blockHash.toLowerCase(), "RECEIPT_LOG_INVALID");
      const index = uint(log.logIndex, "RECEIPT_LOG_INVALID").toString();
      requireThat(!indices.has(index), "RECEIPT_LOG_INVALID"); indices.add(index);
      if (log.address?.toLowerCase() !== record.intent.profitToken || log.topics?.[0]?.toLowerCase() !== transfer) continue;
      requireThat(log.topics.length === 3 && log.topics.slice(1).every(t => /^0x0{24}[0-9a-f]{40}$/i.test(t)) && /^0x[0-9a-f]{64}$/i.test(log.data), "RECEIPT_LOG_INVALID");
      const from = "0x" + log.topics[1].slice(-40).toLowerCase(), to = "0x" + log.topics[2].slice(-40).toLowerCase();
      if (to === record.owner && from === record.intent.to) { amount += BigInt(log.data); found = true; }
      else if (from === record.owner || to === record.owner) { found = false; amount = 0n; break; }
    }
    if (found) { actualTokenGainRaw = amount.toString(); tokenGainEvidence = "VALIDATED_EXECUTOR_TO_OWNER_TRANSFER_LOGS"; }
  }
  return { ...record, ok: receipt.status === "0x1", stage: receipt.status === "0x1" ? "RECEIPT_VERIFIED" : "REVERTED",
    receiptStatus: receipt.status, blockHash: receipt.blockHash.toLowerCase(), blockNumber: Number(uint(receipt.blockNumber, "RECEIPT_INVALID")),
    gasUsed: gasUsed.toString(), effectiveGasPriceWei: gasPrice.toString(), actualGasCostWei: (gasUsed * gasPrice).toString(),
    actualTokenGainRaw, tokenGainEvidence, realizedNetProfit: "UNKNOWN" };
}
async function reconcilePending({ journalDir = DEFAULT_JOURNAL_DIR, account = MAIN_ACCOUNT, expectedChainId = 1, receiptRpc }) {
  for (const { file, record } of readJournals(journalDir, account, expectedChainId)) {
    if (!PENDING.has(record.stage)) continue;
    requireThat(hash(record.txHash), "PREPARED_INTENT_REQUIRES_MANUAL_RECONCILIATION");
    let receipt; try { receipt = await receiptRpc(record.txHash); } catch (_) { throw new ExecutionError("RECEIPT_RPC_FAILED"); }
    requireThat(receipt !== null, "TX_ALREADY_PENDING_ON_SAME_WALLET");
    atomicJson(file, receiptSummary(record, receipt)); // Must persist before lock release/next nonce.
  }
}
async function reconcileWallet({ lockRoot = DEFAULT_LOCK_ROOT, journalDir = DEFAULT_JOURNAL_DIR, account = MAIN_ACCOUNT, expectedChainId = 1, receiptRpc }) {
  requireThat(path.resolve(lockRoot) !== path.resolve(journalDir), "LOCK_JOURNAL_PATH_CONFLICT");
  return withWalletLock({ lockRoot, account, chainId: expectedChainId }, () => reconcilePending({ journalDir, account, expectedChainId, receiptRpc }));
}
function validateBatch(batch, { kind, account = MAIN_ACCOUNT, requiredTargets, now = Date.now() }) {
  requireThat(batch?.schema === "live-execution-batch/v1" && batch.approved === true && batch.revoked !== true && Number.isFinite(now) &&
    typeof batch.approvedAt === "string" && batch.approvedAt.trim() !== "" && Number.isFinite(Date.parse(batch.approvedAt)) && Date.parse(batch.approvedAt) <= now &&
    typeof batch.expiresAt === "string" && batch.expiresAt.trim() !== "" && Number.isFinite(Date.parse(batch.expiresAt)) && now < Date.parse(batch.expiresAt),
  "BATCH_INVALID_OR_EXPIRED");
  requireThat(batch.chainId === 1 && batch.chain === "ethereum" && batch.account?.address?.toLowerCase() === account.toLowerCase(), "BATCH_SCOPE_MISMATCH");
  requireThat(Array.isArray(batch.targets) && Array.isArray(batch.actions) && batch.actions.every(a => typeof a === "string"), "BATCH_SCOPE_MISMATCH");
  const addresses = batch.targets.map(t => t.address?.toLowerCase());
  requireThat(requiredTargets.every(t => addresses.includes(t.toLowerCase())), "BATCH_TARGET_NOT_APPROVED");
  const c = batch.caps || {}, v4 = kind === "v4";
  requireThat(v4 || kind === "unified", "BATCH_SCOPE_MISMATCH");
  if (v4) {
    requireThat(batch.targets.some(t => t.kind === "contract-deployment" && t.contract === "FlashLiquidateAaveV4" && t.expectedOwner?.toLowerCase() === account) &&
      batch.actions.some(a => a.startsWith("EXECUTE_ON_TRIGGER: FlashLiquidateAaveV4.execute(Plan)") && a.includes("minSwapOut > 0") && a.includes("minProfit >= 100 USDC")), "BATCH_ACTION_NOT_APPROVED");
    requireThat(c.valueCapEth === "0", "BATCH_VALUE_CAP_INVALID");
    requireThat(uint(c.minProfitUsdcRaw) >= 100000000n && uint(c.minProfitWethRaw) >= 50000000000000000n, "BATCH_PROFIT_FLOOR_INVALID");
  } else {
    requireThat(batch.actions.some(a => a.startsWith("liquidator.executeMorpho(") && a.includes("net > 0")), "BATCH_ACTION_NOT_APPROVED");
    requireThat(c.slippageFloor === "minDebtTokenOut >= quoted * 0.995; minProfitDebtToken > 0" && /^zero \(atomic/.test(c.principalAtRisk || ""), "BATCH_SLIPPAGE_INVALID");
  }
  const gasCap = uint(v4 ? c.maxExecuteGasLimit : c.maxExecutionGasLimit, "BATCH_CAP_INVALID");
  const spendCap = uint(v4 ? c.maxNativeSpendPerTransactionWei : c.maxExecutionSpendWei, "BATCH_CAP_INVALID");
  const feeCap = v4 ? uint(c.maxFeePerGasWei, "BATCH_CAP_INVALID") : null;
  const dailyCap = v4 ? null : uint(c.signedExecutionsPerDay, "BATCH_CAP_INVALID");
  requireThat(gasCap > 0n && spendCap > 0n && (!v4 || feeCap > 0n) && (v4 || dailyCap > 0n), "BATCH_CAP_INVALID");
  return { gasCap, spendCap, feeCap, dailyCap, lifetimeCap: c.signedExecutionsTotal === undefined ? null : uint(c.signedExecutionsTotal, "BATCH_CAP_INVALID"), minProfitUsdc: v4 ? uint(c.minProfitUsdcRaw) : 25000000n,
    minProfitWeth: v4 ? uint(c.minProfitWethRaw) : 10000000000000000n };
}
// Takes the FINAL gas limit. Omission alone opts into the legacy non-profit policy;
// an explicitly missing/invalid profit must never silently select that fallback.
function buildFeePolicy(gasLimit, baseFee, caps, ...profitInput) {
  gasLimit = uint(gasLimit);
  const base = uint(baseFee), childBaseCeiling = base + (base + 7n) / 8n;
  requireThat(gasLimit > 0n && gasLimit <= caps.gasCap, "EXEC_GAS_EXCEEDS_CAP");
  const min = (a, b) => a < b ? a : b;
  let feeMaximum = caps.spendCap / gasLimit;
  if (caps.feeCap != null) feeMaximum = min(feeMaximum, caps.feeCap);
  requireThat(feeMaximum >= childBaseCeiling && feeMaximum > 0n, "FEE_CAP_BELOW_BASE_FEE");
  if (profitInput.length === 0) {
    const maxFeePerGas = min(feeMaximum, base * 2n + LEGACY_PRIORITY_FEE_WEI);
    return { gasLimit, maxFeePerGas, maxPriorityFeePerGas: min(maxFeePerGas - base, LEGACY_PRIORITY_FEE_WEI) };
  }
  const profit = uint(profitInput[0], "PROFIT_BEFORE_GAS_REQUIRED"), headroom = feeMaximum - childBaseCeiling;
  const tipBudget = TIP_PROFIT_SHARE_BPS * profit / (10000n * gasLimit), floor = min(LEGACY_PRIORITY_FEE_WEI, headroom);
  let tip = min(tipBudget, headroom);
  if (tip < floor && profit > gasLimit * (childBaseCeiling + floor)) tip = floor;
  const maxFeePerGas = min(feeMaximum, childBaseCeiling + tip), maxPriorityFeePerGas = min(tip, maxFeePerGas - childBaseCeiling);
  requireThat(profit - gasLimit * maxFeePerGas > 0n, "PROFIT_NET_NONPOSITIVE");
  return { gasLimit, maxFeePerGas, maxPriorityFeePerGas };
}
function buildFees(gasEstimate, baseFee, caps, ...profitInput) {
  return buildFeePolicy((uint(gasEstimate) * 120n + 99n) / 100n, baseFee, caps, ...profitInput);
}
function validateTransaction(tx, caps, expectedChainId = 1) {
  requireThat(tx.chainId === expectedChainId && tx.type === 2 && uint(tx.value) === 0n && address(tx.to) && /^0x(?:[0-9a-f]{2})+$/i.test(tx.data), "TX_SCOPE_INVALID");
  const gas = uint(tx.gasLimit), fee = uint(tx.maxFeePerGas), priority = uint(tx.maxPriorityFeePerGas);
  requireThat(gas > 0n && gas <= caps.gasCap && fee > 0n && priority <= fee && gas * fee <= caps.spendCap && (caps.feeCap === null || fee <= caps.feeCap), "TX_CAP_EXCEEDED");
  requireThat(Number.isSafeInteger(tx.nonce) && tx.nonce >= 0, "NONCE_INVALID");
}
function executionBinding(tx, code = "UNSIGNED_TRANSACTION_INVALID") {
  try {
    requireThat(tx && (tx.to === null || (address(tx.to) && tx.to.length === 42)) && typeof tx.data === "string" &&
      tx.data === tx.data.trim() && /^0x(?:[0-9a-f]{2})*$/i.test(tx.data), code);
    return { type: uint(tx.type, code).toString(), chainId: uint(tx.chainId, code).toString(), nonce: uint(tx.nonce, code).toString(),
      to: tx.to === null ? null : tx.to.toLowerCase(), data: tx.data.toLowerCase(), value: uint(tx.value, code).toString(),
      gasLimit: uint(tx.gasLimit, code).toString(), maxFeePerGas: uint(tx.maxFeePerGas, code).toString(),
      maxPriorityFeePerGas: uint(tx.maxPriorityFeePerGas, code).toString(),
      accessList: accessListify(tx.accessList ?? []).map(row => ({ address: row.address.toLowerCase(), storageKeys: row.storageKeys.map(key => key.toLowerCase()) })) };
  } catch (_) { throw new ExecutionError(code); }
}
function verifiedSignedHash(signed, expectedBinding, account, expectedChainId) {
  try {
    requireThat(typeof signed === "string" && signed === signed.trim() && /^0x(?:[0-9a-f]{2})+$/i.test(signed), "SIGNED_TRANSACTION_INVALID");
    const decoded = Transaction.from(signed);
    requireThat(decoded.isSigned() && decoded.serialized.toLowerCase() === signed.toLowerCase(), "SIGNED_TRANSACTION_INVALID");
    requireThat(decoded.type === 2 && decoded.chainId === BigInt(expectedChainId) && decoded.from?.toLowerCase() === account.toLowerCase(),
      "SIGNED_TRANSACTION_MISMATCH");
    requireThat(JSON.stringify(executionBinding(decoded, "SIGNED_TRANSACTION_INVALID")) === expectedBinding, "SIGNED_TRANSACTION_MISMATCH");
    return keccak256(signed);
  } catch (error) {
    throw new ExecutionError(error instanceof ExecutionError && error.code === "SIGNED_TRANSACTION_MISMATCH" ? error.code : "SIGNED_TRANSACTION_INVALID");
  }
}
async function executeGuarded({ account = MAIN_ACCOUNT, expectedChainId = 1, lockRoot = DEFAULT_LOCK_ROOT, journalDir = DEFAULT_JOURNAL_DIR,
  intent, prepare, validate, signTransaction, sendRawTransaction, receiptRpc, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), receiptWaitMs = 60000, onTiming }) {
  requireThat(path.resolve(lockRoot) !== path.resolve(journalDir), "LOCK_JOURNAL_PATH_CONFLICT");
  const timing = createTiming(onTiming, now);
  try {
  return await withWalletLock({ account, chainId: expectedChainId, lockRoot,
    onTiming: typeof onTiming === "function" ? timing.capture : undefined, now }, async () => {
    await reconcilePending({ journalDir, account, expectedChainId, receiptRpc });
    const journals = readJournals(journalDir, account, expectedChainId).filter(({ record }) => record.stage !== "ABORTED_UNSIGNED");
    if (isM1(intent)) {
      // No reset authority is implemented. Parent/hash/amount/nonce changes do
      // not establish a new trigger event; historical targetId-only records count.
      requireThat(intent.m1TriggerEventKey === undefined || intent.m1TriggerEventKey === M1_EVENT_KEY, "M1_TRIGGER_EVENT_KEY_INVALID");
      requireThat(!journals.some(({ record }) => isM1(record.intent)), "M1_TRIGGER_EVENT_ALREADY_ATTEMPTED");
      intent.m1TriggerEventKey = M1_EVENT_KEY;
    }
    if (intent.executionMode === "NEXT_BLOCK_PASSIVE") {
      requireThat(hash(intent.nextBlockReplayKey), "NEXT_BLOCK_REPLAY_KEY_REQUIRED");
      requireThat(!journals.some(({ record }) => record.intent?.nextBlockReplayKey === intent.nextBlockReplayKey), "NEXT_BLOCK_ALREADY_ATTEMPTED");
    }
    let prepared;
    const endPreparation = timing.start("preparation");
    try { prepared = await prepare(); } finally { endPreparation(); }
    requireThat(prepared != null && Object.hasOwn(prepared, "conservativeProfitBeforeGasWei"), "PROFIT_UNVERIFIED");
    const profit = uint(prepared.conservativeProfitBeforeGasWei, "PROFIT_UNVERIFIED");
    requireThat(profit > 0n, "PROFIT_UNVERIFIED");
    const { transaction, caps } = prepared;
    // Snapshot before callbacks can mutate the proved transaction. Never compare
    // signer output against the same mutable object handed to the signer.
    const expectedExecution = executionBinding(transaction), expectedBinding = JSON.stringify(expectedExecution);
    requireThat(transaction.from == null || (address(transaction.from) && transaction.from.toLowerCase() === account.toLowerCase()), "TX_SCOPE_INVALID");
    let initialCaps;
    const endInitialValidation = timing.start("finalValidation");
    try { initialCaps = await validate() || caps; validateTransaction(transaction, initialCaps, expectedChainId); }
    finally { endInitialValidation(); }
    const recent = readJournals(journalDir, account, expectedChainId).filter(({ record }) =>
      record.stage !== "ABORTED_UNSIGNED" && now() - Date.parse(record.executedAt) <= 86400000);
    const checkCaps = current => {
      requireThat(JSON.stringify(executionBinding(transaction)) === expectedBinding, "UNSIGNED_TRANSACTION_CHANGED");
      validateTransaction(transaction, current, expectedChainId);
      requireThat(profit - uint(transaction.gasLimit) * uint(transaction.maxFeePerGas) > 0n, "PROFIT_NET_NONPOSITIVE");
      requireThat(current.dailyCap === null || BigInt(recent.length) < current.dailyCap, "DAILY_EXECUTION_CAP_REACHED");
      requireThat(current.lifetimeCap == null || BigInt(journals.length) < current.lifetimeCap, "LIFETIME_EXECUTION_CAP_REACHED");
    };
    checkCaps(initialCaps);
    requireThat(transaction.to.toLowerCase() === intent.to && address(intent.profitToken), "INTENT_SCOPE_INVALID");
    const file = path.join(journalDir, `execution-${now()}-${crypto.randomUUID()}.json`);
    let record = { schema: "wallet-execution-journal/v1", stage: "PREPARED", chainId: expectedChainId, owner: account.toLowerCase(), executedAt: new Date(now()).toISOString(),
      intent: { ...intent, calldataHash: keccak256(transaction.data), nonce: transaction.nonce, valueWei: "0", gasLimit: transaction.gasLimit.toString(),
        maxFeePerGasWei: transaction.maxFeePerGas.toString(), maxPriorityFeePerGasWei: transaction.maxPriorityFeePerGas.toString(), accessList: expectedExecution.accessList },
      txHash: null, actualTokenGainRaw: null, realizedNetProfit: "UNKNOWN" };
    atomicJson(file, record);
    try {
      const endValidation = timing.start("finalValidation");
      try { checkCaps(await validate() || caps); } // Reloaded caps, expiry and pin immediately before key access/signing.
      finally { endValidation(); }
    } catch (error) {
      // This catch ends BEFORE the signer call. Never apply it to historical
      // PREPARED records, signer failures, or any post-sign validation failure.
      const reason = error instanceof ExecutionError && reasonCode(error.code) ? error.code : "PRE_SIGN_VALIDATION_FAILED";
      try {
        atomicJson(file, { ...record, stage: "ABORTED_UNSIGNED", signerInvoked: false, abortPhase: "PRE_SIGN_VALIDATION",
          abortedAt: new Date(now()).toISOString(), reason });
      } catch (_) { throw new ExecutionError("UNSIGNED_ABORT_PERSIST_FAILED"); }
      throw new ExecutionError(reason);
    }
    let signed;
    const endSign = timing.start("sign");
    try { signed = await signTransaction(transaction); } // Injected in tests; real key loader is CLI-only.
    finally { endSign(); }
    try {
      const signedHash = verifiedSignedHash(signed, expectedBinding, account, expectedChainId);
      requireThat(JSON.stringify(executionBinding(transaction)) === expectedBinding, "SIGNED_TRANSACTION_MISMATCH");
      record.txHash = signedHash;
    } catch (error) {
      // The signer WAS invoked. Keep PREPARED/null-hash as an indefinite manual
      // hold, not an unsigned abort or an automatically reconcilable wrong tx.
      record.signerInvoked = true; record.signedTransactionBinding = "REJECTED";
      record.reason = error instanceof ExecutionError && error.code === "SIGNED_TRANSACTION_MISMATCH" ? error.code : "SIGNED_TRANSACTION_INVALID";
      try { atomicJson(file, record); } catch (_) { throw new ExecutionError("SIGNED_BINDING_HOLD_PERSIST_FAILED"); }
      throw new ExecutionError(record.reason);
    }
    atomicJson(file, record); // Never persist signed bytes or key material.
    try {
      const endValidation = timing.start("finalValidation");
      try { checkCaps(await validate() || caps); } finally { endValidation(); }
      let sentHash;
      const endSend = timing.start("send");
      try { sentHash = await sendRawTransaction(signed); } finally { endSend(); }
      requireThat(hash(sentHash) && sentHash.toLowerCase() === record.txHash, "BROADCAST_HASH_MISMATCH");
      timing.point("sendAck");
      record.stage = "SENT"; atomicJson(file, record);
    } catch (_) {
      record.stage = "UNCERTAIN"; record.reason = "BROADCAST_OUTCOME_UNCERTAIN"; atomicJson(file, record);
      throw new ExecutionError("BROADCAST_OUTCOME_UNCERTAIN");
    }
    const deadline = now() + receiptWaitMs;
    const endReceipt = timing.start("receipt");
    try {
    do {
      let receipt; try { receipt = await receiptRpc(record.txHash, Math.max(1, Math.min(10000, deadline - now()))); } catch (_) { throw new ExecutionError("RECEIPT_RPC_FAILED"); }
      if (receipt !== null) { record = receiptSummary(record, receipt); atomicJson(file, record); return record; }
      if (now() >= deadline) break;
      await sleep(Math.min(2000, deadline - now()));
    } while (now() <= deadline);
    return record; // SENT remains an indefinite blocker, never expires automatically.
    } finally { endReceipt(); }
  });
  } finally { timing.flush(); }
}
function parseMode(argv, executeFlag) {
  const execute = argv.includes(executeFlag);
  const anyExecute = argv.includes("--execute") || argv.includes("--execute-if-liquidatable");
  requireThat(!(anyExecute && (argv.includes("--check") || argv.includes("--dry-run"))), "CONFLICTING_EXECUTION_FLAGS");
  requireThat(!anyExecute || execute, "UNSUPPORTED_EXECUTION_FLAG");
  requireThat(!(argv.includes("--include-aave-v4") && argv.includes("--skip-aave-v4")), "CONFLICTING_PARTITION_FLAGS");
  return { execute, writeOut: !argv.includes("--no-write") };
}
// Called only inside executeGuarded's locked signing callback, never on import/read-only paths.
async function signWithProcessKey(transaction, account = MAIN_ACCOUNT) {
  const { Wallet } = require("../node_modules/ethers");
  let text;
  try { text = fs.readFileSync(path.join(ROOT, ".env.exploit"), "utf8"); }
  catch (_) { throw new ExecutionError("KEY_UNAVAILABLE"); }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(?:export\s+)?[A-Za-z0-9_]+\s*=\s*["']?(0x[0-9a-fA-F]{64}|[0-9a-fA-F]{64})["']?\s*(?:#.*)?$/);
    if (!m) continue;
    let wallet;
    try { wallet = new Wallet(m[1].startsWith("0x") ? m[1] : "0x" + m[1]); } catch (_) { continue; }
    if (wallet.address.toLowerCase() === account) return wallet.signTransaction(transaction);
  }
  throw new ExecutionError("KEY_UNAVAILABLE");
}
module.exports = { MAIN_ACCOUNT, DEFAULT_LOCK_ROOT, DEFAULT_JOURNAL_DIR, ExecutionError, requireThat, safeError, uint, createTiming,
  atomicJson, acquireWalletLock, withWalletLock, readJournals, reconcilePending, reconcileWallet, receiptSummary, validateBatch,
  TIP_PROFIT_SHARE_BPS, buildFeePolicy, buildFees,
  validateTransaction, executeGuarded, parseMode, signWithProcessKey };
