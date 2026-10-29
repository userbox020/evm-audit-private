"use strict";

// Import-inert. Only the dedicated CLI's explicit --target1-v2 branch enters here.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { Interface, id, keccak256, accessListify } = require("../node_modules/ethers");
const guard = require("./wallet-execution-guard.js"), transport = require("./executor-pinned-rpc.js");
const proof = require("./rank1-aave-v4-proof.js"), next = require("./next-block-execution.js");
const { normalizeSimulationTransaction } = require("./next-block-simulation.js");
// These utilities carry transport/timing checks only, NOT M1 financial authority.
const { strictContext } = require("./m1-live-evidence.js");
const { createM1V2Budget } = require("../execute-top-whale-trigger.js");
const { TARGET, POLICY } = proof, { requireThat, uint, ExecutionError } = guard;
const ROOT = path.resolve(__dirname, "../.."), APPROVAL_PATH = "coordination/decisions/20261024-rank1-optimization-approval.json";
const BASE_PATH = "coordination/live-execution-batch-aave-v4-executor-deploy-20261019.json";
const APPROVAL_SHA = "47fdf20b558cd3d4a97e17d5e52b43b3f2ec6caab3e8eaeb80ea37c6c1d3d862";
const BASE_SHA = "56207f5850c5b2e6fae4f5b8138da2b6aaec52f134c8372dfc11a44276686c2f";
const GAS_APPROVAL_PATH = "coordination/decisions/20261024-rank1-competitive-gas-approval.json";
const GAS_APPROVAL_SHA = "98ab97214bd9ce7dfbd50ed7f5c0479f117221257cffcbdd9334b98ef75baee3";
const EVENT_ID = "rank1-aave-v4-usde-usdc-20261024-crossing";
// Separate from the legacy all-nine-plan status writer; never replace its view.
const STATUS_FILE = path.join(ROOT, "reports/raw/fast/rank1-aave-v4-v2-watch.json");
// Exactly the four outputs in the approved compiled ABI and source.
const HEALTH = new Interface(["function previewHealthFactor(address,address) view returns(uint256 healthFactor,bool isLiquidatable,uint256 totalCollateralValue,uint256 totalDebtValue)"]);
// Fixed decoder; never reread an unverified ABI after the source helper has
// checked the approved build bytes.
const EXEC = new Interface(["function execute((address spoke,uint256 collateralReserveId,uint256 debtReserveId,address borrower,address debtAsset,address collateralAsset,uint256 flashLoanAmount,uint256 debtToCover,uint256 minSwapOut,uint256 minProfit,uint256 deadline,uint8 venueType,address swapTarget,uint24 uniV3Fee,int128 curveIndexIn,int128 curveIndexOut,bytes customSwapData)) returns(uint256)"]);
const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const json = value => JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item);
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const safeCode = error => /^[A-Z][A-Z0-9_]{0,95}$/.test(guard.safeError(error)) ? guard.safeError(error) : "EXECUTION_FAILED";
const owners = new WeakMap(); // Only main can admit a same-lease continuation.

function loadAuthorization({ readFile = fs.readFileSync, now = Date.now } = {}) {
  function read() {
    try {
      const at = now(), raw = readFile(path.join(ROOT, APPROVAL_PATH)), baseRaw = readFile(path.join(ROOT, BASE_PATH)),
        gasRaw = readFile(path.join(ROOT, GAS_APPROVAL_PATH));
      const approval = JSON.parse(raw.toString("utf8")), base = JSON.parse(baseRaw.toString("utf8")), gas = JSON.parse(gasRaw.toString("utf8"));
      requireThat(Number.isSafeInteger(at) && approval.approved === true && approval.revoked === false &&
        base.approved === true && base.revoked !== true && gas.approved === true && gas.revoked === false &&
        Date.parse(approval.expiresAt) > at && Date.parse(base.expiresAt) > at && Date.parse(gas.expiresAt) > at,
      "RANK1_AUTHORIZATION_INVALID_OR_EXPIRED");
      // Exact reviewed public bytes bind every action, target, mode and ceiling.
      requireThat(sha(raw) === APPROVAL_SHA && sha(baseRaw) === BASE_SHA && sha(gasRaw) === GAS_APPROVAL_SHA, "RANK1_AUTHORIZATION_COMMITMENT_MISMATCH");
      requireThat(approval.schema === "rank1-aave-v4-optimization-approval/v1" && approval.decisionId === "rank1-aave-v4-optimization-20261024-01" &&
        approval.chainId === 1 && approval.chain === "ethereum" && approval.account === TARGET.owner && approval.expiresAt === POLICY.expiresAt &&
        approval.scope.targetId === "target1_AaveV4_USDe_USDC" && approval.scope.planId === TARGET.id && approval.scope.borrower === TARGET.borrower && approval.scope.spoke === TARGET.spoke &&
        approval.scope.executor === TARGET.executor && approval.scope.collateralReserveId === 3 && approval.scope.debtReserveId === 4 &&
        approval.scope.collateralAsset === TARGET.usde && approval.scope.debtAsset === TARGET.usdc &&
        approval.baseBatch.path === BASE_PATH && approval.baseBatch.sha256 === BASE_SHA && approval.baseBatch.batchId === base.batchId &&
        approval.caps.eventId === EVENT_ID && approval.caps.signedAttemptsForThisCrossingEvent === 1 && approval.caps.automaticEventReset === false &&
        approval.caps.valueWei === "0" && approval.caps.maxExecuteGasLimit === 1300000 &&
        approval.caps.maxFeePerGasWei === "250000000" && approval.caps.maxNativeSpendPerTransactionWei === "550000000000000" &&
        approval.caps.minProfitUsdcRaw === POLICY.minimumProfitUsdcRaw && approval.caps.maxFlashLoanUsdcRaw === "1008000000000" &&
        approval.caps.maxSlippageBps === 50 && approval.caps.maxVariantsPerContext === 3,
      "RANK1_AUTHORIZATION_SCOPE_MISMATCH");
      const caps = guard.validateBatch(base, { kind: "v4", now: at,
        requiredTargets: [TARGET.spoke, approval.scope.flashLender, approval.scope.router] });
      requireThat(caps.gasCap <= 1300000n && caps.feeCap <= 250000000n && caps.spendCap <= 550000000000000n &&
        caps.minProfitUsdc >= 100000000n, "RANK1_AUTHORIZATION_CAP_MISMATCH");
      // The source/deployment binding remains on the OLD caps. Only this exact
      // target's independently committed amendment can raise these two ceilings.
      requireThat(gas.schema === "rank1-aave-v4-gas-approval/v1" && gas.decisionId === "rank1-aave-v4-competitive-gas-20261024-01" &&
        gas.chainId === 1 && gas.chain === "ethereum" && gas.account === TARGET.owner && gas.expiresAt === approval.expiresAt &&
        gas.priorApproval.path === APPROVAL_PATH && gas.priorApproval.sha256 === APPROVAL_SHA && gas.priorApproval.decisionId === approval.decisionId &&
        json(gas.baseBatch) === json(approval.baseBatch) &&
        ["targetId", "planId", "borrower", "spoke", "executor", "collateralReserveId", "debtReserveId", "collateralAsset", "debtAsset", "actions", "modes"]
          .every(key => json(gas.scope[key]) === json(approval.scope[key])) && gas.scope.newTargets === false && gas.scope.deployment === false &&
        ["valueWei", "maxExecuteGasLimit", "minProfitUsdcRaw", "maxFlashLoanUsdcRaw", "maxSlippageBps", "maxVariantsPerContext",
          "signedAttemptsForThisCrossingEvent", "eventId", "automaticEventReset"].every(key => gas.caps[key] === approval.caps[key]) &&
        gas.caps.replacementTransactionsAllowed === false && gas.caps.strictConservativeNetGreaterThanZero === true &&
        gas.caps.maxFeePerGasWei === "1500000000" && gas.caps.maxNativeSpendPerTransactionWei === "1950000000000000" &&
        gas.caps.maxFeePerGasWei === POLICY.maxFeePerGasWeiCap && gas.caps.maxNativeSpendPerTransactionWei === POLICY.nativeSpendWeiCap &&
        gas.supersession.target1Only === true && json(gas.supersession.fields) === json(["maxFeePerGasWei", "maxNativeSpendPerTransactionWei"]) &&
        gas.supersession.priorMaxFeePerGasWei === approval.caps.maxFeePerGasWei &&
        gas.supersession.priorMaxNativeSpendPerTransactionWei === approval.caps.maxNativeSpendPerTransactionWei,
      "RANK1_GAS_AUTHORIZATION_SCOPE_MISMATCH");
      return freeze({ ...caps, feeCap: uint(gas.caps.maxFeePerGasWei), spendCap: uint(gas.caps.maxNativeSpendPerTransactionWei),
        maxFlashLoanUsdcRaw: uint(approval.caps.maxFlashLoanUsdcRaw), maxSlippageBps: 50,
        maxVariantsPerContext: 3, eventId: EVENT_ID });
    } catch (error) {
      if (error instanceof ExecutionError) throw error;
      throw new ExecutionError("RANK1_AUTHORIZATION_UNAVAILABLE");
    }
  }
  const caps = read(), binding = json(caps);
  return Object.freeze({ caps, assertCurrent() { requireThat(json(read()) === binding, "RANK1_AUTHORIZATION_CHANGED"); } });
}

