"use strict";

// Import-inert preparation only. No inventory, runner import, signing, dispatch,
// journal, budget acceptance, or provider selection. All IO belongs to the lease.
const { Interface, AbiCoder, Transaction, keccak256, solidityPacked } = require("../node_modules/ethers");
const { isDeepStrictEqual: equal } = require("node:util");
const guard = require("./wallet-execution-guard.js");
const rank1 = require("./rank1-aave-v4-proof.js");
const next = require("./next-block-execution.js");
const { createNextBlockContext, normalizeSimulationTransaction } = require("./next-block-simulation.js");
const { TARGET: T, POLICY } = rank1, ABI = AbiCoder.defaultAbiCoder();
const ZERO = "0x" + "00".repeat(20), MAX = (1n << 256n) - 1n;
const LENDER = "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb", ROUTER = "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45";
const QUOTER = "0x61ffe014ba17989e743c5f6cb21bf9697530b21e", POOL = next.v3InputPool(T.usde, T.usdc, 100);
const PLAN = "(address spoke,uint256 collateralReserveId,uint256 debtReserveId,address borrower,address debtAsset,address collateralAsset,uint256 flashLoanAmount,uint256 debtToCover,uint256 minSwapOut,uint256 minProfit,uint256 deadline,uint8 venueType,address swapTarget,uint24 uniV3Fee,int128 curveIndexIn,int128 curveIndexOut,bytes customSwapData)";
const EXEC = new Interface([`function execute(${PLAN}) returns(uint256)`, "function nonce() view returns(uint256)",
  "event LiquidatedAndUnwound(uint256 indexed nonce,address indexed spoke,address indexed borrower,address debtAsset,address collateralAsset,uint256 debtRepaid,uint256 collateralSeized,uint256 debtFromSwap,uint256 profitTransferred)"]);
const TOKEN = new Interface(["function balanceOf(address) view returns(uint256)", "function approve(address,uint256) returns(bool)",
  "function transfer(address,uint256) returns(bool)", "function transferFrom(address,address,uint256) returns(bool)",
  "event Transfer(address indexed from,address indexed to,uint256 value)"]);
const FLASH = new Interface(["function flashLoan(address,uint256,bytes)", "function onMorphoFlashLoan(uint256,bytes)"]);
const SPOKE = new Interface(["function liquidationCall(uint256,uint256,address,uint256,bool)"]);
const HUB = new Interface(["function remove(uint256,uint256,address) returns(uint256)",
  "function restore(uint256,uint256,(int256 sharesDelta,int256 offsetRayDelta,uint256 restoredPremiumRay)) returns(uint256)"]);
const SWAP = new Interface(["function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns(uint256)",
  "function swap(address,bool,int256,uint160,bytes) returns(int256,int256)", "function uniswapV3SwapCallback(int256,int256,bytes)"]);
const QUOTE = new Interface(["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns(uint256,uint160,uint32,uint256)"]);
const CALLBACK = ABI.encode(["tuple(bytes path,address payer)"], [[solidityPacked(["address", "uint24", "address"], [T.usde, 100, T.usdc]), T.executor]]);
const BASE = Object.freeze({ spoke: T.spoke, collateralReserveId: T.collateralReserveId, debtReserveId: T.debtReserveId,
  borrower: T.borrower, debtAsset: T.usdc, collateralAsset: T.usde, flashLoanAmount: 360000000000n, debtToCover: MAX,
  minSwapOut: 348000000000n, minProfit: 100000000n, venueType: 0, swapTarget: ZERO, uniV3Fee: 100,
  curveIndexIn: 0, curveIndexOut: 0, customSwapData: "0x" });
