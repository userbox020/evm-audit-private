#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const { ethers } = require('C:/Users/MiPC/AppData/Local/Temp/opencode/node_modules/ethers');

const ROOT = path.resolve(__dirname, '..');
const MAP_FILE = path.join(ROOT, 'reports', 'raw', 'dolomite-berachain-live-map.json');
const OUT_FILE = path.join(ROOT, 'reports', 'raw', 'dolomite-berachain-pol-generic-probe.json');
const CHAIN_ID = 80094;
const ZERO = '0x0000000000000000000000000000000000000000';
const POL_MARKET_ID = 39;
const IBGT_MARKET_ID = 38;
const POL_FACTORY = '0x5DB5ef3D657471d991e4de09983D2c92b0609749';
const POL_FACTORY_DEPLOY_TX = '0xc99f2a81ceae3e74bec386269776326ce7f54a3a3990344ab2c90f22c018ac1a';
const LOG_CHUNK = 10_000;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sanitize(text) {
  return String(text || '').replace(/https?:\/\/[^\s"']+/g, '[redacted-url]');
}

function bn(value) {
  if (value === undefined || value === null) return value;
  if (ethers.BigNumber.isBigNumber(value)) return value.toString();
  if (Array.isArray(value)) return value.map(bn);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = bn(v);
    return out;
  }
  return value;
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
  candidates.push('https://berachain-rpc.publicnode.com');
  candidates.push('https://rpc.berachain.com');
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
  throw new Error(`No working Berachain RPC candidate (${lastError ? sanitize(lastError.message) : 'unknown error'})`);
}

async function getLogsChunked(provider, filter, fromBlock, toBlock) {
  const logs = [];
  for (let from = fromBlock; from <= toBlock; from += LOG_CHUNK) {
    const to = Math.min(toBlock, from + LOG_CHUNK - 1);
    logs.push(...await provider.getLogs({ ...filter, fromBlock: from, toBlock: to }));
  }
  return logs;
}

function accountKey(owner, number) {
  return `${ethers.utils.getAddress(owner)}:${ethers.BigNumber.from(number).toString()}`;
}

function pushAccount(accounts, owner, number, reason) {
  const key = accountKey(owner, number);
  if (!accounts.has(key)) accounts.set(key, { owner: ethers.utils.getAddress(owner), number: ethers.BigNumber.from(number).toString(), reasons: [] });
  accounts.get(key).reasons.push(reason);
}

function isMarket(value, marketId) {
  return ethers.BigNumber.from(value).eq(marketId);
}

async function discoverPolAccounts(provider, coreAddress, fromBlock, toBlock, vaults) {
  const iface = new ethers.utils.Interface([
    'event LogDeposit(address indexed accountOwner,uint256 accountNumber,uint256 market,tuple(tuple(bool sign,uint256 value) deltaWei,tuple(bool sign,uint128 value) newPar) update,address from)',
    'event LogWithdraw(address indexed accountOwner,uint256 accountNumber,uint256 market,tuple(tuple(bool sign,uint256 value) deltaWei,tuple(bool sign,uint128 value) newPar) update,address to)',
    'event LogTransfer(address indexed accountOneOwner,uint256 accountOneNumber,address indexed accountTwoOwner,uint256 accountTwoNumber,uint256 market,tuple(tuple(bool sign,uint256 value) deltaWei,tuple(bool sign,uint128 value) newPar) updateOne,tuple(tuple(bool sign,uint256 value) deltaWei,tuple(bool sign,uint128 value) newPar) updateTwo)',
    'event LogBuy(address indexed accountOwner,uint256 accountNumber,uint256 takerMarket,uint256 makerMarket,tuple(tuple(bool sign,uint256 value) deltaWei,tuple(bool sign,uint128 value) newPar) takerUpdate,tuple(tuple(bool sign,uint256 value) deltaWei,tuple(bool sign,uint128 value) newPar) makerUpdate,address exchangeWrapper)',
    'event LogSell(address indexed accountOwner,uint256 accountNumber,uint256 takerMarket,uint256 makerMarket,tuple(tuple(bool sign,uint256 value) deltaWei,tuple(bool sign,uint128 value) newPar) takerUpdate,tuple(tuple(bool sign,uint256 value) deltaWei,tuple(bool sign,uint128 value) newPar) makerUpdate,address exchangeWrapper)',
    'event LogTrade(address indexed takerAccountOwner,uint256 takerAccountNumber,address indexed makerAccountOwner,uint256 makerAccountNumber,uint256 inputMarket,uint256 outputMarket,tuple(tuple(bool sign,uint256 value) deltaWei,tuple(bool sign,uint128 value) newPar) takerInputUpdate,tuple(tuple(bool sign,uint256 value) deltaWei,tuple(bool sign,uint128 value) newPar) takerOutputUpdate,tuple(tuple(bool sign,uint256 value) deltaWei,tuple(bool sign,uint128 value) newPar) makerInputUpdate,tuple(tuple(bool sign,uint256 value) deltaWei,tuple(bool sign,uint128 value) newPar) makerOutputUpdate,address autoTrader)',
    'event LogLiquidate(address indexed solidAccountOwner,uint256 solidAccountNumber,address indexed liquidAccountOwner,uint256 liquidAccountNumber,uint256 heldMarket,uint256 owedMarket,tuple(tuple(bool sign,uint256 value) deltaWei,tuple(bool sign,uint128 value) newPar) solidHeldUpdate,tuple(tuple(bool sign,uint256 value) deltaWei,tuple(bool sign,uint128 value) newPar) solidOwedUpdate,tuple(tuple(bool sign,uint256 value) deltaWei,tuple(bool sign,uint128 value) newPar) liquidHeldUpdate,tuple(tuple(bool sign,uint256 value) deltaWei,tuple(bool sign,uint128 value) newPar) liquidOwedUpdate)',
  ]);
  const accountMap = new Map();
  const ownerTopic = (owner) => ethers.utils.hexZeroPad(owner, 32);
  const queryShapes = [
    { event: 'LogDeposit', topicPositions: [1] },
    { event: 'LogWithdraw', topicPositions: [1] },
    { event: 'LogBuy', topicPositions: [1] },
    { event: 'LogSell', topicPositions: [1] },
    { event: 'LogTransfer', topicPositions: [1, 2] },
    { event: 'LogTrade', topicPositions: [1, 2] },
    { event: 'LogLiquidate', topicPositions: [1, 2] },
  ];

  for (const vault of vaults) {
    for (const shape of queryShapes) {
      const topic0 = iface.getEventTopic(shape.event);
      for (const pos of shape.topicPositions) {
        const topics = [topic0];
        topics[pos] = ownerTopic(vault.vault);
        const logs = await getLogsChunked(provider, { address: coreAddress, topics }, fromBlock, toBlock);
        for (const log of logs) {
          const event = iface.parseLog(log);
          const a = event.args;
          if (event.name === 'LogDeposit' || event.name === 'LogWithdraw') {
            if (isMarket(a.market, POL_MARKET_ID)) pushAccount(accountMap, a.accountOwner, a.accountNumber, `${event.name}@${log.blockNumber}`);
          } else if (event.name === 'LogBuy' || event.name === 'LogSell') {
            if (isMarket(a.takerMarket, POL_MARKET_ID) || isMarket(a.makerMarket, POL_MARKET_ID)) pushAccount(accountMap, a.accountOwner, a.accountNumber, `${event.name}@${log.blockNumber}`);
          } else if (event.name === 'LogTransfer') {
            if (isMarket(a.market, POL_MARKET_ID)) {
              pushAccount(accountMap, a.accountOneOwner, a.accountOneNumber, `${event.name}:one@${log.blockNumber}`);
              pushAccount(accountMap, a.accountTwoOwner, a.accountTwoNumber, `${event.name}:two@${log.blockNumber}`);
            }
          } else if (event.name === 'LogTrade') {
            if (isMarket(a.inputMarket, POL_MARKET_ID) || isMarket(a.outputMarket, POL_MARKET_ID)) {
              pushAccount(accountMap, a.takerAccountOwner, a.takerAccountNumber, `${event.name}:taker@${log.blockNumber}`);
              pushAccount(accountMap, a.makerAccountOwner, a.makerAccountNumber, `${event.name}:maker@${log.blockNumber}`);
            }
          } else if (event.name === 'LogLiquidate') {
            if (isMarket(a.heldMarket, POL_MARKET_ID) || isMarket(a.owedMarket, POL_MARKET_ID)) {
              pushAccount(accountMap, a.solidAccountOwner, a.solidAccountNumber, `${event.name}:solid@${log.blockNumber}`);
              pushAccount(accountMap, a.liquidAccountOwner, a.liquidAccountNumber, `${event.name}:liquid@${log.blockNumber}`);
            }
          }
        }
      }
    }
  }

  return [...accountMap.values()];
}

async function main() {
  const map = readJson(MAP_FILE);
  const provider = await connectProvider();
  const latest = await provider.getBlockNumber();
  const receipt = await provider.getTransactionReceipt(POL_FACTORY_DEPLOY_TX);
  const fromBlock = process.env.FROM_BLOCK ? Number(process.env.FROM_BLOCK) : receipt.blockNumber;
  if (!Number.isSafeInteger(fromBlock) || fromBlock <= 0) throw new Error(`Invalid FROM_BLOCK ${process.env.FROM_BLOCK}`);

  const core = new ethers.Contract(map.addresses.DolomiteMargin, [
    'function getIsGlobalOperator(address operator) view returns (bool)',
    'function getAdjustedAccountValues(tuple(address owner,uint256 number) account) view returns (tuple(uint256 value),tuple(uint256 value))',
    'function getAccountValues(tuple(address owner,uint256 number) account) view returns (tuple(uint256 value),tuple(uint256 value))',
    'function getAccountBalances(tuple(address owner,uint256 number) account) view returns (uint256[] memory,address[] memory,tuple(bool sign,uint128 value)[] memory,tuple(bool sign,uint256 value)[] memory)',
    'function getMarginRatio() view returns (tuple(uint256 value))',
  ], provider);
  const liquidatorAssetRegistry = new ethers.Contract(map.registry.liquidatorAssetRegistry, [
    'function getLiquidatorsForAsset(uint256 marketId) view returns (address[])',
    'function isAssetWhitelistedForLiquidation(uint256 marketId,address liquidator) view returns (bool)',
  ], provider);
  const polLiquidator = new ethers.Contract(map.rewards.polLiquidator, [
    'function liquidatorProxy() view returns (address)',
  ], provider);
  const auth = new ethers.Contract(map.registry.genericTraderProxy, [
    'function isCallerAuthorized(address caller) view returns (bool)',
  ], provider);
  let vaults = [];
  let accounts = [];
  let accountStates = [];
  let accountScanSkipped = true;
  if (process.env.SCAN_POL_ACCOUNTS === 'true') {
    accountScanSkipped = false;
    const vaultFactory = new ethers.Contract(POL_FACTORY, [
      'event VaultCreated(address indexed account,address vault)',
    ], provider);

    const vaultLogs = await getLogsChunked(provider, {
      address: POL_FACTORY,
      topics: [vaultFactory.interface.getEventTopic('VaultCreated')],
    }, fromBlock, latest);
    vaults = vaultLogs.map((log) => {
      const event = vaultFactory.interface.parseLog(log);
      return { account: event.args.account, vault: event.args.vault, blockNumber: log.blockNumber };
    });
    accounts = await discoverPolAccounts(provider, map.addresses.DolomiteMargin, fromBlock, latest, vaults);

    for (const account of accounts) {
      const acct = { owner: account.owner, number: account.number };
      const [values, adjustedValues, balances] = await Promise.all([
        core.getAccountValues(acct).catch((err) => ({ error: sanitize(err.reason || err.message) })),
        core.getAdjustedAccountValues(acct).catch((err) => ({ error: sanitize(err.reason || err.message) })),
        core.getAccountBalances(acct).catch((err) => ({ error: sanitize(err.reason || err.message) })),
      ]);
      accountStates.push({
        ...account,
        values: bn(values),
        adjustedValues: bn(adjustedValues),
        balances: bn(balances),
      });
    }
  }

  const liquidators = {};
  for (const marketId of [IBGT_MARKET_ID, POL_MARKET_ID]) {
    liquidators[marketId] = {
      listed: bn(await liquidatorAssetRegistry.getLiquidatorsForAsset(marketId)),
      checks: {
        oldLiquidatorProxyV5: await liquidatorAssetRegistry.isAssetWhitelistedForLiquidation(marketId, map.addresses.LiquidatorProxyV5),
        liquidatorProxyV6: await liquidatorAssetRegistry.isAssetWhitelistedForLiquidation(marketId, map.rewards.polLiquidatorProxy),
        polLiquidatorProxy: await liquidatorAssetRegistry.isAssetWhitelistedForLiquidation(marketId, map.rewards.polLiquidator),
      },
    };
  }

  const randomCaller = '0x000000000000000000000000000000000000dEaD';
  const out = {
    generatedAt: new Date().toISOString(),
    chainId: CHAIN_ID,
    block: latest,
    fromBlock,
    polLiquidator: map.rewards.polLiquidator,
    liquidatorProxyV6FromPolLiquidator: await polLiquidator.liquidatorProxy(),
    liquidatorProxyV6FromMap: map.rewards.polLiquidatorProxy,
    liquidators,
    genericTrader: {
      proxy: map.registry.genericTraderProxy,
      router: map.addresses.GenericTraderRouter,
      routerIsAuthorizedCaller: await auth.isCallerAuthorized(map.addresses.GenericTraderRouter),
      randomCallerIsAuthorized: await auth.isCallerAuthorized(randomCaller),
      proxyIsGlobalOperator: await core.getIsGlobalOperator(map.registry.genericTraderProxy),
      routerIsGlobalOperator: await core.getIsGlobalOperator(map.addresses.GenericTraderRouter),
    },
    marginRatio: bn(await core.getMarginRatio()),
    accountScanSkipped,
    polVaultCreatedCount: vaults.length,
    polVaults: vaults,
    polAccountsTouchedCount: accounts.length,
    polAccounts: accountStates,
  };

  fs.writeFileSync(OUT_FILE, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`wrote ${path.relative(ROOT, OUT_FILE)} with accountScanSkipped=${accountScanSkipped}`);
}

main().catch((err) => {
  console.error(sanitize(err.stack || err.message));
  process.exit(1);
});
