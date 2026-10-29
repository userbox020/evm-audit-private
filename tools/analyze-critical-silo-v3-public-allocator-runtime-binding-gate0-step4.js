#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ID = 'critical-silo-v3-public-allocator-runtime-binding-gate0-step4';
const MODE = 'OFFLINE_PREFLIGHT_NO_EXECUTION';
const STATUS = 'BLOCKED_FACTORY_VAULT_RUNTIME_BINDING';
const GENERATED_AT = '2026-08-07T00:00:00.000Z';
const TARGET_COMMIT = '94c20ef94041345cce7f216f4914a8cbea861be4';

const OUTPUT_PATHS = {
  report: `reports/${ID}.md`,
  artifact: `reports/raw/fast/${ID}.json`,
  manifest: `reports/raw/fast/${ID}-manifest.json`,
};

const RETAINED_AUTHORITY = Object.freeze({
  'reports/critical-silo-v3-public-allocator-reallocation-conservation-step1.md': 'd64efa64d655d18ce44560eeb25fc2f584f2de899ff1896e5c8e4792a5355d66',
  'reports/raw/fast/critical-silo-v3-public-allocator-reallocation-conservation-step1.json': 'e1ff5c4882fd1b0d26f43e105331f95364ab04545a46152a3d1d1d4010b597ae',
  'reports/raw/fast/critical-silo-v3-public-allocator-reallocation-conservation-step1-metadata.json': 'f43130295eebc96c229c5d69af17483380c0f75b68cf351f2136ff77a425cb73',
  'reports/raw/fast/critical-silo-v3-public-allocator-reallocation-conservation-step1-manifest.json': '18e58cb97199059588481dcf310744b2df4dc8d90c79b618452a7b0b89f971b7',
  'reports/critical-silo-v3-public-allocator-deployment-economics-step2.md': 'eb1f1bf230cd1762f621dc7806e2c696f2a16bb9ad69056d739fffa6fac401ff',
  'reports/raw/fast/critical-silo-v3-public-allocator-deployment-economics-step2.json': 'd9da2ccc2cc81a9e388d0a6a8e915da24488bfcbeb0519aa11e9c043b196b1fd',
  'reports/raw/fast/critical-silo-v3-public-allocator-deployment-economics-step2-manifest.json': '39231e43d5015747522570f7c3a0cd6fb82fc4a3d8b966bb606c0df81b83660e',
  'reports/raw/fast/critical-silo-v3-public-allocator-deployment-economics-step2-retained-r1.json': 'a93859dfd39fd40b1bef3ea27b4a7af2e53a8172640e19a8a665630d39026cce',
  'reports/raw/fast/critical-silo-v3-public-allocator-deployment-economics-step2-manifest-retained-r1.json': '202e6cb75b56d47e04f8e7bc9c2551b0312ca8bff6f0da2deac895c91d077430',
  'reports/critical-silo-v3-public-allocator-deployment-economics-step3.md': 'dd2be4c53c6f4d86ae94a2b97b9291afeba995510aeb23f941aa43e233e578cb',
  'reports/raw/fast/critical-silo-v3-public-allocator-deployment-economics-step3.json': '136259a660346601c06043c92c83799f6d731bca78e7dc84faf035a794d3ddc1',
});

const SOURCE_CONFIG_PATHS = Object.freeze([
  'targets/silo-contracts-v2/foundry.toml',
  'targets/silo-contracts-v2/remappings.txt',
  'targets/silo-contracts-v2/package.json',
  'targets/silo-contracts-v2/yarn.lock',
  'targets/silo-contracts-v2/silo-vaults/package.json',
  'targets/silo-contracts-v2/common/utils/Create2Factory.sol',
  'targets/silo-contracts-v2/silo-vaults/contracts/PublicAllocator.sol',
  'targets/silo-contracts-v2/silo-vaults/contracts/SiloVaultsFactory.sol',
  'targets/silo-contracts-v2/silo-vaults/contracts/SiloVault.sol',
  'targets/silo-contracts-v2/silo-vaults/contracts/interfaces/IPublicAllocator.sol',
  'targets/silo-contracts-v2/silo-vaults/contracts/interfaces/ISiloVault.sol',
  'targets/silo-contracts-v2/silo-vaults/contracts/interfaces/ISiloVaultsFactory.sol',
  'targets/silo-contracts-v2/silo-vaults/contracts/interfaces/IIncentivesClaimingLogic.sol',
  'targets/silo-contracts-v2/silo-vaults/contracts/interfaces/IIncentivesClaimingLogicFactory.sol',
  'targets/silo-contracts-v2/silo-vaults/contracts/interfaces/INotificationReceiver.sol',
  'targets/silo-contracts-v2/silo-vaults/contracts/interfaces/IVaultIncentivesModule.sol',
  'targets/silo-contracts-v2/silo-vaults/contracts/libraries/ConstantsLib.sol',
  'targets/silo-contracts-v2/silo-vaults/contracts/libraries/ErrorsLib.sol',
  'targets/silo-contracts-v2/silo-vaults/contracts/libraries/EventsLib.sol',
  'targets/silo-contracts-v2/silo-vaults/contracts/libraries/PendingLib.sol',
  'targets/silo-contracts-v2/silo-vaults/contracts/libraries/SiloVaultActionsLib.sol',
  'targets/silo-contracts-v2/silo-vaults/contracts/libraries/SiloVaultFactoryActionsLib.sol',
  'targets/silo-contracts-v2/silo-vaults/contracts/incentives/VaultIncentivesModule.sol',
]);

const BUILD_INPUT_PATHS = Object.freeze([
  'targets/silo-contracts-v2/cache/foundry/out/silo-public-allocator-step1-r2-final/PublicAllocator.sol/PublicAllocator.json',
  'targets/silo-contracts-v2/cache/foundry/out/silo-public-allocator-step1-r2-final/SiloVault.sol/SiloVault.json',
  'targets/silo-contracts-v2/cache/foundry/out/silo-public-allocator-step1-r2-final/SiloVaultActionsLib.sol/SiloVaultActionsLib.json',
  'targets/silo-contracts-v2/cache/foundry/out/silo-public-allocator-step1-r2-final/build-info/6630e73532e6c64d.json',
  'tools/node_modules/ethers/package.json',
  'tools/node_modules/ethers/lib.commonjs/index.js',
]);

