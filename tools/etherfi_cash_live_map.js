#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const { ethers } = require('C:/Users/MiPC/AppData/Local/Temp/opencode/node_modules/ethers');

const ROOT = path.resolve(__dirname, '..');
const TARGET = path.join(ROOT, 'targets', 'cash-v3');
const OUT_DIR = path.join(ROOT, 'reports', 'raw');
const OUT_FILE = path.join(OUT_DIR, 'etherfi-cash-live-map.json');
const CHAIN_ID = '10';

const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
const ZERO = '0x0000000000000000000000000000000000000000';
const ETH_SELECTOR = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function rpcUrl(label) {
  if (process.env.OPTIMISM_RPC) return process.env.OPTIMISM_RPC;
  const p = path.join(ROOT, 'RPC_URLS.txt');
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].toLowerCase() === label.toLowerCase() && /^https?:\/\//i.test(lines[i + 1])) return lines[i + 1];
  }
  throw new Error(`RPC label not found: ${label}`);
}

function artifact(source, name) {
  return readJson(path.join(TARGET, 'out', source, `${name}.json`)).abi;
}

function asAddressFromSlot(slot) {
  const v = ethers.BigNumber.from(slot);
  if (v.isZero()) return ZERO;
  return ethers.utils.getAddress(`0x${slot.slice(-40)}`);
}

function bn(value) {
  if (value === undefined || value === null) return value;
  if (ethers.BigNumber.isBigNumber(value)) return value.toString();
  if (Array.isArray(value)) return value.map(bn);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/^\d+$/.test(k)) continue;
      out[k] = bn(v);
    }
    return out;
  }
  return value;
}

async function optional(label, fn) {
  try {
    return await fn();
  } catch (err) {
    return { error: `${label}: ${err.reason || err.message}` };
  }
}

function resolveFixture(fixtures, symbol) {
  if (symbol === 'ETH') return ETH_SELECTOR;
  if (fixtures[symbol]) return fixtures[symbol];
  const found = Object.keys(fixtures).find((k) => k.toLowerCase() === symbol.toLowerCase());
  return found ? fixtures[found] : undefined;
}

function priceConfig(version, raw) {
  if (!raw || raw.error) return raw;
  if (version === 'v2') {
    return {
      oracle: raw[0],
      priceFunctionCalldata: raw[1],
      isChainlinkType: raw[2],
      oraclePriceDecimals: Number(raw[3]),
      maxStaleness: Number(raw[4]),
      dataType: Number(raw[5]),
      isStableToken: raw[6],
      baseAsset: raw[7],
    };
  }
  return {
    oracle: raw[0],
    priceFunctionCalldata: raw[1],
    isChainlinkType: raw[2],
    oraclePriceDecimals: Number(raw[3]),
    maxStaleness: Number(raw[4]),
    dataType: Number(raw[5]),
    isBaseTokenEth: raw[6],
    isStableToken: raw[7],
    isBaseTokenBtc: raw[8],
  };
}

