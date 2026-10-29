/* Progressive review controls only. Native GET filters and details need no JS. */
(() => {
  'use strict';
  const section = document.querySelector('[data-deployed-contracts]');
  if (!section) return;
  const records = section.querySelectorAll('details[data-contract-record]');
  const actions = section.querySelector('[data-contract-detail-actions]');
  if (actions && records.length) {
    actions.querySelector('[data-contract-expand]').addEventListener('click', () => {
      records.forEach(record => { record.open = true; });
    });
    actions.querySelector('[data-contract-collapse]').addEventListener('click', () => {
      records.forEach(record => { record.open = false; });
    });
    actions.hidden = false;
  }
  const openLinkedContract = () => {
    let id;
    try { id = decodeURIComponent(window.location.hash.slice(1)); } catch (_) { return; }
    if (!id.startsWith('contract-')) return;
    const record = document.getElementById(id);
    if (!record || !section.contains(record) || !record.matches('details[data-contract-record]')) return;
    record.open = true;
    record.scrollIntoView({ block: 'start', behavior: 'instant' });
  };
  window.addEventListener('hashchange', openLinkedContract);
  openLinkedContract();
})();
