#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { AbiCoder, Interface, getAddress, id, keccak256 } = require("ethers");

const WORKSPACE = path.join(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "folks-live.json");
const RPC_TIMEOUT_MS = 20_000;
const PROBE_FROM = "0x000000000000000000000000000000000000dEaD";

const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const ZERO32 = "0x" + "0".repeat(64);
const ABI = AbiCoder.defaultAbiCoder();

const CHAINS = {
  avalanche: { chainId: 43114, folksChainId: 100, rpcMatch: /avalanche|avax/i },
  ethereum: { chainId: 1, folksChainId: 101, rpcMatch: /ethereum|mainnet/i },
  base: { chainId: 8453, folksChainId: 102, rpcMatch: /base/i },
  bsc: { chainId: 56, folksChainId: 103, rpcMatch: /bsc|binance|bnb/i },
  arbitrum: { chainId: 42161, folksChainId: 104, rpcMatch: /arbitrum|arb/i },
  polygon: { chainId: 137, folksChainId: 106, rpcMatch: /polygon|matic/i },
  sei: { chainId: 1329, folksChainId: 107, rpcMatch: /sei/i },
  monad: { chainId: 143, folksChainId: 108, rpcMatch: /monad/i },
};

const PUBLIC_FALLBACKS = {
  avalanche: [
    ["https://", "api.avax.network/ext/bc/C/rpc"].join(""),
    ["https://", "avalanche-c-chain-rpc.publicnode.com"].join(""),
  ],
  ethereum: [["https://", "ethereum-rpc.publicnode.com"].join("")],
  base: [["https://", "base-rpc.publicnode.com"].join("")],
  bsc: [["https://", "bsc-dataseed.binance.org"].join("")],
  arbitrum: [["https://", "arb1.arbitrum.io/rpc"].join("")],
  polygon: [["https://", "polygon-rpc.com"].join("")],
  sei: [["https://", "evm-rpc.sei-apis.com"].join("")],
};

const CORE = {
  hub: "0xb39c03297E87032fF69f4D42A6698e4c4A934449",
  bridgeRouterHub: "0xFc828C500c90E63134B2B73537cC6cADfF4Ce695",
  hubAdapter: "0xCda75578328D0CB0e79dB7797289c44fa02a77ad",
  wormholeDataAdapter: "0xeB48a1eE43B91959A1686b70B7Cd482c65DE69c9",
  wormholeCctpAdapter: "0x5C60f12838b8E3EEB525F299cD7C454c989dd04e",
  ccipDataAdapter: "0xc7bc4A43384f84B8FC937Ab58173Edab23a4c3cD",
  ccipTokenAdapter: "0x5f2F4771B7dc7e2F7E9c1308B154E1e8957ecAB0",
  wormholeExecutorDataAdapter: "0x27389a07d02C3Cd8C3d069FCb2Ee6AaA160788A2",
  nodeManager: "0x802063A23E78D0f5D158feaAc605028Ee490b03b",
  oracleManager: "0x7218Bd1050D41A9ECfc517abdd294FB8116aEe81",
  spokeManager: "0x4Db12F554623E4B0b3F5bAcF1c8490D4493380A5",
  accountManager: "0x12Db9758c4D9902334C523b94e436258EB54156f",
  loanManager: "0xF4c542518320F09943C35Db6773b2f9FeB2F847e",
};

const SPOKE_CORES = {
  avalanche: {
    spokeCommon: "0xc03094C4690F3844EA17ef5272Bf6376e0CF2AC6",
    bridgeRouterSpoke: "0xF854AC65A40f1EabFD32E6D4C7d0E1c4B1753Cc5",
  },
  ethereum: {
    spokeCommon: "0xc7bc4A43384f84B8FC937Ab58173Edab23a4c3cD",
    bridgeRouterSpoke: "0xFc828C500c90E63134B2B73537cC6cADfF4Ce695",
  },
  base: {
    spokeCommon: "0xc7bc4A43384f84B8FC937Ab58173Edab23a4c3cD",
    bridgeRouterSpoke: "0xFc828C500c90E63134B2B73537cC6cADfF4Ce695",
  },
  bsc: {
    spokeCommon: "0xc7bc4A43384f84B8FC937Ab58173Edab23a4c3cD",
    bridgeRouterSpoke: "0xCda75578328D0CB0e79dB7797289c44fa02a77ad",
  },
  arbitrum: {
    spokeCommon: "0x57D77FD37670e22188d1c92D7cEc931bccf074A4",
    bridgeRouterSpoke: "0x4Db12F554623E4B0b3F5bAcF1c8490D4493380A5",
  },
  polygon: {
    spokeCommon: "0x5f2F4771B7dc7e2F7E9c1308B154E1e8957ecAB0",
    bridgeRouterSpoke: "0xF854AC65A40f1EabFD32E6D4C7d0E1c4B1753Cc5",
  },
  sei: {
    spokeCommon: "0xc7bc4A43384f84B8FC937Ab58173Edab23a4c3cD",
    bridgeRouterSpoke: "0xF854AC65A40f1EabFD32E6D4C7d0E1c4B1753Cc5",
  },
  monad: {
    spokeCommon: "0xc7bc4A43384f84B8FC937Ab58173Edab23a4c3cD",
    bridgeRouterSpoke: "0xF854AC65A40f1EabFD32E6D4C7d0E1c4B1753Cc5",
  },
};

const ADAPTER_IDS = {
  HUB: 1,
  WORMHOLE_DATA: 2,
  WORMHOLE_CCTP: 3,
  CCIP_DATA: 4,
  CCIP_TOKEN: 5,
  WORMHOLE_EXECUTOR_DATA: 6,
};

const LOAN_TYPES = {
  1: "DEPOSIT",
  2: "GENERAL",
  3: "AVAX_EFFICIENCY",
  4: "ETH_EFFICIENCY",
  5: "STABLECOIN_EFFICIENCY",
  6: "POL_EFFICIENCY",
  7: "BTC_EFFICIENCY",
  8: "SEI_EFFICIENCY",
  9: "LINK_EFFICIENCY",
  10: "MON_EFFICIENCY",
};

const NODE_TYPES = {
  0: "NONE",
  1: "CHAINLINK",
  2: "PYTH",
  3: "PRICE_DEVIATION_CIRCUIT_BREAKER",
  4: "PRICE_DEVIATION_SAME_ORACLE_CIRCUIT_BREAKER",
  5: "STALENESS_CIRCUIT_BREAKER",
  6: "CONSTANT",
  7: "REDUCER",
  8: "EXTERNAL",
};

const REDUCERS = {
  0: "RECENT",
  1: "MIN",
  2: "MAX",
  3: "MEAN",
  4: "MEDIAN",
};

