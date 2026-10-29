#!/usr/bin/env node
// scan-pull-oracle-timing.js — Pattern #1: Pull-Oracle Timing Attack Surface
// Covers Pyth, Stork, RedStone(push), Band, Supra across all major EVM chains
// Detects exploitable staleness windows between oracle updates
//
// PYTH "STALENESS" MAGNITUDE FINDING (2026-09-17)
// ----------------------------------------------
// The tool reported Pyth ages of days-to-weeks (e.g. 2,618,376 s on Ethereum) against
// `typicalUpdate: 1` second and labelled them HIGH. That was investigated live:
//
//   * The decode is CORRECT. getPriceUnsafe(bytes32) returns
//     (int64 price, uint64 conf, int32 expo, uint32 publishTime) = 4 ABI words
//     (258-char result). Slot 3 decoded to a plausible unix time and the price/expo
//     decoded to a credible ETH price; chain block timestamps matched machine time, so
//     there is no clock skew.
//   * The magnitude is GENUINE. On Ethereum mainnet the same contract returned
//     USDC/USD at 896 s of age (actively pushed) while ETH/USD was 30.3 days and
//     BTC/USD 55.2 days old. Pyth publishes to Hermes every ~1 s, but
//     getPriceUnsafe() only returns the last price *pushed on-chain* by a permissionless
//     updatePriceFeeds() call. Push frequency is per-feed and per-chain, so a 1 s
//     baseline is simply the wrong yardstick and made normal, unpushed feeds look
//     "HIGH stale".
//
// The defect fixed here is therefore the BASELINE and the SEVERITY, not the decode:
//   * Pyth rows are now compared against the oracle contract's own staleness tolerance
//     read on chain (`getValidTimePeriod()`, 0xe18910a3 — 120 s on mainnet, 60 s
//     elsewhere on 2026-09-17), and the age is also reported in days.
//   * Stored-price age alone can no longer produce HIGH/CRITICAL: pulling stale data is
//     only exploitable when a consumer reads it without an adequate max-age check, and
//     this scanner does not join consumers. Rows say so explicitly.
//   * HIGH is reserved for a genuine oracle-configuration anomaly: a contract
//     validTimePeriod above a conservative ceiling (Pyth's default is 60 s), which
//     would let the safe getter accept materially stale signed prices.
//
// Other observations recorded in the artifact rather than fixed (no verified
// replacement addresses available, so none were guessed):
//   * Stork / Band / Supra registered addresses answer `0x` to their documented
//     selectors on the chains probed. Band mainnet even reverts after the two-string
//     calldata encoder below was corrected, so those targets are unverified, not fixed.
//   * The Band encoder previously emitted a 0x20 offset for BOTH dynamic arguments,
//     which is malformed calldata; corrected here so a live Band target would answer.
const { rpcCall, resolveRpc } = require("./shared-rpc");
const ethers = require("ethers");
const fs = require("fs"); const path = require("path");

const OUT = path.join(__dirname, "..", "reports", "raw", "fast", "pull-oracle-timing.json");

// === Oracle Registry ===
const CHAIN_NAMES = {1:"ETH",42161:"Arb",8453:"Base",10:"OP",137:"Poly",56:"BSC",43114:"Avax",534352:"Scroll",59144:"Linea",100:"Gno",324:"zkSync"};

// Pyth IPyth interface - getPriceNoOlderThan / getPriceUnsafe
// getPriceUnsafe returns the last on-chain-pushed price, NOT the Hermes (~1s) price.
const PYTH = {
  sel: { priceUnsafe: "0x96834ad3", validTimePeriod: "0xe18910a3" }, // getPriceUnsafe(bytes32), getValidTimePeriod()
  feedId: { "ETH/USD": "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace" },
  chains: {
    1:"0x4305FB66699C3B2702D4d05CF36551390A4c69C6",
    42161:"0xff1a0f4744e8582DF1aE09D5611b887B6a12925C",
    8453:"0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a",
    10:"0xff1a0f4744e8582DF1aE09D5611b887B6a12925C",
    137:"0xff1a0f4744e8582DF1aE09D5611b887B6a12925C",
    56:"0x4D7E825f80bDf85e913E0DD2A2D54927e9dE1594",
    43114:"0x4305FB66699C3B2702D4d05CF36551390A4c69C6",
  },
  offchainCadenceSeconds: 1,       // Hermes publication cadence (context, NOT the comparison basis)
  maxSafeValidTimePeriod: 300,     // conservative ceiling; Pyth default is 60s, mainnet read 120s
};

