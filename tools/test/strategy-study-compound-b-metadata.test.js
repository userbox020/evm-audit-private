"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process"), Module = require("node:module");
const capture = require("../strategy-study/capture"), metadata = require("../strategy-study/compound-b-metadata"), cli = require("../strategy-study/compound-b-metadata-cli");
const START = Date.parse("2026-10-21T01:00:00Z"), SENTINEL = "PRIVATE_METADATA_SENTINEL", q = n => `0x${BigInt(n).toString(16)}`, H = n => `0x${BigInt(n).toString(16).padStart(64, "0")}`;
const clone = v => JSON.parse(JSON.stringify(v)), TEMP = "C:\\Users\\MiPC\\AppData\\Local\\Temp\\opencode";
const candidates = ["https://eth-mainnet.g.alchemy.com/offline-metadata", "https://eth-mainnet.infura.io/offline-metadata", "https://ethereum.publicnode.com/offline-metadata"];
test("new collector and CLI imports are inert and do not resolve inventory or codec", () => {
  const vm = require("node:vm"), blocked = new Proxy({}, { get() { assert.fail("I/O during import"); } });
  for (const name of ["compound-b-metadata", "compound-b-metadata-cli"]) {
    const filename = require.resolve(`../strategy-study/${name}`), module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, "utf8"), { module, __dirname: path.dirname(filename), process: blocked, Buffer,
      require(dep) {
        if (dep === "node:fs") return blocked; if (dep === "node:path") return path; if (dep === "./capture") return capture;
        if (dep === "./emission-proof") return require("../strategy-study/emission-proof");
        if (dep === "./compound-b-metadata-admission") return require("../strategy-study/compound-b-metadata-admission");
        if (dep === "./compound-b-pilot") return { FIXTURE: metadata.FIXTURE }; if (dep === "./compound-b-metadata") return metadata;
        assert.fail("unexpected import");
      } }, { filename });
    assert.equal(typeof module.exports[name.endsWith("cli") ? "main" : "runCompoundBMetadata"], "function");
  }
});
function runtimeFixture(respond = () => ({ result: "0x1" }), extra = {}) {
  let time = START; const calls = [], events = [];
  const f = { calls, events, now: () => time, setNow: n => { time = n; } };
  f.options = { chainId: 1, purpose: "compound-b-metadata", backoff: true, candidates, shared: { getOrigin: () => null }, now: f.now, sleep: async ms => { time += ms; }, backoffRandom: () => 0,
    onTransportDiagnostic: e => events.push(e), fetch: async (url, init) => { const req = JSON.parse(init.body), c = { ...req, index: f.options.candidates.indexOf(url), at: time }; calls.push(c);
      const response = await respond(c, f, init); return new Response(response.raw ?? JSON.stringify({ jsonrpc: "2.0", id: req.id, ...(response.error ? { error: response.error } : { result: response.result }) }),
        { status: response.status || 200, headers: response.headers }); }, ...extra };
  return f;
}
async function runtimeTest(f, task) { const r = capture.createRuntime(f.options); try { return await task(r); } finally { await r.close(); assert.deepEqual(r.lifecycle(), { closed: true, pending: 0 }); } }
test("metadata purpose is isolated to Oct22 and requires explicit adapter/backoff without broader overrides", async () => {
  assert.equal(capture.EXPIRES_AT, "2026-10-21T00:00:00Z"); assert.equal(metadata.EXPIRES_AT, "2026-10-22T00:00:00Z");
  for (const purpose of ["qualification", "census", "enrichment", "emission-diagnostic", "emission-capability"]) assert.throws(() => capture.createRuntime({ ...runtimeFixture().options, purpose }), /session-expired/);
  const f = runtimeFixture();
  for (const extra of [{ chainId: 8453 }, { candidates: undefined }, { shared: undefined }, { backoff: false }, { expiresAt: "2030-01-01" }, { expiryMs: 9999999999999 }, { limits: { requests: 301 } }, { limits: { traceRequestCap: 1 } }, { limits: { spacingMs: 999 } }])
    assert.throws(() => capture.createRuntime({ ...f.options, ...extra }), /invalid-options/);
  await runtimeTest(f, async r => { assert.equal(r.timing().expiresAt, metadata.EXPIRES_AT); assert.equal(await r.request(0, "eth_chainId", []), "0x1"); f.setNow(Date.parse(metadata.EXPIRES_AT)); await assert.rejects(r.request(0, "eth_chainId", []), /session-expired/); });
  assert.equal(f.calls.length, 1);
});
test("metadata exact methods/params reject getters and serializers before queues; retry payload is frozen", async () => {
  let invoked = 0; const getter = [q(metadata.ANCHORS[1].number), false]; Object.defineProperty(getter, "1", { enumerable: true, get() { invoked++; return false; } });
  const serializer = []; Object.defineProperty(serializer, "toJSON", { value() { invoked++; return []; } });
  const f = runtimeFixture(c => c.id === 1 ? { status: 429, raw: SENTINEL, headers: { "retry-after": "2" } } : { result: "0x1" });
  await runtimeTest(f, async r => {
    for (const method of ["eth_getLogs", "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_call", "eth_getCode", "debug_traceCall", "debug_traceTransaction", "eth_sendRawTransaction"])
      await assert.rejects(r.request(0, method, []), /rpc-method-not-read-only-allowlisted/);
    for (const [method, params] of [["eth_chainId", ["0x1"]], ["eth_chainId", serializer], ["eth_getBlockByNumber", getter], ["eth_getBlockByNumber", ["latest", false]], ["eth_getBlockByNumber", ["finalized", false]],
      ["eth_getBlockByNumber", [q(metadata.ANCHORS[0].number), true]], ["eth_getBlockByHash", [metadata.ANCHORS[0].hash, true]], ["eth_getBlockByHash", [H(1), false]], ["eth_getBlockByHash", [metadata.ANCHORS[1].hash, true, {}]]])
      await assert.rejects(r.request(0, method, params), /invalid-options/);
    assert.equal(invoked, 0); assert.equal(f.calls.length, 0); assert.equal(r.snapshot().requests, 0);
    const params = [metadata.ANCHORS[1].hash, true], pending = r.request(0, "eth_getBlockByHash", params); params[0] = H(99); params[1] = false; await pending;
    assert.deepEqual(f.calls.map(c => c.params), [[metadata.ANCHORS[1].hash, true], [metadata.ANCHORS[1].hash, true]]); assert.ok(f.calls[1].at - f.calls[0].at >= 2000);
    assert.equal(r.backoffSnapshot().retries, 1); assert.ok(!JSON.stringify(f.events).includes(SENTINEL));
  });
});
test("metadata response/HTTP/lifetime deadlines and malformed envelopes remain global and sanitized", async () => {
  const expired = runtimeFixture((c, f) => { f.setNow(Date.parse(metadata.EXPIRES_AT)); return { result: "0x1" }; });
  await runtimeTest(expired, r => assert.rejects(r.request(0, "eth_chainId", []), /session-expired/));
  const f = runtimeFixture(() => ({ raw: SENTINEL }), { limits: { responseBytes: 1 } });
  await runtimeTest(f, r => assert.rejects(r.request(0, "eth_chainId", []), /response-budget-exceeded/));
  const bad = runtimeFixture(c => ({ raw: JSON.stringify({ jsonrpc: "2.0", id: c.id, result: "0x1", error: { code: -32601, message: SENTINEL } }) }));
  await runtimeTest(bad, r => assert.rejects(r.request(0, "eth_chainId", []), /invalid-schema/));
  const timeout = runtimeFixture(() => assert.fail("unused"), { limits: { requestTimeoutMs: 10 }, fetch: async (_, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error(SENTINEL)), { once: true })) });
  await runtimeTest(timeout, r => assert.rejects(r.request(0, "eth_chainId", []), /request-timeout/));
  const capped = runtimeFixture(() => ({ result: "0x1" }), { limits: { requests: 1 } });
  await runtimeTest(capped, r => assert.rejects(r.request(0, "eth_chainId", []), /request-budget-exhausted/));
});

