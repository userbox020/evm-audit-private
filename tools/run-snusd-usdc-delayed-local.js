#!/usr/bin/env node
"use strict";
// Explicit opt-in MANUAL wrapper. Imports/prepare() perform local reads only.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, "..");
const MANIFEST = "reports/raw/fast/snusd-usdc-delayed-normal-input-20261018.json";
const SCENARIO = "tools/fork-poc/snusd-usdc-delayed-normal.js";
const OUT = "reports/raw/fast/fork-poc/snusd-usdc-delayed-normal-20261018.json";
const OUTPUTS = Object.freeze({ 1: OUT,
  2: "reports/raw/fast/fork-poc/snusd-usdc-delayed-normal-20261018-attempt02.json",
  3: "reports/raw/fast/fork-poc/snusd-usdc-delayed-normal-20261018-attempt03.json",
  4: "reports/raw/fast/fork-poc/snusd-usdc-delayed-normal-20261018-attempt04.json" });
const ORIGINAL_RECEIPT_SHA = "d69b388f72e1f98646726b789a2961500206097341d362f3a37c23fddd5c1928";
const MANIFEST_SHA = "034e612eb8ba91b8486861db86c230ea1f1ace1f20e1d7439c7accc781197a71";
const SCENARIO_SHA = "22091836f764fc863dcb0ef9c86045e586a90497135b1aab7c5101d6c4b952e1";
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function fail(code) { const e = new Error(code); e.code = code; throw e; }
function parseAttempt(argv) {
  if (Array.isArray(argv) && argv.length === 1 && argv[0] === "--run") return 1;
  if (Array.isArray(argv) && argv.length === 3 && argv[0] === "--run" && argv[1] === "--attempt" && typeof argv[2] === "string" && /^[2-4]$/.test(argv[2])) return Number(argv[2]);
  fail("EXPLICIT_FIXED_RUN_REQUIRED");
}
function prepare(readFile = file => fs.readFileSync(file)) {
  const bytes = readFile(path.join(ROOT, MANIFEST));
  if (digest(bytes) !== MANIFEST_SHA) fail("MANIFEST_SOURCE_MISMATCH");
  const m = JSON.parse(bytes);
  if (digest(readFile(path.join(ROOT, SCENARIO))) !== SCENARIO_SHA) fail("SCENARIO_SOURCE_MISMATCH");
  for (const { file, sha256 } of m.sourceCommitments) if (digest(readFile(path.join(ROOT, file))) !== sha256) fail("DEPENDENCY_SOURCE_MISMATCH");
  const receiptBytes = readFile(path.join(ROOT, m.receiptPath));
  if (digest(receiptBytes) !== m.receiptSha256) fail("ECONOMICS_RECEIPT_MISMATCH");
  const r = JSON.parse(receiptBytes);
  const same = (a, b) => JSON.stringify(a.map(v => String(v).toLowerCase())) === JSON.stringify(b.map(v => String(v).toLowerCase()));
  if (r.pin.chainId !== m.pin.chainId || String(r.pin.number) !== m.pin.number || r.pin.hash !== m.pin.hash
      || r.pin.stateRoot !== m.pin.stateRoot || r.pin.timestamp !== m.pin.timestamp || r.terminalCanonical !== true || r.position.eligible !== true
      || r.sizes.at(-1).seized !== m.seizedAssetsRaw || r.sizes.at(-1).repaid !== m.capturedRepaymentRaw
      || r.sizes.at(-1).quoteUsdcRaw !== m.capturedExitRaw || r.vault.asset !== m.bindings.nusd || r.vault.silo !== m.bindings.silo
      || BigInt(m.minExitRaw) !== BigInt(m.capturedExitRaw) * 99n / 100n) fail("RECEIPT_INPUT_BINDING_MISMATCH");
  if (!same(m.marketParams, r.coreObservation.params) || !same(m.storedMarket, r.coreObservation.market) || !same(m.position, r.coreObservation.position)
      || m.oraclePriceRaw !== r.position.price || m.borrowRateRaw !== r.position.borrowRateRaw || m.cooldownSeconds !== r.vault.cooldownSeconds
      || m.previewUnderlyingRaw !== r.sizes.at(-1).previewUnderlyingRaw || m.gasReferenceUsdcPerEthRaw !== r.gas.wethUsdcPerEthRaw
      || m.inputIndex !== r.curve.inputIndex || m.outputIndex !== r.curve.outputIndex) fail("RECEIPT_STATE_BINDING_MISMATCH");
  for (const [address, hash] of Object.entries(m.runtimes)) if (!r.runtimes.some(x => x.address === address && x.runtimeKeccak256 === hash)) fail("RUNTIME_INPUT_BINDING_MISMATCH");
  require("./fork-poc/snusd-usdc-delayed-normal").validateInput(m, require("ethers"));
  return m;
}
// The shared ctx lacks header reads. This fixed-scope read-only bridge reuses
// its owned local RPC; it adds no provider, sender, mining or mutation primitive.
function makeHarnessDeps(harness, approved, m, scenario, attempt = 1) {
  if (![1, 2, 3, 4].includes(attempt)) fail("ATTEMPT_REJECTED");
  const outPath = OUTPUTS[attempt];
  const sourceFiles = [SCENARIO, "tools/run-snusd-usdc-delayed-local.js", "tools/test/snusd-usdc-delayed-normal.test.js", MANIFEST]
    .map(file => ({ file, sha256: digest(fs.readFileSync(path.join(ROOT, file))) }));
  const attemptMetadata = { number: attempt, outputPath: outPath, scenarioNameUnchanged: true, originalReceiptPath: OUT,
    originalReceiptSha256: ORIGINAL_RECEIPT_SHA, sourceFiles,
    sourceArchiveIndex: "reports/raw/fast/fork-poc/snusd-usdc-normal-source-history-20261018/attempt0" + attempt + "/index.json",
    sourceArchiveStatus: "PARENT_SNAPSHOT_REQUIRED_NOT_VERIFIED_BY_WRAPPER" };
  const base = harness.defaultDeps(), started = Date.now();
  let local = null, upstreamRequests = 0, headerReads = 0, waitedMs = 0, sendCount = 0;
  const allowed = new Set(Object.keys(m.runtimes)), eoas = new Set([m.actor, ...m.fundingEoas]);
  const nativeFixtures = new Map([[m.actor, m.actorNativeFixtureWei], ...m.fundingEoas.map(a => [a, m.fundingNativeFixtureWei])]);
  const nativeSeeded = new Set();
  const scope = (condition, code) => { if (!condition) fail(code); };
  const readBlockHeader = async number => {
    scope(local && Number.isSafeInteger(number) && number >= Number(m.pin.number) && number <= Number(m.pin.number) + 8 && ++headerReads <= 32, "HEADER_READ_SCOPE_INVALID");
    const raw = await local.call("eth_getBlockByNumber", ["0x" + number.toString(16), false]);
    scope(raw && BigInt(raw.number) === BigInt(number) && /^0x[0-9a-f]{64}$/i.test(raw.hash)
      && /^0x[0-9a-f]{64}$/i.test(raw.stateRoot) && /^0x[0-9a-f]+$/i.test(raw.timestamp), "LOCAL_HEADER_INVALID");
    return { number, hash: raw.hash.toLowerCase(), stateRoot: raw.stateRoot.toLowerCase(), timestamp: BigInt(raw.timestamp).toString() };
  };
  return {
    loadRpcUrls: options => base.loadRpcUrls({ ...options, maxCandidates: 8, preferredChainId: 1 }),
    transport: async (url, payload, timeout, maxBytes = m.harnessLimits.messageBytes) => {
      scope(++upstreamRequests <= 1000 && Date.now() - started < m.harnessLimits.totalMs, "UPSTREAM_BUDGET_EXHAUSTED");
      const response = await base.transport(url, payload, Math.min(timeout, m.harnessLimits.requestMs), Math.min(maxBytes, m.harnessLimits.messageBytes));
      if (payload.method === "eth_getBlockByNumber" && payload.params[0] === "0x" + BigInt(m.pin.number).toString(16)) {
        const h = response?.value?.result;
        scope(h && h.hash?.toLowerCase() === m.pin.hash && h.stateRoot?.toLowerCase() === m.pin.stateRoot
          && BigInt(h.number) === BigInt(m.pin.number) && BigInt(h.timestamp) === BigInt(m.pin.timestamp), "UPSTREAM_FIXED_PIN_MISMATCH");
      }
      return response;
    },
    createLocalRpc: port => { local = approved.createLocalRpc(port, { limits: m.harnessLimits }); return local; },
    loadScenario: file => {
      scope(file === path.join(ROOT, SCENARIO), "SCENARIO_PATH_REJECTED");
      return { run: async ctx => {
        // Deliberately omit deploy/setCode/snapshots/signers/raw RPC/time travel.
        const restricted = {
          chainId: ctx.chainId, blockNumber: ctx.blockNumber, blockHash: ctx.blockHash, ethers: ctx.ethers, input: ctx.input,
          assert: ctx.assert, log: ctx.log, readBlockHeader,
          waitOrdinary: async ms => {
            scope(Number.isSafeInteger(ms) && ms >= 0 && (waitedMs += ms) <= 5000, "ORDINARY_WAIT_CAP");
            await new Promise(resolve => setTimeout(resolve, ms));
          },
          call: tx => { scope(allowed.has(tx.to.toLowerCase()), "CALL_TARGET_REJECTED");
            if (tx.from) scope(tx.from.toLowerCase() === m.bindings.morpho && tx.to.toLowerCase() === m.bindings.irm, "CALL_SENDER_REJECTED");
            return ctx.call(tx); },
          send: tx => { scope(allowed.has(tx.to.toLowerCase()) && eoas.has(tx.from.toLowerCase()) && ++sendCount <= 8
              && BigInt(tx.value || 0) === 0n && BigInt(tx.gas) > 0n && BigInt(tx.gas) <= 1000000n, "SEND_SCOPE_REJECTED");
            return ctx.send(tx); },
          getCode: (address, block) => { scope(allowed.has(address.toLowerCase()) || eoas.has(address.toLowerCase()), "CODE_SCOPE_REJECTED"); return ctx.getCode(address, block); },
          getStorageAt: (address, slot, block) => { scope(allowed.has(address.toLowerCase()) && slot === "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc", "STORAGE_READ_SCOPE_REJECTED"); return ctx.getStorageAt(address, slot, block); },
          getBalance: address => { scope(eoas.has(address.toLowerCase()), "NATIVE_READ_SCOPE_REJECTED"); return ctx.getBalance(address); },
          setBalance: (address, quantity) => { const key = address.toLowerCase();
            scope(sendCount === 0 && nativeFixtures.has(key) && !nativeSeeded.has(key) && BigInt(quantity) === BigInt(nativeFixtures.get(key)), "NATIVE_FIXTURE_SCOPE_REJECTED");
            nativeSeeded.add(key); return ctx.setBalance(address, quantity); }
        };
        ctx.log("preparation-commitments", { receiptSha256: m.receiptSha256, manifestSha256: MANIFEST_SHA, scenarioSha256: SCENARIO_SHA,
          expectedStateRoot: m.pin.stateRoot, historicalOnly: true, boundedLocalHeaderBridge: true });
        ctx.log("operational-attempt", attemptMetadata);
        try { await scenario.run(Object.freeze(restricted)); }
        finally {
          ctx.log("fixed-wrapper-counters", { transportRequestsIncludingRelay: upstreamRequests,
            localRpc: local && typeof local.stats === "function" ? local.stats() : null,
            headerReads, waitedMs, sendsObserved: sendCount, elapsedMs: Date.now() - started,
            sharedQualificationProbeCount: null });
        }
      } };
    },
    writeEvidence: (file, output) => {
      scope(file === path.join(ROOT, outPath), "OUTPUT_PATH_REJECTED");
      output.operationalAttempt = attemptMetadata;
      harness.leakGuard(output);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(output, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    }
  };
}
async function main(argv = process.argv.slice(2), deps = {}) {
  const attempt = parseAttempt(argv), outPath = OUTPUTS[attempt];
  if (!deps || Object.keys(deps).some(k => !["runForkPoc", "readFile", "exists"].includes(k))
      || Object.values(deps).some(v => typeof v !== "function") || Object.keys(deps).length && typeof deps.runForkPoc !== "function") fail("TEST_SEAM_REQUIRES_MOCK_HARNESS");
  if ((deps.exists || fs.existsSync)(path.join(ROOT, outPath))) fail("OUTPUT_ALREADY_EXISTS");
  const m = prepare(deps.readFile);
  if (attempt > 1 && digest((deps.readFile || fs.readFileSync)(path.join(ROOT, OUT))) !== ORIGINAL_RECEIPT_SHA) fail("ORIGINAL_RECEIPT_CHANGED");
  const harness = require("./run-fork-poc"), approved = require("./run-approved-fork-validation"), scenario = require("./fork-poc/snusd-usdc-delayed-normal");
  const options = { callerClass: "MANUAL", chain: "1", block: m.pin.number, scenario: path.join(ROOT, SCENARIO),
    scenarioName: "snusd-usdc-delayed-normal-20261018", scenarioInput: m, outPath: path.join(ROOT, outPath), limits: m.harnessLimits };
  const result = await (deps.runForkPoc || harness.runForkPoc)(options, makeHarnessDeps(harness, approved, m, scenario, attempt));
  return { status: result.status, blocker: result.blocker || null, outPath, attempt };
}
if (require.main === module) main().then(result => {
  process.stdout.write(JSON.stringify(result) + "\n"); if (result.status !== "PASS") process.exitCode = 1;
}).catch(e => { process.stderr.write((/^[A-Z][A-Z0-9_]+$/.test(e.code || "") ? e.code : "LOCAL_PREPARATION_REFUSED") + "\n"); process.exitCode = 1; });
module.exports = Object.freeze({ main, prepare, makeHarnessDeps, parseAttempt, MANIFEST, SCENARIO, OUT, OUTPUTS, ORIGINAL_RECEIPT_SHA, MANIFEST_SHA, SCENARIO_SHA });
