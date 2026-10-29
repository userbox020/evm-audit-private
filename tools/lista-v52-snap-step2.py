#!/usr/bin/env python3
"""Read-only live-configuration snapshot for Lista v5.2 step2 (chainId 56).

Collects contract code sizes, whitelist modes, core state (Vat/Jug/Dog/Vow),
per-collateral clipper state and linkage (ilk/dog/vat/spotter/buf/tail/cusp/
chip/tip/chost/stopped/kicks), EIP-1967 implementation slots with
AuctionProxy-literal containment in both proxy and implementation bytecode,
and per-ilk Vat/Dog/Jug/Spot configuration rows. Pure eth_call/eth_getCode/
eth_getStorageAt reads; URLs come from the workspace inventory and are never
printed. No transactions, no state changes.
"""
import json
import re
import threading
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO = None
for parent in [ROOT] + list(ROOT.parents):
    cand = parent / 'targets' / 'lista-dao-contracts-v5.2'
    if cand.is_dir():
        REPO = cand
        break
if REPO is None:
    raise SystemExit('lista checkout not found')
ADDR = REPO / 'addresses'
SEL = json.loads((ROOT / 'tools' / 'lista-v52-snap-step2.prereqs.json').read_text(encoding='ascii'))['selectors']

CORE = {
    'Interaction': '0xB68443Ee3e828baD1526b3e0Bdf2Dfc6b1975ec4',
    'Vat': '0x33A34eAB3ee892D40420507B820347b1cA2201c4',
    'Jug': '0x787BdEaa29A253e40feB35026c3d05C18CbCA7B3',
    'Dog': '0xd57E7b53a1572d27A04d9c1De2c4D423f1926d0B',
    'Vow': '0x2078A1969Ea581D618FDBEa2C0Dc13Fc15CB9fa7',
    'Spotter': '0x49bc2c4E5B035341b7d92Da4e6B267F7426F3038',
    'AuctionProxyLib': '0x272d6589CEcC19165cfCd0466f73A648cb1Ea700',
    'GenericCLIP': '0x2dcFb02CE33955b6Cc0aF34033189DE3ac4C0292',
    'ABACI': '0xc1359eD77E6B0CBF9a8130a4C28FBbB87B9501b7',
}
IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
AUPROXY_LIB = bytes.fromhex('272d6589cecc19165cfcd0466f73a648cb1ea700')


def log(*a):
    print(*a, flush=True)


def selof(name):
    return SEL[name] if name in SEL else SEL[name + '()']


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


with ThreadPoolExecutor(max_workers=12) as ex:
    cids = list(ex.map(probe, urls))
eps = [u for u, c in zip(urls, cids) if c == 56]
log('working BSC endpoints:', len(eps))
if not eps:
    raise SystemExit('no chain-56 endpoints')
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


def ethcall(to, data_hex):
    try:
        r = call('eth_call', [{'to': to, 'data': data_hex}, 'latest'])
        return r if r and r != '0x' else None
    except Exception:
        return None


def callnamed(to, name):
    return ethcall(to, selof(name))


def uint(to, name):
    d = callnamed(to, name)
    return int.from_bytes(bytes.fromhex(d[2:]), 'big') if d else None


def word20(to, name):
    d = callnamed(to, name)
    return '0x' + d[2:][-40:].lower() if d else None


def code_bytes(a):
    try:
        return len(call('eth_getCode', [a, 'latest'])) // 2 - 1
    except Exception:
        return -1


def code_of(a):
    try:
        return bytes.fromhex(call('eth_getCode', [a, 'latest'])[2:])
    except Exception:
        return None


def impl_of(a):
    try:
        r = call('eth_getStorageAt', [a, IMPL_SLOT, 'latest'])
        return '0x' + r[-40:].lower()
    except Exception:
        return None


blk = int(call('eth_blockNumber', []), 16)
log('latest BSC block:', blk)

collaterals = []
for f in sorted(ADDR.glob('new_collateral_*_bsc.json')):
    j = json.loads(f.read_text(encoding='utf-8'))
    if not j.get('clipper'):
        log('registry without clipper:', f.name)
        continue
    ilk_hex = j['ilk']
    ilk_hex = ilk_hex[2:] if ilk_hex.lower().startswith('0x') else ilk_hex
    collaterals.append({'file': f.name, 'symbol': j['symbol'], 'ilkHex': '0x' + ilk_hex,
                        'ilkName': bytes.fromhex(ilk_hex).rstrip(b'\x00').decode('ascii', 'replace'),
                        'clipper': j['clipper'], 'gemJoin': j.get('gemJoin'), 'oracle': j.get('oracle'),
                        'localImpl': j.get('clipperImplementation')})
log('collateral rows:', len(collaterals))

print('=== core snapshot ===')
all_addrs = list(CORE.items()) + [(c['symbol'], c['clipper']) for c in collaterals]
with ThreadPoolExecutor(max_workers=8) as ex:
    lens = dict(zip([k for k, _ in all_addrs], ex.map(lambda kv: code_bytes(kv[1]), all_addrs)))
    impls = dict(zip([k for k, _ in all_addrs], ex.map(lambda kv: impl_of(kv[1]), all_addrs)))


