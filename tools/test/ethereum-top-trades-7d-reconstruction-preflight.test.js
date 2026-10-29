"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const { LIMITS, buildEthereumCandidatePool, parseInventoryText } = require("../atomic/ethereum-top-trades-7d-reconstruction/collector");
const { NONZERO_EXIT_STAGES, TERMINAL_STAGES, preflightExecutionAbortObject, selectionPreflight, strictPreflightJson, validatePreflightSchema } = require("../atomic/ethereum-top-trades-7d-reconstruction/selection-preflight");
const { argumentsOf } = require("../atomic/ethereum-top-trades-7d-reconstruction/run");

function entries(groupCount = 2, aliases = 1) {
  const rows = [];
  for (let group = 0; group < groupCount; group += 1) {
    const identity = Symbol(`mock-group-${group}`);
    for (let alias = 0; alias < aliases; alias += 1) {
      rows.push({ url: `https://g${group}-a${alias}.invalid`, lineIndex: rows.length, ethereumHint: true, unsupportedMode: false, groupIdentity: identity, declaredGroup: true });
    }
  }
  return rows;
}

function budget() {
  return { requests: 0, bytes: 0, limits: { ...LIMITS } };
}

function baseCapabilities(ready = true) {
  return { chain1: ready, finalized: ready, historicalBlocks: ready, boundedLogs: ready, transaction: false, receipt: false, blockByHash: false };
}

function operations(options = {}) {
  return {
    async qualifyProvider(provider) {
      if (options.budgetStop) throw new Error("request-budget-exhausted");
      const ready = options.baseReady ? options.baseReady(provider) : true;
      return { provider, identity: ready ? { internal: true } : null, capabilities: baseCapabilities(ready), score: ready ? 56 : 0 };
    },
    async commonFinalized() {
      if (options.commonError) throw new Error(options.commonError);
      return { internal: true };
    },
    async findMutualProbeTransaction() {
      if (options.probeError) throw new Error(options.probeError);
      return { internal: true };
    },
    async qualifyTransactionData(row) {
      if (options.dataUnavailable?.(row)) return null;
      row.capabilities.transaction = true;
      row.capabilities.receipt = true;
      row.capabilities.blockByHash = true;
      return { internalConsensusValue: options.consensusValue?.(row) || 1 };
    },
    equalConsensusFields(left, right) {
      return options.consensus === false ? false : left.internalConsensusValue === right.internalConsensusValue;
    },
  };
}

async function preflight(config = {}) {
  return selectionPreflight({ inventoryEntries: config.inventoryEntries || entries(config.groupCount || 2, config.aliases || 1), budget: budget(), operations: operations(config), pairChecksCap: config.pairChecksCap });
}

test("inventory unsupported metadata resets after an entry and at section boundaries", () => {
  const parsed = parseInventoryText(`## Ethereum\n### Service One\nhttps://first.invalid\nauth-required\nhttps://second.invalid\nhttps://third.invalid\n### Service Two origin-required\nhttps://fourth.invalid\n### Service Three\nhttps://fifth.invalid`);
  assert.deepEqual(parsed.map((row) => row.unsupportedMode), [false, true, false, true, false]);
  const pool = buildEthereumCandidatePool(parsed, 4);
  assert.equal(pool.length, 3);
  assert.equal(pool[0].url.includes("first"), true);
  assert.equal(pool[1].url.includes("fifth"), true);
  assert.equal(pool[2].url.includes("third"), true);
});

test("nested chain/category headings inherit provider grouping and provider auth restrictions", () => {
  const parsed = parseInventoryText(`## Provider Alpha\norigin-required\n### Ethereum\n#### Archive Category\nhttps://alpha.invalid\n## Provider Beta\n### Ethereum\n#### Public Category\nhttps://beta-one.invalid\n##### Secondary Category\nhttps://beta-two.invalid`);
  assert.equal(parsed.length, 3);
  assert.equal(parsed.every((row) => row.declaredGroup === true), true);
  assert.equal(parsed[0].unsupportedMode, true);
  assert.equal(parsed[1].unsupportedMode, false);
  assert.equal(parsed[2].unsupportedMode, false);
  assert.notEqual(parsed[0].groupIdentity, parsed[1].groupIdentity);
  assert.equal(parsed[1].groupIdentity, parsed[2].groupIdentity);
  assert.equal(parsed.every((row) => row.ethereumHint === true), true);
});

