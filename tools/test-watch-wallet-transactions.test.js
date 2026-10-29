"use strict";

// Offline suite for the wallet-transaction collector. No network: RPC is
// injected and serialization is checked to contain no endpoint material.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const collector = require("./watch-wallet-transactions.js");

const WALLET = collector.WALLET_DEFAULT;
const FAKE_URL = "http://fake.invalid";
const PAXG = "0x45804880de22913dafe09f4980848ece6ecbaf78";
const ROUTER = `0x${"ab".repeat(20)}`;
const UNKNOWN_TOKEN = `0x${"cd".repeat(20)}`;
const KNOWN_SWAP = "0x08a7e1fb056e7804c5179c213ce7ffb0ab80866c05b2935dd969486bcc49faec";

function word(value) {
  return BigInt(value).toString(16).padStart(64, "0");
}

function encString(text) {
  const bytes = Buffer.from(text, "utf8");
  const hex = bytes.toString("hex");
  const padded = hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");
  return `0x${word(32)}${word(bytes.length)}${padded}`;
}

function hash(seed) {
  return `0x${seed.repeat(32)}`.slice(0, 66);
}

function tx({ nonce, block, seed, from = WALLET, to = ROUTER, value = "0x0", input = "0x095ea7b3", gasPrice = "0x3b9aca00" }) {
  return {
    hash: hash(seed),
    nonce: `0x${nonce.toString(16)}`,
    blockNumber: `0x${block.toString(16)}`,
    from,
    to,
    value,
    input,
    gasPrice,
  };
}

function receipt({ status = "0x1", gasUsed = "0x5208", logs = [] }) {
  return { status, gasUsed, effectiveGasPrice: "0x3b9aca00", logs };
}

function transferLog(token, from, to, raw) {
  return {
    address: token,
    topics: [collector.TRANSFER_TOPIC, `0x${from.slice(2).padStart(64, "0")}`, `0x${to.slice(2).padStart(64, "0")}`],
    data: `0x${word(raw)}`,
  };
}

// Fake chain RPC driven by a fixed transaction set. Historical nonce reads are
// derived from the mined blocks, exactly like a real archive node.
function fakeChain({ chainId, head, entries, tokenMeta = {}, failNonce = false }) {
  const byBlock = new Map();
  for (const entry of entries) {
    const blockNumber = Number(BigInt(entry.tx.blockNumber));
    if (!byBlock.has(blockNumber)) {
      byBlock.set(blockNumber, { number: blockNumber, timestamp: 1_700_000_000 + blockNumber, transactions: [] });
    }
    byBlock.get(blockNumber).transactions.push(entry.tx);
  }
  return async (_url, method, params) => {
    if (method === "eth_chainId") return `0x${chainId.toString(16)}`;
    if (method === "eth_blockNumber") return `0x${head.toString(16)}`;
    if (method === "eth_getTransactionCount") {
      if (failNonce) throw new Error("nonce boom");
      const tag = params[1];
      const block = typeof tag === "string" && tag.startsWith("0x") ? Number(BigInt(tag)) : head;
      const count = entries.filter((entry) => Number(BigInt(entry.tx.blockNumber)) <= block).length;
      return `0x${count.toString(16)}`;
    }
    if (method === "eth_getBlockByNumber") {
      const block = byBlock.get(Number(BigInt(params[0])));
      if (!block) return null;
      return {
        number: `0x${block.number.toString(16)}`,
        timestamp: `0x${block.timestamp.toString(16)}`,
        transactions: block.transactions,
      };
    }
    if (method === "eth_getTransactionReceipt") {
      const entry = entries.find((candidate) => candidate.tx.hash.toLowerCase() === String(params[0]).toLowerCase());
      return entry ? { ...entry.receipt, transactionHash: entry.tx.hash, blockNumber: entry.tx.blockNumber } : null;
    }
    if (method === "eth_call") {
      const address = String(params[0].to).toLowerCase();
      const meta = tokenMeta[address];
      if (!meta) return null;
      if (params[0].data.startsWith("0x95d89b41")) return meta.symbolHex;
      if (params[0].data.startsWith("0x313ce567")) return meta.decimalsHex;
      return null;
    }
    return null;
  };
}

