#!/usr/bin/env node
// Extract raw Jupiter swap instructions from a VersionedTransaction.
// No key loading, no signing, no send path.

const fs = require("fs");
const path = require("path");
const { resolveRpcUrls } = require("../targets/kamino-klend/live-liquidation-executor.js");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "jupiter-ix-extract.json");
const JUPITER_BASE = process.env.JUPITER_API_BASE || "https://api.jup.ag/swap/v1";

const PROGRAMS_TO_FILTER = new Set([
  "ComputeBudget111111111111111111111111111111",
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPo7hY4zQbBwfT9x5j", // Token-2022
]);
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

function ts() { return new Date().toISOString(); }

function arg(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

function has(name) { return process.argv.includes(name); }

function loadWeb3() {
  try { return require("@solana/web3.js"); }
  catch (_) { return require(path.join(WORKSPACE, "node_modules", "@solana/web3.js")); }
}

function outputPath() { return arg("--out", OUT); }

function instructionToJson(ix) {
  return {
    programId: ix.programId.toBase58(),
    keys: ix.keys.map(k => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
    dataBase64: Buffer.from(ix.data).toString("base64"),
    dataLength: ix.data.length,
  };
}

function shouldKeepSwapInstruction(ix, inputMint, outputMint) {
  const programId = ix.programId.toBase58();
  if (PROGRAMS_TO_FILTER.has(programId)) return false;
  if (programId === ATA_PROGRAM) {
    const mint = ix.keys[3]?.pubkey?.toBase58?.();
    if (mint && (mint === inputMint || mint === outputMint)) return false;
  }
  return true;
}

async function getQuote(inputMint, outputMint, amount, slippageBps, swapMode = "ExactIn") {
  const url = new URL(`${JUPITER_BASE}/quote`);
  url.searchParams.set("inputMint", inputMint);
  url.searchParams.set("outputMint", outputMint);
  url.searchParams.set("amount", String(amount));
  url.searchParams.set("slippageBps", String(slippageBps));
  url.searchParams.set("swapMode", swapMode);
  const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!resp.ok) throw new Error(`Jupiter quote HTTP ${resp.status}`);
  return await resp.json();
}

async function getSwapTransaction(quoteResponse, userPublicKey, slippageBps) {
  const resp = await fetch(`${JUPITER_BASE}/swap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey,
      slippageBps,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: Number(process.env.JUPITER_PRIORITY_FEE_LAMPORTS || "0"),
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) throw new Error(`Jupiter swap HTTP ${resp.status}`);
  const json = await resp.json();
  if (!json.swapTransaction) throw new Error(`Jupiter swapTransaction missing: ${json.error || json.message || "unknown error"}`);
  return json.swapTransaction;
}

async function fetchLookupTables(connection, transaction) {
  const lookups = transaction.message.addressTableLookups || [];
  const tables = [];
  for (const lookup of lookups) {
    const result = await connection.getAddressLookupTable(lookup.accountKey);
    if (result.value) tables.push(result.value);
  }
  return tables;
}

async function extractInstructions({ connection, swapTransactionBase64, inputMint, outputMint }) {
  const web3 = loadWeb3();
  const { VersionedTransaction, TransactionMessage } = web3;
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransactionBase64, "base64"));
  const lookupTables = await fetchLookupTables(connection, tx);
  const message = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: lookupTables });
  const allInstructions = message.instructions;
  const swapInstructions = allInstructions.filter(ix => shouldKeepSwapInstruction(ix, inputMint, outputMint));
  return {
    lookupTables: lookupTables.map(t => ({ key: t.key.toBase58(), addresses: t.state.addresses.length })),
    staticAccountKeys: tx.message.staticAccountKeys.map(k => k.toBase58()),
    allInstructions: allInstructions.map(instructionToJson),
    swapInstructions: swapInstructions.map(instructionToJson),
  };
}

function usage() {
  console.log("Usage:");
  console.log("  node tools/jupiter-ix-extract.js --swap-tx <base64> --input <mint> --output <mint>");
  console.log("  node tools/jupiter-ix-extract.js --input <mint> --output <mint> --amount <raw> --user <pubkey> [--slippage-bps 100]");
  console.log("Options: --exact-out, --out <file>");
}

async function main() {
  if (has("--help") || has("-h")) { usage(); return; }
  const web3 = loadWeb3();
  const inputMint = arg("--input");
  const outputMint = arg("--output");
  const amount = arg("--amount");
  const user = arg("--user");
  const slippageBps = Number(arg("--slippage-bps", "100"));
  let swapTx = arg("--swap-tx");
  let quote = null;

  if (!inputMint || !outputMint) throw new Error("--input and --output are required");
  if (!swapTx) {
    if (!amount || !user) throw new Error("--amount and --user are required when --swap-tx is not provided");
    quote = await getQuote(inputMint, outputMint, amount, slippageBps, has("--exact-out") ? "ExactOut" : "ExactIn");
    swapTx = await getSwapTransaction(quote, user, slippageBps);
  }

  const rpcUrl = resolveRpcUrls()[0];
  const connection = new web3.Connection(rpcUrl, "processed");
  const extracted = await extractInstructions({ connection, swapTransactionBase64: swapTx, inputMint, outputMint });
  const artifact = {
    generatedAt: ts(),
    scanner: "tools/jupiter-ix-extract.js",
    safety: { keypairLoaded: false, signedActions: false, sentTransactions: false, rpcUrlsStored: false },
    request: { inputMint, outputMint, amount: amount || null, user: user || null, slippageBps, swapMode: has("--exact-out") ? "ExactOut" : "ExactIn" },
    quoteSummary: quote ? { inAmount: quote.inAmount, outAmount: quote.outAmount, priceImpactPct: quote.priceImpactPct, routePlanLength: quote.routePlan?.length || 0 } : null,
    counts: { allInstructions: extracted.allInstructions.length, swapInstructions: extracted.swapInstructions.length, lookupTables: extracted.lookupTables.length },
    ...extracted,
  };
  const out = outputPath();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(artifact, null, 2) + "\n");
  console.log(`Wrote ${out}`);
  console.log(`instructions=${artifact.counts.allInstructions}, swapInstructions=${artifact.counts.swapInstructions}, lookupTables=${artifact.counts.lookupTables}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { getQuote, getSwapTransaction, extractInstructions };