// Stork - getTemporalNumericValueV1 (selector verified; registered addresses did not answer)
const STORK = {
  sel: { getValue: "0x19af7a40" }, // getTemporalNumericValueV1(bytes32)
  feedId: { "ETH/USD": "0x7404e3d104ea7841c3d9e6fd20adfe99b4ad586bc08d8f3bd3afef4cf4b24030" },
  chains: {
    1:"0x035B5438444f26e6Aab81E91d475b7B1Ac4Fb22b",
    42161:"0xacC0a0cF13571d30B4b8637996F5D6D774d4fd62",
    8453:"0x647DFd812BC1e116c6992CB2bC353b2112176fD6",
    10:"0xacC0a0cF13571d30B4b8637996F5D6D774d4fd62",
    137:"0xacC0a0cF13571d30B4b8637996F5D6D774d4fd62",
    56:"0x7D06cc8210228365896A3cc8Aac88c5551529112",
    43114:"0x647DFd812BC1e116c6992CB2bC353b2112176fD6",
  },
  typicalUpdate: 15, // assumed off-chain cadence (context only)
};

// Band Standard Dataset - getReferenceData (selector verified; registered address did not answer)
const BAND = {
  sel: { refData: "0x65555bcc" }, // getReferenceData(string,string)
  chains: {
    1:"0xDA7a001b254CD22e46d3eAB04d937489c93174C3",
    42161:"0xDA7a001b254CD22e46d3eAB04d937489c93174C3",
    10:"0xDA7a001b254CD22e46d3eAB04d937489c93174C3",
    137:"0xDA7a001b254CD22e46d3eAB04d937489c93174C3",
    56:"0xDA7a001b254CD22e46d3eAB04d937489c93174C3",
    43114:"0xDA7a001b254CD22e46d3eAB04d937489c93174C3",
  },
  typicalUpdate: 300,
};

// Supra Pull Oracle - getPrice (selector verified; registered address did not answer)
const SUPRA = {
  sel: { getPrice: "0x31d98b3f" }, // getPrice(bytes32)
  chains: {
    1:"0x2FA6DbFe4291136Cf272E1A3294362b6651e8517",
    42161:"0x41AB2059bAA4b73E9A3f55D30Dff27179e0eA181",
    8453:"0x2FA6DbFe4291136Cf272E1A3294362b6651e8517",
    10:"0x2FA6DbFe4291136Cf272E1A3294362b6651e8517",
    137:"0x2FA6DbFe4291136Cf272E1A3294362b6651e8517",
    56:"0x2FA6DbFe4291136Cf272E1A3294362b6651e8517",
    43114:"0x2FA6DbFe4291136Cf272E1A3294362b6651e8517",
  },
  typicalUpdate: 1,
};

const ESCALATION_REQUIREMENT = "escalation requires a joined consumer that reads the stale value without an adequate max-age check (not verified by this scanner)";

// ABI-encode f(string,string) arguments. Two dynamic arguments need distinct offsets:
// the first at 0x40 (past both offset words), the second after the first block.
// The previous implementation emitted 0x20 for both, producing malformed calldata.
function encodeStringPair(a, b) {
  const word = (n) => n.toString(16).padStart(64, "0");
  const enc = (s) => {
    const d = ethers.toUtf8Bytes(s);
    const body = ethers.hexlify(d).slice(2).padEnd(Math.ceil(d.length / 32) * 64, "0");
    return { len: word(d.length), body };
  };
  const A = enc(a); const B = enc(b);
  const offA = 64;
  const offB = 64 + 32 + A.body.length / 2;
  return word(offA) + word(offB) + A.len + A.body + B.len + B.body;
}

const NOW = Math.floor(Date.now() / 1000);

// Endpoint faults must not be reported as dead targets. During 2026-09-17 validation a
// flaky Base endpoint answered eth_getCode with "0x" while other endpoints returned a
// 680-byte contract, which is why these errors are retried once on a fresh endpoint.
const RPC_RETRY_ERRORS = new Set(["no-contract-code", "call-reverted", "short-return"]);

async function targetPresence(rpc, addr) {
  const code = await rpcCall(rpc, "eth_getCode", [addr, "latest"], 5000);
  return code ? (code.length - 2) / 2 : 0;
}

async function probeOracle(chainId, rpcs, name, probeFn) {
  let last = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const rpc = rpcs[chainId];
    if (!rpc) return last;
    last = await probeFn(rpc, chainId, name);
    if (!last || !last.error || !RPC_RETRY_ERRORS.has(last.error)) return last;
    const fresh = await resolveRpc(chainId);
    if (!fresh || fresh === rpc) return last;
    rpcs[chainId] = fresh;
  }
  return last;
}

