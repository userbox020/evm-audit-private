"use strict";

// Read-only, injected simulation helper. Nothing imports this into a signing runner.
const { Interface, AbiCoder, keccak256, getCreate2Address, solidityPacked } = require("../node_modules/ethers");
const near = require("../execute-aave-v4-near-liquidation.js");
const { MAIN_ACCOUNT: OWNER, ExecutionError, requireThat, uint, buildFees } = require("./wallet-execution-guard.js");
const { MAX_AGE_MS } = require("./executor-pinned-rpc.js");
const T = near.NEAR_TARGET_PLANS.find(t => t.id === "rank2_wsteth_weth_0x4cd7");
const EXECUTOR = T.executor, WETH = T.debtAsset, WSTETH = T.collateralAsset;
const MORPHO = "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb";
const ROUTER = "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45";
const ZERO = "0x" + "00".repeat(20), HEALTHY_ERROR = "0x930bb771";
const ABI = AbiCoder.defaultAbiCoder(), PLAN_TYPE = near.DEDICATED_IFACE.getFunction("execute").inputs[0];
const TOKEN = new Interface([
  "function balanceOf(address) view returns(uint256)", "function approve(address,uint256) returns(bool)",
  "function transfer(address,uint256) returns(bool)", "function transferFrom(address,address,uint256) returns(bool)"
]);
const LENDER = new Interface(["function flashLoan(address,uint256,bytes)", "function onMorphoFlashLoan(uint256,bytes)"]);
const SPOKE = new Interface(["function liquidationCall(uint256,uint256,address,uint256,bool)"]);
const HUB = new Interface(["function remove(uint256,uint256,address) returns(uint256)",
  "function restore(uint256,uint256,(int256 sharesDelta,int256 offsetRayDelta,uint256 restoredPremiumRay)) returns(uint256)"]);
const SWAP = new Interface([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns(uint256)",
  "function swap(address,bool,int256,uint160,bytes) returns(int256,int256)",
  "function uniswapV3SwapCallback(int256,int256,bytes)"
]);
// Uniswap V3 PoolAddress.sol, standard Ethereum factory, sorted wstETH/WETH, fee 100.
const POOL = getCreate2Address("0x1f98431c8ad98523631ae4a59f267346ea31f984",
  keccak256(ABI.encode(["address", "address", "uint24"], [WSTETH, WETH, 100])),
  "0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54").toLowerCase();
const SWAP_CALLBACK_DATA = ABI.encode(["tuple(bytes path,address payer)"],
  [[solidityPacked(["address", "uint24", "address"], [WSTETH, 100, WETH]), EXECUTOR]]);
