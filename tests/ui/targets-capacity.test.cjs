'use strict';

// Synthetic Jinja view fixtures only: no Flask routes, backend collectors,
// artifact files, network calls, wallet material, or process inspection.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..', '..');
const renderScript = String.raw`
import json, sys
from types import SimpleNamespace
from jinja2 import Environment, FileSystemLoader, select_autoescape
class EmptyArgs:
    def lists(self):
        return []
env = Environment(loader=FileSystemLoader('dashboard/templates'), autoescape=select_autoescape())
env.globals['url_for'] = lambda endpoint, filename: '/static/' + filename
data = json.load(sys.stdin)
html = env.get_template('targets.html').render(data=data, request=SimpleNamespace(path='/targets', args=EmptyArgs()))
sys.stdout.buffer.write(html.encode('utf-8'))
`;

const observation = (freshness = 'FRESH') => ({
  source: 'fixture-capacity-observation', block: 123456, hash: '0x' + 'b'.repeat(64),
  utc: '2026-10-28T21:37:00Z', freshness,
});
const capacity = (changes = {}) => ({
  available: true, read_status: 'OK', amount_raw: '100396316', amount: '0.000000000100396316',
  symbol: 'WETH', decimals: 18, scope: 'SHARED_YNETHX_HOLDER',
  legacy_shares: '0', legacy_shares_unit: 'MCwETH shares', legacy_shares_rounded: true,
  observation: observation(),
  note: 'Shared holder-specific ordinary redemption capacity; not global cash or NAV and not additive across these targets.',
  ...changes,
});
const row = (rank, buffer) => ({
  rank, id: `fixture-${rank.slice(1)}`, position_key: `fixture-${rank.slice(1)}`,
  pair: 'ynETHx / fixture', label: `Fixture ${rank}`, chain_id: 1, chain_name: 'Ethereum',
  protocol: 'Fixture protocol', record_type: 'position', health_factor: '1.01 HF',
  status: { code: 'HELD', label: 'Held', tone: 'warning' }, protocol_status: 'HEALTHY',
  observation: observation(), quote: { available: false, freshness: 'UNKNOWN' }, position: {},
  liveness: { state: 'UNKNOWN' },
  runner: { reported_armed: false, mode: 'NOT_READY', held: true, freshness: 'STALE' },
  armed: false, calldata_ready: false,
  blockers: rank === '#E4' ? ['Encumbrance and collateral-vault economics remain unproven.'] : ['Recorded capacity is not execution permission.'],
  readiness_note: 'NOT_READY · NOT_VERIFIED',
  ...(buffer === undefined ? {} : { buffer_capacity: buffer }),
});
const render = (rows) => {
  const data = {
    available: true, view_mode: 'trade_candidates', freshness: 'FRESH', targets: rows,
    summary: { total: rows.length }, query: {}, options: {}, coverage: {},
    pagination: { page: 1, pages: 1, page_size: 50, start: 1, end: rows.length, filtered_total: rows.length, returned: rows.length },
  };
  const result = spawnSync('python', ['-c', renderScript], {
    cwd: root, encoding: 'utf8', input: JSON.stringify(data), timeout: 20000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(result.status, 0, result.stderr || String(result.error || 'Synthetic template render failed'));
  return result.stdout;
};
const widgets = (html) => [...html.matchAll(/<section\b[^>]*data-buffer-capacity="[^"]+"[^>]*>[\s\S]*?<\/section>/g)].map((match) => match[0]);
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const displayedAmount = (html) => html.match(/<strong data-capacity-amount>([^<]*)<\/strong>/)[1].trim();

for (const [name, raw, exact] of [
  ['tiny positive', '100396316', '0.000000000100396316'],
  ['one wei', '1', '0.000000000000000001'],
  ['known zero', '0', '0'],
]) {
  test(`capacity preserves ${name} as an exact WETH string`, () => {
    const [widget] = widgets(render([row('#M7', capacity({ amount_raw: raw, amount: exact }))]));
    assert.equal(displayedAmount(widget), `${exact} WETH`);
    assert.match(widget, /Recorded buffer withdrawal limit/);
    assert.match(widget, /class="pill neutral">OK<\/span>/);
    assert.doesNotMatch(displayedAmount(widget), /e[-+]\d/i);
  });
}

for (const [name, fields, status] of [
  ['missing read', { available: false, read_status: 'UNKNOWN', amount_raw: null, amount: null }, 'UNKNOWN'],
  ['failed read', { available: false, read_status: 'READ_FAILED', amount_raw: null, amount: null }, 'READ FAILED'],
  ['missing exact amount', { amount_raw: null, amount: null }, 'OK'],
  ['unavailable read with a retained value', { available: false, read_status: 'READ_FAILED' }, 'READ FAILED'],
]) {
  test(`capacity shows Unknown for ${name}, without a zero or fresh claim`, () => {
    const [widget] = widgets(render([row('#M7B', capacity(fields))]));
    assert.equal(displayedAmount(widget), 'Unknown');
    assert.match(text(widget), new RegExp(`Recorded read ${status}`));
    assert.match(text(widget), /Source freshness Unknown/);
    assert.doesNotMatch(widget, /class="pill fresh"/);
    assert.match(text(widget), /read is missing, failed, or incomplete/);
  });
}

test('stale capacity retains its recorded amount, own source pin and timestamp, not a LIVE claim', () => {
  const [widget] = widgets(render([row('#E4', capacity({ observation: observation('STALE') }))]));
  assert.equal(displayedAmount(widget), '0.000000000100396316 WETH');
  assert.match(widget, /class="pill stale">Stale<\/span>/);
  assert.match(text(widget), /Source freshness Stale/);
  assert.match(widget, /123456/);
  assert.match(widget, /2026-10-28T21:37:00Z/);
  assert.match(widget, /fixture-capacity-observation/);
  assert.ok(widget.includes('0x' + 'b'.repeat(64)));
  assert.doesNotMatch(widget, /\bLIVE\b|href=/i);
});

test('rounded share zero is secondary, correctly labeled and cannot replace tiny positive capacity', () => {
  const [widget] = widgets(render([row('#M7', capacity({ legacy_shares: '0' }))]));
  assert.equal(displayedAmount(widget), '0.000000000100396316 WETH');
  assert.match(text(widget), /MCwETH shares \(rounded source value\): 0/);
  assert.match(text(widget), /zero does not prove the actual share balance is zero/);
  const legacy = widget.match(/<p class="t-help"><strong>MCwETH shares[\s\S]*?<\/p>/)[0];
  assert.doesNotMatch(legacy, /\bWETH\b/);
});

test('all three target cards show the same holder-specific capacity, never a global or additive total', () => {
  const html = render(['#M7', '#M7B', '#E4'].map((rank) => row(rank, capacity())));
  const sections = widgets(html);
  assert.equal(sections.length, 3);
  for (const [index, rank] of ['#M7', '#M7B', '#E4'].entries()) {
    assert.ok(sections[index].includes(`data-buffer-capacity="${rank}"`));
    assert.equal(displayedAmount(sections[index]), '0.000000000100396316 WETH');
    assert.match(text(sections[index]), /Observed MCwETH max-withdraw limit for the ynETHx holder; not global cash or NAV and not additive across these targets/);
    assert.match(text(sections[index]), /Outer-vault and owner-specific restrictions remain separate/);
    assert.match(text(sections[index]), /Read success does not change the blockers or execution permissions/);
    assert.doesNotMatch(sections[index], /liquidation amount|profitable|\bready\b|<button|<input|<form|<script|href=/i);
  }
  assert.doesNotMatch(html, /0\.000000000301188948/);
  assert.match(html, /Encumbrance and collateral-vault economics remain unproven/);
  assert.match(html, /NOT_READY/);
  assert.match(html, /NOT_VERIFIED/);
  assert.match(html, /No · telemetry only/);
  assert.match(html, /No signing, arming, or execution controls are available/);
});

test('absent optional capacity leaves the three older card shapes and other target cards unchanged', () => {
  const html = render(['#M7', '#M7B', '#E4', '#M8'].map((rank) => row(rank)));
  assert.equal(widgets(html).length, 0);
  assert.doesNotMatch(html, /Recorded buffer withdrawal limit|MCwETH shares/);
  for (const rank of ['M7', 'M7B', 'E4', 'M8']) assert.ok(html.includes(`id="target-fixture-${rank}"`));
  const unrelatedBaseline = render([row('#M8')]);
  const unrelatedWithCapacity = render([row('#M8', capacity())]);
  assert.equal(unrelatedWithCapacity, unrelatedBaseline, 'the widget is limited to the three named cards');
});

test('missing legacy shares do not create a fabricated share value or change existing quote and runner sections', () => {
  const target = row('#M7', capacity({ legacy_shares: null }));
  target.quote = { available: true, freshness: 'STALE', gross_token_amount: '2.5', gross_token_symbol: 'UNIT', block: 111, utc: '2026-10-20T00:00:00Z' };
  target.historical_reference = { available: true, modeled_net_usd_display: '7.25', modeled_net_usd: '7.25', original_block: 100, note: 'Historical fixture only.' };
  const html = render([target]);
  const [widget] = widgets(html);
  assert.doesNotMatch(widget, /MCwETH shares \(rounded source value\)/);
  assert.match(html, /2\.5 UNIT/);
  assert.match(html, /7\.25 modeled net · historical local fork/);
  assert.match(html, /Historical reference · not a current quote/);
  assert.match(html, /No · telemetry only/);
  assert.match(html, /NOT_READY/);
});
