#!/usr/bin/env node
"use strict";

// Morpho Blue read adapter + unchanged legacy CLI. No signer or transaction API.
const fs = require("node:fs"), path = require("node:path");
const single = require("./morpho-cbbtc-watch"), template = require("./multi-borrower-watch");
const { AbiCoder, keccak256 } = require("./node_modules/ethers");
const { ROOT, OUT, USDC, CBBTC, CORE, PRICE, IRM, PARAMS, liveSend, safeCode, safety, sha, rel, decimal } = single.helpers;
const SCHEMA = "morpho-multi-watch/v1", MAX_REQUESTS = 25, WAD = 10n ** 18n, SCALE = 10n ** 36n;
const OUTPUT = path.join(ROOT, "reports/monitor/morpho-multi-watch.json");
const LIST = path.join(__dirname, "morpho-multi-watch.watch-list.json"), FIXTURES = path.join(__dirname, "morpho-multi-watch.fixtures.json");
const USDE_MARKET = "0x54cf9be57fdfa6457a660991907434ff9d295c465a603a50126ff647d50b7354";
const MGLO_MARKET = "0x29ae7ac08be3a58e11151fed74701fb8e6ffd8e76b1870cf17ad70f332752d0b";
const ENFORCEMENT = "Observation-only multi-pair Morpho watch on Base. No signing, deployment, simulation, liquidation, transactions, or fund movement. Not fork proof or an executable route.";
const MARKETS = {
  [single.MARKET_ID]: { oracle: single.ORACLE, collateralToken: CBBTC, collateralDecimals: 8 },
  [USDE_MARKET]: { oracle: "0xf4b17c79492d68775e22e8dd0a2bb22854a39a47", collateralToken: "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34", collateralDecimals: 18 },
  [MGLO_MARKET]: { oracle: "0x182e072f2c9c58c6f19f144c97986f7496c6a109", collateralToken: "0xfcc9cc1209651ed8867332d6f664cf82743a2584", collateralDecimals: 18 },
};
const DEFAULT = { chainId: 8453, morpho: single.MORPHO, loanToken: USDC, loanDecimals: 6, markets: MARKETS, maxRequests: MAX_REQUESTS,
  get watchList() { return JSON.parse(fs.readFileSync(LIST)); } };