const LIMITATIONS = Object.freeze([
  "SIMULATION ONLY: no arming decision, signing, nonce reservation or inclusion guarantee; the runner hold is unchanged.",
  "Standard wstETH approve(C) overwrites prior allowance; successful settlement resets it to zero. X <= min(C,S) implies B+C-X >= B.",
  "At inclusion C<S may partially fill rather than revert; C>S may leave collateral, valued at zero liquid profit here. The deployed contract does NOT enforce inclusion X=S.",
  "Both local traces require C=S=X. Prior WETH cannot mask incremental profit; inclusion prices, balances, gas and realized profit remain unestablished."
]);
const hex = x => typeof x === "string" && /^0x(?:[0-9a-f]{2})*$/.test(x);
const address = x => typeof x === "string" && /^0x[0-9a-f]{40}$/.test(x);
const hash = x => typeof x === "string" && /^0x[0-9a-f]{64}$/.test(x);
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
function amount(value, positive = false) {
  const n = uint(value, "SWAP_AMOUNT_INVALID");
  requireThat(n < (1n << 256n) && (!positive || n > 0n), "SWAP_AMOUNT_INVALID"); return n;
}
function slippage(b) {
  requireThat(Number.isInteger(b) && b >= 0 && b <= 50, "BATCH_SLIPPAGE_NOT_APPROVED"); return BigInt(b);
}
function minimumOutput(Q, b) {
  const relative = (amount(Q, true) * (10000n - slippage(b)) + 9999n) / 10000n;
  return relative > T.minSwapOut ? relative : T.minSwapOut;
}
// Arithmetic consequence of the standard token's overwrite allowance(C), NOT an
// inclusion/full-fill assertion. The trace validator separately demands C=S=X.
function collateralRemainder({ B, C, S, X }) {
  [B, C, S, X] = [B, C, S, X].map(n => amount(n));
  requireThat(X <= C && X <= S, "COLLATERAL_PAYMENT_EXCEEDS_ALLOWANCE_OR_REQUEST");
  return B + C - X;
}
function planAt(deadline) {
  return { spoke: T.spoke, collateralReserveId: T.collateralReserveId, debtReserveId: T.debtReserveId,
    borrower: T.borrower, debtAsset: WETH, collateralAsset: WSTETH, flashLoanAmount: T.flashLoanAmount,
    debtToCover: T.debtToCover, minSwapOut: T.minSwapOut, minProfit: T.minProfit, deadline: amount(deadline, true),
    venueType: 0, swapTarget: ZERO, uniV3Fee: 100, curveIndexIn: 0, curveIndexOut: 0, customSwapData: "0x" };
}
function transaction(plan) {
  return freeze({ from: OWNER, to: EXECUTOR, value: "0x0", data: near.DEDICATED_IFACE.encodeFunctionData("execute", [plan]) });
}
function routerData(S, M) { return SWAP.encodeFunctionData("exactInputSingle", [[WSTETH, WETH, 100, EXECUTOR, S, M, 0]]); }

function buildRank2SwapTransaction(options) {
  requireThat(options && Object.keys(options).length === 4 &&
    Object.keys(options).every(k => ["S", "Q", "maxSlippageBps", "deadline"].includes(k)), "OPAQUE_SWAP_INPUT_FORBIDDEN");
  const S = amount(options.S, true), Q = amount(options.Q, true), M = minimumOutput(Q, options.maxSlippageBps);
  requireThat(S < (1n << 255n) && M <= Q, "SWAP_QUOTE_BELOW_FLOOR");
  const plan = { ...planAt(options.deadline), venueType: 2, swapTarget: ROUTER, minSwapOut: M, customSwapData: routerData(S, M) };
  return freeze({ S: S.toString(), Q: Q.toString(), M: M.toString(), deadline: plan.deadline.toString(), plan,
    transaction: transaction(plan) });
}

