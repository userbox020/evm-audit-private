#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const v1 = require('./analyze-critical-silo-v3-public-allocator-runtime-binding-gate0-step4.js');

const ROOT = path.resolve(__dirname, '..');
const ID = 'critical-silo-v3-public-allocator-runtime-binding-gate0-step4-r2';
const MODE = 'OFFLINE_PREFLIGHT_NO_EXECUTION';
const STATUS = 'BLOCKED_VAULT_RUNTIME_BINDING';
const ORACLE_SCOPE = 'FACTORY_EXACT_7';
const GENERATED_AT = '2026-08-07T00:00:00.000Z';
const STANDARD_JSON_PATH = 'targets/silo-contracts-v2/flattened/silo_vaults/arbitrum_one/SiloVaultsFactory.standard.json';
const STANDARD_JSON_SHA256 = '6d536b5725d40f67ae0bd8eb754cd711b628f2419c347965889b7ee4e2abe0aa';
const FACTORY_LAYOUT = Object.freeze({ constructorRuntimeOffset: 0x6d, constructorRuntimeLength: 0x09bc, immutablePatchOffsets: [0x99, 0x2d6], immutablePatchLength: 32 });
const MODULE_LOG_TOPIC = '0xc7f505b2f371ae2175ee4913f4499e1f2633a7b5936321eed1cdaeb6115181d2';
const MODULE_LOG_DATA = '0x000000000000000000000000000000000000000000000000ffffffffffffffff';
const LAYOUT_DIRECTIVE = '6080516109bc61006d5f395f8181609901526102d601526109bc5ff3fe';
const COMMON_LIBRARY = '0x62315ae486418bc81bccd89b50a06cc4b90e426b';

const OUTPUT_PATHS = Object.freeze({
  report: `reports/${ID}.md`,
  artifact: `reports/raw/fast/${ID}.json`,
  manifest: `reports/raw/fast/${ID}-manifest.json`,
});

const V1_HASHES = Object.freeze({
  'tools/analyze-critical-silo-v3-public-allocator-runtime-binding-gate0-step4.js': 'eb824f1105cb297fd3f2d581a261770810422c3b52b4240565d0a7e44e656396',
  'tools/test-critical-silo-v3-public-allocator-runtime-binding-gate0-step4.js': '0f1eb90ceda6056cd9941485e5d268883711b6f04a1db5ba8644031485511426',
  'reports/raw/fast/critical-silo-v3-public-allocator-runtime-binding-gate0-step4.json': '64f09f0f2face12267d7345b29b2f14df50885fee5dd84fdf63814cda9673bd3',
  'reports/raw/fast/critical-silo-v3-public-allocator-runtime-binding-gate0-step4-manifest.json': '5a5afe8ca0514db85312026485562f6fe8b2babfae61288cfe60c43d2492a2e4',
  'reports/critical-silo-v3-public-allocator-runtime-binding-gate0-step4.md': '457b11a742e555288c9c796bf5329c29c8813e7c4307de6c3a0f887a453c68a4',
});

