#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const { ethers } = require('C:/Users/MiPC/AppData/Local/Temp/opencode/node_modules/ethers');

const ROOT = path.resolve(__dirname, '..');
const LIVE_MAP = path.join(ROOT, 'reports', 'raw', 'etherfi-cash-live-map.json');
const OUT_FILE = path.join(ROOT, 'reports', 'raw', 'etherfi-cash-token-behavior-probe.json');
const FORK_RPC = process.env.FORK_RPC || 'http://127.0.0.1:8545';
const ZERO = '0x0000000000000000000000000000000000000000';
const RECIPIENT = '0x000000000000000000000000000000000000dEaD';

const erc20Abi = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function asHexQuantity(value) {
  return ethers.BigNumber.from(value).toHexString();
}

function formatAmount(value, decimals) {
  try {
    return ethers.utils.formatUnits(value, decimals);
  } catch (_) {
    return value.toString();
  }
}

async function rawTransferReturn(provider, token, from, recipient, amount) {
  const iface = new ethers.utils.Interface(erc20Abi);
  const data = iface.encodeFunctionData('transfer', [recipient, amount]);
  try {
    const ret = await provider.call({ to: token, from, data });
    if (ret === '0x') return { status: 'ok', return: 'no-return' };
    if ((ret.length - 2) / 2 === 32) {
      return { status: 'ok', return: ethers.BigNumber.from(ret).isZero() ? 'false' : 'true', raw: ret };
    }
    return { status: 'ok', return: 'non-standard', raw: ret };
  } catch (err) {
    return { status: 'revert', error: err.reason || err.message };
  }
}

async function main() {
  const live = readJson(LIVE_MAP);
  const provider = new ethers.providers.JsonRpcProvider(FORK_RPC);

  const moduleNames = ['EtherFiLiquidModule', 'FraxModule', 'StargateModule'];
  const moduleEthBalances = {};
  for (const name of moduleNames) {
    const address = live.addresses[name];
    moduleEthBalances[name] = {
      address,
      ethBalance: (await provider.getBalance(address)).toString(),
    };
  }

  const borrowTokens = live.tokens.filter((token) => token.debt && token.debt.isBorrow);
  const tokenResults = [];

  for (const row of borrowTokens) {
    const token = row.address;
    const contract = new ethers.Contract(token, erc20Abi, provider);
    const decimals = row.decimals;
    const candidates = [
      live.addresses.DebtManager,
      live.addresses.TopUpDest,
      live.addresses.CashModule,
      ...Object.values(row.settlementRecipients || {}).filter((addr) => addr && addr !== ZERO),
    ];

    let holder = null;
    let holderBalance = ethers.BigNumber.from(0);
    for (const candidate of [...new Set(candidates)]) {
      try {
        const bal = await contract.balanceOf(candidate);
        if (bal.gt(0)) {
          holder = candidate;
          holderBalance = bal;
          break;
        }
      } catch (_) {
        // Skip non-ERC20 or broken balanceOf candidates.
      }
    }

    const zeroReturn = await rawTransferReturn(provider, token, holder || live.addresses.TopUpDest, RECIPIENT, 0);
    const result = {
      symbol: row.erc20Symbol || row.configuredSymbol,
      token,
      decimals,
      isBorrow: true,
      totalBorrowingAmount: row.debt.totalBorrowingAmount,
      totalSupplies: row.debt.totalSupplies,
      selectedHolder: holder,
      selectedHolderBalance: holderBalance.toString(),
      zeroTransferReturn: zeroReturn,
      amountTransferReturn: null,
      transferDelta: null,
      verdict: null,
    };

    if (!holder) {
      result.verdict = 'no-live-holder-found-for-fee-test';
      tokenResults.push(result);
      continue;
    }

    const oneUnit = ethers.BigNumber.from(10).pow(Math.min(decimals, 18));
    const amount = holderBalance.lt(oneUnit) ? holderBalance : oneUnit;
    result.amountTransferReturn = await rawTransferReturn(provider, token, holder, RECIPIENT, amount);

    await provider.send('anvil_impersonateAccount', [holder]);
    await provider.send('anvil_setBalance', [holder, asHexQuantity(ethers.utils.parseEther('10'))]);

    const signer = provider.getSigner(holder);
    const beforeHolder = await contract.balanceOf(holder);
    const beforeRecipient = await contract.balanceOf(RECIPIENT);

    try {
      const tx = await contract.connect(signer).transfer(RECIPIENT, amount, { gasLimit: 1_000_000 });
      const receipt = await tx.wait();
      const afterHolder = await contract.balanceOf(holder);
      const afterRecipient = await contract.balanceOf(RECIPIENT);
      const spent = beforeHolder.sub(afterHolder);
      const received = afterRecipient.sub(beforeRecipient);
      result.transferDelta = {
        status: receipt.status,
        amount: amount.toString(),
        amountFormatted: formatAmount(amount, decimals),
        holderSpent: spent.toString(),
        recipientReceived: received.toString(),
        recipientReceivedFormatted: formatAmount(received, decimals),
      };
      result.verdict = spent.eq(amount) && received.eq(amount) ? 'vanilla-transfer' : 'fee-or-rebase-transfer';
    } catch (err) {
      result.transferDelta = { status: 'revert', error: err.reason || err.message };
      result.verdict = 'transfer-reverted-on-fork';
    }

    await provider.send('anvil_stopImpersonatingAccount', [holder]);
    tokenResults.push(result);
  }

  const output = {
    forkRpc: FORK_RPC,
    blockNumber: await provider.getBlockNumber(),
    moduleEthBalances,
    tokenResults,
  };

  fs.writeFileSync(OUT_FILE, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