function assertLive(lease, active, budget, now, context = active.nextBlock?.context || null) {
  strictContext(active, context, now());
  budget.assert(lease, active, context);
  strictContext(active, context, now());
}
async function focusedHealth({ lease, active, budget, authorization, now }) {
  const context = active.nextBlock?.context || null;
  const check = () => { authorization.assertCurrent(); assertLive(lease, active, budget, now, context); };
  const invoke = async fn => { check(); const result = await fn(); check(); return result; };
  check();
  const data = HEALTH.encodeFunctionData("previewHealthFactor", [TARGET.spoke, TARGET.borrower]);
  let raw;
  if (!context) raw = await invoke(() => active.call({ to: TARGET.executor, data }));
  else {
    const tx = { type: 2, chainId: 1, from: TARGET.owner, to: TARGET.executor, data, value: 0n, accessList: [],
      nonce: Number(uint(await invoke(() => active.nonce(TARGET.owner)))), ...guard.buildFeePolicy(authorization.caps.gasCap, active.pin.baseFeePerGas, authorization.caps) };
    raw = next.checkedSimulation(await invoke(() => active.nextBlock.simulate(tx)), tx, context).returnData;
  }
  let decoded;
  try {
    decoded = HEALTH.decodeFunctionResult("previewHealthFactor", raw);
    requireThat(HEALTH.encodeFunctionResult("previewHealthFactor", decoded).toLowerCase() === raw.toLowerCase(), "RANK1_HEALTH_ABI_INVALID");
  } catch (_) { throw new ExecutionError("RANK1_HEALTH_ABI_INVALID"); }
  requireThat(decoded[0] > 0n && decoded[1] === (decoded[0] < 10n ** 18n), "RANK1_HEALTH_INCONSISTENT");
  await invoke(() => context ? active.nextBlock.recheck() : active.recheck());
  return freeze({ id: TARGET.id, spoke: TARGET.spoke, borrower: TARGET.borrower, healthFactorRaw: decoded[0].toString(),
    bpsToLiquidation: ((Number(decoded[0]) / 1e18 - 1) * 10000).toFixed(3),
    isLiquidatableBothProviders: decoded[1], liquidatable: decoded[1], mode: context ? "NEXT_BLOCK_PASSIVE" : "CURRENT" });
}

