#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.join(__dirname, "..");
const TARGET = path.join(WORKSPACE, "targets", "scallop-sui-lending-protocol");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "scallop-live.json");
const RPC_TIMEOUT_MS = 20_000;

const PROTOCOL_PUBLISH = path.join(TARGET, "contracts", "protocol", "publish-result.mainnet.json");
const XORACLE_PUBLISH = path.join(TARGET, "contracts", "sui_x_oracle", "x_oracle", "publish-result.mainnet.json");
const PYTH_PUBLISH = path.join(TARGET, "contracts", "sui_x_oracle", "pyth_rule", "publish-result.mainnet.json");
const CHAIN_DATA = path.join(TARGET, "mainnet-data-setup", "chain-data.ts");

function sanitize(text) {
  return String(text || "").replace(/https?:\/\/\S+/g, "[redacted-url]");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function extractRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function rpcCall(url, method, params = [], timeoutMs = RPC_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${sanitize(text.slice(0, 200))}`);
    const json = JSON.parse(text);
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    return json.result;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveSuiRpc() {
  const urls = extractRpcUrls();
  const preferred = urls.filter((url) => /sui/i.test(url));
  const candidates = [...preferred, ...urls.filter((url) => !preferred.includes(url))];
  const seen = new Set();
  for (const url of candidates) {
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      await rpcCall(url, "sui_getLatestCheckpointSequenceNumber", [], 5000);
      return url;
    } catch (_) {
      // Never print RPC URLs.
    }
  }
  return null;
}

function parseChainData() {
  const text = fs.readFileSync(CHAIN_DATA, "utf8");
  const coinTypes = { sui: "0x2::sui::SUI" };
  const coinTypesBlock = text.match(/export const coinTypes = \{([\s\S]*?)\n\};/);
  if (coinTypesBlock) {
    for (const match of coinTypesBlock[1].matchAll(/\b([A-Za-z0-9_]+):\s*'([^']+)'/g)) {
      coinTypes[match[1]] = match[2];
    }
  }

  const decimals = {};
  const decimalsBlock = text.match(/export const coinDecimals = \{([\s\S]*?)\n\}/);
  if (decimalsBlock) {
    for (const match of decimalsBlock[1].matchAll(/\b([A-Za-z0-9_]+):\s*(\d+)/g)) {
      decimals[match[1]] = Number(match[2]);
    }
  }

  return Object.fromEntries(Object.entries(coinTypes).map(([symbol, coinType]) => [symbol, { coinType, decimals: decimals[symbol] ?? null }]));
}

function compactOwner(owner) {
  if (!owner || typeof owner !== "object") return owner ?? null;
  if (owner.AddressOwner) return { kind: "AddressOwner", value: owner.AddressOwner };
  if (owner.ObjectOwner) return { kind: "ObjectOwner", value: owner.ObjectOwner };
  if (owner.Shared) return { kind: "Shared", initialSharedVersion: owner.Shared.initial_shared_version || owner.Shared.initialSharedVersion };
  if (owner.Immutable) return { kind: "Immutable" };
  return owner;
}

function compactValue(value, depth = 0) {
  if (value === null || value === undefined) return value ?? null;
  if (["string", "number", "boolean"].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.slice(0, 40).map((x) => compactValue(x, depth + 1));
  if (typeof value !== "object") return String(value);
  if (typeof value.id === "string" && Object.keys(value).length === 1) return { id: value.id };
  if (depth >= 6) return Object.keys(value).slice(0, 40);
  const out = {};
  for (const [key, val] of Object.entries(value).slice(0, 60)) {
    out[key] = compactValue(val, depth + 1);
  }
  return out;
}

function summarizeObject(result) {
  const data = result?.data;
  if (!data) return { exists: false, error: result?.error || null };
  const content = data.content || null;
  const fields = content?.fields || null;
  const primitiveFields = {};
  const fieldKeys = fields && typeof fields === "object" ? Object.keys(fields) : [];
  for (const key of fieldKeys) {
    const value = fields[key];
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
      primitiveFields[key] = value;
    } else if (typeof value === "object" && (value.id || value.type || value.fields)) {
      primitiveFields[key] = compactValue(value);
    }
  }
  return {
    exists: true,
    objectId: data.objectId,
    version: data.version,
    digest: data.digest,
    type: data.type || content?.type || null,
    owner: compactOwner(data.owner),
    previousTransaction: data.previousTransaction || null,
    contentDataType: content?.dataType || null,
    fieldKeys,
    fields: primitiveFields,
  };
}

async function getObject(rpc, objectId) {
  const result = await rpcCall(rpc, "sui_getObject", [objectId, {
    showType: true,
    showOwner: true,
    showPreviousTransaction: true,
    showContent: true,
    showDisplay: false,
  }]);
  return summarizeObject(result);
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function getDynamicFieldValueObjects(rpc, dynamicFields) {
  const fields = dynamicFields?.fields || [];
  return mapLimit(fields, 8, async (item) => {
    const valueObject = await getObject(rpc, item.objectId).catch((err) => ({ exists: false, error: sanitize(err.message || String(err)) }));
    return {
      keyType: dynamicFieldKeyType(item),
      coinType: dynamicFieldCoinType(item),
      objectType: item.objectType || null,
      objectId: item.objectId,
      version: item.version ?? null,
      digest: item.digest || null,
      value: decodedDynamicFieldValue(valueObject),
      valueObject,
    };
  });
}

function dynamicFieldKeyType(item) {
  const type = item?.name?.type || null;
  return type ? type.split("::").pop().replace(/>$/, "") : null;
}

function dynamicFieldCoinType(item) {
  const name = item?.name?.value?.type?.name || item?.name?.value?.name || item?.name?.value?.fields?.name || null;
  if (!name) return null;
  return name.startsWith("0x") ? name : `0x${name}`;
}

function normalizedTypeName(type) {
  if (!type) return null;
  const prefixed = (type.startsWith("0x") ? type : `0x${type}`).toLowerCase();
  const [address, ...rest] = prefixed.slice(2).split("::");
  const canonicalAddress = `0x${address.replace(/^0+/, "") || "0"}`;
  return [canonicalAddress, ...rest].join("::");
}

function buildCoinTypeLookup(configuredAssets) {
  const lookup = new Map();
  for (const [symbol, info] of Object.entries(configuredAssets)) {
    lookup.set(normalizedTypeName(info.coinType), symbol);
  }
  return lookup;
}

function decodedDynamicFieldValue(valueObject) {
  if (!valueObject?.exists) return null;
  const fields = valueObject.fields || {};
  return fields.value ?? fields;
}

function summarizeMarketDynamicValues(decodedFields, configuredAssets) {
  const coinTypeLookup = buildCoinTypeLookup(configuredAssets);
  const byAsset = {};
  const byKeyType = {};
  for (const field of decodedFields || []) {
    const keyType = field.keyType || "unknown";
    const coinType = field.coinType || "global";
    const symbol = coinTypeLookup.get(normalizedTypeName(coinType)) || null;
    const entry = {
      keyType,
      symbol,
      coinType,
      objectType: field.objectType,
      objectId: field.objectId,
      value: field.value,
    };
    if (!byKeyType[keyType]) byKeyType[keyType] = [];
    byKeyType[keyType].push(entry);
    const assetKey = symbol || coinType;
    if (!byAsset[assetKey]) byAsset[assetKey] = { symbol, coinType, parameters: {} };
    if (!byAsset[assetKey].parameters[keyType]) byAsset[assetKey].parameters[keyType] = [];
    byAsset[assetKey].parameters[keyType].push({
      objectType: field.objectType,
      objectId: field.objectId,
      value: field.value,
    });
  }
  return { byAsset, byKeyType };
}

function getPath(root, pathParts) {
  let value = root;
  for (const part of pathParts) {
    if (value === null || value === undefined) return null;
    value = value[part];
  }
  return value ?? null;
}

function extractNestedContainers(objects) {
  const market = objects.market?.fields || {};
  const xOracle = objects.xOracle?.fields || {};
  const pythRegistry = objects.pythRegistry?.fields || {};
  const containers = {
    activeBaseTable: getPath(market, ["asset_active_states", "fields", "base", "fields", "table", "fields", "id", "id"]),
    activeCollateralTable: getPath(market, ["asset_active_states", "fields", "collateral", "fields", "table", "fields", "id", "id"]),
    borrowDynamicsTable: getPath(market, ["borrow_dynamics", "fields", "table", "fields", "id", "id"]),
    collateralStatsTable: getPath(market, ["collateral_stats", "fields", "table", "fields", "id", "id"]),
    interestModelsTable: getPath(market, ["interest_models", "fields", "table", "fields", "id", "id"]),
    riskModelsTable: getPath(market, ["risk_models", "fields", "table", "fields", "id", "id"]),
    limitersTable: getPath(market, ["limiters", "fields", "table", "fields", "id", "id"]),
    balanceSheetsTable: getPath(market, ["vault", "fields", "balance_sheets", "fields", "table", "fields", "id", "id"]),
    flashLoanFeesTable: getPath(market, ["vault", "fields", "flash_loan_fees", "fields", "table", "fields", "id", "id"]),
    marketCoinSuppliesBag: getPath(market, ["vault", "fields", "market_coin_supplies", "fields", "bag", "fields", "id", "id"]),
    underlyingBalancesBag: getPath(market, ["vault", "fields", "underlying_balances", "fields", "bag", "fields", "id", "id"]),
    xOraclePricesTable: getPath(xOracle, ["prices", "fields", "id", "id"]),
    xOraclePrimaryPolicy: getPath(xOracle, ["primary_price_update_policy", "fields", "id", "id"]),
    xOracleSecondaryPolicy: getPath(xOracle, ["secondary_price_update_policy", "fields", "id", "id"]),
    pythRegistryTable: getPath(pythRegistry, ["table", "fields", "id", "id"]),
  };
  return Object.fromEntries(Object.entries(containers).filter(([, objectId]) => objectId));
}

async function getDecodedNestedDynamicFields(rpc, containers) {
  const out = {};
  for (const [label, objectId] of Object.entries(containers)) {
    const dynamicFields = await getDynamicFields(rpc, objectId, 50, 5).catch((err) => ({ error: sanitize(err.message || String(err)) }));
    const decoded = await getDynamicFieldValueObjects(rpc, dynamicFields).catch((err) => ({ error: sanitize(err.message || String(err)) }));
    out[label] = { objectId, dynamicFields, decoded };
  }
  return out;
}

function summarizeTypeNameKeyedFields(decodedFields, configuredAssets) {
  const coinTypeLookup = buildCoinTypeLookup(configuredAssets);
  const byAsset = {};
  for (const field of decodedFields || []) {
    const coinType = field.coinType;
    const symbol = coinTypeLookup.get(normalizedTypeName(coinType)) || null;
    const assetKey = symbol || coinType || field.objectId;
    byAsset[assetKey] = {
      symbol,
      coinType,
      objectType: field.objectType,
      objectId: field.objectId,
      value: field.value,
    };
  }
  return byAsset;
}

function summarizeNestedDynamicFields(nestedDynamicFields, configuredAssets) {
  const out = {};
  for (const [label, data] of Object.entries(nestedDynamicFields || {})) {
    out[label] = summarizeTypeNameKeyedFields(data.decoded, configuredAssets);
  }
  return out;
}

function firstDecodedTableId(nestedEntry) {
  for (const field of nestedEntry?.decoded || []) {
    const id = getPath(field, ["value", "fields", "id", "id"]);
    if (id) return id;
  }
  return null;
}

async function getDynamicFields(rpc, objectId, limit = 50, maxPages = 5) {
  const fields = [];
  let cursor = null;
  for (let page = 0; page < maxPages; page++) {
    const result = await rpcCall(rpc, "suix_getDynamicFields", [objectId, cursor, limit]);
    for (const item of result?.data || []) fields.push(item);
    if (!result?.hasNextPage) return { countSampled: fields.length, hasNextPage: false, nextCursor: null, fields };
    cursor = result.nextCursor;
  }
  return { countSampled: fields.length, hasNextPage: true, nextCursor: cursor, fields };
}

async function gitCommit() {
  return new Promise((resolve) => {
    const { execFile } = require("child_process");
    execFile("git", ["rev-parse", "HEAD"], { cwd: TARGET }, (err, stdout) => resolve(err ? null : stdout.trim()));
  });
}

async function main() {
  const rpc = await resolveSuiRpc();
  if (!rpc) throw new Error("No Sui RPC endpoint resolved from local inventory");

  const protocol = readJson(PROTOCOL_PUBLISH);
  const xoracle = readJson(XORACLE_PUBLISH);
  const pyth = readJson(PYTH_PUBLISH);
  const latestCheckpoint = await rpcCall(rpc, "sui_getLatestCheckpointSequenceNumber", []);
  const objectsToScan = {
    protocolPackage: protocol.packageId,
    protocolUpgradeCap: protocol.upgradeCapId,
    market: protocol.marketId,
    adminCap: protocol.adminCapId,
    version: protocol.versionId,
    obligationAccessStore: protocol.obligationAccessStoreId,
    borrowReferralWitnessList: protocol.borrowReferralWitnessList,
    xOraclePackage: xoracle.packageId,
    xOracleOriginalPackage: xoracle.originalPackageId,
    xOracle: xoracle.xOracleId,
    xOracleCap: xoracle.xOracleCapId,
    pythRulePackage: pyth.packageId,
    pythRegistry: pyth.pythRegistryId,
    pythRegistryCap: pyth.pythRegistryCapId,
    clock: "0x6",
  };

  const objects = {};
  for (const [label, objectId] of Object.entries(objectsToScan)) {
    objects[label] = await getObject(rpc, objectId).catch((err) => ({ exists: false, error: sanitize(err.message || String(err)) }));
  }

  const dynamicFields = {};
  for (const label of ["market", "obligationAccessStore", "xOracle", "pythRegistry"]) {
    const objectId = objectsToScan[label];
    dynamicFields[label] = await getDynamicFields(rpc, objectId).catch((err) => ({ error: sanitize(err.message || String(err)) }));
  }

  const configuredAssets = parseChainData();
  const decodedDynamicFields = {};
  for (const label of ["market", "xOracle", "pythRegistry"]) {
    decodedDynamicFields[label] = await getDynamicFieldValueObjects(rpc, dynamicFields[label]).catch((err) => ({ error: sanitize(err.message || String(err)) }));
  }
  const marketDynamicSummary = summarizeMarketDynamicValues(decodedDynamicFields.market, configuredAssets);
  const nestedContainers = extractNestedContainers(objects);
  const nestedDynamicFields = await getDecodedNestedDynamicFields(rpc, nestedContainers);
  for (const [label, objectId] of Object.entries({
    xOraclePrimaryRulesTable: firstDecodedTableId(nestedDynamicFields.xOraclePrimaryPolicy),
    xOracleSecondaryRulesTable: firstDecodedTableId(nestedDynamicFields.xOracleSecondaryPolicy),
  })) {
    if (!objectId) continue;
    const dynamicFields = await getDynamicFields(rpc, objectId, 50, 5).catch((err) => ({ error: sanitize(err.message || String(err)) }));
    const decoded = await getDynamicFieldValueObjects(rpc, dynamicFields).catch((err) => ({ error: sanitize(err.message || String(err)) }));
    nestedContainers[label] = objectId;
    nestedDynamicFields[label] = { objectId, dynamicFields, decoded };
  }
  const nestedDynamicSummary = summarizeNestedDynamicFields(nestedDynamicFields, configuredAssets);

  const output = {
    generatedAt: new Date().toISOString(),
    source: {
      repo: "https://github.com/scallop-io/sui-lending-protocol",
      path: path.relative(WORKSPACE, TARGET),
      commit: await gitCommit(),
      protocolPublish: path.relative(WORKSPACE, PROTOCOL_PUBLISH),
      xOraclePublish: path.relative(WORKSPACE, XORACLE_PUBLISH),
      pythPublish: path.relative(WORKSPACE, PYTH_PUBLISH),
    },
    chain: { name: "sui", latestCheckpoint },
    configuredAssets,
    objectIds: objectsToScan,
    objects,
    dynamicFields,
    decodedDynamicFields,
    marketDynamicSummary,
    nestedContainers,
    nestedDynamicFields,
    nestedDynamicSummary,
    verdict: "SCALLOP_SUI_READ_ONLY_MAP_REFRESHED",
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(output, null, 2) + "\n");
  console.log(`Wrote ${path.relative(WORKSPACE, OUT)}`);
  console.log(`checkpoint=${latestCheckpoint} assets=${Object.keys(output.configuredAssets).length} objects=${Object.keys(objects).length} verdict=${output.verdict}`);
}

main().catch((err) => {
  console.error(sanitize(err.stack || err.message || String(err)));
  process.exit(1);
});
