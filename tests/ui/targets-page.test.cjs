'use strict';

// Real template + navigation script. Rendering uses the dashboard's Jinja
// dependency, but never imports the app, opens artifacts, or starts a server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const rootPath = path.join(__dirname, '../..');
const source = fs.readFileSync(path.join(rootPath, 'dashboard/static/targets.js'), 'utf8');
const template = fs.readFileSync(path.join(rootPath, 'dashboard/templates/targets.html'), 'utf8');
const css = fs.readFileSync(path.join(rootPath, 'dashboard/static/targets.css'), 'utf8');
const refreshSource = fs.readFileSync(path.join(rootPath, 'dashboard/static/refresh.js'), 'utf8');

const element = (extra = {}) => ({
  listeners: {},
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); },
  fire(type, event = {}) { for (const handler of this.listeners[type] || []) handler(event); },
  ...extra,
});
const decode = (text) => text.replace(/&(amp|quot|lt|gt|#39);/g, (_, key) => ({ amp: '&', quot: '"', lt: '<', gt: '>', '#39': "'" })[key]);
const attributes = (tag) => Object.fromEntries(Array.from(tag.matchAll(/([\w-]+)="([^"]*)"/g), (match) => [match[1], decode(match[2])]));
const option = (value, label = value) => ({ value, label });
const fixture = {
  view_mode: 'trade_candidates',
  available: true, freshness: 'STALE', pin_block: 123, pin_utc: '2026-10-19T12:00:00Z', generated_at: '2026-10-19T23:00:00Z',
  query: { q: 'USDe', chain: '', protocol: '', source: '', status: '', sort: 'curated', page: 2, page_size: 50 },
  pagination: { page: 2, page_size: 50, pages: 3, filtered_total: 125, returned: 3, start: 51, end: 53, has_prev: true, has_next: true },
  summary: { total: 156, eligible: 2, observation_only: 38, stale: 11 },
  options: {
    chains: [option('Ethereum'), option('Base')],
    protocols: ['Aave V3', 'Aave V4', 'Morpho Blue'].map((value) => option(value)),
    sources: [option('near3', 'Near-three monitor'), option('curated', 'Curated borrower observations'), option('unified', 'Unified runner (missing)')],
    statuses: ['HELD', 'ELIGIBLE', 'WATCH', 'OBSERVATION_ONLY', 'STALE', 'UNKNOWN'].map((value) => option(value)),
    sorts: [option('passive_time', 'Passive time: soonest'), ...['curated', 'distance-asc', 'distance-desc', 'gross-asc', 'gross-desc', 'chain', 'protocol', 'status'].map((value) => option(value))],
  },
  coverage: {
    complete: false, limits: { max_bytes_per_source: 100000000, max_rows_per_source: 600000 },
    sources: [
      { id: 'near3', label: 'Near-three monitor', read_state: 'OK', freshness: 'FRESH', input_rows: 3, accepted_rows: 3, rejected_rows: 0, omitted_rows: 0, reported_total: 3, truncated: false, limitations: [] },
      { id: 'curated', label: 'Curated borrower observations', read_state: 'PARTIAL', freshness: 'STALE', input_rows: 203, accepted_rows: 153, rejected_rows: 1, omitted_rows: 49, reported_total: 203, truncated: true, limitations: ['Source observations do not establish current health.', 'Curated evidence is incomplete.'] },
      { id: 'unified', label: 'Unified runner (missing)', read_state: 'MISSING', freshness: 'UNKNOWN', input_rows: null, accepted_rows: null, rejected_rows: null, omitted_rows: null, reported_total: null, truncated: null, limitations: ['Runner telemetry unknown.'] },
    ],
  },
  targets: [
    { id: 'legacy-rank1', position_key: '1'.repeat(64), record_type: 'position', protocol: 'Aave V3', chain_name: 'Ethereum', chain_id: 1, pair: 'USDe / USDC', user_short: '0x123…456', borrower_address: `0x${'1'.repeat(40)}`, status: { code: 'HELD', label: 'Held', tone: 'warning' }, protocol_status: 'WATCH', runner: { held: true, reported_armed: false, mode: 'CHECK_ONLY', freshness: 'STALE', age_text: '40m ago' }, observation: { freshness: 'FRESH', age_text: '1m ago' }, health_factor: '1.01 HF', bps_numeric: 100, source_ids: ['near3', 'curated'], provenance: [{ source: 'near3', generated_at: '2026-10-19T22:59:00Z', freshness: 'FRESH', age_text: '1m ago', block: 456, utc: '2026-10-19T22:58:00Z', hash: `0x${'a'.repeat(64)}` }] },
    { id: 'legacy-rank2', position_key: '2'.repeat(64), record_type: 'position', protocol: 'Aave V3', chain_name: 'Ethereum', chain_id: 1, label: 'Curated borrower awaiting evidence', status: { code: 'UNKNOWN', label: 'Unknown', tone: 'neutral' }, protocol_status: 'UNKNOWN', runner: { held: null }, source_ids: ['curated'], provenance: [] },
    { id: 'legacy-m2', position_key: '3'.repeat(64), record_type: 'position', protocol: 'Morpho Blue', chain_name: 'Base', chain_id: 8453, label: 'M2 curated borrower', borrower_address: `0x${'3'.repeat(40)}`, user_short: '0x333…333', status: { code: 'OBSERVATION_ONLY', label: 'Observation only', tone: 'neutral' }, protocol_status: 'UNKNOWN', runner: { held: null }, source_ids: ['curated'], provenance: [], blockers: ['Observation stage: current health and exit quote not established.'] },
  ],
};

let rendered;
const views = () => {
  if (rendered) return rendered;
  const clone = () => structuredClone(fixture);
  const empty = clone();
  empty.targets = [];
  empty.pagination = { page: 1, page_size: 50, pages: 1, filtered_total: 0, returned: 0, start: 0, end: 0, has_prev: false, has_next: false };
  const missing = structuredClone(empty);
  missing.summary = { total: 0, eligible: 0, observation_only: 0, stale: 0 };
  missing.available = false;
  const unknown = { targets: [], summary: {}, pagination: {}, options: {}, query: {} };
  const complete = clone();
  complete.coverage.complete = true;
  const unsafe = clone();
  unsafe.query = { ...unsafe.query, q: '<img src=x onerror="bad()">', page_size: 75 };
  unsafe.targets[0].label = '<script>alert(1)</script>';
  unsafe.targets[0].runner.reason_text = '<img src=x onerror="bad()">';
  unsafe.coverage.sources[0].limitations = ['<img src=x onerror="bad()">'];
  unsafe.query_warnings = [{ parameter: 'q', code: 'TRUNCATED' }, { parameter: 'page', code: 'CLAMPED' }];
  const states = clone();
  states.coverage.sources = ['OK', 'PARTIAL', 'MISSING', 'INVALID', 'OVERSIZED', 'UNAVAILABLE'].map((state) => ({ id: state, label: state, read_state: state }));
  states.targets = ['HELD', 'ELIGIBLE', 'WATCH', 'OBSERVATION_ONLY', 'STALE', 'UNKNOWN'].map((status, index) => ({ ...structuredClone(fixture.targets[1]), position_key: String(index + 4).repeat(64), status: { code: status, label: status }, protocol_status: status === 'HELD' ? 'ELIGIBLE' : 'UNKNOWN' }));
  const historical = clone();
  historical.view_mode = 'historical_inventory';
  historical.summary = { total: 320456, eligible: 2, observation_only: 317000, stale: 2000 };
  historical.options.protocols.push(option('Compound V3'), option('Euler'));
  historical.options.sources.push(option('borrower-history', 'Historical borrower index'));
  historical.coverage.sources.push({ id: 'borrower-history', label: 'Historical borrower index', read_state: 'PARTIAL', freshness: 'STALE', input_rows: 320500, accepted_rows: 320450, rejected_rows: 1, omitted_rows: 49, reported_total: 420500, truncated: true, limitations: ['Historical identities only; current health is unknown.', 'Upstream borrower coverage is incomplete.'] });
  historical.targets[1] = { ...historical.targets[1], label: 'Historical borrower identity', source_ids: ['borrower-history'] };
  historical.targets[2] = { ...historical.targets[2], position_key: '4'.repeat(64), record_type: 'market', protocol: 'Euler', chain_name: 'Ethereum', chain_id: 1, label: 'Stored vault observation', borrower_address: null, user_short: null, blockers: [] };
  const historicalEmpty = { ...structuredClone(historical), targets: [], pagination: structuredClone(empty.pagination) };
  const historicalMissing = { ...structuredClone(historicalEmpty), available: false, summary: structuredClone(missing.summary) };
  const historicalUnknown = { ...structuredClone(unknown), view_mode: 'historical_inventory' };
  const candidateSpoof = clone();
  const historySpoof = structuredClone(historical);
  const armedMorpho = clone();
  armedMorpho.targets = [
    ['#M2', 'Ethereum', 1, 'reUSD / USDC', '0x2d5bca1b846e89965544c7f03d09a25126803627', 'Unified Morpho M2'],
    ['#M7', 'Ethereum', 1, 'ynETHx / msETH', '0xc06326bc6fbd4305cdab4de8e239b7b80feb2eb4', 'Unified Morpho M7'],
    ['#B1', 'Base', 8453, 'USDe / USDC', '0x88bff83b4c987cc90a863cd79baa54dd5cd94f32', 'Base Morpho Runner'],
    ['#B2', 'Base', 8453, 'USDe / USDC', '0x88bff83b4c987cc90a863cd79baa54dd5cd94f32', 'Base Morpho Runner'],
  ].map(([rank, chain_name, chain_id, pair, executor_address, label], i) => ({
    ...structuredClone(fixture.targets[2]), id: `armed-${i}`, position_key: String(i + 5).repeat(64),
    rank, chain_name, chain_id, pair, label: `${rank} deployed Morpho plan`, executor_address, observation_only: false,
    status: { code: 'WATCH', label: 'Watching' }, protocol_status: 'WATCH',
    runner: { label, mode: 'EXECUTE_IF_LIQUIDATABLE', reported_armed: true, freshness: 'FRESH' },
    blockers: ['Reported armed is telemetry only; not execution approval.'],
  }));
  armedMorpho.targets.push({ ...structuredClone(fixture.targets[2]), rank: '#B3', pair: 'mGLO / USDC', label: '#B3 observation only' });
  const passive = clone();
  passive.query.sort = 'passive_time';
  passive.targets[0].position = { passive_hours: '16.25' };
  passive.targets[1].position = { passive_hours: null };
  passive.targets[1].runner = { freshness: 'UNKNOWN', age_text: null, mode: 'BLOCKED' };
  passive.targets[1].status = { code: 'BLOCKED', label: 'Blocked', tone: 'warning' };
  passive.targets[2].position = { passive_hours: 0 };
  passive.targets[2].runner = { freshness: 'FRESH', age_text: '0s', mode: 'CHECK_ONLY' };
  const runnerReasons = structuredClone(passive);
  const knownReason = 'Shared runner blocked: provider disagreement.';
  runnerReasons.targets[0].runner = { mode: 'BLOCKED', freshness: 'UNKNOWN', age_text: null, checked_at: '2026-10-24T09:10:00Z', reason_code: 'PROVIDER_DISAGREEMENT', reason_text: knownReason, notes: [knownReason], error: 'RAW_PRODUCER_ERROR_DO_NOT_RENDER' };
  runnerReasons.targets[1].runner.reason_text = '';
  runnerReasons.targets[2].runner = { ...runnerReasons.targets[2].runner, reason_code: null, reason_text: null, notes: [] };
  const evidence = clone();
  evidence.targets[0].liveness = { state: 'STOPPED', observed_at: '2026-10-27T19:55:50Z' };
  evidence.targets[1].runner = { mode: 'EXECUTE_IF_LIQUIDATABLE', reported_armed: true, freshness: 'FRESH' };
  evidence.targets[1].liveness = { state: 'UNKNOWN' };
  evidence.targets[1].quote = { available: false, estimate: { gross_token_amount: '120.36', gross_token_symbol: 'USDC', provenance: 'HISTORICAL_REFERENCE' } };
  evidence.targets[2].historical_reference = {
    available: true, modeled_net_usd_display: '213.50', modeled_net_usd: '213.49892698',
    original_block: 26281701, original_hash: `0x${'a'.repeat(64)}`, original_utc: '2026-10-27T02:38:35Z',
    fixture_advance_seconds: 43200, note: 'Not current profit, realized profit, or production readiness.',
  };
  const python = `
import json, sys
sys.stdin.reconfigure(encoding='utf-8')
from types import SimpleNamespace
from jinja2 import Environment, FileSystemLoader, select_autoescape
from werkzeug.datastructures import MultiDict
env = Environment(loader=FileSystemLoader('dashboard/templates'), autoescape=select_autoescape(['html']))
env.globals['url_for'] = lambda endpoint, **kw: '/static/' + kw.get('filename', '')
page = env.get_template('targets.html')
rendered = {}
for name, data in json.load(sys.stdin).items():
    args = MultiDict([('q', 'REJECTED_QUERY'), ('chain', 'REJECTED_CHAIN'), ('source', 'REJECTED_SOURCE'), ('page', '999'), ('page_size', 'BAD_SIZE'), ('other', 'keep'), ('tag', 'one'), ('tag', 'two'), ('extra', '<b>escaped</b>')])
    if name in ('candidateSpoof', 'historySpoof'):
        args.add('view_mode', 'historical_inventory' if name == 'candidateSpoof' else 'trade_candidates')
    request = SimpleNamespace(path='/inventory' if data.get('view_mode') == 'historical_inventory' else '/targets', args=args)
    rendered[name] = page.render(data=data, request=request)
print(json.dumps(rendered))
`;
  const result = spawnSync('python', ['-c', python], {
    cwd: rootPath, input: JSON.stringify({ inventory: fixture, empty, missing, unknown, complete, unsafe, states, historical, historicalEmpty, historicalMissing, historicalUnknown, candidateSpoof, historySpoof, armedMorpho, passive, runnerReasons, evidence }), encoding: 'utf8', timeout: 30000,
  });
  assert.equal(result.status, 0, `Template rendering failed: ${result.stderr || result.error || ''}`);
  rendered = JSON.parse(result.stdout);
  return rendered;
};

const harness = ({ html = views().inventory, url = 'http://localhost/targets?other=keep&page=2#target-abc' } = {}) => {
  const formTag = html.match(/<form\b[^>]*data-target-filters[^>]*>/)[0];
  const formBody = html.slice(html.indexOf(formTag) + formTag.length, html.indexOf('</form>', html.indexOf(formTag)));
  const controls = Array.from(formBody.matchAll(/<input\b[^>]*>/g), ([tag]) => attributes(tag));
  for (const match of formBody.matchAll(/<select\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const entries = Array.from(match[2].matchAll(/<option\b([^>]*)>/g), ([, attrs]) => ({ ...attributes(attrs), selected: /\bselected\b/.test(attrs) }));
    controls.push({ name: match[1], value: (entries.find((entry) => entry.selected) || entries[0])?.value || '' });
  }
  const form = element({
    action: attributes(formTag).action, method: 'get',
    elements: { namedItem: (name) => controls.find((item) => item.name === name) },
    getAttribute(name) { return this[name]; },
  });
  const links = Array.from(html.matchAll(/<a\b[^>]*data-target-nav[^>]*>/g), ([tag]) => ({
    ...attributes(tag),
    getAttribute(name) { return this[name]; },
  }));
  const root = {
    querySelector(selector) { assert.equal(selector, '[data-target-filters]'); return form; },
    querySelectorAll(selector) { assert.equal(selector, 'a[data-target-nav]'); return links; },
  };
  const window = element({ location: { href: url } });
  const document = { querySelector: (selector) => selector === '[data-targets-page]' ? root : null };
  vm.runInNewContext(source, { document, window, URL }, { filename: 'targets.js' });
  return {
    controls, form, links, window,
    set(name, value) { form.elements.namedItem(name).value = value; form.fire('change'); form.fire('input'); },
    submit() {
      let prevented = false;
      form.fire('submit', { preventDefault() { prevented = true; } });
      assert.equal(prevented, false, 'Use native server navigation');
      const destination = new URL(form.action, window.location.href);
      destination.search = new URLSearchParams(controls.map(({ name, value }) => [name, value])).toString();
      return destination;
    },
  };
};

test('actual reported armed telemetry remains labeled as reports, never observed liveness', () => {
  const html = views().armedMorpho;
  assert.equal((html.match(/Yes · telemetry only/g) || []).length, 4);
  assert.match(html, /https:\/\/etherscan\.io\/address\/0x2d5bca1b846e89965544c7f03d09a25126803627/);
  assert.match(html, /https:\/\/etherscan\.io\/address\/0xc06326bc6fbd4305cdab4de8e239b7b80feb2eb4/);
  assert.match(html, /https:\/\/basescan\.org\/address\/0x88bff83b4c987cc90a863cd79baa54dd5cd94f32/);
  for (const label of ['Unified Morpho M2', 'Unified Morpho M7', 'Base Morpho Runner', '#B3 observation only']) assert.ok(html.includes(label));
  assert.match(html, /not execution approval/);
  assert.match(html, /Observed: Unknown/);
  assert.match(html, /Reported mode: EXECUTE_IF_LIQUIDATABLE/);
});

test('liveness, reported state, stored estimates, and historical unearned gain remain distinct', () => {
  const html = views().evidence;
  const rows = [...html.matchAll(/<li data-target-row[^>]*>[\s\S]*?<\/summary>/g)].map(([row]) => row);
  assert.match(rows[0], /Observed: Stopped/);
  assert.match(rows[0], /Hold reported/);
  assert.match(rows[1], /Observed: Unknown/);
  assert.match(rows[1], /Reported mode: EXECUTE_IF_LIQUIDATABLE/);
  assert.match(rows[1], /Current quote unavailable/);
  assert.match(rows[1], /120\.36 USDC · stored estimate, not earned/);
  assert.match(rows[2], /\$213\.50 modeled net/);
  assert.match(rows[2], /Historical local fork · block 26281701 · not earned/);
  assert.match(html, /excluded from current-quote gain sorting/);
  assert.match(html, /Original block hash/);
  assert.match(html, /Configured implementation/);
  assert.match(html, /Realized receipt/);
  assert.match(html, /Read-only sentinel health is not executor liveness/);
});

test('visible native GET controls render from global options, not this page of rows', () => {
  const html = views().inventory;
  assert.match(html, /data-target-filters action="\/targets" method="get"/);
  assert.doesNotMatch(html.match(/<form\b[^>]*data-target-filters[^>]*>/)[0], /\bhidden\b/);
  for (const name of ['q', 'chain', 'protocol', 'source', 'status', 'sort', 'page_size']) assert.match(html, new RegExp(`name="${name}"`));
  assert.match(html, /<button type="submit">Apply<\/button>/);
  assert.match(html, /<option value="Aave V4">Aave V4<\/option>/);
  assert.match(html, /<option value="unified">Unified runner \(missing\)<\/option>/);
  assert.doesNotMatch(html, /<option[^>]+(?:borrower-history|view_mode|archive)/);
  assert.match(html, /Filters, page links, and record details work without JavaScript/);
  assert.equal(harness().form.elements.namedItem('q').value, 'USDe');
});

test('Apply sends search and all filters to the server, without filtering page rows', () => {
  const page = harness();
  page.set('q', 'USDE 0xDEF');
  page.set('chain', 'Base');
  page.set('protocol', 'Aave V4');
  page.set('source', 'unified');
  page.set('status', 'UNKNOWN');
  assert.equal(page.window.location.href, 'http://localhost/targets?other=keep&page=2#target-abc');
  const url = page.submit();
  for (const [name, expected] of [['q', 'USDE 0xDEF'], ['chain', 'Base'], ['protocol', 'Aave V4'], ['source', 'unified'], ['status', 'UNKNOWN']]) assert.equal(url.searchParams.get(name), expected);
  assert.equal(url.searchParams.get('page'), '1');
});

test('numeric sorts navigate globally rather than reordering or reclassifying page records', () => {
  const page = harness();
  for (const key of ['passive_time', 'distance-asc', 'distance-desc', 'gross-asc', 'gross-desc']) {
    page.set('sort', key);
    assert.equal(page.submit().searchParams.get('sort'), key);
  }
  assert.doesNotMatch(source, /appendChild|data-target-row|Number\(|\.sort\(|\.hidden\s*=/);
  assert.match(views().inventory, /Unknown sort values stay last/);
});

test('passive-time selection follows the backend and survives GET, pagination, and JSON links', () => {
  const html = views().passive;
  const page = harness({ html });
  assert.match(html, /<option value="passive_time" selected>Passive time: soonest<\/option>/);
  assert.match(html, /id="targets-sort"[^>]*aria-describedby="targets-filter-help targets-timing-help"/);
  assert.equal(page.form.elements.namedItem('sort').value, 'passive_time');
  const url = page.submit();
  assert.equal(url.searchParams.get('sort'), 'passive_time');
  assert.equal(url.searchParams.get('q'), 'USDe');
  assert.equal(url.searchParams.get('page'), '1');
  assert.equal(url.searchParams.get('page_size'), '50');
  assert.equal(url.hash, '#target-abc');
  for (const link of page.links.filter((link) => link.rel || link.href.startsWith('/api/v1/'))) {
    const destination = new URL(link.href, page.window.location.href);
    assert.equal(destination.searchParams.get('sort'), 'passive_time');
    assert.equal(destination.searchParams.get('q'), 'USDe');
    assert.equal(destination.searchParams.get('page_size'), '50');
    assert.equal(destination.hash, '#target-abc');
  }
  page.set('sort', 'curated');
  assert.equal(page.submit().searchParams.get('sort'), 'curated');
});

test('row summaries reuse passive estimates, including zero, without converting missing data or implying readiness', () => {
  const html = views().passive;
  const rows = [...html.matchAll(/<li data-target-row[^>]*>[\s\S]*?<\/summary>/g)].map(([row]) => row);
  assert.equal(rows.length, 3);
  assert.match(rows[0], /Passive est\. · 16\.25 h/);
  assert.match(rows[0], /Hold reported/);
  assert.match(rows[0], /Stale · 40m ago/);
  assert.match(rows[0], /Fresh · 1m ago/);
  assert.match(rows[1], /Passive est\. · Not reported/);
  assert.match(rows[1], /data-status="BLOCKED"/);
  assert.match(rows[1], /BLOCKED/);
  assert.match(rows[1], /Unknown · Age not reported/);
  assert.doesNotMatch(rows[1], /0s|Passive est\. · 0 h/);
  assert.match(rows[2], /Passive est\. · 0 h/);
  assert.match(rows[2], /Fresh · 0s/);
  assert.match(views().inventory, /Passive est\. · Not reported/);
  assert.match(html, /Passive time estimates assume unchanged rates and prices/);
  assert.match(html, /not guaranteed countdowns to liquidation or proof of execution readiness/);
  assert.match(html, /Unknown or unusable estimates sort last/);
  assert.doesNotMatch(source, /passive_hours|passive_time/);
});

test('runner summaries show normalized reasons, omit absent or recovered reasons, and escape text', () => {
  const html = views().runnerReasons;
  const rows = [...html.matchAll(/<li data-target-row[^>]*>[\s\S]*?<\/summary>/g)].map(([row]) => row);
  assert.match(rows[0], /Shared runner blocked: provider disagreement\./);
  assert.match(rows[0], /BLOCKED/);
  assert.match(rows[0], /Unknown · Age not reported/);
  assert.match(rows[0], /Fresh · 1m ago/);
  assert.match(rows[0], /data-status="HELD"/);
  assert.match(html, /<dt>Last checked<\/dt><dd>2026-10-24T09:10:00Z<\/dd>/);
  assert.equal((html.match(/Shared runner blocked: provider disagreement\./g) || []).length, 2, 'One summary reason plus the existing expanded note');
  for (const row of rows.slice(1)) assert.doesNotMatch(row, /Shared runner blocked|provider disagreement|PROVIDER_DISAGREEMENT/);
  assert.match(rows[2], /CHECK_ONLY/);
  assert.match(rows[2], /Fresh · 0s/);
  assert.doesNotMatch(views().inventory, /Shared runner blocked/);
  assert.doesNotMatch(html, /RAW_PRODUCER_ERROR_DO_NOT_RENDER|PROVIDER_DISAGREEMENT/);
  const escaped = views().unsafe.match(/<li data-target-row[^>]*>[\s\S]*?<\/summary>/)[0];
  assert.match(escaped, /&lt;img src=x onerror=&#34;bad\(\)&#34;&gt;/);
  assert.doesNotMatch(escaped, /<img src=x/);
});

test('normal automatic refresh keeps the applied passive sort and page in the URL', () => {
  const href = 'http://localhost/targets?sort=passive_time&page=2&page_size=50#targets-list';
  const document = element({ body: { dataset: { refreshInterval: '60000' } }, hidden: false, querySelector: () => null, querySelectorAll: () => [] });
  let refresh;
  let reloaded = 0;
  const window = { sessionStorage: { getItem: () => null }, clearTimeout() {}, setTimeout(callback, delay) { assert.equal(delay, 60000); refresh = callback; }, location: { href, reload() { reloaded += 1; } } };
  vm.runInNewContext(refreshSource, { document, window });
  refresh();
  assert.equal(reloaded, 1);
  assert.equal(window.location.href, href);
  assert.equal(harness({ html: views().passive, url: href }).form.elements.namedItem('sort').value, 'passive_time');
});

test('chain, protocol, status, and curated sorts stay in native GET queries', () => {
  const page = harness();
  for (const sort of ['chain', 'protocol', 'status', 'curated']) {
    page.set('sort', sort);
    assert.equal(page.submit().searchParams.get('sort'), sort);
  }
  page.set('status', 'HELD');
  assert.equal(page.submit().searchParams.get('status'), 'HELD');
});

test('submission preserves repeated unrelated parameters and the current hash', () => {
  const page = harness();
  const url = page.submit();
  assert.equal(url.searchParams.get('other'), 'keep');
  assert.deepEqual(url.searchParams.getAll('tag'), ['one', 'two']);
  assert.equal(url.searchParams.get('extra'), '<b>escaped</b>');
  assert.equal(url.hash, '#target-abc');
  assert.equal(url.pathname, '/targets');
});

test('clear is a normal link that resets filters and page size, preserving unrelated URL state', () => {
  const page = harness();
  const clear = page.links.find((link) => new URL(link.href, page.window.location.href).pathname === '/targets' && !new URL(link.href, page.window.location.href).searchParams.has('sort'));
  const url = new URL(clear.href, page.window.location.href);
  for (const name of ['q', 'chain', 'protocol', 'source', 'status', 'sort', 'page_size']) assert.equal(url.searchParams.has(name), false);
  assert.equal(url.searchParams.get('page'), '1');
  assert.equal(url.searchParams.get('other'), 'keep');
  assert.deepEqual(url.searchParams.getAll('tag'), ['one', 'two']);
  assert.equal(url.hash, '#target-abc');
});

test('server-normalized controls are not overwritten by rejected URL parameters', () => {
  const page = harness({ url: 'http://localhost/targets?q=REJECTED_QUERY&chain=REJECTED_CHAIN&sort=constructor&page=999#targets-list' });
  assert.equal(page.form.elements.namedItem('q').value, 'USDe');
  assert.equal(page.form.elements.namedItem('chain').value, '');
  assert.equal(page.form.elements.namedItem('sort').value, 'curated');
  assert.doesNotMatch(views().inventory, /REJECTED_QUERY|REJECTED_CHAIN|REJECTED_SOURCE|BAD_SIZE/);
  assert.match(views().unsafe, /Some query values were adjusted/);
  assert.match(views().unsafe, /page · clamped/);
});

test('stable position-key disclosures delegate persistence to the unchanged shared refresh script', () => {
  const html = views().inventory;
  assert.match(html, new RegExp(`id="target-${'1'.repeat(64)}"`));
  assert.doesNotMatch(html, /id="target-legacy/);
  assert.doesNotMatch(source, /sessionStorage|localStorage|\.open\s*=|setTimeout\(|setInterval\(|fetch\(/);
  const storage = new Map([['watchboard-details-open', JSON.stringify({ [`target-${'1'.repeat(64)}`]: true, 'targets-coverage': true })]]);
  const details = [{ id: `target-${'1'.repeat(64)}`, open: false }, { id: `target-${'2'.repeat(64)}`, open: false }, { id: 'targets-coverage', open: false }];
  const document = element({ body: { dataset: { refreshInterval: '60000' } }, hidden: false, querySelector: () => null, querySelectorAll: () => details });
  let timers = 0;
  const window = { sessionStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) }, clearTimeout() {}, setTimeout(_fn, delay) { assert.equal(delay, 60000); timers += 1; } };
  vm.runInNewContext(refreshSource, { document, window });
  assert.equal(details[0].open, true);
  assert.equal(details[1].open, false);
  assert.equal(details[2].open, true);
  assert.equal(timers, 1);
});

test('empty and missing shortlists do not claim healthy or complete coverage', () => {
  assert.match(views().empty, /Rows 0–0 of 0 matching \/ 156 candidates/);
  assert.match(views().empty, /No matching candidates/);
  assert.match(views().missing, /No candidate records available/);
  assert.match(views().missing, /Inputs may be empty, missing, or invalid/);
  assert.match(views().unknown, /Coverage unknown/);
  assert.match(views().unknown, /Rows Unknown–Unknown of Unknown matching \/ Unknown candidates/);
  assert.match(views().unknown, /No candidate-source coverage details are available/);
  assert.doesNotMatch(views().unknown, /<dd>0<\/dd>/);
  assert.equal(harness({ html: views().empty }).submit().searchParams.get('page'), '1');
});

test('pagination uses normal links with normalized query and accessible current-page counts', () => {
  const page = harness();
  const previous = new URL(page.links.find((link) => link.rel === 'prev').href, page.window.location.href);
  const next = new URL(page.links.find((link) => link.rel === 'next').href, page.window.location.href);
  assert.equal(previous.searchParams.get('page'), '1');
  assert.equal(next.searchParams.get('page'), '3');
  assert.equal(next.searchParams.get('q'), 'USDe');
  assert.equal(next.searchParams.get('page_size'), '50');
  assert.deepEqual(next.searchParams.getAll('tag'), ['one', 'two']);
  assert.equal(next.hash, '#target-abc');
  assert.match(views().inventory, /aria-current="page">Page 2 of 3/);
  assert.match(views().inventory, /Rows 51–53 of 125 matching \/ 156 candidates/);
  assert.match(views().inventory, /3 candidates on this page · 50 per page/);
  assert.doesNotMatch(views().empty, /rel="prev"|rel="next"/);
  assert.match(views().empty, /aria-disabled="true">Next/);
});

test('all filter, sort, and page-size submissions reset to page one', () => {
  const page = harness();
  for (const [name, value] of [['q', 'new terms'], ['chain', 'Base'], ['protocol', 'Morpho Blue'], ['source', 'near3'], ['status', 'HELD'], ['sort', 'distance-desc'], ['page_size', '200']]) {
    page.form.elements.namedItem('page').value = '99';
    page.set(name, value);
    const url = page.submit();
    assert.equal(url.searchParams.get('page'), '1');
    assert.equal(url.searchParams.get(name), value);
  }
  assert.equal(harness({ html: views().unsafe }).form.elements.namedItem('page_size').value, '75');
  assert.match(views().inventory, /<option value="50" selected>50<\/option>/);
  assert.match(views().inventory, /<option value="200">200<\/option>/);
});

test('hash changes and back-forward restoration update ordinary navigation destinations', () => {
  const page = harness();
  page.window.location.href = 'http://localhost/targets?page=2#targets-coverage';
  page.window.fire('hashchange');
  assert.equal(page.submit().hash, '#targets-coverage');
  for (const link of page.links) assert.equal(new URL(link.href, page.window.location.href).hash, '#targets-coverage');
  page.window.location.href = 'http://localhost/targets?page=2';
  page.window.fire('pageshow');
  for (const link of page.links) assert.equal(new URL(link.href, page.window.location.href).hash, '');
});

test('coverage exposes dynamic source counts, truncation, missing counts, and upstream limitations', () => {
  const html = views().inventory;
  assert.match(html, /Partial coverage/);
  assert.match(html, /Maximum input ceilings: 600000 input rows and 100000000 bytes\./);
  assert.match(html, /Candidate-source coverage/);
  assert.match(html, /3 sources consulted · inspect counts and gaps/);
  assert.match(html, /Unread historical indexes are not counted/);
  assert.match(html, /Source counts overlap; candidate totals are deduplicated/);
  assert.match(html, /Curated evidence is incomplete/);
  assert.match(html, /<dt>Omitted<\/dt><dd>49<\/dd>/);
  assert.match(html, /<dt>Truncated<\/dt><dd>Yes<\/dd>/);
  const missing = html.match(/<article class="t-source" data-source-state="MISSING">[\s\S]*?<\/article>/)[0];
  assert.match(missing, /<dt>Accepted<\/dt><dd>Unknown<\/dd>/);
  assert.match(missing, /<dt>Source-reported total<\/dt><dd>Unknown<\/dd>/);
  assert.match(missing, /<dt>Truncated<\/dt><dd>Unknown<\/dd>/);
  assert.doesNotMatch(missing, /<dd>0<\/dd>/);
  for (const state of ['OK', 'PARTIAL', 'MISSING', 'INVALID', 'OVERSIZED', 'UNAVAILABLE']) assert.match(views().states, new RegExp(`data-source-state="${state}"`));
  assert.match(views().complete, /Candidate inputs read/);
  assert.match(views().complete, /not every on-chain position or current health/);
});

test('held, stale, unknown, observation-only, and eligible remain distinct from execution readiness', () => {
  for (const status of ['HELD', 'ELIGIBLE', 'WATCH', 'OBSERVATION_ONLY', 'STALE', 'UNKNOWN']) assert.match(views().states, new RegExp(`data-target-row data-status="${status}"`));
  const held = views().inventory.match(/<li data-target-row data-status="HELD">[\s\S]*?<\/li>/)[0];
  assert.match(held, /pill t-held">Held/);
  assert.match(held, /Protocol: Watch/);
  assert.match(held, /Hold reported/);
  assert.match(held, /40m ago/);
  assert.match(held, /No · telemetry only/);
  const unknown = views().inventory.match(/<li data-target-row data-status="UNKNOWN">[\s\S]*?<\/li>/)[0];
  assert.match(unknown, /No valid quote/);
  assert.match(unknown, /<dt>Runner hold<\/dt><dd>Unknown<\/dd>/);
  assert.match(views().inventory, /waiting, held, and observation-stage candidates/);
  assert.match(views().inventory, /Inclusion does not establish execution readiness or profit/);
  assert.match(views().inventory, /Gross quote ≠ net or realized profit/);
});

test('curated observation-stage borrowers keep their identity and blockers without readiness claims', () => {
  const candidate = views().inventory.match(/<li data-target-row data-status="OBSERVATION_ONLY">[\s\S]*?<\/li>/)[0];
  assert.match(candidate, /M2 curated borrower/);
  assert.match(candidate, /Account 0x333…333/);
  assert.match(candidate, /Observation stage: current health and exit quote not established/);
  assert.match(candidate, /No valid quote/);
  assert.doesNotMatch(candidate, /Market \/ vault observation|Not applicable · market \/ vault record|Yes · telemetry only/);
  assert.match(views().inventory, /Sources: Near-three monitor · Curated borrower observations/);
  assert.match(views().inventory, /Stored source evidence/);
  assert.match(views().inventory, /2026-10-19T22:59:00Z/);
  assert.match(views().inventory, /A recent source does not refresh an older health check, quote, or runner hold/);
});

test('candidate-only scope, current-page rows, global counts, and curated-reference pins are clear', () => {
  const html = views().inventory;
  assert.equal((html.match(/<li data-target-row/g) || []).length, 3);
  assert.match(html, /Global candidate counts, deduplicated before filtering/);
  assert.match(html, /CURATED REFERENCE/);
  assert.match(html, /not a shared pin for other chains or sources/);
  assert.match(html, /<title>Trade candidates · Watchboard<\/title>/);
  assert.match(html, /<h1>Trade candidates<span/);
  assert.match(html, /<h2 id="targets-register-title">Candidates<\/h2>/);
  assert.match(html, /CURATED BORROWER SHORTLIST/);
  assert.match(html, /Historical identities and market-only observations are excluded/);
  assert.match(html, /Apply searches and sorts the full candidate shortlist/);
  assert.doesNotMatch(html, /Every tracked position|All targets|All records are shown|STORED TARGET INVENTORY|Historical borrower identities remain listed|stored records|name="(?:view_mode|archive)"/);
  assert.doesNotMatch(template, /\|tojson|data-search=|targets\|map|\|safe\b/);
  assert.match(html, /id="targets-runners"/);
  assert.match(html, /id="targets-fork-evidence"/);
});

test('template text and query values are escaped, not inserted as HTML', () => {
  const html = views().unsafe;
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=&#34;bad\(\)&#34;&gt;/);
  assert.doesNotMatch(html, /<script>alert|<img src=x/);
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML/);
});

test('responsive inventory hooks retain visible labels, wrapping grids, focus, and large touch targets', () => {
  assert.match(css, /\.t-coverage-grid\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css, /@media\(max-width:800px\)\{\.targets-page \.t-coverage-grid\{grid-template-columns:1fr/);
  assert.match(css, /\.t-filter-actions\{grid-column:1\/-1/);
  assert.match(css, /\.t-source-counts\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css, /min-height:42px/);
  assert.match(css, /focus-visible/);
  assert.match(css, /overflow-wrap:anywhere/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(views().inventory, /class="t-mobile-label"/);
});

test('script is inert on other pages and adds no refresh or query-history owner', () => {
  vm.runInNewContext(source, { document: { querySelector: () => null } });
  assert.doesNotMatch(source, /history\.|replaceState|pushState|popstate|location\.reload|fetch\(|setTimeout\(|setInterval\(/);
  assert.match(views().inventory, /data-refresh-status/);
  assert.match(views().inventory, /data-refresh-interval="60000"/);
});

test('Inventory and Targets navigation links select only the active route', () => {
  for (const [html, route, label, otherRoute, otherLabel] of [
    [views().historical, '/inventory', 'Inventory', '/targets', 'Targets'],
    [views().inventory, '/targets', 'Targets', '/inventory', 'Inventory'],
  ]) {
    const nav = html.match(/<nav aria-label="Primary navigation">[\s\S]*?<\/nav>/)[0];
    assert.ok(nav.includes(`<a href="${route}" aria-current="page">${label}</a>`));
    assert.ok(nav.includes(`<a href="${otherRoute}">${otherLabel}</a>`));
    assert.equal((nav.match(/aria-current="page"/g) || []).length, 1);
  }
});

test('historical inventory describes stored records, not a trade list or snapshot timeline', () => {
  const html = views().historical;
  assert.match(html, /<title>Historical inventory · Watchboard<\/title>/);
  assert.match(html, /<h1>Historical inventory<span/);
  assert.match(html, /Full stored borrower and market inventory, including some current trade candidates/);
  assert.match(html, /A historical identity is not proof of current debt or an executable trade/);
  assert.match(html, /Stored records, not a trade list/);
  assert.match(html, /Not complete on-chain coverage/);
  assert.match(html, /This is not a timeline of past snapshots/);
  assert.match(html, /<h2 id="targets-register-title">Stored records<\/h2>/);
  assert.match(html, /Global stored counts, deduplicated before filtering/);
  assert.match(html, /Rows 51–53 of 125 matching \/ 320456 records/);
  assert.match(html, /3 records on this page · 50 per page/);
  assert.match(html, /Stored-source coverage/);
  assert.match(html, /4 sources consulted · inspect counts and gaps/);
  assert.match(html, /Search stored records/);
  assert.doesNotMatch(html, /Historical identities and market-only observations are excluded|Candidate-source coverage|CURATED BORROWER SHORTLIST|320456 candidates/);
});

test('inventory native GET applies all filters and page-size changes on page one without switching routes', () => {
  const html = views().historical;
  const page = harness({ html, url: 'http://localhost/inventory?other=keep&page=2#target-abc' });
  assert.match(html, /data-target-filters action="\/inventory" method="get"/);
  assert.doesNotMatch(html.match(/<form\b[^>]*data-target-filters[^>]*>/)[0], /\bhidden\b/);
  assert.match(html, /<option value="borrower-history">Historical borrower index<\/option>/);
  assert.match(html, /<option value="Compound V3">Compound V3<\/option>/);
  assert.match(html, /<option value="50" selected>50<\/option>/);
  assert.match(html, /<option value="200">200<\/option>/);
  for (const [name, value] of [['q', 'historical borrower'], ['chain', 'Base'], ['protocol', 'Compound V3'], ['source', 'borrower-history'], ['status', 'UNKNOWN'], ['sort', 'distance-desc'], ['page_size', '200']]) {
    page.form.elements.namedItem('page').value = '77';
    page.set(name, value);
    const url = page.submit();
    assert.equal(url.pathname, '/inventory');
    assert.equal(url.searchParams.get('page'), '1');
    assert.equal(url.searchParams.get(name), value);
    assert.equal(url.searchParams.get('other'), 'keep');
    assert.deepEqual(url.searchParams.getAll('tag'), ['one', 'two']);
    assert.equal(url.searchParams.get('extra'), '<b>escaped</b>');
    assert.equal(url.hash, '#target-abc');
  }
});

test('both modes keep pagination and current-page JSON links on their own routes with query and hash intact', () => {
  for (const [html, route] of [[views().historical, '/inventory'], [views().inventory, '/targets']]) {
    const page = harness({ html, url: `http://localhost${route}?page=2#targets-coverage` });
    for (const link of page.links) {
      const url = new URL(link.href, page.window.location.href);
      assert.ok([route, `/api/v1${route}`].includes(url.pathname));
      assert.equal(url.searchParams.get('other'), 'keep');
      assert.deepEqual(url.searchParams.getAll('tag'), ['one', 'two']);
      assert.equal(url.hash, '#targets-coverage');
      if (link.rel === 'prev') assert.equal(url.searchParams.get('page'), '1');
      if (link.rel === 'next') assert.equal(url.searchParams.get('page'), '3');
    }
    const json = new URL(page.links.find((link) => link.href.startsWith('/api/v1/')).href, page.window.location.href);
    assert.equal(json.pathname, `/api/v1${route}`);
    assert.equal(json.searchParams.get('q'), 'USDe');
    assert.equal(json.searchParams.get('sort'), 'curated');
    assert.equal(json.searchParams.get('page'), '2');
    assert.equal(json.searchParams.get('page_size'), '50');
    assert.match(html, /aria-current="page">Page 2 of 3/);
  }
});

test('inventory clear links, including the empty state, reset only filters and preserve the inventory route', () => {
  const page = harness({ html: views().historicalEmpty, url: 'http://localhost/inventory?page=2#targets-list' });
  const clearLinks = page.links.filter((link) => {
    const url = new URL(link.href, page.window.location.href);
    return url.pathname === '/inventory' && !url.searchParams.has('sort');
  });
  assert.equal(clearLinks.length, 2);
  for (const link of clearLinks) {
    const url = new URL(link.href, page.window.location.href);
    assert.equal(url.pathname, '/inventory');
    assert.equal(url.searchParams.get('page'), '1');
    for (const name of ['q', 'chain', 'protocol', 'source', 'status', 'sort', 'page_size']) assert.equal(url.searchParams.has(name), false);
    assert.equal(url.searchParams.get('other'), 'keep');
    assert.deepEqual(url.searchParams.getAll('tag'), ['one', 'two']);
    assert.equal(url.hash, '#targets-list');
  }
  page.window.location.href = 'http://localhost/inventory#targets-coverage';
  page.window.fire('hashchange');
  assert.equal(page.submit().hash, '#targets-coverage');
  page.window.location.href = 'http://localhost/inventory';
  page.window.fire('pageshow');
  assert.equal(page.submit().hash, '');
});

test('inventory missing coverage and empty results preserve unknown counts and record terminology', () => {
  assert.match(views().historicalEmpty, /Rows 0–0 of 0 matching \/ 320456 records/);
  assert.match(views().historicalEmpty, /No matching stored records/);
  assert.match(views().historicalEmpty, /Other records are still in the inventory/);
  assert.match(views().historicalMissing, /No stored records available/);
  assert.match(views().historicalMissing, /No readable inventory inputs/);
  assert.match(views().historicalMissing, /Inputs may be empty, missing, or invalid/);
  assert.match(views().historicalUnknown, /Coverage unknown/);
  assert.match(views().historicalUnknown, /Rows Unknown–Unknown of Unknown matching \/ Unknown records/);
  assert.match(views().historicalUnknown, /No stored-source coverage details are available/);
  assert.doesNotMatch(views().historicalUnknown, /<dd>0<\/dd>/);
  const missing = views().historical.match(/<article class="t-source" data-source-state="MISSING">[\s\S]*?<\/article>/)[0];
  assert.match(missing, /<dt>Accepted<\/dt><dd>Unknown<\/dd>/);
  assert.match(views().historical, /Upstream borrower coverage is incomplete/);
  assert.match(views().historical, /<dt>Truncated<\/dt><dd>Yes<\/dd>/);
});

test('inventory renders only the current page with stable identities, independent holds, and no invented market borrower', () => {
  const html = views().historical;
  assert.equal((html.match(/<li data-target-row/g) || []).length, 3);
  assert.match(html, new RegExp(`id="target-${'1'.repeat(64)}"`));
  assert.match(html, /pill t-held">Held/);
  assert.match(html, /Protocol: Watch/);
  assert.match(html, /40m ago/);
  assert.match(html, /No · telemetry only/);
  const historicalRow = html.match(/<li data-target-row data-status="UNKNOWN">[\s\S]*?<\/li>/)[0];
  assert.match(historicalRow, /Historical borrower identity/);
  assert.match(historicalRow, /<dt>Runner hold<\/dt><dd>Unknown<\/dd>/);
  assert.match(historicalRow, /No valid quote/);
  assert.doesNotMatch(historicalRow, /Yes · telemetry only/);
  const market = html.match(/<li data-target-row data-status="OBSERVATION_ONLY">[\s\S]*?<\/li>/)[0];
  assert.match(market, /Market \/ vault observation/);
  assert.match(market, /Not applicable · market \/ vault record/);
  assert.doesNotMatch(market, /Account not reported|Account 0x/);
  for (const id of ['targets-coverage', 'targets-runners', 'targets-fork-evidence']) assert.ok(html.includes(`id="${id}"`));
  assert.match(html, /data-refresh-interval="60000"/);
  assert.match(html, /data-refresh-status/);
});

test('presentation routes and titles follow the server mode, never a conflicting query parameter', () => {
  for (const [html, route, title] of [
    [views().candidateSpoof, '/targets', 'Trade candidates'],
    [views().historySpoof, '/inventory', 'Historical inventory'],
  ]) {
    const page = harness({ html, url: `http://localhost${route}?view_mode=wrong#targets-list` });
    assert.ok(html.includes(`<title>${title} · Watchboard</title>`));
    assert.equal(page.submit().pathname, route);
    for (const link of page.links) assert.ok([route, `/api/v1${route}`].includes(new URL(link.href, page.window.location.href).pathname));
  }
});
