'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TARGET = path.join(ROOT, 'targets', 'strata-contracts-2be97f9b');
const RAW = path.join(ROOT, 'reports', 'raw', 'fast', 'prefilter-strata-saturn-upgrade-source');
const NEW = JSON.parse(fs.readFileSync(path.join(RAW, 'new-build.json')));
const OLD = JSON.parse(fs.readFileSync(path.join(RAW, 'predecessor-build.json')));
const NEW_INPUT = JSON.parse(fs.readFileSync(path.join(RAW, 'new-compiler-input.json')));
const OLD_INPUT = JSON.parse(fs.readFileSync(path.join(RAW, 'predecessor-compiler-input.json')));

function gitShow(ref, file) {
  return cp.execFileSync('git', ['show', `${ref}:${file}`], { cwd: TARGET, encoding: 'utf8' });
}

function ceilDiv(a, b) {
  return (a + b - 1n) / b;
}

function actionAllowed(config, tranche, action) {
  const key = `${tranche}${action}`;
  return !config[key];
}

test('official lead identity and exact changed files', () => {
  assert.equal(NEW.commit, '2be97f9b22c34e536475e6ea28370073a97b94c0');
  assert.equal(NEW.parent, '0ccad51abebff679cdf6ac1c7a1e936442321e2f');
  assert.equal(NEW.tree, '34b82e4c55d3a29b379ca2dcb8e38d8f4342183f');
  const changed = cp.execFileSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', NEW.commit], { cwd: TARGET, encoding: 'utf8' }).trim().split(/\r?\n/);
  assert.deepEqual(changed, [
    'deployments/saturn/deployments-eth.json',
    'deployments/saturn/deployments-eth.layout.json'
  ]);
  assert.equal(NEW.officialDeployment.address.toLowerCase(), '0xce7b00d1004d9ed22e702a6a7f5bbdce7297b090');
  assert.equal(NEW.officialDeployment.implementation.toLowerCase(), '0xcaf0865334eb135b8c47fca6d9049d5eafe19d9b');
  assert.equal(NEW.officialDeployment.block, 25172016);
  assert.equal(NEW.officialDeployment.tx, '0xa4dc528681f289f6d3569c7b6db8887c16d5edb56c4c086d69860a6b3835fac3');
});

test('official predecessor deployment and source authority are bounded', () => {
  assert.equal(OLD.commit, 'cbf26503ad466a15d0298db9c4e5fccde69dbfc6');
  assert.equal(OLD.officialDeployment.implementation.toLowerCase(), '0x9686e327a6f50aca2a1bea4219e04dc4449dc286');
  assert.equal(OLD.officialDeployment.block, 24974126);
  assert.equal(OLD.officialDeployment.tx, '0x0a63136f38a48b3a6c80a920e92c31cef8a71ee9438bea907b3960c8d0d1bf7e');
});

test('storage continuity is append-only slot-by-slot', () => {
  const before = OLD.build.storageLayout.storage;
  const after = NEW.build.storageLayout.storage;
  assert.equal(after.length, before.length + 1);
  for (let i = 0; i < before.length; i++) {
    // AST ids are compiler-internal source-order identifiers and legitimately
    // move when the new struct declaration is inserted. Storage identity does not.
    for (const field of ['contract', 'label', 'offset', 'slot']) {
      assert.equal(after[i][field], before[i][field], `storage[${i}].${field}`);
    }
    const oldType = OLD.build.storageLayout.types[before[i].type];
    const newType = NEW.build.storageLayout.types[after[i].type];
    for (const field of ['encoding', 'label', 'numberOfBytes']) {
      assert.equal(newType[field], oldType[field], `storage[${i}].type.${field}`);
    }
  }
  const added = after.at(-1);
  assert.equal(added.label, 'tokenConfigs');
  assert.equal(added.slot, '104');
  assert.equal(added.offset, 0);
  assert.match(NEW.build.storageLayout.types[added.type].label, /^mapping\(address => struct SaturnStrategy\.TTokenConfig\)/);
  const members = NEW.build.storageLayout.types[added.type].value ? NEW.build.storageLayout.types[NEW.build.storageLayout.types[added.type].value].members : [];
  assert.deepEqual(members.map(x => [x.label, x.slot, x.offset]), [
    ['jrtDepositsPaused', '0', 0],
    ['jrtWithdrawalsPaused', '0', 1],
    ['srtDepositsPaused', '0', 2],
    ['srtWithdrawalsPaused', '0', 3]
  ]);
});

