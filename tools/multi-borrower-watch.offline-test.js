#!/usr/bin/env node
"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const template = require("./multi-borrower-watch"), morpho = require("./morpho-multi-watch"), single = require("./morpho-cbbtc-watch");
const adapterPath = path.join(__dirname, "morpho-multi-watch.js"), listPath = path.join(__dirname, "morpho-multi-watch.watch-list.json");
const fakePath = path.join(__dirname, "multi-borrower-watch.test-adapter.js"), fakeConfig = path.join(__dirname, "multi-borrower-watch.test-config.json");
const { jsonBytes, sha } = template.helpers;
async function quiet(fn) {
  const write = process.stdout.write; let output = "";
  process.stdout.write = (chunk) => { output += chunk.toString(); return true; };
  try { await fn(); return output.trim().split(/\r?\n/).map((line) => JSON.parse(line)); } finally { process.stdout.write = write; }
}
// Legacy commands must keep their production output paths. Redirect ONLY their
// filesystem I/O during validation so this bounded task writes nothing to reports/.
async function legacyValidation() {
  const reports = path.join(single.helpers.ROOT, "reports"), target = path.join(__dirname, "multi-borrower-watch-validation", "legacy-reports");
  const saved = {}, map = (v) => typeof v === "string" && (v === reports || v.startsWith(reports + path.sep)) ? path.join(target, path.relative(reports, v)) : v;
  for (const name of ["readFileSync", "mkdirSync", "openSync", "unlinkSync", "linkSync", "renameSync"]) {
    saved[name] = fs[name]; fs[name] = (...args) => { args[0] = map(args[0]); if (["linkSync", "renameSync"].includes(name)) args[1] = map(args[1]); return saved[name](...args); };
  }
  const fetch = globalThis.fetch; globalThis.fetch = () => { throw new Error("NETWORK_FORBIDDEN"); };
  try {
    const [s] = await quiet(() => single.main(["--offline-test"])); assert.equal(s.passed, true); assert.equal(s.cases.filter((c) => c.passed).length, 21);
    const [m] = await quiet(() => morpho.main(["--offline-test"])); assert.equal(m.passed, true); assert.equal(m.passedCount, 10);
    const [one] = await quiet(() => single.main(["--once"])); assert.equal(one.status, "COMPLETE"); assert.equal(one.mode, "dry-run");
    const [multi] = await quiet(() => morpho.main(["--once"])); assert.equal(multi.status, "COMPLETE"); assert.equal(multi.crossPairSummary.captured, 4);
    const [defaultPair] = await quiet(() => morpho.main(["--once", "--default-cbbtc"])); assert.equal(defaultPair.status, "COMPLETE"); assert.equal(defaultPair.crossPairSummary.captured, 1);
    return { single: "21/21", multi: "10/10", singleCapture: one.status, multiCapture: multi.status, defaultPairCapture: defaultPair.status, artifacts: "tools/multi-borrower-watch-validation/legacy-reports (test-only I/O redirection)" };
  } finally { for (const [name, fn] of Object.entries(saved)) fs[name] = fn; globalThis.fetch = fetch; }
}
async function main(selected = null) {
  const cases = [], previousFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("NETWORK_FORBIDDEN"); };
  const test = async (id, fn) => { try { await fn(); cases.push({ id, passed: true }); } catch (error) { cases.push({ id, passed: false, reason: template.helpers.safeCode(error) }); } };
  const resolved = template.resolveAdapter(adapterPath, listPath), other = template.resolveAdapter(fakePath, fakeConfig);
  const run = (r = resolved, overrides = {}, send = null) => template.runResolved(r, { live: false, block: null, ...overrides }, send ?? r.adapter.fixtureSend(r.config));
  let capture;
  try {
    await test("required-adapter-and-config", () => {
      for (const args of [[], ["--adapter", adapterPath], ["--adapter-config", listPath], ["--adapter", "--once", "--adapter-config", listPath]]) assert.throws(() => template.parseArgs(args));
    });
    await test("cli-flags-and-block-normalization", () => {
      const value = template.parseArgs(["--adapter", adapterPath, "--adapter-config", listPath, "--once", "--live", "--refresh", "--block", "16", "--rpc-url", "https://redacted.invalid"]);
      assert.equal(value.block, "0x10"); assert.ok(value.live && value.once && value.refresh);
      for (const extra of [["--live"], ["--once", "--live", "--offline-test"], ["--block", "0"], ["--block", "9007199254740992"], ["--unknown"]]) assert.throws(() => template.parseArgs(["--adapter", adapterPath, "--adapter-config", listPath, ...extra]));
    });
    await test("resolve-existing-array-with-adapter-defaults", () => { assert.equal(resolved.config.chainId, 8453); assert.equal(resolved.config.watchList.length, 4); assert.equal(resolved.config.morpho, single.MORPHO); });
    await test("resolution-is-cwd-relative-and-missing-safe", () => {
      assert.equal(template.resolveAdapter(path.relative(process.cwd(), adapterPath), path.relative(process.cwd(), listPath)).identity, resolved.identity);
      assert.throws(() => template.resolveAdapter(adapterPath + ".missing", listPath), /ADAPTER_INVALID/);
      assert.throws(() => template.resolveAdapter(adapterPath, listPath + ".missing"), /ADAPTER_INVALID/);
    });
    await test("adapter-contract-and-config-rejected", () => {
      assert.throws(() => template.resolveAdapter(path.join(__dirname, "morpho-cbbtc-watch.js"), listPath), /ADAPTER_INVALID/);
      assert.throws(() => template.resolveAdapter(adapterPath, path.join(__dirname, "morpho-multi-watch.fixtures.json")));
    });
    await test("template-four-morpho-pairs-one-pin", async () => {
      capture = await run(); assert.equal(capture.status, "COMPLETE"); assert.equal(capture.entries.length, 4); assert.equal(capture.diagnostics.requestCount, 18);
      assert.ok(capture.entries.every((e) => e.pin.valid && e.pin.hash === capture.pin.hash)); assert.equal(capture.diagnostics.rpcCount, 0);
    });
    await test("summary-matches-legacy-exactly", async () => {
      const legacy = await morpho.captureMulti({ transport: morpho.makeTransport(morpho.fixtureSend(resolved.config), "dry-run"), watchList: resolved.config.watchList });
      assert.deepEqual(capture.crossPairSummary.pairs, legacy.crossPairSummary.pairs);
      assert.equal(capture.crossPairSummary.closestToLiquidation.borrower, resolved.config.watchList[1].borrower);
    });
    await test("summary-exact-integer-threshold-and-equality", () => {
      for (const e of capture.entries) {
        const m = e.metrics, p = BigInt(m.thresholdOraclePriceRaw), c = BigInt(m.collateralRaw), l = BigInt(m.lltvWad), d = BigInt(m.debtRaw);
        const max = (price) => (c * price / 10n ** 36n) * l / 10n ** 18n;
        assert.ok(max(p) >= d && max(p - 1n) < d);
      }
      const m = morpho.computeHF(1n, 1n, 2n * 10n ** 36n, 860000000000000000n);
      assert.equal(m.hfWad, "1000000000000000000"); assert.equal(m.verdict, "LIQUIDATABLE"); assert.equal(m.protocolLiquidatableAtPin, false);
    });
    await test("historical-pin-within-request-budget", async () => {
      const block = `0x${(BigInt(capture.pin.number) - 1n).toString(16)}`, value = await run(resolved, { block });
      assert.equal(value.status, "COMPLETE"); assert.equal(value.pin.number, Number(BigInt(block))); assert.equal(value.diagnostics.requestCount, 19);
    });
    await test("future-pin-rejected", async () => { const v = await run(resolved, { block: `0x${(BigInt(capture.pin.number) + 1n).toString(16)}` }); assert.equal(v.reason, "PIN_NOT_FINALIZED"); assert.equal(v.crossPairSummary.captured, 0); });
    await test("canonical-drift-invalidates-all-pairs", async () => {
      const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, "morpho-multi-watch.fixtures.json")));
      const send = require("./morpho-multi-watch.offline-test").fixtureSend(fixtures, resolved.config.watchList, { drift: true });
      const value = await run(resolved, {}, send); assert.equal(value.reason, "PIN_DRIFT"); assert.equal(value.crossPairSummary.captured, 0); assert.equal(value.crossPairSummary.closestToLiquidation, null);
    });
    await test("pair-failure-never-zero-health", async () => {
      const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, "morpho-multi-watch.fixtures.json")));
      const send = require("./morpho-multi-watch.offline-test").fixtureSend(fixtures, resolved.config.watchList, { failUsde: true });
      const v = await run(resolved, {}, send); assert.equal(v.status, "INCOMPLETE"); assert.equal(v.crossPairSummary.captured, 1);
      assert.ok(v.crossPairSummary.pairs.slice(1).every((p) => p.hf === null && p.hfWad === null && p.thresholdOraclePriceRaw === null));
    });
    await test("non-morpho-other-chain-and-no-debt-ranking", async () => {
      const v = await run(other); assert.equal(v.status, "COMPLETE"); assert.equal(v.entries[0].identity.chainId, 1); assert.equal(v.crossPairSummary.closestToLiquidation.borrower, "near");
      assert.equal(v.crossPairSummary.pairs[2].hfWad, null); assert.equal(v.diagnostics.requestCount, 5);
    });
    await test("all-no-debt-no-closest-pair", async () => {
      const r = { ...other, config: { ...other.config, watchList: [other.config.watchList[2]] } }, v = await run(r);
      assert.equal(v.status, "COMPLETE"); assert.equal(v.crossPairSummary.closestToLiquidation, null);
    });
    await test("partial-pair-summary-scopes-health", async () => {
      const r = { ...other, config: { ...other.config, watchList: [other.config.watchList[0], { marketId: "reserve-a", borrower: "failed", label: "failed" }] } }, v = await run(r);
      assert.equal(v.status, "INCOMPLETE"); assert.equal(v.crossPairSummary.captured, 1); assert.equal(v.crossPairSummary.incomplete, 1); assert.match(v.crossPairSummary.closestScope, /^complete-pairs-only/); assert.equal(v.pin.valid, false);
    });
    await test("chain-mismatch-and-invalid-header", async () => {
      const v = await run(other, {}, async () => "0x2"); assert.equal(v.reason, "CHAIN_MISMATCH");
      const bad = await run(other, {}, async (m) => m === "eth_chainId" ? "0x1" : null); assert.equal(bad.reason, "PIN_INVALID");
    });
    await test("write-methods-selectors-and-unpinned-calls-denied", async () => {
      const t = template.createTransport({ mode: "dry-run", send: async () => assert.fail(), allowCall: () => true });
      for (const m of ["eth_sendTransaction", "eth_sendRawTransaction", "eth_sign", "debug_traceCall"]) await assert.rejects(t.rpc(m, []), /METHOD_REJECTED/);
      await assert.rejects(t.rpc("eth_call", [{ to: single.MORPHO, data: "0x12345678" }, "latest"]), /METHOD_REJECTED/);
      const guarded = template.createTransport({ mode: "dry-run", send: async () => assert.fail(), allowCall: (call) => morpho.allowCall(call, resolved.config) });
      await assert.rejects(guarded.rpc("eth_call", [{ to: single.MORPHO, data: "0x12345678" }, { blockHash: capture.pin.hash, requireCanonical: true }]), /METHOD_REJECTED/); assert.equal(t.ledger.length, 0);
    });
    await test("bounded-request-count-and-shared-deadline", async () => {
      const t = template.createTransport({ mode: "dry-run", maxRequests: 1, send: async () => "0x1" }); await t.rpc("eth_chainId", []); await assert.rejects(t.rpc("eth_chainId", []), /RPC_BUDGET_EXCEEDED/);
      let now = 0; const timed = template.createTransport({ mode: "dry-run", now: () => now, send: async () => { now = 120000; return "0x1"; } }); await assert.rejects(timed.rpc("eth_chainId", []), /TIME_BUDGET_EXCEEDED/);
    });
    await test("malformed-adapter-health-stays-incomplete", async () => {
      const r = { ...other, adapter: { ...other.adapter, computeHF: () => ({ verdict: "LIQUIDATABLE", hfWad: "bad" }) } }, v = await run(r); assert.equal(v.crossPairSummary.captured, 0); assert.equal(v.reason, "READ_INVALID");
    });
    await test("endpoint-and-upstream-errors-sanitized", async () => {
      assert.throws(() => jsonBytes({ rpc: "https://redacted.invalid" }), /SANITIZATION_FAILED/); jsonBytes(capture);
      const v = await run(other, {}, async () => { throw new Error("https://redacted.invalid?key=redacted"); }); assert.equal(v.reason, "RPC_FAILURE"); assert.ok(!JSON.stringify(v).includes("redacted"));
    });
    await test("atomic-capture-manifest-and-latest-reuse", () => {
      const out = path.join(__dirname, "multi-borrower-watch-validation", "persistence"), output = path.join(out, "latest-status.json");
      const store = template.createPersistence({ out, output, identity: resolved.identity, artifactPattern: /^tools\/multi-borrower-watch-validation\/persistence\/multi-[^/]+\.json$/ });
      const v = { ...capture, mode: "live", runId: require("node:crypto").randomBytes(8).toString("hex") }, artifact = store.persist(v, true);
      const file = path.join(single.helpers.ROOT, artifact), manifest = JSON.parse(fs.readFileSync(file.replace(/\.json$/, ".manifest.json")));
      assert.equal(manifest.sha256, sha(fs.readFileSync(file))); assert.ok(store.freshStatus({ watchList: resolved.config.watchList }));
      assert.equal(store.freshStatus({ watchList: resolved.config.watchList.slice(0, 1) }), null);
      const wrong = template.createPersistence({ out, output, identity: "wrong", artifactPattern: /.*/ }); assert.equal(wrong.freshStatus({ watchList: resolved.config.watchList }), null);
      fs.appendFileSync(file, " "); assert.equal(store.freshStatus({ watchList: resolved.config.watchList }), null);
    });
    await test("selected-adapter-and-template-cli-capture", async () => {
      if (selected) { const v = await run(selected); assert.equal(v.status, "COMPLETE"); }
      const [v] = await quiet(() => template.main(["--adapter", adapterPath, "--adapter-config", listPath, "--once"])); assert.equal(v.status, "COMPLETE"); assert.equal(v.crossPairSummary.captured, 4);
    });
    const summary = { passed: cases.every((c) => c.passed), passedCount: cases.filter((c) => c.passed).length, total: cases.length, rpcCount: 0, cases };
    process.stdout.write(JSON.stringify(summary) + "\n"); if (!summary.passed) throw new Error("OFFLINE_TEST_FAILED");
    return summary;
  } finally { globalThis.fetch = previousFetch; }
}
module.exports = { main, legacyValidation };
if (require.main === module) (async () => {
  const result = await main(); const legacy = await legacyValidation(); process.stdout.write(JSON.stringify({ template: `${result.passedCount}/${result.total}`, legacy, rpcCount: 0 }) + "\n");
})().catch((error) => { process.stdout.write(JSON.stringify({ passed: false, reason: template.helpers.safeCode(error) }) + "\n"); process.exitCode = 1; });
