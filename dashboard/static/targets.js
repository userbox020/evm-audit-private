(() => {
  'use strict';
  const root = document.querySelector('[data-targets-page]');
  if (!root) return;
  const form = root.querySelector('[data-target-filters]');

  // The server owns the full inventory, query normalization, order, and page.
  // A native GET submission also works without JavaScript. Unrelated query
  // parameters are rendered as hidden inputs; only the browser knows the hash.
  const preserveHash = () => {
    const current = new URL(window.location.href);
    const action = new URL(form.getAttribute('action'), current);
    action.hash = current.hash;
    form.action = action.pathname + action.hash;
    root.querySelectorAll('a[data-target-nav]').forEach((link) => {
      const destination = new URL(link.getAttribute('href'), current);
      destination.hash = current.hash;
      link.href = destination.pathname + destination.search + destination.hash;
    });
  };

  form.addEventListener('submit', () => {
    form.elements.namedItem('page').value = '1';
    preserveHash();
  });
  window.addEventListener('hashchange', preserveHash);
  window.addEventListener('pageshow', preserveHash);
  preserveHash();
  // No row filtering, fetch, timer, or duplicate disclosure storage. The shared
  // refresh script keeps pause / hidden-tab behavior and stable-ID disclosures.
})();
