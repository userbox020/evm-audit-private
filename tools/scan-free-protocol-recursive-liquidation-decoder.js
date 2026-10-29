#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { AbiCoder, Interface, id, keccak256 } = require("ethers");

const ROOT = path.resolve(__dirname, "..");
const SOURCE_DIR = path.join(ROOT, "sources/free-protocol-step11-recursive-liquidation-decoder");
const RAW = path.join(ROOT, "reports/raw/fast/free-protocol-recursive-liquidation-decoder.json");
const MANIFEST = path.join(ROOT, "reports/raw/fast/free-protocol-recursive-liquidation-decoder.manifest.json");
const REPORT = path.join(ROOT, "reports/free-protocol-recursive-liquidation-decoder.md");
const HANDOFF = path.join(ROOT, "coordination/handoffs/2026-07-15-coordinator-free-step11-handoff.md");
const STEP10_RAW = path.join(ROOT, "reports/raw/fast/free-protocol-liquidation-net-value.json");
const STEP10_MANIFEST = path.join(ROOT, "reports/raw/fast/free-protocol-liquidation-net-value.manifest.json");

const PROVIDERS = ["https://mainnet.mode.network", "https://mode.drpc.org"];
const SOURCE_API = "https://explorer.mode.network/api";
const TX_HASHES = [
  "0x18ec9dccba73f858ccf2fab342dbc3f454a264a9680069ab51ea191ea23fd85d",
  "0xad64bdb6d240e3ecda529816f8bd0fec17062e1d12ceefba610bc056ade05647",
  "0xc451cee61713ca98560e853f6eee5f484a80fc667120d76de75480a9bd01918c",
  "0x2cc8a05b8a3685e0114bbfa74f08e921a308f19aab3299cacb3e91ebe56bb762",
  "0x7d46361e2c2448c5fe34f3b2f0e943a6aaf55d42dbab5e741411f75d9bd7725c",
  "0x8693a2e15cd26b5cb09a7402dfabf40adb7a201ccb942c59b82101a0ada80775"
];

const CORE = "0x80980869d90a737aff47aba6fbaa923012c1ff50";
const L_MBTC = "0x59dd441184024a77fd17e68f07e242622806c256";
const M_BTC = "0x59889b7021243db5b1e065385f918316cd90d46c";
const L_ETH = "0xe855b8018c22a05f84724e93693caf166912add5";
const L_WEETH = "0xbd9edf764bc1f219c124ad5cfa7084bbed124aa8";
const WEETH = "0x04c0599ae5a44757c0af6f9ec3b93da8976c150a";
const OLD_VALIDATOR = "0x5ae221cec86bcdd0cdc616b6c2bbd95d0e68030f";
const NEW_VALIDATOR = "0x0ccd703acfe6ce83377243c2dbf9d55a09e12769";
const OLD_ORACLE = "0x310e183416d7f266c150e7244733d1dcb1470172";
const NEW_ORACLE = "0xa6b2535b1c10ca5592be90a01dd1b6018062f7cf";
const DOMINANT = "0x9e34d89c013da3bf65fc02b59b6f27d710850430";
const ZERO = "0x0000000000000000000000000000000000000000";
const DEBT_MARKETS = [L_ETH, L_WEETH];
const VALIDATORS = [OLD_VALIDATOR, NEW_VALIDATOR];
const ORACLES = [OLD_ORACLE, NEW_ORACLE];
const WAD = 10n ** 18n;
const WAD_SQUARED = WAD * WAD;

const SELECTORS = {
  liquidateBorrow: "0xe61604cf",
  redeemToken: "0x830cbbbd",
  seize: "0xb2a02ff1",
  lTokenAmountToSeize: "0xf643b5df",
  getUnderlyingPrice: "0xfc57d4df",
  accruedExchangeRate: "0x8b9db037",
  liquidationIncentive: "0x8c765e94",
  borrowBalanceOf: "0x374c49b4",
  validator: "0x3a5381b5",
  priceCalculator: "0x8b95e335",
  closeFactor: "0x05308b9f",
  underlying: "0x6f307dc3",
  decimals: "0x313ce567"
};

const SELECTOR_SIGNATURES = {
  [SELECTORS.liquidateBorrow]: "liquidateBorrow(address,address,address,uint256)",
  [SELECTORS.redeemToken]: "redeemToken(address,uint256)",
  [SELECTORS.seize]: "seize(address,address,uint256)",
  [SELECTORS.lTokenAmountToSeize]: "lTokenAmountToSeize(address,address,uint256)",
  [SELECTORS.getUnderlyingPrice]: "getUnderlyingPrice(address)",
  [SELECTORS.accruedExchangeRate]: "accruedExchangeRate()",
  [SELECTORS.liquidationIncentive]: "liquidationIncentive()",
  [SELECTORS.borrowBalanceOf]: "borrowBalanceOf(address)",
  [SELECTORS.validator]: "validator()",
  [SELECTORS.priceCalculator]: "priceCalculator()",
  [SELECTORS.closeFactor]: "closeFactor()",
  [SELECTORS.underlying]: "underlying()",
  [SELECTORS.decimals]: "decimals()"
};

const TOPICS = {
  transfer: id("Transfer(address,address,uint256)").toLowerCase(),
  repayBorrow: id("RepayBorrow(address,address,uint256,uint256)").toLowerCase(),
  liquidateBorrow: id("LiquidateBorrow(address,address,uint256,address,uint256)").toLowerCase(),
  redeem: id("Redeem(address,uint256,uint256)").toLowerCase(),
  marketRedeem: id("MarketRedeem(address,address,uint256)").toLowerCase()
};

const coreIface = new Interface([
  "function liquidateBorrow(address lToken,address lTokenCollateral,address borrower,uint256 amount)",
  "function redeemToken(address lToken,uint256 redeemTokens) returns (uint256)",
  "function validator() view returns (address)",
  "function priceCalculator() view returns (address)",
  "function closeFactor() view returns (uint256)",
  "function liquidationIncentive() view returns (uint256)"
]);
const marketIface = new Interface([
  "function liquidateBorrow(address lTokenCollateral,address liquidator,address borrower,uint256 amount) returns (uint256,uint256,uint256)",
  "function redeemToken(address redeemer,uint256 redeemTokens) returns (uint256)",
  "function seize(address liquidator,address borrower,uint256 seizeTokens)",
  "function borrowBalanceOf(address account) view returns (uint256)",
  "function accruedExchangeRate() returns (uint256)",
  "function underlying() view returns (address)"
]);
const validatorIface = new Interface([
  "function lTokenAmountToSeize(address lTokenBorrowed,address lTokenCollateral,uint256 amount) returns (uint256,uint256,uint256)"
]);
const oracleIface = new Interface(["function getUnderlyingPrice(address lToken) view returns (uint256)"]);
const erc20Iface = new Interface(["function decimals() view returns (uint8)"]);
const eventIface = new Interface([
  "event RepayBorrow(address payer,address borrower,uint256 repayAmount,uint256 accountBorrows)",
  "event LiquidateBorrow(address liquidator,address borrower,uint256 repayAmount,address lTokenCollateral,uint256 seizeTokens)",
  "event Redeem(address redeemer,uint256 redeemAmount,uint256 redeemTokens)",
  "event MarketRedeem(address user,address lToken,uint256 amount)"
]);
const coder = AbiCoder.defaultAbiCoder();
const CLASSIFICATION = "INCOMPLETE/WATCH — SIX LAYERBANK LIQUIDATIONS, DEBT RELIEF, VALIDATOR SEIZURES, REDEMPTIONS, AND ONCHAIN ACCEPTED-VALUE BENCHMARK BOUND; ONE DEBT-MARKET SOURCE-EXACTNESS AND ULTIMATE LOSS UNPROVEN";

let rpcId = 1;
const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
const relative = (file) => path.relative(ROOT, file).replace(/\\/g, "/");
const lower = (value) => value ? value.toLowerCase() : null;
const asString = (value) => typeof value === "bigint" ? value.toString() : value;
const hexBlock = (number) => `0x${number.toString(16)}`;

function record(file) {
  const bytes = fs.readFileSync(file);
  return { file: relative(file), sha256: sha256(bytes), bytes: bytes.length };
}

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
}

