"use strict";

// Import-inert execution policy. Transport owns qualification and hypothetical state.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { id, keccak256, AbiCoder, getCreate2Address } = require("../node_modules/ethers");
const guard = require("./wallet-execution-guard.js");
const { normalizeSimulationTransaction, createNextBlockContext } = require("./next-block-simulation.js");
const { requireThat, uint, MAIN_ACCOUNT } = guard;
const ROOT = path.resolve(__dirname, "../..");
const AMENDMENT_PATH = "coordination/decisions/20261023-next-block-batch-amendment.json";
// This is the exact public approval, not a new approval or a configurable policy.
const AMENDMENT_SHA256 = "f51209edc221ab1c7bee7f7081988deeffd77b71c5465f0aba9240a0acde9d27";
const BASES = Object.freeze([
  { path: "coordination/live-execution-batch-aave-v4-v3-morpho.json", batchId: "aave-v4-v3-morpho-liquidator-20261019-01", sha256: "e0478bfeacad9dfbf546a714bbaaa64f3f9bcd39f1d8e040938baa846ae312bb" },
  { path: "coordination/live-execution-batch-morpho-trigger.json", batchId: "morpho-trigger-liquidation-20261012-01", sha256: "169a8519aa10bb656b1974e33d2bbb956e67b5ce31609827e049ad4d57e6354e" },
]);
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", DAI = "0x6b175474e89094c44da98b954eedeac495271d0f";
const W = 10n ** 18n, TRANSFER = id("Transfer(address,address,uint256)");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const min = (...values) => values.reduce((a, b) => a < b ? a : b);
const ceil = (n, d) => (n + d - 1n) / d;
const address = x => typeof x === "string" && /^0x[0-9a-f]{40}$/i.test(x);

function loadAuthorization({ readFile = fs.readFileSync, now = Date.now() } = {}) {
  try {
    const bytes = readFile(path.join(ROOT, AMENDMENT_PATH)), amendment = JSON.parse(bytes.toString("utf8"));
    requireThat(amendment.approved === true && amendment.revoked !== true && Date.parse(amendment.expiresAt) > now,
      "NEXT_BLOCK_AMENDMENT_INVALID_OR_EXPIRED");
    requireThat(sha(bytes) === AMENDMENT_SHA256, "NEXT_BLOCK_AMENDMENT_POLICY_MISMATCH");
    requireThat(amendment.schema === "next-block-execution-amendment/v1" && amendment.chainId === 1 && amendment.chain === "ethereum" &&
      amendment.account === MAIN_ACCOUNT && same(amendment.baseBatches, BASES) && amendment.nextBlock.offsetSeconds === 12 &&
      amendment.nextBlock.validation === true && amendment.nextBlock.exactTransaction === true && amendment.scope.valueWei === "0" &&
      amendment.scope.deployments === false && amendment.scope.newTargets === false && amendment.caps.maxSlippageBps === 50,
    "NEXT_BLOCK_AMENDMENT_POLICY_MISMATCH");
    const batches = BASES.map(binding => {
      const raw = readFile(path.join(ROOT, binding.path));
      requireThat(sha(raw) === binding.sha256, "NEXT_BLOCK_BASE_HASH_MISMATCH");
      const batch = JSON.parse(raw.toString("utf8"));
      requireThat(batch.batchId === binding.batchId && batch.approved === true && batch.revoked !== true &&
        Date.parse(batch.expiresAt) > now && batch.chainId === 1 && batch.account?.address?.toLowerCase() === MAIN_ACCOUNT,
      "NEXT_BLOCK_BASE_INVALID_OR_EXPIRED");
      return batch;
    });
    return { amendment, batches, amendmentHash: AMENDMENT_SHA256, baseHashes: BASES.map(b => b.sha256) };
  } catch (error) {
    if (error instanceof guard.ExecutionError) throw error;
    throw new guard.ExecutionError("NEXT_BLOCK_AUTHORIZATION_UNAVAILABLE");
  }
}