async function drained(jobs) {
  const results = await Promise.allSettled(jobs.map(job => Promise.resolve().then(job)));
  const failed = results.find(result => result.status === "rejected"); if (failed) throw failed.reason;
  return results.map(result => result.value);
}
// One signature, concurrent identical bytes, primary hash authoritative. Every
// physical fetch re-enters the synchronous gate; both branches always drain.
async function sendIdentical({ active, signed, assertDispatch, secondaryRpc = transport.httpRpc }) {
  assertDispatch();
  const [primary, secondary] = await Promise.allSettled([
    Promise.resolve().then(() => { assertDispatch(); return active.send(signed, assertDispatch); }),
    Promise.resolve().then(() => { assertDispatch(); return secondaryRpc({ handle: "https://rpc.flashbots.net/fast" },
      "eth_sendRawTransaction", [signed], 3500, assertDispatch); }),
  ]);
  if (primary.status === "rejected") throw primary.reason;
  requireThat(/^0x[0-9a-f]{64}$/i.test(primary.value), "BROADCAST_HASH_MISMATCH");
  if (secondary.status === "fulfilled" && secondary.value != null)
    requireThat(typeof secondary.value === "string" && secondary.value.toLowerCase() === primary.value.toLowerCase(), "SECONDARY_BROADCAST_HASH_MISMATCH");
  assertDispatch(); return primary.value;
}
function assertInputPins(inputs, active, context) {
  for (const input of [inputs.runtime, inputs.feeds]) requireThat(input?.pin?.hash === active.pin.hash &&
    String(input.pin.number) === String(active.pin.number) && String(input.pin.timestamp) === String(active.pin.timestamp), "RANK1_PROOF_PIN_MISMATCH");
  requireThat(inputs.feeds.contextTimestamp === String(context?.timestamp ?? active.pin.timestamp), "RANK1_PROOF_CONTEXT_MISMATCH");
}
function assertEventAvailable(journalDir) {
  const records = guard.readJournals(journalDir, TARGET.owner, 1);
  requireThat(!records.some(({ record }) => record.stage !== "ABORTED_UNSIGNED" &&
    (record.intent?.rank1EventId === EVENT_ID || [TARGET.id, "target1_AaveV4_USDe_USDC"].includes(record.intent?.targetId))),
  "RANK1_EVENT_ALREADY_ATTEMPTED");
}
function journalSnapshot(journalDir) {
  return guard.readJournals(journalDir, TARGET.owner, 1).map(row => ({ ...row, bytes: fs.readFileSync(row.file, "utf8") }));
}
// Exactly one new file; every preexisting file must remain byte-for-byte intact.
function journalAddition(rows, before) {
  if (rows.length !== before.length + 1 || before.some(old => !rows.some(row => row.file === old.file && json(row) === json(old)))) return null;
  return rows.find(row => !before.some(old => old.file === row.file));
}

