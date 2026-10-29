"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ethers } = require("../node_modules/ethers");
const {
  BASE_TARGET_PLANS,
  computeBasePollIntervalMs,
  validateBaseAuthorization,
  maxSeizeByBorrowShares,
  buildBaseExecutionCalldata,
  runBaseOnce,
} = require("../execute-base-morpho-liquidation.js");

const OWNER = "0x24e46e91dfaad1fa3d49c48aa85ca9306885ce0a";
const EXEC = "0x5fe8d5a87af042bd744e9eda640c1342fa6bcc1c";
const W = 10n ** 18n;
const USDE_PLANS = BASE_TARGET_PLANS.filter(plan => plan.kind !== "YOUSD_REDEEM");

function validBatch() {
  return {
    schema: "live-execution-batch/v1",
    approved: true,
    expiresAt: "2026-10-26T23:59:59Z",
    chain: "base",
    chainId: 8453,
    account: { address: OWNER },
    targets: [
      { address: "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb" },
      { address: "0x2626664c2603336e57b271c5c0b26f421741e481" },
    ],
    actions: [
      "EXECUTE_ON_TRIGGER_BASE: MorphoLiquidateUnwindBaseRoundTrip.execute(Plan, swapData) on Base Mainnet (chainId 8453)",
    ],
    caps: {
      valueCapEthBase: "0",
      maxExecuteGasLimitBase: 700000,
      maxNativeSpendPerTransactionWeiBase: "200000000000000",
      signedExecutionsPerDayBase: 3,
      minProfitUsdcRawBase: "100000000",
    },
  };
}

test("validateBaseAuthorization enforces chain 8453, targets, actions, and caps", () => {
  const caps = validateBaseAuthorization(validBatch(), Date.parse("2026-10-20T00:00:00Z"));
  assert.equal(caps.gasCap, 700000n);
  assert.equal(caps.minProfitUsdc, 100000000n);
  assert.throws(() => validateBaseAuthorization({ ...validBatch(), chainId: 1 }, Date.parse("2026-10-20T00:00:00Z")), /BATCH_SCOPE_MISMATCH/);
  assert.throws(() => validateBaseAuthorization({ ...validBatch(), approved: false }, Date.parse("2026-10-20T00:00:00Z")), /BATCH_INVALID_OR_EXPIRED/);
});

test("buildBaseExecutionCalldata caps seize to borrower collateral and sets minLoanOut above repayment", () => {
  assert.equal(BASE_TARGET_PLANS.length, 7);
  assert.deepEqual(BASE_TARGET_PLANS.map(p => p.rank), ["#B7", "#B0", "#B4", "#B5", "#B6", "#B1", "#B2"]);
  assert.equal(USDE_PLANS[4].borrower, "0xb4fb31e7b1471a8e52dd1e962a281a732ead59c1");
  const b0 = USDE_PLANS[0];
  const full = buildBaseExecutionCalldata(EXEC, b0, 372637n * W, 10n ** 24n);
  assert.equal(full.seize, 345000n * W);
  assert.equal(full.minLoanOut, full.repayEstUsdc + 100000000n);
  const capped = buildBaseExecutionCalldata(EXEC, b0, 100000n * W, 10n ** 24n);
  assert.equal(capped.seize, 100000n * W);
});

test("computeBasePollIntervalMs immediately repolls verified receipts and selects turbo or standard cadence", () => {
  assert.equal(computeBasePollIntervalMs({ execution: { stage: "RECEIPT_VERIFIED" }, armed: true }), 0);
  assert.equal(computeBasePollIntervalMs({ execution: { stage: "RECEIPT_VERIFIED" }, armed: false }), 10000);
  assert.equal(computeBasePollIntervalMs({ execution: { stage: "SENT" }, armed: true }), 10000);
  const turbo = { pollMode: "TURBO_SUB_5BPS", targets: [{ bpsToLiquidation: "12.1" }, { bpsToLiquidation: "5.0000" }] };
  assert.equal(computeBasePollIntervalMs(turbo), 3500);
  assert.equal(computeBasePollIntervalMs(turbo, 2000), 2000);
  assert.equal(computeBasePollIntervalMs({ targets: [{ bpsToLiquidation: -0.1 }] }), 3500);
  assert.equal(computeBasePollIntervalMs({ targets: [{ isLiquidatable: true, bpsToLiquidation: null }] }), 3500);
  const standard = { pollMode: "STANDARD", targets: [{ bpsToLiquidation: "5.0001" }, { bpsToLiquidation: 12.1 }] };
  assert.equal(computeBasePollIntervalMs(standard), 10000);
  assert.equal(computeBasePollIntervalMs(standard, 12000), 12000);
  assert.equal(computeBasePollIntervalMs({ targets: [null, {}, { bpsToLiquidation: null }, { bpsToLiquidation: "invalid" }] }), 10000);
  assert.equal(computeBasePollIntervalMs(), 10000);
});

