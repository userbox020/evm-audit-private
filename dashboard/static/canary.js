(() => {
  if (!document.querySelector('[data-canary-live]')) return;
  let ages = [];
  let deadlines = [];
  let timer;
  let lastTick = Date.now();
  const monotonic = () => window.performance.now();
  const number = (value) => value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
  const elapsed = (anchor) => {
    // performance.now resists clock edits; positive wall time also counts OS
    // sleep on platforms where the performance clock pauses. Never go back.
    anchor.elapsed = Math.max(anchor.elapsed, (monotonic() - anchor.mono) / 1000, (Date.now() - anchor.wall) / 1000, 0);
    return anchor.elapsed;
  };
  const duration = (seconds) => {
    const value = Math.max(0, Math.floor(seconds));
    if (value < 60) return `${value}s`;
    if (value < 3600) return `${Math.floor(value / 60)}m ${value % 60}s`;
    if (value < 86400) return `${Math.floor(value / 3600)}h ${Math.floor(value % 3600 / 60)}m`;
    return `${Math.floor(value / 86400)}d ${Math.floor(value % 86400 / 3600)}h`;
  };
  const anchor = () => ({ mono: monotonic(), wall: Date.now(), elapsed: 0 });
  const initialize = (extra = 0) => {
    ages = Array.from(document.querySelectorAll('[data-canary-age]')).map((node) => ({
      ...anchor(), node, age: number(node.dataset.canaryAge), initial: node.dataset.freshness,
      aging: number(node.dataset.agingAfter), stale: number(node.dataset.staleAfter), extra,
      recheck: false, state: node.querySelector('[data-age-state]'), value: node.querySelector('[data-age-value]'),
    }));
    deadlines = Array.from(document.querySelectorAll('[data-canary-deadline]')).map((node) => {
      const known = number(node.dataset.remaining);
      const absolute = Date.parse(node.dataset.canaryDeadline);
      return { ...anchor(), node, remaining: known === null ? (Number.isFinite(absolute) ? (absolute - Date.now()) / 1000 : null) : known,
        extra, ended: node.dataset.ended === 'true', recheck: false, serverTimed: known !== null,
        state: node.querySelector('[data-deadline-state]') };
    });
    tick(false);
  };
  const requireCheck = () => {
    ages.forEach((item) => { item.recheck = true; });
    deadlines.forEach((item) => { item.recheck = true; });
    tick(false);
  };
  const tick = (detectSleep = true) => {
    window.clearTimeout(timer);
    const now = Date.now();
    if (detectSleep && now - lastTick > 15000) {
      ages.forEach((item) => { item.recheck = true; });
      deadlines.forEach((item) => { item.recheck = true; });
      if (typeof window.requestWatchboardReload === 'function') window.requestWatchboardReload('resume');
    }
    lastTick = now;
    ages.forEach((item) => {
      const age = item.age === null ? null : Math.max(0, item.age) + elapsed(item) + item.extra;
      let state = item.initial;
      // UNKNOWN, CLOCK_SKEW, unavailable, and already stale never become fresh
      // merely because the browser clock advances.
      if (['FRESH', 'AGING', 'STALE'].includes(state) && age !== null) {
        if (item.stale !== null && age > item.stale) state = 'STALE';
        else if (state === 'FRESH' && item.aging !== null && age > item.aging) state = 'AGING';
        if (item.recheck && state !== 'STALE') state = 'CHECK_NEEDED';
      }
      if (age === null && ['FRESH', 'AGING'].includes(state)) state = 'UNKNOWN';
      if (item.age !== null && item.age < 0 && ['FRESH', 'AGING'].includes(state)) state = 'CHECK_NEEDED';
      item.state.textContent = state.replaceAll('_', ' ');
      item.state.className = `pill ${state === 'CHECK_NEEDED' ? 'unknown' : state.toLowerCase()}`;
      item.value.textContent = age === null ? '· age unknown' : item.age < 0 ? '· source time is ahead · server check needed' : `· ${duration(age)} old${item.recheck ? ' · server check needed' : ''}`;
    });
    deadlines.forEach((item) => {
      const remaining = item.remaining === null ? null : item.remaining - elapsed(item) - item.extra;
      item.ended = item.ended || (remaining !== null && remaining <= 0);
      item.state.textContent = item.ended ? (item.node.dataset.endedLabel || 'Window ended') : remaining === null ? 'Deadline unknown' : `${duration(remaining)} until recorded end${item.recheck || !item.serverTimed ? ' · server check needed' : ''}`;
      item.state.className = item.ended ? (item.node.dataset.historicalDeadline === 'true' ? 'pill neutral' : 'pill warn') : 'window-context';
      item.node.dataset.expired = String(item.ended);
      if (item.node.dataset.executionDeadline === 'true' && (item.ended || item.recheck)) {
        document.querySelectorAll('[data-canary-authority-state]').forEach((node) => {
          if (node.dataset.canaryAuthorityState === 'VALID') node.textContent = item.ended ? 'EXPIRED' : 'CHECK NEEDED';
        });
      }
    });
    if (!document.hidden) timer = window.setTimeout(tick, 1000);
  };
  document.addEventListener('watchboard:canary-updated', (event) => initialize(Math.max(0, Number(event.detail && event.detail.elapsedSeconds) || 0)));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) window.clearTimeout(timer);
    else requireCheck();
  });
  document.addEventListener('resume', requireCheck);
  window.addEventListener('offline', requireCheck);
  window.addEventListener('online', requireCheck);
  window.addEventListener('pageshow', (event) => { if (event.persisted) requireCheck(); });
  window.addEventListener('pagehide', () => window.clearTimeout(timer));
  initialize();
  if (window.navigator && window.navigator.onLine === false) requireCheck();
})();