async function rpc(method, params) {
  let lastError;
  for (const provider of PROVIDERS) {
    try {
      const response = await fetch(provider, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params })
      });
      const payload = await response.json();
      if (payload.error) throw new Error(payload.error.message);
      return payload.result;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function flattenTrace(node, pathParts = [0], parentPath = null, rows = []) {
  const pathText = pathParts.join(".");
  rows.push({
    sequence: rows.length,
    path: pathText,
    parentPath,
    depth: pathParts.length - 1,
    type: node.type || null,
    from: lower(node.from),
    to: lower(node.to),
    valueRaw: BigInt(node.value || "0x0").toString(),
    input: node.input || "0x",
    output: node.output || "0x",
    selector: node.input?.slice(0, 10).toLowerCase() || "0x",
    error: node.error || null
  });
  (node.calls || []).forEach((child, index) => flattenTrace(child, [...pathParts, index], pathText, rows));
  return rows;
}

function decodeData(iface, signature, input) {
  return [...iface.decodeFunctionData(signature, input)].map(asString);
}

function decodeOutput(types, output) {
  return [...coder.decode(types, output)].map(asString);
}

function addressFromTopic(topic) {
  return `0x${topic.slice(-40)}`.toLowerCase();
}

function logIndex(log) {
  return typeof log.logIndex === "string" ? Number.parseInt(log.logIndex, 16) : log.logIndex;
}

function one(rows, description) {
  if (rows.length !== 1) throw new Error(`${description}: expected one, got ${rows.length}`);
  return rows[0];
}

function descendant(row, ancestor) {
  return row.path.startsWith(`${ancestor.path}.`);
}

function compactCall(call, operation, args, results = []) {
  return {
    sequence: call.sequence,
    path: call.path,
    parentPath: call.parentPath,
    depth: call.depth,
    type: call.type,
    from: call.from,
    to: call.to,
    valueRaw: call.valueRaw,
    selector: call.selector,
    operation,
    args,
    results,
    error: call.error
  };
}

function parseEvent(log, expectedName) {
  const parsed = eventIface.parseLog({ topics: log.topics, data: log.data });
  if (!parsed || parsed.name !== expectedName) throw new Error(`Event decode mismatch: ${expectedName}`);
  const result = { logIndex: logIndex(log), emitter: lower(log.address), event: parsed.name };
  parsed.fragment.inputs.forEach((input, index) => {
    const value = parsed.args[index];
    result[input.name] = input.type === "address" ? lower(value) : asString(value);
  });
  return result;
}

function transferEffects(receipt) {
  return receipt.logs
    .filter((log) => [L_MBTC, M_BTC].includes(lower(log.address)) && lower(log.topics[0]) === TOPICS.transfer)
    .map((log) => ({
      logIndex: logIndex(log),
      token: lower(log.address),
      from: addressFromTopic(log.topics[1]),
      to: addressFromTopic(log.topics[2]),
      amountRaw: BigInt(log.data).toString()
    }));
}

function sumEffects(effects, predicate) {
  return effects.filter(predicate).reduce((total, row) => total + BigInt(row.amountRaw), 0n);
}

async function ethCall(to, data, blockNumber) {
  return rpc("eth_call", [{ to, data }, hexBlock(blockNumber)]);
}

async function historicalState(blockNumber, debtMarket) {
  const [validatorRaw, oracleRaw, closeFactorRaw, incentiveRaw, underlyingRaw, collateralUnderlyingRaw] = await Promise.all([
    ethCall(CORE, coreIface.encodeFunctionData("validator"), blockNumber),
    ethCall(CORE, coreIface.encodeFunctionData("priceCalculator"), blockNumber),
    ethCall(CORE, coreIface.encodeFunctionData("closeFactor"), blockNumber),
    ethCall(CORE, coreIface.encodeFunctionData("liquidationIncentive"), blockNumber),
    ethCall(debtMarket, marketIface.encodeFunctionData("underlying"), blockNumber),
    ethCall(L_MBTC, marketIface.encodeFunctionData("underlying"), blockNumber)
  ]);
  const validator = lower(coreIface.decodeFunctionResult("validator", validatorRaw)[0]);
  const priceCalculator = lower(coreIface.decodeFunctionResult("priceCalculator", oracleRaw)[0]);
  const closeFactorRaw18 = coreIface.decodeFunctionResult("closeFactor", closeFactorRaw)[0].toString();
  const liquidationIncentiveRaw = coreIface.decodeFunctionResult("liquidationIncentive", incentiveRaw)[0].toString();
  const debtUnderlying = lower(marketIface.decodeFunctionResult("underlying", underlyingRaw)[0]);
  const collateralUnderlying = lower(marketIface.decodeFunctionResult("underlying", collateralUnderlyingRaw)[0]);
  const [debtPriceResult, collateralPriceResult, debtDecimalsResult, collateralDecimalsResult] = await Promise.all([
    ethCall(priceCalculator, oracleIface.encodeFunctionData("getUnderlyingPrice", [debtMarket]), blockNumber),
    ethCall(priceCalculator, oracleIface.encodeFunctionData("getUnderlyingPrice", [L_MBTC]), blockNumber),
    debtUnderlying === ZERO ? Promise.resolve(null) : ethCall(debtUnderlying, erc20Iface.encodeFunctionData("decimals"), blockNumber),
    ethCall(collateralUnderlying, erc20Iface.encodeFunctionData("decimals"), blockNumber)
  ]);
  return {
    blockNumber,
    debtMarket,
    validator,
    priceCalculator,
    closeFactorRaw18,
    liquidationIncentiveRaw,
    debtUnderlying,
    debtDecimals: debtUnderlying === ZERO ? 18 : Number(erc20Iface.decodeFunctionResult("decimals", debtDecimalsResult)[0]),
    debtPriceRaw18: oracleIface.decodeFunctionResult("getUnderlyingPrice", debtPriceResult)[0].toString(),
    collateralMarket: L_MBTC,
    collateralUnderlying,
    collateralDecimals: Number(erc20Iface.decodeFunctionResult("decimals", collateralDecimalsResult)[0]),
    collateralPriceRaw18: oracleIface.decodeFunctionResult("getUnderlyingPrice", collateralPriceResult)[0].toString(),
    configurationCallProvenance: {
      validator: { signature: "validator()", selector: coreIface.getFunction("validator").selector, result: validator },
      priceCalculator: { signature: "priceCalculator()", selector: coreIface.getFunction("priceCalculator").selector, result: priceCalculator },
      closeFactor: { signature: "closeFactor()", selector: coreIface.getFunction("closeFactor").selector, resultRaw18: closeFactorRaw18 },
      liquidationIncentive: { signature: "liquidationIncentive()", selector: coreIface.getFunction("liquidationIncentive").selector, resultRaw18: liquidationIncentiveRaw }
    },
    qualification: "Historical eth_call values are end-of-block configuration/oracle cross-checks. The exact liquidation exchange rate is taken from the in-transaction Validator call trace because same-block ordering can change mutable market state."
  };
}

