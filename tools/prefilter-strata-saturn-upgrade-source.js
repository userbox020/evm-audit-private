#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TARGET = path.join(ROOT, 'targets', 'strata-contracts-2be97f9b');

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function git(args) {
  return cp.execFileSync('git', args, { cwd: TARGET, encoding: 'utf8' }).trim();
}

function metadataStripped(hex) {
  const bytes = Buffer.from(hex.replace(/^0x/, ''), 'hex');
  if (bytes.length < 2) return bytes;
  const metadataLength = bytes.readUInt16BE(bytes.length - 2);
  if (metadataLength + 2 > bytes.length) return bytes;
  return bytes.subarray(0, bytes.length - metadataLength - 2);
}

function listBuildInfo() {
  const dir = path.join(TARGET, 'artifacts', 'build-info');
  return fs.readdirSync(dir).filter(x => x.endsWith('.json')).sort();
}

function generateStorageLayout(compilerInput) {
  const solcName = 'solc-windows-amd64-v0.8.28+commit.7893614a.exe';
  const solcPath = path.join(process.env.LOCALAPPDATA || '', 'hardhat-nodejs', 'Cache', 'compilers-v2', 'windows-amd64', solcName);
  if (!fs.existsSync(solcPath)) throw new Error(`fail closed: pinned compiler unavailable: ${solcName}`);
  const input = JSON.parse(JSON.stringify(compilerInput));
  input.settings.outputSelection = { '*': { '*': ['storageLayout'] } };
  const inputBytes = Buffer.from(JSON.stringify(input));
  const stdout = cp.execFileSync(solcPath, ['--standard-json'], {
    cwd: TARGET,
    input: inputBytes,
    maxBuffer: 256 * 1024 * 1024
  });
  const output = JSON.parse(stdout.toString('utf8'));
  const fatal = (output.errors || []).filter(x => x.severity === 'error');
  if (fatal.length) throw new Error(`fail closed: storage-layout compile errors: ${fatal.map(x => x.formattedMessage).join('\n')}`);
  return {
    compiler: solcName,
    inputSha256: sha256(inputBytes),
    outputSha256: sha256(stdout),
    warningCount: (output.errors || []).filter(x => x.severity === 'warning').length,
    layout: output.contracts['contracts/tranches/strategies/saturn/SaturnStrategy.sol'].SaturnStrategy.storageLayout
  };
}