const RUNTIME_HASH = "0x9bfeec237d3689863be8dda33148dfecaa28433c115513b2cc211733c593f833";
const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const serial = value => JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v);
const copy = value => JSON.parse(serial(value));
const address = x => typeof x === "string" && /^0x[0-9a-f]{40}$/.test(x);
const bytes = x => typeof x === "string" && /^0x(?:[0-9a-f]{2})*$/.test(x);
class PreparationError extends guard.ExecutionError {}
const need = (condition, code) => { if (!condition) throw new PreparationError(code); };
const amount = value => { const n = guard.uint(value, "RANK1_AMOUNT_INVALID"); need(n <= MAX, "RANK1_AMOUNT_INVALID"); return n; };
const max = (a, b) => a > b ? a : b;
// The current trace facet takes JSON-RPC `data`, whereas the simulator's exact
// transaction commitment deliberately uses `input`.
const currentWire = tx => { const { input, ...wire } = normalizeSimulationTransaction(tx); return freeze({ ...wire, data: input }); };
function canonical(iface, method, data, output = false) {
  try {
    need(bytes(data), "RANK1_ABI_INVALID");
    const decoded = output ? iface.decodeFunctionResult(method, data) : iface.decodeFunctionData(method, data);
    need((output ? iface.encodeFunctionResult(method, decoded) : iface.encodeFunctionData(method, decoded)).toLowerCase() === data, "RANK1_ABI_INVALID");
    return decoded;
  } catch (_) { throw new PreparationError("RANK1_ABI_INVALID"); }
}
function event(iface, method, log) {
  try {
    const d = iface.decodeEventLog(method, log.data, log.topics), e = iface.encodeEventLog(iface.getEvent(method), d);
    need(e.data.toLowerCase() === log.data && equal(e.topics.map(x => x.toLowerCase()), log.topics), "RANK1_LOG_INVALID"); return d;
  } catch (_) { throw new PreparationError("RANK1_LOG_INVALID"); }
}
function settleLogs(result, plan, contractNonce) {
  const transfers = [], events = [], balances = { [T.usde]: 0n, [T.usdc]: 0n };
  need(Array.isArray(result.logs) && result.logs.length <= 10000, "RANK1_LOG_INVALID");
  for (const [index, log] of result.logs.entries()) {
    need(log && address(log.address) && bytes(log.data) && Array.isArray(log.topics) && log.topics.length <= 4 &&
      log.topics.every(t => /^0x[0-9a-f]{64}$/.test(t)) && log.removed !== true, "RANK1_LOG_INVALID");
    if (log.address === T.executor) {
      need(log.topics[0] === EXEC.getEvent("LiquidatedAndUnwound").topicHash, "RANK1_SETTLEMENT_EVENT_INVALID");
      events.push({ index, d: event(EXEC, "LiquidatedAndUnwound", log) });
    }
    if (log.topics[0] !== TOKEN.getEvent("Transfer").topicHash) continue;
    const d = event(TOKEN, "Transfer", log), from = d.from.toLowerCase(), to = d.to.toLowerCase(), value = d.value;
    need(from !== T.owner && (to !== T.owner || log.address === T.usdc && from === T.executor), "RANK1_OWNER_FLOW_INVALID");
    if (from !== T.executor && to !== T.executor) continue;
    need(Object.hasOwn(balances, log.address), "RANK1_TOKEN_FLOW_INVALID");
    balances[log.address] += (to === T.executor ? value : 0n) - (from === T.executor ? value : 0n);
    transfers.push({ index, token: log.address, from, to, value });
  }
  need(events.length === 1 && transfers.length === 7, "RANK1_SETTLEMENT_EVENT_INVALID");
  const { d, index: eventIndex } = events[0];
  need(d.nonce === contractNonce && d.spoke.toLowerCase() === T.spoke && d.borrower.toLowerCase() === T.borrower &&
    d.debtAsset.toLowerCase() === T.usdc && d.collateralAsset.toLowerCase() === T.usde, "RANK1_SETTLEMENT_EVENT_INVALID");
  const D = d.debtRepaid, C = d.collateralSeized, O = d.debtFromSwap, P = d.profitTransferred, F = plan.flashLoanAmount;
  const one = predicate => { const rows = transfers.filter(predicate); need(rows.length === 1, "RANK1_TOKEN_FLOW_INVALID"); return rows[0]; };
  const exact = (token, from, to, value) => one(t => t.token === token && t.from === from && t.to === to && t.value === value);
  const incoming = exact(T.usdc, LENDER, T.executor, F), repaid = exact(T.usdc, T.executor, LENDER, F);
  const spent = exact(T.usde, T.executor, POOL, C), output = exact(T.usdc, POOL, T.executor, O), profit = exact(T.usdc, T.executor, T.owner, P);
  const reserved = [ZERO, T.executor, T.owner, LENDER, ROUTER, POOL, T.usde, T.usdc];
  const debt = one(t => t.token === T.usdc && t.from === T.executor && !reserved.includes(t.to) && t.value === D);
  const collateral = one(t => t.token === T.usde && t.to === T.executor && !reserved.includes(t.from) && t.value === C);
  // V3 pays output first, then collects exact input through its swap callback.
  need(incoming.index < debt.index && incoming.index < collateral.index && debt.index < output.index && collateral.index < output.index &&
    output.index < spent.index && spent.index < repaid.index && repaid.index < profit.index && profit.index < eventIndex &&
    Object.values(balances).every(v => v === 0n), "RANK1_SETTLEMENT_ORDER_INVALID");
  const returned = canonical(EXEC, "execute", result.returnData, true)[0];
  need(C > 0n && D > 0n && D <= F && O >= plan.minSwapOut && O >= D && P === O - D && P >= plan.minProfit && returned === P,
    "RANK1_SETTLEMENT_AMOUNT_INVALID");
  return freeze({ C, D, O, P, F, contractNonce, priorDebt: 0n, priorCollateral: 0n });
}

