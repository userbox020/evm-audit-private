#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const { ethers } = require('C:/Users/MiPC/AppData/Local/Temp/opencode/node_modules/ethers');

const ROOT = path.resolve(__dirname, '..');
const CORE_DEPLOYED = path.join(ROOT, 'targets', 'dolomite-margin', 'migrations', 'deployed.json');
const MODULE_DEPLOYED = path.join(
  ROOT,
  'targets',
  'dolomite-margin-modules',
  'packages',
  'deployment',
  'src',
  'deploy',
  'deployments.json',
);
const OUT_DIR = path.join(ROOT, 'reports', 'raw');
const OUT_FILE = path.join(OUT_DIR, 'dolomite-berachain-live-map.json');
const CHAIN_ID = 80094;
const ZERO = '0x0000000000000000000000000000000000000000';
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
const RPC_CALL_TIMEOUT_MS = 8_000;
const MAX_PERMISSION_CANDIDATES = 50;
const PERMISSION_NAME_RE = /(Router|Proxy|Trader|Liquidator|Wrapper|Unwrapper|BorrowPosition|DepositWithdrawal|GenericTrader|VaultFactory|IsolationMode.*Factory|Emitter|Migrator|AdminPause|AdminClaim)/i;

const ADDRESSES = {
  DolomiteMargin: '0x003Ca23Fd5F0ca87D01F6eC6CD14A8AE60c2b97D',
  BorrowPositionRouter: '0xF579b345cdA0860668b857De10ABD62442133D0F',
  DepositWithdrawalRouter: '0xf8b2c637A68cF6A17b1DF9F8992EeBeFf63d2dFf',
  GenericTraderRouter: '0x7b61CbA306CfdB02493b94757143132B1b72Bc6b',
  LiquidatorProxyV5: '0x1506f80d2FD5fbeF2424573EC86E5481C972B99a',
  OracleAggregator: '0xa150Ef2D5827dB283321D15d62d5D07fB41d636E',
  ChroniclePriceOracle: '0xb6B3EaF640707688186e7df34aC7d21fAbAf4359',
  RedstonePriceOracle: '0xe09f85B284C177c8325c5cCAeaE30a14494CDD45',
  DolomiteRegistryProxy: '0x0F38bFBd9c1450BCF7A758e80E148CE78cfE09fD',
};

const coreAbi = [
  'function owner() view returns (address)',
  'function getMarginRatio() view returns (tuple(uint256 value))',
  'function getLiquidationSpread() view returns (tuple(uint256 value))',
  'function getEarningsRate() view returns (tuple(uint256 value))',
  'function getMinBorrowedValue() view returns (tuple(uint256 value))',
  'function getAccountMaxNumberOfMarketsWithBalances() view returns (uint256)',
  'function getOracleSentinel() view returns (address)',
  'function getIsBorrowAllowed() view returns (bool)',
  'function getIsLiquidationAllowed() view returns (bool)',
  'function getCallbackGasLimit() view returns (uint256)',
  'function getDefaultAccountRiskOverrideSetter() view returns (address)',
  'function getNumMarkets() view returns (uint256)',
  'function getMarketTokenAddress(uint256 marketId) view returns (address)',
  'function getMarketIsClosing(uint256 marketId) view returns (bool)',
  'function getMarketPrice(uint256 marketId) view returns (tuple(uint256 value))',
  'function getMarketTotalPar(uint256 marketId) view returns (tuple(uint128 borrow,uint128 supply))',
  'function getMarketTotalWei(uint256 marketId) view returns (tuple(uint128 borrow,uint128 supply))',
  'function getMarketCachedIndex(uint256 marketId) view returns (tuple(uint112 borrow,uint112 supply,uint32 lastUpdate))',
  'function getMarketCurrentIndex(uint256 marketId) view returns (tuple(uint112 borrow,uint112 supply,uint32 lastUpdate))',
  'function getMarketPriceOracle(uint256 marketId) view returns (address)',
  'function getMarketInterestSetter(uint256 marketId) view returns (address)',
  'function getMarketMarginPremium(uint256 marketId) view returns (tuple(uint256 value))',
  'function getMarketLiquidationSpreadPremium(uint256 marketId) view returns (tuple(uint256 value))',
  'function getMarketMaxSupplyWei(uint256 marketId) view returns (tuple(bool sign,uint256 value))',
  'function getMarketMaxBorrowWei(uint256 marketId) view returns (tuple(bool sign,uint256 value))',
  'function getMarketEarningsRateOverride(uint256 marketId) view returns (tuple(uint256 value))',
  'function getMarketBorrowInterestRatePerSecond(uint256 marketId) view returns (tuple(uint256 value))',
  'function getNumExcessTokens(uint256 marketId) view returns (tuple(bool sign,uint256 value))',
  'function getIsGlobalOperator(address operator) view returns (bool)',
  'function getIsAutoTraderSpecial(address autoTrader) view returns (bool)',
];

