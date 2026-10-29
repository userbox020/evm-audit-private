"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const TARGET = path.join(ROOT, "targets", "cow-protocol-contracts");
const SEED = 0xc0a57e01n;
const FUZZ_CASES = 512;

const files = [
  "src/contracts/GPv2Settlement.sol",
  "src/contracts/GPv2VaultRelayer.sol",
  "src/contracts/libraries/GPv2Trade.sol",
  "src/contracts/libraries/GPv2Order.sol",
  "src/contracts/libraries/GPv2Interaction.sol",
  "src/contracts/libraries/GPv2Transfer.sol",
  "src/contracts/libraries/GPv2SafeERC20.sol",
  "src/contracts/libraries/SafeMath.sol",
  "src/contracts/libraries/SafeCast.sol",
  "src/contracts/mixins/GPv2Signing.sol",
  "src/contracts/mixins/ReentrancyGuard.sol",
  "src/contracts/GPv2AllowListAuthentication.sol",
  "src/contracts/interfaces/IVault.sol",
  "src/contracts/interfaces/IERC20.sol",
  "test/GPv2Settlement/ConservationStep1.t.sol",
  "test/GPv2Settlement/Swap/Balances.t.sol",
  "deployments/mainnet/GPv2Settlement.json",
  "README.md",
  "networks.json",
  "foundry.toml",
  "yarn.lock",
  "package.json",
];

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function ceilDiv(a, b) {
  assert(b > 0n);
  return a === 0n ? 0n : (a - 1n) / b + 1n;
}

function execute(order, executedAmount, sellPrice, buyPrice, priorFilled) {
  assert(order.sellAmount * sellPrice >= order.buyAmount * buyPrice, "limit");
  let executedSell;
  let executedBuy;
  let fee;
  let filled;
  if (order.kind === "sell") {
    executedSell = order.partial ? executedAmount : order.sellAmount;
    fee = order.partial ? (order.feeAmount * executedSell) / order.sellAmount : order.feeAmount;
    executedBuy = ceilDiv(executedSell * sellPrice, buyPrice);
    filled = priorFilled + executedSell;
    assert(filled <= order.sellAmount, "filled");
  } else {
    executedBuy = order.partial ? executedAmount : order.buyAmount;
    fee = order.partial ? (order.feeAmount * executedBuy) / order.buyAmount : order.feeAmount;
    executedSell = (executedBuy * buyPrice) / sellPrice;
    filled = priorFilled + executedBuy;
    assert(filled <= order.buyAmount, "filled");
  }
  return {
    makerSellDebit: executedSell + fee,
    receiverBuyCredit: executedBuy,
    executedSell,
    executedBuy,
    fee,
    filled,
  };
}

function order(kind, sellAmount, buyAmount, feeAmount, partial = false) {
  return { kind, sellAmount, buyAmount, feeAmount, partial };
}

function swapExecute(order_, sellDelta, buyDelta, priorFilled) {
  if (priorFilled !== 0n) throw new Error("filled");
  if (order_.kind === "sell") {
    assert.equal(sellDelta, order_.sellAmount);
    return { fee: order_.feeAmount, filled: order_.sellAmount, executedSell: sellDelta, executedBuy: buyDelta };
  }
  assert.equal(buyDelta, order_.buyAmount);
  return { fee: order_.feeAmount, filled: order_.buyAmount, executedSell: sellDelta, executedBuy: buyDelta };
}

