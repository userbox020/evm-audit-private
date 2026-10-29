#!/usr/bin/env node
"use strict";

// morpho-blue-flash-liquidator-rehearsal.js
// Keyless, local-only fork rehearsal for the built Morpho Blue flash liquidator
// `FlashLiquidateMorphoBlue` (contracts/flash-liquidate-morpho-blue/).
//
// The executor has no mainnet deployment, so this harness deploys the LOCAL build
// artifact onto a fork-local copy of mainnet state pinned at the scanner pin
// (reports/raw/fast/morpho-blue-liquidatable.json), then drives the executor's
// full route -- Balancer flash -> Morpho.liquidate -> onMorphoLiquidate swap ->
// repay -> profit sweep -- against a real, currently-liquidatable Morpho Blue
// position. It probes a ranked candidate list on the single fork and keeps the
// first profitable route. No real-network write, no key access, no signing (fork
// txs are sent from an impersonated/funded EOA).
//
// Endpoint material (URL/host/path) is NEVER printed, persisted, or forwarded to
// children; anvil forks through an in-process loopback relay that owns the
// upstream, mirroring tools/aave-v3-flash-liquidator-rehearsal.js.

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const { spawn, spawnSync } = require("node:child_process");
const { Interface, AbiCoder } = require(path.join(__dirname, "node_modules", "ethers"));

const ROOT = path.resolve(__dirname, "..");
const OUTDIR = path.join(ROOT, "reports", "raw", "fast", "morpho-fork-rehearsal");
const OUTPUT = path.join(OUTDIR, "result.json");
const INVENTORY = path.join(ROOT, "rpc_endpoints.txt");
const SCAN_ARTIFACT = path.join(ROOT, "reports", "raw", "fast", "morpho-blue-liquidatable.json");
const EXEC_ARTIFACT = path.join(
  ROOT, "contracts", "flash-liquidate-morpho-blue", "out", "FlashLiquidateMorphoBlue.sol", "FlashLiquidateMorphoBlue.json",
);
const ANVIL = "C:\\Users\\MiPC\\.foundry\\bin\\anvil.exe";

const CHAIN_ID = 1;
const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const SWAP_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
const QUOTER = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const VAULT = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";
const HEALTHY_BORROWER = "0x000000000000000000000000000000000000dEaD";

const WAD = 10n ** 18n;
const ORACLE_PRICE_SCALE = 10n ** 36n;
const LIQUIDATION_CURSOR = 300000000000000000n; // 0.3e18
const MAX_LIF = 1150000000000000000n; // 1.15e18
const VIRTUAL_SHARES = 10n ** 6n;
const VIRTUAL_ASSETS = 1n;
const MIN_ROUTE_LIQUIDITY = 10n ** 15n;
const MAX_CANDIDATES = 12;

const LIMIT_MS = 240000;
const OWNER_FUND_WEI = 10n * 10n ** 18n;
const EXEC_GAS = 8_000_000;
const DEPLOY_GAS = 4_000_000;
const GAS_PRICE_WEI = 2_000_000_000n;
const MAX_PIN_BACKOFF = 3;

const fail = (code) => { throw new Error(code); };
const lc = (s) => String(s || "").toLowerCase();
const quantity = (value) => "0x" + BigInt(value).toString(16);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deadline = Date.now() + LIMIT_MS;
let anvil = null;
let relay = null;
let requestId = 0;
let aborted = false;
let stage = "SETUP";
let live = null;

const IFACE = {
  morpho: new Interface([
    "function position(bytes32,address) view returns (uint256,uint128,uint128)",
    "function market(bytes32) view returns (uint128,uint128,uint128,uint128,uint128,uint128)",
    "function liquidate((address,address,address,address,uint256),address,uint256,uint256,bytes) returns (uint256,uint256)",
    "function accrueInterest((address,address,address,address,uint256))",
  ]),
  oracle: new Interface(["function price() view returns (uint256)"]),
  exec: new Interface([
    "function owner() view returns (address)",
    "function MORPHO() view returns (address)",
    "function BALANCER_VAULT() view returns (address)",
    "function MORPHO_CALLBACK_TAG() view returns (bytes32)",
    "function marketId((address,address,address,address,uint256)) pure returns (bytes32)",
    "function execute((address,address,address,address,uint256),address,uint256,uint256,uint256,uint256,address,bytes)",
  ]),
  erc20: new Interface([
    "function balanceOf(address) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
  ]),
  quoter: new Interface(["function quoteExactInput(bytes,uint256) returns (uint256,uint160[],uint32[],uint256)"]),
  morphoEvents: new Interface([
    "event Liquidate(bytes32 indexed id, address indexed caller, address indexed borrower, uint256 repaidAssets, uint256 repaidShares, uint256 seizedAssets, uint256 badDebtAssets, uint256 badDebtShares)",
  ]),
  balancerEvents: new Interface([
    "event FlashLoan(address indexed recipient, address indexed token, uint256 amount, uint256 feeAmount)",
  ]),
};