function canonical(iface, name, bytes, output = false) {
  try {
    requireThat(hex(bytes), "TRACE_ABI_INVALID");
    const decoded = output ? iface.decodeFunctionResult(name, bytes) : iface.decodeFunctionData(name, bytes);
    const encoded = output ? iface.encodeFunctionResult(name, decoded) : iface.encodeFunctionData(name, decoded);
    requireThat(encoded === bytes, "TRACE_ABI_INVALID"); return decoded;
  } catch (_) { throw new ExecutionError("TRACE_ABI_INVALID"); }
}
function traceIndex(trace) {
  requireThat(trace && Number.isSafeInteger(trace.nodes) && trace.nodes > 0 && trace.nodes <= 4096, "TRACE_SHAPE_INVALID");
  const rows = [], seen = new Set(); let bytes = 0;
  function visit(node, parent, context, ancestors, depth) {
    requireThat(node && !seen.has(node) && depth <= 96 && rows.length < 4096 &&
      Object.keys(node).length === 8 && Object.keys(node).every(k => ["type", "from", "to", "input", "output", "value", "reverted", "calls"].includes(k)) &&
      ["CALL", "STATICCALL", "DELEGATECALL"].includes(node.type) && address(node.from) && address(node.to) &&
      hex(node.input) && hex(node.output) && node.value === "0" && typeof node.reverted === "boolean" && Array.isArray(node.calls), "TRACE_SHAPE_INVALID");
    requireThat(!parent || node.from === context, "TRACE_CALLER_PATH_INVALID");
    bytes += (node.input.length + node.output.length) / 2;
    requireThat(bytes <= 1024 * 1024, "TRACE_SHAPE_INVALID");
    seen.add(node); rows.push({ node, ancestors });
    const nextContext = node.type === "DELEGATECALL" ? context : node.to;
    for (const child of node.calls) visit(child, node, nextContext, [...ancestors, node], depth + 1);
  }
  visit(trace.tree, null, null, [], 0);
  requireThat(rows.length === trace.nodes, "TRACE_NODE_COUNT_MISMATCH"); return rows;
}
function frame(node, from, to, type, iface, method, args, reverted = false) {
  requireThat(node && node.from === from && node.to === to && node.type === type && node.reverted === reverted && node.value === "0", "TRACE_REQUIRED_PATH_INVALID");
  const decoded = canonical(iface, method, node.input);
  if (args) requireThat(node.input === iface.encodeFunctionData(method, args), "TRACE_ARGUMENT_MISMATCH");
  if (!reverted) canonical(iface, method, node.output, true);
  return decoded;
}
function balance(node, from, token, account) {
  frame(node, from, token, "STATICCALL", TOKEN, "balanceOf", [account]);
  requireThat(node.calls.length === 0, "TRACE_TOKEN_CHILDREN_UNEXPECTED");
  return canonical(TOKEN, "balanceOf", node.output, true)[0];
}
function tokenCall(node, from, token, method, args) {
  frame(node, from, token, "CALL", TOKEN, method, args);
  requireThat(node.calls.length === 0 && canonical(TOKEN, method, node.output, true)[0] === true, "TRACE_TOKEN_RESULT_INVALID");
}