const POOLS = [
  [1, "USDC", "0x88f15e36308ED060d8543DA8E2a5dA0810Efded2"],
  [2, "AVAX", "0x0259617bE41aDA4D97deD60dAf848Caa6db3F228"],
  [3, "sAVAX", "0x7033105d1a527d342bE618ab1F222BB310C8d70b"],
  [4, "ETH_eth", "0xB6DF8914C084242A19A4C7fb15368be244Da3c75"],
  [5, "ETH_base", "0x51958ed7B96F57142CE63BB223bbd9ce23DA7125"],
  [6, "wETH_ava", "0x795CcF6f7601edb41E4b3123c778C56F0F19389A"],
  [7, "wBTC_eth", "0x9936812835476504D6Cf495F4F0C718Ec19B3Aff"],
  [8, "BTCb_ava", "0x1C51AA1516e1156d98075F2F64e259906051ABa9"],
  [9, "cbBTC_base", "0x9eD81F0b5b0E9b6dE00F374fFc7f270902576EF7"],
  [10, "BNB", "0x89970d3662614a5A4C9857Fcc9D9C3FA03824fe3"],
  [11, "ETHB_bsc", "0x18031B374a571F9e060de41De58Abb5957cD5258"],
  [12, "BTCB_bsc", "0xC2FD40D9Ec4Ae7e71068652209EB75258809e131"],
  [13, "ETH_arb", "0x44E0d0809AF8Ee37BFb1A4e75D5EF5B96F6346A3"],
  [14, "ARB", "0x1177A3c2CccDb9c50D52Fc2D30a13b2c3C40BCF4"],
  [15, "SolvBTC", "0x307bCEC89624660Ed06C97033EDb7eF49Ab0EB2D"],
  [16, "JOE", "0x5e5a2007a8D613C4C98F425097166095C875e6eE"],
  [17, "ggAVAX", "0xAdA5Be2A259096fd11D00c2b5c1181843eD008DC"],
  [18, "SHIB", "0x9f59642C6733397dF5c2696D3Ac9ceb431b1b573"],
  [19, "POL", "0x481cF0c02BF17a33753CE32f1931ED9990fFB40E"],
  [20, "wBTC_pol", "0x7054254933279d93D97309745AfbFF9310cdb570"],
  [21, "wETH_pol", "0x88Ae56886233C706409c74c3D4EA9A9Ac1D65ab2"],
  [22, "aUSD_ava", "0xc7DdB440666c144c2F27a3a5156D636Bacfc769C"],
  [23, "savUSD", "0xE6B7713854620076B5716E2743262D315bf8609D"],
  [24, "wBTC_arb", "0x3445055F633fEF5A64F852aaCD6dA76143aCA109"],
  [25, "tBTC_arb", "0xdd9eFBf83572f5387381aD3A04b1318221d545A2"],
  [26, "wstETH_arb", "0x9f0c0aDEc9fd4ef946aCe1e2b4F32e49aE45C8F3"],
  [27, "weETH_arb", "0x78B4e5cda33C898b546dB7925162879E7bd2A9d1"],
  [28, "rsETH_arb", "0x60f2682Ab38e3C9a51b07fbd69f42Ad2Cfe731db"],
  [29, "wstETH_pol", "0xD77b920A9c05B3e768FEaE0bcB5839cd224328fE"],
  [30, "LINK_pol", "0x84C420D5e077cF0ed8a20c44d803C380172eD5D5"],
  [31, "MaticX", "0x59023eFDB22B9d8b2C7aeD842aC1fd2f6110e5B5"],
  [32, "ATH_eth", "0x391201cEC4F80e69C87Dee364d599c1FCAE3c363"],
  [33, "pyUSD_eth", "0x279b3E185F64e99141d4CE363657A5F3B5B32Fb9"],
  [34, "rlUSD_eth", "0x7178bF2a8A50153549e0d95A4C6Cb816448840F0"],
  [35, "wstETH_eth", "0xe7897052FAC4bfF9EB3ABc073CBC1e17Fce5709C"],
  [36, "weETH_eth", "0x4E6dD5E35638008cdB1E9004F3E952bCDd920E6D"],
  [37, "AERO_base", "0xb5327c35E083248E3a0f79122FaB3b6018e5584a"],
  [38, "cbETH_base", "0x0b09E1Ffd28040654021A85A49284597F3d0e41C"],
  [39, "wstETH_base", "0xC96820695217c7dd8F696f8892de76F7a48432CB"],
  [40, "weETH_base", "0xf727EC8D6e565328f2cf0Ff8aC4e7c9e7f8d24B2"],
  [41, "VIRTUAL_base", "0x331a1938f94af7bB41d57691119Aee416495202a"],
  [42, "KAITO_base", "0x04C8B9d8AF87a6D670B646125B2D99740D8eBa5E"],
  [43, "aUSD_pol", "0x34f1BA5808EB5Bf60c9B1C343d86e410466F4860"],
  [44, "USDT_ava", "0xA1E1024c49c77297bA6367F624cFbEFC80E697c6"],
  [45, "USDT_eth", "0xf51a72b92cB9C16376Da04f48eF071c966B9C50B"],
  [46, "USDT_pol", "0x11f82b5Ea7408Ff257F6031E6A3e29203557A1DD"],
  [47, "USDT0_arb", "0x1b5a1dCe059E6069Ed33C3656826Ad04bE536465"],
  [48, "SEI", "0x63EFdA4bf91Ba13D678C58AF47304e6180dD46DF"],
  [49, "iSEI", "0x2B7995fd223dCf3A660Cc5a514349E3fa7B16168"],
  [50, "USDT0_sei", "0x213299AC40Ce76117C2c4B13945D9d935686BB85"],
  [51, "wETH_sei", "0x9A102080970043B96773c15E6520d182565C68Ff"],
  [52, "wBTC_sei", "0x7Cd4afD7F4DB51A0bF06Bf4630752A5B28e0B6C1"],
  [53, "YBTCB", "0x13A21bC65844CD530098Ab15431c57078ea90737"],
  [54, "SYRUP_eth", "0xD4F87eb6cc8795e727F7DbC1e2C6c3452ad0010c"],
  [55, "USDe_ava", "0x5431e7f480C4985e9C3FaAcd3Bd1fc7143eAdEFa"],
  [56, "sUSDe_ava", "0x94307E63eF02Cf9B39894553f14b21378Ef20adB"],
  [57, "EURC_ava", "0x3F87F3B301f031ba59C479EDF067621DcC72DDca"],
  [58, "tETH", "0x5FE123B659FC5242f46884C37550F05Ef08C816a"],
  [59, "tAVAX", "0x3F63A6401e6354a486e6a38127409fD16e222B59"],
  [60, "wstLINK", "0x42Bb92684e72707030F59C48FBe5A222A0d8b387"],
  [61, "MON", "0x10a4481F79aAC209aC6c2959B785F2e303912Dc5"],
  [62, "wBTC_mon", "0xdc887aCFe154BF0048Ae15Cda3693Ab2C237431A"],
  [63, "wETH_mon", "0xD7Ff49751DAF42Bf7AFC4fF5C958d4bea48358D3"],
  [64, "sMON", "0x5562d84f9891288fc72aaB1d857797c7275Fcedb"],
  [66, "aUSD_mon", "0x4fb4c3A33cBe855C5d87078c1BbBe5f371417faC"],
  [67, "USDT0_mon", "0xd9D50D4F73f61A306b47e5BdC825E98cd11139dc"],
  [68, "gMON", "0x0b4e69C4890a88acA90E7e71dB76619C3AaCD79D"],
  [69, "shMON", "0x398715A6011391B2B7fD1fF66BB26c126E5d4aAC"],
].map(([id, symbol, address]) => ({ id, symbol, address: getAddress(address) }));