def lib_in_code(a):
    code = code_of(a)
    return None if code is None else (AUPROXY_LIB in code)


with ThreadPoolExecutor(max_workers=8) as ex:
    impl_codes = dict(zip([k for k, _ in all_addrs], ex.map(lambda kv: lib_in_code(impls[kv[0]]) if impls[kv[0]] and impls[kv[0]] != '0x0000000000000000000000000000000000000000' else None, all_addrs)))
    proxy_codes = dict(zip([k for k, _ in all_addrs], ex.map(lambda kv: lib_in_code(kv[1]), all_addrs)))
core_out = {}
for k, a in CORE.items():
    core_out[k] = {'address': a, 'codeBytes': lens[k], 'impl': impls[k],
                   'implHasAuproxyLiteral': impl_codes[k], 'proxyHasAuproxyLiteral': proxy_codes[k]}
log(json.dumps(core_out, indent=1))

print('=== core state ===')
state = {
    'interactionWhitelistMode': uint(CORE['Interaction'], 'whitelistMode'),
    'interactionAuctionWhitelistMode': uint(CORE['Interaction'], 'auctionWhitelistMode'),
    'dogLive': uint(CORE['Dog'], 'live'), 'dogHole': uint(CORE['Dog'], 'Hole'),
    'dogDirt': uint(CORE['Dog'], 'Dirt'), 'vatLive': uint(CORE['Vat'], 'live'),
    'jugBase': uint(CORE['Jug'], 'base'),
    'vowSin': uint(CORE['Vow'], 'Sin'), 'vowAsh': uint(CORE['Vow'], 'Ash'),
    'vowWait': uint(CORE['Vow'], 'wait'), 'vowDump': uint(CORE['Vow'], 'dump'),
    'vowSump': uint(CORE['Vow'], 'sump'),
}
log(json.dumps(state, indent=1))

print('=== per-collateral clipper snapshot ===')
rows = []
for c in collaterals:
    a = c['clipper']
    ilk_ret = callnamed(a, 'ilk()')
    rows.append({
        'symbol': c['symbol'], 'clipper': a, 'codeBytes': lens[c['symbol']],
        'impl': impls[c['symbol']], 'localImpl': c['localImpl'], 'implImplMatch': str(impls[c['symbol']]).lower() == str(c['localImpl']).lower(),
        'ilkOnchainEmptyTail': '0x' + (ilk_ret[2:].rstrip('0') if ilk_ret else ''),
        'ilkMatchesRegistry': (ilk_ret is not None and ilk_ret[2:].lower() == c['ilkHex'][2:].lower()),
        'ilkName': c['ilkName'],
        'dog': word20(a, 'dog'), 'vat': word20(a, 'vat'), 'vow': word20(a, 'vow'), 'spotter': word20(a, 'spotter'),
        'buf': uint(a, 'buf'), 'tail': uint(a, 'tail'), 'cusp': uint(a, 'cusp'),
        'chip': uint(a, 'chip'), 'tip': uint(a, 'tip'), 'chost': uint(a, 'chost'),
        'kicks': uint(a, 'kicks'), 'stopped': uint(a, 'stopped'),
        'implHasAuproxyLiteral': impl_codes[c['symbol']], 'proxyHasAuproxyLiteral': proxy_codes[c['symbol']],
    })
    log(json.dumps(rows[-1]))

print('=== per-ilk vat/dog/jug/spot config ===')


def words32(hexstr):
    if not hexstr:
        return []
    b = bytes.fromhex(hexstr[2:])
    return [int.from_bytes(b[i:i + 32], 'big') for i in range(0, len(b) // 32 * 32, 32)]


ilk_rows = []
for c in collaterals:
    pad = c['ilkHex'][2:]
    chop_ret = ethcall(CORE['Dog'], SEL['chop(bytes32)'] + pad)
    ilk_rows.append({
        'symbol': c['symbol'],
        'vatIlks': words32(ethcall(CORE['Vat'], SEL['ilks(bytes32)'] + pad)),
        'dogIlks': words32(ethcall(CORE['Dog'], SEL['ilks(bytes32)'] + pad)),
        'jugIlks': words32(ethcall(CORE['Jug'], SEL['ilks(bytes32)'] + pad)),
        'spotIlks': words32(ethcall(CORE['Spotter'], SEL['ilks(bytes32)'] + pad)),
        'dogChop': words32(chop_ret)[-1] if chop_ret else None,
    })
for r in ilk_rows:
    log(json.dumps(r))

Path(__file__).with_suffix('.snapshot.json').write_text(
    json.dumps({'block': blk, 'core': core_out, 'state': state, 'clippers': rows, 'ilkConfig': ilk_rows}, indent=2),
    encoding='ascii')
log('snapshot file written')
