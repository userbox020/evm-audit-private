'use strict';

// Offline clock and template fixtures only. No browser, server, RPC, collection,
// wallet file, or production artifact is accessed by these tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..', '..');
const source = fs.readFileSync(path.join(root, 'dashboard/static/canary.js'), 'utf8');

const ageNode = (freshness, age, aging = 600, stale = 1800) => {
  const state = { textContent: '', className: '' };
  const value = { textContent: '' };
  return {
    dataset: { freshness, canaryAge: age === null ? '' : String(age), agingAfter: String(aging), staleAfter: String(stale) },
    state, value,
    querySelector: (selector) => selector === '[data-age-state]' ? state : value,
  };
};
const deadlineNode = (remaining, ended = false) => {
  const state = { textContent: '', className: '' };
  return {
    dataset: { remaining: remaining === null ? '' : String(remaining), ended: String(ended), canaryDeadline: '2026-10-28T20:01:00Z', endedLabel: 'Execution window ended' },
    state, querySelector: () => state,
  };
};
const harness = ({ ages = [], deadlines = [], authority = [], present = true } = {}) => {
  const epoch = Date.parse('2026-10-28T20:00:00Z');
  let now = 0;
  let wallOffset = 0;
  let seq = 0;
  let requests = 0;
  const timers = new Map();
  const listeners = {};
  const windowListeners = {};
  const document = {
    hidden: false,
    querySelector: () => present ? {} : null,
    querySelectorAll: (selector) => selector === '[data-canary-age]' ? ages : selector === '[data-canary-deadline]' ? deadlines : authority,
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
  };
  class ClockDate extends Date {
    static now() { return epoch + now + wallOffset; }
  }
  const window = {
    performance: { now: () => now },
    setTimeout(fn, delay) { const id = ++seq; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    addEventListener: (type, fn) => { (windowListeners[type] ||= []).push(fn); },
    requestWatchboardReload() { requests += 1; },
  };
  vm.runInNewContext(source, { window, document, Date: ClockDate }, { filename: 'canary.js' });
  return {
    document, timers,
    requests: () => requests,
    event(type, detail = {}) { for (const fn of listeners[type] || []) fn({ detail }); },
    windowEvent(type, event = {}) { for (const fn of windowListeners[type] || []) fn(event); },
    shiftWall(ms) { wallOffset += ms; },
    advance(ms, sleep = false) {
      const end = now + ms;
      if (sleep) now = end;
      for (;;) {
        const entry = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry || entry[1].at > end) break;
        timers.delete(entry[0]);
        if (!sleep) now = entry[1].at;
        entry[1].fn();
      }
      now = end;
    },
  };
};

test('Canary clocks do not initialize on any other page', () => {
  const app = harness({ present: false });
  assert.equal(app.timers.size, 0);
});

test('known source age degrades Fresh → Aging → Stale without resetting its publication time', () => {
  const item = ageNode('FRESH', 599);
  const app = harness({ ages: [item] });
  assert.equal(item.state.textContent, 'FRESH');
  app.advance(2000);
  assert.equal(item.state.textContent, 'AGING');
  app.advance(1200000);
  assert.equal(item.state.textContent, 'STALE');
  assert.equal(item.dataset.canaryAge, '599');
  assert.match(item.value.textContent, /30m 1s old/);
});

test('unknown, unavailable, clock-skew and initially stale evidence never becomes fresh', () => {
  const items = [ageNode('UNKNOWN', null), ageNode('UNAVAILABLE', null), ageNode('CLOCK_SKEW', -600), ageNode('STALE', 1)];
  const app = harness({ ages: items });
  app.advance(900000);
  assert.deepEqual(items.map((item) => item.state.textContent), ['UNKNOWN', 'UNAVAILABLE', 'CLOCK SKEW', 'STALE']);
  assert.match(items[0].value.textContent, /age unknown/);
});

test('source-specific freshness thresholds stay separate for balances and transactions', () => {
  const balances = ageNode('FRESH', 1799, 1800, 5400);
  const transactions = ageNode('FRESH', 1799, 7200, 21600);
  const app = harness({ ages: [balances, transactions] });
  app.advance(2000);
  assert.equal(balances.state.textContent, 'AGING');
  assert.equal(transactions.state.textContent, 'FRESH');
});

test('a missing age cannot leave a fresh badge indefinitely', () => {
  const item = ageNode('FRESH', null);
  harness({ ages: [item] });
  assert.equal(item.state.textContent, 'UNKNOWN');
  assert.match(item.value.textContent, /age unknown/);
});

