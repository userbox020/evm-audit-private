#!/usr/bin/env node
"use strict";

// maple-queue-loss-fork-scenario.js — N4 scenario scaffold:
// Maple queue admission vs loss-realization ordering.
//
// TWO ENTRY POINTS
//   1. Direct run (this file, no --run):
//        node tools/maple-queue-loss-fork-scenario.js
//      Compiles/plans ONLY. Writes reports/raw/fast/maple-queue-loss-step1.json
//      with mechanismNotes, orderingFacts (source file:line refs), scenarioSteps
//      and gaps. Makes NO network call, NO signing, NO fork.
//   2. Fork harness (self-registered scenario module):
//        node tools/run-fork-poc.js --chain 1 --block <n|finalized> \
//             --scenario tools/maple-queue-loss-fork-scenario.js --run
//      The harness passes scenarioInput into ctx.input; the module expects
//      ctx.input.maple = { pool, poolManager, withdrawalManager, asset, whale,
//      strategy|loanManager(+loan), governor|poolDelegate }. Without those
//      addresses the scenario records the missing dependency and FAILS CLOSED
//      (it never fabricates on-chain state).
//
// HONESTY: every on-chain step below is keyed to a source anchor in ORDERING_FACTS.
// Anything not derivable from the in-tree sources (deployed addresses, the exact
// pool-manager->withdrawal-manager share hand-off, the impairment caller) is
// recorded in `gaps`, never assumed.
//
// SAFETY: no signing, no broadcast. The harness is impersonation-only against a
// local fork. This module never reads wallet/key material.
//
// Claimed resource: tools/maple-queue-loss-fork-scenario.js (new file).

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "maple-queue-loss-step1.json");

// --- source-derived ordering facts (file:line refs) ---------------------------------------
const ORDERING_FACTS = [
  {
    id: "F1",
    file: "targets/maple-core-v2/modules/pool/contracts/MaplePool.sol",
    line: 318,
    fact: "convertToShares (deposit/mint basis) = assets * totalSupply / totalAssets(); it does NOT subtract unrealizedLosses.",
  },
  {
    id: "F2",
    file: "targets/maple-core-v2/modules/pool/contracts/MaplePool.sol",
    line: 322,
    fact: "convertToExitShares (redeem/exit basis) = ceil(amount * totalSupply / (totalAssets() - unrealizedLosses())); exit basis NETS unrealizedLosses.",
  },
  {
    id: "F3",
    file: "targets/maple-core-v2/modules/pool/contracts/MaplePool.sol",
    line: 312,
    fact: "convertToExitAssets = shares * (totalAssets() - unrealizedLosses()) / totalSupply; the exit side is loss-aware.",
  },
  {
    id: "F4",
    file: "targets/maple-core-v2/modules/pool/contracts/MaplePool.sol",
    line: 306,
    fact: "convertToAssets = shares * totalAssets() / totalSupply (no loss term) — ERC4626-style view used by the mint/deposit side.",
  },
  {
    id: "F5",
    file: "targets/maple-core-v2/modules/pool/contracts/MaplePoolManager.sol",
    line: 445,
    fact: "totalAssets() = asset balanceOf(pool) + SUM(strategy.assetsUnderManagement()); impaired principal can remain counted until written off.",
  },
  {
    id: "F6",
    file: "targets/maple-core-v2/modules/pool/contracts/MaplePoolManager.sol",
    line: 498,
    fact: "unrealizedLosses() = MIN(SUM(strategy.unrealizedLosses()), totalAssets()); the explicit corrective term for the exit basis.",
  },
  {
    id: "F7",
    file: "targets/maple-core-v2/modules/pool/contracts/MaplePoolManager.sol",
    line: 319,
    fact: "requestRedeem(shares, owner, sender) approves the pool then calls withdrawalManager.addShares(shares, owner) — this is the queue-admission call site (onlyPool).",
  },
  {
    id: "F8",
    file: "targets/withdrawal-manager-queue/contracts/MapleWithdrawalManager.sol",
    line: 344,
    fact: "_calculateRedemption = totalAssetsWithLosses(= totalAssets - unrealizedLosses) * shares / totalSupply (with an availableLiquidity pro-rata cap); queue-era exit NAV nets losses.",
  },
  {
    id: "F9",
    file: "targets/withdrawal-manager-queue/contracts/MapleWithdrawalManager.sol",
    line: 388,
    fact: "_processRequest computes redemption per request at the CURRENT NAV and redeems; ordering within the queue therefore decides who absorbs a realised loss.",
  },
  {
    id: "F10",
    file: "targets/withdrawal-manager-cyclical/contracts/MapleWithdrawalManager.sol",
    line: 367,
    fact: "previewRedeem/getRedeemableAmounts in the cyclical manager also use (totalAssets - unrealizedLosses) and gate on the exit window; admission timing is cycle-bounded.",
  },
  {
    id: "F11",
    file: "targets/maple-core-v2/modules/strategies/contracts/MapleBasicStrategy.sol",
    line: 109,
    fact: "impairStrategy() external onlyProtocolAdmins sets StrategyState.Impaired — one candidate loss-injection tick (protocol-admin gated).",
  },
  {
    id: "F12",
    file: "targets/maple-core-v2/modules/fixed-term-loan-manager/contracts/LoanManager.sol",
    line: 297,
    fact: "impairLoan(address) external onlyPoolDelegateOrGovernor — the loan-side loss-injection tick.",
  },
];

