'use strict';

// Offline real-template rendering and small DOM harnesses. No app import,
// catalog/artifact access, host collection, server, browser, or network calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '../..');
const css = fs.readFileSync(path.join(root, 'dashboard/static/deployed-contracts.css'), 'utf8');
const js = fs.readFileSync(path.join(root, 'dashboard/static/deployed-contracts.js'), 'utf8');
const theme = fs.readFileSync(path.join(root, 'dashboard/static/dashboard.css'), 'utf8');
const refresh = fs.readFileSync(path.join(root, 'dashboard/static/refresh.js'), 'utf8');
const partial = fs.readFileSync(path.join(root, 'dashboard/templates/_deployed_contracts.html'), 'utf8');
const address = '0x' + '1'.repeat(40);
const txHash = '0x' + '2'.repeat(64);
const jobs = {
  freshness: 'FRESH', observedAt: '2026-10-26T06:00:00Z', inspection: { processes: 'OK', scheduler: 'OK' },
  jobs: ['READY', 'DISABLED'].map((state, index) => ({
    id: `fixture-runner-${index}`, label: `Fixture runner ${index}`, description: 'Synthetic process observation.', kind: 'watcher', scriptId: `fixture-runner-${index}`,
    process: { state: 'RUNNING', pids: [913771 + index], pid: 913771 + index, instanceCount: 1, matchKind: 'WORKSPACE_PATH', startedAt: '2026-10-26T05:00:00Z', windowVisible: false },
    schedule: { taskId: `FixtureTask${index}`, state, enabled: state === 'READY', cadenceSeconds: 3600, lastRunAt: null, nextRunAt: null, lastResultCode: 0, hiddenLaunch: true },
  })),
};
const fixture = {
  catalog_as_of: '2026-10-26', read_only: true, live_chain_checked_at: null,
  summary: { total: 40, matched: 4, executors: 32, other_contracts: 8, receipt_backed: 24, recorded_only: 16, chains: 3 },
  filters: { contract_q: '', contract_chain: '', contract_kind: '', contract_evidence: '' },
  options: {
    chains: [{ value: '1', label: 'Ethereum' }, { value: '8453', label: 'Base' }, { value: '42161', label: 'Arbitrum' }],
    kinds: [{ value: 'executor', label: 'Executor' }, { value: 'helper', label: 'Helper' }, { value: 'other', label: 'Other' }],
    evidence: [{ value: 'receipt_backed', label: 'Receipt recorded' }, { value: 'recorded_only', label: 'Deployment record only' }],
  },
  coverage: { summary: 'Synthetic UI fixture only; not a deployment inventory.', exclusions: ['BuilderPay staged rehearsal is not a live deployment.', 'Third-party protocol targets are excluded.'], gaps: ['Older receipts may be missing.'] },
  notices: ['Historical evidence does not establish current state.'],
  contracts: ['unknown', 'held', 'disabled', 'unknown'].map((state, index) => ({
    id: `fixture-${index}`, name: `Example contract ${index}`, aliases: ['Historical contract alias'], kind: index === 0 ? 'executor' : 'helper', kind_label: index === 0 ? 'Executor' : 'Helper',
    chain_id: 1, chain_name: 'Ethereum', address, explorer_url: `https://etherscan.io/address/${address}`,
    purpose: 'Recorded settlement and unwind implementation.', protocols: ['Protocol A', 'Protocol B'], funding: 'Atomic borrowed principal; no current balance observed.',
    capabilities: ['Settle obligations atomically.', 'Return remaining assets.'], source_paths: ['contracts/Example.sol'],
    deployment: { status: index % 2 ? 'recorded_only' : 'receipt_backed', label: index % 2 ? 'Deployment record only' : 'Receipt recorded', tx_hash: index % 2 ? null : txHash,
      tx_url: index % 2 ? null : `https://etherscan.io/tx/${txHash}`, block_number: index % 2 ? null : 25000000, observed_at: '2026-10-01T12:00:00Z', gas_used: index % 2 ? null : '1700000', note: 'Historical evidence, not checked on chain now.' },
    ownership: { owner_address: '0x' + '3'.repeat(40), access: 'Owner-gated entry point in recorded source.', upgradeability: 'Not established.' },
    code: { runtime_hash: '0x' + '4'.repeat(64), verification: 'Recorded runtime/source comparison only.', compiler: '0.8.26' },
    runners: [{ job_id: index < 2 ? `fixture-runner-${index}` : null, label: `Fixture runner ${index}`, script_id: `fixture-runner-${index}`, state: ['RUNNING', 'NOT_RUNNING', 'UNKNOWN', 'UNMAPPED'][index],
      pids: index === 0 ? [913771] : [], observed_at: '2026-10-26T06:00:00Z', match_kind: index === 0 ? 'SCRIPT_MATCH' : 'NONE', note: 'Mapping is not contract activity evidence.', url: index < 2 ? `#job-fixture-runner-${index}` : null }],
    readiness: { state, label: state === 'held' ? 'Held for separate approval' : state === 'disabled' ? 'Recorded mode disabled' : 'Readiness not established', note: 'No execution authority is conferred by this record.' },
    blockers: index === 0 ? [] : ['Current funding and authorization have not been checked.'],
    evidence: [{ path: 'reports/example/receipt.json', lines: '10-18', note: 'Retained deployment evidence.' }],
  })),
};

