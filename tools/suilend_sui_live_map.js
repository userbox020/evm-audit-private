#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'reports', 'raw');
const OUT_FILE = path.join(OUT_DIR, 'suilend-suite-live-map.json');

const OBJECT_OPTIONS = {
  showType: true,
  showOwner: true,
  showPreviousTransaction: true,
  showDisplay: true,
  showContent: true,
  showBcs: false,
  showStorageRebate: true,
};

const TX_OPTIONS = {
  showInput: true,
  showEffects: true,
  showEvents: true,
  showObjectChanges: true,
  showBalanceChanges: false,
};

const TARGETS = {
  suilend: {
    currentPackage: '0x3d4353f3bd3565329655e6b77bc2abfd31e558b86662ebd078ae453d416bc10f',
    originalPackage: '0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf',
    mainMarket: '0x84030d26d85eaa7035084a057f2f11f701b7e2e4eda87551becbc7c97505ece1',
    ownerCap: '0xf7a4defe0b6566b6a2674a02a0c61c9f99bd012eed21bc741a069eaa82d35927',
  },
  suilendOracles: {
    currentPackage: '0xe84b649199654d18c38e727212f5d8dacfc3cf78d60d0a7fc85fd589f280eb2b',
    originalPackage: '0xe84b649199654d18c38e727212f5d8dacfc3cf78d60d0a7fc85fd589f280eb2b',
  },
  strategyWrapper: {
    currentPackage: '0x864b66441e95323c320ee7584592769930a2d236b45d731011ee7a98eb785b35',
    originalPackage: '0xba97dc73a07638d03d77ad2161484eb21db577edc9cadcd7035fef4b4f2f6fa1',
  },
  sprungsuiHelper: {
    currentPackage: '0xb87cea7e4220461e35dff856185814d6a37ef479ce895ffbe4efa1d1af5aacbc',
    originalPackage: '0xb87cea7e4220461e35dff856185814d6a37ef479ce895ffbe4efa1d1af5aacbc',
  },
  springSui: {
    currentPackage: '0x47c4b62aed92c5ae308ecd00253b64b3568ad97e6fb11e54b3d1ac5ed7be19ab',
    originalPackage: '0xb0575765166030556a6eafd3b1b970eba8183ff748860680245b9edd41c716e7',
    liquidStakingInfo: '0x15eda7330c8f99c30e430b4d82fd7ab2af3ead4ae17046fcb224aa9bad394f6b',
    weightHook: '0xbbafcb2d7399c0846f8185da3f273ad5b26b3b35993050affa44cfa890f1f144',
  },
  steamm: {
    currentPackage: '0xd8d2601f4a787e732d1e8f017b2bb6b613e4ab2f683ced63296d9e81786d886f',
    originalPackage: '0x4fb1cf45dffd6230305f1d269dd1816678cc8e3ba0b747a813a556921219f261',
  },
  steammScripts: {
    currentPackage: '0x0755429cba577decc090009348987a89f4fb8397da27a3eaafc366794078af7d',
    originalPackage: '0x13bfc09cfc1bd922d3aa53fcf7b2cd510727ee65068ce136e2ebd5f3b213fdd2',
  },
  steammRewards: {
    currentPackage: '0x0a071f4976abae1a7f722199cf0bfcbe695ef9408a878e7d12a7ca87b7e582a6',
    originalPackage: '0x0a071f4976abae1a7f722199cf0bfcbe695ef9408a878e7d12a7ca87b7e582a6',
  },
};