test("runBaseOnce check-only computes accrued HF for all six targets at the pinned Base block", async () => {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const mc = new ethers.Interface(["function aggregate3((address target,bool allowFailure,bytes callData)[]) returns ((bool success,bytes returnData)[])"]);
  const mkt = coder.encode(["uint128","uint128","uint128","uint128","uint128","uint128"], [400_000_000_000000n, 0, 350_000_000_000000n, 350_000_000_000000000000n, 1792450000, 0]);
  const price = coder.encode(["uint256"], [10n ** 24n]);
  const posB0 = coder.encode(["uint256","uint128","uint128"], [0, 340_855_000000000000n, 372_637n * W]);
  const posB4 = coder.encode(["uint256","uint128","uint128"], [0, 100_000n * 10n ** 12n, 200_000n * W]);
  const posB5 = coder.encode(["uint256","uint128","uint128"], [0, 200_000n * 10n ** 12n, 400_000n * W]);
  const posB6 = coder.encode(["uint256","uint128","uint128"], [0, 300_000n * 10n ** 12n, 600_000n * W]);
  const posB1 = coder.encode(["uint256","uint128","uint128"], [0, 28_807_000_000000000000n, 31_876_212n * W]);
  const posB2 = coder.encode(["uint256","uint128","uint128"], [0, 126_756_000_000000000000n, 140_794_000n * W]);
  const positions = [posB0, posB4, posB5, posB6, posB1, posB2];
  const agg = mc.encodeFunctionResult("aggregate3", [[mkt, price, ...positions].map(returnData => ({ success: true, returnData }))]);
  const rate = coder.encode(["uint256"], [1394785395n]);

  const out = await runBaseOnce({
    execute: false,
    executorAddress: EXEC,
    resolve: async () => "offline-base",
    transport: async (_rpc, method) => {
      if (method === "eth_chainId") return "0x2105";
      if (method === "eth_getBlockByNumber") return { number: "0x3263800", hash: "0x" + "ab".repeat(32), timestamp: "0x6ad49110", baseFeePerGas: "0x5f5e10" };
      if (method === "eth_call") {
        if (!outCalls++) return agg;
        return rate;
      }
      throw new Error("unexpected method " + method);
    },
  });
  assert.equal(out.ok, true);
  assert.equal(out.chainId, 8453);
  assert.equal(out.targets.length, 6);
  assert.equal(out.targets[0].rank, "#B0");
  assert.equal(out.targets[4].rank, "#B1");
  assert.equal(out.pollMode, "TURBO_SUB_5BPS");
  assert.equal(out.closestBps, Math.min(...out.targets.map(t => Number(t.bpsToLiquidation))));
});
let outCalls = 0;

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const guard = require("../lib/wallet-execution-guard.js");