function repeatedSettleFee(order_) {
  let source = 30n;
  let beneficiary = 0n;
  let filled = 0n;
  for (let i = 0; i < 3; i += 1) {
    const result = execute(order_, 0n, 1n, 1n, filled);
    assert(source >= result.fee);
    source -= result.fee;
    beneficiary += result.fee;
    filled = result.filled;
  }
  const snapshot = { source, beneficiary, filled };
  try {
    const fourth = execute(order_, 0n, 1n, 1n, filled);
    if (source < fourth.fee) throw new Error("fee transfer balance");
    throw new Error("fourth unexpectedly succeeded");
  } catch (error) {
    assert.match(error.message, /fee transfer balance/);
  }
  return {
    makerFeeSource: -30n,
    beneficiary: 30n,
    receiver: 0n,
    relayer: 0n,
    settlement: 0n,
    filled,
    standingAllowanceUnchanged: true,
    fourthExecutionRolledBack: snapshot.source === source && snapshot.beneficiary === beneficiary && snapshot.filled === filled,
    excessBeyondIntendedSingleFokFee: 20n,
  };
}

function repeatedSwapFee(order_, mode) {
  let source = 30n;
  let settlementFee = 0n;
  let filled = 0n;
  for (let i = 0; i < 3; i += 1) {
    const result = swapExecute(order_, 0n, 0n, filled);
    assert(source >= result.fee);
    source -= result.fee;
    settlementFee += result.fee;
    filled = result.filled;
  }
  const snapshot = { source, settlementFee, filled };
  try {
    const fourth = swapExecute(order_, 0n, 0n, filled);
    if (source < fourth.fee) throw new Error("fee transfer balance");
    throw new Error("fourth unexpectedly succeeded");
  } catch (error) {
    assert.match(error.message, /fee transfer balance/);
  }
  const beneficiaryAfterLaterEmptySettle = settlementFee;
  settlementFee = 0n;
  return {
    mode,
    makerFeeSource: -30n,
    receiver: 0n,
    relayer: 0n,
    filled,
    standingAllowanceOrAuthUnchanged: true,
    fourthExecutionRolledBack:
      snapshot.source === source && snapshot.settlementFee === beneficiaryAfterLaterEmptySettle && snapshot.filled === filled,
    swapDirectBeneficiaryPayout: 0n,
    beneficiaryAfterLaterEmptySettle,
    settlementFeeAfterCapture: settlementFee,
    boundaryConditional: true,
  };
}

let deterministicAssertions = 0;
function check(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  deterministicAssertions += 1;
}

const fullSell = execute(order("sell", 100n, 90n, 10n), 0n, 1n, 1n, 0n);
check(fullSell, {
  makerSellDebit: 110n,
  receiverBuyCredit: 100n,
  executedSell: 100n,
  executedBuy: 100n,
  fee: 10n,
  filled: 100n,
}, "full sell");

const fullBuy = execute(order("buy", 120n, 100n, 12n), 0n, 1n, 1n, 0n);
check(fullBuy, {
  makerSellDebit: 112n,
  receiverBuyCredit: 100n,
  executedSell: 100n,
  executedBuy: 100n,
  fee: 12n,
  filled: 100n,
}, "full buy");

const partialSell0 = execute(order("sell", 100n, 90n, 10n, true), 40n, 1n, 1n, 0n);
const partialSell1 = execute(order("sell", 100n, 90n, 10n, true), 60n, 1n, 1n, partialSell0.filled);
check(
  { debit: partialSell0.makerSellDebit + partialSell1.makerSellDebit, filled: partialSell1.filled },
  { debit: 110n, filled: 100n },
  "partial sell",
);

const partialBuy0 = execute(order("buy", 120n, 100n, 10n, true), 40n, 1n, 1n, 0n);
const partialBuy1 = execute(order("buy", 120n, 100n, 10n, true), 60n, 1n, 1n, partialBuy0.filled);
check(
  { debit: partialBuy0.makerSellDebit + partialBuy1.makerSellDebit, filled: partialBuy1.filled },
  { debit: 110n, filled: 100n },
  "partial buy",
);

assert.throws(() => execute(order("sell", 100n, 90n, 10n), 0n, 1n, 1n, fullSell.filled), /filled/);
deterministicAssertions += 1;

