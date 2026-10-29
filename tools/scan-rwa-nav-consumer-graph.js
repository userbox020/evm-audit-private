#!/usr/bin/env node
// Read-only RWA/NAV receipt-token consumer graph scanner.
// RPC URLs are resolved from local inventory in memory only and never printed or stored.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = process.env.RWA_NAV_OUT
  ? path.resolve(WORKSPACE, process.env.RWA_NAV_OUT)
  : path.join(WORKSPACE, "reports", "raw", "fast", "rwa-nav-consumer-graph.json");
const EXTRA_PRODUCER_FILE = process.env.RWA_NAV_EXTRA_PRODUCER_FILE
  ? path.resolve(WORKSPACE, process.env.RWA_NAV_EXTRA_PRODUCER_FILE)
  : null;
const SILO_CORE_DEPLOYMENTS = path.join(WORKSPACE, "targets", "silo-contracts-v2", "silo-core", "deployments");
const COMPOUND_DEPLOYMENTS = path.join(WORKSPACE, "targets", "compound-comet", "deployments");

const TIMEOUT_MS = 15_000;
const RPC_BATCH_SIZE = 20;
const MAX_EULER_VAULTS = Number(process.env.RWA_NAV_MAX_EULER_VAULTS || "700");
const MAX_SILO_IDS = Number(process.env.RWA_NAV_MAX_SILO_IDS || "700");
const MORPHO_TOP_N = Number(process.env.RWA_NAV_MORPHO_TOP_N || "350");
const ROUTE_LIQUIDITY_USD = Number(process.env.RWA_NAV_ROUTE_LIQUIDITY_USD || "10000");
const NAV_DIVERGENCE_BPS = Number(process.env.RWA_NAV_DIVERGENCE_BPS || "100");
const PROTOCOL_FILTER = String(process.env.RWA_NAV_PROTOCOL_FILTER || "").trim().toLowerCase();
const SYMBOL_FILTER = String(process.env.RWA_NAV_SYMBOL_FILTER || "").trim().toLowerCase();
const CHAIN_ID_FILTER = new Set(String(process.env.RWA_NAV_CHAIN_IDS || "").split(",").map((x) => Number(x.trim())).filter((x) => Number.isFinite(x) && x > 0));
const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const CHAINS = {
  1: {
    name: "Ethereum",
    coinSlug: "ethereum",
    aavePool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
    eulerFactory: "0x29a56a1b8214D9Cf7c5561811750D5cBDb45CC8e",
    siloFolder: "mainnet",
    compoundFolder: "mainnet",
  },
  8453: {
    name: "Base",
    coinSlug: "base",
    aavePool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
    siloFolder: "base",
    compoundFolder: "base",
  },
  42161: {
    name: "Arbitrum",
    coinSlug: "arbitrum",
    aavePool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    siloFolder: "arbitrum_one",
  },
  43114: {
    name: "Avalanche",
    coinSlug: "avax",
    aavePool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  },
  137: {
    name: "Polygon",
    coinSlug: "polygon",
    aavePool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    compoundFolder: "polygon",
  },
  56: {
    name: "BNB Chain",
    coinSlug: "bsc",
    siloFolder: "bnb",
  },
  5000: {
    name: "Mantle",
    coinSlug: "mantle",
    compoundFolder: "mantle",
  },
  10: {
    name: "Optimism",
    coinSlug: "optimism",
    aavePool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    siloFolder: "optimism",
    compoundFolder: "optimism",
  },
  42220: {
    name: "Celo",
    coinSlug: "celo",
  },
  57073: {
    name: "Ink",
    coinSlug: "ink",
  },
};