const MECHANISM_NOTES = [
  "The pool has an ASYMMETRIC NAV basis: the deposit/share-mint side (convertToShares, F1/F4) uses raw totalAssets(), while the redeem/exit side (convertToExitAssets/convertToExitShares, F2/F3, and the withdrawal managers F8/F10) uses totalAssets() - unrealizedLosses().",
  "A queue-era claimant admits shares via requestRedeem -> addShares (F7); their payout is computed by _calculateRedemption at the CURRENT loss-aware NAV (F8). Ordering question: does a claimant who queued BEFORE a loss tick still exit at the pre-loss NAV, or absorb the loss?",
  "Loss is injected as an unrealized-loss tick (impairStrategy / impairLoan, F11/F12). While unrealized, totalAssets() still counts impaired principal (F5), so the deposit basis is overstated relative to the exit basis. That asymmetry is the dilution/donation surface this scenario measures.",
  "The two orderings to assert: (i) a claimant queued pre-loss exits at the pre-loss NAV (loss not yet realised on the exit basis), and (ii) a depositor arriving post-loss mints shares on a basis that ignores unrealizedLosses, altering existing holders' per-share value. The module MEASURES both and asserts the source-predicted divergence rather than assuming a direction.",
];

const SCENARIO_STEPS = [
  { id: "S0", action: "fork", detail: "Fork Ethereum mainnet at the configured pin (--block), impersonation-only, no signing." },
  { id: "S1", action: "snapshot", detail: "evm_snapshot so the scenario can be reverted in place." },
  { id: "S2", action: "impersonate-whale", detail: "Impersonate ctx.input.maple.whale; require a non-zero asset balance (else record gap 'whale-unfunded')." },
  { id: "S3", action: "deposit-pre-loss", detail: "whale approves asset and calls pool.deposit(assets, whale); read pool.balanceOf(whale) at the pre-loss NAV (F1/F4)." },
  { id: "S4", action: "queue-admit", detail: "Construct queue state: impersonate the poolManager and call withdrawalManager.addShares(shares, whale) per F7; read requestIds(whale)/lockedShares." },
  { id: "S5", action: "freeze-pre-loss-nav", detail: "Record pre-loss exit NAV = pool.convertToExitAssets(qShares) and pre-loss deposit basis = pool.convertToShares(unit)." },
  { id: "S6", action: "inject-loss-tick", detail: "Impersonate the protocol admin/pool-delegate and call strategy.impairStrategy() (F11) or loanManager.impairLoan(loan) (F12); read poolManager.unrealizedLosses() > 0." },
  { id: "S7", action: "measure-post-loss", detail: "Re-read exit NAV and deposit basis; compute the divergence." },
  { id: "S8", action: "assert-orders", detail: "Assert (i) exit-side loss realisation: post-loss exit NAV <= pre-loss exit NAV; (ii) basis divergence: convertToShares != convertToExitShares once unrealizedLosses > 0 (mint ignores the corrective term)." },
  { id: "S9", action: "teardown", detail: "stopImpersonating all accounts, then evm_revert the snapshot." },
];

const GAPS = [
  { id: "G1", status: "UNMAPPED", dep: "deployed addresses", note: "No Maple pool/poolManager/withdrawalManager/strategy addresses exist in the in-tree sources; the harness must supply ctx.input.maple. Without it the scenario fails closed." },
  { id: "G2", status: "PARTIAL", dep: "pool-manager -> withdrawal-manager share hand-off", note: "addShares (F7) does ERC20Helper.transferFrom(pool, msg.sender==poolManager, wm, shares). The exact production wiring that puts pool shares in the poolManager's hands (or an approval path) is not fully resolved from source in this revision; step S4 may need the shares transferred to the poolManager first." },
  { id: "G3", status: "UNMAPPED", dep: "impairment caller identity", note: "impairStrategy (F11) needs onlyProtocolAdmins; impairLoan (F12) needs the pool delegate or governor. The concrete mainnet admin/governor addresses are not in-tree; the harness must supply them for impersonation." },
  { id: "G4", status: "UNMAPPED", dep: "which withdrawal manager", note: "queue vs cyclical manager differ (F8/F9 vs F10): the queue-era isInExitWindow() always returns true while the cyclical manager gates on a window. The scenario assumes the loss-aware _calculateRedemption path and records the manager variant actually wired." },
  { id: "G5", status: "NOTE", dep: "loss direction", note: "Whether the loss is borne by the pre-loss claimant or dilutes the post-loss depositor is the thing being measured; the assertions encode the source-predicted basis divergence, not a guaranteed profit." },
];