function boundedCaps(authorization, baseCaps) {
  const { amendment, batches } = authorization;
  const lifetime = batches.flatMap(b => b.caps.signedExecutionsTotal === undefined ? [] : [uint(b.caps.signedExecutionsTotal)]);
  return { ...baseCaps,
    gasCap: min(baseCaps.gasCap, uint(amendment.caps.maxGasLimitPerTransaction), ...batches.map(b => uint(b.caps.maxExecutionGasLimit ?? b.caps.maxGasLimitPerTransaction))),
    spendCap: min(baseCaps.spendCap, uint(amendment.caps.maxNativeSpendPerTransactionWei), ...batches.map(b => uint(b.caps.maxExecutionSpendWei ?? b.caps.maxNativeSpendPerTransactionWei))),
    dailyCap: min(baseCaps.dailyCap, uint(amendment.caps.signedExecutionsPerDay), ...batches.map(b => uint(b.caps.signedExecutionsPerDay))),
    lifetimeCap: lifetime.length ? min(...lifetime) : null,
  };
}

function matchesContext(left, right) {
  if (!left || !right) return false;
  try {
    const expected = createNextBlockContext({ hash: right.parentHash, number: right.parentNumber, timestamp: right.parentTimestamp });
    return Object.keys(left).length === Object.keys(expected).length && Object.keys(right).length === Object.keys(expected).length &&
      Object.keys(expected).every(k => left[k] === expected[k] && right[k] === expected[k]);
  } catch (_) { return false; }
}
function assertContext(pinned, context, now) {
  requireThat(pinned.nextBlock && typeof pinned.nextBlock.simulate === "function" && typeof pinned.nextBlock.recheck === "function" &&
    matchesContext(context, pinned.nextBlock.context) && matchesContext(context, createNextBlockContext(pinned.pin)), "NEXT_BLOCK_CONTEXT_MISMATCH");
  const e = pinned.evidence;
  requireThat(e?.independentFamilies === true && e.nextBlockQualified === true && Array.isArray(e.aliases) && e.aliases.length === 2 &&
    new Set(e.aliases).size === 2 && e.aliases.every(alias => e.qualification?.some(q => q.alias === alias && q.qualified === true &&
      q.nextBlockQualified === true && q.numberTimestampVerified === true && q.timeControlVerified === true && q.simulationUnknownHashRejected === true)),
  "NEXT_BLOCK_QUALIFICATION_REQUIRED");
  requireThat(Number.isSafeInteger(now) && now >= context.parentTimestamp * 1000 && now < context.timestamp * 1000, "NEXT_BLOCK_DEADLINE");
}
function activePosition(row) {
  return row && row.inactive !== true && row.positionStatus !== "CLOSED" && row.positionStatus !== "UNKNOWN" &&
    row.debtRaw !== "0" && row.debtReadStatus !== "UNAVAILABLE";
}
function forecastEligible(row, context) {
  if (!activePosition(row) || row.liquidatableNow !== false || row.hfUnderwaterNow === true ||
    (row.armed === false && row.observationKind !== "READ_ONLY_MONITOR") || row.observationOnly === true ||
    row.routePositive === false || row.observationStatus === "INCOMPLETE" || row.observationStatus === "UNAVAILABLE") return false;
  const f = row.nextBlockForecast;
  if (f?.eligibleForSimulation !== true || f.evidence !== "FORECAST_ONLY" || !matchesContext(f.context, context) ||
    !f.plans || typeof f.plans !== "object" || Array.isArray(f.plans)) return false;
  // Monitor flags describe a non-authorizing observation, not current/future
  // runner readiness. Only a complete row at this exact parent may nominate;
  // trusted capability, exact child simulation and authorization remain separate.
  if (row.observationKind === "READ_ONLY_MONITOR" && (row.observationStatus !== "COMPLETE" || row.refreshStatus !== "COMPLETE" ||
    row.chainId !== context.chainId || row.observationBlock !== context.parentNumber || row.observationHash !== context.parentHash ||
    row.observationTimestamp !== context.parentTimestamp)) return false;
  try {
    if (f.currentHealth !== "HEALTHY" || f.requiresExactSimulation !== true) return false;
    const near = (numerator, denominator) => denominator > 0n && numerator >= denominator &&
      (numerator - denominator) * 200000n <= numerator;
    // Watcher publishes exact Aave HF or Morpho accrued-debt/max-borrow integers,
    // not its rounded display HF. Retain any additional raw-row veto as well.
    if (row.healthFactorRaw !== undefined && !near(uint(row.healthFactorRaw), W)) return false;
    if (f.currentHealthFactorRaw !== undefined) return near(uint(f.currentHealthFactorRaw), W);
    return near(uint(f.maxBorrowRaw), uint(f.currentDebtRaw));
  } catch (_) { return false; }
}