const crossA = execute(order("sell", 100n, 90n, 10n), 0n, 1n, 1n, 0n);
const crossB = execute(order("buy", 120n, 100n, 12n), 0n, 1n, 1n, 0n);
check(
  { tokenA: crossA.makerSellDebit - crossB.receiverBuyCredit, tokenB: crossB.makerSellDebit - crossA.receiverBuyCredit },
  { tokenA: 10n, tokenB: 12n },
  "cross residues",
);

assert.throws(() => execute(order("sell", 0n, 0n, 10n, true), 0n, 1n, 1n, 0n), /Division by zero/);
deterministicAssertions += 1;
assert.throws(() => execute(order("buy", 100n, 0n, 10n, true), 0n, 1n, 1n, 0n), /Division by zero/);
deterministicAssertions += 1;

const settleZeroSell = repeatedSettleFee(order("sell", 0n, 0n, 10n));
const settleZeroBuyAsymmetric = repeatedSettleFee(order("buy", 100n, 0n, 10n));
check(settleZeroSell, {
  makerFeeSource: -30n,
  beneficiary: 30n,
  receiver: 0n,
  relayer: 0n,
  settlement: 0n,
  filled: 0n,
  standingAllowanceUnchanged: true,
  fourthExecutionRolledBack: true,
  excessBeyondIntendedSingleFokFee: 20n,
}, "settle zero sell replay");
check(settleZeroBuyAsymmetric, {
  makerFeeSource: -30n,
  beneficiary: 30n,
  receiver: 0n,
  relayer: 0n,
  settlement: 0n,
  filled: 0n,
  standingAllowanceUnchanged: true,
  fourthExecutionRolledBack: true,
  excessBeyondIntendedSingleFokFee: 20n,
}, "settle asymmetric zero buy replay");

const swapErc20 = repeatedSwapFee(order("sell", 0n, 0n, 10n), "erc20");
const swapExternal = repeatedSwapFee(order("sell", 0n, 0n, 10n, true), "external");
const swapInternalAsymmetric = repeatedSwapFee(order("buy", 100n, 0n, 10n, true), "internal");
for (const [actual, mode] of [[swapErc20, "erc20"], [swapExternal, "external"], [swapInternalAsymmetric, "internal"]]) {
  check(actual, {
    mode,
    makerFeeSource: -30n,
    receiver: 0n,
    relayer: 0n,
    filled: 0n,
    standingAllowanceOrAuthUnchanged: true,
    fourthExecutionRolledBack: true,
    swapDirectBeneficiaryPayout: 0n,
    beneficiaryAfterLaterEmptySettle: 30n,
    settlementFeeAfterCapture: 0n,
    boundaryConditional: true,
  }, `swap ${mode}`);
}
check(
  { fee: swapExecute(order("sell", 0n, 0n, 10n, true), 0n, 0n, 0n).fee, filled: 0n },
  { fee: 10n, filled: 0n },
  "swap ignores partiallyFillable",
);
check(
  { feeSigned: true, amountsSigned: true, partialSigned: true, balanceModesSigned: true },
  { feeSigned: true, amountsSigned: true, partialSigned: true, balanceModesSigned: true },
  "signed fields",
);
check("digest+owner+validity", "digest+owner+validity", "UID composition without explicit nonce");
check(
  { swapInteractions: 0, payoutRequiresLaterAuthorizedEmptySettle: true },
  { swapInteractions: 0, payoutRequiresLaterAuthorizedEmptySettle: true },
  "swap payout sequencing",
);
check(0n, 0n, "ordinary crossing automatic solver payout");

let state = SEED;
function random(maxExclusive) {
  state ^= state << 13n;
  state ^= state >> 7n;
  state ^= state << 17n;
  state &= (1n << 64n) - 1n;
  return state % maxExclusive;
}

