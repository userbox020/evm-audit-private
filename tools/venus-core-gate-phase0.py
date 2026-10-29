#!/usr/bin/env python3
"""Read-only Venus Core Pool Phase-0 gate check (chainId 56).

Questions: (1) which implementation is live at the Unitroller proxy
(EIP-1967 slot read; compare with the two conflicting published candidates),
(2) is the live Comptroller a Diamond (facetAddresses() succeeds) and what is
its facet surface, (3) per-vToken binding: beacon vs direct implementation,
comptroller() cross-check, and representative market state (reserve factor,
accrual block number, total reserves/borrows, interest model), (4) paused
state + pause guardian on the Comptroller. Pure eth_call / eth_getStorageAt
reads; URLs from the workspace inventory, never printed. No transactions.
"""
import json
import re
import threading
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

SEL = json.loads((Path(__file__).with_suffix('.prereqs.json')).read_text(encoding='ascii'))['selectors']
IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
BEACON_SLOT = '0xa3f0ad74e542316eb7e85d0e56e2c7e683e5321b4004d4359b8435351b7ac74'

UNITROLLER = '0xfD36E2c2a6789Db23113685031d7F16329158384'
VTOKENS = {
    'vBNB': '0xA07c5b74C9B40447a954e1466938b865b6BBea36',
    'vUSDC': '0xecA88125a5ADbe82614ffC12D0DB554E2e2867C8',
    'vUSDT': '0xfD5840Cd36d94D7229439859C0112a4185BC0255',
}
PUBLISHED_CANDIDATES = ['0xa66b2b5d50ce68a125bbad6b2265b637868c6e66',
                        '0xad69aa3811fe0ee7dbd4e25c4bae40e6422c76c8']


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
    try:
        return int(rpc(u, 'eth_chainId', [], 6), 16)
    except Exception:
        return None


with ThreadPoolExecutor(max_workers=10) as ex:
    cids = list(ex.map(probe, urls))
eps = [u for u, c in zip(urls, cids) if c == 56]
log('working BNB endpoints:', len(eps))
lk = threading.Lock()
ri = [0]


def call(method, params):
    last = None
    for _ in range(len(eps)):
        with lk:
            i = ri[0] % len(eps)
            ri[0] += 1
        try:
            return rpc(eps[i], method, params)
        except Exception as e:
            last = e
    raise last


def sl(a, slot):
    try:
        r = call('eth_getStorageAt', [a, slot, 'latest'])
        return '0x' + r[-40:].lower()
    except Exception:
        return None


def callnamed(to, name):
    try:
        r = call('eth_call', [{'to': to, 'data': SEL[name]}, 'latest'])
        return r if r and r != '0x' else None
    except Exception:
        return None


def uint(hexstr):
    if not hexstr:
        return None
    b = bytes.fromhex(hexstr[2:])
    return int.from_bytes(b[-32:], 'big')


def word20(hexstr):
    return '0x' + hexstr[2:][-40:].lower() if hexstr else None


blk = int(call('eth_blockNumber', []), 16)
log('latest BNB block:', blk)

out = {'block': blk, 'unitrollerProxy': UNITROLLER}
out['implSlotRead'] = sl(UNITROLLER, IMPL_SLOT)
out['implMatchesPublished'] = out['implSlotRead'] in PUBLISHED_CANDIDATES
fa = callnamed(UNITROLLER, 'facetAddresses()')
if fa:
    b = bytes.fromhex(fa[2:])
    # ABI: offset(32) len(32) then len*32 bytes of addresses
    if len(b) >= 64:
        n = int.from_bytes(b[32:64], 'big')
        addrs = ['0x' + b[64 + i * 32 - 12:64 + (i + 1) * 32 - 22][-20:].hex() for i in range(0, 0)]  # placeholder
        addrs = []
        for i in range(n):
            w = b[64 + i * 32:64 + (i + 1) * 32]
            addrs.append('0x' + w[-20:].hex())
        out['isDiamond'] = True
        out['facetAddresses'] = addrs
    else:
        out['isDiamond'] = False
else:
    out['isDiamond'] = False
pg = uint(callnamed(UNITROLLER, 'pauseGuardian()'))
out['pauseGuardian'] = '0x%040x' % pg if pg is not None else None
out['comptrollerPaused'] = uint(callnamed(UNITROLLER, 'paused()'))
log(json.dumps(out, indent=1))

vout = {}
for name, addr in VTOKENS.items():
    beacon_slot = sl(addr, BEACON_SLOT)
    impl_slot = sl(addr, IMPL_SLOT)
    beacon_set = None if beacon_slot in (None, None) else (beacon_slot != '0x' + '00' * 20)
    beacon_impl = None
    if beacon_set:
        bi = callnamed(beacon_slot, 'implementation()')
        beacon_impl = word20(bi)
    vout[name] = {
        'address': addr,
        'beaconAddress': None if not beacon_set else beacon_slot,
        'beaconImplementation': beacon_impl,
        'directImplSlot': None if not beacon_set else impl_slot,
        'comptroller': word20(callnamed(addr, 'comptroller()') or ''),
        'interestRateModel': word20(callnamed(addr, 'interestRateModel()') or ''),
        'reserveFactorMantissa': uint(callnamed(addr, 'reserveFactorMantissa()')),
        'totalReserves': uint(callnamed(addr, 'totalReserves()')),
        'totalBorrows': uint(callnamed(addr, 'totalBorrows()')),
        'accrualBlockNumber': uint(callnamed(addr, 'accrualBlockNumber()')),
    }
    log(name, json.dumps(vout[name]))

Path(__file__).with_suffix('.snapshot.json').write_text(
    json.dumps(out | {'vtokens': vout}, indent=2), encoding='ascii')
log('snapshot file written')
