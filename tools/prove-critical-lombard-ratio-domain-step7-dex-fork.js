#!/usr/bin/env node
"use strict";

// Defensive local-fork consumer binding only. No key, live transaction, or upstream mutation.
// Reuses already-public ratio-update calldata captured by the Step-7 scanner.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { ethers } = require("ethers");
const { resolveRpc } = require("./shared-rpc");

const ROOT = path.resolve(__dirname, "..");
const STEM = "critical-lombard-ratio-domain-step7";
const RAW = path.join(ROOT, `reports/raw/fast/${STEM}.json`);
const CALLDATA = path.join(ROOT, `reports/raw/fast/${STEM}.public-calldata.json`);
const OUT = path.join(ROOT, `reports/raw/fast/${STEM}.dex-fork.json`);
const EPHEMERAL = "0x000000000000000000000000000000000000bEEF";
const ORACLE = "0x1De9fcfeDF3E51266c188ee422fbA1c7860DA0eF";
const CAPPED = "0x503Ef5B869b3f32D407c7816710f87b1D686C103";
const INVERTED_CENTER = "0xb0335b5443e19676bA973411C5A18571eB7Cd4B3";
const DEXES = [
  ["WBTC/LBTC", "0xe0Cc64Ab3712e2087E1D4AAB6f3A14F120449E5f"],
  ["LBTC/cbBTC", "0xc8F989E9B7ECE1b4D092Ae4db7fAF1294146bdA4"],
];
const DEX_META = {
  "WBTC/LBTC": { token0: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", token1: LBTC_ADDRESS(), expectedCenterPrice: INVERTED_CENTER },
  "LBTC/cbBTC": { token0: LBTC_ADDRESS(), token1: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", expectedCenterPrice: CAPPED },
};
const QUOTE_AMOUNTS = ["10000", "100000", "1000000", "10000000", "100000000"];
const ADDRESS_DEAD = "0x000000000000000000000000000000000000dEaD";

function LBTC_ADDRESS() { return "0x8236a87084f8B84306f72007F36F2618A5634494"; }

const RATE = new ethers.Interface([
  "function getExchangeRate() view returns (uint256)",
  "function getExchangeRateOperate() view returns (uint256)",
  "function getExchangeRateLiquidate() view returns (uint256)",
  "function rebalance()",
]);
const CENTER = new ethers.Interface([
  "function FLUID_CAPPED_RATE() view returns (address)",
  "function centerPrice() returns (uint256)",
]);
const DEX_SWAP = new ethers.Interface([
  "function swapIn(bool swap0to1,uint256 amountIn,uint256 amountOutMin,address to) payable returns (uint256 amountOut)",
  "error FluidDexSwapResult(uint256 amountOut)",
]);

function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function redact(error) { return String(error?.message || error || "unknown").replace(/https?:\/\/\S+/g, "[redacted]").slice(0, 220); }
function assertNoLeak(text) { if (/https?:\/\//i.test(text) || /(?:authorization|x-api-key|api[_-]?key)\s*[:=]/i.test(text)) throw new Error("leak guard"); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function s(value) { return value == null ? null : value.toString(); }

async function localRpc(port, method, params = [], timeout = 30000) {
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const response = await fetch(`http://127.0.0.1:${port}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: ctrl.signal });
    const json = await response.json();
    if (json.error) {
      const error = new Error(`${json.error.code}:${json.error.message}`);
      error.rpcData = typeof json.error.data === "string" ? json.error.data : json.error.data?.data;
      throw error;
    }
    return json.result;
  } finally { clearTimeout(timer); }
}

async function upstreamRpc(url, method, params = [], timeout = 30000) {
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: ctrl.signal });
    const json = await response.json();
    if (json.error) throw new Error(`${json.error.code}:${json.error.message}`);
    return json.result;
  } finally { clearTimeout(timer); }
}

async function waitReady(port) {
  for (let i = 0; i < 120; i++) {
    try { if (await localRpc(port, "eth_chainId", [], 1000) === "0x1") return true; } catch {}
    await sleep(250);
  }
  return false;
}

async function waitReceipt(port, txHash) {
  for (let i = 0; i < 100; i++) {
    const receipt = await localRpc(port, "eth_getTransactionReceipt", [txHash]);
    if (receipt) return receipt;
    await sleep(100);
  }
  return null;
}

async function ethCall(port, to, iface, fn, args = []) {
  const raw = await localRpc(port, "eth_call", [{ from: EPHEMERAL, to, data: iface.encodeFunctionData(fn, args) }, "latest"]);
  return iface.decodeFunctionResult(fn, raw);
}

function pexView(x) {
  return {
    lastStoredPrice: s(x.lastStoredPrice ?? x[0]),
    centerPrice: s(x.centerPrice ?? x[1]),
    upperRange: s(x.upperRange ?? x[2]),
    lowerRange: s(x.lowerRange ?? x[3]),
    geometricMean: s(x.geometricMean ?? x[4]),
  };
}

function reserveView(x) {
  return {
    token0RealReserves: s(x.token0RealReserves ?? x[0]),
    token1RealReserves: s(x.token1RealReserves ?? x[1]),
    token0ImaginaryReserves: s(x.token0ImaginaryReserves ?? x[2]),
    token1ImaginaryReserves: s(x.token1ImaginaryReserves ?? x[3]),
  };
}

async function directSwapQuote(port, dex, swap0to1, amountIn) {
  try {
    await localRpc(port, "eth_call", [{ from: EPHEMERAL, to: dex, data: DEX_SWAP.encodeFunctionData("swapIn", [swap0to1, amountIn, 0, ADDRESS_DEAD]) }, "latest"]);
    throw new Error("swap estimate unexpectedly returned without FluidDexSwapResult");
  } catch (error) {
    if (!error.rpcData) throw error;
    const decoded = DEX_SWAP.parseError(error.rpcData);
    if (!decoded || decoded.name !== "FluidDexSwapResult") throw error;
    return decoded.args[0];
  }
}

async function singleQuote(port, resolverAddress, resolverIface, dex, swap0to1, amountIn, resolverAvailable) {
  return resolverAvailable ? (await ethCall(port, resolverAddress, resolverIface, "estimateSwapIn", [dex, swap0to1, amountIn, 0]))[0] : await directSwapQuote(port, dex, swap0to1, amountIn);
}

async function quoteGrid(port, resolverAddress, resolverIface, dex, resolverAvailable) {
  const rows = [];
  for (const swap0to1 of [true, false]) {
    for (const amountIn of QUOTE_AMOUNTS) {
      try {
        const amountOut = await singleQuote(port, resolverAddress, resolverIface, dex, swap0to1, amountIn, resolverAvailable);
        rows.push({ swap0to1, amountIn, amountOut: s(amountOut), accepted: true, method: resolverAvailable ? "resolver-eth_call" : "direct-custom-error-eth_call" });
      } catch (error) {
        rows.push({ swap0to1, amountIn, amountOut: null, accepted: false, errorClass: redact(error) });
      }
    }
  }
  return rows;
}

async function compositeQuoteGrid(port, resolverAddress, resolverIface, resolverAvailable) {
  const rows = [];
  for (const amountIn of QUOTE_AMOUNTS) {
    for (const route of ["WBTC->LBTC->cbBTC", "cbBTC->LBTC->WBTC"]) {
      try {
        let middle, amountOut;
        if (route === "WBTC->LBTC->cbBTC") {
          middle = await singleQuote(port, resolverAddress, resolverIface, DEXES[0][1], true, amountIn, resolverAvailable);
          amountOut = await singleQuote(port, resolverAddress, resolverIface, DEXES[1][1], true, middle, resolverAvailable);
        } else {
          middle = await singleQuote(port, resolverAddress, resolverIface, DEXES[1][1], false, amountIn, resolverAvailable);
          amountOut = await singleQuote(port, resolverAddress, resolverIface, DEXES[0][1], false, middle, resolverAvailable);
        }
        rows.push({ route, amountIn, middleAmount: s(middle), amountOut: s(amountOut), outputVsInputSignedBps1e4: signedBps(amountIn, amountOut), accepted: true });
      } catch (error) {
        rows.push({ route, amountIn, middleAmount: null, amountOut: null, outputVsInputSignedBps1e4: null, accepted: false, errorClass: redact(error) });
      }
    }
  }
  return rows;
}

async function dexSnapshot(port, resolverAddress, resolverIface, label, dex, resolverAvailable) {
  try {
    if (!resolverAvailable) {
      const meta = DEX_META[label];
      const raw = BigInt(await localRpc(port, "eth_getStorageAt", [dex, "0x1", "latest"]));
      return {
        label,
        address: ethers.getAddress(dex),
        resolved: true,
        resolutionMethod: "direct-pool-calls-and-storage-layout",
        token0: ethers.getAddress(meta.token0),
        token1: ethers.getAddress(meta.token1),
        config: {
          isSmartCollateralEnabled: (raw & 1n) === 1n,
          isSmartDebtEnabled: ((raw >> 1n) & 1n) === 1n,
          fee: ((raw >> 2n) & ((1n << 17n) - 1n)).toString(),
          centerPriceAddress: ethers.getAddress(meta.expectedCenterPrice),
          centerPriceAddressEvidence: "checked-in deployment artifact; behavioral quote delta tested on fork",
        },
        pex: null,
        collateralReserves: null,
        state: { isSwapAndArbitragePaused: ((raw >> 255n) & 1n) === 1n },
        quotes: await quoteGrid(port, resolverAddress, resolverIface, dex, false),
      };
    }
    const [tokensResult, configResult, pexResult, reservesResult, stateResult] = await Promise.all([
      ethCall(port, resolverAddress, resolverIface, "getDexTokens", [dex]),
      ethCall(port, resolverAddress, resolverIface, "getDexConfigs", [dex]),
      ethCall(port, resolverAddress, resolverIface, "getDexPricesAndExchangePrices", [dex]),
      ethCall(port, resolverAddress, resolverIface, "getDexCollateralReserves", [dex]),
      ethCall(port, resolverAddress, resolverIface, "getDexState", [dex]),
    ]);
    const config = configResult[0], state = stateResult[0];
    return {
      label,
      address: ethers.getAddress(dex),
      resolved: true,
      token0: ethers.getAddress(tokensResult[0]),
      token1: ethers.getAddress(tokensResult[1]),
      config: {
        isSmartCollateralEnabled: Boolean(config.isSmartCollateralEnabled ?? config[0]),
        isSmartDebtEnabled: Boolean(config.isSmartDebtEnabled ?? config[1]),
        fee: s(config.fee ?? config[2]),
        revenueCut: s(config.revenueCut ?? config[3]),
        upperRange: s(config.upperRange ?? config[4]),
        lowerRange: s(config.lowerRange ?? config[5]),
        centerPriceAddress: ethers.getAddress(config.centerPriceAddress ?? config[9]),
      },
      pex: pexView(pexResult[0]),
      collateralReserves: reserveView(reservesResult[0]),
      state: {
        lastStoredPrice: s(state.lastStoredPrice ?? state[1]),
        centerPrice: s(state.centerPrice ?? state[2]),
        totalSupplyShares: s(state.totalSupplyShares ?? state[7]),
        totalBorrowShares: s(state.totalBorrowShares ?? state[8]),
        isSwapAndArbitragePaused: Boolean(state.isSwapAndArbitragePaused ?? state[9]),
      },
      resolutionMethod: "deployed-dex-resolver",
      quotes: await quoteGrid(port, resolverAddress, resolverIface, dex, true),
    };
  } catch (error) {
    return { label, address: ethers.getAddress(dex), resolved: false, errorClass: redact(error), quotes: [] };
  }
}

async function snapshot(port, resolverAddress, resolverIface) {
  const direct = {};
  for (const fn of ["getExchangeRate", "getExchangeRateOperate", "getExchangeRateLiquidate"]) {
    try { direct[fn] = s((await ethCall(port, CAPPED, RATE, fn))[0]); } catch { direct[fn] = null; }
  }
  let invertedCenterPrice = null, invertedRateSource = null;
  try { invertedCenterPrice = s((await ethCall(port, INVERTED_CENTER, CENTER, "centerPrice"))[0]); } catch {}
  try { invertedRateSource = ethers.getAddress((await ethCall(port, INVERTED_CENTER, CENTER, "FLUID_CAPPED_RATE"))[0]); } catch {}
  const resolverAvailable = (await localRpc(port, "eth_getCode", [resolverAddress, "latest"])) !== "0x";
  const dexes = [];
  for (const [label, dex] of DEXES) dexes.push(await dexSnapshot(port, resolverAddress, resolverIface, label, dex, resolverAvailable));
  const compositeQuotes = await compositeQuoteGrid(port, resolverAddress, resolverIface, resolverAvailable);
  return { capped: direct, invertedCenterPrice, invertedRateSource, resolverAvailable, dexes, compositeQuotes };
}

function signedBps(before, after) {
  if (before == null || after == null || BigInt(before) === 0n) return null;
  return ((BigInt(after) - BigInt(before)) * 100000000n / BigInt(before)).toString(); // 1e4 = one bp
}

function candidateRateDelta(candidate) {
  const oldRatio = BigInt(candidate.destinationPreState.ratio);
  const newRatio = BigInt(candidate.key.split(":")[1]);
  const signedBps1e4 = oldRatio * 100000000n / newRatio - 100000000n;
  return { oldRatio: oldRatio.toString(), newRatio: newRatio.toString(), signedBps1e4: signedBps1e4.toString(), absoluteBps1e4: (signedBps1e4 < 0n ? -signedBps1e4 : signedBps1e4).toString() };
}

async function deploymentCoverage(upstream, candidates, addresses) {
  const rows = [];
  for (const candidate of candidates) {
    const at = `0x${candidate.destinationPreBlock.toString(16)}`;
    const hasCode = {};
    for (const [label, address] of addresses) {
      try { hasCode[label] = (await upstreamRpc(upstream, "eth_getCode", [address, at])) !== "0x"; } catch { hasCode[label] = null; }
    }
    const rateDelta = candidateRateDelta(candidate);
    rows.push({ sourceTransactionHash: candidate.sourceTransactionHash, destinationPreBlock: candidate.destinationPreBlock, effectiveTimingWindowSeconds: candidate.effectiveTimingWindowSeconds, ...rateDelta, hasCode, directDexPathDeployed: Object.entries(hasCode).filter(([label]) => label !== "resolver").every(([, present]) => present === true) });
  }
  return rows;
}

function compare(before, after) {
  return before.dexes.map((prior, index) => {
    const next = after.dexes[index];
    const quotes = prior.quotes.map((q, i) => {
      const n = next?.quotes?.[i];
      return { swap0to1: q.swap0to1, amountIn: q.amountIn, before: q.amountOut, after: n?.amountOut ?? null, changed: q.amountOut !== (n?.amountOut ?? null), signedBps1e4: signedBps(q.amountOut, n?.amountOut) };
    });
    return {
      label: prior.label,
      resolvedBefore: prior.resolved,
      resolvedAfter: next?.resolved ?? false,
      configuredCenterPrice: prior.config?.centerPriceAddress ?? null,
      pexCenterBefore: prior.pex?.centerPrice ?? null,
      pexCenterAfter: next?.pex?.centerPrice ?? null,
      pexCenterChanged: prior.pex?.centerPrice !== next?.pex?.centerPrice,
      reservesChanged: prior.collateralReserves == null || next?.collateralReserves == null ? null : JSON.stringify(prior.collateralReserves) !== JSON.stringify(next.collateralReserves),
      quoteChanged: quotes.some((x) => x.changed),
      quotes,
    };
  });
}

function compareComposite(before, after) {
  return before.compositeQuotes.map((prior, index) => {
    const next = after.compositeQuotes[index];
    return { route: prior.route, amountIn: prior.amountIn, before: prior.amountOut, after: next?.amountOut ?? null, changed: prior.amountOut !== (next?.amountOut ?? null), signedBps1e4: signedBps(prior.amountOut, next?.amountOut) };
  });
}

async function main() {
  const raw = readJson(RAW), fixtures = readJson(CALLDATA);
  const candidates = raw.compatibility.windows.filter((x) => x.exploitableTimingCandidate).sort((a, b) => b.destinationPreBlock - a.destinationPreBlock || b.effectiveTimingWindowSeconds - a.effectiveTimingWindowSeconds);
  if (!candidates.length) throw new Error("fork gate closed: no effective compatibility window");
  const resolverDeployment = readJson(path.join(ROOT, "targets/fluid-contracts-public/deployments/mainnet/DexResolver.json"));
  const resolverAddress = ethers.getAddress(resolverDeployment.address), resolverIface = new ethers.Interface(resolverDeployment.abi);
  const upstream = await resolveRpc(1);
  if (!upstream) throw new Error("authorized Ethereum endpoint unavailable");
  let coverage = null;
  try {
    const prior = readJson(OUT);
    if (Array.isArray(prior.deploymentCoverage) && prior.deploymentCoverage.length === candidates.length && prior.deploymentCoverage.every((x) => candidates.some((c) => c.sourceTransactionHash === x.sourceTransactionHash))) coverage = prior.deploymentCoverage;
  } catch {}
  if (!coverage) coverage = await deploymentCoverage(upstream, candidates, [["resolver", resolverAddress], ["capped", CAPPED], ["invertedCenter", INVERTED_CENTER], ...DEXES.map(([label, address]) => [`dex:${label}`, address])]);
  const covered = coverage.filter((x) => x.directDexPathDeployed).sort((a, b) => Number(BigInt(b.absoluteBps1e4) - BigInt(a.absoluteBps1e4)) || b.destinationPreBlock - a.destinationPreBlock);
  if (!covered.length) throw new Error("fork gate closed: direct DEX path was not deployed in a compatible window");
  const selectedCoverage = covered[0];
  const selected = candidates.find((x) => x.sourceTransactionHash === selectedCoverage.sourceTransactionHash);
  const fixture = fixtures.rows.find((x) => x.chainId === 8453 && x.transactionHash === selected.sourceTransactionHash);
  if (!fixture?.input) throw new Error("public calldata fixture unavailable");
  const port = 19545 + Math.floor(Math.random() * 1000);
  const child = spawn("anvil", ["--silent", "--fork-url", upstream, "--fork-block-number", String(selected.destinationPreBlock), "--port", String(port), "--chain-id", "1", "--no-rate-limit"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let childOutput = "";
  child.stdout.on("data", (b) => { childOutput += b.toString(); });
  child.stderr.on("data", (b) => { childOutput += b.toString(); });
  try {
    if (!(await waitReady(port))) throw new Error("local fork did not become ready");
    await localRpc(port, "anvil_impersonateAccount", [EPHEMERAL]);
    await localRpc(port, "anvil_setBalance", [EPHEMERAL, "0x8ac7230489e80000"]);
    const codePresence = {};
    for (const [name, address] of [["resolver", resolverAddress], ["center", INVERTED_CENTER], ...DEXES.map(([name, address]) => [`dex:${name}`, address])]) {
      const code = await localRpc(port, "eth_getCode", [address, "latest"]);
      codePresence[name] = { address: ethers.getAddress(address), hasCode: code !== "0x", codeBytes: Math.max(0, (code.length - 2) / 2) };
    }
    const before = await snapshot(port, resolverAddress, resolverIface);
    const replayHash = await localRpc(port, "eth_sendTransaction", [{ from: EPHEMERAL, to: ORACLE, data: fixture.input, gas: "0x7a1200" }]);
    const replayReceipt = await waitReceipt(port, replayHash);
    if (!replayReceipt || Number(BigInt(replayReceipt.status)) !== 1) throw new Error("local replay reverted");
    const afterReplay = await snapshot(port, resolverAddress, resolverIface);
    const rebalanceHash = await localRpc(port, "eth_sendTransaction", [{ from: EPHEMERAL, to: CAPPED, data: RATE.encodeFunctionData("rebalance", []), gas: "0x2dc6c0" }]);
    const rebalanceReceipt = await waitReceipt(port, rebalanceHash);
    if (!rebalanceReceipt || Number(BigInt(rebalanceReceipt.status)) !== 1) throw new Error("local capped-rate rebalance reverted");
    const afterRebalance = await snapshot(port, resolverAddress, resolverIface);
    const replayDelta = compare(before, afterReplay), rebalanceDelta = compare(before, afterRebalance);
    const replayCompositeDelta = compareComposite(before, afterReplay), rebalanceCompositeDelta = compareComposite(before, afterRebalance);
    const allConfiguredConsumers = before.dexes.every((x) => x.resolved && [CAPPED, INVERTED_CENTER].map((a) => a.toLowerCase()).includes(x.config.centerPriceAddress.toLowerCase()));
    const quoteDeltaPositive = rebalanceDelta.some((x) => x.quoteChanged);
    const pexDeltaPositive = rebalanceDelta.some((x) => x.pexCenterChanged);
    const oneBtcDexDeltas = rebalanceDelta.map((dex) => ({ label: dex.label, directions: dex.quotes.filter((q) => q.amountIn === "100000000") }));
    const oneBtcCompositeDeltas = rebalanceCompositeDelta.filter((q) => q.amountIn === "100000000");
    const feeBps1e4 = before.dexes.map((dex) => ({ label: dex.label, rawFee: dex.config?.fee ?? null, feeBps1e4: dex.config?.fee == null ? null : (BigInt(dex.config.fee) * 100n).toString() }));
    const out = {
      schema: 1,
      generatedAt: raw.generatedAt,
      runId: raw.runId,
      safety: { localForkOnly: true, ephemeralImpersonatedAccount: true, privateKeyUsed: false, keyFileRead: false, signedTransaction: false, liveBroadcast: false, upstreamMutation: false, publicCalldataOnly: true, swapsExecuted: false, resolverQuotesOnly: true, childOutputPersisted: false },
      selectionStrategy: "maximum absolute ratio-implied rate change among compatible windows with the complete direct DEX path deployed",
      deploymentCoverage: coverage,
      selectedWindow: { sourceTransactionHash: selected.sourceTransactionHash, destinationTransactionHash: selected.destinationTransactionHash, destinationPreBlock: selected.destinationPreBlock, effectiveTimingWindowSeconds: selected.effectiveTimingWindowSeconds, rateDelta: candidateRateDelta(selected) },
      codePresence,
      directBinding: { cappedRate: CAPPED, invertedCenterPrice: INVERTED_CENTER, invertedRateSource: before.invertedRateSource, allDexesBoundToDirectOrInvertedCappedRate: allConfiguredConsumers },
      localTransactions: { replayStatus: Number(BigInt(replayReceipt.status)), replayGasUsed: s(replayReceipt.gasUsed), rebalanceStatus: Number(BigInt(rebalanceReceipt.status)), rebalanceGasUsed: s(rebalanceReceipt.gasUsed) },
      before,
      afterReplay,
      afterRebalance,
      replayDelta,
      rebalanceDelta,
      replayCompositeDelta,
      rebalanceCompositeDelta,
      pexCenterDeltaPositive: pexDeltaPositive,
      dexQuoteDeltaPositive: quoteDeltaPositive,
      compositeRouteQuoteDeltaPositive: rebalanceCompositeDelta.some((x) => x.changed),
      reserveAccountingDelta: rebalanceDelta.some((x) => x.reservesChanged),
      historicalEconomicsBound: {
        grossRatioImpliedRateChangeBps1e4: candidateRateDelta(selected).absoluteBps1e4,
        feeBps1e4,
        oneBtcDexDeltas,
        oneBtcCompositeDeltas,
        twoFluidDexFeeFloorBps1e4: feeBps1e4.every((x) => x.feeBps1e4 != null) ? feeBps1e4.reduce((sum, x) => sum + BigInt(x.feeBps1e4), 0n).toString() : null,
        externalUnwindRequiredForSingleDexRoute: true,
        fundedExternalUnwindTested: false,
        currentCompatibleWindowProven: false,
      },
      permissionlessSwapExecuted: false,
      permissionlessExtractionProven: false,
      exactPositiveEconomics: null,
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      blockers: [
        quoteDeltaPositive ? "DEX quote deltas are hypothetical eth_call outputs; no funded round trip, external unwind, or net-positive extraction was demonstrated." : "No DEX swap quote changed after replay and capped-rate rebalance.",
        "The replayed ratio is the same globally intended update and only advanced Ethereum publication by the bounded historical window.",
        "No current-window availability or current positive economics is established by this historical fork.",
      ],
      childOutputObservedInMemoryOnly: childOutput.length > 0,
    };
    const text = JSON.stringify(out, null, 2) + "\n"; assertNoLeak(text); fs.writeFileSync(OUT, text);
    process.stdout.write(`forkBlock=${selected.destinationPreBlock} bound=${allConfiguredConsumers} pexDelta=${pexDeltaPositive} quoteDelta=${quoteDeltaPositive} reserveDelta=${out.reserveAccountingDelta} routePositive=0\n`);
  } finally {
    try { await localRpc(port, "anvil_stopImpersonatingAccount", [EPHEMERAL], 1000); } catch {}
    child.kill();
  }
}

main().catch((error) => { process.stderr.write(`dex fork proof failed: ${redact(error)}\n`); process.exitCode = 1; });
