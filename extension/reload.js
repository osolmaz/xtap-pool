import { ScrapeReceiptStore } from './lib/scrape-receipts.js';

try {
  const params = new URLSearchParams(window.location.search);
  if (params.get('fail-active') === '1') {
    const store = new ScrapeReceiptStore();
    await store.beginCutover(Date.now());
    await store.close();
  }
  chrome.runtime.reload();
} catch {
  document.body.textContent = 'xTap reload failed.';
}
