(() => {
  const STORAGE_KEY = 'watchboard-theme';
  const root = document.documentElement;
  const read = () => {
    try {
      return window.localStorage.getItem(STORAGE_KEY);
    } catch (error) {
      return null;
    }
  };
  const write = (value) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, value);
    } catch (error) {
      /* storage may be unavailable; the in-memory theme still applies */
    }
  };
  // Default is dark. Only an explicit stored "light" switches the palette.
  root.dataset.theme = read() === 'light' ? 'light' : 'dark';

  const syncButton = () => {
    const button = document.querySelector('[data-theme-toggle]');
    if (!button) return;
    const isLight = root.dataset.theme === 'light';
    button.setAttribute('aria-pressed', String(isLight));
    button.textContent = isLight ? 'Dark mode' : 'Light mode';
    button.title = isLight ? 'Switch to the dark theme' : 'Switch to the light theme';
  };

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-theme-toggle]') : null;
    if (!target) return;
    const next = root.dataset.theme === 'light' ? 'dark' : 'light';
    root.dataset.theme = next;
    write(next);
    syncButton();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', syncButton);
  } else {
    syncButton();
  }
})();
