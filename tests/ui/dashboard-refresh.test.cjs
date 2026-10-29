'use strict';

// Deterministic node:test coverage for the dashboard auto-reload gate:
//   - dashboard/static/refresh.js (coordinator + deferral + details state)
//   - dashboard/static/wallets.js (owned-token busy registry; overlap/release)
// Added against the 2026-10-14 UI findings (U2) and the follow-up review of
// the same lane. Runs scripts in vm sandboxes with fake DOMs, fake timers,
// and fake sessionStorage. No network, no page load, no external packages.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const REFRESH_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'dashboard', 'static', 'refresh.js'),
  'utf8'
);
const WALLETS_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'dashboard', 'static', 'wallets.js'),
  'utf8'
);

class FakeClock {
  constructor() {
    this.now = 0;
    this.seq = 0;
    this.timers = new Map();
  }

  setTimeout(fn, ms) {
    const id = ++this.seq;
    this.timers.set(id, { fn, at: this.now + (ms || 0) });
    return id;
  }

  clearTimeout(id) {
    this.timers.delete(id);
  }

  size() {
    return this.timers.size;
  }

  advance(ms) {
    const end = this.now + ms;
    for (;;) {
      let id = null;
      for (const [key, timer] of this.timers.entries()) {
        if (timer.at <= end && (id === null || timer.at < this.timers.get(id).at)) id = key;
      }
      if (id === null) break;
      const timer = this.timers.get(id);
      this.timers.delete(id);
      this.now = timer.at;
      timer.fn();
    }
    this.now = end;
  }
}

const makeStorage = () => {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(String(key), String(value)); },
    removeItem: (key) => { store.delete(key); },
  };
};

// Fake DOM covering exactly what refresh.js touches.
const buildHarness = ({ interval = 60000, activeElement = null, storage = makeStorage(), details = null, walletInputs = null, canary = false } = {}) => {
  const clock = new FakeClock();
  const state = { reloads: 0, requests: [], replacements: 0, scrolls: [] };
  const statusEl = { textContent: '' };
  const toggleEl = {
    textContent: '',
    features: {},
    listeners: [],
    setAttribute(name, value) { this.features[name] = value; },
    getAttribute(name) { return this.features[name]; },
    addEventListener(type, fn) { this.listeners.push([type, fn]); },
    click() { for (const [, fn] of this.listeners) fn(); },
  };
  const doc = {
    hidden: false,
    body: { dataset: { refreshInterval: String(interval) } },
    activeElement,
    listeners: {},
    details: details || [],
    walletZone: null,
    walletInputs: [],
    addEventListener(type, fn, _capture) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    },
    dispatch(type, event = { target: null, type }) {
      for (const fn of this.listeners[type] || []) fn(event);
    },
    dispatchEvent(event) { this.dispatch(event.type, event); },
    querySelector(selector) {
      if (selector === '[data-canary-live]') return canary ? {} : null;
      if (selector === '[data-refresh-status]') return statusEl;
      if (selector === '[data-refresh-toggle]') return toggleEl;
      if (selector === '[data-wallets]') return this.walletZone;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'details[id]') return this.details.filter((item) => item && item.id);
      if (selector === '[data-wallet-add] input' && this.walletZone) return this.walletInputs;
      if (selector === '[data-canary-panel]') return this.panels;
      return [];
    },
  };
  const panel = () => ({
    dataset: { canaryPanel: 'evidence' },
    querySelectorAll: () => [],
    replaceWith(next) { state.replacements += 1; doc.panels = [next]; },
  });
  doc.panels = [panel()];
  let validDocument = true;
  const nextDocument = {
    querySelector: (selector) => selector === '[data-canary-live]' && validDocument ? {} : null,
    querySelectorAll: (selector) => selector === '[data-canary-panel]' ? [panel()] : [],
  };
  const epoch = Date.parse('2026-10-28T20:00:00Z');
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [epoch + clock.now])); }
    static now() { return epoch + clock.now; }
  }
  const sandbox = {
    document: doc, window: {}, Date: ClockDate, AbortController,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
    DOMParser: class { parseFromString() { return nextDocument; } },
  };
  sandbox.window.setTimeout = (fn, ms) => clock.setTimeout(fn, ms);
  sandbox.window.clearTimeout = (id) => clock.clearTimeout(id);
  sandbox.window.location = { href: 'http://localhost/canary', reload: () => { state.reloads += 1; } };
  sandbox.window.sessionStorage = storage;
  sandbox.window.navigator = { onLine: true };
  sandbox.window.performance = { now: () => clock.now };
  sandbox.window.scrollX = 0;
  sandbox.window.scrollY = 900;
  sandbox.window.scrollTo = (position) => state.scrolls.push(position);
  const listeners = {};
  sandbox.window.addEventListener = (type, fn) => { (listeners[type] ||= []).push(fn); };
  let fetchImpl = async () => ({ ok: true, text: async () => '<fixture>' });
  sandbox.window.fetch = (...args) => { state.requests.push(args); return fetchImpl(...args); };

  if (walletInputs) {
    doc.walletInputs = walletInputs;
    doc.walletZone = {
      querySelectorAll: (selector) => (selector === '[data-wallet-add] input' ? walletInputs : []),
    };
  }

  vm.runInNewContext(REFRESH_SOURCE, sandbox, { filename: 'refresh.js' });

  return {
    clock,
    doc,
    sandbox,
    statusEl,
    toggleEl,
    state,
    setFetch(fn) { fetchImpl = fn; },
    setValidDocument(value) { validDocument = value; },
    dispatchWindow(type, event = {}) { for (const fn of listeners[type] || []) fn(event); },
    attachWalletZone(inputs) {
      doc.walletInputs = inputs;
      doc.walletZone = {
        querySelectorAll: (selector) => (selector === '[data-wallet-add] input' ? inputs : []),
      };
    },
    reloadCount: () => state.reloads,
  };
};