const ERC20_IFACE = new Interface([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256)",
  "function transfer(address,uint256)",
]);

const ACCESS_IFACE = new Interface([
  "function owner() view returns (address)",
  "function defaultAdmin() view returns (address)",
  "function hasRole(bytes32,address) view returns (bool)",
]);

const HUB_IFACE = new Interface([
  "function getBridgeRouter() view returns (address)",
  "function spokeManager() view returns (address)",
  "function accountManager() view returns (address)",
  "function loanManager() view returns (address)",
  "function hubChainId() view returns (uint16)",
  "function directOperation(uint8,bytes32,bytes)",
  "function claimTokenFees(uint8,uint16,uint16,uint256)",
]);

const LOAN_MANAGER_IFACE = new Interface([
  "function getPool(uint8) view returns (address)",
  "function getOracleManager() view returns (address)",
  "function isLoanTypeCreated(uint16) view returns (bool)",
  "function isLoanTypeDeprecated(uint16) view returns (bool)",
  "function getLoanTypeLoanTargetHealth(uint16) view returns (uint256)",
  "function getLoanPool(uint16,uint8) view returns (tuple(uint256 collateralUsed,uint256 borrowUsed,uint64 collateralCap,uint64 borrowCap,uint16 collateralFactor,uint16 borrowFactor,uint16 liquidationBonus,uint16 liquidationFee,bool isAdded,bool isDeprecated,tuple(uint64 lastUpdateTimestamp,uint256 minimumAmount,uint256 collateralSpeed,uint256 borrowSpeed,uint256 collateralRewardIndex,uint256 borrowRewardIndex) reward))",
  "function updateOracleManager(address)",
  "function createLoanType(uint16,uint32)",
  "function addPool(address)",
  "function updateLoanPoolCaps(uint16,uint8,uint64,uint64)",
  "function rebalanceUp(bytes32,uint8)",
]);

const POOL_IFACE = new Interface([
  "function getPoolId() view returns (uint8)",
  "function token() view returns (address)",
  "function getChainSpoke(uint16) view returns (bytes32)",
  "function getLastUpdateTimestamp() view returns (uint256)",
  "function getFeeData() view returns (tuple(uint32 flashLoanFee,uint32 retentionRate,address fTokenFeeRecipient,address tokenFeeClaimer,uint256 totalRetainedAmount,bytes32 tokenFeeRecipient))",
  "function getDepositData() view returns (tuple(uint16 optimalUtilisationRatio,uint256 totalAmount,uint256 interestRate,uint256 interestIndex))",
  "function getVariableBorrowData() view returns (tuple(uint32 vr0,uint32 vr1,uint32 vr2,uint256 totalAmount,uint256 interestRate,uint256 interestIndex))",
  "function getStableBorrowData() view returns (tuple(uint32 sr0,uint32 sr1,uint32 sr2,uint32 sr3,uint16 optimalStableToTotalDebtRatio,uint16 rebalanceUpUtilisationRatio,uint16 rebalanceUpDepositInterestRate,uint16 rebalanceDownDelta,uint256 totalAmount,uint256 interestRate,uint256 averageInterestRate))",
  "function getCapsData() view returns (tuple(uint64 deposit,uint64 borrow,uint64 stableBorrowPercentage))",
  "function getConfigData() view returns (tuple(bool deprecated,bool stableBorrowSupported,bool canMintFToken,bool flashLoanSupported))",
  "function getUpdatedDepositInterestIndex() view returns (uint256)",
  "function getUpdatedVariableBorrowInterestIndex() view returns (uint256)",
  "function getOracleManager() view returns (address)",
  "function updateCapsData(tuple(uint64 deposit,uint64 borrow,uint64 stableBorrowPercentage))",
  "function updateConfigData(tuple(bool deprecated,bool stableBorrowSupported,bool canMintFToken,bool flashLoanSupported))",
  "function mintFToken(address,uint256)",
]);

const ORACLE_IFACE = new Interface([
  "function getNodeManager() view returns (address)",
  "function poolIdToNode(uint8) view returns (bytes32 nodeId,uint8 decimals)",
  "function processPriceFeed(uint8) view returns (tuple(uint256 price,uint8 decimals))",
  "function setNodeManager(address)",
  "function setNodeId(uint8,bytes32,uint8)",
]);

const NODE_IFACE = new Interface([
  "function registerNode(uint8,bytes,bytes32[]) returns (bytes32)",
  "function isNodeRegistered(bytes32) view returns (bool)",
  "function process(bytes32) view returns (tuple(uint256 price,uint256 timestamp,uint8 nodeType,uint256 additionalParam1,uint256 additionalParam2))",
  "function getNode(bytes32) pure returns (tuple(uint8 nodeType,bytes parameters,bytes32[] parents))",
]);

const BRIDGE_ROUTER_IFACE = new Interface([
  "function getAdapter(uint16) view returns (address)",
  "function idToAdapter(uint16) view returns (address)",
  "function adapterToId(address) view returns (uint16)",
  "function isAdapterInitialized(uint16) view returns (bool)",
  "function addAdapter(uint16,address)",
  "function removeAdapter(uint16)",
  "function receiveMessage(tuple(bytes32 messageId,uint16 sourceChainId,bytes32 sourceAddress,bytes32 handler,bytes payload,uint16 returnAdapterId,uint256 returnGasLimit)) payable",
]);

const SPOKE_MANAGER_IFACE = new Interface([
  "function isSpoke(uint16,bytes32) view returns (bool)",
  "function activateSpoke(uint16,bytes32)",
]);

const SPOKE_IFACE = new Interface([
  "function getBridgeRouter() view returns (address)",
  "function getHubChainId() view returns (uint16)",
  "function getHubContractAddress() view returns (bytes32)",
  "function getAddressOracle() view returns (address)",
]);

const WORMHOLE_ADAPTER_IFACE = new Interface([
  "function isChainAvailable(uint16) view returns (bool)",
  "function getChainAdapter(uint16) view returns (uint16 wormholeChainId,bytes32 adapterAddress)",
  "function bridgeRouter() view returns (address)",
  "function refundAddress() view returns (address)",
]);

const CCIP_ADAPTER_IFACE = new Interface([
  "function isChainAvailable(uint16) view returns (bool)",
  "function getChainAdapter(uint16) view returns (uint64 ccipChainId,bytes32 adapterAddress)",
  "function bridgeRouter() view returns (address)",
  "function ccipRouter() view returns (address)",
]);

const HUB_ADAPTER_IFACE = new Interface([
  "function bridgeRouterSpoke() view returns (address)",
  "function bridgeRouterHub() view returns (address)",
  "function hubChainId() view returns (uint16)",
  "function sequence() view returns (uint256)",
]);