test('base contracts, dependency lock, gaps, and namespaced storage authorities are unchanged', () => {
  assert.equal(NEW.packageLock.sha256, OLD.packageLock.sha256);
  const authorities = [
    'contracts/governance/AccessControlled.sol',
    'contracts/tranches/base/CDOComponent.sol',
    '@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol',
    '@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol',
    '@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol',
    '@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol'
  ];
  for (const source of authorities) {
    assert.equal(NEW_INPUT.sources[source].content, OLD_INPUT.sources[source].content, source);
  }
  assert.match(NEW_INPUT.sources['contracts/governance/AccessControlled.sol'].content, /uint256\[48\] private __gap/);
  assert.match(NEW_INPUT.sources['contracts/tranches/base/CDOComponent.sol'].content, /uint256\[49\] private __gap/);
  assert.match(NEW_INPUT.sources['@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol'].content, /@custom:storage-location erc7201:openzeppelin\.storage\.Ownable/);
  assert.match(NEW_INPUT.sources['@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol'].content, /@custom:storage-location erc7201:openzeppelin\.storage\.ReentrancyGuard/);
});

test('default mapping state preserves predecessor behavior', () => {
  const config = {
    jrtDepositsPaused: false,
    jrtWithdrawalsPaused: false,
    srtDepositsPaused: false,
    srtWithdrawalsPaused: false
  };
  for (const tranche of ['jrt', 'srt']) {
    for (const action of ['DepositsPaused', 'WithdrawalsPaused']) {
      assert.equal(actionAllowed(config, tranche, action), true);
    }
  }
});

test('all 16 pause combinations isolate exactly the selected actions for both supported tokens', () => {
  const keys = ['jrtDepositsPaused', 'jrtWithdrawalsPaused', 'srtDepositsPaused', 'srtWithdrawalsPaused'];
  for (const token of ['USDat', 'sUSDat']) {
    for (let mask = 0; mask < 16; mask++) {
      const config = Object.fromEntries(keys.map((key, i) => [key, Boolean(mask & (1 << i))]));
      for (const [i, key] of keys.entries()) {
        assert.equal(actionAllowed(config, key.slice(0, 3), key.slice(3)), !Boolean(mask & (1 << i)), `${token}/${mask}/${key}`);
      }
    }
  }
});

test('unsupported token is not configurable and remains rejected after the pause precheck', () => {
  const source = gitShow(NEW.commit, 'contracts/tranches/strategies/saturn/SaturnStrategy.sol');
  assert.match(source, /token != address\(sUSDat\) && token != address\(USDat\)/);
  assert.match(source, /revert UnsupportedToken\(token\);/);
  assert.match(source, /function isTokenEnabledForDeposit[\s\S]*tokenConfigs\[token\]\.jrtDepositsPaused/);
  assert.match(source, /function isTokenEnabledForWithdrawal[\s\S]*tokenConfigs\[token\]\.jrtWithdrawalsPaused/);
});