const FACTORIES = Object.freeze([
  { chainId: 1, chainHex: '0x1', path: 'targets/silo-contracts-v2/silo-vaults/broadcast/MainnetDeploy.s.sol/1/run-latest.json', sha256: 'cb95237cd20cbe9c9a29fa1b60c4e4a9ff7af408dd6b5b71aee98e4f7846eba4', txHash: '0x08d0474cf94b99202236474bcdf138fcfd9d53f32cbfb936b86354653a950dee', address: '0xffd3cb64ec6fb68432792e4e902f62192a420506', library: COMMON_LIBRARY, module: '0x6b9e23afe5cf726151eb72582e9fe62cd05931ac', runtimeHash: '0x61a166bf55fe01859fca458cdebd33cfd3991b88c00acc60b4e1d55327da5acc', predecessor: true },
  { chainId: 56, chainHex: '0x38', path: 'targets/silo-contracts-v2/silo-vaults/broadcast/MainnetDeploy.s.sol/56/run-latest.json', sha256: 'fb1e02448c4f366af22676f5d2985dd0ee6e108bc5c6a238a5ec32f8a584ee6f', txHash: '0x738fda74f055c4452515dacb7e3c2b6505f1f831bce69e91d29791dc333da104', address: '0x16876af41e8beddbf9b67d2b66bb50abf3503b1c', library: COMMON_LIBRARY, module: '0x26b14d761df357fc7363ddc78fdbce2c79938e6c', runtimeHash: '0x6d23df16b631c36ed22ac0c83a4a4c06513def71b541dc35c14d4f4a953a9feb', predecessor: true },
  { chainId: 146, chainHex: '0x92', path: 'targets/silo-contracts-v2/silo-vaults/broadcast/SiloVaultsFactoryDeploy.s.sol/146/run-latest.json', sha256: '9292941390b6f898b99dc694585d866d12d240b85c6503c7e487481e98c0ff32', txHash: '0xd6e72e502561d61c836580dbeb249f047ac1c2e8e6803916c29fb74211944386', address: '0x4b8cbf30c9dc9d28ce56eeed40bf23b5fd6457b6', library: COMMON_LIBRARY, module: '0xedf84c9b0afa9880295a7496acab17aec0865df9', runtimeHash: '0xcc7466c5967d03defb855dd7c4d1960755905282e809522aa221a7454ec9a0db', predecessor: false },
  { chainId: 5000, chainHex: '0x1388', path: 'targets/silo-contracts-v2/silo-vaults/broadcast/VaultsMainnetDeploy.s.sol/5000/run-latest.json', sha256: '13f6f7deaafd42cfd8196e9eecdf456e7231a2877dbb3e653dee69fc38a70bee', txHash: '0x65a5d023ad024bb93e2e5f633b05327211eeff22a976bd3615490189cc475768', address: '0x4a6c34a6b8f5c1a1dcdc4be664cbc1259a0737a6', library: '0xdd14762aabe1d5f5b470ad83ad7cefaf40bedad5', module: '0x2811cee6ad6dcfcd94d5b093fa8c0553d3a07b19', runtimeHash: '0xa8969255469d4d8ca49a866df3249643e5509e4df5b8f6c021d2598b266da7ce', predecessor: false },
  { chainId: 8453, chainHex: '0x2105', path: 'targets/silo-contracts-v2/silo-vaults/broadcast/MainnetDeploy.s.sol/8453/run-latest.json', sha256: '844dba26c2cb70b0f8fdda5b7f63ae1cd61d991a05e2be9c3e7e1c190d3dedbe', txHash: '0x487d5c096a3a1e8390c8481a30407549d548459a0c30a43b13ab3bbb172d834e', address: '0x2534b2e33076787142246750e9340696267b96be', library: COMMON_LIBRARY, module: '0xa95c82f3d33f90e57e48ea747baa23d1c329e419', runtimeHash: '0x5f50fb4c92f333f48be0f5ac79befb7ea6f4e151efaa4bb830bf44fd8815ae3f', predecessor: true },
  { chainId: 42161, chainHex: '0xa4b1', path: 'targets/silo-contracts-v2/silo-vaults/broadcast/MainnetDeploy.s.sol/42161/run-latest.json', sha256: 'a1fa6098c12dafafb3adb1708a29a54005e8d7b83c001c07c0357d715bab187a', txHash: '0x6bf053a5593429043e3a7d800086547e180ac5eb148f7b95c06dd1efbc7d5d21', address: '0x2976d3ea35adcd185bbf79b201424f9607d49d30', library: COMMON_LIBRARY, module: '0x55fc028d988e017bcce640ae6cd71b9ca6390b1c', runtimeHash: '0x8b21f3a8619b5a56ec4eccaf477a727dab88d62c462b2c27523936c796a11515', predecessor: true },
  { chainId: 57073, chainHex: '0xdef1', path: 'targets/silo-contracts-v2/silo-vaults/broadcast/SiloVaultsFactoryDeploy.s.sol/57073/run-latest.json', sha256: '72395600487b91c44417727acef7325cf4f7ecca660daf534b057bf2a95ed875', txHash: '0x80daf702fb4aeca0f3c0fe7f401e00e33cbedbd7a1d6714aa959cf5ac0d41674', address: '0xf279eec12a1936b0786a4ce51e71e77132a04ef3', library: COMMON_LIBRARY, module: '0x6d8c9df31a9950f11199e80360612fa02d38de34', runtimeHash: '0x5215c2510b5bd1c7c1860727986b2a0cefdca06f2eb06bc48150e3faa516a930', predecessor: false },
]);

const VAULT_BLOCKERS = Object.freeze([
  'VAULT_ADDRESS_ABSENT_FROM_LOCAL_BROADCASTS',
  'VAULT_CREATION_TRANSACTION_ABSENT',
  'VAULT_CREATION_CALLDATA_INIT_CODE_ABSENT',
  'VAULT_DEPLOYED_BYTE_PREIMAGE_ABSENT',
  'VAULT_IMMUTABLE_CLOSURE_ABSENT',
  'VAULT_EXACT_BYTE_COMPARISON_NOT_POSSIBLE',
]);