const settle = () => new Promise((resolve) => setImmediate(resolve));

// Pump one due timer at a time, draining promise continuations between ticks
// so async flows can progress deterministically.
const pumpOnce = async (clock) => {
  await settle();
  const entries = [...clock.timers.entries()];
  if (!entries.length) return false;
  entries.sort((a, b) => a[1].at - b[1].at);
  const nextAt = entries[0][1].at;
  const due = entries.filter(([, timer]) => timer.at === nextAt);
  clock.now = nextAt;
  for (const [id] of due) clock.timers.delete(id);
  for (const [, timer] of due) timer.fn();
  await settle();
  return true;
};

const pumpUntil = async (clock, condition, maxSteps = 400) => {
  for (let step = 0; step < maxSteps; step += 1) {
    await settle();
    if (condition()) return true;
    await pumpOnce(clock);
  }
  await settle();
  return condition();
};

// Combined refresh.js + wallets.js sandbox: real coordinator, real handler
// bodies, scripted fetch replies, fake clocks — no manual busy-flag toggling.
const buildIntegratedSandbox = ({ collectorRunningPolls = 4, canary = false, collectorReply = null } = {}) => {
  const app = buildHarness({ interval: 7200000, canary }); // periodic tick out of the way
  const doc = app.doc;
  const addressInput = { value: '', focus() {} };
  const labelInput = { value: '', focus() {} };
  const submitButton = { disabled: false };
  const messageEl = { textContent: '', hidden: true, dataset: {} };
  const addForm = {
    listeners: [],
    addEventListener(type, fn) { this.listeners.push([type, fn]); },
    submit() {
      for (const [type, fn] of this.listeners) {
        if (type === 'submit') return fn({ preventDefault() {} });
      }
      return undefined;
    },
    querySelector(selector) {
      if (selector === 'input[name="address"]') return addressInput;
      if (selector === 'input[name="label"]') return labelInput;
      if (selector === 'button[type="submit"]') return submitButton;
      return null;
    },
  };
  const refreshButton = {
    disabled: false,
    listeners: [],
    addEventListener(type, fn) { this.listeners.push([type, fn]); },
    click() { for (const [, fn] of this.listeners) fn(); },
  };
  const collectorStatusEl = { textContent: '' };
  const root = {
    querySelector(selector) {
      if (selector === '[data-wallet-message]') return messageEl;
      if (selector === '[data-wallet-add]') return addForm;
      if (selector === '[data-wallet-refresh]') return refreshButton;
      if (selector === '[data-collector-status]') return collectorStatusEl;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-wallet-add] input') return [addressInput, labelInput];
      return [];
    },
    contains() { return true; },
  };
  // The wallet zone must exist before wallets.js runs so its root binds.
  doc.querySelector = (selector) => {
    if (selector === '[data-canary-live]') return canary ? {} : null;
    if (selector === '[data-refresh-status]') return app.statusEl;
    if (selector === '[data-refresh-toggle]') return app.toggleEl;
    if (selector === '[data-wallets]') return root;
    return null;
  };
  doc.walletInputs = [addressInput, labelInput]; // draft gate sees the real inputs

  const fetchCalls = [];
  let opsPolls = 0;
  const reply = (status, data) => ({ ok: status < 400, status, json: async () => data });
  const fakeFetch = async (url, init) => {
    fetchCalls.push(`${(init && init.method) || 'GET'} ${url}`);
    if (url === '/api/v1/wallets/addresses') return reply(201, {});
    if (url === '/api/v1/wallets/refresh') return reply(202, {});
    if (url === '/api/v1/ops') {
      opsPolls += 1;
      if (collectorReply) return collectorReply(opsPolls, app);
      return reply(200, {
        wallets: { collector: { running: opsPolls <= collectorRunningPolls, last_error: null, last_exit: null } },
      });
    }
    return reply(500, {});
  };
  // wallets.js calls bare `fetch` (globally scoped in browsers) and refresh/
  // contract code may use window.fetch — register the stub at both levels.
  app.sandbox.fetch = fakeFetch;
  app.sandbox.window.fetch = fakeFetch;

  vm.runInNewContext(WALLETS_SOURCE, app.sandbox, { filename: 'wallets.js' });

  return Object.assign(app, {
    addressInput,
    submitButton,
    labelInput,
    refreshButton,
    addForm,
    messageEl,
    fetchCalls,
    collectorStatusEl,
    busy: () => app.sandbox.window.__watchboardWalletBusy === true,
  });
};

