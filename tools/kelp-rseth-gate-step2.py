#!/usr/bin/env python3
"""Read-only live gate-check capture for Kelp rsETH step2 (Base + Ethereum).

Answers the step-2 preconditions that step 1 declared:
(A) live rsETH oracle address + cross-chain rate staleness,
(B) live daily mint limit on the V3 pool,
(C) wrapper/pool reserve magnitudes (ETH balances, supplies, fee counters),
(D) implementation slots for proxy binding.
Pure eth_call/eth_getStorageAt/eth_getBalance reads. URLs from the workspace
inventory are never printed. No transactions; no state changes.
"""
import json
import re
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

SEL = json.loads((Path(__file__).with_suffix('.prereqs.json')).read_text(encoding='ascii'))['selectors']
IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'

ETH = {
    'rsETH': '0xA1290d69c65A6Fe4DF752f95823fae25cB99e5A7',
    'LRTConfig': '0x947Cb49334e6571ccBFEF1f1f1178d8469D65ec7',
    'LRTDepositPool': '0x036676389e48133B63a802f8635AD39E752D375D',
    'LRTOracle': '0x349A73444b1a310BAe67ef67973022020d70020d',
    'LRTWithdrawalManager': '0x62De59c08eB5dAE4b7E6F7a8cAd3006d6965ec16',
    'LRTUnstakingVault': '0xc66830E2667bc740c0BED9A71F18B14B8c8184bA',
    'L1VaultForBase': '0x48CdaD4C3c7A2F5818DAb5EB08dF7DB5420a60F6',
    'RSETHRateProvider': '0xF1cccBa5558D31628216489A1435e068b1fd2C8A',
    'RSETHMultiChainRateProvider': '0x0788906B19bA8f8d0e8a7015f0714DF3179D9aB6',
}
BASE = {
    'PoolV3ExternalBridge': '0x291088312150482826b3A37d5A69a4c54DAa9118',
    'wrsETHWrapper': '0xEDfa23602D0EC14714057867A78d01e94176BEA0',
    'BridgedRSETHOFT': '0x1Bc71130A0e39942a7658878169764Bbd8A45993',
    'RSETHRateReceiver': '0x7781ae9B47FeCaCEAeCc4FcA8d0b6187E3eF9ba7',
    'RSETHMultiChainRateReceiverProvider?': None,
}


def log(*a):
    print(*a, flush=True)


def find_rpc_file():
    p = Path(__file__).resolve()
    for parent in [p] + list(p.parents):
        cand = parent / 'rpc_endpoints.txt'
        if cand.is_file():
            return cand
    raise SystemExit('rpc_endpoints.txt not found')


urls = []
for raw_line in find_rpc_file().read_text(encoding='utf-8', errors='replace').splitlines():
    s = raw_line.strip()
    if not s or s[0] in '#/':
        continue
    for u in re.findall(r'https?://\S+', s):
        urls.append(u.rstrip('.,;)>]}"'))