function traceRows(trace) {
  const rows = [], seen = new Set(); let size = 0;
  function visit(node, context, ancestors, depth) {
    need(node && !seen.has(node) && depth <= 64 && rows.length < 2000 && Object.keys(node).length === 8 &&
      Object.keys(node).every(k => ["type", "from", "to", "input", "output", "value", "reverted", "calls"].includes(k)) &&
      ["CALL", "STATICCALL", "DELEGATECALL"].includes(node.type) && address(node.from) && address(node.to) && bytes(node.input) &&
      bytes(node.output) && node.value === "0" && typeof node.reverted === "boolean" && Array.isArray(node.calls), "RANK1_TRACE_INVALID");
    need(!ancestors.length || node.from === context, "RANK1_TRACE_CALLER_INVALID");
    size += (node.input.length + node.output.length) / 2; need(size <= 2 * 1024 * 1024, "RANK1_TRACE_INVALID");
    seen.add(node); rows.push({ node, ancestors });
    for (const child of node.calls) visit(child, node.type === "DELEGATECALL" ? context : node.to, [...ancestors, node], depth + 1);
  }
  visit(trace?.tree, null, [], 0); need(trace.nodes === rows.length, "RANK1_TRACE_INVALID"); return rows;
}
function settleTrace(trace, wire, plan, contractNonce) {
  const rows = traceRows(trace), root = trace.tree;
  need(root.type === "CALL" && root.from === T.owner && root.to === T.executor && root.input === wire.input, "RANK1_TRACE_TRANSACTION_INVALID");
  if (root.reverted) throw new PreparationError("RANK1_VARIANT_REVERTED");
  need(rows.every(r => !r.node.reverted), "RANK1_TRACE_REVERTED_CHILD");
  const mutations = new Set(), proxies = new Set();
  function frame(node, from, to, type, iface, method, args) {
    need(node && node.from === from && node.to === to && node.type === type, "RANK1_TRACE_PATH_INVALID");
    const input = canonical(iface, method, node.input);
    if (args) need(node.input === iface.encodeFunctionData(method, args).toLowerCase(), "RANK1_TRACE_ARGUMENT_INVALID");
    canonical(iface, method, node.output, true); return input;
  }
  // Authenticate the token entry, not an implementation address. Real USDC is
  // a proxy: permit same-calldata/result delegate chains in the token context,
  // never arbitrary external calls, extra mutations or executor re-entry.
  function tokenChildren(node, token) {
    need(node.calls.length <= 1, "RANK1_TOKEN_PROXY_INVALID");
    for (const child of node.calls) {
      need(child.type === "DELEGATECALL" && child.from === token && child.input === node.input && child.output === node.output &&
        ![T.executor, T.owner, T.usdc, T.usde, LENDER, ROUTER, POOL, T.spoke, ZERO].includes(child.to), "RANK1_TOKEN_PROXY_INVALID");
      proxies.add(child); tokenChildren(child, token);
    }
  }
  function balance(node, from, token, account) {
    frame(node, from, token, "STATICCALL", TOKEN, "balanceOf", [account]); tokenChildren(node, token);
    return canonical(TOKEN, "balanceOf", node.output, true)[0];
  }
  function tokenCall(node, from, token, method, args) {
    frame(node, from, token, "CALL", TOKEN, method, args); tokenChildren(node, token);
    need(canonical(TOKEN, method, node.output, true)[0] === true, "RANK1_TOKEN_RESULT_INVALID"); mutations.add(node);
  }
  frame(root, T.owner, T.executor, "CALL", EXEC, "execute", [plan]);
  need(root.calls.length === 4, "RANK1_TRACE_SEQUENCE_INVALID");
  const priorDebt = balance(root.calls[0], T.executor, T.usdc, T.executor), flash = root.calls[1];
  const f = frame(flash, T.executor, LENDER, "CALL", FLASH, "flashLoan");
  need(f[0].toLowerCase() === T.usdc && f[1] === plan.flashLoanAmount, "RANK1_FLASH_INVALID");
  let payload;
  try { payload = ABI.decode(["uint256", PLAN], f[2]); }
  catch (_) { throw new PreparationError("RANK1_CALLBACK_INVALID"); }
  need(ABI.encode(["uint256", PLAN], payload).toLowerCase() === f[2] && payload[0] === contractNonce &&
    ABI.encode([PLAN], [payload[1]]).toLowerCase() === ABI.encode([PLAN], [plan]).toLowerCase(), "RANK1_CALLBACK_INVALID");
  need(flash.calls.length === 3, "RANK1_TRACE_SEQUENCE_INVALID");
  tokenCall(flash.calls[0], LENDER, T.usdc, "transfer", [T.executor, plan.flashLoanAmount]);
  const callback = flash.calls[1]; frame(callback, LENDER, T.executor, "CALL", FLASH, "onMorphoFlashLoan", [plan.flashLoanAmount, f[2]]);
  const c = callback.calls; need(c.length === 12, "RANK1_TRACE_SEQUENCE_INVALID");
  const before = balance(c[0], T.executor, T.usdc, T.executor), priorCollateral = balance(c[1], T.executor, T.usde, T.executor);
  need(priorDebt === 0n && priorCollateral === 0n && before === priorDebt + plan.flashLoanAmount, "RANK1_INVENTORY_INVALID");
  tokenCall(c[2], T.executor, T.usdc, "approve", [T.spoke, plan.flashLoanAmount]);
  frame(c[3], T.executor, T.spoke, "CALL", SPOKE, "liquidationCall", [T.collateralReserveId, T.debtReserveId, T.borrower, plan.debtToCover, false]);
  tokenCall(c[4], T.executor, T.usdc, "approve", [T.spoke, 0]);
  const after = balance(c[5], T.executor, T.usdc, T.executor), C = balance(c[6], T.executor, T.usde, T.executor) - priorCollateral, D = before - after;
  need(C > 0n && D > 0n && D <= plan.flashLoanAmount, "RANK1_SETTLEMENT_AMOUNT_INVALID");
  tokenCall(c[7], T.executor, T.usde, "approve", [ROUTER, C]);
  const router = c[8]; frame(router, T.executor, ROUTER, "CALL", SWAP, "exactInputSingle", [[T.usde, T.usdc, 100, T.executor, C, plan.minSwapOut, 0]]);
  const O = canonical(SWAP, "exactInputSingle", router.output, true)[0]; need(router.calls.length === 1, "RANK1_TRACE_SEQUENCE_INVALID");
  const pool = router.calls[0]; frame(pool, ROUTER, POOL, "CALL", SWAP, "swap", [T.executor, true, C, 4295128740n, CALLBACK]);
  const delta = canonical(SWAP, "swap", pool.output, true); need(delta[0] === C && delta[1] === -O && pool.calls.length === 4, "RANK1_SWAP_INVALID");
  tokenCall(pool.calls[0], POOL, T.usdc, "transfer", [T.executor, O]);
  const poolBefore = balance(pool.calls[1], POOL, T.usde, POOL), swapCallback = pool.calls[2];
  frame(swapCallback, POOL, ROUTER, "CALL", SWAP, "uniswapV3SwapCallback", [C, -O, CALLBACK]);
  need(swapCallback.calls.length === 1, "RANK1_TRACE_SEQUENCE_INVALID");
  tokenCall(swapCallback.calls[0], ROUTER, T.usde, "transferFrom", [T.executor, POOL, C]);
  need(balance(pool.calls[3], POOL, T.usde, POOL) === poolBefore + C, "RANK1_SWAP_INVALID");
  tokenCall(c[9], T.executor, T.usde, "approve", [ROUTER, 0]);
  need(balance(c[10], T.executor, T.usdc, T.executor) - after === O, "RANK1_SWAP_INVALID");
  tokenCall(c[11], T.executor, T.usdc, "approve", [LENDER, plan.flashLoanAmount]);
  tokenCall(flash.calls[2], LENDER, T.usdc, "transferFrom", [T.executor, LENDER, plan.flashLoanAmount]);
  const P = canonical(EXEC, "execute", root.output, true)[0];
  need(P === O - D && P >= plan.minProfit && O >= plan.minSwapOut && balance(root.calls[2], T.executor, T.usdc, T.executor) === priorDebt + P,
    "RANK1_SETTLEMENT_AMOUNT_INVALID");
  tokenCall(root.calls[3], T.executor, T.usdc, "transfer", [T.owner, P]);
  const liquidation = rows.filter(r => r.ancestors.includes(c[3]));
  const debits = liquidation.filter(r => r.node.to === T.usdc && r.node.input.startsWith(TOKEN.getFunction("transferFrom").selector));
  const credits = liquidation.filter(r => r.node.to === T.usde && r.node.input.startsWith(TOKEN.getFunction("transfer").selector));
  need(debits.length === 1 && credits.length === 1, "RANK1_LIQUIDATION_FLOW_INVALID");
  const debit = debits[0].node, credit = credits[0].node, destination = canonical(TOKEN, "transferFrom", debit.input)[1].toLowerCase();
  need(![ZERO, T.executor, T.owner, ROUTER, LENDER, POOL, T.usde, T.usdc].includes(destination), "RANK1_LIQUIDATION_FLOW_INVALID");
  tokenCall(debit, T.spoke, T.usdc, "transferFrom", [T.executor, destination, D]);
  const siblings = debits[0].ancestors.at(-1).calls, restore = siblings[siblings.indexOf(debit) + 1];
  const restored = frame(restore, T.spoke, destination, "CALL", HUB, "restore");
  need(restored[1] + (restored[2].restoredPremiumRay + 10n ** 27n - 1n) / 10n ** 27n === D, "RANK1_LIQUIDATION_FLOW_INVALID");
  tokenCall(credit, credit.from, T.usde, "transfer", [T.executor, C]);
  const remove = credits[0].ancestors.filter(n => n.type === "CALL" && n.from === T.spoke && n.to === credit.from && n.input.startsWith(HUB.getFunction("remove").selector));
  need(remove.length === 1, "RANK1_LIQUIDATION_FLOW_INVALID");
  const removed = frame(remove[0], T.spoke, credit.from, "CALL", HUB, "remove");
  need(removed[1] === C && removed[2].toLowerCase() === T.executor, "RANK1_LIQUIDATION_FLOW_INVALID");
  for (const { node } of rows) {
    if (proxies.has(node)) continue;
    if (node.to === T.executor) need(node === root || node === callback, "RANK1_TRACE_EXTRA_CALL");
    if (node.to === LENDER) need(node === flash, "RANK1_TRACE_EXTRA_CALL");
    if (node.to === ROUTER) need(node === router || node === swapCallback, "RANK1_TRACE_EXTRA_CALL");
    if (node.to === POOL) need(node === pool, "RANK1_TRACE_EXTRA_CALL");
    if (![T.usdc, T.usde].includes(node.to)) continue;
    if (node.type === "STATICCALL" && node.input.startsWith(TOKEN.getFunction("balanceOf").selector)) {
      canonical(TOKEN, "balanceOf", node.input); canonical(TOKEN, "balanceOf", node.output, true); tokenChildren(node, node.to);
    } else need(mutations.delete(node), "RANK1_TRACE_EXTRA_CALL");
  }
  need(mutations.size === 0, "RANK1_TRACE_EXTRA_CALL");
  return freeze({ C, D, O, P, F: plan.flashLoanAmount, contractNonce, priorDebt, priorCollateral });
}