// ---------- periodic scheduler (baseline semantics) ----------

test('schedules and performs the periodic reload when nothing defers it', () => {
  const app = buildHarness();
  assert.equal(app.reloadCount(), 0);
  assert.equal(app.clock.size(), 1, 'exactly one timer armed after init');
  app.clock.advance(60000 - 1);
  assert.equal(app.reloadCount(), 0);
  app.clock.advance(1);
  assert.equal(app.reloadCount(), 1);
});

test('defers while a wallet address draft exists, and reloads once the draft clears', () => {
  const app = buildHarness();
  const address = { value: '0x' + 'a'.repeat(40) };
  const label = { value: '' };
  app.attachWalletZone([address, label]);
  app.clock.advance(60000);
  assert.equal(app.reloadCount(), 0);
  assert.match(app.statusEl.textContent, /wallet address form/, 'deferral is announced in the live status line');
  assert.equal(app.clock.size(), 1, 'a retriable timer stays armed, not a dead one');
  address.value = '';
  app.clock.advance(5000);
  assert.equal(app.reloadCount(), 1, 'timer resumes and reloads as soon as the draft is gone');
});

test('defers while focus sits in an empty wallet input and resumes on blur', () => {
  const address = { value: '' };
  const app = buildHarness({ walletInputs: [address] });
  app.doc.activeElement = address;
  app.clock.advance(60000);
  assert.equal(app.reloadCount(), 0);
  app.doc.activeElement = null;
  app.clock.advance(5000);
  assert.equal(app.reloadCount(), 1);
});

test('a completed outcome panel never latches the gate: reload still fires with only stale output present', () => {
  const app = buildHarness({ walletInputs: [{ value: '' }] });
  app.doc.outcomesStale = true; // rendered outcome panel; no busy flag, no draft
  app.clock.advance(60000);
  assert.equal(app.reloadCount(), 1, 'suppression keys on in-flight work and drafts only');
});

test('pause toggle stops and resume restarts the timer through sessionStorage', () => {
  const app = buildHarness();
  app.toggleEl.click();
  assert.equal(app.toggleEl.features['aria-pressed'], 'true');
  assert.equal(app.toggleEl.textContent, 'Resume refresh');
  assert.equal(app.clock.size(), 0, 'no deferred timer keeps running while paused');
  app.clock.advance(240000);
  assert.equal(app.reloadCount(), 0);
  app.toggleEl.click();
  assert.equal(app.toggleEl.features['aria-pressed'], 'false');
  app.clock.advance(60000);
  assert.equal(app.reloadCount(), 1);
});

test('hidden tabs suspend the timer; returning to visibility reschedules and reloads', () => {
  const app = buildHarness();
  app.doc.hidden = true;
  app.doc.dispatch('visibilitychange');
  assert.equal(app.clock.size(), 0);
  app.clock.advance(300000);
  assert.equal(app.reloadCount(), 0);
  app.doc.hidden = false;
  app.doc.dispatch('visibilitychange');
  assert.equal(app.clock.size(), 1);
  app.clock.advance(60000);
  assert.equal(app.reloadCount(), 1);
});

// ---------- completion-reload coordinator ----------

test('requestWatchboardReload while safe refreshes promptly without waiting for the interval', () => {
  const app = buildHarness();
  app.sandbox.window.requestWatchboardReload('wallets');
  assert.equal(app.reloadCount(), 1);
});