const CODES = new Set([
  "ANVIL_MISSING", "ANVIL_CLEANUP_FAILED", "ANVIL_ARGUMENTS_INVALID", "ANVIL_START_FAILED",
  "FORK_BLOCK_MISMATCH", "FORK_BACKING_UNSUPPORTED", "FORK_BACKING_METHOD_MISSING", "FORK_BACKING_STATE_MISSING",
  "FORK_BACKING_BLOCK_FAILURE", "FORK_BACKING_CHAIN_ID_FAILURE", "FORK_BACKING_GAS_PRICE_FAILURE",
  "FORK_BACKING_TRANSACTION_FAILURE", "FORK_BACKING_PROOF_FAILURE", "FORK_BACKING_CODE_FAILURE",
  "FORK_BACKING_BALANCE_FAILURE", "FORK_BACKING_RATE_LIMITED",
  "INVENTORY_MISSING", "NO_ARCHIVE_BACKING", "DEADLINE_EXCEEDED",
  "SCAN_ARTIFACT_MISSING", "SCAN_ARTIFACT_INVALID", "NO_ROUTABLE_ROW", "EXEC_ARTIFACT_MISSING", "EXEC_ARTIFACT_INVALID",
  "MORPHO_CODE_MISSING", "TOKEN_CODE_MISSING", "ROUTER_CODE_MISSING", "ORACLE_CODE_MISSING", "MARKET_ID_MISMATCH",
  "NOT_LIQUIDATABLE_AT_PIN", "EXEC_IMMUTABLE_MISMATCH", "DEPLOY_FAILED", "ROUTE_UNPROFITABLE",
  "MEASURED_STATIC_REVERTED", "MEASURED_TX_REVERTED", "NEGATIVE_CONTROL_FAILED", "NO_MEASURED_CASE",
  "SNAPSHOT_REVERT_FAILED",
  "RPC_RESPONSE_TOO_LARGE", "UPSTREAM_UNAVAILABLE", "UPSTREAM_RPC_ERROR", "LOCAL_RPC_UNAVAILABLE", "LOCAL_RPC_ERROR",
]);

function budget(maxMs = 8500) {
  if (aborted || Date.now() >= deadline) fail("DEADLINE_EXCEEDED");
  return Math.max(1, Math.min(maxMs, deadline - Date.now()));
}