async function executeCandidate({ lease, active, observation, budget, authorization, now, readFile,
  prepareRank1 = options => require("./rank1-aave-v4-settlement.js").prepareRank1(options),
  signTransaction = guard.signWithProcessKey, secondaryRpc = transport.httpRpc, executionOptions = {}, continuationOwner }) {
  const context = active.nextBlock?.context || null;
  const phase = owners.get(continuationOwner);
  // Private main-owned evidence, never supplied by preparation or status data.
  const attempt = phase ? (phase.attempt = { id: crypto.randomUUID(), startedAt: now(), validations: 0, prepareEntered: false }) : null;
  let prepared, inputs, binding, proofBinding, currentTraceFailure, signedAttempt = false;
  const intent = { targetId: TARGET.id, rank1EventId: EVENT_ID, to: TARGET.executor, profitToken: TARGET.usdc,
    ...(attempt ? { rank1AttemptId: attempt.id } : {}),
    executionMode: observation.mode, pinHash: active.pin.hash,
    ...(context ? { nextBlockReplayKey: id(EVENT_ID + ":" + context.parentHash), nextBlockContext: context } : {}) };
  const checkedPrepared = () => {
    requireThat(prepared && Object.isFrozen(prepared) && Object.isFrozen(prepared.transaction) && Object.isFrozen(prepared.proof), "RANK1_IMMUTABLE_PREPARATION_REQUIRED");
    assertInputPins(inputs, active, context);
    requireThat(json(normalizeSimulationTransaction(prepared.transaction)) === binding && json(prepared.proof) === proofBinding, "RANK1_PREPARATION_CHANGED");
    const tx = prepared.transaction; guard.validateTransaction(tx, authorization.caps, 1);
    const settlement = prepared.proof;
    requireThat(settlement.schema === "rank1-settlement-proof/v1" && settlement.settlementVerified === true &&
      settlement.targetId === TARGET.id && settlement.mode === observation.mode &&
      settlement.parent?.hash === active.pin.hash && String(settlement.parent.number) === String(active.pin.number) &&
      String(settlement.parent.timestamp) === String(active.pin.timestamp) &&
      json(settlement.transaction) === binding &&
      (context ? next.matchesContext(settlement.context, context) : settlement.context === null), "RANK1_SETTLEMENT_BINDING_MISMATCH");
    requireThat(tx.from?.toLowerCase() === TARGET.owner && tx.to.toLowerCase() === TARGET.executor, "RANK1_TRANSACTION_SCOPE_MISMATCH");
    const decoded = EXEC.decodeFunctionData("execute", tx.data), plan = decoded[0];
    requireThat(EXEC.encodeFunctionData("execute", decoded).toLowerCase() === tx.data.toLowerCase() &&
      plan.spoke.toLowerCase() === TARGET.spoke && plan.borrower.toLowerCase() === TARGET.borrower &&
      plan.collateralReserveId === 3n && plan.debtReserveId === 4n && plan.collateralAsset.toLowerCase() === TARGET.usde &&
      plan.debtAsset.toLowerCase() === TARGET.usdc && plan.flashLoanAmount > 0n && plan.flashLoanAmount <= authorization.caps.maxFlashLoanUsdcRaw &&
      plan.minProfit >= authorization.caps.minProfitUsdc && plan.minSwapOut > 0n && plan.venueType === 0n && plan.uniV3Fee === 100n &&
      plan.swapTarget === "0x0000000000000000000000000000000000000000" && plan.customSwapData === "0x" &&
      plan.deadline > BigInt(Math.floor(now() / 1000)) && (!context || plan.deadline >= BigInt(context.timestamp)), "RANK1_TRANSACTION_SCOPE_MISMATCH");
    const economics = proof.valueRank1Profit({ profitUsdcRaw: plan.minProfit, fees: tx, feeds: inputs.feeds });
    requireThat(json(settlement.economics) === json(economics) &&
      uint(prepared.conservativeProfitBeforeGasWei) === uint(economics.conservativeProfitBeforeGasWei), "RANK1_PROFIT_FLOOR_MISMATCH");
    return economics;
  };
  const boundary = dispatch => {
    strictContext(active, context, now()); authorization.assertCurrent(); checkedPrepared();
    // Clock/read hooks cannot leave authorization or live facade trust unchecked.
    authorization.assertCurrent(); checkedPrepared(); strictContext(active, context, now());
    // Acceptance follows ALL unsigned proof/revalidation work, never precedes
    // the final file reads/decoding. It is single-use and cannot reset detection.
    if (dispatch) budget.assertDispatch(lease, active, context); else budget.acceptUnsigned(lease, active, context);
    strictContext(active, context, now()); budget.assertDispatch(lease, active, context);
  };
  const validate = async () => {
    if (phase && !phase.signerEntered) phase.phase = "VALIDATING";
    if (attempt) attempt.validations++;
    try {
      if (attempt?.validations === 2 && !phase.signerEntered) {
        // The shared guard has now persisted PREPARED, but has not entered its
        // signer. Bind its exact file/action before any second-validation work.
        const row = journalAddition(journalSnapshot(executionOptions.journalDir), phase.journalFence);
        const fileTime = row && /^execution-(\d+)-[0-9a-f-]{36}\.json$/.exec(path.basename(row.file));
        const at = now(), executedAt = Date.parse(row?.record.executedAt);
        requireThat(row && fileTime && Number(fileTime[1]) >= attempt.startedAt && Number(fileTime[1]) <= executedAt && executedAt <= at &&
          json(row.record) === json({ schema: "wallet-execution-journal/v1", stage: "PREPARED", chainId: 1, owner: TARGET.owner,
            executedAt: row.record.executedAt, intent: attempt.intent, txHash: null, actualTokenGainRaw: null, realizedNetProfit: "UNKNOWN" }),
        "RANK1_ATTEMPT_JOURNAL_MISMATCH");
        attempt.preparedJournal = row;
      }
      authorization.assertCurrent(); assertLive(lease, active, budget, now, context);
      const [, nonce] = await drained([() => invoke(() => context ? active.nextBlock.recheck() : active.recheck()), () => invoke(() => active.nonce(TARGET.owner))]);
      requireThat(uint(nonce) === uint(prepared.transaction.nonce), "RANK1_NONCE_CHANGED");
      authorization.assertCurrent(); checkedPrepared(); assertLive(lease, active, budget, now, context);
      return authorization.caps;
    } catch (error) {
      if (attempt?.validations === 2 && !phase.signerEntered) attempt.validationFailure = error;
      throw error;
    }
  };
  // Shared failure latch stops either proof helper from starting more IO after
  // its sibling fails; drained() waits for all requests already in flight.
  let fatal;
  const check = () => { if (fatal) throw fatal; authorization.assertCurrent(); assertLive(lease, active, budget, now, context); };
  const invoke = async work => {
    try { check(); const result = await work(); check(); return result; }
    catch (error) { fatal ||= error; throw fatal; }
  };
  const proofFacade = Object.freeze({ ...active, assertUsable: check,
    call: tx => invoke(() => active.call(tx)), code: address => invoke(() => active.code(address)) });
  let execution;
  if (phase) phase.phase = "LOCK_ACQUIRING";
  try { execution = await guard.executeGuarded({ ...executionOptions, account: TARGET.owner, expectedChainId: 1, now, intent,
    prepare: async () => {
      if (phase) { phase.phase = "PREPARING"; attempt.prepareEntered = true; }
      // Already under the shared wallet lock, after pending reconciliation. No
      // timestamp, parent change or restart resets this crossing event.
      assertEventAvailable(executionOptions.journalDir);
      authorization.assertCurrent(); assertLive(lease, active, budget, now, context);
      const sourceProof = proof.loadRank1SourceProof({ readFile });
      let runtime, feeds, feedStale;
      try { [runtime, feeds] = await drained([
        () => invoke(() => proof.verifyRank1Runtime(proofFacade, { sourceProof })),
        async () => {
          check();
          let value;
          try { value = await proof.readRank1Feeds(proofFacade, { contextTimestamp: context?.timestamp ?? active.pin.timestamp }); }
          catch (error) {
            // Only a semantic age failure from this top-level helper is soft.
            // Raw IO/auth/trust/budget failures already latched by invoke stay hard.
            if (!fatal && error instanceof ExecutionError && error.code === "RANK1_FEED_STALE") { feedStale = error; throw error; }
            fatal ||= error; throw fatal;
          }
          check(); return value;
        },
      ]); } catch (error) {
        // Both helpers have drained. A late runtime/raw failure always wins;
        // feed-helper internal hard-over-stale precedence is also required.
        if (fatal) throw fatal;
        if (error === feedStale) { check(); if (attempt) attempt.feedStale = error; }
        throw error;
      }
      inputs = freeze({ runtime, feeds }); assertInputPins(inputs, active, context);
      authorization.assertCurrent(); assertLive(lease, active, budget, now, context);
      try {
        prepared = await invoke(() => prepareRank1({ lease, active, observation, proofInputs: inputs, authorization, budget, now }));
        if (attempt) attempt.preparationCompleted = true;
      }
      catch (error) {
        // Only a settlement-preparation failure may fall through to FUTURE.
        // Never interpret a signer/send/reconciliation error as unsigned HOLD.
        if (!context && error instanceof ExecutionError && error.code === "RANK1_CURRENT_TRACE_UNAVAILABLE") currentTraceFailure = error;
        throw error;
      }
      binding = json(normalizeSimulationTransaction(prepared.transaction)); proofBinding = json(prepared.proof);
      checkedPrepared(); authorization.assertCurrent(); assertLive(lease, active, budget, now, context);
      intent.conservativeProfitBeforeGasWei = uint(prepared.conservativeProfitBeforeGasWei).toString();
      if (attempt) attempt.intent = JSON.parse(json({ ...intent, calldataHash: keccak256(prepared.transaction.data),
        nonce: prepared.transaction.nonce, valueWei: "0", gasLimit: prepared.transaction.gasLimit.toString(),
        maxFeePerGasWei: prepared.transaction.maxFeePerGas.toString(), maxPriorityFeePerGasWei: prepared.transaction.maxPriorityFeePerGas.toString(),
        accessList: accessListify(prepared.transaction.accessList ?? []).map(row => ({ address: row.address.toLowerCase(),
          storageKeys: row.storageKeys.map(key => key.toLowerCase()) })) }));
      return prepared;
    }, validate,
    signTransaction: tx => {
      if (phase) phase.phase = "SIGNER_BOUNDARY";
      boundary(false); if (!context) lease.cancelFuture(); signedAttempt = true;
      if (phase) { phase.signerEntered = true; phase.phase = "SIGNING"; }
      return signTransaction(tx);
    },
    sendRawTransaction: signed => {
      if (phase) { phase.outcomePossible = true; phase.phase = "SENDING"; }
      return sendIdentical({ active, signed, assertDispatch: () => boundary(true), secondaryRpc });
    },
    receiptRpc: (hash, timeout) => {
      if (phase) { phase.outcomePossible = true; phase.phase = "RECONCILING"; }
      return active.receipt(hash, timeout);
    },
  }); } catch (error) {
    // executeGuarded has released the lock; prepare threw before journal/signing.
    // The local failure latch belongs to this attempt, not the original lease.
    if (error === currentTraceFailure && !prepared && !signedAttempt) return { currentHold: "RANK1_CURRENT_TRACE_UNAVAILABLE" };
    throw error;
  }
  if (phase) { phase.outcomePossible = true; phase.phase = "COMPLETE"; }
  return { execution, signedAttempt };
}

