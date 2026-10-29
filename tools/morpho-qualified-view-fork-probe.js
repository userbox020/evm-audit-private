#!/usr/bin/env node
"use strict";

// morpho-qualified-view-fork-probe.js
//
// Lane A: resolve whether the conservative net veto on the scanner's
// `QUALIFIED_VIEW` rows (`quoteExecutable=false (same-pin fork probe pending)`)
// hides a real Morpho Blue liquidation profit. The scanner suppresses a row
// because its *assumed* net is <= 0 at a 2,000,000-gas ceiling price with a
// suppress-only haircut; this tool replaces that assumption with a MEASURED
// same-pin fork fill.
//
// It re-uses the scanner's recorded route + unit family (never re-derived):
//   * rows are the QUALIFIED_VIEW rows of the freshest scan artifact,
//   * the USDC unit family + gas model come from tools/frax-usdc-cross-venue-economics.js,
//   * the venue constants, route fees and haircut live in tools/morpho-unwind-valuation.js.
//
// It forks at the scanner's own (same) pin through an in-process loopback relay
// that owns the upstream (mirroring tools/aave-v3-flash-liquidator-rehearsal.js):
// endpoint material is NEVER printed, persisted, or forwarded to children.
// Keyless + local: the deployed executor is driven by an IMPERSONATED owner; no
// key is read, no transaction leaves the fork, nothing is signed.
//
// Chain 1 uses the DEPLOYED executor 0xaf5b...07ba (MATCH_IMMUTABLES_MASKED). No
// Base deployment of that executor exists, so chain 8453 deploys the identical
// local build artifact onto the Base fork and drives the same `execute(...)` shape.
//
// The scan's `seizedCollateralRaw` is the whole position collateral, so the
// trigger-runner's seize branch (seizedAssets=whole collateral, repaidShares=0)
// over-repays and is recorded as measured evidence; the extraction measurement
// uses the executor's repaid-shares branch (`execute(...,0,repaidShares,...)`),
// which is the shape the fork rehearsal proved, with a floor-bypass fallback
// recorded explicitly so the production minOut floor is never silently ignored.
//
// CLI: --chain all|1|8453   --max-rows N   --limit-ms N   --out <path> --md-out <path>

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const { spawn, spawnSync } = require("node:child_process");
const { Interface, AbiCoder, getAddress } = require(path.join(__dirname, "node_modules", "ethers"));
const economics = require("./frax-usdc-cross-venue-economics");
const valuation = require("./morpho-unwind-valuation");

const ROOT = path.resolve(__dirname, "..");
const INVENTORY = path.join(ROOT, "rpc_endpoints.txt");
const ANVIL = "C:\\Users\\MiPC\\.foundry\\bin\\anvil.exe";
const EXEC_ARTIFACT = path.join(
  ROOT, "contracts", "flash-liquidate-morpho-blue", "out", "FlashLiquidateMorphoBlue.sol", "FlashLiquidateMorphoBlue.json",
);

const MORPHO = getAddress("0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb");
const VAULT = getAddress("0xBA12222222228d8Ba445958a75a0704d566BF2C8");
const USDC = { 1: getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"), 8453: getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913") };
const DEPLOYED_EXECUTOR = getAddress("0xaf5b033e23ac555c09096bf39979a855e09907ba");
const DEPLOYED_OWNER = getAddress("0x24e46e91dfaad1fa3d49c48aa85ca9306885ce0a");
const SWAP_ROUTER_LEGACY = getAddress("0xE592427A0AEce92De3Edee1F18E0157C05861564");
const LOCAL_DEPLOY_OWNER = getAddress("0x00000000000000000000000000000000DeaDBeef");

const WAD = 10n ** 18n;
const ORACLE_PRICE_SCALE = 10n ** 36n;
const LIQUIDATION_CURSOR = 300000000000000000n;
const MAX_LIF = 1150000000000000000n;
const VIRTUAL_SHARES = 10n ** 6n;
const VIRTUAL_ASSETS = 1n;

const OWNER_FUND_WEI = 10n * 10n ** 18n;
const EXEC_GAS = 8_000_000;
const DEPLOY_GAS = 4_000_000;
const FORK_GAS_PRICE_WEI = 2_000_000_000n;
const MAX_PIN_BACKOFF = 3;

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}
const LIMIT_MS = Number(argValue("--limit-ms", "1800000"));
const MAX_ROWS = Number(argValue("--max-rows", "0"));
const OUT = argValue("--out", path.join(ROOT, "reports", "raw", "fast", "morpho-qualified-fork-probe-r1.json"));
const MD_OUT = argValue("--md-out", path.join(ROOT, "reports", "morpho-qualified-fork-probe-r1.md"));

const VERDICT = Object.freeze({
  NEGATIVE: "ROUTE_NEGATIVE_MEASURED",
  POSITIVE: "ROUTE_POSITIVE_FORK_MEASURED",
  PROOF: "GROSS_POSITIVE_NET_PROOF_REQUIRED",
  INSUFFICIENT: "INSUFFICIENT_EVIDENCE",
});

const CHAIN_CFG = Object.freeze({
  1: Object.freeze({
    chainId: 1, label: "ethereum", chainHex: "0x1",
    artifact: path.join(ROOT, "reports", "raw", "fast", "morpho-blue-liquidatable.json"),
    executor: DEPLOYED_EXECUTOR, executorMode: "DEPLOYED_IMPERSONATED_OWNER",
    owner: DEPLOYED_OWNER, router: SWAP_ROUTER_LEGACY, usdc: USDC[1],
  }),
  8453: Object.freeze({
    chainId: 8453, label: "base", chainHex: "0x2105",
    artifact: path.join(ROOT, "reports", "raw", "fast", "morpho-blue-liquidatable-base.json"),
    executor: null, executorMode: "FORK_LOCAL_DEPLOY_SAME_BUILD",
    owner: LOCAL_DEPLOY_OWNER, router: SWAP_ROUTER_LEGACY, usdc: USDC[8453],
  }),
});