// Only the two exact branches generated here are accepted; no caller-supplied plan/bytes authority.
function validateRank2SwapTrace({ trace, transaction: tx, deadline, quote = null, maxSlippageBps }) {
  slippage(maxSlippageBps);
  const built = quote ? buildRank2SwapTransaction({ S: quote.S, Q: quote.Q, maxSlippageBps, deadline })
    : { plan: planAt(deadline), transaction: transaction(planAt(deadline)) };
  requireThat(tx && Object.keys(tx).length === 4 && Object.keys(built.transaction).every(k => tx[k] === built.transaction[k]), "TRACE_TRANSACTION_MISMATCH");
  const rows = traceIndex(trace), root = trace.tree, healthy = root.reverted && root.output === HEALTHY_ERROR;
  frame(root, OWNER, EXECUTOR, "CALL", near.DEDICATED_IFACE, "execute", [built.plan], healthy);
  requireThat(!healthy || !quote, "FINAL_TRACE_REVERTED");
  requireThat(root.calls.length === (healthy ? 2 : 4), "TRACE_ROOT_SEQUENCE_INVALID");
  const priorDebt = balance(root.calls[0], EXECUTOR, WETH, EXECUTOR), flash = root.calls[1];
  const flashArgs = frame(flash, EXECUTOR, MORPHO, "CALL", LENDER, "flashLoan", null, healthy);
  requireThat(flashArgs[0].toLowerCase() === WETH && flashArgs[1] === T.flashLoanAmount, "TRACE_FLASH_MISMATCH");
  let payload;
  try {
    payload = ABI.decode(["uint256", PLAN_TYPE], flashArgs[2]);
    requireThat(ABI.encode(["uint256", PLAN_TYPE], payload) === flashArgs[2] && payload[0] > 0n &&
      ABI.encode([PLAN_TYPE], [payload[1]]) === ABI.encode([PLAN_TYPE], [built.plan]), "TRACE_CALLBACK_MISMATCH");
  } catch (_) { throw new ExecutionError("TRACE_CALLBACK_MISMATCH"); }
  requireThat(flash.calls.length === (healthy ? 2 : 3), "TRACE_FLASH_SEQUENCE_INVALID");
  tokenCall(flash.calls[0], MORPHO, WETH, "transfer", [EXECUTOR, T.flashLoanAmount]);
  const callback = flash.calls[1];
  frame(callback, MORPHO, EXECUTOR, "CALL", LENDER, "onMorphoFlashLoan", [T.flashLoanAmount, flashArgs[2]], healthy);
  requireThat(callback.calls.length === (healthy ? 4 : 12), "TRACE_CALLBACK_SEQUENCE_INVALID");
  const c = callback.calls, beforeLiq = balance(c[0], EXECUTOR, WETH, EXECUTOR), B = balance(c[1], EXECUTOR, WSTETH, EXECUTOR);
  requireThat(beforeLiq === priorDebt + T.flashLoanAmount, "TRACE_FLASH_BALANCE_MISMATCH");
  tokenCall(c[2], EXECUTOR, WETH, "approve", [T.spoke, T.flashLoanAmount]);
  frame(c[3], EXECUTOR, T.spoke, "CALL", SPOKE, "liquidationCall", [0, 1, T.borrower, T.debtToCover, false], healthy);
  if (healthy) {
    requireThat([root, flash, callback, c[3]].every(n => n.output === HEALTHY_ERROR), "TRACE_HEALTHY_PATH_INVALID");
    return freeze({ status: "NOT_LIQUIDATABLE", simulationOnly: true, reason: "HealthFactorNotBelowThreshold", nodes: trace.nodes });
  }
  requireThat(rows.every(r => !r.node.reverted), "TRACE_REVERTED_ANCESTOR");
  tokenCall(c[4], EXECUTOR, WETH, "approve", [T.spoke, 0]);
  const afterLiq = balance(c[5], EXECUTOR, WETH, EXECUTOR), afterColl = balance(c[6], EXECUTOR, WSTETH, EXECUTOR);
  const R = beforeLiq - afterLiq, C = afterColl - B;
  requireThat(C > 0n && R > 0n && R <= T.flashLoanAmount, "TRACE_LIQUIDATION_ACCOUNTING_INVALID");
  tokenCall(c[7], EXECUTOR, WSTETH, "approve", [ROUTER, C]);
  const router = c[8], swapArgs = frame(router, EXECUTOR, ROUTER, "CALL", SWAP, "exactInputSingle")[0];
  const S = swapArgs.amountIn, Q = canonical(SWAP, "exactInputSingle", router.output, true)[0];
  requireThat(router.input === routerData(S, built.plan.minSwapOut) && (!quote || router.input === built.plan.customSwapData), "TRACE_ROUTER_ARGUMENT_MISMATCH");
  requireThat(router.calls.length === 1, "TRACE_ROUTER_SEQUENCE_INVALID");
  const pool = router.calls[0];
  frame(pool, ROUTER, POOL, "CALL", SWAP, "swap", [EXECUTOR, true, S, 4295128740n, SWAP_CALLBACK_DATA]);
  const [X, negativeQ] = canonical(SWAP, "swap", pool.output, true);
  requireThat(X > 0n && negativeQ === -Q && pool.calls.length === 4, "TRACE_POOL_ACCOUNTING_INVALID");
  tokenCall(pool.calls[0], POOL, WETH, "transfer", [EXECUTOR, Q]);
  const poolBefore = balance(pool.calls[1], POOL, WSTETH, POOL), swapCallback = pool.calls[2];
  frame(swapCallback, POOL, ROUTER, "CALL", SWAP, "uniswapV3SwapCallback", [X, -Q, SWAP_CALLBACK_DATA]);
  requireThat(swapCallback.calls.length === 1, "TRACE_SWAP_CALLBACK_INVALID");
  tokenCall(swapCallback.calls[0], ROUTER, WSTETH, "transferFrom", [EXECUTOR, POOL, X]);
  requireThat(balance(pool.calls[3], POOL, WSTETH, POOL) === poolBefore + X, "TRACE_POOL_PAYMENT_MISMATCH");
  tokenCall(c[9], EXECUTOR, WSTETH, "approve", [ROUTER, 0]);
  const O = balance(c[10], EXECUTOR, WETH, EXECUTOR) - afterLiq;
  tokenCall(c[11], EXECUTOR, WETH, "approve", [MORPHO, T.flashLoanAmount]);
  tokenCall(flash.calls[2], MORPHO, WETH, "transferFrom", [EXECUTOR, MORPHO, T.flashLoanAmount]);
  const P = canonical(near.DEDICATED_IFACE, "execute", root.output, true)[0];
  requireThat(balance(root.calls[2], EXECUTOR, WETH, EXECUTOR) === priorDebt + P && P === O - R && P >= T.minProfit,
    "TRACE_INCREMENTAL_PROFIT_INVALID");
  tokenCall(root.calls[3], EXECUTOR, WETH, "transfer", [OWNER, P]);
  requireThat(C === S && S === X && Q === O && Q > 0n && Q >= built.plan.minSwapOut, "TRACE_EXACT_INPUT_REQUIRED");

  // Authenticate liquidation token movements inside the approved spoke call. Delegated
  // libraries retain the spoke's context (checked by traceIndex), not their own sender.
  const liquidationRows = rows.filter(r => r.ancestors.includes(c[3]));
  const debitRows = liquidationRows.filter(r => r.node.to === WETH && r.node.input.startsWith(TOKEN.getFunction("transferFrom").selector));
  const creditRows = liquidationRows.filter(r => r.node.to === WSTETH && r.node.input.startsWith(TOKEN.getFunction("transfer").selector));
  requireThat(debitRows.length === 1 && creditRows.length === 1, "TRACE_LIQUIDATION_TRANSFERS_INVALID");
  const debit = debitRows[0].node, credit = creditRows[0].node;
  const debtDestination = canonical(TOKEN, "transferFrom", debit.input)[1].toLowerCase();
  requireThat(debtDestination !== ZERO && ![EXECUTOR, OWNER, ROUTER, MORPHO, POOL].includes(debtDestination), "TRACE_DEBT_DESTINATION_INVALID");
  tokenCall(debit, T.spoke, WETH, "transferFrom", [EXECUTOR, debtDestination, R]);
  const debitSiblings = debitRows[0].ancestors.at(-1).calls, restore = debitSiblings[debitSiblings.indexOf(debit) + 1];
  const restored = frame(restore, T.spoke, debtDestination, "CALL", HUB, "restore");
  requireThat(restored[1] + (restored[2].restoredPremiumRay + 10n ** 27n - 1n) / (10n ** 27n) === R, "TRACE_DEBT_RESTORE_MISMATCH");
  tokenCall(credit, credit.from, WSTETH, "transfer", [EXECUTOR, C]);
  const removeCalls = creditRows[0].ancestors.filter(n => n.type === "CALL" && n.from === T.spoke && n.to === credit.from && n.input.startsWith(HUB.getFunction("remove").selector));
  requireThat(removeCalls.length === 1, "TRACE_COLLATERAL_PATH_INVALID");
  const removeArgs = frame(removeCalls[0], T.spoke, credit.from, "CALL", HUB, "remove");
  requireThat(removeArgs[1] === C && removeArgs[2].toLowerCase() === EXECUTOR, "TRACE_COLLATERAL_PATH_INVALID");
  const expectedMutations = new Set([flash.calls[0], flash.calls[2], root.calls[3], c[2], c[4], c[7], c[9], c[11],
    pool.calls[0], swapCallback.calls[0], debit, credit]);
  for (const { node } of rows) {
    if (node.to === EXECUTOR) requireThat(node === root || node === callback, "TRACE_UNEXPECTED_EXECUTOR_ENTRY");
    if (node.to === MORPHO) requireThat(node === flash, "TRACE_UNEXPECTED_LENDER_ENTRY");
    if (node.to === ROUTER) requireThat(node === router || node === swapCallback, "TRACE_UNEXPECTED_ROUTER_ENTRY");
    if (node.to === POOL) requireThat(node === pool, "TRACE_UNEXPECTED_POOL_ENTRY");
    if (![WETH, WSTETH].includes(node.to)) continue;
    if (node.type === "STATICCALL" && node.input.startsWith(TOKEN.getFunction("balanceOf").selector)) {
      canonical(TOKEN, "balanceOf", node.input); canonical(TOKEN, "balanceOf", node.output, true);
      requireThat(node.calls.length === 0, "TRACE_TOKEN_CHILDREN_UNEXPECTED");
    } else requireThat(expectedMutations.delete(node), "TRACE_UNEXPECTED_TOKEN_MUTATION");
  }
  requireThat(expectedMutations.size === 0, "TRACE_REQUIRED_TOKEN_MUTATION_MISSING");
  const result = { status: "EXACT_SWAP_SIMULATED", C, S, X, Q, O, R, P, priorCollateral: B,
    remainingCollateral: collateralRemainder({ B, C, S, X }), priorDebt, callbackNonce: payload[0] };
  for (const key of Object.keys(result)) if (typeof result[key] === "bigint") result[key] = result[key].toString();
  if (quote) for (const key of ["C", "S", "X", "Q", "O", "R", "P", "priorCollateral", "priorDebt", "callbackNonce"])
    requireThat(result[key] === quote[key], "TRACE_DISCOVERY_FINAL_MISMATCH");
  return freeze({ ...result, nodes: trace.nodes });
}