const CHAINLINK_IFACE = new Interface([
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
]);

function sanitize(text) {
  return String(text || "").replace(/https?:\/\/\S+/g, "[redacted-url]");
}

function extractRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function rpcCallSingle(url, method, params, timeoutMs = RPC_TIMEOUT_MS) {
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

async function rpcCall(urlOrPool, method, params, timeoutMs = RPC_TIMEOUT_MS) {
  const urls = Array.isArray(urlOrPool) ? urlOrPool : [urlOrPool];
  let lastErr;
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    try {
      const result = await rpcCallSingle(url, method, params, timeoutMs);
      if (Array.isArray(urlOrPool) && i > 0) {
        urls.splice(i, 1);
        urls.unshift(url);
      }
      return result;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("No RPC candidate available");
}

async function resolveRpc(chainName) {
  const cfg = CHAINS[chainName];
  const urls = [...extractRpcUrls(), ...(PUBLIC_FALLBACKS[chainName] || [])];
  const preferred = urls.filter((url) => cfg.rpcMatch.test(url));
  const candidates = [...preferred, ...urls.filter((url) => !preferred.includes(url))];
  const seen = new Set();
  const healthy = [];
  for (const url of candidates) {
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      const got = Number(BigInt(await rpcCallSingle(url, "eth_chainId", [], 5000)));
      if (got !== cfg.chainId) continue;
      await rpcCallSingle(url, "eth_blockNumber", [], 5000);
      healthy.push(url);
    } catch (_) {
      // Never print RPC URLs.
    }
  }
  return healthy.length ? healthy : null;
}

async function getBlock(rpc) {
  const block = await rpcCall(rpc, "eth_getBlockByNumber", ["latest", false]);
  return {
    number: Number(BigInt(block.number)),
    timestamp: Number(BigInt(block.timestamp)),
  };
}

function normalizeAddress(value) {
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(String(value))) return null;
  try {
    return getAddress(value);
  } catch (_) {
    return String(value).toLowerCase();
  }
}

function storageAddress(word) {
  if (!word || word === "0x" || BigInt(word) === 0n) return null;
  return normalizeAddress("0x" + word.slice(-40));
}

function codeHash(code) {
  if (!code || code === "0x") return null;
  return keccak256(code);
}

function bytes32ToAddress(value) {
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(String(value))) return null;
  return normalizeAddress("0x" + String(value).slice(-40));
}

function addressToBytes32(address) {
  return "0x" + normalizeAddress(address).slice(2).padStart(64, "0");
}

function toNumber(value) {
  if (value === null || value === undefined) return null;
  return Number(BigInt(value));
}

function toSerializable(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(toSerializable);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (/^\d+$/.test(key)) continue;
      out[key] = toSerializable(val);
    }
    return out;
  }
  return value;
}

function formatUnits(raw, decimals, maxFrac = 8) {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  const value = BigInt(raw);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const frac = value % scale;
  const fracText = frac.toString().padStart(Number(decimals), "0").replace(/0+$/g, "").slice(0, maxFrac);
  return fracText ? `${whole}.${fracText}` : whole.toString();
}

async function ethCall(rpc, to, iface, fn, args = [], from = undefined) {
  const data = iface.encodeFunctionData(fn, args);
  const tx = { to, data };
  if (from) tx.from = from;
  const result = await rpcCall(rpc, "eth_call", [tx, "latest"]);
  return iface.decodeFunctionResult(fn, result);
}

async function safeCall(rpc, to, iface, fn, args = [], from = undefined) {
  try {
    return { ok: true, value: [...(await ethCall(rpc, to, iface, fn, args, from))] };
  } catch (err) {
    return { ok: false, error: sanitize(err.message || String(err)).slice(0, 220) };
  }
}

async function safeOne(rpc, to, iface, fn, args = []) {
  const res = await safeCall(rpc, to, iface, fn, args);
  return res.ok ? res.value[0] : null;
}

async function probe(rpc, to, iface, fn, args = []) {
  const res = await safeCall(rpc, to, iface, fn, args, PROBE_FROM);
  return { function: fn, success: res.ok, error: res.ok ? null : res.error };
}

async function proxyInfo(rpc, address) {
  const [code, implWord, adminWord] = await Promise.all([
    rpcCall(rpc, "eth_getCode", [address, "latest"]).catch(() => "0x"),
    rpcCall(rpc, "eth_getStorageAt", [address, IMPL_SLOT, "latest"]).catch(() => null),
    rpcCall(rpc, "eth_getStorageAt", [address, ADMIN_SLOT, "latest"]).catch(() => null),
  ]);
  const implementation = storageAddress(implWord);
  const admin = storageAddress(adminWord);
  const implCode = implementation ? await rpcCall(rpc, "eth_getCode", [implementation, "latest"]).catch(() => "0x") : "0x";
  return {
    exists: code && code !== "0x",
    codeHash: codeHash(code),
    implementation,
    implementationCodeHash: codeHash(implCode),
    admin,
  };
}

function decodeParams(nodeType, parameters) {
  try {
    if (nodeType === 1) {
      const [aggregator, twapTimeInterval] = ABI.decode(["address", "uint256"], parameters);
      return { aggregator: normalizeAddress(aggregator), twapTimeInterval: twapTimeInterval.toString() };
    }
    if (nodeType === 2) {
      const [pyth, priceFeedId, useEma] = ABI.decode(["address", "bytes32", "bool"], parameters);
      return { pyth: normalizeAddress(pyth), priceFeedId, useEma };
    }
    if (nodeType === 3 || nodeType === 4) {
      const [deviationTolerance] = ABI.decode(["uint256"], parameters);
      return { deviationTolerance: deviationTolerance.toString(), deviationToleranceBps: Number(deviationTolerance / 10n ** 14n) };
    }
    if (nodeType === 5) {
      const [stalenessTolerance] = ABI.decode(["uint256"], parameters);
      return { stalenessToleranceSeconds: Number(stalenessTolerance) };
    }
    if (nodeType === 6) {
      const [constantPrice] = ABI.decode(["uint256"], parameters);
      return { constantPrice: constantPrice.toString() };
    }
    if (nodeType === 7) {
      const [operation] = ABI.decode(["uint256"], parameters);
      return { operation: Number(operation), operationName: REDUCERS[Number(operation)] || "UNKNOWN" };
    }
    if (nodeType === 8) {
      const [externalNode] = ABI.decode(["address"], parameters);
      return { externalNode: normalizeAddress(externalNode) };
    }
  } catch (err) {
    return { decodeError: sanitize(err.message || String(err)).slice(0, 120) };
  }
  return {};
}