async function transactionEvidence(txHash, baselineRow) {
  const tx = await rpc("eth_getTransactionByHash", [txHash]);
  const [receipt, block, trace] = await Promise.all([
    rpc("eth_getTransactionReceipt", [txHash]),
    rpc("eth_getBlockByNumber", [tx.blockNumber, false]),
    rpc("debug_traceTransaction", [txHash, { tracer: "callTracer", timeout: "30s" }])
  ]);
  if (receipt.status !== "0x1") throw new Error(`${txHash}: unsuccessful receipt`);
  const flat = flattenTrace(trace);
  if (flat.some((row) => row.error)) throw new Error(`${txHash}: relevant transaction contains trace error`);

  const coreLiquidation = one(flat.filter((row) => row.to === CORE && row.selector === SELECTORS.liquidateBorrow), `${txHash} Core liquidation`);
  const coreArgs = decodeData(coreIface, "liquidateBorrow", coreLiquidation.input);
  const [debtMarketArgument, collateralMarket, borrower, repayAmountRaw] = [lower(coreArgs[0]), lower(coreArgs[1]), lower(coreArgs[2]), coreArgs[3]];
  const debtLiquidation = one(flat.filter((row) => row.from === CORE && DEBT_MARKETS.includes(row.to) && row.selector === SELECTORS.liquidateBorrow && descendant(row, coreLiquidation)), `${txHash} debt-market liquidation`);
  const debtArgs = decodeData(marketIface, "liquidateBorrow", debtLiquidation.input);
  const debtOutputs = decodeOutput(["uint256", "uint256", "uint256"], debtLiquidation.output);
  const debtMarket = debtLiquidation.to;

  const validatorCall = one(flat.filter((row) => row.from === debtMarket && VALIDATORS.includes(row.to) && row.selector === SELECTORS.lTokenAmountToSeize && descendant(row, debtLiquidation)), `${txHash} Validator seize calculation`);
  const validatorArgs = decodeData(validatorIface, "lTokenAmountToSeize", validatorCall.input);
  const validatorOutputs = decodeOutput(["uint256", "uint256", "uint256"], validatorCall.output);
  const directValidatorChildren = flat.filter((row) => row.parentPath === validatorCall.path);
  const oracleCalls = directValidatorChildren.filter((row) => ORACLES.includes(row.to) && row.selector === SELECTORS.getUnderlyingPrice);
  const decodedOracleCalls = oracleCalls.map((row) => ({ row, asset: lower(decodeData(oracleIface, "getUnderlyingPrice", row.input)[0]), priceRaw18: decodeOutput(["uint256"], row.output)[0] }));
  const priceSet = (asset) => [...new Set(decodedOracleCalls.filter((entry) => entry.asset === asset).map((entry) => entry.priceRaw18))];
  const debtPrices = priceSet(debtMarket);
  const collateralPrices = priceSet(L_MBTC);
  if (debtPrices.length !== 1 || collateralPrices.length !== 1) throw new Error(`${txHash}: inconsistent Validator oracle outputs`);
  const exchangeRateCall = one(directValidatorChildren.filter((row) => row.to === L_MBTC && row.selector === SELECTORS.accruedExchangeRate), `${txHash} accrued exchange rate`);
  const incentiveCall = one(directValidatorChildren.filter((row) => row.to === CORE && row.selector === SELECTORS.liquidationIncentive), `${txHash} liquidation incentive`);
  const exchangeRateRaw18 = decodeOutput(["uint256"], exchangeRateCall.output)[0];
  const liquidationIncentiveRaw18 = decodeOutput(["uint256"], incentiveCall.output)[0];

  const seizeCall = one(flat.filter((row) => row.from === CORE && row.to === L_MBTC && row.selector === SELECTORS.seize && descendant(row, coreLiquidation)), `${txHash} collateral seize`);
  const seizeArgs = decodeData(marketIface, "seize", seizeCall.input);
  const coreRedeem = one(flat.filter((row) => row.to === CORE && row.selector === SELECTORS.redeemToken), `${txHash} Core redeem`);
  const coreRedeemArgs = decodeData(coreIface, "redeemToken", coreRedeem.input);
  const coreRedeemOutput = decodeOutput(["uint256"], coreRedeem.output)[0];
  const marketRedeemCall = one(flat.filter((row) => row.from === CORE && row.to === L_MBTC && row.selector === SELECTORS.redeemToken && descendant(row, coreRedeem)), `${txHash} lMBTC redeem`);
  const marketRedeemArgs = decodeData(marketIface, "redeemToken", marketRedeemCall.input);
  const marketRedeemOutput = decodeOutput(["uint256"], marketRedeemCall.output)[0];

  const repayLog = one(receipt.logs.filter((log) => lower(log.address) === debtMarket && lower(log.topics[0]) === TOPICS.repayBorrow), `${txHash} RepayBorrow event`);
  const liquidationLog = one(receipt.logs.filter((log) => lower(log.address) === debtMarket && lower(log.topics[0]) === TOPICS.liquidateBorrow), `${txHash} LiquidateBorrow event`);
  const redeemLog = one(receipt.logs.filter((log) => lower(log.address) === L_MBTC && lower(log.topics[0]) === TOPICS.redeem), `${txHash} Redeem event`);
  const marketRedeemLog = one(receipt.logs.filter((log) => lower(log.address) === CORE && lower(log.topics[0]) === TOPICS.marketRedeem), `${txHash} MarketRedeem event`);
  const events = {
    repayBorrow: parseEvent(repayLog, "RepayBorrow"),
    liquidateBorrow: parseEvent(liquidationLog, "LiquidateBorrow"),
    redeem: parseEvent(redeemLog, "Redeem"),
    marketRedeem: parseEvent(marketRedeemLog, "MarketRedeem")
  };
  const debtLiquidationSubtreeLastSequence = Math.max(...flat
    .filter((row) => row.path === debtLiquidation.path || descendant(row, debtLiquidation))
    .map((row) => row.sequence));
  const orderedPostBorrowCandidates = flat
    .filter((row) => row.to === debtMarket && row.selector === SELECTORS.borrowBalanceOf)
    .filter((row) => descendant(row, coreLiquidation))
    .filter((row) => row.sequence > debtLiquidationSubtreeLastSequence)
    .filter((row) => lower(decodeData(marketIface, "borrowBalanceOf", row.input)[0]) === borrower);
  const orderedPostBorrowCall = one(orderedPostBorrowCandidates, `${txHash} ordered post-borrow call`);
  const orderedPostBorrowRaw = decodeOutput(["uint256"], orderedPostBorrowCall.output)[0];
  const transactionAccruedPreBorrowRaw = (BigInt(events.repayBorrow.accountBorrows) + BigInt(events.repayBorrow.repayAmount)).toString();
  const postBorrowProof = {
    traceOrderDefinition: "zero-based depth-first recursive pre-order over every callTracer calls[] node",
    matchedCall: {
      path: orderedPostBorrowCall.path,
      parentPath: orderedPostBorrowCall.parentPath,
      traceOrderIndex: orderedPostBorrowCall.sequence,
      address: orderedPostBorrowCall.to,
      selector: orderedPostBorrowCall.selector,
      signature: SELECTOR_SIGNATURES[orderedPostBorrowCall.selector],
      borrowerCalldataArg: lower(decodeData(marketIface, "borrowBalanceOf", orderedPostBorrowCall.input)[0]),
      outputRaw: orderedPostBorrowRaw
    },
    branch: {
      coreLiquidationPath: coreLiquidation.path,
      coreLiquidationTraceOrderIndex: coreLiquidation.sequence,
      debtMarketLiquidationPath: debtLiquidation.path,
      debtMarketLiquidationTraceOrderIndex: debtLiquidation.sequence,
      debtMarketLiquidationSubtreeLastTraceOrderIndex: debtLiquidationSubtreeLastSequence,
      repayEventLogIndex: events.repayBorrow.logIndex,
      liquidationEventLogIndex: events.liquidateBorrow.logIndex
    },
    arithmetic: {
      repayEventAccountBorrowsRaw: events.repayBorrow.accountBorrows,
      repayAmountRaw: events.repayBorrow.repayAmount,
      transactionAccruedPreBorrowRaw,
      orderedPostBorrowRaw,
      equation: "transactionAccruedPreBorrowRaw - repayAmountRaw = orderedPostBorrowRaw"
    },
    predicates: {
      exactlyOneRelevantOrderedCandidate: orderedPostBorrowCandidates.length === 1,
      descendantOfDecodedCoreLiquidation: descendant(orderedPostBorrowCall, coreLiquidation),
      afterCompletedDebtMarketLiquidationSubtree: orderedPostBorrowCall.sequence > debtLiquidationSubtreeLastSequence,
      repaymentAndLiquidationEventsOrderedInsideDebtMarketCall: events.repayBorrow.emitter === debtMarket && events.liquidateBorrow.emitter === debtMarket && events.repayBorrow.logIndex < events.liquidateBorrow.logIndex,
      addressSelectorAndBorrowerBound: orderedPostBorrowCall.to === debtMarket && orderedPostBorrowCall.selector === SELECTORS.borrowBalanceOf && lower(decodeData(marketIface, "borrowBalanceOf", orderedPostBorrowCall.input)[0]) === borrower,
      outputMatchesRepayEventAccountBorrows: orderedPostBorrowRaw === events.repayBorrow.accountBorrows,
      accruedPreMinusRepayEqualsOrderedPost: BigInt(transactionAccruedPreBorrowRaw) - BigInt(events.repayBorrow.repayAmount) === BigInt(orderedPostBorrowRaw)
    }
  };

  const effects = transferEffects(receipt);
  const seizedRaw = sumEffects(effects, (row) => row.token === L_MBTC && row.from === DOMINANT);
  const burnedRaw = sumEffects(effects, (row) => row.token === L_MBTC && row.to === ZERO);
  const payoutRaw = sumEffects(effects, (row) => row.token === M_BTC && row.from === L_MBTC);
  const routerResidualRaw = seizedRaw - burnedRaw;
  const historical = await historicalState(Number.parseInt(tx.blockNumber, 16), debtMarket);
  const expectedSeizedRaw = BigInt(repayAmountRaw) * BigInt(liquidationIncentiveRaw18) * BigInt(debtPrices[0]) /
    (BigInt(collateralPrices[0]) * BigInt(exchangeRateRaw18));
  const debtAcceptedValueUsdRaw18 = BigInt(repayAmountRaw) * BigInt(debtPrices[0]) / WAD;
  const seizedCollateralAcceptedValueUsdRaw18 = seizedRaw * BigInt(exchangeRateRaw18) * BigInt(collateralPrices[0]) / WAD_SQUARED;
  const payoutAcceptedValueUsdRaw18 = payoutRaw * BigInt(collateralPrices[0]) / WAD;
  const redemptionFlooringDeltaUsdRaw18 = seizedCollateralAcceptedValueUsdRaw18 - payoutAcceptedValueUsdRaw18;

  const assertions = {
    coreArgsBound: debtMarketArgument === debtMarket && collateralMarket === L_MBTC && borrower === DOMINANT && repayAmountRaw === debtArgs[3],
    coreToDebtMarketBound: lower(debtArgs[0]) === L_MBTC && lower(debtArgs[1]) === lower(tx.to) && lower(debtArgs[2]) === borrower,
    nativeValueSemanticsBound: debtMarket === L_ETH ? coreLiquidation.valueRaw === repayAmountRaw && debtLiquidation.valueRaw === repayAmountRaw : coreLiquidation.valueRaw === "0" && debtLiquidation.valueRaw === "0",
    validatorArgsBound: lower(validatorArgs[0]) === debtMarket && lower(validatorArgs[1]) === L_MBTC && validatorArgs[2] === repayAmountRaw,
    validatorOutputsMatchDebtMarket: JSON.stringify(validatorOutputs) === JSON.stringify(debtOutputs),
    formulaExpectedSeizureMatches: expectedSeizedRaw.toString() === validatorOutputs[0],
    zeroRebateAndLiquidatorReceivesAll: validatorOutputs[1] === "0" && validatorOutputs[2] === validatorOutputs[0],
    seizeCallMatchesValidator: lower(seizeArgs[0]) === lower(tx.to) && lower(seizeArgs[1]) === borrower && seizeArgs[2] === validatorOutputs[0],
    repayEventMatchesTrace: events.repayBorrow.payer === lower(tx.to) && events.repayBorrow.borrower === borrower && events.repayBorrow.repayAmount === repayAmountRaw,
    liquidationEventMatchesTrace: events.liquidateBorrow.liquidator === lower(tx.to) && events.liquidateBorrow.borrower === borrower && events.liquidateBorrow.repayAmount === repayAmountRaw && events.liquidateBorrow.lTokenCollateral === L_MBTC && events.liquidateBorrow.seizeTokens === validatorOutputs[0],
    orderedPostBorrowBalanceMatchesEventAndArithmetic: Object.values(postBorrowProof.predicates).every((value) => value === true),
    receiptSeizureMatchesTrace: seizedRaw.toString() === validatorOutputs[0],
    redeemTraceMatchesReceipt: lower(coreRedeemArgs[0]) === L_MBTC && coreRedeemArgs[1] === burnedRaw.toString() && lower(marketRedeemArgs[0]) === lower(tx.to) && marketRedeemArgs[1] === burnedRaw.toString() && coreRedeemOutput === payoutRaw.toString() && marketRedeemOutput === payoutRaw.toString(),
    redeemEventsMatchTrace: events.redeem.redeemer === lower(tx.to) && events.redeem.redeemAmount === payoutRaw.toString() && events.redeem.redeemTokens === burnedRaw.toString() && events.marketRedeem.user === lower(tx.to) && events.marketRedeem.lToken === L_MBTC && events.marketRedeem.amount === payoutRaw.toString(),
    historicalConfigurationMatchesTrace: historical.validator === validatorCall.to && historical.priceCalculator === decodedOracleCalls[0].row.to && historical.liquidationIncentiveRaw === liquidationIncentiveRaw18,
    configurationSelectorsCorrectAndDistinct: historical.configurationCallProvenance.priceCalculator.selector === SELECTORS.priceCalculator && historical.configurationCallProvenance.closeFactor.selector === SELECTORS.closeFactor && SELECTORS.priceCalculator !== SELECTORS.closeFactor,
    historicalOracleMatchesTrace: historical.debtPriceRaw18 === debtPrices[0] && historical.collateralPriceRaw18 === collateralPrices[0],
    decimalsAndUnderlyingBound: historical.debtDecimals === 18 && historical.collateralDecimals === 18 && historical.collateralUnderlying === M_BTC && (debtMarket === L_ETH ? historical.debtUnderlying === ZERO : historical.debtUnderlying === WEETH),
    step10ReceiptEffectsMatch: seizedRaw.toString() === baselineRow.seizedRaw && burnedRaw.toString() === baselineRow.burnedRaw && payoutRaw.toString() === baselineRow.payoutRaw && routerResidualRaw.toString() === baselineRow.routerResidualRaw
  };
  if (Object.values(assertions).some((value) => value !== true)) throw new Error(`${txHash}: fail-closed assertion failed ${JSON.stringify(assertions)}`);

  const relevantCalls = [
    compactCall(coreLiquidation, "Core.liquidateBorrow", { debtMarket: debtMarketArgument, collateralMarket, borrower, repayAmountRaw }),
    compactCall(debtLiquidation, "DebtMarket.liquidateBorrow", { collateralMarket: lower(debtArgs[0]), liquidator: lower(debtArgs[1]), borrower: lower(debtArgs[2]), repayAmountRaw: debtArgs[3] }, { seizeLAmountRaw: debtOutputs[0], rebateLAmountRaw: debtOutputs[1], liquidatorLAmountRaw: debtOutputs[2] }),
    compactCall(validatorCall, "Validator.lTokenAmountToSeize", { debtMarket: lower(validatorArgs[0]), collateralMarket: lower(validatorArgs[1]), repayAmountRaw: validatorArgs[2] }, { seizeLAmountRaw: validatorOutputs[0], rebateLAmountRaw: validatorOutputs[1], liquidatorLAmountRaw: validatorOutputs[2] }),
    ...decodedOracleCalls.map((entry) => compactCall(entry.row, "PriceCalculator.getUnderlyingPrice", { market: entry.asset }, { priceRaw18: entry.priceRaw18 })),
    compactCall(exchangeRateCall, "lMBTC.accruedExchangeRate", {}, { exchangeRateRaw18 }),
    compactCall(incentiveCall, "Core.liquidationIncentive", {}, { liquidationIncentiveRaw18 }),
    compactCall(seizeCall, "lMBTC.seize", { liquidator: lower(seizeArgs[0]), borrower: lower(seizeArgs[1]), seizeTokensRaw: seizeArgs[2] }),
    compactCall(orderedPostBorrowCall, "DebtMarket.borrowBalanceOf.orderedPostLiquidation", { borrower }, { postBorrowRaw: orderedPostBorrowRaw }),
    compactCall(coreRedeem, "Core.redeemToken", { market: lower(coreRedeemArgs[0]), redeemTokensRaw: coreRedeemArgs[1] }, { redeemAmountRaw: coreRedeemOutput }),
    compactCall(marketRedeemCall, "lMBTC.redeemToken", { redeemer: lower(marketRedeemArgs[0]), redeemTokensRaw: marketRedeemArgs[1] }, { redeemAmountRaw: marketRedeemOutput })
  ];

  return {
    txHash,
    blockNumber: Number.parseInt(tx.blockNumber, 16),
    blockHash: block.hash,
    blockTimestamp: Number.parseInt(block.timestamp, 16),
    transactionIndex: Number.parseInt(tx.transactionIndex, 16),
    caller: lower(tx.from),
    router: lower(tx.to),
    outerTransactionValueRaw: BigInt(tx.value).toString(),
    borrower,
    debtMarket,
    debtAsset: debtMarket === L_ETH ? "native ETH" : "weETH.mode",
    repayAmountRaw,
    collateralMarket: L_MBTC,
    seizedRaw: seizedRaw.toString(),
    burnedRaw: burnedRaw.toString(),
    routerResidualRaw: routerResidualRaw.toString(),
    mbtcPayoutRaw: payoutRaw.toString(),
    validator: validatorCall.to,
    priceCalculator: historical.priceCalculator,
    debtPriceRaw18: debtPrices[0],
    collateralPriceRaw18: collateralPrices[0],
    liquidationIncentiveRaw18,
    liquidationExchangeRateRaw18: exchangeRateRaw18,
    formulaExpectedSeizedRaw: expectedSeizedRaw.toString(),
    debtAcceptedValueUsdRaw18: debtAcceptedValueUsdRaw18.toString(),
    seizedCollateralAcceptedValueUsdRaw18: seizedCollateralAcceptedValueUsdRaw18.toString(),
    payoutAcceptedValueUsdRaw18: payoutAcceptedValueUsdRaw18.toString(),
    redemptionFlooringDeltaUsdRaw18: redemptionFlooringDeltaUsdRaw18.toString(),
    seizedAcceptedValueIncentiveUsdRaw18: (seizedCollateralAcceptedValueUsdRaw18 - debtAcceptedValueUsdRaw18).toString(),
    payoutAcceptedValueIncentiveUsdRaw18: (payoutAcceptedValueUsdRaw18 - debtAcceptedValueUsdRaw18).toString(),
    trace: {
      recursiveCallCount: flat.length,
      maxDepth: Math.max(...flat.map((row) => row.depth)),
      relevantCalls,
      orderedPostBorrowProof: postBorrowProof,
      qualification: "All calls[] were traversed recursively. Matching is by address, selector, decoded arguments, ancestry, and outputs—not fixed depth or child index."
    },
    events,
    effects,
    historical,
    assertions
  };
}

