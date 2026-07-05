const statusEl = document.getElementById('status');
const sessionEl = document.getElementById('session-count');
const alltimeEl = document.getElementById('alltime-count');
const toggleBtn = document.getElementById('toggle');
const outputDirInput = document.getElementById('output-dir');
const saveDirBtn = document.getElementById('save-dir');
const videoSection = document.getElementById('video-section');
const videoLabel = document.getElementById('video-label');
const ytdlpHint = document.getElementById('ytdlp-hint');
const downloadBtn = document.getElementById('download-btn');

function render(state) {
  sessionEl.textContent = state.sessionCount.toLocaleString();
  alltimeEl.textContent = state.allTimeCount.toLocaleString();

  if (state.connected) {
    const mode = state.transport === 'http' ? ' (HTTP daemon)' : ' (Native host)';
    statusEl.textContent = 'Saving to disk' + mode;
    statusEl.className = 'status connected';
  } else {
    statusEl.textContent = 'Not connected';
    statusEl.className = 'status disconnected';
  }

  if (state.captureEnabled) {
    toggleBtn.textContent = 'Pause';
    toggleBtn.className = 'capturing';
  } else {
    toggleBtn.textContent = 'Resume';
    toggleBtn.className = 'paused';
  }

  if (state.outputDir) {
    outputDirInput.value = state.outputDir;
  }

  currentTransport = state.transport;
}

function refresh() {
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
    if (response) {
      render(response);
      checkForVideo();
    }
  });
  refreshPool();
}

// --- Pool sync section ---

const poolStatusEl = document.getElementById('pool-status');
const poolConnectBtn = document.getElementById('pool-connect');
const poolSyncNowBtn = document.getElementById('pool-sync-now');
const poolPauseBtn = document.getElementById('pool-pause');

function renderPool(state) {
  if (!state) return;
  if (state.lastError) {
    poolStatusEl.textContent = state.lastError;
    poolStatusEl.className = 'status disconnected';
  } else if (state.connected) {
    const who = state.username ? ` as @${state.username}` : '';
    poolStatusEl.textContent =
      `Connected${who} — ${state.queued} queued, ${state.synced} synced` +
      (state.paused ? ' (paused)' : '');
    poolStatusEl.className = 'status connected';
  } else {
    poolStatusEl.textContent = 'Not connected to a pool';
    poolStatusEl.className = 'status disconnected';
  }
  poolConnectBtn.textContent = state.connected ? 'Reconnect' : 'Connect';
  poolPauseBtn.textContent = state.paused ? 'Resume sync' : 'Pause sync';
  poolConnectUrl = state.url;
}

let poolConnectUrl = '';

function refreshPool() {
  chrome.runtime.sendMessage({ type: 'POOL_STATUS' }, renderPool);
}

poolConnectBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: `${poolConnectUrl}/connect` });
});

poolSyncNowBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'POOL_FLUSH_NOW' }, renderPool);
});

poolPauseBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'POOL_TOGGLE_PAUSE' }, renderPool);
});

toggleBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'TOGGLE_CAPTURE' }, (response) => {
    if (response) refresh();
  });
});

saveDirBtn.addEventListener('click', () => {
  const dir = outputDirInput.value.trim();
  saveDirBtn.textContent = '...';
  saveDirBtn.disabled = true;
  chrome.runtime.sendMessage({ type: 'SET_OUTPUT_DIR', outputDir: dir }, (resp) => {
    saveDirBtn.disabled = false;
    if (resp?.error) {
      saveDirBtn.textContent = 'Error';
      saveDirBtn.classList.add('error');
      outputDirInput.title = resp.error;
    } else {
      saveDirBtn.textContent = 'Saved!';
      saveDirBtn.classList.remove('error');
      outputDirInput.title = '';
    }
    setTimeout(() => { saveDirBtn.textContent = 'Save'; }, 2000);
  });
});

// --- Video download (HTTP daemon only) ---

let pollTimer = null;
let currentTransport = null;
let videoChecked = false;

function checkForVideo() {
  // Video download requires the HTTP daemon
  if (currentTransport !== 'http') return;
  // Only check once per popup open
  if (videoChecked) return;
  videoChecked = true;

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    const url = tabs[0].url || '';
    const match = url.match(/\/status\/(\d+)/);
    if (!match) return;
    const tweetId = match[1];

    chrome.runtime.sendMessage({ type: 'CHECK_VIDEO', tweetId }, (resp) => {
      if (!resp || !resp.hasVideo) return;

      // Show video section
      const typeLabel = resp.mediaType === 'animated_gif' ? 'GIF' : 'Video';
      const duration = resp.durationMs ? ` (${Math.round(resp.durationMs / 1000)}s)` : '';
      videoLabel.textContent = `${typeLabel} detected${duration}`;
      videoSection.style.display = '';

      // Resume polling if there's an active download for this tweet
      if (resp.activeDownloadId) {
        downloadBtn.textContent = 'Downloading...';
        downloadBtn.className = 'download-btn downloading';
        downloadBtn.disabled = true;
        pollDownload(resp.activeDownloadId);
        return;
      }

      // Check yt-dlp availability
      chrome.runtime.sendMessage({ type: 'CHECK_YTDLP' }, (ytResp) => {
        const hasYtdlp = ytResp && ytResp.ok && ytResp.available;
        if (hasYtdlp) {
          downloadBtn.textContent = 'Download Video';
        } else {
          ytdlpHint.style.display = '';
          downloadBtn.textContent = 'Download MP4';
        }

        downloadBtn.onclick = () => startDownload(tweetId, resp.tweetUrl, resp.directUrl, resp.postDate);
      });
    });
  });
}

function startDownload(tweetId, tweetUrl, directUrl, postDate) {
  downloadBtn.disabled = true;
  downloadBtn.textContent = 'Starting...';
  downloadBtn.className = 'download-btn downloading';

  chrome.runtime.sendMessage({
    type: 'DOWNLOAD_VIDEO',
    tweetId,
    tweetUrl,
    directUrl,
    postDate,
  }, (resp) => {
    if (!resp || !resp.ok) {
      showDownloadResult('error', resp?.error || 'Download failed');
      return;
    }
    pollDownload(resp.downloadId);
  });
}

function pollDownload(downloadId) {
  pollTimer = setInterval(() => {
    chrome.runtime.sendMessage({
      type: 'DOWNLOAD_STATUS',
      downloadId,
    }, (resp) => {
      if (!resp || !resp.ok) return;

      if (resp.status === 'downloading') {
        if (resp.progress != null) {
          downloadBtn.textContent = `Downloading... ${Math.round(resp.progress)}%`;
        } else {
          downloadBtn.textContent = 'Downloading...';
        }
      } else if (resp.status === 'done') {
        clearInterval(pollTimer);
        showDownloadResult('success', 'Download complete');
      } else if (resp.status === 'error') {
        clearInterval(pollTimer);
        showDownloadResult('error', resp.error || 'Download failed');
      }
    });
  }, 500);
}

function showDownloadResult(type, message) {
  downloadBtn.textContent = message;
  downloadBtn.className = `download-btn ${type}`;
  downloadBtn.disabled = true;
  setTimeout(() => {
    downloadBtn.textContent = 'Download Video';
    downloadBtn.className = 'download-btn';
    downloadBtn.disabled = false;
  }, 3000);
}

document.getElementById('open-debug').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('debug.html') });
});

refresh();