function bindPinned(pinned, now) {
  const methods = ["trace", "call", "estimateGas", "recheck", "assertUsable"];
  requireThat(pinned && methods.every(k => typeof pinned[k] === "function"), "TRACE_QUALIFIED_PAIR_REQUIRED");
  const refs = Object.fromEntries(methods.map(k => [k, pinned[k]]));
  const pin = freeze({ ...pinned.pin }), aliases = [...(pinned.evidence?.aliases || [])];
  requireThat(Number.isSafeInteger(pin.number) && pin.number > 0 && hash(pin.hash) && hash(pin.parentHash) && hash(pin.stateRoot) &&
    Number.isSafeInteger(pin.timestamp), "PIN_HEADER_INVALID");
  amount(pin.baseFeePerGas);
  function check() {
    requireThat(pinned.evidence?.traceQualified === true && pinned.evidence.independentFamilies === true && aliases.length === 2 &&
      aliases.every(a => Number.isSafeInteger(a) && a > 0) && aliases[0] !== aliases[1] &&
      JSON.stringify(pinned.evidence.aliases) === JSON.stringify(aliases) && methods.every(k => pinned[k] === refs[k]), "TRACE_QUALIFIED_PAIR_REQUIRED");
    requireThat(JSON.stringify(pinned.pin) === JSON.stringify(pin), "PREFLIGHT_PIN_CHANGED");
    const age = now() - pin.timestamp * 1000;
    requireThat(Number.isSafeInteger(age) && age >= 0 && age <= MAX_AGE_MS, "PIN_STALE_OR_FUTURE");
    refs.assertUsable.call(pinned);
  }
  check();
  const view = { pin };
  for (const name of ["trace", "call", "estimateGas", "recheck"]) view[name] = async (...args) => {
    check(); const result = await refs[name].apply(pinned, args); check(); return result;
  };
  return { view: freeze(view), check, aliases: freeze(aliases) };
}