function invariant(value, message) { if (!value) throw new Error(message); }
function rel(root, p) { return path.join(root, ...p.split('/')); }
function read(root, p) { return fs.readFileSync(rel(root, p)); }
function json(root, p) { return JSON.parse(read(root, p).toString('utf8')); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function jsonBytes(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`); }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function aggregate(records) { return sha256(Buffer.from(records.map((x) => `${x.sha256}  ${x.path}\n`).join(''))); }
function hashRecord(root, p, role) { const b = read(root, p); return { path: p, role, bytes: b.length, sha256: sha256(b) }; }
function lower(value) { return String(value || '').toLowerCase(); }
function keccak256(root, hex) { return require(rel(root, 'tools/node_modules/ethers')).keccak256(hex); }

function listRunLatest(root) {
  const base = rel(root, 'targets/silo-contracts-v2/silo-vaults/broadcast');
  const rows = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name === 'run-latest.json') rows.push(path.relative(root, full).replace(/\\/g, '/'));
    }
  }
  walk(base);
  return rows.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function verifyV1(root) {
  return Object.entries(V1_HASHES).map(([p, expected]) => {
    const record = hashRecord(root, p, 'immutable-v1');
    invariant(record.sha256 === expected, `v1 immutability drift: ${p}`);
    return record;
  });
}

function validateStandardJsonObject(value) {
  invariant(value.language === 'Solidity', 'Standard JSON language');
  const sources = Object.entries(value.sources || {});
  invariant(sources.length === 54, 'Standard JSON source count');
  invariant(sources.every(([, source]) => typeof source.content === 'string' && source.content.length > 0), 'Standard JSON literal source omission');
  const settings = value.settings || {};
  invariant(same(settings.optimizer, { enabled: true, runs: 200 }), 'Standard JSON optimizer');
  invariant(settings.evmVersion === 'cancun' && settings.viaIR === false, 'Standard JSON EVM/viaIR');
  invariant(same(settings.metadata, { useLiteralContent: false, bytecodeHash: 'ipfs', appendCBOR: true }), 'Standard JSON IPFS metadata');
  invariant(settings.libraries?.['silo-vaults/contracts/SiloVaultsFactory.sol']?.SiloVaultFactoryActionsLib === COMMON_LIBRARY, 'Standard JSON library setting');
  invariant(Array.isArray(settings.remappings) && settings.remappings.length > 0, 'Standard JSON remappings');
  return true;
}

function reconstructFactory(root, expected, broadcast) {
  const txs = broadcast.transactions.filter((x) => x.contractName === 'SiloVaultsFactory');
  invariant(txs.length === 1, `factory transaction count: ${expected.chainId}`);
  const tx = txs[0];
  invariant(tx.transactionType === 'CREATE', `factory transaction type: ${expected.chainId}`);
  invariant(lower(tx.hash) === expected.txHash && lower(tx.contractAddress) === expected.address, `factory transaction hash/address: ${expected.chainId}`);
  invariant(lower(tx.transaction.chainId) === expected.chainHex, `factory transaction chain: ${expected.chainId}`);
  const input = lower(tx.transaction.input);
  invariant(/^0x[0-9a-f]+$/.test(input) && (input.length - 2) / 2 === 9179, `factory input shape: ${expected.chainId}`);
  invariant(input.slice(2 + 0x50 * 2, 2 + (0x50 + LAYOUT_DIRECTIVE.length / 2) * 2) === LAYOUT_DIRECTIVE, `factory constructor layout directive: ${expected.chainId}`);
  const moduleRows = tx.additionalContracts.filter((x) => x.contractName === 'VaultIncentivesModule');
  invariant(moduleRows.length === 1 && lower(moduleRows[0].address) === expected.module, `factory module additionalContracts: ${expected.chainId}`);
  invariant(/^0x[0-9a-f]+$/.test(lower(moduleRows[0].initCode)), `factory module initCode: ${expected.chainId}`);
  const receipts = broadcast.receipts.filter((x) => lower(x.transactionHash) === expected.txHash);
  invariant(receipts.length === 1, `factory matching receipt: ${expected.chainId}`);
  const receipt = receipts[0];
  invariant(receipt.status === '0x1' && lower(receipt.contractAddress) === expected.address, `factory receipt status/address: ${expected.chainId}`);
  invariant(receipt.logs.length === 1, `factory receipt log count: ${expected.chainId}`);
  const log = receipt.logs[0];
  invariant(lower(log.address) === expected.module && same(log.topics.map(lower), [MODULE_LOG_TOPIC]) && lower(log.data) === MODULE_LOG_DATA, `factory module receipt log: ${expected.chainId}`);

  let runtime = input.slice(2 + FACTORY_LAYOUT.constructorRuntimeOffset * 2, 2 + (FACTORY_LAYOUT.constructorRuntimeOffset + FACTORY_LAYOUT.constructorRuntimeLength) * 2);
  invariant(runtime.length / 2 === 2492, `factory runtime layout length: ${expected.chainId}`);
  for (const offset of FACTORY_LAYOUT.immutablePatchOffsets) invariant(runtime.slice(offset * 2, (offset + 32) * 2) === '0'.repeat(64), `factory immutable template slot: ${expected.chainId}/${offset}`);
  const libraryMatches = [...runtime.matchAll(/73([0-9a-f]{40})63e466ce56/g)];
  invariant(libraryMatches.length === 1 && libraryMatches[0].index / 2 === 376 && `0x${libraryMatches[0][1]}` === expected.library, `factory linked library: ${expected.chainId}`);
  const patch = expected.module.slice(2).padStart(64, '0');
  for (const offset of FACTORY_LAYOUT.immutablePatchOffsets) runtime = `${runtime.slice(0, offset * 2)}${patch}${runtime.slice((offset + 32) * 2)}`;
  const reconstructedHash = keccak256(root, `0x${runtime}`);
  invariant(reconstructedHash === expected.runtimeHash, `factory reconstructed runtime hash: ${expected.chainId}`);
  return {
    chainId: expected.chainId,
    chain: v1.CHAINS.find((x) => x.chainId === expected.chainId).chain,
    broadcast: { path: expected.path, sha256: expected.sha256, provenance: expected.predecessor ? 'PRIOR_STEP2_MANIFEST_BOUND_AND_R2_REBOUND' : 'NEWLY_R2_MANIFEST_BOUND' },
    transaction: { hash: expected.txHash, type: tx.transactionType, chainIdHex: expected.chainHex, contractAddress: expected.address, inputBytes: 9179 },
    receipt: { matchedByTransactionHash: true, status: receipt.status, contractAddress: lower(receipt.contractAddress), moduleLogExact: true, moduleLogTopic: MODULE_LOG_TOPIC },
    library: { address: expected.library, linkedRuntimeOffset: 377, exactInConstructorRuntime: true, arbitrumStandardJsonSettingMatch: expected.chainId === 42161 },
    moduleImmutable: { address: expected.module, additionalContractsExact: true, receiptLogExact: true, patchOffsets: [...FACTORY_LAYOUT.immutablePatchOffsets], patchLength: 32 },
    constructorRuntimeLayout: { offset: FACTORY_LAYOUT.constructorRuntimeOffset, length: FACTORY_LAYOUT.constructorRuntimeLength, outputBytes: 2492, directiveOffset: 0x50, directiveExact: true },
    reconstructedRuntime: { bytes: 2492, keccak256: reconstructedHash, retainedRuntimeKeccak256: expected.runtimeHash, exactByteHashMatch: true },
    exactRuntimeBound: true,
    mismatchClaimed: false,
  };
}

function verifyDirty(root) {
  const output = execFileSync('git', ['status', '--short', '--untracked-files=all'], { cwd: rel(root, 'targets/silo-contracts-v2'), encoding: 'utf8' });
  const rows = output.split(/\r?\n/).filter(Boolean).map((line) => ({ status: line.slice(0, 2), path: line.slice(3).replace(/\\/g, '/') }));
  const expected = Object.values(v1.EXPECTED_DIRTY).flat();
  invariant(rows.length === expected.length && same(rows.map((x) => x.path), expected), 'target dirty provenance drift');
  return { dirtyTargetObserved: true, exactSanitizedPaths: rows };
}

function searchVaultPreimages(root, broadcastPaths) {
  const addresses = v1.VAULTS.map((x) => lower(x.vault).slice(2));
  const bodies = broadcastPaths.map((p) => ({ path: p, body: read(root, p).toString('utf8').toLowerCase() }));
  const rows = v1.VAULTS.map((vault, index) => {
    const hits = bodies.filter((x) => x.body.includes(addresses[index])).map((x) => x.path);
    invariant(hits.length === 0, `vault address unexpectedly present in broadcasts: ${vault.vault}`);
    return {
      chainId: vault.chainId,
      chain: vault.chain,
      vault: vault.vault,
      retainedRuntimeHash: vault.runtimeHash,
      addressOccurrencesInBroadcasts: 0,
      creationTransactionPresent: false,
      creationCalldataOrInitCodePresent: false,
      deployedBytePreimagePresent: false,
      immutableClosurePresent: false,
      deepBound: false,
      exactRuntimeBound: false,
      binding: 'UNBOUND_NOT_MISMATCH',
      blockers: [...VAULT_BLOCKERS],
      historicalAuthorizationOnly: true,
    };
  });
  return { rows, searchedRunLatestFiles: broadcastPaths.length, addressesSearched: rows.length, totalAddressOccurrences: 0, creationTransactionsFound: 0, calldataOrInitCodePreimagesFound: 0, deployedBytePreimagesFound: 0, immutableClosuresFound: 0, deepBoundRows: 0 };
}

function deriveStatus(binding) {
  if (binding.factory.exactBoundChains !== 7) return 'BLOCKED_FACTORY_RUNTIME_BINDING';
  if (binding.vault.exactBoundRows !== 6) return STATUS;
  return 'RUNTIME_BINDING_COMPLETE_REQUIRES_SEPARATE_AUTHORIZATION_REVIEW';
}

function makeCore(root) {
  const immutableV1 = verifyV1(root);
  const standardRecord = hashRecord(root, STANDARD_JSON_PATH, 'factory-standard-json');
  invariant(standardRecord.sha256 === STANDARD_JSON_SHA256, 'Standard JSON hash drift');
  validateStandardJsonObject(json(root, STANDARD_JSON_PATH));
  const retained = json(root, 'reports/raw/fast/critical-silo-v3-public-allocator-deployment-economics-step2.json');
  v1.verifyStep2Rows(retained);
  const factoryRows = FACTORIES.map((expected) => {
    const record = hashRecord(root, expected.path, 'factory-broadcast');
    invariant(record.sha256 === expected.sha256, `factory broadcast hash drift: ${expected.chainId}`);
    const row = reconstructFactory(root, expected, json(root, expected.path));
    const retainedChain = retained.chains.find((x) => x.chainId === expected.chainId);
    invariant(lower(retainedChain.deployments.factory) === expected.address && retainedChain.deployments.factoryRuntime.codeKeccak256 === expected.runtimeHash, `retained factory binding drift: ${expected.chainId}`);
    return row;
  });
  const broadcastPaths = listRunLatest(root);
  invariant(broadcastPaths.length === 53, 'broadcast search file count drift');
  const vaultSearch = searchVaultPreimages(root, broadcastPaths);
  const dirty = verifyDirty(root);
  const runtimeBinding = {
    publicAllocator: { exactRetainedChains: 7, status: 'EXACT_RETAINED_CLAIM_ONLY' },
    factory: { exactBoundChains: 7, totalChains: 7, status: 'EXACT_RECONSTRUCTED_RUNTIME_7_OF_7', blockers: [], noBuildPerformed: true },
    vault: { exactBoundRows: 0, totalRows: 6, status: 'UNBOUND_NOT_MISMATCH', compilerSettingsClosureInheritedFromFactory: false, blockers: [...VAULT_BLOCKERS] },
    runtimeMismatchClaimed: false,
  };
  invariant(deriveStatus(runtimeBinding) === STATUS, 'R2 status derivation');
  const searchedRecords = broadcastPaths.map((p) => hashRecord(root, p, FACTORIES.some((x) => x.path === p) ? 'factory-broadcast' : 'vault-preimage-search'));
  return {
    schema: ID,
    schemaVersion: 2,
    version: '2.0.0',
    generatedAt: GENERATED_AT,
    mode: MODE,
    findingId: ID,
    oracleScope: ORACLE_SCOPE,
    correctionOf: { findingId: v1.ID, preservation: 'V1_FILES_BYTE_IDENTICAL', immutableV1Files: immutableV1, aggregateSha256: aggregate(immutableV1) },
    provenance: {
      standardJson: { ...standardRecord, sourceCount: 54, allSourcesLiteralContentPresent: true, optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', viaIR: false, metadataBytecodeHash: 'ipfs', librarySetting: COMMON_LIBRARY, validated: true },
      exactFactoryBroadcasts: FACTORIES.map((x) => ({ chainId: x.chainId, path: x.path, sha256: x.sha256 })),
      priorStep2ManifestBoundFactoryChains: [1, 56, 8453, 42161],
      newlyR2BoundFactoryChains: [146, 5000, 57073],
      broadcastSearch: { fileCount: searchedRecords.length, aggregateSha256: aggregate(searchedRecords), files: searchedRecords },
      dirtyTarget: dirty,
    },
    factoryRows,
    vaultSearch,
    vaultRows: vaultSearch.rows,
    aggregate: { factoryExactBoundChains: 7, factoryTotalChains: 7, vaultExactBoundRows: 0, vaultTotalRows: 6, searchedBroadcastFiles: broadcastPaths.length },
    runtimeBinding,
    authorizationSemanticsBoundary: 'No negative or positive current/global authorization classification is made without exact vault runtime semantics. Step2 authorization observations remain historical only.',
    dirtyTargetObserved: true,
    networkAttempted: false,
    forgeInvoked: false,
    buildPerformed: false,
    packageManagerInvoked: false,
    stateReadOrMutationAttempted: false,
    coordinationWritten: false,
    status: STATUS,
    admission: { authorizationDeltaNetworkRunnerAdmitted: false, admitted: false, reason: STATUS },
    gates: { routePositive: 'unknown', executableNow: 'unknown', signedActionJustified: false, fork: false, economics: 'UNASSESSED' },
    nextAction: 'CLOSE_ROTATE',
    reopenCondition: 'Future exact vault creation preimages and source/compiler/library/immutable verification become available.',
  };
}

function renderReport(core) {
  return Buffer.from([
    '# Silo V3 PublicAllocator Step 4 Gate0-R2', '',
    `Oracle scope: \`${ORACLE_SCOPE}\`  `,
    `Mode: \`${MODE}\`  `,
    `Status: **${STATUS}**  `,
    'Authorization-delta runner admitted: `false`.', '',
    '## Corrective decision', '',
    'R2 preserves every v1 file byte-identically and corrects only the factory conclusion. Seven exact local broadcasts plus the Arbitrum factory Standard JSON now establish exact reconstructed SiloVaultsFactory runtime binding on all seven retained chains. No build was performed.', '',
    'Vault binding remains `0/6`. An exact search of all 53 local Silo Vault `run-latest.json` broadcasts found none of the six retained vault addresses and therefore no creation transaction, calldata/init code, deployed-byte preimage, or immutable closure for those rows. Factory compiler settings are not inherited as vault closure. No runtime mismatch or current/global authorization claim is made.', '',
    '## Factory exact reconstruction', '',
    '| chain | provenance | factory | library | module immutable | runtime hash |',
    '|---|---|---|---|---|---|',
    ...core.factoryRows.map((x) => `| ${x.chain} (${x.chainId}) | ${x.broadcast.provenance} | ${x.transaction.contractAddress} | ${x.library.address} | ${x.moduleImmutable.address} | ${x.reconstructedRuntime.keccak256} |`), '',
    'Each row validates the exact broadcast hash, chain/address transaction, matching successful receipt and module log, linked library, module address from `additionalContracts` plus receipt log, constructor runtime layout offset `0x6d`/length `0x09bc`, 32-byte immutable patches at `0x99` and `0x2d6`, and exact 2,492-byte reconstructed runtime hash against the retained observation.', '',
    'Prior Step2 manifest-bound broadcast rows were chains `1,56,8453,42161`; R2 newly binds `146,5000,57073`. The bound Standard JSON SHA-256 is `6d536b5725d40f67ae0bd8eb754cd711b628f2419c347965889b7ee4e2abe0aa` and contains 54 literal source bodies with optimizer 200, Cancun, viaIR false, IPFS metadata, and the Arbitrum library setting.', '',
    '## Remaining vault blockers (all six rows)', '',
    ...VAULT_BLOCKERS.map((x) => `- \`${x}\``), '',
    '## Gates and safety', '',
    '- `routePositive="unknown"`; `executableNow="unknown"`',
    '- `signedActionJustified=false`; `fork=false`; `economics="UNASSESSED"`',
    '- `networkAttempted=false`; `forgeInvoked=false`; `buildPerformed=false`; `packageManagerInvoked=false`',
    '- `stateReadOrMutationAttempted=false`; `coordinationWritten=false`; `dirtyTargetObserved=true`',
    '- next action: `CLOSE_ROTATE` unless future vault preimages/source verification become available', '',
  ].join('\n'));
}

