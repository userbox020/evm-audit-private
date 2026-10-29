"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const DATASET_BASE = "https://portal.sqd.dev/datasets/base-mainnet";
const MAX_WINDOW_BLOCKS = 20_000;
const MAX_PAGES = 64;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_RECORDS = 100_000;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;

const COMPOUND_MANIFESTS = Object.freeze([
  Object.freeze({
    localPath: "targets/compound-comet/deployments/base/weth/roots.json",
    rolePrefix: "compound-weth"
  }),
  Object.freeze({
    localPath: "targets/compound-comet/deployments/base/usdc/roots.json",
    rolePrefix: "compound-usdc"
  })
]);

const FLUID_MANIFEST_ALLOWLIST = Object.freeze({
  "targets/fluid-contracts-public/deployments/base/Liquidity.json": "fluid-liquidity",
  "targets/fluid-contracts-public/deployments/base/VaultFactory.json": "fluid-vault-factory",
  "targets/fluid-contracts-public/deployments/base/DexFactory.json": "fluid-dex-factory",
  "targets/fluid-contracts-public/deployments/base/LendingFactory.json": "fluid-lending-factory",
  "targets/fluid-contracts-public/deployments/base/SmartLendingFactory.json": "fluid-smart-lending-factory"
});

class TriageError extends Error {
  constructor(code) {
    super(code);
    this.name = "TriageError";
    this.code = code;
  }
}

const stop = (code) => { throw new TriageError(code); };

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function commitment(namespace, value) {
  return `${namespace}_${crypto.createHash("sha256").update(`${namespace}:${value}`).digest("base64url")}`;
}

function withDerivedHash(core) {
  return { ...core, derivedHash: commitment("derived", canonical(core)) };
}

function normalizeLocalPath(value) {
  if (typeof value !== "string" || value.length === 0 || path.isAbsolute(value)) stop("FLUID_MANIFEST_PATH_NOT_ALLOWLISTED");
  const normalized = value.replaceAll("\\", "/");
  if (normalized.split("/").some((part) => part === "" || part === "." || part === "..")) stop("FLUID_MANIFEST_PATH_NOT_ALLOWLISTED");
  return normalized;
}

function normalizeAddress(value) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/u.test(value)) stop("MANIFEST_ADDRESS_INVALID");
  const lowered = value.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/u.test(lowered)) stop("MANIFEST_ADDRESS_INVALID");
  return lowered;
}

async function readJson(localPath, readFileFn) {
  let bytes;
  try {
    bytes = await readFileFn(path.join(ROOT, ...localPath.split("/")));
  } catch (_) {
    stop("MANIFEST_READ_FAILED");
  }
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buffer.byteLength > MAX_MANIFEST_BYTES) stop("MANIFEST_BYTES_CAP_EXCEEDED");
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch (_) {
    stop("MANIFEST_JSON_INVALID");
  }
}

async function loadRoles(fluidManifestPaths, readFileFn = fs.readFile) {
  if (!Array.isArray(fluidManifestPaths) || fluidManifestPaths.length === 0) stop("FLUID_MANIFEST_REQUIRED");
  const selectedFluid = fluidManifestPaths.map(normalizeLocalPath);
  if (new Set(selectedFluid).size !== selectedFluid.length) stop("FLUID_MANIFEST_DUPLICATE");
  for (const localPath of selectedFluid) {
    if (!Object.hasOwn(FLUID_MANIFEST_ALLOWLIST, localPath)) stop("FLUID_MANIFEST_PATH_NOT_ALLOWLISTED");
  }

  const roles = [];
  for (const source of COMPOUND_MANIFESTS) {
    const manifest = await readJson(source.localPath, readFileFn);
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) stop("COMPOUND_MANIFEST_INVALID");
    const entries = Object.entries(manifest);
    if (entries.length === 0) stop("COMPOUND_MANIFEST_INVALID");
    for (const [name, address] of entries) {
      if (!/^[A-Za-z][A-Za-z0-9]*$/u.test(name)) stop("COMPOUND_ROLE_INVALID");
      roles.push({ roleLabel: `${source.rolePrefix}.${name}`, address: normalizeAddress(address) });
    }
  }

  for (const localPath of selectedFluid) {
    const manifest = await readJson(localPath, readFileFn);
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || !Object.hasOwn(manifest, "address")) {
      stop("FLUID_MANIFEST_INVALID");
    }
    roles.push({ roleLabel: FLUID_MANIFEST_ALLOWLIST[localPath], address: normalizeAddress(manifest.address) });
  }

  roles.sort((a, b) => (a.roleLabel < b.roleLabel ? -1 : a.roleLabel > b.roleLabel ? 1 : 0));
  if (new Set(roles.map((role) => role.roleLabel)).size !== roles.length) stop("ROLE_LABEL_DUPLICATE");
  return roles;
}