const CHAINS = Object.freeze([
  { chainId: 1, chain: 'mainnet', pinNumber: '25635004', pinHash: '0xc1ad2af578ba164c5bd4ae007c28402eba661015a8edb42320f7409478b62e6a', publicAllocator: '0xafBB4891D49Aab0d71251a4d47cAd582a47465e9', publicAllocatorRuntimeHash: '0xc9449b2872d72040876f1fe3541998e7c77bfd2385fc7fd2143e94086308ecaa', factory: '0xFfD3cB64ec6Fb68432792e4E902F62192a420506', factoryRuntimeHash: '0x61a166bf55fe01859fca458cdebd33cfd3991b88c00acc60b4e1d55327da5acc' },
  { chainId: 56, chain: 'bnb', pinNumber: '112726842', pinHash: '0x6f82e510c501498c8d1402fea3d83631b1534e578246dd0f1ac53b64e353b054', publicAllocator: '0x9Ea2867DBb81DDd45D28276F513622988fE21A10', publicAllocatorRuntimeHash: '0xc9449b2872d72040876f1fe3541998e7c77bfd2385fc7fd2143e94086308ecaa', factory: '0x16876aF41E8beDdBF9B67D2B66Bb50Abf3503B1C', factoryRuntimeHash: '0x6d23df16b631c36ed22ac0c83a4a4c06513def71b541dc35c14d4f4a953a9feb' },
  { chainId: 146, chain: 'sonic', pinNumber: '76679053', pinHash: '0xcc29a6a87a00d6b4aa139aed197191dbe06633f6e51d10393cb3baed353a32c5', publicAllocator: '0xC95149D52dA227cfeb0425ac6803086Db5A193b7', publicAllocatorRuntimeHash: '0x8812e5a573f92a981f5245c3b2bf83b3ba20830e62d398cf8c1084cfb85ff5ab', factory: '0x4B8Cbf30c9DC9d28ce56EeED40BF23B5FD6457B6', factoryRuntimeHash: '0xcc7466c5967d03defb855dd7c4d1960755905282e809522aa221a7454ec9a0db' },
  { chainId: 5000, chain: 'mantle', pinNumber: '98577486', pinHash: '0x890e141d872c9ee3b3d93d7dbc0a6f00690f81a77c2eed2974000b068297f644', publicAllocator: '0xB2886994d8E7d84759b6e08D465094E71BfBad67', publicAllocatorRuntimeHash: '0xc9d1b0566c96d5673777231e56e815405789dd847465816a267d388f3ec78068', factory: '0x4A6c34A6B8F5C1a1Dcdc4be664cbC1259a0737a6', factoryRuntimeHash: '0xa8969255469d4d8ca49a866df3249643e5509e4df5b8f6c021d2598b266da7ce' },
  { chainId: 8453, chain: 'base', pinNumber: '49245954', pinHash: '0xeb36bbf14484ed09f7663d1d4e2f263dc5db65bf4b60c4a36cabad95b374ded1', publicAllocator: '0x4C5526Ad3546819eE86fE3499D997453A3178043', publicAllocatorRuntimeHash: '0xc9449b2872d72040876f1fe3541998e7c77bfd2385fc7fd2143e94086308ecaa', factory: '0x2534b2e33076787142246750E9340696267B96be', factoryRuntimeHash: '0x5f50fb4c92f333f48be0f5ac79befb7ea6f4e151efaa4bb830bf44fd8815ae3f' },
  { chainId: 42161, chain: 'arbitrum_one', pinNumber: '488777728', pinHash: '0x85ab83e9600007e21ff847e4de2dfc276489d94d47fe63c075b8447087d44413', publicAllocator: '0x75153A486244dAe7C469CB2098C200f01f93a99B', publicAllocatorRuntimeHash: '0xc9449b2872d72040876f1fe3541998e7c77bfd2385fc7fd2143e94086308ecaa', factory: '0x2976d3Ea35adcd185bBF79b201424f9607D49D30', factoryRuntimeHash: '0x8b21f3a8619b5a56ec4eccaf477a727dab88d62c462b2c27523936c796a11515' },
  { chainId: 57073, chain: 'ink', pinNumber: '51786975', pinHash: '0xece0d62a59c621caa8059c9fd74fb998e900db0424f4c6a1a7eec21f37a1fe08', publicAllocator: '0x5a040892094293A052Db6feCbC781d26fc29CceB', publicAllocatorRuntimeHash: '0x4c79ec25901e35f6982743471a7f492f7a369d94fdb97b6caa16a8ff930b7fb5', factory: '0xf279eeC12a1936b0786A4ce51e71E77132A04ef3', factoryRuntimeHash: '0x5215c2510b5bd1c7c1860727986b2a0cefdca06f2eb06bc48150e3faa516a930' },
]);