test("parseArgs accepts --once and --check and rejects anything else", () => {
  assert.deepEqual(collector.parseArgs([]), { check: false, once: true });
  assert.deepEqual(collector.parseArgs(["--once"]), { check: false, once: true });
  assert.deepEqual(collector.parseArgs(["--check"]), { check: true, once: false });
  assert.throws(() => collector.parseArgs(["--bogus"]), (error) => error.code === "USAGE");
  assert.throws(() => collector.parseArgs(["--once", "--check"]), (error) => error.code === "USAGE");
});

test("formatUnits trims and caps the fraction, rejecting bad decimals", () => {
  assert.equal(collector.formatUnits("0", 18), "0");
  assert.equal(collector.formatUnits("1000000000000000000", 18), "1");
  assert.equal(collector.formatUnits("1500000000", 6), "1500");
  assert.equal(collector.formatUnits("1773055312239924", 18), "0.00177305");
  assert.equal(collector.formatUnits("1", 0), "1");
  assert.equal(collector.formatUnits("1", 40), null);
  assert.equal(collector.formatUnits("nope", 18), null);
});

test("symbol and decimals decoding tolerates dynamic strings and bytes32", () => {
  assert.equal(collector.decodeSymbol(encString("USDC")), "USDC");
  assert.equal(collector.decodeSymbol(`0x${Buffer.from("DAI", "utf8").toString("hex").padEnd(64, "0")}`), "DAI");
  assert.equal(collector.decodeSymbol("0x"), null);
  assert.equal(collector.decodeDecimals(`0x${word(6)}`), 6);
  assert.equal(collector.decodeDecimals("0x"), null);
});

test("hex helpers convert block tags and timestamps safely", () => {
  assert.equal(collector.hexToDecimal("0x0de0b6b3a7640000"), "1000000000000000000");
  assert.equal(collector.hexToDecimal("0xz"), null);
  assert.equal(collector.numberOrNull("0x10"), 16);
  assert.equal(collector.numberOrNull("nope"), null);
  assert.equal(collector.timestampIso("0x6553f100"), new Date(1_700_000_000 * 1000).toISOString());
  assert.equal(collector.timestampIso("0x0"), null);
});

test("decodeTransfer keeps only wallet-relevant ERC20 transfers", () => {
  const other = `0x${"ee".repeat(20)}`;
  const incoming = transferLog(PAXG, other, WALLET, "1000");
  const outgoing = transferLog(PAXG, WALLET, other, "2000");
  const unrelated = transferLog(PAXG, other, other, "3000");
  assert.deepEqual(collector.decodeTransfer(incoming, WALLET), { token: PAXG, raw: "1000", direction: "in" });
  assert.deepEqual(collector.decodeTransfer(outgoing, WALLET), { token: PAXG, raw: "2000", direction: "out" });
  assert.equal(collector.decodeTransfer(unrelated, WALLET), null);
  assert.equal(collector.decodeTransfer({ topics: [] }, WALLET), null);
});

test("describeTx labels the known batch transactions and classifies the rest", () => {
  assert.match(collector.describeTx(KNOWN_SWAP, { to: ROUTER }, "0x", false, false), /swap ETH/);
  assert.equal(
    collector.describeTx(
      "0xf3a45d2ec84e7661c41ee690dfe841ab184f5dd906fa2b24a483cb633c030219",
      { to: ROUTER },
      "0x095ea7b3",
      false,
      false
    ),
    "PAXG collateral approval \u2192 Morpho Blue"
  );
  assert.equal(collector.describeTx(hash("11"), { to: ROUTER }, "0x095ea7b3", false, false), "Contract interaction \u00b7 approve");
  assert.equal(collector.describeTx(hash("11"), { to: ROUTER }, "0xdeadbeef", false, true), "Token transfer");
  assert.equal(collector.describeTx(hash("11"), { to: ROUTER }, "0xdeadbeef", false, false), "Contract interaction");
  assert.equal(collector.describeTx(hash("11"), { to: null }, "0x", false, false), "Contract deployment");
  assert.equal(collector.describeTx(hash("11"), { to: ROUTER }, "0x", true, false), "ETH transfer");
});