let rendered;
function views() {
  if (rendered) return rendered;
  const filtered = structuredClone(fixture);
  filtered.filters = { contract_q: 'principal & unwind', contract_chain: '1', contract_kind: 'executor', contract_evidence: 'receipt_backed' };
  filtered.contracts = [filtered.contracts[0]];
  filtered.summary.matched = 1;
  const noMatches = structuredClone(filtered);
  noMatches.contracts = [];
  noMatches.summary.matched = 0;
  const invalid = structuredClone(noMatches);
  invalid.filters = { contract_q: 'missing', contract_chain: '999999', contract_kind: 'bad-kind', contract_evidence: '<invalid>' };
  const empty = structuredClone(fixture);
  empty.contracts = [];
  empty.summary = Object.fromEntries(Object.keys(empty.summary).map(key => [key, 0]));
  const missing = structuredClone(filtered);
  missing.summary = { total: null, matched: null };
  Object.assign(missing.contracts[0], { aliases: [], source_paths: [], evidence: [], runners: [], ownership: {}, code: {}, deployment: {}, readiness: {} });
  const unsafe = structuredClone(filtered);
  unsafe.filters.contract_q = '<img src=x onerror="bad()">';
  Object.assign(unsafe.contracts[0], { name: '<script>bad()</script>', purpose: '<b>purpose</b>', funding: '<i>funding</i>', source_paths: ['javascript:bad()', 'https://example.invalid/source.sol'], evidence: [{ path: 'file:///private', lines: '1-2', note: '<img src=x>' }] });
  unsafe.contracts[0].ownership.access = '<script>access()</script>';
  unsafe.contracts[0].runners[0].note = '<b>runner note</b>';
  unsafe.notices = ['<script>notice()</script>'];
  const eighty = structuredClone(fixture);
  eighty.contracts = Array.from({ length: 80 }, (_, index) => ({ ...structuredClone(fixture.contracts[index % 4]), id: `eighty-${index}`, name: `Long contract ${'W'.repeat(120)} ${index}`, source_paths: [`contracts/${'nested/'.repeat(40)}Example.sol`] }));
  eighty.summary = { ...eighty.summary, total: 80, matched: 80 };
  const stale = structuredClone(jobs);
  stale.freshness = 'STALE';
  const failed = structuredClone(jobs);
  failed.inspection.processes = 'ERROR';
  const input = Object.fromEntries(Object.entries({ full: fixture, filtered, noMatches, invalid, empty, missing, unsafe, eighty }).map(([name, deployed]) => [name, { jobs, deployed }]));
  Object.assign(input, { legacy: { jobs }, stale: { jobs: stale, deployed: fixture }, failed: { jobs: failed, deployed: fixture } });
  const python = `
import json, sys
from types import SimpleNamespace
from urllib.parse import urlencode
from jinja2 import Environment, FileSystemLoader, select_autoescape
from html.parser import HTMLParser
sys.stdin.reconfigure(encoding='utf-8')
env = Environment(loader=FileSystemLoader('dashboard/templates'), autoescape=select_autoescape(['html']))
def url_for(endpoint, **kw):
    if endpoint == 'static': return '/static/' + kw['filename']
    assert endpoint == 'deployed_contracts_api', endpoint
    return '/api/v1/jobs/contracts' + ('?' + urlencode(kw) if kw else '')
env.globals['url_for'] = url_for
class Structure(HTMLParser):
    def __init__(self): super().__init__(); self.tags = []
    def handle_starttag(self, tag, attrs): self.tags.append({'tag': tag, **dict(attrs)})
page = env.get_template('jobs.html')
result = {}
for name, context in json.load(sys.stdin).items():
    html = page.render(**context, request=SimpleNamespace(path='/jobs'))
    parsed = Structure(); parsed.feed(html)
    result[name] = {'html': html, 'tags': parsed.tags}
print(json.dumps(result))
`;
  const run = spawnSync('python', ['-c', python], { cwd: root, input: JSON.stringify(input), encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(run.status, 0, `Offline Jinja rendering failed: ${run.stderr || run.error || ''}`);
  rendered = JSON.parse(run.stdout);
  return rendered;
}
const contractSection = html => html.slice(html.indexOf('<section class="dc"'));
const runnerSection = html => contractSection(html).split('<h3>Mapped runner observations</h3>')[1].split('<h3>Source locations</h3>')[0];
const eventTarget = extra => ({
  listeners: {}, addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
  fire(type) { for (const fn of this.listeners[type] || []) fn(); }, ...extra,
});
function harness({ hash = '', count = 3, outside = false } = {}) {
  const records = Array.from({ length: count }, (_, index) => ({ id: `contract-fixture-${index}`, open: false, scrolls: [], matches: selector => selector === 'details[data-contract-record]', scrollIntoView(options) { this.scrolls.push(options); } }));
  const expand = eventTarget({});
  const collapse = eventTarget({});
  const actions = { hidden: true, querySelector: selector => selector === '[data-contract-expand]' ? expand : collapse };
  const section = { querySelectorAll: () => records, querySelector: () => actions, contains: item => !outside && records.includes(item) };
  const window = eventTarget({ location: { hash } });
  const document = { querySelector: () => section, getElementById: id => records.find(item => item.id === id) };
  vm.runInNewContext(js, { document, window });
  return { records, expand, collapse, actions, window };
}

test('existing Jobs navigation, table markup, states and API link survive the integration', () => {
  const { html, tags } = views().full;
  assert.match(html, /<title>Jobs · Watchboard<\/title>/);
  assert.match(html, /<a href="\/jobs" aria-current="page">Jobs<\/a>/);
  assert.match(html, /<a href="\/api\/v1\/jobs">View JSON<\/a>/);
  const rows = [...html.matchAll(/<tr>.*?<\/tr>/gs)].map(([row]) => row);
  for (const job of jobs.jobs) {
    const row = rows.find(row => row.includes(`<code>${job.scriptId}</code>`));
    assert.ok(row, 'Original bare tr selector still matches');
    assert.ok(row.includes(`id="job-${job.id}"`));
    assert.ok(row.includes(String(job.process.pid)));
    assert.match(row, /Running/);
  }
  assert.match(html, /Idle schedule/);
  assert.match(html, /Automatic launch disabled/);
  assert.ok(tags.some(tag => tag.tag === 'section' && tag.id === 'jobs-register'));
  assert.ok(tags.some(tag => tag.tag === 'a' && tag.href === '#deployed-contracts'));
  assert.ok(tags.some(tag => tag.tag === 'a' && tag.href === '#jobs-register'));
});

test('legacy direct renders without deployed keep Jobs usable and counts unknown, not zero', () => {
  const { html, tags } = views().legacy;
  assert.match(html, /Contract inventory unavailable/);
  assert.match(html, /Deployment data was not supplied with this view/);
  assert.match(html, /<dt>Recorded deployments<\/dt><dd>Unknown<\/dd>/);
  assert.doesNotMatch(contractSection(html), /<dd>0<\/dd>/);
  assert.equal(tags.filter(tag => 'data-contract-record' in tag).length, 0);
  assert.match(html, /913771/);
});

test('native GET filters preserve exact names, values, labels and numeric chain IDs', () => {
  const { tags, html } = views().filtered;
  const form = tags.find(tag => tag.tag === 'form');
  assert.equal(form.method, 'get');
  assert.equal(form.action, '/jobs#deployed-contracts');
  assert.equal(tags.find(tag => tag.name === 'contract_q').value, 'principal & unwind');
  assert.equal(tags.find(tag => tag.name === 'contract_q').maxlength, '200');
  for (const [name, value] of Object.entries({ contract_chain: '1', contract_kind: 'executor', contract_evidence: 'receipt_backed' })) {
    const start = tags.findIndex(tag => tag.tag === 'select' && tag.name === name);
    const end = tags.findIndex((tag, index) => index > start && tag.tag === 'select');
    const selected = tags.slice(start + 1, end < 0 ? tags.length : end).find(tag => tag.tag === 'option' && 'selected' in tag);
    assert.equal(selected.value, value);
  }
  assert.ok(tags.some(tag => tag.tag === 'option' && tag.value === '42161'));
  assert.match(html, /Filters and expandable contract details work without JavaScript/);
  assert.doesNotMatch(js, /preventDefault|fetch\(|XMLHttpRequest|\.filter\(|\.sort\(/);
});

test('unrecognized filter values remain selected and visible, never silently widened', () => {
  const { html, tags } = views().invalid;
  for (const value of ['999999', 'bad-kind', '<invalid>']) assert.ok(tags.some(tag => tag.tag === 'option' && tag.value === value && 'selected' in tag));
  assert.match(html, /Unrecognized: &lt;invalid&gt;/);
  assert.match(html, /No contracts match these filters/);
  assert.equal(tags.filter(tag => 'data-contract-record' in tag).length, 0);
});

test('filtered JSON carries all four filters; Clear returns to the same Jobs section', () => {
  const links = views().filtered.tags.filter(tag => tag.tag === 'a');
  const api = new URL(links.find(tag => tag.class === 'dc-json').href, 'http://localhost');
  assert.equal(api.pathname, '/api/v1/jobs/contracts');
  assert.deepEqual(Object.fromEntries(api.searchParams), { contract_q: 'principal & unwind', contract_chain: '1', contract_kind: 'executor', contract_evidence: 'receipt_backed' });
  assert.ok(links.some(link => link.href === '/jobs#deployed-contracts'));
});

test('counts stay global while rendered contracts and matching count follow the server', () => {
  for (const view of [views().full, views().filtered]) {
    assert.match(view.html, /<dt>Recorded deployments<\/dt><dd>40<\/dd>/);
    assert.match(view.html, /<dt>Receipt recorded<\/dt><dd>24<\/dd>/);
    assert.match(view.html, /<dt>Deployment record only<\/dt><dd>16<\/dd>/);
    assert.match(view.html, /<dt>Executors<\/dt><dd>32<\/dd>/);
    assert.match(view.html, /<dt>Other contracts<\/dt><dd>8<\/dd>/);
    assert.match(view.html, /<dt>Chains<\/dt><dd>3<\/dd>/);
    assert.match(view.html, /Global counts · unaffected by filters/);
  }
  assert.match(views().filtered.html, /<strong>1<\/strong> matching \/ 40 recorded deployments/);
  assert.equal(views().filtered.tags.filter(tag => 'data-contract-record' in tag).length, 1);
  assert.doesNotMatch(views().filtered.html, /Example contract 1/);
});

test('deployment evidence and readiness remain distinct, with no green ready inference', () => {
  const html = contractSection(views().full.html);
  for (const state of ['unknown', 'held', 'disabled']) assert.ok(html.includes(`dc-readiness-${state}">${state[0].toUpperCase() + state.slice(1)}</span>`));
  assert.match(html, /dc-evidence-receipt_backed">Receipt recorded/);
  assert.match(html, /dc-evidence-recorded_only">Deployment record only/);
  assert.match(html, /Recorded deployment ≠ execution readiness/);
  assert.match(html, /No specific blocker recorded\. This does not establish readiness/);
  assert.match(css, /dc-evidence-receipt_backed\{color:var\(--blue\)/);
  assert.doesNotMatch(css, /var\(--ok|var\(--lime/);
  assert.doesNotMatch(partial, /ready now|deployed verified now|100.USDC/i);
});

test('details preserve purpose, funding, aliases, capabilities, ownership, code and provenance', () => {
  const html = views().filtered.html;
  const record = fixture.contracts[0];
  for (const text of [record.purpose, record.funding, ...record.capabilities, ...record.aliases, ...Object.values(record.ownership), ...Object.values(record.code), record.deployment.note, record.readiness.note]) assert.ok(html.includes(text), `Missing ${text}`);
  assert.match(html, /<code>contracts\/Example\.sol<\/code>/);
  assert.match(html, /<code>reports\/example\/receipt\.json:10-18<\/code>/);
  assert.match(html, /Funding model · not a live balance/);
  assert.match(html, /Recorded metadata, not a fresh ownership or bytecode check/);
});

test('missing metadata stays unknown and empty inventories do not imply no deployments', () => {
  const html = contractSection(views().missing.html);
  assert.match(html, /<dt>Recorded deployments<\/dt><dd>Unknown<\/dd>/);
  for (const label of ['Recorded block', 'Deployment gas used', 'Recorded owner', 'Recorded runtime hash']) assert.ok(html.includes(`<dt>${label}</dt><dd>Unknown</dd>`));
  assert.match(html, /No source location recorded/);
  assert.match(html, /No evidence location recorded/);
  assert.match(html, /No runner mapping recorded/);
  assert.match(views().empty.html, /No recorded deployments to display/);
  assert.match(views().empty.html, /An empty catalog does not establish that no contracts have been deployed/);
  assert.match(views().noMatches.html, /Global counts above still cover the full catalog/);
});

test('runner observations link to known row anchors and preserve lower-confidence/unmapped states', () => {
  const html = views().full.html;
  assert.match(runnerSection(html), /913771/);
  assert.match(runnerSection(html), /Lower-confidence script match; workspace not confirmed/);
  assert.match(html, /Not in the job register; this does not mean stopped/);
  for (const state of ['Running', 'Not running', 'Unknown', 'Unmapped']) assert.ok(html.includes(`dc-runner-state">${state}</span>`));
  for (const link of views().full.tags.filter(tag => tag.href?.startsWith('#job-'))) assert.ok(views().full.tags.some(tag => tag.id === link.href.slice(1)));
  assert.match(runnerSection(html), /A running runner is not proof this contract is active, funded, or authorized/);
});

test('stale or failed process inspection withholds runner PIDs and current state without calling it stopped', () => {
  for (const view of [views().stale, views().failed]) {
    assert.doesNotMatch(view.html, /913771|913772/);
    const runners = runnerSection(view.html);
    assert.match(runners, /dc-runner-state">Unknown/);
    assert.match(runners, /Current state and PIDs are withheld/);
    assert.doesNotMatch(runners, /dc-runner-state">Running/);
    assert.match(view.html, /dc-runner-state">Unmapped/);
  }
});

test('retained dates and staged exclusions never become fresh verification or deployment counts', () => {
  const html = contractSection(views().full.html);
  assert.match(html, /<time datetime="2026-10-26">2026-10-26<\/time>/);
  assert.match(html, /Evidence observation time<\/dt><dd><time datetime="2026-10-01T12:00:00Z">2026-10-01 12:00:00Z/);
  assert.match(html, /This page performs no live chain check/);
  assert.match(html, /BuilderPay staged rehearsal is not a live deployment/);
  assert.match(html, /Older receipts may be missing/);
  assert.match(html, /it does not verify deployments on-chain/);
  assert.doesNotMatch(js, /Date\b|setInterval|setTimeout|sessionStorage|localStorage/);
});

test('all catalog text is escaped; source/evidence paths are plain text, not links', () => {
  const { html, tags } = views().unsafe;
  for (const text of ['&lt;script&gt;bad()&lt;/script&gt;', '&lt;b&gt;purpose&lt;/b&gt;', '&lt;i&gt;funding&lt;/i&gt;', '&lt;script&gt;access()&lt;/script&gt;', '&lt;b&gt;runner note&lt;/b&gt;', '&lt;script&gt;notice()&lt;/script&gt;']) assert.ok(html.includes(text));
  assert.match(html, /<code>javascript:bad\(\)<\/code>/);
  assert.match(html, /<code>file:\/\/\/private:1-2<\/code>/);
  assert.doesNotMatch(html, /<img|<script>bad|<b>purpose/);
  for (const tag of tags) {
    assert.ok(!Object.keys(tag).some(key => /^on/i.test(key)), 'No inline event handlers');
    assert.ok(!('style' in tag), 'No inline styles');
    if (tag.tag === 'a') assert.doesNotMatch(tag.href, /^javascript:|^file:|example\.invalid|reports\/example|contracts\/Example/);
  }
  assert.doesNotMatch(partial, /\|safe\b/);
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|eval\(/);
});

test('explorer links use provided safe URLs, new-tab disclosure, and noreferrer', () => {
  const { tags, html } = views().filtered;
  const external = tags.filter(tag => tag.tag === 'a' && tag.href.startsWith('https:'));
  assert.deepEqual(external.map(tag => tag.href), [`https://etherscan.io/address/${address}`, `https://etherscan.io/tx/${txHash}`]);
  for (const tag of external) { assert.equal(tag.target, '_blank'); assert.equal(tag.rel, 'noopener noreferrer'); }
  assert.match(html, /opens a new tab/);
  assert.equal(views().missing.tags.filter(tag => tag.tag === 'a' && tag.href.includes('/tx/')).length, 0);
});

test('local assets preserve CSP and the page has no execution controls', () => {
  const { html, tags } = views().full;
  for (const tag of tags.filter(tag => tag.tag === 'script' || tag.rel === 'stylesheet')) assert.ok((tag.src || tag.href).startsWith('/static/'));
  assert.doesNotMatch(css, /@import|https?:\/\//);
  const section = contractSection(html);
  const buttons = [...section.matchAll(/<button\b[^>]*>([^<]*)<\/button>/g)].map(([, text]) => text);
  assert.deepEqual(buttons, ['Apply filters', 'Expand shown', 'Collapse shown']);
  assert.doesNotMatch(section, /method="post"|data-wallet|Re-arm|Trade now|Start runner|Stop runner/i);
  assert.doesNotThrow(() => vm.runInNewContext(js, { document: { querySelector: () => null } }));
});

test('native details and labelled controls have unique, stable IDs and valid accessible references', () => {
  for (const { tags } of Object.values(views())) {
    const ids = tags.filter(tag => tag.id).map(tag => tag.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(tags.filter(tag => tag.tag === 'h1').length, 1);
    for (const control of tags.filter(tag => ['input', 'select'].includes(tag.tag))) assert.ok(tags.some(tag => tag.tag === 'label' && tag.for === control.id));
    for (const tag of tags) for (const attribute of ['aria-labelledby', 'aria-describedby', 'aria-controls']) {
      for (const id of (tag[attribute] || '').split(/\s+/).filter(Boolean)) assert.ok(ids.includes(id), `Missing ${attribute}: ${id}`);
    }
    for (const tag of tags.filter(tag => 'data-contract-record' in tag)) {
      assert.equal(tag.tag, 'details');
      assert.ok(!('open' in tag));
      assert.ok(tags.some(link => link.href === `#${tag.id}`));
    }
  }
});

test('80 long records stay compact and complete, with narrow-screen stacking and no truncation', () => {
  assert.equal(views().eighty.tags.filter(tag => 'data-contract-record' in tag).length, 80);
  assert.match(views().eighty.html, /<strong>80<\/strong> matching \/ 80 recorded deployments/);
  assert.match(css, /overflow-wrap:anywhere/);
  assert.match(css, /min-width:0/);
  assert.doesNotMatch(css, /line-clamp|text-overflow:ellipsis/);
  assert.match(css, /@media\(max-width:760px\)/);
  assert.match(css, /dc-list-heading\{display:none\}/);
  assert.match(css, /dc-detail-grid,\.jobs-page \.dc-runners\{grid-template-columns:1fr\}/);
  const narrow = css.slice(css.indexOf('@media(max-width:520px)'));
  assert.match(narrow, /dc-filters\{grid-template-columns:minmax\(0,1fr\)/);
  assert.match(narrow, /dc-search\{grid-column:auto\}/);
  assert.match(narrow, /dc-filters :is\(input,select\)\{font-size:16px\}/);
  assert.match(css, /:focus-visible\{outline:3px solid var\(--focus\)/);
  assert.match(css, /min-height:44px/);
  assert.match(css, /@media\(prefers-reduced-motion:no-preference\)/);
  assert.match(css, /html:has\(\.jobs-shell\)\{scroll-behavior:auto\}/);
});

const luminance = hex => {
  if (hex.length === 4) hex = '#' + [...hex.slice(1)].map(char => char + char).join('');
  const rgb = hex.slice(1).match(/../g).map(value => parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
};
test('small text and evidence/readiness badges meet AA contrast in both themes', () => {
  const palettes = [...theme.matchAll(/:root(?:\[data-theme="light"\])?\{([^}]+)\}/g)].map(([, body]) => Object.fromEntries([...body.matchAll(/--([\w-]+):(#[\da-f]{3,6})(?:;|$)/g)].map(([, key, value]) => [key, value])));
  assert.equal(palettes.length, 2);
  palettes[1].muted = css.match(/:root\[data-theme="light"\] \.jobs-page \.dc\{--muted:(#[\da-f]{6})\}/)[1];
  for (const palette of palettes) for (const [fg, bg] of [['ink', 'card'], ['muted', 'card'], ['muted', 'surface-2'], ['muted', 'paper'], ['muted', 'neutral-bg'], ['blue', 'info-bg'], ['warn-fg', 'warn-bg'], ['on-solid', 'blue']]) {
    const [a, b] = [luminance(palette[fg]), luminance(palette[bg])].sort((a, b) => b - a);
    assert.ok((a + .05) / (b + .05) >= 4.5, `${fg} on ${bg} fails AA`);
  }
});

test('expand/collapse touches only visible contract records, not jobs or coverage', () => {
  const ui = harness();
  assert.equal(ui.actions.hidden, false);
  ui.expand.fire('click');
  assert.ok(ui.records.every(record => record.open));
  ui.collapse.fire('click');
  assert.ok(ui.records.every(record => !record.open));
  assert.equal(harness({ count: 0 }).actions.hidden, true);
});

test('deep links open only the exact contract, safely ignoring invalid and unrelated fragments', () => {
  const ui = harness({ hash: '#contract-fixture-1' });
  assert.deepEqual(ui.records.map(record => record.open), [false, true, false]);
  assert.equal(ui.records[1].scrolls.length, 1);
  ui.window.location.hash = '#contract-fixture-2';
  ui.window.fire('hashchange');
  assert.equal(ui.records[2].open, true);
  for (const hash of ['#job-fixture-runner-0', '#jobs-register', '#contract-coverage', '#contract-missing', '#%ZZ', '#contract-"onclick="x']) assert.ok(harness({ hash }).records.every(record => !record.open));
  assert.ok(harness({ hash: '#contract-fixture-1', outside: true }).records.every(record => !record.open));
});

test('shared refresh restores contract disclosures without changing query, timestamps or snapshot semantics', () => {
  const record = { id: 'contract-fixture-0', open: false };
  const store = new Map([['watchboard-details-open', JSON.stringify({ [record.id]: true })]]);
  const document = eventTarget({ body: { dataset: { refreshInterval: '60000' } }, hidden: false, querySelector: () => null, querySelectorAll: () => [record] });
  let timer;
  let reloads = 0;
  const window = { sessionStorage: { getItem: key => store.get(key), setItem: (key, value) => store.set(key, value) }, clearTimeout() {}, setTimeout(fn) { timer = fn; }, location: { href: 'http://localhost/jobs?contract_chain=1#contract-fixture-0', reload() { reloads++; } } };
  vm.runInNewContext(refresh, { document, window });
  assert.equal(record.open, true);
  timer();
  assert.equal(reloads, 1);
  assert.equal(window.location.href, 'http://localhost/jobs?contract_chain=1#contract-fixture-0');
});