test('a pending completion reload survives pause and completes promptly after resume', () => {
  const app = buildHarness();
  app.toggleEl.click(); // paused
  app.sandbox.window.requestWatchboardReload('wallets');
  app.clock.advance(600000);
  assert.equal(app.reloadCount(), 0);
  assert.equal(app.clock.size(), 0, 'no chain keeps running while paused');
  app.toggleEl.click(); // resume
  assert.equal(app.reloadCount(), 1, 'resume processes the pending request immediately');
});

test('a pending completion reload survives a hidden tab and completes on visibility', () => {
  const app = buildHarness();
  app.doc.hidden = true;
  app.sandbox.window.requestWatchboardReload('wallets');
  app.clock.advance(600000);
  assert.equal(app.reloadCount(), 0);
  app.doc.hidden = false;
  app.doc.dispatch('visibilitychange');
  assert.equal(app.reloadCount(), 1);
});

test('a pending completion reload defers behind busy work and drafts, completing when both clear', () => {
  const draft = { value: '0x' + 'b'.repeat(40) };
  const app = buildHarness({ walletInputs: [draft] });
  app.sandbox.window.__watchboardWalletBusy = true;
  app.sandbox.window.requestWatchboardReload('wallets');
  app.clock.advance(120000);
  assert.equal(app.reloadCount(), 0, 'busy work holds the pending reload');
  app.sandbox.window.__watchboardWalletBusy = false;
  app.clock.advance(120000);
  assert.equal(app.reloadCount(), 0, 'a new draft alone still holds it');
  draft.value = '';
  app.clock.advance(5000);
  assert.equal(app.reloadCount(), 1, 'prompt completion and no latch once safe');
});

// ---------- <details> persistence ----------

test('open/closed <details> state persists only by stable id and restores on the next load', () => {
  const storage = makeStorage();
  const legacy = { id: 'legacy-monitors-details', open: true, localName: 'details' };
  const untouched = { id: 'audit-state-details', open: false, localName: 'details' };

  const writer = buildHarness({ storage });
  writer.doc.dispatch('toggle', { target: legacy, type: 'toggle' });
  assert.deepEqual(JSON.parse(storage.getItem('watchboard-details-open')), { 'legacy-monitors-details': true });
  assert.equal(untouched.open, false, 'one toggle never records another section');

  const restored = { id: 'legacy-monitors-details', open: false, localName: 'details' };
  const reader = buildHarness({ storage, details: [restored, untouched] });
  assert.equal(restored.open, true, 'init restore reopens the recorded section');
  assert.equal(untouched.open, false, 'sections never toggled keep their server-set state');

  reader.doc.dispatch('toggle', { target: { id: 'legacy-monitors-details', open: false, localName: 'details' }, type: 'toggle' });
  assert.deepEqual(JSON.parse(storage.getItem('watchboard-details-open')), { 'legacy-monitors-details': false });
  const reClosed = { id: 'legacy-monitors-details', open: true, localName: 'details' };
  buildHarness({ storage, details: [reClosed] });
  assert.equal(reClosed.open, false, 'a deliberately closed section stays closed');
});

test('toggle state is recorded only from details[id] elements, not other toggle targets', () => {
  const storage = makeStorage();
  const notDetails = { id: 'fake-section', open: true, localName: 'div' };
  const detailsRow = { id: 'legacy-monitors-details', open: true, localName: 'details' };
  const app = buildHarness({ storage });
  app.doc.dispatch('toggle', { target: notDetails, type: 'toggle' });
  app.doc.dispatch('toggle', { target: detailsRow, type: 'toggle' });
  assert.deepEqual(JSON.parse(storage.getItem('watchboard-details-open')), { 'legacy-monitors-details': true });
});

test('target-shaped guard: toggle events without an id (or not an object target) never touch storage', () => {
  const storage = makeStorage();
  const writer = buildHarness({ storage });
  writer.doc.dispatch('toggle', { target: { open: true, localName: 'details' }, type: 'toggle' });
  writer.doc.dispatch('toggle', { target: null, type: 'toggle' });
  writer.doc.dispatch('toggle', { type: 'toggle' });
  assert.equal(storage.getItem('watchboard-details-open'), null);
});

// ---------- wallets.js overlap/release + completion-with-new-draft ----------