const IFACE = Object.freeze({
  exec: new Interface([
    "function owner() view returns (address)",
    "function MORPHO() view returns (address)",
    "function execute((address,address,address,address,uint256) marketParams,address borrower,uint256 seizedAssets,uint256 repaidShares,uint256 minProfitWei,uint256 minOut,address router,bytes routerSwapData)",
  ]),
  morpho: new Interface([
    "function position(bytes32,address) view returns (uint256,uint128,uint128)",
    "function market(bytes32) view returns (uint128,uint128,uint128,uint128,uint128,uint128)",
    "function accrueInterest((address,address,address,address,uint256))",
  ]),
  oracle: new Interface(["function price() view returns (uint256)"]),
  erc20: new Interface(["function balanceOf(address) view returns (uint256)"]),
  quoter: new Interface(["function quoteExactInput(bytes,uint256) returns (uint256,uint160[],uint32[],uint256)"]),
  execEvents: new Interface([
    "event LiquidationExecuted((address,address,address,address,uint256) marketParams,address borrower,uint256 seizedAssets,uint256 repaidShares,uint256 repaidAssets,uint256 collateralBalanceAfterSwap,uint256 netProfitWei)",
  ]),
  morphoEvents: new Interface([
    "event Liquidate(bytes32 indexed id,address indexed caller,address indexed borrower,uint256 repaidAssets,uint256 repaidShares,uint256 seizedAssets,uint256 badDebtAssets,uint256 badDebtShares)",
  ]),
  balancerEvents: new Interface([
    "event FlashLoan(address indexed recipient,address indexed token,uint256 amount,uint256 feeAmount)",
  ]),
});

const fail = (code) => { throw new Error(code); };
const lc = (s) => String(s || "").toLowerCase();
const quantity = (value) => "0x" + BigInt(value).toString(16);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deadline = Date.now() + LIMIT_MS;
let anvil = null;
let relay = null;
let requestId = 0;
let aborted = false;

function budget(maxMs = 8500) {
  if (aborted || Date.now() >= deadline) fail("DEADLINE_EXCEEDED");
  return Math.max(1, Math.min(maxMs, deadline - Date.now()));
}

async function request(url, method, params, upstream = false) {
  let response;
  const bodyJson = JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    response = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" }, body: bodyJson,
      signal: AbortSignal.timeout(budget(upstream ? 8500 : 30000)),
    });
    if (response.status !== 429 || attempt === 2) break;
    await response.arrayBuffer();
    await delay(400 * (attempt + 1));
  }
  if (!response.ok || Number(response.headers.get("content-length") || 0) > 8 * 1024 * 1024) fail(upstream ? "UPSTREAM_UNAVAILABLE" : "LOCAL_RPC_UNAVAILABLE");
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > 16 * 1024 * 1024) fail("RPC_RESPONSE_TOO_LARGE");
  const body = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (body && body.error) {
    const error = new Error(upstream ? "UPSTREAM_RPC_ERROR" : "LOCAL_RPC_ERROR");
    error.reverted = /execution reverted|\brevert\b|VM Exception/i.test(String(body.error.message || ""));
    error.detail = String(body.error.message || "").slice(0, 200);
    const data = typeof body.error.data === "string" ? body.error.data : body.error.data && body.error.data.data;
    if (typeof data === "string" && /^0x[0-9a-f]+$/i.test(data)) error.revertData = data.toLowerCase();
    throw error;
  }
  if (!body || Array.isArray(body) || body.result === undefined) fail(upstream ? "UPSTREAM_RPC_ERROR" : "LOCAL_RPC_ERROR");
  return body.result;
}

// --- endpoint inventory (never printed) --------------------------------------------------
function inventoryUrls(chainId) {
  if (!fs.existsSync(INVENTORY)) return [];
  const want = chainId === 1 ? /mainnet|ethereum|\beth\b/i : /base|8453/i;
  const urls = [];
  for (const line of fs.readFileSync(INVENTORY, "utf8").split(/\r?\n/)) {
    const match = line.match(/https?:\/\/[^\s'"<>\[\]]+/i);
    if (!match || !want.test(line)) continue;
    let parsed;
    try { parsed = new URL(match[0].replace(/[)\],;]+$/, "")); } catch (_) { continue; }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) continue;
    if (/\.md($|\?)/i.test(parsed.pathname)) continue;
    if (/\b(?:x-api-key|bearer)\b/i.test(line)) continue;
    urls.push(parsed.href);
  }
  return [...new Set(urls)].slice(0, 16);
}

function upstreamPool(chainId) {
  const eth = ["https://eth.blockscout.com/api/eth-rpc", "https://eth.drpc.org", "https://gateway.tenderly.co/public/mainnet", "https://rpc.mevblocker.io"];
  const base = ["https://base.llamarpc.com", "https://mainnet.base.org", "https://base.drpc.org", "https://base.blockpi.network/v1/rpc/public", "https://1rpc.io/base", "https://base.gateway.tenderly.co", "https://base-mainnet.public.blastapi.io"];
  const primary = chainId === 1 ? eth : base;
  return [...primary.map((url) => ({ url, backingClass: "PUBLIC_KEYLESS" })), ...inventoryUrls(chainId).map((url) => ({ url, backingClass: "PUBLIC_KEYLESS_INVENTORY" }))];
}

async function* qualifiedUpstreams(cfg, pin, pinHash, needExecutorCode) {
  const seen = new Set();
  for (const candidate of upstreamPool(cfg.chainId)) {
    const { url } = candidate;
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      if (await request(url, "eth_chainId", [], true) !== cfg.chainHex) continue;
      const block = await request(url, "eth_getBlockByNumber", [quantity(pin), false], true);
      if (!block || Number(BigInt(block.number)) !== pin) continue;
      if (pinHash && lc(block.hash) !== lc(pinHash)) continue;
      const code = await request(url, "eth_getCode", [MORPHO, quantity(pin)], true);
      if (typeof code !== "string" || code.length <= 2) continue;
      if (needExecutorCode) {
        const ec = await request(url, "eth_getCode", [cfg.executor, quantity(pin)], true);
        if (typeof ec !== "string" || ec.length <= 2) continue;
      }
      yield { ...candidate, pin, blockHash: block.hash };
    } catch (_) { /* candidate failed qualification; never expose its error */ }
  }
}

// --- anvil + loopback relay --------------------------------------------------------------
function stopAnvil() {
  if (!anvil) return true;
  const child = anvil;
  anvil = null;
  if (child.exitCode !== null || !child.pid) return true;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 4000 });
  else { try { child.kill("SIGKILL"); } catch (_) {} }
  try { process.kill(child.pid, 0); return false; } catch (_) { return true; }
}

async function startRelay(upstream) {
  relay = http.createServer(async (req, res) => {
    try {
      if (req.method !== "POST" || req.socket.remoteAddress !== "127.0.0.1") fail("RELAY_INVALID_REQUEST");
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) fail("RELAY_REQUEST_TOO_LARGE"); chunks.push(chunk); }
      const query = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!query || typeof query.method !== "string" || !/^eth_|^net_|^web3_/.test(query.method)) fail("RELAY_INVALID_METHOD");
      let remote;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        remote = await fetch(upstream, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(query), signal: AbortSignal.timeout(budget(25000)) });
        if (remote.status !== 429 || attempt === 2) break;
        await remote.arrayBuffer();
        await delay(400 * (attempt + 1));
      }
      const bytes = await remote.arrayBuffer();
      if (!remote.ok || bytes.byteLength > 16 * 1024 * 1024) fail("RELAY_UPSTREAM_FAILURE");
      res.writeHead(200, { "content-type": "application/json" }); res.end(Buffer.from(bytes));
    } catch (_) {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "RELAY_UPSTREAM_FAILURE" } }));
    }
  });
  await new Promise((resolve, reject) => { relay.once("error", reject); relay.listen(0, "127.0.0.1", resolve); });
  return `http://127.0.0.1:${relay.address().port}`;
}