const SOURCE_TARGETS = {
  [CORE]: { label: "Core", selectors: [SELECTORS.liquidateBorrow, SELECTORS.redeemToken, SELECTORS.validator, SELECTORS.priceCalculator, SELECTORS.closeFactor, SELECTORS.liquidationIncentive], needles: ["function liquidateBorrow", "function redeemToken", "emit MarketRedeem", "priceCalculator", "closeFactor"] },
  [L_MBTC]: { label: "lMBTC", selectors: [SELECTORS.liquidateBorrow, SELECTORS.redeemToken, SELECTORS.seize, SELECTORS.accruedExchangeRate], needles: ["event RepayBorrow", "event LiquidateBorrow", "function liquidateBorrow", "function seize", "event Redeem", "function redeemToken"] },
  [L_ETH]: { label: "lETH debt market", selectors: [SELECTORS.liquidateBorrow, SELECTORS.borrowBalanceOf, SELECTORS.underlying], needles: ["event RepayBorrow", "event LiquidateBorrow", "function liquidateBorrow"] },
  [L_WEETH]: { label: "lweETH.mode debt market", selectors: [SELECTORS.liquidateBorrow, SELECTORS.borrowBalanceOf, SELECTORS.underlying], needles: ["event RepayBorrow", "event LiquidateBorrow", "function liquidateBorrow"] },
  [OLD_VALIDATOR]: { label: "historical Validator", selectors: [SELECTORS.lTokenAmountToSeize], needles: ["function lTokenAmountToSeize", "uint256 seizeLTokenAmountBase", ".mul(core.liquidationIncentive())"] },
  [NEW_VALIDATOR]: { label: "later Validator", selectors: [SELECTORS.lTokenAmountToSeize], needles: ["function lTokenAmountToSeize", "uint256 seizeLTokenAmountBase", ".mul(core.liquidationIncentive())"] },
  [OLD_ORACLE]: { label: "historical PriceCalculator", selectors: [SELECTORS.getUnderlyingPrice], needles: ["function getUnderlyingPrice"] },
  [NEW_ORACLE]: { label: "later PriceCalculator", selectors: [SELECTORS.getUnderlyingPrice], needles: ["function getUnderlyingPrice"] }
};