test('overlapping wallet actions hold the busy gate until the last releases, and a draft typed mid-collection still wins', async () => {
  const app = buildIntegratedSandbox({ collectorRunningPolls: 4 });

  // Start flow A: form add (address already typed by the user at click time),
  // then flow B (Refresh balances) while A is still settling.
  app.addressInput.value = '0x' + 'c'.repeat(40);
  const submitPromise = app.addForm.submit();
  await settle();
  assert.equal(app.busy(), true, 'submit admits an operation');
  assert.equal(app.submitButton.disabled, true);
  app.refreshButton.click();
  await settle();
  assert.equal(app.busy(), true, 'both operations hold the gate');

  // Pump until the collector idles on a poll — both flows are between their
  // last poll and their finally blocks here. The handler has cleared the
  // draft input by now; the user immediately types a NEW draft mid-collection.
  const opsCount = () => app.fetchCalls.filter((call) => call === 'GET /api/v1/ops').length;
  assert.ok(app.fetchCalls.includes('POST /api/v1/wallets/addresses'), 'form add reached the API');
  assert.ok(app.fetchCalls.includes('POST /api/v1/wallets/refresh'), 'refresh reached the API');
  await pumpUntil(app.clock, () => opsCount() >= 5, 400);
  app.addressInput.value = '0x' + 'd'.repeat(40);

  // Both flows eventually settle; the flag must go false only when the LAST
  // finally releases, and no reload may fire while the draft exists.
  await pumpUntil(app.clock, () => !app.busy(), 400);
  assert.equal(app.busy(), false, 'owned tokens released by both finallys');
  assert.equal(app.reloadCount(), 0, 'completion reload deferred behind the new draft');

  // Clear the draft: the pending completion request completes promptly.
  app.addressInput.value = '';
  const flushed = await pumpUntil(app.clock, () => app.reloadCount() === 1, 400);
  assert.ok(flushed, 'pending reload completes after the gate clears');
  await submitPromise.catch(() => {});
  assert.ok(opsCount() >= 4, 'collector wait polled the ops API during the wait');
  assert.ok(app.refreshButton.disabled === false, 'refresh button re-enabled in finally');
  assert.ok(app.submitButton.disabled === false, 'submit button re-enabled in finally');
});

// ---------- Canary in-place updates (all transports are local test stubs) ----------

test('Canary periodically replaces evidence only, preserving scroll and avoiding navigation', async () => {
  const app = buildHarness({ canary: true });
  app.clock.advance(60000);
  await settle();
  assert.equal(app.state.requests.length, 1);
  assert.equal(app.state.replacements, 1);
  assert.equal(app.reloadCount(), 0);
  assert.equal(app.state.scrolls[0].top, 900);
  assert.match(app.statusEl.textContent, /Display checked at/);
  assert.equal(app.clock.size(), 1);
});

for (const event of ['visibilitychange', 'online', 'pageshow', 'resume']) {
  test(`Canary catches up immediately after ${event}, not after a new 60-second interval`, async () => {
    const app = buildHarness({ canary: true });
    if (event === 'visibilitychange' || event === 'resume') app.doc.dispatch(event);
    else app.dispatchWindow(event, { persisted: true });
    assert.equal(app.state.requests.length, 1);
    await settle();
    assert.equal(app.state.replacements, 1);
  });
}

test('Canary ignores a normal pageshow, and an intentional pause wins over every resume signal', async () => {
  const app = buildHarness({ canary: true });
  app.dispatchWindow('pageshow', { persisted: false });
  assert.equal(app.state.requests.length, 0);
  app.toggleEl.click();
  app.doc.dispatch('visibilitychange');
  app.doc.dispatch('resume');
  app.dispatchWindow('online');
  app.dispatchWindow('pageshow', { persisted: true });
  app.clock.advance(120000);
  assert.equal(app.state.requests.length, 0);
  assert.match(app.statusEl.textContent, /paused/);
  app.toggleEl.click();
  assert.equal(app.state.requests.length, 1);
  await settle();
});

test('Canary resume defers behind focus, drafts, and owned wallet operations', async () => {
  const input = { value: '' };
  const app = buildHarness({ canary: true, walletInputs: [input], activeElement: input });
  app.dispatchWindow('online');
  assert.equal(app.state.requests.length, 0);
  app.doc.activeElement = null;
  input.value = 'new draft';
  app.doc.dispatch('focusout');
  app.clock.advance(0);
  assert.equal(app.state.requests.length, 0);
  input.value = '';
  app.sandbox.window.__watchboardWalletBusy = true;
  app.doc.dispatch('input');
  assert.equal(app.state.requests.length, 0);
  app.sandbox.window.__watchboardWalletBusy = false;
  app.clock.advance(5000);
  await settle();
  assert.equal(app.state.replacements, 1);
});