async function inspectNode(rpc, nodeManager, nodeId, blockTimestamp, seen = new Set(), depth = 0) {
  if (!nodeId || nodeId === ZERO32 || seen.has(nodeId) || depth > 8) return null;
  seen.add(nodeId);
  const nodeRes = await safeCall(rpc, nodeManager, NODE_IFACE, "getNode", [nodeId]);
  if (!nodeRes.ok) return { nodeId, error: nodeRes.error };
  const node = nodeRes.value[0];
  const nodeType = Number(node.nodeType);
  const outputRes = await safeCall(rpc, nodeManager, NODE_IFACE, "process", [nodeId]);
  const output = outputRes.ok ? outputRes.value[0] : null;
  const decodedParams = decodeParams(nodeType, node.parameters);
  const parents = [];
  for (const parentId of node.parents || []) {
    const parent = await inspectNode(rpc, nodeManager, parentId, blockTimestamp, seen, depth + 1);
    if (parent) parents.push(parent);
  }
  const baseSources = [];
  if (nodeType === 1 && decodedParams.aggregator) baseSources.push({ type: "CHAINLINK", address: decodedParams.aggregator });
  if (nodeType === 2 && decodedParams.pyth) baseSources.push({ type: "PYTH", address: decodedParams.pyth, priceFeedId: decodedParams.priceFeedId });
  if (nodeType === 8 && decodedParams.externalNode) baseSources.push({ type: "EXTERNAL", address: decodedParams.externalNode });
  for (const parent of parents) baseSources.push(...(parent.baseSources || []));
  const hasStalenessBreaker = nodeType === 5 || parents.some((p) => p.hasStalenessBreaker);
  const rootOutput = output
    ? {
        price: output.price.toString(),
        timestamp: output.timestamp.toString(),
        ageSeconds: blockTimestamp && output.timestamp > 0n ? Math.max(0, blockTimestamp - Number(output.timestamp)) : null,
        nodeType: Number(output.nodeType),
        nodeTypeName: NODE_TYPES[Number(output.nodeType)] || "UNKNOWN",
      }
    : { error: outputRes.error };
  return {
    nodeId,
    nodeType,
    nodeTypeName: NODE_TYPES[nodeType] || "UNKNOWN",
    parameters: decodedParams,
    output: rootOutput,
    hasStalenessBreaker,
    stalenessBreakerParentCount: nodeType === 5 ? parents.length : 0,
    baseSources,
    parents,
  };
}

function flattenNodes(node, out = []) {
  if (!node) return out;
  out.push(node);
  for (const parent of node.parents || []) flattenNodes(parent, out);
  return out;
}

async function inspectChainlink(rpc, aggregator, blockTimestamp) {
  if (!aggregator) return null;
  const [decimals, description, latest] = await Promise.all([
    safeOne(rpc, aggregator, CHAINLINK_IFACE, "decimals", []),
    safeOne(rpc, aggregator, CHAINLINK_IFACE, "description", []),
    safeCall(rpc, aggregator, CHAINLINK_IFACE, "latestRoundData", []),
  ]);
  if (!latest.ok) return { aggregator, ok: false, error: latest.error };
  const row = latest.value;
  const updatedAt = Number(row[3]);
  return {
    aggregator,
    ok: true,
    description,
    decimals: decimals === null ? null : Number(decimals),
    answer: row[1].toString(),
    updatedAt,
    ageSeconds: updatedAt ? Math.max(0, blockTimestamp - updatedAt) : null,
    answeredInRoundBehind: row[4] < row[0],
  };
}

async function scanCore(rpc) {
  const entries = Object.entries(CORE);
  const out = {};
  for (const [name, address] of entries) {
    out[name] = { address: getAddress(address), ...(await proxyInfo(rpc, getAddress(address))) };
  }
  const hub = out.hub.address;
  const [bridgeRouter, spokeManager, accountManager, loanManager, hubChainId] = await Promise.all([
    safeOne(rpc, hub, HUB_IFACE, "getBridgeRouter", []),
    safeOne(rpc, hub, HUB_IFACE, "spokeManager", []),
    safeOne(rpc, hub, HUB_IFACE, "accountManager", []),
    safeOne(rpc, hub, HUB_IFACE, "loanManager", []),
    safeOne(rpc, hub, HUB_IFACE, "hubChainId", []),
  ]);
  out.hub.runtimeConfig = {
    bridgeRouter: normalizeAddress(bridgeRouter),
    spokeManager: normalizeAddress(spokeManager),
    accountManager: normalizeAddress(accountManager),
    loanManager: normalizeAddress(loanManager),
    hubChainId: hubChainId === null ? null : Number(hubChainId),
    matchesDocs:
      normalizeAddress(bridgeRouter) === normalizeAddress(CORE.bridgeRouterHub) &&
      normalizeAddress(spokeManager) === normalizeAddress(CORE.spokeManager) &&
      normalizeAddress(accountManager) === normalizeAddress(CORE.accountManager) &&
      normalizeAddress(loanManager) === normalizeAddress(CORE.loanManager),
  };
  return out;
}

async function scanBridgeRouter(rpc, address, name) {
  const adapters = {};
  for (const [adapterName, adapterId] of Object.entries(ADAPTER_IDS)) {
    const adapter = await safeOne(rpc, address, BRIDGE_ROUTER_IFACE, "getAdapter", [adapterId]);
    adapters[adapterName] = adapter ? normalizeAddress(adapter) : null;
  }
  return {
    name,
    address: normalizeAddress(address),
    proxy: await proxyInfo(rpc, address),
    adapters,
    probes: [
      await probe(rpc, address, BRIDGE_ROUTER_IFACE, "addAdapter", [9999, PROBE_FROM]),
      await probe(rpc, address, BRIDGE_ROUTER_IFACE, "removeAdapter", [1]),
    ],
  };
}

async function scanAdapters(rpc, blockTimestamp) {
  const adapterRows = {};
  const folksChainIds = Object.values(CHAINS).map((c) => c.folksChainId);
  for (const [name, address] of Object.entries({
    hubAdapter: CORE.hubAdapter,
    wormholeDataAdapter: CORE.wormholeDataAdapter,
    wormholeCctpAdapter: CORE.wormholeCctpAdapter,
    ccipDataAdapter: CORE.ccipDataAdapter,
    ccipTokenAdapter: CORE.ccipTokenAdapter,
    wormholeExecutorDataAdapter: CORE.wormholeExecutorDataAdapter,
  })) {
    const row = { address: getAddress(address), proxy: await proxyInfo(rpc, getAddress(address)), chains: {} };
    if (name === "hubAdapter") {
      row.bridgeRouterSpoke = normalizeAddress(await safeOne(rpc, row.address, HUB_ADAPTER_IFACE, "bridgeRouterSpoke", []));
      row.bridgeRouterHub = normalizeAddress(await safeOne(rpc, row.address, HUB_ADAPTER_IFACE, "bridgeRouterHub", []));
      row.hubChainId = toNumber(await safeOne(rpc, row.address, HUB_ADAPTER_IFACE, "hubChainId", []));
      row.sequence = toSerializable(await safeOne(rpc, row.address, HUB_ADAPTER_IFACE, "sequence", []));
    } else {
      const isCcip = name.startsWith("ccip");
      const iface = isCcip ? CCIP_ADAPTER_IFACE : WORMHOLE_ADAPTER_IFACE;
      row.bridgeRouter = normalizeAddress(await safeOne(rpc, row.address, iface, "bridgeRouter", []));
      row.router = normalizeAddress(await safeOne(rpc, row.address, iface, isCcip ? "ccipRouter" : "refundAddress", []));
      for (const folksChainId of folksChainIds) {
        const available = await safeOne(rpc, row.address, iface, "isChainAvailable", [folksChainId]);
        if (!available) continue;
        const adapter = await safeCall(rpc, row.address, iface, "getChainAdapter", [folksChainId]);
        row.chains[folksChainId] = adapter.ok
          ? { bridgeChainId: adapter.value[0].toString(), adapterAddress: adapter.value[1], adapterEvmAddress: bytes32ToAddress(adapter.value[1]) }
          : { error: adapter.error };
      }
    }
    adapterRows[name] = row;
  }
  return { generatedAtTimestamp: blockTimestamp, adapters: adapterRows };
}