async function startAnvil(cfg, relayUrl, pin) {
  if (!stopAnvil()) fail("ANVIL_CLEANUP_FAILED");
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  anvil = spawn(ANVIL, ["--host", "127.0.0.1", "--port", String(port), "--fork-url", relayUrl,
    "--fork-block-number", String(pin), "--no-rate-limit", "--block-base-fee-per-gas", "1000000000"],
  { stdio: ["ignore", "ignore", "pipe"], windowsHide: true, shell: false });
  let bootDiagnostic = "";
  anvil.stderr.on("data", (chunk) => { bootDiagnostic = (bootDiagnostic + chunk.toString("utf8")).slice(-16384); });
  const bootError = () => {
    if (/429|too many requests|rate.limit/i.test(bootDiagnostic)) return "FORK_BACKING_RATE_LIMITED";
    if (/method not found/i.test(bootDiagnostic)) return "FORK_BACKING_METHOD_MISSING";
    if (/missing trie node|historical state/i.test(bootDiagnostic)) return "FORK_BACKING_STATE_MISSING";
    if (/failed to get|failed to fetch|cannot fork|unsupported/i.test(bootDiagnostic)) return "FORK_BACKING_UNSUPPORTED";
    if (/unexpected argument|unrecognized option|invalid value/i.test(bootDiagnostic)) return "ANVIL_ARGUMENTS_INVALID";
    return "ANVIL_START_FAILED";
  };
  anvil.on("error", () => { /* observed by readiness loop */ });
  const local = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    budget();
    if (anvil.exitCode !== null) fail(bootError());
    try {
      if (await request(local, "eth_chainId", []) === cfg.chainHex && Number(BigInt(await request(local, "eth_blockNumber", []))) === pin) return local;
    } catch (_) { /* boot in progress */ }
    await delay(120);
  }
  fail(bootError());
}

// --- fork-local helpers -------------------------------------------------------------------
async function readCall(local, to, iface, fn, args, from) {
  const data = iface.encodeFunctionData(fn, args);
  const req = { to, data };
  if (from) req.from = from;
  return iface.decodeFunctionResult(fn, await request(local, "eth_call", [req, "latest"]));
}

async function sendTx(local, tx) {
  const hash = await request(local, "eth_sendTransaction", [tx]);
  let receipt = null;
  for (let n = 0; n < 40 && !receipt; n += 1) { receipt = await request(local, "eth_getTransactionReceipt", [hash]); if (!receipt) await delay(100); }
  return { hash, receipt };
}

function decodeRevert(error) {
  if (!error || error.reverted !== true) return "local-error";
  const data = error.revertData;
  if (!data) return error.detail ? error.detail.replace(/^execution reverted:?\s*/i, "") : "reverted";
  try {
    if (data.startsWith("0x08c379a0")) {
      const [msg] = AbiCoder.defaultAbiCoder().decode(["string"], "0x" + data.slice(10));
      return String(msg);
    }
    if (data.startsWith("0x4e487b71")) {
      const [code] = AbiCoder.defaultAbiCoder().decode(["uint256"], "0x" + data.slice(10));
      return "Panic(0x" + code.toString(16) + ")";
    }
  } catch (_) { /* fall through */ }
  return data.slice(0, 10);
}

function decodeLogs(receipt, execAddress, marketId) {
  const out = { swapOut: null, repaidAssets: null, netProfitWei: null, balancerFee: null, morphoRepaid: null, morphoSeized: null };
  for (const log of receipt.logs || []) {
    const addr = lc(log.address);
    try {
      if (execAddress && addr === lc(execAddress) && lc(log.topics[0]) === lc(IFACE.execEvents.getEvent("LiquidationExecuted").topicHash)) {
        const p = IFACE.execEvents.parseLog(log);
        out.swapOut = p.args.collateralBalanceAfterSwap.toString();
        out.repaidAssets = p.args.repaidAssets.toString();
        out.netProfitWei = p.args.netProfitWei.toString();
      }
      if (addr === lc(MORPHO) && lc(log.topics[0]) === lc(IFACE.morphoEvents.getEvent("Liquidate").topicHash)) {
        if (!marketId || lc(log.topics[1]) === lc(marketId)) {
          const p = IFACE.morphoEvents.parseLog(log);
          out.morphoRepaid = p.args.repaidAssets.toString();
          out.morphoSeized = p.args.seizedAssets.toString();
        }
      }
      if (addr === lc(VAULT) && lc(log.topics[0]) === lc(IFACE.balancerEvents.getEvent("FlashLoan").topicHash)) {
        const p = IFACE.balancerEvents.parseLog(log);
        out.balancerFee = p.args.feeAmount.toString();
      }
    } catch (_) { /* unrelated log */ }
  }
  return out;
}

// Packed Uniswap V3 path (token20 | fee3 | token20 | ...). Mirrors the path the
// arbiter in morpho-unwind-valuation.encodeSwapData builds, but yields the raw
// `path` bytes the deployed executor forwards to its pinned SwapRouter.
function packedPath(hops, fees) {
  if (!Array.isArray(hops) || !Array.isArray(fees) || hops.length !== fees.length + 1 || hops.length < 2) return null;
  let out = "";
  for (let i = 0; i < hops.length; i += 1) {
    out += lc(hops[i]).slice(2);
    if (i < fees.length) out += Number(fees[i]).toString(16).padStart(6, "0");
  }
  return "0x" + out;
}

// Morpho math (mirrors Morpho.sol / SharesMathLib.sol, as the fork rehearsal does).
function liquidationIncentiveFactor(lltv) {
  const lif = (WAD * WAD) / (WAD - (LIQUIDATION_CURSOR * (WAD - lltv)) / WAD);
  return lif > MAX_LIF ? MAX_LIF : lif;
}
function toAssetsUp(shares, totalAssets, totalShares) {
  const p = shares * (totalAssets + VIRTUAL_ASSETS);
  if (p === 0n) return 0n;
  return (p - 1n) / (totalShares + VIRTUAL_SHARES) + 1n;
}
function toAssetsDown(shares, totalAssets, totalShares) {
  return (shares * (totalAssets + VIRTUAL_ASSETS)) / (totalShares + VIRTUAL_SHARES);
}
function seizedForShares(shares, totalBorrowAssets, totalBorrowShares, lif, price) {
  const assets = toAssetsDown(shares, totalBorrowAssets, totalBorrowShares);
  const quoted = (assets * lif) / WAD;
  return (quoted * ORACLE_PRICE_SCALE) / price;
}