function sanitize(text) {
  return String(text || '').replace(/https?:\/\/[^\s"']+/g, '[redacted-url]');
}

function rpcCandidates() {
  const candidates = [];
  for (const key of ['SUI_RPC', 'SUI_RPC_URL']) {
    if (process.env[key]) candidates.push(process.env[key]);
  }
  const rpcFile = path.join(ROOT, 'rpc_endpoints.txt');
  if (fs.existsSync(rpcFile)) {
    const lines = fs.readFileSync(rpcFile, 'utf8').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    for (const line of lines) {
      if (/sui/i.test(line) && /^https?:\/\//i.test(line)) candidates.push(line);
    }
  }
  candidates.push('https://fullnode.mainnet.sui.io:443');
  return [...new Set(candidates)];
}

async function postJson(url, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${sanitize(text)}`);
    const json = JSON.parse(text);
    if (json.error) throw new Error(JSON.stringify(json.error));
    return json.result;
  } finally {
    clearTimeout(timeout);
  }
}

async function connectRpc() {
  let lastError;
  for (const url of rpcCandidates()) {
    try {
      const checkpoint = await postJson(url, { jsonrpc: '2.0', id: 1, method: 'sui_getLatestCheckpointSequenceNumber', params: [] });
      const chain = await postJson(url, { jsonrpc: '2.0', id: 2, method: 'sui_getChainIdentifier', params: [] });
      return { url, checkpoint, chain };
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`No working Sui RPC candidate (${lastError ? sanitize(lastError.message) : 'unknown error'})`);
}

function makeRpc(url) {
  let id = 100;
  return async function rpc(method, params = []) {
    return postJson(url, { jsonrpc: '2.0', id: id++, method, params });
  };
}

async function optional(label, fn) {
  try {
    return await fn();
  } catch (err) {
    return { error: `${label}: ${sanitize(err.message || err)}` };
  }
}

async function getObject(rpc, id, options = OBJECT_OPTIONS) {
  return rpc('sui_getObject', [id, options]);
}

async function getDynamicFields(rpc, id, limit = 50) {
  const out = [];
  let cursor = null;
  do {
    const page = await rpc('suix_getDynamicFields', [id, cursor, limit]);
    out.push(...(page.data || []));
    cursor = page.hasNextPage ? page.nextCursor : null;
  } while (cursor && out.length < 500);
  return out;
}

async function normalizedModuleSummary(rpc, packageId) {
  const modules = await rpc('sui_getNormalizedMoveModulesByPackage', [packageId]);
  return Object.fromEntries(Object.entries(modules).map(([name, mod]) => {
    const functions = Object.entries(mod.exposedFunctions || {}).map(([fnName, fn]) => ({
      name: fnName,
      visibility: fn.visibility,
      isEntry: fn.isEntry,
      typeParameters: (fn.typeParameters || []).length,
      parameters: (fn.parameters || []).length,
      return: (fn.return || []).length,
    }));
    return [name, {
      structs: Object.keys(mod.structs || {}),
      entryFunctions: functions.filter((fn) => fn.isEntry).map((fn) => fn.name),
      publicFunctionCount: functions.filter((fn) => fn.visibility === 'Public').length,
      functionCount: functions.length,
    }];
  }));
}

function contentFields(objectResult) {
  return objectResult && objectResult.data && objectResult.data.content && objectResult.data.content.fields;
}

function reserveConfigFields(config) {
  return config && (
    config.element && config.element.fields
    || config.fields
    || config
  );
}

function findContainerIds(value, out = {}) {
  if (!value || typeof value !== 'object') return out;
  if (value.type && /(::bag::Bag$|::bag::Bag<|::table::Table<|::object_table::ObjectTable<)/.test(value.type) && value.fields && value.fields.id && value.fields.id.id) {
    out[value.fields.id.id] = { type: value.type, size: value.fields.size };
  }
  if (Array.isArray(value)) {
    for (const item of value) findContainerIds(item, out);
  } else {
    for (const item of Object.values(value)) findContainerIds(item, out);
  }
  return out;
}

function summarizeMarket(objectResult) {
  const fields = contentFields(objectResult);
  if (!fields) return null;
  const reserves = fields.reserves || [];
  return {
    type: objectResult.data.type,
    owner: objectResult.data.owner,
    version: fields.version,
    reserveCount: Array.isArray(reserves) ? reserves.length : null,
    obligationTable: fields.obligations,
    rateLimiter: fields.rate_limiter,
    reserves: Array.isArray(reserves) ? reserves.map((reserve, i) => {
      const r = reserve.fields || reserve;
      const cfg = reserveConfigFields(r.config);
      return {
        index: i,
        arrayIndex: r.array_index,
        coinType: r.coin_type,
        mintDecimals: r.mint_decimals,
        priceIdentifier: r.price_identifier,
        priceLastUpdateTimestampS: r.price_last_update_timestamp_s,
        ctokenSupply: r.ctoken_supply,
        availableAmount: r.available_amount,
        borrowedAmount: r.borrowed_amount,
        unclaimedSpreadFees: r.unclaimed_spread_fees,
        config: cfg,
      };
    }) : reserves,
  };
}

async function packageEvidence(rpc, label, target) {
  const currentObject = await optional(`${label} current object`, () => getObject(rpc, target.currentPackage, { ...OBJECT_OPTIONS, showContent: false }));
  const originalObject = await optional(`${label} original object`, () => getObject(rpc, target.originalPackage, { ...OBJECT_OPTIONS, showContent: false }));
  const normalized = await optional(`${label} normalized modules`, () => normalizedModuleSummary(rpc, target.currentPackage));
  const txDigests = new Set();
  for (const obj of [currentObject, originalObject]) {
    const digest = obj && obj.data && obj.data.previousTransaction;
    if (digest) txDigests.add(digest);
  }
  const publishTransactions = {};
  for (const digest of txDigests) {
    publishTransactions[digest] = await optional(`${label} tx ${digest}`, () => rpc('sui_getTransactionBlock', [digest, TX_OPTIONS]));
  }
  return { currentObject, originalObject, normalized, publishTransactions };
}

async function queryEvents(rpc, eventType, limit = 50) {
  return rpc('suix_queryEvents', [{ MoveEventType: eventType }, null, limit, true]);
}

async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const connection = await connectRpc();
  const rpc = makeRpc(connection.url);

  const packages = {};
  for (const [label, target] of Object.entries(TARGETS)) {
    packages[label] = await packageEvidence(rpc, label, target);
  }

  const objects = {};
  const objectTargets = {
    suilendMainMarket: TARGETS.suilend.mainMarket,
    suilendOwnerCap: TARGETS.suilend.ownerCap,
    springSuiLiquidStakingInfo: TARGETS.springSui.liquidStakingInfo,
    springSuiWeightHook: TARGETS.springSui.weightHook,
  };
  for (const [label, id] of Object.entries(objectTargets)) {
    objects[label] = await optional(label, () => getObject(rpc, id));
  }

  const dynamicFields = {};
  for (const [label, object] of Object.entries(objects)) {
    if (object && object.data && object.data.objectId) {
      dynamicFields[label] = await optional(`${label} dynamic fields`, () => getDynamicFields(rpc, object.data.objectId));
    }
  }

  const discoveredSharedObjects = [];
  for (const [label, pkg] of Object.entries(packages)) {
    for (const [digest, tx] of Object.entries(pkg.publishTransactions || {})) {
      const changes = tx && tx.objectChanges || [];
      for (const change of changes) {
        if (change.type === 'created' && change.owner && change.owner.Shared) {
          discoveredSharedObjects.push({ packageLabel: label, digest, objectId: change.objectId, objectType: change.objectType, owner: change.owner });
        }
      }
    }
  }

  const discoveredSharedObjectDetails = {};
  for (const item of discoveredSharedObjects) {
    discoveredSharedObjectDetails[item.objectId] = await optional(`shared ${item.objectId}`, () => getObject(rpc, item.objectId));
  }

  const nestedDynamicFields = {};
  for (const [label, object] of Object.entries({ ...objects, ...discoveredSharedObjectDetails })) {
    const containers = findContainerIds(object);
    for (const [containerId, meta] of Object.entries(containers)) {
      nestedDynamicFields[`${label}:${containerId}`] = {
        meta,
        fields: await optional(`dynamic fields ${containerId}`, () => getDynamicFields(rpc, containerId, 100)),
      };
    }
  }

  const events = {
    oracleRegistries: await optional('oracle NewRegistryEvent', () => queryEvents(rpc, `${TARGETS.suilendOracles.originalPackage}::oracles::NewRegistryEvent`, 50)),
  };

  const out = {
    generatedAt: new Date().toISOString(),
    chain: { identifier: connection.chain, latestCheckpoint: connection.checkpoint },
    targets: TARGETS,
    summaries: {
      suilendMainMarket: summarizeMarket(objects.suilendMainMarket),
    },
    objects,
    dynamicFields,
    nestedDynamicFields,
    events,
    packages,
    discoveredSharedObjects,
    discoveredSharedObjectDetails,
  };

  fs.writeFileSync(OUT_FILE, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`wrote ${path.relative(ROOT, OUT_FILE)} at checkpoint ${connection.checkpoint}`);
}

main().catch((err) => {
  console.error(sanitize(err.stack || err.message));
  process.exit(1);
});
