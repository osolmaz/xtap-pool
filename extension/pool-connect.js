// xtap-pool — content script for the pool Space's /connect page.
// Reads the pool token the Space rendered for the signed-in user and hands it
// to the service worker, so connecting requires no copy-paste.
(function () {
  'use strict';

  function tryConnect() {
    const el = document.getElementById('xtap-pool-token');
    if (!el) return false;
    const token = el.dataset.token || '';
    const username = el.dataset.username || '';
    if (!token) return false;
    chrome.runtime.sendMessage(
      { type: 'POOL_CONNECT', token, username, url: window.location.origin },
      (resp) => {
        const status = document.getElementById('xtap-pool-status');
        if (status && resp && resp.ok) {
          status.textContent = `Connected to the xtap-pool extension as @${username}. You can close this tab.`;
        }
      }
    );
    return true;
  }

  if (!tryConnect()) {
    document.addEventListener('DOMContentLoaded', tryConnect, { once: true });
  }
})();