async function runPass(options) {
  const { lease, budget, authorization, now: wallNow = Date.now, execute = false, continuationOwner } = options;
  const record = owners.get(continuationOwner);
  const now = () => { record?.assertObservationDeadline?.(); return wallNow(); };
  if (record) record.phase = "OBSERVING";
  let currentHold = null;
  const summary = (mode, observation, extra = {}) => ({ ok: true, armed: false, mode, checkedAt: new Date(now()).toISOString(),
    owner: TARGET.owner, deployedExecutor: TARGET.executor, collectionScope: "RANK1_ONLY", partition: "DEDICATED_V4_RANK1_V2", partial: true,
    pin: lease.current.pin, targets: observation ? [observation] : [], candidateCount: observation?.liquidatable ? 1 : 0, firedCount: extra.signedAttempt ? 1 : 0,
    budget: budget.snapshot(), realizedNetProfit: "UNKNOWN", ...(currentHold ? { currentHold } : {}), ...extra });
  async function attempt(active) {
    const observation = await focusedHealth({ lease, active, budget, authorization, now });
    if (!execute) return summary("CHECK_ONLY", observation);
    if (!observation.liquidatable) return summary("STANDBY", observation, { reason: "NO_CURRENT_PROPOSAL" });
    const result = await executeCandidate({ ...options, active, observation, now });
    return summary("ATTEMPTED", observation, result);
  }
  const currentObservation = await focusedHealth({ lease, active: lease.current, budget, authorization, now });
  if (!execute) { lease.cancelFuture(); return summary("CHECK_ONLY", currentObservation); }
  if (currentObservation.liquidatable) {
    // The optional trace facet is on the LEASE, not lease.current. An unsupported
    // trace holds only CURRENT; contradictions still abort and drain the lease.
    try {
      assertLive(lease, lease.current, budget, now); authorization.assertCurrent();
      requireThat(typeof lease.qualifyCurrentTrace === "function", "TRACE_CAPABILITY_UNAVAILABLE");
      await lease.qualifyCurrentTrace();
      assertLive(lease, lease.current, budget, now); authorization.assertCurrent();
    } catch (error) {
      if (error.code !== "TRACE_CAPABILITY_UNAVAILABLE") throw error;
      assertLive(lease, lease.current, budget, now); authorization.assertCurrent();
      currentHold = "TRACE_CAPABILITY_UNAVAILABLE";
    }
    if (!currentHold) {
      const result = await executeCandidate({ ...options, active: lease.current, observation: currentObservation, now });
      if (!result.currentHold) return summary("ATTEMPTED", currentObservation, result);
      currentHold = result.currentHold;
    }
  }
  const take = async () => {
    assertLive(lease, lease.current, budget, now, null); authorization.assertCurrent();
    const active = lease.takeFuture();
    if (!active) return summary("STANDBY", currentObservation, { reason: "FUTURE_NOT_READY" });
    return attempt(active);
  };
  if (lease.isFutureReady?.() === true) return take();
  if (record?.allowContinuation && record.lease === lease && record.budget === budget && !record.used) record.resume = take;
  else lease.cancelFuture();
  return summary(currentHold ? "HOLD" : "STANDBY", currentObservation, { reason: currentHold || "NO_CURRENT_PROPOSAL" });
}

// One bounded idle waiter; notifications only wake it and never admit a proof.
// Kept local: the only imported M1 runner export is its reviewed budget.
function createHeadWakeLatch({ isReady }) {
  let waiter = null, closed = false, generation = 0, consumed = 0;
  return { signal() { waiter?.(); }, head() { generation++; waiter?.(); },
    takeHead() { if (generation === consumed) return false; consumed = generation; return true; },
    close() { closed = true; waiter?.(); },
    async wait(ms, sleep = delay => new Promise(resolve => setTimeout(resolve, delay))) {
      if (closed || isReady()) return;
      let timer;
      const wake = new Promise(resolve => { waiter = resolve; });
      try {
        if (arguments.length > 1 && sleep) await Promise.race([wake, sleep(ms)]);
        else await Promise.race([wake, new Promise(resolve => { timer = setTimeout(resolve, ms); })]);
      } finally { clearTimeout(timer); waiter = null; }
    } };
}
async function waitForNewHead(pin, { absoluteDeadline, now, sleep, wake, futureReady = () => false, liveHeadNumber, advisoryHead = false, isStopped = () => false }) {
  while (!isStopped() && now() < absoluteDeadline) {
    if (advisoryHead && wake.takeHead()) return "ADVISORY_HEAD";
    if (futureReady()) return "FUTURE_READY";
    if (liveHeadNumber && await liveHeadNumber() !== pin.number) return "HEAD_CHANGED";
    if (futureReady()) return "FUTURE_READY";
    const remaining = absoluteDeadline - now(); if (remaining <= 0) break;
    await wake.wait(Math.min(250, remaining), sleep);
  }
  return "DEADLINE";
}