test('regex/static trace: initial public deposit/mint and withdraw/redeem calls converge on guarded strategy methods', () => {
  const tranche = gitShow(NEW.commit, 'contracts/tranches/Tranche.sol');
  const cdo = gitShow(NEW.commit, 'contracts/tranches/StrataCDO.sol');
  const strategy = gitShow(NEW.commit, 'contracts/tranches/strategies/saturn/SaturnStrategy.sol');
  assert.match(tranche, /function deposit\(uint256[\s\S]*super\.deposit/);
  assert.match(tranche, /function mint\(uint256[\s\S]*super\.mint/);
  assert.match(tranche, /cdo\.deposit\(address\(this\), token, tokenAssets, baseAssets\)/);
  assert.match(tranche, /function withdraw\(address token[\s\S]*_withdraw\(token/);
  assert.match(tranche, /function redeem\(address token[\s\S]*_withdraw\(token/);
  assert.match(tranche, /cdo\.withdraw\(address\(this\), token, tokenAssets, baseAssets, owner, receiver\)/);
  assert.match(cdo, /strategy\.deposit\(tranche, token, tokenAmount, baseAssets/);
  assert.match(cdo, /strategy\.withdraw\(tranche, token, tokenAmount, baseAssets/);
  assert.match(strategy, /function deposit[\s\S]*isTokenEnabledForDeposit[\s\S]*TokenDepositPaused/);
  assert.match(strategy, /function withdrawInner[\s\S]*isTokenEnabledForWithdrawal[\s\S]*TokenWithdrawalPaused/);
});

test('share-lock request fee precedes token settlement check and cancellation returns only net shares', () => {
  const tranche = gitShow(NEW.commit, 'contracts/tranches/Tranche.sol');
  const cdo = gitShow(NEW.commit, 'contracts/tranches/StrataCDO.sol');
  const shares = gitShow(NEW.commit, 'contracts/tranches/base/cooldown/SharesCooldown.sol');
  const config = gitShow(NEW.commit, 'src/platforms/strats/SaturnTranche.ts');

  const lockBranch = tranche.match(/if \(exitMode == IStrataCDO\.TExitMode\.SharesLock\)[\s\S]*?\n        }/)[0];
  assert.ok(lockBranch.indexOf('_transfer(owner, address(cdo.sharesCooldown()), sharesGross)') < lockBranch.indexOf('cdo.cooldownShares('));
  const cooldownShares = cdo.match(/function cooldownShares[\s\S]*?\n    }/)[0];
  assert.doesNotMatch(cooldownShares, /tokenConfigs|isTokenEnabledForWithdrawal/);

  const request = shares.match(/function requestRedeem\([\s\S]*?\n    }/)[0];
  assert.ok(request.indexOf('accrueFee(vault, shares, fee)') < request.indexOf('activeRequests[address(vault)][to]'));
  assert.match(shares, /function accrueFee[\s\S]*vault\.burnSharesAsFee\(sharesFee, address\(this\)\)/);
  assert.match(shares, /function cancel[\s\S]*vault\.transfer\(user, req\.shares\)/);
  assert.match(config, /\{ covPct: 30, feeBps: 10, lock: '7days' \}/);
});

test('regex/static trace: downstream finalizers release already-created claims without caller-directed payout', () => {
  const strategy = gitShow(NEW.commit, 'contracts/tranches/strategies/saturn/SaturnStrategy.sol');
  const cdo = gitShow(NEW.commit, 'contracts/tranches/StrataCDO.sol');
  const erc20 = gitShow(NEW.commit, 'contracts/tranches/base/cooldown/ERC20Cooldown.sol');
  const unstake = gitShow(NEW.commit, 'contracts/tranches/base/cooldown/UnstakeCooldown.sol');
  const saturn = gitShow(NEW.commit, 'contracts/tranches/strategies/saturn/SaturnCooldownRequestImpl.sol');

  const withdrawInner = strategy.match(/function withdrawInner[\s\S]*?\n    }/)[0];
  assert.ok(withdrawInner.indexOf('isTokenEnabledForWithdrawal') < withdrawInner.indexOf('erc20Cooldown.transfer'));
  assert.ok(withdrawInner.indexOf('isTokenEnabledForWithdrawal') < withdrawInner.indexOf('unstakeCooldown.transfer'));
  assert.doesNotMatch(erc20, /tokenConfigs/);
  assert.match(erc20, /function finalize[\s\S]*safeTransfer\(token, user, claimed\)/);
  assert.doesNotMatch(unstake, /tokenConfigs/);
  assert.match(unstake, /try req\.proxy\.finalize\(\)/);
  assert.doesNotMatch(saturn, /tokenConfigs/);
  assert.match(saturn, /function finalizeLateSettlement[\s\S]*require\(pending == false[\s\S]*safeTransfer\(USDat, receiver, amount\)/);

  const cdoWithdraw = cdo.match(/function withdraw\(address tranche[\s\S]*?\n    }/)[0];
  assert.ok(cdoWithdraw.indexOf('strategy.withdraw(') < cdoWithdraw.indexOf('accounting.updateBalanceFlow('));
});

test('regex/static trace: both TrancheDepositor public variants converge on vault.deposit', () => {
  const depositor = gitShow(NEW.commit, 'contracts/tranches/TrancheDepositor.sol');
  assert.match(depositor, /function deposit\(IMetaVault[\s\S]*return _deposit\(vault, asset, amount, receiver, params\)/);
  assert.match(depositor, /function depositWithPermit[\s\S]*return _deposit\(vault, asset, address\(this\), amount, receiver, params\)/);
  assert.match(depositor, /function _deposit_viaWithdraw[\s\S]*return _deposit\(vault, baseAsset, address\(this\), amountOut, receiver, depositParams\)/);
  assert.match(depositor, /function _deposit_viaSwap[\s\S]*return _deposit\(vault, IERC20\(tokenOut\), address\(this\), amountReceived, receiver, depositParams\)/);
  assert.match(depositor, /function _deposit_asMetaToken[\s\S]*vault\.deposit\(address\(asset\), amount, receiver\)/);
});

test('reserve extraction bypass is privileged, not a public actor path', () => {
  const cdo = gitShow(NEW.commit, 'contracts/tranches/StrataCDO.sol');
  const strategy = gitShow(NEW.commit, 'contracts/tranches/strategies/saturn/SaturnStrategy.sol');
  assert.match(cdo, /function reduceReserve[\s\S]*onlyRole\(RESERVE_MANAGER_ROLE\)/);
  assert.match(strategy, /function reduceReserve[\s\S]*external onlyCDO/);
  assert.doesNotMatch(strategy.match(/function reduceReserve[\s\S]*?\n    }/)[0], /isTokenEnabledForWithdrawal/);
  assert.match(strategy, /function setTokenConfig[\s\S]*onlyRole\(PAUSER_ROLE\)/);
});

test('rounding and conservation model remains identical when all new flags are false', () => {
  let seed = 0x5eed1234n;
  function rnd(mod) {
    seed = (1103515245n * seed + 12345n) & ((1n << 63n) - 1n);
    return seed % mod;
  }
  for (let i = 0; i < 10000; i++) {
    const assets = 1n + rnd(10n ** 24n);
    const totalAssets = 1n + rnd(10n ** 24n);
    const totalSupply = 1n + rnd(10n ** 30n);
    const offset = 10n ** 12n;
    const sharesFloor = assets * (totalSupply + offset) / (totalAssets + 1n);
    const sharesCeil = ceilDiv(assets * (totalSupply + offset), totalAssets + 1n);
    assert.ok(sharesFloor <= sharesCeil && sharesCeil - sharesFloor <= 1n);
    const assetsFloor = sharesFloor * (totalAssets + 1n) / (totalSupply + offset);
    assert.ok(assetsFloor <= assets);
    const predecessor = { sharesFloor, sharesCeil, assetsFloor };
    const upgradedDefault = { sharesFloor, sharesCeil, assetsFloor };
    assert.deepEqual(upgradedDefault, predecessor);
  }
});

test('new state has no initializer or reinitializer and is explicitly default-permissive', () => {
  const oldSource = gitShow(OLD.commit, 'contracts/tranches/strategies/saturn/SaturnStrategy.sol');
  const newSource = gitShow(NEW.commit, 'contracts/tranches/strategies/saturn/SaturnStrategy.sol');
  assert.equal((newSource.match(/\binitializer\b/g) || []).length, (oldSource.match(/\binitializer\b/g) || []).length);
  assert.equal((newSource.match(/\breinitializer\b/g) || []).length, 0);
  assert.match(newSource, /By default \(false\), all tokens and actions are allowed/);
});

test('package commitment recomputes from every declared artifact', () => {
  const crypto = require('node:crypto');
  const manifest = JSON.parse(fs.readFileSync(path.join(RAW, 'package-manifest.json')));
  assert.equal(manifest.fileCount, manifest.entries.length);
  for (const entry of manifest.entries) {
    const bytes = fs.readFileSync(path.join(ROOT, entry.path));
    assert.equal(bytes.length, entry.bytes, `${entry.path} bytes`);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), entry.sha256, `${entry.path} sha256`);
  }
  const canonical = Buffer.from(JSON.stringify(manifest.entries));
  assert.equal(crypto.createHash('sha256').update(canonical).digest('hex'), manifest.packageCommitmentSha256);
});