test('Canary cannot overwrite a wallet draft typed while an update is in flight', async () => {
  const input = { value: '' };
  const app = buildHarness({ canary: true, walletInputs: [input] });
  let finish;
  app.setFetch(() => new Promise((resolve) => { finish = resolve; }));
  app.sandbox.window.requestWatchboardReload('test');
  input.value = 'keep this';
  finish({ ok: true, text: async () => '<fixture>' });
  await settle();
  assert.equal(app.state.replacements, 0);
  assert.equal(input.value, 'keep this');
  assert.match(app.statusEl.textContent, /being edited/);
  app.setFetch(async () => ({ ok: true, text: async () => '<fixture>' }));
  input.value = '';
  app.doc.dispatch('input');
  await settle();
  assert.equal(app.state.replacements, 1);
});

test('Canary coalesces periodic, pageshow, online and completion requests into one flight', async () => {
  const app = buildHarness({ canary: true });
  let finish;
  app.setFetch(() => new Promise((resolve) => { finish = resolve; }));
  app.clock.advance(60000);
  app.dispatchWindow('online');
  app.dispatchWindow('pageshow', { persisted: true });
  app.sandbox.window.requestWatchboardReload('wallets');
  assert.equal(app.state.requests.length, 1);
  finish({ ok: true, text: async () => '<fixture>' });
  await settle();
  assert.equal(app.state.replacements, 1);
  assert.equal(app.clock.size(), 1);
});

for (const reason of ['hidden', 'pause', 'offline']) {
  test(`Canary cancels on ${reason}; a late response cannot replace evidence`, async () => {
    const app = buildHarness({ canary: true });
    let finish;
    app.setFetch(() => new Promise((resolve) => { finish = resolve; }));
    app.sandbox.window.requestWatchboardReload('test');
    if (reason === 'hidden') { app.doc.hidden = true; app.doc.dispatch('visibilitychange'); }
    if (reason === 'pause') app.toggleEl.click();
    if (reason === 'offline') { app.sandbox.window.navigator.onLine = false; app.dispatchWindow('offline'); }
    assert.equal(app.state.requests[0][1].signal.aborted, true);
    finish({ ok: true, text: async () => '<fixture>' });
    await settle();
    assert.equal(app.state.replacements, 0);
    assert.equal(app.clock.size(), 0);
    app.setFetch(async () => ({ ok: true, text: async () => '<fixture>' }));
    if (reason === 'hidden') { app.doc.hidden = false; app.doc.dispatch('visibilitychange'); }
    if (reason === 'pause') app.toggleEl.click();
    if (reason === 'offline') { app.sandbox.window.navigator.onLine = true; app.dispatchWindow('online'); }
    await settle();
    assert.equal(app.state.replacements, 1);
  });
}

test('Canary bounds a hanging response body and keeps the old display on timeout', async () => {
  const app = buildHarness({ canary: true });
  app.setFetch(async () => ({ ok: true, text: () => new Promise(() => {}) }));
  app.sandbox.window.requestWatchboardReload('test');
  await settle();
  app.clock.advance(15000);
  await settle();
  assert.equal(app.state.requests[0][1].signal.aborted, true);
  assert.equal(app.state.replacements, 0);
  assert.match(app.statusEl.textContent, /Update timed out.*previous display/);
  app.setFetch(async () => ({ ok: true, text: async () => '<fixture>' }));
  app.clock.advance(59999);
  assert.equal(app.state.requests.length, 1);
  app.clock.advance(1);
  await settle();
  assert.equal(app.state.replacements, 1);
});

for (const failure of ['network', 'http', 'wrong document']) {
  test(`Canary retains all previous panels on ${failure} and announces the error`, async () => {
    const app = buildHarness({ canary: true });
    if (failure === 'network') app.setFetch(async () => { throw new Error('untrusted detail'); });
    if (failure === 'http') app.setFetch(async () => ({ ok: false }));
    if (failure === 'wrong document') app.setValidDocument(false);
    app.sandbox.window.requestWatchboardReload('test');
    await settle();
    assert.equal(app.state.replacements, 0);
    assert.match(app.statusEl.textContent, /Update failed/);
    assert.doesNotMatch(app.statusEl.textContent, /untrusted detail/);
    assert.equal(app.clock.size(), 1);
  });
}