function checkedSimulation(result, transaction, context) {
  requireThat(result && result.context && typeof result.context === "object", "NEXT_BLOCK_SIMULATION_PROOF_INVALID");
  const { transaction: returned, ...returnedContext } = result.context;
  requireThat(matchesContext(returnedContext, context) && same(returned, normalizeSimulationTransaction(transaction)) &&
    uint(result.gasLimit) === uint(transaction.gasLimit) && uint(result.gasUsed) > 0n && uint(result.gasUsed) <= uint(transaction.gasLimit) &&
    typeof result.returnData === "string" && /^0x(?:[0-9a-f]{2})*$/i.test(result.returnData) && Array.isArray(result.logs),
  "NEXT_BLOCK_SIMULATION_PROOF_INVALID");
  return result;
}
function ownerGain(logs, token, executor) {
  let gain = 0n, found = false;
  for (const log of logs) {
    requireThat(log && log.removed !== true && address(log.address) && Array.isArray(log.topics), "NEXT_BLOCK_LOG_INVALID");
    if (log.address.toLowerCase() !== token || log.topics[0]?.toLowerCase() !== TRANSFER) continue;
    requireThat(log.topics.length === 3 && log.topics.slice(1).every(t => /^0x0{24}[0-9a-f]{40}$/i.test(t)) &&
      /^0x[0-9a-f]{64}$/i.test(log.data), "NEXT_BLOCK_LOG_INVALID");
    const from = "0x" + log.topics[1].slice(-40).toLowerCase(), to = "0x" + log.topics[2].slice(-40).toLowerCase();
    requireThat(from !== MAIN_ACCOUNT && (to !== MAIN_ACCOUNT || from === executor), "NEXT_BLOCK_OWNER_GAIN_AMBIGUOUS");
    if (to === MAIN_ACCOUNT) { gain += BigInt(log.data); found = true; }
  }
  requireThat(found && gain > 0n, "NEXT_BLOCK_OWNER_GAIN_UNKNOWN");
  return gain;
}
function validateSlippage(evidence, context) {
  if (evidence?.kind === "SAME_ASSET_NO_SWAP") return;
  requireThat(evidence?.maxSlippageBps === 50 && matchesContext(evidence.context, context), "NEXT_BLOCK_SLIPPAGE_EVIDENCE_INVALID");
  const output = uint(evidence.outputRaw), minimum = uint(evidence.minOutputRaw);
  requireThat(output > 0n && minimum <= output && minimum * 10000n >= output * 9950n, "NEXT_BLOCK_SLIPPAGE_EXCEEDS_CAP");
}

// Canonical mainnet V3 pool for the first hop of an already allowlisted route.
function v3InputPool(tokenIn, tokenOut, fee) {
  const tokens = [tokenIn.toLowerCase(), tokenOut.toLowerCase()].sort();
  return getCreate2Address("0x1f98431c8ad98523631ae4a59f267346ea31f984", keccak256(
    AbiCoder.defaultAbiCoder().encode(["address", "address", "uint24"], [...tokens, fee])),
  "0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54").toLowerCase();
}
function swapInput(logs, { token, executor, recipient, minimum, exact }) {
  const code = "NEXT_BLOCK_SWAP_INPUT_UNPROVEN";
  let input;
  for (const log of logs) {
    requireThat(log && log.removed !== true && address(log.address) && Array.isArray(log.topics), code);
    if (log.address.toLowerCase() !== token || log.topics[0]?.toLowerCase() !== TRANSFER) continue;
    requireThat(log.topics.length === 3 && log.topics.slice(1).every(t => /^0x0{24}[0-9a-f]{40}$/i.test(t)) &&
      /^0x[0-9a-f]{64}$/i.test(log.data), code);
    const from = "0x" + log.topics[1].slice(-40).toLowerCase(), to = "0x" + log.topics[2].slice(-40).toLowerCase();
    if (from !== executor) continue;
    // These standard-token routes spend once, directly to the Curve/V3 pool.
    // Do not sum unrelated transfers or infer an amount from the seizure floor.
    requireThat(input === undefined && to === recipient && BigInt(log.data) > 0n, code);
    input = BigInt(log.data);
  }
  requireThat(input !== undefined && input >= minimum && (exact === undefined || input === exact), code);
  return input;
}