function ceilScale(gas, baseFeeRaw, ethUsdRaw, priorityFee) {
  const gasWei = BigInt(gas) * economics.effectiveGasPriceWei(BigInt(baseFeeRaw), priorityFee);
  return economics.ceilDiv(gasWei * BigInt(ethUsdRaw) * 1_000_000n, 10n ** 18n * 100_000_000n);
}

// --- row measurement ----------------------------------------------------------------------
async function probeRow(local, cfg, ctx, row, mi) {
  const out = {
    chainId: cfg.chainId,
    eventKey: row.eventKey,
    marketId: row.marketId,
    borrower: row.borrower,
    collateralToken: row.collateralToken,
    loanToken: row.loanToken,
    unwindRoute: row.unwindRoute,
    swapHops: row.swapHops,
    swapFees: row.swapFees,
    scanSwapTarget: row.swapTarget,
    scannerNetUsdcRaw: row.netUsdcRaw,
    scannerGasCeilingUsdcRaw: row.gasCeilingUsdcRaw,
    scannerProbeStatus: row.probeStatus,
    scannerQuoteExecutable: row.quoteExecutable,
    haircutBps: row.haircutBps,
    seizedCollateralRaw: row.seizedCollateralRaw,
    repaidDebtRaw: row.repaidDebtRaw,
    minLoanOutRaw: row.minLoanOutRaw,
    loanIsUsdc: lc(row.loanToken) === lc(cfg.usdc),
    livePosition: null,
    repaidSharesUsedRaw: null,
    seizedEstimateRaw: null,
    measuredMinOutQuoteRaw: null,
    enforcedMinOutRaw: null,
    minOutFloorUsable: true,
    productionFloorMet: null,
    runnerShape: null,
    runnerShapeRevert: null,
    measurementFloorBypass: false,
    measuredGasUsedRaw: null,
    measuredGasUsedEstimatedRaw: null,
    measuredSwapOutLoanRaw: null,
    measuredRepaidLoanRaw: null,
    measuredBalancerFeeLoanRaw: null,
    measuredNetLoanRaw: null,
    measuredNetAfterHaircutLoanRaw: null,
    measuredNetUsdcRaw: null,
    measuredGasCostUsdcAtPinRaw: null,
    measuredNetUsdcAfterGasAtPinRaw: null,
    measuredNetUsdcAfterCeilingGasRaw: null,
    measuredGasUsdcAtPin: undefined,
    measuredGasUsdcCeiling: undefined,
    convertedUsdc: undefined,
    usdcConversion: null,
    staticCall: null,
    revertReason: null,
    revertSelector: null,
    executed: false,
    accountingConsistent: null,
    verdict: null,
    routePositive: false,
    executableNow: false,
    signedActionJustified: false,
    note: null,
  };

  const seized = BigInt(row.seizedCollateralRaw);
  const debt = BigInt(row.repaidDebtRaw);
  const minLoanOut = BigInt(row.minLoanOutRaw || row.repaidDebtRaw);
  const minOutFloor = (minLoanOut * 98n) / 100n;
  out.enforcedMinOutRaw = minOutFloor.toString();

  const sp = packedPath(row.swapHops, row.swapFees);
  if (!sp) { out.verdict = VERDICT.INSUFFICIENT; out.note = "route path not reconstructible from scan hops/fees"; return out; }
  const marketParams = [row.loanToken, row.collateralToken, row.oracle, row.irm, BigInt(row.lltvRaw)];
  const execData = (seizedAssets, repaidShares, minProfit, minOut) => IFACE.exec.encodeFunctionData("execute", [
    marketParams, row.borrower, seizedAssets, repaidShares, minProfit, minOut, ctx.router, sp,
  ]);

  // Position + sizing at the pin (market/oracle cached after accrual).
  let borrowShares = 0n, collateral = 0n;
  try {
    const pos = await readCall(local, MORPHO, IFACE.morpho, "position", [row.marketId, row.borrower]);
    borrowShares = BigInt(pos[1]); collateral = BigInt(pos[2]);
  } catch (_) { /* unreadable */ }
  const lltv = BigInt(row.lltvRaw);
  const lif = liquidationIncentiveFactor(lltv);
  const price = mi.price;
  const borrowed = toAssetsUp(borrowShares, mi.tba, mi.tbs);
  const maxBorrow = price > 0n ? ((collateral * price) / ORACLE_PRICE_SCALE) * lltv / WAD : 0n;
  out.livePosition = {
    borrowSharesRaw: borrowShares.toString(), collateralRaw: collateral.toString(),
    totalBorrowAssetsRaw: mi.tba.toString(), totalBorrowSharesRaw: mi.tbs.toString(),
    oraclePriceRaw: price.toString(), lltvRaw: lltv.toString(), lifRaw: lif.toString(),
    borrowedRaw: borrowed.toString(), maxBorrowRaw: maxBorrow.toString(),
    liquidatable: maxBorrow < borrowed,
  };
  if (borrowShares === 0n || collateral === 0n) { out.verdict = VERDICT.NEGATIVE; out.note = "zero-debt or zero-collateral at pin"; return out; }
  if (maxBorrow >= borrowed) { out.verdict = VERDICT.NEGATIVE; out.note = "position healthy at pin (not liquidatable)"; return out; }

  // Sizing for the executor's repaid-shares branch (as the fork rehearsal proved).
  let repaidShares = borrowShares;
  const seizedFull = seizedForShares(borrowShares, mi.tba, mi.tbs, lif, price);
  if (seizedFull > collateral && seizedFull > 0n) repaidShares = (borrowShares * collateral * 95n) / (seizedFull * 100n);
  let seizedEstimate = seizedForShares(repaidShares, mi.tba, mi.tbs, lif, price);
  for (let guard = 0; seizedEstimate > collateral && repaidShares > 1n && guard < 40; guard += 1) {
    repaidShares = (repaidShares * 90n) / 100n;
    seizedEstimate = seizedForShares(repaidShares, mi.tba, mi.tbs, lif, price);
  }
  if (repaidShares === 0n) { out.verdict = VERDICT.NEGATIVE; out.note = "no repayable shares sized"; return out; }
  const seizedIn = seizedEstimate > collateral ? collateral : seizedEstimate;
  out.repaidSharesUsedRaw = repaidShares.toString();
  out.seizedEstimateRaw = seizedIn.toString();

  // 1) Measured same-pin route fill quote for the seized amount (loan-token output).
  let quotedLoan = null;
  try {
    const q = await readCall(local, valuation.venueFor(cfg.chainId).quoter, IFACE.quoter, "quoteExactInput", [sp, seizedIn]);
    quotedLoan = BigInt(q[0]);
    out.measuredMinOutQuoteRaw = quotedLoan.toString();
  } catch (_) { out.measuredMinOutQuoteRaw = null; }

  // 2) Production trigger-runner shape: seizedAssets=whole scan collateral, repaidShares=0.
  try {
    await request(local, "eth_call", [{ from: ctx.owner, to: ctx.exec, data: execData(seized, 0n, 0n, minOutFloor) }, "latest"]);
    out.runnerShape = "success";
  } catch (error) {
    out.runnerShape = error.reverted ? "reverted" : "error";
    out.runnerShapeRevert = error.reverted ? decodeRevert(error) : "local-error";
  }

  // 3) Extraction staticCall at the production floor (repaid-shares branch).
  let staticOk = false;
  try {
    await request(local, "eth_call", [{ from: ctx.owner, to: ctx.exec, data: execData(0n, repaidShares, 0n, minOutFloor) }, "latest"]);
    out.staticCall = "success";
    staticOk = true;
  } catch (error) {
    if (error.reverted !== true) throw error;
    out.staticCall = "reverted";
    out.revertReason = decodeRevert(error);
    out.revertSelector = error.revertData ? error.revertData.slice(0, 10) : null;
  }

  // 3b) Floor-bypass staticCall: can the route settle at all (measurement floor = 1)?
  let bypassOk = false;
  if (!staticOk && minOutFloor > 1n) {
    try {
      await request(local, "eth_call", [{ from: ctx.owner, to: ctx.exec, data: execData(0n, repaidShares, 0n, 1n) }, "latest"]);
      bypassOk = true;
      out.measurementFloorBypass = true;
    } catch (_) { /* still not executable */ }
  }

  // 4) estimateGas for the route.
  const gasProbeData = execData(0n, repaidShares, 0n, staticOk ? minOutFloor : 1n);
  try { out.measuredGasUsedEstimatedRaw = BigInt(await request(local, "eth_estimateGas", [{ from: ctx.owner, to: ctx.exec, data: gasProbeData }])).toString(); } catch (_) { out.measuredGasUsedEstimatedRaw = null; }

  // 5) Full impersonated local execution under snapshot -> real fork fills.
  const executable = staticOk || bypassOk;
  if (executable) {
    const minOutUsed = staticOk ? minOutFloor : 1n;
    const snapshot = await request(local, "evm_snapshot", []);
    const before = BigInt((await readCall(local, row.loanToken, IFACE.erc20, "balanceOf", [ctx.owner]))[0]);
    let exec = null, execError = null;
    try {
      exec = await sendTx(local, { from: ctx.owner, to: ctx.exec, data: execData(0n, repaidShares, 0n, minOutUsed), gas: quantity(EXEC_GAS), gasPrice: quantity(FORK_GAS_PRICE_WEI) });
    } catch (error) { execError = error; }
    let after = before, decoded = null;
    if (exec && exec.receipt && exec.receipt.status === "0x1") {
      after = BigInt((await readCall(local, row.loanToken, IFACE.erc20, "balanceOf", [ctx.owner]))[0]);
      decoded = decodeLogs(exec.receipt, ctx.exec, row.marketId);
      out.measuredGasUsedRaw = BigInt(exec.receipt.gasUsed).toString();
      out.executed = true;
    } else if (exec && exec.receipt) {
      out.revertReason = "receipt-status-nonzero";
    } else if (execError) {
      out.revertReason = decodeRevert(execError);
    } else {
      out.revertReason = "no-receipt";
    }
    if (!await request(local, "evm_revert", [snapshot])) fail("SNAPSHOT_REVERT_FAILED");

    if (out.executed && decoded) {
      const swapOut = decoded.swapOut !== null ? BigInt(decoded.swapOut) : (quotedLoan !== null ? quotedLoan : null);
      const repaid = BigInt(decoded.repaidAssets !== null ? decoded.repaidAssets : decoded.morphoRepaid !== null ? decoded.morphoRepaid : seizedIn.toString());
      const fee = decoded.balancerFee !== null ? BigInt(decoded.balancerFee) : 0n;
      const ownerDelta = after - before;
      const netLoan = swapOut - repaid - fee;
      const hc = valuation.haircutRaw(swapOut, BigInt(row.haircutBps || 0));
      const adjOut = swapOut > hc ? swapOut - hc : 0n;
      out.measuredSwapOutLoanRaw = swapOut.toString();
      out.measuredRepaidLoanRaw = repaid.toString();
      out.measuredBalancerFeeLoanRaw = fee.toString();
      out.measuredNetLoanRaw = netLoan.toString();
      out.measuredNetAfterHaircutLoanRaw = (adjOut - repaid - fee).toString();
      out.productionFloorMet = out.measuredSwapOutLoanRaw !== null ? BigInt(out.measuredSwapOutLoanRaw) >= minOutFloor : null;
      out.accountingConsistent = netLoan === ownerDelta || (decoded.netProfitWei !== null && BigInt(decoded.netProfitWei) === ownerDelta);
      if (out.measurementFloorBypass) out.note = `measured with minOut=1 (production floor ${minOutFloor} not met by the route)`;
    } else if (quotedLoan !== null) {
      recordQuoteOnly(out, quotedLoan, debt, row.haircutBps);
      out.note = `fill not executed (${out.revertReason}); gross measured from quote`;
    } else {
      out.note = "no measured fill and no exact quote";
    }
  } else if (quotedLoan !== null) {
    recordQuoteOnly(out, quotedLoan, debt, row.haircutBps);
    out.note = `route not executable at pin (staticCall ${out.revertReason}); gross measured from quote`;
  } else {
    out.note = `staticCall reverted (${out.revertReason}); no exact quote`;
  }

  out.executableNow = staticOk;
  return out;
}

