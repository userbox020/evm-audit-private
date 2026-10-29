(() => {
  const root = document.querySelector('[data-wallets]');
  if (!root) return;
  const canary = Boolean(document.querySelector('[data-canary-live]'));
  const message = root.querySelector('[data-wallet-message]');
  const addForm = root.querySelector('[data-wallet-add]');
  const accountsBox = root.querySelector('[data-wallet-accounts]');
  const outcomesBox = root.querySelector('[data-wallet-outcomes]');
  const connectButton = root.querySelector('[data-wallet-connect]');
  const refreshButton = root.querySelector('[data-wallet-refresh]');
  const collectorEl = root.querySelector('[data-collector-status]');
  const collectorBar = root.querySelector('[data-collector-bar]');

  const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
  const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const validSolanaAddress = (address) => {
    if (!SOLANA_ADDRESS.test(address)) return false;
    let value = 0n;
    for (const character of address) value = value * 58n + BigInt(BASE58.indexOf(character));
    let bytes = address.match(/^1*/)[0].length;
    while (value > 0n) { bytes += 1; value >>= 8n; }
    return bytes === 32;
  };
  const OUTCOME_KEY = 'watchboard-wallet-outcomes';

  // Family is inferred from the address shape; EVM is the default.
  const addressFamily = (address) => {
    if (typeof address !== 'string') return null;
    if (EVM_ADDRESS.test(address)) return 'evm';
    if (validSolanaAddress(address)) return 'solana';
    return null;
  };

  // Per-reason copy. Every POST response maps to one of these outcomes.
  const REASONS = {
    INVALID_ADDRESS: { kind: 'error', text: 'rejected — not a valid 0x address' },
    DUPLICATE_ADDRESS: { kind: 'warn', text: 'skipped — already watched' },
    ADDRESS_NOT_FOUND: { kind: 'warn', text: 'skipped — address is not in the watchlist' },
    ADDRESS_LIMIT_REACHED: { kind: 'error', text: 'rejected — watchlist limit reached (20)' },
    WATCHLIST_UNREADABLE: { kind: 'error', text: 'rejected — watchlist unreadable, left unchanged' },
    WRITE_FAILED: { kind: 'error', text: 'rejected — watchlist write failed' },
    BODY_TOO_LARGE: { kind: 'error', text: 'rejected — request too large' },
    UNSUPPORTED_MEDIA_TYPE: { kind: 'error', text: 'rejected — unsupported request type' },
    FORBIDDEN_ORIGIN: { kind: 'error', text: 'rejected — cross-origin request' },
    COLLECTOR_RUNNING: { kind: 'warn', text: 'skipped — a refresh is already running' },
    NETWORK: { kind: 'error', text: 'failed — no response from the local server' },
    UNCONFIRMED: { kind: 'warn', text: 'no response — the request outcome is unknown; check status before trying again' },
  };

  const shortAddress = (address) =>
    typeof address === 'string' && address.length > 12
      ? `${address.slice(0, 6)}…${address.slice(-4)}`
      : String(address || '');

  const setMessage = (text, kind) => {
    if (!message) return;
    message.textContent = text;
    message.hidden = !text;
    message.dataset.kind = kind || '';
  };

  const focusManualInput = () => {
    const input = addForm && addForm.querySelector('input[name="address"]');
    if (input) input.focus();
  };

  // In-flight marker for the auto-refresh gate (refresh.js). A reload must
  // never interrupt a provider prompt, an add/remove request, or the collector
  // wait. Actions overlap (e.g. a live wallet prompt while a balance refresh
  // runs and both wait on the collector), so each admitted action owns a
  // token and the flag clears only when the LAST token releases — every
  // release happens in a finally.
  const activeOps = new Set();
  let nextOpId = 0;
  const beginWalletOp = () => {
    nextOpId += 1;
    const opId = nextOpId;
    activeOps.add(opId);
    window.__watchboardWalletBusy = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeOps.delete(opId);
      window.__watchboardWalletBusy = activeOps.size > 0;
    };
  };

  // Completion reloads route through the safe-reload coordinator in
  // refresh.js so intent survives busy work, drafts, pause, and hidden tabs.
  // The bare-reload fallback only exists if refresh.js failed to load.
  const requestCompletionReload = () => {
    if (typeof window.requestWatchboardReload === 'function') {
      window.requestWatchboardReload('wallets');
    } else {
      window.location.reload();
    }
  };

  // A) Gather every candidate EVM provider: window.ethereum, its providers[]
  // array (multi-wallet coexistence), and Phantom's dedicated EVM provider.
  const candidateProviders = () => {
    const providers = [];
    const add = (provider) => {
      if (provider && typeof provider.request === 'function' && providers.indexOf(provider) === -1) {
        providers.push(provider);
      }
    };
    const ethereum = window.ethereum;
    if (ethereum) {
      if (ethereum.providers && typeof ethereum.providers.length === 'number') {
        Array.prototype.forEach.call(ethereum.providers, add);
      }
      add(ethereum);
    }
    const phantomEthereum = window.phantom && window.phantom.ethereum;
    add(phantomEthereum);
    return providers;
  };

  // A) Request accounts from every provider, keep only unique 0x EVM accounts.
  const discoverEvmAccounts = async () => {
    const providers = candidateProviders();
    const seen = new Set();
    const accounts = [];
    let sawNonEvm = false;
    for (const provider of providers) {
      let returned;
      try {
        returned = await provider.request({ method: 'eth_requestAccounts' });
      } catch (error) {
        continue; // declined or unavailable provider; try the next one
      }
      const list = Array.isArray(returned) ? returned : [];
      for (const account of list) {
        if (typeof account !== 'string') continue;
        if (EVM_ADDRESS.test(account)) {
          const key = account.toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            accounts.push(account);
          }
        } else if (account.trim()) {
          sawNonEvm = true; // e.g. a Solana base58 address
        }
      }
    }
    return { providers: providers.length, accounts, sawNonEvm };
  };

  // Bound the complete request, including its JSON body. Never retry a POST:
  // a missing response cannot tell us whether the local write happened.
  const boundedJson = async (path, init, milliseconds = 10000) => {
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        (async () => {
          const response = await fetch(path, { ...init, signal: controller.signal });
          return { response, data: await response.json() };
        })(),
        new Promise((_, reject) => {
          timer = window.setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, milliseconds);
        }),
      ]);
    } finally {
      window.clearTimeout(timer);
    }
  };

  const post = async (path, payload) => {
    try {
      const init = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload || {}),
      };
      if (canary) {
        const { response, data } = await boundedJson(path, init);
        return { status: response.status, data };
      }
      const response = await fetch(path, init);
      let data = null;
      try {
        data = await response.json();
      } catch (error) {
        data = null;
      }
      return { status: response.status, data };
    } catch (error) {
      return { status: 0, data: canary ? { reason: 'UNCONFIRMED' } : null };
    }
  };

  // E) Map one POST response to a per-address outcome.
  const outcomeFor = (address, status, data) => {
    if (status === 201) return { address, kind: 'ok', text: 'added' };
    if (status === 0) {
      const reason = canary ? REASONS.UNCONFIRMED : REASONS.NETWORK;
      return { address, kind: reason.kind, text: reason.text };
    }
    const reason = data && data.reason;
    const mapped = REASONS[reason] || { kind: 'error', text: `rejected (${reason || status})` };
    return { address, kind: mapped.kind, text: mapped.text };
  };

  const renderOutcomes = (outcomes) => {
    if (!outcomesBox) return;
    outcomesBox.textContent = '';
    if (!outcomes.length) {
      outcomesBox.hidden = true;
      return;
    }
    const heading = document.createElement('p');
    heading.className = 'eyebrow';
    heading.textContent = 'OUTCOMES';
    outcomesBox.appendChild(heading);
    const list = document.createElement('ul');
    list.className = 'wallet-outcome-list';
    outcomes.forEach((outcome) => {
      const item = document.createElement('li');
      item.className = `outcome ${outcome.kind}`;
      const code = document.createElement('code');
      code.textContent = shortAddress(outcome.address);
      const span = document.createElement('span');
      span.textContent = outcome.text;
      item.appendChild(code);
      item.appendChild(span);
      list.appendChild(item);
    });
    outcomesBox.appendChild(list);
    outcomesBox.hidden = false;
  };

  const persistOutcomes = (outcomes) => {
    try {
      window.sessionStorage.setItem(OUTCOME_KEY, JSON.stringify(outcomes));
    } catch (error) {
      /* storage unavailable; outcomes stay on this page */
    }
  };

  const restoreOutcomes = () => {
    let raw = null;
    try {
      raw = window.sessionStorage.getItem(OUTCOME_KEY);
      if (raw) window.sessionStorage.removeItem(OUTCOME_KEY);
    } catch (error) {
      return;
    }
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) renderOutcomes(parsed);
    } catch (error) {
      /* ignore malformed stored outcomes */
    }
  };

  const canaryCollectorState = (collector) => {
    if (collector.running === true) return 'RUNNING';
    if (collector.last_error === 'OUTPUT_BUSY' || collector.state === 'DEFERRED') return 'DEFERRED';
    if (collector.last_error === 'TIMEOUT' || collector.state === 'TIMEOUT') return 'TIMEOUT';
    if (collector.last_error || collector.state === 'FAILED' || (typeof collector.last_exit === 'number' && collector.last_exit !== 0)) return 'FAILED';
    if (collector.state === 'SUCCEEDED' || (!collector.state && collector.last_exit === 0)) return 'SUCCEEDED';
    return collector.state === 'IDLE' ? 'IDLE' : 'UNKNOWN';
  };

  const collectorText = (collector) => {
    if (!collector) return '';
    const state = canary ? canaryCollectorState(collector) : null;
    const label = state === 'TIMEOUT' ? 'timed out' : state === 'UNKNOWN' ? 'idle · result unconfirmed' : state && state.toLowerCase();
    const parts = [`Collector ${canary ? label : collector.running ? 'running' : 'idle'}`];
    if (collector.last_error) parts.push(collector.last_error);
    else if (collector.last_exit !== null && collector.last_exit !== undefined) parts.push(`exit ${collector.last_exit}`);
    if (collector.last_finished) parts.push(`finished ${collector.last_finished}`);
    if (canary && collector.running && collector.deadline_at) parts.push(`deadline ${collector.deadline_at}`);
    return parts.join(' · ');
  };

  const syncCollector = (collector) => {
    if (!collector) return;
    if (collectorEl) collectorEl.textContent = collectorText(collector);
    if (collectorBar) {
      collectorBar.classList.toggle('running', Boolean(collector.running));
      collectorBar.classList.toggle('danger', !collector.running && Boolean(collector.last_error));
      collectorBar.classList.toggle('ok', canary ? !collector.running && canaryCollectorState(collector) === 'SUCCEEDED' : !collector.running && !collector.last_error && collector.last_exit === 0);
    }
  };

  let collectorWait = null;
  const waitForCanaryCollector = async () => {
    const started = Date.now();
    const mono = window.performance.now();
    let elapsed = 0;
    const age = () => {
      elapsed = Math.max(elapsed, Date.now() - started, window.performance.now() - mono);
      return elapsed;
    };
    let budget = 480000; // Bounded fallback only for older responses without a deadline.
    let serverBudget = null;
    let attemptStarted = null;
    while (age() < budget) {
      try {
        const { response, data } = await boundedJson('/api/v1/ops', {
          headers: { Accept: 'application/json' }, cache: 'no-store',
        }, Math.min(10000, budget - age()));
        if (response.ok) {
          const collector = data && data.wallets && data.wallets.collector;
          syncCollector(collector);
          if (collector && collector.running === false) {
            const state = canaryCollectorState(collector);
            const outcome = {
              SUCCEEDED: ['Collector reported success. The balance snapshot still has its own timestamp.', 'ok'],
              DEFERRED: ['Balance collection was deferred: another balance writer owns the output. No refreshed snapshot was confirmed.', 'warn'],
              TIMEOUT: ['Balance collection timed out. No refreshed snapshot was confirmed.', 'error'],
              FAILED: ['Balance collection failed. No refreshed snapshot was confirmed; see the collector status.', 'error'],
              IDLE: ['Collector is idle. No collection result is confirmed for this request.', 'warn'],
              UNKNOWN: ['Collector is no longer running, but its result is unconfirmed.', 'warn'],
            }[state];
            setMessage(...outcome);
            return state === 'SUCCEEDED';
          }
          if (collector && collector.running === true) {
            const attempt = typeof collector.last_started === 'string' ? Date.parse(collector.last_started) : NaN;
            const newAttempt = Number.isFinite(attempt) && (attemptStarted === null || attempt > attemptStarted);
            if (newAttempt) {
              attemptStarted = attempt;
              serverBudget = null;
            }
            const end = typeof collector.deadline_at === 'string' ? Date.parse(collector.deadline_at) : NaN;
            const seconds = collector.timeout_seconds;
            const nextBudget = Number.isFinite(end) ? age() + end - Date.now()
              : typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
                ? (Number.isFinite(attempt) ? age() + attempt - Date.now() : 0) + seconds * 1000 : null;
            if (nextBudget !== null) {
              // Re-anchor only when the server identifies a newer attempt
              // (e.g. a coalesced watchlist change), never on each status poll.
              // All attempts together remain inside the 15m browser wait cap.
              serverBudget = Math.min(serverBudget === null ? Infinity : serverBudget, nextBudget, 900000);
              budget = Math.max(0, serverBudget);
            }
          }
        }
      } catch (_) { /* unknown status, not a finished or failed collection */ }
      const remaining = budget - age();
      if (remaining > 0) await new Promise((resolve) => window.setTimeout(resolve, Math.min(3000, remaining)));
    }
    setMessage('The collector deadline or status-check limit was reached. Collection may still be running; its result is not confirmed. Check its status before starting another collection.', 'warn');
    return false;
  };

  const waitForCollector = async () => {
    if (canary) {
      // Overlapping admitted wallet actions share one status poller, while
      // their existing owned operation tokens remain independent.
      if (!collectorWait) collectorWait = waitForCanaryCollector().finally(() => { collectorWait = null; });
      return collectorWait;
    }
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const response = await fetch('/api/v1/ops', { headers: { Accept: 'application/json' } });
        if (response.ok) {
          const data = await response.json();
          const collector = data && data.wallets && data.wallets.collector;
          syncCollector(collector);
          if (collector && !collector.running) return true;
        }
      } catch (error) {
        /* keep waiting; the page reload remains the fallback */
      }
      await new Promise((resolve) => window.setTimeout(resolve, 3000));
    }
    setMessage('Balance collection is still running or its status is unavailable; refresh the page later.', 'warn');
    return false;
  };

  // B) Explicit no-EVM state — never a silent empty list.
  const showNoEvmAccounts = (sawNonEvm, providerCount) => {
    const detail = sawNonEvm
      ? 'No EVM (0x…) accounts were returned. A Solana account cannot be connected through this button, but you can paste a Solana address to watch it.'
      : 'No EVM (0x…) accounts were returned. Your wallet may be locked, or this site may not have account permission — paste an EVM or Solana address instead.';
    if (accountsBox) {
      accountsBox.textContent = '';
      accountsBox.hidden = false;
      const heading = document.createElement('p');
      heading.className = 'eyebrow';
      heading.textContent = sawNonEvm ? 'NO EVM ACCOUNTS' : 'NO ACCOUNTS RETURNED';
      const copy = document.createElement('p');
      copy.className = 'ops-lede';
      copy.textContent = `${detail} (${providerCount} provider${providerCount === 1 ? '' : 's'} checked.)`;
      accountsBox.appendChild(heading);
      accountsBox.appendChild(copy);
    }
    setMessage(detail, 'warn');
    focusManualInput();
  };

  // C) Checkbox list with a prominent add action; single account stays checked.
  const renderAccounts = (accounts) => {
    if (!accountsBox) return;
    accountsBox.textContent = '';
    if (!accounts.length) return;
    const heading = document.createElement('p');
    heading.className = 'eyebrow';
    heading.textContent = 'ACCOUNTS FOUND';
    accountsBox.appendChild(heading);
    const list = document.createElement('ul');
    list.className = 'wallet-account-list';
    accounts.forEach((account) => {
      const item = document.createElement('li');
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = true;
      box.value = account;
      box.setAttribute('data-wallet-account', 'true');
      const code = document.createElement('code');
      code.textContent = account;
      label.appendChild(box);
      label.appendChild(code);
      item.appendChild(label);
      list.appendChild(item);
    });
    accountsBox.appendChild(list);
    const addButton = document.createElement('button');
    addButton.type = 'button';
    addButton.className = 'wallet-button primary';
    addButton.setAttribute('data-wallet-add-selected', 'true');
    addButton.textContent = 'Add selected & refresh';
    accountsBox.appendChild(addButton);
    accountsBox.hidden = false;
    if (accounts.length === 1) addButton.focus();
  };

  const addOne = async (address, label, family) => {
    const payload = { address };
    if (family) payload.family = family;
    if (label) payload.label = label;
    const { status, data } = await post('/api/v1/wallets/addresses', payload);
    return outcomeFor(address, status, data);
  };

  const finishAdd = async (outcomes) => {
    renderOutcomes(outcomes);
    persistOutcomes(outcomes);
    const added = outcomes.filter((outcome) => outcome.kind === 'ok').length;
    setMessage(
      added
        ? (canary ? `Added ${added} address(es). Checking the balance collector; new balances are not confirmed yet.` : `Added ${added} address(es). Balance refresh started; this page reloads when it finishes.`)
        : (canary ? 'No additions were confirmed. See the per-address outcomes above; an unanswered request may still have completed.' : 'No addresses were added. See the per-address outcomes above.'),
      added ? 'ok' : 'warn'
    );
    if (added) {
      if (await waitForCollector()) requestCompletionReload();
    }
  };

  if (connectButton) {
    connectButton.addEventListener('click', async () => {
      const providerCount = candidateProviders().length;
      if (!providerCount) {
        showNoEvmAccounts(false, 0);
        return;
      }
      connectButton.disabled = true;
      const endBusy = beginWalletOp();
      try {
        const result = await discoverEvmAccounts();
        if (!result.accounts.length) {
          showNoEvmAccounts(result.sawNonEvm, result.providers);
          return;
        }
        renderAccounts(result.accounts);
        setMessage(
          `Found ${result.accounts.length} EVM account(s) across ${result.providers} provider(s). Select the ones to watch, then choose “Add selected & refresh”. No signature or transaction is requested.`,
          'ok'
        );
      } catch (error) {
        showNoEvmAccounts(false, providerCount);
      } finally {
        connectButton.disabled = false;
        endBusy();
      }
    });
  }

  document.addEventListener('click', async (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-wallet-add-selected]') : null;
    if (!target || !root.contains(target)) return;
    const boxes = Array.from(root.querySelectorAll('input[data-wallet-account]')).filter((box) => box.checked);
    if (!boxes.length) {
      setMessage('Select at least one account to add.', 'warn');
      return;
    }
    target.disabled = true;
    const endBusy = beginWalletOp();
    try {
      const outcomes = [];
      for (const box of boxes) {
        outcomes.push(await addOne(box.value));
      }
      await finishAdd(outcomes);
    } finally {
      target.disabled = false;
      endBusy();
    }
  });

  if (addForm) {
    addForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const addressInput = addForm.querySelector('input[name="address"]');
      const labelInput = addForm.querySelector('input[name="label"]');
      const address = addressInput ? addressInput.value.trim() : '';
      const label = labelInput ? labelInput.value.trim() : '';
      const family = addressFamily(address);
      if (!family) {
        setMessage('Enter a valid EVM (0x…) or Solana (base58) address.', 'warn');
        if (addressInput) addressInput.focus();
        return;
      }
      const submit = addForm.querySelector('button[type="submit"]');
      if (submit) submit.disabled = true;
      const endBusy = beginWalletOp();
      try {
        const outcome = await addOne(address, label, family);
        if (outcome.kind === 'ok' && labelInput && (!canary || labelInput.value.trim() === label)) labelInput.value = '';
        if (addressInput && (!canary || (outcome.kind === 'ok' && addressInput.value.trim() === address))) addressInput.value = '';
        await finishAdd([outcome]);
      } finally {
        if (submit) submit.disabled = false;
        endBusy();
      }
    });
  }

  document.addEventListener('click', async (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-wallet-remove]') : null;
    if (!target || !root.contains(target)) return;
    const address = target.getAttribute('data-wallet-remove');
    const family = target.getAttribute('data-wallet-family');
    if (!address) return;
    target.disabled = true;
    const endBusy = beginWalletOp();
    try {
      const payload = family ? { address, family } : { address };
      const { status, data } = await post('/api/v1/wallets/addresses/remove', payload);
      const outcome = status === 200
        ? { address, kind: 'ok', text: 'removed' }
        : outcomeFor(address, status, data);
      renderOutcomes([outcome]);
      persistOutcomes([outcome]);
      if (status === 200 && await waitForCollector()) requestCompletionReload();
      target.disabled = false;
    } finally {
      target.disabled = false;
      endBusy();
    }
  });

  if (refreshButton) {
    refreshButton.addEventListener('click', async () => {
      refreshButton.disabled = true;
      const endBusy = beginWalletOp();
      try {
        const { status, data } = await post('/api/v1/wallets/refresh', {});
        if (status === 202 || status === 200) {
          setMessage(canary ? 'Balance refresh request accepted. Checking the collector result…' : 'Balance refresh started.', canary ? 'warn' : 'ok');
          if (await waitForCollector()) requestCompletionReload();
          return;
        }
        const mapped = REASONS[data && data.reason] || { kind: 'error', text: `request failed (${status})` };
        setMessage(mapped.text, mapped.kind);
      } finally {
        refreshButton.disabled = false;
        endBusy();
      }
    });
  }

  restoreOutcomes();
})();
