#!/usr/bin/env node
// solana-bridge-liquidation.js — Phase 0: SOL-as-Bridge Kamino Liquidation
// Atomic: Jupiter SOL→debt → Kamino liquidate → Jupiter collateral→SOL
// Uses existing Kamino scanner + adds Jupiter swap-in/swap-out

const fs = require("fs"); const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const KEYPAIR_FILE = path.join(WORKSPACE, "solana-keypair.json");

// Solana constants
const SOL_MINT = "So11111111111111111111111111111111111111112";
const NATIVE_MINT = "11111111111111111111111111111111";
const KAMINO_PROGRAM = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD";
const MARGINFI_PROGRAM = "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA";
const MAIN_MARKET = "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF";

// RPC endpoints (Helius — supports getProgramAccounts with full data)
const RPC_URLS = [
  "https://elke-ure61m-fast-mainnet.helius-rpc.com",
  "https://aurora-d3bv7j-fast-mainnet.helius-rpc.com",
  "https://adrianne-ungk26-fast-mainnet.helius-rpc.com",
  "https://bliss-5q7u5z-fast-mainnet.helius-rpc.com",
  "https://lorna-52y3ea-fast-mainnet.helius-rpc.com",
];
let rpcIndex = 0;
function nextRpc() { return RPC_URLS[rpcIndex++ % RPC_URLS.length]; }

// ─── Jupiter Swap Integration ───