test("resolveTokenMeta uses the registry and falls back on-chain, fail-closed", async () => {
  const cache = new Map();
  const errors = [];
  const meta = await collector.resolveTokenMeta(1, PAXG, async () => null, FAKE_URL, cache, collector.TOKEN_REGISTRY, errors);
  assert.deepEqual(meta, { symbol: "PAXG", decimals: 18 });
  assert.deepEqual(errors, []);

  const call = async (_url, method) => {
    if (method !== "eth_call") return null;
    return null;
  };
  const unknown = await collector.resolveTokenMeta(1, UNKNOWN_TOKEN, call, FAKE_URL, cache, collector.TOKEN_REGISTRY, errors);
  assert.deepEqual(unknown, { symbol: null, decimals: null });
  assert.deepEqual(errors, [{ scope: "token", message: `TOKEN_META_UNRESOLVED:${UNKNOWN_TOKEN.slice(0, 10)}` }]);
});

function entriesFixture() {
  return [
    { tx: tx({ nonce: 0, block: 150, seed: "0a" }), receipt: receipt({}) },
    {
      tx: tx({ nonce: 1, block: 190, seed: "0b", value: "0x0de0b6b3a7640000", input: "0x7ff36ab5" }),
      receipt: receipt({
        gasUsed: "0x20b34",
        logs: [
          transferLog(PAXG, `0x${"ab".repeat(20)}`, WALLET, "1773055312239924"),
          { address: UNKNOWN_TOKEN, topics: [`0x${"00".repeat(32)}`], data: "0x" },
        ],
      }),
    },
    { tx: tx({ nonce: 2, block: 195, seed: "0c", input: "0xdeadbeef" }), receipt: receipt({ status: "0x0" }) },
  ];
}

test("resolution rejects recent-only and wrong-chain nodes and retains bounded deep-read alternatives", async () => {
  const urls = ["recent", "wrong-chain", "archive-a", "archive-b", "archive-c", "archive-d"];
  const calls = [];
  const call = async (url, method, params) => {
    calls.push({ url, method, params });
    if (method === "eth_chainId") return url === "wrong-chain" ? "0x38" : "0x2105";
    if (method === "eth_blockNumber") return "0xf4240"; // 1,000,000
    if (method === "eth_getTransactionCount") {
      const block = Number(BigInt(params[1]));
      // This provider passes the old 5,000-block probe and even genesis, but
      // cannot supply intermediate historical state used by the search.
      if (url === "recent" && block > 0 && block < 995000) return null;
      return block < 900000 ? "0x0" : "0x8";
    }
    return null;
  };
  const result = await collector.resolveEndpoints([8453], WALLET, { urls, fallbacks: {}, call, now: () => 0 });
  assert.deepEqual(result.get(8453), ["archive-a", "archive-b", "archive-c"]);
  assert.equal(calls.some((row) => row.url === "wrong-chain" && row.method !== "eth_chainId"), false);
  assert.equal(calls.some((row) => row.url === "recent" && row.params[1] === "0x7a120"), true);
  assert.equal(calls.filter((row) => row.method === "eth_chainId").length, urls.length);
});

test("qualification reserves bounded public fallbacks and stops RPC calls at the deadline", async () => {
  const chain = fakeChain({ chainId: 1, head: 200, entries: entriesFixture() });
  const resolved = await collector.resolveEndpoints([1], WALLET, {
    urls: ["unavailable", "outside-cap"], maxCandidates: 1, fallbacks: { 1: FAKE_URL },
    call: (url, ...args) => url === FAKE_URL ? chain(url, ...args) : null, now: () => 0,
  });
  assert.deepEqual(resolved.get(1), [FAKE_URL]);

  let clock = 0;
  const calls = [];
  const expired = await collector.resolveEndpoints([1], WALLET, {
    urls: ["slow", "not-started"], fallbacks: {}, deadlineMs: 25, now: () => clock,
    call: async (_url, method, _params, timeoutMs) => {
      calls.push({ method, timeoutMs });
      clock = 25;
      return "0x1";
    },
  });
  assert.equal(expired.size, 0);
  assert.deepEqual(calls, [{ method: "eth_chainId", timeoutMs: 25 }]);
});