async function scanPools(rpc, blockTimestamp) {
  const loanManager = getAddress(CORE.loanManager);
  const oracleManager = getAddress(CORE.oracleManager);
  const nodeManager = getAddress(CORE.nodeManager);
  const spokeManager = getAddress(CORE.spokeManager);
  const pools = [];
  const chainlinkSources = new Map();

  for (const meta of POOLS) {
    const actualPool = await safeOne(rpc, loanManager, LOAN_MANAGER_IFACE, "getPool", [meta.id]);
    const address = actualPool ? normalizeAddress(actualPool) : meta.address;
    const [poolId, name, symbol, decimals, totalSupply, lastUpdateTimestamp, feeData, depositData, variableBorrowData, stableBorrowData, capsData, configData, token, oracle, updatedDepositIndex, updatedVariableIndex, balance] = await Promise.all([
      safeOne(rpc, address, POOL_IFACE, "getPoolId", []),
      safeOne(rpc, address, ERC20_IFACE, "name", []),
      safeOne(rpc, address, ERC20_IFACE, "symbol", []),
      safeOne(rpc, address, ERC20_IFACE, "decimals", []),
      safeOne(rpc, address, ERC20_IFACE, "totalSupply", []),
      safeOne(rpc, address, POOL_IFACE, "getLastUpdateTimestamp", []),
      safeOne(rpc, address, POOL_IFACE, "getFeeData", []),
      safeOne(rpc, address, POOL_IFACE, "getDepositData", []),
      safeOne(rpc, address, POOL_IFACE, "getVariableBorrowData", []),
      safeOne(rpc, address, POOL_IFACE, "getStableBorrowData", []),
      safeOne(rpc, address, POOL_IFACE, "getCapsData", []),
      safeOne(rpc, address, POOL_IFACE, "getConfigData", []),
      safeOne(rpc, address, POOL_IFACE, "token", []),
      safeOne(rpc, address, POOL_IFACE, "getOracleManager", []),
      safeOne(rpc, address, POOL_IFACE, "getUpdatedDepositInterestIndex", []),
      safeOne(rpc, address, POOL_IFACE, "getUpdatedVariableBorrowInterestIndex", []),
      rpcCall(rpc, "eth_getBalance", [address, "latest"]).catch(() => null),
    ]);
    const tokenAddress = normalizeAddress(token);
    const underlyingBalance = tokenAddress ? await safeOne(rpc, tokenAddress, ERC20_IFACE, "balanceOf", [address]) : (balance ? BigInt(balance) : null);
    const nodeRow = await safeCall(rpc, oracleManager, ORACLE_IFACE, "poolIdToNode", [meta.id]);
    const priceFeedRow = await safeCall(rpc, oracleManager, ORACLE_IFACE, "processPriceFeed", [meta.id]);
    const nodeId = nodeRow.ok ? nodeRow.value[0] : null;
    const oracleDecimals = nodeRow.ok ? Number(nodeRow.value[1]) : null;
    const rootNode = nodeId ? await inspectNode(rpc, nodeManager, nodeId, blockTimestamp) : null;
    for (const source of rootNode?.baseSources || []) {
      if (source.type === "CHAINLINK" && source.address) chainlinkSources.set(source.address, source.address);
    }
    const trustedSpokes = {};
    for (const [chainName, chain] of Object.entries(CHAINS)) {
      const spoke = await safeOne(rpc, address, POOL_IFACE, "getChainSpoke", [chain.folksChainId]);
      if (!spoke) continue;
      const active = await safeOne(rpc, spokeManager, SPOKE_MANAGER_IFACE, "isSpoke", [chain.folksChainId, spoke]);
      trustedSpokes[chainName] = { folksChainId: chain.folksChainId, spoke, spokeEvmAddress: bytes32ToAddress(spoke), activeInSpokeManager: active === null ? null : Boolean(active) };
    }
    const poolProbeResults = meta.id <= 5
      ? [
          await probe(rpc, address, POOL_IFACE, "updateCapsData", [[1, 1, 0]]),
          await probe(rpc, address, POOL_IFACE, "updateConfigData", [[false, false, false, false]]),
          await probe(rpc, address, POOL_IFACE, "mintFToken", [PROBE_FROM, 1]),
        ]
      : [];
    const variableDebt = variableBorrowData ? variableBorrowData.totalAmount : 0n;
    const stableDebt = stableBorrowData ? stableBorrowData.totalAmount : 0n;
    const totalDebt = BigInt(variableDebt || 0n) + BigInt(stableDebt || 0n);
    const totalDeposit = depositData ? BigInt(depositData.totalAmount) : 0n;
    pools.push({
      id: meta.id,
      docsSymbol: meta.symbol,
      docsAddress: meta.address,
      actualAddress: address,
      docsMatch: normalizeAddress(actualPool) === meta.address,
      proxy: await proxyInfo(rpc, address),
      erc20: {
        name,
        symbol,
        decimals: decimals === null ? null : Number(decimals),
        totalSupply: totalSupply === null ? null : totalSupply.toString(),
        totalSupplyFormatted: decimals === null || totalSupply === null ? null : formatUnits(totalSupply, Number(decimals)),
      },
      underlying: {
        token: tokenAddress,
        nativeAssumed: !tokenAddress,
        balance: underlyingBalance === null ? null : underlyingBalance.toString(),
        balanceFormatted: decimals === null || underlyingBalance === null ? null : formatUnits(underlyingBalance, Number(decimals)),
      },
      poolState: {
        lastUpdateTimestamp: lastUpdateTimestamp === null ? null : lastUpdateTimestamp.toString(),
        lastUpdateAgeSeconds: lastUpdateTimestamp === null ? null : Math.max(0, blockTimestamp - Number(lastUpdateTimestamp)),
        feeData: toSerializable(feeData),
        depositData: toSerializable(depositData),
        variableBorrowData: toSerializable(variableBorrowData),
        stableBorrowData: toSerializable(stableBorrowData),
        capsData: toSerializable(capsData),
        configData: toSerializable(configData),
        updatedDepositInterestIndex: updatedDepositIndex === null ? null : updatedDepositIndex.toString(),
        updatedVariableBorrowInterestIndex: updatedVariableIndex === null ? null : updatedVariableIndex.toString(),
        totalDebt: totalDebt.toString(),
        availableLiquidity: totalDeposit >= totalDebt ? (totalDeposit - totalDebt).toString() : "0",
        utilizationBps: totalDeposit > 0n ? Number((totalDebt * 10000n) / totalDeposit) : 0,
      },
      oracle: {
        oracleManager: normalizeAddress(oracle),
        nodeId,
        configuredDecimals: oracleDecimals,
        priceFeed: priceFeedRow.ok ? toSerializable(priceFeedRow.value[0]) : { error: priceFeedRow.error },
        rootNode,
      },
      trustedSpokes,
      probes: poolProbeResults,
    });
  }

  const feeds = [];
  for (const aggregator of chainlinkSources.values()) feeds.push(await inspectChainlink(rpc, aggregator, blockTimestamp));
  return { pools, chainlinkFeeds: feeds };
}