function tokenDataRows(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.map((x) => ({ token: x.token || x[0], amount: bn(x.amount ?? x[1]) }));
}

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl('optimism'));
  const deployments = readJson(path.join(TARGET, 'deployments', 'mainnet', CHAIN_ID, 'deployments.json')).addresses;
  const config = readJson(path.join(TARGET, 'deployments', 'mainnet', CHAIN_ID, 'config.json'));
  const fixtures = readJson(path.join(TARGET, 'deployments', 'mainnet', 'fixtures', 'fixtures.json'))[CHAIN_ID];

  const erc20Abi = [
    'function symbol() view returns (string)',
    'function name() view returns (string)',
    'function decimals() view returns (uint8)',
    'function totalSupply() view returns (uint256)',
    'function balanceOf(address) view returns (uint256)',
  ];
  const chainlinkAbi = [
    'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
    'function decimals() view returns (uint8)',
    'function description() view returns (string)',
  ];

  const priceV1Abi = artifact('PriceProvider.sol', 'PriceProvider');
  const priceV2Abi = artifact('PriceProviderV2.sol', 'PriceProviderV2');
  const debtAbi = artifact('DebtManagerCore.sol', 'DebtManagerCore');
  const cashAbi = artifact('CashModuleCore.sol', 'CashModuleCore');
  const roleAbi = artifact('RoleRegistry.sol', 'RoleRegistry');
  const topUpDestAbi = artifact('TopUpDest.sol', 'TopUpDest');
  const settlementAbi = artifact('SettlementDispatcherV2.sol', 'SettlementDispatcherV2');

  const roleRegistry = new ethers.Contract(deployments.RoleRegistry, roleAbi, provider);
  const debtManager = new ethers.Contract(deployments.DebtManager, debtAbi, provider);
  const cashModule = new ethers.Contract(deployments.CashModule, cashAbi, provider);
  const topUpDest = new ethers.Contract(deployments.TopUpDest, topUpDestAbi, provider);
  const settlementRain = new ethers.Contract(deployments.SettlementDispatcherRain, settlementAbi, provider);
  const settlementReap = new ethers.Contract(deployments.SettlementDispatcherReap, settlementAbi, provider);
  const settlementPix = new ethers.Contract(deployments.SettlementDispatcherPix, settlementAbi, provider);

  const priceV2 = new ethers.Contract(deployments.PriceProvider, priceV2Abi, provider);
  const priceVersion = (await optional('isBaseAsset', () => priceV2.isBaseAsset(ETH_SELECTOR))).error ? 'v1' : 'v2';
  const priceProvider = new ethers.Contract(deployments.PriceProvider, priceVersion === 'v2' ? priceV2Abi : priceV1Abi, provider);

  const block = await provider.getBlock('latest');

  const proxySlots = {};
  for (const [name, address] of Object.entries(deployments)) {
    proxySlots[name] = await optional(`proxy ${name}`, async () => {
      const [implSlot, adminSlot, beaconSlot, code] = await Promise.all([
        provider.getStorageAt(address, IMPL_SLOT),
        provider.getStorageAt(address, ADMIN_SLOT),
        provider.getStorageAt(address, BEACON_SLOT),
        provider.getCode(address),
      ]);
      return {
        address,
        implementation: asAddressFromSlot(implSlot),
        admin: asAddressFromSlot(adminSlot),
        beacon: asAddressFromSlot(beaconSlot),
        codeSize: (code.length - 2) / 2,
      };
    });
  }

  const roleNames = new Set(Object.keys(config.roles || {}));
  [
    'PAUSER', 'UNPAUSER', 'DATA_PROVIDER_ADMIN_ROLE', 'CASH_MODULE_CONTROLLER_ROLE',
    'PRICE_PROVIDER_ADMIN_ROLE', 'CASHBACK_DISPATCHER_ADMIN_ROLE', 'DEBT_MANAGER_ADMIN_ROLE',
    'ETHER_FI_WALLET_ROLE', 'ETHERFI_SAFE_FACTORY_ADMIN_ROLE', 'SETTLEMENT_DISPATCHER_BRIDGER_ROLE',
    'DEPOSITOR_ROLE', 'TOP_UP_ROLE', 'ETHERFI_LIQUID_MODULE_ADMIN', 'STARGATE_MODULE_ADMIN_ROLE',
    'MIDAS_MODULE_ADMIN', 'BEHYPE_STAKE_MODULE_ADMIN_ROLE',
  ].forEach((x) => roleNames.add(x));
  const roles = {};
  for (const role of roleNames) {
    const id = ethers.utils.id(role);
    roles[role] = await optional(`role ${role}`, () => roleRegistry['roleHolders(bytes32)'](id));
  }

  const tokenSymbols = new Set([
    ...Object.keys(config.priceProvider?.oracles || {}),
    ...(config.priceProvider?.tokensWithPrice || []),
    ...Object.keys(config.debtManager?.collateralTokens || {}),
    ...(config.debtManager?.borrowTokens || []),
  ]);

  const tokenAddresses = new Map();
  for (const symbol of tokenSymbols) {
    const address = resolveFixture(fixtures, symbol);
    if (address && ethers.utils.isAddress(address)) tokenAddresses.set(ethers.utils.getAddress(address), symbol);
  }

  const collateralTokens = await optional('getCollateralTokens', () => debtManager.getCollateralTokens());
  const borrowTokens = await optional('getBorrowTokens', () => debtManager.getBorrowTokens());
  for (const addr of [...(Array.isArray(collateralTokens) ? collateralTokens : []), ...(Array.isArray(borrowTokens) ? borrowTokens : [])]) {
    if (ethers.utils.isAddress(addr) && !tokenAddresses.has(ethers.utils.getAddress(addr))) tokenAddresses.set(ethers.utils.getAddress(addr), 'unknown');
  }

  const tokens = [];
  for (const [address, configuredSymbol] of tokenAddresses.entries()) {
    const isEthSelector = address.toLowerCase() === ETH_SELECTOR.toLowerCase();
    const erc20 = isEthSelector ? null : new ethers.Contract(address, erc20Abi, provider);
    const rawCfg = await optional(`tokenConfig ${configuredSymbol}`, () => priceProvider.tokenConfig(address));
    const cfg = priceConfig(priceVersion, rawCfg);
    const price = await optional(`price ${configuredSymbol}`, () => priceProvider.price(address));
    let oracleLatest = null;
    let customOracleReturn = null;
    if (cfg && !cfg.error && cfg.oracle && cfg.oracle !== ZERO) {
      if (cfg.isChainlinkType) {
        const feed = new ethers.Contract(cfg.oracle, chainlinkAbi, provider);
        oracleLatest = await optional(`latestRoundData ${configuredSymbol}`, async () => {
          const [latest, decimals, description] = await Promise.all([
            feed.latestRoundData(),
            optional('feed decimals', () => feed.decimals()),
            optional('feed description', () => feed.description()),
          ]);
          return {
            roundId: latest.roundId.toString(),
            answer: latest.answer.toString(),
            startedAt: latest.startedAt.toString(),
            updatedAt: latest.updatedAt.toString(),
            answeredInRound: latest.answeredInRound.toString(),
            ageSec: block.timestamp - Number(latest.updatedAt),
            decimals,
            description,
          };
        });
      } else if (cfg.priceFunctionCalldata && cfg.priceFunctionCalldata !== '0x') {
        customOracleReturn = await optional(`customOracle ${configuredSymbol}`, async () => {
          const data = await provider.call({ to: cfg.oracle, data: cfg.priceFunctionCalldata });
          let decoded;
          try {
            decoded = cfg.dataType === 0
              ? ethers.BigNumber.from(ethers.utils.defaultAbiCoder.decode(['int256'], data)[0]).toString()
              : ethers.BigNumber.from(ethers.utils.defaultAbiCoder.decode(['uint256'], data)[0]).toString();
          } catch (err) {
            decoded = null;
          }
          return { selector: cfg.priceFunctionCalldata.slice(0, 10), data, decoded };
        });
      }
    }

    const erc20Symbol = isEthSelector ? 'ETH' : await optional(`symbol ${configuredSymbol}`, () => erc20.symbol());
    tokens.push({
      configuredSymbol: configuredSymbol === 'unknown' && typeof erc20Symbol === 'string' ? erc20Symbol : configuredSymbol,
      address,
      erc20Symbol,
      erc20Name: isEthSelector ? 'ETH' : await optional(`name ${configuredSymbol}`, () => erc20.name()),
      decimals: isEthSelector ? 18 : await optional(`decimals ${configuredSymbol}`, () => erc20.decimals()),
      totalSupply: isEthSelector ? null : bn(await optional(`totalSupply ${configuredSymbol}`, () => erc20.totalSupply())),
      debtManagerBalance: isEthSelector ? null : bn(await optional(`debtBalance ${configuredSymbol}`, () => erc20.balanceOf(deployments.DebtManager))),
      cashModuleBalance: isEthSelector ? null : bn(await optional(`cashBalance ${configuredSymbol}`, () => erc20.balanceOf(deployments.CashModule))),
      topUpDestBalance: isEthSelector ? null : bn(await optional(`topUpDestBalance ${configuredSymbol}`, () => erc20.balanceOf(deployments.TopUpDest))),
      price: bn(price),
      priceConfig: cfg,
      oracleLatest: bn(oracleLatest),
      customOracleReturn: bn(customOracleReturn),
      debt: {
        isCollateral: await optional(`isCollateral ${configuredSymbol}`, () => debtManager.isCollateralToken(address)),
        isBorrow: await optional(`isBorrow ${configuredSymbol}`, () => debtManager.isBorrowToken(address)),
        collateralConfig: bn(await optional(`collateralConfig ${configuredSymbol}`, () => debtManager.collateralTokenConfig(address))),
        borrowConfig: bn(await optional(`borrowConfig ${configuredSymbol}`, () => debtManager.borrowTokenConfig(address))),
        totalBorrowingAmount: bn(await optional(`totalBorrowingAmount ${configuredSymbol}`, () => debtManager.totalBorrowingAmount(address))),
        totalSupplies: bn(await optional(`totalSupplies ${configuredSymbol}`, () => debtManager['totalSupplies(address)'](address))),
      },
      topUpDestDeposit: bn(await optional(`topUp deposit ${configuredSymbol}`, () => topUpDest.getDeposit(address))),
      settlementRecipients: {
        Rain: await optional(`rain recipient ${configuredSymbol}`, () => settlementRain.getSettlementRecipient(address)),
        Reap: await optional(`reap recipient ${configuredSymbol}`, () => settlementReap.getSettlementRecipient(address)),
        Pix: await optional(`pix recipient ${configuredSymbol}`, () => settlementPix.getSettlementRecipient(address)),
      },
    });
  }

  const currentState = await optional('getCurrentState', async () => {
    const state = await debtManager.getCurrentState();
    return {
      borrowings: tokenDataRows(state.borrowings || state[0]),
      totalBorrowingsInUsd: bn(state.totalBorrowingsInUsd ?? state[1]),
      totalLiquidStableAmounts: tokenDataRows(state.totalLiquidStableAmounts || state[2]),
    };
  });

  const result = {
    capturedAt: new Date().toISOString(),
    chainId: Number(CHAIN_ID),
    blockNumber: block.number,
    blockTimestamp: block.timestamp,
    commit: 'e05bda2',
    addresses: deployments,
    proxySlots: bn(proxySlots),
    priceProviderVersion: priceVersion,
    paused: {
      CashModule: await optional('cash paused', () => cashModule.paused()),
      DebtManager: await optional('debt paused', () => debtManager.paused()),
      PriceProvider: await optional('price paused', () => priceProvider.paused()),
      TopUpDest: await optional('topup paused', () => topUpDest.paused()),
      SettlementDispatcherRain: await optional('rain paused', () => settlementRain.paused()),
      SettlementDispatcherReap: await optional('reap paused', () => settlementReap.paused()),
      SettlementDispatcherPix: await optional('pix paused', () => settlementPix.paused()),
    },
    roleRegistryOwner: await optional('role owner', () => roleRegistry.owner()),
    roles: bn(roles),
    cashModule: {
      whitelistedWithdrawAssets: await optional('withdraw assets', () => cashModule.getWhitelistedWithdrawAssets()),
      whitelistedModulesCanRequestWithdraw: await optional('modules can withdraw', () => cashModule.getWhitelistedModulesCanRequestWithdraw()),
    },
    debtManager: {
      collateralTokens,
      borrowTokens,
      currentState: bn(currentState),
      totalBorrowingAmounts: bn(await optional('totalBorrowingAmounts', async () => {
        const r = await debtManager.totalBorrowingAmounts();
        return { tokens: tokenDataRows(r[0]), totalUsd: r[1] };
      })),
      totalSupplies: bn(await optional('totalSupplies', async () => {
        const r = await debtManager['totalSupplies()']();
        return { tokens: tokenDataRows(r[0]), totalUsd: r[1] };
      })),
    },
    tokens: tokens.sort((a, b) => a.configuredSymbol.localeCompare(b.configuredSymbol)),
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2));

  console.log(`Captured Ether.fi Cash live map at ${result.capturedAt}`);
  console.log(`Optimism block=${result.blockNumber} priceProvider=${priceVersion} tokens=${tokens.length}`);
  const stale = tokens.filter((t) => t.oracleLatest && !t.oracleLatest.error && t.priceConfig?.maxStaleness && t.oracleLatest.ageSec > t.priceConfig.maxStaleness);
  const custom = tokens.filter((t) => t.priceConfig && !t.priceConfig.error && !t.priceConfig.isChainlinkType);
  const borrowRows = tokens.filter((t) => t.debt?.isBorrow === true).map((t) => `${t.configuredSymbol}:cash=${t.debtManagerBalance} borrow=${t.debt.totalBorrowingAmount} supply=${t.debt.totalSupplies}`);
  console.log(`Stale chainlink configs=${stale.length} customOracleConfigs=${custom.length}`);
  console.log(`Borrow tokens: ${borrowRows.join(', ')}`);
  console.log(`Wrote ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