test("same-depth sibling heading closes inherited provider and auth scope", () => {
  const parsed = parseInventoryText(`## Provider Alpha origin-required\n### Ethereum\nhttps://nested.invalid\n## Public Category\n### Ethereum\nhttps://sibling.invalid`);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].declaredGroup, true);
  assert.equal(parsed[0].unsupportedMode, true);
  assert.equal(parsed[1].declaredGroup, false);
  assert.equal(parsed[1].unsupportedMode, false);
  assert.notEqual(parsed[0].groupIdentity, parsed[1].groupIdentity);
});

test("shallower ancestor heading closes deeply nested provider and auth scope", () => {
  const parsed = parseInventoryText(`### Service Alpha header-required\n#### Ethereum\n##### Archive\nhttps://nested.invalid\n# Independent Category\n## Ethereum\nhttps://ancestor.invalid`);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].declaredGroup, true);
  assert.equal(parsed[0].unsupportedMode, true);
  assert.equal(parsed[1].declaredGroup, false);
  assert.equal(parsed[1].unsupportedMode, false);
  const pool = buildEthereumCandidatePool(parsed, 2);
  assert.equal(pool.length, 1);
  assert.equal(pool[0].groupOrdinal, "group-00");
});

test("undeclared entries never count as declared groups or independent pair members", async () => {
  const undeclared = Symbol("undeclared-mock");
  const declaredA = Symbol("declared-a");
  const declaredB = Symbol("declared-b");
  const mixed = [
    { url: "https://undeclared.invalid", lineIndex: 0, ethereumHint: true, unsupportedMode: false, groupIdentity: undeclared, declaredGroup: false },
    { url: "https://declared-a.invalid", lineIndex: 1, ethereumHint: true, unsupportedMode: false, groupIdentity: declaredA, declaredGroup: true },
    { url: "https://declared-b.invalid", lineIndex: 2, ethereumHint: true, unsupportedMode: false, groupIdentity: declaredB, declaredGroup: true },
  ];
  const ready = await selectionPreflight({ inventoryEntries: mixed, budget: budget(), operations: operations() });
  assert.equal(ready.terminalStage, "PAIR_READY");
  assert.equal(ready.counts.declaredGroups, 2);
  assert.equal(ready.candidates.find((row) => row.groupOrdinal === "group-00") != null, true);
  assert.equal(ready.pairs[0].leftGroupOrdinal === "group-00" || ready.pairs[0].rightGroupOrdinal === "group-00", false);

  const insufficient = await selectionPreflight({ inventoryEntries: mixed.slice(0, 2), budget: budget(), operations: operations() });
  assert.equal(insufficient.terminalStage, "DECLARED_GROUPS_LT_2");
  assert.equal(insufficient.counts.declaredGroups, 1);
});

test("candidate ordering prioritizes one endpoint from each declared group before aliases", () => {
  const pool = buildEthereumCandidatePool(entries(3, 2), 6);
  assert.deepEqual(pool.slice(0, 3).map((row) => row.groupOrdinal), ["group-01", "group-02", "group-03"]);
  assert.deepEqual(pool.slice(3).map((row) => row.groupOrdinal), ["group-01", "group-02", "group-03"]);
});

test("generic triple-dash provider sections remain opaque while chain/category boundaries stay conservative", () => {
  const parsed = parseInventoryText(`--- service: Section One ---\n--- Ethereum ---\nhttps://node-one.invalid/credential-token\n--- Archive ---\nhttps://node-two.invalid/secret-path\n--- Public Chains ---\n--- Ethereum ---\nhttps://public.invalid\n--- token: section-two-marker ---\n--- Ethereum ---\nhttps://node-three.invalid/key-material\nheader-required\nhttps://node-four.invalid/credential-path\n--- Additional Endpoints Inventory ---\n--- Ethereum ---\nhttps://additional.invalid`);
  assert.equal(parsed.length, 6);
  assert.deepEqual(parsed.map((row) => row.declaredGroup), [true, true, false, true, true, false]);
  assert.deepEqual(parsed.map((row) => row.unsupportedMode), [false, false, false, false, true, false]);
  assert.equal(parsed[0].groupIdentity, parsed[1].groupIdentity);
  assert.equal(parsed[3].groupIdentity, parsed[4].groupIdentity);
  assert.notEqual(parsed[0].groupIdentity, parsed[3].groupIdentity);
  assert.equal(parsed.every((row) => row.ethereumHint === true), true);
});

