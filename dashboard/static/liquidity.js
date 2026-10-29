/* Native GET filtering and <details> do the work; no fetching or status changes. */
(() => {
  'use strict';
  const page = document.querySelector('[data-liquidity-page]');
  if (!page) return;

  const routes = page.querySelectorAll('details[data-liquidity-route]');
  const actions = page.querySelector('[data-liquidity-detail-actions]');
  if (actions && routes.length) {
    actions.querySelector('[data-liquidity-expand]').addEventListener('click', () => {
      routes.forEach((route) => { route.open = true; });
    });
    actions.querySelector('[data-liquidity-collapse]').addEventListener('click', () => {
      routes.forEach((route) => { route.open = false; });
    });
    actions.hidden = false;
  }

  // A shared path link opens its record, even after refresh.js restores details.
  const openLinkedPath = () => {
    let id;
    try { id = decodeURIComponent(window.location.hash.slice(1)); } catch (_) { return; }
    if (!id.startsWith('liquidity-route-')) return;
    const route = document.getElementById(id);
    if (!route || !page.contains(route) || !route.matches('details[data-liquidity-route]')) return;
    route.open = true;
    route.scrollIntoView({ block: 'start', behavior: 'instant' });
  };
  window.addEventListener('hashchange', openLinkedPath);
  openLinkedPath();
})();