function parseInventory() {
  if (!fs.existsSync(INVENTORY)) fail("INVENTORY_MISSING");
  const rows = [];
  let family = null;
  for (const line of fs.readFileSync(INVENTORY, "utf8").split(/\r?\n/)) {
    const heading = line.match(/^\s*(?:#{1,6}\s+)?(?:-{3}\s+)?(?:provider|family|service)\s*[:=\-]\s*(.+?)\s*(?:-{3})?\s*$/i);
    if (heading) family = heading[1];
    const match = line.match(/https?:\/\/[^\s'"<>\[\]]+/i);
    if (!match) continue;
    let parsed;
    try { parsed = new URL(match[0].replace(/[)\],;]+$/, "")); } catch (_) { continue; }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) continue;
    if (parsed.pathname !== "/" && !/^\/(v3|api)?\/?$/.test(parsed.pathname)) continue;
    const metadata = line.replace(match[0], " ");
    if (/\b(?:origin|header|auth|bearer|x-api-key|key|token)\s*[:=]/i.test(metadata)) continue;
    if (!/\bmainnet\b|\bethereum\b|\beth\b/i.test(`${family || ""} ${line}`) && family == null) continue;
    rows.push(parsed.href);
  }
  return [...new Set(rows)].slice(0, 24);
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
  if (bytes.byteLength > 8 * 1024 * 1024) fail("RPC_RESPONSE_TOO_LARGE");
  const body = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (body?.error) {
    const error = new Error(upstream ? "UPSTREAM_RPC_ERROR" : "LOCAL_RPC_ERROR");
    error.reverted = /execution reverted|\brevert\b|VM Exception/i.test(String(body.error.message || ""));
    const data = typeof body.error.data === "string" ? body.error.data : body.error.data?.data;
    if (typeof data === "string" && /^0x[0-9a-f]+$/i.test(data)) error.revertData = data.toLowerCase();
    throw error;
  }
  if (!body || Array.isArray(body) || body.result === undefined) fail(upstream ? "UPSTREAM_RPC_ERROR" : "LOCAL_RPC_ERROR");
  return body.result;
}

// --- scan artifact ----------------------------------------------------------------------
function loadCandidates() {
  if (!fs.existsSync(SCAN_ARTIFACT)) fail("SCAN_ARTIFACT_MISSING");
  let artifact;
  try { artifact = JSON.parse(fs.readFileSync(SCAN_ARTIFACT, "utf8")); } catch (_) { fail("SCAN_ARTIFACT_INVALID"); }
  if (!artifact.rows || !artifact.pin || !artifact.valuation) fail("SCAN_ARTIFACT_INVALID");
  const directFor = new Map();
  for (const r of (artifact.valuation.routes || []).filter((r) => r.direct)) {
    directFor.set(lc(r.collateralToken) + "|" + lc(r.loanToken), r.direct);
  }

  // Keep one largest liquidatable position per direct Uniswap V3 collateral->loan route,
  // then rank routes by pool liquidity (deeper pools track the oracle more closely).
  const byRoute = new Map();
  for (const r of artifact.rows) {
    const route = directFor.get(lc(r.collateralToken) + "|" + lc(r.loanToken));
    if (!route) continue;
    if (BigInt(route.liquidity || 0) < MIN_ROUTE_LIQUIDITY) continue;
    const repaid = BigInt(r.repaidDebtRaw || 0);
    if (repaid < 10n ** 6n) continue;
    const collateral = BigInt(r.seizedCollateralRaw || 0);
    const price = BigInt(r.oraclePriceRaw || 0);
    const lltv = BigInt(r.lltvRaw || 0);
    if (price === 0n || collateral === 0n) continue;
    const maxBorrow = ((collateral * price) / ORACLE_PRICE_SCALE) * lltv / WAD;
    if (maxBorrow >= repaid) continue; // must be liquidatable at the pin
    const key = lc(r.collateralToken) + "|" + lc(r.loanToken);
    const cur = byRoute.get(key);
    if (!cur || repaid > BigInt(cur.row.repaidDebtRaw)) byRoute.set(key, { row: r, route });
  }
  // Rank by position size (largest liquidatable repaid debt first) so the positive control
  // uses a realistic liquidation; the probe loop skips routes whose pool price makes them
  // unprofitable and falls through to the next candidate.
  const candidates = [...byRoute.values()].sort((a, b) => (BigInt(b.row.repaidDebtRaw) > BigInt(a.row.repaidDebtRaw) ? 1 : -1));
  if (!candidates.length) fail("NO_ROUTABLE_ROW");
  return { artifact, candidates: candidates.slice(0, MAX_CANDIDATES) };
}

function loadExecutorArtifact() {
  if (!fs.existsSync(EXEC_ARTIFACT)) fail("EXEC_ARTIFACT_MISSING");
  let artifact;
  try { artifact = JSON.parse(fs.readFileSync(EXEC_ARTIFACT, "utf8")); } catch (_) { fail("EXEC_ARTIFACT_INVALID"); }
  const creation = artifact?.bytecode?.object;
  if (typeof creation !== "string" || !/^0x[0-9a-f]+$/i.test(creation) || creation.length <= 2) fail("EXEC_ARTIFACT_INVALID");
  return creation;
}

// --- morpho math (mirrors Morpho.sol / SharesMathLib.sol) --------------------------------
function liquidationIncentiveFactor(lltv) {
  const lif = (WAD * WAD) / (WAD - (LIQUIDATION_CURSOR * (WAD - lltv)) / WAD);
  return lif > MAX_LIF ? MAX_LIF : lif;
}
function toAssetsDown(shares, totalAssets, totalShares) {
  return (shares * (totalAssets + VIRTUAL_ASSETS)) / (totalShares + VIRTUAL_SHARES);
}
function toAssetsUp(shares, totalAssets, totalShares) {
  const p = shares * (totalAssets + VIRTUAL_ASSETS);
  if (p === 0n) return 0n;
  return (p - 1n) / (totalShares + VIRTUAL_SHARES) + 1n;
}
function seizedForShares(shares, totalBorrowAssets, totalBorrowShares, lif, price) {
  const assets = toAssetsDown(shares, totalBorrowAssets, totalBorrowShares);
  const quoted = (assets * lif) / WAD;
  return (quoted * ORACLE_PRICE_SCALE) / price;
}

// --- upstream qualification -------------------------------------------------------------
async function* qualifiedUpstreams(pin, pinHash) {
  const archive = ["https://eth.blockscout.com/api/eth-rpc", "https://eth.drpc.org"];
  const fallback = ["https://gateway.tenderly.co/public/mainnet", "https://rpc.mevblocker.io"];
  const pool = [
    ...archive.map((url) => ({ url, backingClass: "PUBLIC_KEYLESS_ARCHIVE" })),
    ...fallback.map((url) => ({ url, backingClass: "PUBLIC_KEYLESS_ARCHIVE" })),
    ...parseInventory().map((url) => ({ url, backingClass: "PUBLIC_KEYLESS_INVENTORY" })),
  ];
  const seen = new Set();
  for (const candidate of pool) {
    const { url } = candidate;
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      if (await request(url, "eth_chainId", [], true) !== "0x1") continue;
      const block = await request(url, "eth_getBlockByNumber", [quantity(pin), false], true);
      if (!block || Number(BigInt(block.number)) !== pin) continue;
      if (pinHash && lc(block.hash) !== lc(pinHash)) continue;
      const code = await request(url, "eth_getCode", [MORPHO, quantity(pin)], true);
      if (typeof code !== "string" || code.length <= 2) continue;
      yield { ...candidate, pin };
    } catch (_) { /* candidate failed qualification; never expose its error */ }
  }
}

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

async function startAnvil(relayUrl, pin) {
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
    if (/failed to get.*(?:chain.?id|chain id)/i.test(bootDiagnostic)) return "FORK_BACKING_CHAIN_ID_FAILURE";
    if (/failed to get.*(?:gas price|gasprice)/i.test(bootDiagnostic)) return "FORK_BACKING_GAS_PRICE_FAILURE";
    if (/failed to get.*(?:transaction|receipt)/i.test(bootDiagnostic)) return "FORK_BACKING_TRANSACTION_FAILURE";
    if (/failed to get.*proof/i.test(bootDiagnostic)) return "FORK_BACKING_PROOF_FAILURE";
    if (/failed to get.*code/i.test(bootDiagnostic)) return "FORK_BACKING_CODE_FAILURE";
    if (/failed to get.*balance/i.test(bootDiagnostic)) return "FORK_BACKING_BALANCE_FAILURE";
    if (/failed to get block/i.test(bootDiagnostic)) return "FORK_BACKING_BLOCK_FAILURE";
    if (/failed to get|failed to fetch|cannot fork|unsupported/i.test(bootDiagnostic)) return "FORK_BACKING_UNSUPPORTED";
    if (/unexpected argument|unrecognized option|invalid value/i.test(bootDiagnostic)) return "ANVIL_ARGUMENTS_INVALID";
    return "ANVIL_START_FAILED";
  };
  anvil.on("error", () => { /* observed by readiness loop */ });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    budget();
    if (anvil.exitCode !== null) fail(bootError());
    const local = `http://127.0.0.1:${port}`;
    try { if (await request(local, "eth_chainId", []) === "0x1" && Number(BigInt(await request(local, "eth_blockNumber", []))) === pin) return local; } catch (_) { /* boot in progress */ }
    await delay(120);
  }
  fail(bootError());
}