const fail = (code) => { throw new Error(code); };
const ceil = (a, b) => (a + b - 1n) / b;
function validateList(value, markets = MARKETS) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) fail("INVALID_ARGUMENTS");
  const seen = new Set();
  return value.map((row) => {
    if (!row || typeof row.marketId !== "string" || typeof row.borrower !== "string" || !/^0x[0-9a-f]{64}$/i.test(row.marketId)
        || !/^0x[0-9a-f]{40}$/i.test(row.borrower) || /^0x0{40}$/i.test(row.borrower)
        || typeof row.label !== "string" || !/^[a-z0-9 _.-]{1,80}$/i.test(row.label)) fail("INVALID_ARGUMENTS");
    const marketId = row.marketId.toLowerCase(), borrower = row.borrower.toLowerCase(), key = `${marketId}:${borrower}`;
    if (!markets[marketId] || seen.has(key)) fail("INVALID_ARGUMENTS");
    seen.add(key); return { marketId, borrower, label: row.label };
  });
}
function validateConfig(config) {
  for (const address of [config.morpho, config.loanToken]) if (!/^0x[0-9a-f]{40}$/i.test(address) || /^0x0{40}$/i.test(address)) fail("INVALID_ARGUMENTS");
  if (!Number.isInteger(config.loanDecimals) || config.loanDecimals < 0 || config.loanDecimals > 36 || !config.markets) fail("INVALID_ARGUMENTS");
  config.watchList = validateList(config.watchList, config.markets);
  for (const row of config.watchList) {
    const m = config.markets[row.marketId];
    if (!m || !/^0x[0-9a-f]{40}$/i.test(m.oracle) || !/^0x[0-9a-f]{40}$/i.test(m.collateralToken)
        || !Number.isInteger(m.collateralDecimals) || m.collateralDecimals < 0 || m.collateralDecimals > 36 + config.loanDecimals) fail("INVALID_ARGUMENTS");
  }
}
async function read(name, target, iface, args, names, block) {
  const raw = await this.transport.rpc("eth_call", [{ to: target.toLowerCase(), data: iface.encodeFunctionData(name, args) }, block]);
  if (typeof raw !== "string" || !/^0x(?:[0-9a-f]{64})+$/i.test(raw) || raw.length !== 2 + names.length * 64) fail("READ_INVALID");
  let decoded;
  try { decoded = iface.decodeFunctionResult(name, raw); if (iface.encodeFunctionResult(name, decoded).toLowerCase() !== raw.toLowerCase()) fail("READ_INVALID"); }
  catch (_) { fail("READ_INVALID"); }
  this.reads[name] = { target: target.toLowerCase(), returnData: raw, sha256: sha(Buffer.from(raw.slice(2), "hex")),
    values: Object.fromEntries(names.map((field, i) => [field, typeof decoded[i] === "bigint" ? decoded[i].toString() : decoded[i].toLowerCase()])) };
  return decoded;
}
async function readMarketTotal(market, block) {
  if (this.marketCache.has(market)) return this.marketCache.get(market);
  const c = this.config, expected = c.markets[market];
  const params = await this.read("idToMarketParams", c.morpho, CORE, [market], ["loanToken", "collateralToken", "oracle", "irm", "lltv"], block);
  if (keccak256(AbiCoder.defaultAbiCoder().encode([PARAMS], [params])) !== market || params[0].toLowerCase() !== c.loanToken.toLowerCase()
      || params[1].toLowerCase() !== expected.collateralToken.toLowerCase() || params[2].toLowerCase() !== expected.oracle.toLowerCase()
      || params[4] <= 0n || params[4] >= WAD) fail("MARKET_PARAMS_INVALID");
  const totals = await this.read("market", c.morpho, CORE, [market], ["totalSupplyAssets", "totalSupplyShares", "totalBorrowAssets", "totalBorrowShares", "lastUpdate", "fee"], block);
  let rate = 0n;
  if (!/^0x0{40}$/i.test(params[3]) && BigInt(this.pin.timestamp) > totals[4]) [rate] = await this.read("borrowRateView", params[3], IRM, [params, totals], ["borrowRatePerSecondWad"], block);
  const value = { params, totals, rate, lltv: params[4] }; this.marketCache.set(market, value); this.marketId = market;
  return value;
}
async function readPosition(market, borrower, block) {
  const position = await this.read("position", this.config.morpho, CORE, [market, borrower], ["supplyShares", "borrowShares", "collateral"], block);
  const { params, totals, rate } = await this.readMarketTotal(market, block);
  // Reuse the validated Morpho virtual-share + local Taylor-accrual arithmetic.
  const accrued = single.compute(position, totals, params, 1n, this.pin.timestamp, rate);
  return { debt: BigInt(accrued.debtRawUsdc), collateral: position[2] };
}
async function readOraclePrice(market, block) {
  const [price] = await this.read("price", this.config.markets[market].oracle, PRICE, [], ["price"], block);
  if (price <= 0n) fail("MARKET_INVALID"); return price;
}
function computeHF(debt, collateral, oraclePrice, lltv) {
  debt = BigInt(debt); collateral = BigInt(collateral); oraclePrice = BigInt(oraclePrice); lltv = BigInt(lltv);
  if (debt < 0n || collateral < 0n || oraclePrice <= 0n || lltv <= 0n || lltv >= WAD) fail("MARKET_INVALID");
  const maxBorrow = (collateral * oraclePrice / SCALE) * lltv / WAD;
  const hf = debt === 0n ? null : maxBorrow * WAD / debt;
  const distance = maxBorrow === 0n || maxBorrow <= debt ? 0n : (maxBorrow - debt) * 100n * WAD / maxBorrow;
  const threshold = collateral > 0n && debt > 0n ? ceil(ceil(debt * WAD, lltv) * SCALE, collateral) : null;
  const c = this?.config, decimals = c ? 36 + c.loanDecimals - c.markets[this.marketId].collateralDecimals : null;
  return { debtRaw: debt.toString(), collateralRaw: collateral.toString(), lltvWad: lltv.toString(), oraclePriceRaw: oraclePrice.toString(),
    hf: hf === null ? null : decimal(hf), hfWad: hf?.toString() ?? null, noDebt: debt === 0n,
    distancePct: debt === 0n ? null : decimal(distance), protocolLiquidatableAtPin: debt > maxBorrow, verdict: single.classify(maxBorrow, debt),
    thresholdOraclePriceRaw: threshold?.toString() ?? null,
    thresholdOraclePriceUsdcPerCollateral: threshold === null || decimals === null || c.loanToken.toLowerCase() !== USDC ? null : decimal(threshold, decimals) };
}
function createAdapter(context) {
  return { ...context, marketCache: new Map(), read, readPosition, readMarketTotal, readOraclePrice, computeHF };
}
function summarizePair(entry, label) {
  const { thresholdOraclePricePerCollateral, ...summary } = template.rowSummary(entry, label);
  return { ...summary, thresholdOraclePriceUsdcPerCollateral: entry.metrics?.thresholdOraclePriceUsdcPerCollateral ?? null };
}
function allowCall(call, config) {
  const selector = call.data.slice(0, 10), target = call.to.toLowerCase();
  if (target === config.morpho.toLowerCase()) return ["position", "market", "idToMarketParams"].some((name) => selector === CORE.getFunction(name).selector);
  if (Object.values(config.markets).some((m) => m.oracle.toLowerCase() === target)) return selector === PRICE.getFunction("price").selector;
  return selector === IRM.getFunction("borrowRateView").selector;
}
function fixtureSend(config) {
  return require("./morpho-multi-watch.offline-test").fixtureSend(JSON.parse(fs.readFileSync(FIXTURES)), config.watchList);
}
// Legacy surface: the generic loop/persistence are shared, the original single-pair
// capture remains responsible for its established entry shape and provenance.
function parseArgs(argv) {
  let listPath = LIST, selected = false; const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--watch-list") { if (selected || !argv[i + 1]) fail("INVALID_ARGUMENTS"); selected = true; listPath = path.resolve(argv[++i]); }
    else if (argv[i] === "--default-cbbtc") { if (selected) fail("INVALID_ARGUMENTS"); selected = true; listPath = null; }
    else if (["--rpc-url", "--block"].includes(argv[i])) rest.push(argv[i], argv[++i]);
    else rest.push(argv[i]);
  }
  const options = single.parseArgs(rest); let list;
  try { list = listPath ? JSON.parse(fs.readFileSync(listPath)) : [{ marketId: single.MARKET_ID, borrower: single.BORROWER, label: "cbBTC-USDC-standing" }]; }
  catch (_) { fail("INVALID_ARGUMENTS"); }
  return { ...options, watchList: validateList(list) };
}
function makeTransport(send, mode) {
  return single.createTransport({ send, mode, maxRequests: MAX_REQUESTS, oracleTargets: new Set(Object.values(MARKETS).map((row) => row.oracle)) });
}
function rowSummary(entry, label) {
  const m = entry.metrics;
  const threshold = m && BigInt(m.collateralRaw) > 0n && BigInt(m.debtRawUsdc) > 0n ? ceil(ceil(BigInt(m.debtRawUsdc) * WAD, BigInt(m.lltvWad)) * SCALE, BigInt(m.collateralRaw)) : null;
  return { label, marketId: entry.identity.marketId, borrower: entry.identity.borrower, status: entry.status, verdict: entry.trigger.status, reason: entry.reason,
    hf: m?.hf ?? null, hfWad: m?.hfWad ?? null, distancePct: m?.adverseMoveToLiquidationPct ?? null, oraclePriceRaw: m?.oraclePriceRaw ?? null,
    thresholdOraclePriceRaw: threshold?.toString() ?? null, thresholdOraclePriceUsdcPerCollateral: threshold === null ? null : decimal(threshold, 36 + 6 - entry.identity.collateralDecimals),
    protocolLiquidatableAtPin: m?.protocolLiquidatableAtPin ?? null };
}
function captureMulti(options) {
  // Shared pinned getters need 24 requests for five borrowers across three markets
  // (25 with a historical header); no token sweep or Multicall3 batching is used.
  return template.captureMulti({ ...options, adapter: { schema: SCHEMA, maxRequests: MAX_REQUESTS, enforcement: ENFORCEMENT, rowSummary,
    thresholdPolicy: "Minimum raw integer oracle price for protocol health; equality is healthy. Distances use unrounded HF arithmetic; no-debt entries are not ranked.",
    async captureEntry({ transport, row, block, fixtureId }) {
      const legacy = row.marketId === single.MARKET_ID && row.borrower === single.BORROWER;
      const entry = await single.capture({ transport, block, fixtureId, watch: legacy ? null : { ...row, ...MARKETS[row.marketId] } });
      if (fixtureId) { entry.provenance.fixturePath = rel(FIXTURES); entry.provenance.fixtureSha256 = sha(fs.readFileSync(FIXTURES)); }
      return entry;
    } } });
}
const { persist, freshStatus } = template.createPersistence({ root: ROOT, out: OUT, output: OUTPUT, schema: SCHEMA,
  manifestSchema: "morpho-multi-watch-manifest/v1", artifactPattern: /^reports\/raw\/fast\/morpho-cbbtc-watch\/multi-[^/]+\.json$/ });