async function prepareRank2SwapPreflight({ pinned, loadBatch, now = Date.now }) {
  requireThat(typeof loadBatch === "function" && typeof now === "function", "PREFLIGHT_ARGUMENT_INVALID");
  const batch = loadBatch(), caps = near.validateAuthorization(batch, now()), batchId = batch.batchId;
  const economics = JSON.stringify(caps.economics), binding = bindPinned(pinned, now), rpc = binding.view;
  const deadline = BigInt(Math.floor(now() / 1000)) + 120n;
  const probePlan = freeze(planAt(deadline)), probeTx = transaction(probePlan);
  await rpc.recheck();
  const discovery = validateRank2SwapTrace({ trace: await rpc.trace(probeTx), transaction: probeTx, deadline, maxSlippageBps: caps.maxSwapSlippageBps });
  if (discovery.status === "NOT_LIQUIDATABLE") {
    await rpc.recheck();
    binding.check();
    const current = loadBatch(); near.validateAuthorization(current, now());
    requireThat(current.batchId === batchId, "PREFLIGHT_BATCH_CHANGED");
    return freeze({ status: "NOT_LIQUIDATABLE", simulationOnly: true, H: rpc.pin.hash, deadline: deadline.toString(),
      probeCalldataHash: keccak256(probeTx.data), reason: discovery.reason, limitations: LIMITATIONS });
  }
  const built = buildRank2SwapTransaction({ S: discovery.S, Q: discovery.Q, maxSlippageBps: caps.maxSwapSlippageBps, deadline });
  const finalTx = built.transaction;
  const final = validateRank2SwapTrace({ trace: await rpc.trace(finalTx), transaction: finalTx, deadline, quote: discovery, maxSlippageBps: caps.maxSwapSlippageBps });
  const callProfit = canonical(near.DEDICATED_IFACE, "execute", await rpc.call(finalTx), true)[0];
  requireThat(callProfit.toString() === discovery.P, "FINAL_CALL_PROFIT_MISMATCH");
  const gasEstimate = amount(await rpc.estimateGas(finalTx), true), fees = buildFees(gasEstimate, rpc.pin.baseFeePerGas, caps);
  const netEstimate = await near.estimateNetLowerBound(rpc, T, fees, caps.economics);
  requireThat(netEstimate.positive, "CONSERVATIVE_NET_NONPOSITIVE");
  await rpc.recheck();
  binding.check();
  // FINAL policy reload is after the last await. No asynchronous work below this gate.
  const finalNow = now(), current = loadBatch(), currentCaps = near.validateAuthorization(current, finalNow);
  requireThat(current.batchId === batchId && JSON.stringify(currentCaps.economics) === economics, "PREFLIGHT_BATCH_CHANGED");
  requireThat(BigInt(Math.floor(finalNow / 1000)) <= deadline, "PREFLIGHT_DEADLINE_EXPIRED");
  requireThat(BigInt(built.M) >= minimumOutput(discovery.Q, currentCaps.maxSwapSlippageBps), "PREFLIGHT_SLIPPAGE_TIGHTENED");
  requireThat(fees.gasLimit <= currentCaps.gasCap && fees.maxFeePerGas <= currentCaps.feeCap &&
    fees.gasLimit * fees.maxFeePerGas <= currentCaps.spendCap, "TX_CAP_EXCEEDED");
  return freeze({ status: "SIMULATION_ONLY", simulationOnly: true, H: rpc.pin.hash, S: built.S, Q: built.Q, M: built.M,
    deadline: built.deadline, finalCalldataHash: keccak256(finalTx.data), finalTx, plan: built.plan,
    gasEstimateRaw: gasEstimate.toString(), fees, netEstimate,
    policy: { batchId, expiresAt: current.expiresAt, caps: currentCaps },
    evidence: { pin: rpc.pin, aliases: binding.aliases, independentFamilies: true, traceQualified: true,
      discovery, final, callProfitRaw: callProfit.toString(), probeCalldataHash: keccak256(probeTx.data) }, limitations: LIMITATIONS });
}

module.exports = { prepareRank2SwapPreflight, buildRank2SwapTransaction, validateRank2SwapTrace, minimumOutput, collateralRemainder };