function recordQuoteOnly(out, quotedLoan, debt, haircutBps) {
  const hc = valuation.haircutRaw(quotedLoan, BigInt(haircutBps || 0));
  const adjOut = quotedLoan > hc ? quotedLoan - hc : 0n;
  const gross = adjOut - debt;
  out.measuredSwapOutLoanRaw = quotedLoan.toString();
  out.measuredRepaidLoanRaw = debt.toString();
  out.measuredBalancerFeeLoanRaw = "0";
  out.measuredNetLoanRaw = (quotedLoan - debt).toString();
  out.measuredNetAfterHaircutLoanRaw = gross.toString();
}

function finalizeVerdict(out) {
  if (out.verdict !== null && out.verdict !== undefined) return; // already decided (healthy/etc.)
  const grossRaw = out.measuredNetAfterHaircutLoanRaw;
  if (grossRaw === null || grossRaw === undefined) {
    if (out.staticCall === "reverted" && /healthy/i.test(out.revertReason || "")) out.verdict = VERDICT.NEGATIVE;
    else if (out.measuredMinOutQuoteRaw !== null) out.verdict = VERDICT.PROOF;
    else out.verdict = VERDICT.INSUFFICIENT;
  } else {
    const grossLoan = BigInt(grossRaw);
    let grossUsdc;
    if (out.loanIsUsdc) { grossUsdc = grossLoan; out.usdcConversion = out.usdcConversion || "identity(loan=USDC)"; }
    else if (grossLoan > 0n) {
      grossUsdc = out.convertedUsdc === undefined ? null : out.convertedUsdc;
      if (grossUsdc === null) out.usdcConversion = out.usdcConversion || "unavailable";
    } else { grossUsdc = grossLoan; out.usdcConversion = out.usdcConversion || "not-applied(gross<=0)"; }
    out.measuredNetUsdcRaw = grossUsdc === null ? null : grossUsdc.toString();
    if (grossUsdc === null) {
      out.verdict = VERDICT.PROOF;
      out.note = out.note || "gross positive; USDC conversion unavailable";
    } else {
      const gPin = out.measuredGasUsdcAtPin === undefined ? null : out.measuredGasUsdcAtPin;
      const gCeil = out.measuredGasUsdcCeiling === undefined ? null : out.measuredGasUsdcCeiling;
      const netPin = gPin === null ? null : grossUsdc - gPin;
      const netCeil = gCeil === null ? null : grossUsdc - gCeil;
      out.measuredGasCostUsdcAtPinRaw = gPin === null ? null : gPin.toString();
      out.measuredNetUsdcAfterGasAtPinRaw = netPin === null ? null : netPin.toString();
      out.measuredNetUsdcAfterCeilingGasRaw = netCeil === null ? null : netCeil.toString();
      if (netPin !== null && netPin > 0n) out.verdict = VERDICT.POSITIVE;
      else if (out.executed !== true && grossUsdc > 0n) out.verdict = VERDICT.PROOF;
      else out.verdict = VERDICT.NEGATIVE;
    }
  }
  out.routePositive = out.verdict === VERDICT.POSITIVE;
}