test('Canary collector waits beyond the old 120s limit and shares one poller between actions', async () => {
  const app = buildIntegratedSandbox({ canary: true, collectorReply: (_poll, current) => ({
    ok: true, json: async () => ({ wallets: { collector: {
      running: current.clock.now < 180000, state: current.clock.now < 180000 ? 'RUNNING' : 'SUCCEEDED',
      last_started: '2026-10-28T20:00:00Z', last_exit: current.clock.now < 180000 ? null : 0,
      deadline_at: current.clock.now < 180000 ? '2026-10-28T20:04:00Z' : null, timeout_seconds: 240,
    } } }),
  }) });
  app.addressInput.value = '0x' + 'e'.repeat(40);
  const submit = app.addForm.submit();
  app.refreshButton.click();
  await settle();
  const polls = () => app.fetchCalls.filter((call) => call === 'GET /api/v1/ops').length;
  assert.equal(polls(), 1, 'both operations share the immediate poll');
  await pumpUntil(app.clock, () => app.clock.now >= 123000, 100);
  assert.equal(app.busy(), true);
  assert.equal(app.refreshButton.disabled, true);
  assert.match(app.collectorStatusEl.textContent, /deadline/);
  assert.equal(polls(), 42, 'one read per 3s, not one per admitted action');
  await pumpUntil(app.clock, () => !app.busy(), 100);
  assert.equal(app.clock.now, 180000);
  assert.equal(app.busy(), false);
  await submit;
});

test('Canary collector absolute deadline is not renewed by each running response', async () => {
  const app = buildIntegratedSandbox({ canary: true, collectorReply: () => ({
    ok: true, json: async () => ({ wallets: { collector: { running: true, state: 'RUNNING', last_started: '2026-10-28T20:00:00Z', deadline_at: '2026-10-28T20:00:06Z', timeout_seconds: 240 } } }),
  }) });
  app.refreshButton.click();
  await pumpUntil(app.clock, () => !app.busy(), 20);
  assert.equal(app.clock.now, 6000);
  assert.match(app.messageEl.textContent, /may still be running.*not confirmed/);
  assert.equal(app.reloadCount(), 0);
  assert.equal(app.refreshButton.disabled, false);
});

test('Canary collector bounds stalled JSON reads and releases the busy token after fallback limit', async () => {
  const app = buildIntegratedSandbox({ canary: true, collectorReply: () => ({ ok: true, json: () => new Promise(() => {}) }) });
  app.refreshButton.click();
  const finished = await pumpUntil(app.clock, () => !app.busy(), 200);
  assert.equal(finished, true);
  assert.equal(app.clock.now, 480000);
  assert.match(app.messageEl.textContent, /status-check limit.*not confirmed/);
  assert.equal(app.reloadCount(), 0);
});

test('Canary add preserves new input typed while the acknowledged request was pending', async () => {
  const app = buildIntegratedSandbox({ canary: true });
  let acknowledge;
  app.sandbox.fetch = async (url) => url === '/api/v1/wallets/addresses'
    ? new Promise((resolve) => { acknowledge = resolve; })
    : { ok: true, json: async () => ({ wallets: { collector: { running: false } } }) };
  app.addressInput.value = '0x' + 'f'.repeat(40);
  app.labelInput.value = 'old label';
  const submit = app.addForm.submit();
  await settle();
  app.addressInput.value = '0x' + 'a'.repeat(40);
  app.labelInput.value = 'new label';
  acknowledge({ status: 201, json: async () => ({}) });
  await submit;
  assert.equal(app.addressInput.value, '0x' + 'a'.repeat(40));
  assert.equal(app.labelInput.value, 'new label');
  assert.equal(app.busy(), false);
  assert.equal(app.reloadCount(), 0);
});

test('Canary does not retry an unconfirmed POST or discard its draft', async () => {
  const app = buildIntegratedSandbox({ canary: true });
  let calls = 0;
  app.sandbox.fetch = () => { calls += 1; return new Promise(() => {}); };
  app.addressInput.value = '0x' + 'a'.repeat(40);
  const submit = app.addForm.submit();
  await settle();
  app.clock.advance(10000);
  await submit;
  assert.equal(calls, 1);
  assert.equal(app.addressInput.value, '0x' + 'a'.repeat(40));
  assert.equal(app.busy(), false);
  assert.match(app.messageEl.textContent, /No additions were confirmed/);
});

