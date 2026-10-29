"use strict";

// Import-inert, read-only arithmetic verifier. No signer, executor invocation,
// quote/exit proof or execution permission. Future values HOLD the pin's oracle
// price and IRM rate constant; they are not future-chain observations.
const MORPHO = "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb";
const NEAR_MORPHO_TARGETS = Object.freeze([
  { id: "targetM31_Morpho_syrupUSDC_USDC", rank: "#M31", pair: "syrupUSDC / USDC", borrower: "0x950fd558f47e234a2fde23b7d61f7ccdbcb4a86f",
    marketId: "0x729badf297ee9f2f6b3f717b96fd355fc6ec00422284ce1968e76647b258cf44", executor: "0x2d5bca1b846e89965544c7f03d09a25126803627", loanDecimals: 6, collateralDecimals: 6, maxSeizeCapRaw: "740000000" },
  { id: "targetM29_Morpho_PT_srUSDe_USDC", rank: "#M29", pair: "PT-srUSDe-15JAN2026 / USDC", borrower: "0x723cf98bfa71d786e3962140b79823637d0bbc0b",
    marketId: "0x79b4e55cef9e7c214b5cc965e1984229ada26a66051e35366a75c4d92b776735", executor: "0xd53ee7b5806c4d7f36422eab99dc46563d18b84d", loanDecimals: 6, collateralDecimals: 18, maxSeizeCapRaw: "3500000000000000000000" },
  { id: "targetM25_Morpho_USD3_USDC", rank: "#M25", pair: "USD3 / USDC", borrower: "0xaa34d20be3f9623ccf5bff53ef4dfa765c3f5dd5",
    marketId: "0xe3df58f9d3011b7481ff36b939fa5f8da642f34ea5792d25d3958dbf1efa26d7", executor: "0x2d5bca1b846e89965544c7f03d09a25126803627", loanDecimals: 6, collateralDecimals: 6, maxSeizeCapRaw: "150000000000" },
  { id: "targetM22_Morpho_PT_apyUSD_apxUSD", rank: "#M22", pair: "PT-apyUSD-5NOV2026 / apxUSD", borrower: "0x687f584fd1f4a4d9eb277c03a24fe28f4b0675b7",
    marketId: "0xebd23a871b52e0a8c92bd719f4413600101b69e946cb72923b3a33fb5bc6ec85", executor: "0x2d5bca1b846e89965544c7f03d09a25126803627", loanDecimals: 18, collateralDecimals: 18, maxSeizeCapRaw: "250000000000000000000000" },
  { id: "targetM18_Morpho_USD3_USDC", rank: "#M18", pair: "USD3 / USDC", borrower: "0x599275be9753ecd8e6c380a7ef78e38711b8f212",
    marketId: "0xe3df58f9d3011b7481ff36b939fa5f8da642f34ea5792d25d3958dbf1efa26d7", executor: "0x2d5bca1b846e89965544c7f03d09a25126803627", loanDecimals: 6, collateralDecimals: 6, maxSeizeCapRaw: "100000000000" },
].map(row => Object.freeze({ chainId: 1, morpho: MORPHO, ...row })));
const W = 10n ** 18n, PRICE_SCALE = 10n ** 36n, VIRTUAL_SHARES = 1000000n, MAX = (1n << 256n) - 1n;
const LADDER = [10000n, 9500n, 9000n, 8000n, 7000n, 5000n, 2500n];
const CROSSING_HORIZON = 315360000n; // Bounded ten-year constant-input model, not a prediction.
const errors = new WeakMap();
function fail(code) { const error = new Error(code); errors.set(error, code); throw error; }
function need(ok, code) { if (!ok) fail(code); }
const safe = error => errors.get(error) || "MORPHO_READ_FAILED";
const json = value => JSON.parse(JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v));
const invoke = job => Promise.resolve().then(job);
async function together(jobs) {
  const results = await Promise.allSettled(jobs.map(invoke));
  const bad = results.find(r => r.status === "rejected"); if (bad) throw bad.reason;
  return results.map(r => r.value);
}
function uint(value) {
  need(typeof value === "bigint" || typeof value === "number" && Number.isSafeInteger(value) || typeof value === "string" &&
    /^(?:0|[1-9][0-9]{0,77}|0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63}))$/.test(value), "MORPHO_INTEGER_INVALID");
  const n = BigInt(value); need(n >= 0n && n <= MAX, "MORPHO_INTEGER_INVALID"); return n;
}
const mul = (a, b) => uint(a * b);
const ceil = (a, b) => a / b + (a % b === 0n ? 0n : 1n);
const min = (...values) => values.reduce((a, b) => a < b ? a : b);
function address(value) {
  need(typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/.test(value), "MORPHO_ADDRESS_INVALID"); return value.toLowerCase();
}
function hash(value) {
  need(typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) && !/^0x0{64}$/.test(value), "MORPHO_HASH_INVALID"); return value.toLowerCase();
}
function pinOf(pin) {
  need(pin && typeof pin === "object" && (pin.chainId === undefined || uint(pin.chainId) === 1n), "MORPHO_PIN_INVALID");
  const number = uint(pin.number), timestamp = uint(pin.timestamp);
  need(number > 0n && number < BigInt(Number.MAX_SAFE_INTEGER) && timestamp > 0n && timestamp < BigInt(Number.MAX_SAFE_INTEGER) - CROSSING_HORIZON, "MORPHO_PIN_INVALID");
  return Object.freeze({ chainId: 1, number: String(number), hash: hash(pin.hash), timestamp: String(timestamp) });
}
function profile(spec) {
  need(spec && spec.chainId === 1 && address(spec.morpho) === MORPHO && typeof spec.id === "string" && /^target[A-Za-z0-9_]{1,80}$/.test(spec.id) &&
    typeof spec.rank === "string" && /^#M[0-9]{1,5}$/.test(spec.rank) && typeof spec.pair === "string" && /^[A-Za-z0-9 /-]{1,80}$/.test(spec.pair), "MORPHO_TARGET_INVALID");
  need([spec.loanDecimals, spec.collateralDecimals].every(n => Number.isInteger(n) && n >= 0 && n <= 36) && uint(spec.maxSeizeCapRaw) > 0n, "MORPHO_TARGET_INVALID");
  return Object.freeze({ id: spec.id, rank: spec.rank, pair: spec.pair, chainId: 1, morpho: MORPHO, borrower: address(spec.borrower),
    marketId: hash(spec.marketId), executor: address(spec.executor), loanDecimals: spec.loanDecimals, collateralDecimals: spec.collateralDecimals,
    maxSeizeCapRaw: uint(spec.maxSeizeCapRaw).toString() });
}
function decimal(numerator, denominator, digits) {
  const sign = numerator < 0n ? "-" : "", n = numerator < 0n ? -numerator : numerator, scale = 10n ** BigInt(digits);
  const value = n * scale / denominator;
  return sign + String(value / scale) + "." + String(value % scale).padStart(digits, "0");
}
function stateAt(market, position, price, rate, lltv, timestamp) {
  need(timestamp >= market.lastUpdate, "MORPHO_STATE_INVALID");
  const elapsed = timestamp - market.lastUpdate, first = mul(rate, elapsed), second = mul(first, first) / (2n * W), third = mul(second, first) / (3n * W);
  const compounded = uint(first + second + third), interest = mul(market.totalBorrowAssets, compounded) / W;
  const accruedBorrowAssets = uint(market.totalBorrowAssets + interest);
  need(accruedBorrowAssets < 1n << 128n, "MORPHO_ACCRUAL_OVERFLOW");
  const debt = ceil(mul(position.borrowShares, accruedBorrowAssets + 1n), market.totalBorrowShares + VIRTUAL_SHARES);
  need(debt > 0n, "MORPHO_NO_DEBT");
  const maxBorrow = mul(mul(position.collateral, price) / PRICE_SCALE, lltv) / W;
  const bpsNumerator = (maxBorrow - debt) * 10000n;
  return { timestamp, elapsed, compounded, interest, accruedBorrowAssets, debt, maxBorrow, isLiquidatable: debt > maxBorrow,
    healthFactor: decimal(maxBorrow, debt, 18), healthFactorExact: { numerator: maxBorrow, denominator: debt },
    bpsToLiquidation: decimal(bpsNumerator, debt, 8), bpsToLiquidationExact: { numerator: bpsNumerator, denominator: debt } };
}
function sizes(state, market, position, price, lltv, cap) {
  const lif = min(1150000000000000000n, PRICE_SCALE / (W - 300000000000000000n * (W - lltv) / W));
  const assets = state.accruedBorrowAssets + 1n, shares = market.totalBorrowShares + VIRTUAL_SHARES;
  const fullNumerator = mul(position.borrowShares, assets), fullRepay = ceil(fullNumerator, shares);
  // Morpho seizes from toAssetsDown, but charges the toAssetsUp amount.
  const shareBound = mul(mul(fullNumerator / shares, lif) / W, PRICE_SCALE) / price;
  const base = min(position.collateral, cap, shareBound);
  const rows = [{ mode: "repaidShares", bps: 10000n, seizedAssets: 0n, repaidShares: position.borrowShares,
    expectedSeizedAssets: shareBound, expectedRepaidShares: position.borrowShares, expectedRepaidAssets: fullRepay }];
  for (const bps of LADDER) {
    const seizedAssets = base * bps / 10000n, initialRepay = ceil(mul(ceil(mul(seizedAssets, price), PRICE_SCALE), W), lif);
    const repaidShares = ceil(mul(initialRepay, shares), assets), repaidAssets = ceil(mul(repaidShares, assets), shares);
    rows.push({ mode: "seizedAssets", bps, seizedAssets, repaidShares: 0n,
      expectedSeizedAssets: seizedAssets, expectedRepaidShares: repaidShares, expectedRepaidAssets: repaidAssets });
  }
  return rows.map((row, index) => {
    const reason = row.expectedSeizedAssets === 0n || row.expectedRepaidShares === 0n ? "MORPHO_ZERO_SIZE" :
      row.expectedSeizedAssets > position.collateral ? "MORPHO_COLLATERAL_BOUND" : row.expectedSeizedAssets > cap ? "MORPHO_SEIZE_CAP" :
        row.expectedRepaidShares > position.borrowShares || row.expectedRepaidAssets > state.debt ? "MORPHO_REPAY_BOUND" : null;
    return { alias: index + 1, ...row, status: reason ? "EXCLUDED" : "SIZED", reason, feasible: reason === null,
      liquidationConditionInModel: state.isLiquidatable, executionReady: false };
  });
}

async function evaluateMorphoTargetAtPin(targetSpec, reader) {
  const out = { schema: "near-morpho-target-readiness/v1", status: "HOLD", reason: null, target: null, pin: null,
    executorCodePresent: null, executorCompatibilityVerified: false, tokenDecimalsVerified: false, executionReady: false,
    liveActions: false, signing: false, productionEligibilityProven: false,
    readEvidenceScope: "DELEGATED_TO_CALLER_PINNED_READER", projectionScope: "CONSTANT_PIN_RATE_AND_PRICE_NOT_FUTURE_CHAIN_EVIDENCE",
    crossingHorizonSeconds: String(CROSSING_HORIZON), variants: [], currentVariants: [] };
  try {
    const target = profile(targetSpec); out.target = target;
    need(reader && typeof reader.call === "function" && typeof reader.code === "function", "MORPHO_READER_INVALID");
    const pin = pinOf(reader.pin); out.pin = pin;
    const { Interface, AbiCoder, keccak256 } = require("./node_modules/ethers");
    const MP = "(address,address,address,address,uint256)", MT = "(uint128,uint128,uint128,uint128,uint128,uint128)";
    const abi = new Interface([`function idToMarketParams(bytes32) view returns(${MP})`, `function market(bytes32) view returns(${MT})`,
      "function position(bytes32,address) view returns(uint256,uint128,uint128)", `function borrowRateView(${MP},${MT}) view returns(uint256)`, "function price() view returns(uint256)"]);
    function decode(name, raw, words) {
      need(typeof raw === "string" && raw.length === 2 + words * 64 && /^0x[0-9a-fA-F]+$/.test(raw), "MORPHO_RETURN_INVALID");
      try { const value = abi.decodeFunctionResult(name, raw); need(abi.encodeFunctionResult(name, value).toLowerCase() === raw.toLowerCase(), "MORPHO_RETURN_INVALID"); return value; }
      catch { fail("MORPHO_RETURN_INVALID"); }
    }
    const read = (to, name, args = [], words = 1) => invoke(async () => decode(name, await reader.call({ to, data: abi.encodeFunctionData(name, args) }), words));
    // Wave 1 is dispatched first. Its dependants are NOT blocked on position or
    // executor code; every sibling/dependent request is drained on failure.
    const paramsRead = read(MORPHO, "idToMarketParams", [target.marketId], 5), marketRead = read(MORPHO, "market", [target.marketId], 6);
    const dependent = (async () => {
      const [p, m] = await together([() => paramsRead, () => marketRead]);
      const params = Array.from(p[0]), marketArray = Array.from(m[0]);
      params.slice(0, 4).forEach(address);
      need(params[4] > 0n && params[4] <= W && keccak256(AbiCoder.defaultAbiCoder().encode([MP], [params])) === target.marketId, "MORPHO_MARKET_MISMATCH");
      const [rate, price] = await together([() => read(address(params[3]), "borrowRateView", [params, marketArray]), () => read(address(params[2]), "price")]);
      return { params, marketArray, rate: rate[0], price: price[0] };
    })();
    const positionRead = read(MORPHO, "position", [target.marketId, target.borrower], 3), codeRead = invoke(() => reader.code(target.executor));
    const [collected, rawPosition, code] = await together([() => dependent, () => positionRead, () => codeRead]);
    need(JSON.stringify(pinOf(reader.pin)) === JSON.stringify(pin), "MORPHO_PIN_CHANGED");
    need(typeof code === "string" && code.length <= 2 + 2 * 1048576 && /^0x(?:[0-9a-fA-F]{2})*$/.test(code), "MORPHO_CODE_INVALID");
    const { params, marketArray, rate, price } = collected;
    const market = Object.fromEntries(["totalSupplyAssets", "totalSupplyShares", "totalBorrowAssets", "totalBorrowShares", "lastUpdate", "fee"].map((key, i) => [key, marketArray[i]]));
    const position = { supplyShares: rawPosition[0], borrowShares: rawPosition[1], collateral: rawPosition[2] };
    const timestamp = uint(pin.timestamp), lltv = params[4];
    need(price > 0n && market.lastUpdate > 0n && market.lastUpdate <= timestamp && market.fee <= W &&
      position.borrowShares > 0n && position.borrowShares <= market.totalBorrowShares && position.collateral > 0n, "MORPHO_STATE_INVALID");
    const at = time => stateAt(market, position, price, rate, lltv, time);
    const current = at(timestamp), nextBlock = at(timestamp + 12n);
    let crossing = current.isLiquidatable ? current : null;
    if (!crossing && rate > 0n && market.totalBorrowAssets > 0n) {
      let low = 0n, high = 1n;
      while (!at(timestamp + high).isLiquidatable && high < CROSSING_HORIZON) { low = high; high = min(high * 2n, CROSSING_HORIZON); }
      if (at(timestamp + high).isLiquidatable) {
        while (high - low > 1n) { const mid = (low + high) / 2n; if (at(timestamp + mid).isLiquidatable) high = mid; else low = mid; }
        crossing = at(timestamp + high);
      }
    }
    const sizingState = crossing || current, cap = uint(target.maxSeizeCapRaw);
    Object.assign(out, { status: "READ_ONLY_VERIFIED", executorCodePresent: code !== "0x", params: { loanToken: address(params[0]), collateralToken: address(params[1]),
      oracle: address(params[2]), irm: address(params[3]), lltv }, originalMarket: market, position, oraclePrice: price, borrowRatePerSecond: rate,
      current, nextBlock, debt: current.debt, maxBorrow: current.maxBorrow, healthFactor: current.healthFactor,
      bpsToLiquidation: current.bpsToLiquidation, bpsToLiquidationExact: current.bpsToLiquidationExact,
      crossingTimestamp: crossing?.timestamp ?? null, crossingState: crossing,
      crossingStatus: current.isLiquidatable ? "ALREADY_LIQUIDATABLE_AT_PIN" : crossing ? "EXACT_INTEGER_SECOND_CONSTANT_INPUT_MODEL" : "NO_CROSSING_WITHIN_MODEL_HORIZON",
      passiveHoursToCrossing: crossing ? Number(crossing.timestamp - timestamp) / 3600 : null,
      passiveSecondsToCrossing: crossing ? crossing.timestamp - timestamp : null,
      variantTimestamp: sizingState.timestamp, variantScope: sizingState.timestamp === timestamp ? "PIN_STATE_ARITHMETIC_ONLY" : "PROJECTED_CROSSING_ARITHMETIC_ONLY",
      currentVariants: sizes(current, market, position, price, lltv, cap), variants: sizes(sizingState, market, position, price, lltv, cap) });
  } catch (error) { out.status = "HOLD"; out.reason = safe(error); out.variants = []; out.currentVariants = []; }
  return json(out);
}

async function verifyNearMorphoTargets({ targets = NEAR_MORPHO_TARGETS, createSession } = {}) {
  const report = { schema: "near-morpho-targets-readiness/v1", status: "HOLD", reason: null, pin: null, rows: [],
    complete: false, canonicalRechecked: false, liveActions: false, signing: false, executionReady: false,
    witnessVerification: "DELEGATED_TO_STRICT_PINNED_RPC_SESSION_NOT_EXTERNAL_ATTESTATION", dualWitnessSession: false };
  let session;
  try {
    need(Array.isArray(targets) && targets.length > 0 && targets.length <= 32 && typeof createSession === "function", "MORPHO_OPTIONS_INVALID");
    const specs = targets.map(profile); need(new Set(specs.map(s => s.id)).size === specs.length, "MORPHO_DUPLICATE_TARGET");
    session = await createSession();
    const e = session?.evidence;
    need(e?.strictEvidence === true && e.independentFamilies === true && e.fixedProviderPair === true && e.rawTimestamp === true && e.codeHashPinnedQualified === true &&
      Array.isArray(e.aliases) && e.aliases.length === 2 && e.aliases.every(a => Number.isSafeInteger(a) && a > 0) && e.aliases[0] !== e.aliases[1] &&
      typeof session.recheck === "function" && typeof session.call === "function" && typeof session.code === "function", "MORPHO_DUAL_WITNESS_REQUIRED");
    report.pin = pinOf(session.pin); report.dualWitnessSession = true; await session.recheck();
    report.rows = await together(specs.map(spec => () => evaluateMorphoTargetAtPin(spec, session)));
    await session.recheck(); need(JSON.stringify(pinOf(session.pin)) === JSON.stringify(report.pin), "MORPHO_PIN_CHANGED");
    report.canonicalRechecked = true;
    report.rows.sort((a, b) => {
      if (a.status !== b.status) return a.status === "READ_ONLY_VERIFIED" ? -1 : 1;
      if (a.status !== "READ_ONLY_VERIFIED") return 0;
      const x = a.bpsToLiquidationExact, y = b.bpsToLiquidationExact;
      const difference = BigInt(x.numerator) * BigInt(y.denominator) - BigInt(y.numerator) * BigInt(x.denominator);
      return difference < 0n ? -1 : difference > 0n ? 1 : 0;
    });
    need(report.rows.every(row => row.status === "READ_ONLY_VERIFIED"), "MORPHO_TARGETS_INCOMPLETE");
    report.complete = true; report.status = "READ_ONLY_VERIFIED";
  } catch (error) { report.reason = safe(error); }
  finally {
    try { await session?.close?.(); }
    catch { report.status = "HOLD"; report.complete = false; report.reason = "MORPHO_CLOSE_FAILED"; }
  }
  return report;
}

module.exports = Object.freeze({ NEAR_MORPHO_TARGETS, evaluateMorphoTargetAtPin, verifyNearMorphoTargets });

async function main() {
  need(process.argv.length === 2, "MORPHO_ARGUMENTS_REJECTED");
  const { createPinnedRpc, loadRpcCandidates, httpRpc } = require("./lib/executor-pinned-rpc.js");
  const report = await verifyNearMorphoTargets({ createSession: () => createPinnedRpc({ candidates: loadRpcCandidates(), rpc: httpRpc, requireStrictEvidence: true }) });
  const fs = require("node:fs"), path = require("node:path"), root = path.resolve(__dirname, "..");
  const directory = path.join(root, "reports/raw/fast/executor-readiness-m32-20261026");
  const file = path.join(directory, "near-morpho-targets-readiness-" + new Date().toISOString().replace(/[-:.]/g, "") + ".json");
  fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(file, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ status: report.status, reason: report.reason, pin: report.pin, artifact: path.relative(root, file),
    rows: report.rows.map(row => ({ id: row.target?.id, status: row.status, reason: row.reason, bpsToLiquidation: row.bpsToLiquidation,
      passiveHoursToCrossing: row.passiveHoursToCrossing, executorCodePresent: row.executorCodePresent,
      sizedVariants: row.variants.filter(v => v.feasible).length, executionReady: false })) }));
}
if (require.main === module) main().catch(() => { console.log("NEAR_MORPHO_TARGETS_HOLD"); process.exitCode = 1; });