async function scanLoanTypes(rpc) {
  const loanManager = getAddress(CORE.loanManager);
  const loanTypes = [];
  for (const [loanTypeIdText, name] of Object.entries(LOAN_TYPES)) {
    const loanTypeId = Number(loanTypeIdText);
    const created = await safeOne(rpc, loanManager, LOAN_MANAGER_IFACE, "isLoanTypeCreated", [loanTypeId]);
    if (!created) continue;
    const deprecated = await safeOne(rpc, loanManager, LOAN_MANAGER_IFACE, "isLoanTypeDeprecated", [loanTypeId]);
    const targetHealth = await safeOne(rpc, loanManager, LOAN_MANAGER_IFACE, "getLoanTypeLoanTargetHealth", [loanTypeId]);
    const pools = [];
    for (const meta of POOLS) {
      const loanPool = await safeOne(rpc, loanManager, LOAN_MANAGER_IFACE, "getLoanPool", [loanTypeId, meta.id]);
      if (!loanPool) continue;
      pools.push({
        poolId: meta.id,
        symbol: meta.symbol,
        collateralUsed: loanPool.collateralUsed.toString(),
        borrowUsed: loanPool.borrowUsed.toString(),
        collateralCap: loanPool.collateralCap.toString(),
        borrowCap: loanPool.borrowCap.toString(),
        collateralFactorBps: Number(loanPool.collateralFactor),
        borrowFactorBps: Number(loanPool.borrowFactor),
        liquidationBonusBps: Number(loanPool.liquidationBonus),
        liquidationFeeBps: Number(loanPool.liquidationFee),
        isAdded: Boolean(loanPool.isAdded),
        isDeprecated: Boolean(loanPool.isDeprecated),
      });
    }
    const unsafeLiquidationPairs = [];
    for (const col of pools) {
      if (!col.isAdded || col.isDeprecated || col.collateralFactorBps === 0) continue;
      for (const bor of pools) {
        if (!bor.isAdded || bor.isDeprecated || bor.borrowCap === "0") continue;
        const borrowAdjust = (Number(targetHealth) * bor.borrowFactorBps) / 10000;
        const collateralAdjust = (col.collateralFactorBps * (10000 + bor.liquidationBonusBps)) / 10000;
        if (borrowAdjust <= collateralAdjust) {
          unsafeLiquidationPairs.push({
            collateralPoolId: col.poolId,
            collateralSymbol: col.symbol,
            borrowPoolId: bor.poolId,
            borrowSymbol: bor.symbol,
            borrowAdjustBps: Math.floor(borrowAdjust),
            collateralAdjustBps: Math.floor(collateralAdjust),
          });
        }
      }
    }
    loanTypes.push({
      loanTypeId,
      name,
      created: Boolean(created),
      deprecated: Boolean(deprecated),
      targetHealthBps: Number(targetHealth),
      pools,
      unsafeLiquidationPairs,
    });
  }
  return loanTypes;
}

async function scanSpokeChain(chainName, rpc) {
  const cfg = CHAINS[chainName];
  const docs = SPOKE_CORES[chainName];
  const block = await getBlock(rpc);
  const contracts = {};
  for (const [name, address] of Object.entries(docs)) {
    contracts[name] = { address: getAddress(address), ...(await proxyInfo(rpc, getAddress(address))) };
  }
  const spokeCommon = contracts.spokeCommon.address;
  const [hubChainId, hubContractAddress, bridgeRouter, addressOracle] = await Promise.all([
    safeOne(rpc, spokeCommon, SPOKE_IFACE, "getHubChainId", []),
    safeOne(rpc, spokeCommon, SPOKE_IFACE, "getHubContractAddress", []),
    safeOne(rpc, spokeCommon, SPOKE_IFACE, "getBridgeRouter", []),
    safeOne(rpc, spokeCommon, SPOKE_IFACE, "getAddressOracle", []),
  ]);
  const router = await scanBridgeRouter(rpc, docs.bridgeRouterSpoke, `${chainName}-spoke`);
  return {
    chainName,
    chainId: cfg.chainId,
    folksChainId: cfg.folksChainId,
    block,
    contracts,
    spokeCommonRuntime: {
      hubChainId: hubChainId === null ? null : Number(hubChainId),
      hubContractAddress,
      hubEvmAddress: bytes32ToAddress(hubContractAddress),
      bridgeRouter: normalizeAddress(bridgeRouter),
      addressOracle: normalizeAddress(addressOracle),
      matchesDocs: Number(hubChainId || 0) === CHAINS.avalanche.folksChainId && bytes32ToAddress(hubContractAddress) === normalizeAddress(CORE.hub),
    },
    router,
  };
}