// Existing Chainlink denomination/round checks (near runner), using the fixed
// ETH feed and the DAI feed/max-age already used by the Morpho price screen.
const FEEDS = Object.freeze({
  eth: { address: "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419", description: "ETH / USD", maxAgeSeconds: 3600 },
  dai: { address: "0xaed0c38402a5d19df6e4c03f4e2dced6e29c1ee9", description: "DAI / USD", maxAgeSeconds: 10800 },
});
async function readFeeds(simulateCall, context) {
  const { FEED_IFACE, MULTICALL_IFACE } = require("../execute-aave-v4-near-liquidation.js");
  const { MULTICALL3 } = require("./executor-pinned-rpc.js");
  const methods = ["decimals", "description", "latestRoundData"], configs = [FEEDS.eth, FEEDS.dai];
  const calls = configs.flatMap(config => methods.map(method => ({ target: config.address, allowFailure: false,
    callData: FEED_IFACE.encodeFunctionData(method) })));
  const raw = (await simulateCall({ to: MULTICALL3, data: MULTICALL_IFACE.encodeFunctionData("aggregate3", [calls]) })).returnData;
  let rows;
  try {
    rows = MULTICALL_IFACE.decodeFunctionResult("aggregate3", raw)[0];
    requireThat(rows.length === 6 && rows.every(r => r.success === true) &&
      MULTICALL_IFACE.encodeFunctionResult("aggregate3", [rows]).toLowerCase() === raw.toLowerCase(), "NEXT_BLOCK_ORACLE_ABI_INVALID");
  } catch (_) { throw new guard.ExecutionError("NEXT_BLOCK_ORACLE_ABI_INVALID"); }
  return configs.map((config, i) => {
    const values = methods.map((method, j) => {
      try {
        const bytes = rows[i * 3 + j].returnData, decoded = FEED_IFACE.decodeFunctionResult(method, bytes);
        requireThat(FEED_IFACE.encodeFunctionResult(method, decoded).toLowerCase() === bytes.toLowerCase(), "NEXT_BLOCK_ORACLE_ABI_INVALID");
        return decoded;
      } catch (_) { throw new guard.ExecutionError("NEXT_BLOCK_ORACLE_ABI_INVALID"); }
    });
    requireThat(values[0][0] === 8n && values[1][0] === config.description, "NEXT_BLOCK_ORACLE_DENOMINATION_INVALID");
    const [round, price, start, updated, answered] = values[2];
    requireThat(round > 0n && price > 0n && start > 0n && updated >= start && answered >= round && updated <= BigInt(context.timestamp) &&
      BigInt(context.timestamp) - updated <= BigInt(config.maxAgeSeconds), "NEXT_BLOCK_ORACLE_STALE_OR_INVALID");
    return { address: config.address, priceRaw: price.toString(), decimals: 8, updatedAt: updated.toString(), roundId: round.toString() };
  });
}
async function economics({ gain, minimumProfit, slippageLoss = 0n, token, transaction, simulateCall, context, prices }) {
  requireThat(token === WETH || token === DAI, "NEXT_BLOCK_VALUATION_UNSUPPORTED");
  const nativeGas = uint(transaction.gasLimit) * uint(transaction.maxFeePerGas);
  let gas = nativeGas, eth, dai;
  if (token === DAI) {
    [eth, dai] = prices ? [prices.eth, prices.dai] : await readFeeds(simulateCall, context);
    gas = ceil(nativeGas * BigInt(eth.priceRaw), BigInt(dai.priceRaw));
  }
  // Never promote the simulator's gain above the retained contract profit floor.
  const lower = min(gain - slippageLoss, minimumProfit), reserve = token === WETH ? 500000000000000n : 2n * W;
  requireThat(lower > 0n, "NEXT_BLOCK_NET_NONPOSITIVE");
  const haircut = ceil(lower * 1000n, 10000n), beforeGas = lower - reserve - haircut, net = beforeGas - gas;
  requireThat(net > 0n, "NEXT_BLOCK_NET_NONPOSITIVE");
  return { evidence: "CONDITIONAL_SIMULATED_OWNER_GAIN_NOT_REALIZED", token, ownerGainRaw: gain.toString(),
    retainedProfitFloorRaw: minimumProfit.toString(), slippageLossAllowanceRaw: slippageLoss.toString(),
    conservativeGrossRaw: lower.toString(), maxGasCostWei: nativeGas.toString(), gasCostTokenRaw: gas.toString(),
    uncertaintyHaircutBps: 1000, uncertaintyHaircutRaw: haircut.toString(), additionalReserveRaw: reserve.toString(),
    conservativeProfitBeforeGasWei: (token === WETH ? beforeGas : beforeGas * BigInt(dai.priceRaw) / BigInt(eth.priceRaw)).toString(),
    netTokenRaw: net.toString(), netNativeWei: (token === WETH ? net : net * BigInt(dai.priceRaw) / BigInt(eth.priceRaw)).toString(),
    prices: token === WETH ? null : { eth, dai }, realizedNetProfit: "UNKNOWN" };
}