async function probePyth(rpc, chainId, id) {
  const addr = PYTH.chains[chainId];
  if (!addr) return null;
  const codeBytes = await targetPresence(rpc, addr);
  if (codeBytes === 0) return { error: "no-contract-code", codeBytes };

  const feedId = PYTH.feedId["ETH/USD"];
  const vtpRaw = await rpcCall(rpc, "eth_call", [{ to: addr, data: PYTH.sel.validTimePeriod }, "latest"], 5000);
  const validTimePeriod = vtpRaw && vtpRaw.length >= 66 ? Number(BigInt("0x" + vtpRaw.slice(2, 66))) : null;

  const raw = await rpcCall(rpc, "eth_call", [{ to: addr, data: PYTH.sel.priceUnsafe + feedId.slice(2) }, "latest"], 8000);
  if (!raw) return { error: "call-reverted", codeBytes, validTimePeriod };
  // PythStructs.Price = 4 ABI words: int64 price, uint64 conf, int32 expo, uint32 publishTime
  if (raw.length < 258) return { error: "short-return", codeBytes, returnLen: raw.length, validTimePeriod };

  const priceRaw = BigInt("0x" + raw.slice(2, 66));
  // int64 sign extension
  const MAX_INT64 = BigInt("0x7FFFFFFFFFFFFFFF");
  const price = priceRaw > MAX_INT64 ? priceRaw - BigInt("0x10000000000000000") : priceRaw;

  const conf = Number(BigInt("0x" + raw.slice(66, 130)));

  // int32 is right-aligned in word 2: low 32 bits are the final 4 bytes.
  const expoUnsigned = parseInt(raw.slice(186, 194), 16);
  const expo = expoUnsigned > 0x7FFFFFFF ? expoUnsigned - 0x100000000 : expoUnsigned;

  const publishTime = Number(BigInt("0x" + raw.slice(194, 258))); // uint32 -> safe as Number

  // Sanity guard: only publish a price when the exponent is in a credible range.
  const priceCredible = Number.isInteger(expo) && expo <= 0 && expo >= -20 && publishTime > 0;
  return {
    codeBytes,
    feedId,
    price: priceCredible ? Number(price) * Math.pow(10, expo) : null,
    priceRaw: price.toString(),
    conf,
    expo,
    updatedAt: publishTime,
    age: publishTime ? NOW - publishTime : null,
    ageBasis: "on-chain publishTime returned by getPriceUnsafe()",
    validTimePeriod,
    stakedPriceGuard: priceCredible ? null : "exponent/publishTime outside credible range",
  };
}

function classifyPythRow(r) {
  const age = r.age;
  const days = age === null ? null : age / 86400;
  const basis = r.validTimePeriod;

  if (basis !== null && basis > PYTH.maxSafeValidTimePeriod) {
    return {
      severity: "HIGH",
      reason: "Pyth validTimePeriod " + basis + "s exceeds the conservative ceiling " + PYTH.maxSafeValidTimePeriod
        + "s: the max-age getter would accept materially stale signed prices. " + ESCALATION_REQUIREMENT + ".",
    };
  }
  if (age === null) {
    return { severity: "MEDIUM", reason: "stored price age unavailable; no staleness claim made" };
  }
  if (basis === null) {
    return {
      severity: "MEDIUM",
      reason: "on-chain stored price age " + age + "s (" + days.toFixed(1) + "d); contract validTimePeriod unreadable, so no verified staleness basis. "
        + "Hermes (~" + PYTH.offchainCadenceSeconds + "s) is not a valid on-chain-push baseline. " + ESCALATION_REQUIREMENT + ".",
    };
  }
  if (age <= basis) {
    return { severity: "LOW", reason: "stored price age " + age + "s <= validTimePeriod " + basis + "s (within the oracle's own tolerance)" };
  }
  return {
    severity: "MEDIUM",
    reason: "stored price age " + age + "s (" + days.toFixed(1) + "d) exceeds the contract validTimePeriod " + basis
      + "s. This is a genuine on-chain push gap, not a decode error: unpushed feeds legitimately go stale because updatePriceFeeds() is permissionless. "
      + ESCALATION_REQUIREMENT + ".",
  };
}

// Non-Pyth families: assume-cadence comparison, capped at MEDIUM for the same reason.
function classifyAssumeCadenceRow(r, typical) {
  const days = r.age === null ? null : r.age / 86400;
  if (r.age === null) return { severity: "LOW", reason: "age unavailable" };
  if (r.age > typical) {
    return {
      severity: "MEDIUM",
      reason: "stored value age " + r.age + "s (" + (days === null ? "?" : days.toFixed(1)) + "d) vs assumed off-chain cadence "
        + typical + "s (assumption, not a verified on-chain basis). " + ESCALATION_REQUIREMENT + ".",
    };
  }
  return { severity: "LOW", reason: "stored value age " + r.age + "s <= assumed cadence " + typical + "s" };
}

