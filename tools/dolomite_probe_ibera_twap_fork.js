#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { ethers } = require('C:/Users/MiPC/AppData/Local/Temp/opencode/node_modules/ethers');
const solc = require('C:/_Work/__EVM_AUDIT/targets/dolomite-margin-modules/node_modules/solc');

const ROOT = path.resolve(__dirname, '..');
const MAP_FILE = path.join(ROOT, 'reports', 'raw', 'dolomite-berachain-live-map.json');
const OUT_FILE = path.join(ROOT, 'reports', 'raw', 'dolomite-berachain-ibera-twap-fork-probe.json');
const CHAIN_ID = 80094;
const PORT = 18545;
const FORK_RPC = `http://127.0.0.1:${PORT}`;
const MIN_SQRT_RATIO_PLUS_ONE = '4295128740';

const SOURCE = `
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.15;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IPoolLike {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data) external returns (int256 amount0, int256 amount1);
}

contract V3PoolSwapper {
    function swapExactInput(address pool, bool zeroForOne, uint256 amountIn, uint160 sqrtPriceLimitX96) external {
        IPoolLike(pool).swap(address(this), zeroForOne, int256(amountIn), sqrtPriceLimitX96, abi.encode(pool));
    }

    function pancakeV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        _pay(amount0Delta, amount1Delta, data);
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        _pay(amount0Delta, amount1Delta, data);
    }

    function algebraSwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        _pay(amount0Delta, amount1Delta, data);
    }

    function recover(address token, address to) external {
        IERC20(token).transfer(to, IERC20(token).balanceOf(address(this)));
    }

    function _pay(int256 amount0Delta, int256 amount1Delta, bytes calldata data) internal {
        address pool = abi.decode(data, (address));
        require(msg.sender == pool, "bad pool");
        if (amount0Delta > 0) IERC20(IPoolLike(pool).token0()).transfer(pool, uint256(amount0Delta));
        if (amount1Delta > 0) IERC20(IPoolLike(pool).token1()).transfer(pool, uint256(amount1Delta));
    }
}
`;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
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