// --- chain run ----------------------------------------------------------------------------
async function runChain(cfg) {
  const section = {
    chainId: cfg.chainId, label: cfg.label, artifact: path.relative(ROOT, cfg.artifact).split(path.sep).join("/"),
    scannerPin: null, scannerPinHash: null, forkPin: null, forkPinHash: null, pinMatchesScanner: false,
    pinBaseFeeRaw: null, ethUsdRaw: null, executor: cfg.executor, executorMode: cfg.executorMode,
    owner: cfg.owner, router: cfg.router, upstreamClass: null, accruedMarkets: 0,
    qualifiedRows: 0, probedRows: 0, verdictCounts: {}, state: "PENDING", reason: null, rows: [],
  };
  if (!fs.existsSync(cfg.artifact)) { section.state = "FAIL"; section.reason = "SCAN_ARTIFACT_MISSING"; return section; }
  let artifact;
  try { artifact = JSON.parse(fs.readFileSync(cfg.artifact, "utf8")); } catch (_) { section.state = "FAIL"; section.reason = "SCAN_ARTIFACT_INVALID"; return section; }
  section.scannerPin = artifact.pin && artifact.pin.number;
  section.scannerPinHash = artifact.pin && artifact.pin.hash;
  section.pinBaseFeeRaw = artifact.pin && artifact.pin.baseFeePerGasRaw;
  section.ethUsdRaw = artifact.valuation && artifact.valuation.ethUsdRaw;
  const ethUsdRaw = BigInt((artifact.valuation && artifact.valuation.ethUsdRaw) || "0");
  const priority = economics.PRIORITY_FEE_WEI;
  const ceilingGas = BigInt(artifact.valuation.gasCeilingUsdcRaw);

  const qualified = (artifact.rows || []).filter((r) => r.valuationStatus === "QUALIFIED_VIEW" && r.unwindRoute);
  qualified.sort((a, b) => { const d = BigInt(b.netUsdcRaw) - BigInt(a.netUsdcRaw); return d > 0n ? 1 : d < 0n ? -1 : 0; });
  section.qualifiedRows = qualified.length;
  const rows = MAX_ROWS > 0 ? qualified.slice(0, MAX_ROWS) : qualified;

  const loanUsdcFee = new Map();
  for (const rt of artifact.valuation.routes || []) if (rt.loanUsdc) loanUsdcFee.set(lc(rt.loanToken), Number(rt.loanUsdc.fee));

  let pin = Number(artifact.pin.number);
  const scannerPin = pin;
  const pinHash = artifact.pin.hash;
  const needExecCode = cfg.executorMode === "DEPLOYED_IMPERSONATED_OWNER";

  let relayUrl = null, local = null, qualifiedBacking = null;
  for (let backoff = 0; backoff <= MAX_PIN_BACKOFF && !qualifiedBacking; backoff += 1) {
    const tryPin = pin - backoff;
    for await (const backing of qualifiedUpstreams(cfg, tryPin, backoff === 0 ? pinHash : null, needExecCode)) {
      try {
        relayUrl = await startRelay(backing.url);
        local = await startAnvil(cfg, relayUrl, tryPin);
        qualifiedBacking = backing;
        pin = tryPin;
        break;
      } catch (error) {
        if (!stopAnvil()) fail("ANVIL_CLEANUP_FAILED");
        if (relay) { relay.closeAllConnections(); relay.close(); relay = null; }
        relayUrl = null;
        if (error && (error.message === "DEADLINE_EXCEEDED" || error.message === "ANVIL_CLEANUP_FAILED")) throw error;
      }
    }
  }
  if (!relayUrl || !qualifiedBacking) { section.state = "FAIL"; section.reason = "NO_ARCHIVE_BACKING"; return section; }

  try {
    section.forkPin = pin;
    section.forkPinHash = qualifiedBacking.blockHash;
    section.pinMatchesScanner = pin === scannerPin;
    section.upstreamClass = qualifiedBacking.backingClass;
    section.state = "RUNNING";

    if ((await request(local, "eth_getCode", [MORPHO, "latest"])) === "0x") throw new Error("MORPHO_CODE_MISSING");
    if ((await request(local, "eth_getCode", [cfg.router, "latest"])) === "0x") throw new Error("ROUTER_CODE_MISSING");

    const ctx = { exec: cfg.executor, owner: cfg.owner, router: cfg.router };
    if (cfg.executorMode === "FORK_LOCAL_DEPLOY_SAME_BUILD") {
      if (!fs.existsSync(EXEC_ARTIFACT)) throw new Error("EXEC_ARTIFACT_MISSING");
      const creation = JSON.parse(fs.readFileSync(EXEC_ARTIFACT, "utf8")).bytecode.object;
      await request(local, "anvil_setBalance", [cfg.owner, quantity(OWNER_FUND_WEI)]);
      await request(local, "anvil_impersonateAccount", [cfg.owner]);
      const deployData = creation + AbiCoder.defaultAbiCoder().encode(["address"], [MORPHO]).slice(2);
      const dep = await sendTx(local, { from: cfg.owner, data: deployData, gas: quantity(DEPLOY_GAS), gasPrice: quantity(FORK_GAS_PRICE_WEI) });
      if (!dep.receipt || dep.receipt.status !== "0x1" || !dep.receipt.contractAddress) throw new Error("DEPLOY_FAILED");
      ctx.exec = getAddress(dep.receipt.contractAddress);
    } else {
      if ((await request(local, "eth_getCode", [cfg.executor, "latest"])) === "0x") throw new Error("EXEC_CODE_MISSING");
      const onchainOwner = (await readCall(local, cfg.executor, IFACE.exec, "owner", []))[0];
      if (lc(onchainOwner) !== lc(DEPLOYED_OWNER)) throw new Error("EXEC_OWNER_MISMATCH");
      await request(local, "anvil_setBalance", [ctx.owner, quantity(OWNER_FUND_WEI)]);
      await request(local, "anvil_impersonateAccount", [ctx.owner]);
      if ((await request(local, "eth_getCode", [ctx.owner, "latest"])) !== "0x") throw new Error("OWNER_NOT_EOA");
    }
    section.executor = ctx.exec;

    // Accrue interest once per distinct market so on-chain sizing matches the pin.
    const byMarket = new Map();
    for (const row of rows) if (!byMarket.has(row.marketId)) byMarket.set(row.marketId, row);
    for (const row of byMarket.values()) {
      const mp = [row.loanToken, row.collateralToken, row.oracle, row.irm, BigInt(row.lltvRaw)];
      try {
        await sendTx(local, { from: ctx.owner, to: MORPHO, data: IFACE.morpho.encodeFunctionData("accrueInterest", [mp]), gas: quantity(1_000_000), gasPrice: quantity(FORK_GAS_PRICE_WEI) });
        section.accruedMarkets += 1;
      } catch (_) { /* leave to Morpho's internal accrual */ }
    }
    const marketInfo = new Map();
    for (const row of byMarket.values()) {
      try {
        const m = await readCall(local, MORPHO, IFACE.morpho, "market", [row.marketId]);
        const price = BigInt((await readCall(local, row.oracle, IFACE.oracle, "price", []))[0]);
        marketInfo.set(row.marketId, { tba: BigInt(m[2]), tbs: BigInt(m[3]), price });
      } catch (_) { marketInfo.set(row.marketId, { tba: 0n, tbs: 0n, price: 0n }); }
    }

    const counts = {};
    const baseFeeRaw = artifact.pin.baseFeePerGasRaw;
    for (const row of rows) {
      let probed;
      try {
        probed = await probeRow(local, cfg, ctx, row, marketInfo.get(row.marketId) || { tba: 0n, tbs: 0n, price: 0n });
      } catch (error) {
        if (error && (error.message === "DEADLINE_EXCEEDED" || error.message === "SNAPSHOT_REVERT_FAILED")) throw error;
        probed = { chainId: cfg.chainId, eventKey: row.eventKey, borrower: row.borrower, verdict: VERDICT.INSUFFICIENT, note: `probe-error:${String(error && error.message).slice(0, 60)}`, routePositive: false, executableNow: false, signedActionJustified: false, loanIsUsdc: lc(row.loanToken) === lc(cfg.usdc) };
      }

      const gasUsedRaw = probed.measuredGasUsedRaw || probed.measuredGasUsedEstimatedRaw;
      probed.measuredGasUsdcAtPin = gasUsedRaw ? ceilScale(BigInt(gasUsedRaw), baseFeeRaw, ethUsdRaw, priority) : null;
      probed.measuredGasUsdcCeiling = ceilingGas;

      if (probed.loanIsUsdc === false && probed.measuredNetAfterHaircutLoanRaw) {
        const netLoan = BigInt(probed.measuredNetAfterHaircutLoanRaw);
        if (netLoan > 0n) {
          const fee = loanUsdcFee.get(lc(probed.loanToken));
          if (fee === undefined) { probed.usdcConversion = "no-loanUsdc-route"; }
          else {
            try {
              const q = await readCall(local, valuation.venueFor(cfg.chainId).quoter, IFACE.quoter, "quoteExactInput", [packedPath([probed.loanToken, cfg.usdc], [fee]), netLoan]);
              probed.convertedUsdc = BigInt(q[0]);
              probed.usdcConversion = `quoter(loan->USDC fee=${fee})`;
            } catch (_) { probed.usdcConversion = "quoter-unavailable"; }
          }
        }
      }
      finalizeVerdict(probed);
      delete probed.measuredGasUsdcAtPin;
      delete probed.measuredGasUsdcCeiling;
      delete probed.convertedUsdc;
      counts[probed.verdict] = (counts[probed.verdict] || 0) + 1;
      section.rows.push(probed);
      section.probedRows += 1;
    }
    section.verdictCounts = counts;
    section.state = "PASS";
  } catch (error) {
    section.state = "FAIL";
    section.reason = error && error.message ? String(error.message).slice(0, 80) : "INTERNAL";
  } finally {
    stopAnvil();
    if (relay) { relay.closeAllConnections(); relay.close(); relay = null; }
    relay = null;
  }
  return section;
}