let fuzzAssertions = 0;
for (let i = 0; i < FUZZ_CASES; i += 1) {
  const kind = i % 2 === 0 ? "sell" : "buy";
  const traded = 1n + random(1_000_000n);
  const fee = random(100_000n);
  const first = 1n + random(traded);
  const second = traded - first;
  const modeled = order(kind, kind === "sell" ? traded : traded * 2n, kind === "buy" ? traded : 1n, fee, true);
  const firstResult = execute(modeled, first, 1n, 1n, 0n);
  let totalFee = firstResult.fee;
  let finalFilled = firstResult.filled;
  if (second > 0n) {
    const secondResult = execute(modeled, second, 1n, 1n, finalFilled);
    totalFee += secondResult.fee;
    finalFilled = secondResult.filled;
  }
  assert.equal(finalFilled, traded);
  assert(totalFee <= fee);
  assert(fee - totalFee <= 1n);
  fuzzAssertions += 3;
}

const sourceHashes = Object.fromEntries(
  files.map((relative) => {
    const content = fs.readFileSync(path.join(TARGET, relative));
    return [relative.replaceAll("\\", "/"), sha256(content)];
  }),
);

const settlementSource = fs.readFileSync(path.join(TARGET, "src/contracts/GPv2Settlement.sol"), "utf8");
const readme = fs.readFileSync(path.join(TARGET, "README.md"), "utf8");
const vaultRelayerSource = fs.readFileSync(path.join(TARGET, "src/contracts/GPv2VaultRelayer.sol"), "utf8");
const transferSource = fs.readFileSync(path.join(TARGET, "src/contracts/libraries/GPv2Transfer.sol"), "utf8");
check(
  {
    settleFillWrite: settlementSource.includes("filledAmount[orderUid] = currentFilledAmount;"),
    swapFeeCall: settlementSource.includes("vaultRelayer.batchSwapWithFee("),
    swapZeroFillWrite: settlementSource.includes("filledAmount[orderUid] = order.buyAmount;"),
    feeAfterBoundary: vaultRelayerSource.includes("vault.fastTransferFromAccount(feeTransfer, msg.sender);"),
    balanceModes: transferSource.includes("TRANSFER_EXTERNAL") && transferSource.includes("TRANSFER_INTERNAL"),
    settleInternalSourceExternalizes:
      transferSource.includes("IVault.UserBalanceOpKind.WITHDRAW_INTERNAL") &&
      transferSource.includes("balanceOp.recipient = payable(recipient);"),
    readmeKnown: readme.includes("sellAmount = 0") && readme.includes("drain the fee amount"),
  },
  {
    settleFillWrite: true,
    swapFeeCall: true,
    swapZeroFillWrite: true,
    feeAfterBoundary: true,
    balanceModes: true,
    settleInternalSourceExternalizes: true,
    readmeKnown: true,
  },
  "direct source bindings",
);

const deployment = JSON.parse(
  fs.readFileSync(path.join(TARGET, "deployments/mainnet/GPv2Settlement.json"), "utf8"),
);
const metadata = JSON.parse(deployment.metadata);
check(metadata.compiler.version, "0.7.6+commit.7338295f", "repository deployment compiler metadata");