function validateArtifactData(a) {
  invariant(a.schema === ID && a.schemaVersion === 2 && a.version === '2.0.0' && a.mode === MODE && a.oracleScope === ORACLE_SCOPE, 'artifact schema/scope');
  invariant(a.factoryRows.length === 7 && same(a.factoryRows.map((x) => x.chainId), v1.CHAINS.map((x) => x.chainId)), 'artifact factory rows/order');
  invariant(a.factoryRows.every((x) => x.exactRuntimeBound && x.reconstructedRuntime.exactByteHashMatch), 'artifact factory exact reconstruction');
  invariant(a.runtimeBinding.factory.exactBoundChains === 7 && a.runtimeBinding.factory.blockers.length === 0, 'artifact factory exact promotion');
  invariant(a.vaultRows.length === 6 && a.vaultRows.every((x) => !x.exactRuntimeBound && !x.deepBound && x.binding === 'UNBOUND_NOT_MISMATCH'), 'artifact vault rows/deep binding');
  invariant(a.runtimeBinding.vault.exactBoundRows === 0 && a.runtimeBinding.vault.compilerSettingsClosureInheritedFromFactory === false, 'artifact vault false exact/inherited closure');
  invariant(a.vaultSearch.searchedRunLatestFiles === 53 && a.vaultSearch.totalAddressOccurrences === 0 && a.vaultSearch.deepBoundRows === 0, 'artifact vault preimage absence');
  invariant(a.runtimeBinding.runtimeMismatchClaimed === false, 'artifact mismatch claim');
  invariant(a.buildPerformed === false && a.networkAttempted === false && a.forgeInvoked === false && a.packageManagerInvoked === false && a.stateReadOrMutationAttempted === false && a.coordinationWritten === false, 'artifact offline/no-build provenance');
  invariant(a.dirtyTargetObserved === true, 'artifact dirty provenance');
  invariant(deriveStatus(a.runtimeBinding) === STATUS && a.status === STATUS, 'artifact status');
  invariant(a.admission.admitted === false && a.admission.authorizationDeltaNetworkRunnerAdmitted === false, 'artifact admission');
  invariant(same(a.gates, { routePositive: 'unknown', executableNow: 'unknown', signedActionJustified: false, fork: false, economics: 'UNASSESSED' }), 'artifact gates');
  invariant(a.nextAction === 'CLOSE_ROTATE', 'artifact next action');
  return true;
}