test("runOnce recovers historical nonce, full-block and receipt reads using the same pinned parameters", async () => {
  const urls = ["http://primary.invalid/key", "http://archive.invalid/key", "http://receipt.invalid/key"];
  const chain = fakeChain({ chainId: 1, head: 200, entries: entriesFixture() });
  const calls = [];
  const { artifact } = await collector.runOnce({
    chainEndpoints: new Map([[1, urls]]), chainIds: [1], now: () => 0,
    call: async (url, method, params) => {
      calls.push({ url, method, params });
      if (url === urls[0] && method === "eth_getTransactionCount" && params[1] === "0xc1") return "malformed";
      if (url === urls[0] && method === "eth_getBlockByNumber") {
        const block = await chain(url, method, params);
        return { ...block, transactions: [] }; // readable but missing the requested nonce
      }
      if (method === "eth_getTransactionReceipt") {
        if (url === urls[0]) throw new Error(`provider failure ${url}`);
        if (url === urls[1]) return { ...await chain(url, method, params), transactionHash: hash("ff") };
      }
      return chain(url, method, params);
    },
  });
  assert.equal(artifact.rowCount, 3);
  assert.equal(artifact.chains[0].collectedRowCount, 3);
  assert.deepEqual(artifact.errors, []);
  assert.deepEqual(artifact.chains[0].rows.map((row) => row.status), ["failed", "mined", "mined"]);
  const nonceAttempts = calls.filter((row) => row.method === "eth_getTransactionCount" && row.params[1] === "0xc1");
  assert.deepEqual(nonceAttempts.map((row) => row.url), urls.slice(0, 2));
  const blocks = calls.filter((row) => row.method === "eth_getBlockByNumber");
  assert.deepEqual(blocks.slice(0, 2).map((row) => row.params), [["0xc3", true], ["0xc3", true]]);
  assert.equal(blocks.filter((row) => row.url === urls[0]).length, 1);
  assert.equal(/https?:|\.invalid|provider failure/iu.test(JSON.stringify(artifact)), false);
});

test("unrecoverable historical reads retain partial rows and expose a sanitized error", async () => {
  const chain = fakeChain({ chainId: 1, head: 200, entries: entriesFixture() });
  const calls = [];
  const urls = ["primary", "archive", "last", "outside-cap"];
  const { artifact } = await collector.runOnce({
    chainEndpoints: new Map([[1, urls]]), chainIds: [1], now: () => 0,
    call: async (url, method, params) => {
      if (method === "eth_getTransactionCount" && Number(BigInt(params[1])) < 190) {
        calls.push(url);
        throw new Error("https://private.invalid/secret");
      }
      return chain(url, method, params);
    },
  });
  assert.equal(artifact.rowCount, 1);
  assert.equal(artifact.chains[0].error, "HISTORICAL_NONCE_READ_FAILED");
  assert.deepEqual(artifact.errors, [{ scope: "chain-1", message: "HISTORICAL_NONCE_READ_FAILED" }]);
  assert.deepEqual(calls, urls.slice(0, 3));
  assert.equal(/private|secret|https:/iu.test(JSON.stringify(artifact)), false);
});

test("missing full blocks and receipts remain explicit gaps after alternatives are exhausted", async () => {
  for (const failedMethod of ["eth_getBlockByNumber", "eth_getTransactionReceipt"]) {
    const chain = fakeChain({ chainId: 1, head: 200, entries: entriesFixture() });
    const { artifact } = await collector.runOnce({
      chainEndpoints: new Map([[1, ["primary", "alternate"]]]), chainIds: [1], now: () => 0,
      call: (url, method, params) => method === failedMethod ? null : chain(url, method, params),
    });
    const expected = failedMethod === "eth_getBlockByNumber" ? "BLOCK_TX_READ_FAILED" : "RECEIPT_READ_FAILED";
    assert.equal(artifact.errors.length, 3);
    assert.equal(artifact.errors.every((row) => row.message === expected), true);
    if (failedMethod === "eth_getBlockByNumber") assert.equal(artifact.rowCount, 0);
    else {
      assert.equal(artifact.rowCount, 3);
      assert.equal(artifact.chains[0].rows.every((row) => row.error === expected && row.status === "RECEIPT_UNAVAILABLE"), true);
    }
  }
});

for (const mode of ["throw", "null", "missing-status", "unsupported-status"]) {
  test(`block-included transaction with ${mode} receipt has unknown execution, not pending`, async () => {
    const entry = { tx: tx({ nonce: 0, block: 5, seed: "ab", value: "0x0" }), receipt: receipt({}) };
    const chain = fakeChain({ chainId: 1, head: 5, entries: [entry] });
    const { artifact } = await collector.runOnce({
      chainEndpoints: new Map([[1, FAKE_URL]]), chainIds: [1], now: () => 0,
      call: async (url, method, params) => {
        if (method !== "eth_getTransactionReceipt") return chain(url, method, params);
        if (mode === "throw") throw new Error("provider private diagnostic");
        if (mode === "null") return null;
        const result = await chain(url, method, params);
        if (mode === "missing-status") delete result.status;
        else result.status = "0x2";
        delete result.logs;
        return result;
      },
    });
    const row = artifact.chains[0].rows[0];
    assert.equal(row.status, "RECEIPT_UNAVAILABLE");
    assert.equal(row.hash, entry.tx.hash);
    assert.equal(row.blockNumber, 5);
    assert.equal(row.blockTimestamp, new Date(1_700_000_005_000).toISOString());
    assert.deepEqual(row.amounts, []);
    assert.equal(row.error, "RECEIPT_READ_FAILED");
    assert.equal(artifact.errors[0].message, row.error);
    assert.equal(JSON.stringify(artifact).includes("private diagnostic"), false);
  });
}