const VAULTS = Object.freeze([
  { chainId: 56, chain: 'bnb', vault: '0x0365De2a04775f4494C74f71F03Cc13E4Cc93039', creationBlock: 96750189, runtimeHash: '0x43a782434ea58b59d36995c515f061a9d29931bc97d1ee7567cb0f8a49ad92b9' },
  { chainId: 56, chain: 'bnb', vault: '0xBdb8B501636E9b6e4Dd1fa629FB87Ee7909EB846', creationBlock: 96750571, runtimeHash: '0x646a572fcda76e8583bf9d7be59d2c803879df05006eb3182aaca468e502dc2a' },
  { chainId: 42161, chain: 'arbitrum_one', vault: '0x5134dD226ba8F035224C2d393D6d5a41D006C018', creationBlock: 437886842, runtimeHash: '0x8e94f495da01de45eaaf630813f7eb223bd6b4d7e137da6c3093f5af13aa458d' },
  { chainId: 42161, chain: 'arbitrum_one', vault: '0xAE95aDd7226aeE19B77Cfed0E252F0395d41F946', creationBlock: 438207054, runtimeHash: '0x68537181bf645aa3f68b657c34bd95fcd94af4003b97e1ec87bf07db44ced9fe' },
  { chainId: 42161, chain: 'arbitrum_one', vault: '0x159CD30288c687353a672dBB1e482fc4c18f3e66', creationBlock: 450264806, runtimeHash: '0x0d6e9ca5cbce7e049030d1a1abc316d0cce4ce070cbe50467636a176d7a15422' },
  { chainId: 42161, chain: 'arbitrum_one', vault: '0x817a5EFF6FbD7c8445D6823175DbA8F2dc42A184', creationBlock: 476559114, runtimeHash: '0xfa0e24c1ff087fed9c18540e3bcdc0e5260afb7d70d5ce270c5474096c3f008f' },
]);

const EXPECTED_DIRTY = Object.freeze({
  trackedModifiedGitlinks: ['gitmodules/aave-v3-origin', 'gitmodules/chainlink', 'gitmodules/chainlink-ccip', 'gitmodules/pyth-sdk-solidity', 'gitmodules/uniswap/v3-core', 'gitmodules/uniswap/v3-periphery'],
  trackedModifiedPackageFiles: ['silo-vaults/package.json'],
  untrackedRootAuditScripts: ['classify-silo-oracles.js', 'probe-silo-id.js', 'scan-share-holders.js', 'scan-silo-live.js', 'scan-silo-vaults.js', 'scan-zero-oracle-pairs.js'],
  untrackedAuditTests: ['silo-vaults/test/foundry/audit/SiloPublicAllocatorReallocationConservationStep1.t.sol', 'silo-vaults/test/foundry/audit/SiloVaultRewardClaimConservationStep1.t.sol'],
});

const FACTORY_BLOCKERS = Object.freeze([
  'FACTORY_SETTINGS_CLOSURE_MISSING',
  'FACTORY_LIBRARY_LINK_REFERENCE_METADATA_MISSING',
  'FACTORY_LIBRARY_ADDRESS_UNRESOLVED',
  'FACTORY_IMMUTABLE_REFERENCE_METADATA_MISSING',
  'FACTORY_IMMUTABLE_VALUE_UNRESOLVED',
  'FACTORY_DETERMINISTIC_RUNTIME_UNAVAILABLE',
  'FACTORY_BYTE_COMPARISON_NOT_POSSIBLE',
]);
const VAULT_BLOCKERS = Object.freeze([
  'VAULT_LIBRARY_ADDRESS_UNRESOLVED',
  'VAULT_IMMUTABLE_VALUES_UNRESOLVED',
  'VAULT_DETERMINISTIC_RUNTIME_UNAVAILABLE',
  'VAULT_DEPLOYED_BYTECODE_NOT_RETAINED',
  'VAULT_BYTE_COMPARISON_NOT_POSSIBLE',
]);

const DEPLOYMENT_PATHS = Object.freeze(CHAINS.flatMap((c) => [
  `targets/silo-contracts-v2/silo-vaults/deployments/${c.chain}/PublicAllocator.sol.json`,
  `targets/silo-contracts-v2/silo-vaults/deployments/${c.chain}/SiloVaultsFactory.sol.json`,
]));