async function probeStork(rpc, chainId, id) {
  const addr = STORK.chains[chainId];
  if (!addr) return null;
  const codeBytes = await targetPresence(rpc, addr);
  if (codeBytes === 0) return { error: "no-contract-code", codeBytes };
  const feedId = STORK.feedId["ETH/USD"];
  const raw = await rpcCall(rpc, "eth_call", [{ to: addr, data: STORK.sel.getValue + feedId.slice(2) }, "latest"], 8000);
  if (!raw) return { error: "call-reverted", codeBytes };
  if (raw.length < 194) return { error: "short-return", codeBytes, returnLen: raw.length };
  // TemporalNumericValue: (int192 quantizedValue, int192 quantizedValueExact, uint64 timestamp)
  const quantized = Number(BigInt("0x" + raw.slice(2, 66))) / 1e8;
  const timestamp = Number(BigInt("0x" + raw.slice(130, 194)));
  return { codeBytes, price: quantized, updatedAt: timestamp, age: timestamp ? NOW - timestamp : null, ageBasis: "on-chain timestamp" };
}

async function probeBand(rpc, chainId, id) {
  const addr = BAND.chains[chainId];
  if (!addr) return null;
  const codeBytes = await targetPresence(rpc, addr);
  if (codeBytes === 0) return { error: "no-contract-code", codeBytes };
  const data = BAND.sel.refData + encodeStringPair("ETH", "USD");
  const raw = await rpcCall(rpc, "eth_call", [{ to: addr, data }, "latest"], 8000);
  if (!raw) return { error: "call-reverted", codeBytes };
  if (raw.length < 194) return { error: "short-return", codeBytes, returnLen: raw.length };
  // ReferenceData: (uint256 rate, uint256 lastUpdatedBase, uint256 lastUpdatedQuote)
  const rate = Number(BigInt("0x" + raw.slice(2, 66))) / 1e18;
  const updatedBase = Number(BigInt("0x" + raw.slice(66, 130)));
  const updatedQuote = Number(BigInt("0x" + raw.slice(130, 194)));
  const oldest = Math.min(updatedBase, updatedQuote);
  return { codeBytes, price: rate, updatedAt: oldest, age: oldest ? NOW - oldest : null, ageBasis: "on-chain lastUpdated" };
}

async function probeSupra(rpc, chainId, id) {
  const addr = SUPRA.chains[chainId];
  if (!addr) return null;
  const codeBytes = await targetPresence(rpc, addr);
  if (codeBytes === 0) return { error: "no-contract-code", codeBytes };
  const pairId = ethers.keccak256(ethers.encodeBytes32String("ETH/USD"));
  const raw = await rpcCall(rpc, "eth_call", [{ to: addr, data: SUPRA.sel.getPrice + pairId.slice(2) }, "latest"], 8000);
  if (!raw) return { error: "call-reverted", codeBytes };
  if (raw.length < 130) return { error: "short-return", codeBytes, returnLen: raw.length };
  const price = Number(BigInt("0x" + raw.slice(2, 66))) / 1e8; // assumed 8 decimals, unverified
  const timestamp = Number(BigInt("0x" + raw.slice(130, 194)));
  return { codeBytes, price, updatedAt: timestamp, age: timestamp ? NOW - timestamp : null, ageBasis: "on-chain timestamp" };
}