const PRODUCER_SEEDS = [
  { source: "defillama-adapter:ondofinance", protocol: "Ondo", chainId: 1, symbol: "OUSG", name: "Ondo Short-Term US Government Treasuries", address: "0x1B19C19393e2d034D8Ff31ff34c81252FcBbee92", category: "rwa-nav-token", tags: ["treasury", "permissioned-redemption"] },
  { source: "defillama-adapter:ondofinance", protocol: "Ondo", chainId: 1, symbol: "USDY", name: "Ondo US Dollar Yield", address: "0x96F6eF951840721AdBF46Ac996b59E0235CB985C", category: "yield-bearing-stable", tags: ["treasury", "permissioned-redemption"] },
  { source: "defillama-adapter:ondofinance", protocol: "Ondo", chainId: 1, symbol: "USDYc", name: "Ondo USDYc", address: "0xe86845788d6e3e5c2393ade1a051ae617d974c09", category: "rwa-nav-token", tags: ["treasury", "permissioned-redemption"] },
  { source: "defillama-adapter:ondofinance", protocol: "Ondo", chainId: 137, symbol: "OUSG", name: "Ondo Short-Term US Government Treasuries", address: "0xbA11C5effA33c4D6F8f593CFA394241CfE925811", category: "rwa-nav-token", tags: ["treasury", "permissioned-redemption"] },
  { source: "defillama-adapter:ondofinance", protocol: "Ondo", chainId: 5000, symbol: "USDY", name: "Ondo US Dollar Yield", address: "0x5bE26527e817998A7206475496fDE1E68957c5A6", category: "yield-bearing-stable", tags: ["treasury", "permissioned-redemption"] },
  { source: "defillama-adapter:ondofinance", protocol: "Ondo", chainId: 42161, symbol: "USDY", name: "Ondo US Dollar Yield", address: "0x35e050d3C0eC2d29D269a8EcEa763a183bDF9A9D", category: "yield-bearing-stable", tags: ["treasury", "permissioned-redemption"] },

  { source: "defillama-adapter:superstate", protocol: "Superstate", chainId: 1, symbol: "USTB", name: "Superstate Short Duration US Government Securities Fund", address: "0x43415eb6ff9db7e26a15b704e7a3edce97d31c4e", category: "rwa-nav-token", tags: ["treasury", "permissioned-redemption"] },
  { source: "defillama-adapter:superstate-uscc", protocol: "Superstate", chainId: 1, symbol: "USCC", name: "Superstate Crypto Carry Fund", address: "0x14d60e7fdc0d71d8611742720e4c50e7a974020c", category: "rwa-nav-token", tags: ["carry", "permissioned-redemption"] },

  { source: "defillama-adapter:hashnote", protocol: "Circle USYC", chainId: 1, symbol: "USYC", name: "Circle USYC", address: "0x136471a34f6ef19fE571EFFC1CA711fdb8E49f2b", category: "rwa-nav-token", tags: ["treasury", "permissioned-redemption", "transfer-restricted-possible"] },
  { source: "defillama-adapter:hashnote", protocol: "Circle USYC", chainId: 56, symbol: "USYC", name: "Circle USYC", address: "0x8D0fA28f221eB5735BC71d3a0Da67EE5bC821311", category: "rwa-nav-token", tags: ["treasury", "permissioned-redemption", "transfer-restricted-possible"] },

  { source: "defillama-adapter:tether-gold", protocol: "Tether Gold", chainId: 1, symbol: "XAUt", name: "Tether Gold", address: "0x68749665ff8d2d112fa859aa293f07a622782f38", category: "rwa-nav-token", tags: ["commodity", "gold", "permissioned-redemption", "transfer-restricted-possible"] },
  { source: "defillama-adapter:tether-gold", protocol: "Tether Gold", chainId: 43114, symbol: "XAUt", name: "Tether Gold", address: "0x2775d5105276781b4b85ba6ea6a6653beed1dd32", category: "rwa-nav-token", tags: ["commodity", "gold", "permissioned-redemption", "transfer-restricted-possible"] },
  { source: "defillama-adapter:tether-gold", protocol: "Tether Gold", chainId: 42161, symbol: "XAUt", name: "Tether Gold", address: "0x40461291347e1ecbb09499f3371d3f17f10d7159", category: "rwa-nav-token", tags: ["commodity", "gold", "permissioned-redemption", "transfer-restricted-possible"] },
  { source: "defillama-adapter:tether-gold", protocol: "Tether Gold", chainId: 42220, symbol: "XAUt", name: "Tether Gold", address: "0xaf37e8b6c9ed7f6318979f56fc287d76c30847ff", category: "rwa-nav-token", tags: ["commodity", "gold", "permissioned-redemption", "transfer-restricted-possible"] },
  { source: "defillama-adapter:tether-gold", protocol: "Tether Gold", chainId: 57073, symbol: "XAUt", name: "Tether Gold", address: "0xf50258d3c1dd88946c567920b986a12e65b50dac", category: "rwa-nav-token", tags: ["commodity", "gold", "permissioned-redemption", "transfer-restricted-possible"] },
  { source: "local-artifact:lista-dex-phase0", protocol: "Tether Gold", chainId: 56, symbol: "XAUt", name: "Tether Gold", address: "0x21cAef8A43163Eea865baeE23b9C2E327696A3bf", category: "rwa-nav-token", tags: ["commodity", "gold", "adapter-out-of-scope", "permissioned-redemption", "transfer-restricted-possible"] },

  { source: "defillama-adapter:paxos-gold", protocol: "Paxos Gold", chainId: 1, symbol: "PAXG", name: "Paxos Gold", address: "0x45804880De22913dAFE09f4980848ECE6EcbAf78", category: "rwa-nav-token", tags: ["commodity", "gold", "permissioned-redemption", "transfer-restricted-possible"] },

  { source: "defillama-adapter:re-protocol", protocol: "Re Protocol", chainId: 1, symbol: "reUSD-adapter", name: "Re Protocol reUSD contract", address: "0x4691C475bE804Fa85f91c2D6D0aDf03114de3093", category: "rwa-nav-token", tags: ["insurance", "rwa", "permissioned-redemption", "custody-backed"] },
  { source: "defillama-adapter:re-protocol", protocol: "Re Protocol", chainId: 1, symbol: "reUSDe-adapter", name: "Re Protocol reUSDe contract", address: "0xE1886BE2bA8B2496c2044a77516F63a734193082", category: "rwa-nav-token", tags: ["insurance", "rwa", "permissioned-redemption", "custody-backed"] },
  { source: "local-artifact:public-lead-consumer", protocol: "Re Protocol", chainId: 1, symbol: "reUSD", name: "Re Protocol Deposit Token", address: "0x5086bf358635B81D8C47C66d1C8b9E567Db70c72", category: "rwa-nav-token", tags: ["insurance", "rwa", "permissioned-redemption", "dex-liquid", "pendle-pt"] },
  { source: "local-artifact:public-lead-consumer", protocol: "Re Protocol", chainId: 1, symbol: "reUSDe", name: "Re Protocol reUSDe", address: "0xdDC0f880ff6e4e22E4B74632fBb43Ce4DF6cCC5a", category: "rwa-nav-token", tags: ["insurance", "rwa", "permissioned-redemption", "dex-liquid", "pendle-pt"] },
  { source: "defillama-adapter:re-protocol", protocol: "Re Protocol", chainId: 8453, symbol: "reUSD", name: "Re Protocol reUSD", address: "0x7D214438D0F27AfCcC23B3d1e1a53906aCE5CFEa", category: "rwa-nav-token", tags: ["insurance", "rwa", "permissioned-redemption", "custody-backed"] },
  { source: "defillama-adapter:re-protocol", protocol: "Re Protocol", chainId: 42161, symbol: "reUSD", name: "Re Protocol reUSD", address: "0x802eDbB1Ec20548A4388ABC337E4011718eb0291", category: "rwa-nav-token", tags: ["insurance", "rwa", "permissioned-redemption", "custody-backed"] },
  { source: "defillama-adapter:re-protocol", protocol: "Re Protocol", chainId: 43114, symbol: "reUSD-adapter", name: "Re Protocol reUSD contract", address: "0xb22a8533e6cd81598f82514a42F0B3161745fbe1", category: "rwa-nav-token", tags: ["insurance", "rwa", "permissioned-redemption", "custody-backed"] },
  { source: "local-artifact:silo-v2-phase0", protocol: "Re Protocol", chainId: 43114, symbol: "reUSD", name: "Re Protocol Deposit Token", address: "0x180aF87b47Bf272B2df59dccf2D76a6eaFa625Bf", category: "rwa-nav-token", tags: ["insurance", "rwa", "permissioned-redemption", "silo-v2-context"] },

  { source: "defillama-adapter:securitize", protocol: "BlackRock BUIDL", chainId: 1, symbol: "BUIDL", name: "BlackRock USD Institutional Digital Liquidity Fund", address: "0x7712c34205737192402172409a8F7ccef8aA2AEc", category: "rwa-nav-token", tags: ["treasury", "permissioned-redemption", "transfer-restricted-possible"] },
  { source: "defillama-adapter:securitize", protocol: "BlackRock BUIDL", chainId: 1, symbol: "BUIDL-I", name: "BlackRock BUIDL-I", address: "0x6a9DA2D710BB9B700acde7Cb81F10F1fF8C89041", category: "rwa-nav-token", tags: ["treasury", "permissioned-redemption", "transfer-restricted-possible"] },
  { source: "defillama-adapter:securitize", protocol: "BlackRock BUIDL", chainId: 137, symbol: "BUIDL", name: "BlackRock BUIDL", address: "0x2893ef551b6dD69F661Ac00F11D93E5Dc5dC0e99", category: "rwa-nav-token", tags: ["treasury", "permissioned-redemption", "transfer-restricted-possible"] },
  { source: "defillama-adapter:securitize", protocol: "BlackRock BUIDL", chainId: 43114, symbol: "BUIDL", name: "BlackRock BUIDL", address: "0x53FC82f14F009009b440a706e31c9021E1196A2F", category: "rwa-nav-token", tags: ["treasury", "permissioned-redemption", "transfer-restricted-possible"] },
  { source: "defillama-adapter:securitize", protocol: "BlackRock BUIDL", chainId: 10, symbol: "BUIDL", name: "BlackRock BUIDL", address: "0xa1cdab15bba75a80df4089cafba013e376957cf5", category: "rwa-nav-token", tags: ["treasury", "permissioned-redemption", "transfer-restricted-possible"] },
  { source: "defillama-adapter:securitize", protocol: "BlackRock BUIDL", chainId: 42161, symbol: "BUIDL", name: "BlackRock BUIDL", address: "0xa6525ae43edcd03dc08e775774dcabd3bb925872", category: "rwa-nav-token", tags: ["treasury", "permissioned-redemption", "transfer-restricted-possible"] },
  { source: "defillama-adapter:securitize", protocol: "BlackRock BUIDL", chainId: 56, symbol: "BUIDL", name: "BlackRock BUIDL", address: "0x2d5bdc96d9c8aabbdb38c9a27398513e7e5ef84f", category: "rwa-nav-token", tags: ["treasury", "permissioned-redemption", "transfer-restricted-possible"] },
  { source: "local-artifact:euler-v2-phase0", protocol: "BlackRock BUIDL", chainId: 1, symbol: "sBUIDL", name: "sBUIDL", address: "0x07a36C630e3F072637da3445Da733B29958D8cAB", category: "rwa-nav-token", tags: ["treasury", "wrapper", "adapter-out-of-scope", "permissioned-redemption", "transfer-restricted-possible"] },
  { source: "local-artifact:silo-v2-phase0", protocol: "BlackRock BUIDL", chainId: 43114, symbol: "sBUIDL", name: "sBUIDL", address: "0xaEb1FA0853c7C98EAb10fcF0EA669aE3d07FBB10", category: "rwa-nav-token", tags: ["treasury", "wrapper", "adapter-out-of-scope", "permissioned-redemption", "transfer-restricted-possible"] },

  { source: "defillama-adapter:matrixdock", protocol: "Matrixdock", chainId: 1, symbol: "STBT", name: "Matrixdock Short-term Treasury Bill", address: "0x530824DA86689C9C17CdC2871Ff29B058345b44a", category: "rwa-nav-token", tags: ["treasury", "permissioned-redemption"] },

  { source: "local-artifact:euler-v2-phase0", protocol: "Midas RWA", chainId: 1, symbol: "mTBILL", name: "Midas US Treasury Bill Token", address: "0xDD629E5241CbC5919847783e6C96B2De4754e438", category: "rwa-nav-token", tags: ["treasury", "permissioned-redemption", "euler-consumer"] },
  { source: "local-artifact:euler-v2-phase0", protocol: "Midas RWA", chainId: 1, symbol: "mBASIS", name: "Midas Basis Trading Token", address: "0x2a8c22E3b10036f3AEF5875d04f8441d4188b656", category: "yield-bearing-stable", tags: ["basis", "permissioned-redemption", "euler-consumer"] },
  { source: "local-artifact:euler-v2-phase0", protocol: "Midas RWA", chainId: 1, symbol: "mEDGE", name: "Midas mEDGE", address: "0xbB51E2a15A9158EBE2b0Ceb8678511e063AB7a55", category: "yield-bearing-stable", tags: ["permissioned-redemption", "euler-consumer", "pendle-pt"] },
  { source: "local-artifact:euler-v2-phase0", protocol: "Midas RWA", chainId: 1, symbol: "mMEV", name: "Midas MEV", address: "0x030b69280892c888670EDCDCD8B69Fd8026A0BF3", category: "yield-bearing-stable", tags: ["permissioned-redemption", "euler-consumer", "silo-consumer", "pendle-pt"] },
  { source: "local-artifact:euler-v2-phase0", protocol: "Midas RWA", chainId: 1, symbol: "mRe7YIELD", name: "Midas Re7 Yield", address: "0x87C9053C819bB28e0D73d33059E1b3DA80AFb0cf", category: "yield-bearing-stable", tags: ["permissioned-redemption", "euler-consumer"] },
  { source: "local-artifact:euler-v2-phase0", protocol: "Midas RWA", chainId: 1, symbol: "mHYPER", name: "Midas Hyperithm", address: "0x9b5528528656DBC094765E2abB79F293c21191B9", category: "yield-bearing-stable", tags: ["permissioned-redemption", "euler-consumer", "morpho-consumer", "pendle-pt"] },
  { source: "local-artifact:euler-v2-phase0", protocol: "Midas RWA", chainId: 1, symbol: "mFARM", name: "Midas Farm Capital", address: "0xA19f6e0dF08a7917F2F8A33Db66D0AF31fF5ECA6", category: "yield-bearing-stable", tags: ["permissioned-redemption", "euler-consumer", "pendle-pt"] },
  { source: "local-artifact:euler-v2-phase0", protocol: "Midas RWA", chainId: 1, symbol: "mAPOLLO", name: "Midas Apollo Crypto", address: "0x7CF9DEC92ca9FD46f8d86e7798B72624Bc116C05", category: "yield-bearing-stable", tags: ["permissioned-redemption", "euler-consumer", "silo-consumer", "morpho-consumer", "pendle-pt"] },
  { source: "local-artifact:euler-v2-phase0", protocol: "Midas RWA", chainId: 1, symbol: "mBTC", name: "Midas BTC Yield Token", address: "0x007115416AB6c266329a03B09a8aa39aC2eF7d9d", category: "yield-bearing-btc", tags: ["permissioned-redemption", "euler-consumer"] },
  { source: "local-artifact:pendle-pt-multichain-consumer-graph", protocol: "Midas RWA", chainId: 1, symbol: "mHyperBTC", name: "Midas Hyperithm BTC", address: "0xC8495EAFf71D3A563b906295fCF2f685b1783085", category: "yield-bearing-btc", tags: ["permissioned-redemption", "silo-consumer", "pendle-pt"] },
  { source: "local-artifact:pendle-pt-multichain-consumer-graph", protocol: "Midas RWA", chainId: 1, symbol: "mROX", name: "Midas mROX", address: "0x67E1F506B148d0Fc95a4E3fFb49068ceB6855c05", category: "yield-bearing-stable", tags: ["permissioned-redemption", "pendle-pt"] },

  { source: "defillama-adapter:openeden-tbill", protocol: "OpenEden", chainId: 1, symbol: "TBILL", name: "OpenEden TBILL", address: "0xdd50C053C096CB04A3e3362E2b622529EC5f2e8a", category: "rwa-nav-token", tags: ["treasury", "permissioned-redemption"] },
  { source: "defillama-adapter:openeden-tbill", protocol: "OpenEden", chainId: 42161, symbol: "TBILL", name: "OpenEden TBILL", address: "0xF84D28A8D28292842dD73D1c5F99476A80b6666A", category: "rwa-nav-token", tags: ["treasury", "permissioned-redemption"] },
  { source: "defillama-adapter:openeden-tbill", protocol: "OpenEden", chainId: 56, symbol: "TBILL", name: "OpenEden TBILL", address: "0x5b4681F0d7A01B817675F25892D3Ad73572FD1D9", category: "rwa-nav-token", tags: ["treasury", "permissioned-redemption"] },

  { source: "defillama-adapter:maple", protocol: "Maple", chainId: 1, symbol: "stSYRUP", name: "Maple stSYRUP", address: "0xc7E8b36E0766D9B04c93De68A9D47dD11f260B45", category: "yield-bearing-stable", tags: ["private-credit", "staking-share"] },

  { source: "defillama-adapter:spiko", protocol: "Spiko", chainId: 1, symbol: "USTBL", name: "Spiko US T-Bills Money Market Fund", address: "0xe4880249745eAc5F1eD9d8F7DF844792D560e750", category: "rwa-nav-token", tags: ["treasury", "permissioned-redemption", "transfer-restricted-possible"] },
  { source: "defillama-adapter:spiko", protocol: "Spiko", chainId: 1, symbol: "EUTBL", name: "Spiko EU T-Bills Money Market Fund", address: "0xa0769f7A8fC65e47dE93797b4e21C073c117Fc80", category: "rwa-nav-token", tags: ["treasury", "permissioned-redemption", "transfer-restricted-possible", "morpho-consumer", "silo-consumer"] },
  { source: "defillama-adapter:spiko", protocol: "Spiko", chainId: 1, symbol: "SPKCC", name: "Spiko Cash & Carry Fund", address: "0x4f33acf823e6eeb697180d553ce0c710124c8d59", category: "rwa-nav-token", tags: ["carry", "permissioned-redemption", "transfer-restricted-possible"] },
  { source: "defillama-adapter:spiko", protocol: "Spiko", chainId: 1, symbol: "eurSPKCC", name: "Spiko EUR Cash & Carry Fund", address: "0x3868D4e336d14D38031cf680329d31e4712e11cC", category: "rwa-nav-token", tags: ["carry", "permissioned-redemption", "transfer-restricted-possible"] },
  { source: "defillama-adapter:spiko", protocol: "Spiko", chainId: 1, symbol: "UKTBL", name: "Spiko UK T-Bills Money Market Fund", address: "0xf695Df6c0f3bB45918A7A82e83348FC59517734E", category: "rwa-nav-token", tags: ["treasury", "permissioned-redemption", "transfer-restricted-possible"] },
  { source: "defillama-adapter:spiko", protocol: "Spiko", chainId: 137, symbol: "USTBL", name: "Spiko US T-Bills Money Market Fund", address: "0xe4880249745eAc5F1eD9d8F7DF844792D560e750", category: "rwa-nav-token", tags: ["treasury", "permissioned-redemption", "transfer-restricted-possible"] },
  { source: "defillama-adapter:spiko", protocol: "Spiko", chainId: 137, symbol: "EUTBL", name: "Spiko EU T-Bills Money Market Fund", address: "0xa0769f7A8fC65e47dE93797b4e21C073c117Fc80", category: "rwa-nav-token", tags: ["treasury", "permissioned-redemption", "transfer-restricted-possible"] },
  { source: "defillama-adapter:spiko", protocol: "Spiko", chainId: 137, symbol: "SPKCC", name: "Spiko Cash & Carry Fund", address: "0x903d5990119bc799423e9c25c56518ba7dd19474", category: "rwa-nav-token", tags: ["carry", "permissioned-redemption", "transfer-restricted-possible"] },
  { source: "defillama-adapter:spiko", protocol: "Spiko", chainId: 137, symbol: "eurSPKCC", name: "Spiko EUR Cash & Carry Fund", address: "0x99F70A0e1786402a6796c6B0AA997ef340a5c6da", category: "rwa-nav-token", tags: ["carry", "permissioned-redemption", "transfer-restricted-possible"] },
  { source: "defillama-adapter:spiko", protocol: "Spiko", chainId: 137, symbol: "UKTBL", name: "Spiko UK T-Bills Money Market Fund", address: "0x970E2aDC2fdF53AEa6B5fa73ca6dc30eAFEDfe3D", category: "rwa-nav-token", tags: ["treasury", "permissioned-redemption", "transfer-restricted-possible"] },
  { source: "defillama-adapter:spiko", protocol: "Spiko", chainId: 42161, symbol: "USTBL", name: "Spiko US T-Bills Money Market Fund", address: "0x021289588cd81dC1AC87ea91e91607eEF68303F5", category: "rwa-nav-token", tags: ["treasury", "permissioned-redemption", "transfer-restricted-possible"] },
  { source: "defillama-adapter:spiko", protocol: "Spiko", chainId: 42161, symbol: "EUTBL", name: "Spiko EU T-Bills Money Market Fund", address: "0xcbeb19549054cc0a6257a77736fc78c367216ce7", category: "rwa-nav-token", tags: ["treasury", "permissioned-redemption", "transfer-restricted-possible"] },
  { source: "defillama-adapter:spiko", protocol: "Spiko", chainId: 42161, symbol: "SPKCC", name: "Spiko Cash & Carry Fund", address: "0x99f70a0e1786402a6796c6b0aa997ef340a5c6da", category: "rwa-nav-token", tags: ["carry", "permissioned-redemption", "transfer-restricted-possible"] },
  { source: "defillama-adapter:spiko", protocol: "Spiko", chainId: 42161, symbol: "eurSPKCC", name: "Spiko EUR Cash & Carry Fund", address: "0x0e389C83Bc1d16d86412476F6103027555C03265", category: "rwa-nav-token", tags: ["carry", "permissioned-redemption", "transfer-restricted-possible"] },
  { source: "defillama-adapter:spiko", protocol: "Spiko", chainId: 42161, symbol: "UKTBL", name: "Spiko UK T-Bills Money Market Fund", address: "0x903d5990119bC799423e9C25c56518Ba7DD19474", category: "rwa-nav-token", tags: ["treasury", "permissioned-redemption", "transfer-restricted-possible"] },
  { source: "defillama-adapter:spiko", protocol: "Spiko", chainId: 8453, symbol: "USTBL", name: "Spiko US T-Bills Money Market Fund", address: "0xe4880249745eAc5F1eD9d8F7DF844792D560e750", category: "rwa-nav-token", tags: ["treasury", "permissioned-redemption", "transfer-restricted-possible"] },
  { source: "defillama-adapter:spiko", protocol: "Spiko", chainId: 8453, symbol: "EUTBL", name: "Spiko EU T-Bills Money Market Fund", address: "0xa0769f7A8fC65e47dE93797b4e21C073c117Fc80", category: "rwa-nav-token", tags: ["treasury", "permissioned-redemption", "transfer-restricted-possible"] },
  { source: "defillama-adapter:spiko", protocol: "Spiko", chainId: 8453, symbol: "SPKCC", name: "Spiko Cash & Carry Fund", address: "0xf695df6c0f3bb45918a7a82e83348fc59517734e", category: "rwa-nav-token", tags: ["carry", "permissioned-redemption", "transfer-restricted-possible"] },
  { source: "defillama-adapter:spiko", protocol: "Spiko", chainId: 8453, symbol: "eurSPKCC", name: "Spiko EUR Cash & Carry Fund", address: "0x4f33aCf823E6eEb697180d553cE0c710124C8D59", category: "rwa-nav-token", tags: ["carry", "permissioned-redemption", "transfer-restricted-possible"] },
  { source: "defillama-adapter:spiko", protocol: "Spiko", chainId: 8453, symbol: "UKTBL", name: "Spiko UK T-Bills Money Market Fund", address: "0xA8De1f55Aa0E381cb456e1DcC9ff781eA0079068", category: "rwa-nav-token", tags: ["treasury", "permissioned-redemption", "transfer-restricted-possible"] },

  { source: "defillama-adapter:backed", protocol: "Backed", chainId: 1, symbol: "Backed", name: "Backed RWA token", address: "0x2F123cF3F37CE3328CC9B5b8415f9EC5109b45e7", category: "tokenized-security", tags: ["backed", "transfer-restricted-possible"] },
  { source: "defillama-adapter:backed", protocol: "Backed", chainId: 1, symbol: "Backed", name: "Backed RWA token", address: "0x2f11eeee0bf21e7661a22dbbbb9068f4ad191b86", category: "tokenized-security", tags: ["backed", "transfer-restricted-possible"] },
  { source: "defillama-adapter:backed", protocol: "Backed", chainId: 1, symbol: "Backed", name: "Backed RWA token", address: "0x0f76D32CDccDcbd602A55Af23EAF58FD1eE17245", category: "tokenized-security", tags: ["backed", "transfer-restricted-possible"] },
  { source: "defillama-adapter:backed", protocol: "Backed", chainId: 1, symbol: "Backed", name: "Backed RWA token", address: "0xbbcb0356bB9e6B3Faa5CbF9E5F36185d53403Ac9", category: "tokenized-security", tags: ["backed", "transfer-restricted-possible"] },
  { source: "defillama-adapter:backed", protocol: "Backed", chainId: 1, symbol: "Backed", name: "Backed RWA token", address: "0xCA30c93B02514f86d5C86a6e375E3A330B435Fb5", category: "tokenized-security", tags: ["backed", "transfer-restricted-possible"] },
  { source: "defillama-adapter:backed", protocol: "Backed", chainId: 1, symbol: "Backed", name: "Backed RWA token", address: "0x52d134c6DB5889FaD3542A09eAf7Aa90C0fdf9E4", category: "tokenized-security", tags: ["backed", "transfer-restricted-possible"] },
  { source: "defillama-adapter:backed", protocol: "Backed", chainId: 1, symbol: "Backed", name: "Backed RWA token", address: "0x1e2c4fb7ede391d116e6b41cd0608260e8801d59", category: "tokenized-security", tags: ["backed", "transfer-restricted-possible"] },
  { source: "defillama-adapter:backed", protocol: "Backed", chainId: 1, symbol: "Backed", name: "Backed RWA token", address: "0x20C64dEE8FdA5269A78f2D5BDBa861CA1d83DF7a", category: "tokenized-security", tags: ["backed", "transfer-restricted-possible"] },
  { source: "defillama-adapter:backed", protocol: "Backed", chainId: 1, symbol: "Backed", name: "Backed RWA token", address: "0x3f95AA88dDbB7D9D484aa3D482bf0a80009c52c9", category: "tokenized-security", tags: ["backed", "transfer-restricted-possible"] },
  { source: "defillama-adapter:backed", protocol: "Backed", chainId: 1, symbol: "Backed", name: "Backed RWA token", address: "0xAde6057FcAfa57d6d51FFa341C64ce4814995995", category: "tokenized-security", tags: ["backed", "transfer-restricted-possible"] },
  { source: "defillama-adapter:backed", protocol: "Backed", chainId: 1, symbol: "bNVDA", name: "Backed NVIDIA", address: "0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495", category: "tokenized-security", tags: ["backed", "equity", "transfer-restricted-possible"] },
  { source: "defillama-adapter:backed", protocol: "Backed", chainId: 8453, symbol: "Backed", name: "Backed Base extra RWA token", address: "0xC3cE78B037DDA1B966D31EC7979d3f3a38571A8E", category: "tokenized-security", tags: ["backed", "transfer-restricted-possible"] },
];