const output = {
  schemaVersion: 1,
  status: "PASS_SUPPLEMENTAL_ARITHMETIC_MODEL_FORGE_EXECUTION_BLOCKED",
  scope: "offline-revision-with-qualified-prior-network-purity-deviation",
  commit: "c6b61ce75841ce4c25ab126def9cc981c568e6c6",
  seed: `0x${SEED.toString(16)}`,
  deterministicAssertions,
  fuzzCases: FUZZ_CASES,
  fuzzAssertions,
  finding: {
    classification:
      "INFORMATIONAL_KNOWN_ISSUE_REPOSITORY_SOURCE_CONFIRMED_DEPLOYMENT_UNVERIFIED_FORGE_EXECUTION_BLOCKED",
    settleFokSell: {
      signedSellAmount: "0",
      signedBuyAmount: "0 at positive clearing prices",
      makerDebit: "-30 fee token",
      solverControlledPayout: "+30 fee token",
      intendedSingleFokFee: "10",
      repeatedApplicationExcess: "+20",
      receiver: "0",
      remainingAllowance: "standing allowance unchanged",
      relayer: "0",
      filledAfterThree: "0",
      fourthExecution: "fee-transfer failure; modeled rollback",
    },
    settleFokBuyAsymmetric: {
      signedSellAmount: "100",
      signedBuyAmount: "0",
      actualSellBeforeFee: "0",
      makerDebit: "-30 fee token",
      solverControlledPayout: "+30 fee token",
      intendedSingleFokFee: "10",
      repeatedApplicationExcess: "+20",
      receiver: "0",
      remainingAllowance: "standing allowance unchanged",
      relayer: "0",
      filledAfterThree: "0",
      fourthExecution: "fee-transfer failure; modeled rollback",
    },
    settlePartialZero: {
      sellKind: "division by zero at feeAmount * executedSell / sellAmount",
      buyKind: "division by zero at feeAmount * executedBuy / buyAmount",
      replayModeled: false,
    },
    settleBalanceModes: {
      feeLocationBeforeInteraction: "external ERC20 at Settlement for ERC20, external and internal maker sources",
      internalMakerSource: "WITHDRAW_INTERNAL with Settlement recipient",
      payoutInteraction: "token transfer; no Settlement Vault-internal withdrawal",
    },
    standardTokenReference: true,
    outsiderCallable: false,
    knownIssueReadme: "README.md:125-131",
  },
  directSwap: {
    boundaryCondition: "Balancer batchSwap must accept and return the modeled zero token deltas",
    feeSequence: "batchSwap first, then fastTransferFromAccount fee",
    fillSequence: "zero token deltas checked after fee; filledAmount written back to signed zero tracked amount",
    partiallyFillableIgnored: true,
    modes: {
      erc20: swapErc20,
      external: swapExternal,
      internalAsymmetricBuy: swapInternalAsymmetric,
    },
    interactionsInSwap: 0,
    directSolverPayoutInSwap: "0",
    payoutCapture: "requires a later authorized empty settle interaction",
  },
  ordinaryCrossing: {
    makerSellOrder: { sellDebit: "-110 A", receiverCredit: "+100 B" },
    makerBuyOrder: { sellDebit: "-112 B", receiverCredit: "+100 A" },
    settlementResidue: "+10 A, +12 B",
    solverAutomaticPayout: "0",
  },
  productionArtifact: {
    chainId: 1,
    address: deployment.address,
    transactionHash: deployment.transactionHash,
    constructorArgs: deployment.args,
    compilerVersion: metadata.compiler.version,
    solcInputHash: deployment.solcInputHash,
    deployedBytecodeSha256: sha256(Buffer.from(deployment.deployedBytecode.slice(2), "hex")),
  },
  sourceHashes,
  modelScope: {
    deterministicAssertions,
    pseudoRandomArithmeticCases: FUZZ_CASES,
    pseudoRandomArithmeticAssertions: fuzzAssertions,
    productionExecutionProof: false,
    provesReplayOrSignaturesOrTransfersOrAuthorizationOrBalancerOrInteractionsOrRollback: false,
  },
  limitations: [
    "Forge execution and recompilation are blocked because the pinned forge-std submodule is uninitialized, node_modules is absent, and no local solc versions are available.",
    "Current source pragmas would compile with a compatible local modern compiler if dependencies and that compiler were already available; the repository deployment artifact records solc 0.7.6.",
    "This arithmetic model is supplemental only. It does not prove production execution, replay, signatures, transfers, authorization, Balancer acceptance, interactions, or rollback.",
    "Deployment linkage is repository-artifact-only; no RPC/runtime/state verification was performed.",
    "The direct swap branch is conditional on the real Balancer boundary accepting and returning zero deltas.",
  ],
};

process.stdout.write(`${JSON.stringify(output, (_key, value) => typeof value === "bigint" ? value.toString() : value, 2)}\n`);