// --- fork-local helpers -----------------------------------------------------------------
async function readCall(local, to, iface, fn, args, from) {
  const data = iface.encodeFunctionData(fn, args);
  const req = { to, data };
  if (from) req.from = from;
  return iface.decodeFunctionResult(fn, await request(local, "eth_call", [req, "latest"]));
}

async function sendTx(local, tx) {
  const hash = await request(local, "eth_sendTransaction", [tx]);
  let receipt = null;
  for (let n = 0; n < 40 && !receipt; n += 1) { receipt = await request(local, "eth_getTransactionReceipt", [hash]); if (!receipt) await delay(120); }
  return { hash, receipt };
}

function decodeRevert(error) {
  if (!error || error.reverted !== true) return null;
  const data = error.revertData;
  if (!data) return "reverted";
  try {
    if (data.startsWith("0x08c379a0")) {
      const [msg] = AbiCoder.defaultAbiCoder().decode(["string"], "0x" + data.slice(10));
      return String(msg);
    }
    if (data.startsWith("0x4e487b71")) {
      const [code] = AbiCoder.defaultAbiCoder().decode(["uint256"], "0x" + data.slice(10));
      return "Panic(0x" + code.toString(16) + ")";
    }
  } catch (_) { /* fall through to selector */ }
  return data.slice(0, 10);
}

function decodeExecutionLogs(receipt, marketId, execAddress) {
  let repaidAssetsWei = null;
  let repaidSharesWei = null;
  let seizedAssetsWei = null;
  let balancerFeeWei = null;
  for (const log of receipt.logs || []) {
    try {
      if (log.address.toLowerCase() === lc(MORPHO) && log.topics[0].toLowerCase() === IFACE.morphoEvents.getEvent("Liquidate").topicHash.toLowerCase()) {
        if (!marketId || log.topics[1].toLowerCase() === lc(marketId)) {
          const parsed = IFACE.morphoEvents.parseLog(log);
          repaidAssetsWei = parsed.args.repaidAssets.toString();
          repaidSharesWei = parsed.args.repaidShares.toString();
          seizedAssetsWei = parsed.args.seizedAssets.toString();
        }
      }
      if (log.address.toLowerCase() === lc(VAULT) && log.topics[0].toLowerCase() === IFACE.balancerEvents.getEvent("FlashLoan").topicHash.toLowerCase()) {
        const parsed = IFACE.balancerEvents.parseLog(log);
        if (!execAddress || parsed.args.recipient.toLowerCase() === lc(execAddress)) balancerFeeWei = parsed.args.feeAmount.toString();
      }
    } catch (_) { /* unrelated log */ }
  }
  return { repaidAssetsWei, repaidSharesWei, seizedAssetsWei, balancerFeeWei };
}

function swapPathFor(row, route) {
  return "0x" + lc(row.collateralToken).slice(2) + Number(route.fee).toString(16).padStart(6, "0") + lc(row.loanToken).slice(2);
}