// --- scenario API (only executed under the fork harness with --run) -----------------------
function ifaceMacros(ctx) {
  const { ethers } = ctx;
  return {
    pool: new ethers.Interface([
      "function totalSupply() view returns (uint256)",
      "function totalAssets() view returns (uint256)",
      "function unrealizedLosses() view returns (uint256)",
      "function convertToAssets(uint256) view returns (uint256)",
      "function convertToExitAssets(uint256) view returns (uint256)",
      "function convertToShares(uint256) view returns (uint256)",
      "function convertToExitShares(uint256) view returns (uint256)",
      "function balanceOf(address) view returns (uint256)",
      "function approve(address,uint256) returns (bool)",
      "function deposit(uint256,address) returns (uint256)",
    ]),
    poolManager: new ethers.Interface([
      "function totalAssets() view returns (uint256)",
      "function unrealizedLosses() view returns (uint256)",
    ]),
    withdrawalManager: new ethers.Interface([
      "function addShares(uint256,address) returns (uint256)",
      "function requestIds(address) view returns (uint256)",
      "function lockedShares(address) view returns (uint256)",
      "function isInExitWindow(address) view returns (bool)",
      "function previewRedeem(address,uint256) view returns (uint256,uint256)",
    ]),
    asset: new ethers.Interface([
      "function balanceOf(address) view returns (uint256)",
      "function approve(address,uint256) returns (bool)",
    ]),
    strategy: new ethers.Interface(["function impairStrategy()"]),
    loanManager: new ethers.Interface(["function impairLoan(address)"]),
  };
}

async function call(ctx, iface, to, fn, args = []) {
  const raw = await ctx.call({ to, data: iface.encodeFunctionData(fn, args) });
  return iface.decodeFunctionResult(fn, raw);
}