async function prepareRank1({ lease, active, observation, proofInputs, authorization, budget, now = Date.now } = {}) {
  let fatal = null;
  const safe = error => {
    const code = error instanceof guard.ExecutionError && /^[A-Z][A-Z0-9_]{0,95}$/.test(error.code) ? error.code : "RANK1_PREPARATION_FAILED";
    return new PreparationError(observation?.mode === "CURRENT" &&
      ["TRACE_CAPABILITY_UNAVAILABLE", "TRACE_METHOD_UNAVAILABLE", "TRACE_RESOURCE_UNAVAILABLE"].includes(code)
      ? "RANK1_CURRENT_TRACE_UNAVAILABLE" : code);
  };
  const stop = error => {
    if (error instanceof PreparationError && error.code === "RANK1_VARIANT_REVERTED") return error;
    const failure = safe(error);
    // Availability is the only fallback-eligible stop. Every other failure,
    // including an unclassified one, outranks it regardless of arrival order.
    if (!fatal || fatal.code === "RANK1_CURRENT_TRACE_UNAVAILABLE" && failure.code !== "RANK1_CURRENT_TRACE_UNAVAILABLE") fatal = failure;
    return fatal;
  };
  try {
    need(lease?.current && active && observation && proofInputs && authorization && typeof authorization.assertCurrent === "function" &&
      typeof budget?.assert === "function" && typeof now === "function", "RANK1_ARGUMENT_INVALID");
    const current = lease.current, mode = observation.mode, future = mode === "NEXT_BLOCK_PASSIVE";
    need(mode === "CURRENT" || future, "RANK1_MODE_INVALID");
    need(future ? active !== current && active.nextBlock && active.evidence?.nextBlockQualified === true : active === current,
      "RANK1_MODE_INVALID");
    const pin = freeze(copy(current.pin)), context = future ? freeze(copy(active.nextBlock.context)) : null;
    need(equal(copy(active.pin), pin) && (!future || next.matchesContext(context, createNextBlockContext(pin))), "RANK1_CONTEXT_INVALID");
    const pinKey = p => p && serial({ number: String(p.number), hash: p.hash, timestamp: String(p.timestamp) });
    const inputs = freeze(copy(proofInputs)), initialObservation = serial(observation), caps = freeze({ ...authorization.caps }), capsKey = serial(caps);
    need(inputs.runtime?.schema === "rank1-runtime-proof/v1" && inputs.runtime.targetId === T.id && inputs.runtime.executor === T.executor &&
      inputs.runtime.owner === T.owner && inputs.runtime.runtimeKeccak256 === RUNTIME_HASH &&
      inputs.runtime.source?.runtimeKeccak256 === RUNTIME_HASH && pinKey(inputs.runtime.pin) === pinKey(pin) &&
      inputs.runtime.inventories?.usde?.balanceRaw === "0" && inputs.runtime.inventories?.usdc?.balanceRaw === "0" &&
      pinKey(inputs.feeds?.pin) === pinKey(pin) && String(inputs.feeds.contextTimestamp) === String(context?.timestamp ?? pin.timestamp), "RANK1_PROOF_CONTEXT_INVALID");
    need(caps.gasCap > 0n && caps.gasCap <= BigInt(POLICY.gasLimitCap) && caps.feeCap > 0n && caps.feeCap <= BigInt(POLICY.maxFeePerGasWeiCap) &&
      caps.spendCap > 0n && caps.spendCap <= BigInt(POLICY.nativeSpendWeiCap) && caps.minProfitUsdc >= BigInt(POLICY.minimumProfitUsdcRaw) &&
      amount(caps.minProfitUsdc) <= MAX && caps.maxFlashLoanUsdcRaw === 1008000000000n && caps.maxSlippageBps === 50 && caps.maxVariantsPerContext === 3,
      "RANK1_CAP_INVALID");
    need(observation.id === T.id && observation.spoke === T.spoke && observation.borrower === T.borrower, "RANK1_OBSERVATION_SCOPE_INVALID");
    need(observation.isLiquidatableBothProviders === true && observation.liquidatable === true && amount(observation.healthFactorRaw) > 0n &&
      amount(observation.healthFactorRaw) < 10n ** 18n, future ? "RANK1_FUTURE_NOT_LIQUIDATABLE" : "RANK1_CURRENT_NOT_LIQUIDATABLE");
    const methodNames = ["assertUsable", "nonce", "call", "recheck", ...(!future ? ["estimateGas"] : [])];
    need(methodNames.every(k => typeof active[k] === "function"), "RANK1_FACADE_INVALID");
    const methods = methodNames.map(k => active[k]), authCheck = authorization.assertCurrent, budgetCheck = budget.assert;
    const nextRefs = future ? [active.nextBlock, active.nextBlock.simulate, active.nextBlock.recheck] : null;
    if (future) need(nextRefs.slice(1).every(fn => typeof fn === "function"), "RANK1_FACADE_INVALID");
    const aliases = copy(active.evidence.aliases), evidenceKey = serial(active.evidence), currentEvidenceKey = serial(current.evidence);
    need(Array.isArray(aliases) && aliases.length === 2 && aliases.every(a => Number.isSafeInteger(a) && a > 0) && aliases[0] !== aliases[1] &&
      equal(aliases, current.evidence.aliases) && active.evidence.independentFamilies === true && active.evidence.fixedProviderPair === true &&
      active.evidence.strictEvidence === true && active.evidence.rawTimestamp === true, "RANK1_PAIR_INVALID");
    let lastNow = now(); need(Number.isSafeInteger(lastNow) && lastNow >= pin.timestamp * 1000, "RANK1_CLOCK_INVALID");
    const deadline = BigInt(Math.floor(lastNow / 1000) + 120);
    need(deadline >= BigInt(context?.timestamp ?? pin.timestamp) && deadline <= BigInt(context?.timestamp ?? Math.floor(lastNow / 1000)) + 120n, "RANK1_DEADLINE_INVALID");
    let facet, facetRefs;
    const binding = () => {
      need(lease.current === current && serial(current.pin) === serial(pin) && serial(active.pin) === serial(pin) &&
        serial(active.evidence) === evidenceKey && serial(current.evidence) === currentEvidenceKey && serial(observation) === initialObservation &&
        serial(proofInputs) === serial(inputs) && serial(authorization.caps) === capsKey && authorization.assertCurrent === authCheck &&
        budget.assert === budgetCheck && methodNames.every((k, i) => active[k] === methods[i]), "RANK1_CONTEXT_CHANGED");
      if (future) need(active.nextBlock === nextRefs[0] && active.nextBlock.simulate === nextRefs[1] && active.nextBlock.recheck === nextRefs[2] &&
        next.matchesContext(active.nextBlock.context, context), "RANK1_CONTEXT_CHANGED");
      if (facet) need(facet.trace === facetRefs[0] && facet.assertUsable === facetRefs[1] && serial(facet.evidence) === facetRefs[2] &&
        equal(copy(facet.pin), pin) && facet.evidence.traceQualified === true && facet.evidence.fixedProviderPair === true &&
        facet.evidence.hashPinnedBlockNumberVerified === true && facet.evidence.unknownHashRejected === true &&
        facet.evidence.independentFamilies === true && equal(facet.evidence.aliases, aliases), "RANK1_TRACE_PAIR_INVALID");
    };
    const check = (draining = false) => {
      if (fatal && !draining) throw fatal;
      binding();
      active.assertUsable(); current.assertUsable(); budget.assert(lease, active, context);
      const authorized = authCheck();
      if (authorized !== undefined) { Promise.resolve(authorized).catch(() => {}); throw new PreparationError("RANK1_AUTHORIZATION_INVALID"); }
      const time = now(); need(Number.isSafeInteger(time) && time >= lastNow && BigInt(Math.floor(time / 1000)) < deadline &&
        time < Date.parse(POLICY.expiresAt) && (!future || time < context.timestamp * 1000), "RANK1_CLOCK_INVALID"); lastNow = time;
      // Assertion/clock hooks cannot revoke the facade or mutate its binding and
      // then permit the next asynchronous operation to start.
      active.assertUsable(); current.assertUsable(); facet?.assertUsable(); budget.assert(lease, active, context); binding();
    };
    // Nested final call/gas pairs share the existing width-two IO bound with
    // the other candidate. A queued job rechecks trust/budget before dispatch.
    let inFlight = 0; const ioWaiters = [];
    const invoke = async (work, ordinary = false) => {
      let release;
      try {
        check();
        if (inFlight === 2) await new Promise(resolve => ioWaiters.push(resolve));
        else inFlight++;
        release = () => { const next = ioWaiters.shift(); if (next) next(); else inFlight--; };
        check(); let value, error, failed = false;
        try { value = await work(); } catch (caught) {
          failed = true;
          error = ordinary && caught instanceof guard.ExecutionError && ["CALL_REVERTED", "NEXT_BLOCK_REVERTED"].includes(caught.code)
            ? new PreparationError("RANK1_VARIANT_REVERTED") : caught;
          stop(error);
        }
        // A stopped sibling must not hide this response or fresh revocation.
        // Successful responses still reach their local validators below; every
        // subsequent IO/scheduling boundary remains blocked by check().
        try { check(true); } catch (caught) { stop(caught); }
        if (failed) throw fatal || error;
        return value;
      } catch (error) { throw stop(error); }
      finally { release?.(); }
    };
    check();
    if (!future) {
      need(typeof lease.qualifyCurrentTrace === "function", "RANK1_CURRENT_TRACE_UNAVAILABLE");
      facet = await invoke(() => lease.qualifyCurrentTrace());
      need(facet && typeof facet.trace === "function" && typeof facet.assertUsable === "function", "RANK1_TRACE_FACADE_INVALID");
      facetRefs = [facet.trace, facet.assertUsable, serial(facet.evidence)]; check();
    }
    const nonce = Number(amount(await invoke(() => active.nonce(T.owner)))); need(Number.isSafeInteger(nonce), "RANK1_NONCE_INVALID");
    const fees = guard.buildFeePolicy(caps.gasCap, pin.baseFeePerGas, caps);
    const env = freeze({ type: 2, chainId: 1, from: T.owner, nonce, value: 0n, ...fees, accessList: [] });
    const exact = (to, data, price = fees) => { const tx = freeze({ ...env, ...price, to, data }); guard.validateTransaction(tx, caps); return tx; };
    const call = async (tx, ordinary = false) => {
      try {
        if (!future) return { returnData: await invoke(() => active.call(currentWire(tx)), ordinary) };
        const result = await invoke(() => active.nextBlock.simulate(tx), ordinary);
        // Accept only the normalized sandbox result, never extra override or
        // pending-state assertions alongside an otherwise matching context.
        need(result && Object.keys(result).every(key => ["context", "returnData", "gasUsed", "gasLimit", "logs", "transactionHash"].includes(key)),
          "NEXT_BLOCK_SIMULATION_PROOF_INVALID");
        return next.checkedSimulation(result, tx, context);
      } catch (error) { throw stop(error); }
    };
    const contractNonce = canonical(EXEC, "nonce", (await call(exact(T.executor, EXEC.encodeFunctionData("nonce")))).returnData, true)[0] + 1n;
    need(contractNonce <= MAX, "RANK1_NONCE_INVALID");
    const simulate = async tx => {
      try {
        return future ? settleLogs(await call(tx, true), canonical(EXEC, "execute", tx.data)[0], contractNonce)
          : settleTrace(await invoke(() => facet.trace(currentWire(tx)), true), normalizeSimulationTransaction(tx), canonical(EXEC, "execute", tx.data)[0], contractNonce);
      } catch (error) { throw stop(error); }
    };
    const templates = [BASE, { ...BASE, flashLoanAmount: 1008000000000n }, { ...BASE, debtToCover: BASE.flashLoanAmount }];
    const outcomes = templates.map((_, index) => ({ index, status: "SKIPPED" })); let cursor = 0, hasVerified = false;
    const worker = async () => {
      while (!fatal && !hasVerified && cursor < templates.length) {
        const index = cursor++;
        try {
          check(); const discoveryPlan = freeze({ ...templates[index], deadline, minSwapOut: 1n, minProfit: caps.minProfitUsdc });
          const discoveryTx = exact(T.executor, EXEC.encodeFunctionData("execute", [discoveryPlan]));
          const discovered = await simulate(discoveryTx); check();
          const quoteTx = exact(QUOTER, QUOTE.encodeFunctionData("quoteExactInputSingle", [[T.usde, T.usdc, discovered.C, 100, 0]]));
          const Q = canonical(QUOTE, "quoteExactInputSingle", (await call(quoteTx)).returnData, true)[0];
          const minOut = max(BASE.minSwapOut, (Q * 9950n + 9999n) / 10000n);
          need(Q > 0n && Q >= minOut, "RANK1_QUOTE_BELOW_FLOOR");
          const plan = freeze({ ...templates[index], deadline, minSwapOut: minOut, minProfit: max(caps.minProfitUsdc, minOut > discovered.D ? minOut - discovered.D : 0n) });
          const data = EXEC.encodeFunctionData("execute", [plan]);
          const boundedFees = future ? fees : guard.buildFees(await invoke(() => active.estimateGas(currentWire(exact(T.executor, data))), true), pin.baseFeePerGas, caps);
          // Value only the final calldata's enforced floor. This before-gas
          // bound is independent of the diagnostic fees and is never a quote
          // or simulated surplus. Fix the profit-aware envelope before proof.
          const beforeGas = rank1.valueRank1ProfitBeforeGas({ profitUsdcRaw: plan.minProfit, feeds: inputs.feeds }).conservativeProfitBeforeGasWei;
          const finalFees = guard.buildFeePolicy(boundedFees.gasLimit, pin.baseFeePerGas, caps, BigInt(beforeGas));
          const tx = exact(T.executor, data, finalFees), economics = rank1.valueRank1Profit({ profitUsdcRaw: plan.minProfit, fees: tx, feeds: inputs.feeds });
          const settled = await simulate(tx);
          need(equal(settled, discovered), "RANK1_DISCOVERY_FINAL_MISMATCH");
          check();
          let finalGasEstimate = null;
          if (!future) {
            const results = await Promise.allSettled([
              async () => {
                need(canonical(EXEC, "execute", (await call(tx, true)).returnData, true)[0] === settled.P, "RANK1_FINAL_CALL_MISMATCH");
              },
              async () => {
                const gas = amount(await invoke(() => active.estimateGas(currentWire(tx)), true));
                need(gas > 0n && gas <= tx.gasLimit, "RANK1_FINAL_GAS_INVALID"); return gas;
              },
            ].map(async work => { try { return await work(); } catch (error) { throw stop(error); } }));
            // Both successful responses are validated, even if the other job
            // reverted or became unavailable first. No winner before the drain.
            try { check(true); } catch (error) { stop(error); }
            if (fatal) throw fatal;
            const rejected = results.find(row => row.status === "rejected"); if (rejected) throw rejected.reason;
            finalGasEstimate = results[1].value;
          }
          check(); outcomes[index] = { index, transaction: tx, plan, discovered, settlement: settled, quote: { C: discovered.C, Q, minOut, contextTimestamp: context?.timestamp ?? pin.timestamp }, economics, finalGasEstimate };
          hasVerified = true;
        } catch (error) {
          if (error instanceof PreparationError && error.code === "RANK1_VARIANT_REVERTED" && !fatal) outcomes[index] = { index, status: "REVERTED" };
          else stop(error);
        }
      }
    };
    await Promise.allSettled([worker(), worker()]);
    try { check(true); } catch (error) { stop(error); }
    if (fatal) throw fatal;
    const verified = outcomes.filter(r => r?.transaction);
    need(verified.length > 0, "RANK1_NO_VERIFIED_VARIANT");
    let best = verified[0]; for (const row of verified.slice(1)) if (BigInt(row.economics.afterGas.netNativeWei) > BigInt(best.economics.afterGas.netNativeWei)) best = row;
    await invoke(() => future ? active.nextBlock.recheck() : active.recheck()); check();
    const wire = normalizeSimulationTransaction(best.transaction), { from, ...unsigned } = best.transaction;
    const proof = freeze(copy({ schema: "rank1-settlement-proof/v1", targetId: T.id, mode, parent: pin, context, plan: best.plan,
      transaction: wire, unsignedTransactionHash: Transaction.from(unsigned).unsignedHash, calldataHash: keccak256(best.transaction.data),
      runtime: inputs.runtime, quote: best.quote, discovery: best.discovered, settlement: best.settlement, economics: best.economics,
      finalGasEstimateRaw: best.finalGasEstimate, selectedVariant: best.index,
      variants: outcomes.map(r => r.transaction ? { index: r.index, status: "VERIFIED", netNativeWei: r.economics.afterGas.netNativeWei } : r),
      settlementVerified: true, realizedProfit: "UNKNOWN" }));
    check(); return freeze({ transaction: best.transaction, caps, conservativeProfitBeforeGasWei: BigInt(best.economics.conservativeProfitBeforeGasWei), proof });
  } catch (error) { throw safe(error); }
}
module.exports = { prepareRank1 };
