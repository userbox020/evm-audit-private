(() => {
  const interval = Number(document.body.dataset.refreshInterval || 60000);
  const statusEl = document.querySelector('[data-refresh-status]');
  const toggle = document.querySelector('[data-refresh-toggle]');
  const canary = Boolean(document.querySelector('[data-canary-live]'));
  const DETAILS_KEY = 'watchboard-details-open';
  let paused = false;
  try { paused = window.sessionStorage.getItem('watchboard-refresh-paused') === 'true'; } catch (_) { /* use this page's state */ }
  let timer;
  let pendingRetryTimer;
  let pendingReload = false;
  let request = null;
  let lastCheck = 'this page load';
  const offline = () => canary && window.navigator && window.navigator.onLine === false;

  // Fail-closed deferred-reload gate. A reload happens only when no refresh
  // (Pause / hidden tab) applies and no wallet draft, edit focus, or in-flight
  // wallet operation would be interrupted. wallets.js holds the flag with an
  // owned-operation registry until ALL admitted actions end, so a completed
  // outcome panel never latches this false forever.
  const isWalletBusy = () => window.__watchboardWalletBusy === true;

  const hasDraftOrFocus = () => {
    const zone = document.querySelector('[data-wallets]');
    if (!zone) return false;
    const inputs = zone.querySelectorAll('[data-wallet-add] input');
    for (let index = 0; index < inputs.length; index += 1) {
      const input = inputs[index];
      if (String(input.value || '').trim() !== '') return true;
      if (document.activeElement === input) return true;
    }
    return false;
  };

  const shouldDeferReload = () => isWalletBusy() || hasDraftOrFocus();

  const describeDeferral = () => {
    if (isWalletBusy()) return 'Automatic refresh is waiting: collection or a wallet action is in progress.';
    return 'Automatic refresh is waiting: a wallet address form is being edited.';
  };

  // Stable-ID open/closed state for <details> sections only; sections without
  // an explicit id are intentionally not restored (no fragile DOM-order keys).
  const readDetailMap = () => {
    try {
      return JSON.parse(window.sessionStorage.getItem(DETAILS_KEY) || '{}') || {};
    } catch (error) {
      return {};
    }
  };

  const restoreDetails = () => {
    const map = readDetailMap();
    const sections = document.querySelectorAll('details[id]');
    for (let index = 0; index < sections.length; index += 1) {
      const section = sections[index];
      if (Object.prototype.hasOwnProperty.call(map, section.id)) {
        section.open = map[section.id] === true;
      }
    }
  };

  const isDetailsElement = (target) =>
    !(typeof target.localName === 'string' && target.localName !== 'details');

  const setDetailState = (detail) => {
    const map = readDetailMap();
    map[detail.id] = detail.open === true;
    try {
      window.sessionStorage.setItem(DETAILS_KEY, JSON.stringify(map));
    } catch (error) {
      /* storage unavailable; state stays on this page */
    }
  };

  document.addEventListener('toggle', (event) => {
    const target = event ? event.target : null;
    if (!target || typeof target !== 'object' || target.nodeType === 3 || !target.id) return;
    if (!isDetailsElement(target)) return;
    setDetailState(target);
  }, true);

  // Canary keeps the existing document and wallet controls. Only explicitly
  // marked evidence panels are replaced, atomically after all checks pass.
  // Other pages retain their existing full-page reload behavior.
  const cancelCanaryRequest = () => {
    if (!request) return;
    request.cancelled = true;
    request.controller.abort();
    request.reject(new Error('cancelled'));
    pendingReload = true;
  };

  const updateCanary = async () => {
    if (request) return;
    window.clearTimeout(timer);
    clearPendingRetry();
    const current = { controller: new AbortController(), cancelled: false, timedOut: false, started: Date.now() };
    request = current;
    if (statusEl) statusEl.textContent = 'Checking the local server… Previous evidence remains visible.';
    const cancellation = new Promise((_, reject) => { current.reject = reject; });
    const timeout = window.setTimeout(() => {
      current.timedOut = true;
      current.controller.abort();
      current.reject(new Error('timeout'));
    }, 15000);
    try {
      const next = await Promise.race([cancellation, (async () => {
        const response = await window.fetch(window.location.href, {
          headers: { Accept: 'text/html' }, cache: 'no-store', credentials: 'same-origin',
          signal: current.controller.signal,
        });
        if (!response.ok) throw new Error('http');
        const html = await response.text();
        const page = new DOMParser().parseFromString(html, 'text/html');
        if (!page.querySelector('[data-canary-live]')) throw new Error('document');
        return page;
      })()]);
      if (current.cancelled || document.hidden || paused || offline()) return;
      if (shouldDeferReload()) {
        pendingReload = true;
        if (statusEl) statusEl.textContent = describeDeferral();
        return;
      }
      const panels = Array.from(document.querySelectorAll('[data-canary-panel]'));
      const incoming = Array.from(next.querySelectorAll('[data-canary-panel]'));
      if (!panels.length || panels.length !== incoming.length) throw new Error('panels');
      const replacements = panels.map((panel) => {
        const matches = incoming.filter((item) => item.dataset.canaryPanel === panel.dataset.canaryPanel);
        if (matches.length !== 1) throw new Error('panel');
        return matches[0];
      });
      const x = window.scrollX;
      const y = window.scrollY;
      document.querySelectorAll('details[id]').forEach(setDetailState);
      const scrolls = panels.map((panel) => Array.from(panel.querySelectorAll('.table-wrap')).map((table) => table.scrollLeft));
      panels.forEach((panel, index) => panel.replaceWith(replacements[index]));
      // Keep the original collector node: wallets.js owns its live reference.
      const collector = document.querySelector('[data-collector-status]');
      const nextCollector = next.querySelector('[data-collector-status]');
      if (collector && nextCollector) collector.textContent = nextCollector.textContent;
      restoreDetails();
      replacements.forEach((panel, index) => panel.querySelectorAll('.table-wrap').forEach((table, column) => {
        table.scrollLeft = scrolls[index][column] || 0;
      }));
      document.dispatchEvent(new CustomEvent('watchboard:canary-updated', {
        detail: { elapsedSeconds: Math.max(0, (Date.now() - current.started) / 1000) },
      }));
      if (typeof window.scrollTo === 'function') window.scrollTo({ left: x, top: y, behavior: 'instant' });
      pendingReload = false;
      lastCheck = new Date().toLocaleTimeString();
      if (statusEl) statusEl.textContent = `Display checked at ${lastCheck}. Source timestamps are shown below.`;
    } catch (_) {
      if (!current.cancelled && statusEl) {
        statusEl.textContent = `${current.timedOut ? 'Update timed out' : 'Update failed'} — showing the previous display. Source ages keep increasing; retrying in ${Math.round(interval / 1000)}s.`;
      }
    } finally {
      window.clearTimeout(timeout);
      if (request === current) request = null;
      if (current.cancelled) {
        updateUi();
        if (!document.hidden && !paused && !offline()) processPendingReload();
      } else if (pendingReload && shouldDeferReload() && !document.hidden && !paused && !offline()) {
        pendingRetryTimer = window.setTimeout(processPendingReload, 5000);
      } else {
        schedule();
      }
    }
  };

  // Completion refreshes (wallet collection finished) route through this gate
  // instead of a bare reload, so pending intent survives busy work, drafts,
  // pause, and hidden tabs, and completes promptly once it is safe. The
  // pending flag cannot latch: each retry re-checks instead of assuming.
  window.requestWatchboardReload = (source) => {
    pendingReload = true;
    void source;
    if (document.hidden || paused || offline()) return; // visibility/pause handlers resume it
    processPendingReload();
  };

  const clearPendingRetry = () => {
    window.clearTimeout(pendingRetryTimer);
    pendingRetryTimer = undefined;
  };

  const processPendingReload = () => {
    clearPendingRetry();
    if (!pendingReload || document.hidden || paused || offline() || request) return;
    if (shouldDeferReload()) {
      if (statusEl) statusEl.textContent = describeDeferral();
      pendingRetryTimer = window.setTimeout(processPendingReload, 5000);
      return;
    }
    if (canary) { updateCanary(); return; }
    window.location.reload();
  };

  const schedule = () => {
    window.clearTimeout(timer);
    clearPendingRetry();
    if (!document.hidden && !paused && !offline() && !request) timer = window.setTimeout(fire, interval);
  };

  const fire = () => {
    if (document.hidden || paused || offline()) return;
    if (canary) pendingReload = true;
    if (pendingReload) {
      processPendingReload();
      return;
    }
    if (shouldDeferReload()) {
      if (statusEl) statusEl.textContent = describeDeferral();
      timer = window.setTimeout(fire, 5000);
      return;
    }
    window.location.reload();
  };

  const updateUi = () => {
    if (toggle) {
      toggle.setAttribute('aria-pressed', String(paused));
      toggle.textContent = paused ? 'Resume refresh' : 'Pause refresh';
    }
    if (statusEl) statusEl.textContent = paused ? 'Automatic refresh is paused.' : (document.hidden ? 'Automatic refresh paused while this tab is hidden.' : (offline() ? 'Offline — showing the previous display. Source ages keep increasing; a server check is needed after reconnect.' : (canary ? `Last display check: ${lastCheck}. Source timestamps are shown below.` : 'Last UI refresh: this page load')));
  };

  if (toggle) toggle.addEventListener('click', () => {
    paused = !paused;
    try { window.sessionStorage.setItem('watchboard-refresh-paused', String(paused)); } catch (_) { /* pause still applies here */ }
    if (canary) {
      if (paused) cancelCanaryRequest();
      else pendingReload = true;
    }
    updateUi();
    schedule();
    processPendingReload();
  });
  document.addEventListener('visibilitychange', () => {
    if (canary) {
      pendingReload = true;
      if (document.hidden) cancelCanaryRequest();
    }
    updateUi();
    schedule();
    processPendingReload();
  });

  if (canary) {
    const catchUp = () => {
      pendingReload = true;
      updateUi();
      schedule();
      processPendingReload();
    };
    window.addEventListener('online', catchUp);
    window.addEventListener('offline', () => { cancelCanaryRequest(); updateUi(); schedule(); });
    window.addEventListener('pageshow', (event) => { if (event.persisted) catchUp(); });
    window.addEventListener('pagehide', () => { cancelCanaryRequest(); window.clearTimeout(timer); clearPendingRetry(); });
    document.addEventListener('resume', catchUp);
    // Clearing a draft or leaving its input need not wait for the next minute.
    document.addEventListener('input', () => { if (pendingReload) processPendingReload(); });
    document.addEventListener('focusout', () => {
      if (pendingReload) {
        clearPendingRetry();
        pendingRetryTimer = window.setTimeout(processPendingReload, 0);
      }
    });
  }

  restoreDetails();
  updateUi();
  schedule();
})();