const erc20Abi = [
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
];
const erc20BytesAbi = [
  'function symbol() view returns (bytes32)',
  'function name() view returns (bytes32)',
];
const registryAbi = [
  'function adminRegistry() view returns (address)',
  'function borrowPositionProxy() view returns (address)',
  'function depositWithdrawalRouter() view returns (address)',
  'function genericTraderProxy() view returns (address)',
  'function expiry() view returns (address)',
  'function slippageToleranceForPauseSentinel() view returns (uint256)',
  'function liquidatorAssetRegistry() view returns (address)',
  'function eventEmitter() view returns (address)',
  'function feeAgent() view returns (address)',
  'function chainlinkPriceOracle() view returns (address)',
  'function dolomiteMigrator() view returns (address)',
  'function redstonePriceOracle() view returns (address)',
  'function oracleAggregator() view returns (address)',
  'function dolomiteAccountRegistry() view returns (address)',
  'function isolationModeMulticallFunctions() view returns (bytes4[])',
  'function treasury() view returns (address)',
  'function dao() view returns (address)',
  'function isTrustedInternalTrader(address trader) view returns (bool)',
];
const aggregatorAbi = [
  'function getPrice(address token) view returns (tuple(uint256 value))',
  'function getDecimalsByToken(address token) view returns (uint8)',
  'function getOraclesByToken(address token) view returns (tuple(address oracle,address tokenPair,uint256 weight)[])',
  'function getTokenInfo(address token) view returns (tuple(tuple(address oracle,address tokenPair,uint256 weight)[] oracleInfos,uint8 decimals,address token))',
];
const feedOracleAbi = [
  'function getAggregatorByToken(address token) view returns (address)',
  'function getScribeByToken(address token) view returns (address)',
  'function getInvertPriceByToken(address token) view returns (bool)',
  'function stalenessThreshold() view returns (uint256)',
  'function getPrice(address token) view returns (tuple(uint256 value))',
];
const chainlinkFeedAbi = [
  'function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
  'function description() view returns (string)',
];
const twapAbi = [
  'function TOKEN() view returns (address)',
  'function PAIR() view returns (address)',
  'function TOKEN_DECIMALS_FACTOR() view returns (uint256)',
  'function observationInterval() view returns (uint32)',
  'function floorPrice() view returns (uint256)',
  'function getPrice(address token) view returns (tuple(uint256 value))',
];
const pairAbi = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function liquidity() view returns (uint128)',
  'function globalState() view returns (uint160 price,int24 tick,uint16 fee,uint16 timepointIndex,uint8 communityFee,bool unlocked)',
  'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)',
  'function getReserves() view returns (uint112 reserve0,uint112 reserve1,uint32 blockTimestampLast)',
];
const erc4626OracleAbi = [
  'function tokenInfo(address token) view returns (tuple(address vault,uint8 vaultDecimals,address asset,uint8 assetDecimals))',
  'function getPrice(address token) view returns (tuple(uint256 value))',
];
const erc4626Abi = [
  'function asset() view returns (address)',
  'function totalAssets() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function convertToAssets(uint256 shares) view returns (uint256)',
  'function decimals() view returns (uint8)',
];
const polOracleAbi = [
  'function DPOL_TOKEN() view returns (address)',
  'function getPrice(address token) view returns (tuple(uint256 value))',
];
const rewardsRegistryAbi = [
  'function bgt() view returns (address)',
  'function bgtm() view returns (address)',
  'function iBgt() view returns (address)',
  'function wbera() view returns (address)',
  'function berachainRewardsFactory() view returns (address)',
  'function iBgtStakingVault() view returns (address)',
  'function infrared() view returns (address)',
  'function bgtIsolationModeVaultFactory() view returns (address)',
  'function bgtmIsolationModeVaultFactory() view returns (address)',
  'function iBgtIsolationModeVaultFactory() view returns (address)',
  'function metaVaultImplementation() view returns (address)',
  'function polFeeAgent() view returns (address)',
  'function polFeePercentage(uint256 marketId) view returns (uint256)',
  'function polLiquidator() view returns (address)',
  'function polTokenVault() view returns (address)',
  'function polUnwrapperTrader() view returns (address)',
  'function polWrapperTrader() view returns (address)',
];
const polLiquidatorAbi = [
  'function liquidatorProxy() view returns (address)',
];
const authAbi = [
  'function isCallerAuthorized(address caller) view returns (bool)',
];
const liquidatorAssetRegistryAbi = [
  'function getLiquidatorsForAsset(uint256 marketId) view returns (address[])',
  'function isAssetWhitelistedForLiquidation(uint256 marketId,address liquidator) view returns (bool)',
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function bn(value) {
  if (value === undefined || value === null) return value;
  if (ethers.BigNumber.isBigNumber(value)) return value.toString();
  if (Array.isArray(value)) return value.map(bn);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = bn(v);
    }
    return out;
  }
  return value;
}