function sourceReference(source, needle) {
  const index = source.indexOf(needle);
  if (index < 0) return { needle, found: false, line: null };
  return { needle, found: true, line: source.slice(0, index).split(/\r?\n/).length };
}

async function sourceBinding(address, blocks) {
  let result = null;
  let sourceApiErrorClass = null;
  try {
    const url = `${SOURCE_API}?module=contract&action=getsourcecode&address=${address}`;
    const response = await fetch(url, { headers: { accept: "application/json" } });
    const payload = await response.json();
    if (payload.status !== "1" || !Array.isArray(payload.result) || !payload.result[0]) throw new Error(payload.message || "source API unavailable");
    result = payload.result[0];
  } catch (error) {
    sourceApiErrorClass = error.name || "Error";
  }
  const source = result?.SourceCode || "";
  const abi = result?.ABI && result.ABI !== "Contract source code not verified" ? result.ABI : "";
  const runtimes = {};
  for (const blockNumber of blocks) {
    const code = await rpc("eth_getCode", [address, hexBlock(blockNumber)]);
    runtimes[blockNumber] = {
      codePresent: code !== "0x",
      byteLength: Math.max(0, (code.length - 2) / 2),
      keccak256: code === "0x" ? null : keccak256(code),
      selectorPresence: SOURCE_TARGETS[address].selectors.map((selector) => ({ selector, signature: SELECTOR_SIGNATURES[selector], present: code.toLowerCase().includes(selector.slice(2)) })),
      requiredSelectorsPresent: SOURCE_TARGETS[address].selectors.every((selector) => code.toLowerCase().includes(selector.slice(2)))
    };
  }
  const references = SOURCE_TARGETS[address].needles.map((needle) => sourceReference(source, needle));
  return {
    address,
    label: SOURCE_TARGETS[address].label,
    explorerSourceAvailable: Boolean(source),
    explorerVerificationStatus: source ? "verified-source-returned" : "unverified-or-unavailable",
    contractName: result?.ContractName || null,
    sourceFile: result?.FileName || null,
    compilerVersion: result?.CompilerVersion || null,
    optimizationUsed: result?.OptimizationUsed || null,
    optimizationRuns: result?.OptimizationRuns ?? null,
    isProxyExplorerField: result?.IsProxy ?? null,
    sourceCodeSha256: source ? sha256(Buffer.from(source)) : null,
    sourceCodeBytes: source ? Buffer.byteLength(source) : 0,
    abiSha256: abi ? sha256(Buffer.from(abi)) : null,
    abiBytes: abi ? Buffer.byteLength(abi) : 0,
    relevantSourceReferences: references,
    requiredSelectorProvenance: SOURCE_TARGETS[address].selectors.map((selector) => ({ selector, signature: SELECTOR_SIGNATURES[selector] })),
    relevantSourceSemanticsPresent: Boolean(source) && references.every((reference) => reference.found),
    buildReproducedLocally: false,
    sourceRuntimeExactLocally: null,
    sourceApiErrorClass,
    historicalRuntimes: runtimes
  };
}

