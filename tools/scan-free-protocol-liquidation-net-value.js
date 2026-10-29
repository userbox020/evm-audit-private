#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { id } = require("ethers");

const ROOT = path.resolve(__dirname, "..");
const SOURCE_DIR = path.join(ROOT, "sources/free-protocol-step10-liquidation-net-value");
const RAW = path.join(ROOT, "reports/raw/fast/free-protocol-liquidation-net-value.json");
const MANIFEST = path.join(ROOT, "reports/raw/fast/free-protocol-liquidation-net-value.manifest.json");
const REPORT = path.join(ROOT, "reports/free-protocol-liquidation-net-value.md");
const HANDOFF = path.join(ROOT, "coordination/handoffs/2026-07-15-coordinator-free-step10-handoff.md");
const STEP9_RAW = path.join(ROOT, "reports/raw/fast/free-protocol-claimant-recovery.json");
const STEP9_MANIFEST = path.join(ROOT, "reports/raw/fast/free-protocol-claimant-recovery.manifest.json");

const PROVIDERS = ["https://mainnet.mode.network", "https://mode.drpc.org"];
const TX_HASHES = [
  "0x18ec9dccba73f858ccf2fab342dbc3f454a264a9680069ab51ea191ea23fd85d",
  "0xad64bdb6d240e3ecda529816f8bd0fec17062e1d12ceefba610bc056ade05647",
  "0xc451cee61713ca98560e853f6eee5f484a80fc667120d76de75480a9bd01918c",
  "0x2cc8a05b8a3685e0114bbfa74f08e921a308f19aab3299cacb3e91ebe56bb762",
  "0x7d46361e2c2448c5fe34f3b2f0e943a6aaf55d42dbab5e741411f75d9bd7725c",
  "0x8693a2e15cd26b5cb09a7402dfabf40adb7a201ccb942c59b82101a0ada80775"
];
const L_MBTC = "0x59dd441184024a77fd17e68f07e242622806c256";
const M_BTC = "0x59889b7021243db5b1e065385f918316cd90d46c";
const DOMINANT = "0x9e34d89c013da3bf65fc02b59b6f27d710850430";
const ZERO = "0x0000000000000000000000000000000000000000";
const TRANSFER_TOPIC = id("Transfer(address,address,uint256)").toLowerCase();
const CLASSIFICATION = "INCOMPLETE/WATCH — SIX SUCCESSFUL RECEIPTS AND COLLATERAL TRANSFER/BURN/PAYOUT EFFECTS BOUND; DEBT/VALIDATOR/ORACLE TRACE DECODING UNRESOLVED; ULTIMATE LOSS UNPROVEN";

let rpcId = 1;
const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
const relative = (file) => path.relative(ROOT, file).replace(/\\/g, "/");
const addressFromTopic = (topic) => `0x${topic.slice(-40)}`.toLowerCase();

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

function shallowTrace(trace) {
  if (!trace) return null;
  const call = (row) => ({
    from: row.from?.toLowerCase() || null,
    to: row.to?.toLowerCase() || null,
    type: row.type || null,
    value: row.value || null,
    inputSelector: row.input?.slice(0, 10) || null,
    error: row.error || null
  });
  return { ...call(trace), outputClass: trace.output ? "returned" : "none", calls: (trace.calls || []).map(call) };
}

async function transactionEvidence(txHash) {
  const tx = await rpc("eth_getTransactionByHash", [txHash]);
  const [receipt, block] = await Promise.all([
    rpc("eth_getTransactionReceipt", [txHash]),
    rpc("eth_getBlockByNumber", [tx.blockNumber, false])
  ]);
  let trace = null;
  try {
    trace = await rpc("debug_traceTransaction", [txHash, { tracer: "callTracer", timeout: "30s" }]);
  } catch {}

  const effects = receipt.logs
    .filter((log) => [L_MBTC, M_BTC].includes(log.address.toLowerCase()) && log.topics[0]?.toLowerCase() === TRANSFER_TOPIC)
    .map((log) => ({
      logIndex: Number.parseInt(log.logIndex, 16),
      token: log.address.toLowerCase(),
      from: addressFromTopic(log.topics[1]),
      to: addressFromTopic(log.topics[2]),
      amountRaw: BigInt(log.data).toString()
    }));

  const sum = (predicate) => effects.filter(predicate).reduce((total, row) => total + BigInt(row.amountRaw), 0n);
  const seized = sum((row) => row.token === L_MBTC && row.from === DOMINANT);
  const burned = sum((row) => row.token === L_MBTC && row.to === ZERO);
  const payout = sum((row) => row.token === M_BTC && row.from === L_MBTC);

  return {
    txHash,
    blockNumber: Number.parseInt(tx.blockNumber, 16),
    blockHash: block.hash,
    blockTimestamp: Number.parseInt(block.timestamp, 16),
    caller: tx.from.toLowerCase(),
    target: tx.to.toLowerCase(),
    selector: tx.input.slice(0, 10),
    valueRaw: BigInt(tx.value).toString(),
    receiptStatus: receipt.status === "0x1",
    effects,
    seizedRaw: seized.toString(),
    burnedRaw: burned.toString(),
    routerResidualRaw: (seized - burned).toString(),
    payoutRaw: payout.toString(),
    traceAvailable: Boolean(trace),
    traceQualification: "Public call trace acquired but only shallowly sanitized; liquidation, debt, validator, and oracle semantics are not recursively decoded or source-bound.",
    sanitizedTrace: shallowTrace(trace),
    rawSignaturesPersisted: false
  };
}