test("unknown triple-dash categories stay undeclared and cannot form an independent pair", async () => {
  const parsed = parseInventoryText(`--- Premium Regional Endpoints ---\n--- Ethereum ---\nhttps://category-one.invalid\n--- Secondary Regional Endpoints ---\n--- Ethereum ---\nhttps://category-two.invalid`);
  assert.equal(parsed.length, 2);
  assert.equal(parsed.every((row) => row.declaredGroup === false), true);
  const pool = buildEthereumCandidatePool(parsed, 4);
  assert.equal(new Set(pool.filter((row) => row.declaredGroup).map((row) => row.family)).size, 0);
  const result = await selectionPreflight({ inventoryEntries: parsed, budget: budget(), operations: operations() });
  assert.equal(result.terminalStage, "DECLARED_GROUPS_LT_2");
  assert.equal(result.counts.declaredGroups, 0);
  assert.equal(result.counts.distinctPairsAvailable, 0);
});

test("credential-scoped triple-dash sections form opaque groups while origin scope is skipped", async () => {
  const parsed = parseInventoryText(`--- key: synthetic-marker-one ---\n--- Ethereum ---\nhttps://credential-one.invalid/path-token\n--- project: synthetic-marker-two ---\n--- Ethereum ---\nhttps://credential-two.invalid/path-key\n--- origin: synthetic-marker-three ---\n--- Ethereum ---\nhttps://origin-scoped.invalid`);
  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed.map((row) => row.declaredGroup), [true, true, true]);
  assert.deepEqual(parsed.map((row) => row.unsupportedMode), [false, false, true]);
  assert.notEqual(parsed[0].groupIdentity, parsed[1].groupIdentity);
  const pool = buildEthereumCandidatePool(parsed, 4);
  assert.equal(pool.length, 2);
  assert.equal(pool.every((row) => row.declaredGroup), true);
  const result = await selectionPreflight({ inventoryEntries: parsed, budget: budget(), operations: operations() });
  assert.equal(result.terminalStage, "PAIR_READY");
  const serialized = strictPreflightJson(result);
  assert.equal(JSON.parse(serialized).terminalStage, "PAIR_READY");
  assert.doesNotMatch(serialized, /synthetic-marker|credential-|origin-scoped|\.invalid|https?:/i);
});

test("supported Origin scopes are eligible but remain absent from sanitized preflight output", async () => {
  const parsed = parseInventoryText(`## Provider Alpha\norigin: https://opaque-a.invalid\n### Ethereum\nhttps://rpc-a.invalid/token-path\n## Provider Beta\n--- origin: https://opaque-b.invalid ---\n### Ethereum\nhttps://rpc-b.invalid/key-path`);
  assert.equal(parsed.length, 2);
  assert.equal(parsed.every((row) => row.unsupportedMode === false), true);
  const result = await selectionPreflight({ inventoryEntries: parsed, budget: budget(), operations: operations() });
  assert.equal(result.terminalStage, "PAIR_READY");
  const sanitized = strictPreflightJson(result);
  assert.doesNotMatch(sanitized, /opaque-|rpc-|token-path|key-path|origin|https?:/i);
});

test("triple-dash request-metadata markers establish opaque unsupported provider scopes", () => {
  const markers = [
    "header: synthetic-one",
    "headers: synthetic-two",
    "authorization: synthetic-three",
    "auth: synthetic-four",
    "bearer synthetic-five",
    "x-api-key: synthetic-six",
    "header: X-Custom: synthetic-seven",
  ];
  const text = markers.map((marker, index) => `--- ${marker} ---\n--- Ethereum ---\nhttps://scoped-${index}.invalid`).join("\n");
  const parsed = parseInventoryText(text);
  assert.equal(parsed.length, markers.length);
  assert.equal(parsed.every((row) => row.declaredGroup === true), true);
  assert.equal(parsed.every((row) => row.unsupportedMode === true), true);
  assert.equal(new Set(parsed.map((row) => row.groupIdentity)).size, markers.length);
  assert.equal(buildEthereumCandidatePool(parsed, 24).length, 0);
});

test("arbitrary header metadata URLs are not parsed as RPC endpoints and remain unsupported", () => {
  const parsed = parseInventoryText(`## Provider Alpha\nheader: X-Custom: https://metadata.invalid\n### Ethereum\nhttps://rpc.invalid`);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].url.includes("rpc.invalid"), true);
  assert.equal(parsed[0].unsupportedMode, true);
  assert.equal(buildEthereumCandidatePool(parsed, 2).length, 0);
});