function manifestInputPaths(root) {
  const broadcasts = listRunLatest(root);
  return [
    `tools/analyze-${ID}.js`, `tools/test-${ID}.js`, OUTPUT_PATHS.artifact, OUTPUT_PATHS.report,
    ...Object.keys(V1_HASHES),
    'reports/raw/fast/critical-silo-v3-public-allocator-deployment-economics-step2.json',
    'reports/raw/fast/critical-silo-v3-public-allocator-deployment-economics-step2-manifest.json',
    STANDARD_JSON_PATH,
    ...broadcasts,
    'tools/node_modules/ethers/package.json', 'tools/node_modules/ethers/lib.commonjs/index.js',
  ];
}

function roleFor(p) {
  if (p.startsWith('tools/analyze-') || p.startsWith('tools/test-')) return 'tool';
  if (p === OUTPUT_PATHS.artifact) return 'artifact';
  if (p === OUTPUT_PATHS.report) return 'report';
  if (Object.hasOwn(V1_HASHES, p)) return 'immutable-v1';
  if (p === STANDARD_JSON_PATH) return 'factory-standard-json';
  if (p.includes('/broadcast/')) return FACTORIES.some((x) => x.path === p) ? 'factory-broadcast-and-vault-search' : 'vault-preimage-search';
  return 'retained-or-runtime-dependency';
}