function decimalBlock(value, code) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) stop(code);
    return value;
  }
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) stop(code);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) stop(code);
  return parsed;
}

async function consumeBytes(response, cap, onText) {
  const contentLength = response.headers && typeof response.headers.get === "function"
    ? response.headers.get("content-length")
    : null;
  if (contentLength !== null && /^(?:0|[1-9][0-9]*)$/u.test(contentLength) && Number(contentLength) > cap) {
    stop("RESPONSE_BYTES_CAP_EXCEEDED");
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  const accept = (chunk) => {
    const buffer = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    bytes += buffer.byteLength;
    if (bytes > cap) stop("RESPONSE_BYTES_CAP_EXCEEDED");
    onText(decoder.decode(buffer, { stream: true }));
  };

  try {
    if (response.body && typeof response.body.getReader === "function") {
      const reader = response.body.getReader();
      let completed = false;
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) {
            completed = true;
            break;
          }
          accept(item.value);
        }
      } finally {
        if (!completed && typeof reader.cancel === "function") {
          try { await reader.cancel(); } catch (_) { /* Preserve the original fail-closed error. */ }
        }
        if (typeof reader.releaseLock === "function") {
          try { reader.releaseLock(); } catch (_) { /* The body is already consumed or cancelled. */ }
        }
      }
    } else if (response.body && typeof response.body[Symbol.asyncIterator] === "function") {
      for await (const chunk of response.body) accept(chunk);
    } else if (typeof response.arrayBuffer === "function") {
      accept(await response.arrayBuffer());
    } else {
      stop("RESPONSE_BODY_UNREADABLE");
    }
    onText(decoder.decode());
  } catch (error) {
    if (error instanceof TriageError) throw error;
    stop("RESPONSE_BODY_INVALID");
  }
  return bytes;
}

async function fetchHead(fetchFn, headResponseBytes) {
  let response;
  try {
    response = await fetchFn(`${DATASET_BASE}/head`, { method: "GET", redirect: "error" });
  } catch (_) {
    stop("HEAD_FETCH_FAILED");
  }
  if (!response || response.status !== 200) stop("HEAD_HTTP_STATUS_INVALID");
  let text = "";
  await consumeBytes(response, headResponseBytes, (chunk) => { text += chunk; });
  const trimmed = text.trim();
  if (/^(?:0|[1-9][0-9]*)$/u.test(trimmed)) return decimalBlock(trimmed, "HEAD_INVALID");
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (_) {
    stop("HEAD_INVALID");
  }
  const candidate = parsed && typeof parsed === "object"
    ? (parsed.finalized ?? parsed.number ?? parsed.height ?? (parsed.header && parsed.header.number))
    : parsed;
  return decimalBlock(candidate, "HEAD_INVALID");
}

function selectWindow(head, fromBlock, toBlock, maxWindowBlocks) {
  const suppliedFrom = fromBlock !== undefined && fromBlock !== null;
  const suppliedTo = toBlock !== undefined && toBlock !== null;
  if (suppliedFrom !== suppliedTo) stop("WINDOW_BOUNDS_PAIR_REQUIRED");
  const from = suppliedFrom ? decimalBlock(fromBlock, "WINDOW_FROM_INVALID") : Math.max(0, head - maxWindowBlocks + 1);
  const to = suppliedTo ? decimalBlock(toBlock, "WINDOW_TO_INVALID") : head;
  if (to < from || to > head || to - from + 1 > maxWindowBlocks) stop("WINDOW_BOUNDS_INVALID");
  return { from, to };
}

function selectorCommitment(input) {
  if (typeof input !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/u.test(input)) stop("TRANSACTION_INPUT_INVALID");
  const selector = input.length >= 10 ? input.slice(0, 10).toLowerCase() : "no-selector";
  return commitment("selector", selector);
}

function initializeAggregates(roles) {
  const roleState = new Map();
  const labelsByAddress = new Map();
  for (const role of roles) {
    roleState.set(role.roleLabel, { count: 0, selectors: new Map() });
    if (!labelsByAddress.has(role.address)) labelsByAddress.set(role.address, []);
    labelsByAddress.get(role.address).push(role.roleLabel);
  }
  return { roleState, labelsByAddress };
}