async function main() {
  fs.rmSync(SOURCE_DIR, { recursive: true, force: true });
  fs.mkdirSync(SOURCE_DIR, { recursive: true });

  const predecessor = { raw: record(STEP9_RAW), manifest: record(STEP9_MANIFEST), runId: require(STEP9_RAW).runId };
  if (predecessor.runId !== "free-step9-796f15f9cd288922fbcf") throw new Error("Step9 predecessor mismatch");

  const rows = [];
  for (const txHash of TX_HASHES) rows.push(await transactionEvidence(txHash));

  const sum = (field) => rows.reduce((total, row) => total + BigInt(row[field]), 0n);
  const metrics = {
    seizedRaw: sum("seizedRaw").toString(),
    burnedRaw: sum("burnedRaw").toString(),
    routerResidualRaw: sum("routerResidualRaw").toString(),
    mbtcPayoutRaw: sum("payoutRaw").toString()
  };
  const gates = {
    sixMaterialReceiptsSuccessful: rows.length === 6 && rows.every((row) => row.receiptStatus),
    sixPublicCallTracesAvailable: rows.length === 6 && rows.every((row) => row.traceAvailable),
    receiptTransferSeizuresBound: rows.length === 6 && rows.every((row) => BigInt(row.seizedRaw) > 0n),
    receiptBurnAndMbtcPayoutBound: rows.length === 6 && rows.every((row) => BigInt(row.burnedRaw) > 0n && BigInt(row.payoutRaw) > 0n),
    routerResidualBound: metrics.routerResidualRaw === "1",
    sixCoreLiquidationCallsTraceBound: null,
    borrowerBoundInAllSix: null,
    debtAssetsAndRepayAmountsResolved: null,
    repayEventsMatchLiquidationEvents: null,
    postBorrowBalancesMatchRepayEvents: null,
    collateralSeizuresTraceBound: null,
    validatorSeizeOutputsTraceBound: null,
    redemptionsAndMbtcPayoutsTraceBound: null,
    fixedBlockOraclePricesResolved: null,
    liquidationIncentiveResolved: null,
    onchainAcceptedValueBenchmarkComputed: null,
    allSixDebtMarketSourceExact: null,
    beneficialOwnershipProven: null,
    legalDamagesProven: null,
    ultimateUncompensatedLossProven: null,
    abuseProven: null,
    routePositive: false,
    signedAction: false,
    promotion: false
  };
  if (!gates.sixMaterialReceiptsSuccessful || !gates.sixPublicCallTracesAvailable || !gates.receiptTransferSeizuresBound || !gates.receiptBurnAndMbtcPayoutBound) {
    throw new Error("Receipt-effect invariants failed");
  }
  if (metrics.seizedRaw !== "4730950768016049778" || metrics.burnedRaw !== "4730950768016049777" || metrics.mbtcPayoutRaw !== "8900774766577676") {
    throw new Error("Step9 receipt-effect aggregate mismatch");
  }

  const fixedTransactions = {
    qualification: "Successful receipts and ERC20 Transfer effects are independently bound. Public call traces are available but not recursively decoded or source-bound.",
    rows
  };
  const accounting = {
    metrics,
    gates,
    unsupportedResearchDisposition: {
      artifactDerived: false,
      qualification: "Prior manual debt-relief, 1.15x liquidation-incentive, validator, and USD benchmark values are intentionally not published as computed evidence because this scanner does not independently decode/source-bind their inputs."
    }
  };
  write(path.join(SOURCE_DIR, "fixed-transactions.json"), fixedTransactions);
  write(path.join(SOURCE_DIR, "net-value-accounting.json"), accounting);

  const runId = `free-step10-${sha256(Buffer.from(JSON.stringify({ predecessorRunId: predecessor.runId, rows, metrics, gates, classification: CLASSIFICATION }))).slice(0, 20)}`;
  const raw = {
    schemaVersion: 2,
    runId,
    classification: CLASSIFICATION,
    predecessor,
    evidence: fixedTransactions,
    accounting,
    safety: { publicReadOnly: true, providerUrlsEmitted: false, rawSignaturesPersisted: false, signing: false, transactions: false, forks: false }
  };
  write(RAW, raw);

  const report = `# Free Protocol Step10 — liquidation evidence boundary\n\n**Classification:** ${CLASSIFICATION}\n\nSix successful receipts and their lMBTC seizure transfers, zero-address burns, and M-BTC payouts are bound. Totals: seized=${metrics.seizedRaw}, burned=${metrics.burnedRaw}, router residual=${metrics.routerResidualRaw}, M-BTC payout=${metrics.mbtcPayoutRaw}.\n\nPublic call traces were acquired but not recursively decoded or source-bound. Debt assets, repayment amounts, borrower debt deltas, Validator outputs, historical oracle prices, liquidation incentive, and the prior manual 1.15x/USD benchmark remain unresolved in this artifact and are not promoted as onchain-computed evidence.\n\nGates: \`${JSON.stringify(gates)}\`\n\nNext branch: implement a recursive ABI/source-bound trace and event decoder, or obtain authoritative LayerBank liquidation accounting.\n`;
  const handoff = `# Step10 liquidation evidence-boundary handoff\n\n- ${CLASSIFICATION}\n- Run ${runId}.\n- Receipt effects seized/burned/residual/payout=${metrics.seizedRaw}/${metrics.burnedRaw}/${metrics.routerResidualRaw}/${metrics.mbtcPayoutRaw}.\n- Traces are available but not recursively decoded/source-bound; debt, Validator, oracle, and benchmark gates remain null.\n- Gates=${JSON.stringify(gates)}.\n`;
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