// Collector flow tests use explicit synthetic codec injection. No fixture below
// claims cryptographic validity; real codec/source integration is a separate test.
let context;
function syntheticContext() {
  if (context) return context;
  const previous = require("../strategy-study/trace-enrichment"), census = require("../strategy-study/census-cli").readAuthoritativeCensus(previous.C2_DIRECTORY, { allowPartial: false, expectedManifestSha256: previous.C2_SHA256 });
  const raw = JSON.parse(fs.readFileSync(metadata.RAW_PATH)), parsed = require("ethers").Transaction.from(raw.publicSignedTransaction);
  const headers = metadata.ANCHORS.map(a => census.chunks.flatMap(c => c.headers).find(h => h.hash === a.hash));
  const stub = {
    normalizeMetadataHeader(raw) {
      assert.ok(raw && typeof raw === "object" && Array.isArray(raw.transactions));
      const header = Object.fromEntries(["number", "hash", "parentHash", "stateRoot", "timestamp", "baseFeePerGas"].map(k => [k, raw[k]]));
      assert.ok(Object.values(header).every(v => typeof v === "string" && /^0x[0-9a-f]+$/.test(v)));
      const transactionHashes = raw.transactions.map(v => typeof v === "string" ? v : v.hash); assert.ok(transactionHashes.every(h => /^0x[0-9a-f]{64}$/.test(h)));
      return { header, headerRlp: `0x${capture.sha256(capture.canonical(header))}`, transactionHashes };
    },
    serializeSignedTransaction(body) {
      assert.ok(body && !body.invalid && typeof body.hash === "string" && /^0x[0-9a-f]{64}$/.test(body.hash));
      assert.ok(typeof body.transactionIndex === "string" && /^0x[0-9a-f]+$/.test(body.transactionIndex));
      const normalized = clone(body);
      if (["0x2", "0x3", "0x4"].includes(body.type) && Object.hasOwn(body, "gasPrice")) {
        assert.ok(/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(body.gasPrice));
        assert.ok(BigInt(body.gasPrice) >= BigInt(body.maxPriorityFeePerGas) && BigInt(body.gasPrice) <= BigInt(body.maxFeePerGas)); delete normalized.gasPrice;
      }
      return { body: normalized, rawTransaction: body.hash === metadata.FIXTURE.txHash ? raw.publicSignedTransaction : `0x${capture.sha256(capture.canonical(normalized))}` };
    },
  };
  const filename = require.resolve("../strategy-study/compound-b-metadata"), isolated = new Module(filename, module); isolated.filename = filename; isolated.paths = module.paths;
  isolated.require = name => name === "./compound-b-metadata-codec" ? stub : require(require.resolve(name, { paths: [path.dirname(filename)] }));
  isolated._compile(fs.readFileSync(filename, "utf8"), filename); const collector = isolated.exports;
  const parent = collector.loadMetadataParent({ readCensus: () => census, readForensic: () => ({ manifestSha256: metadata.B1F_SHA256, manifest: { forensicObservation: { universeIndex: 41, publicCallBytes: [{ input: parsed.data }] } } }) });
  const cliName = require.resolve("../strategy-study/compound-b-metadata-cli"), cliModule = new Module(cliName, module); cliModule.filename = cliName; cliModule.paths = module.paths;
  cliModule.require = name => name === "./compound-b-metadata" ? collector : require(require.resolve(name, { paths: [path.dirname(cliName)] })); cliModule._compile(fs.readFileSync(cliName, "utf8"), cliName);
  const rpcHeaders = headers.map(h => ({ ...h, number: q(h.number), timestamp: q(h.timestamp), baseFeePerGas: q(BigInt(parent.transaction.gasPrice) - BigInt(parent.transaction.maxPriorityFeePerGas)) }));
  const bodies = headers[1].transactions.map((hash, i) => i === 113 ? parent.transactionBody : { hash, blockHash: headers[1].hash, blockNumber: q(headers[1].number), transactionIndex: q(i), input: "0x", from: `0x${"11".repeat(20)}` });
  context = { collector, cli: cliModule.exports, parent, headers: rpcHeaders, bodies, stub }; return context;
}
function collectorFixture(hook = () => null, extra = {}) {
  const c = syntheticContext();
  const f = runtimeFixture((req, f) => {
    let result = req.method === "eth_chainId" ? "0x1" : clone(c.headers[req.params[0] === q(metadata.ANCHORS[0].number) || req.params[0] === metadata.ANCHORS[0].hash ? 0 : 1]);
    if (req.params[1] === true) result.transactions = clone(c.bodies);
    return hook(req, result, f) || { result };
  }, extra);
  f.run = () => { const { purpose, chainId, backoff, onTransportDiagnostic, ...runtimeOptions } = f.options; return c.collector.runCompoundBMetadata({ parent: c.parent, runtimeOptions }); };
  f.runB3M = () => { const { purpose, chainId, backoff, onTransportDiagnostic, ...runtimeOptions } = f.options; return c.collector.runCompoundBMetadataB3M({ parent: c.parent, runtimeOptions }); };
  return f;
}
test("synthetic full-pool barriers precede immutable first independent pair and all eight rechecks", async () => {
  const c = syntheticContext(), f = collectorFixture(), result = await f.run();
  assert.equal(result.status, "METADATA-VALID"); assert.equal(result.operations.length, 20); assert.deepEqual(result.state.selectedAliases, ["obs-01", "obs-02"]);
  assert.deepEqual(result.operations.slice(0, 9).map(o => o.phase), ["chain", "parent", "target", "chain", "parent", "target", "chain", "parent", "target"]);
  assert.ok(result.operations.slice(9, 12).every(o => o.phase === "full")); assert.equal(result.operations.slice(12).length, 8);
  assert.equal(result.facts.filter(f => f.kind === "transaction").length, c.bodies.length); assert.equal(result.prefixComplete, true); assert.deepEqual(result.authority, metadata.AUTHORITY);
  c.collector.validateCompoundBMetadata(result, c.parent); assert.equal(result.runtimeDrained, true); assert.ok(!JSON.stringify(result).includes("alchemy"));
});
test("synthetic facts survive later retirement, malformed prefix, late contradiction and post-selection failure", async () => {
  const c = syntheticContext();
  for (const mode of ["retired-contradiction", "malformed-prefix", "late-full", "recheck"]) {
    const f = collectorFixture((req, result) => {
      if (mode === "retired-contradiction") {
        if (req.index === 0 && req.method === "eth_getBlockByNumber" && req.params[0] === q(metadata.ANCHORS[1].number)) return { error: { code: -32601, message: SENTINEL } };
        if (req.index === 2 && req.params[0] === q(metadata.ANCHORS[0].number)) result.stateRoot = H(123);
      }
      if (mode === "malformed-prefix" && req.params[1] === true) result.transactions[5].invalid = SENTINEL;
      if (mode === "late-full" && req.params[1] === true && req.index === 2) result.transactions[5].input = "0x1234";
      if (mode === "recheck" && req.id === 13) return { status: 403, raw: SENTINEL };
      return { result };
    });
    const result = await f.run(); assert.equal(result.status, "FAILED"); assert.equal(result.prefixComplete, false); c.collector.validateCompoundBMetadata(result, c.parent);
    assert.ok(!JSON.stringify(result).includes(SENTINEL));
    if (mode === "retired-contradiction") { assert.equal(result.state.observations[0].retirement, "provider-method-not-found"); assert.equal(result.facts.filter(f => f.kind === "header" && f.value.header.number === q(metadata.ANCHORS[0].number)).length, 2); }
    if (mode === "malformed-prefix") { assert.equal(result.facts.filter(f => f.kind === "transaction").length, 5); assert.deepEqual(result.operations.at(-1).validationFailure, { stage: "transaction", index: 5 }); }
    if (mode === "late-full") assert.equal(result.facts.filter(f => f.kind === "transaction" && f.value.body.transactionIndex === "0x5").length, 2);
    if (mode === "recheck") { assert.deepEqual(result.state.selectedAliases, ["obs-01", "obs-02"]); assert.equal(result.operations.at(-1).observationId, "obs-01"); }
  }
});
function withFeeMarketPrices(block, omit = false) {
  const base = BigInt(block.baseFeePerGas), last = block.transactions.length - 1;
  for (const [index, type] of [[0, "0x2"], [1, "0x3"], [2, "0x4"], [last, "0x3"]]) Object.assign(block.transactions[index], {
    type, maxPriorityFeePerGas: "0xa", maxFeePerGas: q(base + (index === 1 ? 5n : 20n)),
  });
  for (const index of [0, 1, 2, 113, last]) {
    const body = block.transactions[index], offered = base + BigInt(body.maxPriorityFeePerGas), cap = BigInt(body.maxFeePerGas);
    if (!omit) body.gasPrice = q(offered < cap ? offered : cap); else delete body.gasPrice;
  }
}
test("fee-market price observations survive codec omission and bind types 2-4, cap branch, suffix and C2 B", async () => {
  const c = syntheticContext(), f = collectorFixture((req, result) => {
    if (req.params[1]) withFeeMarketPrices(result, req.index === 1); return { result };
  }), result = await f.run();
  assert.equal(result.status, "METADATA-VALID"); c.collector.validateCompoundBMetadata(result, c.parent);
  const fees = result.facts.filter(f => f.kind === "effective-gas-price"); assert.equal(fees.length, 10);
  assert.ok(fees.some(f => f.value.reportedGasPrice === null)); assert.ok(fees.some(f => f.value.reportedGasPrice === f.value.derivedGasPrice));
  assert.ok(result.facts.filter(f => f.kind === "transaction" && ["0x2", "0x3", "0x4"].includes(f.value.body.type)).every(f => !Object.hasOwn(f.value.body, "gasPrice")));
  assert.equal(fees.find(f => f.value.transactionIndex === q(113)).value.derivedGasPrice, q(c.parent.transaction.gasPrice));
  assert.equal(fees.find(f => f.value.transactionIndex === "0x1").value.derivedGasPrice, q(BigInt(c.headers[1].baseFeePerGas) + 5n));
  for (const index of [0, 1, 2, 113, c.bodies.length - 1]) {
    const bad = collectorFixture((req, block) => {
      if (req.params[1]) { withFeeMarketPrices(block); if (req.index === 2) {
        const tx = block.transactions[index], value = BigInt(tx.gasPrice); tx.gasPrice = q(value + (value === BigInt(tx.maxFeePerGas) ? -1n : 1n));
      } } return { result: block };
    }), failed = await bad.run();
    assert.equal(failed.reason, "consensus-mismatch"); assert.equal(failed.prefixComplete, false); assert.equal(failed.state.selectedAliases.length, 0);
    c.collector.validateCompoundBMetadata(failed, c.parent);
    const observed = failed.facts.filter(f => f.kind === "effective-gas-price" && f.value.transactionIndex === q(index)); assert.equal(observed.length, 2);
    assert.ok(observed.some(f => f.value.reportedGasPrice !== f.value.derivedGasPrice)); assert.equal(failed.operations.at(-1).observationId, "obs-03");
  }
  const badC2 = collectorFixture((req, block) => {
    if (req.method !== "eth_chainId" && block.hash === metadata.ANCHORS[1].hash) block.baseFeePerGas = q(BigInt(block.baseFeePerGas) + 1n);
    return { result: block };
  }), failed = await badC2.run();
  assert.equal(failed.reason, "consensus-mismatch"); c.collector.validateCompoundBMetadata(failed, c.parent);
  const bFee = failed.facts.find(f => f.kind === "effective-gas-price" && f.value.transactionIndex === q(113));
  assert.equal(bFee.value.reportedGasPrice, null); assert.notEqual(bFee.value.derivedGasPrice, q(c.parent.transaction.gasPrice));
});
test("strict reader recomputes retained fee observations and requires one after each fee-market envelope", async () => {
  const c = syntheticContext(), f = collectorFixture((req, block) => { if (req.params[1]) withFeeMarketPrices(block); return { result: block }; });
  const result = await f.run(), root = fs.mkdtempSync(path.join(TEMP, "metadata-fee-reader-")), out = path.join(root, "capture");
  try {
    c.cli.createCompoundBMetadataWriter(out).publish({ ...result, adapterDisposed: true }, c.parent, f.now);
    const file = path.join(out, cli.FILE), original = JSON.parse(fs.readFileSync(file));
    const read = () => c.cli.readCompoundBMetadata(out, {}, { loadMetadataParent: () => c.parent }); assert.equal(read().prefix.length, 114);
    for (const field of ["baseFeePerGas", "derivedGasPrice", "reportedGasPrice", "transactionHash", "remove"]) {
      const changed = clone(original), fact = changed.facts.find(f => f.kind === "effective-gas-price" && f.value.transactionIndex === "0x1"), oldId = fact.id;
      if (field === "remove") { changed.facts = changed.facts.filter(f => f.id !== oldId); changed.operations.forEach(o => { o.factRefs = o.factRefs.filter(id => id !== oldId); }); }
      else {
        fact.value[field] = field === "transactionHash" ? H(99) : q(BigInt(fact.value[field]) + 1n); fact.id = `fact-${capture.sha256(capture.canonical({ kind: fact.kind, value: fact.value }))}`;
        changed.operations.forEach(o => { o.factRefs = o.factRefs.map(id => id === oldId ? fact.id : id); });
      }
      const { payloadSha256, ...body } = changed; changed.payloadSha256 = capture.sha256(capture.canonical(body)); fs.writeFileSync(file, JSON.stringify(changed)); assert.throws(read, /invalid-schema/);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("synthetic reader rejects changed facts, phase barriers, flags, timing, selection and authority after payload rehash", async () => {
  const c = syntheticContext(), f = collectorFixture(), result = await f.run(), base = fs.mkdtempSync(path.join(TEMP, "metadata-reader-")), out = path.join(base, "capture");
  try {
    const writer = c.cli.createCompoundBMetadataWriter(out), published = writer.publish({ ...result, adapterDisposed: true }, c.parent, f.now);
    const read = () => c.cli.readCompoundBMetadata(out, {}, { loadMetadataParent: () => c.parent }); assert.equal(read().manifestSha256, published.manifestSha256); assert.equal(read().prefix.length, 114);
    assert.throws(() => writer.publish(result, c.parent, f.now), /output-unavailable/); assert.throws(() => c.cli.createCompoundBMetadataWriter(out), /output-unavailable/);
    const file = path.join(out, cli.FILE), original = JSON.parse(fs.readFileSync(file));
    for (const mutate of [m => { m.facts[0].value = "0x2"; }, m => { m.facts.pop(); }, m => { m.operations[10].phase = "target"; }, m => { [m.operations[1], m.operations[9]] = [m.operations[9], m.operations[1]]; },
      m => { m.operations[0].transport[0].startedAt = "2026-10-22T00:00:00.000Z"; }, m => { m.expiresAt = "2026-10-23T00:00:00Z"; }, m => { m.state.selectedAliases = ["obs-02", "obs-03"]; },
      m => { m.state.basicPoolComplete = false; }, m => { m.budget.bytes--; }, m => { m.backoff.successes--; }, m => { m.authority.historicalReplayQualified = true; }, m => { m.prefixComplete = false; }, m => { m.adapterDisposed = false; }, m => { m.extra = SENTINEL; }]) {
      const changed = clone(original); mutate(changed); const { payloadSha256, ...body } = changed; changed.payloadSha256 = capture.sha256(capture.canonical(body)); fs.writeFileSync(file, JSON.stringify(changed));
      assert.throws(read, /invalid-schema/);
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
test("synthetic 429 retirement has causal evidence; budgets/expiry remain global and failed terminal files stay readable", async () => {
  const c = syntheticContext();
  for (const mode of ["rate", "cooldown", "budget", "expired", "malformed"]) {
    const f = collectorFixture((req, result, f) => {
      if (["rate", "cooldown"].includes(mode) && req.index === 0) return { status: 429, raw: SENTINEL, headers: { "retry-after": mode === "cooldown" ? "1000" : "1" } };
      if (mode === "expired") f.setNow(Date.parse(metadata.EXPIRES_AT));
      if (mode === "malformed" && req.params[1]) result.transactions[2].invalid = SENTINEL;
      return { result };
    }, mode === "budget" ? { limits: { requests: 1 } } : {});
    const result = await f.run(); c.collector.validateCompoundBMetadata(result, c.parent);
    if (["rate", "cooldown"].includes(mode)) { assert.equal(result.status, "METADATA-VALID"); assert.deepEqual(result.state.selectedAliases, ["obs-02", "obs-03"]); }
    else { assert.equal(result.status, "FAILED"); assert.equal(result.prefixComplete, false); }
    assert.ok(!JSON.stringify(result).includes(SENTINEL));
    const root = fs.mkdtempSync(path.join(TEMP, "metadata-terminal-")), out = path.join(root, "capture");
    try {
      c.cli.createCompoundBMetadataWriter(out).publish({ ...result, adapterDisposed: true }, c.parent, f.now);
      const read = c.cli.readCompoundBMetadata(out, {}, { loadMetadataParent: () => c.parent }); assert.equal(read.manifest.status, result.status); assert.equal(read.prefix === null, result.status === "FAILED");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
  const failed = { ...c.collector.setupFailure(c.parent, "capture-failed"), adapterDisposed: true }; c.collector.validateCompoundBMetadata(failed, c.parent);
});
test("actual guarded adapter shape uses injected synthetic transport and is disposed before exclusive publication", async () => {
  const c = syntheticContext(), adapter = require("../strategy-study/authorized-inventory").parseAuthorizedInventory(candidates.map(url => `Ethereum ${url}`).join("\n"), { chainId: 1, cap: 16 });
  assert.equal(Object.getPrototypeOf(adapter), null); assert.throws(() => JSON.stringify(adapter.candidates), /process-only-provider-handles/);
  const f = collectorFixture(() => null, { candidates: adapter.candidates }); let published = false;
  const exit = await c.cli.main(["--capture-compound-b-metadata"], { preflight() {}, now: f.now, loadMetadataParent: () => c.parent, loadAuthorizedCandidates: () => adapter,
    runCompoundBMetadata: ({ parent, runtimeOptions }) => { assert.equal(runtimeOptions.candidates, adapter.candidates); const { purpose, chainId, backoff, onTransportDiagnostic, ...offline } = f.options;
      return c.collector.runCompoundBMetadata({ parent, runtimeOptions: { ...runtimeOptions, fetch: offline.fetch, sleep: offline.sleep, backoffRandom: offline.backoffRandom } }); },
    createCompoundBMetadataWriter() { return { publish(result) { assert.equal(adapter.candidates.length, 0); assert.equal(result.adapterDisposed, true); c.collector.validateCompoundBMetadata(result, c.parent); published = true; return { metadataComplete: result.metadataComplete }; } }; }, print() {} });
  assert.equal(exit, 0); assert.equal(published, true);
});
test("real CLI preflight rejects extra options and collision without loading inventory or resolving codec", () => {
  const root = fs.mkdtempSync(path.join(TEMP, "metadata-cli-")), preload = path.join(root, "preload.cjs");
  try {
    fs.writeFileSync(preload, `const M=require('node:module'),fs=require('node:fs');const old=M._load;M._load=function(n,...a){if(/authorized-inventory|shared-rpc|compound-b-metadata-codec/.test(n))throw new Error('FORBIDDEN_MODULE_SENTINEL');return old.call(this,n,...a)};const l=fs.lstatSync;fs.lstatSync=function(p,...a){if(String(p).endsWith('b2m-compound-ethereum'))return {isDirectory:()=>true};return l.call(this,p,...a)};`);
    for (const args of [["--capture-compound-b-metadata"], ["--capture-compound-b-metadata", "--out=x"], ["--capture-compound-b-metadata", "--expiry=2030"]]) {
      const r = cp.spawnSync(process.execPath, ["--require", preload, require.resolve("../strategy-study/compound-b-metadata-cli"), ...args], { encoding: "utf8", timeout: 10000, windowsHide: true });
      assert.equal(r.status, 2); assert.equal(r.stderr, ""); assert.equal(JSON.parse(r.stdout).reason, args.length === 1 ? "output-unavailable" : "invalid-options"); assert.ok(!r.stdout.includes("SENTINEL"));
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("actual authenticated C2 parent and signed B/B1F bindings load after old expiry using the real codec", t => {
  if (!fs.existsSync(path.join(__dirname, "../strategy-study/compound-b-metadata-codec.js"))) return t.skip("parallel codec implementation not yet available");
  const parent = metadata.loadMetadataParent(); assert.equal(parent.headers[0].hash, metadata.ANCHORS[0].hash); assert.equal(parent.headers[1].transactions[113], metadata.FIXTURE.txHash);
  assert.equal((parent.rawTransaction.length - 2) / 2, 629); assert.equal(metadata.checkParent(parent), parent); assert.throws(() => metadata.checkParent(clone(parent)), /invalid-schema/);
});

const nullIdError = () => ({ raw: JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32601, message: SENTINEL, data: { [SENTINEL]: SENTINEL } } }) });
test("B3M exact admission preserves original invalid-schema and all-pool/two-family/full-body barriers; v1 remains fatal", async () => {
  const c = syntheticContext();
  for (const rejected of [0, 2]) {
    const f = collectorFixture(req => req.index === rejected ? nullIdError() : null), m = await f.runB3M();
    assert.equal(m.schema, metadata.B3M_SCHEMA); assert.equal(m.admissionPolicy, metadata.B3M_POLICY); assert.equal(m.status, "METADATA-VALID");
    const op = m.operations.find(o => o.observationId === `obs-0${rejected + 1}`); assert.equal(op.code, "invalid-schema"); assert.equal(op.admissionReason, "UNQUALIFIED_TRANSPORT");
    assert.equal(m.state.observations[rejected].retirement, "invalid-schema"); assert.equal(op.response, "transport"); assert.deepEqual(op.factRefs, []);
    assert.equal(f.calls.filter(req => req.index === rejected).length, 1); assert.equal(m.operations.filter(o => o.phase === "full").length, 2);
    const firstFull = m.operations.findIndex(o => o.phase === "full"); assert.ok(m.operations.slice(0, firstFull).some(o => o.observationId === "obs-03"));
    assert.deepEqual(m.state.selectedAliases, rejected === 0 ? ["obs-02", "obs-03"] : ["obs-01", "obs-02"]);
    c.collector.validateCompoundBMetadataB3M(m, c.parent); assert.throws(() => c.collector.validateCompoundBMetadata(m, c.parent), /invalid-schema/);
    assert.ok(!JSON.stringify(m).includes(SENTINEL)); assert.deepEqual(m.authority, metadata.AUTHORITY);
    for (const o of m.operations.filter(o => o.method !== "eth_chainId")) for (const e of o.transport) assert.equal(Object.hasOwn(e, "admissionEnvelope"), false);
  }
  const v1 = await collectorFixture(req => req.index === 0 ? nullIdError() : null).run(); assert.equal(v1.reason, "invalid-schema"); assert.equal(v1.operations.length, 1); c.collector.validateCompoundBMetadata(v1, c.parent);
  const sameFamily = collectorFixture(req => req.index === 0 ? nullIdError() : null, { candidates: [candidates[0], candidates[1], candidates[1] + "-second"] });
  const failed = await sameFamily.runB3M(); assert.equal(failed.reason, "independent-pair-unavailable"); assert.equal(failed.state.qualificationComplete, true);
  assert.equal(failed.operations.filter(o => o.phase === "full").length, 2); c.collector.validateCompoundBMetadataB3M(failed, c.parent);
});
test("B3M non-predicate malformed chains and post-identity material failures remain global; accepted facts survive", async () => {
  const c = syntheticContext();
  for (const mode of ["both", "unknown-keys", "message", "invalid-json", "empty-body", "postidentity", "partial-prefix", "retired-contradiction", "late-full", "final-recheck"]) {
    const f = collectorFixture((req, result) => {
      if (["both", "unknown-keys", "message"].includes(mode) && req.index === 0) {
        const raw = JSON.parse(nullIdError().raw); if (mode === "both") raw.result = "0x1"; if (mode === "unknown-keys") raw.error[SENTINEL] = SENTINEL; if (mode === "message") raw.error.message = 1;
        return { raw: JSON.stringify(raw) };
      }
      if (mode === "invalid-json") return { raw: SENTINEL };
      if (mode === "empty-body") return { raw: "" };
      if (mode === "postidentity" && req.index === 0 && req.method !== "eth_chainId") return nullIdError();
      if (["partial-prefix", "late-full", "final-recheck"].includes(mode) && req.index === 0) return nullIdError();
      if (mode === "partial-prefix" && req.params[1]) result.transactions[5].invalid = SENTINEL;
      if (mode === "late-full" && req.params[1] && req.index === 2) result.transactions[5].input = "0x1234";
      if (mode === "final-recheck" && req.id === 10) return nullIdError();
      if (mode === "retired-contradiction") {
        if (req.index === 0 && req.params[0] === q(metadata.ANCHORS[1].number)) return { error: { code: -32601, message: SENTINEL } };
        if (req.index === 2 && req.params[0] === q(metadata.ANCHORS[0].number)) result.stateRoot = H(123);
      }
      return { result };
    });
    const m = await f.runB3M(); assert.equal(m.status, "FAILED", mode); c.collector.validateCompoundBMetadataB3M(m, c.parent);
    assert.equal(m.operations.at(-1).admissionReason, null); assert.ok(!JSON.stringify(m).includes(SENTINEL));
    if (mode === "postidentity") { assert.equal(m.operations[0].factRefs.length, 1); assert.equal(m.operations.length, 2); }
    if (mode === "partial-prefix") assert.equal(m.facts.filter(f => f.kind === "transaction").length, 5);
    if (mode === "retired-contradiction") assert.equal(m.facts.filter(f => f.kind === "header" && f.value.header.number === q(metadata.ANCHORS[0].number)).length, 2);
    if (mode === "late-full") assert.equal(m.facts.filter(f => f.kind === "transaction" && f.value.body.transactionIndex === "0x5").length, 2);
    if (mode === "final-recheck") assert.deepEqual(m.state.selectedAliases, ["obs-02", "obs-03"]);
  }
});
test("B3M global failure after a shape cannot retire that candidate; failed terminal remains readable", async () => {
  const c = syntheticContext();
  for (const mode of ["budget", "expiry", "elapsed", "oversize"]) {
    const f = collectorFixture((req, result, f) => { if (mode === "expiry") f.setNow(Date.parse(metadata.EXPIRES_AT)); if (mode === "elapsed") f.setNow(START + 600000); return nullIdError(); },
      mode === "budget" ? { limits: { requests: 1 } } : mode === "oversize" ? { limits: { responseBytes: 1 } } : {}), m = await f.runB3M();
    assert.equal(m.status, "FAILED"); assert.equal(m.operations.length, 1); assert.equal(m.operations[0].admissionReason, null); assert.equal(m.state.observations[0].retirement, null);
    c.collector.validateCompoundBMetadataB3M(m, c.parent);
    const root = fs.mkdtempSync(path.join(TEMP, "b3m-failed-")), out = path.join(root, "capture");
    try {
      c.cli.createCompoundBMetadataB3MWriter(out).publish({ ...m, adapterDisposed: true }, c.parent, f.now);
      const read = c.cli.readCompoundBMetadataB3M(out, {}, { loadMetadataParent: () => c.parent }); assert.equal(read.prefix, null); assert.equal(read.manifest.status, "FAILED");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});
for (const status of [201, 202]) test(`B3M HTTP${status} null-ID structural failure is fatal and publishes a readable FAILED terminal`, async () => {
  const c = syntheticContext(), f = collectorFixture(() => ({ status,
    raw: JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32601, message: "offline diagnostic" } }),
  })), m = await f.runB3M();
  assert.equal(m.status, "FAILED"); assert.equal(m.reason, "invalid-schema"); assert.equal(m.runtimeDrained, true);
  assert.equal(m.operations.length, 1); assert.equal(f.calls.length, 1); assert.deepEqual(m.facts, []);
  const op = m.operations[0]; assert.equal(op.code, "invalid-schema"); assert.equal(op.response, "transport"); assert.deepEqual(op.factRefs, []);
  assert.equal(op.validationFailure, null); assert.equal(op.admissionReason, null); assert.equal(m.state.observations[0].retirement, null);
  assert.equal(op.transport.length, 1); assert.equal(op.transport[0].code, "invalid-schema"); assert.equal(op.transport[0].httpStatus, status);
  assert.equal(op.transport[0].admissionEnvelope.shape.category, "invalid-id"); c.collector.validateCompoundBMetadataB3M(m, c.parent);
  const root = fs.mkdtempSync(path.join(TEMP, "b3m-http-failed-")), out = path.join(root, "capture");
  try {
    const published = c.cli.createCompoundBMetadataB3MWriter(out).publish({ ...m, adapterDisposed: true }, c.parent, f.now);
    assert.equal(published.status, "FAILED"); assert.equal(published.metadataComplete, false);
    const read = c.cli.readCompoundBMetadataB3M(out, { expectedManifestSha256: published.manifestSha256 }, { loadMetadataParent: () => c.parent });
    assert.equal(read.manifest.status, "FAILED"); assert.equal(read.manifest.reason, "invalid-schema"); assert.equal(read.prefix, null);
    assert.equal(read.manifest.operations[0].admissionReason, null); assert.equal(read.manifest.operations[0].transport[0].httpStatus, status);
    assert.deepEqual(read.manifest.authority, metadata.AUTHORITY);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("B3M internal callback failure after retaining a diagnostic is fatal, not UNQUALIFIED_TRANSPORT", async () => {
  const c = syntheticContext(), original = capture.createRuntime;
  try {
    capture.createRuntime = options => original({ ...options, onTransportDiagnostic(event) { options.onTransportDiagnostic(event); throw new Error(SENTINEL); } });
    const m = await collectorFixture(() => nullIdError()).runB3M(); assert.equal(m.reason, "capture-failed"); assert.equal(m.operations.length, 1);
    assert.equal(m.operations[0].transport[0].code, "invalid-schema"); assert.equal(m.operations[0].code, "capture-failed"); assert.equal(m.operations[0].admissionReason, null);
    assert.equal(m.state.observations[0].retirement, null); assert.equal(m.metadataComplete, false); c.collector.validateCompoundBMetadataB3M(m, c.parent);
    assert.ok(!JSON.stringify(m).includes(SENTINEL));
  } finally { capture.createRuntime = original; }
});
test("B3M strict reader rejects transplanted flags, erased refs, later retired traffic, pool/pair tampering after rehash", async () => {
  const c = syntheticContext(), f = collectorFixture(req => req.index === 0 ? nullIdError() : null), m = await f.runB3M();
  const root = fs.mkdtempSync(path.join(TEMP, "b3m-reader-")), out = path.join(root, "capture");
  try {
    const writer = c.cli.createCompoundBMetadataB3MWriter(out); writer.publish({ ...m, adapterDisposed: true }, c.parent, f.now);
    const file = path.join(out, cli.FILE), original = JSON.parse(fs.readFileSync(file)), read = () => c.cli.readCompoundBMetadataB3M(out, {}, { loadMetadataParent: () => c.parent });
    assert.equal(read().prefix.length, 114); assert.throws(() => c.cli.readCompoundBMetadata(out, {}, { loadMetadataParent: () => c.parent }), /invalid-schema/);
    assert.throws(() => c.cli.createCompoundBMetadataB3MWriter(out), /output-unavailable/);
    for (const mutate of [m => { m.admissionPolicy = "relaxed"; }, m => { m.schema = metadata.SCHEMA; }, m => { m.operations[0].admissionReason = null; },
      m => { m.operations[0].transport[0].admissionEnvelope.requestId = 2; }, m => { m.operations[0].transport[0].admissionEnvelope.observationId = "obs-02"; },
      m => { m.operations[1].transport[0].admissionEnvelope = clone(m.operations[0].transport[0].admissionEnvelope); },
      m => { m.operations[0].transport[0].admissionEnvelope.shape.resultPresent = true; m.operations[0].transport[0].admissionEnvelope.shape.resultType = "string"; },
      m => { m.operations[0].code = "request-budget-exhausted"; }, m => { m.operations[1].factRefs = []; },
      m => { m.operations[2].factRefs = []; }, m => { m.operations[1].admissionReason = "UNQUALIFIED_TRANSPORT"; },
      m => { m.operations[2].transport[0].admissionEnvelope = clone(m.operations[0].transport[0].admissionEnvelope); },
      m => { const op = clone(m.operations[2]); op.observationId = "obs-01"; op.transport.forEach(e => { e.observationId = "obs-01"; }); m.operations.splice(1, 0, op); },
      m => { m.operations.splice(m.operations.findIndex(o => o.phase === "full"), 1); }, m => { m.state.basicPoolComplete = false; },
      m => { m.state.independence[1][2] = false; m.state.independence[2][1] = false; }, m => { m.state.selectedAliases = ["obs-01", "obs-03"]; },
      m => { m.state.selectedAliases.reverse(); }, m => { m.authority.historicalReplayQualified = true; }]) {
      const changed = clone(original); mutate(changed); const { payloadSha256, ...body } = changed; changed.payloadSha256 = capture.sha256(capture.canonical(body)); fs.writeFileSync(file, JSON.stringify(changed)); assert.throws(read, /invalid-schema/);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("B3M fixed explicit CLI routes separately, reserves before adapter and disposes before publication", async () => {
  const snapshotB3M = () => {
    const file = path.join(cli.B3M_OUTPUT, cli.FILE);
    return { listing: fs.existsSync(cli.B3M_OUTPUT) ? fs.readdirSync(cli.B3M_OUTPUT).sort() : null,
      artifactSha256: fs.existsSync(file) ? capture.sha256(fs.readFileSync(file)) : null };
  }, before = snapshotB3M();
  try {
    if (before.artifactSha256 !== null) assert.equal(before.artifactSha256, "64ea5dde6ef661e1e17ca4ad0960e5f1b3e9f69614979ad382a19c4d11cc77cb");
    const c = syntheticContext(), adapter = require("../strategy-study/authorized-inventory").parseAuthorizedInventory(candidates.map(url => `Ethereum ${url}`).join("\n"), { chainId: 1, cap: 16 });
    const f = collectorFixture(req => req.index === 0 ? nullIdError() : null, { candidates: adapter.candidates }), order = [];
    const exit = await c.cli.main(["--capture-compound-b-metadata-b3m"], { preflight(out) { assert.equal(out, cli.B3M_OUTPUT); order.push("fresh"); }, now: f.now,
      loadMetadataParent() { order.push("parent"); return c.parent; }, loadAuthorizedCandidates() { order.push("adapter"); return adapter; },
      createCompoundBMetadataB3MWriter(out) { assert.equal(out, cli.B3M_OUTPUT); order.push("reserve"); return { publish(m) { order.push("publish"); assert.equal(adapter.candidates.length, 0); assert.equal(m.adapterDisposed, true); c.collector.validateCompoundBMetadataB3M(m, c.parent); return { metadataComplete: m.metadataComplete }; } }; },
      runCompoundBMetadataB3M() { order.push("run"); return f.runB3M(); }, print() {} });
    assert.equal(exit, 0); assert.deepEqual(order, ["fresh", "parent", "reserve", "adapter", "run", "publish"]);
    for (const argv of [["--capture-compound-b-metadata-b3m", "--out=x"], ["--capture-compound-b-metadata-b3m", "--expiry=2030"], ["--capture-compound-b-metadata-b3m", "--capture-compound-b-metadata"]]) assert.throws(() => cli.parseArgs(argv), /invalid-options/);
    let inventory = false; const collision = await c.cli.main(["--capture-compound-b-metadata-b3m"], { preflight() { throw new Error("output-unavailable"); }, loadAuthorizedCandidates() { inventory = true; }, print() {} });
    assert.equal(collision, 2); assert.equal(inventory, false);
  } finally { assert.deepEqual(snapshotB3M(), before, "B3M output listing and artifact hash must remain unchanged"); }
});