function buildBundle(root = ROOT) {
  const core = makeCore(root);
  const reportBytes = renderReport(core);
  const artifact = { ...core, reportBinding: { path: OUTPUT_PATHS.report, bytes: reportBytes.length, sha256: sha256(reportBytes) } };
  validateArtifactData(artifact);
  const artifactBytes = jsonBytes(artifact);
  const paths = manifestInputPaths(root);
  invariant(new Set(paths).size === paths.length, 'manifest duplicate input path');
  const memory = new Map([[OUTPUT_PATHS.artifact, artifactBytes], [OUTPUT_PATHS.report, reportBytes]]);
  const files = paths.map((p) => { const b = memory.get(p) || read(root, p); return { path: p, role: roleFor(p), bytes: b.length, sha256: sha256(b) }; });
  const manifest = {
    schema: `${ID}-manifest`, schemaVersion: 2, version: '2.0.0', generatedAt: GENERATED_AT, mode: MODE, findingId: ID,
    oracleScope: ORACLE_SCOPE, algorithm: 'sha256', manifestSelfHashExcluded: true, immutableNoReplaceGeneration: true,
    metadata: { status: STATUS, factoryExactBoundChains: 7, vaultExactBoundRows: 0, factoryChainIds: FACTORIES.map((x) => x.chainId), standardJsonSha256: STANDARD_JSON_SHA256, v1AggregateSha256: core.correctionOf.aggregateSha256, broadcastSearchFileCount: 53, broadcastSearchAggregateSha256: core.provenance.broadcastSearch.aggregateSha256 },
    fileCount: files.length, exactPathOrder: paths, files, aggregateSha256: aggregate(files),
  };
  return { reportBytes, artifact, artifactBytes, manifest, manifestBytes: jsonBytes(manifest) };
}