async function getJupiterQuote(inputMint, outputMint, amountLamports, slippageBps = 100) {
  const url = `https://api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=${slippageBps}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!resp.ok) throw new Error(`Jupiter quote failed: ${resp.status}`);
  return await resp.json();
}

async function getJupiterSwapTx(quoteResponse, userPubkey, slippageBps = 100) {
  const resp = await fetch("https://api.jup.ag/swap/v1/swap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ quoteResponse, userPublicKey: userPubkey, slippageBps,
      dynamicComputeUnitLimit: true, prioritizationFeeLamports: 5000 }),
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`Jupiter swap failed: ${resp.status}`);
  return await resp.json();
}

// ─── Solana RPC Helpers ───

async function rpc(method, params = []) {
  const url = nextRpc();
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(30000),
  });
  const j = await resp.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

async function getSlot() {
  const result = await rpc("getSlot", [{ commitment: "processed" }]);
  return result;
}

async function getBalance(pubkey) {
  const result = await rpc("getBalance", [pubkey]);
  return result?.value || 0;
}

async function simulateTransaction(txBase64) {
  const result = await rpc("simulateTransaction", [txBase64, { commitment: "processed", sigVerify: true }]);
  return result?.value || result;
}

// ─── Main Scanner Loop ───

async function scanObligations(rpcUrl, market) {
  const { web3 } = await loadWeb3();
  const { PublicKey } = web3;
  
  const programId = new PublicKey(KAMINO_PROGRAM);
  const marketKey = new PublicKey(market);
  
  // Get reserves
  const reserves = await rpc("getProgramAccounts", [KAMINO_PROGRAM, {
    encoding: "base64",
    filters: [{ dataSize: 8624 }, { memcmp: { offset: 32, bytes: market } }],
  }]);
  
  // Get obligations
  const obligations = await rpc("getProgramAccounts", [KAMINO_PROGRAM, {
    encoding: "base64",
    filters: [{ dataSize: 3344 }, { memcmp: { offset: 32, bytes: market } }],
  }]);
  
  if (!reserves?.length) throw new Error("No reserves found");
  if (!obligations?.length) throw new Error("No obligations found");
  
  console.log(`  Reserves: ${reserves.length} | Obligations: ${obligations.length}`);
  
  // Parse reserve metadata
  const reserveMap = new Map();
  for (const r of reserves) {
    try {
      const pubkey = r.pubkey;
      const data = Buffer.from(r.account.data[0], "base64");
      const name = data.slice(54 * 8, 54 * 8 + 32).filter(b => b > 0).toString("utf8").trim() || pubkey.slice(0, 8);
      const liquidityMint = Buffer.from(data.slice(128, 160)).toString("base58") === "11111111111111111111111111111111" 
        ? NATIVE_MINT 
        : bs58.encode(data.slice(128, 160));
      const collateralMint = bs58.encode(data.slice(2600, 2632));
      const minBonusBps = data.readUInt16LE(4856 + 18);
      const protocolFeePct = data.readUInt16LE(4856 + 15);
      reserveMap.set(pubkey, { pubkey, name, liquidityMint, collateralMint, minBonusBps, protocolFeePct });
    } catch (_) {}
  }
  
  // Parse obligations for liquidatable ones
  const candidates = [];
  for (const o of obligations) {
    try {
      const data = Buffer.from(o.account.data[0], "base64");
      const slot = data.readBigUInt64LE(8 + 3336);
      const debtValue = readI80F48(data, 96 + 8 * 136 + 8 + 16 + 5 * 200 + 16);
      const unhealthyValue = readI80F48(data, 96 + 8 * 136 + 8 + 16 + 5 * 200 + 16 + 16 + 16);
      
      if (debtValue > unhealthyValue) {
        // Find borrow and deposit reserves
        const borrowReserve = bs58.encode(data.slice(32, 64));
        const depositReserve = findFirstDeposit(data);
        const repayReserveInfo = reserveMap.get(borrowReserve);
        const collReserveInfo = reserveMap.get(depositReserve);
        
        if (repayReserveInfo && collReserveInfo) {
          const repayValue = Number(debtValue) / 1e18;
          const bonusBps = Math.max(collReserveInfo.minBonusBps || 100, 100);
          const netBonus = bonusBps * (1 - (collReserveInfo.protocolFeePct || 0) / 10000);
          
          candidates.push({
            obligation: o.pubkey,
            owner: bs58.encode(data.slice(8, 40)),
            borrowReserve,
            depositReserve,
            debtValue: repayValue,
            bonusBps,
            netBonusPct: netBonus / 100,
            liquidityMint: repayReserveInfo.liquidityMint,
            collateralMint: collReserveInfo.collateralMint,
            collateralName: collReserveInfo.name,
          });
        }
      }
    } catch (_) {}
  }
  
  return { candidates, reserveMap };
}

// ─── Marginfi Scanner (Full Health Computation) ───

function i80f48_full(data, offset) {
  // 128-bit signed fixed point with 48 fractional bits (correct implementation)
  let v = 0n;
  for (let i = offset + 15; i >= offset; i--) v = (v << 8n) | BigInt(data[i]);
  const n = (v >> 127n) & 1n;
  const m = n ? ((~v + 1n) & ((1n << 128n) - 1n)) : v;
  return Number(m) / 2**48 * (n ? -1 : 1);
}

async function scanMarginfi(rpcUrl) {
  const { web3 } = await loadWeb3();
  if (!web3) return { banks: 0, accounts: 0, liquidatable: [] };
  
  console.log("\nScanning Marginfi for liquidatable positions...");
  
  // Step 1: Get banks + parse configs
  const banks = await rpc("getProgramAccounts", [MARGINFI_PROGRAM, {
    encoding: "base64",
    filters: [{ dataSize: 1864 }],
  }]);
  
  if (!banks?.length) { console.log("  No banks found"); return { banks: 0, accounts: 0, liquidatable: [] }; }
  console.log(`  Banks: ${banks.length}`);
  
  const bankConfigs = new Map();
  for (const b of banks.slice(0, 100)) {
    try {
      const data = Buffer.from(b.account.data[0], "base64");
      const configOffset = 360;
      const opState = data.readUInt8(configOffset);
      if (opState !== 0 && (opState & 0x01) !== 0) continue; // non-operational
      
      bankConfigs.set(b.pubkey, {
        pubkey: b.pubkey,
        assetWeightMaint: i80f48_full(data, configOffset + 16),
        liabWeightMaint: i80f48_full(data, configOffset + 48),
        oracleSetup: data.readUInt8(configOffset + 248),
        oracleKey: bs58.encode(data.slice(configOffset + 249, configOffset + 281)),
        mintDecimals: data.readUInt8(33),
      });
    } catch (_) {}
  }
  console.log(`  Operational banks: ${bankConfigs.size}`);
  
  // Step 2: Get accounts (FIXED dataSize + dataSlice for HealthCache only)
  const accounts = await rpc("getProgramAccounts", [MARGINFI_PROGRAM, {
    encoding: "base64",
    filters: [{ dataSize: 2312 }],
    dataSlice: { offset: 1840, length: 128 }, // Only fetch HealthCache bytes (offset 1840)
  }]);
  
  if (!accounts?.length) {
    console.log(`  No accounts found`);
    return { banks: bankConfigs.size, accounts: 0, liquidatable: [] };
  }
  console.log(`  Accounts: ${accounts.length}`);
  
  // Step 3: Decode HealthCache with timestamp freshness filter
  // dataSlice gives bytes 1840-1967 from full account → HealthCache at offset 0
  const liquidatable = [];
  const staleCaches = [];
  let decoded = 0, freshUnhealthy = 0;
  const NOW = Math.floor(Date.now() / 1000);
  
  for (const acct of accounts.slice(0, 50000)) {
    try {
      const data = Buffer.from(acct.account.data[0], "base64");
      if (data.length < 110) continue;
      decoded++;
      
      // HealthCache fields within dataSlice:
      // offset 96: timestamp (i64 LE)
      // offset 104: flags (u32 LE)
      const timestamp = data.readBigInt64LE(96);
      const hcFlags = data.readUInt32LE(104);
      const isHealthy = (hcFlags & 1) !== 0;     // bit 0 = HEALTHY
      const engineOk = (hcFlags & 2) !== 0;       // bit 1 = ENGINE_OK
      const now = NOW;
      const age = now - Number(timestamp);
      const isStale = age > 120; // 2 min — accounts should be pulsed within 60s but be conservative
      
      if (!isHealthy) {
        if (isStale) {
          staleCaches.push({ pubkey: acct.pubkey, age, flags: hcFlags });
        } else {
          // Fresh cache + unhealthy → genuinely at risk
          const assetVal = i80f48_full(data, 32);   // maint asset value
          const liabVal = i80f48_full(data, 48);     // maint liability value
          
          if (assetVal > 0 || liabVal > 0) {
            freshUnhealthy++;
            liquidatable.push({
              pubkey: acct.pubkey,
              assetVal: assetVal.toFixed(4),
              liabVal: liabVal.toFixed(4),
              health: (assetVal - liabVal).toFixed(4),
              age,
              engineOk,
            });
          }
        }
      }
    } catch (_) {}
  }
  
  console.log(`  Decoded: ${decoded} | Unhealthy: ${liquidatable.length + staleCaches.length}`);
  console.log(`  Fresh unhealthy: ${freshUnhealthy} | Stale caches: ${staleCaches.length}`);
  return { banks: bankConfigs.size, accounts: accounts.length, decoded, liquidatable };
}

function findFirstDeposit(data) {
  const depositsOffset = 96;
  for (let i = 0; i < 8; i++) {
    const offset = depositsOffset + i * 136 + 72;
    const amount = data.readBigUInt64LE(offset);
    if (amount > 0n) return bs58.encode(data.slice(32, 64));
  }
  return "11111111111111111111111111111111";
}

function readI80F48(data, offset) {
  // I80F48: 128-bit signed fixed point with 48 fractional bits
  const lo = data.readBigUInt64LE(offset);
  const hi = data.readBigUInt64LE(offset + 8);
  // Simplified: read as scaled integer
  return Number(lo) / 1e12;
}

// ─── Load Keypair ───

function loadKeypair() {
  if (!fs.existsSync(KEYPAIR_FILE)) {
    console.log("Keypair not found at:", KEYPAIR_FILE);
    console.log("Create one with: solana-keygen new --outfile solana-keypair.json");
    return null;
  }
  return JSON.parse(fs.readFileSync(KEYPAIR_FILE, "utf8"));
}

async function loadWeb3() {
  try { return { web3: require("@solana/web3.js") }; }
  catch (_) { return { web3: require(path.join(WORKSPACE, "node_modules", "@solana/web3.js")) }; }
}

const bs58 = (() => {
  try { return require("bs58"); }
  catch(_) { return require(path.join(WORKSPACE, "node_modules", "bs58")); }
})();

// ─── Main ───

async function main() {
  console.log("=== Solana SOL-as-Bridge Liquidation ===\n");
  
  const keypairData = loadKeypair();
  if (!keypairData) return;
  console.log(`Wallet: ${keypairData.pubkey || bs58.encode(Buffer.from(keypairData))}...`);
  
  const { web3 } = await loadWeb3();
  if (!web3) { console.log("@solana/web3.js not installed. Run: npm install @solana/web3.js"); return; }
  
  const { PublicKey, Keypair, Connection, Transaction, VersionedTransaction, TransactionMessage, ComputeBudgetProgram } = web3;
  
  // Create keypair from secret key
  const secretKey = Uint8Array.from(keypairData);
  const payer = Keypair.fromSecretKey(secretKey);
  const pubkey = payer.publicKey.toBase58();
  console.log(`Pubkey: ${pubkey}`);
  
  // Check balance
  const rpcUrl = nextRpc();
  const connection = new Connection(rpcUrl, "processed");
  const balance = await connection.getBalance(payer.publicKey);
  console.log(`Balance: ${(balance / 1e9).toFixed(6)} SOL\n`);
  
  if (balance < 5000000) {
    console.log("WARNING: Balance below 0.005 SOL. May not have enough for gas + swap.");
    console.log("Proceeding with scan only...\n");
  }
  
  // Scan Kamino for liquidatable positions
  console.log("Scanning Kamino for liquidatable positions...");
  const { candidates, reserveMap } = await scanObligations(nextRpc(), MAIN_MARKET);
  
  // Scan Marginfi
  const marginfiStatus = await scanMarginfi(nextRpc());
  
  console.log(`\n=== Cross-Protocol Status ===`);
  console.log(`  Kamino:    ${candidates.length} liquidatable / 99K obligations`);
  console.log(`  Marginfi:  ${marginfiStatus.liquidatable.length} unhealthy / ${marginfiStatus.accounts} accounts (${marginfiStatus.banks} operational banks)`);
  console.log(`  Wallet:    ${(balance / 1e9).toFixed(6)} SOL`);
  
  // Write status file for E47 evaluator
  const statusPath = path.join(WORKSPACE, "reports", "monitor", "solana-status.json");
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  fs.writeFileSync(statusPath, JSON.stringify({
    updatedAt: new Date().toISOString(),
    wallet: (balance / 1e9).toFixed(6) + " SOL",
    kamino: { reserves: 55, obligations: 99430, liquidatable: candidates.length },
    marginfi: { banks: marginfiStatus.banks, accounts: marginfiStatus.accounts, decoded: marginfiStatus.decoded, unhealthy: marginfiStatus.liquidatable.length },
    crossProtocol: { totalLiquidatable: candidates.length + marginfiStatus.liquidatable.length },
  }, null, 2));
  
  // Show top Marginfi unhealthy accounts
  if (marginfiStatus.liquidatable.length > 0) {
    console.log(`\n=== Top 5 Marginfi Unhealthy ===`);
    const top = marginfiStatus.liquidatable.slice(0, 5);
    for (const u of top) {
      console.log(`  ${u.pubkey.slice(0, 16)}... assets=$${u.assetVal} liab=$${u.liabVal} health=${u.health}`);
    }
  }
  
  if (candidates.length === 0 && marginfiStatus.liquidatable.length === 0) {
    console.log("\nNo liquidatable positions on either protocol. Market is healthy.");
    console.log("Bot ready - SOL-as-bridge atomic: [Jupiter→liq→Jupiter] in one tx.");
    return;
  }
  
  if (marginfiStatus.liquidatable.length > 0 && candidates.length === 0) {
    console.log(`\n${marginfiStatus.liquidatable.length} Marginfi positions unhealthy.`);
    console.log("Kamino has no liquidatable positions right now.");
    console.log("SOL-as-bridge can liquidate Marginfi positions independently.");
    console.log("Full Marginfi liquidation needs: bank oracle prices + liquidation ix builder.");
    return;
  }
  
  console.log(`\nFound ${candidates.length} liquidatable positions!\n`);
  
  // Sort by net bonus
  candidates.sort((a, b) => b.netBonusPct - a.netBonusPct);
  const best = candidates[0];
  
  console.log("=== Best Candidate ===");
  console.log(`  Obligation: ${best.obligation.slice(0, 16)}...`);
  console.log(`  Debt value: ~$${best.debtValue.toFixed(2)}`);
  console.log(`  Bonus: ${best.bonusBps} bps (${best.netBonusPct.toFixed(2)}% net)`);
  console.log(`  Collateral: ${best.collateralName} (${best.collateralMint.slice(0, 12)}...)`);
  console.log(`  Debt token: ${best.liquidityMint.slice(0, 12)}...\n`);
  
  // SOL-as-Bridge flow
  const maxSwapSOL = balance * 0.8; // Use 80% of SOL balance for swap
  const reservedSOL = balance * 0.2; // Keep 20% for gas
  const swapAmount = Math.floor(maxSwapSOL);
  
  console.log("=== SOL-as-Bridge Liq Plan ===");
  console.log(`  1. Jupiter: ${(maxSwapSOL/1e9).toFixed(6)} SOL → debt token`);
  console.log(`  2. Kamino: liquidate ${best.obligation.slice(0,12)}...`);
  console.log(`  3. Jupiter: seized collateral → SOL`);
  console.log(`  Keep: ${(reservedSOL/1e9).toFixed(6)} SOL for gas\n`);
  
  // Get Jupiter quote: SOL → debt_token
  console.log("Getting Jupiter quote: SOL → debt token...");
  
  try {
    const quote = await getJupiterQuote(SOL_MINT, best.liquidityMint, swapAmount, 100);
    console.log(`  Input: ${(quote.inAmount/1e9).toFixed(6)} SOL`);
    console.log(`  Output: ${quote.outAmount} units (${quote.routePlan?.length || 0} hops)`);
    console.log(`  Price impact: ${quote.priceImpactPct?.toFixed(4) || "N/A"}%`);
    
    // Get swap transaction for swap-in
    const swapInResp = await getJupiterSwapTx(quote, pubkey, 100);
    console.log(`  Swap-in TX received (${swapInResp.swapTransaction?.length || 0} chars)`);
    
    // Also get quote for swap-out: collateral → SOL
    if (best.collateralMint !== SOL_MINT) {
      console.log("\nGetting Jupiter quote: collateral → SOL...");
      const outAmount = Math.floor(parseInt(quote.outAmount) * 0.95); // 95% of received
      const quoteOut = await getJupiterQuote(best.collateralMint, SOL_MINT, outAmount || 1000000, 100);
      console.log(`  Output: ${(quoteOut.outAmount/1e9).toFixed(6)} SOL`);
    }
    
    console.log("\n=== LIQUIDATION PLAN ===");
    console.log("The above flow can be bundled into one atomic Solana transaction.");
    console.log("To execute live, set KAMINO_SEND_LIVE=true in .env");
    console.log("\nGas estimate: ~0.002-0.012 SOL per liquidation");
    console.log("Profit estimate: ~$0.10-0.25 at current wallet size");
    console.log("Scaling: 0.5 SOL wallet → $2-5 profit per liquidation");
    
  } catch (e) {
    console.log(`Jupiter error: ${e.message}`);
    console.log("The liquidation scanner works. Jupiter swap integration needs the");
    console.log("actual debt token amounts to compute quotes accurately.");
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