function summarize(result) {
  const pools = result.hub?.pools || [];
  const loanTypes = result.hub?.loanTypes || [];
  const oracleRows = pools.map((p) => p.oracle?.rootNode).filter(Boolean);
  const trustedSpokeRows = pools.flatMap((p) => Object.values(p.trustedSpokes || []));
  const poolProbes = pools.flatMap((p) => p.probes || []);
  const adminProbes = [...(result.hub?.probes || []), ...(result.hub?.bridgeRouter?.probes || []), ...poolProbes];
  const staleOracleRows = pools.filter((p) => (p.oracle?.rootNode?.output?.ageSeconds || 0) > 3600);
  const overToleranceOracleRows = pools.filter((p) => {
    const root = p.oracle?.rootNode;
    if (!root) return false;
    return flattenNodes(root).some((n) => {
      if (n.nodeType !== 5 || n.parameters?.stalenessToleranceSeconds === undefined) return false;
      const age = n.output?.ageSeconds;
      return age !== null && age !== undefined && age > Number(n.parameters.stalenessToleranceSeconds);
    });
  });
  const noStalenessRows = pools.filter((p) => p.oracle?.rootNode && !p.oracle.rootNode.hasStalenessBreaker);
  const fallbackStalenessRows = pools.filter((p) =>
    flattenNodes(p.oracle?.rootNode).some((n) => n.nodeType === 5 && n.stalenessBreakerParentCount === 2)
  );
  const activeLoanPoolRows = loanTypes.flatMap((lt) => lt.pools.filter((p) => p.isAdded && !p.isDeprecated).map((p) => ({ loanTypeId: lt.loanTypeId, poolId: p.poolId, borrowCap: p.borrowCap, collateralCap: p.collateralCap })));
  const unsafeLiquidationPairs = loanTypes.flatMap((lt) => lt.unsafeLiquidationPairs.map((p) => ({ loanTypeId: lt.loanTypeId, ...p })));
  result.summary = {
    scannedChains: Object.keys(result.chains || {}).filter((name) => result.chains[name].resolved),
    skippedChains: Object.keys(result.chains || {}).filter((name) => !result.chains[name].resolved),
    poolsConfiguredFromDocs: POOLS.length,
    poolsResolvedOnLoanManager: pools.filter((p) => p.docsMatch).length,
    activeLoanPoolRows: activeLoanPoolRows.length,
    loanTypesCreated: loanTypes.length,
    oracleRows: oracleRows.length,
    oracleRowsWithoutStalenessBreaker: noStalenessRows.length,
    oracleRowsWithUncheckedFallbackParent: fallbackStalenessRows.length,
    oracleRowsOlderThan1h: staleOracleRows.length,
    oracleRowsOverConfiguredStalenessTolerance: overToleranceOracleRows.length,
    oracleRowsOlderThan1hWithinTolerance: staleOracleRows.length - overToleranceOracleRows.length,
    chainlinkFeeds: result.hub?.chainlinkFeeds?.length || 0,
    trustedPoolSpokes: trustedSpokeRows.length,
    trustedPoolSpokesInactiveInSpokeManager: trustedSpokeRows.filter((r) => r.activeInSpokeManager === false).length,
    unsafeLiquidationPairs: unsafeLiquidationPairs.length,
    arbitraryAdminProbeSuccesses: adminProbes.filter((p) => p.success).length,
    verdict:
      adminProbes.some((p) => p.success) || trustedSpokeRows.some((r) => r.activeInSpokeManager === false)
        ? "FOLKS_REVIEW_REQUIRED"
        : "FOLKS_READ_ONLY_MAP_REFRESHED",
  };
  result.findings = [];
  if (adminProbes.some((p) => p.success)) result.findings.push("At least one arbitrary-sender admin probe succeeded; review required.");
  if (trustedSpokeRows.some((r) => r.activeInSpokeManager === false)) result.findings.push("At least one pool trusted spoke is not active in SpokeManager.");
  if (overToleranceOracleRows.length) result.findings.push(`${overToleranceOracleRows.length} pool oracle outputs exceed decoded staleness tolerance.`);
  if (noStalenessRows.length) result.findings.push(`${noStalenessRows.length} pool oracle roots do not include a staleness breaker in the decoded graph.`);
  if (unsafeLiquidationPairs.length) result.findings.push(`${unsafeLiquidationPairs.length} loan-type pool pairs have non-positive liquidation denominator margins and may block liquidations for those pair configs.`);
  if (!result.findings.length) result.findings.push("No arbitrary-admin, inactive-spoke, or decoded oracle registration failure was found in the read-only scan.");
  return result;
}

async function main() {
  const result = {
    generatedAt: new Date().toISOString(),
    sources: [
      "https://docs.xapp.folks.finance/developers/contracts.md",
      "https://github.com/Folks-Finance/xchain-js-sdk",
      "https://github.com/Folks-Finance/xchain-contracts",
    ],
    chains: {},
    hub: {},
  };

  const resolved = {};
  for (const chainName of Object.keys(CHAINS)) {
    const rpc = await resolveRpc(chainName);
    resolved[chainName] = rpc;
    result.chains[chainName] = { chainId: CHAINS[chainName].chainId, folksChainId: CHAINS[chainName].folksChainId, resolved: Boolean(rpc?.length) };
  }

  const avaxRpc = resolved.avalanche;
  if (!avaxRpc?.length) throw new Error("No Avalanche RPC endpoint found in inventory");
  const avaxBlock = await getBlock(avaxRpc);
  result.hub.chainName = "avalanche";
  result.hub.chainId = CHAINS.avalanche.chainId;
  result.hub.folksChainId = CHAINS.avalanche.folksChainId;
  result.hub.block = avaxBlock;
  result.hub.core = await scanCore(avaxRpc);
  result.hub.bridgeRouter = await scanBridgeRouter(avaxRpc, CORE.bridgeRouterHub, "hub");
  result.hub.adapters = await scanAdapters(avaxRpc, avaxBlock.timestamp);
  const poolScan = await scanPools(avaxRpc, avaxBlock.timestamp);
  result.hub.pools = poolScan.pools;
  result.hub.chainlinkFeeds = poolScan.chainlinkFeeds;
  result.hub.loanTypes = await scanLoanTypes(avaxRpc);
  result.hub.probes = [
    await probe(avaxRpc, CORE.hub, HUB_IFACE, "claimTokenFees", [1, CHAINS.avalanche.folksChainId, ADAPTER_IDS.HUB, 0]),
    await probe(avaxRpc, CORE.loanManager, LOAN_MANAGER_IFACE, "updateOracleManager", [PROBE_FROM]),
    await probe(avaxRpc, CORE.loanManager, LOAN_MANAGER_IFACE, "createLoanType", [9999, 10000]),
    await probe(avaxRpc, CORE.loanManager, LOAN_MANAGER_IFACE, "addPool", [PROBE_FROM]),
    await probe(avaxRpc, CORE.loanManager, LOAN_MANAGER_IFACE, "updateLoanPoolCaps", [2, 1, 1, 1]),
    await probe(avaxRpc, CORE.oracleManager, ORACLE_IFACE, "setNodeManager", [PROBE_FROM]),
    await probe(avaxRpc, CORE.oracleManager, ORACLE_IFACE, "setNodeId", [1, ZERO32, 18]),
    await probe(avaxRpc, CORE.spokeManager, SPOKE_MANAGER_IFACE, "activateSpoke", [9999, ZERO32]),
  ];

  result.spokes = {};
  for (const chainName of Object.keys(SPOKE_CORES)) {
    if (!resolved[chainName]?.length) continue;
    try {
      result.spokes[chainName] = await scanSpokeChain(chainName, resolved[chainName]);
    } catch (err) {
      result.spokes[chainName] = { error: sanitize(err.message || String(err)).slice(0, 240) };
    }
  }

  summarize(result);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(toSerializable(result), null, 2));
  console.log(`FOLKS_READ_ONLY_SCAN ${result.summary.verdict} pools=${result.summary.poolsResolvedOnLoanManager}/${result.summary.poolsConfiguredFromDocs} loanTypes=${result.summary.loanTypesCreated} staleOracles=${result.summary.oracleRowsOlderThan1h} adminProbeSuccesses=${result.summary.arbitraryAdminProbeSuccesses}`);
  console.log(`Wrote ${path.relative(WORKSPACE, OUT)}`);
}

main().catch((err) => {
  console.error(sanitize(err.stack || err.message || String(err)));
  process.exit(1);
});