test("buildRow also refuses to infer execution from an unsupported receipt status", async () => {
  for (const status of [undefined, "0x2"]) {
    const errors = [];
    const row = await collector.buildRow({
      tx: tx({ nonce: 0, block: 5, seed: "ab" }), block: { timestamp: "0x6553f105" },
      chainId: 1, wallet: WALLET, url: FAKE_URL, cache: new Map(), registry: collector.TOKEN_REGISTRY, errors,
      call: async () => ({ status }),
    });
    assert.equal(row.status, "RECEIPT_UNAVAILABLE");
    assert.equal(row.error, "RECEIPT_READ_FAILED");
    assert.deepEqual(row.amounts, []);
    assert.equal(errors[0].message, row.error);
  }
});

test("collection does not start alternate RPC reads after the shared run deadline", async () => {
  const chain = fakeChain({ chainId: 1, head: 200, entries: entriesFixture() });
  let clock = 0;
  const calls = [];
  const { artifact } = await collector.runOnce({
    chainEndpoints: new Map([[1, ["primary", "alternate"]]]), chainIds: [1], now: () => clock, deadlineMs: 50,
    call: async (url, method, params, timeoutMs) => {
      calls.push({ url, method, timeoutMs });
      if (method === "eth_getTransactionCount" && params[1] !== "0xc8") {
        clock = 50;
        return null;
      }
      return chain(url, method, params);
    },
  });
  assert.equal(artifact.rowCount, 0);
  assert.equal(artifact.errors.length > 0, true);
  assert.equal(calls.every((row) => row.url === "primary" && row.timeoutMs <= 50), true);
  assert.equal(calls.length, 3);
});