test("unsupported access scope inherits through nested headings and closes at a boundary", () => {
  const parsed = parseInventoryText(`--- headers: synthetic-scope ---\n--- Ethereum ---\n--- Archive ---\nhttps://nested-unsupported.invalid\n--- Public Chains ---\n--- Ethereum ---\nhttps://boundary-undeclared.invalid`);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed.map((row) => row.declaredGroup), [true, false]);
  assert.deepEqual(parsed.map((row) => row.unsupportedMode), [true, false]);
  const pool = buildEthereumCandidatePool(parsed, 4);
  assert.equal(pool.length, 1);
  assert.equal(pool[0].declaredGroup, false);
  assert.equal(pool[0].groupOrdinal, "group-00");
});

test("key and token text confined to URL paths does not create unsupported metadata", () => {
  const parsed = parseInventoryText(`--- service: synthetic-access ---\n--- Ethereum ---\nhttps://usable.invalid/path/key:visible-only-in-url/token=also-in-url`);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].declaredGroup, true);
  assert.equal(parsed[0].unsupportedMode, false);
  assert.equal(buildEthereumCandidatePool(parsed, 2).length, 1);
});

test("selection preflight reaches every fixed terminal stage with sanitized mock inputs", async () => {
  const one = entries(1, 1);
  const sameGroup = entries(1, 2);
  const twoGroupsWithAliases = entries(2, 2);
  const scenarios = new Map([
    ["ELIGIBLE_CANDIDATES_LT_2", () => preflight({ inventoryEntries: one })],
    ["DECLARED_GROUPS_LT_2", () => preflight({ inventoryEntries: sameGroup })],
    ["BASE_CAPABILITY_INSUFFICIENT", () => preflight({ baseReady: (provider) => provider.ordinal === "provider-01" })],
    ["NO_DISTINCT_GROUP_PAIR", () => preflight({ inventoryEntries: twoGroupsWithAliases, baseReady: (provider) => provider.groupOrdinal === "group-01" })],
    ["COMMON_HEIGHT_UNAVAILABLE", () => preflight({ commonError: "provider-rpc-failure" })],
    ["COMMON_HEIGHT_DISAGREEMENT", () => preflight({ commonError: "common-finalized-disagreement" })],
    ["PROBE_TRANSACTION_UNAVAILABLE", () => preflight({ probeError: "probe-transaction-unavailable" })],
    ["REQUIRED_DATA_UNAVAILABLE", () => preflight({ dataUnavailable: (row) => row.provider.ordinal === "provider-02" })],
    ["DATA_CONSENSUS_DISAGREEMENT", () => preflight({ consensus: false })],
    ["PAIR_CHECK_CAP_REACHED", () => preflight({ groupCount: 3, pairChecksCap: 1, commonError: "provider-rpc-failure" })],
    ["BUDGET_STOP", () => preflight({ budgetStop: true })],
    ["PAIR_READY", () => preflight()],
  ]);
  for (const [stage, run] of scenarios) {
    const result = await run();
    assert.equal(result.terminalStage, stage, stage);
    assert.equal(validatePreflightSchema(result), true, stage);
    assert.equal(JSON.parse(strictPreflightJson(result)).terminalStage, stage, stage);
  }
  const aborted = JSON.parse(strictPreflightJson({ schemaVersion: 1, mode: "SELECTION_PREFLIGHT_V1", terminalStage: "PAIR_READY", url: "forbidden" }));
  assert.equal(aborted.terminalStage, "PREFLIGHT_SANITIZATION_ABORTED");
  assert.equal(validatePreflightSchema(aborted), true);
  assert.equal(NONZERO_EXIT_STAGES.has(aborted.terminalStage), true);
});