function buildArtifact(sections) {
  const allRows = sections.flatMap((s) => s.rows);
  const counts = {};
  for (const r of allRows) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  const positives = allRows.filter((r) => r.verdict === VERDICT.POSITIVE);
  const executable = allRows.filter((r) => r.executableNow === true);
  const executedRows = allRows.filter((r) => r.executed === true);
  const measuredGross = allRows.filter((r) => r.measuredNetUsdcRaw !== null).map((r) => BigInt(r.measuredNetUsdcRaw));
  const measuredGas = allRows.filter((r) => r.measuredGasCostUsdcAtPinRaw).map((r) => BigInt(r.measuredGasCostUsdcAtPinRaw));
  const maxGross = measuredGross.length ? measuredGross.reduce((m, x) => (x > m ? x : m)) : 0n;
  const minGas = measuredGas.length ? measuredGas.reduce((m, x) => (x < m ? x : m)) : 0n;
  const proven = allRows.length - (counts[VERDICT.INSUFFICIENT] || 0);
  const routePositive = positives.length > 0;
  const noFindingSentence = routePositive
    ? `No-Finding NOT established: the same-pin fork probe measured a positive net on at least one of ${allRows.length} qualified rows.`
    : `No-Finding: a keyless same-pin fork probe measured ${proven} of ${allRows.length} qualified Morpho Blue rows at the scanner's own pin (${executedRows.length} executed end-to-end; ${counts[VERDICT.INSUFFICIENT] || 0} unquotable -> INSUFFICIENT_EVIDENCE) and none produced a positive net after the route haircut, flash settlement and gas at the pin base fee: the largest measured gross output was ${maxGross.toString()} USDC-raw (6dp) against a smallest measured gas cost of ${minGas.toString()} USDC-raw. The conservative QUALIFIED_VIEW veto at the 2,000,000-gas ceiling is confirmed, not a hidden profit.`;
  return {
    schema: "morpho-qualified-fork-probe/v1",
    generatedAt: new Date().toISOString(),
    scanner: "tools/morpho-qualified-view-fork-probe.js",
    readonly: true,
    signedActions: false,
    transactions: false,
    endpointMaterialPersisted: false,
    sourceArtifacts: ["reports/raw/fast/morpho-blue-liquidatable.json", "reports/raw/fast/morpho-blue-liquidatable-base.json"],
    note: "Measured same-pin fork fills replace the scanner's conservative net assumption on QUALIFIED_VIEW rows. Keyless/local; deployed executor driven by an impersonated owner; nothing signed, no upstream transaction.",
    routePositive,
    executableNow: routePositive || executable.length > 0,
    signedActionJustified: false,
    noFinding: !routePositive,
    noFindingSentence,
    summary: {
      chains: sections.length,
      qualifiedRows: sections.reduce((n, s) => n + (s.qualifiedRows || 0), 0),
      probedRows: allRows.length,
      routePositiveRows: positives.length,
      executableRows: executable.length,
      executedRows: executedRows.length,
      insufficientRows: counts[VERDICT.INSUFFICIENT] || 0,
      maxMeasuredGrossUsdcRaw: maxGross.toString(),
      minMeasuredGasUsdcAtPinRaw: minGas.toString(),
      verdictCounts: counts,
      perChain: sections.map((s) => ({ chainId: s.chainId, label: s.label, state: s.state, qualifiedRows: s.qualifiedRows, probedRows: s.probedRows, verdictCounts: s.verdictCounts })),
    },
    chainSections: sections.map((s) => ({ ...s, rows: undefined })),
    rows: allRows,
  };
}