function capture(label, outputRelative) {
  const buildFiles = listBuildInfo();
  if (buildFiles.length !== 1) {
    throw new Error(`fail closed: expected exactly one build-info file, got ${buildFiles.length}`);
  }
  const buildPath = path.join(TARGET, 'artifacts', 'build-info', buildFiles[0]);
  const buildBytes = fs.readFileSync(buildPath);
  const build = JSON.parse(buildBytes);
  const generatedStorage = generateStorageLayout(build.input);
  const sourceName = 'contracts/tranches/strategies/saturn/SaturnStrategy.sol';
  const contractName = 'SaturnStrategy';
  const contractOutput = build.output.contracts[sourceName][contractName];
  const artifactPath = path.join(TARGET, 'artifacts', sourceName, `${contractName}.json`);
  const artifactBytes = fs.readFileSync(artifactPath);
  const artifact = JSON.parse(artifactBytes);
  const manifestPath = path.join(TARGET, 'deployments', 'saturn', 'deployments-eth.json');
  const layoutPath = path.join(TARGET, 'deployments', 'saturn', 'deployments-eth.layout.json');
  const manifest = readJson(manifestPath);
  const officialLayouts = readJson(layoutPath);
  const deployment = manifest.find(x => x.id === 'SaturnSaturnStrategy');
  const proxyDeployment = manifest.find(x => x.id === 'SaturnSaturnStrategyProxy');
  const officialLayout = officialLayouts.find(x => x.id === 'SaturnSaturnStrategyProxy');
  const packageLock = readJson(path.join(TARGET, 'package-lock.json'));
  const directPackages = {};
  for (const name of [
    'hardhat', '@0xweb/hardhat', '@openzeppelin/contracts',
    '@openzeppelin/contracts-upgradeable', '@prb/math', 'dequanto', '0xweb'
  ]) {
    const entry = packageLock.packages[`node_modules/${name}`];
    directPackages[name] = entry ? { version: entry.version, integrity: entry.integrity || null } : null;
  }
  const bytecode = Buffer.from(artifact.bytecode.slice(2), 'hex');
  const runtime = Buffer.from(artifact.deployedBytecode.slice(2), 'hex');
  const status = git(['status', '--porcelain', '--untracked-files=no']);
  const result = {
    schema: 'strata-saturn-source-build-capture/v1',
    label,
    repository: git(['remote', 'get-url', 'origin']),
    commit: git(['rev-parse', 'HEAD']),
    parent: git(['rev-parse', 'HEAD^']),
    tree: git(['rev-parse', 'HEAD^{tree}']),
    committedAt: git(['show', '-s', '--format=%cI', 'HEAD']),
    subject: git(['show', '-s', '--format=%s', 'HEAD']),
    trackedWorktreeClean: status === '',
    trackedStatus: status ? status.split(/\r?\n/) : [],
    submodules: git(['submodule', 'status', '--recursive']).split(/\r?\n/).filter(Boolean),
    packageLock: {
      lockfileVersion: packageLock.lockfileVersion,
      sha256: sha256(fs.readFileSync(path.join(TARGET, 'package-lock.json'))),
      directPackages
    },
    build: {
      buildInfoFile: buildFiles[0],
      buildInfoSha256: sha256(buildBytes),
      compilerInputSha256: sha256(Buffer.from(JSON.stringify(build.input))),
      compilerOutputSha256: sha256(Buffer.from(JSON.stringify(build.output))),
      solcVersion: build.solcVersion,
      solcLongVersion: build.solcLongVersion,
      sourceCount: Object.keys(build.input.sources).length,
      settings: build.input.settings,
      artifactPath: path.relative(TARGET, artifactPath).replace(/\\/g, '/'),
      artifactSha256: sha256(artifactBytes),
      creationBytecodeBytes: bytecode.length,
      creationBytecodeSha256: sha256(bytecode),
      runtimeBytecodeBytes: runtime.length,
      runtimeBytecodeSha256: sha256(runtime),
      metadataStrippedRuntimeBytes: metadataStripped(artifact.deployedBytecode).length,
      metadataStrippedRuntimeSha256: sha256(metadataStripped(artifact.deployedBytecode)),
      immutableReferences: contractOutput.evm.deployedBytecode.immutableReferences || {},
      storageLayout: generatedStorage.layout,
      storageLayoutCompiler: generatedStorage.compiler,
      storageLayoutInputSha256: generatedStorage.inputSha256,
      storageLayoutOutputSha256: generatedStorage.outputSha256,
      storageLayoutWarningCount: generatedStorage.warningCount
    },
    officialDeployment: deployment,
    officialProxyDeployment: proxyDeployment,
    officialLayout,
    authorityHashes: {
      manifestSha256: sha256(fs.readFileSync(manifestPath)),
      layoutManifestSha256: sha256(fs.readFileSync(layoutPath)),
      sourceSha256: sha256(fs.readFileSync(path.join(TARGET, sourceName))),
      hardhatConfigSha256: sha256(fs.readFileSync(path.join(TARGET, 'hardhat.config.js'))),
      foundryConfigSha256: sha256(fs.readFileSync(path.join(TARGET, 'foundry.toml')))
    }
  };
  const output = path.join(ROOT, outputRelative);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const compilerInputOutput = output.replace(/-build\.json$/, '-compiler-input.json');
  if (compilerInputOutput === output) throw new Error('fail closed: capture output must end in -build.json');
  fs.writeFileSync(compilerInputOutput, JSON.stringify(build.input, null, 2) + '\n');
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ output: outputRelative, compilerInput: path.relative(ROOT, compilerInputOutput).replace(/\\/g, '/'), commit: result.commit, solc: result.build.solcLongVersion, sources: result.build.sourceCount }));
}