for (const [name, state, last_error, last_exit, text, kind, completed] of [
  ['success', 'SUCCEEDED', null, 0, /reported success/, 'ok', 1],
  ['output contention', 'DEFERRED', 'OUTPUT_BUSY', null, /deferred.*No refreshed snapshot was confirmed/, 'warn', 0],
  ['server timeout', 'TIMEOUT', 'TIMEOUT', null, /timed out.*No refreshed snapshot was confirmed/, 'error', 0],
  ['failed attempt', 'FAILED', 'COLLECT_FAILED', 1, /failed.*No refreshed snapshot was confirmed/, 'error', 0],
  ['idle with no attempt', 'IDLE', null, null, /idle.*No collection result is confirmed/, 'warn', 0],
  ['legacy unconfirmed stop', undefined, null, null, /result is unconfirmed/, 'warn', 0],
  ['success contradicted by output lock', 'SUCCEEDED', 'OUTPUT_BUSY', 0, /deferred/, 'warn', 0],
  ['success contradicted by exit code', 'SUCCEEDED', null, 1, /failed/, 'error', 0],
]) {
  test(`Canary collector distinguishes ${name}, without resubmitting the request`, async () => {
    const app = buildIntegratedSandbox({ canary: true, collectorReply: () => ({
      ok: true, json: async () => ({ wallets: { collector: {
        running: false, state, last_error, last_exit, deadline_at: null, timeout_seconds: 240,
      } } }),
    }) });
    let completions = 0;
    app.sandbox.window.requestWatchboardReload = () => { completions += 1; };
    app.refreshButton.click();
    await settle();
    assert.equal(app.busy(), false);
    assert.equal(app.refreshButton.disabled, false);
    assert.match(app.messageEl.textContent, text);
    assert.equal(app.messageEl.dataset.kind, kind);
    assert.equal(completions, completed, 'only a confirmed successful collection requests a completion refresh');
    assert.equal(app.fetchCalls.filter((call) => call.startsWith('POST ')).length, 1);
    assert.doesNotMatch(app.collectorStatusEl.textContent, /deadline null|deadline None/);
    if (!completed) assert.doesNotMatch(app.collectorStatusEl.textContent, /Collector succeeded/);
  });
}

for (const absoluteDeadline of [true, false]) {
  test(`Canary re-anchors a server-identified new attempt (${absoluteDeadline ? 'absolute deadline' : 'start plus timeout'}) without dropping the busy gate`, async () => {
    const app = buildIntegratedSandbox({ canary: true, collectorReply: (_poll, current) => {
      const followUp = current.clock.now >= 3000;
      const running = current.clock.now < 9000;
      return { ok: true, json: async () => ({ wallets: { collector: {
        running, state: running ? 'RUNNING' : 'SUCCEEDED', last_exit: running ? null : 0, last_error: null,
        last_started: followUp ? '2026-10-28T20:00:03Z' : '2026-10-28T20:00:00Z',
        deadline_at: absoluteDeadline && running ? (followUp ? '2026-10-28T20:00:12Z' : '2026-10-28T20:00:06Z') : null,
        timeout_seconds: followUp ? 9 : 6,
      } } }) };
    } });
    app.refreshButton.click();
    await pumpUntil(app.clock, () => app.clock.now >= 6000, 10);
    assert.equal(app.busy(), true, 'the old attempt deadline must not end a newer attempt');
    await pumpUntil(app.clock, () => !app.busy(), 10);
    assert.equal(app.clock.now, 9000);
    assert.match(app.messageEl.textContent, /reported success/);
    assert.equal(app.fetchCalls.filter((call) => call === 'GET /api/v1/ops').length, 4);
    assert.equal(app.fetchCalls.filter((call) => call.startsWith('POST ')).length, 1);
  });
}

test('a moving deadline without a newer attempt start cannot extend a Canary collector wait', async () => {
  const app = buildIntegratedSandbox({ canary: true, collectorReply: (_poll, current) => ({
    ok: true, json: async () => ({ wallets: { collector: {
      running: true, state: 'RUNNING', last_started: '2026-10-28T20:00:00Z', timeout_seconds: 240,
      deadline_at: new Date(Date.parse('2026-10-28T20:00:00Z') + current.clock.now + 6000).toISOString(),
    } } }),
  }) });
  app.refreshButton.click();
  await pumpUntil(app.clock, () => !app.busy(), 20);
  assert.equal(app.clock.now, 6000);
  assert.match(app.messageEl.textContent, /result is not confirmed/);
});

test('even repeated new collector attempts cannot exceed the bounded overall UI wait', async () => {
  const epoch = Date.parse('2026-10-28T20:00:00Z');
  const app = buildIntegratedSandbox({ canary: true, collectorReply: (_poll, current) => ({
    ok: true, json: async () => ({ wallets: { collector: {
      running: true, state: 'RUNNING', timeout_seconds: 240,
      last_started: new Date(epoch + current.clock.now).toISOString(),
      deadline_at: new Date(epoch + current.clock.now + 240000).toISOString(),
    } } }),
  }) });
  app.refreshButton.click();
  const finished = await pumpUntil(app.clock, () => !app.busy(), 400);
  assert.equal(finished, true);
  assert.equal(app.clock.now, 900000);
  assert.match(app.messageEl.textContent, /status-check limit/);
  assert.equal(app.fetchCalls.filter((call) => call.startsWith('POST ')).length, 1);
});