function validateManifestData(m, expected) {
  invariant(m.schema === `${ID}-manifest` && m.schemaVersion === 2 && m.version === '2.0.0' && m.oracleScope === ORACLE_SCOPE, 'manifest schema/scope');
  invariant(m.metadata.status === STATUS && m.metadata.factoryExactBoundChains === 7 && m.metadata.vaultExactBoundRows === 0, 'manifest status/counts');
  invariant(same(m.metadata.factoryChainIds, FACTORIES.map((x) => x.chainId)) && m.metadata.standardJsonSha256 === STANDARD_JSON_SHA256, 'manifest chain/Standard JSON metadata');
  invariant(m.metadata.broadcastSearchFileCount === 53, 'manifest broadcast count');
  invariant(m.fileCount === m.files.length && same(m.exactPathOrder, m.files.map((x) => x.path)), 'manifest path order/count');
  invariant(new Set(m.files.map((x) => x.path)).size === m.files.length, 'manifest duplicate path');
  invariant(m.aggregateSha256 === aggregate(m.files), 'manifest aggregate');
  if (expected) invariant(same(m, expected), 'manifest deterministic binding');
  return true;
}

function validateBundle(root = ROOT) {
  const expected = buildBundle(root);
  const report = read(root, OUTPUT_PATHS.report), artifactBytes = read(root, OUTPUT_PATHS.artifact), manifestBytes = read(root, OUTPUT_PATHS.manifest);
  invariant(report.equals(expected.reportBytes), 'report byte binding');
  invariant(artifactBytes.equals(expected.artifactBytes), 'artifact byte binding');
  invariant(manifestBytes.equals(expected.manifestBytes), 'manifest byte binding');
  const artifact = JSON.parse(artifactBytes), manifest = JSON.parse(manifestBytes);
  validateArtifactData(artifact); validateManifestData(manifest, expected.manifest);
  invariant(artifact.reportBinding.bytes === report.length && artifact.reportBinding.sha256 === sha256(report), 'artifact report binding');
  for (const row of manifest.files) { const b = read(root, row.path); invariant(b.length === row.bytes && sha256(b) === row.sha256, `manifest file drift: ${row.path}`); }
  return { artifact, manifest };
}