test("runOnce enumerates nonce transitions newest-first with decoded amounts", async () => {
  const chain = fakeChain({ chainId: 1, head: 200, entries: entriesFixture() });
  const { artifact } = await collector.runOnce({
    chainEndpoints: new Map([[1, FAKE_URL]]),
    chainIds: [1],
    call: chain,
    now: () => 1_700_000_000_000,
  });
  assert.equal(artifact.schema, "exploit-rearm-canary-wallet-tx/v1");
  assert.equal(artifact.wallet, WALLET);
  assert.equal(artifact.noSigning, true);
  assert.equal(artifact.noBroadcast, true);
  assert.equal(artifact.rowCount, 3);
  assert.equal(artifact.chains.length, 1);
  const chainView = artifact.chains[0];
  assert.equal(chainView.chainId, 1);
  assert.equal(chainView.name, "ethereum");
  assert.equal(chainView.nonce, 3);
  assert.deepEqual(chainView.rows.map((row) => row.blockNumber), [195, 190, 150]);
  assert.deepEqual(chainView.rows.map((row) => row.status), ["failed", "mined", "mined"]);

  const swap = chainView.rows[1];
  assert.equal(swap.description, "Contract interaction \u00b7 swapExactETHForTokens");
  assert.equal(swap.direction, "out");
  assert.equal(swap.gasUsed, "133940");
  assert.deepEqual(
    swap.amounts.map((amount) => `${amount.direction}:${amount.formatted}:${amount.symbol}`),
    ["out:1:ETH", "in:0.00177305:PAXG"]
  );
  const approve = chainView.rows[2];
  assert.equal(approve.methodName, "approve");
  assert.equal(approve.description, "Contract interaction \u00b7 approve");
  const text = JSON.stringify(artifact);
  assert.equal(/https?:\/\//iu.test(text), false);
  assert.equal(/fake\.invalid|endpoint|authorization|api[_-]?key/iu.test(text), false);
});

test("runOnce labels the exact known batch transaction hashes", async () => {
  const entry = {
    tx: {
      hash: KNOWN_SWAP,
      nonce: "0x0",
      blockNumber: "0x5",
      from: WALLET,
      to: ROUTER,
      value: "0x0",
      input: "0x7ff36ab5",
      gasPrice: "0x3b9aca00",
    },
    receipt: receipt({}),
  };
  const chain = fakeChain({ chainId: 1, head: 5, entries: [entry] });
  const { artifact } = await collector.runOnce({
    chainEndpoints: new Map([[1, FAKE_URL]]),
    chainIds: [1],
    call: chain,
    now: () => 0,
  });
  assert.equal(artifact.chains[0].rows[0].description, collector.KNOWN_TX_LABELS[KNOWN_SWAP]);
});

test("runOnce fails closed when a chain has no endpoint or no nonce", async () => {
  const chain = fakeChain({ chainId: 1, head: 10, entries: [] });
  const noEndpoint = await collector.runOnce({
    chainEndpoints: new Map([[1, FAKE_URL]]),
    chainIds: [1, 8453],
    call: chain,
    now: () => 0,
  });
  assert.equal(noEndpoint.artifact.chains.find((row) => row.chainId === 8453).error, "NO_ENDPOINT");
  assert.equal(noEndpoint.artifact.errors.some((row) => row.message === "NO_ENDPOINT"), true);

  const nonceFailure = fakeChain({ chainId: 1, head: 10, entries: [], failNonce: true });
  const failed = await collector.runOnce({
    chainEndpoints: new Map([[1, FAKE_URL]]),
    chainIds: [1],
    call: nonceFailure,
    now: () => 0,
  });
  assert.equal(failed.artifact.chains[0].error, "NONCE_READ_FAILED");
  assert.equal(failed.artifact.rowCount, 0);
  assert.equal(failed.artifact.errors.some((row) => row.message === "NONCE_READ_FAILED"), true);
});

test("capRows keeps only the newest bounded rows across chains", () => {
  const make = (block, timestamp) => ({ blockNumber: block, blockTimestamp: timestamp, hash: `0x${"11".repeat(32)}` });
  const chains = [
    { chainId: 1, rows: [make(10, "2026-05-01T00:00:00Z"), make(30, "2026-10-01T00:00:00Z")] },
    { chainId: 8453, rows: [make(50000, "2026-04-01T00:00:00Z")] },
  ];
  const capped = collector.capRows(chains, 2);
  assert.equal(capped.reduce((total, chain) => total + chain.rows.length, 0), 2);
  assert.deepEqual(capped[0].rows.map((row) => row.blockNumber), [30, 10]);
  assert.deepEqual(capped[1].rows, []);
  assert.deepEqual(capped.map((chain) => chain.collectedRowCount), [2, 1]);
});

test("writeArtifact is atomic and round-trips the schema", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wallet-tx-"));
  try {
    const outPath = path.join(directory, "wallet-transactions.json");
    const chain = fakeChain({ chainId: 1, head: 200, entries: entriesFixture() });
    const { artifact } = await collector.runOnce({
      chainEndpoints: new Map([[1, FAKE_URL]]),
      chainIds: [1],
      call: chain,
      now: () => 0,
    });
    assert.equal(collector.writeArtifact(artifact, outPath), outPath);
    const readback = JSON.parse(fs.readFileSync(outPath, "utf8"));
    assert.equal(readback.schema, "exploit-rearm-canary-wallet-tx/v1");
    assert.equal(fs.readdirSync(directory).some((name) => name.includes(".tmp-")), false);
    assert.equal(/https?:\/\//iu.test(fs.readFileSync(outPath, "utf8")), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("token registry has lowercase addresses and verified decimals", () => {
  for (const chainId of Object.keys(collector.TOKEN_REGISTRY)) {
    for (const [address, meta] of Object.entries(collector.TOKEN_REGISTRY[chainId])) {
      assert.match(address, /^0x[0-9a-f]{40}$/u);
      assert.equal(typeof meta.symbol, "string");
      assert.equal(Number.isInteger(meta.decimals) && meta.decimals >= 0 && meta.decimals <= 36, true);
    }
  }
  assert.equal(collector.TOKEN_REGISTRY[1][PAXG].decimals, 18);
  assert.equal(collector.TOKEN_REGISTRY[8453]["0x3c0f801d5dd237c9c3e183b2de7a7e18aa6bea18"].symbol, "bwUSDC");
});