// Probe one candidate on the fork: accrue, size a safe repaidShares, run the full route via
// a snapshot'd real tx, then revert. Returns the measured plan or null if the route is not
// profitable / not liquidatable.
async function probeCandidate(local, EXEC, OWNER, cand) {
  const { row, route } = cand;
  const marketParams = [row.loanToken, row.collateralToken, row.oracle, row.irm, BigInt(row.lltvRaw)];
  const swapPath = swapPathFor(row, route);
  const marketId = (await readCall(local, EXEC, IFACE.exec, "marketId", [marketParams]))[0];
  if (lc(marketId) !== lc(row.marketId)) return null;

  await sendTx(local, {
    from: OWNER, to: MORPHO, data: IFACE.morpho.encodeFunctionData("accrueInterest", [marketParams]),
    gas: quantity(1_000_000), gasPrice: quantity(GAS_PRICE_WEI),
  });

  const pos = await readCall(local, MORPHO, IFACE.morpho, "position", [marketId, row.borrower]);
  const borrowShares = BigInt(pos[1]);
  const collateral = BigInt(pos[2]);
  if (borrowShares === 0n || collateral === 0n) return null;
  const mkt = await readCall(local, MORPHO, IFACE.morpho, "market", [marketId]);
  const totalBorrowAssets = BigInt(mkt[2]);
  const totalBorrowShares = BigInt(mkt[3]);
  const price = BigInt((await readCall(local, row.oracle, IFACE.oracle, "price", []))[0]);
  if (price === 0n) return null;
  const lltv = BigInt(row.lltvRaw);
  const lif = liquidationIncentiveFactor(lltv);
  const maxBorrow = ((collateral * price) / ORACLE_PRICE_SCALE) * lltv / WAD;
  const borrowed = toAssetsUp(borrowShares, totalBorrowAssets, totalBorrowShares);
  if (maxBorrow >= borrowed) return null; // not liquidatable

  let repaidShares = borrowShares;
  const seizedFull = seizedForShares(borrowShares, totalBorrowAssets, totalBorrowShares, lif, price);
  if (seizedFull > collateral && seizedFull > 0n) repaidShares = (borrowShares * collateral * 95n) / (seizedFull * 100n);
  let seizedEstimate = seizedForShares(repaidShares, totalBorrowAssets, totalBorrowShares, lif, price);
  for (let guard = 0; seizedEstimate > collateral && repaidShares > 1n && guard < 40; guard += 1) {
    repaidShares = repaidShares * 90n / 100n;
    seizedEstimate = seizedForShares(repaidShares, totalBorrowAssets, totalBorrowShares, lif, price);
  }
  if (repaidShares === 0n) return null;

  const data = IFACE.exec.encodeFunctionData("execute", [marketParams, row.borrower, 0n, repaidShares, 0n, 1n, SWAP_ROUTER, swapPath]);
  const snapshot = await request(local, "evm_snapshot", []);
  const ownerLoanBefore = BigInt((await readCall(local, row.loanToken, IFACE.erc20, "balanceOf", [OWNER]))[0]);
  const probe = await sendTx(local, { from: OWNER, to: EXEC, data, gas: quantity(EXEC_GAS), gasPrice: quantity(GAS_PRICE_WEI) });
  if (!probe.receipt || probe.receipt.status !== "0x1") {
    if (!await request(local, "evm_revert", [snapshot])) fail("SNAPSHOT_REVERT_FAILED");
    return null;
  }
  const ownerLoanAfter = BigInt((await readCall(local, row.loanToken, IFACE.erc20, "balanceOf", [OWNER]))[0]);
  const logs = decodeExecutionLogs(probe.receipt, marketId, EXEC);
  const repaidAssets = logs.repaidAssetsWei === null ? 0n : BigInt(logs.repaidAssetsWei);
  const seized = logs.seizedAssetsWei === null ? 0n : BigInt(logs.seizedAssetsWei);
  const fee = logs.balancerFeeWei === null ? 0n : BigInt(logs.balancerFeeWei);
  const net = ownerLoanAfter - ownerLoanBefore;
  const swapOut = net + repaidAssets + fee;
  if (!await request(local, "evm_revert", [snapshot])) fail("SNAPSHOT_REVERT_FAILED");

  const minOut = (swapOut * 98n) / 100n;
  const quotedSwapOut = await (async () => {
    try { return BigInt((await readCall(local, QUOTER, IFACE.quoter, "quoteExactInput", [swapPath, seized]))[0]); } catch (_) { return null; }
  })();

  return {
    row, route, marketParams, swapPath, marketId,
    borrowShares, collateral, totalBorrowAssets, totalBorrowShares, price, lltv, lif, maxBorrow, borrowed,
    repaidShares, seizedEstimate, minOut, quotedSwapOut,
    probe: { repaidAssets, seized, fee, net, swapOut },
  };
}