function writeNoReplace(root, entries) {
  for (const [p] of entries) invariant(!fs.existsSync(rel(root, p)), `immutable generation refuses existing output: ${p}`);
  for (const [p, bytes] of entries) fs.writeFileSync(rel(root, p), bytes, { flag: 'wx' });
}

function generate(root = ROOT) {
  const bundle = buildBundle(root);
  writeNoReplace(root, [[OUTPUT_PATHS.report, bundle.reportBytes], [OUTPUT_PATHS.artifact, bundle.artifactBytes], [OUTPUT_PATHS.manifest, bundle.manifestBytes]]);
  return bundle;
}

function main() {
  const args = process.argv.slice(2);
  invariant(args.length <= 1 && (args.length === 0 || args[0] === '--check-only'), 'usage: analyzer [--check-only]');
  if (args[0] === '--check-only') {
    const result = validateBundle(ROOT);
    process.stdout.write(`PASS ${ID} check-only files=${result.manifest.fileCount} aggregate=${result.manifest.aggregateSha256}\n`);
  } else {
    const result = generate(ROOT);
    process.stdout.write(`WROTE ${ID} files=3 manifestFiles=${result.manifest.fileCount} aggregate=${result.manifest.aggregateSha256}\n`);
  }
}

if (require.main === module) { try { main(); } catch (error) { process.stderr.write(`FAIL ${error.message}\n`); process.exitCode = 1; } }

module.exports = { FACTORIES, FACTORY_LAYOUT, ID, MODE, ORACLE_SCOPE, OUTPUT_PATHS, ROOT, STANDARD_JSON_PATH, STANDARD_JSON_SHA256, STATUS, V1_HASHES, VAULT_BLOCKERS, aggregate, buildBundle, deriveStatus, generate, listRunLatest, reconstructFactory, searchVaultPreimages, sha256, validateArtifactData, validateBundle, validateManifestData, validateStandardJsonObject, verifyV1, writeNoReplace };