function publicAggregates(roles, roleState, zero = false) {
  const successCounts = [];
  const selectorFrequencies = [];
  for (const role of roles) {
    const state = roleState.get(role.roleLabel);
    successCounts.push({ roleLabel: role.roleLabel, count: zero ? 0 : state.count });
    selectorFrequencies.push({
      roleLabel: role.roleLabel,
      frequencies: zero ? [] : [...state.selectors.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([selectorCommitmentValue, count]) => ({ selectorCommitment: selectorCommitmentValue, count }))
    });
  }
  return { successCounts, selectorFrequencies };
}

function resultCore(status, error, window, headersProcessed, aggregates) {
  return {
    status,
    error,
    windowBlocks: window === null ? null : {
      fromBlock: String(window.from),
      toBlock: String(window.to),
      finalizedHead: String(window.head)
    },
    headersProcessed,
    successCounts: aggregates.successCounts,
    selectorFrequencies: aggregates.selectorFrequencies
  };
}

async function scanFinalizedWindow(options, fetchFn, roles, head, window, roleState, labelsByAddress) {
  const maxPages = options.maxPages ?? MAX_PAGES;
  const maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const maxTotalResponseBytes = options.maxTotalResponseBytes ?? MAX_TOTAL_RESPONSE_BYTES;
  const maxRecords = options.maxRecords ?? MAX_RECORDS;
  for (const [value, code] of [[maxPages, "PAGE_CAP_INVALID"], [maxResponseBytes, "RESPONSE_BYTES_CAP_INVALID"],
    [maxTotalResponseBytes, "TOTAL_RESPONSE_BYTES_CAP_INVALID"], [maxRecords, "RECORD_CAP_INVALID"]]) {
    if (!Number.isSafeInteger(value) || value < 1) stop(code);
  }

  const addresses = [...labelsByAddress.keys()].sort();
  let cursor = window.from;
  let pages = 0;
  let totalBytes = 0;
  let records = 0;
  let headersProcessed = 0;
  let lastHeader = null;
  const transactionPositions = new Set();

  while (cursor <= window.to) {
    if (pages >= maxPages) stop("PAGE_CAP_EXCEEDED");
    pages += 1;
    const request = {
      type: "evm",
      fromBlock: cursor,
      toBlock: window.to,
      fields: {
        block: { number: true },
        transaction: { transactionIndex: true, input: true, to: true, status: true }
      },
      transactions: [{ to: addresses }]
    };
    let response;
    try {
      response = await fetchFn(`${DATASET_BASE}/finalized-stream`, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request)
      });
    } catch (_) {
      stop("STREAM_FETCH_FAILED");
    }
    if (!response) stop("STREAM_HTTP_STATUS_INVALID");
    if (response.status === 204) stop("FINALIZED_WINDOW_INCOMPLETE");
    if (response.status !== 200) stop("STREAM_HTTP_STATUS_INVALID");

    let pending = "";
    let pageRecords = 0;
    let pageLastHeader = null;
    const processLine = (line) => {
      const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (clean.length === 0) return;
      records += 1;
      pageRecords += 1;
      if (records > maxRecords) stop("RECORD_CAP_EXCEEDED");
      let record;
      try {
        record = JSON.parse(clean);
      } catch (_) {
        stop("NDJSON_RECORD_INVALID");
      }
      if (!record || typeof record !== "object" || Array.isArray(record)
          || !record.header || typeof record.header !== "object" || Array.isArray(record.header)) {
        stop("NDJSON_RECORD_INVALID");
      }
      const number = decimalBlock(record.header.number, "HEADER_NUMBER_INVALID");
      if (number < cursor || number > window.to || (lastHeader !== null && number <= lastHeader)) stop("HEADER_ORDER_INVALID");
      lastHeader = number;
      pageLastHeader = number;
      headersProcessed += 1;

      const transactions = record.transactions === undefined ? [] : record.transactions;
      if (!Array.isArray(transactions)) stop("TRANSACTIONS_INVALID");
      for (const transaction of transactions) {
        records += 1;
        if (records > maxRecords) stop("RECORD_CAP_EXCEEDED");
        if (!transaction || typeof transaction !== "object" || Array.isArray(transaction)) stop("TRANSACTION_INVALID");
        const transactionIndex = decimalBlock(transaction.transactionIndex, "TRANSACTION_INDEX_INVALID");
        const position = `${number}:${transactionIndex}`;
        if (transactionPositions.has(position)) stop("TRANSACTION_DUPLICATE");
        transactionPositions.add(position);
        if (transaction.status !== 0 && transaction.status !== 1) stop("TRANSACTION_STATUS_INVALID");
        if (transaction.status !== 1) continue;
        if (typeof transaction.to !== "string" || !/^0x[0-9a-f]{40}$/u.test(transaction.to)
            || !labelsByAddress.has(transaction.to)) stop("TRANSACTION_RECIPIENT_INVALID");
        const selector = selectorCommitment(transaction.input);
        for (const roleLabel of labelsByAddress.get(transaction.to)) {
          const state = roleState.get(roleLabel);
          state.count += 1;
          state.selectors.set(selector, (state.selectors.get(selector) || 0) + 1);
        }
      }
    };

    const pageBytes = await consumeBytes(response, maxResponseBytes, (chunk) => {
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf("\n")) !== -1) {
        processLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
      if (Buffer.byteLength(pending, "utf8") > maxResponseBytes) stop("RESPONSE_BYTES_CAP_EXCEEDED");
    });
    if (pending.length !== 0) processLine(pending);
    totalBytes += pageBytes;
    if (totalBytes > maxTotalResponseBytes) stop("TOTAL_RESPONSE_BYTES_CAP_EXCEEDED");
    if (pageRecords === 0 || pageLastHeader === null) stop("EMPTY_STREAM_PAGE");
    cursor = pageLastHeader + 1;
  }
  if (lastHeader !== window.to) stop("FINALIZED_WINDOW_INCOMPLETE");
  return { headersProcessed };
}