def rpc(u, method, params, timeout=25):
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}).encode()
    req = urllib.request.Request(u, data=body, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        d = json.loads(r.read())
    if 'error' in d:
        raise RuntimeError(json.dumps(d['error']))
    return d['result']


def probe(u):
    t0 = time.time()
    try:
        cid = int(rpc(u, 'eth_chainId', [], 6), 16)
        return (cid, round((time.time() - t0) * 1000), u)
    except Exception:
        return (None, None, u)


with ThreadPoolExecutor(max_workers=12) as ex:
    probed = list(ex.map(probe, urls))
eps_by = {c: sorted([u for cc, ms, u in probed if cc == c], key=lambda u: [ms for cc, ms, uu in probed if u == uu][0]) for c in (1, 8453)}
log('endpoints: eth', len(eps_by[1]), 'base', len(eps_by[8453]))


class Ctl:
    def __init__(self, eps):
        self.eps = eps
        self.lock = threading.Lock()
        self.i = 0
        self.client_cache = {}

    def call(self, method, params):
        last = None
        for _ in range(len(self.eps)):
            with self.lock:
                i = self.i % len(self.eps)
                self.i += 1
            u = self.eps[i]
            try:
                return rpc(u, method, params)
            except Exception as e:
                last = e
        raise last


def capture(chain_tag, eps, targets, callmap, balances):
    ctl = Ctl(eps)
    out = {'chainTag': chain_tag, 'block': None, 'targets': {}}
    out['block'] = int(ctl.call('eth_blockNumber', []), 16)
    for field, to in targets.items():
        d = {}
        try:
            d['impl'] = '0x' + ctl.call('eth_getStorageAt', [to, IMPL_SLOT, 'latest'])[-40:].lower()
        except Exception:
            d['impl'] = None
        if balances:
            try:
                d['ethBalanceWei'] = int(ctl.call('eth_getBalance', [to, 'latest']), 16)
            except Exception:
                d['ethBalanceWei'] = None
        for name in callmap.get(field, []):
            sel = SEL[name]
            try:
                r = ctl.call('eth_call', [{'to': to, 'data': sel}, 'latest'])
                d[name + '@hex'] = r if r and r != '0x' else None
            except Exception:
                d[name + '@hex'] = None
        out['targets'][field] = {'address': to, **d}
    return out, ctl


pool_calls = ['rsETHOracle()', 'dailyMintLimit()', 'dailyMintAmount()', 'lastMintDay()', 'feeBps()',
              'paused()', 'wrsETH()', 'l1VaultETHForL2Chain()', 'stargatePool()', 'dstLzChainId()',
              'l2Bridge()', 'messenger()']
receiver_calls = ['rate()', 'lastUpdated()', 'srcChainId()', 'rateProvider()', 'layerZeroEndpoint()', 'rateInfo()']
wrapper_calls = ['totalSupply()', 'getRate()']
oft_calls = ['totalSupply()']
oracle_calls = ['rsETHPrice()', 'pricePercentageLimit()', 'highestRsethPrice()', 'paused()']
token_calls = ['totalSupply()']
provider_calls = ['getRate()', 'rate()', 'lastUpdated()']

b_targets = {
    'PoolV3ExternalBridge': BASE['PoolV3ExternalBridge'],
    'wrsETHWrapper': BASE['wrsETHWrapper'],
    'BridgedRSETHOFT': BASE['BridgedRSETHOFT'],
    'RSETHRateReceiver': BASE['RSETHRateReceiver'],
}
calls_b = {
    'PoolV3ExternalBridge': pool_calls,
    'wrsETHWrapper': wrapper_calls,
    'BridgedRSETHOFT': oft_calls,
    'RSETHRateReceiver': receiver_calls,
}
eth_targets = {
    'rsETH': ETH['rsETH'],
    'LRTOracle': ETH['LRTOracle'],
    'LRTWithdrawalManager': ETH['LRTWithdrawalManager'],
    'LRTUnstakingVault': ETH['LRTUnstakingVault'],
    'L1VaultForBase': ETH['L1VaultForBase'],
    'RSETHRateProvider': ETH['RSETHRateProvider'],
    'RSETHMultiChainRateProvider': ETH['RSETHMultiChainRateProvider'],
}
calls_e = {
    'rsETH': token_calls,
    'LRTOracle': oracle_calls,
    'LRTWithdrawalManager': [],
    'LRTUnstakingVault': [],
    'L1VaultForBase': ['totalSupply()'],
    'RSETHRateProvider': provider_calls,
    'RSETHMultiChainRateProvider': provider_calls,
}

base_out, _ = capture('base(8453)', eps_by[8453], b_targets, calls_b, balances=True)
eth_out, _ = capture('eth(1)', eps_by[1], eth_targets, calls_e, balances=True)

out = {'captureAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'base': base_out, 'eth': eth_out}
Path(__file__).with_suffix('.snapshot.json').write_text(json.dumps(out, indent=2), encoding='ascii')

# compact human-readable decode of the decisive fields
dec = base_out['targets']['PoolV3ExternalBridge']['rsETHOracle()@hex']
oracle = '0x' + dec[-40:] if dec else None
log('POOL.rsETHOracle:', oracle)
for f in ['dailyMintLimit()', 'dailyMintAmount()', 'lastMintDay()', 'feeBps()', 'paused()']:
    h = base_out['targets']['PoolV3ExternalBridge'].get(f + '@hex')
    log('POOL.' + f, int(h, 16) if h else None)
recv = base_out['targets']['RSETHRateReceiver']
for f in ['rate()', 'lastUpdated()', 'srcChainId()']:
    h = recv.get(f + '@hex')
    log('RECEIVER.' + f, int(h, 16) if h else None)
log('RECEIVER.rateProvider/endpoint', recv.get('rateProvider()@hex')[-40:] if recv.get('rateProvider()@hex') else None,
    recv.get('layerZeroEndpoint()@hex')[-40:] if recv.get('layerZeroEndpoint()@hex') else None)
log('RECEIVER.rateInfo.hex', recv.get('rateInfo()@hex'))
log('WRAPPER.ethBalance', base_out['targets']['wrsETHWrapper'].get('ethBalanceWei'),
    'totalSupply(hex)', base_out['targets']['wrsETHWrapper'].get('totalSupply()@hex'))
log('POOL.ethBalance', base_out['targets']['PoolV3ExternalBridge'].get('ethBalanceWei'))
log('OFT.ethBalance', base_out['targets']['BridgedRSETHOFT'].get('ethBalanceWei'))
oracle_price = eth_out['targets']['LRTOracle'].get('rsETHPrice()@hex')
log('ETH LRTOracle.rsETHPrice', int(oracle_price, 16) if oracle_price else None,
    'pctLimit(h)', eth_out['targets']['LRTOracle'].get('pricePercentageLimit()@hex'),
    'highest(h)', eth_out['targets']['LRTOracle'].get('highestRsethPrice()@hex'),
    'paused(h)', eth_out['targets']['LRTOracle'].get('paused()@hex'))
prov = eth_out['targets']['RSETHRateProvider']
log('ETH RateProvider getRate(hex)', prov.get('getRate()@hex'),
    'rate(hex)', prov.get('rate()@hex'), 'lastUpdated(hex)', prov.get('lastUpdated()@hex'), 'ethWei', prov.get('ethBalanceWei'))
for k, t in list(base_out['targets'].items()) + list(eth_out['targets'].items()):
    log('impl', k, t.get('impl'))
log('snapshot file written')