// ---------------------------------------------------------------------------
// main run
// ---------------------------------------------------------------------------
async function run() {
  if (!fs.existsSync(ANVIL)) fail("ANVIL_MISSING");
  const creation = loadExecutorArtifact();
  const { artifact: scanArtifact, candidates } = loadCandidates();
  const basePin = Number(scanArtifact.pin.number);
  const pinHash = scanArtifact.pin.hash;

  stage = "QUALIFY";
  let relayUrl = null;
  let local = null;
  let qualified = null;
  let pin = null;
  for (let backoff = 0; backoff <= MAX_PIN_BACKOFF && !qualified; backoff += 1) {
    const tryPin = basePin - backoff;
    const tryHash = backoff === 0 ? pinHash : null; // only the exact scanner block is hash-checked
    for await (const backing of qualifiedUpstreams(tryPin, tryHash)) {
      try {
        relayUrl = await startRelay(backing.url);
        stage = "QUALIFY_FORK";
        local = await startAnvil(relayUrl, tryPin);
        qualified = backing;
        pin = tryPin;
        break;
      } catch (error) {
        if (!stopAnvil()) fail("ANVIL_CLEANUP_FAILED");
        if (relay) { relay.closeAllConnections(); relay.close(); relay = null; }
        relayUrl = null;
        if (error?.message === "DEADLINE_EXCEEDED" || error?.message === "ANVIL_CLEANUP_FAILED") throw error;
      }
    }
  }
  if (!relayUrl || !qualified) fail("NO_ARCHIVE_BACKING");
  if (Number(BigInt(await request(local, "eth_blockNumber", []))) !== pin) fail("FORK_BLOCK_MISMATCH");

  stage = "CONTEXT";
  if ((await request(local, "eth_getCode", [MORPHO, "latest"])) === "0x") fail("MORPHO_CODE_MISSING");
  if ((await request(local, "eth_getCode", [USDC, "latest"])) === "0x") fail("TOKEN_CODE_MISSING");
  if ((await request(local, "eth_getCode", [WETH, "latest"])) === "0x") fail("TOKEN_CODE_MISSING");
  if ((await request(local, "eth_getCode", [SWAP_ROUTER, "latest"])) === "0x") fail("ROUTER_CODE_MISSING");

  const artifacts = {
    schema: "morpho-fork-rehearsal/v1",
    generatedAt: new Date().toISOString(),
    scanner: "tools/morpho-blue-flash-liquidator-rehearsal.js",
    chainId: CHAIN_ID,
    sourceArtifact: "reports/raw/fast/morpho-blue-liquidatable.json",
    scannerPinBlock: basePin,
    pinBlock: pin,
    executorArtifact: "contracts/flash-liquidate-morpho-blue/out/FlashLiquidateMorphoBlue.sol/FlashLiquidateMorphoBlue.json",
    morpho: MORPHO,
    candidateCount: candidates.length,
    relayOnly: true,
    endpointProcessOnly: true,
    sourceEndpointClass: qualified.backingClass.startsWith("PUBLIC_KEYLESS") ? qualified.backingClass : "PUBLIC_KEYLESS",
    backingClass: qualified.backingClass,
    callerFunding: { method: "anvil_setBalance+anvil_impersonateAccount", amountWei: OWNER_FUND_WEI.toString(), impersonated: true, signed: false },
    executorDeployment: { method: "fork-local deploy from local build artifact", signed: false },
    preSteps: [],
    interventions: [],
    cases: [],
    negatives: [],
    attempts: [],
    readonly: true,
    signedActionJustified: false,
    spawnedAt: new Date().toISOString(),
  };
  live = artifacts;

  // ---- fund owner + deploy the built executor on the fork ----
  stage = "FUND_OWNER";
  const OWNER = "0x00000000000000000000000000000000DeaDBeef";
  await request(local, "anvil_setBalance", [OWNER, quantity(OWNER_FUND_WEI)]);
  await request(local, "anvil_impersonateAccount", [OWNER]);

  stage = "DEPLOY_EXECUTOR";
  const deployData = creation + AbiCoder.defaultAbiCoder().encode(["address"], [MORPHO]).slice(2);
  const { receipt: deployReceipt } = await sendTx(local, {
    from: OWNER, data: deployData, gas: quantity(DEPLOY_GAS), gasPrice: quantity(GAS_PRICE_WEI),
  });
  if (!deployReceipt || deployReceipt.status !== "0x1" || !deployReceipt.contractAddress) fail("DEPLOY_FAILED");
  const EXEC = deployReceipt.contractAddress;
  artifacts.executor = EXEC;
  artifacts.executorAddress = EXEC;
  artifacts.owner = OWNER;
  artifacts.executorDeployment.contractAddress = EXEC;

  const execOwner = (await readCall(local, EXEC, IFACE.exec, "owner", []))[0];
  const execMorpho = (await readCall(local, EXEC, IFACE.exec, "MORPHO", []))[0];
  const execVault = (await readCall(local, EXEC, IFACE.exec, "BALANCER_VAULT", []))[0];
  if (lc(execOwner) !== lc(OWNER)) fail("EXEC_IMMUTABLE_MISMATCH");
  if (lc(execMorpho) !== lc(MORPHO)) fail("EXEC_IMMUTABLE_MISMATCH");
  if (lc(execVault) !== lc(VAULT)) fail("EXEC_IMMUTABLE_MISMATCH");

  // ---- probe candidates on the single fork; keep the first profitable route ----
  stage = "PROBE_CANDIDATES";
  let chosen = null;
  for (const cand of candidates) {
    if (Date.now() >= deadline - 45000) break; // leave budget for negatives + measured
    let probe = null;
    try { probe = await probeCandidate(local, EXEC, OWNER, cand); } catch (error) {
      if (error?.message === "DEADLINE_EXCEEDED" || error?.message === "ANVIL_CLEANUP_FAILED") throw error;
      probe = null;
    }
    artifacts.attempts.push({
      case: "PROBE", marketId: cand.row.marketId, borrower: cand.row.borrower,
      collateralToken: cand.row.collateralToken, loanToken: cand.row.loanToken,
      profitable: !!probe, note: probe ? "route-profitable" : "route-not-measured",
    });
    if (probe) { chosen = probe; break; }
  }
  if (!chosen) fail("ROUTE_UNPROFITABLE");

  const { row, route, marketParams, swapPath, marketId, repaidShares, minOut } = chosen;
  artifacts.market = {
    marketId: row.marketId, borrower: row.borrower, loanToken: row.loanToken, collateralToken: row.collateralToken,
    oracle: row.oracle, irm: row.irm, lltvRaw: row.lltvRaw, swapFee: Number(route.fee), swapPath,
  };
  artifacts.preSteps.push({ kind: "morpho.accrueInterest", marketId: row.marketId, status: "ok" });
  artifacts.liveReads = {
    borrowSharesRaw: chosen.borrowShares.toString(), collateralRaw: chosen.collateral.toString(),
    totalBorrowAssetsRaw: chosen.totalBorrowAssets.toString(), totalBorrowSharesRaw: chosen.totalBorrowShares.toString(),
    oraclePriceRaw: chosen.price.toString(), lltvRaw: chosen.lltv.toString(),
    liquidationIncentiveFactorRaw: chosen.lif.toString(), maxBorrowRaw: chosen.maxBorrow.toString(),
    borrowedRaw: chosen.borrowed.toString(), liquidatable: chosen.maxBorrow < chosen.borrowed,
  };
  artifacts.routePlan = {
    repaidSharesRaw: repaidShares.toString(), seizedEstimateRaw: chosen.seizedEstimate.toString(),
    collateralCapRaw: chosen.collateral.toString(), minOutWei: minOut.toString(),
    quotedSwapOutWei: chosen.quotedSwapOut === null ? null : chosen.quotedSwapOut.toString(),
  };

  const execData = (borrower, seizedAssets, shares, minProfitWei, minOutWei) =>
    IFACE.exec.encodeFunctionData("execute", [marketParams, borrower, seizedAssets, shares, minProfitWei, minOutWei, SWAP_ROUTER, swapPath]);

  const staticCall = async (data, from) => {
    try {
      await request(local, "eth_call", [{ from: from || OWNER, to: EXEC, data }, "latest"]);
      return { reverted: false };
    } catch (error) {
      if (error.reverted !== true) throw error;
      return { reverted: true, reason: decodeRevert(error), revertData: error.revertData || null };
    }
  };

  // ---- negative (a): healthy borrower -> HEALTHY_POSITION ----
  stage = "NEGATIVE_HEALTHY";
  const negHealthy = await staticCall(execData(HEALTHY_BORROWER, 1n, 0n, 0n, 1n));
  artifacts.negatives.push({
    kind: "healthy-borrower-control", expected: "HEALTHY_POSITION", staticCallReverted: negHealthy.reverted,
    revertReason: negHealthy.reason, revertSelector: negHealthy.revertData ? negHealthy.revertData.slice(0, 10) : null,
    controlledIntervention: "NONE", status: negHealthy.reverted && /position is healthy/i.test(negHealthy.reason || "") ? "PASS" : "FAIL",
  });

  // ---- negative (b): minOut = 0 -> MIN_OUT_REQUIRED ----
  stage = "NEGATIVE_MINOUT_ZERO";
  const negMinOut = await staticCall(execData(row.borrower, 0n, repaidShares, 0n, 0n));
  artifacts.negatives.push({
    kind: "minOut-zero-undercut", expected: "MIN_OUT_REQUIRED", staticCallReverted: negMinOut.reverted,
    revertReason: negMinOut.reason, controlledIntervention: "NONE",
    status: negMinOut.reverted && /MIN_OUT_REQUIRED/.test(negMinOut.reason || "") ? "PASS" : "FAIL",
  });

  // ---- negative (c): minProfit above achievable -> MIN_PROFIT_NOT_MET (pre-pull) ----
  stage = "NEGATIVE_MINPROFIT";
  const negProfit = await staticCall(execData(row.borrower, 0n, repaidShares, 10n ** 30n, minOut));
  artifacts.negatives.push({
    kind: "minProfit-above-achievable", expected: "MIN_PROFIT_NOT_MET", staticCallReverted: negProfit.reverted,
    revertReason: negProfit.reason, revertSelector: negProfit.revertData ? negProfit.revertData.slice(0, 10) : null,
    controlledIntervention: "NONE", status: negProfit.reverted && /MIN_PROFIT_NOT_MET/.test(negProfit.reason || "") ? "PASS" : "FAIL",
  });

  // ---- measured executor execution ----
  stage = "MEASURED_STATIC";
  const measuredData = execData(row.borrower, 0n, repaidShares, 0n, minOut);
  const staticResult = await staticCall(measuredData);
  if (staticResult.reverted) {
    artifacts.attempts.push({ case: "MEASURED_EXECUTION", reverted: true, reason: staticResult.reason, revertSelector: staticResult.revertData ? staticResult.revertData.slice(0, 10) : null });
    fail("MEASURED_STATIC_REVERTED");
  }

  stage = "MEASURED_TX";
  const ownerLoanBefore = BigInt((await readCall(local, row.loanToken, IFACE.erc20, "balanceOf", [OWNER]))[0]);
  const execLoanBefore = BigInt((await readCall(local, row.loanToken, IFACE.erc20, "balanceOf", [EXEC]))[0]);
  const { receipt } = await sendTx(local, { from: OWNER, to: EXEC, data: measuredData, gas: quantity(EXEC_GAS), gasPrice: quantity(GAS_PRICE_WEI) });
  if (!receipt || receipt.status !== "0x1") {
    const sim = await staticCall(measuredData);
    artifacts.attempts.push({ case: "MEASURED_EXECUTION", reverted: true, reason: "receipt-status-nonzero", staticReason: sim.reason || null, gasUsed: receipt ? receipt.gasUsed : null, gasLimit: EXEC_GAS });
    fail("MEASURED_TX_REVERTED");
  }
  const ownerLoanAfter = BigInt((await readCall(local, row.loanToken, IFACE.erc20, "balanceOf", [OWNER]))[0]);
  const execLoanAfter = BigInt((await readCall(local, row.loanToken, IFACE.erc20, "balanceOf", [EXEC]))[0]);
  const gasUsed = BigInt(receipt.gasUsed);
  const decoded = decodeExecutionLogs(receipt, marketId, EXEC);

  const feeWei = decoded.balancerFeeWei === null ? 0n : BigInt(decoded.balancerFeeWei);
  const repaidAssetsWei = decoded.repaidAssetsWei === null ? 0n : BigInt(decoded.repaidAssetsWei);
  const seizedAssetsWei = decoded.seizedAssetsWei === null ? 0n : BigInt(decoded.seizedAssetsWei);
  const netWei = ownerLoanAfter - ownerLoanBefore; // profit to owner (loan asset)
  const swapOutWei = netWei + repaidAssetsWei + feeWei; // loan asset in from the collateral swap
  const flashBorrowWei = toAssetsUp(repaidShares, chosen.totalBorrowAssets, chosen.totalBorrowShares);
  if (process.env.REHEARSAL_DEBUG === "1") process.stderr.write(`[debug] market=${row.marketId} seized=${seizedAssetsWei} repaid=${repaidAssetsWei} fee=${feeWei} net=${netWei} swapOut=${swapOutWei} flash=${flashBorrowWei} gas=${gasUsed}\n`);

  artifacts.cases.push({
    case: "MEASURED_EXECUTION",
    route: "balancer-flash->morpho-liquidate->onMorphoLiquidate-swap->repay->sweep",
    marketId: row.marketId,
    borrower: row.borrower,
    seizedAssetsWei: seizedAssetsWei.toString(),
    repaidSharesWei: decoded.repaidSharesWei,
    repaidAssetsWei: repaidAssetsWei.toString(),
    flashBorrowWei: flashBorrowWei.toString(),
    minProfitWei: "0",
    minOutWei: minOut.toString(),
    quotedSwapOutWei: chosen.quotedSwapOut === null ? null : chosen.quotedSwapOut.toString(),
    swapOutWei: swapOutWei.toString(),
    balancerFlashFeeWei: feeWei.toString(),
    netWei: netWei.toString(),
    ownerLoanBeforeWei: ownerLoanBefore.toString(),
    ownerLoanAfterWei: ownerLoanAfter.toString(),
    executorLoanBeforeWei: execLoanBefore.toString(),
    executorLoanAfterWei: execLoanAfter.toString(),
    collateralInWei: seizedAssetsWei.toString(),
    collateralOutLoanWei: swapOutWei.toString(),
    gasUsed: gasUsed.toString(),
    receiptStatus: receipt.status,
    minOutHonored: swapOutWei >= minOut,
    controlledIntervention: "NONE",
  });

  if (artifacts.negatives.some((n) => n.status !== "PASS")) fail("NEGATIVE_CONTROL_FAILED");
  if (artifacts.cases.length < 1) fail("NO_MEASURED_CASE");

  // Tear the fork down and verify no anvil process remains (process check).
  const stopped = stopAnvil();
  artifacts.anvilTeardown = { stopped, residue: !stopped, checked: true };

  artifacts.completedAt = new Date().toISOString();
  artifacts.state = "PASS";
  return artifacts;
}