function renderMd(a) {
  const L = [];
  L.push("# Morpho qualified-view same-pin fork probe (r1)");
  L.push("");
  L.push(`Generated: ${a.generatedAt}`);
  L.push("");
  L.push(`**routePositive:** ${a.routePositive}  |  **executableNow:** ${a.executableNow}  |  **signedActionJustified:** ${a.signedActionJustified}`);
  L.push("");
  L.push(`**${a.noFindingSentence}**`);
  L.push("");
  L.push("## Summary");
  L.push("");
  L.push(`- chains: ${a.summary.chains}`);
  L.push(`- qualified rows seen: ${a.summary.qualifiedRows}`);
  L.push(`- rows probed: ${a.summary.probedRows}`);
  L.push(`- route-positive rows: ${a.summary.routePositiveRows}`);
  L.push(`- verdict counts: ${JSON.stringify(a.summary.verdictCounts)}`);
  L.push("");
  for (const s of a.chainSections) {
    L.push(`## Chain ${s.chainId} (${s.label}) - ${s.state}${s.reason ? ` (${s.reason})` : ""}`);
    L.push("");
    L.push(`- scanner pin: ${s.scannerPin} (${s.scannerPinHash})`);
    L.push(`- fork pin: ${s.forkPin} (${s.forkPinHash})`);
    L.push(`- executor: ${s.executor} [${s.executorMode}] owner ${s.owner} router ${s.router}`);
    L.push(`- accrued markets: ${s.accruedMarkets}`);
    L.push(`- qualified rows: ${s.qualifiedRows}, probed: ${s.probedRows}, verdicts: ${JSON.stringify(s.verdictCounts)}`);
    L.push("");
  }
  L.push("## Top measured rows (most promising first)");
  L.push("");
  L.push("| chain | borrower | route | scanner net USDC | measured net loan | gasUsed | minOut floor | verdict | note |");
  L.push("|---|---|---|---|---|---|---|---|---|");
  for (const r of a.rows.slice(0, 40)) {
    L.push(`| ${r.chainId} | ${String(r.borrower || "").slice(0, 10)} | ${r.unwindRoute} | ${r.scannerNetUsdcRaw} | ${r.measuredNetLoanRaw} | ${r.measuredGasUsedRaw || r.measuredGasUsedEstimatedRaw || ""} | ${r.enforcedMinOutRaw} | ${r.verdict} | ${String(r.note || "").slice(0, 50)} |`);
  }
  L.push("");
  L.push("_No finding is fabricated: reverted or unquotable rows record the decoded revert / INSUFFICIENT_EVIDENCE; nothing is signed; no upstream transaction is sent._");
  L.push("");
  return L.join("\n");
}

function writeOutputs(artifact) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n", "utf8");
  fs.mkdirSync(path.dirname(MD_OUT), { recursive: true });
  fs.writeFileSync(MD_OUT, renderMd(artifact), "utf8");
}

process.once("exit", stopAnvil);
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { aborted = true; stopAnvil(); process.exit(1); });

(async () => {
  try {
    const which = argValue("--chain", "all");
    const chainIds = which === "all" ? [1, 8453] : [Number(which)];
    const sections = [];
    for (const id of chainIds) {
      const cfg = CHAIN_CFG[id];
      if (cfg) sections.push(await runChain(cfg));
    }
    const artifact = buildArtifact(sections);
    writeOutputs(artifact);
    process.stdout.write(JSON.stringify({
      ok: true, out: path.relative(ROOT, OUT).split(path.sep).join("/"),
      routePositive: artifact.routePositive, probedRows: artifact.summary.probedRows,
      verdictCounts: artifact.summary.verdictCounts, perChain: artifact.summary.perChain,
    }, null, 2) + "\n");
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, reason: aborted ? "DEADLINE_EXCEEDED" : String(error && error.message || error).slice(0, 120) }) + "\n");
    process.exitCode = 1;
  } finally {
    stopAnvil();
    if (relay) { relay.closeAllConnections(); relay.close(); }
  }
})();