function asAddress(value) {
  if (!value || value === ZERO) return ZERO;
  return ethers.utils.getAddress(value);
}

function asAddressFromSlot(slot) {
  const value = ethers.BigNumber.from(slot);
  if (value.isZero()) return ZERO;
  return ethers.utils.getAddress(`0x${slot.slice(-40)}`);
}

function bytes32ToString(value) {
  try {
    return ethers.utils.parseBytes32String(value);
  } catch (_err) {
    return value;
  }
}

async function optional(label, fn) {
  try {
    return await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), RPC_CALL_TIMEOUT_MS)),
    ]);
  } catch (err) {
    return { error: `${label}: ${err.reason || err.message}` };
  }
}

function rpcCandidates() {
  const candidates = [];
  for (const key of ['BERACHAIN_RPC', 'BERACHAIN_RPC_URL']) {
    if (process.env[key]) candidates.push(process.env[key]);
  }
  const rpcFile = path.join(ROOT, 'RPC_URLS.txt');
  if (fs.existsSync(rpcFile)) {
    const lines = fs.readFileSync(rpcFile, 'utf8').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    const labels = new Set(['berachain', 'bera', 'bera chain', 'berachain mainnet', '80094']);
    for (let i = 0; i < lines.length - 1; i++) {
      if (labels.has(lines[i].toLowerCase()) && /^https?:\/\//i.test(lines[i + 1])) candidates.push(lines[i + 1]);
    }
  }
  candidates.push('https://rpc.berachain.com');
  candidates.push('https://berachain-rpc.publicnode.com');
  return [...new Set(candidates)];
}

async function connectProvider() {
  let lastError;
  for (const url of rpcCandidates()) {
    try {
      const provider = new ethers.providers.JsonRpcProvider(url, { chainId: CHAIN_ID, name: 'berachain' });
      const network = await provider.getNetwork();
      if (Number(network.chainId) !== CHAIN_ID) throw new Error(`unexpected chain ${network.chainId}`);
      await provider.getBlockNumber();
      return provider;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`No working Berachain RPC candidate (${lastError ? lastError.message : 'unknown error'})`);
}

function collectDeployments() {
  const byName = { ...ADDRESSES };
  const sources = [
    { source: 'core', data: readJson(CORE_DEPLOYED) },
    { source: 'modules', data: readJson(MODULE_DEPLOYED) },
  ];
  for (const { source, data } of sources) {
    for (const [name, chains] of Object.entries(data)) {
      const item = chains[String(CHAIN_ID)];
      if (!item || !item.address) continue;
      byName[name] = item.address;
      if (item.links) {
        for (const [linkName, linkAddress] of Object.entries(item.links)) {
          byName[`${name}.${linkName}`] = linkAddress;
        }
      }
      if (!byName[`${source}:${name}`]) byName[`${source}:${name}`] = item.address;
    }
  }

  const addressToNames = {};
  for (const [name, address] of Object.entries(byName)) {
    try {
      const key = asAddress(address).toLowerCase();
      if (!addressToNames[key]) addressToNames[key] = [];
      addressToNames[key].push(name);
    } catch (_err) {
      // ignore malformed deployment entries
    }
  }

  return { byName, addressToNames };
}

function namesFor(address, addressToNames) {
  if (!address) return [];
  const key = asAddress(address).toLowerCase();
  return addressToNames[key] || [];
}

async function readString(token, method) {
  const c = token;
  const bytes = new ethers.Contract(token.address, erc20BytesAbi, token.provider || token.signer);
  const value = await optional(method, () => c[method]());
  if (!value || !value.error) return value;
  const bytesValue = await optional(`${method} bytes32`, () => bytes[method]());
  return bytesValue && !bytesValue.error ? bytes32ToString(bytesValue) : value;
}

async function tokenMeta(provider, tokenAddress, holder) {
  const token = new ethers.Contract(tokenAddress, erc20Abi, provider);
  const [symbol, name, decimals, totalSupply, dolomiteBalance] = await Promise.all([
    readString(token, 'symbol'),
    readString(token, 'name'),
    optional('decimals', () => token.decimals()),
    optional('totalSupply', () => token.totalSupply()),
    optional('balanceOf', () => token.balanceOf(holder)),
  ]);
  return bn({ symbol, name, decimals, totalSupply, dolomiteBalance });
}

async function proxySlots(provider, address) {
  const [implSlot, adminSlot, beaconSlot, code] = await Promise.all([
    provider.getStorageAt(address, IMPL_SLOT),
    provider.getStorageAt(address, ADMIN_SLOT),
    provider.getStorageAt(address, BEACON_SLOT),
    provider.getCode(address),
  ]);
  const beacon = asAddressFromSlot(beaconSlot);
  let beaconImplementation = ZERO;
  if (beacon !== ZERO) {
    beaconImplementation = await optional('beacon implementation', async () => {
      const beaconContract = new ethers.Contract(beacon, ['function implementation() view returns (address)'], provider);
      return beaconContract.implementation();
    });
  }
  return bn({
    address,
    implementation: asAddressFromSlot(implSlot),
    admin: asAddressFromSlot(adminSlot),
    beacon,
    beaconImplementation,
    codeSize: code === '0x' ? 0 : (code.length - 2) / 2,
  });
}

function fullTokenPriceUsd(priceValue, decimals) {
  if (!priceValue || priceValue.error || decimals === undefined || decimals === null || decimals.error) return null;
  try {
    const value = ethers.BigNumber.from(priceValue.value || priceValue);
    const scaled = value.mul(ethers.BigNumber.from(10).pow(Number(decimals)));
    return ethers.utils.formatUnits(scaled, 36);
  } catch (_err) {
    return null;
  }
}

function normalizeOracleInfo(info) {
  return {
    oracle: asAddress(info.oracle || info[0]),
    tokenPair: asAddress(info.tokenPair || info[1]),
    weight: ethers.BigNumber.from(info.weight || info[2]).toString(),
  };
}

function normalizeAggregatorInfo(info) {
  if (!info || info.error) return info;
  return {
    oracleInfos: (info.oracleInfos || info[0] || []).map(normalizeOracleInfo),
    decimals: Number(info.decimals ?? info[1]),
    token: asAddress(info.token || info[2]),
  };
}

async function feedDetails(provider, feedAddress, block) {
  if (!feedAddress || feedAddress === ZERO) return null;
  const feed = new ethers.Contract(feedAddress, chainlinkFeedAbi, provider);
  const [round, decimals, description] = await Promise.all([
    optional('latestRoundData', () => feed.latestRoundData()),
    optional('feed decimals', () => feed.decimals()),
    optional('feed description', () => feed.description()),
  ]);
  const out = bn({ feed: feedAddress, decimals, description, latestRoundData: round });
  if (!round.error && round.updatedAt) {
    out.ageSeconds = String(block.timestamp - Number(round.updatedAt.toString()));
  }
  return out;
}

async function pairDetails(provider, pairAddress) {
  if (!pairAddress || pairAddress === ZERO) return null;
  const pair = new ethers.Contract(pairAddress, pairAbi, provider);
  const [token0, token1, liquidity, globalState, slot0, reserves] = await Promise.all([
    optional('pair token0', () => pair.token0()),
    optional('pair token1', () => pair.token1()),
    optional('pair liquidity', () => pair.liquidity()),
    optional('pair globalState', () => pair.globalState()),
    optional('pair slot0', () => pair.slot0()),
    optional('pair reserves', () => pair.getReserves()),
  ]);
  const balances = {};
  if (token0 && !token0.error && token1 && !token1.error) {
    const token0Contract = new ethers.Contract(token0, erc20Abi, provider);
    const token1Contract = new ethers.Contract(token1, erc20Abi, provider);
    const [balance0, balance1, decimals0, decimals1, symbol0, symbol1] = await Promise.all([
      optional('pair token0 balance', () => token0Contract.balanceOf(pairAddress)),
      optional('pair token1 balance', () => token1Contract.balanceOf(pairAddress)),
      optional('pair token0 decimals', () => token0Contract.decimals()),
      optional('pair token1 decimals', () => token1Contract.decimals()),
      readString(token0Contract, 'symbol'),
      readString(token1Contract, 'symbol'),
    ]);
    balances.token0 = { balance: balance0, decimals: decimals0, symbol: symbol0 };
    balances.token1 = { balance: balance1, decimals: decimals1, symbol: symbol1 };
  }
  return bn({ pair: pairAddress, token0, token1, liquidity, globalState, slot0, reserves, balances });
}

async function oracleDetails(provider, oracleAddress, tokenAddress, block, addressToNames) {
  const details = { address: oracleAddress, names: namesFor(oracleAddress, addressToNames) };
  const oracle = new ethers.Contract(oracleAddress, feedOracleAbi, provider);
  const [price, stalenessThreshold, aggregator, scribe, invert] = await Promise.all([
    optional('oracle getPrice', () => oracle.getPrice(tokenAddress)),
    optional('stalenessThreshold', () => oracle.stalenessThreshold()),
    optional('getAggregatorByToken', () => oracle.getAggregatorByToken(tokenAddress)),
    optional('getScribeByToken', () => oracle.getScribeByToken(tokenAddress)),
    optional('getInvertPriceByToken', () => oracle.getInvertPriceByToken(tokenAddress)),
  ]);
  details.price = bn(price);
  details.stalenessThreshold = bn(stalenessThreshold);
  details.invertPrice = bn(invert);

  if (aggregator && !aggregator.error && aggregator !== ZERO) {
    details.feed = await feedDetails(provider, aggregator, block);
  }
  if (scribe && !scribe.error && scribe !== ZERO) {
    details.scribe = await feedDetails(provider, scribe, block);
  }

  const twap = new ethers.Contract(oracleAddress, twapAbi, provider);
  const [twapToken, pair, interval, floorPrice] = await Promise.all([
    optional('twap TOKEN', () => twap.TOKEN()),
    optional('twap PAIR', () => twap.PAIR()),
    optional('twap observationInterval', () => twap.observationInterval()),
    optional('twap floorPrice', () => twap.floorPrice()),
  ]);
  if (!twapToken.error || !pair.error || !interval.error || !floorPrice.error) {
    details.twap = bn({ token: twapToken, pair, observationInterval: interval, floorPrice });
    if (pair && !pair.error) details.twap.pairDetails = await pairDetails(provider, pair);
  }

  const erc4626Oracle = new ethers.Contract(oracleAddress, erc4626OracleAbi, provider);
  const info = await optional('erc4626 tokenInfo', () => erc4626Oracle.tokenInfo(tokenAddress));
  if (info && !info.error && info.vault && info.vault !== ZERO) {
    const vault = new ethers.Contract(info.vault, erc4626Abi, provider);
    const oneShare = ethers.BigNumber.from(10).pow(Number(info.vaultDecimals));
    const [asset, totalAssets, totalSupply, convertOneShare, vaultDecimals] = await Promise.all([
      optional('vault asset', () => vault.asset()),
      optional('vault totalAssets', () => vault.totalAssets()),
      optional('vault totalSupply', () => vault.totalSupply()),
      optional('vault convertToAssets', () => vault.convertToAssets(oneShare)),
      optional('vault decimals', () => vault.decimals()),
    ]);
    details.erc4626 = bn({ tokenInfo: info, asset, totalAssets, totalSupply, convertOneShare, vaultDecimals });
  }

  const polOracle = new ethers.Contract(oracleAddress, polOracleAbi, provider);
  const dpol = await optional('DPOL_TOKEN', () => polOracle.DPOL_TOKEN());
  if (dpol && !dpol.error && dpol !== ZERO) details.pol = bn({ dpolToken: dpol });

  return details;
}

async function registryState(provider, address) {
  const registry = new ethers.Contract(address, registryAbi, provider);
  const keys = [
    'adminRegistry', 'borrowPositionProxy', 'depositWithdrawalRouter', 'genericTraderProxy', 'expiry',
    'slippageToleranceForPauseSentinel', 'liquidatorAssetRegistry', 'eventEmitter', 'feeAgent',
    'chainlinkPriceOracle', 'dolomiteMigrator', 'redstonePriceOracle', 'oracleAggregator',
    'dolomiteAccountRegistry', 'isolationModeMulticallFunctions', 'treasury', 'dao',
  ];
  const out = {};
  for (const key of keys) {
    out[key] = bn(await optional(key, () => registry[key]()));
  }
  return out;
}

async function rewardsState(provider, address, markets) {
  if (!address || address === ZERO) return null;
  const registry = new ethers.Contract(address, rewardsRegistryAbi, provider);
  const keys = [
    'bgt', 'bgtm', 'iBgt', 'wbera', 'berachainRewardsFactory', 'iBgtStakingVault', 'infrared',
    'bgtIsolationModeVaultFactory', 'bgtmIsolationModeVaultFactory', 'iBgtIsolationModeVaultFactory',
    'metaVaultImplementation', 'polFeeAgent', 'polLiquidator', 'polTokenVault', 'polUnwrapperTrader', 'polWrapperTrader',
  ];
  const out = {};
  for (const key of keys) out[key] = bn(await optional(key, () => registry[key]()));
  if (out.polLiquidator && !out.polLiquidator.error && out.polLiquidator !== ZERO) {
    const polLiquidator = new ethers.Contract(out.polLiquidator, polLiquidatorAbi, provider);
    out.polLiquidatorProxy = bn(await optional('pol liquidatorProxy', () => polLiquidator.liquidatorProxy()));
  }
  out.polFeePercentages = {};
  for (const market of markets) {
    out.polFeePercentages[market.marketId] = bn(await optional('pol fee percentage', () => registry.polFeePercentage(market.marketId)));
  }
  return out;
}

function candidateAddressSet(deployments, registry, rewards) {
  const addresses = new Map();
  for (const [name, address] of Object.entries(deployments.byName)) {
    if (!PERMISSION_NAME_RE.test(name)) continue;
    try { addresses.set(asAddress(address).toLowerCase(), { address: asAddress(address), names: namesFor(address, deployments.addressToNames) }); } catch (_err) {}
  }
  for (const object of [registry, rewards]) {
    if (!object) continue;
    for (const [name, value] of Object.entries(object)) {
      if (typeof value === 'string' && ethers.utils.isAddress(value) && value !== ZERO) {
        const key = asAddress(value).toLowerCase();
        const entry = addresses.get(key) || { address: asAddress(value), names: [] };
        entry.names.push(name);
        addresses.set(key, entry);
      }
    }
  }
  return Array.from(addresses.values());
}

async function mapInChunks(items, chunkSize, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    out.push(...await Promise.all(chunk.map(fn)));
  }
  return out;
}

async function permissions(provider, core, deployments, registry, rewards) {
  const candidates = candidateAddressSet(deployments, registry, rewards).slice(0, MAX_PERMISSION_CANDIDATES);
  console.error(`checking permissions for ${candidates.length} candidates`);
  const globalOperators = [];
  const specialAutoTraders = [];
  const coreResults = await mapInChunks(candidates, 8, async (item) => {
    const [isGlobal, isSpecial] = await Promise.all([
      optional('getIsGlobalOperator', () => core.getIsGlobalOperator(item.address)),
      optional('getIsAutoTraderSpecial', () => core.getIsAutoTraderSpecial(item.address)),
    ]);
    return { item, isGlobal, isSpecial };
  });
  for (const { item, isGlobal, isSpecial } of coreResults) {
    if (isGlobal === true) globalOperators.push(item);
    if (isSpecial === true) specialAutoTraders.push(item);
  }

  const authorizedGenericTraderCallers = [];
  if (registry.genericTraderProxy && !registry.genericTraderProxy.error && registry.genericTraderProxy !== ZERO) {
    const genericTrader = new ethers.Contract(registry.genericTraderProxy, authAbi, provider);
    const traderResults = await mapInChunks(candidates, 8, async (item) => {
      const isAuthorized = await optional('isCallerAuthorized', () => genericTrader.isCallerAuthorized(item.address));
      return { item, isAuthorized };
    });
    for (const { item, isAuthorized } of traderResults) {
      if (isAuthorized === true) authorizedGenericTraderCallers.push(item);
    }
  }

  return {
    candidateCountChecked: candidates.length,
    candidateLimit: MAX_PERMISSION_CANDIDATES,
    globalOperators,
    specialAutoTraders,
    authorizedGenericTraderCallers,
  };
}

async function liquidatorWhitelists(provider, registry, markets, liquidatorCandidates) {
  if (!registry.liquidatorAssetRegistry || registry.liquidatorAssetRegistry.error || registry.liquidatorAssetRegistry === ZERO) {
    return null;
  }
  const lar = new ethers.Contract(registry.liquidatorAssetRegistry, liquidatorAssetRegistryAbi, provider);
  const out = {};
  for (const market of markets) {
    const listed = await optional('getLiquidatorsForAsset', () => lar.getLiquidatorsForAsset(market.marketId));
    const checks = {};
    for (const item of liquidatorCandidates) {
      if (!item || !item.address || item.address === ZERO) continue;
      checks[item.label] = bn(await optional('isAssetWhitelistedForLiquidation', () => lar.isAssetWhitelistedForLiquidation(market.marketId, item.address)));
    }
    out[market.marketId] = bn({ listedLiquidators: listed, candidateChecks: checks });
  }
  return out;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.error('connecting to Berachain RPC');
  const provider = await connectProvider();
  const deployments = collectDeployments();
  const core = new ethers.Contract(ADDRESSES.DolomiteMargin, coreAbi, provider);
  const block = await provider.getBlock('latest');
  console.error(`connected at block ${block.number}`);

  const globalRisk = bn({
    owner: await optional('owner', () => core.owner()),
    marginRatio: await optional('marginRatio', () => core.getMarginRatio()),
    liquidationSpread: await optional('liquidationSpread', () => core.getLiquidationSpread()),
    earningsRate: await optional('earningsRate', () => core.getEarningsRate()),
    minBorrowedValue: await optional('minBorrowedValue', () => core.getMinBorrowedValue()),
    accountMaxNumberOfMarketsWithBalances: await optional('accountMax', () => core.getAccountMaxNumberOfMarketsWithBalances()),
    oracleSentinel: await optional('oracleSentinel', () => core.getOracleSentinel()),
    isBorrowAllowed: await optional('borrowAllowed', () => core.getIsBorrowAllowed()),
    isLiquidationAllowed: await optional('liquidationAllowed', () => core.getIsLiquidationAllowed()),
    callbackGasLimit: await optional('callbackGasLimit', () => core.getCallbackGasLimit()),
    defaultAccountRiskOverrideSetter: await optional('defaultRiskOverride', () => core.getDefaultAccountRiskOverrideSetter()),
  });

  const registry = await registryState(provider, ADDRESSES.DolomiteRegistryProxy);
  const registryAggregatorAddress = registry.oracleAggregator && !registry.oracleAggregator.error
    ? registry.oracleAggregator
    : ADDRESSES.OracleAggregator;
  const aggregator = new ethers.Contract(registryAggregatorAddress, aggregatorAbi, provider);

  const numMarketsRaw = await core.getNumMarkets();
  const numMarkets = numMarketsRaw.toNumber();
  console.error(`mapping ${numMarkets} markets`);
  const markets = [];
  const uniqueUnderlyingOracles = new Set();
  for (let i = 0; i < numMarkets; i++) {
    const tokenAddress = await core.getMarketTokenAddress(i);
    const token = await tokenMeta(provider, tokenAddress, ADDRESSES.DolomiteMargin);
    const [
      isClosing,
      price,
      totalPar,
      totalWei,
      cachedIndex,
      currentIndex,
      priceOracle,
      interestSetter,
      marginPremium,
      liquidationSpreadPremium,
      maxSupplyWei,
      maxBorrowWei,
      earningsRateOverride,
      borrowRate,
      excessTokens,
      aggregatorTokenInfo,
    ] = await Promise.all([
      optional('isClosing', () => core.getMarketIsClosing(i)),
      optional('market price', () => core.getMarketPrice(i)),
      optional('totalPar', () => core.getMarketTotalPar(i)),
      optional('totalWei', () => core.getMarketTotalWei(i)),
      optional('cachedIndex', () => core.getMarketCachedIndex(i)),
      optional('currentIndex', () => core.getMarketCurrentIndex(i)),
      optional('priceOracle', () => core.getMarketPriceOracle(i)),
      optional('interestSetter', () => core.getMarketInterestSetter(i)),
      optional('marginPremium', () => core.getMarketMarginPremium(i)),
      optional('liquidationSpreadPremium', () => core.getMarketLiquidationSpreadPremium(i)),
      optional('maxSupplyWei', () => core.getMarketMaxSupplyWei(i)),
      optional('maxBorrowWei', () => core.getMarketMaxBorrowWei(i)),
      optional('earningsRateOverride', () => core.getMarketEarningsRateOverride(i)),
      optional('borrowRate', () => core.getMarketBorrowInterestRatePerSecond(i)),
      optional('excessTokens', () => core.getNumExcessTokens(i)),
      optional('aggregator tokenInfo', () => aggregator.getTokenInfo(tokenAddress)),
    ]);

    const normalizedAggregatorTokenInfo = normalizeAggregatorInfo(aggregatorTokenInfo);
    const oracleInfos = normalizedAggregatorTokenInfo && !normalizedAggregatorTokenInfo.error
      ? normalizedAggregatorTokenInfo.oracleInfos
      : [];
    for (const info of oracleInfos) uniqueUnderlyingOracles.add(asAddress(info.oracle).toLowerCase());

    const priceUsd = price && !price.error ? fullTokenPriceUsd(price, token.decimals) : null;
    const market = bn({
      marketId: i,
      token: tokenAddress,
      tokenInfo: token,
      isClosing,
      price,
      priceUsdPerToken: priceUsd,
      totalPar,
      totalWei,
      cachedIndex,
      currentIndex,
      priceOracle,
      priceOracleNames: priceOracle && !priceOracle.error ? namesFor(priceOracle, deployments.addressToNames) : [],
      interestSetter,
      interestSetterNames: interestSetter && !interestSetter.error ? namesFor(interestSetter, deployments.addressToNames) : [],
      marginPremium,
      liquidationSpreadPremium,
      maxSupplyWei,
      maxBorrowWei,
      earningsRateOverride,
      borrowRatePerSecond: borrowRate,
      excessTokens,
      aggregatorTokenInfo: normalizedAggregatorTokenInfo,
    });
    markets.push(market);
  }

  const oracleRoutes = {};
  console.error('mapping oracle routes');
  for (const market of markets) {
    const tokenAddress = market.token;
    const info = market.aggregatorTokenInfo;
    if (!info || info.error || !Array.isArray(info.oracleInfos)) continue;
    oracleRoutes[market.marketId] = [];
    for (const route of info.oracleInfos) {
      const routeDetails = await oracleDetails(provider, route.oracle, tokenAddress, block, deployments.addressToNames);
      oracleRoutes[market.marketId].push(bn({ ...route, details: routeDetails }));
    }
  }

  const rewardsRegistryAddress = deployments.byName.BerachainRewardsRegistryProxy
    || deployments.byName.BerachainRewardsRegistry
    || deployments.byName.BerachainRewardsRegistryV1
    || ZERO;
  const rewards = await rewardsState(provider, rewardsRegistryAddress, markets);
  let perms = { skipped: 'set CHECK_PERMISSIONS=true to run permission candidate scan' };
  if (process.env.CHECK_PERMISSIONS === 'true') {
    console.error('mapping permissions');
    perms = await permissions(provider, core, deployments, registry, rewards);
  }
  const liquidatorCandidates = [
    { label: 'registry.liquidatorAssetRegistry', address: registry.liquidatorAssetRegistry },
    { label: 'LiquidatorProxyV5_docs', address: ADDRESSES.LiquidatorProxyV5 },
    { label: 'rewards.polLiquidator', address: rewards && rewards.polLiquidator },
    { label: 'rewards.polLiquidatorProxy', address: rewards && rewards.polLiquidatorProxy },
  ];
  const liquidationWhitelists = await liquidatorWhitelists(provider, registry, markets, liquidatorCandidates);

  const proxyChecks = {};
  console.error('mapping proxy slots');
  const checkNames = [
    'DolomiteMargin', 'DolomiteRegistryProxy', 'OracleAggregator', 'BorrowPositionRouter', 'DepositWithdrawalRouter',
    'GenericTraderRouter', 'LiquidatorProxyV5', 'ChroniclePriceOracle', 'RedstonePriceOracle',
  ];
  for (const name of checkNames) {
    const address = deployments.byName[name] || ADDRESSES[name];
    if (address) proxyChecks[name] = await optional(`proxy ${name}`, () => proxySlots(provider, address));
  }
  if (registry.genericTraderProxy && !registry.genericTraderProxy.error) {
    proxyChecks.RegistryGenericTraderProxy = await optional('proxy generic trader', () => proxySlots(provider, registry.genericTraderProxy));
  }
  if (registry.borrowPositionProxy && !registry.borrowPositionProxy.error) {
    proxyChecks.RegistryBorrowPositionProxy = await optional('proxy borrow position', () => proxySlots(provider, registry.borrowPositionProxy));
  }

  const out = bn({
    generatedAt: new Date().toISOString(),
    chainId: CHAIN_ID,
    block: { number: block.number, timestamp: block.timestamp, hash: block.hash },
    deploymentCounts: {
      names: Object.keys(deployments.byName).length,
      uniqueAddresses: Object.keys(deployments.addressToNames).length,
      uniqueUnderlyingOracles: uniqueUnderlyingOracles.size,
    },
    addresses: ADDRESSES,
    globalRisk,
    registry,
    rewardsRegistryAddress,
    rewards,
    markets,
    oracleRoutes,
    permissions: perms,
    liquidationWhitelists,
    proxyChecks,
  });

  fs.writeFileSync(OUT_FILE, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`wrote ${path.relative(ROOT, OUT_FILE)} with ${markets.length} markets`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