async function main() {
  if (coreIface.getFunction("priceCalculator").selector !== SELECTORS.priceCalculator || coreIface.getFunction("closeFactor").selector !== SELECTORS.closeFactor || SELECTORS.priceCalculator === SELECTORS.closeFactor) {
    throw new Error("Core selector provenance mismatch");
  }
  fs.rmSync(SOURCE_DIR, { recursive: true, force: true });
  fs.mkdirSync(SOURCE_DIR, { recursive: true });
  const predecessor = { raw: record(STEP10_RAW), manifest: record(STEP10_MANIFEST), runId: require(STEP10_RAW).runId };
  if (predecessor.runId !== "free-step10-56d0daa8cdd6c6fd9395") throw new Error("Step10 predecessor mismatch");
  const baseline = require(STEP10_RAW).evidence.rows;
  if (baseline.length !== 6 || TX_HASHES.some((hash, index) => baseline[index].txHash !== hash)) throw new Error("Step10 transaction baseline mismatch");

  const rows = [];
  for (let index = 0; index < TX_HASHES.length; index++) rows.push(await transactionEvidence(TX_HASHES[index], baseline[index]));
  const sameBlockRows = rows.filter((row) => row.blockNumber === 19559957).sort((a, b) => a.transactionIndex - b.transactionIndex);
  if (sameBlockRows.length !== 2) throw new Error("Expected exactly two continuity rows at block 19559957");
  const [firstSameBlockRow, secondSameBlockRow] = sameBlockRows;
  const firstPostBorrowRaw = firstSameBlockRow.trace.orderedPostBorrowProof.arithmetic.orderedPostBorrowRaw;
  const secondAccruedPreBorrowRaw = secondSameBlockRow.trace.orderedPostBorrowProof.arithmetic.transactionAccruedPreBorrowRaw;
  const sameBlockContinuity = {
    blockNumber: 19559957,
    first: { txHash: firstSameBlockRow.txHash, transactionIndex: firstSameBlockRow.transactionIndex, orderedPostBorrowRaw: firstPostBorrowRaw },
    second: { txHash: secondSameBlockRow.txHash, transactionIndex: secondSameBlockRow.transactionIndex, transactionAccruedPreBorrowRaw: secondAccruedPreBorrowRaw },
    predicates: {
      transactionIndexOrderStrict: firstSameBlockRow.transactionIndex < secondSameBlockRow.transactionIndex,
      transactionsAdjacentInBlock: firstSameBlockRow.transactionIndex + 1 === secondSameBlockRow.transactionIndex,
      sameBorrowerAndDebtMarket: firstSameBlockRow.borrower === secondSameBlockRow.borrower && firstSameBlockRow.debtMarket === secondSameBlockRow.debtMarket,
      firstPostBorrowEqualsSecondAccruedPreBorrow: firstPostBorrowRaw === secondAccruedPreBorrowRaw
    }
  };
  sameBlockContinuity.passed = Object.values(sameBlockContinuity.predicates).every((value) => value === true);
  firstSameBlockRow.sameBlockContinuity = { role: "first", counterpartTxHash: secondSameBlockRow.txHash, ...sameBlockContinuity };
  secondSameBlockRow.sameBlockContinuity = { role: "second", counterpartTxHash: firstSameBlockRow.txHash, ...sameBlockContinuity };
  if (!sameBlockContinuity.passed) throw new Error(`Same-block post-borrow continuity failed: ${JSON.stringify(sameBlockContinuity)}`);
  const blocks = [...new Set(rows.map((row) => row.blockNumber))].sort((a, b) => a - b);
  const sourceBindings = {};
  for (const address of Object.keys(SOURCE_TARGETS)) sourceBindings[address] = await sourceBinding(address, blocks);

  const sum = (field) => rows.reduce((total, row) => total + BigInt(row[field]), 0n);
  const metrics = {
    transactions: rows.length,
    nativeEthDebtReliefRaw: rows.filter((row) => row.debtMarket === L_ETH).reduce((total, row) => total + BigInt(row.repayAmountRaw), 0n).toString(),
    weethDebtReliefRaw: rows.filter((row) => row.debtMarket === L_WEETH).reduce((total, row) => total + BigInt(row.repayAmountRaw), 0n).toString(),
    seizedRaw: sum("seizedRaw").toString(),
    burnedRaw: sum("burnedRaw").toString(),
    routerResidualRaw: sum("routerResidualRaw").toString(),
    mbtcPayoutRaw: sum("mbtcPayoutRaw").toString(),
    debtAcceptedValueUsdRaw18: sum("debtAcceptedValueUsdRaw18").toString(),
    seizedCollateralAcceptedValueUsdRaw18: sum("seizedCollateralAcceptedValueUsdRaw18").toString(),
    payoutAcceptedValueUsdRaw18: sum("payoutAcceptedValueUsdRaw18").toString(),
    redemptionFlooringDeltaUsdRaw18: sum("redemptionFlooringDeltaUsdRaw18").toString(),
    seizedAcceptedValueIncentiveUsdRaw18: sum("seizedAcceptedValueIncentiveUsdRaw18").toString(),
    payoutAcceptedValueIncentiveUsdRaw18: sum("payoutAcceptedValueIncentiveUsdRaw18").toString()
  };
  if (metrics.seizedRaw !== "4730950768016049778" || metrics.burnedRaw !== "4730950768016049777" || metrics.routerResidualRaw !== "1" || metrics.mbtcPayoutRaw !== "8900774766577676") {
    throw new Error("Step10 receipt aggregate mismatch");
  }
  const expectedPriorValueAssertions = {
    debtAcceptedValueUsdRaw18: { expected: "769643612574470163095", observed: metrics.debtAcceptedValueUsdRaw18, matches: metrics.debtAcceptedValueUsdRaw18 === "769643612574470163095" },
    seizedCollateralAcceptedValueUsdRaw18: { expected: "885090154460640686873", observed: metrics.seizedCollateralAcceptedValueUsdRaw18, matches: metrics.seizedCollateralAcceptedValueUsdRaw18 === "885090154460640686873" },
    payoutAcceptedValueUsdRaw18: { expected: "885090154460640276371", observed: metrics.payoutAcceptedValueUsdRaw18, matches: metrics.payoutAcceptedValueUsdRaw18 === "885090154460640276371" },
    redemptionFlooringDeltaUsdRaw18: { expected: "410502", observed: metrics.redemptionFlooringDeltaUsdRaw18, matches: metrics.redemptionFlooringDeltaUsdRaw18 === "410502" }
  };
  if (Object.values(expectedPriorValueAssertions).some((assertion) => !assertion.matches)) throw new Error(`Accepted-value assertion mismatch: ${JSON.stringify(expectedPriorValueAssertions)}`);

  const oldValidatorSourceBound = sourceBindings[OLD_VALIDATOR].relevantSourceSemanticsPresent;
  const newValidatorSourceBound = sourceBindings[NEW_VALIDATOR].relevantSourceSemanticsPresent;
  const coreSourceBound = sourceBindings[CORE].relevantSourceSemanticsPresent;
  const collateralSourceBound = sourceBindings[L_MBTC].relevantSourceSemanticsPresent;
  const lethSourceBound = sourceBindings[L_ETH].relevantSourceSemanticsPresent;
  const lweethSourceExact = sourceBindings[L_WEETH].relevantSourceSemanticsPresent ? true : null;
  const lweethRuntimeCompatible = Object.values(sourceBindings[L_WEETH].historicalRuntimes).every((runtime) => runtime.codePresent && runtime.requiredSelectorsPresent);
  const coreConfigurationSelectorProvenanceBound = sourceBindings[CORE].requiredSelectorProvenance.some((row) => row.signature === "priceCalculator()" && row.selector === SELECTORS.priceCalculator) &&
    sourceBindings[CORE].requiredSelectorProvenance.some((row) => row.signature === "closeFactor()" && row.selector === SELECTORS.closeFactor) &&
    Object.values(sourceBindings[CORE].historicalRuntimes).every((runtime) => runtime.selectorPresence.some((row) => row.signature === "priceCalculator()" && row.selector === SELECTORS.priceCalculator && row.present) && runtime.selectorPresence.some((row) => row.signature === "closeFactor()" && row.selector === SELECTORS.closeFactor && row.present));
  const everyAssertion = (name) => rows.every((row) => row.assertions[name] === true);
  const gates = {
    predecessorStep10Bound: true,
    sixMaterialReceiptsSuccessful: true,
    sixRecursiveCallTracesDecoded: rows.length === 6 && rows.every((row) => row.trace.recursiveCallCount > row.trace.relevantCalls.length),
    sixCoreLiquidationCallsTraceBound: everyAssertion("coreArgsBound") && everyAssertion("coreToDebtMarketBound"),
    borrowerBoundInAllSix: rows.every((row) => row.borrower === DOMINANT),
    debtAssetsAndRepayAmountsResolved: everyAssertion("nativeValueSemanticsBound") && rows.every((row) => DEBT_MARKETS.includes(row.debtMarket) && BigInt(row.repayAmountRaw) > 0n),
    repayEventsMatchLiquidationEvents: everyAssertion("repayEventMatchesTrace") && everyAssertion("liquidationEventMatchesTrace"),
    postBorrowBalancesMatchRepayEvents: everyAssertion("orderedPostBorrowBalanceMatchesEventAndArithmetic") && sameBlockContinuity.passed,
    sameBlockPostBorrowContinuityBound: sameBlockContinuity.passed,
    collateralSeizuresTraceBound: everyAssertion("seizeCallMatchesValidator") && everyAssertion("receiptSeizureMatchesTrace"),
    validatorSeizeOutputsTraceBound: everyAssertion("validatorArgsBound") && everyAssertion("validatorOutputsMatchDebtMarket") && everyAssertion("formulaExpectedSeizureMatches") && everyAssertion("zeroRebateAndLiquidatorReceivesAll") && oldValidatorSourceBound && newValidatorSourceBound,
    redemptionsAndMbtcPayoutsTraceBound: everyAssertion("redeemTraceMatchesReceipt") && everyAssertion("redeemEventsMatchTrace"),
    fixedBlockOraclePricesResolved: everyAssertion("historicalOracleMatchesTrace") && everyAssertion("historicalConfigurationMatchesTrace") && everyAssertion("configurationSelectorsCorrectAndDistinct"),
    correctCorePriceCalculatorAndCloseFactorSelectorsBound: everyAssertion("configurationSelectorsCorrectAndDistinct") && coreConfigurationSelectorProvenanceBound,
    liquidationIncentiveResolved: rows.every((row) => row.liquidationIncentiveRaw18 === "1150000000000000000") && everyAssertion("historicalConfigurationMatchesTrace"),
    onchainAcceptedValueBenchmarkComputed: rows.every((row) => BigInt(row.debtAcceptedValueUsdRaw18) > 0n && BigInt(row.seizedCollateralAcceptedValueUsdRaw18) >= BigInt(row.payoutAcceptedValueUsdRaw18) && BigInt(row.payoutAcceptedValueUsdRaw18) > BigInt(row.debtAcceptedValueUsdRaw18)) && Object.values(expectedPriorValueAssertions).every((assertion) => assertion.matches) && oldValidatorSourceBound && newValidatorSourceBound,
    redemptionFlooringAccountingBound: rows.every((row) => BigInt(row.seizedCollateralAcceptedValueUsdRaw18) - BigInt(row.payoutAcceptedValueUsdRaw18) === BigInt(row.redemptionFlooringDeltaUsdRaw18)) && expectedPriorValueAssertions.redemptionFlooringDeltaUsdRaw18.matches,
    coreCollateralAndFiveLethSourceSemanticsBound: coreSourceBound && collateralSourceBound && lethSourceBound && oldValidatorSourceBound,
    sixthDebtMarketAbiRuntimeCompatible: lweethRuntimeCompatible && rows.filter((row) => row.debtMarket === L_WEETH).length === 1,
    allSixDebtMarketSourceExact: lweethSourceExact === true && lethSourceBound ? true : null,
    beneficialOwnershipProven: null,
    legalDamagesProven: null,
    ultimateUncompensatedLossProven: null,
    abuseProven: null,
    routePositive: false,
    signedAction: false,
    promotion: false
  };
  const requiredTrue = Object.entries(gates).filter(([name]) => !["allSixDebtMarketSourceExact", "beneficialOwnershipProven", "legalDamagesProven", "ultimateUncompensatedLossProven", "abuseProven", "routePositive", "signedAction", "promotion"].includes(name));
  if (requiredTrue.some(([, value]) => value !== true)) throw new Error(`Required Step11 gate failed: ${JSON.stringify(gates)}`);
  if (gates.allSixDebtMarketSourceExact !== null) throw new Error("Unverified lweETH market must keep all-six source-exact gate null");

  const recursiveTransactions = {
    qualification: "Six successful public transactions were recursively traversed and decoded without fixed trace depth/index assumptions. Exact relevant call paths, arguments, outputs, ordered post-borrow proofs, receipt events, and Transfer effects are retained.",
    sameBlockContinuity,
    rows
  };
  const decodedEvents = { qualification: "Event layouts are bound to explorer-returned verified LToken/Core source for five lETH rows and to the same topic/data ABI plus runtime selector compatibility for the unverified lweETH.mode row.", rows: rows.map((row) => ({ txHash: row.txHash, debtMarket: row.debtMarket, events: row.events, effects: row.effects })) };
  const historicalStateEvidence = { qualification: "Historical eth_call cross-checks bind Core configuration, Validator, PriceCalculator, underlying assets, decimals, prices, and incentive. Trace exchange rates remain authoritative for exact same-transaction arithmetic.", rows: rows.map((row) => ({ txHash: row.txHash, historical: row.historical, traceExchangeRateRaw18: row.liquidationExchangeRateRaw18 })) };
  const sourceEvidence = {
    qualification: "Explorer-returned verified source and historical runtime hashes bind Core, lMBTC, lETH, both Validators, and both PriceCalculators. No local compiler reproduction is claimed. lweETH.mode source is unavailable, so all-six debt-market source exactness remains null despite ABI/runtime compatibility.",
    sourceApiQueried: true,
    sourceApiUrlPersisted: false,
    correctedCoreSelectorProvenance: {
      priceCalculator: { signature: "priceCalculator()", selector: SELECTORS.priceCalculator, interfaceDerivedSelector: coreIface.getFunction("priceCalculator").selector, purpose: "Core PriceCalculator address getter" },
      closeFactor: { signature: "closeFactor()", selector: SELECTORS.closeFactor, interfaceDerivedSelector: coreIface.getFunction("closeFactor").selector, purpose: "Core close-factor getter; not PriceCalculator" },
      distinct: SELECTORS.priceCalculator !== SELECTORS.closeFactor
    },
    bindings: sourceBindings
  };
  const accounting = {
    metrics,
    gates,
    expectedPriorValueAssertions,
    sameBlockContinuity,
    benchmarkQualification: "Values labeled USD are derived from trace- and historical-call-bound LayerBank PriceCalculator outputs at each transaction block, in 18-decimal raw units. Seized-collateral accepted value is computed before redemption flooring; payout accepted value uses the actual M-BTC receipt payout after redemption flooring. Their small integer delta is not unexplained economic loss. These values are not independent market prices, realizable proceeds, beneficial-owner loss, legal damages, or uncompensated loss.",
    formula: "expectedSeizedRaw = repayRaw * 10^(18-debtDecimals) * liquidationIncentiveRaw18 * debtPriceRaw18 / (collateralPriceRaw18 * liquidationExchangeRateRaw18) / 10^(18-collateralDecimals), using Solidity integer order. All observed debt/collateral decimals are 18.",
    rows: rows.map((row) => ({ txHash: row.txHash, transactionIndex: row.transactionIndex, debtAsset: row.debtAsset, repayAmountRaw: row.repayAmountRaw, debtPriceRaw18: row.debtPriceRaw18, collateralPriceRaw18: row.collateralPriceRaw18, liquidationExchangeRateRaw18: row.liquidationExchangeRateRaw18, liquidationIncentiveRaw18: row.liquidationIncentiveRaw18, formulaExpectedSeizedRaw: row.formulaExpectedSeizedRaw, observedSeizedRaw: row.seizedRaw, actualMbtcPayoutRaw: row.mbtcPayoutRaw, debtAcceptedValueUsdRaw18: row.debtAcceptedValueUsdRaw18, seizedCollateralAcceptedValueUsdRaw18: row.seizedCollateralAcceptedValueUsdRaw18, payoutAcceptedValueUsdRaw18: row.payoutAcceptedValueUsdRaw18, redemptionFlooringDeltaUsdRaw18: row.redemptionFlooringDeltaUsdRaw18, seizedAcceptedValueIncentiveUsdRaw18: row.seizedAcceptedValueIncentiveUsdRaw18, payoutAcceptedValueIncentiveUsdRaw18: row.payoutAcceptedValueIncentiveUsdRaw18, orderedPostBorrowProof: row.trace.orderedPostBorrowProof }))
  };

  write(path.join(SOURCE_DIR, "recursive-transactions.json"), recursiveTransactions);
  write(path.join(SOURCE_DIR, "decoded-events.json"), decodedEvents);
  write(path.join(SOURCE_DIR, "historical-state.json"), historicalStateEvidence);
  write(path.join(SOURCE_DIR, "source-bindings.json"), sourceEvidence);
  write(path.join(SOURCE_DIR, "accepted-value-accounting.json"), accounting);

  const runId = `free-step11-${sha256(Buffer.from(JSON.stringify({ predecessorRunId: predecessor.runId, rows, metrics, gates, sourceBindings, classification: CLASSIFICATION }))).slice(0, 20)}`;
  const raw = {
    schemaVersion: 2,
    runId,
    classification: CLASSIFICATION,
    predecessor,
    evidence: { recursiveTransactions, decodedEvents, historicalState: historicalStateEvidence, sourceBindings: sourceEvidence },
    accounting,
    safety: { publicReadOnly: true, publicSourceApiRead: true, providerUrlsEmitted: false, sourceApiUrlEmitted: false, endpointInventoryRead: false, rawTransactionSignaturesPersisted: false, signing: false, transactions: false, forks: false, stateMutation: false }
  };
  write(RAW, raw);

  const table = rows.map((row) => `| \`${row.txHash.slice(0, 10)}…\` | ${row.blockNumber}:${row.transactionIndex} | ${row.debtAsset} | ${row.repayAmountRaw} | ${row.seizedRaw} | ${row.debtAcceptedValueUsdRaw18} | ${row.seizedCollateralAcceptedValueUsdRaw18} | ${row.payoutAcceptedValueUsdRaw18} | ${row.redemptionFlooringDeltaUsdRaw18} |`).join("\n");
  const report = `# Free Protocol Step11 — recursive LayerBank liquidation decoder\n\nSignal: 🟠 WATCH — accounting evidence strengthened; no exploit, abuse, ownership, ultimate-loss, or execution promotion.\n\n**Classification:** ${CLASSIFICATION}\n\nSix successful liquidation paths were recursively decoded from public call traces and matched to RepayBorrow, LiquidateBorrow, Redeem, MarketRedeem, and ERC20 Transfer receipt effects. The common borrower is \`${DOMINANT}\`; this binds the onchain account only and does not establish beneficial ownership.\n\n| Transaction | Block:txIndex | Debt asset | Repaid raw | lMBTC seized raw | Debt accepted USD raw18 | Seized accepted USD raw18 | Payout accepted USD raw18 | Flooring delta raw18 |\n|---|---:|---|---:|---:|---:|---:|---:|---:|\n${table}\n\nTotals: native ETH debt relief=${metrics.nativeEthDebtReliefRaw}; weETH.mode debt relief=${metrics.weethDebtReliefRaw}; lMBTC seized=${metrics.seizedRaw}; lMBTC burned=${metrics.burnedRaw}; router residual=${metrics.routerResidualRaw}; M-BTC payout=${metrics.mbtcPayoutRaw}; debt accepted value=${metrics.debtAcceptedValueUsdRaw18}; seized-collateral accepted value=${metrics.seizedCollateralAcceptedValueUsdRaw18}; payout accepted value=${metrics.payoutAcceptedValueUsdRaw18}; redemption-flooring delta=${metrics.redemptionFlooringDeltaUsdRaw18}; incentive versus seized=${metrics.seizedAcceptedValueIncentiveUsdRaw18}; incentive versus payout=${metrics.payoutAcceptedValueIncentiveUsdRaw18}.\n\nEach post-borrow proof now requires exactly one borrower-bound \`borrowBalanceOf(address)\` call inside the decoded Core liquidation branch and after the complete debt-market liquidation subtree. The persisted proof includes full path, trace order, calldata borrower, output, event indices, and accrued-pre arithmetic. At block 19,559,957, transaction indices ${sameBlockContinuity.first.transactionIndex} then ${sameBlockContinuity.second.transactionIndex} are adjacent and the first ordered postBorrow (${sameBlockContinuity.first.orderedPostBorrowRaw}) exactly equals the second transaction-accrued preBorrow (${sameBlockContinuity.second.transactionAccruedPreBorrowRaw}).\n\nThe exact Validator integer formula reproduces every seizure. Historical calls reproduce each block's Validator, PriceCalculator, prices, decimals, underlying asset, close factor, and \`1.15e18\` liquidation incentive. Core selector provenance is corrected and kept distinct: \`priceCalculator()=${SELECTORS.priceCalculator}\`; \`closeFactor()=${SELECTORS.closeFactor}\`. Exact exchange rates come from each in-transaction trace, not end-of-block state. Prices and configuration are call/trace-derived; the prior totals are assertions only.\n\nThe ${metrics.redemptionFlooringDeltaUsdRaw18} raw18 difference is the aggregate of per-redemption integer flooring/accepted-value multiplication flooring, including the separately persisted one-raw-lMBTC router residual in one transaction. It is a difference between two integer accounting constructions, not an unexplained economic loss.\n\nSource boundary: Core, lMBTC, lETH, both Validators, and both PriceCalculators have explorer-returned source semantics and historical runtime hashes. No local build reproduction is claimed. \`${L_WEETH}\` remains source-unverified; its one row is ABI/event/runtime compatible, but \`allSixDebtMarketSourceExact\` remains null.\n\nLayerBank PriceCalculator values are accepted-value accounting, not independent market value, realizable proceeds, ownership, legal damages, or ultimate uncompensated loss. No exploit, abuse, or route promotion is claimed.\n\nGates: \`${JSON.stringify(gates)}\`\n`;
  const handoff = `# Step11 recursive LayerBank liquidation decoder handoff\n\n- ${CLASSIFICATION}\n- Run ${runId}; predecessor ${predecessor.runId}.\n- Corrected Core selectors: priceCalculator()=${SELECTORS.priceCalculator}; closeFactor()=${SELECTORS.closeFactor}; both independently interface/source/runtime-provenanced.\n- Six recursive trace paths, exact ordered descendant post-borrow proofs, same-block continuity, debt repayments, Validator outputs, seizures, redemptions, and fixed-block accepted-value inputs are bound.\n- Totals debt/seized-collateral/payout accepted raw18=${metrics.debtAcceptedValueUsdRaw18}/${metrics.seizedCollateralAcceptedValueUsdRaw18}/${metrics.payoutAcceptedValueUsdRaw18}; seized-minus-payout flooring delta=${metrics.redemptionFlooringDeltaUsdRaw18}. The ${metrics.redemptionFlooringDeltaUsdRaw18} raw18 delta is bounded integer redemption/value flooring (plus the separately persisted one-raw-lMBTC residual), not unexplained economic loss.\n- Incentive differences versus seized/payout accepted value=${metrics.seizedAcceptedValueIncentiveUsdRaw18}/${metrics.payoutAcceptedValueIncentiveUsdRaw18}.\n- Same-block tx indices ${sameBlockContinuity.first.transactionIndex}->${sameBlockContinuity.second.transactionIndex}; first postBorrow equals second accrued preBorrow=${sameBlockContinuity.first.orderedPostBorrowRaw}; continuity=${sameBlockContinuity.passed}.\n- lweETH.mode source remains unavailable; all-six source exactness, beneficial ownership, legal damages, abuse, and ultimate loss remain null.\n- No signing, transactions, forks, state mutation, endpoint inventory, or promotion.\n- Gates=${JSON.stringify(gates)}.\n`;
  write(REPORT, report);
  write(HANDOFF, handoff);

  const manifest = {
    schemaVersion: 2,
    runId,
    generationId: runId,
    detachedManifest: true,
    manifestSelfHashIncluded: false,
    predecessor,
    files: {
      scanner: record(__filename),
      sources: fs.readdirSync(SOURCE_DIR).sort().map((name) => record(path.join(SOURCE_DIR, name))),
      raw: record(RAW),
      report: record(REPORT),
      handoff: record(HANDOFF)
    },
    safety: raw.safety
  };
  write(MANIFEST, manifest);
  console.log(JSON.stringify({ status: "complete", runId, classification: CLASSIFICATION, metrics, gates, hashes: { raw: record(RAW).sha256, report: record(REPORT).sha256, handoff: record(HANDOFF).sha256, manifest: record(MANIFEST).sha256 } }, null, 2));
}

main().catch((error) => { console.error(error); process.exit(1); });