function bindRuntime(captureRelative, compilerInputRelative) {
  const capturePath = path.join(ROOT, captureRelative);
  const compilerInputPath = path.join(ROOT, compilerInputRelative);
  const capture = readJson(capturePath);
  const compilerInput = readJson(compilerInputPath);
  const solcName = 'solc-windows-amd64-v0.8.28+commit.7893614a.exe';
  const solcPath = path.join(process.env.LOCALAPPDATA || '', 'hardhat-nodejs', 'Cache', 'compilers-v2', 'windows-amd64', solcName);
  const inputBytes = Buffer.from(JSON.stringify(compilerInput));
  const stdout = cp.execFileSync(solcPath, ['--standard-json'], { cwd: TARGET, input: inputBytes, maxBuffer: 256 * 1024 * 1024 });
  const output = JSON.parse(stdout.toString('utf8'));
  const fatal = (output.errors || []).filter(x => x.severity === 'error');
  if (fatal.length) throw new Error(`fail closed: runtime rebuild errors: ${fatal.map(x => x.formattedMessage).join('\n')}`);
  const sourceName = 'contracts/tranches/strategies/saturn/SaturnStrategy.sol';
  const contractOutput = output.contracts[sourceName].SaturnStrategy;
  const refs = contractOutput.evm.deployedBytecode.immutableReferences || {};
  const wanted = new Set(Object.keys(refs).map(Number));
  const immutableNames = {};
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (wanted.has(node.id) && node.nodeType === 'VariableDeclaration') immutableNames[node.id] = node.name;
    for (const value of Object.values(node)) walk(value);
  })(output.sources[sourceName].ast);
  const values = {
    sUSDat: '0xD166337499E176bbC38a1FBd113Ab144e5bd2Df7',
    USDat: '0x23238f20b894f29041f48D88eE91131C395AAa71'
  };
  const runtime = Buffer.from(contractOutput.evm.deployedBytecode.object, 'hex');
  const templateStripped = metadataStripped(`0x${runtime.toString('hex')}`);
  const ethers = require(path.join(TARGET, 'node_modules', 'ethers'));
  const templateHash = ethers.keccak256(`0x${templateStripped.toString('hex')}`);
  const patched = [];
  for (const [id, locations] of Object.entries(refs)) {
    const name = immutableNames[id];
    const address = values[name];
    if (!address) throw new Error(`fail closed: no authoritative immutable value for ${id}/${name}`);
    const word = Buffer.alloc(32);
    Buffer.from(address.slice(2), 'hex').copy(word, 12);
    for (const location of locations) {
      if (location.length !== 32) throw new Error(`fail closed: unexpected immutable width ${location.length}`);
      word.copy(runtime, location.start);
    }
    patched.push({ id, name, value: address, references: locations.length });
  }
  const stripped = metadataStripped(`0x${runtime.toString('hex')}`);
  const patchedHash = ethers.keccak256(`0x${stripped.toString('hex')}`);
  capture.sourceRuntimeManifestBinding = {
    method: 'exact compiler input; solc 0.8.28; CBOR metadata stripped; keccak256 of compiler runtime template (immutable placeholders remain zero, matching deployment tooling)',
    compiler: solcName,
    compilerInputSha256: sha256(inputBytes),
    rebuiltCompilerOutputSha256: sha256(stdout),
    immutables: patched,
    metadataStrippedRuntimeBytes: templateStripped.length,
    computedTemplateBytecodeHash: templateHash,
    officialManifestBytecodeHash: capture.officialDeployment.bytecodeHash,
    matchesOfficialManifest: templateHash.toLowerCase() === capture.officialDeployment.bytecodeHash.toLowerCase(),
    constructorPatchedExpectedRuntimeHash: patchedHash,
    runtimeCaveat: 'The official manifest hashes the compiler template, not fetched deployed bytes; source-only work does not establish live runtime equality.'
  };
  if (!capture.sourceRuntimeManifestBinding.matchesOfficialManifest) {
    throw new Error(`fail closed: rebuilt source runtime template hash ${templateHash} does not match official manifest ${capture.officialDeployment.bytecodeHash}`);
  }
  fs.writeFileSync(capturePath, JSON.stringify(capture, null, 2) + '\n');
  console.log(JSON.stringify({ capture: captureRelative, computedTemplateBytecodeHash: templateHash, match: true }));
}

function packageManifest(outputRelative) {
  const files = [
    'reports/prefilter-strata-saturn-upgrade-source.md',
    'reports/raw/fast/prefilter-strata-saturn-upgrade-source/analysis.json',
    'reports/raw/fast/prefilter-strata-saturn-upgrade-source/commands.json',
    'reports/raw/fast/prefilter-strata-saturn-upgrade-source/new-build.json',
    'reports/raw/fast/prefilter-strata-saturn-upgrade-source/new-compiler-input.json',
    'reports/raw/fast/prefilter-strata-saturn-upgrade-source/predecessor-build.json',
    'reports/raw/fast/prefilter-strata-saturn-upgrade-source/predecessor-compiler-input.json',
    'tools/prefilter-strata-saturn-upgrade-source.js',
    'tools/tests/prefilter-strata-saturn-upgrade-source.test.js',
    'coordination/inbox/discovery/20260822-discovery-strata-saturn-upgrade-source-prefilter-terminal.json',
    'coordination/handoffs/20260822-discovery-strata-saturn-upgrade-source-prefilter-handoff.md'
  ].sort();
  const entries = files.map(file => {
    const bytes = fs.readFileSync(path.join(ROOT, file));
    return { path: file, bytes: bytes.length, sha256: sha256(bytes) };
  });
  const canonical = Buffer.from(JSON.stringify(entries));
  const manifest = {
    schema: 'strata-saturn-source-prefilter-package/v1',
    commitmentMethod: 'sha256(JSON.stringify(entries sorted by path)); package manifest excluded from its own commitment',
    fileCount: entries.length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    entries,
    packageCommitmentSha256: sha256(canonical)
  };
  const output = path.join(ROOT, outputRelative);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify({ output: outputRelative, files: manifest.fileCount, bytes: manifest.totalBytes, commitment: manifest.packageCommitmentSha256 }));
}

function usage() {
  console.error('usage: node tools/prefilter-strata-saturn-upgrade-source.js capture <label> <output-relative> | bind <capture-relative> <compiler-input-relative> | package <output-relative>');
  process.exit(2);
}

if (process.argv[2] === 'capture' && process.argv[3] && process.argv[4]) capture(process.argv[3], process.argv[4]);
else if (process.argv[2] === 'bind' && process.argv[3] && process.argv[4]) bindRuntime(process.argv[3], process.argv[4]);
else if (process.argv[2] === 'package' && process.argv[3]) packageManifest(process.argv[3]);
else usage();