function writeResult(result) {
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(result, null, 2) + "\n", "utf8");
}

process.once("exit", stopAnvil);
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { aborted = true; stopAnvil(); process.exit(1); });

(async () => {
  let timer;
  try {
    const result = await Promise.race([
      run(),
      new Promise((_, reject) => { timer = setTimeout(() => { aborted = true; stopAnvil(); reject(new Error("DEADLINE_EXCEEDED")); }, LIMIT_MS); }),
    ]);
    writeResult(result);
    process.stdout.write(JSON.stringify({
      state: "PASS", pinBlock: result.pinBlock, interventions: result.interventions.length,
      measuredCases: result.cases.length, negatives: result.negatives.map((n) => n.status),
      gasUsed: result.cases[0] ? result.cases[0].gasUsed : null, netWei: result.cases[0] ? result.cases[0].netWei : null,
      cleanup: stopAnvil() ? "clean" : "residual",
    }) + "\n");
  } catch (error) {
    const reason = CODES.has(error?.message) ? error.message : `${stage}_INTERNAL_OR_RELAY_FAILURE`;
    if (process.env.REHEARSAL_DEBUG === "1" && !CODES.has(error?.message)) process.stderr.write(`[debug] ${error && error.stack ? error.stack : String(error)}\n`);
    const stopped = stopAnvil();
    writeResult({
      schema: "morpho-fork-rehearsal/v1", state: "FAIL_CLOSED", reason, pinBlock: live ? live.pinBlock : null,
      relayOnly: true, endpointProcessOnly: true,
      sourceEndpointClass: live ? live.sourceEndpointClass : null, backingClass: live ? live.backingClass : null,
      market: live ? live.market : null, executor: live ? live.executor : null,
      liveReads: live ? live.liveReads : null, routePlan: live ? live.routePlan : null,
      preSteps: live ? live.preSteps : [], interventions: live ? live.interventions : [],
      cases: live ? live.cases : [], negatives: live ? live.negatives : [], attempts: live ? live.attempts : [],
      anvilTeardown: { stopped, residue: !stopped, checked: true },
      spawnedAt: live ? live.spawnedAt : new Date().toISOString(), completedAt: new Date().toISOString(),
      readonly: true, signedActionJustified: false,
    });
    process.stdout.write(JSON.stringify({ state: "FAIL_CLOSED", reason }) + "\n");
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    stopAnvil();
    if (relay) { relay.closeAllConnections(); relay.close(); }
  }
})();
