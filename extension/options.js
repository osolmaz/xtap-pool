const statusEl = document.getElementById('pool-status');
const urlInput = document.getElementById('pool-url');
const tokenInput = document.getElementById('pool-token');
const saveBtn = document.getElementById('save');

function render(state) {
  if (!state) return;
  urlInput.value = state.url || '';
  if (state.connected) {
    const who = state.username ? ` as @${state.username}` : '';
    statusEl.textContent = `Connected${who} — ${state.queued} queued, ${state.synced} synced`;
    statusEl.className = 'status connected';
  } else {
    statusEl.textContent = 'Not connected to a pool';
    statusEl.className = 'status disconnected';
  }
}

chrome.runtime.sendMessage({ type: 'POOL_STATUS' }, render);

saveBtn.addEventListener('click', () => {
  const msg = { type: 'POOL_SET_CONFIG' };
  const url = urlInput.value.trim();
  const token = tokenInput.value.trim();
  if (url) msg.url = url;
  if (token) msg.token = token;
  saveBtn.disabled = true;
  chrome.runtime.sendMessage(msg, (state) => {
    saveBtn.disabled = false;
    tokenInput.value = '';
    render(state);
  });
});