test('deadlines expire at zero, remain expired after clock rollback, and keep the absolute end', () => {
  const item = deadlineNode(2);
  const app = harness({ deadlines: [item] });
  assert.match(item.state.textContent, /2s until recorded end/);
  app.advance(2000);
  assert.equal(item.state.textContent, 'Execution window ended');
  assert.equal(item.dataset.expired, 'true');
  app.shiftWall(-600000);
  app.advance(1000);
  assert.equal(item.state.textContent, 'Execution window ended');
  assert.equal(item.dataset.canaryDeadline, '2026-10-28T20:01:00Z');
});

test('an already expired window stays ended even if its supplied remaining time is positive', () => {
  const item = deadlineNode(120, true);
  harness({ deadlines: [item] });
  assert.equal(item.state.textContent, 'Execution window ended');
});

test('execution authority labels only degrade on reconnect and expiry, without changing invalid scope', () => {
  const end = deadlineNode(5);
  end.dataset.executionDeadline = 'true';
  const valid = { dataset: { canaryAuthorityState: 'VALID' }, textContent: 'VALID' };
  const invalid = { dataset: { canaryAuthorityState: 'INVALID' }, textContent: 'INVALID' };
  const app = harness({ deadlines: [end], authority: [valid, invalid] });
  app.windowEvent('online');
  assert.equal(valid.textContent, 'CHECK NEEDED');
  app.advance(5000);
  assert.equal(valid.textContent, 'EXPIRED');
  assert.equal(invalid.textContent, 'INVALID');
});

test('a closed historical observation window does not change source freshness or execution authority', () => {
  const end = deadlineNode(1);
  end.dataset.historicalDeadline = 'true';
  end.dataset.endedLabel = 'Historical multichain window closed';
  const source = ageNode('FRESH', 3);
  const authority = { dataset: { canaryAuthorityState: 'INVALID' }, textContent: 'INVALID' };
  const app = harness({ deadlines: [end], ages: [source], authority: [authority] });
  app.advance(1000);
  assert.equal(end.state.textContent, 'Historical multichain window closed');
  assert.equal(end.state.className, 'pill neutral');
  assert.equal(source.state.textContent, 'FRESH');
  assert.equal(authority.textContent, 'INVALID');
});

test('absolute-only deadlines are estimates needing a server check, never authority', () => {
  const item = deadlineNode(null);
  const app = harness({ deadlines: [item] });
  assert.match(item.state.textContent, /1m 0s until recorded end · server check needed/);
  app.advance(60000);
  assert.equal(item.dataset.expired, 'true');
});

test('invalid deadlines remain unknown', () => {
  const item = deadlineNode(null);
  item.dataset.canaryDeadline = '';
  harness({ deadlines: [item] });
  assert.equal(item.state.textContent, 'Deadline unknown');
});

test('wall-clock rollback cannot make source ages younger', () => {
  const item = ageNode('FRESH', 5);
  const app = harness({ ages: [item] });
  app.advance(3000);
  assert.match(item.value.textContent, /8s old/);
  app.shiftWall(-3600000);
  app.advance(2000);
  assert.match(item.value.textContent, /10s old/);
});

test('returning from a hidden tab requires a server check and still accounts for elapsed age', () => {
  const item = ageNode('FRESH', 5);
  const app = harness({ ages: [item] });
  app.document.hidden = true;
  app.event('visibilitychange');
  assert.equal(app.timers.size, 0);
  app.advance(60000);
  app.document.hidden = false;
  app.event('visibilitychange');
  assert.equal(item.state.textContent, 'CHECK NEEDED');
  assert.match(item.value.textContent, /1m 5s old · server check needed/);
});

test('sleep expires deadlines immediately and asks the shared safe-refresh gate to catch up once', () => {
  const item = ageNode('FRESH', 5);
  const end = deadlineNode(10);
  const app = harness({ ages: [item], deadlines: [end] });
  app.advance(30000, true);
  assert.equal(app.requests(), 1);
  assert.equal(item.state.textContent, 'CHECK NEEDED');
  assert.equal(end.state.textContent, 'Execution window ended');
  app.advance(1000);
  assert.equal(app.requests(), 1);
});

test('reconnection alone cannot refresh evidence; only a completed server update resets the anchors', () => {
  const item = ageNode('FRESH', 5);
  const app = harness({ ages: [item] });
  app.windowEvent('offline');
  app.windowEvent('online');
  assert.equal(item.state.textContent, 'CHECK NEEDED');
  app.windowEvent('pageshow', { persisted: true });
  assert.equal(item.state.textContent, 'CHECK NEEDED');
  app.event('watchboard:canary-updated', { elapsedSeconds: 4 });
  assert.equal(item.state.textContent, 'FRESH');
  assert.match(item.value.textContent, /9s old/);
});