async function main(argv, dependencies = {}) {
  requireThat(argv.includes("--target1-v2"), "RANK1_EXPLICIT_MODE_REQUIRED");
  const { execute, writeOut } = guard.parseMode(argv, "--execute-if-liquidatable"), loop = execute && argv.includes("--loop");
  const now = dependencies.wallNow || Date.now, mono = dependencies.monotonicNow || (() => performance.now());
  const readFile = dependencies.readFile || fs.readFileSync, loadCandidates = dependencies.loadCandidates || transport.loadRpcCandidates;
  const output = dependencies.output || (value => console.log(json(value))), statusFile = dependencies.statusFile || STATUS_FILE;
  const interval = Math.max(6000, Number(argv.find(arg => arg.startsWith("--interval-ms="))?.split("=")[1]) || 12000);
  const maxRuns = dependencies.maxRuns ?? (loop || !execute ? Infinity : 1), rawRpc = dependencies.rpc || transport.httpRpc;
  const configuration = Object.freeze({}), pending = new Set();
  const resolveOrigin = dependencies.resolveOrigin || require("../shared-rpc.js").getOrigin;
  const getCapabilityContext = dependencies.getCapabilityContext || (() => {
    // Tracking does not weaken httpRpc's process-only resolver/fetch identity.
    requireThat(require("../shared-rpc.js").getOrigin === resolveOrigin, "M1_CAPABILITY_CONTEXT_CHANGED");
    return { rpc: rawRpc, fetch: globalThis.fetch, configuration, inventoryRevision: 0 };
  });
  const rpc = (...args) => {
    const work = Promise.resolve().then(() => rawRpc(...args)); pending.add(work);
    work.then(() => pending.delete(work), () => pending.delete(work)); return work;
  };
  const drain = async () => {
    do { await Promise.allSettled([...pending]); await new Promise(resolve => setImmediate(resolve)); } while (pending.size);
  };
  const createFactory = () => (dependencies.createFactory || transport.createM1HotPathFactory)({ rpc, now, monotonic: mono,
    qualificationMode: "capability-v1", rank1AcquisitionRecovery: true, selectionPolicy: "rank1-prefer-dual", allowFuture: execute, resolveOrigin, getCapabilityContext });
  let factory, lease, owner, unsubscribe, advisory, last, stopped = false, fatal = false, requireFreshAfter = null, clock, nextAcquireAt = 0;
  let acquisitionFailures = 0;
  const isStopped = () => stopped || dependencies.signal?.aborted === true;
  const sample = () => {
    const wall = now(), tick = mono();
    requireThat(Number.isSafeInteger(wall) && wall >= 0 && Number.isFinite(tick) && tick >= 0 &&
      (!clock || wall >= clock.wall && tick >= clock.tick && Math.abs((wall - clock.wall) - (tick - clock.tick)) <= 2), "RANK1_SCHEDULER_CLOCK_INVALID");
    clock = { wall, tick }; return clock;
  };
  // Check is an observation, not an unattended loop: warmup + any fresh-head
  // retry have one absolute 20s deadline. Execute cold qualification allows 30s.
  const started = sample(), checkDeadline = started.tick + 20000;
  const wake = createHeadWakeLatch({ isReady: () => lease?.isFutureReady?.() === true });
  const publish = (value, scheduled = false, terminal = false) => {
    let stamp = clock.wall;
    try { const wall = now(); if (Number.isSafeInteger(wall) && wall >= stamp) stamp = wall; } catch (_) {}
    // No observers run in the proof-to-sign window. Published observations or
    // completed/held attempts are NOT a currently admissible execution proof.
    last = { ...value, checkedAt: new Date(stamp).toISOString(), targetId: "target1_AaveV4_USDe_USDC", collectionScope: "RANK1_ONLY",
      borrower: TARGET.borrower, spoke: TARGET.spoke, owner: TARGET.owner, deployedExecutor: TARGET.executor,
      scheduled: Boolean(scheduled && loop && !stopped), terminal, executionReady: false, proofReady: false, armed: false };
    if (writeOut) guard.atomicJson(statusFile, last); output(last);
  };
  const hold = error => ({ ok: false, mode: "HOLD", partial: true, targets: [],
    reason: safeCode(error), realizedNetProfit: "UNKNOWN" });
  const release = () => { unsubscribe?.(); unsubscribe = null; if (owner) owners.delete(owner); owner = null; lease?.cancelFuture(); lease = null; };
  const stop = () => { stopped = true; wake.signal(); };
  const journals = () => journalSnapshot(dependencies.executionOptions?.journalDir);
  const lockSnapshot = () => {
    const directory = path.join(dependencies.executionOptions?.lockRoot || guard.DEFAULT_LOCK_ROOT, `chain-1-${TARGET.owner}`);
    if (!fs.existsSync(directory)) return null;
    const file = path.join(directory, "owner.json"), dirStat = fs.lstatSync(directory), fileStat = fs.lstatSync(file);
    requireThat(dirStat.isDirectory() && !dirStat.isSymbolicLink() && fileStat.isFile() && !fileStat.isSymbolicLink(), "RANK1_RPC_RECOVERY_LOCK_INVALID");
    return fs.readFileSync(file, "utf8"); // Comparison only; never publish lock ownership bytes.
  };
  const retireAcquisition = async (error, record) => {
    const failed = record?.failedAcquisition;
    const fence = () => {
      requireThat(record && owners.get(owner) === record && record.failedAcquisition === failed && failed?.error === error &&
        factory === failed.factory && record.phase === "ACQUIRING" && !lease && !record.lease && !record.attempt &&
        !record.signerEntered && !record.outcomePossible, "RANK1_RPC_RECOVERY_PHASE_INVALID");
      requireThat(!isStopped(), "RANK1_STOP_REQUESTED");
      record.authorization.assertCurrent(); sample();
      const rows = journals();
      requireThat(json(rows) === json(failed.journalFence) && !rows.some(({ record: r }) => ["PREPARED", "SENT", "UNCERTAIN"].includes(r.stage)),
        "RANK1_RPC_RECOVERY_JOURNAL_CHANGED");
      assertEventAvailable(dependencies.executionOptions?.journalDir);
      requireThat(lockSnapshot() === failed.lockFence, "RANK1_RPC_RECOVERY_LOCK_CHANGED");
    };
    fence();
    // Only the factory can prove an issued transient, seal certificates and
    // drain its unpublished acquisition, including late semantic/auxiliary work.
    const retired = await failed.factory.retireFailedAcquisition(error);
    await drain(); fence();
    requireThat(retired === true, "RANK1_RPC_RECOVERY_REJECTED");
    factory = null; // Never release this reference on a rejected/nontrue retirement.
    const delay = Math.min(12000, 1000 * 2 ** acquisitionFailures);
    acquisitionFailures = Math.min(4, acquisitionFailures + 1);
    nextAcquireAt = Math.max(nextAcquireAt, clock.tick + delay);
  };
  // Only main mints this record. Helpers, injected signers and status consumers
  // never receive it; error codes alone cannot manufacture retry permission.
  const unsignedTransient = (error, record) => {
    if (!record || owners.get(owner) !== record || record.signerEntered || record.outcomePossible ||
      !["WARMING", "ACQUIRING", "OBSERVING", "LOCK_ACQUIRING", "PREPARING", "VALIDATING", "WAITING"].includes(record.phase)) return false;
    if (!(error instanceof ExecutionError) || !["M1_V2_UNSIGNED_BUDGET_EXCEEDED", "M1_V2_CHILD_HEADROOM_INSUFFICIENT",
      "NEXT_BLOCK_DEADLINE", "NEXT_BLOCK_HEAD_ADVANCED", "RANK1_WAITING_FRESH_HEAD", "M1_HOT_PATH_SELECTION_HOLD",
      "RANK1_STARTUP_QUALIFICATION_HOLD", "WALLET_LOCK_HELD", "RANK1_FEED_STALE"].includes(error.code)) return false;
    record.authorization.assertCurrent(); sample();
    if (execute) {
      const rows = journals();
      if (rows.some(({ record: r }) => ["PREPARED", "SENT", "UNCERTAIN"].includes(r.stage))) return false;
      if (json(rows) !== json(record.journalFence) || record.attempt?.preparedJournal) {
        const attempt = record.attempt, added = journalAddition(rows, record.journalFence);
        if (record.phase !== "VALIDATING" || attempt?.validations !== 2 || !attempt.preparedJournal ||
          !(attempt.validationFailure instanceof ExecutionError) || attempt.validationFailure.code !== error.code ||
          !["M1_V2_UNSIGNED_BUDGET_EXCEEDED", "M1_V2_CHILD_HEADROOM_INSUFFICIENT", "NEXT_BLOCK_DEADLINE", "NEXT_BLOCK_HEAD_ADVANCED"].includes(error.code) ||
          !added || added.file !== attempt.preparedJournal.file || Date.parse(added.record.abortedAt) < Date.parse(attempt.preparedJournal.record.executedAt) ||
          Date.parse(added.record.abortedAt) > clock.wall || json(added.record) !== json({ ...attempt.preparedJournal.record,
            stage: "ABORTED_UNSIGNED", signerInvoked: false, abortPhase: "PRE_SIGN_VALIDATION", abortedAt: added.record.abortedAt, reason: error.code })) return false;
      }
      assertEventAvailable(dependencies.executionOptions?.journalDir);
    }
    lease?.current.assertUsable(); // Recheck AFTER draining late witness failures.
    const elapsed = record.budget ? Math.max(clock.wall - record.budget.snapshot().detectionWallMs,
      clock.tick - record.budget.snapshot().detectionMonoMs) : 0;
    const headroom = lease ? (lease.current.pin.timestamp + 12) * 1000 - clock.wall : Infinity;
    switch (error.code) {
      case "M1_V2_UNSIGNED_BUDGET_EXCEEDED": return elapsed > 6000;
      case "M1_V2_CHILD_HEADROOM_INSUFFICIENT": return headroom < 2000;
      case "NEXT_BLOCK_DEADLINE": return headroom <= 0;
      case "NEXT_BLOCK_HEAD_ADVANCED": return Boolean(lease);
      case "RANK1_WAITING_FRESH_HEAD": return Boolean(requireFreshAfter && lease);
      case "M1_HOT_PATH_SELECTION_HOLD": return record.phase === "ACQUIRING" && !lease;
      case "RANK1_STARTUP_QUALIFICATION_HOLD": return record.phase === "WARMING" && !lease;
      case "WALLET_LOCK_HELD": return record.phase === "LOCK_ACQUIRING" && record.attempt?.prepareEntered === false && record.attempt.validations === 0 && Boolean(lease);
      case "RANK1_FEED_STALE": return record.phase === "PREPARING" && record.attempt?.feedStale === error &&
        record.attempt.prepareEntered === true && record.attempt.validations === 0 && !record.attempt.preparationCompleted && Boolean(lease);
      default: return false;
    }
  };
  const warm = async candidates => {
    const deadline = Math.min(sample().tick + 30000, execute ? Infinity : checkDeadline);
    while (!stopped) {
      const status = factory.maintain({ candidates });
      if (status.selection === "READY") return;
      const remaining = deadline - sample().tick;
      requireThat(remaining > 0, "RANK1_STARTUP_QUALIFICATION_HOLD");
      await wake.wait(Math.min(25, remaining), dependencies.sleep);
    }
    throw new ExecutionError("RANK1_STOP_REQUESTED");
  };
  dependencies.signal?.addEventListener("abort", stop, { once: true });
  try {
    if (argv.includes("--target1-ws-heads")) {
      // Offline callers must inject the complete head connector, never fall into
      // live inventory loading behind a test transport override.
      requireThat(!dependencies.rpc || typeof dependencies.headConnect === "function", "RANK1_WS_INJECTION_REQUIRED");
      try {
        const connect = dependencies.headConnect || require("./m1-head-connector.js").createM1HeadConnector({
          loadHeadCandidates: () => require("../shared-rpc.js").loadHeadCandidates({ maxCandidates: 32 }),
          WebSocketImpl: require("../node_modules/ws"), fetchImpl: globalThis.fetch });
        advisory = (dependencies.createAdvisoryHeadWakeup || require("./advisory-head-wakeup.js").createAdvisoryHeadWakeup)({
          connect, onWake: () => wake.head(), now, monotonic: mono });
        Promise.resolve().then(() => advisory.start()).catch(() => {});
      } catch (_) { /* Advisory only; HTTP proof still owns every decision. */ }
    }
    for (let run = 0; run < maxRuns && !stopped && !dependencies.signal?.aborted; run++) {
      let record, budget, pin, retry = false, rpcRecovery = false;
      try {
        const authorization = loadAuthorization({ readFile, now });
        owner = Object.freeze({});
        record = { phase: "WARMING", authorization, signerEntered: false, outcomePossible: false,
          journalFence: execute ? journals() : null, resume: null, used: false, allowContinuation: loop,
          assertObservationDeadline: execute ? null : () => requireThat(sample().tick < checkDeadline, "RANK1_CHECK_DEADLINE") };
        owners.set(owner, record);
        // Coalesce hints while in flight or throttled. No hint/header is proof;
        // at most one acquisition starts per second, with detection AFTER idle.
        await waitForNewHead(null, { absoluteDeadline: Math.min(nextAcquireAt, execute ? Infinity : checkDeadline), now: mono, sleep: dependencies.sleep, wake, isStopped });
        if (stopped || dependencies.signal?.aborted) break;
        if (!execute) requireThat(sample().tick < checkDeadline, "RANK1_CHECK_DEADLINE");
        const candidates = loadCandidates();
        if (!factory) { factory = createFactory(); await warm(candidates); }
        else factory.maintain({ candidates }); // Unchanged background renewal; hot acquire never waits/rescues.
        authorization.assertCurrent(); sample();
        if (!execute) requireThat(clock.tick < checkDeadline, "RANK1_CHECK_DEADLINE");
        record.phase = "ACQUIRING";
        wake.takeHead(); nextAcquireAt = clock.tick + 1000;
        const acquiringFactory = factory, acquisitionJournal = execute ? record.journalFence : journals(), acquisitionLock = lockSnapshot();
        budget = record.budget = createM1V2Budget({ wallNow: now, monotonicNow: mono });
        try { lease = record.lease = await acquiringFactory.acquire({ candidates }); }
        catch (error) {
          // Main-only provenance: never manufacture eligibility from error.code
          // or let a post-acquisition/prepare/signing lookalike reach retirement.
          record.failedAcquisition = Object.freeze({ error, factory: acquiringFactory, journalFence: acquisitionJournal, lockFence: acquisitionLock });
          throw error;
        }
        pin = lease.current.pin; acquisitionFailures = 0;
        if (requireFreshAfter && pin.number <= requireFreshAfter.number) {
          requireThat(pin.number === requireFreshAfter.number && pin.hash === requireFreshAfter.hash, "RANK1_FRESH_HEAD_CONTRADICTION");
          throw new ExecutionError("RANK1_WAITING_FRESH_HEAD");
        }
        requireFreshAfter = null; budget.bind(lease);
        if (loop && execute) {
          unsubscribe = lease.onFutureReady(() => wake.signal());
        }
        const result = await runPass({ lease, budget, authorization, now, readFile, execute, continuationOwner: owner,
          prepareRank1: dependencies.prepareRank1, signTransaction: dependencies.signTransaction,
          secondaryRpc: dependencies.secondaryRpc, executionOptions: dependencies.executionOptions });
        if (record.signerEntered || record.outcomePossible) stopped = true;
        publish(result, !stopped && (run + 1 < maxRuns || Boolean(record.resume)));
        if (record?.resume && !stopped) {
          record.phase = "WAITING";
          const start = budget.snapshot(), remaining = Math.min(6000 - (now() - start.detectionWallMs), (pin.timestamp + 12) * 1000 - now() - 2000);
          const futureDeadline = mono() + Math.max(0, remaining);
          const readiness = await waitForNewHead(pin, { absoluteDeadline: futureDeadline, now: mono, sleep: dependencies.sleep, wake, isStopped,
            liveHeadNumber: lease.current.liveHeadNumber ? async () => {
              assertLive(lease, lease.current, budget, now);
              const head = await lease.current.liveHeadNumber();
              assertLive(lease, lease.current, budget, now); return head;
            } : undefined, futureReady: () => !stopped && lease.isFutureReady() });
          if (readiness === "FUTURE_READY" && mono() < futureDeadline && !stopped && owners.get(owner) === record && !record.used) {
            record.used = true; const resume = record.resume; record.resume = null; unsubscribe?.(); unsubscribe = null;
            record.phase = "OBSERVING";
            const continued = await resume();
            if (record.signerEntered || record.outcomePossible) stopped = true;
            publish(continued, !stopped && run + 1 < maxRuns);
          }
        }
      } catch (caught) {
        let error = caught;
        if (record) record.resume = null;
        // No lease exists in cold qualification: stop pool scheduling at its
        // deadline before draining, rather than waiting for a whole pool sweep.
        if (record?.phase === "WARMING" && !lease) { await factory?.close(); factory = null; }
        lease?.cancelFuture();
        try {
          // A missing-certificate HOLD has no issued acquisition to retire and
          // retains its existing fail-fast/background-maintenance behavior.
          const selectionHold = error instanceof ExecutionError && error.code === "M1_HOT_PATH_SELECTION_HOLD";
          if (record?.failedAcquisition?.error === error && !selectionHold && typeof factory?.retireFailedAcquisition === "function") {
            await retireAcquisition(error, record); retry = rpcRecovery = true;
            error = new ExecutionError("RANK1_RPC_RECOVERY_HOLD");
          } else { await drain(); retry = unsignedTransient(error, record); }
        } catch (failure) {
          // Terminal fencing/retirement failures still seal and drain the factory;
          // no fallback to a code-based retry, and no new factory is admitted.
          await Promise.allSettled([Promise.resolve().then(() => factory?.close())]); await drain();
          error = failure; retry = false;
        }
        // Retire the expired lease only after started work has drained and late
        // contradictions have been checked. Never rebind/reset its old budget.
        if (retry) {
          requireFreshAfter = pin || requireFreshAfter;
          // Retire only the lease; keep the pool/certificate lifecycle under
          // maintain/acquire. Missing certificates remain fail-fast HOLDs.
        } else {
          stopped = true;
          const checkExpired = !execute && error instanceof ExecutionError && error.code === "RANK1_CHECK_DEADLINE" && clock.tick >= checkDeadline;
          fatal = !dependencies.signal?.aborted && !checkExpired;
        }
        publish({ ...hold(error), ...(budget ? { budget: budget.snapshot() } : {}) }, retry && run + 1 < maxRuns);
      } finally { release(); }
      if (stopped || run + 1 >= maxRuns || !loop && (!retry || execute)) break;
      const poll = retry && last?.reason === "NEXT_BLOCK_HEAD_ADVANCED" ? 250 :
        retry && pin ? Math.max(250, Math.min(interval, (pin.timestamp + 12) * 1000 - now() + 50)) : interval;
      const tick = sample().tick, deadline = Math.min(rpcRecovery ? nextAcquireAt : tick + poll, execute ? Infinity : checkDeadline);
      await waitForNewHead(null, { absoluteDeadline: deadline, now: mono, sleep: dependencies.sleep, wake, advisoryHead: !rpcRecovery, isStopped });
      sample();
      if (!execute && clock.tick >= checkDeadline) { publish(hold(new ExecutionError("RANK1_CHECK_DEADLINE"))); break; }
    }
  } catch (error) {
    stopped = true; fatal = !dependencies.signal?.aborted; publish(hold(error));
  } finally {
    release(); wake.close(); dependencies.signal?.removeEventListener("abort", stop);
    await Promise.allSettled([factory, advisory].map(item => Promise.resolve().then(() => item?.close())));
    await drain();
    stopped = true;
    publish({ ...(last || hold(new ExecutionError("RANK1_STOP_REQUESTED"))), exitCode: fatal ? 2 : !execute && last?.ok === false ? 1 : 0 }, false, true);
  }
  return last;
}

module.exports = { APPROVAL_PATH, BASE_PATH, GAS_APPROVAL_PATH, EVENT_ID, STATUS_FILE, loadAuthorization, focusedHealth, sendIdentical, runPass, main };