async function scanOracles() {
  console.log("=== Pull-Oracle Timing Attack Scanner (Pattern #1) ===\n");
  console.log("Basis: on-chain stored price age vs each oracle contract's own tolerance");
  console.log("Attack: supplier provides stale-yet-valid-signed data → borrow against inflated price\n");

  const results = [];
  const rpcs = {};

  // Target chains
  const chains = [1, 42161, 8453, 10, 137, 56, 43114];

  for (const cid of chains) {
    if (!rpcs[cid]) rpcs[cid] = await resolveRpc(cid);
    const name = CHAIN_NAMES[cid] || ("c" + cid);
    if (!rpcs[cid]) {
      // Do not let an unresolved chain vanish from the artifact: record the coverage gap.
      for (const type of ["Pyth", "Stork", "Band", "Supra"]) {
        results.push({ chain: name, oracle: type, error: "no-rpc" });
      }
      continue;
    }

    const pythR = await probeOracle(cid, rpcs, name, probePyth);
    const storkR = await probeOracle(cid, rpcs, name, probeStork);
    const bandR = await probeOracle(cid, rpcs, name, probeBand);
    const supraR = await probeOracle(cid, rpcs, name, probeSupra);

    const chainResults = [];
    for (const [type, r, typical] of [
      ["Pyth", pythR, PYTH.offchainCadenceSeconds],
      ["Stork", storkR, STORK.typicalUpdate],
      ["Band", bandR, BAND.typicalUpdate],
      ["Supra", supraR, SUPRA.typicalUpdate],
    ]) {
      if (!r) { chainResults.push({ chain:name, oracle:type, error:"not-configured" }); continue; }
      if (r.error) { chainResults.push({ chain:name, oracle:type, error:r.error, codeBytes:r.codeBytes, returnLen:r.returnLen }); continue; }

      const verdict = type === "Pyth" ? classifyPythRow(r) : classifyAssumeCadenceRow(r, typical);
      const row = {
        chain: name, oracle: type,
        price: r.price === null || r.price === undefined ? null : Number(r.price.toFixed(2)),
        age: r.age,
        ageDays: r.age === null ? null : Number((r.age / 86400).toFixed(2)),
        updatedAt: r.updatedAt,
        ageBasis: r.ageBasis,
        codeBytes: r.codeBytes,
        validTimePeriod: type === "Pyth" ? r.validTimePeriod : undefined,
        risk: verdict.severity + " — " + verdict.reason,
        riskSeverity: verdict.severity,
        escalationRequirement: ESCALATION_REQUIREMENT,
      };
      if (r.stakedPriceGuard) row.priceGuard = r.stakedPriceGuard;
      chainResults.push(row);

      const pStr = row.price !== null ? "$" + row.price.toFixed(2) : "N/A";
      const aStr = r.age !== null ? r.age + "s" : "N/A";
      console.log((name + "-" + type).padEnd(16) + pStr.padEnd(14) + aStr.padEnd(12) + verdict.severity);
    }
    results.push(...chainResults);
  }

  // Query pushed Chainlink as baseline
  console.log("\n=== Push Oracle Baseline (Chainlink ETH/USD) ===");
  const chainlinkBaseline = [];
  const clFeeds = {1:"0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419",42161:"0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612",8453:"0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",10:"0x13e3Ee699D1909E989722E753853AE30b17e08c5"};
  for (const [cid, feed] of Object.entries(clFeeds)) {
    if (!rpcs[cid]) continue;
    const raw = await rpcCall(rpcs[cid], "eth_call", [{ to: feed, data: "0xfeaf968c" }, "latest"], 5000);
    if (raw && raw.length >= 258) {
      const answer = Number(BigInt("0x" + raw.slice(2+64, 2+128))) / 1e8;
      const updatedAt = Number(BigInt("0x" + raw.slice(2+192, 2+256)));
      const age = NOW - updatedAt;
      chainlinkBaseline.push({ chain: CHAIN_NAMES[cid], oracle: "Chainlink", price: answer, updatedAt, age, ageBasis: "on-chain updatedAt" });
      console.log((CHAIN_NAMES[cid]+"-CL").padEnd(16) + "$" + answer.toFixed(2).padEnd(12) + age + "s");
    }
  }

  const high = results.filter(r => r.risk?.startsWith("HIGH"));
  const med = results.filter(r => r.risk?.startsWith("MEDIUM"));
  const staleStoredPrice = results.filter(r => typeof r.age === "number" && r.age > 0).length;
  console.log("\n=== Summary ===");
  console.log("HIGH (oracle-config anomaly): " + high.length + " | MEDIUM (stale stored value): " + med.length);
  console.log("Pull oracles answered: " + results.filter(r => !r.error).length + "/" + results.length
    + " | rows with a measured stored-value age: " + staleStoredPrice);
  if (med.length) console.log("Stale stored values require a consumer join before any severity escalation");

  fs.writeFileSync(OUT, JSON.stringify({
    scannedAt: new Date().toISOString(),
    ageBasisNote: "Pyth ages are on-chain publishTime from getPriceUnsafe(); Pyth's ~1s cadence is the off-chain Hermes cadence and is not a valid on-chain staleness baseline. Comparison basis is the contract's getValidTimePeriod().",
    escalationRequirement: ESCALATION_REQUIREMENT,
    results, high, medium: med, chainlinkBaseline,
  }, null, 2));
  console.log("Artifact: " + OUT);
}

scanOracles().catch(e => { console.error(e.message); process.exit(1); });
