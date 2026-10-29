#!/usr/bin/env python3
"""Read-only step-2 pre-reads for the Venus Core step-1 candidates (chainId 56).

S1: read each live vToken market's implementation() pointer and compare with
    the at-pin deployment artifacts in the v10.3.0 worktree. If any live
    vToken points to a legacy R1-era implementation, the borrower-less
    liquidation-selector concern is live-strengthened; otherwise collapsed.
S2: read getAllMarkets + markets(vToken) + totalBorrows() per market. Any
    market with listed=false and nonzero totalBorrows is an S2 hint.
Pure eth_call reads. URLs from the workspace inventory, never printed.
No transactions, no state changes.
"""
import json
import re
import threading
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

SEL = json.loads((Path('tools/venus-core-step2-prereads.prereqs.json')).read_text(encoding='ascii'))['selectors']
UNITROLLER = '0xfD36E2c2a6789Db23113685031d7F16329158384'
WORKTREE = Path('targets/venus-protocol-v10.3.0')


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


def ethcall(to, data):
    try:
        r = call('eth_call', [{'to': to, 'data': data}, 'latest'])
        return r if r and r != '0x' else None
    except Exception:
        return None


def addr_array(hexstr):
    if not hexstr:
        return []
    b = bytes.fromhex(hexstr[2:])
    out = []
    i = 64
    end = min(len(b), 64 + int.from_bytes(b[32:64], 'big') * 32)
    while i + 32 <= end:
        out.append('0x' + b[i:i + 32][-20:].hex())
        i += 32
    return out


def uint_word(hexstr, idx=None):
    if not hexstr:
        return None
    b = bytes.fromhex(hexstr[2:])
    if idx is None:
        return int.from_bytes(b[-32:], 'big')
    return None


blk = int(call('eth_blockNumber', []), 16)
log('latest BNB block:', blk)

all_markets = addr_array(ethcall(UNITROLLER, SEL['getAllMarkets()']))
log('getAllMarkets count:', len(all_markets))

last_pool = uint_word(ethcall(UNITROLLER, SEL['lastPoolId()']))
pool_map = {}
for pid in range(1, (last_pool or 0) + 1):
    try:
        vts = addr_array(ethcall(UNITROLLER, SEL['getPoolVTokens(uint96)'] + hex(pid)[2:].rjust(64, '0')))
    except Exception:
        vts = []
    pool_map[pid] = vts
log('lastPoolId:', last_pool, 'pool vToken lists captured')

per_market = {}
for mkt in all_markets:
    raw_fields = ethcall(UNITROLLER, SEL['markets(address)'] + mkt[2:].rjust(64, '0'))
    raw_borrows = uint_word(ethcall(mkt, SEL['totalBorrows()']))
    imp = ethcall(mkt, SEL['implementation()'])
    pend = ethcall(mkt, SEL['pendingImplementation()'])
    words = []
    if raw_fields:
        b = bytes.fromhex(raw_fields[2:])
        words = [int.from_bytes(b[i:i + 32], 'big') for i in range(0, len(b) // 32 * 32, 32)]
    per_market[mkt] = {
        'marketsRaw': words,
        'isListed': words[0] == 1 if words else None,
        'cf': words[1] if len(words) > 1 else None,
        'lt': words[2] if len(words) > 2 else None,
        'liquidationIncentiveMantissa': words[3] if len(words) > 3 else None,
        'totalBorrows': raw_borrows,
        'implementation': '0x' + imp[2:][-40:].lower() if imp else None,
        'pendingImplementation': '0x' + pend[2:][-40:].lower() if pend else None,
    }
    log(json.dumps({'market': mkt, **per_market[mkt]}))

# which pools list each market (for per-pool LI collation later)
for name, vts in pool_map.items():
    log('pool', name, 'vTokens:', vts)

out = {'block': blk, 'allMarkets': all_markets, 'lastPoolId': last_pool,
       'pools': {str(p): v for p, v in pool_map.items()},
       'perMarket': per_market}
Path('tools/venus-core-step2-prereads.snapshot.json').write_text(
    json.dumps(out, indent=2), encoding='ascii')
log('snapshot file written')