test("diagnostic phase aborts preserve only fixed stages, numeric counts, and budget usage", async () => {
  const inventoryBudget = budget();
  const inventoryAbort = await selectionPreflight({ inventoryLoader: async () => { throw new Error("injected-loader-object"); }, budget: inventoryBudget });
  assert.equal(inventoryAbort.terminalStage, "INVENTORY_LOAD_ABORTED");
  assert.equal(inventoryAbort.budgets.requestsUsed, 0);
  assert.equal(inventoryAbort.budgets.requestsCap, LIMITS.requests);
  assert.deepEqual(inventoryAbort.candidates, []);

  const poolAbort = await selectionPreflight({ inventoryEntries: entries(2, 1), poolBuilder: () => { throw new Error("injected-pool-object"); }, budget: budget() });
  assert.equal(poolAbort.terminalStage, "POOL_BUILD_ABORTED");
  assert.equal(poolAbort.counts.inventoryEntries, 2);
  assert.deepEqual(poolAbort.candidates, []);

  const executionBudget = budget();
  const executionAbort = await selectionPreflight({
    inventoryEntries: entries(2, 1), budget: executionBudget,
    operations: { ...operations(), qualifyProvider: async () => { executionBudget.requests += 1; throw new Error("injected-operation-object"); } },
  });
  assert.equal(executionAbort.terminalStage, "SELECTION_EXECUTION_ABORTED");
  assert.equal(executionAbort.budgets.requestsUsed, 1);
  assert.equal(executionAbort.counts.eligibleCandidates, 2);
  assert.deepEqual(executionAbort.candidates, []);

  const escaped = preflightExecutionAbortObject();
  assert.equal(escaped.terminalStage, "PREFLIGHT_EXECUTION_ABORTED");
  for (const row of [inventoryAbort, poolAbort, executionAbort, escaped]) {
    assert.equal(validatePreflightSchema(row), true);
    assert.equal(JSON.parse(strictPreflightJson(row)).terminalStage, row.terminalStage);
    assert.equal(NONZERO_EXIT_STAGES.has(row.terminalStage), true);
    assert.doesNotMatch(JSON.stringify(row), /injected|error|message/i);
  }
  assert.deepEqual(new Set([...TERMINAL_STAGES].filter((stage) => NONZERO_EXIT_STAGES.has(stage))), new Set(["INVENTORY_LOAD_ABORTED", "POOL_BUILD_ABORTED", "SELECTION_EXECUTION_ABORTED", "PREFLIGHT_EXECUTION_ABORTED", "PREFLIGHT_SANITIZATION_ABORTED"]));
});

test("strict schema and leak scan emit no provider material or chain-derived values", async () => {
  const result = await preflight();
  const json = strictPreflightJson(result);
  assert.equal(json.split("\n").length, 1);
  assert.doesNotMatch(json, /https?:|\.invalid|0x[0-9a-f]+|timestamp|raw|headers|authorization|bearer/i);
  const parsed = JSON.parse(json);
  assert.equal(validatePreflightSchema(parsed), true);
  assert.equal(parsed.safety.artifactsWritten, false);
  assert.equal(parsed.safety.outputFilesWritten, false);
  assert.equal(parsed.safety.digestsComputed, false);
  assert.equal(parsed.safety.weeklyWindowSearched, false);
  assert.equal(parsed.safety.weeklyLogsScanned, false);
  assert.equal(parsed.safety.tracesRequested, false);
  assert.equal(parsed.safety.seedsLoaded, false);
  assert.equal(parsed.safety.reconciliationRun, false);
});

test("preflight stops at the first ready pair", async () => {
  let commonChecks = 0;
  const ops = operations();
  const wrapped = { ...ops, commonFinalized: async (...args) => { commonChecks += 1; return ops.commonFinalized(...args); } };
  const result = await selectionPreflight({ inventoryEntries: entries(3, 1), budget: budget(), operations: wrapped });
  assert.equal(result.terminalStage, "PAIR_READY");
  assert.equal(result.counts.pairsRecorded, 1);
  assert.equal(commonChecks, 1);
});

test("CLI exposes standalone preflight and rejects output or collection options", () => {
  assert.equal(argumentsOf(["--selection-preflight"]).mode, "selection-preflight");
  assert.throws(() => argumentsOf(["--selection-preflight", "--output-dir", "unused"]), /rejects-output/);
  assert.throws(() => argumentsOf(["--selection-preflight", "--traces"]), /rejects-output/);
  const run = path.join(__dirname, "..", "atomic", "ethereum-top-trades-7d-reconstruction", "run.js");
  const result = spawnSync(process.execPath, [run, "--selection-preflight", "--output-dir", "unused"], { encoding: "utf8", timeout: 30000 });
  assert.notEqual(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.trim().split("\n").length, 1);
  assert.equal(JSON.parse(result.stdout).terminalStage, "PREFLIGHT_EXECUTION_ABORTED");
});