async function run(ctx) {
  const maple = (ctx.input && ctx.input.maple) || null;
  const required = ["pool", "poolManager", "withdrawalManager", "asset", "whale"];
  const present = maple && required.every((k) => typeof maple[k] === "string" && /^0x[0-9a-fA-F]{40}$/.test(maple[k]));

  if (!present) {
    ctx.log("note", "maple-addresses-missing; scenario fails closed (see gaps G1/G3/G4)");
    ctx.assert(false, "scenario-input-present");
    return;
  }

  const I = ifaceMacros(ctx);
  const qShares = BigInt(ctx.input.qShares || "1000000000000000000"); // 1e18 default
  const unit = 10n ** 18n;
  const snap = await ctx.snapshot();

  // S2: whale funding
  await ctx.impersonate(maple.whale);
  const whaleBal = (await call(ctx, I.asset, maple.asset, "balanceOf", [maple.whale]))[0];
  ctx.log("whaleAssetBalance", whaleBal);
  ctx.assert(whaleBal > 0n, "whale-funded");

  // S3: pre-loss deposit
  if (whaleBal > 0n) {
    await ctx.send({ from: maple.whale, to: maple.asset, data: I.asset.encodeFunctionData("approve", [maple.pool, whaleBal]) });
    await ctx.send({ from: maple.whale, to: maple.pool, data: I.pool.encodeFunctionData("deposit", [whaleBal, maple.whale]) });
  }
  const whaleShares = (await call(ctx, I.pool, maple.pool, "balanceOf", [maple.whale]))[0];
  ctx.log("whaleShares", whaleShares);

  // S4: queue admission (permissioned: onlyPoolManager)
  const admissions = [];
  for (const requester of [maple.poolManager, maple.whale]) {
    try {
      await ctx.impersonate(requester);
      const res = await ctx.send({
        from: requester,
        to: maple.withdrawalManager,
        data: I.withdrawalManager.encodeFunctionData("addShares", [qShares, maple.whale]),
      });
      admissions.push({ requester, hash: res.hash });
      break;
    } catch (e) {
      ctx.log("admit-attempt-failed", requester);
    }
  }
  ctx.assert(admissions.length > 0, "queue-admission-observed");

  // S5: pre-loss NAV
  const preExit = (await call(ctx, I.pool, maple.pool, "convertToExitAssets", [qShares]))[0];
  const preDepositShares = (await call(ctx, I.pool, maple.pool, "convertToShares", [unit]))[0];
  ctx.log("preExitValue", preExit);
  ctx.log("preDepositSharesPerUnit", preDepositShares);

  // S6: inject loss tick
  let lossInjected = false;
  if (typeof maple.strategy === "string") {
    const admin = maple.poolDelegate || maple.governor || maple.strategy;
    await ctx.impersonate(admin);
    try {
      await ctx.send({ from: admin, to: maple.strategy, data: I.strategy.encodeFunctionData("impairStrategy", []) });
      lossInjected = true;
    } catch (_) { ctx.log("impair-strategy-failed", maple.strategy); }
  } else if (typeof maple.loanManager === "string" && typeof maple.loan === "string") {
    const admin = maple.governor || maple.poolDelegate;
    await ctx.impersonate(admin);
    try {
      await ctx.send({ from: admin, to: maple.loanManager, data: I.loanManager.encodeFunctionData("impairLoan", [maple.loan]) });
      lossInjected = true;
    } catch (_) { ctx.log("impair-loan-failed", maple.loan); }
  }
  ctx.assert(lossInjected, "loss-tick-injected");

  const unrealized = (await call(ctx, I.poolManager, maple.poolManager, "unrealizedLosses", []))[0];
  ctx.log("unrealizedLosses", unrealized);

  // S7/S8: post-loss measurements + ordering assertions
  const postExit = (await call(ctx, I.pool, maple.pool, "convertToExitAssets", [qShares]))[0];
  const postDepositShares = (await call(ctx, I.pool, maple.pool, "convertToShares", [unit]))[0];
  const postExitShares = (await call(ctx, I.pool, maple.pool, "convertToExitShares", [unit]))[0];
  ctx.log("postExitValue", postExit);
  ctx.log("postDepositSharesPerUnit", postDepositShares);
  ctx.log("postExitSharesPerUnit", postExitShares);

  // (i) exit side realises the loss: post-loss exit NAV must not exceed the pre-loss snapshot.
  ctx.assert(postExit <= preExit, "ordering-i-claimant-exit-nets-loss");
  // (ii) deposit basis ignores unrealizedLosses while exit basis nets it: the two diverge once a loss exists.
  if (unrealized > 0n) {
    ctx.assert(postDepositShares !== postExitShares, "ordering-ii-mint-vs-exit-basis-diverge");
  } else {
    ctx.log("note", "unrealizedLosses==0; basis-divergence assertion not applicable");
  }

  // S9: teardown
  await ctx.stopImpersonating(maple.whale);
  if (typeof maple.poolManager === "string") await ctx.stopImpersonating(maple.poolManager);
  await ctx.revert(snap);
}

// --- plan (direct run; offline) -----------------------------------------------------------
function plan() {
  const scannedAt = new Date().toISOString();
  const artifact = {
    scannedAt,
    scanner: "tools/maple-queue-loss-fork-scenario.js",
    mode: "offline-scenario-scaffold",
    revision: "step1",
    forkHarnessCompatible: true,
    invocation: "node tools/run-fork-poc.js --chain 1 --block <n|finalized> --scenario tools/maple-queue-loss-fork-scenario.js --run",
    ranFork: false,
    mechanismNotes: MECHANISM_NOTES,
    orderingFacts: ORDERING_FACTS,
    scenarioSteps: SCENARIO_STEPS,
    gaps: GAPS,
    safety: {
      offline: true, networkCalls: false, privateKeysRead: false,
      signedActions: false, broadcast: false, forkTransactions: false,
    },
    exitCode: 0,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(
    `maple-queue-loss-step1: orderingFacts=${ORDERING_FACTS.length} steps=${SCENARIO_STEPS.length} gaps=${GAPS.length} ` +
    `forkHarnessCompatible=true ranFork=false artifact=${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`,
  );
  return artifact;
}

module.exports = {
  run,
  plan,
  ORDERING_FACTS,
  MECHANISM_NOTES,
  SCENARIO_STEPS,
  GAPS,
};

if (require.main === module) {
  try {
    plan();
  } catch (err) {
    try {
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, `${JSON.stringify({
        scannedAt: new Date().toISOString(),
        scanner: "tools/maple-queue-loss-fork-scenario.js",
        mode: "offline-scenario-scaffold",
        error: String((err && err.message) || err),
        gaps: [{ id: "MISS-INTERNAL", status: "MISS", note: "plan threw; recorded fail-closed" }],
        exitCode: 0,
      }, null, 2)}\n`);
    } catch (_) { /* best effort */ }
    console.log("maple-queue-loss-step1: internal error recorded fail-closed (exit 0)");
  }
}
