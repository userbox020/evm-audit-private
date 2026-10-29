'use strict';

// Offline UI contract tests. Render real Jinja templates without importing the
// dashboard app, reading its catalog/artifacts, starting a server, or networking.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '../..');
const js = fs.readFileSync(path.join(root, 'dashboard/static/liquidity.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'dashboard/static/liquidity.css'), 'utf8');
const template = fs.readFileSync(path.join(root, 'dashboard/templates/liquidity.html'), 'utf8');
const theme = fs.readFileSync(path.join(root, 'dashboard/static/dashboard.css'), 'utf8');
const refresh = fs.readFileSync(path.join(root, 'dashboard/static/refresh.js'), 'utf8');
const states = ['implemented', 'quote_only', 'discovery_only', 'study_only', 'blocked', 'unsupported'];
const labels = ['Implemented', 'Quote only', 'Discovery only', 'Study only', 'Blocked', 'Unsupported'];
const fixture = {
  catalog_as_of: '2026-10-25', read_only: true, source_mode: 'curated_snapshot', live_checked_at: null,
  summary: { total: 48, matched: 6, implemented: 30, quote_only: 5, discovery_only: 4, study_only: 4, blocked: 3, unsupported: 2, atomic_funding: 4 },
  filters: { q: '', chain: '', category: '', status: '' },
  options: {
    chains: [{ value: '1', label: 'Ethereum' }, { value: '8453', label: 'Base' }, { value: '42161', label: 'Arbitrum' }],
    categories: ['funding', 'credit', 'swap', 'redemption', 'lp', 'delayed', 'coverage'].map(value => ({ value, label: value })),
    statuses: states.map((value, index) => ({ value, label: labels[index] })),
  },
  notices: ['A local PASS with a refilled buffer is conditional.', 'Oracle shocks and synthetic funding do not establish current readiness.'],
  scan: { as_of: '2026-10-25', scope: 'Uniswap V3 direct / via USDC only.', chains: [
    { name: 'Ethereum', token_pair_entries: 196, qualified_route_families: 33, selected_pools: 38 },
    { name: 'Base', token_pair_entries: 44, qualified_route_families: 17, selected_pools: 15 },
  ], conclusion: 'No after-all-costs-positive executable liquidation established.' },
  routes: states.map((status, index) => ({
    id: `test-${index}`, name: `Example path ${index}`, category: 'funding', category_label: 'Atomic funding',
    chains: [{ id: 1, name: 'Ethereum' }, { id: 8453, name: 'Base' }], status, status_label: labels[index],
    atomicity: 'Same-transaction settlement; exact obligations apply.', paths: ['A → B → settle', 'Alternative B exit'],
    funding: 'Principal supplied for the recorded path.', fees: 'Actual fee required; modeled 5 bps is not a live premium.',
    repayment: 'Transfer principal and actual fee back; approval alone is not repayment.',
    evidence: 'Historical local rehearsal only; buffer was refilled locally.',
    blockers: index === 1 ? [] : ['Current exact-size capacity is not established.'],
    next_check: 'Verify repayment and capacity at the intended size.',
    source_refs: [{ path: `tools/example-${index}.js`, lines: '12-34', note: 'Recorded repayment implementation.' }],
    reviewed_at: '2026-10-25', capacity: 'Size-dependent; no current balance recorded.', execution: 'Implemented code does not establish current readiness.',
  })),
};

let rendered;
const views = () => {
  if (rendered) return rendered;
  const filtered = structuredClone(fixture);
  filtered.filters = { q: 'principal & fee', chain: '8453', category: 'funding', status: 'implemented' };
  filtered.routes = [filtered.routes[0]];
  filtered.summary.matched = 1;
  const noMatches = structuredClone(filtered);
  noMatches.routes = [];
  noMatches.summary.matched = 0;
  const empty = structuredClone(noMatches);
  empty.summary = Object.fromEntries(Object.keys(fixture.summary).map(key => [key, 0]));
  const unsafe = structuredClone(filtered);
  unsafe.filters.q = '<img src=x onerror="bad()">';
  unsafe.routes[0].name = '<script>bad()</script>';
  unsafe.routes[0].evidence = '<b>untrusted</b>';
  unsafe.routes[0].source_refs = [{ path: 'javascript:bad()', lines: '1-2', note: '<img src=x>' }];
  unsafe.routes[0].paths = ['https://example.invalid/private-file'];
  unsafe.notices = ['<script>notice()</script>'];
  const fifty = structuredClone(fixture);
  fifty.routes = Array.from({ length: 50 }, (_, index) => ({ ...structuredClone(fixture.routes[index % 6]), id: `fifty-${index}`, name: `Very long path label ${'W'.repeat(120)} ${index}` }));
  fifty.summary = { ...fifty.summary, total: 50, matched: 50 };
  const python = `
import json, sys
from types import SimpleNamespace
from urllib.parse import urlencode, quote
from jinja2 import Environment, FileSystemLoader, select_autoescape
from html.parser import HTMLParser
sys.stdin.reconfigure(encoding='utf-8')
env = Environment(loader=FileSystemLoader('dashboard/templates'), autoescape=select_autoescape(['html']))
def url_for(endpoint, **kw):
    if endpoint == 'static': return '/static/' + kw['filename']
    base = {'liquidity_page': '/liquidity', 'liquidity_api': '/api/v1/liquidity'}[endpoint]
    anchor = kw.pop('_anchor', None)
    return base + ('?' + urlencode(kw) if kw else '') + ('#' + quote(anchor) if anchor else '')
env.globals['url_for'] = url_for
class Structure(HTMLParser):
    def __init__(self): super().__init__(); self.tags = []
    def handle_starttag(self, tag, attrs): self.tags.append({'tag': tag, **dict(attrs)})
page = env.get_template('liquidity.html')
result = {}
for name, data in json.load(sys.stdin).items():
    html = page.render(data=data, request=SimpleNamespace(path='/liquidity'))
    parsed = Structure(); parsed.feed(html)
    result[name] = {'html': html, 'tags': parsed.tags}
print(json.dumps(result))
`;
  const run = spawnSync('python', ['-c', python], {
    cwd: root, input: JSON.stringify({ full: fixture, filtered, noMatches, empty, unsafe, fifty }), encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(run.status, 0, `Jinja rendering failed: ${run.stderr || run.error || ''}`);
  rendered = JSON.parse(run.stdout);
  return rendered;
};

const eventTarget = extra => ({
  listeners: {},
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
  fire(type) { for (const fn of this.listeners[type] || []) fn(); },
  ...extra,
});
const harness = ({ hash = '', routeCount = 3, outside = false } = {}) => {
  const routes = Array.from({ length: routeCount }, (_, index) => ({
    id: `liquidity-route-test-${index}`, open: false, scrolls: [],
    matches(selector) { return selector === 'details[data-liquidity-route]'; },
    scrollIntoView(options) { this.scrolls.push(options); },
  }));
  const expand = eventTarget({});
  const collapse = eventTarget({});
  const actions = { hidden: true, querySelector(selector) { return selector === '[data-liquidity-expand]' ? expand : collapse; } };
  const page = { querySelectorAll: () => routes, querySelector: () => actions, contains: item => !outside && routes.includes(item) };
  const window = eventTarget({ location: { hash } });
  const document = { querySelector: () => page, getElementById: id => routes.find(item => item.id === id) };
  vm.runInNewContext(js, { document, window });
  return { routes, expand, collapse, actions, window };
};

test('navigation and page assets stay local and page-scoped', () => {
  const { html, tags } = views().full;
  assert.match(html, /<title>Liquidity Paths · Watchboard<\/title>/);
  assert.ok(tags.some(tag => tag.tag === 'body' && tag.class === 'liquidity-shell'));
  assert.ok(tags.some(tag => tag.tag === 'a' && tag.href === '/liquidity' && tag['aria-current'] === 'page'));
  for (const tag of tags.filter(tag => tag.tag === 'script' || tag.rel === 'stylesheet')) {
    assert.ok((tag.src || tag.href).startsWith('/static/'));
  }
  assert.doesNotMatch(css, /@import|https?:\/\//);
});

test('native GET form sends the complete applied query with numeric chain values', () => {
  const { tags } = views().filtered;
  const form = tags.find(tag => tag.tag === 'form');
  assert.equal(form.method, 'get');
  assert.equal(form.action, '/liquidity#liquidity-register');
  assert.equal(tags.find(tag => tag.name === 'q').value, 'principal & fee');
  for (const [name, value] of [['chain', '8453'], ['category', 'funding'], ['status', 'implemented']]) {
    const start = tags.findIndex(tag => tag.tag === 'select' && tag.name === name);
    const end = tags.findIndex((tag, index) => index > start && tag.tag === 'select');
    assert.equal(tags.slice(start + 1, end < 0 ? tags.length : end).find(tag => tag.tag === 'option' && 'selected' in tag).value, value);
  }
  assert.ok(tags.some(tag => tag.tag === 'option' && tag.value === '42161'), 'Global options survive a filtered result');
  assert.ok(tags.some(tag => tag.tag === 'button' && tag.type === 'submit'));
  assert.match(views().full.html, /Filters and expandable path details work without JavaScript/);
  assert.doesNotMatch(js, /preventDefault|fetch\(|XMLHttpRequest|\.filter\(|\.sort\(/);
});

test('JSON link uses all normalized filters; Clear and status counts reset other filters', () => {
  const links = views().filtered.tags.filter(tag => tag.tag === 'a');
  const api = new URL(links.find(tag => tag.class === 'l-json').href, 'http://localhost');
  assert.equal(api.pathname, '/api/v1/liquidity');
  for (const [key, value] of Object.entries({ q: 'principal & fee', chain: '8453', category: 'funding', status: 'implemented' })) assert.equal(api.searchParams.get(key), value);
  assert.ok(links.some(tag => tag.href === '/liquidity#liquidity-register'));
  const groups = links.filter(tag => tag.class?.includes('l-count-link'));
  assert.equal(groups.length, 6);
  for (const link of groups) {
    const url = new URL(link.href, 'http://localhost');
    assert.deepEqual([...url.searchParams.keys()], ['status']);
    assert.equal(url.hash, '#liquidity-register');
  }
});

test('summary counts stay global while the matching count and visible rows follow the server', () => {
  const full = views().full.html;
  const filtered = views().filtered.html;
  for (const html of [full, filtered]) {
    assert.match(html, /<dt>Catalog entries<\/dt><dd>48<\/dd>/);
    assert.match(html, /<dt>Atomic funding<\/dt><dd>4<\/dd>/);
    assert.match(html, /Families · not available balances/);
    assert.match(html, /Global counts · unaffected by filters/);
  }
  assert.match(filtered, /<strong>1<\/strong> matching \/ 48 catalog entries/);
  assert.equal(views().filtered.tags.filter(tag => 'data-liquidity-route' in tag).length, 1);
  assert.doesNotMatch(filtered, /Example path 1/);
});

test('all six statuses are distinct without a green readiness claim', () => {
  const html = views().full.html;
  for (let index = 0; index < states.length; index++) assert.ok(html.includes(`class="l-status l-state-${states[index]}">${labels[index]}</span>`));
  assert.match(html, /Code present, not readiness/);
  assert.match(html, /A path can be implemented and still have blockers/);
  assert.match(html, /No specific blocker recorded\. This is not proof of current readiness/);
  assert.match(css, /l-state-implemented\{--state-color:var\(--blue\)/);
  assert.doesNotMatch(css, /var\(--ok|var\(--lime/);
  assert.doesNotMatch(template, /available now|execution.ready|\bPASS\b/i);
});

test('every route retains all cost, settlement, capacity, evidence, execution, and next-check fields', () => {
  const html = views().filtered.html;
  for (const key of ['funding', 'atomicity', 'fees', 'repayment', 'capacity', 'evidence', 'execution', 'next_check']) assert.ok(html.includes(fixture.routes[0][key]), `Missing ${key}`);
  assert.match(html, /Reviewed <time datetime="2026-10-25">2026-10-25<\/time> · curated record, not a live check/);
  assert.match(html, /1 blocker \/ limit/);
  assert.match(html, /<code>tools\/example-0\.js:12-34<\/code>/);
  assert.match(html, /Recorded repayment implementation/);
});

test('fixed review dates and scan scope never become live check or profit claims', () => {
  const { html, tags } = views().full;
  assert.ok(tags.filter(tag => tag.tag === 'time').every(tag => tag.datetime === '2026-10-25'));
  assert.match(html, /Page reloads do not recheck routes or change the catalog review or retained scan dates/);
  assert.match(html, /No live check performed by this page/);
  assert.match(html, /Uniswap V3 direct \/ via USDC only/);
  assert.match(html, /Token-pair entries<\/dt><dd>196/);
  assert.match(html, /Qualified route families<\/dt><dd>33/);
  assert.match(html, /Selected pools<\/dt><dd>38/);
  assert.match(html, /Token-pair entries<\/dt><dd>44/);
  assert.match(html, /Qualified route families<\/dt><dd>17/);
  assert.match(html, /Selected pools<\/dt><dd>15/);
  assert.match(html, /No after-all-costs-positive executable liquidation established/);
  assert.match(html, /100 USDC floor applies only to the competitive pilot/);
  assert.doesNotMatch(js, /Date\b|setInterval|setTimeout|sessionStorage|localStorage|textContent|innerHTML/);
});

test('catalog text is escaped and source references are never interpreted as links', () => {
  const { html, tags } = views().unsafe;
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.match(html, /&lt;b&gt;untrusted&lt;\/b&gt;/);
  assert.match(html, /&lt;script&gt;notice\(\)&lt;\/script&gt;/);
  assert.match(html, /<code>javascript:bad\(\):1-2<\/code>/);
  assert.match(html, /https:\/\/example\.invalid\/private-file/);
  assert.doesNotMatch(html, /<img|<b>untrusted|<script>bad/);
  for (const link of tags.filter(tag => tag.tag === 'a')) {
    assert.ok(link.href.startsWith('/') || link.href.startsWith('#'));
    assert.doesNotMatch(link.href, /^javascript:|^https?:|tools\/example/);
  }
});

test('empty and no-match views do not claim there are no liquidity opportunities', () => {
  assert.match(views().noMatches.html, /No paths match these filters/);
  assert.match(views().noMatches.html, /Global counts above still cover the full catalog/);
  assert.match(views().empty.html, /No catalog entries recorded/);
  assert.match(views().empty.html, /An empty inventory does not establish that no liquidity paths exist/);
  assert.match(views().empty.html, /<dt>Catalog entries<\/dt><dd>0<\/dd>/);
  assert.equal(views().empty.tags.filter(tag => 'data-liquidity-route' in tag).length, 0);
});

test('semantic structure provides unique IDs, native disclosures, labels, and valid accessible references', () => {
  for (const { tags } of Object.values(views())) {
    const ids = tags.filter(tag => tag.id).map(tag => tag.id);
    assert.equal(new Set(ids).size, ids.length, 'Duplicate element IDs');
    assert.equal(tags.filter(tag => tag.tag === 'h1').length, 1);
    assert.equal(tags.filter(tag => tag.tag === 'main').length, 1);
    for (const control of tags.filter(tag => ['input', 'select'].includes(tag.tag))) assert.ok(tags.some(tag => tag.tag === 'label' && tag.for === control.id), `Unlabelled ${control.id}`);
    for (const tag of tags) for (const attribute of ['aria-labelledby', 'aria-describedby', 'aria-controls']) {
      if (tag[attribute]) for (const id of tag[attribute].split(/\s+/)) assert.ok(ids.includes(id), `Missing ${attribute} target: ${id}`);
    }
    for (const tag of tags.filter(tag => 'data-liquidity-route' in tag)) {
      assert.equal(tag.tag, 'details');
      assert.ok(!('open' in tag), 'Route content starts compact');
      assert.ok(tags.some(link => link.href === `#${tag.id}`));
    }
  }
});

test('50 long route labels remain fully rendered with compact native disclosure', () => {
  const { html, tags } = views().fifty;
  assert.equal(tags.filter(tag => 'data-liquidity-route' in tag).length, 50);
  assert.match(html, /<strong>50<\/strong> matching \/ 50 catalog entries/);
  assert.equal(tags.filter(tag => tag.tag === 'summary').length, 52);
  assert.match(css, /overflow-wrap:anywhere/);
  assert.match(css, /min-width:0/);
  assert.doesNotMatch(css, /line-clamp|text-overflow:ellipsis/);
});

test('responsive rules reflow rows and details, preserve focus, and respect reduced motion', () => {
  assert.match(css, /@media\(max-width:760px\)/);
  assert.match(css, /l-list-heading\{display:none\}/);
  assert.match(css, /l-detail-grid\{grid-template-columns:1fr/);
  assert.match(css, /l-source-list\{grid-template-columns:1fr/);
  assert.match(css, /l-mobile-label\{display:block/);
  assert.match(css, /l-filters :is\(input,select\)\{font-size:16px/);
  assert.match(css, /@media\(max-width:520px\)\{\.liquidity-page \.l-filters\{grid-template-columns:minmax\(0,1fr\)\}\}/);
  assert.match(css, /:focus-visible\{outline:3px solid var\(--focus\)/);
  assert.match(css, /min-height:44px/);
  assert.match(css, /@media\(prefers-reduced-motion:no-preference\)/);
  assert.match(css, /html:has\(\.liquidity-shell\)\{scroll-behavior:auto\}/);
});

const luminance = hex => {
  if (hex.length === 4) hex = '#' + [...hex.slice(1)].map(char => char + char).join('');
  const rgb = hex.slice(1).match(/../g).map(value => parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
};
test('small text and status colors meet AA contrast in both existing themes', () => {
  const palettes = [...theme.matchAll(/:root(?:\[data-theme="light"\])?\{([^}]+)\}/g)].map(([, body]) => Object.fromEntries([...body.matchAll(/--([\w-]+):(#[\da-f]{3,6})(?:;|$)/g)].map(([, key, value]) => [key, value])));
  assert.equal(palettes.length, 2);
  const lightOverride = css.match(/:root\[data-theme="light"\] \.liquidity-page\{([^}]+)\}/)[1];
  Object.assign(palettes[1], Object.fromEntries([...lightOverride.matchAll(/--([\w-]+):(#[\da-f]{6})(?:;|$)/g)].map(([, key, value]) => [key, value])));
  for (const palette of palettes) for (const [fg, bg] of [['ink', 'card'], ['muted', 'card'], ['muted', 'surface-2'], ['muted', 'paper'], ['blue', 'info-bg'], ['warn-fg', 'warn-bg'], ['danger-fg', 'danger-bg'], ['on-solid', 'blue']]) {
    const values = [luminance(palette[fg]), luminance(palette[bg])].sort((a, b) => b - a);
    assert.ok((values[0] + .05) / (values[1] + .05) >= 4.5, `${fg} on ${bg} fails AA`);
  }
});

test('progressive expand/collapse operates only on shown paths', () => {
  const ui = harness();
  assert.equal(ui.actions.hidden, false);
  ui.expand.fire('click');
  assert.ok(ui.routes.every(route => route.open));
  ui.collapse.fire('click');
  assert.ok(ui.routes.every(route => !route.open));
  assert.equal(harness({ routeCount: 0 }).actions.hidden, true);
});

test('path deep links open the exact path without query selectors or navigation', () => {
  const ui = harness({ hash: '#liquidity-route-test-1' });
  assert.deepEqual(ui.routes.map(route => route.open), [false, true, false]);
  assert.equal(ui.routes[1].scrolls.length, 1);
  ui.window.location.hash = '#liquidity-route-test-2';
  ui.window.fire('hashchange');
  assert.equal(ui.routes[2].open, true);
  for (const hash of ['#other', '#liquidity-route-test-999', '#%ZZ', '#liquidity-route-"onclick="x']) {
    const other = harness({ hash });
    assert.ok(other.routes.every(route => !route.open));
  }
  assert.ok(harness({ hash: '#liquidity-route-test-1', outside: true }).routes.every(route => !route.open));
});

test('shared refresh restores stable disclosure IDs without changing snapshot semantics', () => {
  const route = { id: 'liquidity-route-test-0', open: false };
  const store = new Map([['watchboard-details-open', JSON.stringify({ [route.id]: true })]]);
  const document = eventTarget({ body: { dataset: { refreshInterval: '60000' } }, hidden: false, querySelector: () => null, querySelectorAll: () => [route] });
  let timer;
  let reloaded = 0;
  const window = { sessionStorage: { getItem: key => store.get(key), setItem: (key, value) => store.set(key, value) }, clearTimeout() {}, setTimeout(fn) { timer = fn; }, location: { href: 'http://localhost/liquidity?chain=8453#liquidity-route-test-0', reload() { reloaded++; } } };
  vm.runInNewContext(refresh, { document, window });
  assert.equal(route.open, true);
  timer();
  assert.equal(reloaded, 1);
  assert.equal(window.location.href, 'http://localhost/liquidity?chain=8453#liquidity-route-test-0');
  assert.match(views().full.html, /Reloading only rereads this curated catalog; it does not run an RPC check/);
});

test('page controls are review-only and the script is inert on other pages', () => {
  const html = views().full.html;
  const page = html.slice(html.indexOf('<div class="liquidity-page"'), html.indexOf('</main>'));
  const buttons = [...page.matchAll(/<button\b[^>]*>([^<]*)<\/button>/g)].map(([, text]) => text);
  assert.deepEqual(buttons, ['Apply filters', 'Expand shown', 'Collapse shown']);
  assert.doesNotMatch(page, /method="post"|data-wallet|Re-arm|Broadcast|Trade now/i);
  assert.doesNotThrow(() => vm.runInNewContext(js, { document: { querySelector: () => null } }));
});