const MIDAS_NON_AUTHORITATIVE_HINTS = [
  "Midas API `vaults?scope=endorsed` did not expose explicit tokenAddress/vaultAddress/shareAssetAddress fields in this pass.",
  "Addresses found only in logoUrl values were not seeded as exact producers.",
];

const ERC20 = new ethers.Interface([
  "function asset() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function liquidityAssetAddr() view returns (address)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);
const AAVE_POOL = new ethers.Interface([
  "function ADDRESSES_PROVIDER() view returns (address)",
  "function getReservesList() view returns (address[])",
  "function getReserveData(address asset) view returns (tuple(uint256 data) configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,uint16 id,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt)",
]);
const AAVE_ADDRESSES_PROVIDER = new ethers.Interface(["function getPriceOracle() view returns (address)"]);
const AAVE_ORACLE = new ethers.Interface(["function getSourceOfAsset(address asset) view returns (address)"]);
const GENERIC_FACTORY = new ethers.Interface([
  "function getProxyListLength() view returns (uint256)",
  "function getProxyListSlice(uint256 start,uint256 end) view returns (address[])",
]);
const EVAULT = new ethers.Interface([
  "function asset() view returns (address)",
  "function cash() view returns (uint256)",
  "function LTVBorrow(address collateral) view returns (uint16)",
  "function LTVList() view returns (address[])",
  "function oracle() view returns (address)",
  "function symbol() view returns (string)",
  "function totalBorrows() view returns (uint256)",
]);
const SILO_FACTORY = new ethers.Interface([
  "function getNextSiloId() view returns (uint256)",
  "function idToSiloConfig(uint256 id) view returns (address)",
]);
const SILO_CONFIG = new ethers.Interface([
  "function getSilos() view returns (address,address)",
  "function getConfig(address silo) view returns ((uint256,uint256,address,address,address,address,address,address,address,address,uint256,uint256,uint256,uint256,uint256,address,bool))",
]);
const SILO = new ethers.Interface([
  "function getLiquidity() view returns (uint256)",
  "function getSiloStorage() view returns (uint192,uint64,uint256,uint256,uint256)",
]);
const BEACON = new ethers.Interface(["function implementation() view returns (address)"]);

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function strip0x(value) {
  return String(value || "").replace(/^0x/i, "");
}

function normalizeAddress(value) {
  try {
    return ethers.getAddress(value);
  } catch (_) {
    return null;
  }
}

function lowerAddress(value) {
  const address = normalizeAddress(value);
  return address ? address.toLowerCase() : null;
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function loadExtraProducerSeeds() {
  if (!EXTRA_PRODUCER_FILE) return [];
  const json = readJson(EXTRA_PRODUCER_FILE, null);
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.producers)) return json.producers;
  if (Array.isArray(json?.extraProducers)) return json.extraProducers;
  if (Array.isArray(json?.poolRows)) return json.poolRows;
  return [];
}

function loadRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function rpcCall(url, method, params = [], timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    return json.result ?? null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveRpcPool(chainIds) {
  const pool = {};
  for (const url of loadRpcUrls()) {
    try {
      const idHex = await rpcCall(url, "eth_chainId", [], 6000);
      const chainId = Number(BigInt(idHex));
      if (chainIds.includes(chainId) && !pool[chainId]) pool[chainId] = url;
      if (chainIds.every((id) => pool[id])) break;
    } catch (_) {
      // Never print or persist RPC URLs.
    }
  }
  return pool;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function safeProviderCall(provider, to, data) {
  try {
    if (!provider || !normalizeAddress(to)) return null;
    return await provider.call({ to, data });
  } catch (_) {
    return null;
  }
}

function decodeResult(raw, iface, fn) {
  if (!raw || raw === "0x") return null;
  try {
    return iface.decodeFunctionResult(fn, raw);
  } catch (_) {
    return null;
  }
}

function decodeUintResult(raw, fn) {
  if (!raw || raw === "0x") return null;
  try {
    return BigInt(ERC20.decodeFunctionResult(fn, raw)[0]);
  } catch (_) {
    try {
      return BigInt(raw);
    } catch (_) {
      return null;
    }
  }
}

function decodeStringResult(raw, fn) {
  if (!raw || raw === "0x") return null;
  try {
    return String(ERC20.decodeFunctionResult(fn, raw)[0]);
  } catch (_) {
    const hex = strip0x(raw);
    if (hex.length === 64) return Buffer.from(hex, "hex").toString("utf8").replace(/\u0000+$/g, "") || null;
    return null;
  }
}

function wordAt(raw, index) {
  const hex = strip0x(raw);
  const start = index * 64;
  if (!hex || hex.length < start + 64) return null;
  return `0x${hex.slice(start, start + 64)}`;
}

function addressFromStorageSlot(raw) {
  if (!raw || raw === "0x") return null;
  const hex = strip0x(raw).padStart(64, "0");
  if (/^0+$/.test(hex)) return null;
  return normalizeAddress(`0x${hex.slice(-40)}`);
}

function addressWordAt(raw, index) {
  const word = wordAt(raw, index);
  return word ? addressFromStorageSlot(word) : null;
}

function formatUnitsNumber(raw, decimals) {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  try {
    return Number(ethers.formatUnits(raw, Number(decimals)));
  } catch (_) {
    return null;
  }
}

function bpsDiff(reference, observed) {
  const ref = Number(reference || 0);
  const obs = Number(observed || 0);
  if (!Number.isFinite(ref) || !Number.isFinite(obs) || ref <= 0 || obs <= 0) return null;
  return ((obs / ref) - 1) * 10_000;
}

async function erc20Decimals(provider, token) {
  const raw = await safeProviderCall(provider, token, ERC20.encodeFunctionData("decimals", []));
  const decoded = decodeUintResult(raw, "decimals");
  return decoded === null ? 18 : Number(decoded);
}

async function erc20Balance(provider, token, account) {
  const raw = await safeProviderCall(provider, token, ERC20.encodeFunctionData("balanceOf", [account]));
  return decodeUintResult(raw, "balanceOf") || 0n;
}

async function safeGetStorage(provider, address, slot) {
  try {
    return await provider.getStorage(address, slot);
  } catch (_) {
    return null;
  }
}

async function getReferenceCodes(provider, address) {
  const target = normalizeAddress(address);
  if (!provider || !target) return [];
  const out = [];
  const targetCode = await provider.getCode(target).catch(() => "0x");
  if (targetCode && targetCode !== "0x") out.push({ kind: "target", address: target, code: targetCode });

  const impl = addressFromStorageSlot(await safeGetStorage(provider, target, EIP1967_IMPLEMENTATION_SLOT));
  if (impl) {
    const code = await provider.getCode(impl).catch(() => "0x");
    if (code && code !== "0x") out.push({ kind: "eip1967Implementation", address: impl, code });
  }

  const beacon = addressFromStorageSlot(await safeGetStorage(provider, target, EIP1967_BEACON_SLOT));
  if (beacon) {
    const implRaw = await safeProviderCall(provider, beacon, BEACON.encodeFunctionData("implementation", []));
    const beaconImpl = normalizeAddress(decodeResult(implRaw, BEACON, "implementation")?.[0]);
    if (beaconImpl) {
      const code = await provider.getCode(beaconImpl).catch(() => "0x");
      if (code && code !== "0x") out.push({ kind: "eip1967BeaconImplementation", beacon, address: beaconImpl, code });
    }
  }

  const seen = new Set();
  return out.filter((row) => {
    const key = `${row.kind}:${row.beacon || ""}:${row.address}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function codeReferencesProducers(code, producers) {
  const lowerCode = strip0x(code).toLowerCase();
  if (!lowerCode) return [];
  return producers.filter((producer) => lowerCode.includes(strip0x(producer.addressLower)));
}

async function findProducerReferencesInAddress(provider, address, producers) {
  const rows = [];
  for (const codeRef of await getReferenceCodes(provider, address)) {
    for (const producer of codeReferencesProducers(codeRef.code, producers)) {
      rows.push({
        producer,
        reference: {
          address: codeRef.address,
          kind: codeRef.kind,
          beacon: codeRef.beacon || null,
          codeBytes: strip0x(codeRef.code).length / 2,
        },
      });
    }
  }
  return rows;
}

function decodeAaveConfig(data) {
  const raw = BigInt(data || 0n);
  const mask16 = 0xffffn;
  const mask36 = (1n << 36n) - 1n;
  return {
    data: raw.toString(),
    ltv: Number(raw & mask16) / 10_000,
    liquidationThreshold: Number((raw >> 16n) & mask16) / 10_000,
    liquidationBonus: Number((raw >> 32n) & mask16) / 10_000,
    decimals: Number((raw >> 48n) & 0xffn),
    active: Boolean((raw >> 56n) & 1n),
    frozen: Boolean((raw >> 57n) & 1n),
    borrowingEnabled: Boolean((raw >> 58n) & 1n),
    paused: Boolean((raw >> 60n) & 1n),
    borrowCapWholeTokens: ((raw >> 80n) & mask36).toString(),
    supplyCapWholeTokens: ((raw >> 116n) & mask36).toString(),
  };
}

function ltvBpsToRatio(value) {
  return Number(value || 0) / 10_000;
}

function siloLtvToRatio(value) {
  return Number(value || 0n) / 1e18;
}

async function fetchAddressPrices(chain, addresses) {
  const keys = [];
  for (const address of addresses || []) {
    const normalized = lowerAddress(address);
    if (normalized) keys.push(`${chain.coinSlug}:${normalized}`);
  }
  const uniq = [...new Set(keys.filter(Boolean).map((x) => x.toLowerCase()))];
  const out = {};
  for (let i = 0; i < uniq.length; i += 50) {
    const json = await fetchJson(`https://coins.llama.fi/prices/current/${uniq.slice(i, i + 50).join(",")}?searchWidth=6h`, { timeoutMs: 30_000 }).catch(() => ({ coins: {} }));
    Object.assign(out, json.coins || {});
  }
  return out;
}

function pricesToAddressMap(chain, prices) {
  const out = new Map();
  for (const [key, row] of Object.entries(prices || {})) {
    const prefix = `${chain.coinSlug}:`;
    if (!key.toLowerCase().startsWith(prefix)) continue;
    const address = lowerAddress(key.slice(prefix.length));
    const price = Number(row?.price || 0);
    if (address && Number.isFinite(price) && price > 0) out.set(address, price);
  }
  return out;
}

function loadSiloDeployment(chainId, name) {
  const folder = CHAINS[chainId]?.siloFolder;
  if (!folder) return null;
  const file = path.join(SILO_CORE_DEPLOYMENTS, folder, `${name}.sol.json`);
  const json = readJson(file, null);
  return normalizeAddress(json?.address || json?.deployedTo || json?.contractAddress);
}

function addProducer(map, row) {
  const chainId = Number(row.chainId);
  const chain = CHAINS[chainId];
  const address = normalizeAddress(row.address);
  if (!chain || !address) return;
  const key = `${chainId}:${address.toLowerCase()}`;
  const existing = map.get(key);
  const tags = new Set([...(existing?.tags || []), ...(row.tags || [])].filter(Boolean));
  const sources = new Set([...(existing?.sources || []), row.source].filter(Boolean));
  map.set(key, {
    id: existing?.id || row.id || `${row.protocol || "rwa"}:${chainId}:${address.toLowerCase()}`,
    protocol: existing?.protocol || row.protocol || "RWA",
    source: existing?.source || row.source || null,
    sources: [...sources],
    chainId,
    chain: chain.name,
    address,
    addressLower: address.toLowerCase(),
    symbol: existing?.symbol || row.symbol || null,
    name: existing?.name || row.name || null,
    category: existing?.category || row.category || "rwa-nav-token",
    tags: [...tags],
    currentAnomaly: Boolean(existing?.currentAnomaly || row.currentAnomaly),
    blocker: existing?.blocker || row.blocker || null,
  });
}

function collectSeedProducers() {
  const map = new Map();
  for (const seed of PRODUCER_SEEDS) addProducer(map, seed);
  for (const seed of loadExtraProducerSeeds()) addProducer(map, seed);
  let rows = [...map.values()];
  if (PROTOCOL_FILTER) rows = rows.filter((row) => `${row.protocol} ${row.symbol || ""} ${row.name || ""}`.toLowerCase().includes(PROTOCOL_FILTER));
  if (SYMBOL_FILTER) rows = rows.filter((row) => String(row.symbol || "").toLowerCase() === SYMBOL_FILTER);
  if (CHAIN_ID_FILTER.size) rows = rows.filter((row) => CHAIN_ID_FILTER.has(row.chainId));
  return rows.sort((a, b) => a.chainId - b.chainId || String(a.protocol).localeCompare(String(b.protocol)) || String(a.symbol || "").localeCompare(String(b.symbol || "")));
}

function safeShareUnit(decimals) {
  const n = Math.max(0, Math.min(Number(decimals || 18), 36));
  return 10n ** BigInt(n);
}

async function enrichProducer(provider, chain, row, priceMap) {
  if (!provider) {
    return {
      ...row,
      codePresent: null,
      tokenPriceUsd: priceMap.get(row.addressLower) || null,
      currentAnomaly: false,
      anomaly: { reference: "RPC unavailable; live supply/NAV checks skipped", navVsTokenPriceBps: null, thresholdBps: NAV_DIVERGENCE_BPS },
      blocker: "RPC unavailable for live token/NAV probing",
    };
  }
  const [code, symbolRaw, nameRaw, decimalsRaw, supplyRaw, assetRaw, liquidityAssetRaw] = await Promise.all([
    provider.getCode(row.address).catch(() => "0x"),
    safeProviderCall(provider, row.address, ERC20.encodeFunctionData("symbol", [])),
    safeProviderCall(provider, row.address, ERC20.encodeFunctionData("name", [])),
    safeProviderCall(provider, row.address, ERC20.encodeFunctionData("decimals", [])),
    safeProviderCall(provider, row.address, ERC20.encodeFunctionData("totalSupply", [])),
    safeProviderCall(provider, row.address, ERC20.encodeFunctionData("asset", [])),
    safeProviderCall(provider, row.address, ERC20.encodeFunctionData("liquidityAssetAddr", [])),
  ]);
  const decimals = Number(decodeUintResult(decimalsRaw, "decimals") ?? 18n);
  const totalSupplyRaw = decodeUintResult(supplyRaw, "totalSupply");
  const tokenPriceUsd = priceMap.get(row.addressLower) || null;
  const asset = normalizeAddress(decodeResult(assetRaw, ERC20, "asset")?.[0])
    || normalizeAddress(decodeResult(liquidityAssetRaw, ERC20, "liquidityAssetAddr")?.[0]);
  let erc4626 = null;
  if (asset && asset !== ethers.ZeroAddress) {
    const [assetDecimalsRaw, assetSymbolRaw, totalAssetsRaw, vaultSupplyRaw, convertRaw] = await Promise.all([
      safeProviderCall(provider, asset, ERC20.encodeFunctionData("decimals", [])),
      safeProviderCall(provider, asset, ERC20.encodeFunctionData("symbol", [])),
      safeProviderCall(provider, row.address, ERC20.encodeFunctionData("totalAssets", [])),
      safeProviderCall(provider, row.address, ERC20.encodeFunctionData("totalSupply", [])),
      safeProviderCall(provider, row.address, ERC20.encodeFunctionData("convertToAssets", [safeShareUnit(decimals)])),
    ]);
    const assetDecimals = Number(decodeUintResult(assetDecimalsRaw, "decimals") ?? 18n);
    const totalAssets = decodeUintResult(totalAssetsRaw, "totalAssets");
    const vaultSupply = decodeUintResult(vaultSupplyRaw, "totalSupply");
    const convertOne = decodeUintResult(convertRaw, "convertToAssets");
    const assetPriceUsd = priceMap.get(asset.toLowerCase()) || null;
    const sharePriceAssets = convertOne !== null
      ? formatUnitsNumber(convertOne, assetDecimals)
      : (vaultSupply && vaultSupply > 0n && totalAssets !== null ? Number(ethers.formatUnits((totalAssets * safeShareUnit(decimals)) / vaultSupply, assetDecimals)) : null);
    erc4626 = {
      asset,
      assetSymbol: decodeStringResult(assetSymbolRaw, "symbol"),
      assetDecimals,
      assetPriceUsd,
      totalAssetsRaw: totalAssets?.toString() || null,
      totalAssets: totalAssets === null ? null : ethers.formatUnits(totalAssets, assetDecimals),
      totalAssetsUsd: assetPriceUsd && totalAssets !== null ? assetPriceUsd * Number(ethers.formatUnits(totalAssets, assetDecimals)) : null,
      vaultTotalSupplyRaw: vaultSupply?.toString() || null,
      convertOneShareToAssetsRaw: convertOne?.toString() || null,
      sharePriceAssets,
      navUsdPerShare: sharePriceAssets !== null && assetPriceUsd ? sharePriceAssets * assetPriceUsd : null,
    };
  }

  const navVsTokenPriceBps = bpsDiff(tokenPriceUsd, erc4626?.navUsdPerShare);
  const hasLiveSupply = totalSupplyRaw !== null && totalSupplyRaw > 0n;
  const hasNavReference = Boolean(erc4626?.navUsdPerShare && tokenPriceUsd);
  const currentAnomaly = hasLiveSupply && hasNavReference && Math.abs(navVsTokenPriceBps) >= NAV_DIVERGENCE_BPS;
  return {
    ...row,
    codePresent: Boolean(code && code !== "0x"),
    symbol: decodeStringResult(symbolRaw, "symbol") || row.symbol,
    name: decodeStringResult(nameRaw, "name") || row.name,
    decimals,
    totalSupplyRaw: totalSupplyRaw?.toString() || null,
    totalSupply: totalSupplyRaw === null ? null : ethers.formatUnits(totalSupplyRaw, decimals),
    tokenPriceUsd,
    erc4626,
    currentAnomaly,
    anomaly: {
      navVsTokenPriceBps,
      thresholdBps: NAV_DIVERGENCE_BPS,
      publicTokenPriceAvailable: Boolean(tokenPriceUsd),
      erc4626NavReferenceAvailable: Boolean(erc4626?.navUsdPerShare),
      liveSupplyRequired: hasLiveSupply,
      reference: erc4626 ? "ERC4626-like asset/NAV versus DeFiLlama token price" : "no ERC4626-like NAV interface resolved",
    },
    blocker: currentAnomaly
      ? "RWA/NAV divergence needs exact consumer, transferability, and executable exit proof before fork"
      : "No current token/NAV reference divergence above threshold or no NAV reference available",
  };
}

async function enrichProducers(provider, chain, rows) {
  const firstPrices = pricesToAddressMap(chain, await fetchAddressPrices(chain, rows.map((r) => r.address)));
  const firstPass = [];
  for (let i = 0; i < rows.length; i += RPC_BATCH_SIZE) {
    const batch = rows.slice(i, i + RPC_BATCH_SIZE);
    firstPass.push(...await Promise.all(batch.map((row) => enrichProducer(provider, chain, row, firstPrices).catch((err) => ({ ...row, error: err.message || String(err), currentAnomaly: false })))));
  }
  const assetAddresses = firstPass.map((p) => p.erc4626?.asset).filter(Boolean);
  if (!assetAddresses.length) return firstPass;
  const prices = pricesToAddressMap(chain, await fetchAddressPrices(chain, [...rows.map((r) => r.address), ...assetAddresses]));
  const secondPass = [];
  for (let i = 0; i < rows.length; i += RPC_BATCH_SIZE) {
    const batch = rows.slice(i, i + RPC_BATCH_SIZE);
    secondPass.push(...await Promise.all(batch.map((row) => enrichProducer(provider, chain, row, prices).catch((err) => ({ ...row, error: err.message || String(err), currentAnomaly: false })))));
  }
  return secondPass;
}

async function morphoQuery(query, variables) {
  const json = await fetchJson("https://api.morpho.org/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    timeoutMs: 30_000,
  });
  if (json.errors) throw new Error(json.errors[0]?.message || "Morpho GraphQL error");
  return json.data?.markets?.items || [];
}

function morphoFields() {
  return `
    marketId
    loanAsset { symbol address decimals }
    collateralAsset { symbol address decimals }
    oracle { address }
    irmAddress
    lltv
    state { supplyAssetsUsd borrowAssetsUsd liquidityAssetsUsd utilization }
  `;
}

async function fetchMorphoAssetConsumers(chainId, producers, fieldName) {
  const query = `query($chainIds:[Int!]!, $assets:[String!]!) {
    markets(first:100, orderBy:SupplyAssetsUsd, orderDirection:Desc,
      where:{chainId_in:$chainIds, ${fieldName}:$assets}) { items { ${morphoFields()} } }
  }`;
  const assets = producers.map((p) => p.addressLower);
  const rows = [];
  for (let i = 0; i < assets.length; i += 50) {
    rows.push(...await morphoQuery(query, { chainIds: [chainId], assets: assets.slice(i, i + 50) }).catch(() => []));
  }
  return rows;
}

async function fetchTopMorphoMarkets(chainId) {
  const query = `query($chainIds:[Int!]!, $minSupply:Float!) {
    markets(first:${MORPHO_TOP_N}, orderBy:SupplyAssetsUsd, orderDirection:Desc,
      where:{chainId_in:$chainIds, supplyAssetsUsd_gte:$minSupply}) { items { ${morphoFields()} } }
  }`;
  return morphoQuery(query, { chainIds: [chainId], minSupply: 1 }).catch(() => []);
}

function morphoLltvRatio(value) {
  try {
    return Number(BigInt(String(value || 0))) / 1e18;
  } catch (_) {
    return Number(value || 0);
  }
}

function classifyMatch(producer, protocol, side, market, extraBlockers = []) {
  const ltv = Number(market.ltv ?? market.borrowLtv ?? market.maxLtv ?? market.lltv ?? 0);
  const liquidityUsd = Number(market.otherReserveCashUsd ?? market.liquidityAssetsUsd ?? market.cashUsd ?? market.oppositeLiquidityUsd ?? 0);
  const collateralLike = !/loanAsset|borrowAsset/i.test(side);
  const reviewCandidate = collateralLike && ltv > 0 && liquidityUsd >= ROUTE_LIQUIDITY_USD;
  const watchCandidate = reviewCandidate && Boolean(producer.currentAnomaly);
  return {
    protocol,
    side,
    producer: {
      id: producer.id,
      protocol: producer.protocol,
      chainId: producer.chainId,
      chain: producer.chain,
      address: producer.address,
      symbol: producer.symbol,
      name: producer.name,
      category: producer.category,
      tags: producer.tags,
      sources: producer.sources,
      currentAnomaly: producer.currentAnomaly,
      anomaly: producer.anomaly,
      erc4626: producer.erc4626,
      tokenPriceUsd: producer.tokenPriceUsd,
    },
    market,
    reviewCandidate,
    watchCandidate,
    routePositive: false,
    blockers: [
      producer.currentAnomaly ? "Producer price/NAV divergence is current but not route-proven" : "No current producer NAV/reference anomaly above threshold",
      reviewCandidate ? "Needs route-specific oracle semantics and executable exit economics before fork" : null,
      watchCandidate ? "Needs permissionless redemption, transferability, or DEX quote at exact size before route-positive" : null,
      producer.tags?.some((tag) => /permissioned|restricted|kyc/i.test(tag)) ? "RWA mint/redeem/transfer may be permissioned or restricted" : null,
      !collateralLike ? "Producer is debt/loan-side, not collateral overvaluation route" : null,
      ltv <= 0 ? "Collateral LTV disabled or unconfirmed" : null,
      liquidityUsd < ROUTE_LIQUIDITY_USD ? "Route-side liquidity below threshold or unpriced" : null,
      /BytecodeReference/i.test(side) ? "Bytecode reference needs source-level oracle confirmation" : null,
      "No fork proof or signed-action justification",
      ...extraBlockers,
    ].filter(Boolean),
  };
}

async function scanMorpho(provider, chainId, producers) {
  const byAddress = new Map(producers.map((p) => [p.addressLower, p]));
  const [collateral, loan, topMarkets] = await Promise.all([
    fetchMorphoAssetConsumers(chainId, producers, "collateralAssetAddress_in"),
    fetchMorphoAssetConsumers(chainId, producers, "loanAssetAddress_in"),
    provider ? fetchTopMorphoMarkets(chainId) : Promise.resolve([]),
  ]);
  const rows = [];
  for (const market of collateral) {
    const producer = byAddress.get(lowerAddress(market.collateralAsset?.address));
    if (!producer) continue;
    rows.push(classifyMatch(producer, "Morpho Blue", "collateralAsset", {
      marketId: market.marketId,
      loanAsset: market.loanAsset,
      collateralAsset: market.collateralAsset,
      oracle: market.oracle,
      irmAddress: market.irmAddress,
      lltv: morphoLltvRatio(market.lltv),
      liquidityAssetsUsd: Number(market.state?.liquidityAssetsUsd || 0),
      borrowAssetsUsd: Number(market.state?.borrowAssetsUsd || 0),
      supplyAssetsUsd: Number(market.state?.supplyAssetsUsd || 0),
      utilization: market.state?.utilization ?? null,
    }));
  }
  for (const market of loan) {
    const producer = byAddress.get(lowerAddress(market.loanAsset?.address));
    if (!producer) continue;
    rows.push(classifyMatch(producer, "Morpho Blue", "loanAsset", {
      marketId: market.marketId,
      loanAsset: market.loanAsset,
      collateralAsset: market.collateralAsset,
      oracle: market.oracle,
      lltv: morphoLltvRatio(market.lltv),
      liquidityAssetsUsd: Number(market.state?.liquidityAssetsUsd || 0),
      borrowAssetsUsd: Number(market.state?.borrowAssetsUsd || 0),
      supplyAssetsUsd: Number(market.state?.supplyAssetsUsd || 0),
      utilization: market.state?.utilization ?? null,
    }));
  }

  const oracleMarkets = new Map();
  for (const market of topMarkets) {
    const oracle = lowerAddress(market.oracle?.address);
    if (!oracle || oracle === ethers.ZeroAddress.toLowerCase()) continue;
    if (!oracleMarkets.has(oracle)) oracleMarkets.set(oracle, []);
    oracleMarkets.get(oracle).push(market);
  }
  const oracleEntries = [...oracleMarkets.entries()];
  for (let i = 0; i < oracleEntries.length; i += RPC_BATCH_SIZE) {
    const batch = oracleEntries.slice(i, i + RPC_BATCH_SIZE);
    const refs = await Promise.all(batch.map(async ([oracle]) => ({ oracle, refs: await findProducerReferencesInAddress(provider, oracle, producers).catch(() => []) })));
    for (const { oracle, refs: matchedRefs } of refs) {
      for (const ref of matchedRefs) {
        for (const market of oracleMarkets.get(oracle) || []) {
          rows.push(classifyMatch(ref.producer, "Morpho Blue", "oracleBytecodeReference", {
            marketId: market.marketId,
            loanAsset: market.loanAsset,
            collateralAsset: market.collateralAsset,
            oracle: market.oracle,
            oracleReference: ref.reference,
            irmAddress: market.irmAddress,
            lltv: morphoLltvRatio(market.lltv),
            liquidityAssetsUsd: Number(market.state?.liquidityAssetsUsd || 0),
            borrowAssetsUsd: Number(market.state?.borrowAssetsUsd || 0),
            supplyAssetsUsd: Number(market.state?.supplyAssetsUsd || 0),
          }));
        }
      }
    }
  }
  return { rows, stats: { collateralMatches: collateral.length, loanMatches: loan.length, topMarketsScanned: topMarkets.length, oracleContractsScanned: oracleEntries.length } };
}

async function scanAave(provider, chain, producers) {
  const pool = normalizeAddress(chain.aavePool);
  if (!provider || !pool) return { rows: [], stats: { reservesScanned: 0, priceSourcesScanned: 0 } };
  const producersByAddress = new Map(producers.map((p) => [p.addressLower, p]));
  const reservesRaw = await safeProviderCall(provider, pool, AAVE_POOL.encodeFunctionData("getReservesList", []));
  const reserves = (decodeResult(reservesRaw, AAVE_POOL, "getReservesList")?.[0] || []).map(normalizeAddress).filter(Boolean);
  if (!reserves.length) return { rows: [], stats: { reservesScanned: 0, priceSourcesScanned: 0 } };

  const providerRaw = await safeProviderCall(provider, pool, AAVE_POOL.encodeFunctionData("ADDRESSES_PROVIDER", []));
  const addressesProvider = normalizeAddress(decodeResult(providerRaw, AAVE_POOL, "ADDRESSES_PROVIDER")?.[0]);
  const oracleRaw = addressesProvider ? await safeProviderCall(provider, addressesProvider, AAVE_ADDRESSES_PROVIDER.encodeFunctionData("getPriceOracle", [])) : null;
  const priceOracle = normalizeAddress(decodeResult(oracleRaw, AAVE_ADDRESSES_PROVIDER, "getPriceOracle")?.[0]);
  const metas = [];
  for (const reserve of reserves) {
    const [dataRaw, symbolRaw] = await Promise.all([
      safeProviderCall(provider, pool, AAVE_POOL.encodeFunctionData("getReserveData", [reserve])),
      safeProviderCall(provider, reserve, ERC20.encodeFunctionData("symbol", [])),
    ]);
    if (!dataRaw || dataRaw === "0x") continue;
    const cfg = decodeAaveConfig(BigInt(wordAt(dataRaw, 0) || 0n));
    const aToken = normalizeAddress(addressWordAt(dataRaw, 8) || addressWordAt(dataRaw, 9));
    const priceSource = priceOracle
      ? normalizeAddress(decodeResult(await safeProviderCall(provider, priceOracle, AAVE_ORACLE.encodeFunctionData("getSourceOfAsset", [reserve])), AAVE_ORACLE, "getSourceOfAsset")?.[0])
      : null;
    const decimals = cfg.decimals || await erc20Decimals(provider, reserve).catch(() => 18);
    const cashRaw = aToken ? await erc20Balance(provider, reserve, aToken).catch(() => 0n) : 0n;
    metas.push({
      protocol: "Aave V3",
      pool,
      addressesProvider,
      priceOracle,
      reserve,
      symbol: decodeStringResult(symbolRaw, "symbol"),
      aToken,
      priceSource,
      cashRaw: cashRaw.toString(),
      cash: formatUnitsNumber(cashRaw, decimals),
      ...cfg,
    });
  }
  const prices = pricesToAddressMap(chain, await fetchAddressPrices(chain, metas.map((m) => m.reserve)));
  for (const meta of metas) meta.cashUsd = (prices.get(meta.reserve.toLowerCase()) || 0) * Number(meta.cash || 0);
  const borrowableCashUsd = metas.filter((m) => m.active && !m.paused && m.borrowingEnabled).reduce((sum, m) => sum + Number(m.cashUsd || 0), 0);
  const rows = [];
  for (const meta of metas) {
    const producer = producersByAddress.get(meta.reserve.toLowerCase());
    if (producer) rows.push(classifyMatch(producer, "Aave V3", "reserveAsset", { ...meta, otherReserveCashUsd: Math.max(0, borrowableCashUsd - Number(meta.cashUsd || 0)) }));
  }
  const uniqueSources = [...new Set(metas.map((m) => m.priceSource?.toLowerCase()).filter(Boolean))];
  for (let i = 0; i < uniqueSources.length; i += RPC_BATCH_SIZE) {
    const batch = uniqueSources.slice(i, i + RPC_BATCH_SIZE);
    const refs = await Promise.all(batch.map(async (source) => ({ source, refs: await findProducerReferencesInAddress(provider, source, producers).catch(() => []) })));
    for (const { source, refs: matchedRefs } of refs) {
      for (const ref of matchedRefs) {
        for (const meta of metas.filter((m) => m.priceSource?.toLowerCase() === source)) {
          rows.push(classifyMatch(ref.producer, "Aave V3", "priceSourceBytecodeReference", { ...meta, priceSourceReference: ref.reference, otherReserveCashUsd: Math.max(0, borrowableCashUsd - Number(meta.cashUsd || 0)) }));
        }
      }
    }
  }
  return { rows, stats: { reservesScanned: metas.length, priceSourcesScanned: uniqueSources.length } };
}

async function scanEuler(provider, chain, producers) {
  const factory = normalizeAddress(chain.eulerFactory);
  if (!provider || !factory) return { rows: [], stats: { factoryListLength: 0, evaultsScanned: 0, oracleContractsScanned: 0 } };
  const producersByAddress = new Map(producers.map((p) => [p.addressLower, p]));
  const lengthRaw = await safeProviderCall(provider, factory, GENERIC_FACTORY.encodeFunctionData("getProxyListLength", []));
  const length = Number(decodeResult(lengthRaw, GENERIC_FACTORY, "getProxyListLength")?.[0] || 0n);
  if (!length) return { rows: [], stats: { factoryListLength: 0, evaultsScanned: 0, oracleContractsScanned: 0 } };
  const start = Math.max(0, length - MAX_EULER_VAULTS);
  const evaults = [];
  for (let cursor = start; cursor < length; cursor += 100) {
    const end = Math.min(length, cursor + 100);
    const raw = await safeProviderCall(provider, factory, GENERIC_FACTORY.encodeFunctionData("getProxyListSlice", [cursor, end]));
    evaults.push(...(decodeResult(raw, GENERIC_FACTORY, "getProxyListSlice")?.[0] || []).map(normalizeAddress).filter(Boolean));
  }
  const metas = [];
  for (let i = 0; i < evaults.length; i += RPC_BATCH_SIZE) {
    const batch = evaults.slice(i, i + RPC_BATCH_SIZE);
    const rows = await Promise.all(batch.map(async (evault) => {
      const [assetRaw, oracleRaw, cashRaw, borrowsRaw, symbolRaw, ltvListRaw] = await Promise.all([
        safeProviderCall(provider, evault, EVAULT.encodeFunctionData("asset", [])),
        safeProviderCall(provider, evault, EVAULT.encodeFunctionData("oracle", [])),
        safeProviderCall(provider, evault, EVAULT.encodeFunctionData("cash", [])),
        safeProviderCall(provider, evault, EVAULT.encodeFunctionData("totalBorrows", [])),
        safeProviderCall(provider, evault, EVAULT.encodeFunctionData("symbol", [])),
        safeProviderCall(provider, evault, EVAULT.encodeFunctionData("LTVList", [])),
      ]);
      const asset = normalizeAddress(decodeResult(assetRaw, EVAULT, "asset")?.[0]);
      if (!asset) return null;
      const ltvList = (decodeResult(ltvListRaw, EVAULT, "LTVList")?.[0] || []).map(normalizeAddress).filter(Boolean);
      const ltvEntries = [];
      for (const collateral of ltvList.slice(0, 40)) {
        const raw = await safeProviderCall(provider, evault, EVAULT.encodeFunctionData("LTVBorrow", [collateral]));
        ltvEntries.push({ collateral, borrowLtv: ltvBpsToRatio(decodeResult(raw, EVAULT, "LTVBorrow")?.[0] || 0) });
      }
      return {
        protocol: "Euler EVK",
        factory,
        evault,
        asset,
        symbol: decodeStringResult(symbolRaw, "symbol"),
        oracle: normalizeAddress(decodeResult(oracleRaw, EVAULT, "oracle")?.[0]),
        cashRaw: String(decodeResult(cashRaw, EVAULT, "cash")?.[0] || 0n),
        totalBorrowsRaw: String(decodeResult(borrowsRaw, EVAULT, "totalBorrows")?.[0] || 0n),
        ltvEntries,
        maxBorrowLtv: ltvEntries.reduce((max, row) => Math.max(max, Number(row.borrowLtv || 0)), 0),
      };
    }));
    metas.push(...rows.filter(Boolean));
  }
  const prices = pricesToAddressMap(chain, await fetchAddressPrices(chain, metas.map((m) => m.asset)));
  for (const meta of metas) {
    const decimals = await erc20Decimals(provider, meta.asset).catch(() => 18);
    meta.assetDecimals = decimals;
    meta.cash = formatUnitsNumber(BigInt(meta.cashRaw), decimals);
    meta.totalBorrows = formatUnitsNumber(BigInt(meta.totalBorrowsRaw), decimals);
    meta.cashUsd = (prices.get(meta.asset.toLowerCase()) || 0) * Number(meta.cash || 0);
  }
  const rows = [];
  for (const meta of metas) {
    const borrowProducer = producersByAddress.get(meta.asset.toLowerCase());
    if (borrowProducer) rows.push(classifyMatch(borrowProducer, "Euler EVK", "borrowAsset", meta));
    for (const ltv of meta.ltvEntries) {
      const collateralProducer = producersByAddress.get(ltv.collateral.toLowerCase());
      if (collateralProducer) rows.push(classifyMatch(collateralProducer, "Euler EVK", "collateralVault", { ...meta, collateral: ltv.collateral, borrowLtv: ltv.borrowLtv }));
    }
  }
  const oracleMarkets = new Map();
  for (const meta of metas) {
    const oracle = lowerAddress(meta.oracle);
    if (!oracle || oracle === ethers.ZeroAddress.toLowerCase()) continue;
    if (!oracleMarkets.has(oracle)) oracleMarkets.set(oracle, []);
    oracleMarkets.get(oracle).push(meta);
  }
  const oracleEntries = [...oracleMarkets.entries()];
  for (let i = 0; i < oracleEntries.length; i += RPC_BATCH_SIZE) {
    const batch = oracleEntries.slice(i, i + RPC_BATCH_SIZE);
    const refs = await Promise.all(batch.map(async ([oracle]) => ({ oracle, refs: await findProducerReferencesInAddress(provider, oracle, producers).catch(() => []) })));
    for (const { oracle, refs: matchedRefs } of refs) {
      for (const ref of matchedRefs) {
        for (const meta of oracleMarkets.get(oracle) || []) rows.push(classifyMatch(ref.producer, "Euler EVK", "oracleBytecodeReference", { ...meta, oracleReference: ref.reference }));
      }
    }
  }
  return { rows, stats: { factoryListLength: length, factoryListStart: start, evaultsScanned: metas.length, oracleContractsScanned: oracleEntries.length } };
}

function parseSiloConfig(decoded) {
  const row = decoded?.[0];
  if (!row) return null;
  const token = normalizeAddress(row[3]);
  const silo = normalizeAddress(row[2]);
  if (!token || !silo) return null;
  return {
    silo,
    token,
    protectedShareToken: normalizeAddress(row[4]),
    collateralShareToken: normalizeAddress(row[5]),
    debtShareToken: normalizeAddress(row[6]),
    solvencyOracle: normalizeAddress(row[7]),
    maxLtvOracle: normalizeAddress(row[8]),
    maxLtv: siloLtvToRatio(row[10] || 0n),
    lt: siloLtvToRatio(row[11] || 0n),
  };
}

async function scanSilo(provider, chainId, chain, producers) {
  const factory = loadSiloDeployment(chainId, "SiloFactory");
  if (!provider || !factory) return { rows: [], stats: { idsScanned: 0, marketsScanned: 0, oracleContractsScanned: 0 } };
  const producersByAddress = new Map(producers.map((p) => [p.addressLower, p]));
  const nextRaw = await safeProviderCall(provider, factory, SILO_FACTORY.encodeFunctionData("getNextSiloId", []));
  const nextId = decodeResult(nextRaw, SILO_FACTORY, "getNextSiloId")?.[0];
  if (!nextId) return { rows: [], stats: { idsScanned: 0, marketsScanned: 0, oracleContractsScanned: 0 } };
  const start = nextId > BigInt(MAX_SILO_IDS) ? nextId - BigInt(MAX_SILO_IDS) : 1n;
  const pairs = [];
  const tokenSet = new Set();
  for (let id = start; id < nextId; id++) {
    const cfgRaw = await safeProviderCall(provider, factory, SILO_FACTORY.encodeFunctionData("idToSiloConfig", [id]));
    const config = normalizeAddress(decodeResult(cfgRaw, SILO_FACTORY, "idToSiloConfig")?.[0]);
    if (!config || config === ethers.ZeroAddress) continue;
    const silosRaw = await safeProviderCall(provider, config, SILO_CONFIG.encodeFunctionData("getSilos", []));
    const silosDecoded = decodeResult(silosRaw, SILO_CONFIG, "getSilos");
    const silos = [normalizeAddress(silosDecoded?.[0]), normalizeAddress(silosDecoded?.[1])].filter(Boolean);
    if (silos.length < 2) continue;
    const sides = [];
    for (const silo of silos) {
      const [configRaw, liquidityRaw, storageRaw] = await Promise.all([
        safeProviderCall(provider, config, SILO_CONFIG.encodeFunctionData("getConfig", [silo])),
        safeProviderCall(provider, silo, SILO.encodeFunctionData("getLiquidity", [])),
        safeProviderCall(provider, silo, SILO.encodeFunctionData("getSiloStorage", [])),
      ]);
      const cfg = parseSiloConfig(decodeResult(configRaw, SILO_CONFIG, "getConfig"));
      if (!cfg) continue;
      const storage = decodeResult(storageRaw, SILO, "getSiloStorage");
      const liquidity = decodeResult(liquidityRaw, SILO, "getLiquidity")?.[0] || 0n;
      tokenSet.add(cfg.token.toLowerCase());
      sides.push({
        ...cfg,
        id: id.toString(),
        config,
        liquidityRaw: liquidity.toString(),
        collateralAssetsRaw: (storage?.[3] || 0n).toString(),
        debtAssetsRaw: (storage?.[4] || 0n).toString(),
      });
    }
    if (sides.length === 2) pairs.push({ id: id.toString(), config, sides });
  }
  const prices = pricesToAddressMap(chain, await fetchAddressPrices(chain, [...tokenSet]));
  const tokenMeta = new Map();
  for (const token of tokenSet) {
    const address = normalizeAddress(token);
    if (!address) continue;
    const [decimals, symbolRaw] = await Promise.all([
      erc20Decimals(provider, address).catch(() => 18),
      safeProviderCall(provider, address, ERC20.encodeFunctionData("symbol", [])),
    ]);
    tokenMeta.set(address.toLowerCase(), { decimals, symbol: decodeStringResult(symbolRaw, "symbol"), priceUsd: prices.get(address.toLowerCase()) || 0 });
  }
  for (const pair of pairs) {
    for (const side of pair.sides) {
      const meta = tokenMeta.get(side.token.toLowerCase()) || { decimals: 18, priceUsd: 0 };
      side.tokenSymbol = meta.symbol;
      side.tokenDecimals = meta.decimals;
      side.liquidity = formatUnitsNumber(BigInt(side.liquidityRaw), meta.decimals);
      side.liquidityUsd = Number(side.liquidity || 0) * Number(meta.priceUsd || 0);
    }
  }
  const rows = [];
  const oracleRows = [];
  for (const pair of pairs) {
    for (let idx = 0; idx < pair.sides.length; idx++) {
      const side = pair.sides[idx];
      const opposite = pair.sides[idx === 0 ? 1 : 0];
      const consumer = {
        protocol: "Silo V3",
        factory,
        id: pair.id,
        config: pair.config,
        silo: side.silo,
        token: side.token,
        tokenSymbol: side.tokenSymbol,
        solvencyOracle: side.solvencyOracle,
        maxLtvOracle: side.maxLtvOracle,
        maxLtv: side.maxLtv,
        lt: side.lt,
        liquidityUsd: side.liquidityUsd,
        oppositeSilo: opposite.silo,
        oppositeToken: opposite.token,
        oppositeTokenSymbol: opposite.tokenSymbol,
        oppositeLiquidityUsd: opposite.liquidityUsd,
      };
      const producer = producersByAddress.get(side.token.toLowerCase());
      if (producer) rows.push(classifyMatch(producer, "Silo V3", "collateralToken", consumer));
      for (const oracle of [side.solvencyOracle, side.maxLtvOracle]) {
        const normalizedOracle = lowerAddress(oracle);
        if (!normalizedOracle || normalizedOracle === ethers.ZeroAddress.toLowerCase()) continue;
        oracleRows.push({ oracle: normalizedOracle, consumer });
      }
    }
  }
  const uniqueOracles = [...new Set(oracleRows.map((row) => row.oracle))];
  for (let i = 0; i < uniqueOracles.length; i += RPC_BATCH_SIZE) {
    const batch = uniqueOracles.slice(i, i + RPC_BATCH_SIZE);
    const refs = await Promise.all(batch.map(async (oracle) => ({ oracle, refs: await findProducerReferencesInAddress(provider, oracle, producers).catch(() => []) })));
    for (const { oracle, refs: matchedRefs } of refs) {
      for (const ref of matchedRefs) {
        for (const row of oracleRows.filter((r) => r.oracle === oracle)) rows.push(classifyMatch(ref.producer, "Silo V3", "oracleBytecodeReference", { ...row.consumer, oracle, oracleReference: ref.reference }));
      }
    }
  }
  return { rows, stats: { idsScanned: Number(nextId - start), marketsScanned: pairs.length, oracleContractsScanned: uniqueOracles.length } };
}

function listCompoundConfigs(chain) {
  const folder = chain.compoundFolder ? path.join(COMPOUND_DEPLOYMENTS, chain.compoundFolder) : null;
  if (!folder || !fs.existsSync(folder)) return [];
  const rows = [];
  for (const marketName of fs.readdirSync(folder)) {
    const marketFolder = path.join(folder, marketName);
    const stat = fs.statSync(marketFolder);
    if (!stat.isDirectory()) continue;
    const config = readJson(path.join(marketFolder, "configuration.json"), null);
    const roots = readJson(path.join(marketFolder, "roots.json"), null);
    if (!config || !roots?.comet) continue;
    rows.push({ marketName, config, roots, comet: normalizeAddress(roots.comet) });
  }
  return rows;
}

async function scanCompound(provider, chain, producers) {
  const producersByAddress = new Map(producers.map((p) => [p.addressLower, p]));
  const configs = listCompoundConfigs(chain);
  if (!configs.length) return { rows: [], stats: { marketsScanned: 0, priceFeedsScanned: 0 } };
  const baseTokens = configs.map((row) => row.config.baseTokenAddress).filter(Boolean);
  const prices = pricesToAddressMap(chain, await fetchAddressPrices(chain, baseTokens));
  const rows = [];
  const priceFeedRows = [];
  for (const row of configs) {
    const baseToken = normalizeAddress(row.config.baseTokenAddress);
    const baseDecimals = baseToken && provider ? await erc20Decimals(provider, baseToken).catch(() => 18) : 18;
    const baseCashRaw = provider && baseToken && row.comet ? await erc20Balance(provider, baseToken, row.comet).catch(() => 0n) : 0n;
    const baseCash = formatUnitsNumber(baseCashRaw, baseDecimals);
    const baseCashUsd = Number(baseCash || 0) * Number(prices.get(baseToken?.toLowerCase()) || 0);
    for (const [symbol, asset] of Object.entries(row.config.assets || {})) {
      const assetAddress = normalizeAddress(asset.address);
      const priceFeed = normalizeAddress(asset.priceFeed);
      if (priceFeed) {
        priceFeedRows.push({ priceFeed, row, symbol, asset, baseToken, baseCashUsd, baseCash });
      }
      const producer = producersByAddress.get(assetAddress?.toLowerCase());
      if (!producer) continue;
      rows.push(classifyMatch(producer, "Compound Comet", "collateralAsset", {
        chain: chain.name,
        deployment: row.marketName,
        comet: row.comet,
        baseToken,
        baseTokenSymbol: row.config.baseToken,
        baseCash,
        baseCashUsd,
        collateralSymbol: symbol,
        collateralAsset: assetAddress,
        priceFeed,
        ltv: Number(asset.borrowCF || 0),
        liquidateCF: Number(asset.liquidateCF || 0),
        liquidationFactor: Number(asset.liquidationFactor || 0),
        supplyCap: asset.supplyCap || null,
        otherReserveCashUsd: baseCashUsd,
      }, provider ? [] : ["RPC unavailable; Compound base cash not live-read"]));
    }
  }
  const uniqueFeeds = [...new Set(priceFeedRows.map((r) => r.priceFeed?.toLowerCase()).filter(Boolean))];
  if (provider) {
    for (let i = 0; i < uniqueFeeds.length; i += RPC_BATCH_SIZE) {
      const batch = uniqueFeeds.slice(i, i + RPC_BATCH_SIZE);
      const refs = await Promise.all(batch.map(async (feed) => ({ feed, refs: await findProducerReferencesInAddress(provider, feed, producers).catch(() => []) })));
      for (const { feed, refs: matchedRefs } of refs) {
        for (const ref of matchedRefs) {
          for (const feedRow of priceFeedRows.filter((r) => r.priceFeed?.toLowerCase() === feed)) {
            rows.push(classifyMatch(ref.producer, "Compound Comet", "priceFeedBytecodeReference", {
              chain: chain.name,
              deployment: feedRow.row.marketName,
              comet: feedRow.row.comet,
              baseToken: feedRow.baseToken,
              baseTokenSymbol: feedRow.row.config.baseToken,
              baseCash: feedRow.baseCash,
              baseCashUsd: feedRow.baseCashUsd,
              collateralSymbol: feedRow.symbol,
              collateralAsset: normalizeAddress(feedRow.asset.address),
              priceFeed: feedRow.priceFeed,
              priceFeedReference: ref.reference,
              ltv: Number(feedRow.asset.borrowCF || 0),
              liquidateCF: Number(feedRow.asset.liquidateCF || 0),
              liquidationFactor: Number(feedRow.asset.liquidationFactor || 0),
              supplyCap: feedRow.asset.supplyCap || null,
              otherReserveCashUsd: feedRow.baseCashUsd,
            }));
          }
        }
      }
    }
  }
  return { rows, stats: { marketsScanned: configs.length, priceFeedsScanned: uniqueFeeds.length } };
}

function dedupeRows(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = [
      row.protocol,
      row.side,
      row.producer.chainId,
      row.producer.address?.toLowerCase(),
      row.market.marketId || row.market.reserve || row.market.evault || row.market.config || row.market.comet || row.market.silo || "",
      row.market.oracleReference?.address || row.market.priceSourceReference?.address || row.market.priceFeedReference?.address || "",
    ].join(":").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function breakdownRows(rows) {
  return rows.reduce((acc, row) => {
    acc.byProtocol[row.protocol] = (acc.byProtocol[row.protocol] || 0) + 1;
    acc.bySide[row.side] = (acc.bySide[row.side] || 0) + 1;
    acc.byProducerProtocol[row.producer.protocol] = (acc.byProducerProtocol[row.producer.protocol] || 0) + 1;
    acc.byProducerCategory[row.producer.category] = (acc.byProducerCategory[row.producer.category] || 0) + 1;
    return acc;
  }, { byProtocol: {}, bySide: {}, byProducerProtocol: {}, byProducerCategory: {} });
}

function mergeBreakdowns(results) {
  const out = { byProtocol: {}, bySide: {}, byProducerProtocol: {}, byProducerCategory: {} };
  for (const result of results) {
    for (const key of Object.keys(out)) {
      for (const [name, value] of Object.entries(result.matchBreakdown?.[key] || {})) {
        out[key][name] = (out[key][name] || 0) + Number(value || 0);
      }
    }
  }
  return out;
}

async function scanChain(chainId, rpc, allProducers) {
  const chain = CHAINS[chainId];
  const provider = rpc ? new ethers.JsonRpcProvider(rpc) : null;
  const seedRows = allProducers.filter((p) => p.chainId === chainId);
  const blockNumber = provider ? await provider.getBlockNumber().catch(() => null) : null;
  console.log(`Scanning ${chain.name}: producers=${seedRows.length}`);
  const producers = await enrichProducers(provider, chain, seedRows);

  const [morpho, aave, euler, silo, compound] = await Promise.all([
    scanMorpho(provider, chainId, producers),
    scanAave(provider, chain, producers),
    scanEuler(provider, chain, producers),
    scanSilo(provider, chainId, chain, producers),
    scanCompound(provider, chain, producers),
  ]);
  const matches = dedupeRows([...morpho.rows, ...aave.rows, ...euler.rows, ...silo.rows, ...compound.rows]);
  matches.sort((a, b) => Number(b.routePositive) - Number(a.routePositive) || Number(b.watchCandidate) - Number(a.watchCandidate) || Number(b.reviewCandidate) - Number(a.reviewCandidate) || Number(b.market.otherReserveCashUsd || b.market.cashUsd || b.market.baseCashUsd || b.market.liquidityAssetsUsd || b.market.oppositeLiquidityUsd || 0) - Number(a.market.otherReserveCashUsd || a.market.cashUsd || a.market.baseCashUsd || a.market.liquidityAssetsUsd || a.market.oppositeLiquidityUsd || 0));
  return {
    chainId,
    chain: chain.name,
    rpcResolved: Boolean(provider),
    blockNumber,
    producersInput: seedRows.length,
    producersResolved: producers.length,
    producersCodePresent: producers.filter((p) => p.codePresent).length,
    producersWithPublicTokenPrice: producers.filter((p) => p.tokenPriceUsd).length,
    producersWithErc4626Nav: producers.filter((p) => p.erc4626?.navUsdPerShare).length,
    producerAnomalies: producers.filter((p) => p.currentAnomaly).length,
    aaveReservesScanned: aave.stats.reservesScanned,
    aavePriceSourcesScanned: aave.stats.priceSourcesScanned,
    eulerFactoryListLength: euler.stats.factoryListLength,
    eulerFactoryListStart: euler.stats.factoryListStart,
    eulerVaultsScanned: euler.stats.evaultsScanned,
    eulerOracleContractsScanned: euler.stats.oracleContractsScanned,
    siloIdsScanned: silo.stats.idsScanned,
    siloMarketsScanned: silo.stats.marketsScanned,
    siloOracleContractsScanned: silo.stats.oracleContractsScanned,
    compoundMarketsScanned: compound.stats.marketsScanned,
    compoundPriceFeedsScanned: compound.stats.priceFeedsScanned,
    morphoCollateralMatches: morpho.stats.collateralMatches,
    morphoLoanMatches: morpho.stats.loanMatches,
    morphoTopMarketsScanned: morpho.stats.topMarketsScanned,
    morphoOracleContractsScanned: morpho.stats.oracleContractsScanned,
    matches: matches.length,
    matchBreakdown: breakdownRows(matches),
    reviewCandidates: matches.filter((row) => row.reviewCandidate).length,
    watchCandidates: matches.filter((row) => row.watchCandidate).length,
    routePositive: matches.filter((row) => row.routePositive).length,
    topProducers: producers.slice(0, 80),
    topMatches: matches.slice(0, 80),
  };
}

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const producers = collectSeedProducers();
  const chainIds = [...new Set(producers.map((p) => p.chainId))].filter((id) => CHAINS[id]);
  const rpcPool = await resolveRpcPool(chainIds);
  const results = [];
  for (const chainId of chainIds) {
    results.push(await scanChain(chainId, rpcPool[chainId], producers));
  }
  const routePositive = results.reduce((sum, r) => sum + Number(r.routePositive || 0), 0);
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-rwa-nav-consumer-graph.js",
    scope: "Read-only RWA/NAV receipt-token producer inventory and lending/oracle consumer graph",
    safety: {
      rpcInventoryRead: Object.keys(rpcPool).length > 0,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: routePositive > 0,
      signedActionJustified: false,
    },
    thresholds: {
      routeLiquidityUsd: ROUTE_LIQUIDITY_USD,
      navDivergenceBps: NAV_DIVERGENCE_BPS,
      maxEulerVaults: MAX_EULER_VAULTS,
      maxSiloIds: MAX_SILO_IDS,
      morphoTopN: MORPHO_TOP_N,
      protocolFilter: PROTOCOL_FILTER || null,
      symbolFilter: SYMBOL_FILTER || null,
      chainIdFilter: [...CHAIN_ID_FILTER],
      extraProducerFile: EXTRA_PRODUCER_FILE ? path.relative(WORKSPACE, EXTRA_PRODUCER_FILE).replace(/\\/g, "/") : null,
    },
    producerSource: {
      exactSeedCount: producers.length,
      seededProtocols: [...new Set(producers.map((p) => p.protocol))].sort(),
      seededChains: Object.fromEntries(Object.entries(CHAINS).filter(([id]) => chainIds.includes(Number(id))).map(([id, chain]) => [chain.name, producers.filter((p) => p.chainId === Number(id)).length])),
      seedNotes: [
        "Seeds are exact addresses from public adapter/API source review captured before this scan.",
        producers.some((p) => p.protocol === "Backed") ? "Backed non-extra adapter addresses are seeded on Ethereum for this first pass; code-present metadata in results indicates which are live on that chain." : null,
        EXTRA_PRODUCER_FILE ? "Additional exact producer seeds were loaded from the configured local artifact file." : null,
      ].filter(Boolean),
      midas: {
        seeded: producers.some((p) => p.protocol === "Midas RWA"),
        notes: producers.some((p) => p.protocol === "Midas RWA")
          ? ["Midas exact token seeds were resolved from prior Euler/Pendle/Silo/Morpho local artifacts, not from non-authoritative logoUrl values."]
          : MIDAS_NON_AUTHORITATIVE_HINTS,
      },
    },
    summary: {
      chainsScanned: results.filter((r) => r.rpcResolved).length,
      chainsMissingRpc: results.filter((r) => !r.rpcResolved).map((r) => r.chain),
      producersInput: producers.length,
      producersResolved: results.reduce((sum, r) => sum + Number(r.producersResolved || 0), 0),
      producersCodePresent: results.reduce((sum, r) => sum + Number(r.producersCodePresent || 0), 0),
      producersWithPublicTokenPrice: results.reduce((sum, r) => sum + Number(r.producersWithPublicTokenPrice || 0), 0),
      producersWithErc4626Nav: results.reduce((sum, r) => sum + Number(r.producersWithErc4626Nav || 0), 0),
      producerAnomalies: results.reduce((sum, r) => sum + Number(r.producerAnomalies || 0), 0),
      matches: results.reduce((sum, r) => sum + Number(r.matches || 0), 0),
      matchBreakdown: mergeBreakdowns(results),
      reviewCandidates: results.reduce((sum, r) => sum + Number(r.reviewCandidates || 0), 0),
      watchCandidates: results.reduce((sum, r) => sum + Number(r.watchCandidates || 0), 0),
      routePositive,
      signedActionJustified: false,
    },
    results,
    nextRoutePositiveCriteria: [
      "Exact RWA/NAV token is accepted as collateral or oracle input with positive LTV/LLTV",
      "Borrow-side liquidity is live and above gas/slippage threshold",
      "Token has positive live supply and a current NAV/reference or consumer oracle value favorable to executable acquisition cost",
      "Permissionless redemption, unrestricted transfer, or executable DEX exit exists for the exact token and size",
      "Fork simulation extracts positive value from the exact joined route",
    ],
  };
  fs.writeFileSync(OUT, JSON.stringify(artifact, jsonReplacer, 2) + "\n");
  console.log(`RWA/NAV consumer graph: producers=${artifact.summary.producersInput} matches=${artifact.summary.matches} review=${artifact.summary.reviewCandidates} watch=${artifact.summary.watchCandidates} routePositive=${artifact.summary.routePositive}`);
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