async function executeForecast({ candidate, pinned, route, validateBase, readFile = fs.readFileSync, now = Date.now,
  signTransaction, secondarySendRawTransaction, executionOptions = {} }) {
  requireThat(candidate.kind !== "MORPHO_BLUE_M1", "M1_LIVE_EVIDENCE_REQUIRED");
  requireThat(candidate.executionMode === "NEXT_BLOCK_PASSIVE" && route, "NEXT_BLOCK_ROUTE_FRESHNESS_OR_SLIPPAGE_UNSUPPORTED");
  const context = candidate.nextBlockContext, next = pinned.nextBlock;
  const intent = { targetId: candidate.id, to: route.executor, profitToken: route.profitToken, pinHash: context.parentHash,
    executionMode: "NEXT_BLOCK_PASSIVE", canonicalPosition: candidate.canonicalPosition,
    nextBlockReplayKey: id(`${candidate.canonicalPosition}|${context.parentHash}|${context.timestamp}`),
    nextBlockContext: context, forecastCalldataHash: keccak256(candidate.data) };
  let transaction, proof, authorization, caps, txBinding;
  const validate = async () => {
    authorization = loadAuthorization({ readFile, now: now() });
    caps = boundedCaps(authorization, await validateBase(authorization.batches, candidate, now()));
    assertContext(pinned, context, now()); await next.recheck(); assertContext(pinned, context, now());
    // Reload after the asynchronous head check as well as before it.
    authorization = loadAuthorization({ readFile, now: now() });
    caps = boundedCaps(authorization, await validateBase(authorization.batches, candidate, now()));
    if (transaction) {
      requireThat(same(normalizeSimulationTransaction({ ...transaction, from: MAIN_ACCOUNT }), txBinding), "NEXT_BLOCK_TRANSACTION_CHANGED");
      checkedSimulation(proof, { ...transaction, from: MAIN_ACCOUNT }, context);
    }
    // Disk reloads/binding checks may themselves consume the remaining slot.
    assertContext(pinned, context, now());
    return caps;
  };
  return guard.executeGuarded({ ...executionOptions, now, account: MAIN_ACCOUNT, intent,
    prepare: async () => {
      await validate();
      const nonce = Number(uint(await pinned.nonce(MAIN_ACCOUNT)));
      requireThat(Number.isSafeInteger(nonce), "NONCE_INVALID");
      await validate();
      // An explicit capped limit is tested as-is; gasUsed is never a replacement limit.
      const gasLimit = caps.gasCap;
      // This unsigned probe has no profit proof yet. It is never the signed envelope.
      const envelope = { type: 2, chainId: 1, from: MAIN_ACCOUNT, nonce, value: 0n,
        ...guard.buildFeePolicy(gasLimit, pinned.pin.baseFeePerGas, caps), accessList: [] };
      const simulateCall = async call => {
        // Transport rechecks both families before AND after every simulation.
        // Full authorization reloads belong at preparation and sign/send boundaries,
        // not around each unsigned oracle/quote call.
        assertContext(pinned, context, now());
        const exact = { ...envelope, to: call.to, data: call.data };
        guard.validateTransaction(exact, caps);
        const result = checkedSimulation(await next.simulate(exact), exact, context);
        assertContext(pinned, context, now());
        return result;
      };
      const prepared = await route.prepare(simulateCall);
      validateSlippage(prepared.quoteEvidence, context);
      const checkGain = result => {
        route.checkReturn(result.returnData);
        if (prepared.quoteEvidence.kind !== "SAME_ASSET_NO_SWAP") {
          requireThat(route.actualInput(result.logs) === uint(prepared.quoteEvidence.inputRaw), "NEXT_BLOCK_SWAP_INPUT_CHANGED");
        }
        const gain = ownerGain(result.logs, route.profitToken, route.executor);
        requireThat(gain >= prepared.minimumProfit, "SIMULATED_PROFIT_BELOW_MIN");
        return gain;
      };
      const probe = { ...envelope, to: route.executor, data: prepared.data };
      const gain = checkGain(await simulateCall(probe));
      // Zero gas here extracts P only; the final gate below uses the signed maxFee.
      const beforeGas = await economics({ gain, minimumProfit: prepared.minimumProfit, slippageLoss: prepared.slippageLoss,
        token: route.profitToken, transaction: { ...probe, maxFeePerGas: 0n }, simulateCall, context });
      const fees = guard.buildFeePolicy(gasLimit, pinned.pin.baseFeePerGas, caps, beforeGas.conservativeProfitBeforeGasWei);
      Object.assign(envelope, fees);
      const exact = { ...probe, ...fees };
      proof = await simulateCall(exact);
      const net = await economics({ gain: checkGain(proof), minimumProfit: prepared.minimumProfit, slippageLoss: prepared.slippageLoss,
        token: route.profitToken, transaction: exact, simulateCall, context, prices: beforeGas.prices });
      const finalFees = guard.buildFeePolicy(gasLimit, pinned.pin.baseFeePerGas, caps, net.conservativeProfitBeforeGasWei);
      requireThat(finalFees.maxFeePerGas === exact.maxFeePerGas && finalFees.maxPriorityFeePerGas === exact.maxPriorityFeePerGas,
        "NEXT_BLOCK_FEE_PROFIT_CHANGED");
      const { from, ...unsigned } = exact;
      transaction = Object.freeze({ ...unsigned, accessList: Object.freeze([]) }); txBinding = normalizeSimulationTransaction(exact);
      Object.assign(intent, { amendmentId: authorization.amendment.amendmentId, amendmentHash: authorization.amendmentHash,
        baseBatchHashes: authorization.baseHashes, simulatedTransaction: txBinding, simulatedGasUsed: uint(proof.gasUsed).toString(),
        simulatedProfitBeforeGasRaw: gain.toString(), minProfitBeforeGasRaw: prepared.minimumProfit.toString(), simulatedEconomics: net,
        quoteEvidence: prepared.quoteEvidence });
      await validate();
      return { transaction, caps, conservativeProfitBeforeGasWei: net.conservativeProfitBeforeGasWei };
    },
    validate, signTransaction,
    sendRawTransaction: async signed => {
      await validate();
      const [primary] = await Promise.allSettled([
        Promise.resolve().then(() => pinned.send(signed)),
        ...(typeof secondarySendRawTransaction === "function" ? [Promise.resolve().then(() => secondarySendRawTransaction(signed))] : []),
      ]);
      if (primary.status === "rejected") throw primary.reason;
      if (typeof secondarySendRawTransaction === "function") {
        // Retain the post-send recheck, but never gate dispatch on primary latency.
        try { await validate(); } catch (_) { /* primary outcome remains journalled */ }
      }
      return primary.value;
    },
    receiptRpc: (hash, timeoutMs) => pinned.receipt(hash, timeoutMs),
  });
}

module.exports = { AMENDMENT_PATH, AMENDMENT_SHA256, BASES, FEEDS, loadAuthorization, boundedCaps, matchesContext, assertContext,
  activePosition, forecastEligible, checkedSimulation, ownerGain, validateSlippage, v3InputPool, swapInput, readFeeds, economics, executeForecast };