async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--adapter")) return template.main(argv);
  const options = parseArgs(argv);
  if (options.offlineTest) return require("./morpho-multi-watch.offline-test").offlineTest();
  if (options.live && !options.refresh) {
    const cached = freshStatus({ ...options, maxRequests: MAX_REQUESTS });
    if (cached) { process.stdout.write(JSON.stringify({ status: cached.status, reused: true, artifactPath: cached.artifactPath, rpcCount: 0, crossPairSummary: cached.crossPairSummary }) + "\n"); return; }
  }
  const transport = makeTransport(options.live ? liveSend(options.rpcUrl) : fixtureSend({ watchList: options.watchList }), options.live ? "live" : "dry-run");
  const value = await captureMulti({ transport, watchList: options.watchList, block: options.block, fixtureId: options.live ? null : "multi-synthetic" });
  let prior = null; try { prior = JSON.parse(fs.readFileSync(OUTPUT)); } catch (_) { /* first capture */ }
  const artifactPath = persist(value, options.live || prior?.mode !== "live");
  process.stdout.write(JSON.stringify({ status: value.status, mode: value.mode, artifactPath, rpcCount: value.diagnostics.rpcCount, pin: value.pin, crossPairSummary: value.crossPairSummary }) + "\n");
  if (value.status !== "COMPLETE") process.exitCode = 1;
}
module.exports = { main, captureMulti, validateList, parseArgs, OUTPUT, SCHEMA, makeTransport, persist, ENFORCEMENT, MARKETS, USDE_MARKET, MGLO_MARKET, MAX_REQUESTS,
  default: DEFAULT, defaultRpcUrl: "https://base-rpc.publicnode.com", readPosition, readMarketTotal, readOraclePrice, computeHF, createAdapter, validateConfig, allowCall, fixtureSend, summarizePair,
  thresholdPolicy: "Minimum raw integer oracle price for protocol health; equality is healthy. Distances use unrounded HF arithmetic; no-debt entries are not ranked." };
if (require.main === module) main().catch((error) => { process.stdout.write(JSON.stringify({ status: "INCOMPLETE", reason: safeCode(error), enforcement: ENFORCEMENT, safety: safety() }) + "\n"); process.exitCode = 1; });