async function runTriage(options = {}) {
  let roles = [];
  let roleState = new Map();
  let window = null;
  let headersProcessed = 0;
  try {
    const fetchFn = options.fetchFn ?? ((...args) => globalThis.fetch(...args));
    if (typeof fetchFn !== "function") stop("FETCH_UNAVAILABLE");
    roles = await loadRoles(options.fluidManifestPaths, options.readFileFn ?? fs.readFile);
    const initialized = initializeAggregates(roles);
    roleState = initialized.roleState;
    const maxWindowBlocks = options.maxWindowBlocks ?? MAX_WINDOW_BLOCKS;
    if (!Number.isSafeInteger(maxWindowBlocks) || maxWindowBlocks < 1 || maxWindowBlocks > MAX_WINDOW_BLOCKS) stop("WINDOW_CAP_INVALID");
    const head = await fetchHead(fetchFn, options.headResponseBytes ?? 2048);
    const selected = selectWindow(head, options.fromBlock, options.toBlock, maxWindowBlocks);
    window = { ...selected, head };
    const scanned = await scanFinalizedWindow(options, fetchFn, roles, head, selected, roleState, initialized.labelsByAddress);
    headersProcessed = scanned.headersProcessed;
    return withDerivedHash(resultCore("COMPLETE", null, window, headersProcessed, publicAggregates(roles, roleState)));
  } catch (error) {
    const code = error instanceof TriageError ? error.code : "INTERNAL_ERROR";
    return withDerivedHash(resultCore("ERROR", code, window, headersProcessed, publicAggregates(roles, roleState, true)));
  }
}

function parseArgs(argv) {
  const parsed = { fluidManifestPaths: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!["--from-block", "--to-block", "--fluid-manifest"].includes(flag) || index + 1 >= argv.length) stop("ARGUMENT_INVALID");
    const value = argv[index + 1];
    index += 1;
    if (flag === "--fluid-manifest") parsed.fluidManifestPaths.push(value);
    else {
      const key = flag === "--from-block" ? "fromBlock" : "toBlock";
      if (Object.hasOwn(parsed, key)) stop("ARGUMENT_DUPLICATE");
      parsed[key] = value;
    }
  }
  return parsed;
}

async function main() {
  let result;
  try {
    result = await runTriage(parseArgs(process.argv.slice(2)));
  } catch (error) {
    const code = error instanceof TriageError ? error.code : "ARGUMENT_INVALID";
    result = withDerivedHash(resultCore("ERROR", code, null, 0, { successCounts: [], selectorFrequencies: [] }));
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== "COMPLETE") process.exitCode = 1;
}

module.exports = {
  COMPOUND_MANIFESTS,
  FLUID_MANIFEST_ALLOWLIST,
  MAX_PAGES,
  MAX_RECORDS,
  MAX_RESPONSE_BYTES,
  MAX_WINDOW_BLOCKS,
  loadRoles,
  runTriage
};

if (require.main === module) main();