async function chooseRpcUrl() {
  let lastError;
  for (const url of rpcCandidates()) {
    try {
      const provider = new ethers.providers.JsonRpcProvider(url, { chainId: CHAIN_ID, name: 'berachain' });
      const network = await provider.getNetwork();
      if (Number(network.chainId) !== CHAIN_ID) throw new Error(`unexpected chain ${network.chainId}`);
      await provider.getBlockNumber();
      return url;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`No working Berachain RPC candidate (${lastError ? lastError.message : 'unknown error'})`);
}

function compile() {
  const input = {
    language: 'Solidity',
    sources: { 'V3PoolSwapper.sol': { content: SOURCE } },
    settings: { outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter((e) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
  const artifact = output.contracts['V3PoolSwapper.sol'].V3PoolSwapper;
  return { abi: artifact.abi, bytecode: `0x${artifact.evm.bytecode.object}` };
}

async function waitForRpc(provider) {
  const anvilState = waitForRpc.anvilState;
  for (let i = 0; i < 60; i++) {
    if (anvilState && anvilState.exited) {
      throw new Error(`anvil exited before startup: ${anvilState.stderr}`);
    }
    try {
      await provider.getBlockNumber();
      return;
    } catch (_err) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error('anvil did not start');
}

function sanitize(text) {
  return String(text || '').replace(/https?:\/\/[^\s"']+/g, '[redacted-url]');
}

function amountHuman(value, decimals = 18) {
  return ethers.utils.formatUnits(value, decimals);
}

async function main() {
  const map = readJson(MAP_FILE);
  const market = map.markets.find((m) => m.marketId === 33);
  const route = map.oracleRoutes['33'][0];
  const pool = route.details.twap.pair;
  const wbera = route.details.twap.pairDetails.token0;
  const ibera = route.details.twap.pairDetails.token1;
  const oracle = route.oracle;
  const forkBlock = process.env.PIN_FORK_BLOCK === 'true' ? map.block.number : null;
  const rpcUrl = await chooseRpcUrl();
  const compiled = compile();

  const anvilArgs = [
    '--fork-url', rpcUrl,
    '--port', String(PORT),
    '--silent',
  ];
  if (forkBlock !== null) anvilArgs.splice(2, 0, '--fork-block-number', String(forkBlock));
  const anvil = spawn('anvil', anvilArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  const anvilState = { exited: false, stderr: '' };
  waitForRpc.anvilState = anvilState;
  anvil.stderr.on('data', (chunk) => { anvilState.stderr += sanitize(chunk.toString()); });
  anvil.stdout.on('data', (chunk) => { anvilState.stderr += sanitize(chunk.toString()); });
  anvil.on('exit', (code, signal) => {
    anvilState.exited = true;
    anvilState.stderr += ` exit=${code} signal=${signal}`;
  });

  const provider = new ethers.providers.JsonRpcProvider(FORK_RPC, { chainId: CHAIN_ID, name: 'berachain-fork' });
  try {
    await waitForRpc(provider);
    const [signer] = await provider.listAccounts();
    const wallet = provider.getSigner(signer);
    const wberaContract = new ethers.Contract(wbera, [
      'function deposit() payable',
      'function transfer(address to,uint256 amount) returns (bool)',
      'function balanceOf(address account) view returns (uint256)',
    ], wallet);
    const iberaContract = new ethers.Contract(ibera, ['function balanceOf(address account) view returns (uint256)'], wallet);
    const oracleContract = new ethers.Contract(oracle, ['function getPrice(address token) view returns (tuple(uint256 value))'], wallet);
    const core = new ethers.Contract(map.addresses.DolomiteMargin, ['function getMarketPrice(uint256 marketId) view returns (tuple(uint256 value))'], wallet);

    const factory = new ethers.ContractFactory(compiled.abi, compiled.bytecode, wallet);
    const amounts = ['5000', '20000', '50000'];
    const rows = [];

    for (const amount of amounts) {
      const forking = forkBlock === null ? { jsonRpcUrl: rpcUrl } : { jsonRpcUrl: rpcUrl, blockNumber: forkBlock };
      await provider.send('anvil_reset', [{ forking }]);
      await provider.send('anvil_setBalance', [signer, '0x152d02c7e14af6800000']); // 100000 BERA

      const swapper = await factory.deploy();
      await swapper.deployed();

      const amountIn = ethers.utils.parseEther(amount);
      const beforeOracle = await oracleContract.getPrice(ibera);
      const beforeMarketPrice = await core.getMarketPrice(33);
      const beforeIBera = await iberaContract.balanceOf(swapper.address);
      await (await wberaContract.deposit({ value: amountIn })).wait();
      await (await wberaContract.transfer(swapper.address, amountIn)).wait();

      let swapError = null;
      try {
        await (await swapper.swapExactInput(pool, true, amountIn, MIN_SQRT_RATIO_PLUS_ONE, { gasLimit: 5_000_000 })).wait();
      } catch (err) {
        swapError = err.reason || err.message;
      }

      const afterSwapIBera = await iberaContract.balanceOf(swapper.address);
      const immediateOracle = await oracleContract.getPrice(ibera).catch((err) => ({ error: err.reason || err.message }));
      await provider.send('evm_increaseTime', [901]);
      await provider.send('evm_mine', []);
      const afterOracle = await oracleContract.getPrice(ibera).catch((err) => ({ error: err.reason || err.message }));
      const afterMarketPrice = await core.getMarketPrice(33).catch((err) => ({ error: err.reason || err.message }));

      rows.push({
        amountInWbera: amount,
        swapError,
        iberaReceived: amountHuman(afterSwapIBera.sub(beforeIBera)),
        beforeOracleRaw: beforeOracle.value.toString(),
        immediateOracleRaw: immediateOracle.error ? immediateOracle : immediateOracle.value.toString(),
        after15mOracleRaw: afterOracle.error ? afterOracle : afterOracle.value.toString(),
        beforeMarketPriceRaw: beforeMarketPrice.value.toString(),
        after15mMarketPriceRaw: afterMarketPrice.error ? afterMarketPrice : afterMarketPrice.value.toString(),
      });
    }

    const out = {
      generatedAt: new Date().toISOString(),
      forkBlock: forkBlock === null ? 'latest' : forkBlock,
      market: { marketId: 33, symbol: market.tokenInfo.symbol, token: market.token },
      pool,
      wbera,
      ibera,
      oracle,
      rows,
    };
    fs.writeFileSync(OUT_FILE, `${JSON.stringify(out, null, 2)}\n`);
    console.log(`wrote ${path.relative(ROOT, OUT_FILE)} with ${rows.length} swap probes`);
  } finally {
    anvil.kill();
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
