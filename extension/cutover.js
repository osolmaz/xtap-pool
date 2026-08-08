import { ScrapeReceiptStore } from './lib/scrape-receipts.js';

try {
  const store = new ScrapeReceiptStore();
  await store.beginCutover(Date.now());
  await store.close();
  chrome.runtime.reload();
} catch {
  document.body.textContent = 'xTap cutover failed.';
}