const BASE_NOW = Date.parse("2026-10-20T00:00:00Z");
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const BASE_USDE = "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34";
const BASE_YOUSD = "0x0000000f2eb9f69274678c76222b35eec7588a65";
const BASE_YOUSD_MKT = "0x1a3e69d0109bb1be42b80e11034bb6ee98fc466721f26845dc83b2aa8d979137";
const BASE_YOUSD_ORACLE = "0x77f59c5c09e7abef6991b456170930324fe36222";
const YO_PRICE = 10678n * 10n ** 32n;
const B7_C3 = {
  borrowerShares: 3727803099418226n, accruedBorrow: 273899777069n, totalBorrowShares: 252041854962215031n,
  collateral: 4162749493n, price: 1067877000000000000000000000000000000n,
};
const ERC4626_IFACE = new ethers.Interface([
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "function redeem(uint256 shares,address receiver,address owner) returns (uint256)",
]);
const BLUE_READS = new ethers.Interface(["function market(bytes32)", "function position(bytes32,address)", "function price()"]);
const IRM_READS = new ethers.Interface([
  "function borrowRateView((address,address,address,address,uint256),(uint128,uint128,uint128,uint128,uint128,uint128)) view returns (uint256)",
]);
const BASE_MULTICALL = "0xca11bde05977b3631167028862be2a173976ca11";
const BASE_IRM = "0x46415998764c29ab2a25cbea6254146d50d22687";
const BASE_QUOTER_V2 = "0x3d4e44eb1374240ce5f1b871ab261cd16335b76a";
const BASE_GAS_PRICE_ORACLE = "0x420000000000000000000000000000000000000f";
const BASE_B0 = "0x60753e8622a6cfea1df449a9625a9778bb922b72";
const BASE_B1 = "0xb4fb31e7b1471a8e52dd1e962a281a732ead59c1";
const BASE_GAIN = 250_000000n;
const baseHex = n => "0x" + BigInt(n).toString(16);
const BASE_HEADER = {
  number: "0x3263800",
  hash: "0x" + "ab".repeat(32),
  timestamp: baseHex(BigInt(BASE_NOW / 1000) - 10n),
  baseFeePerGas: baseHex(6250000n),
};
const BASE_PIN = { blockHash: BASE_HEADER.hash, requireCanonical: true };
const BASE_EXEC_IFACE = new ethers.Interface([
  "function execute((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv,address borrower,uint256 seizedAssets,address router,uint256 minLoanOut) plan,bytes swapData)",
]);
const QUOTER_V2_IFACE = new ethers.Interface([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) view returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
const L1_GAS_ORACLE_IFACE = new ethers.Interface(["function getL1Fee(bytes data) view returns (uint256)"]);
const SWAP_IFACE = new ethers.Interface([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
]);

function baseExecutionFixture(t, options = {}) {
  const temporary = process.platform === "win32" ? path.join(os.tmpdir(), "opencode") : os.tmpdir();
  fs.mkdirSync(temporary, { recursive: true });
  const root = fs.mkdtempSync(path.join(temporary, "base-morpho-execution-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executionOptions = {
    lockRoot: path.join(root, "locks"),
    journalDir: path.join(root, "journal"),
    receiptWaitMs: 0,
  };
  const calls = [];
  const state = { signed: 0, sent: 0, nonces: 0, tx: null };
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const mc = new ethers.Interface([
    "function aggregate3((address target,bool allowFailure,bytes callData)[]) returns ((bool success,bytes returnData)[])",
  ]);
  const elapsed = 3600n, rate = 10n ** 12n;
  const market = [
    400_000_000_000000n, 0n, 350_000_000_000000n, 350_000_000_000000000000n,
    BigInt(BASE_HEADER.timestamp) - elapsed, 0n,
  ];
  const positions = [
    [0n, 340_855_000000000000n, 372_637n * W],
    [0n, 100_000n * 10n ** 12n, 200_000n * W],
    [0n, 200_000n * 10n ** 12n, 400_000n * W],
    [0n, 300_000n * 10n ** 12n, 600_000n * W],
    [0n, (options.bothLiquidatable ? 29_150_000n : 28_807_000n) * 10n ** 12n, 31_876_212n * W],
    [0n, 126_756_000_000000000000n, 140_794_000n * W],
  ];
  const price = options.oraclePrice ?? 10n ** 24n;
  const rows = [
    coder.encode(["uint128", "uint128", "uint128", "uint128", "uint128", "uint128"], market),
    coder.encode(["uint256"], [price]),
    ...positions.map(position => coder.encode(["uint256", "uint128", "uint128"], position)),
  ];
  const aggregate = mc.encodeFunctionResult("aggregate3", [
    rows.map(returnData => ({ success: true, returnData })),
  ]);

  const run = (overrides = {}) => runBaseOnce({
    execute: true,
    writeOut: false,
    executorAddress: EXEC,
    batch: options.batch ?? validBatch(),
    now: () => BASE_NOW,
    executionOptions,
    secondaryRpc: options.secondaryRpc,
    requireLiveQuote: options.requireLiveQuote,
    resolve: async chainId => {
      assert.equal(chainId, 8453);
      return "offline-base";
    },
    signTransaction: async tx => {
      state.signed++;
      state.tx = tx;
      return "0x010203";
    },
    transport: async (rpc, method, params) => {
      calls.push({ rpc, method, params });
      if (rpc === "offline-base-secondary") {
        if (method === "eth_chainId") return options.secondaryChainId ?? "0x2105";
        if (method === "eth_getBlockByNumber") {
          assert.deepEqual(params, [BASE_HEADER.number, false]);
          return { ...BASE_HEADER, hash: Object.hasOwn(options, "secondaryHash") ? options.secondaryHash : BASE_HEADER.hash };
        }
        assert.equal(method, "eth_call");
        assert.deepEqual(params[1], BASE_PIN);
        assert.equal(params[0].to, EXEC); assert.equal(params[0].from, guard.MAIN_ACCOUNT);
        if (options.secondaryRevert) throw new guard.ExecutionError("CALL_REVERTED");
        return options.secondarySimulation ?? "0x";
      }
      assert.equal(rpc, "offline-base");
      if (method === "eth_chainId") return options.chainId ?? "0x2105";
      if (method === "eth_getBlockByNumber") {
        assert.deepEqual(params, ["latest", false]);
        return BASE_HEADER;
      }
      if (method === "eth_call" || method === "eth_estimateGas") {
        assert.deepEqual(params[1], BASE_PIN);
        const call = params[0];
        if (method === "eth_call" && call.to === BASE_MULTICALL) {
          const calls1 = mc.decodeFunctionData("aggregate3", call.data)[0];
          if (calls1.length === 3) {
            if (!options.yousd) throw new Error("OPTIONAL_YOUSD_UNAVAILABLE");
            const yoMarket = options.yoMarket ?? [100000_000000n, 0n, 50000_000000n, 50000_000000000000n, BigInt(BASE_HEADER.timestamp), 0n];
            const yoPosition = options.yoPosition ?? [0n, (options.yoDebt ?? 4500_000000n) * 1000000n, options.yoCollateral ?? 4420_000000n];
            const yoRows = [coder.encode(Array(6).fill("uint128"), yoMarket), coder.encode(["uint256"], [options.yoPrice ?? YO_PRICE]),
              coder.encode(["uint256", "uint128", "uint128"], yoPosition)];
            return mc.encodeFunctionResult("aggregate3", [yoRows.map((returnData, i) => ({ success: options.yoFailedRead !== i, returnData }))]);
          }
          assert.equal(calls1.length, 8);
          return aggregate;
        }
        if (method === "eth_call" && call.to === BASE_IRM) {
          if (IRM_READS.decodeFunctionData("borrowRateView", call.data)[0][1].toLowerCase() === BASE_YOUSD) {
            return options.yoRateRaw ?? coder.encode(["uint256"], [2000000000n]);
          }
          return coder.encode(["uint256"], [rate]);
        }
        if (method === "eth_call" && call.to === BASE_YOUSD) {
          if (Object.hasOwn(options, "yoPreviewRaw")) return options.yoPreviewRaw;
          return ERC4626_IFACE.encodeFunctionResult("previewRedeem", [options.yoPreview ?? 4377_970000n]);
        }
        if (method === "eth_call" && call.to === BASE_QUOTER_V2) {
          if (Object.hasOwn(options, "quoteRaw")) return options.quoteRaw;
          return options.quote === undefined ? "0x" : QUOTER_V2_IFACE.encodeFunctionResult("quoteExactInputSingle", [options.quote, 0n, 0n, 100000n]);
        }
        if (method === "eth_call" && call.to === BASE_GAS_PRICE_ORACLE) {
          if (Object.hasOwn(options, "l1Raw")) return options.l1Raw;
          return options.l1FeeWei === undefined ? "0x" : L1_GAS_ORACLE_IFACE.encodeFunctionResult("getL1Fee", [options.l1FeeWei]);
        }
        assert.equal(call.from, guard.MAIN_ACCOUNT);
        assert.equal(call.to, EXEC);
        const plan = BASE_EXEC_IFACE.decodeFunctionData("execute", call.data)[0];
        if (method === "eth_call") {
          if ((options.revertBorrowers || []).includes(plan.borrower.toLowerCase())) {
            throw new guard.ExecutionError("CALL_REVERTED");
          }
          return "0x";
        }
        return baseHex(options.gasEstimate ?? 500000n);
      }
      if (method === "eth_getTransactionCount") {
        state.nonces++;
        assert.equal(params[0], guard.MAIN_ACCOUNT);
        assert.ok(params[1] === "latest" || params[1] === "pending");
        return baseHex(params[1] === "pending" ? options.pendingNonce ?? 7n : 7n);
      }
      if (method === "eth_sendRawTransaction") {
        state.sent++;
        assert.equal(params[0], "0x010203");
        return ethers.keccak256(params[0]);
      }
      if (method === "eth_getTransactionReceipt") {
        assert.equal(params[0], ethers.keccak256("0x010203"));
        const receipt = {
          transactionHash: params[0],
          from: guard.MAIN_ACCOUNT,
          to: EXEC,
          blockHash: "0x" + "cd".repeat(32),
          blockNumber: baseHex(BigInt(BASE_HEADER.number) + 1n),
          transactionIndex: "0x0",
          status: "0x1",
          gasUsed: baseHex(500000n),
          effectiveGasPrice: baseHex(6250000n),
          logs: [],
        };
        const transfer = {
          address: BASE_USDC,
          topics: [
            ethers.id("Transfer(address,address,uint256)"),
            ethers.zeroPadValue(EXEC, 32),
            ethers.zeroPadValue(guard.MAIN_ACCOUNT, 32),
          ],
          data: coder.encode(["uint256"], [BASE_GAIN]),
          logIndex: "0x0",
          blockHash: receipt.blockHash,
          blockNumber: receipt.blockNumber,
          transactionHash: receipt.transactionHash,
          transactionIndex: receipt.transactionIndex,
          removed: false,
        };
        receipt.logs = [
          transfer,
          { ...transfer, address: BASE_USDE, data: coder.encode(["uint256"], [999n * W]), logIndex: "0x1" },
        ];
        return receipt;
      }
      assert.fail("unexpected offline method " + method);
    },
    ...overrides,
  });
  return { run, calls, state, executionOptions, market, positions, price, rate, elapsed };
}

function baseJournalRecords(f) {
  const directory = f.executionOptions.journalDir;
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(name => name.endsWith(".json"))
    .map(name => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")));
}

function assertBaseNotSigned(f) {
  assert.equal(f.state.signed, 0);
  assert.equal(f.state.sent, 0);
  assert.equal(f.state.tx, null);
  assert.deepEqual(baseJournalRecords(f), []);
}

test("runBaseOnce executes accrued-underwater B0 at the Base pin and verifies executor-to-owner USDC gains", async t => {
  const f = baseExecutionFixture(t);
  const out = await f.run();
  assert.equal(out.targets[0].borrower, BASE_B0);
  assert.equal(out.targets[0].isLiquidatable, true);
  assert.deepEqual(out.targets.map(row => row.isLiquidatable), [true, false, false, false, false, false]);
  assert.equal(out.firedCount, 1);
  assert.equal(out.chainId, 8453);
  assert.equal(f.state.signed, 1);
  assert.equal(f.state.sent, 1);
  assert.equal(f.state.tx.chainId, 8453);
  assert.equal(f.state.tx.value, 0n);
  const record = out.execution;
  assert.equal(record.stage, "RECEIPT_VERIFIED");
  assert.equal(record.chainId, 8453);
  assert.equal(record.intent.targetId, USDE_PLANS[0].id);
  assert.equal(record.intent.profitToken, BASE_USDC);
  assert.equal(record.actualTokenGainRaw, BASE_GAIN.toString());
  assert.equal(record.tokenGainEvidence, "VALIDATED_EXECUTOR_TO_OWNER_TRANSFER_LOGS");
  assert.deepEqual(baseJournalRecords(f), [record]);
});

test("runBaseOnce falls back from B0 CALL_REVERTED to B1 without signing or journaling B0", async t => {
  const f = baseExecutionFixture(t, { bothLiquidatable: true, revertBorrowers: [BASE_B0] });
  const out = await f.run();
  assert.deepEqual(out.targets.map(row => row.isLiquidatable), [true, false, false, false, true, false]);
  assert.equal(out.firedCount, 2);
  assert.equal(f.state.signed, 1);
  assert.equal(f.state.sent, 1);
  assert.equal(out.execution.stage, "RECEIPT_VERIFIED");
  assert.equal(out.execution.intent.targetId, USDE_PLANS[4].id);
  assert.equal(out.execution.actualTokenGainRaw, BASE_GAIN.toString());
});

test("runBaseOnce rejects non-Base RPC, zero oracle price, pending nonce mismatch, and gas caps", async t => {
  const wrongRpc = baseExecutionFixture(t, { chainId: "0x1" });
  await assert.rejects(wrongRpc.run(), { code: "WRONG_CHAIN" });
  assertBaseNotSigned(wrongRpc);

  const zeroPrice = baseExecutionFixture(t, { oraclePrice: 0n });
  await assert.rejects(zeroPrice.run(), { code: "BASE_ZERO_ORACLE_PRICE" });
  assertBaseNotSigned(zeroPrice);

  const mismatch = baseExecutionFixture(t, { pendingNonce: 8n });
  await assert.rejects(mismatch.run(), { code: "NONCE_PENDING_MISMATCH" });
  assertBaseNotSigned(mismatch);

  const overGas = baseExecutionFixture(t, { gasEstimate: 583334n });
  const out = await overGas.run();
  assert.equal(out.armed, false);
  assert.equal(out.reason, "NO_CANDIDATE_PASSED_PREFLIGHT");
  assert.deepEqual(out.preflightFailures, [{ targetId: USDE_PLANS[0].id, reason: "EXEC_GAS_EXCEEDS_CAP" }]);
  assertBaseNotSigned(overGas);
});

test("buildBaseExecutionCalldata uses the 50-bps quote floor without relaxing the repayment-plus-profit floor", () => {
  const plan = USDE_PLANS[0], collateral = 100000n * W, price = 10n ** 24n;
  const unquoted = buildBaseExecutionCalldata(EXEC, plan, collateral, price);
  const quoted = buildBaseExecutionCalldata(EXEC, plan, collateral, price, 100000000000n);
  assert.equal(quoted.seize, collateral);
  assert.equal(quoted.repayEstUsdc, unquoted.repayEstUsdc);
  assert.equal(quoted.minLoanOut, 100000000000n * 9950n / 10000n);
  assert.ok(quoted.minLoanOut > unquoted.minLoanOut);
  assert.throws(() => buildBaseExecutionCalldata(EXEC, plan, collateral, price, unquoted.minLoanOut - 1n), { code: "QUOTE_BELOW_PROFIT_FLOOR" });
  assert.throws(() => buildBaseExecutionCalldata(EXEC, plan, collateral, price, unquoted.minLoanOut), { code: "SLIPPAGE_FLOOR_BELOW_PROFIT_FLOOR" });
  const threshold = (unquoted.minLoanOut * 10000n + 9949n) / 9950n;
  assert.equal(buildBaseExecutionCalldata(EXEC, plan, collateral, price, threshold).minLoanOut, unquoted.minLoanOut);
  assert.throws(() => buildBaseExecutionCalldata(EXEC, plan, collateral, price, threshold - 1n), { code: "SLIPPAGE_FLOOR_BELOW_PROFIT_FLOOR" });
  for (const absent of [null, undefined]) assert.deepEqual(buildBaseExecutionCalldata(EXEC, plan, collateral, price, absent), unquoted);
});

test("runBaseOnce binds the live QuoterV2 call to the Base pin and signs only the quote-rebuilt executor and swap floors", async t => {
  const quote = 345000000000n, f = baseExecutionFixture(t, { quote, requireLiveQuote: true });
  const out = await f.run();
  assert.equal(out.execution.stage, "RECEIPT_VERIFIED");
  const decoded = BASE_EXEC_IFACE.decodeFunctionData("execute", f.state.tx.data), p = decoded[0];
  const swap = SWAP_IFACE.decodeFunctionData("exactInputSingle", decoded[1])[0];
  assert.equal(p.minLoanOut, quote * 9950n / 10000n);
  assert.equal(swap.amountOutMinimum, p.minLoanOut);
  assert.equal(swap.amountIn, p.seizedAssets); assert.equal(swap.recipient.toLowerCase(), EXEC);
  const quoteCalls = f.calls.filter(c => c.method === "eth_call" && c.params[0].to === BASE_QUOTER_V2);
  assert.equal(quoteCalls.length, 1);
  assert.deepEqual(quoteCalls[0].params[1], BASE_PIN);
  const q = QUOTER_V2_IFACE.decodeFunctionData("quoteExactInputSingle", quoteCalls[0].params[0].data)[0];
  assert.equal(q.tokenIn.toLowerCase(), BASE_USDE); assert.equal(q.tokenOut.toLowerCase(), BASE_USDC);
  assert.equal(q.amountIn, p.seizedAssets); assert.equal(q.fee, 500n); assert.equal(q.fee, swap.fee); assert.equal(q.sqrtPriceLimitX96, 0n);
  const simulations = f.calls.filter(c => c.method === "eth_call" && c.params[0].to === EXEC);
  assert.equal(simulations.length, 1); assert.equal(simulations[0].params[0].data, f.state.tx.data);
  assert.ok(f.calls.indexOf(quoteCalls[0]) < f.calls.indexOf(simulations[0]));
});

test("runBaseOnce rejects insufficient quotes and missing required quotes before simulation or signing", async t => {
  const floor = buildBaseExecutionCalldata(EXEC, USDE_PLANS[0], 372637n * W, 10n ** 24n).minLoanOut;
  for (const [options, reason] of [
    [{ quote: floor - 1n }, "QUOTE_BELOW_PROFIT_FLOOR"],
    [{ quote: floor }, "SLIPPAGE_FLOOR_BELOW_PROFIT_FLOOR"],
    [{ quoteRaw: null, requireLiveQuote: true }, "BASE_LIVE_QUOTE_UNAVAILABLE"],
    [{ quoteRaw: "0x", requireLiveQuote: true }, "BASE_LIVE_QUOTE_UNAVAILABLE"],
  ]) {
    const f = baseExecutionFixture(t, options), out = await f.run();
    assert.equal(out.armed, false);
    assert.deepEqual(out.preflightFailures, [{ targetId: USDE_PLANS[0].id, reason }]);
    assert.equal(f.calls.some(c => c.method === "eth_call" && c.params[0].to === EXEC), false);
    assertBaseNotSigned(f);
  }
});

test("runBaseOnce permits absent optional quote/L1 responses but rejects malformed quote ABI", async t => {
  for (const missing of [null, "0x"]) {
    const f = baseExecutionFixture(t, { quoteRaw: missing, l1Raw: missing }), out = await f.run();
    assert.equal(out.execution.stage, "RECEIPT_VERIFIED");
    const original = buildBaseExecutionCalldata(EXEC, USDE_PLANS[0], 372637n * W, 10n ** 24n);
    assert.equal(f.state.tx.data, original.data);
  }
  const malformed = baseExecutionFixture(t, { quoteRaw: "0x" + "00".repeat(32) });
  const out = await malformed.run();
  assert.equal(out.armed, false); assert.equal(out.preflightFailures.length, 1);
  assertBaseNotSigned(malformed);
});

test("runBaseOnce honors the authorized minimum profit when rebuilding a quoted plan", async t => {
  const batch = validBatch(); batch.caps.minProfitUsdcRawBase = "10000000000";
  const f = baseExecutionFixture(t, { batch, quote: 345000000000n }), out = await f.run();
  assert.equal(out.armed, false);
  assert.deepEqual(out.preflightFailures, [{ targetId: USDE_PLANS[0].id, reason: "QUOTE_BELOW_PROFIT_FLOOR" }]);
  assertBaseNotSigned(f);
});

test("runBaseOnce adds pinned OP-Stack L1 fee to maximum L2 spend and enforces the exact cap boundary", async t => {
  const caps = validateBaseAuthorization(validBatch(), BASE_NOW);
  const fees = guard.buildFees(500000n, BigInt(BASE_HEADER.baseFeePerGas), caps);
  const l2Spend = fees.gasLimit * fees.maxFeePerGas, remaining = caps.spendCap - l2Spend;
  assert.ok(remaining > 0n);
  for (const delta of [-1n, 0n, 1n]) {
    const f = baseExecutionFixture(t, { quote: 345000000000n, l1FeeWei: remaining + delta });
    const out = await f.run();
    const [call] = f.calls.filter(c => c.method === "eth_call" && c.params[0].to === BASE_GAS_PRICE_ORACLE);
    assert.ok(call); assert.deepEqual(call.params[1], BASE_PIN);
    const quotedData = L1_GAS_ORACLE_IFACE.decodeFunctionData("getL1Fee", call.params[0].data)[0];
    if (delta <= 0n) {
      assert.equal(out.execution.stage, "RECEIPT_VERIFIED");
      assert.equal(quotedData, f.state.tx.data);
      assert.equal(f.state.tx.gasLimit * f.state.tx.maxFeePerGas + remaining + delta, caps.spendCap + delta);
    } else {
      assert.equal(out.armed, false);
      assert.deepEqual(out.preflightFailures, [{ targetId: USDE_PLANS[0].id, reason: "TX_SPEND_CAP_WITH_L1_FEE_EXCEEDED" }]);
      assertBaseNotSigned(f);
    }
  }
});

test("runBaseOnce rechecks L1-inclusive spend when authorization tightens before signing", async t => {
  const f = baseExecutionFixture(t, { l1FeeWei: 10000000000000n });
  await assert.rejects(f.run({ loadBatch: () => {
    const batch = validBatch();
    if (f.state.nonces) batch.caps.maxNativeSpendPerTransactionWeiBase = "40000000000000";
    return batch;
  } }), { code: "TX_SPEND_CAP_WITH_L1_FEE_EXCEEDED" });
  assertBaseNotSigned(f);
});

test("optional secondary RPC verifies Base chain and exact numbered block before corroborating the rebuilt simulation", async t => {
  const f = baseExecutionFixture(t, { secondaryRpc: "offline-base-secondary", quote: 345000000000n });
  const out = await f.run();
  assert.equal(out.execution.stage, "RECEIPT_VERIFIED");
  const secondary = f.calls.filter(c => c.rpc === "offline-base-secondary");
  assert.deepEqual(secondary.map(c => c.method), ["eth_chainId", "eth_getBlockByNumber", "eth_call"]);
  assert.deepEqual(secondary[1].params, [BASE_HEADER.number, false]);
  const primarySim = f.calls.find(c => c.rpc === "offline-base" && c.method === "eth_call" && c.params[0].to === EXEC);
  assert.deepEqual(secondary[2].params, primarySim.params);
  assert.equal(secondary[2].params[0].data, f.state.tx.data);
  assert.ok(f.calls.indexOf(secondary[2]) < f.calls.findIndex(c => c.method === "eth_getTransactionCount"));
});

test("optional secondary RPC fails closed for wrong chain, pin mismatch, simulation mismatch or revert", async t => {
  for (const options of [{ secondaryChainId: "0x1" }, { secondaryChainId: "invalid" },
    { secondaryHash: "0x" + "cd".repeat(32) }, { secondaryHash: null }]) {
    const f = baseExecutionFixture(t, { secondaryRpc: "offline-base-secondary", ...options });
    await assert.rejects(f.run(), { code: "BASE_SECONDARY_PIN_MISMATCH" });
    assertBaseNotSigned(f);
    assert.equal(f.calls.some(c => c.method === "eth_call"), false);
  }
  for (const [options, reason] of [[{ secondarySimulation: "0x01" }, "BASE_SECONDARY_SIMULATION_MISMATCH"], [{ secondaryRevert: true }, "CALL_REVERTED"]]) {
    const f = baseExecutionFixture(t, { secondaryRpc: "offline-base-secondary", ...options }), out = await f.run();
    assert.equal(out.armed, false);
    assert.deepEqual(out.preflightFailures, [{ targetId: USDE_PLANS[0].id, reason }]);
    assertBaseNotSigned(f);
  }
});

test("B7 builds a six-decimal redeem capped to collateral and enforces principal plus profit", () => {
  const plan = BASE_TARGET_PLANS[0];
  assert.equal(plan.id, "base-b7-yousd-usdc-0x108b");
  assert.equal(plan.kind, "YOUSD_REDEEM");
  assert.equal(plan.maxSeizeYoUsd, 4100000000n);
  assert.equal(plan.minProfitUsdc, 100000000n);
  for (const collateral of [5000_000000n, 4100_000000n, 1000_000000n]) {
    const built = buildBaseExecutionCalldata(EXEC, plan, collateral, YO_PRICE);
    const [p, swapData] = BASE_EXEC_IFACE.decodeFunctionData("execute", built.data);
    const seize = collateral < plan.maxSeizeYoUsd ? collateral : plan.maxSeizeYoUsd;
    assert.equal(built.seize, seize);
    assert.equal(built.principal, seize * YO_PRICE / (10n ** 36n));
    assert.equal(p.minLoanOut, built.principal + 100000000n);
    assert.notEqual(p.minLoanOut, built.repayEstUsdc + 100000000n);
    assert.equal(p.loanToken.toLowerCase(), BASE_USDC);
    assert.equal(p.collateralToken.toLowerCase(), BASE_YOUSD);
    assert.equal(p.oracle.toLowerCase(), BASE_YOUSD_ORACLE);
    assert.equal(p.irm.toLowerCase(), BASE_IRM);
    assert.equal(p.lltv, 915000000000000000n);
    assert.equal(p.borrower.toLowerCase(), plan.borrower);
    assert.equal(p.router.toLowerCase(), BASE_YOUSD);
    assert.equal(swapData, ERC4626_IFACE.encodeFunctionData("redeem", [seize, EXEC, EXEC]));
    const floor = built.repayEstUsdc + plan.minProfitUsdc;
    assert.equal(buildBaseExecutionCalldata(EXEC, plan, collateral, YO_PRICE, floor).data, built.data);
    assert.throws(() => buildBaseExecutionCalldata(EXEC, plan, collateral, YO_PRICE, floor - 1n), { code: "QUOTE_BELOW_PROFIT_FLOOR" });
  }
  assert.throws(() => buildBaseExecutionCalldata(EXEC, plan, 0n, YO_PRICE), { code: "BASE_ZERO_COLLATERAL" });
});

test("B7 C3 share cap prevents the old 4100-share seizure from exceeding borrower borrowShares", () => {
  const { borrowerShares, accruedBorrow, totalBorrowShares, price } = B7_C3;
  const cap = maxSeizeByBorrowShares(borrowerShares, accruedBorrow, totalBorrowShares, price);
  assert.equal(cap, 3892861030n);
  const ceil = (a, b) => (a + b - 1n) / b;
  const sharesToRepay = seize => ceil(ceil(ceil(seize * price, 10n ** 36n) * W, 1026167265264238070n) *
    (totalBorrowShares + 1000000n), accruedBorrow + 1n);
  assert.ok(sharesToRepay(4100000000n) > borrowerShares);
  assert.ok(sharesToRepay(cap) <= borrowerShares);
  assert.equal(ceil(sharesToRepay(cap) * (accruedBorrow + 1n), totalBorrowShares + 1000000n), 4051090793n);
});

test("B7 C3 calldata uses the share-bounded seize and exact rounded repayment before its profit check", () => {
  const plan = BASE_TARGET_PLANS[0];
  const built = buildBaseExecutionCalldata(EXEC, plan, B7_C3.collateral, B7_C3.price, null, B7_C3);
  assert.equal(built.seize, 3892861030n);
  assert.equal(built.repayEstUsdc, 4051090793n);
  const [encoded, swap] = BASE_EXEC_IFACE.decodeFunctionData("execute", built.data);
  assert.equal(encoded.seizedAssets, 3892861030n);
  assert.equal(swap, ERC4626_IFACE.encodeFunctionData("redeem", [3892861030n, EXEC, EXEC]));
  assert.equal(built.principal, built.seize * B7_C3.price / (10n ** 36n));
  assert.equal(built.minLoanOut, built.principal + plan.minProfitUsdc);
  const floor = 4051090793n + plan.minProfitUsdc;
  assert.deepEqual(buildBaseExecutionCalldata(EXEC, plan, B7_C3.collateral, B7_C3.price, floor, B7_C3), built);
  assert.throws(() => buildBaseExecutionCalldata(EXEC, plan, B7_C3.collateral, B7_C3.price, floor - 1n, B7_C3), { code: "QUOTE_BELOW_PROFIT_FLOOR" });
  const collateralBound = buildBaseExecutionCalldata(EXEC, plan, 1000_000000n, B7_C3.price, null, B7_C3);
  assert.equal(collateralBound.seize, 1000_000000n);
});

test("B7 runBaseOnce preserves the borrow-share bound through preview, quote rebuilding and mocked execution", async t => {
  // Synthetic underwater collateral variation of the supplied C3 debt state;
  // the actual C3 health state is not asserted to be currently liquidatable.
  const f = baseExecutionFixture(t, { yousd: true, yoPrice: B7_C3.price,
    yoMarket: [300000_000000n, 0n, B7_C3.accruedBorrow, B7_C3.totalBorrowShares, BigInt(BASE_HEADER.timestamp), 0n],
    yoPosition: [0n, B7_C3.borrowerShares, 4100000000n], yoPreview: 4160_000000n });
  const out = await f.run();
  assert.equal(out.targets[0].isLiquidatable, true);
  assert.equal(out.execution.intent.targetId, BASE_TARGET_PLANS[0].id);
  assert.equal(out.execution.stage, "RECEIPT_VERIFIED");
  const preview = f.calls.find(c => c.method === "eth_call" && c.params[0].to === BASE_YOUSD);
  assert.equal(ERC4626_IFACE.decodeFunctionData("previewRedeem", preview.params[0].data)[0], 3892861030n);
  const [encoded, swap] = BASE_EXEC_IFACE.decodeFunctionData("execute", f.state.tx.data);
  assert.equal(encoded.seizedAssets, 3892861030n);
  assert.equal(swap, ERC4626_IFACE.encodeFunctionData("redeem", [3892861030n, EXEC, EXEC]));
  const simulations = f.calls.filter(c => c.method === "eth_call" && c.params[0].to === EXEC);
  assert.equal(simulations.length, 1);
  assert.equal(simulations[0].params[0].data, f.state.tx.data);
});

test("B7 takes first priority, pins previewRedeem and executes the redeem plan with a USDC receipt", async t => {
  const f = baseExecutionFixture(t, { yousd: true }), out = await f.run();
  assert.deepEqual(out.targets.map(row => row.rank), ["#B7", "#B0", "#B4", "#B5", "#B6", "#B1", "#B2"]);
  assert.equal(out.targets[0].isLiquidatable, true);
  assert.equal(out.targets[0].passiveHoursToCrossing, 0);
  assert.equal(out.targets[1].isLiquidatable, true);
  assert.equal(out.execution.intent.targetId, BASE_TARGET_PLANS[0].id);
  assert.equal(out.execution.stage, "RECEIPT_VERIFIED");
  assert.equal(out.execution.actualTokenGainRaw, BASE_GAIN.toString());
  assert.equal(f.state.signed, 1); assert.equal(f.state.sent, 1);
  const [p, swapData] = BASE_EXEC_IFACE.decodeFunctionData("execute", f.state.tx.data);
  assert.equal(p.borrower.toLowerCase(), BASE_TARGET_PLANS[0].borrower);
  assert.equal(p.minLoanOut, 4100_000000n * YO_PRICE / (10n ** 36n) + 100000000n);
  assert.equal(swapData, ERC4626_IFACE.encodeFunctionData("redeem", [4100_000000n, EXEC, EXEC]));
  const preview = f.calls.filter(c => c.method === "eth_call" && c.params[0].to === BASE_YOUSD);
  assert.equal(preview.length, 1); assert.deepEqual(preview[0].params[1], BASE_PIN);
  assert.equal(preview[0].params[0].data, ERC4626_IFACE.encodeFunctionData("previewRedeem", [4100_000000n]));
  assert.equal(f.calls.some(c => c.method === "eth_call" && c.params[0].to === BASE_QUOTER_V2), false);
  const mc = new ethers.Interface(["function aggregate3((address,bool,bytes)[]) returns ((bool,bytes)[])"]);
  const batches = f.calls.filter(c => c.method === "eth_call" && c.params[0].to === BASE_MULTICALL)
    .map(c => mc.decodeFunctionData("aggregate3", c.params[0].data)[0]);
  assert.deepEqual(batches.map(b => b.length), [8, 3]);
  assert.equal(BLUE_READS.decodeFunctionData("market", batches[1][0][2])[0], BASE_YOUSD_MKT);
  assert.equal(batches[1][1][0].toLowerCase(), BASE_YOUSD_ORACLE);
  assert.equal(batches[1][1][2], BLUE_READS.encodeFunctionData("price"));
  const pos = BLUE_READS.decodeFunctionData("position", batches[1][2][2]);
  assert.equal(pos[0], BASE_YOUSD_MKT); assert.equal(pos[1].toLowerCase(), BASE_TARGET_PLANS[0].borrower);
  const rates = f.calls.filter(c => c.method === "eth_call" && c.params[0].to === BASE_IRM);
  const yoRate = IRM_READS.decodeFunctionData("borrowRateView", rates[1].params[0].data);
  assert.deepEqual(Array.from(yoRate[0]).slice(0, 4).map(a => a.toLowerCase()), [BASE_USDC, BASE_YOUSD, BASE_YOUSD_ORACLE, BASE_IRM]);
});

test("B7 unavailable market/rate or healthy health leaves the six USDe targets executable", async t => {
  for (const options of [{ yoFailedRead: 0 }, { yoFailedRead: 1 }, { yoFailedRead: 2 }, { yoPrice: 0n }, { yoRateRaw: "0x" }, { yoDebt: 4000_000000n }]) {
    const f = baseExecutionFixture(t, { yousd: true, ...options }), out = await f.run();
    assert.equal(out.execution.intent.targetId, USDE_PLANS[0].id);
    assert.equal(out.targets.length, options.yoDebt ? 7 : 6);
    if (options.yoDebt) {
      assert.equal(out.targets[0].isLiquidatable, false);
      assert.ok(out.targets[0].passiveHoursToCrossing > 0);
    }
    assert.equal(f.calls.some(c => c.method === "eth_call" && c.params[0].to === BASE_YOUSD), false);
  }
});

test("B7 missing or insufficient preview cannot reach simulation/signing and does not relax authorized profit", async t => {
  const batch = validBatch(); batch.caps.minProfitUsdcRawBase = "200000000";
  for (const [options, reason] of [
    [{ yoPreviewRaw: "0x" }, "BASE_LIVE_QUOTE_UNAVAILABLE"],
    [{ yoPreviewRaw: null }, "BASE_LIVE_QUOTE_UNAVAILABLE"],
    [{ yoPreview: 1n }, "QUOTE_BELOW_PROFIT_FLOOR"],
    [{ batch }, "QUOTE_BELOW_PROFIT_FLOOR"],
  ]) {
    const f = baseExecutionFixture(t, { yousd: true, revertBorrowers: [BASE_B0], ...options }), out = await f.run();
    assert.equal(out.armed, false);
    assert.deepEqual(out.preflightFailures, [{ targetId: BASE_TARGET_PLANS[0].id, reason }, { targetId: USDE_PLANS[0].id, reason: "CALL_REVERTED" }]);
    const simulations = f.calls.filter(c => c.method === "eth_call" && c.params[0].to === EXEC);
    assert.ok(simulations.every(c => BASE_EXEC_IFACE.decodeFunctionData("execute", c.params[0].data)[0].borrower.toLowerCase() !== BASE_TARGET_PLANS[0].borrower));
    assertBaseNotSigned(f);
  }
});

test("B7 fork scenario calls the deployed executor under a -5 bps tick, checks owner gain and restores its snapshot", async () => {
  const scenario = require("../fork-poc/verify-base-yousd-usdc-liquidation.js");
  const deployed = "0x88bff83b4c987cc90a863cd79baa54dd5cd94f32";
  const abi = new ethers.Interface(require("../fork-poc/contracts/MorphoLiquidateUnwindBaseRoundTrip.compiled.json").abi);
  const reads = new ethers.Interface([
    "function idToMarketParams(bytes32) view returns (address,address,address,address,uint256)",
    "function price() view returns (uint256)", "function balanceOf(address) view returns (uint256)",
  ]);
  for (const gain of [100000000n, 99999999n]) {
    const state = { sent: false, restored: false, stopped: false, simulated: null, logs: [] };
    const shocked = YO_PRICE * 9995n / 10000n;
    const ctx = {
      chainId: 8453, ethers,
      assert: (condition, label) => assert.ok(condition, label),
      log: (label, value) => state.logs.push({ label, value }),
      snapshot: async () => "snapshot-b7",
      setBalance: async account => assert.equal(account, OWNER),
      setCode: async (address, code) => {
        assert.equal(address, BASE_YOUSD_ORACLE);
        assert.equal(code, `0x7f${shocked.toString(16).padStart(64, "0")}60005260206000f3`);
      },
      call: async ({ to, data, from }) => {
        if (data.startsWith(reads.getFunction("idToMarketParams").selector)) {
          assert.equal(to, "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb");
          assert.equal(reads.decodeFunctionData("idToMarketParams", data)[0], BASE_YOUSD_MKT);
          return reads.encodeFunctionResult("idToMarketParams", [BASE_USDC, BASE_YOUSD, BASE_YOUSD_ORACLE, BASE_IRM, 915000000000000000n]);
        }
        if (to === BASE_YOUSD_ORACLE) return reads.encodeFunctionResult("price", [YO_PRICE]);
        if (to === BASE_USDC || to === BASE_YOUSD) {
          const account = reads.decodeFunctionData("balanceOf", data)[0].toLowerCase();
          return reads.encodeFunctionResult("balanceOf", [account === OWNER && state.sent ? gain : 0n]);
        }
        assert.equal(to, deployed);
        const parsed = abi.parseTransaction({ data });
        if (parsed.name === "actor") return abi.encodeFunctionResult("actor", [OWNER]);
        if (["liquidated", "unwound"].includes(parsed.name)) return abi.encodeFunctionResult(parsed.name, [state.sent]);
        assert.equal(parsed.name, "execute"); assert.equal(from, OWNER);
        state.simulated = data;
        return "0x";
      },
      send: async ({ from, to, data }) => {
        assert.equal(from, OWNER); assert.equal(to, deployed); assert.equal(data, state.simulated);
        const [p, swap] = abi.decodeFunctionData("execute", data);
        assert.equal(p.seizedAssets, 4100000000n);
        assert.equal(p.borrower.toLowerCase(), BASE_TARGET_PLANS[0].borrower);
        assert.equal(p.swapTarget.toLowerCase(), BASE_YOUSD);
        assert.equal(p.minLoanOut, 4100000000n * shocked / (10n ** 36n) + 100000000n);
        assert.equal(swap, ERC4626_IFACE.encodeFunctionData("redeem", [4100000000n, deployed, deployed]));
        state.sent = true;
        return { receipt: { gasUsed: "0x50000" } };
      },
      stopImpersonating: async account => { assert.equal(account, OWNER); state.stopped = true; },
      revert: async snapshot => { assert.equal(snapshot, "snapshot-b7"); state.restored = true; },
    };
    if (gain >= 100000000n) {
      await scenario.run(ctx);
      assert.equal(state.logs[0].value.ownerUsdcGainRaw, gain.toString());
    } else {
      await assert.rejects(scenario.run(ctx), /b7-owner-gain-at-least-100-usdc/);
    }
    assert.equal(state.sent, true); assert.equal(state.restored, true); assert.equal(state.stopped, true);
  }
  await assert.rejects(scenario.run({ chainId: 1, assert: (ok, label) => assert.ok(ok, label) }), /base-mainnet/);
});