const MANIFEST_PATHS = Object.freeze([
  `tools/analyze-${ID}.js`,
  `tools/test-${ID}.js`,
  OUTPUT_PATHS.artifact,
  OUTPUT_PATHS.report,
  ...Object.keys(RETAINED_AUTHORITY),
  ...SOURCE_CONFIG_PATHS,
  ...BUILD_INPUT_PATHS,
  ...DEPLOYMENT_PATHS,
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function rel(root, relativePath) {
  return path.join(root, ...relativePath.split('/'));
}

function readBytes(root, relativePath) {
  return fs.readFileSync(rel(root, relativePath));
}

function readJson(root, relativePath) {
  return JSON.parse(readBytes(root, relativePath).toString('utf8'));
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hashRecord(root, relativePath, role) {
  const bytes = readBytes(root, relativePath);
  return { path: relativePath, role, bytes: bytes.length, sha256: sha256(bytes) };
}

function aggregate(records) {
  return sha256(Buffer.from(records.map((r) => `${r.sha256}  ${r.path}\n`).join(''), 'utf8'));
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function compilerObject(artifact) {
  return artifact.metadata && artifact.metadata.compiler ? artifact.metadata.compiler : null;
}

function bytecodeObject(value) {
  return typeof value === 'string' ? value : value && value.object;
}

function placeholderIds(value) {
  return [...new Set((value.match(/__\$[0-9a-fA-F]{34}\$__/g) || []))];
}

function keccak256(root, hex) {
  const ethers = require(rel(root, 'tools/node_modules/ethers'));
  return ethers.keccak256(hex);
}

function verifyRetainedAuthority(root) {
  return Object.entries(RETAINED_AUTHORITY).map(([p, expected]) => {
    const record = hashRecord(root, p, 'retained-authority');
    invariant(record.sha256 === expected, `retained authority hash drift: ${p}`);
    return record;
  });
}

function verifyStep2Rows(step2) {
  const retained = step2.chains.filter((row) => CHAINS.some((c) => c.chainId === row.chainId));
  invariant(retained.length === 7, 'Step2 retained chain count must be seven');
  invariant(same(retained.map((x) => x.chainId), CHAINS.map((x) => x.chainId)), 'Step2 retained chain order drift');
  for (const expected of CHAINS) {
    const row = retained.find((x) => x.chainId === expected.chainId);
    invariant(row.chain === expected.chain, `Step2 chain name drift: ${expected.chainId}`);
    invariant(row.pin.number === expected.pinNumber && row.pin.hash === expected.pinHash, `Step2 pin drift: ${expected.chainId}`);
    invariant(row.deployments.publicAllocator === expected.publicAllocator, `Step2 PublicAllocator address drift: ${expected.chainId}`);
    invariant(row.deployments.publicAllocatorRuntime.codeKeccak256 === expected.publicAllocatorRuntimeHash, `Step2 PublicAllocator runtime drift: ${expected.chainId}`);
    invariant(row.deployments.factory === expected.factory, `Step2 factory address drift: ${expected.chainId}`);
    invariant(row.deployments.factoryRuntime.codeKeccak256 === expected.factoryRuntimeHash, `Step2 factory runtime drift: ${expected.chainId}`);
  }
  const vaults = retained.flatMap((row) => row.vaults.map((v) => ({ chainId: row.chainId, chain: row.chain, ...v })));
  invariant(vaults.length === 6, 'Step2 known vault count must be six');
  for (let i = 0; i < VAULTS.length; i += 1) {
    const actual = vaults[i];
    const expected = VAULTS[i];
    invariant(actual.chainId === expected.chainId && actual.vault === expected.vault, `Step2 vault address/order drift: ${i}`);
    invariant(actual.creationBlock === expected.creationBlock, `Step2 vault creation block drift: ${expected.vault}`);
    invariant(actual.runtime.codeKeccak256 === expected.runtimeHash, `Step2 vault runtime drift: ${expected.vault}`);
    invariant(actual.authorization.publicAllocatorAuthorized === false, `Step2 historical authorization drift: ${expected.vault}`);
    invariant(actual.authorization.deployedVaultRuntimeSemanticsBound === false, `Step2 vault semantics false promotion: ${expected.vault}`);
  }
  return vaults;
}

function observeDirtyStatus(root) {
  const target = rel(root, 'targets/silo-contracts-v2');
  const output = execFileSync('git', ['status', '--short', '--untracked-files=all'], { cwd: target, encoding: 'utf8' });
  const rows = output.split(/\r?\n/).filter(Boolean).map((line) => ({ status: line.slice(0, 2), path: line.slice(3).replace(/\\/g, '/') }));
  const observed = {
    trackedModifiedGitlinks: rows.filter((r) => r.status === ' M' && r.path.startsWith('gitmodules/')).map((r) => r.path),
    trackedModifiedPackageFiles: rows.filter((r) => r.status === ' M' && r.path.endsWith('package.json')).map((r) => r.path),
    untrackedRootAuditScripts: rows.filter((r) => r.status === '??' && !r.path.includes('/') && r.path.endsWith('.js')).map((r) => r.path),
    untrackedAuditTests: rows.filter((r) => r.status === '??' && r.path.startsWith('silo-vaults/test/foundry/audit/')).map((r) => r.path),
  };
  invariant(rows.length === Object.values(observed).flat().length, 'unexpected dirty target path category observed');
  invariant(same(observed, EXPECTED_DIRTY), 'target dirty-state drift from sanitized exact observation');
  return observed;
}

function inventoryArtifacts(root, step2) {
  const publicAllocatorArtifacts = [];
  const factoryArtifacts = [];
  for (const expected of CHAINS) {
    const paPath = `targets/silo-contracts-v2/silo-vaults/deployments/${expected.chain}/PublicAllocator.sol.json`;
    const factoryPath = `targets/silo-contracts-v2/silo-vaults/deployments/${expected.chain}/SiloVaultsFactory.sol.json`;
    const pa = readJson(root, paPath);
    const factory = readJson(root, factoryPath);
    const paRuntime = bytecodeObject(pa.deployedBytecode);
    const factoryRuntime = bytecodeObject(factory.deployedBytecode);
    invariant(pa.address === expected.publicAllocator, `deployment artifact PublicAllocator address drift: ${expected.chainId}`);
    invariant(/^0x[0-9a-fA-F]*$/.test(paRuntime), `PublicAllocator deterministic runtime missing: ${expected.chainId}`);
    invariant(keccak256(root, paRuntime) === expected.publicAllocatorRuntimeHash, `retained PublicAllocator artifact claim drift: ${expected.chainId}`);
    invariant(factory.address === expected.factory, `deployment artifact factory address drift: ${expected.chainId}`);
    const placeholders = placeholderIds(factoryRuntime);
    invariant(placeholders.length > 0, `factory artifact unexpectedly exact-promoted: ${expected.chainId}`);
    publicAllocatorArtifacts.push({ path: paPath, address: pa.address, compiler: pa.compiler, runtimeBytes: (paRuntime.length - 2) / 2, runtimeKeccak256: expected.publicAllocatorRuntimeHash, unresolvedPlaceholders: 0 });
    factoryArtifacts.push({ path: factoryPath, address: factory.address, compiler: factory.compiler, runtimeTemplateCharacters: factoryRuntime.length, unresolvedPlaceholders: placeholders, exactRuntimeAvailable: false });
  }

  const focusedPaPath = BUILD_INPUT_PATHS[0];
  const focusedVaultPath = BUILD_INPUT_PATHS[1];
  const focusedPa = readJson(root, focusedPaPath);
  const focusedVault = readJson(root, focusedVaultPath);
  const paSettings = focusedPa.metadata && focusedPa.metadata.settings;
  const vaultSettings = focusedVault.metadata && focusedVault.metadata.settings;
  const vaultRuntime = bytecodeObject(focusedVault.deployedBytecode);
  const vaultLinks = focusedVault.deployedBytecode.linkReferences || {};
  const vaultImmutables = focusedVault.deployedBytecode.immutableReferences || {};
  invariant(compilerObject(focusedPa).version === '0.8.28+commit.7893614a', 'focused PublicAllocator compiler drift');
  invariant(compilerObject(focusedVault).version === '0.8.28+commit.7893614a', 'focused vault compiler drift');
  invariant(paSettings.optimizer.enabled === true && paSettings.optimizer.runs === 200 && paSettings.evmVersion === 'cancun', 'focused PublicAllocator settings drift');
  invariant(vaultSettings.optimizer.enabled === true && vaultSettings.optimizer.runs === 200 && vaultSettings.evmVersion === 'cancun', 'focused vault settings drift');
  invariant(placeholderIds(vaultRuntime).length > 0, 'focused vault runtime unexpectedly fully linked');
  invariant(Object.keys(vaultLinks).length > 0, 'focused vault link references missing');
  invariant(Object.keys(vaultImmutables).length > 0, 'focused vault immutable references missing');

  return {
    deploymentArtifacts: { publicAllocator: publicAllocatorArtifacts, factory: factoryArtifacts },
    focusedCompiledArtifacts: {
      publicAllocator: { path: focusedPaPath, compiler: compilerObject(focusedPa).version, settingsAvailable: true, librarySettings: paSettings.libraries, linkReferences: focusedPa.deployedBytecode.linkReferences || {}, deterministicRuntimeAvailable: true, runtimeKeccak256: keccak256(root, bytecodeObject(focusedPa.deployedBytecode)), retainedDeploymentComparisonAuthority: false },
      factory: { path: null, present: false, deterministicRuntimeAvailable: false },
      vault: { path: focusedVaultPath, compiler: compilerObject(focusedVault).version, settingsAvailable: true, librarySettings: vaultSettings.libraries, linkReferences: vaultLinks, libraryAddressesResolved: false, immutableReferences: vaultImmutables, immutableValuesResolved: false, unresolvedPlaceholders: placeholderIds(vaultRuntime), deterministicRuntimeAvailable: false },
    },
    buildInfo: { path: BUILD_INPUT_PATHS[3], fullStandardJsonInputPresent: false, sourceIdMapOnly: true },
    retainedRuntimeObservationCounts: { publicAllocator: 7, factory: 7, vault: 6 },
    exactSourceClosureEstablished: false,
    note: 'Inventory presence is not exact runtime binding. Factory and vault closure remains incomplete without deterministic fully linked/immutable-patched runtime bytes and an exact retained deployed-byte preimage comparison.',
  };
}

function deriveStatus(runtimeBinding) {
  const paExact = runtimeBinding.publicAllocator.exactRetainedChains === 7;
  const factoryExact = runtimeBinding.factory.exactBoundChains === 7;
  const vaultExact = runtimeBinding.vault.exactBoundRows === 6;
  if (paExact && factoryExact && vaultExact) return 'RUNTIME_BINDING_COMPLETE_REQUIRES_SEPARATE_AUTHORIZATION_REVIEW';
  if (!factoryExact || !vaultExact) return STATUS;
  return 'BLOCKED_PUBLIC_ALLOCATOR_RUNTIME_BINDING';
}

function makeCore(root) {
  const retainedHashes = verifyRetainedAuthority(root);
  const step2 = readJson(root, 'reports/raw/fast/critical-silo-v3-public-allocator-deployment-economics-step2.json');
  verifyStep2Rows(step2);
  const dirty = observeDirtyStatus(root);
  const artifactInventory = inventoryArtifacts(root, step2);
  const sourceConfigBuildHashes = [...SOURCE_CONFIG_PATHS, ...BUILD_INPUT_PATHS, ...DEPLOYMENT_PATHS].map((p) => hashRecord(root, p, SOURCE_CONFIG_PATHS.includes(p) ? 'source-config' : 'build-artifact'));

  const chains = CHAINS.map((c) => ({
    chainId: c.chainId,
    chain: c.chain,
    pin: { number: c.pinNumber, hash: c.pinHash },
    publicAllocator: { address: c.publicAllocator, runtimeKeccak256: c.publicAllocatorRuntimeHash, binding: 'EXACT_DEPLOYED_ARTIFACT_MATCH_RETAINED_MANIFEST_BOUND', independentCurrentDeploymentVerificationPerformed: false },
    factory: { address: c.factory, runtimeKeccak256: c.factoryRuntimeHash, observationKind: 'RETAINED_HASH_ONLY', binding: 'UNBOUND_NOT_MISMATCH', blockers: [...FACTORY_BLOCKERS] },
  }));
  const vaults = VAULTS.map((v) => ({
    ...v,
    observationKind: 'RETAINED_HASH_ONLY',
    runtimeBinding: 'UNBOUND_NOT_MISMATCH',
    blockers: [...VAULT_BLOCKERS],
    historicalAuthorizationObservation: { value: false, scope: 'STEP2_PIN_ONLY', currentOrGlobal: false },
  }));
  const runtimeBinding = {
    rule: 'Exact binding requires an existing deterministic compiled runtime, complete compiler/settings/libraries/immutable-reference and value closure, and byte/hash comparison to retained deployed bytes. Retained hash-only observations and source shape are insufficient.',
    runtimeMismatchClaimed: false,
    publicAllocator: { exactRetainedChains: 7, status: 'EXACT_RETAINED_CLAIM_ONLY', claimBasis: 'STEP2_MANIFEST_BOUND_DEPLOYED_ARTIFACT_BYTE_MATCH', currentNetworkVerificationPerformed: false, independentlyPromotedByStep4: false },
    factory: { exactBoundChains: 0, status: 'UNBOUND_NOT_MISMATCH', compiledRuntimeTemplateObserved: true, deterministicCompiledRuntimeAvailable: false, settingsClosureAvailable: false, librariesResolved: false, immutableReferencesAvailable: false, immutableValuesResolved: false, retainedDeployedBytesAvailable: false, byteComparisonPerformed: false, blockers: [...FACTORY_BLOCKERS] },
    vault: { exactBoundRows: 0, status: 'UNBOUND_NOT_MISMATCH', compiledRuntimeTemplateObserved: true, deterministicCompiledRuntimeAvailable: false, settingsClosureAvailable: true, libraryReferencesAvailable: true, librariesResolved: false, immutableReferencesAvailable: true, immutableValuesResolved: false, retainedDeployedBytesAvailable: false, byteComparisonPerformed: false, blockers: [...VAULT_BLOCKERS] },
  };
  const status = deriveStatus(runtimeBinding);
  invariant(status === STATUS, 'status derivation unexpectedly admitted runtime binding');
  return {
    schema: ID,
    schemaVersion: 1,
    version: '1.0.0',
    generatedAt: GENERATED_AT,
    mode: MODE,
    findingId: ID,
    authorityHashes: {
      algorithm: 'sha256',
      retained: retainedHashes,
      retainedAggregateSha256: aggregate(retainedHashes),
      sourceConfigBuild: sourceConfigBuildHashes,
      sourceConfigBuildAggregateSha256: aggregate(sourceConfigBuildHashes),
    },
    target: { path: 'targets/silo-contracts-v2', retainedCommit: TARGET_COMMIT, dirtyTargetObserved: true, sanitizedExactGitStatusPathCategories: dirty },
    dirtyTargetObserved: true,
    networkAttempted: false,
    forgeInvoked: false,
    packageManagerInvoked: false,
    chains,
    vaults,
    aggregate: { retainedChains: chains.length, retainedVaultRows: vaults.length, bnbVaultRows: 2, arbitrumVaultRows: 4, publicAllocatorExactRetainedChains: 7, factoryExactBoundChains: 0, vaultExactBoundRows: 0 },
    artifactInventory,
    compilerSettingsClosure: {
      compiler: { required: '0.8.28+commit.7893614a', publicAllocatorObserved: true, factoryObservedInDeploymentArtifacts: true, vaultObserved: true },
      foundrySettings: { evmVersion: 'cancun', optimizer: true, optimizerRuns: 200, viaIR: false },
      publicAllocator: { settings: true, libraries: true, immutableReferences: 'NOT_APPLICABLE', exactDeployedArtifactClaimRetained: true },
      factory: { settings: false, libraries: false, immutableReferences: false, immutableValues: false, deterministicRuntime: false, exactComparison: false },
      vault: { settings: true, libraryReferences: true, libraryAddresses: false, immutableReferences: true, immutableValues: false, deterministicRuntime: false, exactComparison: false },
      exactFactoryVaultClosureComplete: false,
    },
    runtimeBinding,
    historicalAuthorization: { source: 'Step2 retained observations', knownRows: 6, knownNegativeAtPins: 6, preservation: 'HISTORICAL_ONLY_NOT_CURRENT_OR_GLOBAL', usedForCurrentClassification: false },
    authorizationSemanticsBoundary: 'Code-hash and ABI getter reads cannot support negative or positive authorization classification without exact source/runtime semantics.',
    status,
    admission: { authorizationDeltaNetworkRunnerAdmitted: false, admitted: false, reason: STATUS },
    gates: { routePositive: 'unknown', executableNow: 'unknown', signedActionJustified: false, fork: false, economics: 'UNASSESSED' },
    nextAction: 'CLOSE_ROTATE',
  };
}

function renderReport(core) {
  const lines = [
    '# Silo V3 PublicAllocator Step 4 — Runtime-Binding Gate 0',
    '',
    `Mode: \`${MODE}\`  `,
    `Status: **${STATUS}**  `,
    'Admission: authorization-delta network runner `false`.',
    '',
    '## Decision',
    '',
    'Gate 0 is blocked. The retained Step 2 PublicAllocator exact-deployed-artifact claim remains manifest-bound on seven chains, but Step 4 does not independently promote it. Existing local factory and vault material does not provide the exact deterministic compiled-runtime closure required for byte/hash comparison. No runtime mismatch is claimed.',
    '',
    'Code-hash and ABI getter reads cannot support negative or positive authorization classification without exact source/runtime semantics. The six Step 2 authorization-negative observations are historical at their retained pins only; they are not current or global classifications.',
    '',
    '## Retained chains',
    '',
    '| chain | pin | PublicAllocator / runtime hash | factory / runtime hash | factory binding |',
    '|---|---|---|---|---|',
    ...core.chains.map((c) => `| ${c.chain} (${c.chainId}) | ${c.pin.number}<br>${c.pin.hash} | ${c.publicAllocator.address}<br>${c.publicAllocator.runtimeKeccak256} | ${c.factory.address}<br>${c.factory.runtimeKeccak256} | UNBOUND_NOT_MISMATCH |`),
    '',
    '## Six retained vault observations',
    '',
    '| chain | vault | creation block | retained runtime hash | binding |',
    '|---|---|---:|---|---|',
    ...core.vaults.map((v) => `| ${v.chain} (${v.chainId}) | ${v.vault} | ${v.creationBlock} | ${v.runtimeHash} | UNBOUND_NOT_MISMATCH |`),
    '',
    '## Exact blockers',
    '',
    'Factory (all seven chains):',
    ...FACTORY_BLOCKERS.map((x) => `- \`${x}\``),
    '',
    'Vault (all six retained rows):',
    ...VAULT_BLOCKERS.map((x) => `- \`${x}\``),
    '',
    'The factory deployment JSONs expose compiler identity and unresolved runtime templates, but not complete settings, link-reference/address, immutable-reference/value, or deterministic runtime closure. No focused factory compiled artifact exists. The focused vault artifact preserves compiler/settings, link references, and immutable references, but its library address and immutable values are unresolved; only retained deployed hashes, not deployed byte preimages, are available.',
    '',
    '## Gates and safety',
    '',
    '- `routePositive="unknown"`',
    '- `executableNow="unknown"`',
    '- `signedActionJustified=false`',
    '- `fork=false`',
    '- `economics="UNASSESSED"`',
    '- `networkAttempted=false`',
    '- `forgeInvoked=false`',
    '- `packageManagerInvoked=false`',
    '- `dirtyTargetObserved=true`',
    '- next action: `CLOSE_ROTATE`',
    '',
    'The dirty target was observed but not modified. Its exact sanitized path categories are bound in the raw artifact. No network, RPC, Forge, package manager, compile, fork, signing, or transaction action was performed.',
    '',
  ];
  return Buffer.from(lines.join('\n'), 'utf8');
}

function roleFor(p) {
  if (p.startsWith('tools/')) return 'tool';
  if (p === OUTPUT_PATHS.artifact) return 'artifact';
  if (p === OUTPUT_PATHS.report) return 'report';
  if (Object.hasOwn(RETAINED_AUTHORITY, p)) return 'retained-authority';
  if (SOURCE_CONFIG_PATHS.includes(p)) return 'source-config';
  return 'build-artifact';
}

function validateArtifactData(artifact) {
  invariant(artifact.schema === ID && artifact.schemaVersion === 1 && artifact.version === '1.0.0', 'artifact schema/version invalid');
  invariant(artifact.mode === MODE, 'artifact mode invalid');
  invariant(artifact.dirtyTargetObserved === true && same(artifact.target.sanitizedExactGitStatusPathCategories, EXPECTED_DIRTY), 'dirty-state truth invalid');
  invariant(artifact.networkAttempted === false && artifact.forgeInvoked === false && artifact.packageManagerInvoked === false, 'offline invocation truth invalid');
  const retainedEntries = Object.entries(RETAINED_AUTHORITY);
  invariant(same(artifact.authorityHashes.retained.map((x) => x.path), retainedEntries.map(([p]) => p)), 'retained authority path/order invalid');
  for (let i = 0; i < retainedEntries.length; i += 1) {
    invariant(artifact.authorityHashes.retained[i].sha256 === retainedEntries[i][1], `retained authority hash invalid: ${retainedEntries[i][0]}`);
  }
  invariant(artifact.authorityHashes.retainedAggregateSha256 === aggregate(artifact.authorityHashes.retained), 'retained authority aggregate invalid');
  const sourceBuildPaths = [...SOURCE_CONFIG_PATHS, ...BUILD_INPUT_PATHS, ...DEPLOYMENT_PATHS];
  invariant(same(artifact.authorityHashes.sourceConfigBuild.map((x) => x.path), sourceBuildPaths), 'source/config/build authority path/order invalid');
  invariant(new Set(sourceBuildPaths).size === sourceBuildPaths.length, 'source/config/build authority duplicate');
  invariant(artifact.authorityHashes.sourceConfigBuildAggregateSha256 === aggregate(artifact.authorityHashes.sourceConfigBuild), 'source/config/build authority aggregate invalid');
  invariant(artifact.chains.length === 7 && same(artifact.chains.map((x) => x.chainId), CHAINS.map((x) => x.chainId)), 'artifact chain rows invalid');
  invariant(artifact.vaults.length === 6, 'artifact vault rows invalid');
  for (let i = 0; i < CHAINS.length; i += 1) {
    const a = artifact.chains[i]; const e = CHAINS[i];
    invariant(a.pin.number === e.pinNumber && a.pin.hash === e.pinHash, `artifact pin drift: ${e.chainId}`);
    invariant(a.publicAllocator.address === e.publicAllocator && a.publicAllocator.runtimeKeccak256 === e.publicAllocatorRuntimeHash, `artifact PublicAllocator drift: ${e.chainId}`);
    invariant(a.factory.address === e.factory && a.factory.runtimeKeccak256 === e.factoryRuntimeHash, `artifact factory drift: ${e.chainId}`);
    invariant(a.factory.binding === 'UNBOUND_NOT_MISMATCH' && same(a.factory.blockers, FACTORY_BLOCKERS), `artifact factory false promotion: ${e.chainId}`);
  }
  for (let i = 0; i < VAULTS.length; i += 1) {
    const a = artifact.vaults[i]; const e = VAULTS[i];
    invariant(a.chainId === e.chainId && a.vault === e.vault && a.runtimeHash === e.runtimeHash, `artifact vault drift: ${i}`);
    invariant(a.runtimeBinding === 'UNBOUND_NOT_MISMATCH' && same(a.blockers, VAULT_BLOCKERS), `artifact vault false promotion: ${i}`);
    invariant(a.historicalAuthorizationObservation.currentOrGlobal === false, `historical authorization scope promoted: ${i}`);
  }
  invariant(artifact.runtimeBinding.runtimeMismatchClaimed === false, 'runtime mismatch must not be claimed');
  invariant(artifact.runtimeBinding.publicAllocator.independentlyPromotedByStep4 === false, 'PublicAllocator claim independently promoted');
  invariant(artifact.runtimeBinding.factory.exactBoundChains === 0 && artifact.runtimeBinding.vault.exactBoundRows === 0, 'factory/vault exact binding false promotion');
  invariant(deriveStatus(artifact.runtimeBinding) === STATUS && artifact.status === STATUS, 'status derivation invalid');
  invariant(artifact.admission.admitted === false && artifact.admission.authorizationDeltaNetworkRunnerAdmitted === false, 'authorization runner admitted while blocked');
  invariant(same(artifact.gates, { routePositive: 'unknown', executableNow: 'unknown', signedActionJustified: false, fork: false, economics: 'UNASSESSED' }), 'gates invalid');
  invariant(artifact.nextAction === 'CLOSE_ROTATE', 'nextAction invalid');
  invariant(artifact.authorizationSemanticsBoundary.includes('cannot support negative or positive authorization classification'), 'authorization semantics boundary missing');
  return true;
}

function buildBundle(root = ROOT) {
  const core = makeCore(root);
  const reportBytes = renderReport(core);
  const artifact = { ...core, reportBinding: { path: OUTPUT_PATHS.report, bytes: reportBytes.length, sha256: sha256(reportBytes) } };
  validateArtifactData(artifact);
  const artifactBytes = jsonBytes(artifact);
  const inMemory = new Map([[OUTPUT_PATHS.report, reportBytes], [OUTPUT_PATHS.artifact, artifactBytes]]);
  const files = MANIFEST_PATHS.map((p) => {
    const bytes = inMemory.get(p) || readBytes(root, p);
    return { path: p, role: roleFor(p), bytes: bytes.length, sha256: sha256(bytes) };
  });
  invariant(new Set(files.map((x) => x.path)).size === files.length, 'manifest path duplicate');
  const manifest = {
    schema: `${ID}-manifest`,
    schemaVersion: 1,
    version: '1.0.0',
    generatedAt: GENERATED_AT,
    mode: MODE,
    findingId: ID,
    algorithm: 'sha256',
    manifestSelfHashExcluded: true,
    immutableNoReplaceGeneration: true,
    metadata: {
      targetCommit: TARGET_COMMIT,
      status: STATUS,
      retainedChainIds: CHAINS.map((x) => x.chainId),
      retainedVaultRows: 6,
      chainPinsSha256: sha256(Buffer.from(JSON.stringify(artifact.chains.map((x) => ({ chainId: x.chainId, pin: x.pin }))), 'utf8')),
      retainedAuthorityAggregateSha256: artifact.authorityHashes.retainedAggregateSha256,
      sourceConfigBuildAggregateSha256: artifact.authorityHashes.sourceConfigBuildAggregateSha256,
    },
    fileCount: files.length,
    exactPathOrder: [...MANIFEST_PATHS],
    files,
    aggregateSha256: aggregate(files),
  };
  return { reportBytes, artifact, artifactBytes, manifest, manifestBytes: jsonBytes(manifest) };
}

function validateManifestData(manifest, expected) {
  invariant(manifest.schema === `${ID}-manifest` && manifest.schemaVersion === 1 && manifest.version === '1.0.0', 'manifest schema/version invalid');
  invariant(manifest.mode === MODE && manifest.manifestSelfHashExcluded === true && manifest.immutableNoReplaceGeneration === true, 'manifest metadata invalid');
  invariant(manifest.metadata.targetCommit === TARGET_COMMIT && manifest.metadata.status === STATUS, 'manifest target/status metadata invalid');
  invariant(same(manifest.metadata.retainedChainIds, CHAINS.map((x) => x.chainId)) && manifest.metadata.retainedVaultRows === 6, 'manifest retained row metadata invalid');
  const expectedPinsHash = sha256(Buffer.from(JSON.stringify(CHAINS.map((x) => ({ chainId: x.chainId, pin: { number: x.pinNumber, hash: x.pinHash } }))), 'utf8'));
  invariant(manifest.metadata.chainPinsSha256 === expectedPinsHash, 'manifest chain pin metadata invalid');
  invariant(manifest.fileCount === MANIFEST_PATHS.length, 'manifest file count invalid');
  invariant(same(manifest.exactPathOrder, MANIFEST_PATHS), 'manifest exact path order invalid');
  invariant(same(manifest.files.map((x) => x.path), MANIFEST_PATHS), 'manifest file order invalid');
  invariant(new Set(manifest.files.map((x) => x.path)).size === manifest.files.length, 'manifest duplicate path');
  invariant(manifest.aggregateSha256 === aggregate(manifest.files), 'manifest aggregate invalid');
  if (expected) invariant(same(manifest, expected), 'manifest bytes/metadata differ from deterministic expectation');
  return true;
}

function validateBundle(root = ROOT) {
  const expected = buildBundle(root);
  const reportBytes = readBytes(root, OUTPUT_PATHS.report);
  const artifactBytes = readBytes(root, OUTPUT_PATHS.artifact);
  const manifestBytes = readBytes(root, OUTPUT_PATHS.manifest);
  invariant(reportBytes.equals(expected.reportBytes), 'report byte binding drift');
  invariant(artifactBytes.equals(expected.artifactBytes), 'artifact byte binding drift');
  invariant(manifestBytes.equals(expected.manifestBytes), 'manifest byte binding drift');
  const artifact = JSON.parse(artifactBytes);
  const manifest = JSON.parse(manifestBytes);
  validateArtifactData(artifact);
  invariant(artifact.reportBinding.bytes === reportBytes.length && artifact.reportBinding.sha256 === sha256(reportBytes), 'artifact report byte binding invalid');
  validateManifestData(manifest, expected.manifest);
  for (const record of manifest.files) {
    const bytes = readBytes(root, record.path);
    invariant(bytes.length === record.bytes && sha256(bytes) === record.sha256, `manifest file hash drift: ${record.path}`);
  }
  return { artifact, manifest };
}

function writeNoReplace(root, entries) {
  for (const [p] of entries) invariant(!fs.existsSync(rel(root, p)), `immutable generation refuses existing output: ${p}`);
  for (const [p, bytes] of entries) fs.writeFileSync(rel(root, p), bytes, { flag: 'wx' });
}

function generate(root = ROOT) {
  const bundle = buildBundle(root);
  writeNoReplace(root, [
    [OUTPUT_PATHS.report, bundle.reportBytes],
    [OUTPUT_PATHS.artifact, bundle.artifactBytes],
    [OUTPUT_PATHS.manifest, bundle.manifestBytes],
  ]);
  return bundle;
}

function main() {
  const args = process.argv.slice(2);
  invariant(args.length <= 1 && (args.length === 0 || args[0] === '--check-only'), 'usage: node analyzer.js [--check-only]');
  if (args[0] === '--check-only') {
    const result = validateBundle(ROOT);
    process.stdout.write(`PASS ${ID} check-only files=${result.manifest.fileCount} aggregate=${result.manifest.aggregateSha256}\n`);
  } else {
    const result = generate(ROOT);
    process.stdout.write(`WROTE ${ID} files=3 aggregate=${result.manifest.aggregateSha256}\n`);
  }
}

if (require.main === module) {
  try { main(); } catch (error) { process.stderr.write(`FAIL ${error.message}\n`); process.exitCode = 1; }
}

module.exports = {
  BUILD_INPUT_PATHS,
  CHAINS,
  EXPECTED_DIRTY,
  FACTORY_BLOCKERS,
  ID,
  MANIFEST_PATHS,
  MODE,
  OUTPUT_PATHS,
  RETAINED_AUTHORITY,
  SOURCE_CONFIG_PATHS,
  STATUS,
  VAULTS,
  VAULT_BLOCKERS,
  aggregate,
  buildBundle,
  deriveStatus,
  generate,
  jsonBytes,
  sha256,
  validateArtifactData,
  validateBundle,
  validateManifestData,
  verifyStep2Rows,
  writeNoReplace,
};