test('standalone Canary template fixtures keep missing sections independent, empty transactions truthful and every balance row visible', () => {
  // Jinja is an existing dashboard dependency. Render synthetic view objects,
  // not the Flask app: no route hooks, collection, artifact reads, or RPCs.
  const python = String.raw`
from jinja2 import Environment, FileSystemLoader, select_autoescape
env = Environment(loader=FileSystemLoader('dashboard/templates'), autoescape=select_autoescape())
env.globals['url_for'] = lambda endpoint, filename: '/static/' + filename
template = env.get_template('canary.html')
empty = dict(available=False, rows=[], chains=[], solana=[], errors=[], wallet_short=None)
sentinel = dict(id='fixture-no-reference', pair='UNIT / TEST', fired=False, ok=False, reference_ok=False,
    feedless=False, scale_suspect=False, kind='DYNAMIC', divergence_bps=None, threshold_bps=500,
    execution_readiness='NOT_CONNECTED', execution_reason='No execution connection', batch_scope='NOT_VERIFIED',
    reason='Fixture comparison incomplete', error='Fixture reference unavailable', reference_source=None,
    oracle_ratio=None, reference_ratio=None, consecutive_over=0)
data = dict(available=False, batch=None, history_available=True, runs=[], runner=dict(available=False),
    execution=dict(verification='INVALID', authorization_state='INVALID', readiness='NOT_READY',
        readiness_reason='No verified scope', scope='NOT_VERIFIED'),
    multichain=dict(available=True, generated_at='2026-10-28T20:00:00Z', age=1, freshness='FRESH',
        verdict='DORMANT', fired_count=0, fired_sentinels=[], groups=[], chains=[],
        batch=dict(started_at='2026-10-28T19:00:00Z', expires_at=None), history_available=False),
    divergence=dict(available=True, generated_at='2026-10-28T20:00:00Z', age=1, freshness='FRESH',
        verdict='INCOMPLETE', fired_count=0, sustained_count=0, chains=[],
        coverage=dict(referenceResolvedPct=0, referenceResolved=0, universe=1, constantOracles=0),
        groups=[dict(chain_id=1, qualified=False, alias='Fixture chain', reason='Reference unavailable', sentinels=[sentinel])]),
    transactions=dict(available=True, as_of='2026-10-28T20:00:00Z', age=2, freshness='FRESH', rows=[],
        row_count=0, errors=[dict(scope='fixture', message='Coverage limited')], wallet_short=None), balances=empty)
kwargs = dict(request=dict(path='/canary'), collector=dict(running=False, last_error=None, last_exit=None), refresh=None, collector_hint=None)
html = template.render(data=data, **kwargs)
assert 'Dedicated sentinel status is unavailable' in html
assert 'Multichain canary' in html and 'Fixture comparison incomplete' in html
assert 'Fixture reference unavailable' in html and 'No recorded runs.' in html
assert 'No transactions in this snapshot.' in html and 'Coverage limited' in html
assert '2026-10-28T20:00:00Z' in html and 'data-refresh-status' in html
assert '55 strike sentinels' not in html
data['transactions']['rows'] = [dict(status='receipt_unavailable', time=None, chain='Fixture', chain_id=1,
    description='Fixture transfer', method_name=None, amounts=[], explorer_url=None, short_hash='fixture')]
data['transactions']['row_count'] = 1
html = template.render(data=data, **kwargs)
assert 'RECEIPT UNAVAILABLE' in html and 'Block inclusion is known' in html and '>PENDING<' not in html
chains = []
rows = []
for chain_id in range(1, 29):
    chain_rows = [dict(label=f'ROW-{chain_id}-{index}', short=f'fixture-{chain_id}-{index}', address='fixture',
        is_profit_destination=False, native=None, tokens=[], block=None, total_usd=None, error=None) for index in range(2)]
    rows.extend(chain_rows)
    chains.append(dict(chain=f'Chain {chain_id}', chain_id=chain_id, rows=chain_rows, complete=False, subtotal_usd=None, native_symbol=None))
data['balances'] = dict(available=True, as_of='2026-10-28T20:00:00Z', age=1, freshness='FRESH', stale=False,
    unpriced_chains=['Fixture chain'], errors=[], chains=chains, rows=rows, solana=[], totals=None)
html = template.render(data=data, **kwargs)
assert '28 EVM chain groups' in html and '56 address/chain rows' in html
assert all(f'ROW-{chain_id}-{index}' in html for chain_id in range(1, 29) for index in range(2))
assert html.count('class="wallet-chain canary-wallet-chain"') == 28
assert 'Incomplete subtotal' in html and 'Unavailable / incomplete' in html
data['transactions'] = empty
data['multichain'] = empty
data['divergence'] = empty
html = template.render(data=data, **kwargs)
assert 'Transaction feed unavailable.' in html and 'Multichain sentinel artifact unavailable.' in html
assert 'Oracle-divergence artifact unavailable.' in html
data.update(available=True, generated_at='2026-10-28T20:00:00Z', age=20, freshness='FRESH',
    verdict='DORMANT', fired_sentinels=[], pin_block=123, pin_hash='fixture-pin-hash',
    batch=dict(name='Fixture batch', chain_id=1, started_at='2026-10-28T19:00:00Z',
        monitor_ends_at='2026-10-28T21:00:00Z', expires_in=3600, expired=False,
        caps=dict(capitalEthPerAction='1', gasCeilingEthPerTx='0.01'), profit_destination='0x' + '1' * 40),
    sentinels=[dict(id='morpho-paxg-misscale', fired=False, ok=True, reason='Fixture read',
        execution_readiness='NOT_CONNECTED', execution_reason='No connection', batch_scope='NOT_VERIFIED',
        view=dict(total_supply_usdc='0', total_borrow_usdc='0', available_usdc='0', oracle_price_wei='1000000', lltv='860000000000000000'))],
    runner=dict(available=True, status='UPDATED', freshness='FRESH', age=2, reason=None, generated_at='2026-10-28T20:00:00Z',
        started_at='2026-10-28T19:59:50Z', updated_count=1, monitoring_ends_at='2026-10-28T21:00:00Z', window_state='ACTIVE',
        feeds=[dict(id='fixture', updated=True, verdict='DORMANT', reason=None)]))
html = template.render(data=data, **kwargs)
assert 'fixture-pin-hash' in html and 'LLTV uses 1e18 = 100%' in html and 'not a dollar price' in html
assert 'data-remaining="3600"' in html and 'Legacy metadata state: ACTIVE' in html
assert 'age unknown' in html  # legacy runner feed without additive age fields
data['runner'].update(observation_mode='READ_ONLY_ONCE', historical_monitoring_window_state='WINDOW_CLOSED',
    monitoring_ends_at='2026-10-25T22:10:00Z', window_state='EXPIRED')
data['runner']['feeds'][0].update(observation_mode='READ_ONLY_ONCE', historical_monitoring_window_state='WINDOW_CLOSED')
data['multichain'] = dict(available=True, generated_at='2026-10-28T20:00:00Z', age=1, freshness='FRESH',
    verdict='DORMANT', fired_count=0, fired_sentinels=[], groups=[], chains=[], history_available=False,
    observation_mode='READ_ONLY_ONCE', historical_monitoring_window_state='WINDOW_CLOSED',
    batch=dict(started_at='2026-10-25T20:00:00Z', expires_at='2026-10-25T22:10:00Z', expired=True, expires_in=0))
html = template.render(data=data, **kwargs)
assert html.count('data-observation-mode="READ_ONLY_ONCE"') == 3
assert html.count('data-historical-window-state="WINDOW_CLOSED"') == 3
assert 'Historical multichain window end' in html and 'not a producer deadline' in html
assert 'data-freshness="FRESH"' in html and 'NOT_READY' in html and 'NOT_VERIFIED' in html
assert 'global runner approval' in html and 'href="/targets">Inspect target runners' not in html
# Historical dedicated expiry and explicit dedicated monitor end are distinct
# valid source shapes; both stay separate from signed execution expiry.
data['batch'].update(expires_at='2026-10-25T22:10:00Z', monitor_ends_at=None, expired=True, expires_in=0)
data['execution'].update(verification='VERIFIED', authorization_state='VALID',
    expires_at='2026-10-29T22:10:00Z', expires_in=90000)
html = template.render(data=data, **kwargs)
assert 'Historical dedicated batch end' in html and '2026-10-25T22:10:00Z' in html
assert 'Recorded window ended' in html and 'not a current monitor deadline' in html
assert 'data-canary-deadline="2026-10-29T22:10:00Z" data-remaining="90000"' in html
data['batch'].update(expires_at=None, monitor_ends_at='2026-10-28T21:00:00Z', expired=False, expires_in=3600)
html = template.render(data=data, **kwargs)
assert 'data-canary-deadline="2026-10-28T21:00:00Z" data-remaining="3600" data-ended="false"' in html
assert 'data-canary-deadline="2026-10-29T22:10:00Z" data-remaining="90000"' in html
assert 'Recorded monitor caps' in html and '≤1 ETH capital' in html
for state, error, expected in [('DEFERRED', 'OUTPUT_BUSY', 'deferred'), ('TIMEOUT', 'TIMEOUT', 'timed out'), ('FAILED', 'COLLECT_FAILED', 'failed'), ('IDLE', None, 'idle')]:
    kwargs['collector'] = dict(running=False, state=state, last_error=error, last_exit=None, deadline_at=None)
    html = template.render(data=data, **kwargs)
    assert f'Collector {expected}' in html and 'deadline None' not in html
print('synthetic template assertions passed')
`;
  const result = spawnSync('python', ['-c', python], { cwd: root, encoding: 'utf8', timeout: 20000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(result.status, 0, result.stderr || String(result.error || 'fixture failed'));
  assert.match(result.stdout, /synthetic template assertions passed/);
});
